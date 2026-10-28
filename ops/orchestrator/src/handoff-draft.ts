// Read-only projection of orch seats and parsed reports; the lead edits this before memoryctl handoff.
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { contractRole, deliveryReport, parseReport, type ReportRole } from './report.ts';
import { loadConfig } from './config.ts';
import { formatPause, readPauseRecords } from './paused-families.ts';
import type { Seat, Store, Turn } from './store.ts';
import { ROLE_POLICY, landable } from './seats-defs.ts';

const run = promisify(execFile);
const line = (value: unknown, limit = 150): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

// Every subprocess shares one seat budget; a timeout or oversized diff is unknown, never 'not landed'.
const BUDGET_MS = 10_000;
const DRAFT_BUDGET_MS = 15_000;
const MAX_PATCH = 8 * 1024 * 1024;
type LandingBounds = { seatMs: number; gitMs: number; maxPatch: number };
const INTERACTIVE_BOUNDS: LandingBounds = { seatMs: BUDGET_MS, gitMs: 3000, maxPatch: MAX_PATCH };
// The background sweep is serial, not an interactive request. Large checkouts
// need more than 3 s even to produce a small patch; errors still retain the seat.
const SWEEP_BOUNDS: LandingBounds = { seatMs: 120_000, gitMs: 30_000, maxPatch: 64 * 1024 * 1024 };
const MAX_NOTES_PER_SEAT = 3;
const landingCache = new Map<string, string>();
function remember(key: string, value: string): string {
  if (landingCache.size >= 128) landingCache.delete(landingCache.keys().next().value!);
  landingCache.set(key, value);
  return value;
}
// Only exit 1 is an expected negative Git check. Fatal 128, timeout and spawn errors are unknown.
export const gitExitCode = (code: unknown): 1 | null => code === 1 ? 1 : null;
type GitResult = { code: number | null; text: string; failure?: string };
const unknown = (step: string, result: GitResult): string => `unknown (${step}: ${result.failure ?? `git exit ${result.code}`})`;
async function boundedGit(bounds: LandingBounds, repo: string, deadline: number, env: NodeJS.ProcessEnv | undefined, ...args: string[]): Promise<GitResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { code: null, text: '', failure: 'seat deadline exhausted' };
  const timeout = Math.min(bounds.gitMs, remaining);
  try {
    const { stdout } = await run('git', ['-C', repo, ...args], { env, timeout, maxBuffer: bounds.maxPatch });
    return { code: 0, text: stdout };
  } catch (error) {
    const cause = error as Error & { code?: unknown; killed?: boolean; signal?: string; stderr?: string };
    const failure = cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? `output exceeds ${bounds.maxPatch} bytes` :
      cause.killed ? `killed (${cause.signal ?? 'signal'}; timeout ${timeout} ms)` :
        `git exit ${cause.code ?? 'unknown'}: ${line(cause.stderr || cause.message, 240)}`;
    return { code: cause.killed || cause.signal ? null : gitExitCode(cause.code), text: '', failure };
  }
}

export const landedForSweep = (seat: Seat): Promise<string> =>
  landed(seat, Date.now() + SWEEP_BOUNDS.seatMs, SWEEP_BOUNDS);

