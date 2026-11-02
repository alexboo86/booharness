import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from '../bundle.mjs';
import { createSupervisor } from './supervisor.mjs';

const MAX_ARTIFACT = 67_108_864;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function installRoot(home, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return platform === 'win32' ? p.join(home, 'AppData', 'Local', 'OrchHostAgent') : p.join(home, '.local', 'share', 'orch-host-agent');
}

function assertBareHttpsAddress(address) {
  let origin;
  try { origin = new URL(address); } catch { throw new Error('invalid pairing address'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('pairing address must be a bare https://host:port address');
  }
}

export function parsePairing(line) {
  let value;
  try { value = JSON.parse(line); } catch { throw new Error('pairing input must be one JSON line'); }
  const keys = Object.keys(value ?? {}).sort().join(',');
  if (value?.version !== 1 || typeof value.address !== 'string' || typeof value.secret !== 'string') {
    throw new Error('pairing input requires version, address and secret');
  }
  if (keys === 'address,fingerprint,secret,version') {
    if (!/^[A-Za-z0-9_-]{22}$/.test(value.secret)) throw new Error('invalid pairing secret');
    if (!/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error('invalid pairing fingerprint');
    assertBareHttpsAddress(value.address);
    return { origin: value.address, pair: { mode: 'qr', secret: value.secret, fingerprint: value.fingerprint } };
  }
  throw new Error('pairing input must be the one-line QR payload');
}

function atomicWrite(file, bytes, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, file);
}

const RESERVED_ARCHIVE_NAMES = new Set(['con', 'conin$', 'conout$', 'prn', 'aux', 'nul', ...Array.from({ length: 10 }, (_, i) => `com${i}`), ...Array.from({ length: 10 }, (_, i) => `lpt${i}`)]);

function unsafeArchiveRoot(name) {
  return typeof name !== 'string' || !name || /[\\*<>|"\0-\x1f\x7f:%?#]/.test(name)
    || path.posix.isAbsolute(name) || path.win32.isAbsolute(name);
}

function unsafeArchivePart(part) {
  return !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || RESERVED_ARCHIVE_NAMES.has(part.split('.')[0].trimEnd().toLowerCase());
}

function archivePath(name) {
  const parts = typeof name === 'string' ? name.split('/') : [];
  if (unsafeArchiveRoot(name) || parts.some(unsafeArchivePart)) {
    throw new Error(`${name || 'archive entry'}: unsafe archive path`);
  }
  return parts.join('/');
}

function octal(block, offset, length, name) {
  const text = block.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`${name}: invalid tar size`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`${name}: oversized tar entry`);
  return value;
}

function tarEntryName(block) {
  const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
  const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
  return archivePath(prefix ? `${prefix}/${name}` : name);
}

// A deliberately small ustar reader: regular files and directories only. It
// never lets an archive create a symlink/hardlink before bundle verification.
function unpackTar(bytes, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const seen = new Set();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every(byte => byte === 0)) return;
    const name = tarEntryName(block);
    const folded = name.toLowerCase();
    if (seen.has(folded)) throw new Error(`${name}: duplicate archive entry`);
    seen.add(folded);
    const size = octal(block, 124, 12, name);
    const type = block[156];
    const target = path.join(destination, ...name.split('/'));
    if (type === 53) {
      if (size !== 0) throw new Error(`${name}: invalid directory`);
      mkdirSync(target, { recursive: true, mode: 0o700 });
    } else {
      if (type !== 0 && type !== 48) throw new Error(`${name}: only regular files are allowed`);
      if (offset + 512 + size > bytes.length) throw new Error(`${name}: truncated archive entry`);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes.subarray(offset + 512, offset + 512 + size), { flag: 'wx', mode: 0o600 });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('archive: missing tar terminator');
}

export function artifactDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || match.slice(1).some(part => !Number.isSafeInteger(Number(part)))) throw new Error(`invalid update version ${version}`);
  return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return 0;
}

export function readPointer(root) {
  const pointer = JSON.parse(readFileSync(path.join(root, 'current.json'), 'utf8'));
  if (typeof pointer.version !== 'string' || typeof pointer.directory !== 'string' || typeof pointer.entry !== 'string') {
    throw new Error('current.json: invalid installation pointer');
  }
  return pointer;
}

export function stagedDirectory(root, pointer) {
  if (!/^versions\/[a-f0-9]{64}$/.test(pointer.directory)) throw new Error('current.json: unsafe version directory');
  return path.join(root, ...pointer.directory.split('/'));
}

