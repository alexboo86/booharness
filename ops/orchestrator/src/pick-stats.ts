// Observations only: this module never participates in family or effort selection.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { domainsOfFiles } from '../../bootstrap/knowledge-page-lib.mjs';
import { type Finding } from './grading.ts';
import { parseReport } from './report.ts';
import { commitOf, firstRecordedLanding, landingCommits, retainedShare, survivalShare, type RetainedShare, type SurvivalShare } from './retained.ts';
import { openReadOnlyStore } from './store.ts';
import { accountingRole } from './profiles.ts';
import { reviewRights } from './seats-defs.ts';
import { projectConfig } from '../../../scripts/lib/harness-config.mjs';

const productRoots = projectConfig().productRoots;

export type Row = {
  family: string; role: string; domain: string;
  turns: number; done: number; error: number; interrupted: number; other: number;
  medianDurationMs: number | null; medianTokens: number | null; medianRealReport: number | null;
  // Review outcomes (decision #11901); null where the role has no such outcome or no data exists.
  /** coder: distinct seats, their turns after each seat's first, seats with a valid reviewer report, and of those the seats with a reproduced blocker. */
  seats: number | null; correctionTurns: number | null; reviewedSeats: number | null; blockedSeats: number | null;
  /** reviewer: one verdict per turn; none = no valid settled report. */
  approve: number | null; requestChanges: number | null; noVerdict: number | null;
};
type Source = { id: string; seat_id: string; family: string; role: string; data: string; status: string; duration_ms: number | null; usage: string | null; grade: string | null; text: string | null; seq: number; first: number };
type RecallRow = { family: string; reviews: number | null; found: number | null; paired: number | null; pairedFound: number | null; missed: number | null; recall: number | null };
/** Blocker/major findings on recall's review set. thin when 0 < n < 5; null when that family has none in the window. */
export type PrecisionRow = { family: string; reproduced: number | null; notReproduced: number | null; n: number | null; precision: number | null; thin: boolean | null };
/** A first review of a coder diff is one trial. Interim cells use reproduced findings when correction paths are unavailable. */
export type ReviewerYieldRow = { family: string; model: string; effort: string | null; domain: string; successes: number; trials: number;
  measure: 'held-up' | 'interim reproduced'; low: number | null; high: number | null; noise: number | null;
  noisyFindings: number; majorFindings: number; reviewTokens: number | null; unknownUsageTurns: number;
  yieldPerMillionTokens: number | null;
  /** Reproduced trials supply the interim measure when correction paths are unavailable. */
  reproducedTrials: number };
/** One row per family/role/model/effort over all domains, each turn once: the seat's recorded model and effort. coder counts seats, corrections and reviewed/blocked seats as in Row. */
export type ProfileRow = { family: string; role: string; model: string | null; effort: string | null; turns: number; done: number; error: number; interrupted: number;
  medianDurationMs: number | null; medianTokens: number | null; medianRealReport: number | null;
  seats: number | null; correctionTurns: number | null; reviewedSeats: number | null; blockedSeats: number | null };
export type Result = { distinctTurns: number; rows: Row[]; reviewerRecall: RecallRow[]; reviewerPrecision: PrecisionRow[];
  reviewerYield: ReviewerYieldRow[]; reviewerInvariant: ReviewerInvariantRow[]; byProfile: ProfileRow[] };
/** Recall, precision and yield of the shared first-review set, split by the seat's first brief (decision #12792); yield reuses the yield table's measure. */
export type ReviewerInvariantRow = { group: 'invariant list' | 'other'; reviews: number; found: number;
  paired: number | null; pairedFound: number | null; missed: number | null; recall: number | null;
  reproduced: number | null; notReproduced: number | null; n: number | null; precision: number | null; thin: boolean | null;
  measure: 'held-up' | 'interim reproduced'; successes: number; yield: number | null };
type Cell = { row: Row; durations: number[]; tokens: number[]; grades: number[]; seats: Set<string> };

const ROUTING = new URL('../../../docs/agent/domain-routing.generated.json', import.meta.url);
/** Fewer blocker/major findings than this is too small to read precision (arXiv 2603.11078: recall and noise move apart). */
const THIN_BELOW = 5;

function median(values: number[]): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/** Parsed token components of a turn's usage, or null when the measurement is missing, malformed or invalid. */
export function usageParts(raw: string | null): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  if (raw === null) return null;
  let usage: Record<string, unknown>;
  try { usage = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
  if (!parts.every((part) => typeof part === 'number' && Number.isFinite(part) && part >= 0)) return null;
  const [input, output, cacheRead, cacheWrite] = parts as number[];
  return { input, output, cacheRead, cacheWrite };
}

function tokens(raw: string | null): number | null {
  const parts = usageParts(raw);
  return parts ? parts.input + parts.output + parts.cacheRead + parts.cacheWrite : null;
}

/** A done turn's valid reviewer report, or null. */
function reviewerReport(status: string, text: string | null): Record<string, unknown> | null {
  if (status !== 'done' || text === null) return null;
  const parsed = parseReport(text, 'reviewer');
  return parsed.ok ? parsed.report : null;
}

/**
 * Coder seats reviewed (a reviewer seat authored against them settled a valid report) and blocked
 * (one such report holds a reproduced blocker). Every reviewer turn counts, whatever --since says:
 * a review lands after the coder turns it judges.
 */
export function reviewedCoders(db: DatabaseSync): { reviewed: Set<string>; blocked: Set<string> } {
  const reviewed = new Set<string>();
  const blocked = new Set<string>();
  const rows = db.prepare(`SELECT s.data, t.status, t.text FROM turns t JOIN seats s ON s.id = t.seat_id
    WHERE s.role = 'reviewer'`).all() as { data: string; status: string; text: string | null }[];
  for (const row of rows) {
    const author = (JSON.parse(row.data) as Record<string, unknown>).author;
    const report = reviewerReport(row.status, row.text);
    if (typeof author !== 'string' || !report) continue;
    reviewed.add(author);
    if ((report.findings as Record<string, unknown>[]).some((finding) => finding.severity === 'blocker' && finding.reproduced === true)) blocked.add(author);
  }
  return { reviewed, blocked };
}

type ReviewTurn = { id: string; seat_id: string; seq: number; status: string; text: string | null; started_at: string | null; usage: string | null; prompt: string };
type Review = {
  family: string; author: string; start: string; findings: Record<string, unknown>[];
  seat: string; turn: ReviewTurn; model: string; effort: string | null; domains: string[];
  found: boolean;
  /** The seat's first-turn prompt carries an invariant list (decision #12792). */
  invariantBrief: boolean;
  /** Indexes an accepted support round withdrew or downgraded from blocker/major. */
  dismissed: number[];
};

