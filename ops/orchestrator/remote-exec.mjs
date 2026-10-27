#!/usr/bin/env node
// Run a single provider on the SSH host. Only the first line is JSON; subsequent bytes are stdin.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stateDirFor } from './src/config.ts';
import { resolveCommand, smallCargoTargetEnv } from './src/providers/spawn.ts';
import { buildGateScript, gateEnv, writeBuildShims } from './src/build-gate.ts';

export function parseHeader(line) {
  const value = JSON.parse(line);
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'args,command,cwd,env' ||
      typeof value.cwd !== 'string' || !value.cwd ||
      typeof value.command !== 'string' || !value.command ||
      !Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string') ||
      value.env === null || typeof value.env !== 'object' || Array.isArray(value.env) ||
      !Object.entries(value.env).every(([key, val]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && typeof val === 'string')) {
    throw new Error('invalid remote execution header');
  }
  return value;
}

// Every seat on this host builds through the host's build-gate shims (task 1796), not only the
// vcvars toolchain seats; on a toolchain seat the shim dir lands ahead of pathPrepend and the
// vcvars PATH. The gate is this checkout's own ops/orchestrator/build-gate.mjs; ORCH_BUILD_GATE
// in the HOST's environment moves it, the Mac's header never does.
// Task 2861 C: the header names the seat's role (SEAT_POLICY_ROLE rides spec.env), and a remote
// child inherits its own host's environment, never the Mac daemon's, so the small-target cargo
// defaults for review seats apply HERE; a value this host's environment already sets wins.
export function seatEnvironment(base, extras) {
  const { ORCH_HOST_VCVARS64: vcvars64, ORCH_HOST_PATH_PREPEND: directories,
    ORCH_HOST_CMAKE_PREFIX_PATH: qtPrefix, ...env } = extras;
  delete env.ORCH_BUILD_GATE; // the host names its gate, not the seat header
  const stateDir = base.ORCH_STATE_DIR ? path.resolve(base.ORCH_STATE_DIR) : stateDirFor(os.homedir());
  const bin = writeBuildShims(stateDir, base.ORCH_BUILD_GATE || buildGateScript());
  if (vcvars64 === undefined && directories === undefined && qtPrefix === undefined) {
    const merged = { ...base, ...env };
    Object.assign(merged, smallCargoTargetEnv(env.SEAT_POLICY_ROLE, merged));
    return bin ? gateEnv(merged, bin) : merged;
  }
  if (process.platform !== 'win32' || !vcvars64 || !directories || !qtPrefix) throw new Error('incomplete Windows host toolchain');
  const paths = JSON.parse(directories);
  if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string' && path.win32.isAbsolute(p) && existsSync(p)) || !existsSync(vcvars64) || !existsSync(qtPrefix)) {
    throw new Error('Windows host toolchain path is missing');
  }
  const { variables, pathValue, linker } = vcvarsToolchain(vcvars64, base);
  const result = { ...base, ...variables, ...env };
  for (const key of Object.keys(result)) if (key.toLowerCase() === 'path') delete result[key];
  result.PATH = [...paths, pathValue].join(';');
  result.CMAKE_PREFIX_PATH = qtPrefix;
  result.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = linker;
  Object.assign(result, smallCargoTargetEnv(env.SEAT_POLICY_ROLE, result));
  return bin ? gateEnv(result, bin) : result;
}

const pathOf = (env) => Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1];

// Task 1838: on win32 every remote command runs through ops/orchestrator/jobwrap's orch-jobwrap,
// which holds the whole command branch in a kill-on-close Job Object, so a dropped ssh or a
// TerminateProcess of this process leaves no npm -> cmd -> node orphan holding the checkout.
// The helper is compiled once per crate source hash into <stateDir>/jobwrap/bin; cargo's own
// target-dir lock serializes parallel seat starts, and the hash-named output never replaces a
// running image. A build failure fails the seat loudly: an unwrapped spawn is the orphan leak
// this removes, so there is no fallback (PRIME 6).
export function jobwrap(stateDir) {
  if (process.platform !== 'win32') return null;
  const crate = fileURLToPath(new URL('./jobwrap/', import.meta.url));
  const hash = createHash('sha256');
  for (const name of ['Cargo.toml', 'Cargo.lock', path.join('src', 'main.rs')]) hash.update(readFileSync(path.join(crate, name)));
  const bin = path.join(stateDir, 'jobwrap', 'bin', `orch-jobwrap-${hash.digest('hex').slice(0, 16)}.exe`);
  if (!existsSync(bin)) {
    const target = path.join(stateDir, 'jobwrap', 'target');
    const built = spawnSync('cargo', ['build', '--release', '--locked', '--offline',
      '--manifest-path', path.join(crate, 'Cargo.toml'), '--target-dir', target], { stdio: 'inherit', windowsHide: true });
    if (built.error || built.status !== 0) throw new Error(`orch-jobwrap build failed: ${built.error?.message ?? built.status}`);
    const staged = `${bin}.${process.pid}.tmp`;
    mkdirSync(path.dirname(bin), { recursive: true });
    copyFileSync(path.join(target, 'release', 'orch-jobwrap.exe'), staged);
    try { renameSync(staged, bin); } // hash-named: a parallel seat's winning bytes are identical
    catch (error) { if (!existsSync(bin)) throw error; }
    finally { rmSync(staged, { force: true }); }
  }
  return bin;
}

