// Compose guarded cleanup policies; host tmp cleanup has its own explicit scope.
import { existsSync } from 'node:fs';
import { lstat, opendir, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectConfig } from '../../../scripts/lib/harness-config.mjs';
import { loadConfig, readHosts } from './config.ts';
import { collect } from './shared.entry.ts';
import { spawnProvider } from './providers/spawn.ts';
import { repoOf, noteCodegraphDaemonStop, sweepHostLeadTargets, sweepHostTmp, type HostCleanupResult } from './worktrees.ts';
import { openStore, acquireSweepGate, DAY, DROP_GRACE, directoryBelow, newestMtime, treeBytes, type Store, type SweepGate } from './store.ts';
import { sweepTargets } from './target-sweep.ts';
import { clearCaches, ownedWorktree } from './prune.ts';
import { sweepConfiguredHostWorktrees } from './host-worktree-sweep.ts';
import { sweepTmp } from './tmp-sweep.ts';
import { sweepStoreBackups } from './backup-sweep.ts';

type Skip = { reason: string };
type Item = { path: string; bytesBefore: number };
type Sweep = { candidates: Item[]; removed: string[]; skipped: Skip[] };
type LargeTarget = { path: string; bytes: number; newestWriteAgeMs: number };
type LocalSnapshot = { name: string; deleteCommand: string };
type DiskReport = { largeTargets: LargeTarget[]; localSnapshots: LocalSnapshot[] };
export type DiskReportOptions = { largeTargetBytes?: number };
type Result = { removedCount: number | null; removedBytes: number | null; skipped: Skip[]; details?: unknown; error?: string; report?: DiskReport };
type Machine = { name: string; repo: string; host?: string; before?: number; results: Record<string, Result>; report?: DiskReport };
type Context = { checkout: string; stateDir: string; store: Store; largeTargetBytes: number };
type Step = { name: string; remote?: boolean; run: (context: Context, machine: Machine) => Promise<Result> };
type StepGroup = { base: string; steps: Step[] };
const line = (row: unknown): void => { process.stdout.write(`${JSON.stringify(row)}\n`); };
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ');

function swept(result: Sweep | null): Result {
  if (!result) return { removedCount: 0, removedBytes: null, skipped: [{ reason: 'sweep already running' }] };
  const removed = new Set(result.removed);
  const measured = result.candidates.filter(item => removed.has(item.path));
  return { removedCount: removed.size,
    removedBytes: measured.length === removed.size ? measured.reduce((sum, item) => sum + item.bytesBefore, 0) : null,
    skipped: result.skipped, details: result };
}

async function caches({ stateDir, store }: Context): Promise<Result> {
  const result: Result = { removedCount: 0, removedBytes: 0, skipped: [], details: [] };
  const details: unknown[] = [];
  result.details = details;
  for (const seat of store.listSeats('closed')) {
    const worktree = ownedWorktree(stateDir, seat);
    if (!worktree) continue;
    try {
      const cleanup = await clearCaches(worktree);
      if (result.removedCount !== null) result.removedCount += cleanup.removed.length;
      if (result.removedBytes !== null) result.removedBytes += cleanup.bytes;
      result.skipped.push(...cleanup.skipped);
      details.push({ seat: seat.id, worktree, ...cleanup });
      if (cleanup.codegraphDaemon) noteCodegraphDaemonStop(cleanup.codegraphDaemon, seat.id, worktree, store);
    } catch (error) {
      result.removedCount = null;
      result.removedBytes = null; // clearCaches may have completed earlier removals before throwing.
      result.error = 'one or more cache cleanups failed';
      const reason = message(error);
      result.skipped.push({ reason });
      details.push({ seat: seat.id, worktree, error: reason });
    }
  }
  return result;
}

async function hostWorktrees({ stateDir, store }: Context, machine: Machine): Promise<Result> {
  const events = await sweepConfiguredHostWorktrees({ stateDir, host: machine.host, seats: () => store.listSeats() });
  if (!events) return { removedCount: 0, removedBytes: null, skipped: [{ reason: 'host worktree sweep already running' }] };
  const failed = events.some(event => event.action === 'error');
  return { removedCount: failed ? null : events.filter(event => event.action === 'removed').length, removedBytes: null,
    skipped: events.filter(event => event.action === 'skip'), details: events,
    ...(failed ? { error: 'host worktree cleanup failed' } : {}) };
}

const exec = promisify(execFile);

/** Parse only complete Time Machine snapshot identifiers, never shell fragments. */
export function parseLocalSnapshots(output: string): LocalSnapshot[] {
  const snapshots: LocalSnapshot[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^com\.apple\.TimeMachine\.(\d{4}-\d{2}-\d{2}-\d{6})(?:\.local)?$/.exec(line.trim());
    if (match) snapshots.push({ name: line.trim(), deleteCommand: `tmutil deletelocalsnapshots ${match[1]}` });
  }
  return snapshots;
}

