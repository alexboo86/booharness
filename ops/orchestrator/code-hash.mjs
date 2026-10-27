// The fingerprint of the code orch runs: every source file under src/, their
// static relative-import closure, and the dependency lockfile. The daemon
// reports it in /health; the installer restarts an idle daemon on a mismatch.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const extensions = ['.ts', '.mjs', '.js', '.json'];
// Match static imports/re-exports (including multiline named bindings), not
// dynamic import() or strings used as import() arguments.
const moduleFrom = /^[ \t]*(?:import|export)[ \t]+(?:[^;\n{}]*\{[^}]*\}[^;\n]*|[^;\n]*?)[ \t]+from[ \t\r\n]*['"](\.\.?\/[^'"]+)['"]/gm;
const sideEffectImport = /^[ \t]*import[ \t]*['"](\.\.?\/[^'"]+)['"]/gm;
// Skip comments; include plain template literals, but not interpolated paths.
const fileLiteral = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'((?:\\.|[^'\\\r\n])*)'|"((?:\\.|[^"\\\r\n])*)"|`((?:\\.|[^`\\])*)`/g;

/** Static local imports from arbitrary entrypoints. Missing targets may be
 * retained by a change sensor so that deleting an input still triggers it.
 * A change sensor can also follow file literals and override working-tree bytes
 * (null means absent, retaining literal edges when allowMissing), and collect
 * in `edges` the names that each file leads to. No option changes the daemon
 * fingerprint's walk. */
export function relativeImportFiles(workdir, seeds, {
  allowMissing = false, includeFileLiterals = false, contents = new Map(), edges = null,
} = {}) {
  const pending = [...seeds];
  const files = new Map();
  const diskFiles = new Map();
  const isFile = (name) => {
    if (contents.has(name)) return contents.get(name) !== null;
    if (includeFileLiterals && diskFiles.has(name)) return diskFiles.get(name);
    let found;
    try { found = statSync(path.join(workdir, name)).isFile(); } catch (error) {
      if (error.code === 'ENOENT' || includeFileLiterals
        && ['ENOTDIR', 'ENAMETOOLONG', 'ERR_INVALID_ARG_VALUE'].includes(error.code)) found = false;
      else throw error;
    }
    if (includeFileLiterals) diskFiles.set(name, found);
    return found;
  };
  while (pending.length) {
    const name = pending.pop();
    if (files.has(name)) continue;
    let bytes;
    try {
      bytes = contents.has(name) ? contents.get(name) : readFileSync(path.join(workdir, name));
    } catch (error) {
      if (!allowMissing || error.code !== 'ENOENT') throw error;
      files.set(name, null);
      continue;
    }
    if (bytes === null) {
      if (!allowMissing) throw new Error(`missing local input ${name}`);
      files.set(name, null);
      continue;
    }
    files.set(name, bytes);
    if (name.endsWith('.json')) continue;
    if (includeFileLiterals && !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(name)) continue;
    const source = bytes.toString('utf8');
    const from = pending.length;
    for (const [, specifier] of [...source.matchAll(moduleFrom), ...source.matchAll(sideEffectImport)]) {
      const target = path.posix.join(path.posix.dirname(name), specifier);
      // A dotted suffix like `./utils-shell.entry` is not an extension we
      // resolve: the exact target is tried only when its extname is one of
      // ours or it exists as-is; otherwise each extension is appended.
      const candidates = extensions.includes(path.posix.extname(target)) || isFile(target)
        ? [target]
        : extensions.map((extension) => `${target}${extension}`);
      const resolved = candidates.find(isFile);
      if (!resolved && !allowMissing) throw new Error(`unresolved local import ${specifier} in ${name}`);
      pending.push(...(resolved ? [resolved] : candidates));
    }
    if (includeFileLiterals) {
      for (const match of source.matchAll(fileLiteral)) {
        const literal = match[1] ?? match[2] ?? match[3];
        if (!literal || literal.includes('${') || path.posix.isAbsolute(literal)) continue;
        const specifier = literal.replace(/\\(['"`\\])/g, '$1');
        for (const base of [path.posix.dirname(name), '.']) {
          const target = path.posix.join(base, specifier);
          if (target !== '..' && !target.startsWith('../')
            && (isFile(target) || allowMissing && contents.has(target))) pending.push(target);
        }
      }
    }
    edges?.set(name, pending.slice(from));
  }
  return files;
}

/** sha256 (first 16 hex) of orch sources, their local imports and the lockfile. */
export function codeHash(workdir) {
  // Use POSIX names for both resolution and hashing, regardless of host OS.
  const seeds = readdirSync(path.join(workdir, 'src'), { recursive: true })
    .map((name) => path.posix.join('src', String(name).split(path.sep).join('/')))
    .filter((name) => name.endsWith('.ts'));
  const files = relativeImportFiles(workdir, seeds);
  files.set('package-lock.json', readFileSync(path.join(workdir, 'package-lock.json')));
  const hash = createHash('sha256');
  for (const name of [...files.keys()].sort()) {
    hash.update(`${name}\0`);
    hash.update(files.get(name));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