// Run vcvars64 in a child cmd; returns every variable `set` prints.
function captureVcvars(vcvars64, base) {
  const captured = spawnSync('cmd.exe', ['/d', '/s', '/c', `chcp 65001 >nul && call "${vcvars64}" >nul && set`],
    { env: base, encoding: 'utf8', windowsVerbatimArguments: true, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 }); // under the daemon's 75 s get_state bound (providers/pi.ts), so the error names vcvars64
  if (captured.error || captured.status !== 0) throw new Error(`vcvars64 failed: ${captured.error?.message ?? captured.stderr?.trim() ?? captured.status}`);
  return Object.fromEntries(captured.stdout.split(/\r?\n/).filter((line) => /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

// Validation reads these whether or not vcvars changed them (a host session may already carry them).
const TOOLCHAIN_KEYS = ['path', 'include', 'lib', 'libpath', 'vctoolsinstalldir'];

// vcvars64 output is fixed for one vcvars64 file, default MSVC tools version and base PATH, so seat
// starts share one capture (task 1793: seven parallel captures overran the then 20 s bound). The cache
// keeps the toolchain keys and what vcvars changed, never another session's unchanged variables.
// Cached values pass the same checks as fresh ones; a stale, torn or failing cache is recaptured and
// replaced by an atomic rename.
export function vcvarsToolchain(vcvars64, base, capture = captureVcvars,
  file = path.join(base.ORCH_STATE_DIR ? path.resolve(base.ORCH_STATE_DIR) : stateDirFor(os.homedir()), 'vcvars64-cache.json')) {
  const { mtimeMs, size } = statSync(vcvars64);
  // A VS update switches the default tools version here while the old MSVC tree may still exist.
  const versionFile = path.join(path.dirname(vcvars64), 'Microsoft.VCToolsVersion.default.txt');
  const toolsVersion = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : null;
  const key = { vcvars64, mtimeMs, size, toolsVersion, basePath: pathOf(base) ?? null };
  const checked = (variables) => {
    const pathValue = pathOf(variables);
    if (!pathValue || !variables.INCLUDE || !variables.LIB || !variables.LIBPATH) throw new Error('vcvars64 did not supply MSVC PATH, INCLUDE, LIB and LIBPATH');
    // path is path.win32 on the only platform seatEnvironment accepts.
    const linker = path.join(variables.VCToolsInstallDir ?? '', 'bin', 'Hostx64', 'x64', 'link.exe');
    if (!variables.VCToolsInstallDir || !path.isAbsolute(linker) || !existsSync(linker)) throw new Error('vcvars64 MSVC linker is missing');
    return { variables, pathValue, linker };
  };
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (Object.keys(key).every((name) => cached[name] === key[name])) return checked(cached.variables);
  } catch {} // absent, unreadable or failing the checks: capture again below
  const toolchain = checked(Object.fromEntries(Object.entries(capture(vcvars64, base))
    .filter(([name, value]) => TOOLCHAIN_KEYS.includes(name.toLowerCase()) || base[name] !== value)));
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temp, JSON.stringify({ ...key, variables: toolchain.variables }));
    renameSync(temp, file);
  } catch { rmSync(temp, { force: true }); } // an unwritten cache costs the next start one capture, not this seat
  return toolchain;
}

export function run(input = process.stdin) {
  // ssh on a Linux host can start with umask 0002 (task 3158): seat files are then group-writable
  // and tests that check file modes fail. A seat gets 022, the umask a Mac seat has.
  if (process.platform !== 'win32') process.umask(0o022);
  let pending = Buffer.alloc(0);
  let child;
  input.on('data', (chunk) => {
    if (child) return;
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf(10);
    if (end < 0 && pending.length <= 65536) return;
    if (end < 0 || end > 65536) {
      console.error('remote execution header exceeds 64 KiB');
      process.exitCode = 1;
      input.destroy();
      return;
    }
    input.pause();
    try {
      const { cwd, env, command, args } = parseHeader(pending.subarray(0, end).toString('utf8'));
      const childEnv = seatEnvironment(process.env, env);
      const resolved = resolveCommand(command, childEnv);
      const wrapper = jobwrap(process.env.ORCH_STATE_DIR ? path.resolve(process.env.ORCH_STATE_DIR) : stateDirFor(os.homedir()));
      // Pi's per-call job uses this exact cached helper, never another build or a header path.
      if (wrapper) childEnv.ORCH_JOBWRAP = wrapper;
      child = wrapper
        ? spawn(wrapper, [resolved.file, ...resolved.args, ...args], {
            cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          })
        : spawn(resolved.file, [...resolved.args, ...args], {
            cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true,
          });
      // win32 has no nice: below-normal priority, inherited by the seat's builds, keeps the host's
      // ssh and orch probes responsive under load (task 1796; darwin seats run under nice 10).
      if (process.platform === 'win32' && child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      child.on('error', (error) => { console.error(error); process.exitCode = 1; });
      child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      if (end + 1 < pending.length) child.stdin.write(pending.subarray(end + 1));
      input.pipe(child.stdin);
      input.on('end', () => { if (child.exitCode === null) killTree(child.pid); });
      input.resume();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
      input.destroy();
    }
  });
  input.on('end', () => { if (!child) { console.error('missing remote execution header'); process.exitCode = 1; } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();

// The provider's own children (bash tools, cargo, test runners) must not
// outlive a dropped ssh: kill the whole tree, not just the direct child.
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-pid, 'SIGKILL'); } catch {}
}
