#!/usr/bin/env node
// A machine-local FIFO for expensive seat builds. The seat PATH shims are installed separately.
import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; } // EPERM means it is still alive.
};
const pidIn = (file) => {
  try { return Number(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
};
const remove = (file) => { try { rmSync(file, { force: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; } };

function resolveTool(tool, shimDir, allowPath = false) {
  if (path.basename(tool) !== tool) {
    if (!allowPath) throw new Error('tool must be a command name');
    const resolved = path.resolve(tool);
    try { if (statSync(resolved).isFile()) return resolved; } catch { /* named below */ }
    throw new Error(`build-gate: ${tool} is not an existing file`);
  }
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const names = process.platform === 'win32' && !path.extname(tool) ? extensions.map((ext) => tool + ext) : [tool];
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  for (const dir of (process.env[pathKey] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const resolvedDir = path.resolve(dir);
    if (shimDir && resolvedDir.toLowerCase() === path.resolve(shimDir).toLowerCase()) continue;
    // buildShimDir puts every orch shim dir at <stateDir>/build-gate/bin. Skip all
    // of them, even when an earlier dir survives on PATH or the env marker is lost.
    const shimPath = process.platform === 'win32' ? resolvedDir.toLowerCase() : resolvedDir;
    if (path.basename(shimPath) === 'bin' && path.basename(path.dirname(shimPath)) === 'build-gate') continue;
    for (const name of names) {
      const file = path.join(resolvedDir, name);
      try {
        if (!statSync(file).isFile()) continue;
        if (process.platform !== 'win32') accessSync(file, constants.X_OK);
        return file;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
      }
    }
  }
  throw new Error(`build-gate: ${tool} not found outside ORCH_BUILD_SHIM_DIR`);
}

/** Bare tool name: lower case, without a Windows .exe/.cmd/.bat suffix. */
export function toolName(tool) {
  return String(tool).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
}

export function heavy(tool, args) {
  switch (toolName(tool)) {
    case 'cargo': {
      const optionsWithValue = new Set(['--color', '--manifest-path', '--target-dir', '--config', '-Z']);
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (optionsWithValue.has(arg)) { i++; continue; }
        if (arg.startsWith('-') || arg.startsWith('+')) continue;
        return ['build', 'check', 'test', 'clippy', 'run', 'bench', 'doc', 'install', 'rustc'].includes(arg);
      }
      return false;
    }
    case 'rustc': case 'msbuild': return true;
    case 'cmake': return args.includes('--build');
    case 'ninja': return !args.includes('-t') && !args.includes('--tool');
    default: return false;
  }
}

// libuv 1.52 src/win/error.c: ERROR_ACCESS_DENIED is EPERM (158), sharing and lock
// violations are EBUSY (84-86), ERROR_CANT_ACCESS_FILE is EACCES (74). A held or
// delete-pending gate file returns those instead of EEXIST or ENOENT, on create and on
// read, stat or remove alike. Unix permission errors stay immediate.
const LOCK_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const LOCK_BUSY_MS = 5000;
const busy = (error) => process.platform === 'win32' && LOCK_BUSY.has(error?.code);
const busyTimeout = (what, error, file) =>
  new Error(`build-gate: timed out waiting for ${what} (${error.code} for ${LOCK_BUSY_MS}ms): ${file}`, { cause: error });

// Runs fn, retrying while it throws a Windows busy code, for at most LOCK_BUSY_MS.
async function whileBusy(what, file, fn) {
  const since = Date.now();
  for (;;) {
    try { return fn(); } catch (error) {
      if (!busy(error)) throw error;
      if (Date.now() - since >= LOCK_BUSY_MS) throw busyTimeout(what, error, file);
      await sleep(50);
    }
  }
}

// Removes one of this gate's own ticket or slot files. A removal still busy after the bound is
// reported and left: its pid dies with this process, so prune reclaims it, and the build's
// own exit code stands.
async function release(file) {
  try { await whileBusy('a gate file', file, () => remove(file)); } catch (error) {
    if (!busy(error.cause)) throw error;
    console.error(error.message);
  }
}

// Both ticket allocation and slot acquisition are serialized by a short-lived mutex.
async function locked(dir, fn) {
  const mutex = path.join(dir, 'mutex');
  for (;;) {
    let fd;
    try { fd = await whileBusy('the build mutex', mutex, () => openSync(mutex, 'wx')); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await whileBusy('the build mutex', mutex, () => {
        try {
          const pid = pidIn(mutex);
          if ((pid && !alive(pid)) || (!pid && Date.now() - statSync(mutex).mtimeMs > 5000)) remove(mutex);
        } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      });
      await sleep(50);
      continue;
    }
    try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
    break;
  }
  try { return await fn(); } finally { await whileBusy('the build mutex', mutex, () => remove(mutex)); }
}

// A busy file is kept for this pass: a held or delete-pending file is no proof its owner died.
// busySince carries each kept file's first busy time across passes to bound the wait.
function prune(dir, prefix, busySince) {
  for (const name of readdirSync(dir).filter((name) => name.startsWith(prefix))) {
    const file = path.join(dir, name);
    try {
      if (!alive(pidIn(file))) remove(file);
      busySince.delete(name);
    } catch (error) {
      if (!busy(error)) throw error;
      if (!busySince.has(name)) busySince.set(name, Date.now());
      if (Date.now() - busySince.get(name) >= LOCK_BUSY_MS) throw busyTimeout('a gate file', error, file);
    }
  }
}

async function slot(dir, count) {
  mkdirSync(dir, { recursive: true });
  const ticket = await locked(dir, async () => {
    const counter = path.join(dir, 'next-ticket');
    // existsSync swallows errors, so a busy counter could read as absent and restart the tickets at 1.
    const last = await whileBusy('the ticket counter', counter, () => {
      try { return readFileSync(counter, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return '0'; throw error; }
    });
    const next = Number(last) + 1;
    if (!Number.isSafeInteger(next)) throw new Error('build-gate: invalid ticket counter');
    writeFileSync(counter, String(next));
    const file = path.join(dir, `wait-${String(next).padStart(16, '0')}`);
    writeFileSync(file, String(process.pid), { flag: 'wx' });
    return file;
  });
  let warned = false;
  const busySince = new Map();
  try {
    for (;;) {
      const acquired = await locked(dir, async () => {
        prune(dir, 'wait-', busySince);
        prune(dir, 'slot-', busySince);
        const entries = readdirSync(dir);
        const waiters = entries.filter((name) => name.startsWith('wait-')).sort();
        const free = Array.from({ length: count }, (_, i) => `slot-${i}`).filter((name) => !entries.includes(name));
        // The first F live tickets may race for F free slots; later tickets wait.
        if (waiters.indexOf(path.basename(ticket)) >= free.length) return null;
        for (let i = 0; i < count; i++) {
          const file = path.join(dir, `slot-${i}`);
          if (existsSync(file)) continue;
          // A delete-pending slot reads as absent to existsSync but refuses the create: taken.
          try { writeFileSync(file, String(process.pid), { flag: 'wx' }); } catch (error) {
            if (busy(error)) continue;
            throw error;
          }
          await release(ticket);
          return file;
        }
        return null;
      });
      if (acquired) return acquired;
      if (!warned) { console.error('build-gate: waiting for a build slot'); warned = true; }
      await sleep(75);
    }
  } finally { await release(ticket); }
}

function identifySeat(tool, args) {
  // Seat processes already carry ORCH_SEAT_ID (seats.ts); shims inherit it. On Unix,
  // process.title overwrites argv in place and a longer title is cut to that span, so the
  // seat id stays first and the gated command follows. The script name is omitted: a
  // pkill -f of build-gate.mjs plus the tool line must not match another seat's wait.
  const seat = process.env.ORCH_SEAT_ID;
  if (!seat || !/^[a-z]+-[a-z0-9]+-[0-9a-f]{6}$/.test(seat)) return;
  const prefix = `orch-gate ${seat}`;
  const command = [tool, ...args].join(' ').replaceAll('build-gate.mjs', 'gate');
  let title = command ? `${prefix} ${command}` : prefix;
  let budget = 0;
  for (const arg of process.argv) budget += Buffer.byteLength(arg) + 1;
  budget = Math.max(1, budget - 1);
  if (Buffer.byteLength(title) > budget) {
    const prefixBytes = Buffer.byteLength(prefix);
    if (prefixBytes >= budget) title = prefix.slice(0, budget);
    else {
      const room = budget - prefixBytes - 1;
      let kept = '';
      for (const ch of command) {
        if (Buffer.byteLength(kept + ch) > room) break;
        kept += ch;
      }
      title = kept ? `${prefix} ${kept}` : prefix;
    }
  }
  try { process.title = title; } catch { /* a missing console must not fail the build */ }
}

async function main() {
  let [tool, ...originalArgs] = process.argv.slice(2);
  // --exec: an explicit command that always runs inside a slot (provisioning's
  // heavy steps are not PATH-shimmed tools, so heavy() cannot see them).
  const explicit = tool === '--exec';
  if (explicit) [tool, ...originalArgs] = originalArgs;
  if (!tool) throw new Error('usage: node build-gate.mjs [--exec] <tool> <args...>');
  identifySeat(tool, originalArgs);
  const file = resolveTool(tool, process.env.ORCH_BUILD_SHIM_DIR, explicit);
  const hops = Number(process.env.ORCH_BUILD_GATE_HOPS ?? 0);
  // NaN would never reach the limit and would switch the recursion guard off.
  if (!Number.isSafeInteger(hops) || hops < 0) throw new Error(`build-gate: ORCH_BUILD_GATE_HOPS must be a non-negative integer, got ${process.env.ORCH_BUILD_GATE_HOPS}`);
  if (hops >= 16) throw new Error(`build-gate: hop limit reached for ${tool}: ${file}`);
  const gated = !Object.hasOwn(process.env, 'ORCH_BUILD_SLOT') && (explicit || heavy(tool, originalArgs));
  const count = Number(process.env.ORCH_BUILD_SLOTS ?? 2);
  if (gated && (!Number.isSafeInteger(count) || count < 1)) throw new Error('ORCH_BUILD_SLOTS must be a positive integer');
  const dir = path.resolve(process.env.ORCH_BUILD_GATE_DIR ?? path.join(process.env.ORCH_STATE_DIR ? path.resolve(process.env.ORCH_STATE_DIR) : path.join(os.homedir(), '.local', 'state', 'orch'), 'build-gate'));
  const held = gated ? await slot(dir, count) : null;
  // --exec is provisioning (worktrees.ts runStep, remote-provision.ts runOnHost): the runner
  // starts the step's own timeout at this marker instead of at spawn, so queueing for a machine
  // slot (about 14 seats on 2 slots after a drained restart, task 2930) cannot eat the step
  // budget. Shimmed tools never print it; an --exec passthrough (ORCH_BUILD_SLOT already set)
  // prints it too because its child also starts immediately.
  if (explicit) console.error('build-gate: slot acquired');
  const cores = os.availableParallelism();
  const jobs = Math.max(1, Math.floor(cores / count));
  const args = [...originalArgs];
  const name = toolName(tool);
  if (held && name === 'ninja' && !args.some((arg) => arg === '-j' || /^-j\d/.test(arg) || arg === '--jobs' || arg.startsWith('--jobs='))) args.push('-j', String(jobs));
  if (held && name === 'msbuild' && !args.some((arg) => /^[-/]m(?::|$)/i.test(arg) || /^[-/]maxcpucount(?::|$)/i.test(arg))) args.push(`/m:${jobs}`);
  const env = { ...process.env, ORCH_BUILD_GATE_HOPS: String(hops + 1),
    ...(held ? { ORCH_BUILD_SLOT: path.basename(held), CARGO_BUILD_JOBS: String(jobs), CMAKE_BUILD_PARALLEL_LEVEL: String(jobs) } : {}) };
  let child;
  let released;
  const cleanup = () => (released ??= held ? release(held) : Promise.resolve());
  const onSignal = (signal) => {
    if (child?.pid) child.kill(signal);
    else cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, onSignal);
  try {
    const result = await new Promise((resolve, reject) => {
      child = spawn(file, args, { stdio: 'inherit', env, windowsHide: true });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (result.signal) {
      for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, onSignal);
      // Release before re-raising: the signal ends this process before `finally` runs.
      await cleanup();
      process.kill(process.pid, result.signal);
      process.exitCode = 128;
    } else process.exitCode = result.code ?? 1;
  } finally {
    await cleanup();
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, onSignal);
  }
}

// Realpaths on both sides: ESM resolves symlinks in import.meta.url but argv keeps the path as typed.
function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
}

if (isMain()) main().catch((error) => { console.error(error); process.exitCode = 1; });
