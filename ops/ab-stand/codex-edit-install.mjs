#!/usr/bin/env node
// The ONE verified install of the codex-edit extension (apply_patch) of
// @maxiaochao/pi-toolkit, shared by the A/B stand arm (install.mjs) and by stock
// codex Pi seats (ops/orchestrator/src/codex-edit.ts locally, remote-provision.ts
// on a host). Guarantees, unchanged from the audited arm install: registry
// integrity and tarball origin are checked, the bytes are hashed against the
// pinned sha512 BEFORE npm sees them, npm ci verifies the committed dependency lock with
// --ignore-scripts (the toolkit postinstall writes into ~/.pi and ~/.local/bin)
// and config.json next to index.ts is overwritten with the pinned models.
// Nothing here writes to ~/.pi or ~/.local/bin and nothing here loads extension
// code or makes a model turn.
//
//   node ops/ab-stand/codex-edit-install.mjs --ensure [--prefix DIR] [--force]
//   node ops/ab-stand/codex-edit-install.mjs --check --prefix DIR
// --prefix defaults to this machine's stock orch prefix
// (<orch state dir>/pi-extensions/codex-edit), never an arm directory.
// --ensure is idempotent: a prefix that already verifies is left untouched.
// stdout is exactly one JSON line { ok, prefix, extension?, models?, installed?, reason? };
// --check and a failed --ensure exit 1.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrityPinnedPackages, installedTree as dependencyTree } from './npm-install-tree.mjs';

export const CODEX_EDIT_PINS = JSON.parse(readFileSync(new URL('./codex-edit.json', import.meta.url), 'utf8'));
export const CODEX_EDIT_PACKAGE = `${CODEX_EDIT_PINS.package}@${CODEX_EDIT_PINS.version}`;
export const CODEX_EDIT_INTEGRITY = CODEX_EDIT_PINS.integrity;
export const CODEX_EDIT_CONFIG = CODEX_EDIT_PINS.config;
export const CODEX_EDIT_FILES = CODEX_EDIT_PINS.files;
/** sha256 of the pinned tarball's own bytes, per upstream file: what a check compares against. */
export const CODEX_EDIT_HASHES = CODEX_EDIT_PINS.hashes;
/** Package-relative extension directory with forward slashes, e.g. extensions/codex-edit. */
const EXTENSION_DIR = CODEX_EDIT_PINS.extension.slice(0, CODEX_EDIT_PINS.extension.lastIndexOf('/'));
const ENTRY = CODEX_EDIT_PINS.extension.slice(EXTENSION_DIR.length + 1);
/** npm --prefix layout below a prefix: node_modules/@maxiaochao/pi-toolkit/extensions/codex-edit */
export const CODEX_EDIT_PACKAGE_DIRECTORY = `node_modules/${CODEX_EDIT_PINS.package}/${EXTENSION_DIR}`;
const PACKAGE_ROOT = `node_modules/${CODEX_EDIT_PINS.package}`;
const STAND_EXTRA_PACKAGE = 'pi-mcp-adapter@5.3.2';
const LOCKS = ['codex-edit-lock.json', 'codex-edit-stand-lock.json'].map((file, index) => {
  const bytes = readFileSync(new URL(`./${file}`, import.meta.url));
  const lock = JSON.parse(bytes);
  return {
    bytes, lock, hash: createHash('sha256').update(bytes).digest('hex'),
    manifest: `${JSON.stringify({ ...lock.packages[''], private: true }, null, 2)}\n`,
    extras: index === 0 ? {} : { 'pi-mcp-adapter': '5.3.2' },
  };
});
const lockedPackages = (pin) => integrityPinnedPackages(pin.lock, CODEX_EDIT_PINS, pin.extras);
const installedTree = (root) => dependencyTree(root, (base, file) => contained(base, file, 'codex-edit verification'), 'codex-edit');