/** Exact commit ancestry is a cheap first pass; otherwise reverse-check the seat's complete patch in a disposable index. Shared with seats.ts overlap observation. A mode-only diff reverse-applies too, so a seat whose only change is file modes reads as landed (pre-existing). */
export async function landed(seat: Seat, overallDeadline: number, bounds = INTERACTIVE_BOUNDS): Promise<string> {
  const { repo, branch, base } = seat.data;
  if (typeof repo !== 'string' || typeof base !== 'string') return 'unknown (repo/base absent)';
  const deadline = Math.min(Date.now() + bounds.seatMs, overallDeadline);
  const git = (repo: string, deadline: number, env: NodeJS.ProcessEnv | undefined, ...args: string[]) =>
    boundedGit(bounds, repo, deadline, env, ...args);
  const head = await git(repo, deadline, undefined, 'rev-parse', '--verify', 'HEAD');
  if (head.code !== 0) return unknown('lead rev-parse HEAD', head);
  if (typeof branch === 'string') {
    const tip = await git(repo, deadline, undefined, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    if (tip.code === 0 && tip.text.trim() !== base) {
      const before = await git(repo, deadline, undefined, 'merge-base', '--is-ancestor', base, tip.text.trim());
      if (before.code === 0) {
        const reachable = await git(repo, deadline, undefined, 'merge-base', '--is-ancestor', tip.text.trim(), head.text.trim());
        if (reachable.code === 0 && seat.worktree) {
          const [checkedOut, dirty] = await Promise.all([
            git(seat.worktree, deadline, undefined, 'rev-parse', '--verify', 'HEAD'),
            git(seat.worktree, deadline, undefined, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'),
          ]);
          if (checkedOut.code !== 0) return unknown('seat rev-parse HEAD', checkedOut);
          if (dirty.code !== 0) return unknown('seat status', dirty);
          if (checkedOut.code === 0 && checkedOut.text.trim() === tip.text.trim() && dirty.code === 0 && !dirty.text) return 'yes (commit)';
        }
        if (reachable.code === null) return unknown('tip ancestry', reachable);
      } else if (before.code === null) return unknown('base ancestry', before);
    } else if (tip.code === null) return unknown('branch rev-parse', tip); // --quiet returns 1 for an absent ref: still check the worktree.
  }
  if (!seat.worktree) return 'unknown (worktree unavailable)';
  const scratch = await mkdtemp(join(tmpdir(), 'orch-handoff-'));
  try {
    const seatEnv = { ...process.env, GIT_INDEX_FILE: join(scratch, 'seat.index') };
    const leadEnv = { ...process.env, GIT_INDEX_FILE: join(scratch, 'lead.index') };
    // A fresh index holds intent-to-add for untracked files; neither real index is changed.
    const seatIndex = await git(seat.worktree, deadline, seatEnv, 'read-tree', 'HEAD');
    if (seatIndex.code !== 0) return unknown('seat read-tree', seatIndex);
    const intent = await git(seat.worktree, deadline, seatEnv, 'add', '-N', '--', '.');
    if (intent.code !== 0) return unknown('seat add -N', intent);
    const diff = await git(seat.worktree, deadline, seatEnv, 'diff', '--binary', '--no-ext-diff', '--no-renames', base, '--');
    if (diff.code !== 0) return unknown('seat diff --binary', diff);
    if (!diff.text) return 'no changes';
    const key = createHash('sha256').update(repo).update('\0').update(head.text).update('\0').update(diff.text).digest('hex');
    const cached = landingCache.get(key);
    if (cached) return cached;
    const leadIndex = await git(repo, deadline, leadEnv, 'read-tree', 'HEAD');
    if (leadIndex.code !== 0) return unknown('lead read-tree', leadIndex);
    const patch = join(scratch, 'seat.patch');
    await writeFile(patch, diff.text);
    const full = await git(repo, deadline, leadEnv, 'apply', '--cached', '--check', '--reverse', patch);
    if (full.code === 0) return remember(key, 'yes (patch)');
    if (full.code === null) return unknown('combined reverse apply', full);
    const paths = await git(seat.worktree, deadline, seatEnv, 'diff', '--name-only', '-z', '--no-renames', base, '--');
    if (paths.code !== 0) return unknown('seat diff --name-only', paths);
    let matched = 0;
    const files = paths.text.split('\0').filter(Boolean);
    for (const [i, path] of files.entries()) {
      const part = await git(seat.worktree, deadline, seatEnv, 'diff', '--binary', '--no-ext-diff', '--no-renames', base, '--', path);
      if (part.code !== 0) return unknown(`file diff ${path}`, part);
      if (!part.text) return `unknown (file diff ${path}: empty patch)`;
      const filePatch = join(scratch, `file-${i}.patch`);
      await writeFile(filePatch, part.text);
      const check = await git(repo, deadline, leadEnv, 'apply', '--cached', '--check', '--reverse', filePatch);
      if (check.code === null) return unknown(`file reverse apply ${path}`, check);
      if (check.code === 0) matched++;
    }
    const result = matched === files.length ? 'unknown (combined patch conflict)' : matched ? 'partially landed' : 'no';
    return remember(key, result);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

type Report = Record<string, unknown>;
function reportFor(seat: Seat, turns: Turn[]): { report: Report; turnId: string } | null {
  if (!(seat.role in ROLE_POLICY)) return null;
  for (const turn of [...turns].reverse()) {
    if (turn.status !== 'done' || !turn.text) continue;
    const table = seat.role === 'debater' && Array.isArray(seat.data.options) && (seat.data.options as string[]).length
      ? { options: seat.data.options as string[] } : undefined;
    const parsed = parseReport(turn.text, seat.role as ReportRole, [], { stored: true, table });
    if (parsed.ok) return { report: deliveryReport(parsed.report), turnId: turn.id };
  }
  return null;
}

function items(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Run at most four Git probes simultaneously; the deadline applies even when a probe fails. */
export async function mapLandings(
  seats: Seat[], deadline: number,
  check: (seat: Seat, deadline: number) => Promise<string> = landed,
): Promise<Map<string, string>> {
  const states = new Map<string, string>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, seats.length) }, async () => {
    while (next < seats.length) {
      const seat = seats[next++];
      if (Date.now() >= deadline) { states.set(seat.id, 'unchecked (deadline)'); continue; }
      try {
        const state = await check(seat, deadline);
        states.set(seat.id, Date.now() >= deadline ? 'unchecked (deadline)' : state);
      } catch { states.set(seat.id, Date.now() >= deadline ? 'unchecked (deadline)' : 'unknown (git failed)'); }
    }
  }));
  return states;
}

/** `since` is an ISO timestamp or an existing turn id; absent means earliest nonterminal seat, otherwise 12 h ago. */
export async function handoffDraft(store: Store, options: { since?: string; repo?: string; stateDir?: string } = {}): Promise<string> {
  const pauses = readPauseRecords(options.stateDir ?? loadConfig().stateDir).map((record) => formatPause(record));
  const allSeats = store.listSeats();
  const canonical = options.repo ? await realpath(resolve(options.repo)) : null;
  const repoPaths = new Map<string, string | null>();
  if (canonical) {
    await Promise.all([...new Set(allSeats.flatMap((seat) => [seat.data.repo, seat.data.main]).filter((path): path is string => typeof path === 'string'))].map(async (path) => {
      try { repoPaths.set(path, await realpath(path)); } catch { repoPaths.set(path, null); }
    }));
  }
  // A reviewer of a coder worktree snapshot keeps the repository in data.main; either path selects it (task 1605).
  const inRepo = (seat: Seat) => [seat.data.repo, seat.data.main].some((path) => typeof path === 'string' && repoPaths.get(path) === canonical);
  const seats = canonical ? allSeats.filter(inRepo) : allSeats;
  let since: string;
  if (options.since === undefined) {
    since = seats.find((seat) => !['closed', 'failed'].includes(seat.status))?.created_at
      ?? new Date(Date.now() - 12 * 60 * 60_000).toISOString();
  } else if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(options.since) && !Number.isNaN(Date.parse(options.since)) && new Date(options.since).toISOString().slice(0, 19) === options.since.slice(0, 19)) {
    since = new Date(options.since).toISOString();
  } else {
    const turn = store.getTurn(options.since);
    if (!turn) throw new Error('since must be an ISO UTC time or an existing turn id');
    if (options.repo && !seats.some((seat) => seat.id === turn.seat_id)) throw new Error('since turn is outside repo');
    since = turn.created_at;
  }
  const selected = seats.filter((seat) => seat.created_at >= since);
  const groups = new Map<string, Seat[]>();
  for (const seat of selected) {
    // One repository, not one checkout: a reviewer of a coder worktree snapshot groups with its task (task 1605).
    const key = `${seat.data.main ?? seat.data.repo ?? ''}\u0000${seat.title}`;
    groups.set(key, [...(groups.get(key) ?? []), seat]);
  }
  const states = await mapLandings(selected.filter((seat) => landable(seat.role)), Date.now() + DRAFT_BUDGET_MS);
  const landedLines: string[] = [];
  const open: string[] = [];
  const findings: string[] = [];
  for (const group of groups.values()) {
    const title = line(group[0].title, 100);
    for (const seat of group) {
      const turns = store.listTurns(seat.id);
      const source = reportFor(seat, turns);
      const report = source?.report;
      const label = `${title} · ${seat.id}`;
      if (landable(seat.role)) {
        const files = items(report?.changedFiles);
        const state = states.get(seat.id) ?? 'unchecked (deadline)';
        const detail = `${label}: ${seat.status}/${line(report?.status ?? 'no report', 20)} · ${line(seat.data.branch ?? 'no branch', 65)} · ${files.length ? files.map((f) => line(f, 65)).join(', ') : 'files unreported'}`;
        (state.startsWith('yes') ? landedLines : open).push(`- ${detail} · landed ${state}`);
        if (state.startsWith('yes') && ['working', 'provisioning'].includes(seat.status)) open.push(`- ${seat.id}: still ${seat.status}`);
      } else {
        const summary = contractRole(seat.role as ReportRole) === 'reviewer'
          ? `- ${label}: ${seat.role} ${seat.status}/${line(report?.status ?? 'no report', 20)} · ${line(report?.verdict ?? 'no verdict', 20)}`
          : `- ${label}: ${seat.role} ${seat.status}/${line(report?.status ?? 'no report', 20)}`;
        if (['closed', 'done'].includes(seat.status)) {
          if (report) findings.push(summary); // Keep terminal reports/verdicts, but not under Open.
        } else open.push(summary);
      }
      if (seat.status === 'failed' && typeof seat.data.failure === 'string') open.push(`- ${seat.id}: failed — ${line(seat.data.failure, 110)}`);
      for (const turn of turns) {
        if (['queued', 'running', 'error', 'interrupted', 'cancelled'].includes(turn.status)) {
          open.push(`- ${turn.id}: ${turn.status}${turn.error ? ` — ${line(turn.error, 110)}` : ''}`);
        }
      }
      const notes: string[] = [];
      if (typeof report?.forLead === 'string') notes.push(`- ${seat.id} [hypothesis] forLead: ${line(report.forLead, 180)}`);
      for (const note of items(report?.notChecked)) notes.push(`- ${seat.id} [hypothesis] notChecked: ${line(note, 140)}`);
      if (Array.isArray(report?.findings)) {
        for (const finding of report.findings) {
          if (!finding || typeof finding !== 'object') continue;
          const body = `${finding.claim} — ${finding.evidence}`.replace(/\s+/g, ' ').trim();
          if (finding.reproduced === false && finding.severity !== 'withdrawn') {
            findings.push(`- ${seat.id} [suggestion] ${body} (inferred; not reproduced)`);
            continue;
          }
          const prefix = `- ${seat.id} ${finding.reproduced === true ? '[observed]' : '[hypothesis]'} ${finding.reproduced === true ? 'reproduced ' : ''}${finding.severity}: `;
          if (finding.severity === 'blocker' || finding.severity === 'major') findings.push(prefix + body);
          else notes.push(prefix + line(body, 180));
        }
      }
      for (const check of items(report?.checked)) notes.push(`- ${seat.id} [hypothesis] checked: ${line(check, 140)}`);
      findings.push(...notes.slice(0, MAX_NOTES_PER_SEAT));
      if (notes.length > MAX_NOTES_PER_SEAT) findings.push(`- ${seat.id}: +${notes.length - MAX_NOTES_PER_SEAT} more notes`);
      if (Array.isArray(report?.checks)) {
        for (const check of report.checks) {
          if (!check || typeof check !== 'object') continue;
          findings.push(`- ${seat.id} [hypothesis] check: ${line(check.command, 70)} · ${line(check.result, 20)} · ${line(check.tail, 80)}`);
        }
      }
    }
  }
  return [`# Handoff draft (orch only; edit before memoryctl handoff)`, ``, `## State`,
    `Since ${since}; ${selected.length} seats${options.repo ? ` in ${options.repo}` : ''}. Landing = exact commit ancestor or reverse-applicable seat diff against HEAD in disposable indexes; partial means some files match. Unknown is not landed.`,
    `Paused families: ${pauses.length ? pauses.join('; ') : 'none'}.`,
    ``, `## Landed`, ...landedLines, ``, `## Open`, ...open, ``, `## Seat findings worth memory`, ...findings].join('\n').trimEnd() + '\n';
}
