// A seat's checkout. An editing seat gets its own worktree, provisioned from
// orch's own config: `ops/orchestrator/worktree-setup.json`, the seat's copy
// or, when its branch predates the file, the lead checkout's (dependencies
// cloned from the lead checkout by APFS clonefile when the lead's hidden
// lockfile proves its node_modules matches the seat's own package-lock.json,
// else npm ci; .env, rtk trust, this worktree's own codegraph index) and then
// ops/bootstrap/provision-worktree.sh (ignored per-checkout tools from lead).
// Without that a worker's codegraph answers about main, not about its branch.
import { execFile, spawn } from 'node:child_process';
import { prioritySpawn, withCargoBuildJobs } from './priority-launch.ts';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { copyFile, lstat, mkdtemp, readFile, readdir, realpath, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyedQueue } from './keyed-queue.ts';

const exec = promisify(execFile);
const gitOutput = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
  (await exec('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true })).stdout;
const git = async (cwd: string, ...args: string[]): Promise<string> => (await gitOutput(cwd, args)).trim();

/** The checkout root of `dir`, the same check repoOf uses: an existing absolute directory, then `git rev-parse --show-toplevel`.
 * Asynchronous: a synchronous git held the event loop about 0.2 s on each seat create (task 2640). */
export async function checkoutTop(dir: string): Promise<string> {
  if (!path.isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`'${dir}' is not an existing absolute directory`);
  try {
    const top = await git(dir, 'rev-parse', '--show-toplevel');
    if (!top) throw new Error('empty');
    return path.resolve(top);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`'${dir}'`)) throw error;
    throw new Error(`'${dir}' is not inside a git checkout`);
  }
}

/** A `worktree add` in flight: commondir exists but cannot be read yet, or its `locked` ("initializing") file went between git's exists check and its read (task 2730). The strerror suffix varies (`No error`, `Undefined error: 0`, `No such file or directory`). */
const WORKTREE_LIST_RETRY_MS = 50;

function gitFailureText(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' ? `${error.message}\n${stderr}` : error.message;
}

function isInFlightWorktreeEntry(error: unknown): boolean {
  // Relative `.git/worktrees/<n>/<file>` from the main checkout; an absolute path from a linked
  // worktree or a --separate-git-dir repo. Match the worktrees/<n>/commondir|locked tail only.
  const text = gitFailureText(error).replace(/\\/g, '/');
  return /failed to read \S*worktrees\/[^/\s]+\/(?:commondir|locked)/.test(text);
}

/** Main checkout the way `git worktree list` prints it: the common dir, with a trailing `/.git` removed. */
function mainWorktreePath(commonDir: string): string {
  const resolved = path.resolve(commonDir);
  const gitSuffix = `${path.sep}.git`;
  if (resolved.endsWith(gitSuffix)) return resolved.slice(0, -gitSuffix.length);
  if (resolved.endsWith(`${path.sep}.`)) return resolved.slice(0, -2);
  return resolved;
}

function checkoutFromGitdir(gitdir: string): string | null {
  const trimmed = gitdir.trim();
  for (const suffix of ['/.git', '\\.git']) {
    if (trimmed.endsWith(suffix)) return trimmed.slice(0, -suffix.length);
  }
  return null;
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Linked checkouts whose commondir is written. Missing or empty commondir is the half-written entry: skip it. */
async function linkedWorktreesFromDisk(commonDir: string): Promise<string[]> {
  const root = path.join(commonDir, 'worktrees');
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  for (const name of names) {
    const entry = path.join(root, name);
    const commondir = await readOptional(path.join(entry, 'commondir'));
    if (!commondir?.trim()) continue;
    const gitdir = await readOptional(path.join(entry, 'gitdir'));
    const checkout = gitdir === null ? null : checkoutFromGitdir(gitdir);
    if (checkout) found.push(checkout);
  }
  return found;
}

/**
 * `git worktree list --porcelain`. An in-flight add's entry is retried once, then the list is read
 * from each worktrees entry's gitdir file, skipping an entry with no written commondir.
 * Every other git error is rethrown unchanged. `read` lets a caller keep its own git runner (prune's timeout).
 */
export async function worktreeListPorcelain(cwd: string, read = () => git(cwd, 'worktree', 'list', '--porcelain')): Promise<string> {
  try {
    return await read();
  } catch (error) {
    if (!isInFlightWorktreeEntry(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, WORKTREE_LIST_RETRY_MS));
    try {
      return await read();
    } catch (retryError) {
      if (!isInFlightWorktreeEntry(retryError)) throw retryError;
      const common = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      const linked = await linkedWorktreesFromDisk(common);
      const lines = ['worktree ' + mainWorktreePath(common)];
      for (const checkout of linked) lines.push('worktree ' + checkout);
      return lines.join('\n');
    }
  }
}

/** The checkout `dir` belongs to, and the MAIN checkout of that repository. */
export async function repoOf(dir: string): Promise<{ top: string; main: string }> {
  const top = await checkoutTop(dir);
  // The first `worktree list` entry is the main checkout, also when `dir` is a linked worktree.
  const main = (await worktreeListPorcelain(top)).split('\n')[0].replace(/^worktree /, '');
  return { top, main: path.resolve(main) };
}

/** The commit `base` names, or an error: resolved once so the seat's diff has a fixed origin. */
export async function resolveCommit(repo: string, base: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]*$/.test(base)) throw new Error(`base '${base}' is not a ref or commit`);
  try {
    return await git(repo, 'rev-parse', '--verify', '--end-of-options', `${base}^{commit}`);
  } catch {
    throw new Error(`base '${base}' does not name a commit in ${repo}`);
  }
}