/** This machine's stock prefix; ORCH_STATE_DIR mirrors config.ts loadConfig. */
export function stockCodexEditPrefix(stateDir = process.env.ORCH_STATE_DIR ? path.resolve(process.env.ORCH_STATE_DIR) : path.join(os.homedir(), '.local', 'state', 'orch')) {
  return path.join(stateDir, 'pi-extensions', 'codex-edit');
}
export function codexEditExtension(prefix, join = path) {
  return join.join(prefix, ...CODEX_EDIT_PACKAGE_DIRECTORY.split('/'), ENTRY);
}
function packageRoot(prefix) { return path.join(prefix, ...PACKAGE_ROOT.split('/')); }
function extensionDir(prefix) { return path.join(prefix, ...CODEX_EDIT_PACKAGE_DIRECTORY.split('/')); }
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function lstatOrNull(file) { try { return lstatSync(file); } catch { return null; } }
function canonical(value) { return JSON.stringify(value, (key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.keys(entry).sort().reduce((sorted, name) => (sorted[name] = entry[name], sorted), {}) : entry); }

/** A directory orch writes into must be real: never a symlink and never a Windows junction. */
export function assertRealDir(dir, label, name = 'codex-edit') {
  const stat = lstatOrNull(dir);
  if (!stat) throw new Error(`${name}: ${label} is absent: ${dir}`);
  if (stat.isSymbolicLink()) throw new Error(`${name}: refusing ${label}, a symlink or junction: ${dir}`);
  if (!stat.isDirectory()) throw new Error(`${name}: refusing ${label}, not a directory: ${dir}`);
  return realpathSync(dir);
}

/**
 * Containment for every write and every verified read: each component of `target`
 * below the real prefix must exist as a real file or directory (a symlink or a
 * Windows junction anywhere in it is refused), the leaf may be absent only when
 * orch is about to create it, and the resolved target must stay inside the
 * prefix. Without this, a junction standing in for the installed extension
 * directory (or for the cache) would let an install overwrite a file outside the
 * prefix and still report ok.
 */
export function contained(root, target, label, { create = false, name = 'codex-edit' } = {}) {
  const resolved = path.resolve(target);
  const outside = (value) => value === '' || value.startsWith('..') || path.isAbsolute(value);
  if (outside(path.relative(root, resolved))) throw new Error(`${name}: refusing ${label} outside the prefix ${root}: ${target}`);
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    const next = path.join(current, part);
    const stat = lstatOrNull(next);
    if (stat?.isSymbolicLink()) throw new Error(`${name}: refusing ${label}: ${path.relative(root, next)} is a symlink or junction inside ${root}`);
    if (!stat) {
      if (!create || next !== resolved) throw new Error(`${name}: refusing ${label}: ${path.relative(root, next)} is absent inside ${root}`);
      break;
    }
    current = next;
  }
  if (lstatOrNull(resolved) && outside(path.relative(root, realpathSync(resolved)))) {
    throw new Error(`${name}: refusing ${label} that resolves outside the prefix ${root}: ${target}`);
  }
  return resolved;
}

export function writeContained(root, file, contents, label, name = 'codex-edit') {
  const target = contained(root, file, label, { create: true, name });
  writeFileSync(target, contents, { mode: 0o600 });
  // mode is ignored when the file already exists (an extracted tarball member): make it explicit.
  chmodSync(target, 0o600);
  return target;
}

/**
 * Remove something under the prefix so a repair can reinstall it: the same strict
 * walk as contained(), except that an absent component means there is nothing to
 * remove (a killed install leaves partial trees), and a linked LEAF is unlinked
 * rather than followed, so a junction's target outside the prefix always
 * survives. Returns true when something was removed.
 */
export function removeContained(root, target, label, name = 'codex-edit') {
  const resolved = path.resolve(target);
  const outside = (value) => value === '' || value.startsWith('..') || path.isAbsolute(value);
  if (outside(path.relative(root, resolved))) throw new Error(`${name}: refusing to remove ${label} outside the prefix ${root}: ${target}`);
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    const next = path.join(current, part);
    const stat = lstatOrNull(next);
    if (!stat) return false;
    if (stat.isSymbolicLink()) {
      if (next !== resolved) throw new Error(`${name}: refusing to remove ${label}: ${path.relative(root, next)} is a symlink or junction inside ${root}`);
      rmSync(next, { force: true });
      return true;
    }
    current = next;
  }
  rmSync(resolved, { recursive: true, force: true });
  return true;
}

