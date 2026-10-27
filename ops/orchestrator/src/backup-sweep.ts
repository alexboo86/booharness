// Task 2861 slice S5 (operator decision #19671): worktree backups keep 14
// days. An entry directly under stateDir/worktree-backups — a seat's
// `<seat>.patch` / `<seat>.untracked.tgz`, the `.interrupted-<stamp>` copies a
// conflicting marker set aside, or a lead-made directory — goes once its
// newest content is older than the window. A file named by the marker of a
// removal still in progress (autoPruned set, worktreeRemoved not yet true —
// `prune.ts` resumeAged) stays, and that marker set is sampled again at the
// deletion moment, after the byte walks. A marker whose removal finished does
// not protect anything. A symlinked entry is never followed; nothing outside
// this root is the sweep's to judge. All I/O is asynchronous (as the sibling
// sweeps').
import { lstat, opendir, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { Store } from './store.ts';
import { protectedBackupPaths } from './prune.ts';
import { DAY, acquireSweepGate, missing, provenOlder, treeBytes } from './sweep-shared.ts';

/** Operator decision #19671: a backup entry keeps this long, then goes. */
const KEEP = 14 * DAY;
/** How many levels below a lead-made directory the bounded age walk descends.
 *  Deeper content cannot be proven old and skips (the real store holds files at
 *  depth 0 to 2 only, measured today, so eligible entries still go). */
const WALK_DEPTH = 3;

type Item = { path: string; bytesBefore: number };
export type BackupSweepResult = {
  root: string;
  candidates: Item[];
  removed: string[];
  bytesBefore: number;
  skipped: { path: string; reason: string }[];
};

/** Store-backed daemon wiring, also exercised at the live store shape. */
export function sweepStoreBackups(store: Store, options: Omit<Parameters<typeof sweepBackups>[0], 'protectedPaths'>): Promise<BackupSweepResult | null> {
  return sweepBackups({ ...options, protectedPaths: async () => {
    const named = new Set<string>();
    let cursor: { created_at: string; id: string } | null = null;
    for (;;) {
      // notOwned/mirrorNotOwned restrict marker writers and resumers to closed
      // coders, local or remote. CLI prune records approval, not a new marker.
      // These pages cover both kinds and exclude completed removals; the helper
      // keeps only paths actually named by a live marker.
      const page = store.pruneCandidatesPage(cursor, 500);
      for (const file of protectedBackupPaths(page.seats)) named.add(file);
      cursor = page.next;
      if (cursor === null) return named;
      // SQLite and JSON parsing are synchronous; microtask awaits do not yield
      // the daemon loop (task 2616). Bound each CPU stretch to one page.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } });
}

// Newest mtime and tree bytes live in sweep-shared.ts (task 2861 review dedupe).

/** daily=true is the daemon gate; a manual run bypasses it. Dry-run writes nothing.
 * A timestamp is published BEFORE work: a crash must not trigger another pass on
 * restart. The exclusive lease also serializes a manual run with the daemon; see
 * acquireSweepGate for the atomic lease. A crashed lease blocks its own day (same
 * lower bound as the persisted gate).
 */
export async function sweepBackups(options: {
  root?: string; stateDir: string; daily?: boolean; dryRun?: boolean; protectedPaths?: () => Iterable<string> | Promise<Iterable<string>>;
}): Promise<BackupSweepResult | null> {
  const { root, stateDir, daily = false, dryRun = false, protectedPaths } = options;
  const now = Date.now();
  const gate = await acquireSweepGate({ stateDir, base: 'worktree-backup-sweep', daily, dryRun });
  if (!gate) return null;
  const backupRoot = path.resolve(root ?? path.join(stateDir, 'worktree-backups'));
  const result: BackupSweepResult = { root: backupRoot, candidates: [], removed: [], bytesBefore: 0, skipped: [] };
  const sample = async () => new Set(Array.from(await protectedPaths?.() ?? [], (file) => path.resolve(file)));
  const inside = async (entry: string, stat: Stats, protectedSet: Set<string>, cutoff: number): Promise<number | null> => {
    // Returns the entry's bytes when it may go, else null after recording why.
    if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) {
      result.skipped.push({ path: entry, reason: 'not a plain file or directory' });
      return null;
    }
    const proven = await provenOlder(entry, stat, WALK_DEPTH, cutoff);
    if (proven !== true) {
      result.skipped.push({
        path: entry,
        // null is the depth bound (task 2861 review r2): a fresh file the walk
        // never read is indistinguishable from an old directory — skip, never remove.
        reason: proven === false ? `modified within ${KEEP / DAY} days` : `age not provable within depth ${WALK_DEPTH}`,
      });
      return null;
    }
    if (protectedSet.has(path.resolve(entry))) {
      result.skipped.push({ path: entry, reason: 'named by an active auto-prune marker' });
      return null;
    }
    return stat.isDirectory() ? await treeBytes(entry) : stat.size;
  };
  try {
    await gate.publish();
    const pending: Item[] = [];
    const protectedSet = await sample();
    const cutoff = now - KEEP;
    try {
      const entries = await opendir(backupRoot);
      for await (const entry of entries) {
        const file = path.join(backupRoot, entry.name);
        try {
          const stat = await lstat(file);
          const bytes = await inside(file, stat, protectedSet, cutoff);
          if (bytes !== null) pending.push({ path: file, bytesBefore: bytes });
        } catch (error) {
          if (!missing(error)) result.skipped.push({ path: file, reason: (error as Error).message });
        }
      }
    } catch (error) { if (!missing(error)) throw error; return result; }
    // The first sample is stale after the byte walks: take one more right
    // before the removals, and re-check each entry's shape and age too.
    const fresh = await sample();
    const removalCutoff = Date.now() - KEEP;
    for (const item of pending) {
      try {
        const stat = await lstat(item.path);
        const bytes = await inside(item.path, stat, fresh, removalCutoff);
        if (bytes === null) continue;
        result.candidates.push(item);
        result.bytesBefore += item.bytesBefore;
        if (!dryRun) {
          await rm(item.path, { recursive: true, force: true });
          result.removed.push(item.path);
        }
      } catch (error) {
        if (!missing(error) || result.candidates.some((candidate) => candidate.path === item.path)) {
          result.skipped.push({ path: item.path, reason: (error as Error).message });
        }
      }
    }
  } catch (error) {
    result.skipped.push({ path: backupRoot, reason: `inspection failed: ${(error as Error).message}` });
  } finally { await gate.release(); }
  return result;
}
