#!/usr/bin/env node
// Stock hashline install. Reuse codex-edit's audited npm/tarball/confinement
// primitives; never touch either stand arm's profile or versioned hash store.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRealDir, contained, writeContained, removeContained, npm } from './codex-edit-install.mjs';
import { integrityPinnedPackages, installedTree as dependencyTree } from './npm-install-tree.mjs';

export const HASHLINE_EDIT_PINS = JSON.parse(readFileSync(new URL('./hashline-edit.json', import.meta.url), 'utf8'));
export const HASHLINE_451_PACKAGE = `${HASHLINE_EDIT_PINS.package}@${HASHLINE_EDIT_PINS.version}`;
export const HASHLINE_451_TYPEBOX = HASHLINE_EDIT_PINS.peer;
export const HASHLINE_451_CONFIG = HASHLINE_EDIT_PINS.config;
// The stock scope guard reads path; upstream binds it to anchor ownership in
// src/edit-common.ts resolveEditTargetWithRequirement. Stand pins stay unchanged.
const STOCK_CONFIG = { ...HASHLINE_451_CONFIG, requirePath: true };
// Stand-only 5.0.0 pins. ensureHashlineEdit stays on HASHLINE_EDIT_PINS (4.5.1).
export const HASHLINE_500_PINS = JSON.parse(readFileSync(new URL('./hashline-edit-500.json', import.meta.url), 'utf8'));
export const HASHLINE_500_PACKAGE = `${HASHLINE_500_PINS.package}@${HASHLINE_500_PINS.version}`;
export const HASHLINE_500_TYPEBOX = HASHLINE_500_PINS.peer;
export const HASHLINE_500_CONFIG = HASHLINE_500_PINS.config;
export const HASHLINE_500_INTEGRITY = HASHLINE_500_PINS.integrity;
const packagePath = (root) => path.join(root, 'node_modules', HASHLINE_EDIT_PINS.package);
export const hashlineEditExtension = (root) => path.join(packagePath(root), HASHLINE_EDIT_PINS.extension);
export const hashlineEditStore = (root) => path.join(root, 'hashline');
export function stockHashlineEditPrefix(stateDir = process.env.ORCH_STATE_DIR ? path.resolve(process.env.ORCH_STATE_DIR) : path.join(os.homedir(), '.local', 'state', 'orch')) {
  return path.join(stateDir, 'pi-extensions', 'hashline-edit');
}
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const LOCK_BYTES = readFileSync(new URL('./hashline-edit-lock.json', import.meta.url));
const LOCK = JSON.parse(LOCK_BYTES);
const LOCK_HASH = createHash('sha256').update(LOCK_BYTES).digest('hex');
const MANIFEST_BYTES = `${JSON.stringify({ ...LOCK.packages[''], private: true }, null, 2)}\n`;
const inside = (root, file, create = false) => contained(root, file, 'hashline-edit verification', { create, name: 'hashline-edit' });
const write = (root, file, bytes) => writeContained(root, file, bytes, 'hashline-edit install', 'hashline-edit');

/** npm ci validates each locked tarball's integrity before extraction. No
 * registry specs, links, unpinned peers or outside-prefix paths are allowed. */
function lockedPackages() {
  const [peer, version] = HASHLINE_451_TYPEBOX.split('@');
  return integrityPinnedPackages(LOCK, HASHLINE_EDIT_PINS, { [peer]: version }, 'hashline-edit');
}

/** Hash the complete tree, not just entry points; reject links/special files.
 * Enumeration also detects additions and deletions on subsequent checks. */
const installedTree = (root) => dependencyTree(root, inside, 'hashline-edit');

export function hashlineEditProblem(prefix) {
  return inspectHashlineEdit(prefix, true);
}