/** Indexes of a reviewer turn's findings that an accepted support round withdrew or downgraded from blocker/major. */
function dismissedFindings(data: Record<string, unknown>, turnId: string, findings: Record<string, unknown>[]): number[] {
  const round = (data.supportRounds as Record<string, { asked?: { finding: number; severity: string }[]; outcome?: string }> | undefined)?.[turnId];
  return round?.outcome === 'corrected' && Array.isArray(round.asked)
    ? round.asked.flatMap((asked) => {
      if (asked.severity !== 'blocker' && asked.severity !== 'major') return [];
      const finding = findings[asked.finding];
      return !finding || (finding.severity !== 'blocker' && finding.severity !== 'major') ? [asked.finding] : [];
    })
    : [];
}

/**
 * A brief counts as an invariant-list brief (decision #12792) when it mentions invariants and
 * numbers at least three items, as lines starting 1., 2., 3.
 */
export function isInvariantListBrief(prompt: string): boolean {
  if (!/invariant/i.test(prompt)) return false;
  return prompt.split('\n').filter((line) => /^\s*\d+\.\s/.test(line)).length >= 3;
}

/** First valid reviewer report per seat whose author is a coder. Recall and precision share this set. */
function reviewerReviews(db: DatabaseSync): { families: string[]; bySeat: Map<string, ReviewTurn[]>; reviews: Review[] } {
  const seats = db.prepare('SELECT id, family, role, data FROM seats').all() as { id: string; family: string; role: string; data: string }[];
  const turns = db.prepare('SELECT id, seat_id, seq, status, text, started_at, usage, prompt FROM turns ORDER BY seat_id, seq').all() as ReviewTurn[];
  const bySeat = new Map<string, ReviewTurn[]>();
  for (const turn of turns) {
    if (!bySeat.has(turn.seat_id)) bySeat.set(turn.seat_id, []);
    bySeat.get(turn.seat_id)!.push(turn);
  }
  const coderData = new Map(seats.filter((seat) => seat.role === 'coder').map((seat) => [seat.id, JSON.parse(seat.data) as Record<string, unknown>]));
  const routing = JSON.parse(readFileSync(ROUTING, 'utf8'));
  const reviews = seats.filter((seat) => reviewRights(seat.role)).flatMap((seat) => {
    const data = JSON.parse(seat.data) as Record<string, unknown>;
    const author = data.author;
    if (typeof author !== 'string' || !coderData.has(author)) return [];
    // The first VALID review: a seat whose first turn errored or was interrupted still counts by its later report.
    const first = bySeat.get(seat.id)?.find((turn) => turn.started_at !== null && reviewerReport(turn.status, turn.text) !== null);
    if (!first?.started_at) return [];
    const report = reviewerReport(first.status, first.text);
    if (!report) return [];
    const findings = report.findings as Record<string, unknown>[];
    const dismissed = dismissedFindings(data, first.id, findings);
    const files = coderData.get(author)?.taskFiles;
    const domains = domainsOfFiles(Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [], routing);
    // The seat's first-turn prompt is its brief, even when that first turn errored before the first valid review.
    const brief = bySeat.get(seat.id)?.[0]?.prompt ?? '';
    return [{ family: seat.family, author, start: first.started_at, findings, dismissed,
      seat: seat.id, turn: first, model: typeof data.model === 'string' ? data.model : 'unknown',
      effort: typeof data.effort === 'string' ? data.effort : null, domains: domains.length ? domains : ['none'],
      found: findings.some((finding) => finding.severity === 'blocker' && finding.reproduced === true),
      invariantBrief: isInvariantListBrief(brief) }];
  });
  return { bySeat, reviews, families: [...new Set(seats.filter((seat) => reviewRights(seat.role)).map((seat) => seat.family))].sort() };
}

/** Reviews paired on the same coder diff before any correction; indexes into the review list. */
function recallPairs(bySeat: Map<string, ReviewTurn[]>, reviews: Review[]): { paired: Set<number>; missed: Set<number> } {
  const paired = new Set<number>();
  const missed = new Set<number>();
  for (let i = 0; i < reviews.length; i++) {
    for (let j = i + 1; j < reviews.length; j++) {
      const a = reviews[i], b = reviews[j];
      if (a.author !== b.author) continue;
      const [early, late] = a.start <= b.start ? [a, b] : [b, a];
      // Both reviewers must start before the first coder correction after the earlier review.
      if ((bySeat.get(a.author) ?? []).some((turn) => turn.started_at && turn.started_at > early.start && turn.started_at <= late.start)) continue;
      paired.add(i); paired.add(j);
      if (!a.found && b.found) missed.add(i);
      if (!b.found && a.found) missed.add(j);
    }
  }
  return { paired, missed };
}

/** One first started turn per reviewer seat; pairing uses coder turn starts, never report arrival order. */
function reviewerRecall(db: DatabaseSync, since?: string): RecallRow[] {
  const { families, bySeat, reviews } = reviewerReviews(db);
  const { paired, missed } = recallPairs(bySeat, reviews);
  return families.map((family) => {
    const indexes = reviews.flatMap((review, i) => review.family === family && (!since || review.start >= since) ? [i] : []);
    const pairedIndexes = indexes.filter((i) => paired.has(i));
    const pairedFound = pairedIndexes.filter((i) => reviews[i].found).length;
    const missedCount = pairedIndexes.filter((i) => missed.has(i)).length;
    return { family, reviews: indexes.length || null, found: indexes.length ? indexes.filter((i) => reviews[i].found).length : null,
      paired: pairedIndexes.length || null, pairedFound: pairedIndexes.length ? pairedFound : null,
      missed: pairedIndexes.length ? missedCount : null,
      recall: pairedFound + missedCount ? pairedFound / (pairedFound + missedCount) : null };
  });
}

/** Blocker/major reproduction counts on one report; an accepted support round's dismissed index counts as not reproduced. */
function reproductionCounts(review: Review): { reproduced: number; notReproduced: number } {
  const dismissed = new Set(review.dismissed);
  let reproduced = 0;
  let notReproduced = 0;
  for (const [i, finding] of review.findings.entries()) {
    if (dismissed.has(i)) { notReproduced++; continue; }
    if (finding.severity !== 'blocker' && finding.severity !== 'major') continue;
    if (finding.reproduced === true) reproduced++;
    else if (finding.reproduced === false) notReproduced++;
  }
  return { reproduced, notReproduced };
}

/**
 * Blocker and major findings per reviewer family, on the same first reports as recall.
 * An accepted support round that withdrew or downgraded one counts it as not reproduced.
 * n is reproduced + not reproduced; under 5 is thin. No such finding is null, not a zero.
 */
function reviewerPrecision(db: DatabaseSync, since?: string): PrecisionRow[] {
  const { families, reviews } = reviewerReviews(db);
  return families.map((family) => {
    let reproduced = 0;
    let notReproduced = 0;
    for (const review of reviews) {
      if (review.family !== family || (since && review.start < since)) continue;
      const counts = reproductionCounts(review);
      reproduced += counts.reproduced;
      notReproduced += counts.notReproduced;
    }
    const n = reproduced + notReproduced;
    return { family, reproduced: n ? reproduced : null, notReproduced: n ? notReproduced : null,
      n: n || null, precision: n ? reproduced / n : null, thin: n ? n < THIN_BELOW : null };
  });
}

