// Task 2861 slice D: the whole-worktree lifecycle under .claude/worktrees.
// Caches (node_modules, .codegraph) go by rename-then-delete from every idle
// worktree, app-made claude/* branches included. A lead-made checkout (branch
// NOT under claude/) additionally goes away through `git worktree remove` once
// its tip is contained in master, `git status --porcelain --ignored` shows
// nothing but one allow-list of ignored paths, its HEAD reflog has no entry in
// 3 days, no file changed in 3 days (bounded walk) and no process has its cwd
// inside — with every liveness clause re-sampled at the deletion moment. The
// branch always stays; the main checkout is never touched; nothing throws out
// of the per-worktree loop.
import { execFile } from 'node:child_process';
import { lstat, opendir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { processSnapshot } from './target-sweep.ts';
import { DAY, DROP_GRACE, HOUR, acquireSweepGate, directoryBelow, inside, missing, treeBytes } from './sweep-shared.ts';
import { stopCodegraphDaemon, worktreeListPorcelain, worktreeQueue } from './worktrees.ts';
import { projectConfig } from '../../../scripts/lib/harness-config.mjs';

const exec = promisify(execFile);
/** Caches and whole checkouts alike require this much quiet first. */
const WINDOW = 3 * DAY;
/** How many levels below a worktree the bounded change walk descends. */
const WALK_DEPTH = 3;
const DROPPING = '.dropping-';
/** Regenerable caches of one worktree, at its root. */
const CACHE_DIRS = ['node_modules', '.codegraph'] as const;
/** The only ignored paths (`git status --porcelain --ignored` spelling) a removable
 *  checkout may contain; any other ignored entry (.env, .secrets/) is a skip. */
const ALLOWED_IGNORED = new Set(['node_modules/', 'target/', '.codegraph/', 'dist/', '.vite/']);

type Process = Awaited<ReturnType<typeof processSnapshot>>[number];

type Item = { path: string; bytesBefore: number; branch: string | null };
export type WorktreeSweepResult = {
  dryRun: boolean;
  candidates: Item[];
  removed: { path: string; bytes: number; branch: string | null; kind: 'worktree' | 'cache' }[];
  bytesBefore: number;
  skipped: { path: string; reason: string }[];
};

type Registered = { path: string; branch: string | null; locked: boolean };
type SweepContext = { root: string; checkout: string; worktreesDir: string; common: string; project: ReturnType<typeof projectConfig>; dryRun: boolean; now: number; result: WorktreeSweepResult };

const gitOut = async (cwd: string, args: string[], timeout = 20_000): Promise<string> =>
  (await exec('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true })).stdout;

/** True when nothing at or below `root` (depth-bounded, symlinks dated not followed,
 *  our own `.dropping-<ms>` leftovers excluded) changed since `cutoff`. Early-exits
 *  on the first recent entry. */
async function quietTree(root: string, depth: number, cutoff: number): Promise<boolean> {
  if ((await lstat(root)).mtimeMs >= cutoff) return false;
  if (depth <= 0) return true;
  const entries = await opendir(root);
  for await (const entry of entries) {
    if (/\.dropping-\d+$/.test(entry.name)) continue;
    const file = path.join(root, entry.name);
    const stat = await lstat(file);
    if (stat.mtimeMs >= cutoff) return false;
    if (stat.isDirectory() && !stat.isSymbolicLink() && !await quietTree(file, depth - 1, cutoff)) return false;
  }
  return true;
}

function busyIn(processes: Process[], spellings: string[]): boolean {
  return processes.some((proc) => proc.cwd !== null && spellings.some((spelling) => inside(spelling, proc.cwd as string)));
}

async function generatedOutput(worktree: string, entry: string, generated: readonly string[]): Promise<boolean> {
  const relative = entry.replace(/\/$/, '');
  if (generated.some((dir) => relative === dir || relative.startsWith(`${dir}/`))) return true;
  // Git can collapse ignored generated output to its parent. Unlike prune's
  // broader disposable policy, every child here must be generated output.
  if (!entry.endsWith('/') || !generated.some((dir) => dir.startsWith(`${relative}/`))) return false;
  const folder = path.join(worktree, relative);
  if (!(await lstat(folder)).isDirectory()) return false;
  for await (const child of await opendir(folder)) {
    if (!await generatedOutput(worktree, `${relative}/${child.name}${child.isDirectory() ? '/' : ''}`, generated)) return false;
  }
  return true;
}

async function allowedIgnored(worktree: string, entry: string, project: SweepContext['project']): Promise<boolean> {
  return ALLOWED_IGNORED.has(entry) || /^web\/(?:.*\/)?node_modules\/$/.test(entry) ||
    project.targetDirs.some((dir) => entry === `${dir}/`) ||
    await generatedOutput(worktree, entry, project.generatedPaths);
}

/** `git status --porcelain --ignored` must show nothing at all except allow-listed
 *  ignored entries; the first offending line becomes the skip reason. */
async function cleanForRemoval(dir: string, project: SweepContext['project']): Promise<string | null> {
  // --no-optional-locks: a worktree-comparing read must not take index.lock.
  const status = await gitOut(dir, ['--no-optional-locks', 'status', '--porcelain', '--ignored']);
  for (const line of status.split('\n')) {
    if (!line) continue;
    if (line.startsWith('!! ')) {
      const raw = line.slice(3);
      const entry = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
      if (!await allowedIgnored(dir, entry, project)) return `ignored entry not allowed: ${entry}`;
    } else return `uncommitted or untracked changes: ${line}`;
  }
  return null;
}

async function tipInMaster(dir: string): Promise<string | null> {
  try { await gitOut(dir, ['merge-base', '--is-ancestor', 'HEAD', 'master']); return null; }
  catch (error) {
    if ((error as { code?: unknown }).code === 1) return 'tip not contained in master';
    return `master containment unproved: ${(error as Error).message}`;
  }
}

/** No HEAD reflog entry within the window; `reflog show --date=unix` prints the
 *  ENTRY time as the `HEAD@{<unix>}` selector (git log -g would format the commit's
 *  committer time instead). An empty reflog qualifies. */
async function reflogIdle(dir: string, cutoff: number): Promise<boolean> {
  const out = await gitOut(dir, ['reflog', 'show', '--date=unix', 'HEAD']);
  let newest = 0;
  for (const line of out.split('\n')) {
    const stamped = line.match(/@\{(\d+)\}/);
    if (stamped) newest = Math.max(newest, Number(stamped[1]));
  }
  return newest * 1000 < cutoff;
}

async function registeredWorktrees(root: string): Promise<Registered[]> {
  const text = await worktreeListPorcelain(root);
  const found: Registered[] = [];
  let current: Registered | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) found.push(current);
      current = { path: path.resolve(line.slice('worktree '.length)), branch: null, locked: false };
    } else if (current && line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (current && line.startsWith('locked')) current.locked = true;
  }
  if (current) found.push(current);
  return found;
}

/** Delete `<cache>.dropping-<ms>` leftovers past the grace age: an interrupted
 *  recursive delete dies with its stamp, and a live delete is never that old. */
async function removeStaleDrops(dir: string, spellings: string[], result: WorktreeSweepResult, now: number): Promise<void> {
  let entries;
  try { entries = await opendir(dir); } catch (error) { if (missing(error)) return; throw error; }
  for await (const entry of entries) {
    for (const cache of CACHE_DIRS) {
      const prefix = `${cache}${DROPPING}`;
      if (!entry.name.startsWith(prefix)) continue;
      const stamp = Number(entry.name.slice(prefix.length));
      const dropping = path.join(dir, entry.name);
      if (!Number.isInteger(stamp) || stamp < 0 || now - stamp < DROP_GRACE) continue;
      try {
        const bytes = await treeBytes(dropping);
        // Liveness is sampled AFTER the byte walk, right before the rm (task 2861
        // review r3): a process entering during the walk keeps the leftover.
        if (busyIn(await processSnapshot(), [...spellings, dropping])) {
          result.skipped.push({ path: dropping, reason: 'process inside the dropped leftover' });
          continue;
        }
        await rm(dropping, { recursive: true, force: true });
        result.removed.push({ path: dropping, bytes, branch: null, kind: 'cache' });
      } catch (error) {
        result.skipped.push({ path: dropping, reason: (error as Error).message });
      }
    }
  }
}

/** Drop the regenerable caches of one worktree that stays. Mirrors clearCaches:
 *  only untracked, git-ignored, plain directories; the quiet rule is sampled once
 *  after all byte walks, right before the renames, and each rename re-samples the
 *  process snapshot at its own deletion moment. */
async function dropCaches(context: SweepContext, dir: string, spellings: string[], cutoff: number): Promise<void> {
  const { dryRun, now, result } = context;
  if (!dryRun) await removeStaleDrops(dir, spellings, result, now);
  const caches: { rel: string; target: string; bytes: number }[] = [];
  for (const rel of CACHE_DIRS) {
    let target: string;
    try { target = await directoryBelow(dir, rel); }
    catch (error) {
      if (missing(error)) continue; // no such cache here: nothing to do
      result.skipped.push({ path: path.join(dir, rel), reason: (error as Error).message });
      continue;
    }
    if ((await gitOut(dir, ['ls-files', '-z', '--', rel])).length) {
      result.skipped.push({ path: target, reason: `contains tracked files: ${rel}` });
      continue;
    }
    try { await gitOut(dir, ['check-ignore', '-q', '--', rel]); }
    catch (error) {
      if ((error as { code?: unknown }).code !== 1) { result.skipped.push({ path: target, reason: (error as Error).message }); continue; }
      result.skipped.push({ path: target, reason: `not ignored by Git: ${rel}` });
      continue;
    }
    caches.push({ rel, target, bytes: await treeBytes(target) });
  }
  if (!caches.length) return;
  // Sampled after the byte walks (task 2699): a file the walk aged past is caught here.
  if (!await quietTree(dir, WALK_DEPTH, cutoff)) {
    for (const cache of caches) result.skipped.push({ path: cache.target, reason: `files modified within ${Math.round(WINDOW / HOUR)}h` });
    return;
  }
  for (const cache of caches) {
    if (busyIn(await processSnapshot(), [...spellings, cache.target])) {
      result.skipped.push({ path: cache.target, reason: 'process entered during inspection' });
      continue;
    }
    result.candidates.push({ path: cache.target, bytesBefore: cache.bytes, branch: null });
    result.bytesBefore += cache.bytes;
    if (!dryRun) {
      if (cache.rel === '.codegraph') await stopCodegraphDaemon(dir);
      const dropping = `${cache.target}${DROPPING}${Date.now()}`;
      await rename(cache.target, dropping);
      // A big tree takes a while to delete and must not hold the sweep; the next
      // pass's leftover rule retries an interrupted delete after the grace age.
      rm(dropping, { recursive: true, force: true }).catch(() => undefined);
      result.removed.push({ path: cache.target, bytes: cache.bytes, branch: null, kind: 'cache' });
    }
  }
}

/** One registered worktree: removal guards first (all reads), then either the
 *  whole checkout goes or its caches do. Never throws; the caller reports. */
async function sweepOne(context: SweepContext, registered: Registered): Promise<void> {
  const { root, common, dryRun, result } = context;
  const dir = registered.path;
  const name = path.relative(context.worktreesDir, dir);
  let stat;
  try { stat = await lstat(dir); }
  catch (error) {
    if (missing(error)) { result.skipped.push({ path: dir, reason: 'worktree directory missing' }); return; }
    throw error;
  }
  if (!stat.isDirectory()) { result.skipped.push({ path: dir, reason: 'not a directory' }); return; }
  // Every component from .claude/worktrees down is a real directory: no symlink path.
  await directoryBelow(context.worktreesDir, name);
  const spellings = [...new Set([
    dir,
    path.join(context.worktreesDir, name),
    path.join(path.resolve(context.checkout), '.claude', 'worktrees', name),
  ])];
  const cutoff = context.now - WINDOW;

  // App-made worktrees (claude/*) are caches only, by design: not a skip.
  if (!registered.branch?.startsWith('claude/')) {
    let reason = registered.locked ? 'worktree locked'
      : await tipInMaster(dir);
    if (!reason) reason = await cleanForRemoval(dir, context.project);
    if (!reason && !await reflogIdle(dir, cutoff)) reason = `HEAD reflog entry within ${Math.round(WINDOW / HOUR)}h`;
    if (!reason) {
      const bytes = await treeBytes(dir);
      // The byte walk is long: the quiet rule and the process snapshot are
      // re-sampled here, immediately before the removal (task 2699).
      if (!await quietTree(dir, WALK_DEPTH, cutoff)) reason = `files modified within ${Math.round(WINDOW / HOUR)}h`;
      else if (busyIn(await processSnapshot(), spellings)) reason = 'process entered during inspection';
      else if (!dryRun) {
        await stopCodegraphDaemon(dir);
        // The queue wait is unbounded, so liveness is sampled once more inside the
        // turn, right before git removes the checkout (task 2861 review): a process
        // entering during the wait must not lose its checkout. A late entrant keeps
        // the worktree and only its caches are considered below.
        const outcome = await worktreeQueue(common, async () => {
          if (busyIn(await processSnapshot(), spellings)) return 'process entered during inspection';
          // The full cleanliness check (tracked, untracked, non-allow-listed
          // ignored) is re-run inside the turn, right before git removes the
          // checkout (task 2861 review r2): a file written during the queue wait
          // must keep the worktree — git's own clean check does not guard ignored
          // files, and --force is never used.
          const dirty = await cleanForRemoval(dir, context.project);
          if (dirty) return dirty;
          // Plain remove — never --force: git's own clean check stays a second guard.
          await gitOut(root, ['worktree', 'remove', dir], 120_000);
          return null;
        });
        if (outcome) reason = outcome;
        else {
          result.candidates.push({ path: dir, bytesBefore: bytes, branch: registered.branch });
          result.bytesBefore += bytes;
          result.removed.push({ path: dir, bytes, branch: registered.branch, kind: 'worktree' });
          return; // the whole checkout is gone; its caches went with it
        }
      } else {
        result.candidates.push({ path: dir, bytesBefore: bytes, branch: registered.branch });
        result.bytesBefore += bytes;
        return; // the whole checkout is gone; its caches went with it
      }
    }
    result.skipped.push({ path: dir, reason });
  }
  await dropCaches(context, dir, spellings, cutoff);
}

/** daily=true is the daemon gate; a manual run bypasses it. Dry-run writes nothing.
 * A timestamp is published BEFORE work: a crash must not trigger another pass on
 * restart. The exclusive lease also serializes a manual run with the daemon; see
 * acquireSweepGate for the atomic lease. A crashed lease blocks its own day (same
 * lower bound as the persisted gate).
 */
export async function sweepWorktrees(options: { checkout: string; stateDir: string; daily?: boolean; dryRun?: boolean }): Promise<WorktreeSweepResult | null> {
  const { checkout, stateDir, daily = false, dryRun = false } = options;
  const now = Date.now();
  const gate = await acquireSweepGate({ stateDir, base: 'worktree-sweep', daily, dryRun });
  if (!gate) return null;
  const result: WorktreeSweepResult = { dryRun, candidates: [], removed: [], bytesBefore: 0, skipped: [] };
  try {
    await gate.publish();
    const root = await realpath(checkout);
    const project = projectConfig({ repoRoot: root });
    let worktreesDir: string;
    try { worktreesDir = await directoryBelow(root, '.claude/worktrees'); }
    catch (error) { if (missing(error)) return result; throw error; }
    const common = await realpath((await gitOut(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    const context: SweepContext = { root, checkout, worktreesDir, common, project, dryRun, now, result };
    for (const registered of await registeredWorktrees(root)) {
      // The main checkout itself, and anything outside .claude/worktrees, stays.
      if (registered.path === root || !inside(worktreesDir, registered.path) || inside(registered.path, worktreesDir)) continue;
      try { await sweepOne(context, registered); }
      catch (error) { if (!missing(error)) result.skipped.push({ path: registered.path, reason: (error as Error).message }); }
    }
  } catch (error) {
    result.skipped.push({ path: checkout, reason: `inspection failed: ${(error as Error).message}` });
  } finally { await gate.release(); }
  return result;
}
