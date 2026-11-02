// Task 3459 C18: the storage view BooHarness shows — usage per category and
// machine, an exact preview of what a clean would remove, and a clean that
// revalidates that set and reports concurrent deviations through the EXISTING sweeps. This module owns no
// deletion logic of its own: every removal goes through the sweep functions
// (tmp-sweep, target-sweep, backup-sweep, worktree-sweep, host-worktree-sweep,
// prune's clearCaches) whose guards — unlanded edits, open seats, liveness,
// leases — stay the deletion authority. Categories no sweep owns (seat
// worktrees, mirrors, logs, captures, Pi sessions, package caches) are
// report-only and never cleanable here.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lstat, opendir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson } from './http-leads.ts';
import { readHosts } from './config.ts';
import { directoryBelow, treeBytes, type Store } from './store.ts';
import { CACHE_DIRS, clearCaches, ownedWorktree } from './prune.ts';
import { sweepTargets } from './target-sweep.ts';
import { sweepWorktrees } from './worktree-sweep.ts';
import { sweepConfiguredHostWorktrees } from './host-worktree-sweep.ts';
import { sweepTmp, TMP_PREFIXES } from './tmp-sweep.ts';
import { sweepStoreBackups } from './backup-sweep.ts';
import { noteCodegraphDaemonStop, repoOf } from './worktrees.ts';
import { projectConfig } from '../../../scripts/lib/harness-config.mjs';

const exec = promisify(execFile);
const GIT_TIMEOUT = 20_000;
/** A preview a clean may execute: older than this, the operator looks again. */
export const PREVIEW_TTL_MS = 10 * 60_000;
const CHECKOUT = fileURLToPath(new URL('../../../', import.meta.url));

/** The one per-machine scope the engine reads; every path is explicit so tests and the route agree. */
export type StorageScope = {
  stateDir: string; store: Store; checkout: string;
  tmpRoot?: string; stateRoot?: string; home?: string;
};

export type StorageCategoryRow = {
  id: string; bytes: number | null; items: number; sweep: string; cleanable: boolean;
  detail?: Record<string, unknown>; note?: string; error?: string;
};
export type StorageMachineRow = { name: string; host: boolean; repo: string; categories: StorageCategoryRow[] };
export type StorageOverview = { generatedAt: number; machines: StorageMachineRow[] };
export type PreviewItem = { path: string; bytes: number | null };
export type PreviewRow = {
  id: string; host: string; categories: string[]; items: PreviewItem[];
  kept: { path: string; reason: string }[]; code: string; at: number;
};
export type CleanCategoryRow = {
  id: string; removed: string[]; bytesBefore: number | null;
  kept: { path: string; reason: string }[]; error?: string;
};
export type CleanRow = {
  previewId: string; results: CleanCategoryRow[];
  previewedButKept: { path: string; reason: string }[];
  removedOutsidePreview: string[];
};

/** Categories a clean may run, and the sweep each goes through. */
const CLEANABLE: Record<string, string> = {
  'worktree-backups': 'backup-sweep',
  tmp: 'tmp-sweep',
  'lead-worktrees': 'worktree-sweep',
  'cargo-targets': 'target-sweep',
  'seat-caches': 'prune --caches',
  'host-worktrees': 'host-worktree-sweep',
};
/** Report-only owners: measured, shown, never removed by this surface. */
const REPORT_OWNERS: Record<string, string> = {
  'seat-worktrees': 'prune (operator approval)',
  mirrors: 'prune mirror (operator approval)',
  codegraph: 'cleared by the worktree/cache sweeps inside their own pass',
  captures: "none (report-only; a capture may be an open review's proof)",
  'package-caches': 'none (report-only; no sweep owns pnpm/npm caches)',
  'orch-logs': 'log rotation (createLogger)',
  'pi-sessions': 'none (report-only)',
};
const CATEGORY_IDS = [...Object.keys(CLEANABLE), ...Object.keys(REPORT_OWNERS)];