/** Wilson score 95% interval; a cell without trials has no interval. */
function wilson(successes: number, trials: number): [number | null, number | null] {
  if (!trials) return [null, null];
  const z = 1.959963984540054;
  const p = successes / trials;
  const divisor = 1 + z * z / trials;
  const center = (p + z * z / (2 * trials)) / divisor;
  const radius = z * Math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) / divisor;
  // Exact at the edges: floating point left ~1e-16 for 0 successes.
  return [successes === 0 ? 0 : Math.max(0, center - radius), successes === trials ? 1 : Math.min(1, center + radius)];
}

/**
 * One first review's held-up outcome: its reproduced blocker/major findings and whether the
 * coder's correction or a routed recheck established they held. unknown marks the cells where the
 * store lacks per-finding correction paths, so the interim measure can label them.
 */
function reviewOutcome(review: Review, bySeat: Map<string, ReviewTurn[]>, coderData: Map<string, Record<string, unknown>>):
  { reproduced: Finding[]; held: boolean; unknown: boolean } {
  const dismissed = new Set(review.dismissed);
  const reproduced = review.findings.filter((finding, i) => !dismissed.has(i)
    && (finding.severity === 'blocker' || finding.severity === 'major') && finding.reproduced === true) as Finding[];
  const candidates = (bySeat.get(review.author) ?? []).filter((turn) => turn.started_at && turn.started_at > review.start);
  const correction = candidates.sort((a, b) => a.started_at!.localeCompare(b.started_at!))[0];
  // A coder's changedFiles is a self-reported accumulated file set, not the correction delta.
  // The persisted recheck route is derived from the actual git tree delta, but only for reproduced blocker and major findings.
  const results = coderData.get(review.author)?.recheckResults as Record<string, {
    rechecks?: { reviewer: string; turn: string; kind: string }[];
    decisions?: { reviewer: string; reason: string }[];
  }> | undefined;
  const replaced = (bySeat.get(review.seat) ?? []).some((turn) => turn.seq > review.turn.seq
    && turn.started_at && correction?.started_at && turn.started_at < correction.started_at
    && reviewerReport(turn.status, turn.text));
  const decision = !replaced && correction ? results?.[correction.id]?.decisions?.find((entry) => entry.reviewer === review.seat) : undefined;
  const pathHeld = reproduced.some((finding) => finding.severity === 'blocker')
    && (decision?.reason === 'every correction path is named by the blockers'
      || decision?.reason === 'every correction path is named by the blockers or is a test file');
  const pathKnown = pathHeld || decision?.reason === 'the correction changed nothing the reviewer had not seen';
  const routed = new Set(correction ? (results?.[correction.id]?.rechecks ?? [])
    .filter((entry) => entry.reviewer === review.seat && entry.kind === 'same').map((entry) => entry.turn) : []);
  const later = (bySeat.get(review.seat) ?? []).filter((turn) => !replaced && routed.has(turn.id) && turn.seq > review.turn.seq)
    .map((turn) => reviewerReport(turn.status, turn.text)).filter((report) => report !== null);
  const held = reproduced.length > 0 && (pathHeld
    || later.some((report) => !(report!.findings as Finding[]).some((finding) =>
      (finding.severity === 'blocker' || finding.severity === 'major') && finding.reproduced === true)));
  // No persisted per-finding correctionChangedPaths field exists; a route outside these
  // two decisive cases (including for majors) cannot establish a negative.
  const unknown = reproduced.length > 0 && !!correction && !pathKnown && !held;
  return { reproduced, held, unknown };
}

/** Held-up yield accumulators shared by the yield table's cells and the invariant-brief groups. */
type YieldCell = { trials: number; successes: number; reproducedTrials: number; measure: 'held-up' | 'interim reproduced' };
const ZERO_YIELD: YieldCell = { trials: 0, successes: 0, reproducedTrials: 0, measure: 'held-up' };
/** One folded review outcome: held counts as a success, missing path evidence marks the cell interim. */
function yieldFold(cell: YieldCell, { reproduced, held, unknown }: { reproduced: Finding[]; held: boolean; unknown: boolean }): void {
  cell.trials++;
  if (held) cell.successes++;
  if (reproduced.length) cell.reproducedTrials++;
  if (unknown) cell.measure = 'interim reproduced';
}
/** Do not mix confirmed yield with an interim proxy: an interim cell counts its reproduced trials instead. */
function yieldSuccesses(cell: YieldCell): number {
  return cell.measure === 'interim reproduced' ? cell.reproducedTrials : cell.successes;
}

/** First-review yield counts, with the measurement label guarding interim cells. */
export function reviewerYieldCounts(db: DatabaseSync, since?: string): ReviewerYieldRow[] {
  const { bySeat, reviews } = reviewerReviews(db);
  const coderData = new Map((db.prepare("SELECT id, data FROM seats WHERE role = 'coder'").all() as { id: string; data: string }[])
    .map((seat) => [seat.id, JSON.parse(seat.data) as Record<string, unknown>]));
  const cells = new Map<string, ReviewerYieldRow>();
  for (const review of reviews) {
    if (since && review.start < since) continue;
    const dismissed = new Set(review.dismissed);
    const outcome = reviewOutcome(review, bySeat, coderData);
    for (const domain of review.domains) {
      const key = JSON.stringify([review.family, review.model, review.effort, domain]);
      let row = cells.get(key);
      if (!row) {
        row = { family: review.family, model: review.model, effort: review.effort, domain, ...ZERO_YIELD,
          low: null, high: null, noise: null, noisyFindings: 0, majorFindings: 0,
          reviewTokens: null, unknownUsageTurns: 0, yieldPerMillionTokens: null };
        cells.set(key, row);
      }
      yieldFold(row, outcome);
      const reviewTokens = tokens(review.turn.usage);
      if (reviewTokens === null) row.unknownUsageTurns++;
      else row.reviewTokens = (row.reviewTokens ?? 0) + reviewTokens;
      for (const [i, finding] of review.findings.entries()) {
        if (dismissed.has(i)) { row.noisyFindings++; row.majorFindings++; }
        else if (finding.severity === 'blocker' || finding.severity === 'major') {
          if (finding.reproduced === false) row.noisyFindings++;
          if (typeof finding.reproduced === 'boolean') row.majorFindings++;
        }
      }
    }
  }
  return [...cells.values()].map((row) => {
    row.successes = yieldSuccesses(row);
    [row.low, row.high] = wilson(row.successes, row.trials);
    row.noise = row.majorFindings ? row.noisyFindings / row.majorFindings : null;
    row.yieldPerMillionTokens = row.unknownUsageTurns === 0 && row.reviewTokens
      ? row.successes * 1_000_000 / row.reviewTokens : null;
    return row;
  }).sort((a, b) => a.family.localeCompare(b.family) || a.model.localeCompare(b.model)
    || (a.effort ?? '').localeCompare(b.effort ?? '') || a.domain.localeCompare(b.domain));
}

