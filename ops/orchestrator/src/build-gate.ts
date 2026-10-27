// Task 1796: every seat builds through the machine-wide build gate (ops/orchestrator/build-gate.mjs,
// slice 1). This module owns the wiring on whichever machine a seat runs: the PATH shims that route
// cargo, cmake, ninja and msbuild through the gate, and the environment that puts them first.
// The gate script itself holds the machine-wide slots in `<orch state dir>/build-gate`; the shims
// live beside them in `bin`. When the gate script is absent from the checkout the wiring stays
// dormant: a dead `cargo` first on PATH would break every seat, so activation follows the file.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build tools whose seat invocations must pass the machine-wide gate. */
export const BUILD_GATE_TOOLS = ['cargo', 'cmake', 'ninja', 'msbuild'];

const pathOf = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

/** The gate script shipped with this checkout: ops/orchestrator/build-gate.mjs, beside src/. */
export function buildGateScript(from: string = import.meta.url): string {
  return fileURLToPath(new URL('../build-gate.mjs', from));
}

/** Where the shims live on a machine: `<orch state dir>/build-gate/bin`, beside the gate's slot dir. */
export function buildShimDir(stateDir: string, platform: NodeJS.Platform = process.platform): string {
  return pathOf(platform).join(stateDir, 'build-gate', 'bin');
}

/** POSIX shim body; the single-quoted checkout path keeps `$` and `'` literal. */
export function shimScript(tool: string, gate: string): string {
  return `#!/bin/sh\nexec node '${gate.replaceAll("'", "'\\''")}' ${tool} "$@"\n`;
}

// A seat start is synchronous. Keep the installer lock across compilation and all four renames:
// another process must inspect the fingerprint only after the winning installer finishes.
const lockWait = new Int32Array(new SharedArrayBuffer(4));
const lockBusy = (error: unknown) => ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '');
function alivePid(pid: number): boolean {
  // No OS hands out a pid above int32; process.kill rejects one with ERR_INVALID_ARG_TYPE.
  if (pid > 0x7fffffff) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}
function releaseWindowsLock(file: string, token: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      if (readFileSync(file, 'utf8') !== token) throw new Error(`build-gate: ${file} ownership changed`);
      rmSync(file, { force: true });
      return;
    } catch (error) {
      if (!lockBusy(error) || attempt >= 40) throw error;
      Atomics.wait(lockWait, 0, 0, 50);
    }
  }
}
function withWindowsShimLock(dir: string, install: () => void): void {
  const lock = path.win32.join(dir, 'launcher.lock');
  const token = `${process.pid}:${randomUUID()}`;
  const started = Date.now();
  const wait = (cause?: unknown) => {
    if (Date.now() - started > 120_000) throw new Error('build-gate: timed out waiting for launcher installer lock', { cause });
    Atomics.wait(lockWait, 0, 0, 50);
  };
  for (;;) {
    try { writeFileSync(lock, token, { flag: 'wx' }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // An open can race a delete on Windows: EPERM may outlive the directory entry.
        if (!lockBusy(error)) throw error;
        wait(error);
        continue;
      }
      let owner: string;
      let age: number;
      try {
        owner = readFileSync(lock, 'utf8');
        age = Date.now() - statSync(lock).mtimeMs;
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        if (!lockBusy(readError)) throw readError;
        wait(readError);
        continue;
      }
      const pid = Number(owner.split(':')[0]);
      let stale = !Number.isSafeInteger(pid) || pid <= 0 ? age > 5000 : false;
      if (pid > 0 && Number.isSafeInteger(pid)) stale = !alivePid(pid);
      if (stale) {
        // Reclaimers must themselves be exclusive: otherwise one can delete the old lock
        // after another already removed it and a new installer acquired the same filename.
        const reaper = `${lock}.reap`;
        let claimed = false;
        try { writeFileSync(reaper, token, { flag: 'wx' }); claimed = true; }
        catch (claimError) {
          if ((claimError as NodeJS.ErrnoException).code === 'EEXIST') {
            try {
              const prior = readFileSync(reaper, 'utf8');
              const priorPid = Number(prior.split(':')[0]);
              if (Date.now() - statSync(reaper).mtimeMs > 5000 && (!Number.isSafeInteger(priorPid) || priorPid <= 0 || !alivePid(priorPid))) {
                if (readFileSync(reaper, 'utf8') === prior) rmSync(reaper, { force: true });
              }
            } catch (readError) {
              if ((readError as NodeJS.ErrnoException).code !== 'ENOENT' && !lockBusy(readError)) throw readError;
            }
          } else if (!lockBusy(claimError)) throw claimError;
        }
        if (claimed) {
          try {
            try { if (readFileSync(lock, 'utf8') === owner) rmSync(lock, { force: true }); }
            catch (readError) {
              if ((readError as NodeJS.ErrnoException).code !== 'ENOENT' && !lockBusy(readError)) throw readError;
            }
          } finally { releaseWindowsLock(reaper, token); }
        }
      }
      wait();
    }
  }
  try { install(); }
  finally { releaseWindowsLock(lock, token); }
}

/**
 * A shim writer stages `<tool>[.exe].<pid>.tmp` before renaming it into place; an interrupted
 * writer leaves it behind. Remove only those writer temp files whose owner pid is gone — a live
 * pid names a concurrent writer — and never anything else in the shim dir.
 */
