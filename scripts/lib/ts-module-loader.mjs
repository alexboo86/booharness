/**
 * Canonical TypeScript module loader for Node test scripts.
 *
 * SSOT for resolve / load / cache. Migrated consumers must not keep a local
 * resolveTsModule that can return a directory (EISDIR on readFileSync).
 *
 * Resolution guarantees:
 * - resolved local target is always a file, never a directory
 * - directory import → index.ts / index.tsx (and js/mjs index when present)
 * - explicit file, .ts/.tsx/.js/.mjs/.json extensions
 * - path aliases from repo compiler options (@/* → src/*)
 * - hooks: redirects, mocks, resolveExternal — no silent fallbacks
 *
 * Host contract:
 * - default sandbox is Node-only (no fabricated browser DOM)
 * - browser capabilities (document, localStorage, …) are opt-in via `sandbox`
 * - `import.meta.env` is injected only when the caller supplies `importMetaEnv`
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance as nodePerformance } from 'node:perf_hooks';
import vm from 'node:vm';
import ts from 'typescript';

const FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs'];

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function toMap(value) {
  if (!value) return new Map();
  if (value instanceof Map) return new Map(value);
  return new Map(Object.entries(value));
}

function readCompilerOptions(root) {
  for (const name of ['tsconfig.app.json', 'tsconfig.json']) {
    const configPath = path.join(root, name);
    if (!isFile(configPath)) continue;
    const text = fs.readFileSync(configPath, 'utf8');
    const { config, error } = ts.parseConfigFileTextToJson(configPath, text);
    if (error || !config) {
      const message = error
        ? ts.flattenDiagnosticMessageText(error.messageText, '\n')
        : 'empty compiler configuration';
      throw new Error(`Cannot parse ${configPath}: ${message}`);
    }
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root, undefined, configPath);
    if (parsed.errors.length > 0) {
      const message = parsed.errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .join('; ');
      throw new Error(`Cannot load compiler options from ${configPath}: ${message}`);
    }
    return parsed.options;
  }
  throw new Error(`Cannot create TypeScript module loader: no tsconfig.app.json or tsconfig.json under ${root}`);
}

function buildAliasMatchers(compilerOptions, root) {
  const matchers = [];
  const paths = compilerOptions.paths ?? {};
  const baseUrl = compilerOptions.baseUrl
    ? path.resolve(root, compilerOptions.baseUrl)
    : root;

  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const target = targets[0];
    if (pattern.endsWith('/*') && target.endsWith('/*')) {
      const fromPrefix = pattern.slice(0, -1); // '@/
      const toPrefix = path.resolve(baseUrl, target.slice(0, -1));
      matchers.push({
        test: (specifier) => specifier.startsWith(fromPrefix),
        rewrite: (specifier) => path.join(toPrefix, specifier.slice(fromPrefix.length)),
      });
    } else {
      matchers.push({
        test: (specifier) => specifier === pattern,
        rewrite: () => path.resolve(baseUrl, target),
      });
    }
  }

  // Hard guarantee for the repo alias even if tsconfig is incomplete.
  if (!matchers.some((m) => m.test('@/x'))) {
    matchers.push({
      test: (specifier) => specifier.startsWith('@/'),
      rewrite: (specifier) => path.join(root, 'src', specifier.slice(2)),
    });
  }

  return matchers;
}

/**
 * Resolve a filesystem base to a single FILE path.
 * Never returns a directory — that was the EISDIR root cause.
 */
function resolveFileFromBase(base, specifier, parentPath) {
  if (isFile(base)) {
    return path.normalize(base);
  }

  for (const ext of FILE_EXTENSIONS) {
    const withExt = base + ext;
    if (isFile(withExt)) return path.normalize(withExt);
  }

  if (isDirectory(base)) {
    for (const indexName of INDEX_FILES) {
      const indexPath = path.join(base, indexName);
      if (isFile(indexPath)) return path.normalize(indexPath);
    }
    throw new Error(
      `Cannot resolve ${specifier} from ${parentPath}: ` +
        `${base} is a directory without index.{ts,tsx,js,mjs,cjs}`,
    );
  }

  throw new Error(
    `Cannot resolve ${specifier} from ${parentPath}: ` +
      `no file for ${base}{${FILE_EXTENSIONS.join(',')}} or directory index`,
  );
}

