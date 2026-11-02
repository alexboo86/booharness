import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';
import { importSpecifiers } from './imports.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function refuse(file, message) {
  throw new Error(`${file}: ${message}`);
}

// Windows reserves these base names, with any extension, any casing and spaces before the dot, as devices.
const reservedNames = new Set(['con', 'conin$', 'conout$', 'prn', 'aux', 'nul', 'com0', 'lpt0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

// Manifest/entry paths are canonical POSIX relative names on every platform.
function safePath(name) {
  if (typeof name !== 'string' || !name || /[\\*<>|"\0-\x1f\x7f:%?#]/.test(name)) return false;
  return !path.posix.isAbsolute(name) && !path.win32.isAbsolute(name)
    && name.split('/').every(part => part && !/[. ]$/.test(part)
      && !reservedNames.has(part.split('.')[0].trimEnd().toLowerCase()));
}

function checkPath(name) {
  if (!safePath(name) || name === 'manifest.json') refuse(String(name), 'unsafe bundle path');
  return name;
}

function fileStat(absolute, name) {
  try { return lstatSync(absolute); }
  catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
}

function regularFile(root, name) {
  let current = root;
  const parts = [null, ...name.split('/')];
  for (const part of parts) {
    if (part !== null) current = path.join(current, part);
    const stat = fileStat(current, name);
    if (stat.isSymbolicLink()) refuse(name, 'symlink is forbidden');
    if (current !== path.join(root, name) && !stat.isDirectory()) refuse(name, 'not a directory');
  }
  if (!fileStat(current, name).isFile()) refuse(name, 'not a regular file');
  return current;
}

function dependency(file, specifier) {
  if (specifier.startsWith('node:') && isBuiltin(specifier)) return null;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    refuse(file, `forbidden import ${specifier} (only relative files and node: built-ins)`);
  }
  if (/[\\\0:%?#]/.test(specifier)) refuse(file, `unsafe import ${specifier}`);
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  if (!safePath(target)) refuse(file, `import leaves host-agent: ${specifier}`);
  checkPath(target);
  return target;
}

function closure(sourceDir, entry) {
  const pending = [entry];
  const files = new Map();
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    const bytes = readFileSync(regularFile(sourceDir, file));
    files.set(file, bytes);
    for (const specifier of importSpecifiers(bytes.toString('utf8'), file)) {
      const target = dependency(file, specifier);
      if (target !== null) pending.push(target);
    }
  }
  return files;
}

function validVersion(version) {
  if (typeof version !== 'string' || !version.trim()) refuse('manifest.json', 'version must be a nonempty string');
}

/** Build into a NEW directory. sourceDir defaults to this standalone module. */
export function buildBundle({ entry, outputDir, version, sourceDir = fileURLToPath(new URL('.', import.meta.url)) }) {
  checkPath(entry);
  validVersion(version);
  const files = closure(path.resolve(sourceDir), entry);
  const manifest = {
    version, entry,
    files: [...files.keys()].sort().map(file => ({ path: file, size: files.get(file).length, sha256: digest(files.get(file)) })),
  };
  // Refuse an existing destination: never overwrite another version or retain extras.
  mkdirSync(outputDir);
  for (const file of manifest.files) {
    const destination = path.join(outputDir, file.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, files.get(file.path), { flag: 'wx' });
  }
  writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

function manifestFile(file) {
  if (!file || typeof file !== 'object') refuse('manifest.json', 'invalid file record');
  checkPath(file.path);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
    refuse(file.path, 'invalid size or SHA-256');
  }
}

function readManifest(directory) {
  const manifest = JSON.parse(readFileSync(regularFile(directory, 'manifest.json'), 'utf8'));
  if (!manifest || !Array.isArray(manifest.files)) refuse('manifest.json', 'invalid manifest');
  validVersion(manifest.version);
  checkPath(manifest.entry);
  const paths = new Set();
  for (const file of manifest.files) {
    manifestFile(file);
    const folded = file.path.toLowerCase();
    if (paths.has(folded)) refuse(file.path, 'duplicate bundle path');
    paths.add(folded);
  }
  if (!manifest.files.some(file => file.path === manifest.entry)) refuse(manifest.entry, 'entry is missing from manifest');
  return manifest;
}

function directoryFiles(directory, prefix = '') {
  const files = [];
  for (const name of readdirSync(path.join(directory, prefix)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path.join(directory, relative));
    if (stat.isSymbolicLink()) refuse(relative, 'symlink is forbidden');
    if (stat.isDirectory()) files.push(...directoryFiles(directory, relative));
    else if (stat.isFile()) files.push(relative);
    else refuse(relative, 'not a regular file');
  }
  return files;
}

/** Verify the exact file set and bytes; hashes provide integrity, not authority. */
export function verifyBundle(directory) {
  directory = path.resolve(directory); // Strip a trailing separator before lstat of the root.
  const manifest = readManifest(directory);
  const expected = new Set(['manifest.json', ...manifest.files.map(file => file.path)]);
  for (const file of directoryFiles(directory)) {
    if (!expected.has(file)) refuse(file, 'extra bundle file');
  }
  for (const file of manifest.files) {
    const bytes = readFileSync(regularFile(directory, file.path));
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) refuse(file.path, 'changed bundle file');
  }
  return manifest;
}