const writerTempName = /^(?:cargo|cmake|ninja|msbuild)(?:\.exe)?\.(\d+)\.tmp$/;
function sweepStaleWriterTemps(dir: string, platform: NodeJS.Platform): void {
  const fsPath = pathOf(platform);
  for (const name of readdirSync(dir)) {
    const match = writerTempName.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid > 0 && Number.isSafeInteger(pid) && alivePid(pid)) continue;
    try { rmSync(fsPath.join(dir, name), { force: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !lockBusy(error)) throw error;
    }
  }
}

/** Build one native executable for the four tool names; its filename selects the gate tool. */
function writeWindowsShims(dir: string, gate: string): void {
  withWindowsShimLock(dir, () => {
    // Windows cannot delete an executing image. A later seat removes it once the build exits.
    const retiredName = /^(cargo|cmake|ninja|msbuild)\.exe\.old-\d+-\d+$/;
    const sweep = () => {
      for (const name of readdirSync(dir).filter((entry) => retiredName.test(entry))) {
        try { rmSync(path.win32.join(dir, name), { force: true }); }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
    };
    sweep();
    sweepStaleWriterTemps(dir, 'win32');
    const source = fileURLToPath(new URL('../build-gate-launcher.rs', import.meta.url));
    const fingerprint = createHash('sha256').update(readFileSync(source)).update('\0').update(gate).digest('hex');
    const marker = path.win32.join(dir, 'launcher.sha256');
    const current = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
    const outputs = BUILD_GATE_TOOLS.map((tool) => path.win32.join(dir, `${tool}.exe`));
    if (current !== fingerprint || outputs.some((file) => !existsSync(file))) {
      const temp = mkdtempSync(path.join(os.tmpdir(), 'orch-build-launcher-'));
      try {
        const binary = path.join(temp, 'launcher.exe');
        // rustc finds MSVC itself, but Git Bash puts its unrelated /usr/bin/link.exe first.
        // Only the compiler child loses those PATH candidates, not the seat or gate.
        const compilerEnv = { ...process.env, ORCH_BUILD_GATE_SCRIPT: gate };
        const pathKey = Object.keys(compilerEnv).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
        compilerEnv[pathKey] = (compilerEnv[pathKey] ?? '').split(';')
          .filter((entry) => entry && !existsSync(path.win32.join(entry, 'link.exe'))).join(';');
        const result = spawnSync('rustc', [source, '--edition=2021', '-o', binary], {
          env: compilerEnv, encoding: 'utf8', windowsHide: true,
        });
        if (result.error || result.status !== 0) throw new Error(`build-gate: rustc launcher failed: ${result.error?.message ?? result.stderr}`);
        const built = readFileSync(binary);
        let retired = 0;
        for (const file of outputs) {
          if (existsSync(file) && readFileSync(file).equals(built)) continue;
          const staged = `${file}.${process.pid}.tmp`;
          copyFileSync(binary, staged);
          let old: string | undefined;
          try {
            if (existsSync(file)) {
              do { old = `${file}.old-${process.pid}-${retired++}`; } while (existsSync(old));
              renameSync(file, old); // even a running image can be renamed, not replaced
            }
            try { renameSync(staged, file); }
            catch (error) {
              if (old && !existsSync(file)) {
                try { renameSync(old, file); }
                catch (restoreError) { throw new AggregateError([error, restoreError], `build-gate: could not restore ${file}`); }
              }
              throw error;
            }
          } finally { rmSync(staged, { force: true }); }
        }
        writeFileSync(marker, fingerprint);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    sweep();
    // An upgraded state dir must not let Bash prefer an obsolete extensionless script.
    for (const tool of BUILD_GATE_TOOLS) {
      rmSync(path.win32.join(dir, tool), { force: true });
      rmSync(path.win32.join(dir, `${tool}.cmd`), { force: true });
    }
  });
}

/**
 * Write the four shims idempotently into `<stateDir>/build-gate/bin` (a matching file is not
 * rewritten) and return that dir — or null when `gate` is not on disk, so no caller ever puts a
 * shim whose gate is missing first on a seat's PATH.
 */
export function writeBuildShims(stateDir: string, gate: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!existsSync(gate)) return null;
  const dir = buildShimDir(stateDir, platform);
  mkdirSync(dir, { recursive: true });
  if (platform === 'win32') {
    writeWindowsShims(dir, gate);
    return dir;
  }
  sweepStaleWriterTemps(dir, platform);
  for (const tool of BUILD_GATE_TOOLS) {
    const name = tool;
    const content = shimScript(tool, gate);
    const file = pathOf(platform).join(dir, name);
    let current: string | undefined;
    try { current = readFileSync(file, 'utf8'); } catch { /* absent: written below */ }
    if (current === content) continue;
    // Two seats starting at once on one host may both write: a rename never shows a half-written shim.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, content);
    chmodSync(temp, 0o755);
    renameSync(temp, file);
  }
  return dir;
}

/**
 * `env` with the shim dir first on PATH and `ORCH_BUILD_SHIM_DIR` naming it: the gate skips that
 * directory when it resolves the real tool, so the two must agree. A later occurrence of the dir
 * moves to the front instead of duplicating, and the name is orch's, not a seat-overridable one.
 */
export function gateEnv(env: Record<string, string>, bin: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const separator = platform === 'win32' ? ';' : ':';
  // A later seat override may add PATH beside an inherited Path; the last spelling wins.
  const pathKey = Object.keys(env).filter((name) => name.toLowerCase() === 'path').at(-1) ?? 'PATH';
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (name.toLowerCase() !== 'path') result[name] = value;
  const rest = (env[pathKey] ?? '').split(separator).filter((entry) => entry && entry !== bin);
  return { ...result, [pathKey]: [bin, ...rest].join(separator), ORCH_BUILD_SHIM_DIR: bin };
}
