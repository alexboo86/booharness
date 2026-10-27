// How each family, model and effort did in each seat role. Read-only: no router
// journal, provider, switch or store writes. The aggregate is shared with router
// stats so those files can be removed without taking this table with them.
import type { DatabaseSync } from 'node:sqlite';
import { reviewedCoders, usageParts } from './pick-stats.ts';
import { accountingRole } from './profiles.ts';
import { parseReport, type ReportRole } from './report.ts';
import { TERMINAL_TURN } from './store.ts';

/** Sample count is `seats` because each router-stats sample is one seat. */
export type RoleGroup = { seats: number; rated: number; meanScore: number | null; meanTokens: number | null; medianSeconds: number | null };
export type Sample = { score: number | null; tokens: number | null; seconds: number | null };
export const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const mean = (values: number[]) => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;

export function aggregate(samples: Sample[]): RoleGroup {
  const scores = samples.map((s) => s.score).filter(known);
  const seconds = samples.map((s) => s.seconds).filter(known).sort((a, b) => a - b);
  const mid = Math.floor(seconds.length / 2);
  return { seats: samples.length, rated: scores.length, meanScore: mean(scores),
    meanTokens: mean(samples.map((s) => s.tokens).filter(known)),
    medianSeconds: seconds.length ? seconds.length % 2 ? seconds[mid] : (seconds[mid - 1] + seconds[mid]) / 2 : null };
}

/** A coder seat a reviewer blocked with a reproduced blocker keeps this share of its score. */
const BLOCKED_SCORE_FACTOR = 0.25;

/**
 * First-turn score for a graded report. Inlined so this table has no import for it.
 */
function turnScore(turnStatus: string | null, reportStatus: string | null, grade: { status?: unknown; realReport?: unknown; evidenceSupports?: unknown } | null): number | null {
  if (turnStatus === 'error' || turnStatus === 'interrupted') return 0;
  if (turnStatus === 'cancelled') return null;
  if (grade?.status !== 'graded' || typeof grade.realReport !== 'number' || !Number.isFinite(grade.realReport)) return null;
  const supports = Array.isArray(grade.evidenceSupports) ? grade.evidenceSupports.filter((item) => typeof item === 'number' && Number.isFinite(item)) : [];
  const supportMean = supports.length ? supports.reduce((sum, item) => sum + item, 0) / supports.length : 1;
  const score = Math.min(1, Math.max(0, grade.realReport * supportMean));
  return reportStatus === 'partial' ? score / 2 : score;
}

function coderScore(score: number | null, blocked: boolean): number | null {
  return score === null ? null : score * (blocked ? BLOCKED_SCORE_FACTOR : 1);
}

/** Stable --json contract. since is inclusive and until exclusive, both on turns.created_at.
 * roles omits a role with no started turn in the window. model and effort are null when the
 * seat did not record a string. failOrNoReport is the share of turns that failed (error or
 * interrupted) or gave no valid stored report. meanScore, meanTokens and medianSeconds are
 * the pace aggregate: a null score is not averaged, and missing usage is not a zero.
 * seats is distinct seats; rated is distinct seats with a finite score. */
export type RoleStatsRow = {
  family: string; model: string | null; effort: string | null;
  seats: number; rated: number; turns: number;
  meanScore: number | null; meanTokens: number | null; medianSeconds: number | null;
  failOrNoReport: number;
};
export type RoleStats = { since: string; until: string; roles: { role: string; rows: RoleStatsRow[] }[] };
type Source = { seat: string; role: string; family: string; data: string; status: string | null; text: string | null; usage: string | null; duration_ms: number | null; grade: string | null };

function storedReport(role: string, status: string | null, text: string | null, table?: { options: string[] }): { ok: boolean; status: string | null } {
  if (status !== 'done' || text === null) return { ok: false, status: null };
  try {
    const parsed = parseReport(text, role as ReportRole, [], { stored: true, table });
    if (!parsed.ok) return { ok: false, status: null };
    return { ok: true, status: typeof parsed.report.status === 'string' ? parsed.report.status : null };
  } catch {
    // A role with no report schema cannot have given a valid report.
    return { ok: false, status: null };
  }
}

