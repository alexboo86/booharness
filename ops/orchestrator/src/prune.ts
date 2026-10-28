// Explicit CLI pruning removes a closed coder checkout; the daemon sweep removes
// one only when its whole change is on the lead HEAD (task 1522). A Git tree omits
// ignored files: audit them separately before even considering tracked changes.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync, realpathSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { lstat, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { landedForSweep } from './handoff-draft.ts';
import { assertMirrorPath, MIRROR_CHANGED, mirrorState, removeMirror } from './remote-worktree.ts';
import { collect } from './remote-repo.ts';
import { ROLE_POLICY, landable, remoteCheckoutGone } from './seats-defs.ts';
import { TERMINAL_TURN, type Seat, type Store, type Turn, type TurnPending } from './store.ts';
import { dropCheckoutTargets } from './target-sweep.ts';
import { deleteBranch, noteCodegraphDaemonStop, removeWorktree, stopCodegraphDaemon, worktreeListPorcelain, type CodegraphDaemonStop } from './worktrees.ts';
import { projectConfig } from '../../../scripts/lib/harness-config.mjs';

const project = projectConfig();

const exec = promisify(execFile);
// --stdin-paths unquotes a line that starts with ". Quote every path the way unquote_c_style reads it.
const quoteGitPath = (name: string): string => {
  let quoted = '"';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === '\\') quoted += `\\${ch}`;
    else if (ch === '\n') quoted += '\\n';
    else if (ch === '\r') quoted += '\\r';
    else if (ch === '\t') quoted += '\\t';
    else if (code < 0x20 || code === 0x7f) quoted += `\\${code.toString(8).padStart(3, '0')}`;
    else quoted += ch;
  }
  return `${quoted}"`;
};
const CODER_ID = new RegExp(`^(?:${Object.keys(ROLE_POLICY).filter((role) => landable(role)).join('|')})-(?:claude|glm|codex|grok|kimi|opencode|qwen|mimo)-[0-9a-f]{6}$`);
const DISPOSABLE = new Set(['node_modules', 'target', '.codegraph', '.turbo', '.cache', '.vite']);
// Explicit generated paths: "gen" is not a safe generic basename.
const GENERATED = project.generatedPaths;
const provisioningPath = (name: string): boolean => name === '.claude/scripts/memoryctl' ||
  name === 'docs/agent/domain-routing.generated.json' || name.startsWith('.claude/skills/');
export class LeadRepoMissingError extends Error {
  constructor(repo: string) { super(`lead repo missing: ${repo}`); }
}

const git = async (cwd: string, env: NodeJS.ProcessEnv | undefined, ...args: string[]): Promise<string> => {
  try {
    return (await exec('git', args, { cwd, env, timeout: args[0] === 'add' && args[1] === '-A' ? 120_000 : 15_000, maxBuffer: 32 * 1024 * 1024 })).stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(cwd)) throw new LeadRepoMissingError(cwd);
    throw error;
  }
};
const gitInput = (cwd: string, args: string[], input: string): Promise<string> => {
  if (!existsSync(cwd)) return Promise.reject(new LeadRepoMissingError(cwd));
  const child = spawn('git', args, { cwd, windowsHide: true });
  let bytes = 0;
  let timedOut = false;
  const over = (): boolean => bytes > 32 * 1024 * 1024;
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (over()) child.kill();
  });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
  // collect handles stdin EPIPE: a dead git must reject this step, not kill the daemon.
  return collect(child, Buffer.from(input), `git ${args[0]}`).then((output) => {
    if (over()) throw new Error(`git ${args[0]} exceeded maxBuffer`);
    return output.toString();
  }).catch((error: NodeJS.ErrnoException) => {
    if (timedOut) throw new Error(`git ${args[0]} timed out`);
    if (error.code === 'ENOENT' && !existsSync(cwd)) throw new LeadRepoMissingError(cwd);
    if (over()) throw new Error(`git ${args[0]} exceeded maxBuffer`);
    throw error;
  }).finally(() => clearTimeout(timer));
};
const fields = (text: string): string[] => text.split('\0').filter(Boolean);

type CoderRepo = { repo: string; ref: string; note: string };