/** Exclusive classes: daemon and product take precedence over mixed sets; unrelated or unavailable paths are unknown. */
export type ChangeClass = 'orch-daemon' | 'product' | 'scripts' | 'docs' | 'unknown';
/**
 * first: a reviewer seat's first valid review, unless orch's recheck router created the seat;
 * recheck-same: a later turn of a reviewer seat that the router queued (recheckResults kind same);
 * recheck-new: the first valid review of a seat the router created to replace a reviewer (data.replaces).
 */
export type ReviewKind = 'first' | 'recheck-same' | 'recheck-new';
/** totalTokens sums known usage and is null when none is known; unknownUsage counts the reviews without it. */
export type ReviewClassRow = { changeClass: ChangeClass; kind: ReviewKind; reviews: number; reviewsWithBlocker: number;
  reproducedBlockers: number; repeatedBlockers: number; newBlockers: number;
  blockersPerReview: number; medianTokens: number | null; totalTokens: number | null; unknownUsage: number };

function changeClass(files: unknown): ChangeClass {
  if (!Array.isArray(files) || !files.length || files.some((file) => typeof file !== 'string' || !file.trim())) return 'unknown';
  const paths = files as string[];
  if (paths.some((file) => file.startsWith('ops/orchestrator/src/'))) return 'orch-daemon';
  if (paths.some((file) => productRoots.some((root) => file.startsWith(`${root}/`)))) return 'product';
  if (paths.every((file) => file.startsWith('scripts/') || file.startsWith('ops/ab-stand/'))) return 'scripts';
  if (paths.every((file) => file.endsWith('.md') || file.startsWith('.agents/') || file.startsWith('docs/'))) return 'docs';
  return 'unknown';
}

/** Review findings store their title in claim and their locations in claim/evidence, not separate fields. */
type BlockerLocation = { file: string; line: number | null };
function blockerLocations(finding: Record<string, unknown>): BlockerLocation[] {
  const text = `${finding.claim ?? ''} ${finding.evidence ?? ''}`;
  const re = /(?:^|[\s`'"(=])((?:(?:[A-Za-z]:)?[\\/]|\.\/)?(?:[\w.+~@-]+[\\/])*[\w.+~@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|rs|py|go|md|json|toml|yml|yaml|css|sql|sh|txt|html|vue|xml|svg|mdx))(?::(\d{1,7})(?:-\d{1,7})?)?(?![\w])/g;
  return [...text.matchAll(re)].map((match) => {
    let file = match[1].replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '');
    const worktree = file.indexOf('/worktrees/');
    if (worktree >= 0) {
      const rest = file.slice(worktree + '/worktrees/'.length);
      const slash = rest.indexOf('/');
      if (slash > 0) file = rest.slice(slash + 1);
    }
    return { file, line: match[2] === undefined ? null : Number(match[2]) };
  });
}

function sameBlocker(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const left = blockerLocations(a), right = blockerLocations(b);
  const words = (finding: Record<string, unknown>) => new Set(String(finding.claim ?? '').toLowerCase()
    .replace(/(?:[\w.+~@-]+[\\/])+[\w.+~@-]+\.[a-z0-9]+(?::\d+)?/gi, ' ')
    .match(/[\p{L}\p{N}]+/gu) ?? []);
  return left.some((x) => right.some((y) => {
    // Citations may be bare, repo-relative or absolute; require a whole path segment, not a character suffix.
    if (x.file !== y.file && !x.file.endsWith(`/${y.file}`) && !y.file.endsWith(`/${x.file}`)) return false;
    if (x.line !== null && y.line !== null) return Math.abs(x.line - y.line) <= 10;
    if (x.line !== null || y.line !== null) return false;
    const aWords = words(a), bWords = words(b);
    return aWords.size > 0 && bWords.size > 0
      && [...aWords].filter((word) => bWords.has(word)).length * 2 >= Math.max(aWords.size, bWords.size);
  }));
}

/**
 * Reviews per class and kind; changedFiles are from the latest settled coder report before each review.
 * A same-seat recheck turn without a valid report is not a review; its seat's later turns the router did not queue are not counted.
 */
export function reviewYieldByClass(db: DatabaseSync, since?: string): ReviewClassRow[] {
  const { bySeat, reviews } = reviewerReviews(db);
  const seatData = new Map((db.prepare("SELECT id, data FROM seats WHERE role IN ('coder', 'reviewer')").all() as { id: string; data: string }[])
    .map((seat) => [seat.id, JSON.parse(seat.data) as Record<string, unknown>]));
  const items: { author: string; start: string; turn: ReviewTurn; findings: Record<string, unknown>[]; dismissed: number[]; kind: ReviewKind }[] =
    reviews.map((review) => ({ ...review, kind: typeof seatData.get(review.seat)?.replaces === 'string' ? 'recheck-new' : 'first' }));
  // Same-seat rechecks as queueRechecks (seats.ts) records them on the coder, keyed by correction turn.
  const turnById = new Map([...bySeat.values()].flat().map((turn) => [turn.id, turn]));
  const firstTurn = new Map(reviews.map((review) => [review.seat, review.turn]));
  const seen = new Set<string>();
  for (const review of reviews) {
    if (seen.has(review.author)) continue;
    seen.add(review.author);
    const results = seatData.get(review.author)?.recheckResults as Record<string, { rechecks?: { reviewer: string; turn: string; kind: string }[] }> | undefined;
    for (const recheck of Object.values(results ?? {}).flatMap((entry) => entry.rechecks ?? [])) {
      const turn = turnById.get(recheck.turn);
      const first = firstTurn.get(recheck.reviewer);
      if (recheck.kind !== 'same' || !turn?.started_at || turn.seat_id !== recheck.reviewer || !first || turn.seq <= first.seq) continue;
      const report = reviewerReport(turn.status, turn.text);
      if (!report) continue;
      const findings = report.findings as Record<string, unknown>[];
      items.push({ author: review.author, start: turn.started_at, turn, findings,
        dismissed: dismissedFindings(seatData.get(recheck.reviewer) ?? {}, turn.id, findings), kind: 'recheck-same' });
    }
  }
  const order: ChangeClass[] = ['orch-daemon', 'product', 'scripts', 'docs', 'unknown'];
  const kinds: ReviewKind[] = ['first', 'recheck-same', 'recheck-new'];
  const cells = new Map<string, { row: ReviewClassRow; usages: number[] }>();
  const history = new Map<string, { start: string; earlier: Record<string, unknown>[]; current: Record<string, unknown>[] }>();
  // Compare in start order, including history outside the display window. Equal-start reviews are not earlier.
  items.sort((a, b) => a.start.localeCompare(b.start) || a.turn.id.localeCompare(b.turn.id));
  for (const item of items) {
    const reproduced = item.findings.filter((finding, index) => !item.dismissed.includes(index)
      && finding.severity === 'blocker' && finding.reproduced === true);
    let prior = history.get(item.author);
    if (!prior) {
      prior = { start: item.start, earlier: [], current: [] };
      history.set(item.author, prior);
    } else if (prior.start !== item.start) {
      prior.earlier.push(...prior.current);
      prior.current = [];
      prior.start = item.start;
    }
    const repeated = item.kind === 'first' ? 0 : reproduced.filter((finding) => prior.earlier.some((old) => sameBlocker(finding, old))).length;
    prior.current.push(...reproduced);
    if (since && item.start < since) continue;
    const coder = [...(bySeat.get(item.author) ?? [])].reverse().find((turn) =>
      turn.started_at && turn.started_at <= item.start && turn.status === 'done' && turn.text
      && parseReport(turn.text, 'coder', [], { stored: true }).ok);
    const parsed = coder?.text ? parseReport(coder.text, 'coder', [], { stored: true }) : null;
    const changed = changeClass(parsed?.ok ? parsed.report.changedFiles : null);
    const key = `${changed}/${item.kind}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { row: { changeClass: changed, kind: item.kind, reviews: 0, reviewsWithBlocker: 0, reproducedBlockers: 0, repeatedBlockers: 0, newBlockers: 0,
        blockersPerReview: 0, medianTokens: null, totalTokens: null, unknownUsage: 0 }, usages: [] };
      cells.set(key, cell);
    }
    const blockers = reproduced.length;
    cell.row.repeatedBlockers += repeated;
    cell.row.newBlockers += blockers - repeated;
    cell.row.reviews++;
    cell.row.reviewsWithBlocker += Number(blockers > 0);
    cell.row.reproducedBlockers += blockers;
    const count = tokens(item.turn.usage);
    if (count === null) cell.row.unknownUsage++;
    else cell.usages.push(count);
  }
  return order.flatMap((changed) => kinds.map((kind) => cells.get(`${changed}/${kind}`)).filter((cell) => cell !== undefined)).map(({ row, usages }) =>
    ({ ...row, blockersPerReview: row.reproducedBlockers / row.reviews, medianTokens: median(usages),
      totalTokens: usages.length ? usages.reduce((sum, count) => sum + count, 0) : null }));
}

