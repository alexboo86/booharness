#!/usr/bin/env node
// The single memory backup path. On the NAS it publishes to a local directory
// on another filesystem. On the Mac, --ship-to streams the same generations
// to the NAS (`ssh <host> 'cat > …'`); --staging may share the source
// filesystem because the remote copy is the backup. Never run it against the
// retired workstation DB. No store import: it creates tokens and migrates.
import { createHash } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  closeSync, createReadStream, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const DAY = 86_400_000;
const HEALTH_WINDOW_MS = 26 * 3_600_000;
const GENERATION = /^memory-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)$/;
const SUCCESS = '/tmp/memory-backup-success.json';
// Last successful ship. Written only after the remote generation is renamed
// into place and remote retention has completed.
export const SHIPPED_STATE = '.memory-backup-shipped.json';
const SSH_TIMEOUT_MS = 10 * 60_000;
// Leave three minutes for owner cleanup before the scheduler's 15-minute kill.
const SHIP_TIMEOUT_MS = 12 * 60_000;
const SSH_STDIO_CAP = 1_048_576;
const SNAPSHOT_FILES = ['memory.db', 'manifest.json'];
const SHIP_HOST = /^[A-Za-z0-9._@+-]{1,200}$/;
const REMOTE_PATH = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/;

function syncPath(path) {
  // Unix fsync of an O_RDONLY fd is the durability path, including directories
  // (they cannot be opened for write). Windows FlushFileBuffers rejects that
  // handle with EPERM; a writable handle succeeds there. The Unix flag stays 'r'.
  const fd = openSync(path, process.platform === 'win32' ? 'r+' : 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function counts(db) {
  // Include all application tables, FTS and its shadow tables; no record bodies.
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all();
  const result = Object.fromEntries(tables.map(({ name }) => [
    name, db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n,
  ]));
  if (!Object.hasOwn(result, 'mem_entries') || !Object.hasOwn(result, 'mem_tasks')) {
    throw new Error('source is not a memory database: mem_entries/mem_tasks missing');
  }
  return result;
}

export function verifySnapshot(directory, expected = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')).counts) {
  const db = new DatabaseSync(join(directory, 'memory.db'), { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error(`integrity_check failed: ${JSON.stringify(integrity)}`);
    }
    const actual = counts(db);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`snapshot counts differ: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    }
    return actual;
  } finally { db.close(); }
}

function checkDeadline({ signal, deadline } = {}) {
  signal?.throwIfAborted();
  if (deadline !== undefined && performance.now() >= deadline) throw new Error('ship deadline exceeded');
}

export async function createSnapshot(source, directory, budget = {}) {
  checkDeadline(budget);
  mkdirSync(directory, { mode: 0o700 }); // Never overwrite a previous snapshot.
  const target = join(directory, 'memory.db');
  const reader = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
  let expected;
  let snapshotAt;
  try {
    if (reader.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') {
      throw new Error('live memory database must use WAL');
    }
    // BEGIN + first SELECT pins the WAL view. Keep this SAME connection and
    // transaction for counts and backup, so concurrent commits cannot skew them.
    reader.exec('BEGIN');
    expected = counts(reader);
    snapshotAt = new Date().toISOString();
    checkDeadline(budget);
    await backup(reader, target, { progress: () => checkDeadline(budget) });
  } finally { reader.close(); } // Releases the read transaction, even on failure.
  checkDeadline(budget);

  // Only the new copy is writable. Make it a standalone file without sidecars.
  const copy = new DatabaseSync(target);
  try { copy.exec('PRAGMA journal_mode=DELETE'); } finally { copy.close(); }
  verifySnapshot(directory, expected);
  checkDeadline(budget);
  const manifest = { snapshotAt, counts: expected, integrity: 'ok', bytes: statSync(target).size };
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  syncPath(target);
  syncPath(join(directory, 'manifest.json'));
  syncPath(directory);
  checkDeadline(budget);
  return manifest;
}

export function assertSeparateStorage(source, destination) {
  const src = statSync(source);
  const dst = statSync(destination); // Must already exist; never create a missing mount.
  if (!src.isFile() || !dst.isDirectory()) throw new Error('source must be a file and destination an existing directory');
  if (src.dev === dst.dev) throw new Error('backup destination must be on a different filesystem from the live database');
}

function retentionRemovals(generations, now) {
  const today = Math.floor(now.getTime() / DAY);
  const seen = new Set();
  const removed = [];
  // ISO names, not mtimes: copying/restoring an old generation must not rejuvenate it.
  for (const name of [...generations].sort().reverse()) {
    const timestamp = name.slice(7).replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
    const age = today - Math.floor(Date.parse(timestamp) / DAY);
    if (!Number.isFinite(age) || age < 0) throw new Error(`invalid/future backup date: ${name}`);
    // Seven UTC dates (today + 6); then eight disjoint seven-day windows.
    const bucket = age < 7 ? `day-${age}` : age < 63 ? `week-${Math.floor((age - 7) / 7)}` : null;
    if (bucket !== null && !seen.has(bucket)) {
      seen.add(bucket);
    } else {
      removed.push(name);
    }
  }
  return removed;
}

export function rotate(destination, now = new Date()) {
  const generations = readdirSync(destination, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && GENERATION.test(entry.name))
    .map((entry) => entry.name);
  const removed = retentionRemovals(generations, now);
  for (const name of removed) {
    rmSync(join(destination, name), { recursive: true }); // Any failure is fatal.
  }
  syncPath(destination);
  return { kept: generations.length - removed.length, removed: removed.length };
}

export async function runBackup(source, destination) {
  assertSeparateStorage(source, destination);
  const lock = join(destination, '.memory-backup.lock');
  mkdirSync(lock, { mode: 0o700 }); // Exclusive across scheduler and manual runs.
  try {
    const now = new Date();
    const staging = join(lock, 'snapshot');
    const manifest = await createSnapshot(source, staging);
    const target = join(destination, `memory-${now.toISOString().replaceAll(':', '-')}`);
    renameSync(staging, target); // Publish DB + manifest together, only after validation/fsync.
    syncPath(destination);
    const retention = rotate(destination, now); // Never rotate after a failed snapshot.
    writeFileSync(SUCCESS, JSON.stringify({ completedAt: new Date().toISOString(), target }), { mode: 0o600 });
    return { ok: true, target, ...manifest, ...retention };
  } finally { rmSync(lock, { recursive: true }); }
  // SIGKILL leaves the lock: fail loudly until an operator checks/clears it.
}

function safeRemotePath(path) {
  const segments = path.split('/').slice(1);
  if (!REMOTE_PATH.test(path) || segments.some((part) => part === '.' || part === '..')) {
    throw new Error('refusing remote path');
  }
  return `'${path}'`;
}

export function parseShipTo(value) {
  const split = value.indexOf(':');
  if (split <= 0) throw new Error('ship-to must be <ssh-host>:<absolute dir>');
  const host = value.slice(0, split);
  const dir = value.slice(split + 1);
  if (!SHIP_HOST.test(host) || host.startsWith('-')) throw new Error('ship-to host has unsupported characters');
  safeRemotePath(dir);
  return { host, dir };
}

function runSsh(ssh, remoteCommand, { inputPath } = {}) {
  checkDeadline(ssh);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let input;
    let failure;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ssh.signal.removeEventListener('abort', onAbort);
      input?.destroy();
      callback(value);
    };
    const child = spawn(ssh.program, [...ssh.args, ssh.host, remoteCommand], {
      stdio: [inputPath ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const fail = (error) => {
      failure ??= error;
      input?.destroy();
      child.stdin?.destroy();
      child.kill('SIGKILL');
      // Settle on close: the owner must not remove staging under a live child.
    };
    const onAbort = () => fail(ssh.signal.reason);
    ssh.signal.addEventListener('abort', onAbort, { once: true });
    timer = globalThis.setTimeout(() => fail(new Error('ssh timed out')), SSH_TIMEOUT_MS);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > SSH_STDIO_CAP) {
        fail(new Error('ssh stdout exceeded 1 MiB'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= SSH_STDIO_CAP) stderr.push(chunk);
    });
    child.on('error', (error) => { failure ??= error; });
    child.on('close', (status) => {
      if (failure) {
        finish(reject, failure);
        return;
      }
      finish(resolve, {
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    if (inputPath) {
      input = createReadStream(inputPath);
      const ignorePipe = (error) => {
        if (error.code === 'EPIPE' || error.code === 'ECONNRESET') return;
        fail(error);
      };
      input.on('error', fail);
      child.stdin.on('error', ignorePipe);
      input.pipe(child.stdin);
    }
    if (ssh.signal.aborted) onAbort();
  });
}

async function sshOk(ssh, remoteCommand, options) {
  const result = await runSsh(ssh, remoteCommand, options);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || 'no output';
    throw new Error(`ssh failed (${result.status ?? 'killed'}): ${detail}`);
  }
  return result.stdout;
}

function sha256File(path, signal) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path, { signal });
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function listRemoteGenerations(ssh, dir) {
  const stdout = await sshOk(ssh, `find ${safeRemotePath(dir)} -mindepth 1 -maxdepth 1 -type d -name 'memory-*'`);
  const names = [];
  for (const line of stdout.split('\n')) {
    const name = posix.basename(line.trim());
    if (GENERATION.test(name)) names.push(name);
  }
  return names;
}

async function publishRemoteGeneration(ssh, localDir, remoteDir, generation) {
  if (!GENERATION.test(generation)) throw new Error(`refusing generation name: ${generation}`);
  const partial = `${remoteDir}/.partial-${generation}`;
  const finalDir = `${remoteDir}/${generation}`;
  await sshOk(ssh, `rm -rf -- ${safeRemotePath(partial)}`);
  await sshOk(ssh, `mkdir -- ${safeRemotePath(partial)}`);
  const sha256 = {};
  try {
    for (const file of SNAPSHOT_FILES) {
      const remotePath = `${partial}/${file}`;
      await sshOk(ssh, `cat > ${safeRemotePath(remotePath)}`, { inputPath: join(localDir, file) });
      const localHash = await sha256File(join(localDir, file), ssh.signal);
      const remoteHash = (await sshOk(ssh, `sha256sum -- ${safeRemotePath(remotePath)}`)).trim().split(/\s+/)[0];
      if (!/^[0-9a-f]{64}$/.test(remoteHash) || remoteHash !== localHash) throw new Error(`sha256 mismatch for ${file}`);
      sha256[file] = localHash;
    }
    // Rename publishes both files at once. A reader of memory-* never sees the partial.
    await sshOk(ssh, `test ! -e ${safeRemotePath(finalDir)} && mv -- ${safeRemotePath(partial)} ${safeRemotePath(finalDir)}`);
    const present = await listRemoteGenerations(ssh, remoteDir);
    if (!present.includes(generation)) throw new Error('shipped generation missing after rename');
    return sha256;
  } catch (error) {
    await sshOk(ssh, `rm -rf -- ${safeRemotePath(partial)}`).catch(() => {});
    throw error;
  }
}

async function rotateRemoteGenerations(ssh, remoteDir, now) {
  const generations = await listRemoteGenerations(ssh, remoteDir);
  for (const name of retentionRemovals(generations, now)) {
    await sshOk(ssh, `rm -rf -- ${safeRemotePath(`${remoteDir}/${name}`)}`);
  }
}

export function assertShippedHealth(staging, now = Date.now()) {
  let state;
  try {
    state = JSON.parse(readFileSync(join(staging, SHIPPED_STATE), 'utf8'));
  } catch (error) {
    throw new Error(`no shipped memory backup state: ${error.message}`);
  }
  const sha = state.sha256;
  const hashesOk = sha && SNAPSHOT_FILES.every((file) => /^[0-9a-f]{64}$/.test(sha[file] ?? ''));
  if (typeof state.completedAt !== 'string' || !GENERATION.test(state.generation ?? '') || !hashesOk) {
    throw new Error('shipped backup state is incomplete');
  }
  const age = now - Date.parse(state.completedAt);
  if (!Number.isFinite(age) || age < 0 || age > HEALTH_WINDOW_MS) {
    throw new Error('no successful memory backup within 26 hours');
  }
  return state;
}

export async function shipBackup(source, staging, shipTo, options = {}) {
  const { host, dir } = parseShipTo(shipTo);
  if (!statSync(staging).isDirectory()) throw new Error('staging must be an existing directory');
  const program = options.sshProgram ?? 'ssh';
  if (!program) throw new Error('ssh program is required');
  const timeoutMs = options.timeoutMs ?? SHIP_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > SHIP_TIMEOUT_MS) {
    throw new Error(`ship timeout must be from 1 to ${SHIP_TIMEOUT_MS} ms`);
  }
  const controller = new AbortController();
  const ssh = { program, args: [...(options.sshArgs ?? []),
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'], host,
    signal: controller.signal, deadline: performance.now() + timeoutMs };
  const lock = join(staging, '.memory-backup.lock');
  mkdirSync(lock, { mode: 0o700 }); // Exclusive across scheduler and manual runs.
  const timer = globalThis.setTimeout(() => controller.abort(new Error('ship deadline exceeded')), timeoutMs);
  // A long referenced timer delays node:sqlite backup completion on Node 26.
  // Active SSH children keep timeout delivery alive; snapshot progress checks
  // the same monotonic deadline even when no other event-loop handle is active.
  timer.unref();
  let localTarget;
  let shipped = false;
  try {
    await sshOk(ssh, `test -d ${safeRemotePath(dir)}`); // Reach the remote before allocating a snapshot.
    const now = new Date();
    const snapshot = join(lock, 'snapshot');
    const manifest = await createSnapshot(source, snapshot, ssh);
    const generation = `memory-${now.toISOString().replaceAll(':', '-')}`;
    const target = join(staging, generation);
    renameSync(snapshot, target); // Same publish as a local generation, into staging.
    localTarget = target; // Cleanup only a generation this invocation actually published.
    syncPath(staging);
    const sha256 = await publishRemoteGeneration(ssh, localTarget, dir, generation);
    shipped = true;
    const retention = rotate(staging, now); // Never rotate the remote set after a failed ship.
    const kept = new Set(readdirSync(staging).filter((name) => GENERATION.test(name)));
    if (!kept.has(generation)) throw new Error('local rotation dropped the generation just shipped');
    await rotateRemoteGenerations(ssh, dir, now);
    checkDeadline(ssh);
    const completedAt = new Date().toISOString();
    const statePath = join(staging, SHIPPED_STATE);
    writeFileSync(statePath, `${JSON.stringify({ completedAt, generation, sha256 }, null, 2)}\n`, { mode: 0o600 });
    syncPath(statePath);
    return { ok: true, target: `${dir}/${generation}`, generation, sha256, ...manifest, ...retention };
  } finally {
    clearTimeout(timer);
    try {
      if (!shipped && localTarget) rmSync(localTarget, { recursive: true, force: true });
    } finally { rmSync(lock, { recursive: true }); }
  }
}

export function nextRun(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(3, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function childBackupArgs(values) {
  const args = ['--source', values.source];
  if (values['ship-to']) {
    args.push('--ship-to', values['ship-to'], '--staging', values.staging);
    if (values['ssh-program']) args.push('--ssh-program', values['ssh-program']);
    if (values['ship-timeout-ms']) args.push('--ship-timeout-ms', values['ship-timeout-ms']);
    for (const arg of values['ssh-arg'] ?? []) args.push('--ssh-arg', arg);
  } else {
    args.push('--destination', values.destination ?? '/backups');
  }
  return args;
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: 'string', default: '/state/memory.db' },
    destination: { type: 'string' },
    'ship-to': { type: 'string' },
    staging: { type: 'string' },
    'ssh-program': { type: 'string' },
    'ssh-arg': { type: 'string', multiple: true },
    'ship-timeout-ms': { type: 'string' },
    schedule: { type: 'boolean' },
    healthcheck: { type: 'boolean' },
    verify: { type: 'string' },
  } });
  if ([values.schedule, values.healthcheck, values.verify].filter(Boolean).length > 1) {
    throw new Error('choose only one of --schedule, --healthcheck, --verify');
  }
  if (values['ship-to'] && values.destination) throw new Error('choose only one of --destination and --ship-to');
  if (values['ship-to'] && !values.staging && !values.healthcheck) throw new Error('--ship-to requires --staging');
  if (values.verify) {
    console.log(JSON.stringify({ ok: true, integrity: 'ok', counts: verifySnapshot(values.verify) }));
  } else if (values.healthcheck) {
    if (values.staging) assertShippedHealth(values.staging);
    else if (values['ship-to']) throw new Error('--healthcheck of a shipped backup requires --staging');
    else {
      const { completedAt, target } = JSON.parse(readFileSync(SUCCESS, 'utf8'));
      const age = Date.now() - Date.parse(completedAt);
      if (!Number.isFinite(age) || age < 0 || age > HEALTH_WINDOW_MS) throw new Error('no successful memory backup within 26 hours');
      statSync(join(target, 'memory.db'));
      statSync(join(target, 'manifest.json'));
    }
  } else if (values.schedule) {
    // One bounded child at a time. A stuck backup cannot hold a WAL reader forever.
    // A failed ship exits non-zero and does not change the remote generation set;
    // the supervisor's next start is the retry. Shipped health judges the last
    // verified ship; a scheduler restart does not reset it.
    if (!values['ship-to']) rmSync(SUCCESS, { force: true });
    for (;;) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...childBackupArgs(values)], {
        encoding: 'utf8', timeout: 15 * 60_000, killSignal: 'SIGKILL',
      });
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
      if (child.error || child.status !== 0) throw new Error(`backup child failed: ${child.error?.message ?? child.signal ?? child.status}`);
      const result = JSON.parse(child.stdout);
      if (result.ok !== true) throw new Error('backup child did not report success');
      const next = nextRun();
      console.log(JSON.stringify({ nextRun: next.toISOString() }));
      await setTimeout(next.getTime() - Date.now());
    }
  } else if (values['ship-to']) {
    console.log(JSON.stringify(await shipBackup(values.source, values.staging, values['ship-to'], {
      sshProgram: values['ssh-program'],
      sshArgs: values['ssh-arg'],
      timeoutMs: values['ship-timeout-ms'] === undefined ? undefined : Number(values['ship-timeout-ms']),
    })));
  } else {
    console.log(JSON.stringify(await runBackup(values.source, values.destination ?? '/backups')));
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}
