// Only regenerable Cargo targets in lead worktrees. All disk traversal/removal is async.
import { execFile } from 'node:child_process';
import { lstat, opendir, readlink, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { projectConfig } from '../../../scripts/lib/harness-config.mjs';
import { DAY, DROP_GRACE, HOUR, acquireSweepGate, directoryBelow, inside, missing, treeBytes } from './sweep-shared.ts';

const exec = promisify(execFile);
const TARGETS = projectConfig().targetDirs;
const STATE_TARGETS = projectConfig().stateTargetDirs;
const EXEC_OPTIONS = { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 };
/** A process whose executable is named so may be building: its cwd in the checkout pins every target. */
const BUILDERS = /^(?:cargo|cargo-.+|rustc|rust-analyzer|tauri)$/;
const DROPPING = '.dropping-';

type Item = { path: string; bytesBefore: number };
export type TargetSweepResult = {
  dryRun: boolean;
  candidates: Item[];
  removed: string[];
  bytesBefore: number;
  skipped: { path: string; reason: string }[];
};
type ProcessInfo = { pid: string; name: string; args: string; cwd: string | null };

async function marked(target: string): Promise<void> {
  const errors: string[] = [];
  for (const name of ['CACHEDIR.TAG', '.rustc_info.json']) {
    try {
      const marker = await lstat(path.join(target, name));
      if (marker.isFile() && !marker.isSymbolicLink()) return;
      errors.push(`${name} is not a regular file`);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  throw new Error(errors.join('; '));
}

async function recentBuild(target: string, cutoff: number): Promise<boolean> {
  for (const profile of ['debug', 'release']) {
    const root = path.join(target, profile);
    let stat;
    try { stat = await lstat(root); } catch (error) { if (missing(error)) continue; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`not a plain build directory: ${root}`);
    if (stat.mtimeMs >= cutoff) return true;
    const entries = await opendir(root);
    for await (const entry of entries) {
      const file = path.join(root, entry.name);
      const first = await lstat(file);
      if (first.mtimeMs >= cutoff) return true;
      if (first.isDirectory() && !first.isSymbolicLink()) {
        const children = await opendir(file);
        for await (const child of children) {
          if ((await lstat(path.join(file, child.name))).mtimeMs >= cutoff) return true;
        }
      }
    }
  }
  return false;
}

/** ps plus every process's cwd, pid-keyed. One snapshot per check — the pass snapshot is
 *  never reused at a deletion moment. ps output does not preserve argv quoting, so
 *  candidacy below stays a conservative substring match, never token guessing. */
/** Liveness could not be proved for EVERY process (task 2861 review r4, lead
 *  decision — deletion safety first): on Linux one unreadable /proc entry of
 *  ANY uid — yama.ptrace_scope=1 can make even a same-uid cwd unreadable —
 *  makes the whole snapshot unproved. Callers catch it, keep every candidate
 *  and record the message, which names the pid and errno. Nothing is deleted
 *  on an unproved snapshot; no throw escapes a sweep. */
export class LivenessUnproved extends Error {
  constructor(pid: string, what: string, code: string) {
    super(`liveness unprovable: ${what} ${code} (pid ${pid})`);
    this.name = 'LivenessUnproved';
  }
}

export async function processSnapshot(): Promise<ProcessInfo[]> {
  const { stdout } = await exec('ps', ['-axww', '-o', 'pid=', '-o', 'args='], EXEC_OPTIONS)
    .catch((error: { code: string | number }) => {
      // A missing liveness tool is not a missing candidate path.
      throw new LivenessUnproved(String(process.pid), 'ps', typeof error.code === 'number' ? `exit ${error.code}` : error.code);
    });
  const processes = new Map<string, ProcessInfo>();
  for (const line of stdout.split('\n')) {
    const parsed = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!parsed) continue;
    const [, pid, args] = parsed;
    if (processes.has(pid)) continue;
    const name = path.basename(args.trim().split(/\s+/)[0] ?? '');
    processes.set(pid, { pid, args, name, cwd: null });
  }
  const setCwd = (pid: string, cwd: string): void => {
    const known = processes.get(pid);
    if (known) known.cwd = cwd;
  };
  // Test seam (r4): an injected unreadable pid — no real /proc needed — makes
  // the snapshot unproved exactly as a live EACCES would.
  const injected = process.env.ORCH_TEST_UNREADABLE_PID ?? '';
  if (injected && processes.has(injected)) throw new LivenessUnproved(injected, 'readlink /proc/<pid>/cwd', 'EACCES');
  if (process.platform === 'darwin') {
    // One bounded system-wide cwd query is cheap on the Mac; never run lsof per pid.
    const { stdout: cwd } = await exec('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn'], EXEC_OPTIONS)
      .catch((error: { code: string | number }) => {
        throw new LivenessUnproved(String(process.pid), '/usr/sbin/lsof', typeof error.code === 'number' ? `exit ${error.code}` : error.code);
      });
    let pid = '';
    for (const line of cwd.split('\n')) {
      if (line.startsWith('p')) pid = line.slice(1);
      else if (line.startsWith('n') && pid) setCwd(pid, line.slice(1));
    }
  } else if (process.platform === 'linux') {
    const proc = await opendir('/proc');
    for await (const entry of proc) {
      if (!/^\d+$/.test(entry.name)) continue;
      try { setCwd(entry.name, await readlink(`/proc/${entry.name}/cwd`)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Gone is fine; an unreadable entry of ANY uid (task 2861 review r4)
        // makes liveness unproved — never a partial skip, never a deletion.
        if (code !== 'ESRCH' && code !== 'ENOENT') throw new LivenessUnproved(entry.name, 'readlink /proc/<pid>/cwd', String(code));
      }
    }
  }
  return [...processes.values()];
}

/** Every path the given pids have open — cwd, executable and open files alike — through ONE
 *  `lsof -p` over the whole candidate set on the Mac, /proc fd/exe readlinks on Linux.
 *  Dead pids make lsof exit non-zero; its output still names the survivors, so only an
 *  empty failed run is unproved. */
async function openProcessPaths(pids: string[]): Promise<string[]> {
  if (!pids.length) return [];
  if (process.platform === 'darwin') {
    let stdout = '';
    try { ({ stdout } = await exec('/usr/sbin/lsof', ['-p', pids.join(','), '-Fn', '-w'], EXEC_OPTIONS)); }
    catch (error) {
      stdout = String((error as { stdout?: string }).stdout ?? '');
      if (!stdout) {
        const { code } = error as { code: string | number };
        throw new LivenessUnproved(String(process.pid), '/usr/sbin/lsof', typeof code === 'number' ? `exit ${code}` : code);
      }
    }
    return [...stdout.matchAll(/^n(.*)$/gm)].map((line) => line[1]);
  }
  const files: string[] = [];
  for (const pid of pids) {
    try { files.push(await readlink(`/proc/${pid}/exe`)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || code === 'ENOENT') continue;
      throw new LivenessUnproved(pid, 'readlink /proc/<pid>/exe', String(code));
    }
    let descriptors;
    try { descriptors = await opendir(`/proc/${pid}/fd`); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || code === 'ENOENT') continue;
      throw new LivenessUnproved(pid, 'opendir /proc/<pid>/fd', String(code));
    }
    for await (const descriptor of descriptors) {
      try { files.push(await readlink(`/proc/${pid}/fd/${descriptor.name}`)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH' || code === 'ENOENT') continue;
        throw new LivenessUnproved(pid, `readlink /proc/<pid>/fd/${descriptor.name}`, String(code));
      }
    }
  }
  return files;
}

/** Cargo holds an flock on target/<profile>/.cargo-lock for the whole build. Node cannot
 *  flock, so the non-blocking try goes through a platform tool: flock(1) where util-linux
 *  ships it, otherwise the perl every macOS includes (LOCK_EX|LOCK_NB = 6). Acquired means
 *  free; every other answer — held, unopenable, absent tool — keeps the target. */
let lockTool: { file: string; probe: string[]; args: (lock: string) => string[] } | null | undefined;
async function lockHeld(file: string): Promise<boolean> {
  let stat;
  try { stat = await lstat(file); } catch (error) { if (missing(error)) return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`not a plain lock file: ${file}`);
  if (lockTool === undefined) {
    // One probe per process, through PATH: flock(1) where util-linux ships it, otherwise perl.
    const tools = [
      { file: 'flock', probe: ['-n', '/dev/null', '-c', 'true'], args: (lock: string) => ['-n', lock, '-c', 'true'] },
      { file: 'perl', probe: ['-e', '0'], args: (lock: string) => ['-e', 'open(F,"<",$ARGV[0]) or exit 2; unless(flock(F,6)){exit 1} exit 0', '--', lock] },
    ];
    for (const tool of tools) {
      try { await exec(tool.file, tool.probe, EXEC_OPTIONS); lockTool = tool; break; }
      catch { /* absent or unusable here: the next tool gets its chance */ }
    }
    if (lockTool === undefined) lockTool = null;
  }
  if (!lockTool) throw new Error('no flock tool available for the cargo lock try');
  try { await exec(lockTool.file, lockTool.args(file), EXEC_OPTIONS); return false; }
  catch (error) {
    if (missing(error)) throw error; // the tool vanished mid-run: unproved, keep the target
    return true; // exit 1: a cargo holds it; any other failure also keeps the target
  }
}

/** The in-use clauses (task 2861): a target is in use when a process has its cwd, an open
 *  file or its executable inside it; or a cargo/rustc/rust-analyzer/tauri process has its
 *  cwd anywhere in the checkout; or a profile's .cargo-lock is held. Returns the reason,
 *  or null. `aliases` carries every spelling of the checkout and target paths under which
 *  a process may name them without symlinks being resolved. */
async function targetInUse(checkout: string, target: string, aliases: string[], processes: ProcessInfo[]): Promise<string | null> {
  const checkoutSpellings = [...new Set([checkout, ...aliases])];
  const targetSpellings = [...new Set([target, ...checkoutSpellings.map((alias) => path.join(alias, path.relative(checkout, target)))])];
  for (const proc of processes) {
    if (proc.cwd && targetSpellings.some((spelling) => inside(spelling, proc.cwd!))) return 'process cwd inside the target';
  }
  for (const proc of processes) {
    if (proc.cwd && BUILDERS.test(proc.name) && checkoutSpellings.some((spelling) => inside(spelling, proc.cwd!))) {
      return `${proc.name} working in the checkout`;
    }
  }
  const candidates = processes.filter((proc) =>
    targetSpellings.some((spelling) => proc.args.includes(spelling)) ||
    checkoutSpellings.some((spelling) => proc.args.includes(spelling) || (proc.cwd !== null && inside(spelling, proc.cwd))));
  const open = await openProcessPaths(candidates.map((proc) => proc.pid));
  if (open.some((file) => inside(target, file))) return 'open file or executable inside the target';
  for (const profile of ['debug', 'release']) {
    if (await lockHeld(path.join(target, profile, '.cargo-lock'))) return `${profile} cargo lock held`;
  }
  return null;
}

/** A leftover is in use when a live process holds its cwd, an open file or its
 *  argv inside it — sampled right before the rm (task 2861 review r2): on win32
 *  only EBUSY stood between a live cwd and the delete. */
async function dropInUse(dropping: string, processes: ProcessInfo[]): Promise<boolean> {
  // cwd or argv naming the leftover protects outright — an argv match is intent
  // enough (task 2861 review r3) — and the open-file query covers EVERY pid, so
  // a holder that only keeps an open file inside is caught (plan v3: one
  // `lsof -p` over all candidates).
  if (processes.some((proc) => (proc.cwd !== null && inside(dropping, proc.cwd)) || proc.args.includes(dropping))) return true;
  const open = await openProcessPaths(processes.map((proc) => proc.pid));
  return open.some((file) => inside(dropping, file));
}

/** Delete `<target>.dropping-<ms>` leftovers past the grace age: an interrupted recursive
 *  delete dies with its stamp, and a live delete is never that old. Every component from
 *  the trusted root down is validated — the parent chain before opendir, the full leftover
 *  path again before rm — so a symlinked parent is never followed out of the checkout
 *  (task 2861 review); liveness is sampled right before the rm (task 2861 review r2). */
async function removeStaleDrops(root: string, result: TargetSweepResult, now: number): Promise<void> {
  for (const suffix of TARGETS) {
    const parentRelative = path.posix.dirname(suffix);
    const prefix = `${path.posix.basename(suffix)}${DROPPING}`;
    let parent: string;
    try { parent = parentRelative === '.' ? root : await directoryBelow(root, parentRelative); }
    catch (error) {
      if (missing(error)) continue;
      result.skipped.push({ path: path.join(root, parentRelative), reason: (error as Error).message });
      continue;
    }
    let entries;
    try { entries = await opendir(parent); } catch (error) { if (missing(error)) continue; throw error; }
    for await (const entry of entries) {
      if (!entry.name.startsWith(prefix)) continue;
      const stamp = entry.name.slice(prefix.length);
      if (!/^\d+$/.test(stamp) || now - Number(stamp) < DROP_GRACE) continue;
      const dropping = path.join(parent, entry.name);
      const relative = parentRelative === '.' ? entry.name : `${parentRelative}/${entry.name}`;
      try {
        await directoryBelow(root, relative); // every component, re-validated at the rm
        if (await dropInUse(dropping, await processSnapshot())) {
          result.skipped.push({ path: dropping, reason: 'in use by a live process' });
          continue;
        }
        await rm(dropping, { recursive: true, force: true });
        result.removed.push(dropping);
      }
      catch (error) { result.skipped.push({ path: dropping, reason: (error as Error).message }); }
    }
  }
}

/** Task 2861: drop the regenerable cargo targets of ONE checkout under the sweep's guards —
 *  plain directories only, CACHEDIR.TAG or .rustc_info.json present as a regular non-symlink
 *  file, no build output modified within `window`
 *  ms (re-walked after the byte walk) — with every in-use clause re-sampled immediately
 *  before an atomic rename to `<dir>.dropping-<ms>`; the recursive delete runs after the
 *  rename without holding the sweep. Leftovers of an interrupted delete go first. Sources,
 *  node_modules and .codegraph are not cargo targets and always stay. Dry-run reports
 *  candidates and touches nothing. */
export async function dropCheckoutTargets(checkout: string, options: { window: number; dryRun?: boolean; now?: number; aliases?: string[] }): Promise<TargetSweepResult> {
  const { window, dryRun = false } = options;
  const result: TargetSweepResult = { dryRun, candidates: [], removed: [], bytesBefore: 0, skipped: [] };
  let root: string;
  try { root = await realpath(checkout); }
  catch (error) {
    result.skipped.push({ path: checkout, reason: `inspection failed: ${(error as Error).message}` });
    return result;
  }
  const aliases = [...new Set(options.aliases ?? [path.resolve(checkout)])];
  try {
    if (!dryRun) await removeStaleDrops(root, result, options.now ?? Date.now());
    for (const suffix of TARGETS) {
      const target = path.join(root, suffix);
      let found = false;
      try {
        await directoryBelow(root, suffix);
        found = true;
        try { await marked(target); }
        catch (error) { result.skipped.push({ path: target, reason: `no Cargo marker: ${(error as Error).message}` }); continue; }
        if (await recentBuild(target, (options.now ?? Date.now()) - window)) {
          result.skipped.push({ path: target, reason: `build modified within ${Math.round(window / HOUR)}h` });
          continue;
        }
        const bytesBefore = await treeBytes(target);
        // Recheck after the potentially long byte walk; newly modified builds stay.
        await directoryBelow(root, suffix);
        await marked(target);
        if (await recentBuild(target, Date.now() - window)) { result.skipped.push({ path: target, reason: 'build modified during inspection' }); continue; }
        // The snapshot is stale after the byte walk: every clause is re-sampled here,
        // immediately before the atomic rename that claims the directory (task 2699).
        let busy: string | null;
        try { busy = await targetInUse(root, target, aliases, await processSnapshot()); }
        catch (error) { result.skipped.push({ path: target, reason: `inspection failed: ${(error as Error).message}` }); continue; }
        if (busy) { result.skipped.push({ path: target, reason: `running process: ${busy}` }); continue; }
        result.candidates.push({ path: target, bytesBefore });
        result.bytesBefore += bytesBefore;
        if (!dryRun) {
          const dropping = `${target}${DROPPING}${Date.now()}`;
          await rename(target, dropping);
          result.removed.push(target);
          // A big tree takes a while to delete and must not hold the sweep; the next
          // pass's leftover rule retries an interrupted delete after the grace age.
          rm(dropping, { recursive: true, force: true }).catch(() => undefined);
        }
      } catch (error) {
        if (found || !missing(error)) result.skipped.push({ path: target, reason: (error as Error).message });
      }
    }
  } catch (error) {
    result.skipped.push({ path: checkout, reason: `inspection failed: ${(error as Error).message}` });
  }
  return result;
}

/** Task 2861: the cargo targets the state-dir harnesses keep under the state root
 * (~/.local/state), named by project.stateTargetDirs patterns such as
 * `<harness>-perf/target*` — one trailing `*` of the last segment. Every match goes
 * through the checkout-target guards: plain directory, regular non-symlink CACHEDIR.TAG
 * or .rustc_info.json, the recent-build
 * window re-checked after the byte walk, the in-use clauses re-sampled immediately
 * before the rename that claims it, then the same rename-then-delete and stale-drop
 * grace rule. A match that is a symlink, or that leaves the state root after realpath,
 * is a skip with a reason; a missing state root or pattern parent sweeps nothing. The
 * pattern's directory plays the checkout for the in-use clauses, so a builder whose
 * cwd is anywhere in that harness's state directory also pins its target. */
async function dropStateTargets(result: TargetSweepResult, options: { stateRoot: string; window: number; dryRun: boolean; now: number }): Promise<void> {
  const { stateRoot, window, dryRun, now } = options;
  let root: string;
  try { root = await realpath(stateRoot); }
  catch (error) { if (missing(error)) return; throw error; }
  for (const pattern of STATE_TARGETS) {
    const starred = pattern.endsWith('*');
    const literal = path.posix.basename(starred ? pattern.slice(0, -1) : pattern);
    const parentRelative = path.posix.dirname(starred ? pattern.slice(0, -1) : pattern);
    const matches = (name: string): boolean => starred ? name.startsWith(literal) : name === literal;
    let parent: string;
    try { parent = parentRelative === '.' ? root : await directoryBelow(root, parentRelative); }
    catch (error) { if (missing(error)) continue; throw error; }
    let entries;
    try { entries = await opendir(parent); }
    catch (error) { if (missing(error)) continue; throw error; }
    for await (const entry of entries) {
      const target = path.join(parent, entry.name);
      const relative = parentRelative === '.' ? entry.name : `${parentRelative}/${entry.name}`;
      // A `.dropping-` leftover is never a candidate; one whose base matches the
      // pattern obeys the same grace rule as a checkout target's leftover.
      const cut = entry.name.lastIndexOf(DROPPING);
      if (cut !== -1) {
        const stamp = entry.name.slice(cut + DROPPING.length);
        if (matches(entry.name.slice(0, cut)) && /^\d+$/.test(stamp) && now - Number(stamp) >= DROP_GRACE && !dryRun) {
        try {
          // Every component re-validated at the rm: a leftover path must stay a plain
          // directory below the state root until the moment it is deleted; liveness
          // is sampled right before the rm (task 2861 review r3), as in removeStaleDrops.
          await directoryBelow(root, relative);
          if (await dropInUse(target, await processSnapshot())) {
            result.skipped.push({ path: target, reason: 'in use by a live process' });
          }
          else {
            await rm(target, { recursive: true, force: true });
            result.removed.push(target);
          }
        }
        catch (error) { result.skipped.push({ path: target, reason: (error as Error).message }); }
      }
        continue;
      }
      // A plain file (.DS_Store) is not a target; symlinks and the rest still report.
      if (!matches(entry.name) || entry.isFile()) continue;
      try {
        await directoryBelow(root, relative);
        const resolved = await realpath(target);
        if (resolved !== target && !inside(root, resolved)) {
          result.skipped.push({ path: target, reason: `outside the state root after realpath: ${resolved}` });
          continue;
        }
        try { await marked(target); }
        catch (error) { result.skipped.push({ path: target, reason: `no Cargo marker: ${(error as Error).message}` }); continue; }
        if (await recentBuild(target, now - window)) {
          result.skipped.push({ path: target, reason: `build modified within ${Math.round(window / HOUR)}h` });
          continue;
        }
        const bytesBefore = await treeBytes(target);
        // Recheck after the potentially long byte walk; newly modified builds stay.
        await directoryBelow(root, relative);
        await marked(target);
        if (await recentBuild(target, Date.now() - window)) { result.skipped.push({ path: target, reason: 'build modified during inspection' }); continue; }
        // The snapshot is stale after the byte walk: every clause is re-sampled here,
        // immediately before the atomic rename that claims the directory (task 2699).
        let busy: string | null;
        try { busy = await targetInUse(parent, target, [parent], await processSnapshot()); }
        catch (error) { result.skipped.push({ path: target, reason: `inspection failed: ${(error as Error).message}` }); continue; }
        if (busy) { result.skipped.push({ path: target, reason: `running process: ${busy}` }); continue; }
        result.candidates.push({ path: target, bytesBefore });
        result.bytesBefore += bytesBefore;
        if (!dryRun) {
          const dropping = `${target}${DROPPING}${Date.now()}`;
          await rename(target, dropping);
          result.removed.push(target);
          // A big tree takes a while to delete and must not hold the sweep; the next
          // pass's leftover rule retries an interrupted delete after the grace age.
          rm(dropping, { recursive: true, force: true }).catch(() => undefined);
        }
      } catch (error) {
        result.skipped.push({ path: target, reason: (error as Error).message });
      }
    }
  }
}

/** daily=true is the daemon gate; a manual run bypasses it. Dry-run writes nothing.
 * A timestamp is published BEFORE work: a crash must not trigger another pass on restart.
 * The exclusive lease also serializes a manual run with the daemon; see acquireSweepGate
 * for the atomic lease. A crashed lease blocks its own day (same lower bound as the
 * persisted gate). The pass also sweeps the state-dir harness targets
 * (project.stateTargetDirs), independent of the checkout.
 */
export async function sweepTargets(options: { checkout: string; stateDir: string; daily?: boolean; dryRun?: boolean; stateRoot?: string }): Promise<TargetSweepResult | null> {
  const { checkout, stateDir, daily = false, dryRun = false } = options;
  const now = Date.now();
  const gate = await acquireSweepGate({ stateDir, base: 'target-sweep', daily, dryRun });
  if (!gate) return null;
  const result: TargetSweepResult = { dryRun, candidates: [], removed: [], bytesBefore: 0, skipped: [] };
  try {
    await gate.publish();
    // State-dir harness targets (task 2861) do not depend on the checkout, so they
    // sweep even when the worktree root below is absent.
    await dropStateTargets(result, {
      stateRoot: options.stateRoot ?? path.join(os.homedir(), '.local', 'state'),
      window: DAY, dryRun, now,
    });
    const root = await realpath(checkout);
    let worktrees: string;
    try { worktrees = await directoryBelow(root, '.claude/worktrees'); }
    catch (error) { if (missing(error)) return result; throw error; }
    const entries = await opendir(worktrees);
    for await (const entry of entries) {
      // A plain file (.DS_Store) is not a worktree; symlinks and the rest still report.
      if (entry.isFile()) continue;
      const relativeWorktree = `.claude/worktrees/${entry.name}`;
      const worktree = path.join(worktrees, entry.name);
      try { await directoryBelow(root, relativeWorktree); }
      catch (error) { result.skipped.push({ path: worktree, reason: (error as Error).message }); continue; }
      // Both spellings of the worktree — through the resolved root and through the
      // checkout as given — stay candidate matches, as they were before task 2861.
      const dropped = await dropCheckoutTargets(worktree, {
        window: DAY, dryRun, now,
        aliases: [worktree, path.join(path.resolve(checkout), relativeWorktree)],
      });
      result.candidates.push(...dropped.candidates);
      result.removed.push(...dropped.removed);
      result.bytesBefore += dropped.bytesBefore;
      result.skipped.push(...dropped.skipped);
    }
  } catch (error) {
    result.skipped.push({ path: checkout, reason: `inspection failed: ${(error as Error).message}` });
  } finally { await gate.release(); }
  return result;
}
