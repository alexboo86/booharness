// Daily sweep of the tmp root: leftovers of our own killed test runs and
// checks. A SIGKILLed run skips its finally, so only a later pass reclaims
// the bytes. Only names this harness owns (TMP_PREFIXES), never a symlink,
// quiet for over 24 h, and held by no live process. All I/O is async.
import { execFile } from 'node:child_process';
import { lstat, opendir, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { LivenessUnproved } from './target-sweep.ts';
import { DAY, DROP_GRACE, acquireSweepGate, missing, newestMtime, processCwdFields, treeBytes } from './sweep-shared.ts';

const exec = promisify(execFile);

/** The one list of tmp-root top-level names this harness owns and may sweep. */
export const TMP_PREFIXES = [
  'kit-prefix-',
  'kit-config-canonical-',
  'kit-publication-test-',
  'orch-',
  'terminal-backup-contract-',
  'terminal-restore-contract-',
  'vol-move-contract-',
  'away-check-',
  'hook-topology-probe-',
  'lint-commit-review-',
  'harness-bench-',
] as const;

type Item = { path: string; bytesBefore: number };
export type TmpSweepResult = {
  root: string;
  candidates: Item[];
  removed: string[];
  bytesBefore: number;
  skipped: { path: string; reason: string }[];
};

const ours = (name: string): boolean => (TMP_PREFIXES as readonly string[]).some((prefix) => name.startsWith(prefix));

async function processPaths(): Promise<string> {
  // One ps snapshot per pass, plus one more per entry at its deletion moment.
  const { stdout: argv } = await exec('ps', ['-axww', '-o', 'args='], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })
    .catch((error: { code: string | number }) => {
      // A missing liveness tool is not a missing candidate path.
      throw new LivenessUnproved(String(process.pid), 'ps', typeof error.code === 'number' ? `exit ${error.code}` : error.code);
    });
  // Test seam (r4): an injected unreadable pid — no real /proc needed — makes
  // the snapshot unproved exactly as a live EACCES would.
  const injected = process.env.ORCH_TEST_UNREADABLE_PID ?? '';
  if (injected) throw new LivenessUnproved(injected, 'readlink /proc/<pid>/cwd', 'EACCES');
  const cwd = await processCwdFields().catch((error: NodeJS.ErrnoException) => {
    throw new LivenessUnproved(String(process.pid), 'cwd snapshot', String(error.code ?? error.message));
  });
  return `${argv}\n${cwd}`;
}

async function inUse(snapshot: string, roots: string[]): Promise<boolean> {
  // ps does not preserve argv quoting. Conservative substring matching also keeps
  // ambiguous commands, rather than guessing token boundaries and deleting a live directory.
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (snapshot.includes(resolved) || snapshot.includes(await realpath(resolved))) return true;
  }
  return false;
}

/** daily=true is the daemon gate; a manual run bypasses it. Dry-run writes nothing.
 * A timestamp is published BEFORE work: a crash must not trigger another pass on
 * restart. The exclusive lease also serializes a manual run with the daemon. A
 * crashed lease blocks its own day; see acquireSweepGate for the atomic lease.
 */
