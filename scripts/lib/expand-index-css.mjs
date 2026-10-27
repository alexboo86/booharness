#!/usr/bin/env node
/**
 * Expand local facade style modules and their relative imports under src/styles/*.
 * Leaves facade-level external imports, Tailwind directives, and ./ui/icon.css intact.
 * Used by cascade contract tests and any script that needs pre-split CSS text.
 */
import fs from 'node:fs';
import path from 'node:path';

export const INDEX_CSS_REL = 'src/index.css';
export const STYLE_MODULES = [
  'src/styles/design-tokens.css',
  'src/styles/base-motion.css',
  'src/styles/chrome-components.css',
  'src/styles/trade-tape.css',
];

const QUOTED_IMPORT_RE = /^\s*@import\s+(["'])([^"']+)\1\s*([^;]*);\s*$/;
const URL_IMPORT_RE = /^\s*@import\s+url\(\s*(["'])([^"']+)\1\s*\)\s*([^;]*);\s*$/;

function parseCssImport(line) {
  const match = QUOTED_IMPORT_RE.exec(line) ?? URL_IMPORT_RE.exec(line);
  if (!match) return null;
  return { specifier: match[2], qualifiers: match[3].trim() };
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isFacadeStyleSpecifier(specifier) {
  return specifier.startsWith('./styles/');
}

/**
 * @param {string} rootDir
 * @param {string} [facadeRel]
 * @returns {string}
 */
export function expandIndexCss(rootDir = process.cwd(), facadeRel = INDEX_CSS_REL) {
  const canonicalRoot = fs.realpathSync(rootDir);
  const facadePath = path.join(canonicalRoot, facadeRel);
  return expandFile(facadePath, canonicalRoot, {
    stack: [],
    seen: new Set(),
    stylesRoot: fs.realpathSync(path.resolve(canonicalRoot, 'src/styles')),
  }, true);
}

/**
 * @param {string} filePath absolute
 * @param {string} rootDir
 * @param {{ stack: string[], seen: Set<string>, stylesRoot: string }} state
 * @param {boolean} isFacade
 * @returns {string}
 */
function expandFile(filePath, rootDir, state, isFacade) {
  const requestedAbs = path.resolve(filePath);
  if (!fs.existsSync(requestedAbs) || !fs.statSync(requestedAbs).isFile()) {
    throw new Error(`missing CSS import: ${path.relative(rootDir, requestedAbs)}`);
  }

  const abs = fs.realpathSync(requestedAbs);
  if (!isFacade && !isWithin(state.stylesRoot, abs)) {
    throw new Error(`CSS import escapes src/styles: ${path.relative(rootDir, requestedAbs)} -> ${path.relative(rootDir, abs)}`);
  }
  if (state.stack.includes(abs)) {
    throw new Error(`CSS import cycle: ${[...state.stack, abs].map((p) => path.relative(rootDir, p)).join(' -> ')}`);
  }
  if (state.seen.has(abs)) {
    throw new Error(`duplicate CSS import: ${path.relative(rootDir, abs)}`);
  }

  state.seen.add(abs);
  state.stack.push(abs);
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split(/(?<=\n)/);
  let out = '';
  try {
    for (const line of lines) {
      const trimmedEnd = line.endsWith('\n') ? line.slice(0, -1) : line;
      const parsed = parseCssImport(trimmedEnd);
      if (!parsed) {
        if (/^\s*@import\b/i.test(trimmedEnd)) {
          throw new Error(`unsupported CSS import syntax in ${path.relative(rootDir, abs)}: ${trimmedEnd}`);
        }
        out += line;
        continue;
      }

      const { specifier, qualifiers } = parsed;
      if (!isRelativeSpecifier(specifier)) {
        out += line;
        continue;
      }

      const childAbs = path.resolve(path.dirname(abs), specifier);
      if (isFacade && !isFacadeStyleSpecifier(specifier)) {
        out += line;
        continue;
      }
      if (!isWithin(state.stylesRoot, childAbs)) {
        throw new Error(`CSS import escapes src/styles: ${path.relative(rootDir, abs)} -> ${specifier}`);
      }
      if (qualifiers !== '') {
        throw new Error(`qualified relative CSS import cannot be expanded safely in ${path.relative(rootDir, abs)}: ${trimmedEnd}`);
      }
      out += expandFile(childAbs, rootDir, state, false);
    }
    return out;
  } finally {
    state.stack.pop();
  }
}

/**
 * Ordered local style-module import paths as declared in the facade (repo-relative).
 * @param {string} rootDir
 * @returns {string[]}
 */
export function listFacadeStyleImports(rootDir = process.cwd()) {
  const facadePath = path.join(rootDir, INDEX_CSS_REL);
  const text = fs.readFileSync(facadePath, 'utf8');
  const imports = [];
  for (const line of text.split(/\n/)) {
    const parsed = parseCssImport(line);
    if (!parsed || !isFacadeStyleSpecifier(parsed.specifier)) continue;
    imports.push(path.normalize(path.join('src', parsed.specifier.replace(/^\.\//, ''))));
  }
  return imports;
}

/**
 * Repo-relative POSIX paths of every CSS file expandIndexCss reads: the facade
 * plus every relative @import the expansion follows, recursively. Mirrors
 * expandFile's traversal (the facade follows only ./styles/* imports; a nested
 * file follows any relative import within src/styles), so a new @import is
 * covered automatically and a deleted input still selects the caller's change
 * sensor. Used by check-commit to route the startup logo contract sensor.
 * @param {string} [rootDir]
 * @returns {string[]}
 */
export function listIndexCssInputs(rootDir = process.cwd()) {
  const canonicalRoot = fs.realpathSync(rootDir);
  const stylesRoot = fs.realpathSync(path.resolve(canonicalRoot, 'src/styles'));
  const inputs = [];
  const seen = new Set();
  const walk = (abs, isFacade) => {
    const rel = path.relative(canonicalRoot, abs).split(path.sep).join('/');
    if (seen.has(rel)) return;
    seen.add(rel);
    inputs.push(rel);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      return; // a deleted input still selects; its own imports cannot be followed
    }
    for (const line of text.split(/\n/)) {
      const parsed = parseCssImport(line);
      if (!parsed || !isRelativeSpecifier(parsed.specifier)) continue;
      if (isFacade && !isFacadeStyleSpecifier(parsed.specifier)) continue;
      const childAbs = path.resolve(path.dirname(abs), parsed.specifier);
      if (!isWithin(stylesRoot, childAbs)) continue;
      walk(childAbs, false);
    }
  };
  walk(path.join(canonicalRoot, INDEX_CSS_REL), true);
  return inputs;
}

/**
 * Count physical lines (split on \\n; trailing empty after final newline not double-counted
 * the same way as wc -l for text that ends with newline).
 * @param {string} filePath
 */
export function countLines(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  if (text.length === 0) return 0;
  const parts = text.split('\n');
  // If file ends with newline, last part is empty — wc -l style
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}