const openSeatIds = (store: Store): () => Set<string> =>
  () => new Set(store.listSeats({ notStatus: 'closed' }).map(seat => seat.id));

// ---- measurement helpers (report rows only; removals always go through sweeps) ----

type Measured = { bytes: number; items: number; note?: string; error?: string };
const failed = (message: string): Measured => ({ bytes: 0, items: 0, error: message });

async function measureRoot(root: string): Promise<Measured> {
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { bytes: 0, items: 0, note: 'not a plain directory' };
    return { bytes: await treeBytes(root), items: 1 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, items: 0, note: 'root absent' };
    return failed((error as Error).message);
  }
}

/** Sum one level of `root`, keeping only entries `keep` names — the sweeps' own root layouts. */
async function measureEntries(root: string, keep?: (name: string) => boolean): Promise<Measured> {
  let entries;
  try { entries = await opendir(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, items: 0, note: 'root absent' };
    return failed((error as Error).message);
  }
  let bytes = 0, items = 0;
  try {
    for await (const entry of entries) {
      if (keep && !keep(entry.name)) continue;
      const file = path.join(root, entry.name);
      const stat = await lstat(file).catch(() => null);
      if (!stat) continue;
      bytes += stat.isDirectory() && !stat.isSymbolicLink() ? await treeBytes(file).catch(() => stat.size) : stat.size;
      items += 1;
    }
  } catch (error) { return failed((error as Error).message); }
  return { bytes, items };
}

function row(id: string, sweep: string, cleanable: boolean, measured: Measured, detail?: Record<string, unknown>): StorageCategoryRow {
  const base = { id, sweep, cleanable };
  if (measured.error) return { ...base, bytes: 0, items: 0, error: measured.error };
  return { ...base, bytes: measured.bytes, items: measured.items, ...(measured.note ? { note: measured.note } : {}), ...(detail ?? {}) };
}

/** Landed means what worktree-sweep's containment rule says: HEAD is an ancestor of master. */
async function landed(dir: string): Promise<boolean | null> {
  try { await exec('git', ['-C', dir, 'merge-base', '--is-ancestor', 'HEAD', 'master'], { timeout: GIT_TIMEOUT }); return true; }
  catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    return null;
  }
}

type Tally = { items: number; bytes: number };
const tally = (): Tally => ({ items: 0, bytes: 0 });

/** Seat worktrees under stateDir/worktrees: open/closed/unregistered, and landed/unlanded among closed. */
type SeatBuckets = { open: Tally; closed: Tally; unregistered: Tally; landed: Tally; unlanded: Tally; unproven: Tally };

async function classifySeatEntry(file: string, seat: { id: string; status: string } | undefined, buckets: SeatBuckets): Promise<void> {
  const bytes = await treeBytes(file).catch(() => 0);
  const bucket = !seat ? buckets.unregistered : seat.status === 'closed' ? buckets.closed : buckets.open;
  bucket.items += 1;
  bucket.bytes += bytes;
  if (seat?.status !== 'closed') return;
  const isLanded = await landed(file);
  const landedBucket = isLanded === false ? buckets.unlanded : isLanded === true ? buckets.landed : buckets.unproven;
  landedBucket.items += 1;
  landedBucket.bytes += bytes;
}