export function roleStats(db: DatabaseSync, since: string, until: string): RoleStats {
  if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until))) throw new Error('since and until must be ISO timestamps');
  const { blocked } = reviewedCoders(db);
  const rows = db.prepare(`SELECT s.id AS seat, s.role, s.family, s.data, t.status, t.text, t.usage, t.duration_ms, r.body AS grade
    FROM turns t JOIN seats s ON s.id = t.seat_id
    LEFT JOIN reports r ON r.turn_id = t.id
    WHERE t.started_at IS NOT NULL AND t.created_at >= ? AND t.created_at < ?`).all(since, until) as Source[];
  type Bucket = { family: string; model: string | null; effort: string | null; samples: Sample[]; seats: Set<string>; rated: Set<string>; invalid: number };
  const byRole = new Map<string, Map<string, Bucket>>();
  for (const row of rows) {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    const model = typeof data.model === 'string' ? data.model : null;
    const effort = typeof data.effort === 'string' ? data.effort : null;
    const table = row.role === 'debater' && Array.isArray(data.options) && (data.options as string[]).length
      ? { options: data.options as string[] } : undefined;
    const report = storedReport(row.role, row.status, row.text, table);
    let grade = null;
    try { grade = row.grade === null ? null : JSON.parse(row.grade); } catch { /* Unknown stored grade. */ }
    let score = turnScore(row.status, report.ok ? report.status : null, grade);
    if (row.role === 'coder') score = coderScore(score, blocked.has(row.seat));
    const ended = row.status !== null && TERMINAL_TURN.has(row.status);
    const parts = ended ? usageParts(row.usage) : null;
    const sample: Sample = { score, tokens: parts ? parts.input + parts.output + parts.cacheRead + parts.cacheWrite : null,
      seconds: ended && known(row.duration_ms) && row.duration_ms >= 0 ? row.duration_ms / 1000 : null };
    const role = accountingRole({ role: row.role, data });
    const buckets = byRole.get(role) ?? new Map<string, Bucket>();
    byRole.set(role, buckets);
    const key = JSON.stringify([row.family, model, effort]);
    const bucket = buckets.get(key) ?? { family: row.family, model, effort, samples: [], seats: new Set(), rated: new Set(), invalid: 0 };
    bucket.samples.push(sample);
    bucket.seats.add(row.seat);
    if (known(score)) bucket.rated.add(row.seat);
    if (row.status === 'error' || row.status === 'interrupted' || !report.ok) bucket.invalid++;
    buckets.set(key, bucket);
  }
  const tie = (a: RoleStatsRow, b: RoleStatsRow) => a.family.localeCompare(b.family)
    || (a.model ?? '').localeCompare(b.model ?? '') || (a.effort ?? '').localeCompare(b.effort ?? '');
  return { since, until, roles: [...byRole].sort(([a], [b]) => a.localeCompare(b)).map(([role, buckets]) => ({
    role,
    rows: [...buckets.values()].map((bucket): RoleStatsRow => {
      const group = aggregate(bucket.samples);
      return { family: bucket.family, model: bucket.model, effort: bucket.effort, seats: bucket.seats.size, rated: bucket.rated.size,
        turns: bucket.samples.length, meanScore: group.meanScore, meanTokens: group.meanTokens, medianSeconds: group.medianSeconds,
        failOrNoReport: bucket.invalid / bucket.samples.length };
    }).sort((a, b) => (a.meanScore === null || b.meanScore === null
      ? a.meanScore === b.meanScore ? tie(a, b) : a.meanScore === null ? 1 : -1
      : b.meanScore - a.meanScore || tie(a, b))),
  })) };
}

export function formatRoleStats(stats: RoleStats): string {
  const number = (value: number | null, digits = 0) => value === null ? '—' : value.toFixed(digits);
  const head = `role-stats ${stats.since}..${stats.until} (turn created_at, started turns)`;
  if (!stats.roles.length) return `${head}\nno turns`;
  return [head, ...stats.roles.map((role) => {
    const lines = [role.role, 'family · model · effort · seats · rated · turns · mean-score · tokens/turn · median-seconds · fail-or-no-report'];
    for (const row of role.rows) lines.push(
      `${row.family} · ${row.model ?? '—'} · ${row.effort ?? '—'} · ${row.seats} · ${row.rated} · ${row.turns} · ${number(row.meanScore, 3)} · ${number(row.meanTokens)} · ${number(row.medianSeconds, 1)} · ${number(row.failOrNoReport * 100, 1)}%`);
    return lines.join('\n');
  })].join('\n\n');
}