export async function coderRepo(seat: Seat): Promise<CoderRepo> {
  const recorded = seat.data.repo as string;
  if (existsSync(recorded)) return { repo: recorded, ref: 'HEAD', note: '' };
  let common: string;
  try { common = (await git(seat.worktree!, undefined, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim(); }
  catch (error) {
    // A surviving checkout whose common directory died is a quiet missing-repo verdict.
    if ((error as { code?: unknown }).code === 128) throw new LeadRepoMissingError(recorded);
    throw error;
  }
  if (!lstatSync(common, { throwIfNoEntry: false })?.isDirectory()) throw new LeadRepoMissingError(recorded);
  // An in-flight add in the same repository can make this list fail once (task 2730).
  const first = (await worktreeListPorcelain(common, () => git(common, undefined, 'worktree', 'list', '--porcelain'))).split(/\r?\n/, 1)[0];
  if (!first.startsWith('worktree ') || !first.slice(9)) throw new Error('fallback primary worktree missing');
  const repo = first.slice(9);
  if (!lstatSync(repo, { throwIfNoEntry: false })?.isDirectory()) throw new Error('fallback primary worktree missing');
  try { await git(common, undefined, 'rev-parse', '--verify', 'refs/heads/master^{commit}'); }
  catch (error) {
    if ((error as { code?: unknown }).code === 128) throw new Error('fallback repository has no master branch');
    throw error;
  }
  return { repo, ref: 'refs/heads/master', note: ` (fallback repository ${repo}, master)` };
}

export async function branchTip(repo: string, branch: string): Promise<string | null> {
  try { return (await git(repo, undefined, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).trim(); }
  catch (error) { if ((error as { code?: unknown }).code === 1) return null; throw error; }
}

async function unlandedCommit(repo: string, commit: string, head: string): Promise<boolean> {
  try { await git(repo, undefined, 'merge-base', '--is-ancestor', commit, head); return false; }
  catch (error) { if ((error as { code?: unknown }).code === 1) return true; throw error; }
}

function historyEntries(raw: string): Map<string, Set<string>> {
  const entries = new Map<string, Set<string>>();
  const rows = fields(raw);
  if (rows.length % 2) throw new Error('malformed Git history');
  for (let i = 0; i < rows.length; i += 2) {
    const match = /^:[0-7]{6} ([0-7]{6}) [0-9a-f]{40,64} ([0-9a-f]{40,64}) [A-Z]$/.exec(rows[i]);
    if (!match) throw new Error('malformed Git history');
    const post = `${match[1]} ${match[2]}`;
    const path = rows[i + 1];
    const seen = entries.get(path) ?? new Set<string>();
    seen.add(post);
    entries.set(path, seen);
  }
  return entries;
}

function disposable(worktree: string, name: string): boolean {
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((part) => DISPOSABLE.has(part))) return true;
  const relative = parts.join('/');
  if (GENERATED.some((dir) => relative === dir || relative.startsWith(`${dir}/`))) return true;
  // Git --directory may return an untracked parent of configured generated output.
  // It is disposable only when every actual child resolves to generated output.
  if (name.endsWith('/') && GENERATED.some((dir) => dir.startsWith(`${relative}/`))) {
    const folder = path.join(worktree, ...parts);
    if (!lstatSync(folder).isDirectory()) return false;
    return readdirSync(folder).every((item) => disposable(worktree,
      `${relative}/${item}${lstatSync(path.join(folder, item)).isDirectory() ? '/' : ''}`));
  }
  // Provisioning links skills into the seat. Never treat a regular file there
  // (or an arbitrary .claude subtree) as disposable.
  if (parts[0] !== '.claude') return false;
  if (parts.length === 1 || (parts.length === 2 && parts[1] === 'skills')) {
    const folder = path.join(worktree, ...parts);
    if (!lstatSync(folder).isDirectory()) return false;
    return readdirSync(folder).every((item) => disposable(worktree, `${parts.join('/')}/${item}`));
  }
  return parts.length === 3 && parts[1] === 'skills' && lstatSync(path.join(worktree, ...parts)).isSymbolicLink();
}

type Audit = { changed: string[]; different: string[]; disposable: string[]; unsafe: string[]; unsafeIgnored: string[] };
async function audit(worktree: string, repo: string, base: string, ref = 'HEAD'): Promise<Audit> {
  if (!/^[0-9a-f]{40,64}$/.test(base)) throw new Error('seat base commit unavailable');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orch-prune-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
    await git(worktree, env, 'read-tree', 'HEAD');
    await git(worktree, env, 'add', '-A');
    const [names, untracked, ignored] = await Promise.all([
      git(worktree, env, 'diff', '--cached', '--no-renames', '--name-only', '-z', base, '--'),
      // Query the real index: `add -A` in the disposable index must not turn
      // untracked files into apparently discardable tracked changes.
      git(worktree, undefined, 'ls-files', '--others', '--exclude-standard', '--directory', '-z'),
      git(worktree, undefined, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'),
    ]);
    const changed = fields(names);
    const untrackedNames = fields(untracked);
    const candidates = [...new Set([...changed, ...untrackedNames.filter((name) => !disposable(worktree, name))])];
    const history = new Map<string, Set<string>>();
    if (candidates.length) {
      // Apple Git 2.54 rejects --pathspec-from-file. Batch under a budget that also
      // fits Windows CreateProcess (32767) so this argv cannot grow into E2BIG.
      const prefix = ['log', '--full-history', '-m', '--format=', '--raw', '--no-abbrev', '--no-renames', '-z', `${base}..${ref}`, '--'];
      const budget = 24 * 1024;
      let batch: string[] = [];
      let bytes = prefix.reduce((n, arg) => n + Buffer.byteLength(arg) + 1, 0);
      const baseBytes = bytes;
      const take = async (): Promise<void> => {
        if (!batch.length) return;
        const part = historyEntries(await git(repo, undefined, ...prefix, ...batch));
        for (const [name, seen] of part) {
          const dest = history.get(name) ?? new Set<string>();
          for (const entry of seen) dest.add(entry);
          history.set(name, dest);
        }
        batch = [];
        bytes = baseBytes;
      };
      for (const name of candidates) {
        const cost = Buffer.byteLength(name) + 1;
        if (batch.length && bytes + cost > budget) await take();
        batch.push(name);
        bytes += cost;
      }
      await take();
    }
    // --directory can fold new seat files into a parent. Expand only when that
    // parent held a file on master after base; otherwise the whole dir is unsafe.
    const historicalPaths = [...history.keys()];
    const untrackedFiles: string[] = [];
    for (const name of untrackedNames) {
      if (!name.endsWith('/') || disposable(worktree, name) ||
          !historicalPaths.some((file) => file.startsWith(name))) untrackedFiles.push(name);
      else untrackedFiles.push(...fields(await git(worktree, undefined, 'ls-files', '--others', '--exclude-standard', '-z', '--', name)));
    }
    const matched = new Map<string, boolean>();
    const onMaster = async (name: string): Promise<boolean> => {
      const seen = history.get(name);
      if (!seen) return false;
      const info = lstatSync(path.join(worktree, name), { throwIfNoEntry: false });
      if (!info) return [...seen].some((entry) => entry.startsWith('000000 '));
      if (!info.isFile()) return false;
      const mode = info.mode & 0o100 ? '100755' : '100644';
      // No clean/smudge filters: match the seat's literal bytes and executable mode.
      const hash = (await git(worktree, undefined, 'hash-object', '--no-filters', '--', name)).trim();
      return seen.has(`${mode} ${hash}`);
    };
    const landed = async (name: string): Promise<boolean> => {
      if (!matched.has(name)) matched.set(name, await onMaster(name));
      return matched.get(name)!;
    };
    // A provisioning copy can equal the lead's checkout even when not on HEAD.
    const different: string[] = [];
    for (const name of changed) {
      if (!(provisioningPath(name) && sameInLead(worktree, repo, name)) && !await landed(name)) different.push(name);
    }
    const extra: string[] = [];
    for (const name of [...new Set([...untrackedFiles, ...fields(ignored)])]) {
      if (!untrackedFiles.includes(name) || !await landed(name)) extra.push(name);
    }
    if (!lstatSync(worktree, { throwIfNoEntry: false })?.isDirectory())
      throw Object.assign(new Error('checkout missing during inspection'), { code: 'ENOENT' });
    return {
      changed, different,
      disposable: extra.filter((name) => disposable(worktree, name)),
      unsafe: extra.filter((name) => !disposable(worktree, name)),
      unsafeIgnored: fields(ignored).filter((name) => !disposable(worktree, name)),
    };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function notOwned(stateDir: string, seat: Seat): string | null {
  if (!landable(seat.role) || seat.status !== 'closed') return 'seat is not a closed coder';
  const root = path.join(stateDir, 'worktrees');
  if (!CODER_ID.test(seat.id) || seat.worktree !== path.join(root, seat.id) || seat.data.branch !== `orch/${seat.id}` ||
      !path.isAbsolute(root) || !existsSync(root) || !lstatSync(root).isDirectory()) return 'checkout or branch is not owned by orch';
  if (seat.data.worktreeRemoved) return 'checkout already removed';
  return null;
}

/** Includes persisted recheck checkouts, so queued turns remain protected after restart.
 *  A provisioning, ready or working seat whose cwd, worktree or repo is inside the checkout also pins it.
 *  Failed and closed seats do not (a failed seat never runs a turn; idle close closes it). Computed at call time from bounded
 *  queries of only the fields the pins need — no snapshot is reused across seats or awaits, so a seat
 *  started mid-sweep still pins its checkout — and each filesystem path is probed at most once per call. */
export function checkoutInUse(store: Store, seat: Seat): boolean {
  // A host seat's cwd is a path on that host, so this Mac's filesystem says
  // nothing about it; on macOS a /home lookup also goes through autofs (~22 ms, ~900 calls a sweep, task 2626).
  // It compares as written, which the probe gave it anyway: it does not exist here. Its worktree and repo are Mac paths.
  const onHost = (host: unknown): boolean => typeof host === 'string';
  const targets: { path: string; local: boolean }[] = [];
  if (typeof seat.worktree === 'string') targets.push({ path: seat.worktree, local: true });
  if (typeof seat.cwd === 'string') targets.push({ path: seat.cwd, local: !onHost(seat.data.host) });
  // pathInside's exact pair rule, memoized per call: no realpath unless both sides exist,
  // and a failed realpath on the target leaves the value compared as written.
  const probed = new Map<string, { exists: boolean; real: string | null }>();
  const probe = (value: string): { exists: boolean; real: string | null } => {
    let entry = probed.get(value);
    if (!entry) {
      const exists = existsSync(value);
      let real: string | null = null;
      if (exists) { try { real = realpathSync(value); } catch { /* an unresolvable path compares as written */ } }
      entry = { exists, real };
      probed.set(value, entry);
    }
    return entry;
  };
  const inside = (target: { path: string; local: boolean }, value: string, local: boolean): boolean => {
    let left = target.path;
    let right = value;
    if (target.local && local) {
      const t = probe(target.path);
      const v = probe(value);
      if (t.exists && v.exists && t.real !== null) {
        left = t.real;
        if (v.real !== null) right = v.real;
      }
    }
    const relative = path.relative(left, right);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  const uses = (value: unknown, local = true): boolean =>
    typeof value === 'string' && targets.some((target) => inside(target, value, local));
  const active = store.db.prepare(
    `SELECT t.id AS id, t.seat_id AS seat_id, t.pending AS pending, s.id AS joined_id, s.cwd AS cwd, s.worktree AS worktree,
            json_extract(s.data, '$.repo') AS repo, json_extract(s.data, '$.host') AS host
     FROM turns t LEFT JOIN seats s ON s.id = t.seat_id WHERE t.status IN ('running', 'queued')`,
  ).all() as { id: string; seat_id: string; pending: string | null; joined_id: string | null; cwd: string | null; worktree: string | null; repo: unknown; host: unknown }[];
  if (active.some((turn) => {
    if (turn.seat_id === seat.id) return true;
    if (turn.joined_id === null) return false;
    const checkout = turn.pending ? (JSON.parse(turn.pending) as TurnPending).checkout : undefined;
    return uses(turn.cwd, !onHost(turn.host)) || [turn.worktree, turn.repo, checkout].some((value) => uses(value));
  })) return true;
  const open = store.db.prepare(
    `SELECT id, cwd, worktree, json_extract(data, '$.repo') AS repo, json_extract(data, '$.host') AS host
     FROM seats WHERE status IN ('provisioning', 'ready', 'working')`,
  ).all() as { id: string; cwd: string | null; worktree: string | null; repo: unknown; host: unknown }[];
  return open.some((other) => other.id !== seat.id &&
    (uses(other.cwd, !onHost(other.host)) || [other.worktree, other.repo].some((value) => uses(value))));
}

export type PruneDecision = { seat: string; worktree: string | null; branch: string | null; reason: string; remove: boolean; lost: string[] };

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The idle sweep's floor: a coder whose change is landed closes after 12 h (decision #18443),
 *  every other role after a day. The 2-day unlanded coder rule is separate. */
export const idleFloorDays = (role: string): number => landable(role) ? 0.5 : 1;
/** Never infer idleness from seat.updated_at, or from an earlier ended turn. */
export function idleDays(seat: Seat, turns: Turn[], now = Date.now(), floor = 1): number | null {
  if (seat.status !== 'ready' || turns.some((turn) => turn.status === 'running' || turn.status === 'queued')) return null;
  const last = turns.at(-1);
  if (!last || !TERMINAL_TURN.has(last.status) || !last.ended_at) return null;
  const days = (now - Date.parse(last.ended_at)) / DAY_MS;
  return Number.isFinite(days) && days >= floor ? days : null;
}

/** Idle-close eligibility only: failed and never-prompted seats age from creation.
 * Keep idleDays' terminal-turn contract unchanged for other callers. */
export function idleCloseCandidate(seat: Seat, turns: Turn[], now = Date.now()): { kind: 'failed' | 'never-prompted' | 'idle'; days: number } | null {
  const floor = idleFloorDays(seat.role);
  if (seat.status === 'failed' || (seat.status === 'ready' && turns.length === 0)) {
    if (turns.some((turn) => turn.status === 'running' || turn.status === 'queued')) return null;
    const days = (now - Date.parse(seat.created_at)) / DAY_MS;
    return Number.isFinite(days) && days >= floor
      ? { kind: seat.status === 'failed' ? 'failed' : 'never-prompted', days } : null;
  }
  const days = idleDays(seat, turns, now, floor);
  return days === null ? null : { kind: 'idle', days };
}

/** Task 2861: ms since the seat's last turn ended — null while a turn is queued or
 *  running, before any terminal turn exists, or on an unparsable end. Like idleDays,
 *  never inferred from seat.updated_at. */
export function lastTurnEndedMs(turns: Pick<Turn, 'status' | 'ended_at'>[], now = Date.now()): number | null {
  if (turns.some((turn) => turn.status === 'running' || turn.status === 'queued')) return null;
  const last = turns.at(-1);
  if (!last || !TERMINAL_TURN.has(last.status) || !last.ended_at) return null;
  const ms = now - Date.parse(last.ended_at);
  return Number.isFinite(ms) ? ms : null;
}

/** Task 2861: how idle a local open seat must be before the sweep drops its cargo targets. */
export const SEAT_TARGET_IDLE_MS = 4 * 60 * 60 * 1000;

export type SeatTargetDrop = {
  seat: string;
  worktree: string;
  removed: string[];
  bytesBefore: number;
  skipped: { path: string; reason: string }[];
  error?: string;
};

/** Task 2861 slice A: a local open seat — ready, with no running or queued turn and its
 *  last turn ended SEAT_TARGET_IDLE_MS ago or more — keeps its source, node_modules and
 *  .codegraph but loses its regenerable cargo targets (a 4 h fresh-build window, far
 *  below the daily sweep's 24 h). A host seat's paths name that host's filesystem: it is
 *  never considered, and never probed on this Mac. Returns one summary per seat whose
 *  targets were attempted. */
export async function dropIdleSeatTargets(store: Pick<Store, 'listSeats' | 'listTurns'>, options: { dryRun?: boolean } = {}): Promise<SeatTargetDrop[]> {
  const idle: Seat[] = [];
  for (const seat of store.listSeats('ready')) {
    if (typeof seat.worktree !== 'string' || typeof seat.data.host === 'string') continue;
    const endedMs = lastTurnEndedMs(store.listTurns(seat.id));
    if (endedMs !== null && endedMs >= SEAT_TARGET_IDLE_MS) idle.push(seat);
  }
  const summaries: SeatTargetDrop[] = [];
  for (const seat of idle) {
    // Other seats' drops were awaited since the listing: re-decide on a fresh turn read
    // at the moment of the drop, the same fresh-sample rule as the process clauses.
    if (lastTurnEndedMs(store.listTurns(seat.id)) === null) continue;
    try {
      const dropped = await dropCheckoutTargets(seat.worktree, { window: SEAT_TARGET_IDLE_MS, dryRun: options.dryRun });
      summaries.push({ seat: seat.id, worktree: seat.worktree, removed: dropped.removed, bytesBefore: dropped.bytesBefore, skipped: dropped.skipped });
    } catch (error) {
      summaries.push({ seat: seat.id, worktree: seat.worktree, removed: [], bytesBefore: 0, skipped: [], error: (error as Error).message });
    }
  }
  return summaries;
}

/** Read-only pre-close proof; the real row is still ready. Mirrors must be final,
 * so an open host checkout cannot be judged from its potentially stale mirror. */
export async function inspectIdleCoder(stateDir: string, seat: Seat): Promise<PruneDecision> {
  const closed = { ...seat, status: 'closed', data: { ...seat.data } };
  if (typeof seat.data.host === 'string') return inspectMirror(stateDir, closed);
  closed.data.closedBranchTip = await branchTip((await coderRepo(seat)).repo, `orch/${seat.id}`);
  return inspectLanded(stateDir, closed);
}

export async function inspectCoder(stateDir: string, seat: Seat, olderThanMs?: number, now = Date.now()): Promise<PruneDecision> {
  if (typeof seat.data.host === 'string') return inspectMirror(stateDir, seat);
  let repoNote = '';
  const decision = (reason: string, remove = false, lost: string[] = []): PruneDecision =>
    ({ seat: seat.id, worktree: seat.worktree, branch: seat.data.branch as string | null, reason: reason + repoNote, remove, lost });
  const refused = notOwned(stateDir, seat);
  if (refused) return decision(refused);
  const checkout = lstatSync(seat.worktree!, { throwIfNoEntry: false });
  if (checkout && !checkout.isDirectory()) return decision('checkout is not a directory');
  const started = startedRemoval(seat);
  if (!checkout) {
    if (!started) return decision('checkout missing without recorded approval; refuse deletion');
    if (await branchTip(seat.data.repo as string, `orch/${seat.id}`) !== started.tip) return decision('branch changed since approved removal');
    return decision('resume previously approved removal', true, started.lost);
  }
  const resolved = await coderRepo(seat);
  repoNote = resolved.note;
  if (started && await branchTip(resolved.repo, `orch/${seat.id}`) !== started.tip) return decision('branch changed since approved removal');
  let found: Audit;
  try { found = await audit(seat.worktree!, resolved.repo, seat.data.base as string, resolved.ref); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !lstatSync(seat.worktree!, { throwIfNoEntry: false }))
      return decision('checkout missing during inspection');
    throw error;
  }
  const lost = [...new Set([...found.different, ...found.disposable, ...found.unsafe])];
  if (found.unsafe.length) return decision(`untracked/ignored files require inspection: ${found.unsafe.join(', ')}`, false, lost);
  const age = now - Date.parse(typeof seat.data.closedAt === 'string' ? seat.data.closedAt : seat.updated_at);
  const discard = found.different.length && olderThanMs !== undefined && Number.isFinite(age) && age >= olderThanMs;
  const repo = resolved.repo;
  let tip: string | null;
  let ownHead: string;
  let head: string | null;
  try {
    [tip, ownHead, head] = await Promise.all([
      branchTip(repo, `orch/${seat.id}`),
      git(seat.worktree!, undefined, 'rev-parse', 'HEAD').then((value) => value.trim()),
      leadHead(repo, resolved.ref),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !lstatSync(seat.worktree!, { throwIfNoEntry: false }))
      return decision('checkout missing during inspection');
    throw error;
  }
  if (!head) return decision('repository HEAD unavailable');
  const branchUnlanded = tip !== null && await unlandedCommit(repo, tip, head);
  const checkoutUnlanded = await unlandedCommit(repo, ownHead, head);
  if ((branchUnlanded && tip !== ownHead) || ((branchUnlanded || checkoutUnlanded) && !discard))
    return decision('branch or checkout HEAD has unlanded commits not covered by explicit tracked discard', false, lost);
  if (found.different.length && !discard) return decision('tracked changes differ from repository HEAD; require --older-than', false, lost);
  return decision(found.different.length ? `explicit discard of unlanded tracked changes (age ${Math.floor(age / 3_600_000)}h)` : 'all changed paths match repository HEAD', true, lost);
}

/** Reinspect immediately before deletion. On partial failure retain approval for retry. */
export async function pruneCoder(store: Store, stateDir: string, id: string, olderThanMs?: number): Promise<PruneDecision> {
  const seat = store.getSeat(id);
  if (!seat) throw new Error(`no seat '${id}'`);
  if (typeof seat.data.host === 'string') return pruneMirror(store, stateDir, seat);
  const decision = await inspectCoder(stateDir, seat, olderThanMs);
  if (!decision.remove) return decision;
  const current = store.getSeat(id)!;
  const resolved = await coderRepo(current);
  const [tip, target] = await Promise.all([branchTip(resolved.repo, `orch/${id}`), leadHead(resolved.repo, resolved.ref)]);
  if (!(await inspectCoder(stateDir, current, olderThanMs)).remove) throw new Error(`seat '${id}' is no longer eligible`);
  const rechecked = await coderRepo(current);
  if (rechecked.repo !== resolved.repo || rechecked.ref !== resolved.ref || await leadHead(resolved.repo, resolved.ref) !== target)
    throw new Error(`repository target for '${id}' changed during inspection`);
  if (await branchTip(resolved.repo, `orch/${id}`) !== tip) throw new Error(`branch for '${id}' changed during inspection`);
  const started = startedRemoval(seat);
  if (started && started.tip !== tip) throw new Error(`branch for '${id}' changed since approval`);
  return removeCoder(store, seat, tip, decision, { data: { pruneApproved: true, approvedBranchTip: tip, pruneLost: decision.lost }, event: 'seat.prune_approved' }, resolved.repo);
}

/**
 * A remote coder's local mirror (task 1704d) is exactly `stateDir/mirrors/<seat id>`,
 * recorded as both its worktree and data.mirror, and final once close
 * removed the host checkout or recovery observed the directory gone
 * (`remoteCheckoutGone`). A landed or empty mirror is still required.
 */
function mirrorNotOwned(stateDir: string, seat: Seat): string | null {
  if (!landable(seat.role) || seat.status !== 'closed') return 'seat is not a closed coder';
  const dir = path.join(stateDir, 'mirrors', seat.id);
  if (!CODER_ID.test(seat.id) || !path.isAbsolute(dir) || seat.worktree !== dir || seat.data.mirror !== dir || seat.data.branch != null) return 'mirror is not owned by orch';
  if (seat.data.worktreeRemoved) return 'mirror already removed';
  if (!remoteCheckoutGone(seat.data) && (seat.data.remoteRemoved !== true || seat.data.remoteRemoveError)) return 'host checkout not removed; the mirror is not final';
  try { assertMirrorPath(stateDir, dir); } catch (error) { return (error as Error).message; }
  return null;
}

/**
 * A closed remote coder's mirror goes once its change is landed: its whole tree
 * (untracked files included) is the seat_land snapshot recorded in data.landed
 * and refs/orch/landed/<id>, or the daemon sweep's landed() check finds it on
 * the lead HEAD or finds no change. --older-than never discards a mirror. The
 * fingerprint is the mirror state read BEFORE the proof; removal requires it unchanged.
 */
async function judgeMirror(stateDir: string, seat: Seat): Promise<{ decision: PruneDecision; fingerprint: string | null }> {
  let fingerprint: string | null = null;
  const decision = (reason: string, remove = false, lost: string[] = []) =>
    ({ decision: { seat: seat.id, worktree: seat.worktree, branch: null, reason, remove, lost } as PruneDecision, fingerprint });
  const refused = mirrorNotOwned(stateDir, seat);
  if (refused) return decision(refused);
  const dir = seat.worktree!;
  const info = lstatSync(dir, { throwIfNoEntry: false });
  if (!info) return seat.data.pruneApproved === true ? decision('resume previously approved removal', true) : decision('mirror missing without recorded approval');
  if (!info.isDirectory()) return decision('mirror is not a directory');
  const repo = seat.data.repo;
  if (typeof repo !== 'string' || !existsSync(repo)) return decision('lead repo missing');
  if (typeof seat.data.base !== 'string' || !/^[0-9a-f]{40,64}$/.test(seat.data.base)) return decision('seat base commit unavailable');
  const state = await mirrorState(dir);
  if (state.ignored.length) return decision(`ignored files require inspection: ${state.ignored.join(', ')}`, false, state.ignored);
  fingerprint = state.fingerprint;
  const changed = fields(await git(dir, undefined, 'diff', '--no-renames', '--name-only', '-z', seat.data.base, state.tree, '--'));
  if (!changed.length) return decision('mirror has no changes', true);
  const snapshot = (seat.data.landed as { snapshot?: unknown } | undefined)?.snapshot;
  if (typeof snapshot === 'string' && await leadHead(repo, `refs/orch/landed/${seat.id}`) === snapshot &&
      await leadHead(repo, `${snapshot}^{tree}`) === state.tree) return decision('mirror is the seat_land snapshot', true, changed);
  const onHead = await landedForSweep(seat);
  if (onHead.startsWith('yes') || onHead === 'no changes') return decision(`mirror change is on repository HEAD: ${onHead}`, true, changed);
  return decision(`mirror change is not landed: ${onHead}`, false, changed);
}

const inspectMirror = async (stateDir: string, seat: Seat): Promise<PruneDecision> => (await judgeMirror(stateDir, seat)).decision;

/** The mirror counterpart of pruneCoder: approval is recorded before the owned worktree goes. */
async function pruneMirror(store: Store, stateDir: string, seat: Seat): Promise<PruneDecision> {
  const { decision, fingerprint } = await judgeMirror(stateDir, seat);
  if (!decision.remove) return decision;
  if (checkoutInUse(store, store.getSeat(seat.id) ?? seat)) return { ...decision, remove: false, reason: 'checkout in use' };
  store.updateSeat(seat.id, { data: { pruneApproved: true, pruneLost: decision.lost } }, 'seat.prune_approved', { reason: decision.reason });
  try {
    await removeMirror(seat.data.repo as string, seat.worktree!, stateDir, {
      ...(fingerprint === null ? {} : { expected: fingerprint }),
      beforeRemove: async () => {
        const latest = store.getSeat(seat.id);
        if (latest && checkoutInUse(store, latest)) throw new Error('checkout in use');
      },
    });
  } catch (error) {
    const message = (error as Error).message;
    if (message === 'checkout in use') {
      store.updateSeat(seat.id, { data: { pruneApproved: false } }, 'seat.prune_kept', { reason: message });
      return { ...decision, remove: false, reason: message };
    }
    if (!message.startsWith(MIRROR_CHANGED)) throw error;
    store.updateSeat(seat.id, { data: { pruneApproved: false } }, 'seat.prune_kept', { reason: MIRROR_CHANGED });
    return { ...decision, remove: false, reason: MIRROR_CHANGED };
  }
  store.updateSeat(seat.id, { data: { worktreeRemoved: true } }, 'seat.pruned', { reason: decision.reason });
  return decision;
}

/** Entries under `stateDir/mirrors` that are no remote coder's recorded mirror: reported, never touched. */
export function unknownMirrors(stateDir: string, seats: Seat[]): { mirror: string; remove: false; reason: string }[] {
  const root = path.join(stateDir, 'mirrors');
  const info = lstatSync(root, { throwIfNoEntry: false });
  if (!info) return [];
  if (!info.isDirectory()) return [{ mirror: root, remove: false, reason: 'mirrors root is not a directory; left alone' }];
  const known = new Set(seats.filter((seat) => typeof seat.data.host === 'string' && landable(seat.role) &&
    seat.worktree === path.join(root, seat.id) && seat.data.mirror === seat.worktree).map((seat) => seat.id));
  return readdirSync(root).filter((name) => !known.has(name))
    .map((name) => ({ mirror: path.join(root, name), remove: false as const, reason: 'unknown entry under mirrors; left alone' }));
}

type AutoPruned = { reason: string; tip: string | null; head: string | null; lost: string[]; at: string;
  checkoutOnly?: boolean; repo?: string; ref?: string; patch?: string; untracked?: string; identity?: string; archived?: string[];
  mirrorFingerprint?: string; backupIdentity?: string; capRule?: 2 };

/**
 * A removal already under way: the operator's CLI approval, or the daemon's own
 * automatic decision (autoPruned, never recorded as pruneApproved). Either lets
 * CLI prune resume a partial removal against the tip it was taken at.
 */
function startedRemoval(seat: Seat): { tip: unknown; lost: string[] } | null {
  if (seat.data.pruneApproved === true) return { tip: seat.data.approvedBranchTip, lost: Array.isArray(seat.data.pruneLost) ? seat.data.pruneLost as string[] : [] };
  const auto = seat.data.autoPruned as AutoPruned | undefined;
  // A checkoutOnly marker (task 1953) approved no branch deletion; the daemon
  // resumes it, the CLI treats the seat as if no marker existed.
  return auto && typeof auto === 'object' && auto.checkoutOnly !== true ? { tip: auto.tip, lost: Array.isArray(auto.lost) ? auto.lost : [] } : null;
}

/**
 * Daemon sweep (task 1522, decision #11859): a closed coder whose whole change
 * is on the lead repository HEAD. Kept, with the reason, when the landing check
 * is unknown or negative (it covers untracked files), an ignored file is neither
 * a known cache nor the lead's own copy, or the branch tip moved since close.
 */
export async function inspectLanded(stateDir: string, seat: Seat): Promise<PruneDecision> {
  const decision = (reason: string, remove = false, lost: string[] = []): PruneDecision =>
    ({ seat: seat.id, worktree: seat.worktree, branch: seat.data.branch as string | null, reason, remove, lost });
  const refused = notOwned(stateDir, seat);
  if (refused) return decision(refused);
  if (typeof seat.data.repo !== 'string') return decision('lead repo missing');
  if (!lstatSync(seat.worktree!, { throwIfNoEntry: false })?.isDirectory()) return decision('checkout missing or not a directory; only CLI prune resumes it');
  let resolved: CoderRepo;
  try { resolved = await coderRepo(seat); }
  catch (error) {
    if (error instanceof LeadRepoMissingError) return decision('lead repo missing');
    throw error;
  }
  if (await branchTip(resolved.repo, `orch/${seat.id}`) !== tipAtClose(seat)) return decision('branch tip moved since close');
  let found: Audit;
  try { found = await audit(seat.worktree!, resolved.repo, seat.data.base as string, resolved.ref); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !lstatSync(seat.worktree!, { throwIfNoEntry: false }))
      return decision('checkout missing during inspection');
    throw error;
  }
  const lost = [...new Set([...found.different, ...found.disposable, ...found.unsafe])];
  // landed() carries untracked files; an ignored one blocks removal unless provisioning copied it unchanged from the lead checkout (.env).
  const ignored = found.unsafeIgnored.filter((name) => !sameInLead(seat.worktree!, resolved.repo, name));
  if (ignored.length) return decision(`ignored files require inspection: ${ignored.join(', ')}`, false, lost);
  const onHead = resolved.ref === 'HEAD' ? await landedForSweep(seat) : await landedOnRef(seat, resolved);
  if (!onHead.startsWith('yes') && onHead !== 'no changes') return decision(`change is not on repository HEAD: ${onHead}`, false, lost);
  return decision(`change is on repository HEAD: ${onHead}`, true, lost);
}

/** The existing landing helper reads HEAD only; fallback must judge master, not the primary checkout's branch. */
async function landedOnRef(seat: Seat, resolved: CoderRepo): Promise<string> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orch-prune-ref-'));
  try {
    const seatEnv = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'seat.index') };
    const leadEnv = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'lead.index') };
    await git(seat.worktree!, seatEnv, 'read-tree', 'HEAD');
    await git(seat.worktree!, seatEnv, 'add', '-N', '--', '.');
    const patch = await git(seat.worktree!, seatEnv, 'diff', '--binary', '--no-ext-diff', '--no-renames', seat.data.base as string, '--');
    if (!patch) return 'no changes';
    const file = path.join(scratch, 'seat.patch');
    writeFileSync(file, patch);
    await git(resolved.repo, leadEnv, 'read-tree', resolved.ref);
    try { await git(resolved.repo, leadEnv, 'apply', '--cached', '--check', '--reverse', file); return 'yes (patch)'; }
    catch (error) {
      if ((error as { code?: unknown }).code === 1) return 'no';
      throw error;
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function sameInLead(worktree: string, repo: string, name: string): boolean {
  if (name.endsWith('/')) return false;
  const [own, lead] = [path.join(worktree, name), path.join(repo, name)];
  const ownInfo = lstatSync(own, { throwIfNoEntry: false });
  const leadInfo = lstatSync(lead, { throwIfNoEntry: false });
  if (ownInfo?.isSymbolicLink() && leadInfo?.isSymbolicLink()) {
    try {
      const ownTarget = path.relative(realpathSync(worktree), realpathSync(own));
      return ownTarget !== '..' && !ownTarget.startsWith(`..${path.sep}`) &&
        ownTarget === path.relative(realpathSync(repo), realpathSync(lead));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return !!ownInfo?.isFile() && !!leadInfo?.isFile() &&
    (ownInfo.mode & 0o100) === (leadInfo.mode & 0o100) && readFileSync(own).equals(readFileSync(lead));
}

// A seat closed before closedBranchTip was recorded passes only when its branch never left its base.
const tipAtClose = (seat: Seat): unknown => typeof seat.data.closedBranchTip === 'string' ? seat.data.closedBranchTip : seat.data.base;

async function leadHead(repo: string, ref = 'HEAD'): Promise<string | null> {
  try { return (await git(repo, undefined, 'rev-parse', '--verify', ref)).trim(); }
  catch (error) { if ((error as { code?: unknown }).code === 128) return null; throw error; }
}

/** A kept verdict and the branch tip and lead HEAD it was judged against; null stands for absent. */
type AutoKept = { reason: string; tip: string | null; head: string | null; proofVersion?: number };
const PROOF_VERSION = 2;

/**
 * Kept verdicts that name unlanded work; only these age into backup-and-remove
 * (task 1953). A landing verdict that is unknown also ages (operator #13349
 * covers unlanded and undetermined work): inspectLanded phrases it 'change is
 * not on repository HEAD: unknown (...)', which matches this prefix. Unknown
 * verdicts are never memoized, so they reach the fresh path every sweep, and
 * they age only through the verified backup below; any error keeps the seat.
 * 'branch tip moved since close' ages too: the branch is never deleted, so its
 * later commits survive, and the verified backup covers the checkout. 'lead
 * repo missing' and every error or ownership reason still keep forever.
 */
const AGED_KEPT = /^(?:change is not on repository HEAD|ignored files require inspection):|^branch tip moved since close/;
const AGED_AFTER_MS = DAY_MS;
const BACKUP_CAP = 300 * 1024 * 1024;
const BACKUP_OVER_CAP = 'backup over cap: untracked ';

/** Git output streams to a file: an exec buffer would cap a large patch at maxBuffer. The fd is closed and the promise settled exactly once: a spawn failure emits error then close, and a second closeSync would throw EBADF uncaught. */
const gitToFile = (cwd: string, file: string, args: string[]): Promise<void> => new Promise((resolve, reject) => {
  const out = openSync(file, 'w');
  const child = spawn('git', args, { cwd, stdio: ['ignore', out, 'pipe'] });
  let stderr = '';
  let settled = false;
  const finish = (failure: Error | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { closeSync(out); } catch { /* a failed spawn may have closed it already */ }
    if (failure) reject(failure); else resolve();
  };
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => { child.kill(); finish(new Error(`git ${args[0]} timed out`)); }, 120_000);
  child.on('error', (error) => finish(error));
  child.on('close', (code) => finish(code === 0 ? null : new Error(`git ${args[0]} failed: ${stderr.trim().slice(0, 400)}`)));
});

/**
 * Content identity of a checkout (task 1953): HEAD plus the tree of every
 * non-ignored file written through a temporary index — the mirrorState
 * approach (remote-worktree.ts) — plus the content hashes of the files the
 * backup archives. The tree covers tracked changes and untracked files; the
 * archived ignored files join by hash, and every ignored filename joins by
 * name. A second edit or a new ignored file changes this where HEAD/status
 * text or the non-ignored tree alone would not.
 */
async function checkoutIdentity(worktree: string, archived: string[], auditIdentity?: string): Promise<string> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orch-prune-id-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
    await git(worktree, env, 'read-tree', 'HEAD');
    await git(worktree, env, 'add', '-A');
    const [head, tree, ignoredRaw] = await Promise.all([
      git(worktree, undefined, 'rev-parse', 'HEAD').then((value) => value.trim()),
      git(worktree, env, 'write-tree').then((value) => value.trim()),
      git(worktree, undefined, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'),
    ]);
    const ignored = fields(ignoredRaw).sort();
    const slots: Array<{ missing: string } | { file: string }> = [];
    for (const name of [...archived].sort()) {
      const info = lstatSync(path.join(worktree, name), { throwIfNoEntry: false });
      if (!info) { slots.push({ missing: name }); continue; }
      const files = info.isDirectory()
        ? [...new Set([...fields(await git(worktree, undefined, 'ls-files', '--others', '--exclude-standard', '-z', '--', name)),
            ...ignored.filter((file) => file.startsWith(`${name}/`))])].sort()
        : [name];
      for (const file of files) slots.push({ file });
    }
    const present = slots.flatMap((slot) => 'file' in slot ? [slot.file] : []);
    // One spawn. C-quote every path so a leading quote is literal and newline/CR stay one line.
    const raw = present.length
      ? await gitInput(worktree, ['hash-object', '--no-filters', '--stdin-paths'], `${present.map(quoteGitPath).join('\n')}\n`)
      : '';
    const digests = raw === '' ? [] : raw.replace(/\r?\n$/, '').split(/\r?\n/);
    if (digests.length !== present.length) throw new Error(`hash-object returned ${digests.length} hashes for ${present.length} paths`);
    let at = 0;
    const hashes = slots.map((slot) => 'missing' in slot ? `${slot.missing}=missing` : `${slot.file}=${digests[at++]}`);
    const ignoredContent = ['ignored-paths-v1', JSON.stringify(ignored)].join('\0');
    if (auditIdentity !== undefined) {
      const prior = auditIdentity.split('\0');
      const ignoredDigest = createHash('sha256').update(ignoredContent).digest('hex');
      if (head !== prior[0] || tree !== prior[1] || ignoredDigest !== prior[3])
        throw new Error('checkout changed during archive planning');
    }
    // Fold the exact old tail, keeping HEAD/tree positions and all coverage.
    const digest = createHash('sha256').update([...hashes, ignoredContent].join('\0')).digest('hex');
    return [head, tree, 'sha256-v1', digest].join('\0');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

type ArchivePlan = { names: string[]; lost: string[]; untrackedOverCap: string | null };

/** Fill the cap smallest first. Only ignored leftovers may be lost. */
async function planArchive(worktree: string, found: Audit): Promise<ArchivePlan> {
  const ignored = new Set(found.unsafeIgnored);
  // unsafe includes ignored paths too; classify each candidate exactly once.
  const untracked = new Set(found.unsafe.filter((name) => !ignored.has(name)));
  const candidates: { name: string; bytes: number }[] = [];
  let directory: string | null = null;
  // A directory already includes its descendants, both in size and in tar.
  for (const name of [...new Set([...untracked, ...ignored])].sort()) {
    if (directory !== null && name.startsWith(directory)) continue;
    directory = name.endsWith('/') ? name : null;
    candidates.push({ name, bytes: await diskBytes(path.join(worktree, name)) });
  }
  candidates.sort((a, b) => a.bytes - b.bytes || a.name.localeCompare(b.name));
  const plan: ArchivePlan = { names: [], lost: [], untrackedOverCap: null };
  let bytes = 0;
  for (const candidate of candidates) {
    if (bytes + candidate.bytes <= BACKUP_CAP) {
      bytes += candidate.bytes;
      plan.names.push(candidate.name.replace(/\/+$/, ''));
    } else if (untracked.has(candidate.name)) {
      plan.untrackedOverCap ??= candidate.name;
    } else {
      plan.lost.push(candidate.name);
    }
  }
  return plan;
}

/**
 * Preserve an aged unlanded checkout before its removal. Tracked work becomes
 * `<seat>.patch` (`git diff --binary <base>`); the planned files become
 * `<seat>.untracked.tgz`. Each file is written under a temporary name and
 * renamed. Member names are `./<name>` in a NUL-separated list (`tar --null -T`),
 * not argv: a checkout with tens of thousands of untracked files exceeds ARG_MAX
 * (`spawn E2BIG`). `./` keeps a leading-dash name from being an option (GNU tar
 * 1.35 ran `--checkpoint-action=exec`) and is the stored member form. The archive
 * and the list are relative names with cwd set to the backup directory (GNU tar
 * reads a drive letter in `-f` as a remote host). A failure throws; the
 * caller keeps the seat and partial artifacts go.
 */
async function backupCheckout(stateDir: string, seat: Seat, names: string[]): Promise<{ patch: string; untracked: string | null }> {
  const worktree = seat.worktree!;
  const dir = path.join(stateDir, 'worktree-backups');
  mkdirSync(dir, { recursive: true });
  const patch = path.join(dir, `${seat.id}.patch`);
  const written: string[] = [];
  try {
    const patchTmp = `${patch}.tmp-${process.pid}`;
    written.push(patchTmp);
    await gitToFile(worktree, patchTmp, ['--no-optional-locks', 'diff', '--binary', seat.data.base as string, '--']);
    renameSync(patchTmp, patch);
    written[0] = patch;
    let saved: string | null = null;
    if (names.length) {
      const tgzTmp = `${seat.id}.untracked.tgz.tmp-${process.pid}`;
      written.push(path.join(dir, tgzTmp));
      const listName = `${seat.id}.untracked.list.tmp-${process.pid}`;
      written.push(path.join(dir, listName));
      // One NUL after each `./<name>`. Relative -T: a drive letter in the list path is a remote host on GNU tar, same as -f.
      writeFileSync(path.join(dir, listName), `${names.map((name) => `./${name}`).join('\0')}\0`);
      await exec('tar', ['-czf', tgzTmp, '-C', worktree, '--null', '-T', listName], { cwd: dir, timeout: 300_000 });
      rmSync(path.join(dir, listName), { force: true });
      const tgz = path.join(dir, `${seat.id}.untracked.tgz`);
      renameSync(path.join(dir, tgzTmp), tgz);
      written[1] = tgz;
      saved = tgz;
    }
    return { patch, untracked: saved };
  } catch (error) {
    for (const file of written) rmSync(file, { force: true });
    throw error;
  }
}

/**
 * Task 1953 (decisions #13349, #13352): a closed local coder kept only for
 * unlanded work is backed up and its checkout removed once it is at least a
 * day old. The branch is never deleted and branchRemoved is never set. The
 * age basis is written once (closedAt, else updated_at at first observation);
 * kept verdicts and close retries never move it. The durable autoPruned
 * marker (tip, backup paths, lost; checkoutOnly) is persisted BEFORE the
 * deletion so a restart resumes from it. Null means too young or the backup
 * failed, and the caller records the ordinary kept verdict.
 */
async function pruneAged(store: Store, stateDir: string, seat: Seat, reason: string): Promise<PruneDecision | null> {
  // The same ownership gate inspectLanded and resumeAged apply; the memoized
  // path reaches here without a fresh inspection.
  if (notOwned(stateDir, seat) !== null || checkoutInUse(store, seat)) return null;
  let basis = typeof seat.data.autoPruneAgeBase === 'string' ? seat.data.autoPruneAgeBase : null;
  if (!basis) {
    basis = typeof seat.data.closedAt === 'string' ? seat.data.closedAt : seat.updated_at;
    store.updateSeat(seat.id, { data: { autoPruneAgeBase: basis } }, 'seat.auto_prune_age_recorded', { reason });
  }
  const age = Date.now() - Date.parse(basis);
  if (!Number.isFinite(age) || age < AGED_AFTER_MS) return null;
  if (!lstatSync(seat.worktree!, { throwIfNoEntry: false })?.isDirectory()) return null;
  const { repo, ref } = await coderRepo(seat);
  const aged = `aged unlanded checkout backed up and removed (closed ${Math.floor(age / 3_600_000)}h ago): ${reason}`;
  let plan: ArchivePlan;
  let identity: string;
  let backup: { patch: string; untracked: string | null };
  let tip: string | null;
  let head: string | null;
  try {
    const auditIdentity = await checkoutIdentity(seat.worktree!, []);
    let found: Audit;
    [found, tip, head] = await Promise.all([
      audit(seat.worktree!, repo, seat.data.base as string, ref),
      branchTip(repo, `orch/${seat.id}`),
      leadHead(repo, ref),
    ]);
    plan = await planArchive(seat.worktree!, found);
    if (plan.untrackedOverCap !== null) {
      const capReason = recordCapKeep(store, seat, plan.untrackedOverCap);
      return { seat: seat.id, worktree: seat.worktree, branch: seat.data.branch as string | null,
        reason: capReason, remove: false, lost: [] };
    }
    // Bind the backup to the tree and ignored-name set captured before audit.
    identity = await checkoutIdentity(seat.worktree!, plan.names, auditIdentity);
    backup = await backupCheckout(stateDir, seat, plan.names);
  } catch (error) {
    store.updateSeat(seat.id, { data: {} }, 'seat.auto_prune_backup_failed', { reason: (error as Error).message });
    return null;
  }
  const marker: AutoPruned = { reason: aged, tip, head, lost: plan.lost, at: new Date().toISOString(),
    checkoutOnly: true, capRule: 2, repo, ref, patch: backup.patch, identity, archived: plan.names };
  if (backup.untracked) marker.untracked = backup.untracked;
  store.updateSeat(seat.id, { data: { autoPruned: marker } }, 'seat.auto_prune_started', { reason: aged });
  // Immediately before removal the checkout must still be the backed-up bytes;
  // a change sets the backup aside before dropping the marker, and keeps the seat.
  if (await checkoutIdentity(seat.worktree!, plan.names) !== identity) {
    const failed = setAsideAgedBackup(store, stateDir, seat, marker, 'checkout changed after backup', 'seat.auto_prune_changed');
    if (failed) return { seat: seat.id, worktree: seat.worktree, branch: seat.data.branch as string | null,
      reason: failed, remove: false, lost: [] };
    return null;
  }
  if (checkoutInUse(store, seat)) return null;
  if (existsSync(seat.worktree!)) noteCodegraphDaemonStop(await removeWorktree(repo, seat.worktree!), seat.id, seat.worktree!, store);
  store.updateSeat(seat.id, { data: { worktreeRemoved: true } }, 'seat.pruned', { reason: aged });
  return { seat: seat.id, worktree: seat.worktree, branch: seat.data.branch as string | null, reason: aged, remove: true, lost: plan.lost };
}

/** Set aside only canonical owned files; the backup sweep retires set-asides after 14 days. */
function setAsideAgedBackup(store: Store, stateDir: string, seat: Seat, marker: AutoPruned, reason: string,
  event = 'seat.auto_prune_marker_dropped'): string | null {
  const dir = path.join(stateDir, 'worktree-backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backups: string[] = [];
  try {
    for (const [file, suffix] of [[marker.patch, '.patch'], [marker.untracked, '.untracked.tgz']] as const) {
      const canonical = path.join(dir, `${seat.id}${suffix}`);
      if (file !== canonical || !lstatSync(canonical, { throwIfNoEntry: false })) continue;
      for (let next = 0; ; next++) {
        const target = path.join(dir, `${seat.id}.interrupted-${stamp}${next ? `-${next}` : ''}${suffix}`);
        // A same-directory link/unlink is a no-clobber rename: unlike renameSync,
        // linkSync atomically refuses an existing target, including on Unix.
        try { linkSync(canonical, target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
        backups.push(target);
        unlinkSync(canonical);
        break;
      }
    }
  } catch (error) {
    const failed = `backup set-aside failed: ${(error as Error).message}`;
    // Already moved files stay safe; the remaining canonical files retry next sweep.
    store.updateSeat(seat.id, { data: {} }, 'seat.auto_prune_backup_set_aside_failed', { reason: failed, backups });
    return failed;
  }
  store.updateSeat(seat.id, { data: { autoPruned: null } }, event, { reason, backups });
  return null;
}

/** Backup files of removals still in progress (task 2861 slice S5): a seat's
 *  autoPruned marker survives its own completion — worktreeRemoved true — so a
 *  marker protects its named files only while resumeAged may still need them.
 *  The backup sweep samples this set at every deletion moment. */
export function protectedBackupPaths(seats: Iterable<Pick<Seat, 'data'>>): Set<string> {
  const named = new Set<string>();
  for (const seat of seats) {
    if (seat.data.worktreeRemoved === true) continue;
    const marker = seat.data.autoPruned as AutoPruned | undefined;
    if (!marker || typeof marker !== 'object') continue;
    for (const file of [marker.patch, marker.untracked] as const) {
      if (typeof file === 'string') named.add(path.resolve(file));
    }
  }
  return named;
}

/** A cap refusal is reconsidered at most daily, without moving the closure age. */
function capRetryReason(seat: Seat): string | null {
  const reason = seat.data.autoPruneCapReason;
  const checkedAt = Date.parse(String(seat.data.autoPruneCapCheckedAt));
  return typeof reason === 'string' && reason.startsWith(BACKUP_OVER_CAP) &&
    Number.isFinite(checkedAt) && Date.now() - checkedAt < AGED_AFTER_MS ? reason : null;
}

function recordCapKeep(store: Store, seat: Seat, name: string): string {
  const reason = BACKUP_OVER_CAP + name;
  store.updateSeat(seat.id, { data: { autoPruneCapCheckedAt: new Date().toISOString(), autoPruneCapReason: reason } },
    'seat.auto_prune_cap_checked', {});
  memoAgedKeep(store, seat, reason);
  return reason;
}

/** One observation, not a removal. The sweep stays quiet once autoPruneKept.reason matches, as a worktree 'lead repo missing' does. */
function memoAgedKeep(store: Store, seat: Seat, reason: string): void {
  const kept = (store.getSeat(seat.id) ?? seat).data.autoPruneKept as AutoKept | undefined;
  if (kept?.reason === reason) return;
  const verdict: AutoKept = { reason, tip: null, head: null, proofVersion: PROOF_VERSION };
  store.updateSeat(seat.id, { data: { autoPruneKept: verdict } }, 'seat.auto_prune_kept', { reason });
}

/**
 * Finish a backup-and-remove interrupted after its marker. The seat must still
 * be owned, the marker's patch and archive must exist, and a surviving
 * checkout's content identity must equal the marker's. Any mismatch drops the
 * marker and returns null: the caller takes the full aged path again (fresh
 * backup) or keeps the seat.
 */
function agedBackupFilesPresent(marker: AutoPruned): boolean {
  return typeof marker.patch === 'string' && existsSync(marker.patch) &&
    (marker.untracked === undefined || existsSync(marker.untracked));
}

function gitlessAgedLeftover(seat: Seat, marker: AutoPruned, files: boolean, surviving: boolean): boolean {
  return surviving && marker.checkoutOnly === true && files &&
    !lstatSync(path.join(seat.worktree!, '.git'), { throwIfNoEntry: false });
}

async function resumeAged(store: Store, stateDir: string, seat: Seat, marker: AutoPruned): Promise<PruneDecision | null> {
  const refused = notOwned(stateDir, seat);
  if (refused) return { seat: seat.id, worktree: seat.worktree, branch: seat.data.branch as string | null, reason: refused, remove: false, lost: [] };
  const legacyLoss = Array.isArray(marker.lost) && marker.lost.length > 0 && marker.capRule !== 2;
  const legacyIdentity = typeof marker.identity !== 'string' || marker.identity.split('\0')[2] !== 'sha256-v1';
  const files = agedBackupFilesPresent(marker);
  const surviving = lstatSync(seat.worktree!, { throwIfNoEntry: false })?.isDirectory() === true;
  if (gitlessAgedLeftover(seat, marker, files, surviving)) return removeAgedLeftover(store, stateDir, seat, marker);
  // Once removal finished, the backup is the only surviving copy of the work.
  let verified = files && (!surviving || (!legacyLoss && !legacyIdentity));
  if (verified && surviving)
    verified = typeof marker.identity === 'string' &&
      await checkoutIdentity(seat.worktree!, Array.isArray(marker.archived) ? marker.archived : []) === marker.identity;
  if (!verified) {
    const failed = setAsideAgedBackup(store, stateDir, seat, marker,
      legacyLoss ? 'backup marker predates cap rule 2' : legacyIdentity ? 'backup marker predates sha256 identity' : files ? 'checkout changed since the backup' : 'backup files missing');
    if (failed) return { seat: seat.id, worktree: seat.worktree, branch: seat.data.branch as string | null,
      reason: failed, remove: false, lost: [] };
    // A changed current-format checkout stays for this sweep. Old identities
    // fall through to a fresh judgment instead of resuming their old approval.
    if (files && surviving && !legacyLoss && typeof marker.identity === 'string' &&
        marker.identity.split('\0')[2] === 'sha256-v1')
      return { seat: seat.id, worktree: seat.worktree, branch: seat.data.branch as string | null,
        reason: 'checkout changed since the backup', remove: false, lost: [] };
    return null;
  }
  const repo = typeof marker.repo === 'string' ? marker.repo : (existsSync(seat.worktree!) ? (await coderRepo(seat)).repo : seat.data.repo as string);
  const reason = `resume aged removal: ${marker.reason}`;
  if (checkoutInUse(store, seat)) return { seat: seat.id, worktree: seat.worktree, branch: seat.data.branch as string | null, reason: 'checkout in use', remove: false, lost: [] };
  if (existsSync(seat.worktree!)) noteCodegraphDaemonStop(await removeWorktree(repo, seat.worktree!), seat.id, seat.worktree!, store);
  store.updateSeat(seat.id, { data: { worktreeRemoved: true } }, 'seat.pruned', { reason });
  return { seat: seat.id, worktree: seat.worktree, branch: seat.data.branch as string | null, reason, remove: true, lost: Array.isArray(marker.lost) ? marker.lost : [] };
}

function agedMarkerLegacyReason(marker: AutoPruned): string | null {
  if (Array.isArray(marker.lost) && marker.lost.length > 0 && marker.capRule !== 2)
    return 'backup marker predates cap rule 2';
  if (typeof marker.identity !== 'string' || marker.identity.split('\0')[2] !== 'sha256-v1')
    return 'backup marker predates sha256 identity';
  return null;
}

function agedLeftoverScopeReason(stateDir: string, seat: Seat, marker: AutoPruned): string | null {
  const root = path.join(stateDir, 'worktrees');
  const backups = path.join(stateDir, 'worktree-backups');
  if (marker.patch !== path.join(backups, `${seat.id}.patch`) ||
      (marker.untracked !== undefined && marker.untracked !== path.join(backups, `${seat.id}.untracked.tgz`)))
    return 'backup paths are not owned by orch';
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== path.join(realpathSync(stateDir), 'worktrees'))
    return 'leftover parent is redirected';
  return null;
}

/** Remove only enumerated disposable leaves; never recursively delete a tree
 * based on a stale scan. rmdir atomically refuses late entries, including writes
 * through a process-held cwd. Every read/removal error keeps the remainder. */
async function unarchivedLeftover(worktree: string, relative = ''): Promise<string | null> {
  try {
    for (const entry of await readdir(path.join(worktree, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const kept = await unarchivedLeftover(worktree, name);
        if (kept !== null) return kept;
      } else {
        if (!disposable(worktree, name))
          return `gitless leftover has non-disposable content not verified against backup: ${name}`;
        await unlink(path.join(worktree, name));
      }
    }
    await rmdir(path.join(worktree, relative));
    return null;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return `gitless leftover kept at ${relative || '.'}: ${failure.code ?? failure.message}`;
  }
}

/** A recorded backup authorizes finishing a partially completed Git removal,
 * not deleting unarchived work, an arbitrary directory or a redirected parent. */
async function removeAgedLeftover(store: Store, stateDir: string, seat: Seat, marker: AutoPruned): Promise<PruneDecision> {
  const base = { seat: seat.id, worktree: seat.worktree, branch: seat.data.branch as string | null, lost: [] as string[], remove: false };
  const refused = agedMarkerLegacyReason(marker) ?? agedLeftoverScopeReason(stateDir, seat, marker);
  if (refused) return { ...base, reason: refused };
  if (checkoutInUse(store, seat)) return { ...base, reason: 'checkout in use' };
  // Check before touching any bytes, including a dangling .git link.
  if (!lstatSync(seat.worktree!, { throwIfNoEntry: false })?.isDirectory() ||
      lstatSync(path.join(seat.worktree!, '.git'), { throwIfNoEntry: false }))
    return { ...base, reason: 'leftover is no longer a gitless directory' };
  const kept = await unarchivedLeftover(seat.worktree!);
  if (kept !== null) return { ...base, reason: kept };
  const reason = `resume aged removal: ${marker.reason}`;
  store.updateSeat(seat.id, { data: { worktreeRemoved: true } }, 'seat.pruned', { reason });
  return { ...base, reason, remove: true, lost: Array.isArray(marker.lost) ? marker.lost : [] };
}

/** Hash completed backup files without buffering a potentially large patch in Node. */
async function mirrorBackupIdentity(repo: string, patch: string, untracked?: string): Promise<string> {
  return (await git(repo, undefined, 'hash-object', '--no-filters', '--', patch, ...(untracked ? [untracked] : []))).trim();
}

function dropAgedMirror(store: Store, stateDir: string, seat: Seat, marker: AutoPruned, reason: string): string | null {
  return setAsideAgedBackup(store, stateDir, seat, marker, reason);
}

/** Resume only the recorded final mirror; never regenerate a backup of a half-removed directory. */
async function resumeAgedMirror(store: Store, stateDir: string, seat: Seat, marker: AutoPruned): Promise<PruneDecision | null> {
  const decision = (reason: string, remove = false): PruneDecision =>
    ({ seat: seat.id, worktree: seat.worktree, branch: null, reason, remove, lost: remove ? marker.lost : [] });
  const refused = mirrorNotOwned(stateDir, seat);
  if (refused) return decision(refused);
  const surviving = existsSync(seat.worktree!);
  if (surviving && Array.isArray(marker.lost) && marker.lost.length > 0 && marker.capRule !== 2) {
    const failed = dropAgedMirror(store, stateDir, seat, marker, 'backup marker predates cap rule 2');
    return failed ? decision(failed) : null;
  }
  if (checkoutInUse(store, seat)) {
    memoAgedKeep(store, seat, 'checkout in use');
    return decision('checkout in use');
  }
  const valid = typeof marker.repo === 'string' && path.isAbsolute(marker.repo) &&
    typeof marker.mirrorFingerprint === 'string' && typeof marker.identity === 'string' &&
    (!surviving || marker.identity.split('\0')[2] === 'sha256-v1') && Array.isArray(marker.archived) && typeof marker.backupIdentity === 'string' &&
    marker.patch === path.join(stateDir, 'worktree-backups', `${seat.id}.patch`) && existsSync(marker.patch) &&
    (marker.untracked === undefined || (marker.untracked === path.join(stateDir, 'worktree-backups', `${seat.id}.untracked.tgz`) && existsSync(marker.untracked)));
  if (!valid) {
    const reason = surviving && (typeof marker.identity !== 'string' || marker.identity.split('\0')[2] !== 'sha256-v1')
      ? 'backup marker predates sha256 identity' : 'aged mirror backup marker incomplete or files missing';
    return decision(dropAgedMirror(store, stateDir, seat, marker, reason) ?? reason);
  }
  const repo = marker.repo!;
  const verify = async (): Promise<void> => {
    if (await mirrorBackupIdentity(repo, marker.patch!, marker.untracked) !== marker.backupIdentity)
      throw new Error(`${MIRROR_CHANGED}: backup files changed`);
    if (existsSync(seat.worktree!) && await checkoutIdentity(seat.worktree!, marker.archived!) !== marker.identity)
      throw new Error(`${MIRROR_CHANGED}: checkout changed after backup`);
    const current = store.getSeat(seat.id);
    if (!current || mirrorNotOwned(stateDir, current)) throw new Error('final mirror no longer eligible');
    if (checkoutInUse(store, current)) throw new Error('checkout in use');
  };
  try {
    await verify();
    await removeMirror(repo, seat.worktree!, stateDir, { expected: marker.mirrorFingerprint, keepSnapshot: true,
      ownerRepo: seat.data.repo as string, beforeRemove: verify });
  } catch (error) {
    // Not a byte change: keep the marker, the mirror and the backup. Memoize like a
    // worktree 'lead repo missing' so the sweep does not warn on every pass.
    if (error instanceof LeadRepoMissingError) {
      memoAgedKeep(store, seat, 'lead repo missing');
      return decision('lead repo missing');
    }
    if ((error as Error).message === 'checkout in use') {
      memoAgedKeep(store, seat, 'checkout in use');
      return decision('checkout in use');
    }
    if (!(error as Error).message.startsWith(MIRROR_CHANGED)) throw error;
    return decision(dropAgedMirror(store, stateDir, seat, marker, (error as Error).message) ?? MIRROR_CHANGED);
  }
  const reason = `aged final mirror backed up and removed: ${marker.reason}`;
  store.updateSeat(seat.id, { data: { worktreeRemoved: true } }, 'seat.pruned', { reason });
  return decision(reason, true);
}

/** Daemon only: CLI prune/--older-than still requires landing proof for mirrors. */
export async function pruneAgedMirror(store: Store, stateDir: string, id: string): Promise<PruneDecision> {
  const seat = store.getSeat(id);
  if (!seat) throw new Error(`no seat '${id}'`);
  const kept = (reason: string): PruneDecision => ({ seat: id, worktree: seat.worktree, branch: null, reason, remove: false, lost: [] });
  if (typeof seat.data.host !== 'string') return kept('seat is not a remote coder');
  const refused = mirrorNotOwned(stateDir, seat);
  if (refused) return kept(refused);
  if (checkoutInUse(store, seat)) {
    memoAgedKeep(store, seat, 'checkout in use');
    return kept('checkout in use');
  }
  if (seat.data.autoClosedIdle === true) {
    const age = Date.now() - Date.parse(String(seat.data.closedAt));
    if (!Number.isFinite(age) || age < AGED_AFTER_MS) return kept('idle-closed mirror is less than one day old');
  }
  const prior = seat.data.autoPruned as AutoPruned | undefined;
  if (prior?.checkoutOnly === true) {
    const resumed = await resumeAgedMirror(store, stateDir, seat, prior);
    if (resumed) return resumed;
  }
  const capReason = capRetryReason(seat);
  if (capReason) return kept(capReason);
  const { decision } = await judgeMirror(stateDir, seat);
  if (decision.remove) return pruneMirror(store, stateDir, seat);
  if (!/^(?:mirror change is not landed:|ignored files require inspection:|lead repo missing$)/.test(decision.reason)) return decision;
  let basis = typeof seat.data.autoPruneAgeBase === 'string' ? seat.data.autoPruneAgeBase : null;
  if (!basis) {
    basis = typeof seat.data.closedAt === 'string' ? seat.data.closedAt : seat.updated_at;
    store.updateSeat(id, { data: { autoPruneAgeBase: basis } }, 'seat.auto_prune_age_recorded', { reason: decision.reason });
  }
  const age = Date.now() - Date.parse(basis);
  if (!Number.isFinite(age) || age < AGED_AFTER_MS) return decision;
  if (!lstatSync(seat.worktree!, { throwIfNoEntry: false })?.isDirectory()) return decision;
  let marker: AutoPruned;
  try {
    const resolved = await coderRepo(seat);
    // Capture the file set before the audit: a later new unsafe file must not
    // enter the identity while being absent from the archive plan.
    const fingerprint = (await mirrorState(seat.worktree!)).fingerprint;
    const auditIdentity = await checkoutIdentity(seat.worktree!, []);
    const found = await audit(seat.worktree!, resolved.repo, seat.data.base as string, resolved.ref);
    const plan = await planArchive(seat.worktree!, found);
    if (plan.untrackedOverCap !== null) return kept(recordCapKeep(store, seat, plan.untrackedOverCap));
    const identity = await checkoutIdentity(seat.worktree!, plan.names, auditIdentity);
    const backup = await backupCheckout(stateDir, seat, plan.names);
    // Parse the complete patch and gzip archive before recording permission to remove.
    await git(resolved.repo, undefined, 'apply', '--numstat', '--allow-empty', backup.patch);
    if (backup.untracked) await exec('tar', ['-tzf', path.basename(backup.untracked)],
      { cwd: path.dirname(backup.untracked), timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
    marker = { reason: decision.reason, tip: null, head: await leadHead(resolved.repo, resolved.ref), lost: plan.lost,
      at: new Date().toISOString(), checkoutOnly: true, capRule: 2, repo: resolved.repo, ref: resolved.ref,
      patch: backup.patch, identity, archived: plan.names, mirrorFingerprint: fingerprint,
      backupIdentity: await mirrorBackupIdentity(resolved.repo, backup.patch, backup.untracked ?? undefined),
      ...(backup.untracked ? { untracked: backup.untracked } : {}) };
  } catch (error) {
    store.updateSeat(id, { data: {} }, 'seat.auto_prune_backup_failed', { reason: (error as Error).message });
    return decision;
  }
  store.updateSeat(id, { data: { autoPruned: marker } }, 'seat.auto_prune_started', { reason: marker.reason });
  return (await resumeAgedMirror(store, stateDir, store.getSeat(id)!, marker)) ?? kept('backup marker predates cap rule 2');
}

/**
 * Remove a closed coder the daemon sweep found landed. A kept seat is judged
 * again once its branch tip or the lead HEAD changed, except unknown verdicts
 * and old proof versions, which are retried. A missing lead repo reads as both
 * null. Lead
 * HEAD and tip are read again right before removal; a move keeps the seat for
 * the next sweep. `afterCheck` is a test seam between the landing check and
 * that second read.
 */
export async function pruneLanded(store: Store, stateDir: string, id: string, afterCheck?: () => Promise<void>): Promise<PruneDecision> {
  const seat = store.getSeat(id);
  if (!seat) throw new Error(`no seat '${id}'`);
  const base = { seat: id, worktree: seat.worktree, branch: seat.data.branch as string | null, remove: false, lost: [] as string[] };
  if (checkoutInUse(store, seat)) return { ...base, reason: 'checkout in use' };
  if (seat.data.autoClosedIdle === true) {
    const age = Date.now() - Date.parse(String(seat.data.closedAt));
    if (!Number.isFinite(age) || age < DAY_MS) return { ...base, reason: 'idle-closed checkout is less than one day old' };
  }
  // A backup-and-remove interrupted between its marker and the deletion
  // resumes from the marker; the branch was never part of the approval.
  const prior = seat.data.autoPruned as AutoPruned | undefined;
  if (seat.status === 'closed' && seat.data.worktreeRemoved !== true && typeof seat.data.host !== 'string' &&
      prior && typeof prior === 'object' && prior.checkoutOnly === true) {
    const resumed = await resumeAged(store, stateDir, seat, prior);
    // A dropped stale marker falls through to the full judgment, fresh backup included.
    if (resumed) return resumed;
  }
  const capReason = capRetryReason(seat);
  if (capReason && typeof seat.data.host !== 'string' && notOwned(stateDir, seat) === null) return { ...base, reason: capReason };
  let resolved: CoderRepo | null = null;
  if (typeof seat.data.repo === 'string' && lstatSync(seat.worktree!, { throwIfNoEntry: false })?.isDirectory()) {
    try { resolved = await coderRepo(seat); }
    catch (error) { if (!(error instanceof LeadRepoMissingError)) throw error; }
  }
  const [tip, head] = resolved ? await Promise.all([branchTip(resolved.repo, `orch/${id}`), leadHead(resolved.repo, resolved.ref)]) : [null, null];
  const kept = seat.data.autoPruneKept as AutoKept | undefined;
  const local = typeof seat.data.host !== 'string';
  // Rejudge old interactive-bound verdicts once. Transient failures are never
  // memoized forever just because HEAD and the branch have not moved. The aged
  // check runs before the memoized keep is returned.
  if (kept?.proofVersion === PROOF_VERSION && !kept.reason.includes('unknown') && !kept.reason.startsWith(BACKUP_OVER_CAP) &&
      kept.tip === tip && kept.head === head) {
    if (local && AGED_KEPT.test(kept.reason)) {
      const aged = await pruneAged(store, stateDir, seat, kept.reason);
      if (aged) return aged;
    }
    return { ...base, reason: kept.reason };
  }
  const decision = await inspectLanded(stateDir, seat);
  if (!decision.remove || head === null) {
    const reason = decision.remove ? 'lead HEAD unavailable' : decision.reason;
    if (!decision.remove && local && AGED_KEPT.test(reason)) {
      const aged = await pruneAged(store, stateDir, seat, reason);
      if (aged) return aged;
    }
    const verdict: AutoKept = { reason, tip, head, proofVersion: PROOF_VERSION };
    store.updateSeat(id, { data: { autoPruneKept: verdict } }, 'seat.auto_prune_kept', { reason });
    return { ...decision, remove: false, reason };
  }
  await afterCheck?.();
  if (!resolved || await leadHead(resolved.repo, resolved.ref) !== head) return { ...decision, remove: false, reason: 'lead HEAD moved during the check' };
  if (await branchTip(resolved.repo, `orch/${id}`) !== tip || tip !== tipAtClose(seat)) return { ...decision, remove: false, reason: 'branch tip moved since close' };
  if (checkoutInUse(store, seat)) return { ...decision, remove: false, reason: 'checkout in use' };
  const auto: AutoPruned = { reason: decision.reason, tip, head, lost: decision.lost, at: new Date().toISOString(), repo: resolved.repo, ref: resolved.ref };
  return removeCoder(store, seat, tip, decision, { data: { autoPruned: auto }, event: 'seat.auto_prune_started' }, resolved.repo);
}

/** `record` marks the removal as started (operator approval or the daemon's automatic decision) before anything is deleted. */
async function removeCoder(store: Store, seat: Seat, tip: string | null, decision: PruneDecision, record: { data: Record<string, unknown>; event: string }, branchRepo = seat.data.repo as string): Promise<PruneDecision> {
  const id = seat.id;
  if (checkoutInUse(store, store.getSeat(id) ?? seat)) return { ...decision, remove: false, reason: 'checkout in use' };
  store.updateSeat(id, { data: record.data }, record.event, { reason: decision.reason });
  if (existsSync(seat.worktree!)) noteCodegraphDaemonStop(await removeWorktree(seat.data.repo as string, seat.worktree!), id, seat.worktree!, store);
  if (tip !== null) {
    if (await branchTip(branchRepo, `orch/${id}`) !== tip) throw new Error(`branch for '${id}' changed during prune`);
    await deleteBranch(branchRepo, `orch/${id}`);
  }
  store.updateSeat(id, { data: { worktreeRemoved: true, branchRemoved: true } }, 'seat.pruned', { reason: decision.reason });
  return decision;
}

/**
 * Regenerable caches a seat checkout accumulates (task 1521). Explicit paths,
 * not DISPOSABLE's basenames: an explicitly configured schema path is a cache, an arbitrary
 * `gen` directory is not.
 */
export const CACHE_DIRS = project.cacheDirs;

/** A seat worktree orch created itself: directly under `stateDir/worktrees`, named after the seat. */
export function ownedWorktree(stateDir: string, seat: Seat): string | null {
  const root = path.join(stateDir, 'worktrees');
  if (!path.isAbsolute(root) || !seat.worktree || seat.worktree !== path.join(root, seat.id) || seat.data.worktreeRemoved) return null;
  const checkout = lstatSync(seat.worktree, { throwIfNoEntry: false });
  return checkout?.isDirectory() ? seat.worktree : null;
}

/** Disk usage of `target` without following a symlink (a link counts as itself). */
async function diskBytes(target: string): Promise<number> {
  const info = await lstat(target);
  let bytes = info.blocks ? info.blocks * 512 : info.size;
  if (!info.isDirectory()) return bytes;
  // Small batches: one Promise.all over a whole tree floods the loop with callbacks (160 ms stalls at 40k files).
  const names = await readdir(target);
  for (let i = 0; i < names.length; i += 16) {
    for (const size of await Promise.all(names.slice(i, i + 16).map((name) => diskBytes(path.join(target, name)).catch(() => 0)))) bytes += size;
  }
  return bytes;
}

export type CacheCleanup = { bytes: number; removed: { path: string; bytes: number }[]; skipped: { path: string; reason: string }[]; codegraphDaemon?: CodegraphDaemonStop };

/**
 * Delete CACHE_DIRS inside `worktree`, or with `dryRun` only measure them.
 * A path is removed only when nothing under it is tracked and Git ignores it
 * (so no untracked source file can sit inside), and no parent component is a
 * symlink (so nothing outside the checkout is reached). A symlinked cache is
 * unlinked, never its target; fs.rm never descends through a link. All async:
 * the daemon's HTTP loop keeps running while gigabytes go (task 1512).
 */
export async function clearCaches(worktree: string, options: { dryRun?: boolean } = {}): Promise<CacheCleanup> {
  const result: CacheCleanup = { bytes: 0, removed: [], skipped: [] };
  for (const relative of CACHE_DIRS) {
    const parts = relative.split('/');
    let parent = worktree;
    let reason: string | null = null;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      const info = await lstat(parent).catch(() => null);
      if (!info) { reason = 'absent'; break; }
      if (!info.isDirectory()) { reason = `${path.relative(worktree, parent)} is not a real directory`; break; }
    }
    const target = path.join(worktree, ...parts);
    if (!reason && !await lstat(target).catch(() => null)) reason = 'absent';
    if (reason === 'absent') continue;
    if (!reason && (await git(worktree, undefined, 'ls-files', '-z', '--', relative)).length) reason = 'contains tracked files';
    if (!reason) {
      try { await git(worktree, undefined, 'check-ignore', '-q', '--', relative); }
      catch (error) {
        if ((error as { code?: unknown }).code !== 1) throw error;
        reason = 'not ignored by Git';
      }
    }
    if (reason) { result.skipped.push({ path: relative, reason }); continue; }
    const bytes = await diskBytes(target).catch(() => 0);
    if (!options.dryRun && relative === '.codegraph') {
      const stopped = await stopCodegraphDaemon(worktree);
      if (stopped.stopped.length || stopped.skipped.length) result.codegraphDaemon = stopped;
    }
    if (!options.dryRun) await rm(target, { recursive: true, force: true });
    result.removed.push({ path: relative, bytes });
    result.bytes += bytes;
  }
  return result;
}

export function parseOlderThan(value: string): number {
  const match = /^([1-9]\d*)(h|d)$/.exec(value);
  if (!match) throw new Error('--older-than needs a positive duration such as 24h or 7d');
  const ms = Number(match[1]) * (match[2] === 'd' ? 86_400_000 : 3_600_000);
  if (!Number.isSafeInteger(ms)) throw new Error('--older-than is too large');
  return ms;
}