export function stageArtifact({ root, artifact, expectedSha256, expectedVersion }) {
  const announced = statSync(artifact);
  if (!announced.isFile() || announced.size < 1 || announced.size > MAX_ARTIFACT) throw new Error('update artifact size is outside the protocol bound');
  const bytes = readFileSync(artifact);
  if (bytes.length !== announced.size) throw new Error('update artifact changed while being read');
  const digest = artifactDigest(bytes);
  if (expectedSha256 !== undefined && digest !== expectedSha256) throw new Error('update artifact: SHA-256 mismatch');
  const id = createHash('sha256').update(bytes).digest('hex');
  const staging = path.join(root, '.staging', `${id}-${randomBytes(6).toString('hex')}`);
  const destination = path.join(root, 'versions', id);
  rmSync(staging, { recursive: true, force: true });
  try {
    unpackTar(bytes, staging);
    const manifest = verifyBundle(staging);
    if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
      throw new Error(`manifest.json: version ${manifest.version} does not match offer ${expectedVersion}`);
    }
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (existsSync(destination)) {
      verifyBundle(destination);
      return { version: manifest.version, directory: `versions/${id}`, entry: manifest.entry };
    }
    renameSync(staging, destination);
    return { version: manifest.version, directory: `versions/${id}`, entry: manifest.entry };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function copyStableLauncher(root) {
  copyFileSync(path.join(HERE, 'launcher.mjs'), path.join(root, 'launcher.mjs'));
  copyFileSync(path.join(HERE, 'switch.mjs'), path.join(root, 'switch.mjs'));
  copyFileSync(path.join(HERE, '..', 'bundle.mjs'), path.join(root, 'verifier.mjs'));
  copyFileSync(path.join(HERE, '..', 'imports.mjs'), path.join(root, 'imports.mjs'));
}

function defaultSupervisor(root, config) {
  return createSupervisor({ root, ...config });
}

export function installAgent({ home, platform = process.platform, nodePath = process.execPath, artifact, pairing, supervisor }) {
  const root = installRoot(home, platform);
  if (existsSync(root)) throw new Error(`${root}: installation already exists`);
  const config = { home, platform, nodePath, origin: pairing.origin };
  let pointer;
  let service;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    pointer = stageArtifact({ root, artifact });
    copyStableLauncher(root);
    atomicWrite(path.join(root, 'config.json'), `${JSON.stringify(config)}\n`);
    atomicWrite(path.join(root, 'pairing.json'), `${JSON.stringify({ ...pairing, approvedFingerprint: null })}\n`);
    atomicWrite(path.join(root, 'current.json'), `${JSON.stringify(pointer)}\n`);
    service = supervisor ?? defaultSupervisor(root, config);
    service.install();
    service.restart(pointer.version);
    return { root, ...pointer };
  } catch (error) {
    if (service) {
      try { service.uninstall(); }
      catch (cleanupError) { throw new Error(`install failed (${error.message}); service cleanup failed (${cleanupError.message}); files retained for recovery`); }
    }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function activateStaged({ root, pointer, supervisor, config }) {
  const previous = readPointer(root);
  if (compareVersions(pointer.version, previous.version) <= 0) throw new Error('update downgrade or reinstall is refused');
  const manifest = verifyBundle(stagedDirectory(root, pointer));
  if (manifest.version !== pointer.version || manifest.entry !== pointer.entry) throw new Error('staged pointer does not match its verified bundle');
  const service = supervisor ?? defaultSupervisor(root, config ?? JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8')));
  atomicWrite(path.join(root, 'current.json'), `${JSON.stringify(pointer)}\n`);
  try {
    service.restart(pointer.version);
  } catch (error) {
    atomicWrite(path.join(root, 'current.json'), `${JSON.stringify(previous)}\n`);
    try { service.restart(previous.version); }
    catch (rollbackError) {
      throw new Error(`update start failed (${error.message}); rollback start also failed (${rollbackError.message})`);
    }
    rmSync(stagedDirectory(root, pointer), { recursive: true, force: true });
    throw new Error(`update start failed; rolled back to ${previous.version}: ${error.message}`);
  }
  return pointer;
}

export function uninstallAgent({ home, platform = process.platform, supervisor }) {
  const root = installRoot(home, platform);
  const config = existsSync(path.join(root, 'config.json'))
    ? JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8')) : { home, platform, nodePath: process.execPath };
  (supervisor ?? defaultSupervisor(root, config)).uninstall();
  rmSync(root, { recursive: true, force: true });
}