/**
 * The same first reviews as recall, precision and yield, split by whether the reviewer seat's first-turn
 * brief carries an invariant list (decision #12792): mentions invariants and numbers 3+ items.
 * Definitions are unchanged; only the grouping is new. n < 5 is thin, like the precision table;
 * each group's yield is folded by the yield table's cell code. Recall and precision groups sum to their
 * totals; yield groups do not: a group folds its reviews into one cell (a mixed group is interim), while
 * the yield table has one cell per family/model/effort/domain and counts a multi-domain review per domain.
 */
export function reviewerInvariantGroups(db: DatabaseSync, since?: string): ReviewerInvariantRow[] {
  const { bySeat, reviews } = reviewerReviews(db);
  const coderData = new Map((db.prepare("SELECT id, data FROM seats WHERE role = 'coder'").all() as { id: string; data: string }[])
    .map((seat) => [seat.id, JSON.parse(seat.data) as Record<string, unknown>]));
  const { paired, missed } = recallPairs(bySeat, reviews);
  const cells: Record<'invariant list' | 'other', { found: number; paired: number; pairedFound: number; missed: number;
    reproduced: number; notReproduced: number } & YieldCell> = {
    'invariant list': { found: 0, paired: 0, pairedFound: 0, missed: 0, reproduced: 0, notReproduced: 0, ...ZERO_YIELD },
    other: { found: 0, paired: 0, pairedFound: 0, missed: 0, reproduced: 0, notReproduced: 0, ...ZERO_YIELD },
  };
  for (const [i, review] of reviews.entries()) {
    if (since && review.start < since) continue;
    const cell = cells[review.invariantBrief ? 'invariant list' : 'other'];
    if (review.found) cell.found++;
    if (paired.has(i)) {
      cell.paired++;
      if (review.found) cell.pairedFound++;
      if (missed.has(i)) cell.missed++;
    }
    const counts = reproductionCounts(review);
    cell.reproduced += counts.reproduced;
    cell.notReproduced += counts.notReproduced;
    yieldFold(cell, reviewOutcome(review, bySeat, coderData));
  }
  return (['invariant list', 'other'] as const).map((group) => {
    const cell = cells[group];
    const n = cell.reproduced + cell.notReproduced;
    const successes = yieldSuccesses(cell);
    return { group, reviews: cell.trials, found: cell.found,
      paired: cell.paired || null, pairedFound: cell.paired ? cell.pairedFound : null, missed: cell.paired ? cell.missed : null,
      recall: cell.pairedFound + cell.missed ? cell.pairedFound / (cell.pairedFound + cell.missed) : null,
      reproduced: n ? cell.reproduced : null, notReproduced: n ? cell.notReproduced : null,
      n: n || null, precision: n ? cell.reproduced / n : null, thin: n ? n < THIN_BELOW : null,
      measure: cell.measure, successes, yield: cell.trials ? successes / cell.trials : null };
  });
}

/** Read-only file adapter: no migration or write access. */
export function readReviewYieldByClass(file: string, since?: string): ReviewClassRow[] {
  const db = openReadOnlyStore(file);
  try { return reviewYieldByClass(db, since); }
  finally { db.close(); }
}