/**
 * Why this prefix is NOT the verified pinned install, or null when it is. Checked
 * against the pins themselves, not only against the record the installer wrote: a
 * rewritten install.json cannot make a tampered extension verify. Every read is
 * containment-checked, so a junction inside the prefix refuses instead of
 * reporting a file outside it.
 */
export function codexEditProblem(prefix) {
  // A containment refusal is a verdict, never a crash: --check must always print one.
  try { return inspectPrefix(prefix); } catch (error) { return error.message; }
}

function inspectPrefix(prefix) {
  let root;
  try { root = assertRealDir(prefix, 'the codex-edit prefix'); }
  catch (error) { return lstatOrNull(prefix) ? error.message : `no codex-edit install record in ${prefix}`; }
  // Every target is built from the resolved root: a junction in a component of
  // --prefix itself would otherwise leave the target spelling outside the root and
  // refuse an install that is perfectly contained.
  const read = (file, label) => readJson(contained(root, file, label));
  const record = read(path.join(root, 'install.json'), 'the install record');
  if (!record) return `no codex-edit install record in ${prefix}`;
  if (record.package !== CODEX_EDIT_PACKAGE) return `${prefix} records ${record.package ?? 'no package'}, not the pinned ${CODEX_EDIT_PACKAGE}`;
  if (record.integrity !== CODEX_EDIT_INTEGRITY) return `${prefix} records integrity ${record.integrity ?? 'none'}, not the pinned sha512`;
  if (canonical(record.config) !== canonical(CODEX_EDIT_CONFIG)) return `${prefix} records config ${canonical(record.config ?? null)}, not ${canonical(CODEX_EDIT_CONFIG)}`;
  const pin = LOCKS.find((entry) => entry.hash === record.lockSha256);
  if (!pin || !record.tree || typeof record.tree !== 'object') return 'codex-edit dependency manifest is absent or stale; reinstall';
  const dependencies = lockedPackages(pin);
  if (!readFileSync(contained(root, path.join(root, 'package-lock.json'), 'the dependency lock')).equals(pin.bytes) ||
      readFileSync(contained(root, path.join(root, 'package.json'), 'the npm manifest'), 'utf8') !== pin.manifest) return 'codex-edit npm inputs differ from the committed lock';
  const tree = installedTree(root);
  for (const file of new Set([...Object.keys(tree), ...Object.keys(record.tree)])) {
    if (tree[file] !== record.tree[file]) return `codex-edit: ${file} differs from the verified install`;
  }
  for (const [key, entry] of dependencies) {
    const manifest = path.join(root, ...key.split('/'), 'package.json');
    // npm omits optional native packages for other platforms. The recorded tree
    // still detects removal of any optional package that was actually installed.
    if (entry.optional && !existsSync(manifest)) continue;
    if (read(manifest, key)?.version !== entry.version) return `codex-edit dependency ${key} differs from locked version ${entry.version}`;
  }
  const version = read(path.join(packageRoot(root), 'package.json'), 'the toolkit manifest')?.version;
  if (version !== CODEX_EDIT_PINS.version) return `${prefix} holds toolkit ${version ?? 'nothing'}, pinned ${CODEX_EDIT_PINS.version}`;
  if (!existsSync(contained(root, codexEditExtension(root), 'the codex-edit entry file'))) return `${codexEditExtension(root)} absent`;
  for (const file of CODEX_EDIT_FILES) {
    const full = contained(root, path.join(extensionDir(root), file), file);
    if (!existsSync(full)) return `${file} absent in ${extensionDir(root)}`;
    // config.json is orch's own override: compare its content with the pin, not a tarball hash.
    if (file === 'config.json') {
      if (canonical(readJson(full)) !== canonical(CODEX_EDIT_CONFIG)) return `config.json in ${extensionDir(root)} is ${canonical(readJson(full))}, not the pinned ${canonical(CODEX_EDIT_CONFIG)}`;
      continue;
    }
    const pinned = CODEX_EDIT_HASHES[file];
    if (typeof pinned !== 'string') return `codex-edit.json pins no sha256 for ${file}`;
    const actual = sha256(full);
    if (actual !== pinned) return `${file} in ${extensionDir(root)} is sha256 ${actual}, not the pinned ${pinned}`;
    if (record.files?.[file] !== actual) return `${file} in ${extensionDir(root)} differs from the sha256 recorded at install`;
  }
  return null;
}