async function seatWorktrees(stateDir: string, store: Store): Promise<StorageCategoryRow> {
  const root = path.join(stateDir, 'worktrees');
  const byName = new Map(store.listSeats().map(seat => [seat.id, seat]));
  const buckets: SeatBuckets = { open: tally(), closed: tally(), unregistered: tally(), landed: tally(), unlanded: tally(), unproven: tally() };
  let entries;
  try { entries = await opendir(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return row('seat-worktrees', REPORT_OWNERS['seat-worktrees']!, false, { bytes: 0, items: 0, note: 'root absent' });
    return row('seat-worktrees', REPORT_OWNERS['seat-worktrees']!, false, { bytes: 0, items: 0, error: (error as Error).message });
  }
  let error: string | undefined;
  try {
    for await (const entry of entries) {
      const file = path.join(root, entry.name);
      const stat = await lstat(file).catch(() => null);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
      await classifySeatEntry(file, byName.get(entry.name), buckets);
    }
  } catch (err) { error = (err as Error).message; }
  return {
    id: 'seat-worktrees', sweep: REPORT_OWNERS['seat-worktrees']!, cleanable: false,
    bytes: buckets.open.bytes + buckets.closed.bytes + buckets.unregistered.bytes,
    items: buckets.open.items + buckets.closed.items + buckets.unregistered.items,
    detail: { open: buckets.open, closed: buckets.closed, unregistered: buckets.unregistered,
      closedLanded: buckets.landed, closedUnlanded: buckets.unlanded, closedLandedUnproven: buckets.unproven },
    ...(error ? { error } : {}),
  };
}

/** The cargo targets the target sweep knows: lead worktrees' target dirs and the state-root patterns. */
async function leadTargetsMeasured(leadRoot: string, targets: readonly string[]): Promise<Measured> {
  let bytes = 0, items = 0, error: string | undefined;
  let entries = null;
  try { entries = await opendir(leadRoot); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') error = (err as Error).message; }
  if (entries) {
    try {
      for await (const entry of entries) {
        for (const suffix of targets) {
          const measured = await measureRoot(path.join(leadRoot, entry.name, suffix));
          if (measured.error) { error ??= measured.error; continue; }
          if (!measured.note) { bytes += measured.bytes; items += measured.items; }
        }
      }
    } catch (err) { error ??= (err as Error).message; }
  }
  return error ? failed(error) : { bytes, items };
}

async function stateTargetsMeasured(stateRoot: string, patterns: readonly string[]): Promise<Measured> {
  let bytes = 0, items = 0, error: string | undefined;
  for (const pattern of patterns) {
    const starred = pattern.endsWith('*');
    const literal = path.posix.basename(starred ? pattern.slice(0, -1) : pattern);
    const parentRelative = path.posix.dirname(starred ? pattern.slice(0, -1) : pattern);
    const parent = parentRelative === '.' ? stateRoot : path.join(stateRoot, parentRelative);
    const measured = await measureEntries(parent, starred ? (name: string) => name.startsWith(literal) : (name: string) => name === literal);
    if (measured.error) { error ??= measured.error; continue; }
    bytes += measured.bytes; items += measured.items;
  }
  return error ? failed(error) : { bytes, items };
}

async function cargoTargetsMeasured(checkout: string, stateRoot: string): Promise<Measured> {
  const lead = await leadTargetsMeasured(path.join(checkout, '.claude', 'worktrees'), projectConfig().targetDirs);
  const state = await stateTargetsMeasured(stateRoot, projectConfig().stateTargetDirs);
  const error = lead.error ?? state.error;
  return error ? failed(error) : { bytes: lead.bytes + state.bytes, items: lead.items + state.items };
}

/** The two measured halves of a two-root report row, or zero when a half failed (its error becomes the row's). */
function combined(one: Measured, other: Measured): { bytes: number; items: number; error?: string } {
  return { bytes: (one.error ? 0 : one.bytes) + (other.error ? 0 : other.bytes),
    items: (one.error ? 0 : one.items) + (other.error ? 0 : other.items),
    ...(one.error ? { error: one.error } : other.error ? { error: other.error } : {}) };
}

async function codegraphRow(worktreesRoot: string, leadRoot: string): Promise<StorageCategoryRow> {
  return { id: 'codegraph', sweep: REPORT_OWNERS.codegraph!, cleanable: false,
    ...combined(await measureEntries(worktreesRoot, (name) => name === '.codegraph'), await measureEntries(leadRoot, (name) => name === '.codegraph')),
    note: 'these directories are also counted inside the worktrees; do not sum with them' };
}

async function packageCachesRow(home: string): Promise<StorageCategoryRow> {
  const npmRoot = path.join(home, '.npm', '_cacache'), pnpmRoot = path.join(home, '.local', 'share', 'pnpm', 'store');
  const npm = await measureRoot(npmRoot), pnpm = await measureRoot(pnpmRoot);
  return { id: 'package-caches', sweep: REPORT_OWNERS['package-caches']!, cleanable: false,
    bytes: (npm.error ? 0 : npm.bytes) + (pnpm.error ? 0 : pnpm.bytes),
    items: (npm.error || npm.note ? 0 : 1) + (pnpm.error || pnpm.note ? 0 : 1),
    detail: { roots: [npmRoot, pnpmRoot] },
    ...(npm.error ? { error: npm.error } : pnpm.error ? { error: pnpm.error } : {}) };
}

/** Resolve exact configured cache paths without following any parent symlink. */
async function measureSeatCaches(worktree: string): Promise<Measured> {
  let bytes = 0, items = 0;
  for (const relative of CACHE_DIRS) {
    try {
      const target = await directoryBelow(worktree, relative);
      const one = await measureRoot(target);
      if (one.error) return one;
      bytes += one.bytes; items += one.items;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return failed((error as Error).message);
    }
  }
  return { bytes, items };
}

async function seatCachesRow(stateDir: string, store: Store): Promise<StorageCategoryRow> {
  let bytes = 0, items = 0, error: string | undefined;
  for (const seat of store.listSeats('closed')) {
    const worktree = ownedWorktree(stateDir, seat);
    if (!worktree) continue;
    const one = await measureSeatCaches(worktree);
    if (one.error) { error ??= one.error; continue; }
    bytes += one.bytes; items += one.items;
  }
  return { id: 'seat-caches', sweep: CLEANABLE['seat-caches']!, cleanable: true, bytes, items, detail: { seats: 'closed only' }, ...(error ? { error } : {}) };
}

async function macCategories(scope: StorageScope): Promise<StorageCategoryRow[]> {
  const { stateDir, store, checkout } = scope;
  const home = scope.home ?? homedir();
  const stateRoot = scope.stateRoot ?? path.join(home, '.local', 'state');
  const worktreesRoot = path.join(stateDir, 'worktrees');
  const leadRoot = path.join(checkout, '.claude', 'worktrees');
  return [
    await seatWorktrees(stateDir, store),
    row('mirrors', REPORT_OWNERS.mirrors!, false, await measureRoot(path.join(stateDir, 'mirrors'))),
    row('worktree-backups', CLEANABLE['worktree-backups']!, true, await measureEntries(path.join(stateDir, 'worktree-backups'))),
    row('tmp', CLEANABLE.tmp!, true,
      await measureEntries(scope.tmpRoot ?? tmpdir(), (name) => (TMP_PREFIXES as readonly string[]).some(prefix => name.startsWith(prefix))),
      { retention: 'quiet for 24h; spills of non-closed seats always stay' }),
    row('lead-worktrees', CLEANABLE['lead-worktrees']!, true, await measureEntries(leadRoot), { location: leadRoot }),
    row('cargo-targets', CLEANABLE['cargo-targets']!, true, await cargoTargetsMeasured(checkout, stateRoot)),
    await seatCachesRow(stateDir, store),
    await codegraphRow(worktreesRoot, leadRoot),
    row('captures', REPORT_OWNERS.captures!, false, await measureEntries(worktreesRoot, (name) => name === 'Screenshots')),
    await packageCachesRow(home),
    row('orch-logs', REPORT_OWNERS['orch-logs']!, false, await measureEntries(stateDir, (name) => /^orch\.log(\.\d)?$/.test(name))),
    row('pi-sessions', REPORT_OWNERS['pi-sessions']!, false, await measureRoot(path.join(home, '.pi', 'agent', 'sessions'))),
  ];
}

/** One registry host: its worktree sweep in dry run reports candidates and skips; an unreachable host is reported, never guessed. */
async function hostCategory(scope: StorageScope, name: string): Promise<StorageCategoryRow> {
  const base = { id: 'host-worktrees', sweep: CLEANABLE['host-worktrees']!, cleanable: true } as const;
  try {
    const events = await sweepConfiguredHostWorktrees({ stateDir: scope.stateDir, host: name, dryRun: true, seats: () => scope.store.listSeats() });
    if (!events) return { ...base, bytes: null, items: 0, error: 'host worktree sweep already running' };
    const failed = events.find(event => event.action === 'error');
    return { ...base, bytes: null, items: events.filter(event => event.action === 'candidate').length,
      detail: { skips: events.filter(event => event.action === 'skip').length, note: 'the host sweep reports counts, not byte measurements' },
      ...(failed ? { error: failed.reason } : {}) };
  } catch (error) {
    return { ...base, bytes: null, items: 0, error: `host inspection failed: ${(error as Error).message}` };
  }
}

export async function storageOverview(scope: StorageScope): Promise<StorageOverview> {
  const machines: StorageMachineRow[] = [{ name: 'mac', host: false, repo: scope.checkout, categories: await macCategories(scope) }];
  for (const [name, remote] of Object.entries(readHosts(scope.stateDir))) {
    machines.push({ name, host: true, repo: remote.repo, categories: [await hostCategory(scope, name)] });
  }
  return { generatedAt: Date.now(), machines };
}

// ---- preview and clean ----

/** One sweep pass: candidates (dry) or the removals it actually made (real), plus everything it kept and why. */
type RunOutcome = {
  items: PreviewItem[];
  kept: { path: string; reason: string }[];
  removed: string[];
  bytesOf: Map<string, number>;
  note?: string;
};

const runNote = (note: string): RunOutcome => ({ items: [], kept: [], removed: [], bytesOf: new Map(), note });

/** Shape a {candidates, removed, skipped} sweep result for the preview/clean engine. */
function ofSweep(candidates: { path: string; bytesBefore: number }[], removed: string[], skipped: { path: string; reason: string }[]): RunOutcome {
  return { items: candidates.map(candidate => ({ path: candidate.path, bytes: candidate.bytesBefore })),
    removed, bytesOf: new Map(candidates.map(candidate => [candidate.path, candidate.bytesBefore])), kept: skipped };
}

async function runSeatCaches(scope: StorageScope, _host: string | undefined, dryRun: boolean): Promise<RunOutcome> {
  const outcome = runNote('');
  for (const seat of scope.store.listSeats('closed')) {
    try {
      const worktree = ownedWorktree(scope.stateDir, seat);
      if (!worktree) continue;
      const cleanup = await clearCaches(worktree, { dryRun });
      for (const entry of cleanup.removed) {
        const absolute = path.join(worktree, entry.path);
        outcome.items.push({ path: absolute, bytes: entry.bytes });
        outcome.bytesOf.set(absolute, entry.bytes);
        if (!dryRun) outcome.removed.push(absolute);
      }
      outcome.kept.push(...cleanup.skipped.map(skip => ({ path: path.join(worktree, skip.path), reason: skip.reason })));
      if (!dryRun && cleanup.codegraphDaemon) noteCodegraphDaemonStop(cleanup.codegraphDaemon, seat.id, worktree, scope.store);
    } catch (error) {
      outcome.kept.push({ path: seat.worktree ?? seat.id, reason: `seat ${seat.id}: cache cleanup failed: ${(error as Error).message}` });
      outcome.note = 'one or more seat cache cleanups failed';
    }
  }
  return outcome;
}

type CategoryRunner = (scope: StorageScope, host: string | undefined, dryRun: boolean) => Promise<RunOutcome>;

/** Each cleanable category through its owning sweep; dryRun reports exactly what a clean would target. */
const CATEGORY_RUNNERS: Record<string, CategoryRunner> = {
  tmp: async (scope, _host, dryRun) => {
    const result = await sweepTmp({ root: scope.tmpRoot ?? tmpdir(), stateDir: scope.stateDir, dryRun, openSeatIds: openSeatIds(scope.store) });
    return result ? ofSweep(result.candidates, result.removed, result.skipped) : runNote('tmp sweep already running');
  },
  'worktree-backups': async (scope, _host, dryRun) => {
    const result = await sweepStoreBackups(scope.store, { stateDir: scope.stateDir, dryRun });
    return result ? ofSweep(result.candidates, result.removed, result.skipped) : runNote('backup sweep already running');
  },
  'cargo-targets': async (scope, _host, dryRun) => {
    const result = await sweepTargets({ checkout: scope.checkout, stateDir: scope.stateDir, dryRun, stateRoot: scope.stateRoot });
    return result ? ofSweep(result.candidates, result.removed, result.skipped) : runNote('target sweep already running');
  },
  'lead-worktrees': async (scope, _host, dryRun) => {
    const result = await sweepWorktrees({ checkout: scope.checkout, stateDir: scope.stateDir, dryRun });
    if (!result) return runNote('worktree sweep already running');
    return { items: result.candidates.map(candidate => ({ path: candidate.path, bytes: candidate.bytesBefore })),
      removed: result.removed.map(entry => entry.path),
      bytesOf: new Map(result.removed.map(entry => [entry.path, entry.bytes])), kept: result.skipped };
  },
  'seat-caches': runSeatCaches,
  'host-worktrees': async (scope, host, dryRun) => {
    const events = await sweepConfiguredHostWorktrees({ stateDir: scope.stateDir, host, dryRun, seats: () => scope.store.listSeats() });
    if (!events) return runNote('host worktree sweep already running');
    return {
      items: events.filter(event => event.action === 'candidate').map(event => ({ path: event.dir, bytes: null })),
      removed: events.filter(event => event.action === 'removed').map(event => event.dir),
      bytesOf: new Map(),
      kept: events.filter(event => event.action === 'skip' || event.action === 'error')
        .map(event => ({ path: event.dir, reason: `${event.action}: ${event.reason}` })),
    };
  },
};

async function runCategory(id: string, scope: StorageScope, host: string | undefined, dryRun: boolean): Promise<RunOutcome> {
  const runner = CATEGORY_RUNNERS[id];
  if (!runner) throw new Error(`unknown storage category '${id}'`);
  return runner(scope, host, dryRun);
}

const fingerprint = (items: PreviewItem[]): string => createHash('sha256')
  .update(items.map(item => `${item.path}\u0000${item.bytes}`).sort().join('\n')).digest('hex');

function assertCategory(id: string, host: string): void {
  if (!CATEGORY_IDS.includes(id)) throw new Error(`unknown storage category '${id}'; known: ${CATEGORY_IDS.join(', ')}`);
  if (!(id in CLEANABLE)) throw new Error(`category '${id}' is report-only; cleanable: ${Object.keys(CLEANABLE).join(', ')}`);
  if (host !== 'mac' && id !== 'host-worktrees') throw new Error(`category '${id}' runs on the Mac, not on host '${host}'`);
}

function assertHost(host: string, stateDir: string): void {
  if (typeof host !== 'string' || !host || (host !== 'mac' && !Object.hasOwn(readHosts(stateDir), host))) throw new Error(`unknown host '${host}'`);
}

function validateRequest(host: string, categories: unknown, stateDir: string): string[] {
  assertHost(host, stateDir);
  if (!Array.isArray(categories) || !categories.length || categories.length > Object.keys(CLEANABLE).length) throw new Error('categories must be a non-empty array');
  const unique = [...new Set(categories as string[])];
  for (const id of unique) assertCategory(id, host);
  if (host === 'mac' && unique.includes('host-worktrees')) throw new Error("category 'host-worktrees' needs a registry host");
  return unique.sort();
}

const previews = new Map<string, PreviewRow>();

/** The exact list the sweeps would remove now, with the reasons for what they keep. */
export async function storagePreview(scope: StorageScope, input: { host: string; categories: string[] }): Promise<PreviewRow> {
  const categories = validateRequest(input.host, input.categories, scope.stateDir);
  const host = input.host === 'mac' ? undefined : input.host;
  const items: PreviewItem[] = [], kept: { path: string; reason: string }[] = [];
  for (const id of categories) {
    const outcome = await runCategory(id, scope, host, true);
    items.push(...outcome.items);
    kept.push(...outcome.kept);
  }
  const record: PreviewRow = { id: randomUUID(), host: input.host, categories, items, kept, code: fingerprint(items), at: Date.now() };
  for (const [id, old] of previews) if (Date.now() - old.at > 6 * PREVIEW_TTL_MS) previews.delete(id);
  while (previews.size >= 32) previews.delete(previews.keys().next().value as string);
  previews.set(record.id, record);
  return record;
}

export class StalePreviewError extends Error {}

function matchingPreview(input: { host: string; categories: string[]; previewId: string }, categories: string[]): PreviewRow {
  const record = previews.get(input.previewId);
  if (!record) throw new StalePreviewError(`unknown preview id '${input.previewId}'`);
  if (record.host !== input.host || record.categories.join(',') !== categories.join(',')) {
    throw new Error(`preview ${input.previewId} was made for host '${record.host}' [${record.categories.join(', ')}]`);
  }
  return record;
}

/** Anything changed since the preview: re-run it dry and compare the exact set. */
async function freshPreviewItems(scope: StorageScope, host: string | undefined, categories: string[]): Promise<PreviewItem[]> {
  const fresh: PreviewItem[] = [];
  for (const id of categories) fresh.push(...(await runCategory(id, scope, host, true)).items);
  return fresh;
}

function removedBytes(outcome: RunOutcome, previewBytes: Map<string, number | null>): number | null {
  if (!outcome.removed.length || outcome.note) return null;
  let bytes = 0;
  for (const removed of outcome.removed) {
    const size = outcome.bytesOf.get(removed) ?? previewBytes.get(removed);
    if (size == null) return null;
    bytes += size;
  }
  return bytes;
}

async function cleanCategories(scope: StorageScope, host: string | undefined, categories: string[], items: PreviewItem[]): Promise<{ results: CleanCategoryRow[]; removedPaths: Set<string> }> {
  const results: CleanCategoryRow[] = [];
  const removedPaths = new Set<string>();
  const previewBytes = new Map(items.map(item => [item.path, item.bytes]));
  for (const id of categories) {
    const outcome = await runCategory(id, scope, host, false);
    for (const removed of outcome.removed) removedPaths.add(removed);
    results.push({ id, removed: outcome.removed, bytesBefore: removedBytes(outcome, previewBytes), kept: outcome.kept,
      ...(outcome.note ? { error: outcome.note } : {}) });
  }
  return { results, removedPaths };
}

/** Require a recent, exact preview; sweeps remain the deletion authority. Report
 * any removal outside it (a concurrent change after the fresh dry run). */
export async function storageClean(scope: StorageScope, input: { host: string; categories: string[]; previewId: string }, now: number = Date.now()): Promise<CleanRow> {
  const categories = validateRequest(input.host, input.categories, scope.stateDir);
  const record = matchingPreview(input, categories);
  if (now - record.at > PREVIEW_TTL_MS) throw new StalePreviewError(`preview is older than ${PREVIEW_TTL_MS / 60000} minutes; make a new one`);
  const host = input.host === 'mac' ? undefined : input.host;
  if (fingerprint(await freshPreviewItems(scope, host, categories)) !== record.code) {
    throw new StalePreviewError('preview is stale: the removable set changed since the preview');
  }
  previews.delete(record.id);
  const { results, removedPaths } = await cleanCategories(scope, host, categories, record.items);
  const keptByPath = new Map(results.flatMap(result => result.kept).map(keep => [keep.path, keep.reason]));
  const previewedButKept = record.items
    .filter(item => !removedPaths.has(item.path))
    .map(item => ({ path: item.path, reason: keptByPath.get(item.path) ?? 'not removed' }));
  const previewedPaths = new Set(record.items.map(item => item.path));
  const removedOutsidePreview = [...removedPaths].filter(removed => !previewedPaths.has(removed));
  return { previewId: record.id, results, previewedButKept, removedOutsidePreview };
}

// ---- HTTP routes (mounted by one line in http.ts) ----

export type StorageRuntime = { store: Store; stateDir: string; port: () => number };
type Log = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;

const BODY_KEYS = { preview: ['host', 'categories'], clean: ['host', 'categories', 'previewId'] } as const;
type PostBody = { host: string; categories: string[]; previewId?: string };

/** A storage write needs the board's own origin and header, as the tasks routes ask for theirs. */
function storageOrigin(port: () => number, req: IncomingMessage): string | null {
  let own: string;
  try { own = new URL(`http://${new URL(`http://${req.headers.host ?? ''}`).hostname}:${port()}`).origin; }
  catch { return `host '${req.headers.host ?? ''}' is not a URL host`; }
  if (req.headers.origin !== own || req.headers['x-orch-storage'] !== '1') return 'a storage write requires the daemon origin and X-Orch-Storage: 1';
  return null;
}

function assertStorageKeys(kind: 'preview' | 'clean', input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (!(BODY_KEYS[kind] as readonly string[]).includes(key)) throw new Error(`storage ${kind} takes no '${key}'`);
  }
}

function storageFields(input: Record<string, unknown>): { host: string; categories: string[] } {
  if (typeof input.host !== 'string' || !Array.isArray(input.categories) || input.categories.some(id => typeof id !== 'string')) {
    throw new Error('host must be a string and categories an array of category ids');
  }
  return { host: input.host, categories: input.categories as string[] };
}

async function readStorageBody(kind: 'preview' | 'clean', req: IncomingMessage): Promise<PostBody> {
  const body = await readJson(req, 16 * 1024);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object');
  const input = body as Record<string, unknown>;
  assertStorageKeys(kind, input);
  const fields = storageFields(input);
  if (kind === 'preview') return fields;
  const previewId = input.previewId;
  if (typeof previewId !== 'string' || !previewId) throw new Error('previewId must be a non-empty string');
  return { ...fields, previewId };
}

async function serveStoragePost(kind: 'preview' | 'clean', rt: StorageRuntime, scope: StorageScope, log: Log | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const refused = storageOrigin(rt.port, req);
  if (refused) { sendJson(res, 403, { error: refused }); return; }
  const body = await readStorageBody(kind, req);
  if (kind === 'preview') {
    sendJson(res, 200, await storagePreview(scope, body));
    return;
  }
  try {
    sendJson(res, 200, await storageClean(scope, { host: body.host, categories: body.categories, previewId: body.previewId! }));
  } catch (error) {
    if (!(error instanceof StalePreviewError)) throw error;
    sendJson(res, 409, { error: (error as Error).message });
    return;
  }
  log?.('info', 'storage.clean', { host: body.host, categories: body.categories });
}

/** One mounted route family: GET usage, POST preview, POST clean. */
export function createStorageRoutes(rt: StorageRuntime, log?: Log): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  let main: Promise<string> | undefined;
  const scope = async (): Promise<StorageScope> => {
    main ??= repoOf(CHECKOUT).then(found => found.main);
    return { stateDir: rt.stateDir, store: rt.store, checkout: await main };
  };
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/storage')) return false;
    if (url.pathname === '/api/storage' && req.method === 'GET') {
      try { sendJson(res, 200, await storageOverview(await scope())); }
      catch (error) { sendJson(res, 500, { error: (error as Error).message }); }
      return true;
    }
    const kind = url.pathname === '/api/storage/preview' ? 'preview' : url.pathname === '/api/storage/clean' ? 'clean' : null;
    if (!kind || req.method !== 'POST') return false;
    try { await serveStoragePost(kind, rt, await scope(), log, req, res); }
    catch (error) { sendJson(res, 400, { error: (error as Error).message }); }
    return true;
  };
}