/** since is inclusive on the turn's creation timestamp; a missing measurement is null. */
export function pickStats(db: DatabaseSync, since?: string): Result {
  const routing = JSON.parse(readFileSync(ROUTING, 'utf8'));
  const rows = db.prepare(`SELECT t.id, t.seat_id, s.family, s.role, s.data, t.status, t.duration_ms, t.usage, r.body AS grade, t.text,
      (SELECT MIN(f.seq) FROM turns f WHERE f.seat_id = t.seat_id) AS first, t.seq
    FROM turns t JOIN seats s ON s.id = t.seat_id
    LEFT JOIN reports r ON r.turn_id = t.id
    WHERE (? IS NULL OR t.created_at >= ?)
    ORDER BY t.id`).all(since ?? null, since ?? null) as Source[];
  const { reviewed, blocked } = reviewedCoders(db);
  const seatData = new Map((db.prepare('SELECT id, data FROM seats').all() as { id: string; data: string }[])
    .map((seat) => [seat.id, JSON.parse(seat.data) as Record<string, unknown>]));
  const cells = new Map<string, Cell>();
  const profiles = new Map<string, { row: ProfileRow; durations: number[]; tokens: number[]; grades: number[]; seats: Set<string> }>();
  const distinctTurns = new Set<string>();
  for (const source of rows) {
    const data = JSON.parse(source.data) as Record<string, unknown>;
    const role = accountingRole({ role: source.role, data });
    distinctTurns.add(source.id);
    const model = typeof data.model === 'string' ? data.model : null;
    const effort = typeof data.effort === 'string' ? data.effort : null;
    const profileKey = JSON.stringify([source.family, role, model, effort]);
    let profile = profiles.get(profileKey);
    if (!profile) {
      const coder = source.role === 'coder';
      profile = { row: { family: source.family, role, model, effort, turns: 0, done: 0, error: 0, interrupted: 0,
        medianDurationMs: null, medianTokens: null, medianRealReport: null,
        seats: null, correctionTurns: coder ? 0 : null, reviewedSeats: null, blockedSeats: null }, durations: [], tokens: [], grades: [], seats: new Set() };
      profiles.set(profileKey, profile);
    }
    profile.row.turns++;
    if (source.status === 'done' || source.status === 'error' || source.status === 'interrupted') profile.row[source.status]++;
    if (source.duration_ms !== null && Number.isFinite(source.duration_ms) && source.duration_ms >= 0) profile.durations.push(source.duration_ms);
    const profileTokens = tokens(source.usage);
    if (profileTokens !== null) profile.tokens.push(profileTokens);
    if (source.grade) {
      const grade = JSON.parse(source.grade) as Record<string, unknown>;
      if (grade.status === 'graded' && typeof grade.realReport === 'number' && Number.isFinite(grade.realReport)) profile.grades.push(grade.realReport);
    }
    profile.seats.add(source.seat_id);
    if (source.role === 'coder' && source.seq > source.first) profile.row.correctionTurns!++;
    // taskFiles is the persisted seat-level file set; historical per-turn briefFiles
    // existed only in memory and cannot truthfully be recovered after a restart.
    // A reviewer with an author takes the set of the coder seat it reviews (data.author), even when
    // it persists its own create-time set: reviewers before task 1757 had none, so their domains stay put.
    const taskFiles = reviewRights(source.role) && typeof data.author === 'string' ? seatData.get(data.author)?.taskFiles : data.taskFiles;
    const files = Array.isArray(taskFiles) ? taskFiles.filter((file): file is string => typeof file === 'string') : [];
    const domains = domainsOfFiles(files, routing);
    for (const domain of domains.length ? domains : ['none']) {
      const key = JSON.stringify([source.family, role, domain]);
      let cell = cells.get(key);
      if (!cell) {
        cell = { row: { family: source.family, role, domain, turns: 0, done: 0, error: 0, interrupted: 0, other: 0,
          medianDurationMs: null, medianTokens: null, medianRealReport: null,
          seats: null, correctionTurns: source.role === 'coder' ? 0 : null, reviewedSeats: null, blockedSeats: null,
          ...(reviewRights(source.role) ? { approve: 0, requestChanges: 0, noVerdict: 0 } : { approve: null, requestChanges: null, noVerdict: null }),
        }, durations: [], tokens: [], grades: [], seats: new Set() };
        cells.set(key, cell);
      }
      cell.row.turns++;
      if (source.status === 'done' || source.status === 'error' || source.status === 'interrupted') cell.row[source.status]++;
      else cell.row.other++;
      if (source.duration_ms !== null && Number.isFinite(source.duration_ms) && source.duration_ms >= 0) cell.durations.push(source.duration_ms);
      const count = tokens(source.usage);
      if (count !== null) cell.tokens.push(count);
      if (source.grade) {
        const grade = JSON.parse(source.grade) as Record<string, unknown>;
        if (grade.status === 'graded' && typeof grade.realReport === 'number' && Number.isFinite(grade.realReport)) cell.grades.push(grade.realReport);
      }
      cell.seats.add(source.seat_id);
      if (source.role === 'coder' && source.seq > source.first) cell.row.correctionTurns!++;
      if (reviewRights(source.role)) {
        const verdict = reviewerReport(source.status, source.text)?.verdict;
        if (verdict === 'APPROVE') cell.row.approve!++;
        else if (verdict === 'REQUEST_CHANGES') cell.row.requestChanges!++;
        else cell.row.noVerdict!++;
      }
    }
  }
  const aggregated = [...cells.values()].map((cell) => {
    const coder = cell.row.role === 'coder';
    const seats = [...cell.seats];
    const reviewedSeats = coder ? seats.filter((seat) => reviewed.has(seat)).length : null;
    return { ...cell.row,
      medianDurationMs: median(cell.durations), medianTokens: median(cell.tokens), medianRealReport: median(cell.grades),
      seats: coder ? seats.length : null, reviewedSeats,
      // No reviewed seat: no blocker could have been reproduced, which is not the same as none reproduced.
      blockedSeats: reviewedSeats ? seats.filter((seat) => blocked.has(seat)).length : null,
    };
  }).sort((a, b) => a.family.localeCompare(b.family) || a.role.localeCompare(b.role) || a.domain.localeCompare(b.domain));
  return { distinctTurns: distinctTurns.size, rows: aggregated, reviewerRecall: reviewerRecall(db, since),
    reviewerPrecision: reviewerPrecision(db, since), reviewerYield: reviewerYieldCounts(db, since),
    reviewerInvariant: reviewerInvariantGroups(db, since),
    byProfile: [...profiles.values()].map(({ row, durations, tokens: counts, grades, seats }) => {
      const coder = row.role === 'coder';
      const reviewedSeats = coder ? [...seats].filter((seat) => reviewed.has(seat)).length : null;
      return { ...row, medianDurationMs: median(durations), medianTokens: median(counts), medianRealReport: median(grades),
        seats: coder ? seats.size : null, reviewedSeats, blockedSeats: reviewedSeats ? [...seats].filter((seat) => blocked.has(seat)).length : null };
    }).sort((a, b) => a.role.localeCompare(b.role) || a.family.localeCompare(b.family) || String(a.model).localeCompare(String(b.model)) || String(a.effort).localeCompare(String(b.effort))) };
}

/** A landing younger than this has not aged enough to read survival at HEAD (task 1768). */
export const SURVIVAL_DAYS = 7;
/** Fewer surviving seats than this is too small to read a family's mean survival share. */
export const SURVIVAL_MIN_N = 8;

/** A seat's branch tip equal to its base: the seat left its work uncommitted in the worktree. */
export const NOT_COMMITTED = 'work not committed on branch';
export type RetainedSeat = { seat: string; family: string; commit: string | null; link: 'trailer' | 'record' | 'not landed yet'; survival?: SurvivalShare } & (RetainedShare | { notLandedYet: true });
/** mean share over measured seats; null when none is measured. notCommitted is part of unmeasurable. meanSurvival needs SURVIVAL_MIN_N. */
export type RetainedRow = { family: string; linked: number; trailerLinked: number; recordLinked: number; notLandedYet: number; unmeasurable: number; notCommitted: number; measured: number; meanShare: number | null; young: number; survivalMeasured: number; meanSurvival: number | null };
/** unknownSeats: trailer ids with no coder seat in the store; notes: repositories that could not be read. */
export type Retained = { commits: number; rows: RetainedRow[]; seats: RetainedSeat[]; unknownSeats: string[]; notes: string[] };

/** Seats measured at once (task 3261): ~20 000 git calls one at a time took 6 to 17 minutes. */
const RETAINED_POOL = 8;

