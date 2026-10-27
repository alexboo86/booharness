// The orch state store: one SQLite file in WAL mode, schema by numbered
// migrations. Every write is a transaction, and `events` is an append-only
// journal enforced by triggers, not by convention.
import { DatabaseSync } from 'node:sqlite';
import type { Family } from './providers/types.ts';
import { accountingRoleSql, lenientMatrix, type ProfileRole } from './profiles.ts';
import { landable } from './seats-defs.ts';
import { quotaUnits, type QuotaParts } from './quota-rates.ts';

type Migration = { version: number; sql: string };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE seats (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        family TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        cwd TEXT,
        worktree TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data))
      );
      CREATE INDEX seats_status ON seats(status);
      CREATE TABLE reports (
        id TEXT PRIMARY KEY,
        seat_id TEXT NOT NULL REFERENCES seats(id),
        turn_id TEXT,
        status TEXT NOT NULL,
        body TEXT NOT NULL CHECK (json_valid(body)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX reports_seat ON reports(seat_id);
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        seat_id TEXT,
        payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload))
      );
      CREATE TRIGGER events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
      CREATE TRIGGER events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
    `,
  },
  {
    // Phase 2: one row per prompt a seat was given. `usage` is the adapter's
    // Usage object, or NULL when the provider reported none for the turn.
    version: 2,
    sql: `
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        seat_id TEXT NOT NULL REFERENCES seats(id),
        seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        text TEXT,
        error TEXT,
        stop_reason TEXT,
        usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
        tools INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        duration_ms INTEGER,
        UNIQUE (seat_id, seq)
      );
      CREATE INDEX turns_status ON turns(status);
    `,
  },
  {
    // Phase 3: what orch's watch did in a turn (steer, interrupt) and whether the turn continued
    // the seat's provider session or started a fresh one, and why (decision #10511).
    version: 3,
    sql: `ALTER TABLE turns ADD COLUMN watch TEXT CHECK (watch IS NULL OR json_valid(watch));`,
  },
  {
    // Operator #12326 (S4a): which lessons a seat's first brief delivered, in full or only in the
    // index, per turn; and, for a full one, what the seat's valid report said it did with it.
    // applied/why stay NULL until a valid report answers, so "not reported" never reads as "not applied".
    version: 4,
    sql: `
      CREATE TABLE lesson_deliveries (
        turn_id TEXT NOT NULL REFERENCES turns(id),
        seat_id TEXT NOT NULL REFERENCES seats(id),
        lesson_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('full', 'indexed')),
        delivered_at TEXT NOT NULL,
        applied INTEGER CHECK (applied IS NULL OR applied IN (0, 1)),
        why TEXT,
        reported_at TEXT,
        PRIMARY KEY (turn_id, lesson_id),
        CHECK (mode = 'full' OR applied IS NULL)
      );
      CREATE INDEX lesson_deliveries_seat ON lesson_deliveries(seat_id);
      CREATE INDEX lesson_deliveries_lesson ON lesson_deliveries(lesson_id);
    `,
  },
  {
    // S4b: capture outcomes and repeats are queryable even before the first proposal.
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS memory_proposal_applications (
        turn_id TEXT NOT NULL REFERENCES turns(id), idx INTEGER NOT NULL,
        state TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', PRIMARY KEY(turn_id, idx)
      );
      CREATE TABLE lesson_repeats (
        turn_id TEXT NOT NULL REFERENCES turns(id), idx INTEGER NOT NULL,
        lesson_id TEXT NOT NULL, seat_id TEXT NOT NULL REFERENCES seats(id),
        PRIMARY KEY(turn_id, idx)
      );
      CREATE INDEX lesson_repeats_lesson ON lesson_repeats(lesson_id);
      CREATE TABLE lesson_repeat_tasks (
        lesson_id TEXT PRIMARY KEY, state TEXT NOT NULL, output TEXT NOT NULL DEFAULT ''
      );
    `,
  },
  {
    // restart --when-idle: the drain flag must outlive a crash, and a queued turn's start
    // args (files, timeout, recheck opt-out, checkout) must outlive the process that queued it.
    version: 6,
    sql: `
      CREATE TABLE daemon_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      ALTER TABLE turns ADD COLUMN pending TEXT CHECK (pending IS NULL OR json_valid(pending));
    `,
  },
  {
    // Task 2139 (plan 14640 D2): the lead chat store. Bindings carry the identity rule (one live
    // binding per handle and per session, enforced by partial unique indexes); posts and receipts
    // are filled by the later slices, created now so the schema version moves once.
    version: 7,
    sql: `
      CREATE TABLE chat_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        to_json TEXT CHECK (to_json IS NULL OR json_valid(to_json)),
        wake INTEGER NOT NULL DEFAULT 0 CHECK (wake IN (0, 1))
      );
      CREATE TABLE chat_bindings (
        handle TEXT NOT NULL,
        session TEXT NOT NULL,
        generation INTEGER NOT NULL,
        bound_at TEXT NOT NULL,
        ended_at TEXT,
        PRIMARY KEY (handle, session, generation)
      );
      CREATE UNIQUE INDEX chat_bindings_live_handle ON chat_bindings(handle) WHERE ended_at IS NULL;
      CREATE UNIQUE INDEX chat_bindings_live_session ON chat_bindings(session) WHERE ended_at IS NULL;
      CREATE TABLE chat_receipts (
        post INTEGER NOT NULL REFERENCES chat_posts(id),
        handle TEXT NOT NULL,
        delivered_at TEXT,
        confirmed_at TEXT,
        tries INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (post, handle)
      );
    `,
  },
  {
    version: 8,
    sql: `ALTER TABLE chat_bindings ADD COLUMN desktop TEXT;`,
  },
  {
    // Defect 2026-10-16: every board poll read and JSON-parsed all ~15k seat rows (42 MB) on the
    // event loop, so /health starved behind the board. The hot reads are bounded queries now, and
    // these indexes serve them: (status, created_at, id) — open seats per status in board order and
    // the newest-first closed page without a sort; (status, updated_at) — seats closed inside a
    // recent window; the expression index on the scout parent — one seat's scouts without a scan.
    // seats_status is covered by seats_status_created, so it goes. IF NOT EXISTS/IF EXISTS keep
    // re-migration idempotent when a rolled-back schema_version row set replays this migration
    // (test-orch-core's v3 fixture): indexes outlive the version rows that record them.
    version: 9,
    sql: `
      CREATE INDEX IF NOT EXISTS seats_status_created ON seats(status, created_at, id);
      CREATE INDEX IF NOT EXISTS seats_status_updated ON seats(status, updated_at);
      CREATE INDEX IF NOT EXISTS seats_scout_parent ON seats(json_extract(data, '$.parent'));
      DROP INDEX IF EXISTS seats_status;
    `,
  },
  {
    // Task 2631: two event-loop stalls left after 2626. doneUsage (each seat pick asks it up to twice per
    // family) sorted every done turn of a family to keep ten: 146 ms for codex on the live store, 0.5 ms
    // walking (status, ended_at, id) newest first. Reviewer siblings read every stored seat (245 ms);
    // (role, title) finds one title's reviewers without the closed history.
    version: 10,
    sql: `
      CREATE INDEX IF NOT EXISTS turns_status_ended ON turns(status, ended_at, id);
      CREATE INDEX IF NOT EXISTS seats_role_title ON seats(role, title);
    `,
  },
  {
    // Task 2640: seatByRequestId (task 2637) matched data.requestId in SQL but without an index, so each
    // request_id create still read the JSON of every stored seat twice: 0.2-0.7 s per read on the live
    // store. The expression must stay byte-identical to the query's for SQLite to use the index.
    version: 11,
    sql: `
      CREATE INDEX IF NOT EXISTS seats_request_id ON seats(json_extract(data, '$.requestId'));
    `,
  },
  {
    // Task 2640: doneUsage keeps only one family's seats of the asked raw role before it walks the
    // newest done turns; this index answers that subquery without reading seat rows.
    version: 12,
    sql: `
      CREATE INDEX IF NOT EXISTS seats_family_role ON seats(family, role);
    `,
  },
  {
    // liveBindingsSeen takes MAX(delivered_at) and MAX(confirmed_at) per live handle on every
    // /api/chat; without a handle-led index each was a full scan (task 2645: 4.4 ms to 0.27 ms).
    version: 13,
    sql: `
      CREATE INDEX IF NOT EXISTS chat_receipts_handle_delivered ON chat_receipts(handle, delivered_at);
      CREATE INDEX IF NOT EXISTS chat_receipts_handle_confirmed ON chat_receipts(handle, confirmed_at);
    `,
  },
  {
    // Task 2640: two hot paths asked which reviewers a coder authored (reviewed() at every coder
    // turn end; the reviewers-of-a-coder recheck read) and matched data.author over every stored
    // seat — 12 ms of JSON reads per ask on a store copy without this index, 0.007 ms with it.
    // The expression must stay byte-identical to the query's for SQLite to use the index.
    version: 14,
    sql: `
      CREATE INDEX IF NOT EXISTS seats_author ON seats(json_extract(data, '$.author'));
    `,
  },
  {
    // Task 2684 slice B (operator decision memory 18545): which lessons a LEAD session was delivered
    // by the domain-lessons hook. A lead has no seat and no turn, so the key is its session id.
    // applied/why stay NULL until the lead answers (main.ts lead-lessons), so "not answered"
    // never reads as "not applied"; only a full delivery may carry an answer, as for seats.
    version: 15,
    sql: `
      CREATE TABLE lead_lesson_deliveries (
        session TEXT NOT NULL,
        lesson_id TEXT NOT NULL,
        file TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('full', 'indexed')),
        delivered_at TEXT NOT NULL,
        applied INTEGER CHECK (applied IS NULL OR applied IN (0, 1)),
        why TEXT,
        PRIMARY KEY (session, lesson_id),
        CHECK (mode = 'full' OR applied IS NULL)
      );
      CREATE INDEX lead_lesson_deliveries_lesson ON lead_lesson_deliveries(lesson_id);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export type Seat = {
  id: string;
  role: string;
  family: string;
  title: string;
  status: string;
  cwd: string | null;
  worktree: string | null;
  created_at: string;
  updated_at: string;
  data: Record<string, unknown>;
};

/** Held setup owns no checkout yet and must not delay a drain exit. */
export function provisioningStarted(seat: Seat): boolean {
  return seat.status === 'provisioning' && seat.data.provisionHeld !== true;
}

export type NewSeat = Omit<Seat, 'created_at' | 'updated_at' | 'cwd' | 'worktree' | 'data'> &
  Partial<Pick<Seat, 'cwd' | 'worktree' | 'data'>>;

/** queued → running → done | error | cancelled | interrupted (the daemon died under it). */
export type TurnStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
export const TERMINAL_TURN: ReadonlySet<string> = new Set(['done', 'error', 'cancelled', 'interrupted']);

export type Turn = {
  id: string;
  seat_id: string;
  seq: number;
  status: TurnStatus;
  prompt: string;
  text: string | null;
  error: string | null;
  stop_reason: string | null;
  usage: Record<string, unknown> | null;
  tools: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  watch: TurnWatchRecord | null;
};

/** Jev's reading of a first coder brief; each feature is a probability, or null when its answer was missing or invalid. */
export type ScopeFeatures = { difficulty: number | null; layer_ui: number | null; layer_rust: number | null; layer_orch: number | null; look: number | null; logic: number | null; defect: number | null; tests_only: number | null };

/**
 * Task 1943: the background Jev reading of a bypassed first coder brief, merged into the turn's persisted
 * scope when it arrives. `score` when Jev judged the brief; `reason` when the gate's own guards declined
 * (cut, blocked or over the Jev input cap). Absent on a Jev failure or a restart mid-request; nothing retries.
 */
export type BypassScope = { score: number; features: ScopeFeatures; model: string | null; at: string } | { reason: string; at: string };

/** Legacy stored shadow ranking: blocked-rate evidence and cached retained share. */
export type ShadowRank = { family: string; model: string; cell: string; n: number; blocked: number; rate: number; low: number; high: number; pBest: number;
  retained?: { meanShare: number | null; measured: number } };

/**
 * Legacy stored shadow family/effort recommendation for a first coder brief; family null when no available family
 * had enough reviewed seats or none is clearly best. `ranking` and `unavailable` (family: why the real coder pick could
 * not take it now) are absent on turns before task 1584.
 */
export type ShadowPick = { family: string | null; effort: string | null; reason: string; basis: { cell: string; n: number; blockedRate: number } | null;
  ranking?: ShadowRank[]; unavailable?: Record<string, string> };

/** Legacy stored reviewer shadow ranking; no longer computed or written. */
export type ReviewerShadowRank = {
  family: Family; model: string; domain: string; successes: number; trials: number; interimTrials: number;
  rate: number; low: number; high: number; pBest: number;
  noise: number | null; noiseLow: number | null; noiseHigh: number | null; veto: string | null;
};

/**
 * Legacy stored shadow pick on a reviewer's first brief (task 1702 slice 3): `candidates` are the families the real reviewer
 * pick could take, `excluded` the others with why; family null when none is clearly best. Never changes the pick.
 */
export type ReviewerShadow = { family: string | null; reason: string; domain: string; candidates: string[]; excluded: Record<string, string>;
  ranking: ReviewerShadowRank[] };

export type TurnWatchRecord = {
  /** continued: the seat's provider session went on; fresh: a new session, with why. Absent for a turn that never ran. */
  session?: { mode: 'continued' | 'fresh' | 'first'; reason: string | null; context: { tokens: number; window: number } | null; model?: string | null };
  /**
   * First coder brief's Jev score or explicit/availability bypass, persisted with this turn. `features`
   * records difficulty and layer probabilities: null when unjudged or bypassed, absent on older turns.
   * `recommendation` is the optional legacy shadow pick, no longer written.
   * `model` is the Jev version that scored it, null when no score was available; absent on older turns.
   */
  scope?: ({ status: 'scored'; score: number } | { status: 'bypassed' | 'unjudged'; reason: string }) & { features?: ScopeFeatures | null; recommendation?: ShadowPick | null; model?: string | null; bypass?: BypassScope };
  /** Optional legacy reviewer shadow pick, no longer written; null when computation failed. */
  reviewerShadow?: ReviewerShadow | null;
  /** What the watch did during the turn, in order. Kind `drift` is no longer written (task 2185); stored rows still carry it. */
  actions?: { kind: 'loop' | 'drift'; detail: string; action: 'steer' | 'interrupt'; at: string; failed?: string; model?: string | null }[];
  /** The turn's tool calls by kind (toolkinds.ts): our instruments, built-ins, shell programs. */
  tools?: Record<string, number>;
};

/** What a queued turn needs to start after a drain restart. Kept after the turn starts; only queued turns read it. */
export type TurnPending = {
  files: string[];
  timeoutMs: number;
  tokenCap?: number;
  /** False when the prompt opted out of automatic rechecks. */
  recheck: boolean;
  checkout?: string;
};

export type TurnEnd = Pick<Turn, 'status' | 'text' | 'error' | 'stop_reason' | 'usage' | 'tools' | 'duration_ms'> & { watch?: TurnWatchRecord | null };

/** A done turn's usage: `tokens` in quota units (quota-rates.ts, task 1998 S1), `raw` in raw tokens; both null without usable counters. */
export type DoneUsage = { role: string; tokens: number | null; raw: number | null };
export type DoneUsageOptions = { role?: string; excludeRole?: string; from?: string; to?: string; limit?: number };

/** One lesson a turn's context delivered; applied/why/reported_at are null until a valid report answers for a full one. */
export type LessonDelivery = { turn_id: string; seat_id: string; lesson_id: string; mode: 'full' | 'indexed'; delivered_at: string;
  applied: boolean | null; why: string | null; reported_at: string | null };

/** One lesson a lead session was delivered by the domain-lessons hook; applied/why are null until the lead answers (a full delivery only). */
export type LeadLessonDelivery = { session: string; lesson_id: string; file: string; mode: 'full' | 'indexed'; delivered_at: string;
  applied: boolean | null; why: string | null };

/** Usage parts reported for a completed turn; incomplete counters cannot calibrate a quota. */
function usageParts(raw: string | null): QuotaParts | null {
  if (raw === null) return null;
  try {
    const usage = JSON.parse(raw) as Record<string, unknown>;
    const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
    return parts.every((part) => typeof part === 'number' && Number.isFinite(part) && part >= 0)
      ? { input: parts[0] as number, output: parts[1] as number, cacheRead: parts[2] as number, cacheWrite: parts[3] as number } : null;
  } catch { return null; }
}

export type DrainStatus = { since: string; running: { seat: string; turn: string }[]; queued: number };

/** Shared lead-facing explanation; never suggest retrying a turn held by restart. */
export function drainWarning(drain: DrainStatus): string {
  return `orch is draining for a restart since ${drain.since.slice(11, 16)} UTC; new turns except scouts and critics stay queued and start automatically after the restart; ${drain.queued} queued, waiting on ${drain.running.length} running turns (${drain.running.map(({ seat, turn }) => `${seat}/${turn}`).join(', ') || 'none'}). Do not close, recreate or re-prompt.`;
}

/** A bounded seat read, each branch an index range scan that leaves the rows it does not need unread.
 * `status` alone is today's exact-status list; with `updatedSince` only rows touched at or after that
 * ISO time (a closed seat's `updated_at` is its close time). `notStatus` returns every other status
 * in the same (created_at, id) order the unbounded read produced. `parent`/`parentIn` select scout
 * seats by their recorded parent via seats_scout_parent, closed scouts included. `{ role, title }`
 * finds one title's seats of that role via seats_role_title; `{ role, author }` finds the seats of
 * that role whose `data.author` names the given seat via seats_author — both closed rows included,
 * in the same (created_at, id) order the unbounded read produced. */
export type SeatQuery = { status: string; updatedSince?: string } | { notStatus: string } | { parent: string } | { parentIn: readonly string[] }
  | { role: string; title: string } | { role: string; author: string };

export type Store = {
  db: DatabaseSync;
  schemaVersion: () => number;
  insertSeat: (seat: NewSeat) => Seat;
  getSeat: (id: string) => Seat | null;
  /** One seat by its stored `data.requestId`, first in the (created_at, id) order the unbounded
   * read produced — the row a request_id create's `.find` picked. A create retry must not parse
   * the closed history (task 2637), so the match runs in SQL like the `parent` bound. */
  seatByRequestId: (requestId: string) => Seat | null;
  /** `data` is merged into the stored object, not replaced. */
  updateSeat: (id: string, patch: Partial<Pick<Seat, 'status' | 'cwd' | 'worktree' | 'data'>>, event?: string, eventData?: Record<string, unknown>) => Seat;
  insertTurn: (seatId: string, prompt: string, initialWatch?: TurnWatchRecord, pending?: TurnPending) => Turn;
  /** Merge start args onto a queued turn (a recheck snapshot is known only after insert). */
  patchPending: (id: string, patch: Partial<TurnPending>) => void;
  pendingOf: (id: string) => TurnPending | null;
  startTurn: (id: string) => Turn;
  finishTurn: (id: string, end: TurnEnd) => Turn;
  getTurn: (id: string) => Turn | null;
  listTurns: (seatId: string) => Turn[];
  /** The error for a missing turn id: when the seat exists, name its turns and how to start one. */
  noTurnError: (id: string) => string;
  /** Newest completed turns of one family, optionally within (from, to]. */
  doneUsage: (family: string, options?: DoneUsageOptions) => DoneUsage[];
  /** Per family: the timestamp of its most recent turn that finished with status done, any role; for the daily-probe rule. */
  lastDoneTurn: () => { family: string; at: string }[];
  /** After a stop: only turns that started a provider died with the process; queued turns await recovery. */
  interruptOrphans: () => { turns: number; seats: number };
  /** `restart --when-idle`. A committed row: a crash cannot drop it. */
  setDrain: (on: boolean) => void;
  draining: () => boolean;
  /** Lead-facing snapshot of a committed drain and the work it holds. */
  drainStatus: () => DrainStatus | null;
  /** One seat list. A string or `SeatQuery` bounds the read; no argument reads every seat ever stored, so a hot path (board, leads, polls) must pass a bound. */
  listSeats: (query?: string | SeatQuery) => Seat[];
  /** The closed history one newest-first page at a time: the page's rows and the closed total, never the rows between pages. */
  closedSeatPage: (offset: number, limit: number) => { seats: Seat[]; total: number };
  /** One bounded page of the prune sweep's closed-seat scan: at most `limit` closed rows leave the
   * index (in the `listSeats('closed')` order), and only sweep candidates — a coder whose checkout
   * is not recorded removed — are JSON-parsed and returned.
   * `next` is the cursor of the last scanned row, or null once the scan is exhausted. */
  pruneCandidatesPage: (after: { created_at: string; id: string } | null, limit: number) =>
    { seats: Seat[]; next: { created_at: string; id: string } | null };
  seatCounts: () => Record<string, number>;
  /** Turns queued or running: a restart interrupts only running turns and resumes queued turns. */
  activeTurns: () => number;
  runningTurns: () => number;
  /** Queued turns in chain order: per seat, then seq. */
  listQueued: () => Turn[];
  /** The Jev grade of a turn's report, kept once so a later read never re-grades (table from schema v1). */
  saveGrade: (turnId: string, seatId: string, grade: Record<string, unknown>) => void;
  getGrade: (turnId: string) => Record<string, unknown> | null;
  /** Log the lessons a turn's first brief delivered (operator #12326); an id in both lists counts as full. */
  recordLessonDelivery: (seatId: string, turnId: string, delivered: { full: readonly string[]; indexed: readonly string[] }) => void;
  /** What a valid report said of each lesson delivered in full; an entry for an id not delivered in full is not stored. */
  recordLessonsApplied: (turnId: string, entries: readonly { id: string; applied: boolean; why: string }[]) => number;
  lessonDeliveries: (turnId: string) => LessonDelivery[];
  /** Log the lessons a lead session was delivered (task 2684); a later full delivery upgrades an
   * indexed row (file and delivered_at refreshed), a full row is never downgraded or rewritten. */
  recordLeadLessonDelivery: (session: string, file: string, lessons: readonly { id: string; mode: 'full' | 'indexed' }[]) => number;
  /** What a lead answered for a lesson delivered in full; an id not delivered in full is not stored. */
  recordLeadLessonApplied: (session: string, lessonId: string, applied: boolean, why: string) => number;
  leadLessonDeliveries: (session: string) => LeadLessonDelivery[];
  appendEvent: (kind: string, payload?: Record<string, unknown>, seatId?: string | null) => void;
  eventCount: () => number;
  close: () => void;
};

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Apply every migration newer than the recorded version. Idempotent. */
export function migrate(db: DatabaseSync): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  return transaction(db, () => {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
    let current = row.v ?? 0;
    if (current > SCHEMA_VERSION) {
      throw new Error(`database schema v${current} is newer than this orch (v${SCHEMA_VERSION}); refusing to run`);
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
      current = migration.version;
    }
    return current;
  });
}

function rowToSeat(row: Record<string, unknown>): Seat {
  return { ...(row as unknown as Seat), data: JSON.parse(String(row.data)) };
}

/** A watch column is a record only when it is a plain object. A scalar or array is not one. */
function plainWatch(raw: unknown): TurnWatchRecord | null {
  if (raw === null || raw === undefined) return null;
  const parsed: unknown = JSON.parse(String(raw));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as TurnWatchRecord;
}

function rowToTurn(row: Record<string, unknown>): Turn {
  const { pending: _pending, ...rest } = row;
  const watch = plainWatch(row.watch);
  return {
    ...(rest as unknown as Turn),
    usage: row.usage === null ? null : JSON.parse(String(row.usage)),
    watch: watch && Object.keys(watch).length ? watch : null,
  };
}

/** Read-only database connection: SQLite may create a -shm sidecar, but never writes the database. */
export function openReadOnlyStore(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function openStore(file: string): Store {
  const db = new DatabaseSync(file);
  // busy_timeout FIRST: switching a fresh file to WAL takes a write lock, and a
  // second connection doing the same with no timeout fails 'database is locked'.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  // FULL, not NORMAL: a committed write must survive the process being killed
  // and the machine losing power, which is the whole point of the store.
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

  const appendEventRaw = (kind: string, payload: Record<string, unknown> = {}, seatId: string | null = null) => {
    db.prepare('INSERT INTO events (ts, kind, seat_id, payload) VALUES (?, ?, ?, ?)').run(
      new Date().toISOString(),
      kind,
      seatId,
      JSON.stringify(payload),
    );
  };

  return {
    db,
    schemaVersion: () => (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v,
    insertSeat: (seat) =>
      transaction(db, () => {
        const now = new Date().toISOString();
        const row: Seat = {
          cwd: null,
          worktree: null,
          data: {},
          ...seat,
          created_at: now,
          updated_at: now,
        };
        db.prepare(
          `INSERT INTO seats (id, role, family, title, status, cwd, worktree, created_at, updated_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(row.id, row.role, row.family, row.title, row.status, row.cwd, row.worktree, row.created_at, row.updated_at, JSON.stringify(row.data));
        appendEventRaw('seat.created', { role: row.role, family: row.family, status: row.status }, row.id);
        return row;
      }),
    getSeat: (id) => {
      const row = db.prepare('SELECT * FROM seats WHERE id = ?').get(id);
      return row ? rowToSeat(row as Record<string, unknown>) : null;
    },
    seatByRequestId: (requestId) => {
      const row = db.prepare("SELECT * FROM seats WHERE json_extract(data, '$.requestId') = ? ORDER BY created_at, id LIMIT 1").get(requestId);
      return row ? rowToSeat(row as Record<string, unknown>) : null;
    },
    updateSeat: (id, patch, event = 'seat.updated', eventData) =>
      transaction(db, () => {
        const row = db.prepare('SELECT * FROM seats WHERE id = ?').get(id);
        if (!row) throw new Error(`no seat '${id}'`);
        const seat = rowToSeat(row as Record<string, unknown>);
        const next: Seat = {
          ...seat,
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
          ...(patch.worktree !== undefined ? { worktree: patch.worktree } : {}),
          data: { ...seat.data, ...(patch.data ?? {}) },
          updated_at: new Date().toISOString(),
        };
        db.prepare('UPDATE seats SET status = ?, cwd = ?, worktree = ?, data = ?, updated_at = ? WHERE id = ?').run(
          next.status, next.cwd, next.worktree, JSON.stringify(next.data), next.updated_at, id,
        );
        appendEventRaw(event, { status: next.status, ...(eventData ?? patch.data ?? {}) }, id);
        return next;
      }),
    insertTurn: (seatId, prompt, initialWatch, pending) =>
      transaction(db, () => {
        const { n } = db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM turns WHERE seat_id = ?').get(seatId) as { n: number };
        const turn: Turn = {
          id: `${seatId}.${n + 1}`, seat_id: seatId, seq: n + 1, status: 'queued', prompt,
          text: null, error: null, stop_reason: null, usage: null, tools: 0, watch: initialWatch ?? null,
          created_at: new Date().toISOString(), started_at: null, ended_at: null, duration_ms: null,
        };
        db.prepare('INSERT INTO turns (id, seat_id, seq, status, prompt, tools, created_at, watch, pending) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)').run(
          turn.id, seatId, turn.seq, turn.status, prompt, turn.created_at, turn.watch ? JSON.stringify(turn.watch) : null, pending ? JSON.stringify(pending) : null,
        );
        appendEventRaw('turn.queued', { turn: turn.id }, seatId);
        return turn;
      }),
    patchPending: (id, patch) =>
      transaction(db, () => {
        const row = db.prepare('SELECT pending FROM turns WHERE id = ?').get(id) as { pending: string | null } | undefined;
        if (!row) throw new Error(`no turn '${id}'`);
        const current = row.pending ? JSON.parse(row.pending) as TurnPending : {};
        db.prepare('UPDATE turns SET pending = ? WHERE id = ?').run(JSON.stringify({ ...current, ...patch }), id);
      }),
    pendingOf: (id) => {
      const row = db.prepare('SELECT pending FROM turns WHERE id = ?').get(id) as { pending: string | null } | undefined;
      if (!row?.pending) return null;
      return JSON.parse(row.pending) as TurnPending;
    },
    startTurn: (id) =>
      transaction(db, () => {
        const now = new Date().toISOString();
        db.prepare("UPDATE turns SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(now, id);
        const turn = rowToTurn(db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as Record<string, unknown>);
        appendEventRaw('turn.started', { turn: id }, turn.seat_id);
        return turn;
      }),
    finishTurn: (id, end) =>
      transaction(db, () => {
        db.prepare(
          'UPDATE turns SET status = ?, text = ?, error = ?, stop_reason = ?, usage = ?, tools = ?, duration_ms = ?, watch = ?, ended_at = ? WHERE id = ?',
        ).run(end.status, end.text, end.error, end.stop_reason, end.usage === null ? null : JSON.stringify(end.usage), end.tools, end.duration_ms, end.watch ? JSON.stringify(end.watch) : null, new Date().toISOString(), id);
        const turn = rowToTurn(db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as Record<string, unknown>);
        appendEventRaw('turn.ended', { turn: id, status: end.status }, turn.seat_id);
        return turn;
      }),
    getTurn: (id) => {
      const row = db.prepare('SELECT * FROM turns WHERE id = ?').get(id);
      return row ? rowToTurn(row as Record<string, unknown>) : null;
    },
    listTurns: (seatId) =>
      db.prepare('SELECT * FROM turns WHERE seat_id = ? ORDER BY seq').all(seatId).map((row) => rowToTurn(row as Record<string, unknown>)),
    noTurnError: (id) => {
      const dot = id.lastIndexOf('.');
      // Only `<seat>.<positive integer>` is a turn id; a malformed suffix keeps the plain error.
      const seatId = dot > 0 && /^[1-9]\d*$/.test(id.slice(dot + 1)) ? id.slice(0, dot) : null;
      if (seatId && db.prepare('SELECT id FROM seats WHERE id = ?').get(seatId)) {
        const turns = (db.prepare('SELECT seq FROM turns WHERE seat_id = ? ORDER BY seq').all(seatId) as { seq: number }[])
          .map((row) => `${seatId}.${row.seq}`);
        return `seat ${seatId} has no turn ${id.slice(dot + 1)} (its turns: ${turns.join(', ') || 'none'}); send seat_prompt to start one`;
      }
      return `no turn '${id}'`;
    },
    doneUsage: (family, options = {}) => {
      // The shared seat identity applies inside SQL so role filtering precedes the last-ten limit. The
      // subquery keeps only the family's seats of a raw role that can map to the asked role (a critic is
      // role critic or a flagged scout), through seats_family_role, so the newest-first walk of
      // turns_status_ended reads no other seat's row (task 2640).
      const role = accountingRoleSql('s');
      const rows = db.prepare(`SELECT ${role} AS role, t.usage, json_extract(s.data, '$.model') AS model FROM turns t JOIN seats s ON s.id = t.seat_id
        WHERE t.status = 'done' AND s.family = ?1
          AND t.seat_id IN (SELECT id FROM seats WHERE family = ?1 AND (?2 IS NULL OR role = ?2 OR (?2 = 'critic' AND role = 'scout')))
          AND (?2 IS NULL OR ${role} = ?2)
          AND (?3 IS NULL OR ${role} != ?3)
          AND (?4 IS NULL OR t.ended_at > ?4) AND (?5 IS NULL OR t.ended_at <= ?5)
        ORDER BY t.ended_at DESC, t.id DESC LIMIT ?6`).all(
        family, options.role ?? null, options.excludeRole ?? null, options.from ?? null, options.to ?? null, options.limit ?? -1,
      ) as { role: string; usage: string | null; model: unknown }[];
      return rows.map((row) => {
        const parts = usageParts(row.usage);
        if (!parts) return { role: row.role, tokens: null, raw: null };
        // The seat's own model; a seat without one (explicit native) is priced at its role's matrix model (seats.ts:1639).
        const profileRole = row.role as ProfileRole;
        const model = typeof row.model === 'string' ? row.model : lenientMatrix()[profileRole]?.[family as Family]?.model ?? null;
        return { role: row.role, tokens: quotaUnits(parts, family, model), raw: parts.input + parts.output + parts.cacheRead + parts.cacheWrite };
      });
    },
    lastDoneTurn: () =>
      db.prepare(`SELECT s.family AS family, MAX(COALESCE(t.ended_at, t.created_at)) AS at
        FROM turns t JOIN seats s ON s.id = t.seat_id
        WHERE t.status = 'done' GROUP BY s.family`).all() as { family: string; at: string }[],
    interruptOrphans: () =>
      transaction(db, () => {
        const now = new Date().toISOString();
        const turns = db.prepare("UPDATE turns SET status = 'interrupted', error = ?, ended_at = ? WHERE status = 'running'")
          .run('orch stopped while this turn was running', now).changes;
        // A seat mid-provisioning has a half-built worktree; a working seat keeps its provider session id and can take the next prompt.
        const failed = db.prepare("UPDATE seats SET status = 'failed', data = json_set(data, '$.failure', 'orch stopped while this seat was provisioning'), updated_at = ? WHERE status = 'provisioning' AND json_extract(data, '$.provisionHeld') IS NOT 1").run(now).changes;
        const idle = db.prepare("UPDATE seats SET status = 'ready', updated_at = ? WHERE status = 'working'").run(now).changes;
        if (turns || failed || idle) appendEventRaw('daemon.recovered', { turns: Number(turns), provisioning_failed: Number(failed), working_to_ready: Number(idle) });
        return { turns: Number(turns), seats: Number(failed) + Number(idle) };
      }),
    setDrain: (on) =>
      transaction(db, () => {
        const current = Boolean(db.prepare("SELECT 1 AS n FROM daemon_state WHERE key = 'drain' AND value = '1'").get());
        if (current === on) return;
        if (on) db.prepare("INSERT INTO daemon_state (key, value) VALUES ('drain', '1')").run();
        else db.prepare("DELETE FROM daemon_state WHERE key = 'drain'").run();
        appendEventRaw('daemon.drain', { on });
      }),
    draining: () => Boolean(db.prepare("SELECT 1 AS n FROM daemon_state WHERE key = 'drain' AND value = '1'").get()),
    drainStatus: () => {
      if (!db.prepare("SELECT 1 AS n FROM daemon_state WHERE key = 'drain' AND value = '1'").get()) return null;
      const event = db.prepare("SELECT ts FROM events WHERE kind = 'daemon.drain' AND payload = '{\"on\":true}' ORDER BY seq DESC LIMIT 1").get() as { ts: string } | undefined;
      if (!event) throw new Error('active drain has no start event');
      const running = (db.prepare("SELECT seat_id AS seat, id AS turn FROM turns WHERE status = 'running' ORDER BY seat_id, seq").all() as { seat: string; turn: string }[]).map(({ seat, turn }) => ({ seat, turn }));
      // A scout turn starts during a drain (task 1785): only the turns the drain holds count. A critic's does too (plan 14746).
      const queued = (db.prepare("SELECT COUNT(*) AS n FROM turns JOIN seats ON seats.id = turns.seat_id WHERE turns.status = 'queued' AND seats.role NOT IN ('scout', 'critic')").get() as { n: number }).n;
      return { since: event.ts, running, queued };
    },
    // Defect 2026-10-16: an unbounded read parses every seat's data JSON on the event loop, so the
    // board poll starved /health on ~15k seats. Hot callers pass a bound; every branch below is an
    // index range scan that never touches the closed history it does not need.
    listSeats: (query) => {
      const bound: SeatQuery | undefined = typeof query === 'string' ? { status: query } : query;
      if (!bound) {
        const rows = db.prepare('SELECT * FROM seats ORDER BY created_at, id').all();
        return rows.map((row) => rowToSeat(row as Record<string, unknown>));
      }
      if ('parent' in bound || 'parentIn' in bound) {
        const parents = 'parent' in bound ? [bound.parent] : [...bound.parentIn];
        if (!parents.length) return [];
        const marks = parents.map(() => '?').join(', ');
        const rows = db.prepare(`SELECT * FROM seats WHERE json_extract(data, '$.parent') IN (${marks}) ORDER BY created_at, id`).all(...parents);
        return rows.map((row) => rowToSeat(row as Record<string, unknown>));
      }
      if ('author' in bound) {
        // The expression must stay byte-identical to seats_author's (migration 14) for the index
        // to answer the match; role and the expression together are the old JS filter.
        const rows = db.prepare("SELECT * FROM seats WHERE role = ? AND json_extract(data, '$.author') = ? ORDER BY created_at, id").all(bound.role, bound.author);
        return rows.map((row) => rowToSeat(row as Record<string, unknown>));
      }
      if ('title' in bound) {
        const rows = db.prepare('SELECT * FROM seats WHERE role = ? AND title = ? ORDER BY created_at, id').all(bound.role, bound.title);
        return rows.map((row) => rowToSeat(row as Record<string, unknown>));
      }
      if ('notStatus' in bound) {
        // One indexed range per other status, then one small merge: the same rows in the same
        // (created_at, id) order the unbounded read produced, without reading the excluded ones.
        const statuses = (db.prepare('SELECT DISTINCT status FROM seats').all() as unknown as { status: string }[])
          .map((row) => row.status)
          .filter((status) => status !== bound.notStatus);
        const rows = statuses.flatMap((status) =>
          db.prepare('SELECT * FROM seats WHERE status = ? ORDER BY created_at, id').all(status) as unknown as Record<string, unknown>[]);
        rows.sort((a, b) => {
          const left = String(a.created_at);
          const right = String(b.created_at);
          if (left !== right) return left < right ? -1 : 1;
          return String(a.id) < String(b.id) ? -1 : 1;
        });
        return rows.map((row) => rowToSeat(row));
      }
      const rows = bound.updatedSince !== undefined
        ? db.prepare('SELECT * FROM seats WHERE status = ? AND updated_at >= ? ORDER BY created_at, id').all(bound.status, bound.updatedSince)
        : db.prepare('SELECT * FROM seats WHERE status = ? ORDER BY created_at, id').all(bound.status);
      return rows.map((row) => rowToSeat(row as Record<string, unknown>));
    },
    closedSeatPage: (offset, limit) => {
      const seats = (db.prepare("SELECT * FROM seats WHERE status = 'closed' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(limit, offset) as unknown as Record<string, unknown>[])
        .map((row) => rowToSeat(row));
      const total = (db.prepare("SELECT COUNT(*) AS n FROM seats WHERE status = 'closed'").get() as { n: number }).n;
      return { seats, total };
    },
    pruneCandidatesPage: (after, limit) => {
      // The LIMIT bounds the scanned rows; the sweep flag is extracted in SQL so only
      // candidates pay the JSON parse. It rides along so the cursor can name the
      // last scanned row even when it is not a candidate. `!== 1` is a superset of the
      // sweep's own truthiness guards, which still decide per seat.
      const page = (after === null
        ? db.prepare("SELECT *, json_extract(data, '$.worktreeRemoved') AS wr FROM seats WHERE status = 'closed' ORDER BY created_at, id LIMIT ?").all(limit)
        : db.prepare("SELECT *, json_extract(data, '$.worktreeRemoved') AS wr FROM seats WHERE status = 'closed' AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?")
          .all(after.created_at, after.created_at, after.id, limit)) as unknown as (Record<string, unknown> & { wr: unknown })[];
      const seats = page.filter((row) => landable(String(row.role)) && row.wr !== 1)
        .map(({ wr: _wr, ...row }) => rowToSeat(row));
      const last = page[page.length - 1];
      return {
        seats,
        next: page.length < limit ? null : { created_at: String(last.created_at), id: String(last.id) },
      };
    },
    seatCounts: () => {
      const counts: Record<string, number> = {};
      for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM seats GROUP BY status').all()) {
        const r = row as { status: string; n: number };
        counts[r.status] = r.n;
      }
      return counts;
    },
    activeTurns: () => (db.prepare("SELECT COUNT(*) AS n FROM turns WHERE status IN ('queued', 'running')").get() as { n: number }).n,
    runningTurns: () => (db.prepare("SELECT COUNT(*) AS n FROM turns WHERE status = 'running'").get() as { n: number }).n,
    listQueued: () => db.prepare("SELECT * FROM turns WHERE status = 'queued' ORDER BY seat_id, seq").all().map((row) => rowToTurn(row as Record<string, unknown>)),
    saveGrade: (turnId, seatId, grade) => {
      db.prepare('INSERT OR REPLACE INTO reports (id, seat_id, turn_id, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(turnId, seatId, turnId, String(grade.status), JSON.stringify(grade), new Date().toISOString());
    },
    getGrade: (turnId) => {
      const row = db.prepare('SELECT body FROM reports WHERE turn_id = ?').get(turnId) as { body: string } | undefined;
      if (!row) return null;
      try {
        const body = JSON.parse(row.body);
        return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
      } catch {
        return null;
      }
    },
    recordLessonDelivery: (seatId, turnId, delivered) =>
      transaction(db, () => {
        const now = new Date().toISOString();
        const full = new Set(delivered.full);
        const insert = db.prepare('INSERT OR IGNORE INTO lesson_deliveries (turn_id, seat_id, lesson_id, mode, delivered_at) VALUES (?, ?, ?, ?, ?)');
        for (const id of full) insert.run(turnId, seatId, id, 'full', now);
        for (const id of new Set(delivered.indexed)) if (!full.has(id)) insert.run(turnId, seatId, id, 'indexed', now);
        appendEventRaw('seat.lessons_delivered', { turn: turnId, full: [...full], indexed: delivered.indexed.filter((id) => !full.has(id)) }, seatId);
      }),
    recordLessonsApplied: (turnId, entries) =>
      transaction(db, () => {
        const now = new Date().toISOString();
        const update = db.prepare("UPDATE lesson_deliveries SET applied = ?, why = ?, reported_at = ? WHERE turn_id = ? AND lesson_id = ? AND mode = 'full'");
        let stored = 0;
        for (const entry of entries) stored += Number(update.run(entry.applied ? 1 : 0, entry.why, now, turnId, entry.id).changes);
        return stored;
      }),
    lessonDeliveries: (turnId) =>
      (db.prepare('SELECT * FROM lesson_deliveries WHERE turn_id = ? ORDER BY mode, lesson_id').all(turnId) as Record<string, unknown>[])
        .map((row) => ({ ...(row as unknown as LessonDelivery), applied: row.applied === null ? null : row.applied === 1 })),
    recordLeadLessonDelivery: (session, file, lessons) =>
      transaction(db, () => {
        const now = new Date().toISOString();
        // Task 2684 correction (reviewers 50d5e2.1, 523790.1): after compaction
        // (session-start.mjs forgets the marks) or under a different router budget the
        // same session is re-delivered, and the first mode must not pin the row — an
        // 'indexed' first delivery would refuse the lead's answer and undercount full
        // deliveries. An upgrade refreshes file and delivered_at; a full row is never
        // downgraded or rewritten, so a recorded answer survives a re-delivery.
        const upsert = db.prepare(`INSERT INTO lead_lesson_deliveries (session, lesson_id, file, mode, delivered_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (session, lesson_id) DO UPDATE SET file = excluded.file, mode = 'full', delivered_at = excluded.delivered_at
          WHERE lead_lesson_deliveries.mode = 'indexed' AND excluded.mode = 'full'`);
        let stored = 0;
        for (const lesson of lessons) stored += Number(upsert.run(session, lesson.id, file, lesson.mode, now).changes);
        return stored;
      }),
    recordLeadLessonApplied: (session, lessonId, applied, why) =>
      transaction(db, () =>
        Number(db.prepare("UPDATE lead_lesson_deliveries SET applied = ?, why = ? WHERE session = ? AND lesson_id = ? AND mode = 'full'")
          .run(applied ? 1 : 0, why, session, lessonId).changes)),
    leadLessonDeliveries: (session) =>
      (db.prepare('SELECT * FROM lead_lesson_deliveries WHERE session = ? ORDER BY mode, lesson_id').all(session) as Record<string, unknown>[])
        .map((row) => ({ ...(row as unknown as LeadLessonDelivery), applied: row.applied === null ? null : row.applied === 1 })),
    appendEvent: (kind, payload = {}, seatId = null) => transaction(db, () => appendEventRaw(kind, payload, seatId)),
    eventCount: () => (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
    close: () => db.close(),
  };
}