async function snapshotReport(skipped: Skip[]): Promise<LocalSnapshot[]> {
  if (process.platform !== 'darwin') return [];
  try {
    const { stdout } = await exec('tmutil', ['listlocalsnapshots', '/'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return parseLocalSnapshots(stdout);
  } catch (error) {
    skipped.push({ reason: `tmutil listlocalsnapshots /: ${message(error)}` });
    return [];
  }
}

function reportSkip(skipped: Skip[], target: string, error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') skipped.push({ reason: `${target}: ${message(error)}` });
}

async function inspectLeadTargets(context: Context, name: string, report: DiskReport, skipped: Skip[]): Promise<void> {
  for (const suffix of projectConfig().targetDirs) {
    const relative = `.claude/worktrees/${name}/${suffix}`;
    try {
      const target = await directoryBelow(context.checkout, relative);
      const bytes = await treeBytes(target);
      if (bytes <= context.largeTargetBytes) continue;
      await directoryBelow(context.checkout, relative);
      const newest = await newestMtime(target, await lstat(target));
      report.largeTargets.push({ path: target, bytes, newestWriteAgeMs: Math.max(0, Date.now() - newest) });
    } catch (error) { reportSkip(skipped, relative, error); }
  }
}

async function largeTargetReport(context: Context, report: DiskReport, skipped: Skip[]): Promise<void> {
  try {
    const root = await directoryBelow(context.checkout, '.claude/worktrees');
    for await (const entry of await opendir(root)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      await inspectLeadTargets(context, entry.name, report, skipped);
    }
  } catch (error) { reportSkip(skipped, '.claude/worktrees', error); }
}

async function reportOnly(context: Context): Promise<Result> {
  const skipped: Skip[] = [];
  const report: DiskReport = { largeTargets: [], localSnapshots: [] };
  await largeTargetReport(context, report, skipped);
  report.localSnapshots = await snapshotReport(skipped);
  return { removedCount: 0, removedBytes: 0, skipped, report };
}

function reportThreshold(options: DiskReportOptions): number {
  const bytes = options.largeTargetBytes ?? 50_000_000_000;
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('largeTargetBytes must be a finite non-negative number');
  return bytes;
}

// Add subsequent slices here: execution, step rows and summary accounting share this list.
const STEPS: (Step | StepGroup)[] = [
  { name: 'prune --targets', run: async ({ checkout, stateDir }) => swept(await sweepTargets({ checkout, stateDir })) },
  { name: 'prune --caches', run: caches },
  { name: 'sweep-host-worktrees', remote: true, run: hostWorktrees },
  { base: 'host-tmp-sweep', steps: [
    { name: 'host-lead-check-targets', remote: true, run: async (_context, machine) => hostResult(await sweepHostLeadTargets(machine.host!, DAY)) },
    { name: 'host-tmp-sweep', remote: true, run: async (_context, machine) => hostResult(await sweepHostTmp(machine.host!, { window: DAY, dropGrace: DROP_GRACE })) },
  ] },
  { name: 'tmp-sweep', run: async ({ stateDir, store }) => swept(await sweepTmp({ stateDir,
    openSeatIds: () => new Set(store.listSeats({ notStatus: 'closed' }).map(seat => seat.id)) })) },
  { name: 'backup-sweep', run: async ({ stateDir, store }) => swept(await sweepStoreBackups(store, { stateDir })) },
  { name: 'disk-report', run: reportOnly },
];

function hostResult(result: HostCleanupResult): Result {
  return { removedCount: result.errors.length ? null : result.removed.length, removedBytes: result.bytesBefore, skipped: result.skipped, details: result,
    ...(result.errors.length ? { error: result.errors.join('; ') } : {}) };
}

async function runGroup(group: StepGroup, context: Context, machines: Machine[]): Promise<boolean> {
  let gate: SweepGate | null;
  try { gate = await acquireSweepGate({ stateDir: context.stateDir, base: group.base, daily: false }); }
  catch (error) {
    return runSteps(group.steps.map(step => ({ ...step, run: async () => { throw error; } })), context, machines);
  }
  try {
    const steps = gate ? group.steps : group.steps.map(step => ({ ...step, run: async (): Promise<Result> => ({
      removedCount: 0, removedBytes: null, skipped: [{ reason: 'host tmp sweep already running' }],
    }) }));
    return await runSteps(steps, context, machines);
  } finally { await gate?.release(); }
}

async function runSteps(steps: (Step | StepGroup)[], context: Context, machines: Machine[]): Promise<boolean> {
  let failed = false;
  for (const step of steps) {
    const error = 'steps' in step ? await runGroup(step, context, machines) : await runStep(step, context, machines);
    if (error) failed = true;
  }
  return failed;
}

async function freeBytes(machine: Machine): Promise<number> {
  let bytes: number;
  if (!machine.host) {
    const stats = await statfs(machine.repo);
    bytes = stats.bavail * stats.bsize;
  } else {
    // spawnProvider uses the registered Node and remote-exec (jobwrap on win32).
    const script = "const s=require('node:fs').statfsSync(process.cwd()); console.log(s.bavail*s.bsize)";
    const child = spawnProvider({ host: machine.host, cwd: machine.repo, command: 'node', args: ['-e', script] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      const output = (await collect(child, undefined, 'disk free-space probe', true)).toString('utf8').trim();
      if (!/^\d+$/.test(output)) throw new Error('invalid free-space output');
      bytes = Number(output);
    } finally { clearTimeout(timer); }
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid free-space reading');
  return bytes;
}

function selectedMachines(host: string | undefined, stateDir: string, checkout: string): Machine[] {
  const hosts = readHosts(stateDir);
  if (host !== undefined && host !== 'mac' && !Object.hasOwn(hosts, host)) throw new Error(`unknown host '${host}'`);
  const machines: Machine[] = [];
  if (host === undefined || host === 'mac') machines.push({ name: 'mac', repo: checkout, results: {} });
  for (const [name, remote] of Object.entries(hosts)) {
    if (host === undefined || host === name) machines.push({ name, host: name, repo: remote.repo, results: {} });
  }
  return machines;
}

async function before(machines: Machine[]): Promise<boolean> {
  let failed = false;
  for (const machine of machines) {
    try { machine.before = await freeBytes(machine); }
    catch (error) {
      failed = true;
      line({ event: 'disk-cleanup.error', machine: machine.name, error: message(error) });
    }
  }
  return failed;
}

async function runStep(step: Step, context: Context, machines: Machine[]): Promise<boolean> {
  let failed = false;
  const rows: { machine: string; result: Result }[] = [];
  for (const machine of machines) {
    if (machine.before === undefined || Boolean(machine.host) !== Boolean(step.remote)) continue;
    let result: Result;
    try { result = await step.run(context, machine); }
    catch (error) { result = { removedCount: null, removedBytes: null, skipped: [], error: message(error) }; }
    if (result.error) failed = true;
    if (result.report) machine.report = result.report;
    machine.results[step.name] = result;
    rows.push({ machine: machine.name, result });
  }
  line({ event: 'disk-cleanup.step', step: step.name, machines: rows });
  return failed;
}

function skipCounts(results: Record<string, Result>): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const result of Object.values(results)) {
    for (const skip of result.skipped) counts[skip.reason] = (counts[skip.reason] ?? 0) + 1;
  }
  return counts;
}

async function summaries(machines: Machine[]): Promise<boolean> {
  let failed = false;
  for (const machine of machines) {
    if (machine.before === undefined) continue;
    let after: number | null = null;
    let error: string | undefined;
    try { after = await freeBytes(machine); }
    catch (cause) { failed = true; error = message(cause); }
    line({ event: 'disk-cleanup.summary', machine: machine.name, freeBefore: machine.before, freeAfter: after,
      freeDelta: after === null ? null : after - machine.before,
      removedCount: Object.fromEntries(Object.entries(machine.results).map(([name, result]) => [name, result.removedCount])),
      removedBytes: Object.fromEntries(Object.entries(machine.results).map(([name, result]) => [name, result.removedBytes])),
      skipsByReason: skipCounts(machine.results), ...machine.report, ...(error ? { error } : {}) });
  }
  return failed;
}

function hostArgument(argv: string[]): string | undefined {
  if (!argv.length) return undefined;
  if (argv.length !== 2 || argv[0] !== '--host' || !argv[1] || argv[1].startsWith('--')) {
    throw new Error('usage: disk-cleanup [--host <name>]');
  }
  return argv[1];
}

/** CLI boundary; checkoutDir may be a linked checkout, never the sweep root itself. */
export async function diskCleanup(argv: string[], checkoutDir: string, reportOptions: DiskReportOptions = {}): Promise<number> {
  try {
    const largeTargetBytes = reportThreshold(reportOptions);
    const host = hostArgument(argv);
    const config = loadConfig();
    const checkout = (await repoOf(checkoutDir)).main;
    const machines = selectedMachines(host, config.stateDir, checkout);
    if (!existsSync(config.dbFile)) throw new Error(`orch store does not exist: ${config.dbFile}`);
    const store = openStore(config.dbFile);
    try {
      let failed = await before(machines);
      const context = { checkout, stateDir: config.stateDir, store, largeTargetBytes };
      if (await runSteps(STEPS, context, machines)) failed = true;
      if (await summaries(machines)) failed = true;
      return failed ? 1 : 0;
    } finally { store.close(); }
  } catch (error) {
    process.stderr.write(`disk-cleanup: ${message(error)}\n`);
    return 1;
  }
}