/** `work` over `items` with at most `limit` running; results keep the input order. `work` must not throw. */
async function mapPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = await work(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const settle = <T>(promise: Promise<T>): Promise<{ value: T } | { error: Error }> => promise.then((value) => ({ value }), (error: Error) => ({ error }));

/** A seat's landed snapshot, else its branch tip, else the tip recorded at close. */
async function seatTip(repo: string, seat: string, data: Record<string, unknown>): Promise<{ snapshot: string | null; tip: string | null }> {
  const landed = data.landed as { snapshot?: unknown } | undefined;
  const explicit = typeof landed?.snapshot === 'string' ? landed.snapshot : null;
  const snapshot = explicit ?? await commitOf(repo, `refs/orch/landed/${seat}`);
  const branchTip = snapshot ? null : typeof data.branch === 'string' ? await commitOf(repo, `refs/heads/${data.branch}`) : null;
  return { snapshot, tip: snapshot ?? branchTip ?? (typeof data.closedBranchTip === 'string' ? data.closedBranchTip : null) };
}

async function shareOf(repo: string, base: string | null, tip: string | null, commit: string): Promise<RetainedShare> {
  if (!base) return { unmeasurable: 'no base recorded' };
  if (!tip) return { unmeasurable: NOT_COMMITTED };
  const [from, to] = [await commitOf(repo, base), await commitOf(repo, tip)];
  return from && from === to ? { unmeasurable: NOT_COMMITTED } : retainedShare({ repo, seatBase: base, seatTip: tip, landingCommit: commit });
}

/** One linked seat's retained share and survival; a git failure is a note on the row, never a throw. */
async function measureSeat(seat: string, { family, data }: { family: string; data: Record<string, unknown> }, repo: string, commit: string | null, link: RetainedSeat['link']): Promise<{ entry: RetainedSeat; notes: string[] }> {
  if (!commit) return { entry: { seat, family, commit: null, link, notLandedYet: true }, notes: [] };
  const notes: string[] = [];
  const base = typeof data.base === 'string' ? data.base : null;
  try {
    const { snapshot, tip } = await seatTip(repo, seat, data);
    const share = await shareOf(repo, base, tip, commit);
    const entry: RetainedSeat = { seat, family, commit, link, ...share };
    if (base && tip && 'share' in share) {
      try {
        entry.survival = await survivalShare({ repo, seatBase: base, seatTip: tip, snapshot, landingCommit: commit, days: SURVIVAL_DAYS });
      } catch (error) {
        const cause = (error as Error).message.split('\n')[0];
        notes.push(`${repo} seat ${seat} survival: ${cause}`);
        entry.survival = { unmeasurable: `git failure: ${cause}` };
      }
    }
    return { entry, notes };
  } catch (error) {
    const detail = (error as Error).message.split('\n')[0];
    notes.push(`${repo} seat ${seat}: ${detail}`);
    return { entry: { seat, family, commit, link, unmeasurable: `git failure: ${detail}` }, notes };
  }
}

/**
 * Retained share per coder family (task 1563): each coder seat named in a landing commit's
 * Author/Authors trailer on the HEAD of its main checkout, measured against the latest such
 * commit. Without a trailer, a landing record links the first subsequent touching commit.
 * The seat side prefers its land snapshot, then its branch or close-time tip.
 */
export async function readCoderRetained(file: string): Promise<Retained> {
  const db = openReadOnlyStore(file);
  let coders: Map<string, { family: string; data: Record<string, unknown> }>;
  try {
    coders = new Map((db.prepare("SELECT id, family, data FROM seats WHERE role = 'coder'").all() as { id: string; family: string; data: string }[])
      .map((seat) => [seat.id, { family: seat.family, data: JSON.parse(seat.data) as Record<string, unknown> }]));
  } finally { db.close(); }
  const repos = new Set<string>();
  for (const { data } of coders.values()) {
    const repo = typeof data.main === 'string' ? data.main : typeof data.repo === 'string' ? data.repo : null;
    if (repo) repos.add(repo);
    const landed = data.landed as { into?: unknown } | undefined;
    if (typeof landed?.into === 'string') repos.add(landed.into);
  }
  const latest = new Map<string, { repo: string; commit: string | null; link: RetainedSeat['link'] }>();
  const unknown = new Set<string>();
  const notes: string[] = [];
  let commits = 0;
  // Each step below runs its git calls in a pool and applies the results in the serial order.
  const sorted = [...repos].sort();
  const found = await mapPool(sorted, RETAINED_POOL, (repo) => settle(landingCommits(repo)));
  sorted.forEach((repo, i) => {
    const result = found[i];
    if ('error' in result) { notes.push(`${repo}: ${result.error.message.split('\n')[0]}`); return; }
    commits += result.value.length;
    // Newest first: the first commit naming a seat is the later one.
    for (const { commit, seats } of result.value) for (const seat of seats) {
      if (!coders.has(seat)) unknown.add(seat);
      else if (!latest.has(seat)) latest.set(seat, { repo, commit, link: 'trailer' });
    }
  });
  const recorded = [...coders].flatMap(([seat, { data }]) => {
    if (latest.has(seat)) return []; // An explicit Author(s) trailer always wins.
    const landed = data.landed as { at?: unknown; into?: unknown; paths?: unknown } | undefined;
    if (typeof landed?.into !== 'string' || typeof landed.at !== 'string' || !Array.isArray(landed.paths) || !landed.paths.every((path) => typeof path === 'string')) return [];
    return [{ seat, into: landed.into, at: landed.at, paths: landed.paths as string[] }];
  });
  const records = await mapPool(recorded, RETAINED_POOL, ({ into, at, paths }) => settle(firstRecordedLanding(into, at, paths)));
  recorded.forEach(({ seat, into }, i) => {
    const result = records[i];
    if ('error' in result) notes.push(`${into} seat ${seat}: ${result.error.message.split('\n')[0]}`);
    else latest.set(seat, { repo: into, commit: result.value, link: result.value ? 'record' : 'not landed yet' });
  });
  const measured = await mapPool([...latest], RETAINED_POOL, ([seat, { repo, commit, link }]) => measureSeat(seat, coders.get(seat)!, repo, commit, link));
  const seats: RetainedSeat[] = [];
  for (const { entry, notes: seatNotes } of measured) {
    seats.push(entry);
    notes.push(...seatNotes);
  }
  seats.sort((a, b) => a.family.localeCompare(b.family) || a.seat.localeCompare(b.seat));
  const rows = [...new Set(seats.map((seat) => seat.family))].map((family) => {
    const own = seats.filter((seat) => seat.family === family);
    const shares = own.flatMap((seat) => 'share' in seat ? [seat.share] : []);
    const survivals = own.flatMap((seat) => seat.survival && 'share' in seat.survival ? [seat.survival.share] : []);
    const linked = own.filter((seat) => seat.commit !== null);
    return { family, linked: linked.length, trailerLinked: linked.filter((seat) => seat.link === 'trailer').length,
      recordLinked: linked.filter((seat) => seat.link === 'record').length, notLandedYet: own.length - linked.length,
      unmeasurable: linked.length - shares.length,
      notCommitted: own.filter((seat) => 'unmeasurable' in seat && seat.unmeasurable === NOT_COMMITTED).length,
      measured: shares.length, meanShare: shares.length ? shares.reduce((sum, share) => sum + share, 0) / shares.length : null,
      young: own.filter((seat) => seat.survival && 'young' in seat.survival).length,
      survivalMeasured: survivals.length,
      meanSurvival: survivals.length >= SURVIVAL_MIN_N ? survivals.reduce((sum, share) => sum + share, 0) / survivals.length : null };
  });
  return { commits, rows, seats, unknownSeats: [...unknown].sort(), notes };
}

export function readPickStats(file: string, since?: string): Result {
  const db = openReadOnlyStore(file);
  try { return pickStats(db, since); }
  finally { db.close(); }
}

function formatTable(header: string[], lines: (string | number | null)[][]): string {
  const table = lines.map((line) => line.map((value) => value === null ? 'n/a' : String(value)));
  const widths = header.map((name, i) => Math.max(name.length, ...table.map((line) => line[i].length)));
  return [header, ...table].map((line) => line.map((value, i) => value.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

function formatRetained({ commits, rows, unknownSeats, notes }: Retained): string {
  const table = formatTable(['family', 'linked', 'trailer', 'record', 'not landed yet', 'unmeasurable', 'not committed', 'measured', 'mean share', 'young', 'survival n', 'mean survival'],
    rows.map((row) => [row.family, row.linked, row.trailerLinked, row.recordLinked, row.notLandedYet, row.unmeasurable, row.notCommitted, row.measured, row.meanShare === null ? null : Number(row.meanShare.toFixed(3)),
      row.young, row.survivalMeasured, row.meanSurvival === null ? null : Number(row.meanSurvival.toFixed(3))]));
  return `\ncoder retained share (all landing commits, not --since): added seat lines kept by a trailer-linked or first post-land touching commit; survival is the share of landed countable lines still in HEAD (only landings >= ${SURVIVAL_DAYS}d old, younger are 'young'; mean survival needs n >= ${SURVIVAL_MIN_N})\n${table}\n`
    + `landing commits: ${commits}; trailer seats not in the store: ${unknownSeats.length}${notes.length ? `; unread: ${notes.join('; ')}` : ''}\n`;
}

export function formatPickStats({ rows, distinctTurns, reviewerRecall: recall, reviewerPrecision: precision, reviewerYield: yieldRows, reviewerInvariant: invariantRows, byProfile }: Result, retained?: Retained): string {
  const profileTable = formatTable(['role', 'family', 'model', 'effort', 'turns', 'done', 'error', 'intr', 'med ms', 'med tokens', 'med grade', 'seats', 'corrections', 'reviewed', 'blocked'],
    byProfile.map((row) => [row.role, row.family, row.model, row.effort, row.turns, row.done, row.error, row.interrupted,
      row.medianDurationMs, row.medianTokens, row.medianRealReport, row.seats, row.correctionTurns, row.reviewedSeats, row.blockedSeats]));
  const turns = formatTable(['family', 'role', 'domain', 'turns', 'done', 'error', 'intr', 'other', 'med ms', 'med tokens', 'med grade'],
    rows.map((row) => [row.family, row.role, row.domain, row.turns, row.done, row.error, row.interrupted, row.other,
      row.medianDurationMs, row.medianTokens, row.medianRealReport]));
  const reviews = formatTable(['family', 'role', 'domain', 'seats', 'corrections', 'reviewed', 'blocked', 'approve', 'req changes', 'no verdict'],
    rows.filter((row) => row.role === 'coder' || row.role === 'reviewer').map((row) => [row.family, row.role, row.domain,
      row.seats, row.correctionTurns, row.reviewedSeats, row.blockedSeats, row.approve, row.requestChanges, row.noVerdict]));
  const recallTable = formatTable(['family', 'reviews', 'found', 'paired', 'paired found', 'missed', 'recall on paired'],
    recall.map((row) => [row.family, row.reviews, row.found, row.paired, row.pairedFound, row.missed, row.recall]));
  const precisionTable = formatTable(['family', 'reproduced', 'not reproduced', 'n', 'precision', 'thin'],
    precision.map((row) => [row.family, row.reproduced, row.notReproduced, row.n, row.precision, row.thin ? 'thin' : row.thin === false ? '' : null]));
  const yieldTable = formatTable(['family', 'model', 'effort', 'domain', 'measure', 'successes', 'reviews', 'yield', 'Wilson 95% low', 'high', 'noise', 'review tokens', 'unknown usage', 'yield / 1M tokens'],
    yieldRows.map((row) => [row.family, row.model, row.effort, row.domain, row.measure, row.successes, row.trials,
      row.trials ? Number((row.successes / row.trials).toFixed(3)) : null,
      row.low === null ? null : Number(row.low.toFixed(3)), row.high === null ? null : Number(row.high.toFixed(3)),
      row.noise === null ? null : Number(row.noise.toFixed(3)), row.reviewTokens, row.unknownUsageTurns,
      row.yieldPerMillionTokens === null ? null : Number(row.yieldPerMillionTokens.toFixed(3))]));
  const invariantTable = formatTable(['group', 'reviews', 'found', 'paired', 'missed', 'recall', 'reproduced', 'not reproduced', 'n', 'precision', 'thin', 'measure', 'successes', 'yield'],
    invariantRows.map((row) => [row.group, row.reviews, row.found, row.paired, row.missed, row.recall,
      row.reproduced, row.notReproduced, row.n, row.precision, row.thin ? 'thin' : row.thin === false ? '' : null,
      row.measure, row.successes, row.yield === null ? null : Number(row.yield.toFixed(3))]));
  return `${turns}\n\nreview outcomes: coder seats, turns after each seat's first, seats with a valid review, of them with a reproduced blocker; reviewer verdict per turn\n${reviews}\n`
    + `\nreviewer recall (all domains): first valid reports on coder diffs; paired before coder correction\n${recallTable}\n`
    + `\nreviewer precision (all domains): blocker and major findings on those same first reports; n < 5 is thin\n${precisionTable}\n`
    + `\nreviewer yield by family/model/effort/domain: first valid review per seat; interim reproduced when the store lacks per-finding correctionChangedPaths (coder changedFiles is cumulative self-report); noise = not reproduced or dismissed blocker/major share; review tokens sum known usage, yield / 1M requires all usage known and positive tokens\n${yieldTable}\n`
    + `\nreviewer first briefs with an invariant list (decision #12792): the seat's first-turn prompt mentions invariants and numbers 3+ items; same first reviews, recall/precision definitions as above and the yield table's measure, interim reproduced when the group lacks path evidence; recall and precision groups sum to their totals, yield groups do not sum to the yield table; n < 5 is thin\n${invariantTable}\n`
    + `\nby role/family/model/effort (all domains, each turn once; the seat's recorded model and effort; n/a = not recorded): coder seats, corrections and reviewed/blocked seats as in review outcomes\n${profileTable}\n`
    + (retained ? formatRetained(retained) : '')
    + `distinct turns in range: ${distinctTurns}\na turn counts in every domain of its seat; do not sum cells`;
}