/**
 * Build the `import.meta` substitute for the CommonJS vm sandbox.
 *
 * Contract:
 * - always provides `url` (absolute file path) and `hot: undefined` (HMR strip)
 * - injects `env` only when the caller supplied `importMetaEnv`
 * - never invents a silent empty `env: {}` that masks missing Vite env
 */
function buildImportMetaLiteral(absPath, importMetaEnv) {
  const parts = [
    `url: ${JSON.stringify(absPath)}`,
    'hot: undefined',
  ];
  if (importMetaEnv !== undefined) {
    if (
      importMetaEnv === null ||
      typeof importMetaEnv !== 'object' ||
      Array.isArray(importMetaEnv) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(importMetaEnv))
    ) {
      throw new Error(
        'createTsModuleLoader option importMetaEnv must be a plain object when provided',
      );
    }
    parts.push(`env: ${JSON.stringify(importMetaEnv)}`);
  }
  return `({ ${parts.join(', ')} })`;
}

function scriptKindForPath(absPath) {
  if (absPath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (absPath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (absPath.endsWith('.js') || absPath.endsWith('.mjs') || absPath.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

/** Replace only syntactic `import.meta` nodes, never text in strings/comments. */
function rewriteImportMeta(source, absPath, importMetaEnv) {
  const sourceFile = ts.createSourceFile(
    absPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(absPath),
  );
  const spans = [];
  const visit = (node) => {
    if (
      ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.name.text === 'meta'
    ) {
      spans.push([node.getStart(sourceFile), node.getEnd()]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (spans.length === 0) return source;
  const metaLiteral = buildImportMetaLiteral(absPath, importMetaEnv);
  let transformed = source;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const [start, end] = spans[index];
    transformed = transformed.slice(0, start) + metaLiteral + transformed.slice(end);
  }
  return transformed;
}

function createDefaultTransform(importMetaEnv) {
  return function defaultTransform(source, absPath) {
    return rewriteImportMeta(source, absPath, importMetaEnv);
  };
}

/** Node globals the production graph may touch under vm (explicit, not full globalThis). */
const DEFAULT_SANDBOX_GLOBAL_KEYS = [
  'console',
  'process',
  'Buffer',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'queueMicrotask',
  'structuredClone',
  'performance',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'AbortController',
  'AbortSignal',
  'Event',
  'EventTarget',
  'fetch',
  'Headers',
  'Request',
  'Response',
  'crypto',
  'atob',
  'btoa',
];

/**
 * Default sandbox: Node runtime globals only.
 * No document / window / localStorage fabrication — consumers pass those via `sandbox`.
 */
function buildDefaultSandboxGlobals() {
  /** @type {Record<string, unknown>} */
  const globals = {};
  for (const key of DEFAULT_SANDBOX_GLOBAL_KEYS) {
    if (globalThis[key] !== undefined) {
      globals[key] = globalThis[key];
    }
  }
  if (!globals.performance) {
    globals.performance = nodePerformance;
  }
  return globals;
}

/**
 * @param {object} [options]
 * @param {string} [options.root] repo root (cwd by default)
 * @param {string} [options.requireFrom] createRequire base URL/path
 * @param {import('typescript').CompilerOptions} [options.compilerOptions]
 * @param {Record<string, string>|Map<string, string>} [options.redirects] specifier → file path (absolute or root-relative)
 * @param {Record<string, unknown>|Map<string, unknown>} [options.mocks] specifier → exports | factory
 * @param {(specifier: string) => unknown|undefined} [options.resolveExternal] return exports to short-circuit; undefined → Node require
 * @param {Record<string, unknown>} [options.sandbox] extra vm globals (opt-in host capabilities)
 * @param {Record<string, unknown>} [options.importMetaEnv] explicit Vite-style env; omit to leave import.meta.env absent
 * @param {(source: string, absPath: string) => string} [options.transformSource]
 * @param {import('typescript').CompilerOptions} [options.transpileOptions] overrides for ts.transpileModule
 */
export function createTsModuleLoader(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const requireFromHere = createRequire(
    options.requireFrom ?? path.join(root, 'package.json'),
  );
  const compilerOptions = options.compilerOptions ?? readCompilerOptions(root);
  const aliasMatchers = buildAliasMatchers(compilerOptions, root);
  const redirects = toMap(options.redirects);
  const mocks = toMap(options.mocks);
  const resolveExternal = options.resolveExternal ?? null;
  const extraSandbox = options.sandbox ?? {};
  const hasCustomTransform = typeof options.transformSource === 'function';
  if (
    !hasCustomTransform &&
    Object.prototype.hasOwnProperty.call(options, 'importMetaEnv')
  ) {
    // Validate eagerly so misconfiguration fails at loader creation, not mid-graph.
    buildImportMetaLiteral('/validate', options.importMetaEnv);
  }
  const transformSource =
    options.transformSource ?? createDefaultTransform(options.importMetaEnv);
  const transpileOptions = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.ReactJSX,
    ...options.transpileOptions,
  };

  /** @type {Map<string, { exports: any }>} */
  const moduleCache = new Map();

  function reset() {
    moduleCache.clear();
  }

  function applyAlias(specifier) {
    for (const matcher of aliasMatchers) {
      if (matcher.test(specifier)) return matcher.rewrite(specifier);
    }
    return null;
  }

  /**
   * Classify and resolve a require/import specifier.
   * @returns {{ kind: 'file', path: string }
   *   | { kind: 'external', specifier: string }
   *   | { kind: 'mock', specifier: string }
   *   | { kind: 'redirect', path: string }}
   */
  function resolveRequest(specifier, parentPath) {
    if (typeof specifier !== 'string' || specifier.length === 0) {
      throw new Error(
        `Invalid module specifier ${JSON.stringify(specifier)} from ${parentPath}`,
      );
    }

    if (mocks.has(specifier)) {
      return { kind: 'mock', specifier };
    }

    if (redirects.has(specifier)) {
      const target = redirects.get(specifier);
      if (typeof target !== 'string' || target.length === 0) {
        throw new Error(
          `Redirect for ${specifier} must be a non-empty file path string`,
        );
      }
      const abs = path.isAbsolute(target) ? target : path.resolve(root, target);
      if (!isFile(abs)) {
        throw new Error(
          `Redirect for ${specifier} does not resolve to a file: ${abs}`,
        );
      }
      return { kind: 'redirect', path: path.normalize(abs) };
    }

    if (specifier.startsWith('node:')) {
      return { kind: 'external', specifier };
    }

    const aliased = applyAlias(specifier);
    if (aliased) {
      return {
        kind: 'file',
        path: resolveFileFromBase(aliased, specifier, parentPath),
      };
    }

    // Relative import from parent module
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      if (!parentPath) {
        throw new Error(
          `Cannot resolve relative specifier ${specifier} without parentPath`,
        );
      }
      const base = path.resolve(path.dirname(parentPath), specifier);
      return {
        kind: 'file',
        path: resolveFileFromBase(base, specifier, parentPath),
      };
    }

    // Absolute filesystem path
    if (path.isAbsolute(specifier)) {
      return {
        kind: 'file',
        path: resolveFileFromBase(specifier, specifier, parentPath),
      };
    }

    // Prefer TypeScript program resolution for path-mapped / project-local names
    // when parent is known (covers edge cases beyond explicit alias rewrite).
    if (parentPath && !specifier.startsWith('.')) {
      const tsResolved = ts.resolveModuleName(
        specifier,
        parentPath,
        compilerOptions,
        ts.sys,
      ).resolvedModule;

      if (
        tsResolved &&
        !tsResolved.isExternalLibraryImport &&
        tsResolved.resolvedFileName &&
        isFile(tsResolved.resolvedFileName) &&
        !tsResolved.resolvedFileName.endsWith('.d.ts')
      ) {
        return {
          kind: 'file',
          path: path.normalize(tsResolved.resolvedFileName),
        };
      }
    }

    // Bare package or Node builtin → external
    return { kind: 'external', specifier };
  }

  /**
   * Resolve to an absolute file path for local modules.
   * External/mocks throw — use resolveRequest for full classification.
   */
  function resolve(specifier, parentPath) {
    const request = resolveRequest(specifier, parentPath);
    if (request.kind === 'file' || request.kind === 'redirect') {
      return request.path;
    }
    if (request.kind === 'mock') {
      throw new Error(
        `Specifier ${specifier} is mocked and has no filesystem path`,
      );
    }
    throw new Error(
      `Specifier ${specifier} is external (${request.specifier}); not a local file`,
    );
  }

  /**
   * Resolve a root-relative entry (e.g. src/foo.ts) or absolute path to a file.
   */
  function resolveEntry(sourcePath) {
    if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
      throw new Error(`Invalid entry path: ${JSON.stringify(sourcePath)}`);
    }
    const base = path.isAbsolute(sourcePath)
      ? sourcePath
      : path.resolve(root, sourcePath);
    return resolveFileFromBase(base, sourcePath, path.join(root, 'package.json'));
  }

  /**
   * Some packages ship CommonJS under `type: "module"` with a `.cjs.js`
   * filename (e.g. @phosphor-icons/react). Node's require() then evaluates
   * them as ESM and throws "exports is not defined". When the resolved file
   * is clearly CJS, evaluate it in a CJS sandbox instead of swallowing the
   * error or inventing a mock.
   */
  function loadAsCommonJsFile(resolvedPath, requireImpl) {
    const code = fs.readFileSync(resolvedPath, 'utf8');
    const module = { exports: {} };
    const dirname = path.dirname(resolvedPath);
    const sandbox = {
      exports: module.exports,
      module,
      require: requireImpl,
      __filename: resolvedPath,
      __dirname: dirname,
      console,
      process,
      Buffer,
    };
    vm.runInNewContext(code, sandbox, { filename: resolvedPath });
    return module.exports;
  }

  function looksLikeCommonJsSource(code) {
    const head = code.slice(0, 8000);
    return (
      /\bexports\b/.test(head) ||
      /\bmodule\.exports\b/.test(head) ||
      /\brequire\s*\(/.test(head) ||
      head.startsWith('"use strict"') ||
      head.startsWith("'use strict'")
    );
  }

  function isEsmRequireInteropError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return (
      /exports is not defined in ES module scope/.test(message) ||
      /require is not defined in ES module scope/.test(message) ||
      /Cannot require\(\) ES Module/.test(message) ||
      /require\(\) of ES Module/.test(message)
    );
  }

  function loadExternal(specifier) {
    const cacheKey = `external:${specifier}`;
    if (moduleCache.has(cacheKey)) {
      return moduleCache.get(cacheKey).exports;
    }

    if (resolveExternal) {
      const custom = resolveExternal(specifier);
      if (custom !== undefined) {
        moduleCache.set(cacheKey, { exports: custom });
        return custom;
      }
    }

    try {
      const exports = requireFromHere(specifier);
      moduleCache.set(cacheKey, { exports });
      return exports;
    } catch (err) {
      if (!isEsmRequireInteropError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Cannot load external module ${specifier}: ${message}`,
          { cause: err },
        );
      }

      let resolvedPath;
      try {
        resolvedPath = requireFromHere.resolve(specifier);
      } catch {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Cannot load external module ${specifier}: ${message}`,
          { cause: err },
        );
      }

      if (!isFile(resolvedPath) || resolvedPath.endsWith('.mjs')) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Cannot load external module ${specifier}: ${message}`,
          { cause: err },
        );
      }

      const code = fs.readFileSync(resolvedPath, 'utf8');
      if (!looksLikeCommonJsSource(code)) {
        throw new Error(
          `Cannot load external module ${specifier}: require() failed with ESM interop error ` +
            `and ${resolvedPath} does not look like CommonJS`,
          { cause: err },
        );
      }

      try {
        // Preserve Node's per-module locality: relative requires inside the
        // recovered package must resolve from that package file, not repo root.
        const exports = loadAsCommonJsFile(
          resolvedPath,
          createRequire(resolvedPath),
        );
        moduleCache.set(cacheKey, { exports });
        return exports;
      } catch (cjsErr) {
        const message = cjsErr instanceof Error ? cjsErr.message : String(cjsErr);
        throw new Error(
          `Cannot load external module ${specifier} via CJS sandbox (${resolvedPath}): ${message}`,
          { cause: cjsErr },
        );
      }
    }
  }

  function loadFile(absPath) {
    const normalized = path.normalize(absPath);
    if (!isFile(normalized)) {
      throw new Error(`Cannot load non-file path: ${normalized}`);
    }

    if (moduleCache.has(normalized)) {
      return moduleCache.get(normalized).exports;
    }

    if (normalized.endsWith('.json')) {
      const exports = requireFromHere(normalized);
      moduleCache.set(normalized, { exports });
      return exports;
    }

    const raw = fs.readFileSync(normalized, 'utf8');
    const source = transformSource(raw, normalized);
    // TypeScript leaves `.mjs` source untransformed (ESM syntax preserved).
    // The vm sandbox is CommonJS-only, so force a rewriteable fileName for .mjs.
    const transpileFileName = normalized.endsWith('.mjs')
      ? `${normalized.slice(0, -4)}.js`
      : normalized;
    const compiled = ts.transpileModule(source, {
      compilerOptions: transpileOptions,
      fileName: transpileFileName,
    }).outputText;

    const module = { exports: {} };
    // Cache before execute so cyclic graphs see the partial exports object.
    moduleCache.set(normalized, module);

    const sandbox = {
      ...buildDefaultSandboxGlobals(),
      exports: module.exports,
      module,
      ...extraSandbox,
      require: (specifier) => requireModule(specifier, normalized),
    };

    try {
      vm.runInNewContext(compiled, sandbox, { filename: normalized });
    } catch (err) {
      moduleCache.delete(normalized);
      throw err;
    }

    return module.exports;
  }

  function requireModule(specifier, parentPath) {
    const request = resolveRequest(specifier, parentPath);
    if (request.kind === 'mock') {
      const cacheKey = `mock:${request.specifier}`;
      if (moduleCache.has(cacheKey)) {
        return moduleCache.get(cacheKey).exports;
      }
      const mock = mocks.get(request.specifier);
      const exports = typeof mock === 'function' ? mock() : mock;
      moduleCache.set(cacheKey, { exports });
      return exports;
    }
    if (request.kind === 'redirect' || request.kind === 'file') {
      return loadFile(request.path);
    }
    return loadExternal(request.specifier);
  }

  /**
   * Load a root-relative or absolute TypeScript/JS/JSON entry.
   */
  function load(sourcePath) {
    const absPath = resolveEntry(sourcePath);
    return loadFile(absPath);
  }

  return {
    root,
    load,
    resolve,
    resolveRequest,
    resolveEntry,
    require: requireModule,
    reset,
    get cacheSize() {
      return moduleCache.size;
    },
  };
}

export {
  FILE_EXTENSIONS,
  INDEX_FILES,
  isFile,
  isDirectory,
  resolveFileFromBase,
  readCompilerOptions,
  buildImportMetaLiteral,
  rewriteImportMeta,
};