// Git's racy-clean check uses the index file's mtime. A fresh copy with a newer
// mtime can make a same-size edit appear clean to `git add -A`.
export async function copyIndex(source: string, target: string): Promise<void> {
  const { atime, mtime } = await stat(source);
  await copyFile(source, target);
  await utimes(target, atime, mtime);
}

/**
 * A commit of `repo`'s working tree as it is now, uncommitted and untracked
 * (not ignored) files included, whose parent is HEAD — without touching the
 * lead's index, branch or stash. A reviewer's worktree checks it out, so the
 * change under review is `git diff HEAD^` there (task 1430: before this a
 * reviewer only ever saw the committed base). The lead's own index is copied
 * first so git reuses its stat cache instead of rehashing the tree.
 */
export async function snapshotCommit(repo: string): Promise<string> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'orch-snapshot-'));
  const index = path.join(scratch, 'index');
  try {
    const own = path.resolve(repo, await git(repo, 'rev-parse', '--git-path', 'index'));
    if (existsSync(own)) await copyIndex(own, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const run = async (...args: string[]) => (await gitOutput(repo, args, env)).trim();
    if (!existsSync(index)) await run('read-tree', 'HEAD');
    await run('add', '-A');
    const tree = await run('write-tree');
    return await run('commit-tree', tree, '-p', 'HEAD', '-m', `orch snapshot of ${repo} (HEAD plus its uncommitted changes)`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Logical bytes of objects introduced by a snapshot, excluding everything its parent reaches. */
export async function snapshotBytes(repo: string, commit: string): Promise<number> {
  const objects = await gitOutput(repo, ['rev-list', '--objects', '--no-object-names', commit, `^${commit}^`, '--']);
  const sizes = await new Promise<string>((resolve, reject) => {
    const child = execFile('git', ['cat-file', '--batch-check=%(objectsize)'],
      { cwd: repo, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin!.on('error', reject);
    child.stdin!.end(objects);
  });
  let bytes = 0;
  for (const size of sizes.trim().split('\n')) {
    if (!/^\d+$/.test(size)) throw new Error(`cannot measure snapshot object: ${size}`);
    bytes += Number(size);
    if (!Number.isSafeInteger(bytes)) throw new Error('snapshot size exceeds safe integer range');
  }
  return bytes;
}

/** Diagnose a refused transfer using captured blob sizes, not a recursive disk scan. */
export async function largestUntrackedSnapshotDirs(repo: string, commit: string): Promise<string> {
  const untracked = new Set((await gitOutput(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0'));
  const entries = await gitOutput(repo, ['ls-tree', '-rlz', commit]);
  const totals = new Map<string, number>();
  for (const entry of entries.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const file = entry.slice(tab + 1);
    if (!untracked.has(file)) continue;
    const size = /^\d+ blob [0-9a-f]+\s+(\d+)$/.exec(entry.slice(0, tab));
    if (!size) continue;
    const slash = file.indexOf('/');
    const dir = slash < 0 ? '(top-level files)' : `${file.slice(0, slash)}/`;
    totals.set(dir, (totals.get(dir) ?? 0) + Number(size[1]));
  }
  return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
    .map(([dir, bytes]) => `${JSON.stringify(dir)} (${bytes} bytes)`).join(', ') || 'none (size may come from tracked changes)';
}

export const worktreeQueue = createKeyedQueue();

/** Git reads sibling commondir files during add; one in-flight add can leave one empty.
 * Main and linked checkouts share a queue, while unrelated repositories never wait.
 */
export async function createWorktree(repo: string, dir: string, commit: string, branch: string | null): Promise<void> {
  const common = await realpath(await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  await worktreeQueue(common, async () => {
    if (branch) await git(repo, 'worktree', 'add', '-b', branch, dir, commit);
    else await git(repo, 'worktree', 'add', '--detach', dir, commit);
  });
}

/**
 * A cwd git can actually run in. The recorded `repo` can be a lead landing
 * worktree that has since been removed; spawning git with a missing cwd fails
 * before git runs (`spawn git ENOENT`, orch 2026-09-24), leaving reviewer
 * worktrees registered forever. Git runs inside the common git directory
 * itself — valid for the normal `<main>/.git` and the `--separate-git-dir`
 * layouts alike (its parent is not a checkout in the latter). `repo` itself
 * when it still exists. Throws when the surviving worktree is not a checkout;
 * callers keep that in per-seat error handling, never in daemon startup.
 */
export async function runnableRepo(repo: string, worktree: string | null | undefined): Promise<string> {
  if (existsSync(repo)) return repo;
  if (worktree && existsSync(worktree)) return path.resolve(worktree, await git(worktree, 'rev-parse', '--git-common-dir'));
  return repo;
}

/** Pid files of the background codegraph daemon. The MCP stdio front is not listed here and is never scanned for. */
const CODEGRAPH_PID_FILES = ['daemon.pid', 'writer.pid'] as const;
const CODEGRAPH_STOP_WAIT_MS = 2_000;
const CODEGRAPH_STOP_POLL_MS = 50;

export type CodegraphPidFile = (typeof CODEGRAPH_PID_FILES)[number];

export type CodegraphDaemonStop = {
  stopped: { pid: number; file: CodegraphPidFile; signal: 'SIGTERM' | 'SIGKILL' }[];
  skipped: { file: string; reason: string; pid?: number }[];
};

export type CodegraphDaemonDeps = {
  /** `ps -o command= -p <pid>`. Injected so a test can name a command without a real codegraph. */
  commandOf?: (pid: number) => Promise<string>;
  /** `process.kill`. Signal `0` only asks whether the pid is still alive. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Defaults to `process.platform`. win32 is a no-op: the measured leak and `ps` are POSIX. */
  platform?: NodeJS.Platform;
  /** Defaults to `~/.codegraph/daemons`. */
  registryDir?: string;
};

type CodegraphKill = NonNullable<CodegraphDaemonDeps['kill']>;

function emptyCodegraphStop(): CodegraphDaemonStop {
  return { stopped: [], skipped: [] };
}

function sameRoot(left: string, right: string): boolean {
  if (left === right) return true;
  const norm = (value: string) => path.resolve(value).replace(/[\\/]+$/, '');
  return norm(left) === norm(right);
}

/** Every `--path <value>` argument of `command`, `--path=value` included. */
function commandPathValues(command: string): string[] {
  const values: string[] = [];
  const parts = command.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    const value = part === '--path' ? parts[i + 1] : part.startsWith('--path=') ? part.slice('--path='.length) : undefined;
    if (value !== undefined) values.push(value);
  }
  return values;
}

async function defaultCommandOf(pid: number): Promise<string> {
  try {
    return (await exec('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000, windowsHide: true })).stdout.trim();
  } catch {
    return '';
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processExited(pid: number, kill: CodegraphKill): boolean {
  try {
    kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function waitForExit(pid: number, kill: CodegraphKill): Promise<boolean> {
  const deadline = Date.now() + CODEGRAPH_STOP_WAIT_MS;
  for (;;) {
    if (processExited(pid, kill)) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await sleepMs(Math.min(CODEGRAPH_STOP_POLL_MS, left));
  }
}

/** ENOENT is absence. JSON `{pid}` or a JSON number; anything else is malformed. */
async function readCodegraphPid(file: string): Promise<{ pid: number } | { reason: string } | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { reason: error instanceof Error ? error.message : 'unreadable' };
  }
  const trimmed = text.trim();
  if (!trimmed) return { reason: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { reason: 'malformed json' };
  }
  const pid = typeof parsed === 'number' ? parsed : parsed && typeof parsed === 'object' ? (parsed as { pid?: unknown }).pid : undefined;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return { reason: 'malformed pid' };
  return { pid };
}

async function registryOwns(pid: number, root: string, registryDir: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(registryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(registryDir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const entry = parsed as { pid?: unknown; root?: unknown };
    if (entry.pid === pid && typeof entry.root === 'string' && sameRoot(entry.root, root)) return true;
  }
  return false;
}

/**
 * Stop the background codegraph daemon of `root` (task 2313). Missing pid files are a no-op.
 * A pid is signalled only when its command is `codegraph` with `--path <root>`, or the registry
 * entry for that pid names this root and the command is not some other program. An explicit
 * `--path <other root>` skips the pid even when a registry entry names this root: the command
 * line is what the daemon serves, and only a command without `--path` (the MCP stdio front)
 * falls back to the registry. SIGTERM, then SIGKILL if it is still alive after 2s. win32 is a no-op.
 */
export async function stopCodegraphDaemon(root: string, deps?: CodegraphDaemonDeps): Promise<CodegraphDaemonStop> {
  if ((deps?.platform ?? process.platform) === 'win32') return emptyCodegraphStop();
  const result = emptyCodegraphStop();
  try {
    const dir = path.join(root, '.codegraph');
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw error;
    }
    if (info.isSymbolicLink()) {
      result.skipped.push({ file: '.codegraph', reason: 'codegraph dir is a symlink' });
      return result;
    }
    if (!info.isDirectory()) {
      result.skipped.push({ file: '.codegraph', reason: 'codegraph path is not a directory' });
      return result;
    }
    const kill = deps?.kill ?? ((pid, signal) => process.kill(pid, signal));
    const commandOf = deps?.commandOf ?? defaultCommandOf;
    const registryDir = deps?.registryDir ?? path.join(os.homedir(), '.codegraph', 'daemons');
    const seen = new Set<number>();
    for (const name of CODEGRAPH_PID_FILES) {
      const read = await readCodegraphPid(path.join(dir, name));
      if (read === null) continue;
      if ('reason' in read) {
        result.skipped.push({ file: name, reason: read.reason });
        continue;
      }
      const pid = read.pid;
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (pid === process.pid) {
        result.skipped.push({ file: name, pid, reason: 'refusing to signal this process' });
        continue;
      }
      let command = '';
      try {
        command = await commandOf(pid);
      } catch {
        command = '';
      }
      // An explicit `--path` naming another root beats a registry entry that names this one:
      // the command line is what the daemon serves; a registry entry can be stale (task 2313 slice 2).
      const paths = command.includes('codegraph') ? commandPathValues(command) : [];
      const owns = paths.some((value) => sameRoot(value, root));
      const otherRoot = paths.length > 0 && !owns;
      const denies = command.length > 0 && !command.includes('codegraph');
      let registry = false;
      if (!owns && !otherRoot && !denies) {
        try {
          registry = await registryOwns(pid, root, registryDir);
        } catch (error) {
          result.skipped.push({ file: name, pid, reason: error instanceof Error ? error.message : 'registry unreadable' });
          continue;
        }
      }
      if (!owns && !registry) {
        const reason = otherRoot ? 'codegraph of another root' : denies ? 'not a codegraph process' : 'not a codegraph process of this root';
        result.skipped.push({ file: name, pid, reason });
        continue;
      }
      try {
        kill(pid, 'SIGTERM');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        result.skipped.push({ file: name, pid, reason: code === 'ESRCH' ? 'already exited' : error instanceof Error ? error.message : 'signal failed' });
        continue;
      }
      if (await waitForExit(pid, kill)) {
        result.stopped.push({ pid, file: name, signal: 'SIGTERM' });
        continue;
      }
      try {
        kill(pid, 'SIGKILL');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') {
          result.stopped.push({ pid, file: name, signal: 'SIGTERM' });
          continue;
        }
        result.skipped.push({ file: name, pid, reason: error instanceof Error ? error.message : 'SIGKILL failed' });
        continue;
      }
      if (await waitForExit(pid, kill)) result.stopped.push({ pid, file: name, signal: 'SIGKILL' });
      else result.skipped.push({ file: name, pid, reason: 'still running after SIGKILL' });
    }
  } catch (error) {
    result.skipped.push({ file: '.codegraph', reason: error instanceof Error ? error.message : 'stop failed' });
  }
  return result;
}

/** Seat event for a stop that did something. Stored only when a daemon was stopped; a skipped-only
 * result is logged at info, and an empty result (no daemon) is neither logged nor stored. */
export function noteCodegraphDaemonStop(
  result: CodegraphDaemonStop,
  seatId: string,
  root: string,
  store: { appendEvent: (kind: string, payload: Record<string, unknown>, seatId?: string | null) => unknown },
  log?: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void,
): void {
  if (!result.stopped.length && !result.skipped.length) return;
  const fields = { seat: seatId, root, stopped: result.stopped, skipped: result.skipped };
  if (result.stopped.length) store.appendEvent('seat.codegraph_daemon_stopped', fields, seatId);
  log?.('info', 'seat.codegraph_daemon_stopped', fields);
}

export async function removeWorktree(repo: string, dir: string): Promise<CodegraphDaemonStop> {
  const daemons = await stopCodegraphDaemon(dir);
  const cwd = await runnableRepo(repo, dir);
  const common = await realpath(await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  await worktreeQueue(common, () => git(cwd, 'worktree', 'remove', '--force', dir));
  return daemons;
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, 'branch', '-D', '--end-of-options', branch);
}

/** Git for Windows' bash, never WSL's: the setup lines are POSIX shell and run on Windows paths. */
async function bashExecutable(): Promise<string> {
  if (process.platform !== 'win32') return 'bash';
  const candidates: string[] = [];
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (root) candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
  }
  try {
    for (const line of (await exec('where', ['git'], { encoding: 'utf8', windowsHide: true })).stdout.split(/\r?\n/)) {
      const found = line.trim();
      if (!found) continue;
      const root = /\\mingw\d+\\bin\\/i.test(found) ? path.dirname(path.dirname(path.dirname(found))) : path.dirname(path.dirname(found));
      candidates.push(path.join(root, 'bin', 'bash.exe'));
    }
  } catch { /* git not on PATH: the fixed roots may still hit */ }
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (!hit) throw new Error('Git for Windows bash.exe not found; a seat worktree cannot be provisioned');
  return hit;
}

export type ProvisionStep = { command: string; code: number | null; ms: number; tail: string };

/**
 * The heavy setup steps (npm ci, codegraph init) run inside a slot of the
 * machine-local build gate (ops/orchestrator/build-gate.mjs), so parallel seat
 * provisioning cannot saturate the host (task 1803). worktree-setup.json's
 * `gate` list marks them by substring; these defaults cover a setup file that
 * predates the field. `--exec` gates any command, so this is one mechanism for
 * every heavy step, local and remote alike.
 */
const DEFAULT_GATE_MARKERS = ['npm ci', 'codegraph init'];
export function gatedSetupLine(line: string, markers?: string[]): boolean {
  return (markers ?? DEFAULT_GATE_MARKERS).some((marker) => line.includes(marker));
}
const buildGateScript = fileURLToPath(new URL('../build-gate.mjs', import.meta.url));

/**
 * Task 2930: build-gate.mjs prints this on stderr in --exec mode once the machine slot is held
 * and the step's own runtime begins. A gated step's timeoutMs starts at this marker, not at
 * spawn, so queueing for a slot cannot eat the step budget; until the marker a longer cap
 * bounds only the slot wait itself.
 */
export const SLOT_ACQUIRED_MARKER = 'build-gate: slot acquired';
/** How long a gated setup step may queue for a machine build slot before provisioning fails it. */
export const BUILD_SLOT_WAIT_MS = 2 * 60 * 60_000;
/** The slot-wait cap in force: the 2 h default, tightened by ORCH_BUILD_SLOT_WAIT_MS for tests and operators. */
export function slotWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.ORCH_BUILD_SLOT_WAIT_MS);
  return Number.isSafeInteger(override) && override > 0 ? override : BUILD_SLOT_WAIT_MS;
}

/**
 * Kill a step with everything it started: killing bash alone leaves `npm ci`
 * and friends holding the output pipes, so the step never ends (review
 * 2026-09-22). POSIX: the step leads its own process group; Windows: taskkill /T.
 */
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/** What `runStep` spawns. The caller's env stays; only an unset CARGO_BUILD_JOBS is filled. */
export function stepCommandLaunch(command: string, args: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const childEnv = withCargoBuildJobs(env);
  return { ...prioritySpawn(command, args, childEnv, platform), env: childEnv };
}

function runStep(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, gated = false): Promise<ProvisionStep> {
  const started = Date.now();
  return new Promise((resolve) => {
    const launch = stepCommandLaunch(command, args, env);
    const child = spawn(launch.file, launch.args, { cwd, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let output = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let slotTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(slotTimer);
      resolve({ command: args[args.length - 1], code, ms: Date.now() - started, tail: output.slice(-1500) });
    };
    const kill = (note: string) => {
      if (settled) return;
      output += note;
      if (child.pid) killTree(child.pid);
      // A descendant that escaped the group may still hold the pipes: the step is over regardless.
      setTimeout(() => finish(null), 5000).unref();
    };
    const armExecutionTimer = () => { timer = setTimeout(() => kill(`\n[orch] killed after ${timeoutMs} ms`), timeoutMs); };
    // A gated step (build-gate --exec) spends its first stretch only queueing for a machine slot,
    // so timeoutMs waits for the slot marker and the longer cap bounds the wait itself (task 2930).
    // The marker is detected on the stderr stream alone, against a stderr-only rolling tail: stdout
    // chunks interleaved between marker fragments must not push a fragment out of view.
    // A gate script that predates the marker never prints it: the cap is then the only bound left.
    let stderrTail = '';
    const onStdout = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-4000); };
    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (gated && timer === undefined) {
        const merged = stderrTail + text;
        if (merged.includes(SLOT_ACQUIRED_MARKER)) {
          clearTimeout(slotTimer);
          armExecutionTimer();
        }
        stderrTail = merged.slice(-(SLOT_ACQUIRED_MARKER.length - 1));
      }
      output = (output + text).slice(-4000);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    if (gated) {
      const waitMs = slotWaitMs(env);
      slotTimer = setTimeout(() => kill(`\n[orch] no build slot came within ${waitMs} ms`), waitMs);
    } else armExecutionTimer();
    child.on('error', (error) => { output += `\n${error.message}`; finish(null); });
    child.on('close', (code) => finish(code));
  });
}

/**
 * Run orch's worktree setup inside `dir`. A step that exits non-zero
 * stops provisioning and fails the seat: a coder without node_modules cannot
 * run the checks its brief asks for. The setup lines guard their own optional
 * parts with `|| true`.
 */
export async function provisionWorktree(main: string, dir: string, timeoutMs = 20 * 60_000): Promise<{ ok: boolean; steps: ProvisionStep[] }> {
  const config = path.join('ops', 'orchestrator', 'worktree-setup.json');
  let setup: string[] = [];
  let gateMarkers: string[] | undefined;
  let source: 'seat' | 'lead' | null = null;
  for (const [checkout, root] of [['seat', dir], ['lead', main]] as const) {
    try {
      const parsed = JSON.parse(await readFile(path.join(root, config), 'utf8'));
      setup = parsed?.setup ?? [];
      gateMarkers = Array.isArray(parsed?.gate) ? parsed.gate : undefined;
      source = checkout;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const bash = await bashExecutable();
  const env = { ...process.env, ORCH_SOURCE_CHECKOUT_PATH: main };
  const steps: ProvisionStep[] = [];
  for (const line of setup) {
    const step = gatedSetupLine(line, gateMarkers)
      ? await runStep(process.execPath, [buildGateScript, '--exec', bash, '-c', line], dir, env, timeoutMs, true)
      : await runStep(bash, ['-c', line], dir, env, timeoutMs);
    step.command = `[${source} ${config}] ${line}`;
    steps.push(step);
    if (step.code !== 0) return { ok: false, steps };
  }
  // The seat's committed hook may be older and still copy tracked files over its own base.
  // Run the lead's provisioner in the seat cwd; it provisions only ignored local state.
  const harness = path.join(main, 'ops', 'bootstrap', 'provision-worktree.sh');
  if (existsSync(harness)) {
    const step = await runStep(bash, [harness], dir, env, timeoutMs);
    steps.push(step);
    if (step.code !== 0) return { ok: false, steps };
  }
  return { ok: true, steps };
}

/** What a seat changed in its worktree since `base`: committed and uncommitted. */
export async function worktreeChanges(dir: string, base: string): Promise<{ files: number; stat: string } | null> {
  try {
    // Not through git(): trimming would eat the first line's leading status column.
    const porcelain = await gitOutput(dir, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']);
    const committed = await git(dir, 'diff', '--name-only', `${base}...HEAD`);
    const porcelainLines = porcelain.split('\n').filter(Boolean);
    const committedLines = committed.split('\n').filter(Boolean);
    // The digest counts these raw fields. A rename stays one file.
    const files = new Set([...porcelainLines.map((line) => line.slice(3)), ...committedLines]).size;
    const stat = await git(dir, '--no-optional-locks', 'diff', '--shortstat', base);
    return { files, stat };
  } catch {
    return null;
  }
}