/** Download the pinned tarball and prove its bytes before npm sees them. */
export async function verifiedTarball(cacheDir, log, pins = CODEX_EDIT_PINS) {
  const name = pins === CODEX_EDIT_PINS ? 'codex-edit' : pins.package;
  const metadataResponse = await fetch(`${pins.registry}${pins.package}/${pins.version}`, { signal: AbortSignal.timeout(60_000) });
  if (!metadataResponse.ok) throw new Error(`${name} registry metadata: HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  if (metadata.dist?.integrity !== pins.integrity || !metadata.dist?.tarball?.startsWith(pins.registry)) {
    throw new Error(`${name}: registry integrity or tarball origin differs from the audited pin`);
  }
  const response = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${name} tarball: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== pins.integrity) throw new Error(`${name}: tarball integrity mismatch: ${integrity}`);
  mkdirSync(cacheDir, { recursive: true });
  // The cache may legitimately sit outside the prefix (the stand arm keeps it in
  // the arm directory), so it is checked on its own: a real directory, and never
  // a tarball path that is a link to a file elsewhere.
  assertRealDir(cacheDir, `the ${name} cache directory`);
  const tarball = path.join(cacheDir, `${pins.package.split('/').at(-1)}-${pins.version}.tgz`);
  if (lstatOrNull(tarball)?.isSymbolicLink()) throw new Error(`codex-edit: refusing to write through a link: ${tarball}`);
  writeFileSync(tarball, bytes, { mode: 0o600 });
  chmodSync(tarball, 0o600);
  log?.(`${name}: verified ${integrity}`);
  return tarball;
}

/** npm's own CLI: Node refuses to spawn npm.cmd on win32 without a shell (CVE-2024-27980), and
 *  shell:true would mis-quote a repo path with spaces, so run the CLI with this node. */
function npmInvocation() {
  if (process.platform !== 'win32') return { command: 'npm', prefix: [] };
  const here = path.dirname(process.execPath);
  const found = [path.join(here, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(here, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((file) => existsSync(file));
  if (!found) throw new Error(`codex-edit: cannot resolve npm's npm-cli.js next to ${process.execPath}`);
  return { command: process.execPath, prefix: [found] };
}

export function npm(args, options, name = 'codex-edit') {
  const { command, prefix } = npmInvocation();
  try {
    return execFileSync(command, [...prefix, ...args], { encoding: 'utf8', timeout: 15 * 60_000, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  } catch (error) {
    throw new Error(`${name}: npm ${args[0]} failed: ${String(error?.stderr ?? error?.message ?? error).slice(-1200)}`);
  }
}

/**
 * Install (or reuse) the verified extension under `prefix`. `extraPackages` are
 * selected from the committed stand lock, as the arm does for pi-mcp-adapter. Throws with
 * the reason; a returned value always verifies.
 */
export async function ensureCodexEdit(prefix, { force = false, log = console.error, extraPackages = [], cacheDir = path.join(prefix, 'cache'), env, cwd = prefix } = {}) {
  if (!path.isAbsolute(prefix)) throw new Error(`codex-edit: prefix must be absolute: ${prefix}`);
  if (!Array.isArray(extraPackages) || (extraPackages.length !== 0 && (extraPackages.length !== 1 || extraPackages[0] !== STAND_EXTRA_PACKAGE))) {
    throw new Error('codex-edit: extra packages must match the committed stand lock');
  }
  const pin = LOCKS[extraPackages.length === 0 ? 0 : 1];
  const dependencies = lockedPackages(pin);
  if (!force) {
    const problem = codexEditProblem(prefix);
    if (problem === null && readJson(path.join(prefix, 'install.json'))?.lockSha256 === pin.hash) return { ok: true, prefix, extension: codexEditExtension(prefix), models: CODEX_EDIT_CONFIG.models, installed: false };
    log?.(`codex-edit: installing into ${prefix} (${problem})`);
  }
  mkdirSync(prefix, { recursive: true });
  const root = assertRealDir(prefix, 'the codex-edit prefix');
  // npm follows a junction at node_modules; refuse one before it can write outside.
  if (existsSync(path.join(root, 'node_modules'))) assertRealDir(path.join(root, 'node_modules'), 'the codex-edit node_modules');
  // A repair must clear first: npm's arborist sees the pinned version already
  // present and reifies nothing, so a tampered or partially extracted install
  // would survive the reinstall and the printed repair command could never repair.
  // Both removals are contained, and a linked leaf is unlinked, never followed.
  const removedPackage = removeContained(root, path.join(root, 'node_modules'), 'the installed dependencies');
  const removedRecord = removeContained(root, path.join(root, 'install.json'), 'the install record');
  if (removedPackage || removedRecord) log?.(`codex-edit: cleared the previous install under ${root} (package ${removedPackage}, record ${removedRecord})`);
  await verifiedTarball(cacheDir, log);
  // Keep the pre-npm tarball proof; npm ci independently validates all locked
  // tarballs, including the toolkit, before extracting them.
  const cache = assertRealDir(cacheDir, 'the codex-edit cache directory');
  writeContained(root, path.join(root, 'package.json'), pin.manifest, 'the npm manifest');
  writeContained(root, path.join(root, 'package-lock.json'), pin.bytes, 'the dependency lock');
  log?.(`codex-edit: npm ci --ignore-scripts (${dependencies.length} integrity-pinned packages)`);
  // No .bin links: the extension is loaded by its entry file, not an npm CLI.
  npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--bin-links=false', '--prefix', root], { cwd, env: { ...process.env, ...env, npm_config_cache: cache } });
  const version = readJson(contained(root, path.join(packageRoot(root), 'package.json'), 'the toolkit manifest'))?.version;
  if (version !== CODEX_EDIT_PINS.version) throw new Error(`codex-edit: installed toolkit ${version ?? 'nothing'}, pinned ${CODEX_EDIT_PINS.version}`);
  // Upstream reads config.json adjacent to index.ts and ships gpt-5.6-*: write the
  // pin, contained, so a junction in the extracted tree cannot redirect the write.
  writeContained(root, path.join(extensionDir(root), 'config.json'), `${JSON.stringify(CODEX_EDIT_CONFIG, null, 2)}\n`, 'the codex-edit config');
  const files = Object.fromEntries(CODEX_EDIT_FILES.map((file) => [file, sha256(contained(root, path.join(extensionDir(root), file), file))]));
  writeContained(root, path.join(root, 'install.json'), `${JSON.stringify({
    package: CODEX_EDIT_PACKAGE, integrity: CODEX_EDIT_INTEGRITY, config: CODEX_EDIT_CONFIG, files,
    lockSha256: pin.hash, tree: installedTree(root),
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'the codex-edit install record');
  const problem = codexEditProblem(prefix);
  if (problem) throw new Error(`codex-edit: the fresh install does not verify: ${problem}`);
  return { ok: true, prefix, extension: codexEditExtension(prefix), models: CODEX_EDIT_CONFIG.models, installed: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const named = (flag) => { const at = args.indexOf(flag); return at === -1 ? undefined : args[at + 1]; };
  const check = args.includes('--check');
  if (!check && !args.includes('--ensure')) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'usage: codex-edit-install.mjs --ensure [--prefix DIR] [--force] | --check --prefix DIR' })}\n`);
    process.exit(1);
  }
  const prefix = named('--prefix') ?? stockCodexEditPrefix();
  const result = check
    ? (codexEditProblem(prefix) === null
      ? { ok: true, prefix, extension: codexEditExtension(prefix), models: CODEX_EDIT_CONFIG.models, installed: false }
      : { ok: false, prefix, reason: codexEditProblem(prefix) })
    : await ensureCodexEdit(prefix, { force: args.includes('--force') }).catch((error) => ({ ok: false, prefix, reason: error.message }));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exit(1);
}
