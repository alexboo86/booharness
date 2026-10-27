import { scrubbedGitEnv } from '../git-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

function closure(seeds, edges, stops = new Set()) {
  const result = new Set([...seeds].filter(file => !stops.has(file)));
  const pending = [...result];
  for (let i = 0; i < pending.length; i++) {
    for (const target of edges.get(pending[i])?.values() ?? []) {
      if (result.has(target) || stops.has(target)) continue;
      result.add(target);
      pending.push(target);
    }
  }
  return result;
}

// Shared by the codemod, registry gate and header classifier. Worker and client
// reachability include deferred imports; client reachability stops before modules
// whose first statement is 'use server'. Load-time reachability stays static.
// Inline type specifiers still emit imports with verbatimModuleSyntax.
export function runtimeClosures({ rootDir, files, resolve, resolveWorker = resolve, sources = new Map([...files].map(([file, text]) => [
  file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
])) }) {
  const relative = file => path.relative(rootDir, file).replaceAll('\\', '/');
  const workspaceNames = new Set();
  for (const base of ['web/apps', 'web/packages']) {
    const directory = path.join(rootDir, base);
    if (!fs.existsSync(directory)) continue;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const manifest = path.join(directory, item.name, 'package.json');
      if (item.isDirectory() && fs.existsSync(manifest)) {
        const { name } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (name) workspaceNames.add(name);
      }
    }
  }
  // A missing package under a workspace scope is a project import, not an external one.
  const workspaceScopes = new Set([...workspaceNames].filter(name => name.startsWith('@')).map(name => name.split('/')[0]));
  const workerSeeds = new Map();
  const clientSeeds = new Set();
  const serverActions = new Set();
  const runtimeEdges = new Map();
  const loadTimeEdges = new Map();
  const loadTimeSpecifiers = new Map();
  const ignoredCandidates = new Map();
  function isIgnored(candidate) {
    if (!ignoredCandidates.has(candidate)) {
      // The trailing slash also recognizes an absent generated directory.
      const result = spawnSync('git', ['-C', rootDir, 'check-ignore', '--quiet', '--stdin', '-z'], { env: scrubbedGitEnv(),
        input: `${candidate}\0${candidate}/\0`, encoding: 'utf8',
      });
      ignoredCandidates.set(candidate, result.status === 0);
    }
    return ignoredCandidates.get(candidate);
  }
  function addWorkerSeed(file, rule) {
    if (!workerSeeds.has(file)) workerSeeds.set(file, new Set());
    workerSeeds.get(file).add(rule);
  }
  function edge(graph, file, node, target) {
    if (!graph.has(file)) graph.set(file, new Map());
    graph.get(file).set(node, target);
  }
  for (const [file, source] of sources) {
    if (source.isDeclarationFile) continue;
    const first = source.statements[0];
    if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) &&
        first.expression.text === 'use server') serverActions.add(file);
    if (/(?:^|\/)workers\//.test(relative(file))) addWorkerSeed(file, 'workers-directory');
    if (/\.worker\.[cm]?[jt]sx?$/.test(file)) addWorkerSeed(file, 'worker-extension');
    for (const statement of source.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
      if (statement.expression.text === 'use client') clientSeeds.add(file);
    }
    function visit(node) {
      let specifier;
      let loadTime = false;
      if (((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
          (ts.isExportDeclaration(node) && !node.isTypeOnly)) &&
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
        loadTime = true;
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        specifier = node.arguments[0].text;
      }
      if (specifier !== undefined) {
        let target = resolve(file, specifier);
        const packageName = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
        if (!target && (/^(?:\.|\/|@\/)/.test(specifier) || workspaceNames.has(packageName) ||
            workspaceScopes.has(specifier.split('/')[0]))) {
          // Source inventories omit assets and may omit explicitly imported
          // tooling sources. Resolve existing literal files, never missing ones.
          const asset = specifier.split('?')[0];
          const candidate = asset.startsWith('@/') ? path.join(rootDir, 'src', asset.slice(2))
            : asset.startsWith('.') || path.isAbsolute(asset) ? path.resolve(path.dirname(file), asset) : null;
          if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
            if (!candidate || !isIgnored(candidate)) {
              throw new Error(`Cannot resolve project import ${JSON.stringify(specifier)} from ${relative(file)}`);
            }
          } else {
            target = specifier.includes('?') ? null : candidate;
          }
        }
        if (target) {
          if (!sources.has(target) && !target.replaceAll('\\', '/').includes('/node_modules/') &&
              !relative(target).startsWith('../') && /\.[cm]?[jt]sx?$/.test(target) && fs.existsSync(target)) {
            sources.set(target, ts.createSourceFile(target, fs.readFileSync(target, 'utf8'), ts.ScriptTarget.Latest, true,
              /\.[jt]sx$/.test(target) ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
          }
          edge(runtimeEdges, file, node, target);
          if (loadTime) edge(loadTimeEdges, file, node, target);
        }
        if (loadTime) {
          if (!loadTimeSpecifiers.has(file)) loadTimeSpecifiers.set(file, new Set());
          loadTimeSpecifiers.get(file).add(specifier);
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
          ['Worker', 'SharedWorker'].includes(node.expression.text)) {
        const url = node.arguments?.[0];
        if (url && ts.isNewExpression(url) && ts.isIdentifier(url.expression) && url.expression.text === 'URL' &&
            url.arguments?.[0] && ts.isStringLiteralLike(url.arguments[0])) {
          const target = resolveWorker(file, url.arguments[0].text);
          if (!target) throw new Error(`Unresolved worker entry in ${relative(file)}: ${url.arguments[0].text}`);
          addWorkerSeed(target, `${node.expression.text}-url: ${relative(file)}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return {
    workerSeeds, runtimeEdges, loadTimeSpecifiers,
    workerClosure: closure(workerSeeds.keys(), runtimeEdges),
    clientClosure: closure(clientSeeds, runtimeEdges, serverActions),
    loadTimeClosure: seeds => closure(seeds, loadTimeEdges),
  };
}
