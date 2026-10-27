// Task 2861 review: the one shared gate and traversal helpers of the four disk
// sweeps (target, tmp, worktree, backup). The gate answers "may this pass run";
// the helpers validate, walk and measure trees the same way everywhere.
import { lstat, mkdir, open, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';

export const DAY = 24 * 60 * 60_000;
export const HOUR = 60 * 60_000;
/** An interrupted recursive delete is retried by a later pass only once past this age. */
export const DROP_GRACE = HOUR;
/** A lease — any day's — blocks another pass for as long as it can be a live
 *  holder: no sweep pass over the real stores runs anywhere near a full day, so
 *  one day is both the overlap window (a pass crossing midnight stays exclusive
 *  however long it runs) and the bound on a crashed lease's blocking — the same
 *  one-day bound the per-day lease names already gave a crashed lease (its own
 *  day) before this constant existed. */
const LEASE_MAX_AGE = DAY;

export function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

export function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && relative !== '..' && !path.isAbsolute(relative));
}

// lstat every component below the trusted root; even a symlink to another
// directory *inside* the root is refused. rm itself does not follow leaf links.
export async function directoryBelow(root: string, relative: string): Promise<string> {
  let current = root;
  for (const component of relative.split('/')) {
    if (!component) continue;
    current = path.join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`not a plain directory: ${current}`);
  }
  return current;
}

export async function treeBytes(root: string): Promise<number> {
  let bytes = 0;
  const entries = await opendir(root);
  for await (const entry of entries) {
    const file = path.join(root, entry.name);
    const stat = await lstat(file);
    bytes += stat.isDirectory() && !stat.isSymbolicLink() ? await treeBytes(file) : stat.size;
  }
  return bytes;
}

// Newest mtime of the entry itself and its whole tree. A plain
// file is aged by its own mtime (opendir on one is ENOTDIR); symlinked children
// are dated, never followed.
export async function newestMtime(root: string, stat: Stats): Promise<number> {
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  const entries = await opendir(root);
  for await (const entry of entries) {
    const file = path.join(root, entry.name);
    const child = await lstat(file);
    if (child.isDirectory() && !child.isSymbolicLink()) newest = Math.max(newest, await newestMtime(file, child));
    else newest = Math.max(newest, child.mtimeMs);
  }
  return newest;
}

/** Whether an entry is PROVEN older than `cutoff` down to `depth` levels — or
 *  null when the depth bound left content unread and the age cannot be proved
 *  either way (task 2861 review r2): a fresh file deeper than the walk looks
 *  exactly like an old directory, so the caller must skip, never remove. An
 *  empty directory at the bound still proves its age. */
export async function provenOlder(root: string, stat: Stats, depth: number, cutoff: number): Promise<boolean | null> {
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.mtimeMs < cutoff;
  if (stat.mtimeMs >= cutoff) return false;
  if (depth <= 0) {
    for await (const _ of await opendir(root)) return null; // content below the bound
    return true; // the bound rests on an empty directory
  }
  const entries = await opendir(root);
  for await (const entry of entries) {
    const file = path.join(root, entry.name);
    const child = await lstat(file);
    if (child.isDirectory() && !child.isSymbolicLink()) {
      const below = await provenOlder(file, child, depth - 1, cutoff);
      if (below !== true) return below;
    } else if (child.mtimeMs >= cutoff) return false;
  }
  return true;
}

export type SweepGate = {
  /** Publishes the daily stamp; a no-op for a dry run. A crash after publish must not re-run the pass. */
  publish: () => Promise<void>;
  /** Releases this holder's lease — the only lease rm, and only of its own name. */
  release: () => Promise<void>;
};

/** The daily stamp + exclusive lease every sweep shares. `base` names the files:
 *  `<stateDir>/<base>.last` (stamp) and `<stateDir>/<base>.lock.<UTC day>` (lease).
 *
 *  Admission is ONE exclusive create: open(path, 'wx') is O_CREAT|O_EXCL on macOS
 *  APFS and CREATE_NEW on Windows NTFS — atomic per name on both, so among any
 *  number of contenders on the same day's lease exactly one is admitted and the
 *  rest see EEXIST. An expired lease is never taken over by unlinking it: unlink
 *  and recreate cannot be one atomic step, and an unconditional rm from a stale
 *  stat deletes a fresh holder's lease (two sweeps at once). Instead each day
 *  gets its own lease name, and no contender ever deletes a lease it did not
 *  create. The holder's release()
 *  removes its own name, race-free because no contender can create that name
 *  while the file exists. Admission ORDER (task 2861 review r3): the own-day
 *  lease is created first, then the other leases are scanned — after the create,
 *  a scan cannot miss a lease created before it, so of two acquirers straddling
 *  midnight at most one passes and both refusing is fine; a refusal removes its
 *  own lease so nothing lingers. A lease whose mtime lies in the future (clock
 *  skew) blocks until it is one day old BY THAT MTIME: a skewed stamp delays a
 *  pass, it never admits a second one.
 *  daily=true is the daemon gate; a manual run bypasses the stamp but still
 *  serializes through the lease. Dry-run touches nothing. */
export async function acquireSweepGate(options: { stateDir: string; base: string; daily?: boolean; dryRun?: boolean; now?: number }): Promise<SweepGate | null> {
  const { stateDir, base, daily = false, dryRun = false } = options;
  const now = options.now ?? Date.now();
  const stamp = path.join(stateDir, `${base}.last`);
  const due = async (): Promise<boolean> => {
    try {
      const last = Number(await readFile(stamp, 'utf8'));
      if (!Number.isFinite(last) || last <= 0) throw new Error(`invalid ${base} timestamp: ${stamp}`);
      return now - last >= DAY;
    } catch (error) { if (missing(error)) return true; throw error; }
  };
  if (daily && !await due()) return null;
  if (dryRun) {
    if (daily && !await due()) return null;
    return { publish: async () => undefined, release: async () => undefined };
  }
  const day = new Date(now).toISOString().slice(0, 10);
  const lease = path.join(stateDir, `${base}.lock.${day}`);
  await mkdir(stateDir, { recursive: true });
  // Create FIRST, then scan (task 2861 review r3): two acquirers whose `now`
  // falls on different UTC days both passed the scan-then-create order. After
  // the create a scan cannot miss a lease created before it.
  let locked = false;
  try { await (await open(lease, 'wx')).close(); locked = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error; }
  // Overlap: another lease that can still be a live holder refuses this pass.
  const own = path.basename(lease);
  try {
    for await (const entry of await opendir(stateDir)) {
      if (!entry.name.startsWith(`${base}.lock.`) || entry.name === own) continue;
      const stat = await lstat(path.join(stateDir, entry.name));
      if (now - stat.mtimeMs < LEASE_MAX_AGE) {
        // A refusal never leaves its own lease behind.
        await rm(lease, { force: true }).catch(() => undefined);
        locked = false;
        return null;
      }
    }
  } catch (error) { if (!missing(error)) throw error; }
  // A concurrent daily pass may have stamped between the first check and the lease.
  if (daily && !await due()) { await rm(lease, { force: true }).catch(() => undefined); return null; }
  return {
    publish: async () => {
      const temp = `${stamp}.${process.pid}.tmp`;
      await writeFile(temp, String(now));
      await rename(temp, stamp);
    },
    release: async () => { if (locked) await rm(lease, { force: true }).catch(() => undefined); },
  };
}