export async function sweepTmp(options: {
  root?: string; stateDir: string; daily?: boolean; dryRun?: boolean;
  /** Fresh store-backed set of non-closed seats; absent or throwing keeps every spill. */
  openSeatIds?: () => ReadonlySet<string>;
}): Promise<TmpSweepResult | null> {
  const { root, stateDir, daily = false, dryRun = false, openSeatIds } = options;
  const now = Date.now();
  const gate = await acquireSweepGate({ stateDir, base: 'tmp-sweep', daily, dryRun });
  if (!gate) return null;
  const tmpRoot = path.resolve(root ?? tmpdir());
  const result: TmpSweepResult = { root: tmpRoot, candidates: [], removed: [], bytesBefore: 0, skipped: [] };
  // A rename interrupted by a crash or a reboot: stamped, and past every guard
  // except a process that entered since. Leftovers go before fresh candidates.
  const leftovers: string[] = [];
  const candidates: string[] = [];
  const retention = (entry: string): { quietFor: number; reason?: string } => {
    const name = path.basename(entry).split('.dropping-')[0];
    if (!name.startsWith('orch-seat-spill-')) return { quietFor: DAY };
    try {
      if (!openSeatIds) throw new Error('seat set unavailable');
      const seats = openSeatIds();
      const owner = /^orch-seat-spill-(.+)-[A-Za-z0-9]{6}$/.exec(name)?.[1];
      if (owner && seats.has(owner)) return { quietFor: DAY, reason: 'spill belongs to a non-closed seat' };
      return { quietFor: owner ? DAY : 7 * DAY };
    } catch (error) {
      return { quietFor: DAY, reason: `spill seat inspection failed: ${(error as Error).message}` };
    }
  };
  try {
    await gate.publish();
    try {
      const entries = await opendir(tmpRoot);
      for await (const entry of entries) {
        const dropping = entry.name.indexOf('.dropping-');
        const file = path.join(tmpRoot, entry.name);
        if (dropping > 0 && ours(entry.name.slice(0, dropping))) {
          const stamped = Number(entry.name.slice(dropping + '.dropping-'.length));
          const stat = await lstat(file).catch(() => null);
          const age = Number.isFinite(stamped) && stamped >= 0 ? now - stamped : stat ? now - stat.mtimeMs : DROP_GRACE;
          if (age >= DROP_GRACE) leftovers.push(file);
          else result.skipped.push({ path: file, reason: 'drop already in progress' });
        } else if (ours(entry.name)) candidates.push(file);
      }
    } catch (error) { if (!missing(error)) throw error; return result; }
    // If ps/cwd collection fails, the entire run keeps its entries (no partial snapshot).
    const snapshot = await processPaths();
    const pending: { path: string; bytesBefore: number }[] = [];
    for (const entry of [...leftovers, ...candidates]) {
      const isLeftover = leftovers.includes(entry);
      try {
        const stat = await lstat(entry);
        if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) {
          result.skipped.push({ path: entry, reason: 'not a plain file or directory' });
          continue;
        }
        const guard = retention(entry);
        if (guard.reason) {
          result.skipped.push({ path: entry, reason: guard.reason });
          continue;
        }
        // Inspect the whole tree. Legacy spills retain their seven-day guard
        // even after an interrupted rename by an older sweeper.
        if ((!isLeftover || guard.quietFor > DAY) && await newestMtime(entry, stat) >= now - guard.quietFor) {
          result.skipped.push({ path: entry, reason: guard.quietFor > DAY ? 'legacy spill modified within 7 days' : 'modified within 24h' });
          continue;
        }
        if (await inUse(snapshot, [entry])) {
          result.skipped.push({ path: entry, reason: 'in use by a live process' });
          continue;
        }
        const bytesBefore = stat.isDirectory() ? await treeBytes(entry) : stat.size;
        pending.push({ path: entry, bytesBefore });
      } catch (error) {
        if (!missing(error)) result.skipped.push({ path: entry, reason: (error as Error).message });
      }
    }
    // The pass snapshot is stale after the byte walks and after every removal:
    // each entry is checked against a sample taken at its own deletion moment
    // (task 2861 review), and its shape and age re-checked after the inspection
    // delay. A snapshot that cannot be taken keeps every remaining entry.
    for (const item of pending) {
      const fresh = await processPaths();
      try {
        const stat = await lstat(item.path);
        const isLeftover = leftovers.includes(item.path);
        if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) {
          result.skipped.push({ path: item.path, reason: 'modified during inspection' });
          continue;
        }
        const guard = retention(item.path);
        if (guard.reason) {
          result.skipped.push({ path: item.path, reason: guard.reason });
          continue;
        }
        if ((!isLeftover || guard.quietFor > DAY) && await newestMtime(item.path, stat) >= Date.now() - guard.quietFor) {
          result.skipped.push({ path: item.path, reason: 'modified during inspection' });
          continue;
        }
        if (await inUse(fresh, [item.path])) {
          result.skipped.push({ path: item.path, reason: 'process entered during inspection' });
          continue;
        }
        result.candidates.push(item);
        result.bytesBefore += item.bytesBefore;
        if (!dryRun) {
          // Atomic visibility switch: from here on the name itself says "dropping".
          const dropping = `${item.path}.dropping-${Date.now()}`;
          await rename(item.path, dropping);
          await rm(dropping, { recursive: true, force: true });
          result.removed.push(item.path);
        }
      } catch (error) {
        if (!missing(error) || result.candidates.some((candidate) => candidate.path === item.path)) {
          result.skipped.push({ path: item.path, reason: (error as Error).message });
        }
      }
    }
  } catch (error) {
    result.skipped.push({ path: tmpRoot, reason: `inspection failed: ${(error as Error).message}` });
  } finally { await gate.release(); }
  return result;
}