function inspectHashlineEdit(prefix, checkConfig) {
  try {
    const dependencies = lockedPackages();
    const root = assertRealDir(prefix, 'the hashline-edit prefix', 'hashline-edit');
    const read = (file) => json(inside(root, file));
    const record = read(path.join(root, 'install.json'));
    const pins = HASHLINE_EDIT_PINS;
    if (record.package !== HASHLINE_451_PACKAGE || record.integrity !== pins.integrity) return 'hashline-edit install record differs from the pins';
    if (record.lockSha256 !== LOCK_HASH || !record.tree || typeof record.tree !== 'object') return 'hashline-edit dependency manifest is absent or stale; reinstall';
    if (!readFileSync(inside(root, path.join(root, 'package-lock.json'))).equals(LOCK_BYTES) ||
        readFileSync(inside(root, path.join(root, 'package.json')), 'utf8') !== MANIFEST_BYTES) return 'hashline-edit npm inputs differ from the committed lock';
    const tree = installedTree(root);
    for (const file of new Set([...Object.keys(tree), ...Object.keys(record.tree)])) {
      if (tree[file] !== record.tree[file]) return `hashline-edit: ${file} differs from the verified install`;
    }
    for (const [file, hash] of Object.entries(pins.hashes)) {
      const actual = sha256(inside(root, path.join(packagePath(root), file)));
      if (actual !== hash || record.files?.[file] !== actual) return `hashline-edit: ${file} differs from pinned sha256 ${hash}`;
    }
    for (const [key, entry] of dependencies) {
      if (read(path.join(root, ...key.split('/'), 'package.json')).version !== entry.version) return `hashline-edit dependency ${key} differs from locked version ${entry.version}`;
    }
    execFileSync('rg', ['--version'], { timeout: 10_000, stdio: 'pipe' });
    if (checkConfig) {
      const config = read(path.join(hashlineEditStore(root), 'config.json'));
      // Upstream fills in other defaults when saving its configuration. These
      // safety switches must remain explicit after every start.
      if (config.copyMoveEnabled !== false || config.anchorGrepEnabled !== false) return 'hashline-edit requires copyMoveEnabled:false and anchorGrepEnabled:false';
      if (config.requirePath !== true) return 'hashline-edit requires requirePath:true';
    }
    return null;
  } catch (error) { return error.message.startsWith('hashline-edit:') ? error.message : `hashline-edit: ${error.message}`; }
}

const verdict = (prefix, installed = false) => ({ ok: true, prefix, extension: hashlineEditExtension(prefix), store: hashlineEditStore(prefix), installed });
function writeStockConfig(root) {
  const store = inside(root, hashlineEditStore(root), true);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  write(root, path.join(store, 'config.json'), `${JSON.stringify(STOCK_CONFIG, null, 2)}\n`);
}

export async function ensureHashlineEdit(prefix, { force = false, log = console.error } = {}) {
  if (!path.isAbsolute(prefix)) throw new Error(`hashline-edit: prefix must be absolute: ${prefix}`);
  lockedPackages();
  if (!force && hashlineEditProblem(prefix) === null) return verdict(prefix);
  // Remote provisioning ensures on every seat start. A config migration must
  // not remove verified dependencies that other running seats are still using.
  if (!force && inspectHashlineEdit(prefix, false) === null) {
    writeStockConfig(assertRealDir(prefix, 'the hashline-edit prefix', 'hashline-edit'));
    const problem = hashlineEditProblem(prefix);
    if (problem) throw new Error(problem);
    return verdict(prefix);
  }
  mkdirSync(prefix, { recursive: true });
  const root = assertRealDir(prefix, 'the hashline-edit prefix', 'hashline-edit');
  // Dedicated stock prefix: clear npm's whole tree so it cannot preserve a
  // tampered package/peer/dependency, and never traverse linked leaves.
  removeContained(root, path.join(root, 'node_modules'), 'hashline-edit dependencies', 'hashline-edit');
  removeContained(root, path.join(root, 'install.json'), 'hashline-edit install record', 'hashline-edit');
  const cache = path.join(root, 'cache');
  // Validate before mkdir: a cache junction must not redirect npm or tarball writes.
  inside(root, cache, true);
  mkdirSync(cache, { recursive: true });
  write(root, path.join(root, 'package.json'), MANIFEST_BYTES);
  write(root, path.join(root, 'package-lock.json'), LOCK_BYTES);
  log?.(`hashline-edit: npm ci --ignore-scripts (${lockedPackages().length} integrity-pinned packages)`);
  npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--prefix', root], { cwd: root, env: { ...process.env, npm_config_cache: cache } }, 'hashline-edit');
  writeStockConfig(root);
  const files = Object.fromEntries(Object.keys(HASHLINE_EDIT_PINS.hashes).map(file => [file, sha256(inside(root, path.join(packagePath(root), file)))]));
  write(root, path.join(root, 'install.json'), `${JSON.stringify({ package: HASHLINE_451_PACKAGE, integrity: HASHLINE_EDIT_PINS.integrity, lockSha256: LOCK_HASH, tree: installedTree(root), files, installedAt: new Date().toISOString() }, null, 2)}\n`);
  const problem = hashlineEditProblem(prefix);
  if (problem) throw new Error(problem);
  return verdict(prefix, true);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--prefix');
  const prefix = at === -1 ? stockHashlineEditPrefix() : args[at + 1];
  let result;
  try {
    if (!args.includes('--ensure') && !args.includes('--check')) throw new Error('usage: hashline-edit-install.mjs --ensure|--check [--prefix DIR] [--force]');
    if (args.includes('--check')) {
      const reason = hashlineEditProblem(prefix);
      result = reason ? { ok: false, prefix, reason } : verdict(prefix);
    } else result = await ensureHashlineEdit(prefix, { force: args.includes('--force') });
  } catch (error) { result = { ok: false, prefix, reason: error.message }; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
