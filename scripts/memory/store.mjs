// Durable, append-only memory core for memoryctl.
//
// Memory lives in its own SQLite database because telemetry may be rebuilt while
// agent memory must survive daemon restarts, concurrent writers, and exports.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { entryText, entryTextSha } from './embed-recipe.mjs';
import { RERANK_HEAD, rerankedRows, searchResults } from './search-results.mjs';
import {
  HttpError,
  TASK_CLOSED_STATUSES,
  handoffWritePayload,
  namedOpenTasks,
  taskDomainProblem,
  taskLinks,
  taskListApplied,
  taskMatchesListFilters,
  taskRowDomain,
  titleWords,
  titlesAlike,
  unknownKind,
} from './task-pure.mjs';

// Exported since 2026-08-14: the macOS transfer verifier refuses a database
// this checkout's store cannot open (the mac-kit shipped a v4 store against a
// v6 database, and nothing compared the two numbers). Reading the literal by
// import is the only version that cannot drift from the code that enforces it.
export const SCHEMA_VERSION = 7;

/// Kinds whose identity includes the SESSION that filed them.
///
/// Dedup asks "is this the same fact already living in memory", and for almost
/// every kind a fact is a fact whoever wrote it: two sessions arriving at the
/// same lesson hold one lesson between them. A `report` is the exception, and
/// not by convenience - it is not a fact but a DELIVERY, attributable to one
/// member's attempt, and the attempt is how Svod reads it back. Two members
/// filing byte-identical minimal verdicts are two deliveries, not one.
///
/// Measured 2026-08-07 by four review seats independently: with the session out
/// of the key, the second attempt's append answered `200 dedup:true` against the
/// FIRST attempt's row, nothing existed under its own session, and the read-back
/// found an empty list - a complete report discarded through the dedup door
/// while its author was told the delivery succeeded.
const SESSION_SCOPED_KINDS = new Set(['report']);

/// The scope column dedup compares, as SQL: the session for the kinds above,
/// and one constant for every other kind so their behaviour is untouched.
///
/// Derived from the set rather than written twice, because a list that appears
/// in two places is a list that will disagree with itself. The MIGRATION spells
/// the same expression out as a frozen literal - a migration is history and may
/// not change under a later edit - and `an-index-that-drifts-from-the-code`
/// in the test suite is what fails when a new kind is added without one.
export const SESSION_SCOPE_SQL = `CASE WHEN kind IN (${[...SESSION_SCOPED_KINDS]
  .map((kind) => `'${kind}'`)
  .join(', ')}) THEN COALESCE(session_id, '') ELSE '' END`;

/// What the dedup scope of an entry is, in JS, matching `SESSION_SCOPE_SQL`.
function dedupScope(kind, sessionId) {
  return SESSION_SCOPED_KINDS.has(kind) ? (sessionId ?? '') : '';
}
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TITLE_CHARS = 500;
const CATCHALL_DOMAIN = 'domain-platform-shell';
const LESSONS_ALGO = 'lessons-v1';
/// What ONE file's lesson delivery may weigh, envelope included.
///
/// Exported, and the export is the point: `LESSON_PAYLOAD_BUDGET_PER_FILE` in
/// `lesson-lib.mjs` re-exports THIS constant instead of carrying its own copy.
/// The two used to be separate literals that happened to agree, and on
/// 2026-08-21 they stopped agreeing for half an hour - the sensor was raised and
/// the service was not, so the WARN went quiet while delivery kept dropping the
/// last lesson of the file the WARN was about. A gate and its sensor are two
/// executors of one rule; one of them has to read the other.
///
/// 48 KB since 2026-08-21, up from 24 KB (operator's decision). What the old
/// number was doing when it was raised: exactly one file in the tree exceeded it
/// - `svod/src/adapter/sandbox.rs`, 26 265 bytes over nine lessons - and that
/// file holds nine lessons because it does nine jobs, so the ceiling was asking
/// for a refactor by way of a byte count. A member's PROMPT is capped
/// separately and lower (`MAX_LESSONS_SECTION_BYTES`, 16 KB, in
/// `svod/src/adapter/member_prompt.rs`): that is context a prompt pays for, this
/// is what the store is willing to hand a reader.
export const LESSONS_MAX_BYTES = 48 * 1024;
/// How many NEARBY lessons an unmatched path may be offered.
///
/// Three, and the number is the point: the whole-domain dump this route dropped
/// on 2026-08-11 delivered 65 and matched 0. Breadth is what made it a
/// distractor, so breadth is what is capped.
const LESSONS_NEARBY_MAX = 3;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOMAIN_ROUTING_PATH = path.join(REPO_ROOT, 'docs', 'agent', 'domain-routing.generated.json');
let routingCache = null;
const KINDS = new Set([
  'handoff',
  'registry',
  'chip',
  'lesson',
  'reference',
  'feedback',
  'project',
  'decision',
  'archive',
  // A Svod member's report, delivered through memory instead of through prose.
  //
  // Seven review rounds each lost a complete answer to the same class: the
  // report was embedded in free text and had to be FOUND. Round 13 proved that
  // finding it cannot be made reliable - serde's error category cannot separate
  // `[ junk {report} ]` from `[see note 1] {report}`. So the report stopped
  // being found and started being delivered, and this is where it lands.
  'report',
]);

// Kinds the hot digest must never carry.
//
// A report is per-attempt machinery, not a durable fact: four of them per round
// would push the handoffs and decisions that a session actually starts on out of
// a 6 KB budget, and the digest's own "omitted" counter would then lie about how
// much durable memory was cut. Admitted to the store, absent from the digest -
// which is exactly the difference between `KINDS` and `KIND_PRIORITY`.
const HOT_EXCLUDED_KINDS = new Set(['report']);
const KIND_PRIORITY = [
  'registry',
  'handoff',
  'decision',
  'feedback',
  'lesson',
  'project',
  'chip',
  'reference',
  'archive',
  // Last, and only ever reached by an explicit `--scope report`: the default
  // digest drops this kind before ranking (see HOT_EXCLUDED_KINDS). A kind with
  // no rank at all would also be unrenderable when asked for BY NAME, and would
  // make KIND_RANK.get() return undefined inside the sort comparator.
  'report',
];
const KIND_RANK = new Map(KIND_PRIORITY.map((kind, index) => [kind, index]));

// A task is the tail a session leaves behind: normalized, not narrative. The
// handoff prose stays free text — it is where history is recounted — but what
// is still OPEN has to be a row a query can answer, or it is not tracked at all.
// Two lists, because a priority that may no longer be WRITTEN must still be
// READ. P2 and P3 were retired on 2026-08-05: a sweep of 86 open tasks closed
// 40 P2 and 6 P3 in a single pass without anyone reading them, which is what a
// priority nobody will ever reach looks like from the outside — a landfill with
// a query interface. Work that is not P0 or P1 is not a task: do it now, or let
// it go. The rows already carrying P2/P3 stay valid, listable and closable,
// so the ranking and the `?priority=` filter still know all four.
const TASK_PRIORITIES = ['P0', 'P1'];
const TASK_PRIORITIES_STORED = ['P0', 'P1', 'P2', 'P3'];
const TASK_PRIORITY_RANK = new Map(TASK_PRIORITIES_STORED.map((value, index) => [value, index]));
const TASK_STATUSES = new Set([
  'open',
  'in_progress',
  'blocked',
  'deferred',
  'done',
  'cancelled',
]);
const MAX_TASK_TITLE_CHARS = 200;
const MAX_TASK_TEXT_CHARS = 2000;
const MAX_TASK_DEPENDENCIES = 32;
const HOT_MAX_TASKS = 20;
// How many entries of one kind the digest may show. Only `handoff` is capped,
// and at ONE: measured 2026-08-05 on the live store, sixteen handoff titles took
// 5260 of the digest's 6000 bytes (88%) while the open-task block got 82 — the
// count line and a note saying the task lines had been cut. The digest exists to
// say what is unfinished; the narrative of what is finished is one `memoryctl
// search --kind handoff` away and does not belong in every session's context.
//
// Raised to THREE, one per track, on 2026-09-11: with one slot the digest showed
// whichever handoff was newest on ANY track, so a same-day deploy handoff (#7626)
// was invisible behind a news-screener one written two hours later, and the lead
// went on answering server questions from older state. Three distinct tracks
// cost ~1 KB and still leave the task block its half of the budget.
const HOT_MAX_PER_KIND = new Map([['handoff', 3]]);

/// The track a handoff belongs to: `links.track`, else the body marker
/// `<!-- track: <slug> | ... -->`. Null when it names none; untracked handoffs
/// only compete for the per-kind cap.
function handoffTrack(entry) {
  try {
    const track = JSON.parse(entry.links || '{}')?.track;
    if (typeof track === 'string' && track.trim()) return track.trim();
  } catch {
    // a malformed links column is not a reason to drop the entry from the digest
  }
  const marker = /<!--\s*track:\s*([^\s|>]+)/.exec(String(entry.body ?? ''));
  return marker ? marker[1] : null;
}

/// The day an entry was written, in UTC. The digest is hashed over its inputs,
/// so it carries a DATE rather than an age: the reader knows today's date, and
/// an entry that says when it was true cannot be quoted as "now" by accident.
const entryDay = (ts) => new Date(Number(ts)).toISOString().slice(0, 10);
const DAY_MS = 24 * 60 * 60 * 1000;
/// "Now" for search ranking and hit ages. MEMORYCTL_NOW_MS pins it, and only the
/// retrieval bench sets it: the bench corpus is a frozen copy, and with the real
/// clock the recency re-rank drifted one query in 102 between two runs of the
/// SAME code three hours apart (2026-09-11), so constants could not be compared
/// across runs.
const searchNow = () => Number(process.env.MEMORYCTL_NOW_MS) || Date.now();
// Every refusal repeats this. A deny that does not carry the ready command is
// noise: the model reliably repeats a given form at the cost of one turn, and
// invents its own at the cost of the whole gate.
const HANDOFF_GATE_HINT = 'declare this session\'s tails: --task <id> (repeatable) '
  + 'or --no-open-work when nothing is left open. '
  + 'Finished one: --closes <id>. '
  + 'New tail: memoryctl task create --title <t> --priority P0|P1 --next <step>';

/// Question scaffolding: words that carry no signal and, under FTS5's implicit
/// AND, guarantee zero results for anyone who types a sentence instead of a
/// keyword. Dropped only on the OR retry, never from the literal pass.
const SEARCH_STOPWORDS = new Set([
  'почему', 'как', 'что', 'чем', 'где', 'кто', 'когда', 'зачем', 'какой', 'какие',
  'не', 'или', 'но', 'во', 'со', 'по', 'за', 'до', 'из', 'от', 'для', 'при',
  'про', 'это', 'ли', 'же', 'бы', 'то', 'та', 'the', 'and', 'for', 'was', 'why',
  'how', 'what', 'where', 'who', 'when', 'does', 'did', 'are', 'not',
  // Added 2026-09-11: time and filler words. Under OR they matched every old
  // handoff that once said "сейчас"/"current", which is how a question about
  // the state of a server NOW ranked 41-45 day old snapshots first.
  'какая', 'какое', 'сейчас', 'текущее', 'текущий', 'текущая', 'сегодня', 'мы', 'наш', 'наша',
  'нас', 'там', 'тут', 'вообще', 'был', 'была', 'было', 'были', 'есть', 'все', 'всё', 'его',
  'её', 'они', 'уже', 'ещё', 'еще', 'current', 'currently', 'now', 'today', 'our', 'with',
  'about', 'which', 'this', 'that', 'there', 'any',
]);

/// Ranking of a free-text search, measured 2026-09-11 with
/// scripts/memory/bench-search.mjs over 34 real lead questions whose answers
/// were picked by SQL, not by this search (102 queries: RU, EN, and both):
///   before  hit@1 29%  hit@5 51%  stale 15%  reports 30% of the top five
///   after   hit@1 45%  hit@5 70%  stale 14%  reports 0%
///   server-state questions alone: hit@5 30% -> 42%, still the weakest class.
/// Every constant below is one of the variants that bench compared; change one
/// only with a bench run beside it.
///
/// Title matches weigh four times a body match: a title is the claim, a body is
/// the narrative around it, and long handoff bodies repeat every domain word.
const SEARCH_BM25_WEIGHTS = [4.0, 1.0];
/// Candidates re-ranked in JS before the limit is cut.
export const SEARCH_POOL = 100;
/// A question that asks for the LATEST or CURRENT state ranks by age as well as
/// by words; one that does not is ranked by words alone (a default decay was
/// measured and cost the decision questions more than it saved).
const SEARCH_RECENT_INTENT = /(послед|сейчас|текущ|сегодня|свеж|актуальн|latest|current|\bnow\b|today|recent|\blast\b)/i;
/// Half-life in days per kind, scaled by SEARCH_RECENT_FACTOR under a recency
/// question: a handoff is a snapshot of its day, a decision holds for weeks.
const SEARCH_HALF_LIFE_DAYS = new Map([
  ['handoff', 10], ['report', 10], ['project', 30], ['chip', 30], ['registry', 30], ['archive', 30],
  ['reference', 60], ['decision', 120], ['feedback', 120], ['lesson', 240],
]);
const SEARCH_RECENT_FACTOR = 0.2;
/// Live entries that are history by their own title. Out of the DEFAULT search
/// (an explicit --kind still answers them): measured, a `MERGED-INTO:` lesson
/// was the first hit for the rule it had been merged into, and an `ОТМЕНЕНО:`
/// feedback was the first hit for the decision that cancelled it.
// The marker word, then a space, colon, parenthesis or '#': live titles spell it
// "MERGED-INTO #1539: ...", "ОТМЕНЕНО (дубль #518): ..." and "ОТМЕНЕНО указание ...",
// and the colon-only form missed all three (measured on the live store 2026-09-11).
// ARCHIVED joined 2026-09-14: a consolidation (consolidate-memory skill, case B1)
// retires a superseded-by-a-fresher-one handoff as title prefix `ARCHIVED:` plus
// links.status "archived", and ~25 such live rows broke `npm run tracks` until
// gen-tracks learned to skip what this predicate names. Exported exactly so the
// track index and the writer's validation judge history by THIS regex.
export const SEARCH_DEAD_TITLE = /^(MERGED-INTO|RETIRED|ОТМЕНЕНО|ARCHIVED)(?=[\s:(#]|$)/i;
/// Kinds whose entries state a RULE that a later entry can overturn. Writing
/// one returns the live entries of these kinds that look like the same rule,
/// and `overturns` closes the ones the new entry replaces. Measured 2026-09-11:
/// the operator's "kimi at effort low" (#5361, a decision) never closed "kimi
/// at effort high" (#1147, a pinned feedback) because the two had different
/// kinds and nobody linked them, and the hot digest served the dead rule for
/// two weeks.
const RULE_KINDS = new Set(['decision', 'feedback', 'lesson', 'reference', 'project']);
const RELATED_ON_WRITE = 3;
// The search route's order over its candidate pool: drop historical titles
// (unless a kind was asked for), take relevance as -row.rank (bm25 is lower-is-
// better), decay it by age only under a recency intent, then newest and highest
// id first on ties. Exported so a bench can apply it to another candidate pool.
export function rerankSearchPool(rows, { query, kind = null, now, limit }) {
  const recent = SEARCH_RECENT_INTENT.test(query);
  return rows
    .filter((row) => kind !== null || !SEARCH_DEAD_TITLE.test(row.title))
    .map((row) => {
      let score = -Number(row.rank);
      if (recent) {
        const ageDays = Math.max(0, (now - Number(row.ts)) / DAY_MS);
        const halfLife = (SEARCH_HALF_LIFE_DAYS.get(row.kind) ?? 60) * SEARCH_RECENT_FACTOR;
        score /= 1 + ageDays / halfLife;
      }
      return { row, score };
    })
    .sort((left, right) => (
      right.score - left.score
      || Number(right.row.ts) - Number(left.row.ts)
      || Number(right.row.id) - Number(left.row.id)
    ))
    .slice(0, limit)
    .map(({ row }) => row);
}

/// Explicit FTS5 syntax the caller typed on purpose: a quoted phrase, a prefix
/// star, a boolean or NEAR. Such a query runs literally, as it always did.
const FTS_SYNTAX = /["*^]|\b(AND|OR|NOT|NEAR)\b/;

export function isPlainSearch(url) {
  return url.pathname === '/api/memory/search' && url.searchParams.get('session') === null
    && Boolean(url.searchParams.get('q')?.trim()) && !FTS_SYNTAX.test(url.searchParams.get('q'));
}

/// Russian is inflected and FTS5's unicode61 tokenizer does not stem, so
/// "серверы" and "сервер" returned disjoint top-5s. A Cyrillic term of five or
/// more letters is matched by its prefix without the last two letters (never
/// shorter than four): "ростерах" finds "ростер", "серверы" finds "сервер".
function matchTerm(term) {
  if (/[а-яё]/.test(term) && term.length >= 5) {
    return `${quoteTerm(term.slice(0, Math.max(4, term.length - 2)))}*`;
  }
  return quoteTerm(term);
}

/// The terms FTS5 can be handed safely: letters, digits and underscore, nothing
/// shorter than a trigram (a one-letter term matches everything and ranks it).
function ftsTerms(query) {
  return String(query)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length >= 3);
}

/// Literal identities need not resemble their surrounding prose in vector space.
/// Keep complete tokens only; a seat's turn suffix is not part of its identity.
function idTokens(query) {
  const text = String(query).toLowerCase();
  const tokens = new Set();
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_-])([a-z][a-z0-9]*-[a-z][a-z0-9]*-[a-f0-9]{6})(?:\.\d+)?(?![\p{L}\p{N}_-])/gu)) {
    tokens.add(match[1]);
  }
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])[a-f0-9]{7,40}(?![\p{L}\p{N}_])/gu)) {
    if (/[a-f]/.test(match[0]) && /\d/.test(match[0])) tokens.add(match[0]);
  }
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])(?:task\s+\d{3,6}|#\d{3,6})(?![\p{L}\p{N}_])/gu)) {
    tokens.add(match[0].replace(/\s+/gu, ' '));
  }
  return [...tokens];
}

const quoteTerm = (term) => `"${term.replace(/"/g, '""')}"`;

const MIGRATIONS = new Map([
  [1, (db) => {
    db.exec(`
CREATE TABLE mem_entries(
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  session_id TEXT,
  agent TEXT,
  kind TEXT NOT NULL CHECK(kind IN (
    'handoff', 'registry', 'chip', 'lesson', 'reference',
    'feedback', 'project', 'decision', 'archive', 'report'
  )),
  key TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  links TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(links)),
  sha_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sha_refs)),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
  content_hash TEXT NOT NULL,
  source_path TEXT,
  supersedes INTEGER REFERENCES mem_entries(id),
  superseded_by INTEGER REFERENCES mem_entries(id),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(kind, title, content_hash)
);

CREATE UNIQUE INDEX idx_mem_entries_live_key
  ON mem_entries(key) WHERE superseded_by IS NULL;
CREATE INDEX idx_mem_entries_kind_ts ON mem_entries(kind, ts DESC);
CREATE INDEX idx_mem_entries_session_ts ON mem_entries(session_id, ts);
CREATE INDEX idx_mem_entries_superseded_by ON mem_entries(superseded_by);

CREATE VIRTUAL TABLE mem_entries_fts USING fts5(
  title,
  body,
  content='mem_entries',
  content_rowid='id'
);

CREATE TRIGGER mem_entries_fts_insert AFTER INSERT ON mem_entries
WHEN new.superseded_by IS NULL
BEGIN
  INSERT INTO mem_entries_fts(rowid, title, body)
  VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER mem_entries_fts_supersede AFTER UPDATE OF superseded_by ON mem_entries
WHEN old.superseded_by IS NULL AND new.superseded_by IS NOT NULL
BEGIN
  INSERT INTO mem_entries_fts(mem_entries_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
END;
`);
  }],
  [2, (db) => {
    // v2: UNIQUE(kind,title,content_hash) must bind LIVE rows only. The v1 table-level
    // constraint made a status-only supersede (same body, links change) impossible —
    // the replacement row collides with the row it supersedes (found live by 3C,
    // worked around with body stamps). Table rebuild: drop the table constraint,
    // dedup becomes a partial unique index WHERE superseded_by IS NULL.
    db.exec(`
CREATE TABLE mem_entries_v2(
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  session_id TEXT,
  agent TEXT,
  kind TEXT NOT NULL CHECK(kind IN (
    'handoff', 'registry', 'chip', 'lesson', 'reference',
    'feedback', 'project', 'decision', 'archive'
  )),
  key TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  links TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(links)),
  sha_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sha_refs)),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
  content_hash TEXT NOT NULL,
  source_path TEXT,
  supersedes INTEGER REFERENCES mem_entries(id),
  superseded_by INTEGER REFERENCES mem_entries(id),
  version INTEGER NOT NULL DEFAULT 1
);

INSERT INTO mem_entries_v2
  SELECT id, uuid, ts, session_id, agent, kind, key, title, body, links, sha_refs,
         pinned, content_hash, source_path, supersedes, superseded_by, version
  FROM mem_entries;

DROP TABLE mem_entries;
ALTER TABLE mem_entries_v2 RENAME TO mem_entries;

CREATE UNIQUE INDEX idx_mem_entries_live_dedup
  ON mem_entries(kind, title, content_hash) WHERE superseded_by IS NULL;
CREATE UNIQUE INDEX idx_mem_entries_live_key
  ON mem_entries(key) WHERE superseded_by IS NULL;
CREATE INDEX idx_mem_entries_kind_ts ON mem_entries(kind, ts DESC);
CREATE INDEX idx_mem_entries_session_ts ON mem_entries(session_id, ts);
CREATE INDEX idx_mem_entries_superseded_by ON mem_entries(superseded_by);

CREATE TRIGGER mem_entries_fts_insert AFTER INSERT ON mem_entries
WHEN new.superseded_by IS NULL
BEGIN
  INSERT INTO mem_entries_fts(rowid, title, body)
  VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER mem_entries_fts_supersede AFTER UPDATE OF superseded_by ON mem_entries
WHEN old.superseded_by IS NULL AND new.superseded_by IS NOT NULL
BEGIN
  INSERT INTO mem_entries_fts(mem_entries_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
END;
`);
  }],
  [3, (db) => {
    // v3: tasks. The entries table already held "a handoff mentioning future
    // work" and that is exactly what failed - 5 declared tracks against 36
    // handoffs that declared nothing, measured 2026-07-29. Prose cannot be
    // queried for "what is open", so the tail becomes a row with a status a
    // machine can filter and a claim a second agent cannot steal.
    db.exec(`
CREATE TABLE mem_tasks(
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  closed_ts INTEGER,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL CHECK(priority IN ('P0', 'P1', 'P2', 'P3')),
  status TEXT NOT NULL CHECK(status IN (
    'open', 'in_progress', 'blocked', 'deferred', 'done', 'cancelled'
  )),
  track TEXT,
  next_action TEXT,
  blocked_reason TEXT,
  claimed_by TEXT,
  claimed_at INTEGER,
  session_id TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(depends_on)),
  links TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(links)),
  -- blocked without a reason is a shrug, not a state: it tells the next
  -- session nothing it can act on.
  CHECK(status != 'blocked' OR blocked_reason IS NOT NULL),
  CHECK((claimed_by IS NULL) = (claimed_at IS NULL))
);

CREATE INDEX idx_mem_tasks_status_priority ON mem_tasks(status, priority, id);
CREATE INDEX idx_mem_tasks_track ON mem_tasks(track) WHERE track IS NOT NULL;

-- Which handoff declared which tail. The join is what makes "this session left
-- work" auditable after the fact, instead of a claim inside prose.
CREATE TABLE mem_task_handoffs(
  task_id INTEGER NOT NULL REFERENCES mem_tasks(id),
  entry_id INTEGER NOT NULL REFERENCES mem_entries(id),
  ts INTEGER NOT NULL,
  PRIMARY KEY(task_id, entry_id)
);

CREATE INDEX idx_mem_task_handoffs_entry ON mem_task_handoffs(entry_id);
`);
  }],
  [4, (db) => {
    // v4: the declaration is a FACT about the entry, not an inference from the
    // link table. v3 stored only links, so "no rows" meant two different things
    // at once - "declared nothing is open" and "written before the gate
    // existed". Every row in a migrated database is the second kind (322 of
    // them here), and dedup was reading them as the first: a reviewer measured
    // `legacy_v2_dedup status=200 dedup=true persisted_declaration_rows=0`.
    // NULL keeps meaning UNKNOWN, which is the honest value for everything
    // written before this column existed.
    db.exec(`
ALTER TABLE mem_entries ADD COLUMN handoff_declaration TEXT
  CHECK(handoff_declaration IS NULL OR handoff_declaration IN ('none', 'tails'));
`);
  }],
  [5, (db) => {
    // v5: `report` joins the kinds, because a Svod member now DELIVERS its
    // report into memory instead of burying it in prose for the harness to find.
    // Seven review rounds each lost a complete answer to that search, and round
    // 13 proved the search cannot be made reliable rather than finding an eighth
    // shape of the same defect.
    //
    // A rebuild rather than an ALTER, because SQLite cannot change a CHECK in
    // place. The shape is v2's, for the same reason it was v2's - and the parts
    // that are easy to forget are the FIVE indexes and the TWO triggers, which
    // live on the table and die with it.
    //
    // The FTS index survives untouched: `mem_entries_fts` is keyed by rowid, the
    // copy preserves every id, and no trigger fires during it because the new
    // table has none until after the rename. So a rebuild costs no re-indexing
    // and cannot lose a searchable body.
    db.exec(`
CREATE TABLE mem_entries_v5(
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  session_id TEXT,
  agent TEXT,
  kind TEXT NOT NULL CHECK(kind IN (
    'handoff', 'registry', 'chip', 'lesson', 'reference',
    'feedback', 'project', 'decision', 'archive', 'report'
  )),
  key TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  links TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(links)),
  sha_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sha_refs)),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
  content_hash TEXT NOT NULL,
  source_path TEXT,
  supersedes INTEGER REFERENCES mem_entries(id),
  superseded_by INTEGER REFERENCES mem_entries(id),
  version INTEGER NOT NULL DEFAULT 1,
  handoff_declaration TEXT
    CHECK(handoff_declaration IS NULL OR handoff_declaration IN ('none', 'tails'))
);

INSERT INTO mem_entries_v5
  SELECT id, uuid, ts, session_id, agent, kind, key, title, body, links, sha_refs,
         pinned, content_hash, source_path, supersedes, superseded_by, version,
         handoff_declaration
  FROM mem_entries;

DROP TABLE mem_entries;
ALTER TABLE mem_entries_v5 RENAME TO mem_entries;

CREATE UNIQUE INDEX idx_mem_entries_live_dedup
  ON mem_entries(kind, title, content_hash) WHERE superseded_by IS NULL;
CREATE UNIQUE INDEX idx_mem_entries_live_key
  ON mem_entries(key) WHERE superseded_by IS NULL;
CREATE INDEX idx_mem_entries_kind_ts ON mem_entries(kind, ts DESC);
CREATE INDEX idx_mem_entries_session_ts ON mem_entries(session_id, ts);
CREATE INDEX idx_mem_entries_superseded_by ON mem_entries(superseded_by);

CREATE TRIGGER mem_entries_fts_insert AFTER INSERT ON mem_entries
WHEN new.superseded_by IS NULL
BEGIN
  INSERT INTO mem_entries_fts(rowid, title, body)
  VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER mem_entries_fts_supersede AFTER UPDATE OF superseded_by ON mem_entries
WHEN old.superseded_by IS NULL AND new.superseded_by IS NOT NULL
BEGIN
  INSERT INTO mem_entries_fts(mem_entries_fts, rowid, title, body)
  VALUES ('delete', old.id, old.title, old.body);
END;
`);
  }],
  [6, (db) => {
    // v6: dedup gains the SESSION for the kinds whose identity includes it.
    //
    // `report` is a delivery, not a fact: it belongs to one member's attempt,
    // and that attempt is how Svod reads it back. Keyed on (kind, title,
    // content_hash) alone, a second attempt filing a byte-identical body was
    // answered `200 dedup:true` against the FIRST attempt's row - so nothing
    // existed under its own session, the read-back returned an empty list, and
    // a complete report was discarded while its author was told the delivery
    // had succeeded. Four review seats found it independently on 2026-08-07,
    // one of them with a probe: attempt-A -> id 1 dedup:false; attempt-B, same
    // bytes -> id 1 dedup:true; `?session=attempt-B&kind=report` -> [].
    //
    // The collision was ours twice over: the completion contract asks every
    // member for the constant title `review`, and the identity Svod puts in the
    // member's environment - the one thing that DOES tell the deliveries apart -
    // was the one column the key ignored.
    //
    // Index-only, so no table rebuild and no FTS risk. The expression is spelled
    // out as a LITERAL rather than built from `SESSION_SCOPED_KINDS`: a
    // migration is history, and history may not change when a later edit adds a
    // kind. A new kind gets a v7, and the test that compares the live index DDL
    // against `SESSION_SCOPE_SQL` is what refuses to let it be forgotten.
    db.exec(`
DROP INDEX idx_mem_entries_live_dedup;
CREATE UNIQUE INDEX idx_mem_entries_live_dedup
  ON mem_entries(
    kind, title, content_hash,
    CASE WHEN kind IN ('report') THEN COALESCE(session_id, '') ELSE '' END
  ) WHERE superseded_by IS NULL;
`);
  }],
  [7, (db) => {
    // Additive only: neither mem_entries nor its FTS index is rebuilt or updated.
    db.exec(`
CREATE TABLE mem_vectors(
  entry_id INTEGER PRIMARY KEY REFERENCES mem_entries(id),
  model TEXT NOT NULL,
  dims INTEGER NOT NULL CHECK(dims > 0),
  vec BLOB NOT NULL CHECK(length(vec) = dims * 4),
  text_sha TEXT NOT NULL,
  ts INTEGER NOT NULL
);
`);
  }],
]);

function ensureToken(tokenPath) {
  try {
    fs.writeFileSync(tokenPath, `${crypto.randomBytes(32).toString('hex')}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  fs.chmodSync(tokenPath, 0o600);
}

function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get();
  let version = Number(row.user_version);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`invalid memory schema version: ${row.user_version}`);
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(`memory.db schema v${version} is newer than supported v${SCHEMA_VERSION}`);
  }
  if (version === SCHEMA_VERSION) return;

  // Table-rebuild migrations (v2) DROP a table other rows self-reference — SQLite's
  // canonical 12-step recipe requires foreign_keys OFF around the transaction
  // (the PRAGMA is a no-op inside one). Restore + verify afterwards, always.
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    runMigrations(db, version);
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
  const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
  if (fkViolations.length > 0) {
    throw new Error(`memory migration left ${fkViolations.length} foreign-key violation(s): ${JSON.stringify(fkViolations.slice(0, 3))}`);
  }
}

function runMigrations(db, version) {

  while (version < SCHEMA_VERSION) {
    const nextVersion = version + 1;
    const migration = MIGRATIONS.get(nextVersion);
    if (!migration) throw new Error(`missing memory migration v${version}->v${nextVersion}`);

    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read UNDER the write lock. The version that got us here was read
      // before any lock, so a second process could pass the same check and both
      // would run the same CREATE TABLE - measured as "table mem_entries
      // already exists" in 11 of 20 concurrent opens.
      const current = Number(db.prepare('PRAGMA user_version').get().user_version);
      if (current >= nextVersion) {
        db.exec('COMMIT');
        version = current;
        continue;
      }
      migration(db);
      db.exec(`PRAGMA user_version=${nextVersion}`);
      db.exec('COMMIT');
      version = nextVersion;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `memory migration v${nextVersion} and rollback failed`);
      }
      throw error;
    }
  }
}

// Vector writes compare the recipe hash under the same write lock: a worker must
// not mark an embedding of yesterday's title/body as current after an edit.
export function putVector(db, { entryId, model, vector, textSha, ts = Date.now() }) {
  if (!Number.isSafeInteger(entryId) || entryId < 1 || typeof model !== 'string' || !model ||
      !(vector instanceof Float32Array) || vector.length === 0 ||
      vector.some((value) => !Number.isFinite(value)) ||
      !/^[a-f0-9]{64}$/.test(textSha) || !Number.isSafeInteger(ts)) {
    throw new TypeError('invalid vector metadata or values');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT title, body FROM mem_entries WHERE id = ? AND superseded_by IS NULL AND kind != \'report\'').get(entryId);
    if (!row) throw new Error(`missing entry ${entryId} or no longer eligible`);
    if (entryTextSha(row) !== textSha) throw new Error(`stale entry text ${entryId}`);
    const bytes = Buffer.alloc(vector.length * 4);
    for (let i = 0; i < vector.length; i++) bytes.writeFloatLE(vector[i], i * 4);
    db.prepare(`INSERT INTO mem_vectors(entry_id, model, dims, vec, text_sha, ts)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET model=excluded.model, dims=excluded.dims,
        vec=excluded.vec, text_sha=excluded.text_sha, ts=excluded.ts`)
      .run(entryId, model, vector.length, bytes, textSha, ts);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Search eligibility: all live non-report entries, including dead titles that
// may be requested explicitly by kind. A stale hash is never returned as current.
// Hash text once per version, not on every search/health/backlog scan. Store writes
// refresh individual ids after commit; data_version catches transfers and other
// connections' in-place edits before any cached hash is used again.
export function createTextHashCache(db) {
  const rows = db.prepare(`SELECT id, title, body FROM mem_entries
    WHERE superseded_by IS NULL AND kind != 'report'`);
  const current = db.prepare(`SELECT id, title, body FROM mem_entries
    WHERE id = ? AND superseded_by IS NULL AND kind != 'report'`);
  const version = db.prepare('PRAGMA data_version');
  const hashes = new Map();
  let observed;
  const rebuild = () => {
    hashes.clear();
    for (const row of rows.all()) hashes.set(Number(row.id), entryTextSha(row));
    observed = version.get().data_version;
  };
  rebuild();
  return {
    current() {
      if (version.get().data_version !== observed) rebuild();
      return hashes;
    },
    refresh(id, supersedes) {
      if (version.get().data_version !== observed) rebuild();
      if (supersedes) hashes.delete(Number(supersedes));
      const row = current.get(id);
      if (row) hashes.set(Number(id), entryTextSha(row));
      else hashes.delete(Number(id));
    },
  };
}

const VECTOR_ENTRIES_SQL = `FROM mem_entries e LEFT JOIN mem_vectors v ON v.entry_id = e.id
  WHERE e.superseded_by IS NULL AND e.kind != 'report'`;

export function listMissingOrStaleVectorIds(db, model, textHashes = createTextHashCache(db)) {
  if (typeof model !== 'string' || !model) throw new TypeError('model required');
  const hashes = textHashes.current();
  return db.prepare(`SELECT e.id, v.model, v.text_sha
    ${VECTOR_ENTRIES_SQL} ORDER BY e.id`).all()
    .filter((row) => row.model !== model || row.text_sha !== hashes.get(Number(row.id)))
    .map((row) => Number(row.id));
}

// Count the same live, non-report population used by the backlog and search.
// A row with the wrong model or changed text is stale; no row is missing.
export function vectorBacklogStatus(db, model, textHashes = createTextHashCache(db)) {
  if (typeof model !== 'string' || !model) throw new TypeError('model required');
  const rows = db.prepare(`SELECT e.id, v.model, v.text_sha
    ${VECTOR_ENTRIES_SQL}`).all();
  let missing = 0;
  let stale = 0;
  const hashes = textHashes.current();
  for (const row of rows) {
    if (row.model === null) missing++;
    else if (row.model !== model || row.text_sha !== hashes.get(Number(row.id))) stale++;
  }
  return { total: rows.length, missing, stale };
}

export function loadCurrentVectors(db, model, textHashes = createTextHashCache(db)) {
  if (typeof model !== 'string' || !model) throw new TypeError('model required');
  const hashes = textHashes.current();
  return db.prepare(`SELECT e.id, v.model, v.text_sha, v.dims, v.vec, v.ts
    ${VECTOR_ENTRIES_SQL} AND v.model = ? ORDER BY e.id`)
    .all(model).filter((row) => row.text_sha === hashes.get(Number(row.id)))
    .map((row) => {
      if (row.vec.length !== row.dims * 4) throw new Error(`invalid vector length for ${row.id}`);
      const vector = new Float32Array(row.dims);
      const view = new DataView(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength);
      for (let i = 0; i < row.dims; i++) vector[i] = view.getFloat32(i * 4, true);
      return { entryId: Number(row.id), model: row.model, vector, textSha: row.text_sha, ts: Number(row.ts) };
    });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Where a class ends. A `]` in FIRST position is a literal `]` — the one place a
// class may carry the character that would otherwise close it — so the search
// starts past it.
function globClassEnd(glob, open) {
  let index = open + 1;
  if (glob[index] === '!' || glob[index] === '^') index += 1;
  if (glob[index] === ']') index += 1;
  return glob.indexOf(']', index);
}

// A class as a JS regex class, in the dialect this repository actually means.
//
// The passthrough this replaces handed `[...]` to the regex engine verbatim,
// which is a different language: `[!0-9]` NEGATES in a glob and is a set holding
// `!` and the digits in a regex, so `x[!0-9].ts` matched `x7.ts` and refused
// `xa.ts` — the exact opposite of the Rust matcher over the same routing file.
// A class whose range runs backwards — `[z-a]` — matches nothing. A JS regex
// REFUSES to be built from it (`Range out of order in character class`), so
// matchGlob threw where the Rust matcher answered false: routing a lesson would
// die on a glob that the other side merely ignored. Measured 2026-08-08 by a
// review seat. Matching nothing is the honest answer and the one both sides can
// give; the sensor beside the Rust matcher fails the build for such a glob, so
// nothing has to be guessed about the author's intent here.
const MATCHES_NOTHING = '[^\\s\\S]';

function globClassHasInvertedRange(set) {
  for (let index = 1; index + 1 < set.length; index += 1) {
    if (set[index] !== '-') continue;
    if (set[index + 1] === ']') continue;
    if (set.charCodeAt(index - 1) > set.charCodeAt(index + 1)) return true;
  }
  return false;
}

function globClassSource(body) {
  const negated = body.startsWith('!') || body.startsWith('^');
  const set = negated ? body.slice(1) : body;
  if (globClassHasInvertedRange(set)) return negated ? '[^/]' : MATCHES_NOTHING;
  const escaped = set.startsWith(']') ? `\\]${set.slice(1)}` : set;
  // No class matches a separator, for the same reason `*` does not: a path
  // component boundary is structure, not a character.
  return negated ? `[^/${escaped}]` : `(?!/)[${escaped}]`;
}

// The dialect is stated once, in scripts/memory/glob-dialect.cases.json, and
// this matcher is held to it. There were two until 2026-08-10: the Svod side
// had its own, deciding which domain skills a member was given from the
// subject. That derivation is gone - a lead now names each seat's skills - so
// this is the only matcher over the generated routing file. The shared
// statement stays: it outlived one reader and the four shapes the two of them
// disagreed on are the reason it exists.
function globRegexSource(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      index += 1;
      if (glob[index + 1] === '/') index += 1;
      source += '.*';
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      // One character, and never the separator: `.` crossed `/`.
      source += '[^/]';
    } else if (char === '[') {
      const close = globClassEnd(glob, index);
      if (close === -1) {
        source += '\\[';
      } else {
        source += globClassSource(glob.slice(index + 1, close));
        index = close;
      }
    } else {
      source += /[\\^$+?.()|{}]/.test(char) ? `\\${char}` : char;
    }
  }
  return source;
}

/**
 * Whether this string is a PATTERN rather than one literal path. `matchGlob`
 * answers "does it match"; a caller that has to know what KIND of claim the
 * match is - a path the lesson names, or a class it describes - needs this.
 */
export function isGlobPattern(value) {
  return typeof value === 'string' && /[*?[\]]/.test(value);
}

// Compiled glob regexes are referentially transparent; the bound keeps a long-lived process from
// growing the cache without limit (routing globs are few, lesson anchors can be many).
const globRegexCache = new Map();
const GLOB_REGEX_CACHE_LIMIT = 4096;

export function matchGlob(glob, repoPath) {
  if (typeof glob !== 'string' || !glob) throw new TypeError('glob must be a non-empty string');
  if (typeof repoPath !== 'string') throw new TypeError('path must be a string');
  // The `u` flag makes `[^/]` one CODE POINT rather than one UTF-16 unit, which
  // is what the Rust matcher walks since it moved off bytes. Without it the two
  // disagreed in OPPOSITE directions on an astral character: `src/?.ts` matched
  // `src/<emoji>.ts` there and not here, `src/??.ts` here and not there.
  let re = globRegexCache.get(glob);
  if (!re) {
    if (globRegexCache.size >= GLOB_REGEX_CACHE_LIMIT) globRegexCache.clear();
    re = new RegExp(`^${globRegexSource(glob)}$`, 'u');
    globRegexCache.set(glob, re);
  }
  return re.test(repoPath);
}

function bestDomainRoute(repoPath, routingMap) {
  if (typeof repoPath !== 'string') throw new TypeError('path must be a string');
  if (!routingMap || !Array.isArray(routingMap.order)) {
    throw new TypeError('routingMap.order must be an array');
  }

  let best = null;
  for (const route of routingMap.order) {
    if (!route || typeof route.glob !== 'string' || !route.glob
      || typeof route.domain !== 'string' || !route.domain
      || !Number.isFinite(route.spec)) {
      throw new TypeError('each routing entry must contain non-empty glob/domain and finite spec');
    }
    if (!matchGlob(route.glob, repoPath)) continue;
    if (best === null
      || route.spec > best.spec
      || (route.spec === best.spec
        && best.domain === CATCHALL_DOMAIN
        && route.domain !== CATCHALL_DOMAIN)
      || (route.spec === best.spec
        && (route.domain === CATCHALL_DOMAIN) === (best.domain === CATCHALL_DOMAIN)
        && route.glob.localeCompare(best.glob) < 0)) {
      best = route;
    }
  }
  return best;
}

// The floor is a valid platform-shell route. A lesson filed under another domain
// must not be silently moved there: '**' is not an explicit claim by that domain.
export function resolveDomain(repoPath, routingMap) {
  return bestDomainRoute(repoPath, routingMap)?.domain ?? null;
}

export function resolveExplicitDomain(repoPath, routingMap) {
  const route = bestDomainRoute(repoPath, routingMap);
  return route?.glob === '**' ? null : route?.domain ?? null;
}

/**
 * Exported beside `resolveDomain` and `lessonMatchesPath`: a caller that has to
 * ask "would this reach that file" needs all three, and building its own map
 * from the same JSON is how a third dialect of the routing question is born.
 */
export function loadRoutingMap() {
  const stat = fs.statSync(DOMAIN_ROUTING_PATH);
  if (routingCache
    && routingCache.mtimeMs === stat.mtimeMs
    && routingCache.size === stat.size) {
    return routingCache.map;
  }
  const map = JSON.parse(fs.readFileSync(DOMAIN_ROUTING_PATH, 'utf8'));
  if (!map || !Array.isArray(map.order)) {
    throw new Error(`domain routing map has no order array: ${DOMAIN_ROUTING_PATH}`);
  }
  routingCache = { mtimeMs: stat.mtimeMs, size: stat.size, map };
  return map;
}

/// The shape a caller has to produce, stated once and quoted in every refusal.
///
/// A refusal that names ONE missing field teaches the caller one field per round
/// trip. Measured 2026-08-02 in the session transcripts: three consecutive 400s
/// on a single `append` — "must be a JSON object", then "domain must be a
/// non-empty string", then "anchor must be a non-empty string" — each a full
/// agent turn spent rediscovering a contract the service knew in full from the
/// first request.
const LESSON_LINKS_SHAPE =
  'required shape: {"domain":"<routing map name>","anchor":"<file>[:<symbol>]",'
  + '"status":"active"|"inbox"|"retired","globs":["<glob>",...] (optional),'
  + '"trigger":"<text>" (optional)}';

/// The shape of a track declaration, stated once and quoted in every refusal.
const TRACK_LINKS_SHAPE =
  'required shape: {"track":"<slug>","status":"active"|"paused"|"blocked"|"done","next":"<step>"} '
  + 'with <slug> matching [a-z0-9][a-z0-9-]* (a bare name like "server-arch")';

/// The slug gen-tracks.mjs files a handoff under. The reader imports THIS
/// regex, so what a write accepts is exactly what the view renders.
export const TRACK_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/// The statuses a LIVE track may carry. `archived` is deliberately absent: it
/// is legitimate only under a history title (SEARCH_DEAD_TITLE), where the
/// writer skips this validation and the reader skips the row.
export const TRACK_STATUSES = Object.freeze(['active', 'paused', 'blocked', 'done']);

const TRACK_MARKER = /<!--\s*track\s*:([\s\S]*?)-->/gi;

/**
 * The LAST `<!-- track: <slug> | status: <s> | next: <step> -->` marker in a
 * handoff body — an updated handoff appends one, so the last wins. This is the
 * one parse of that marker: gen-tracks.mjs imports this function rather than
 * carrying its own copy.
 */
export function parseTrackMarker(body) {
  if (!body) return {};
  let last = null;
  for (const m of String(body).matchAll(TRACK_MARKER)) last = m[1];
  if (last === null) return {};
  const out = {};
  const parts = last.split('|');
  // the slug sits right after `track:`, before the first `|`
  out.track = parts.shift().trim();
  for (const part of parts) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    const key = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (key === 'status' || key === 'next') out[key] = value;
  }
  return out;
}

/**
 * A problem description for a track slug, or null when acceptable. An absent
 * or empty track is NOT a problem — it is an untracked handoff, which
 * gen-tracks renders in its own section rather than refusing.
 */
function trackSlugProblem(track) {
  if (track === undefined || track === null || track === '') return null;
  if (typeof track === 'string' && TRACK_SLUG.test(track)) return null;
  const shown = typeof track === 'string'
    ? `"${track.length > 80 ? `${track.slice(0, 80)}…` : track}"`
    : `a ${Array.isArray(track) ? 'array' : typeof track}, not a string`;
  return `track slug ${shown} is not [a-z0-9][a-z0-9-]*`;
}

/// Same question for the status half. Absent or empty is NOT a problem either —
/// gen-tracks renders a missing status as "active".
function trackStatusProblem(status) {
  if (status === undefined || status === null || status === '') return null;
  if (typeof status === 'string' && TRACK_STATUSES.includes(status)) return null;
  const shown = typeof status === 'string'
    ? `"${status}"`
    : `a ${Array.isArray(status) ? 'array' : typeof status}, not a string`;
  return `status ${shown} not in ${TRACK_STATUSES.join('|')}`;
}

/// EVERY problem with a links object, most structural first. Empty means valid.
function lessonLinksProblems(links) {
  const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
  if (!links || typeof links !== 'object' || Array.isArray(links)) {
    // Nothing below can be checked on a non-object, so this one is terminal.
    return ['must be a JSON object'];
  }
  const problems = [];
  if (!nonEmptyString(links.domain)) problems.push('domain must be a non-empty string');
  if (!nonEmptyString(links.anchor)) problems.push('anchor must be a non-empty string');
  // Three states, and the third one is what retirement always needed. `RETIRED:`
  // in a title is a label; the store counted such a lesson as active anyway, so
  // it kept its place in the per-domain budget, kept coming back from a domain
  // query, and kept reading like a rule in force. Measured 2026-07-30: 14 of 77
  // live lessons were in exactly that state. `retired` is delivered to nobody
  // (the lessons query takes `active` only) and deleted from nowhere - the row
  // stays in the supersede chain with the reason in its body.
  if (!['active', 'inbox', 'retired'].includes(links.status)) {
    problems.push("status must be 'active', 'inbox' or 'retired'");
  }
  if (links.globs !== undefined
    && (!Array.isArray(links.globs) || !links.globs.every(nonEmptyString))) {
    problems.push('globs must be an array of non-empty strings');
  }
  if (links.trigger !== undefined && !nonEmptyString(links.trigger)) {
    problems.push('trigger must be a non-empty string');
  }
  if (links.possibleDuplicateOf !== undefined
    && (!Array.isArray(links.possibleDuplicateOf)
      || !links.possibleDuplicateOf.every((id) => Number.isSafeInteger(id) && id > 0))) {
    problems.push('possibleDuplicateOf must be an array of positive integers');
  }
  if (links.duplicateCheck !== undefined && links.duplicateCheck !== 'incomplete') {
    problems.push("duplicateCheck must be 'incomplete'");
  }
  return problems;
}

/**
 * Write-time check that a lesson anchor is SHAPED like a file reference.
 *
 * Enforced on append/supersede only — never on read, or existing rows would
 * become unreadable the moment a file is renamed.
 *
 * The grammar is `<file>` or `<file>:<symbol>`, where `<file>` may be a
 * repo-relative path, a bare basename (delivery matches those too, see
 * `lessonMatchesPath`), or a glob. Agents kept writing an anchor with NO file
 * part at all — a bare symbol (`fn parse_review_decision`) or a markdown
 * heading — which `classifyAnchor` then reads as a filename, cannot resolve,
 * and reports as `gone`. That only surfaced later as a red
 * `check-domain-routing`, long after the writer had moved on.
 *
 * Existence is deliberately NOT checked: an anchor may legitimately point at
 * a file that does not exist yet, and basename anchors never resolve as
 * paths. An anchor that is well-shaped but points into ANOTHER repository
 * still gets caught later, by the sweep — shape alone cannot tell the two
 * apart.
 *
 * @param {string} anchor
 * @returns {string | null} problem description, or null when acceptable
 */
function lessonAnchorProblem(anchor) {
  const raw = String(anchor).trim();
  const file = raw.includes(':') ? raw.slice(0, raw.indexOf(':')).trim() : raw;
  const hint = 'use <file>, <file>:<symbol>, or a glob — a bare symbol name or a '
    + 'markdown heading is not an anchor';
  if (!file) return `anchor "${raw}" has no file part — ${hint}`;
  if (file.startsWith('#')) return `anchor "${raw}" is a markdown heading — ${hint}`;
  if (/\s/.test(file)) return `anchor "${raw}" has whitespace in its file part — ${hint}`;
  // A path or a glob: either it has a directory separator, or it carries a
  // file extension (`collector.rs`), or it is an explicit glob.
  const looksLikePath = file.includes('/') || /\.[A-Za-z0-9]+$/.test(file) || /[*?[\]]/.test(file);
  if (!looksLikePath) return `anchor "${raw}" is not a file reference — ${hint}`;
  if (file.includes('\\') || path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file)) {
    return `anchor "${raw}" must be a repo-relative POSIX path, not an absolute or Windows path`;
  }
  return null;
}

function parseStoredLessonLinks(row) {
  let links;
  try {
    links = JSON.parse(row.links);
  } catch (error) {
    throw new Error(`lesson entry ${row.id} has invalid links JSON: ${error.message}`);
  }
  const problems = lessonLinksProblems(links);
  if (problems.length) throw new Error(`lesson entry ${row.id} links ${problems.join('; ')}`);
  return links;
}

function validateLessonPath(url) {
  const repoPath = url.searchParams.get('path');
  if (!repoPath) throw new HttpError(400, 'lesson path is required');
  const segments = repoPath.split('/');
  if (repoPath.includes('\\')
    || repoPath.includes('\0')
    || path.posix.isAbsolute(repoPath)
    || /^[A-Za-z]:\//.test(repoPath)
    || segments.includes('..')
    || path.posix.normalize(repoPath) !== repoPath
    || repoPath === '.') {
    throw new HttpError(400, 'lesson path must be a normalized repo-relative POSIX path');
  }
  return repoPath;
}

/**
 * HOW this lesson reaches `repoPath`, or `null` when it does not:
 * `anchor` - the lesson names this path (or its basename); somebody wrote a
 * rule about this file. `class` - it arrived through a glob, so it is a rule
 * about a class this file belongs to and nobody named the file itself. The
 * nearby channel needs that difference; every other caller only needs
 * `lessonMatchesPath` below.
 *
 * Exported since 2026-08-11 because two other places were asking the anchor
 * STRING what only this function can answer. A review round found both in one
 * pass: `reanchor-lesson.mjs` accepted a target by `existsSync` alone, and
 * `check-domain-routing.mjs` summed the delivery budget per anchor key. Both
 * miss the same two routes this function honours — the BASENAME match and
 * `globs` — so a lesson could be re-anchored to something it would never reach,
 * and two lessons could jointly blow a file's budget while the gate stayed
 * green. One matcher, asked by everyone, is the only version of this that
 * cannot drift.
 */
export function lessonPathMatchKind(links, repoPath) {
  const separator = links.anchor.indexOf(':');
  const anchorPath = separator === -1 ? links.anchor : links.anchor.slice(0, separator);
  // The LITERAL path first, because a real file name may contain a glob
  // metacharacter and then never matches itself: this tree carries 78 tracked
  // Next.js dynamic routes spelled `[id]`, and `[id]` read as a glob is a
  // character class matching ONE of `i`/`d`. Measured 2026-08-21 on the live
  // service: `web/apps/app/app/api/terminal/workspaces/[id]/route.ts` answered
  // "NOTHING is anchored to this path" and handed back its OWN lesson (#3269)
  // labelled `nearby` - it only arrived at all because the neighbour channel
  // happened to pick it up, and a busier directory would have dropped it.
  if (anchorPath === repoPath) return 'anchor';
  if (matchGlob(anchorPath, repoPath)) {
    // An anchor that IS a glob names a CLASS of files. It reaches this path the
    // same way a `globs` entry does, and it says the same thing about it: the
    // rule is about the class, not about this file.
    return isGlobPattern(anchorPath) ? 'class' : 'anchor';
  }
  // The BASENAME route belongs to an anchor that IS a bare basename, and to no
  // other. Applying it to a full-path anchor as well made every anchor
  // promiscuous over its own file name: measured 2026-08-11, the moment the
  // budget started counting what delivery actually reaches, EVERY
  // `.agents/skills/*/SKILL.md` received 26 365 bytes — the union of every
  // lesson anchored at any other skill's `SKILL.md` — and the same held for
  // `mod.rs` and `index.ts`. An agent editing one skill was being handed the
  // rules of a dozen unrelated ones, which is the distractor this delivery was
  // rebuilt to stop shipping.
  //
  // A bare basename anchor stays deliberate: `collector.rs:collect` is written
  // when the rule follows the FILE wherever it moves, and it keeps working.
  if (!anchorPath.includes('/')
    && (anchorPath === path.posix.basename(repoPath)
      || matchGlob(anchorPath, path.posix.basename(repoPath)))) {
    return 'anchor';
  }
  return (links.globs ?? []).some((glob) => matchGlob(glob, repoPath)) ? 'class' : null;
}

/**
 * Whether this lesson would be DELIVERED to `repoPath`, by any of the routes.
 *
 * The thin half of `lessonPathMatchKind`, kept because most callers only ask
 * whether the lesson arrives - the budget gate, the re-anchor check. One
 * matcher answers both questions; two would drift.
 */
export function lessonMatchesPath(links, repoPath) {
  return lessonPathMatchKind(links, repoPath) !== null;
}

function parseLessonBody(body) {
  const fields = {};
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const field = line.match(/^-\s+(trigger|rule|why|evidence|date):\s*(.*)$/);
    if (field) {
      current = field[1];
      fields[current] = field[2].trim() || null;
    } else if (current !== null && /^(?: {2,}|\t)\S/.test(line)) {
      const continuation = line.trim();
      fields[current] = fields[current] ? `${fields[current]}\n${continuation}` : continuation;
    } else {
      current = null;
    }
  }
  return fields;
}

function lessonPayload(domain, included, total) {
  const items = included.map(({ item }, index) => ({
    uuid: item.uuid,
    id: item.id,
    title: item.title,
    anchor: item.anchor,
    trigger: item.trigger,
    rule: item.rule,
    why: item.why,
    evidence: item.evidence,
    date: item.date,
    rank: index + 1,
    match: item.match,
  }));
  const inputs = included.map(({ row }) => [row.uuid, Number(row.version)]);
  const payload = {
    domain,
    algo: LESSONS_ALGO,
    inputs_hash: sha256(JSON.stringify(inputs)),
    bytes: 0,
    omitted: total - included.length,
    items,
  };
  while (true) {
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (bytes === payload.bytes) return payload;
    payload.bytes = bytes;
  }
}

/// The answer `lessons` sends, built ONCE and weighed by its own fixed point.
///
/// **Two places used to build this shape and they drifted three rounds in a
/// row.** The delivery attached its envelope fields inside `lessons`, and the
/// sensor re-listed them by hand in `deliveredLessonBytes`; each round found the
/// sensor lighter than the wire by whichever field the hand-list had missed -
/// `domain_active` in `lessons-wire-r1`, `invalid` in `-r2`. Patching the third
/// field would have bought the fourth round. So the shape is assembled here, in
/// one function, and both callers pass what they know instead of describing the
/// envelope again.
///
/// `bytes` is settled by a fixed point because the number lives inside the JSON
/// it describes: 9999 -> 10000 grows the body.
function lessonEnvelope(domain, included, total, extras) {
  const payload = lessonPayload(domain, included, total);
  if (extras.domainActive !== null && extras.domainActive !== undefined) {
    payload.domain_active = extras.domainActive;
    payload.nearby = extras.nearby ?? 0;
  }
  if (extras.invalid > 0) payload.invalid = extras.invalid;
  while (true) {
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (bytes === payload.bytes) return payload;
    payload.bytes = bytes;
  }
}

/// Every lesson that MATCHES this path, in delivery order, before the byte
/// ceiling or the nearby channel touch it. `selectLessonsForPath` packs from
/// exactly this list; exported so the delivery replay can tell a lesson that
/// never matched from one the ceiling cut (task 1557 slice 1d).
export function matchLessonsForPath(rows, repoPath, routingMap) {
  const domain = resolveDomain(repoPath, routingMap);
  if (domain === null) return { domain: null, candidates: [], invalidLinks: 0 };

  const candidates = [];
  let invalidLinks = 0;
  for (const row of rows) {
    // one bad row (direct-SQLite import bypasses endpoint validation) must not
    // 500 delivery for the whole domain — skip it, count it loud in the payload
    let links;
    try {
      links = parseStoredLessonLinks(row);
    } catch (error) {
      invalidLinks += 1;
      console.error(`[memory] lessons: skipping ${error.message}`);
      continue;
    }
    if (links.status !== 'active' || links.domain !== domain) continue;
    // What this PATH claims, and nothing else.
    //
    // Until 2026-08-11 every OTHER active lesson of the domain rode along as a
    // `title-index` item: a title with no rule, no why, no evidence. It was
    // introduced without a comment, a doc or a test, and measurement says it
    // was distractor by construction - editing `src/features/chart/ChartPane.tsx`
    // delivered 65 titles of which 0 matched (15 124 B), and
    // `svod/src/adapter/mod.rs` 62 of which 0 matched. Since anchor matches sort
    // first and are never dropped, the 24 KB budget was spent almost entirely on
    // them. Chroma's 2025 context-rot result is that a near-miss delivered
    // beside the right answer is worse than delivering nothing, so the index was
    // not a cheap discovery aid - it was the most expensive thing in the payload.
    //
    // A lesson that legitimately spans several files says so in `globs`, which
    // `lessonMatchesPath` already honours. That is the route for breadth; the
    // whole-domain dump never was.
    const matchKind = lessonPathMatchKind(links, repoPath);
    if (matchKind === null) continue;
    const fields = parseLessonBody(row.body);
    candidates.push({
      row,
      // `anchor` when the lesson names THIS path (or its basename), `class`
      // when it arrived through a glob. Delivery treats both as real matches;
      // only the nearby gate below tells them apart.
      kind: matchKind,
      item: {
        uuid: row.uuid,
        id: Number(row.id),
        title: row.title,
        anchor: links.anchor,
        trigger: links.trigger ?? fields.trigger ?? null,
        rule: fields.rule ?? null,
        why: fields.why ?? null,
        evidence: fields.evidence ?? null,
        date: fields.date ?? null,
        // `anchor` names THIS path; `class` arrived through a glob and is a
        // rule about a class the path belongs to. One label per route, because
        // the banner above the blocks already says which of the two happened
        // and a reader comparing the two must not find them disagreeing -
        // named as a blocker by the glm seat of round `harness-memory-r1`,
        // and by the codex seat through the member prompt that renders them.
        match: matchKind,
      },
    });
  }
  candidates.sort((left, right) => (
    (left.item.title < right.item.title ? -1 : left.item.title > right.item.title ? 1 : 0)
    || Number(left.row.id) - Number(right.row.id)
  ));
  return { domain, candidates, invalidLinks };
}

/// The selection half of the `lessons` route, exported so the delivery replay
/// (scripts/memory/eval-delivery-replay.mjs) asks the SAME code what a commit
/// would have been handed, instead of growing a second copy that drifts.
/// `rows` are the live lesson rows the route would read; `routingMap` comes
/// from `loadRoutingMap()`.
export function selectLessonsForPath(rows, repoPath, routingMap) {
  const { domain, candidates, invalidLinks } = matchLessonsForPath(rows, repoPath, routingMap);
  if (domain === null) return lessonPayload(null, [], 0);

  // ONE way to build this answer, asked by EVERY gate and by the return.
  //
  // Round `harness-memory-r2` (4/4 REQUEST_CHANGES, every measurement
  // reproduced) found four faults of one shape here: the admission loops
  // weighed a different object than the answer carried. The class loop weighed
  // bare `lessonPayload` while the answer went out with `domain_active`,
  // `nearby` and `invalid` attached, so the wire answer crossed the ceiling by
  // 1-30 bytes (kimi 24577 and 24587, codex 24605, glm 24588 and 24604); the
  // anchored branch attached `invalid` AFTER the fixed point, so `bytes` itself
  // understated by the marker (glm: delivered 24578, json.bytes 24566); and the
  // gates passed a different `total` than the return, so `omitted` had a
  // different digit count in the trial than in the answer.
  //
  // The remedy is not a reserved constant - a guessed reserve is a second way
  // to measure the same thing - but ONE builder that attaches exactly the
  // fields the CHOSEN branch will carry. `anchoredHere` decides that, and it is
  // knowable before anything is packed, so it is computed first.
  const anchoredHere = candidates.some((candidate) => candidate.kind === 'anchor');
  // What the domain holds, so an EMPTY answer can say which emptiness it is.
  // Only the nearby branch carries it, so only that branch pays for counting it.
  const active = anchoredHere ? null : domainActive(domain);
  const nearbyCount = (items) => items.filter(({ item }) => item.match === 'nearby').length;
  // `omitted` counts what was OWED and not delivered - the class rules that did
  // not fit. Neighbours are not owed to anybody, so they are added to BOTH
  // sides and cancel out of the subtraction.
  const totalFor = (items) => candidates.length + nearbyCount(items);
  const build = (items) => lessonEnvelope(domain, items, totalFor(items), {
    // `null` is what says "this branch carries no envelope counts at all" -
    // an anchored answer has neither, and a zero would be a different answer.
    domainActive: anchoredHere ? null : active,
    nearby: nearbyCount(items),
    invalid: invalidLinks,
  });
  // THE GUARANTEE, and it is this function rather than the loops above.
  //
  // Admission is optimistic - a gate cannot know how many neighbours will join
  // later, and every join grows the envelope - so the built answer is weighed
  // once more and TRAILING items are dropped until it fits. Neighbours sit last
  // by construction, so a class rule that DID match this path never falls
  // before a neighbour that did not.
  //
  // Measured while writing this: reverting the class loop to weigh bare
  // `lessonPayload` again - the exact defect round `harness-memory-r2` found -
  // leaves every test green, because this settle pops precisely what that loop
  // would have skipped. So the loops asking `build` is not what keeps the
  // answer inside the ceiling; it is what keeps this settle from having to
  // undo work, and what keeps one question from being asked in two shapes.
  // Said out loud rather than dressed up in a test that would only be
  // asserting the mechanism it already agreed with.
  const settle = (items) => {
    const chosen = [...items];
    while (chosen.length > 0 && build(chosen).bytes > LESSONS_MAX_BYTES) chosen.pop();
    return build(chosen);
  };

  const included = [];
  for (const candidate of candidates) {
    // SKIP the one that does not fit, do not stop at it. Stopping made one
    // oversized rule swallow every rule sorted behind it: measured by the grok
    // seat of round `harness-memory-r1` with a 40 000-byte rule titled `AAA`
    // and a small one titled `zzz` - the small one was never tried, and
    // reversing the titles delivered it. `omitted` counts the loss either way;
    // this only decides whether the loss is one rule or all of them.
    if (build([...included, candidate]).bytes > LESSONS_MAX_BYTES) continue;
    included.push(candidate);
  }
  // CANDIDATES, not what survived the byte filter.
  //
  // Gated on `included` this branch fired when a path HAD an exact lesson that
  // simply did not fit the payload budget: the caller then got neighbours, the
  // "NOTHING is anchored to this path" banner, and `omitted: 0` erasing the
  // loss - a lie about the one thing this route exists to state truthfully.
  // All four seats of round `lessons-nearby-r1` found it independently.
  //
  // And ANCHORED candidates, not any candidate. A `class` match arrives
  // through a glob, which says "this rule is about a class your file belongs
  // to" - it does not say anybody wrote a rule about this file, so it must not
  // silence the neighbours the way a real anchor does. Measured 2026-08-21
  // over the whole tree: 279 files had their nearby channel suppressed by a
  // glob, and for 212 of them the globbing lesson was ALREADY their first
  // neighbour - so the glob delivered nothing new and evicted two other rules
  // each. Live probe: `crates/element-detectors/src/bias.rs` answered with
  // exactly one item (#4001, reached by glob) while its unglobbed sibling
  // `effort_v2_grade/grading.rs` answered with three.
  if (!anchoredHere) {
    // NOTHING IS ANCHORED HERE. That is not the same fact as "nothing is
    // known about this code", and until now the answer could not tell them
    // apart: 492 of 683 active lessons are anchored to `file:SYMBOL`, 382
    // anchors cover 4423 source files, and 80.2% of files therefore matched
    // nothing. A lead reading "no lessons for domain domain-platform-shell"
    // concluded nobody knew anything, while that domain held 145.
    //
    // So the nearest lessons ride instead, and NEAREST means the path, not
    // the domain. That distinction is the whole design:
    //
    //   * by domain recency  - 8% of the offers came from the file's own
    //     directory, 31% from even the same top-level tree. That is the
    //     whole-domain dump this route dropped on 2026-08-11, in a smaller
    //     hat, and the measurement above says it would earn the same verdict.
    //   * by path proximity  - measured over 40 unmatched files: 50% have a
    //     lesson in their OWN directory, another 28% in the parent. Only 22%
    //     have nothing closer, and those get no items at all.
    //
    // It rides ONLY when the exact answer is empty, so it never sits beside a
    // real match - which is what the 2025 context-rot result is about, and
    // what the removed title-index did wrong. It is capped at three, it
    // carries the whole lesson rather than a bare title, and every item says
    // `match: "nearby"` so a reader is never told this is about its file.
    const own = repoPath.split('/').slice(0, -1);
    const shared = (anchorPath) => {
      const other = anchorPath.split('/').slice(0, -1);
      let n = 0;
      while (n < own.length && n < other.length && own[n] === other[n]) n += 1;
      return n;
    };
    const near = [];
    // A class rule that reached this path is ALSO, usually, a lesson anchored
    // in the neighbourhood - so without this it would be offered twice, once
    // as the rule about the class and once as a neighbour.
    const alreadyMatched = new Set(candidates.map((candidate) => candidate.row.uuid));
    for (const row of rows) {
      if (alreadyMatched.has(row.uuid)) continue;
      let links;
      try {
        links = parseStoredLessonLinks(row);
      } catch {
        continue;
      }
      if (links.status !== 'active' || links.domain !== domain) continue;
      const separator = links.anchor.indexOf(':');
      const anchorPath = separator === -1 ? links.anchor : links.anchor.slice(0, separator);
      const depth = shared(anchorPath);
      // The parent directory is the floor - EXCEPT there is no parent above a
      // top-level directory, and `own.length - 1` was 0 there: every lesson of
      // the domain shared a prefix of zero and qualified. That is the whole
      // domain dump wearing a proximity label, which is what the floor exists
      // to refuse. Found as P1 by the grok seat of `lessons-nearby-r1`.
      //
      // So a shallow path demands its OWN directory, and only a path with a
      // real ancestor may reach one level up. A file at the repository root
      // (`own.length === 0`) has no directory to be near and is offered
      // nothing.
      const floor = own.length >= 2 ? own.length - 1 : own.length;
      if (floor < 1 || depth < floor) continue;
      const fields = parseLessonBody(row.body);
      near.push({
        depth,
        row,
        item: {
          uuid: row.uuid,
          id: Number(row.id),
          title: row.title,
          anchor: links.anchor,
          trigger: links.trigger ?? fields.trigger ?? null,
          rule: fields.rule ?? null,
          why: fields.why ?? null,
          evidence: fields.evidence ?? null,
          date: fields.date ?? null,
          match: 'nearby',
        },
      });
    }
    near.sort((left, right) => (right.depth - left.depth) || (Number(right.row.id) - Number(left.row.id)));
    const offered = [];
    for (const candidate of near.slice(0, LESSONS_NEARBY_MAX)) {
      // `included` first, always: a class rule that DID match this path is
      // never dropped to make room for a neighbour.
      //
      // And SKIP, do not stop - the same correction the class loop above got
      // and this one did not. Measured by the grok seat of round
      // `harness-memory-r2`: a huge first neighbour emptied the whole offer
      // (`items` came back empty) while reversing the order delivered the small
      // one, so what the caller received depended on which neighbour sorted
      // first rather than on what fit.
      if (build([...included, ...offered, candidate]).bytes > LESSONS_MAX_BYTES) continue;
      offered.push(candidate);
    }
    return settle([...included, ...offered]);
  }
  return settle(included);

/// How many active lessons the domain holds, whatever this path matched.
///
/// Only used to tell one emptiness from the other in the answer text.
function domainActive(domain) {
  let count = 0;
  for (const row of rows) {
    try {
      const links = parseStoredLessonLinks(row);
      if (links.status === 'active' && links.domain === domain) count += 1;
    } catch {
      /* a row that cannot be read is not a lesson this count may claim */
    }
  }
  return count;
}
}

/// What delivering these lessons to ONE file would weigh ON THE WIRE.
///
/// Exported for the SENSOR, and the export is the whole point. `check-domain-
/// routing.mjs` used to sum raw BODY bytes and compare that to the delivery
/// ceiling, which are two different units: the answer the service actually
/// sends is a JSON envelope whose items carry field names, JSON escaping and a
/// header, so it is ALWAYS larger than the bodies it was built from. A file
/// whose bodies sat just under the ceiling therefore delivered NOTHING while the
/// sensor exited 0 in silence - measured by the codex seat of round
/// `harness-tails-r1` with a 48 711-byte body under a 49 152-byte ceiling:
/// `items: 0, omitted: 1`, sensor quiet.
///
/// So the sensor asks THIS, which builds the same payload through the same
/// `lessonPayload` fixed point.
///
/// **The envelope fields are attached at their REAL width, and that took a
/// second round to get right.** The first version hard-coded `domain_active: 0`
/// and `nearby: 0` and called that "erring early"; it is not, because those
/// fields are NUMBERS and the live branch writes the domain's actual count -
/// three digits for `domain-harness` today. Codex, grok and kimi each measured
/// the same 1-2 byte window in round `lessons-wire-r1`: a single glob-matched
/// rule weighed exactly 49 152 by the sensor while the live answer came to
/// 49 153 and dropped it, silently. So the caller passes what the domain HOLDS,
/// and the nearby slot is counted at its maximum - a warning may only err early,
/// and a field whose width is guessed is not erring, it is wrong.
export function deliveredLessonBytes(domain, rows, domainActive = 0, invalid = 0) {
  const included = rows.map((row) => {
    const links = typeof row.links === 'string' ? JSON.parse(row.links) : (row.links ?? {});
    const fields = parseLessonBody(String(row.body ?? ''));
    return {
      row: { uuid: row.uuid, version: Number(row.version ?? 1) },
      item: {
        uuid: row.uuid,
        id: Number(row.id),
        title: String(row.title ?? ''),
        anchor: links.anchor ?? null,
        trigger: links.trigger ?? fields.trigger ?? null,
        rule: fields.rule ?? null,
        why: fields.why ?? null,
        evidence: fields.evidence ?? null,
        date: fields.date ?? null,
        match: 'anchor',
      },
    };
  });
  // The WIDEST envelope a live answer of this shape can carry, through the one
  // builder the delivery itself uses. Nothing is re-listed here: a field added
  // to the envelope reaches this weighing the moment it reaches the answer.
  return lessonEnvelope(domain, included, included.length, {
    domainActive: Number(domainActive) || 0,
    nearby: LESSONS_NEARBY_MAX,
    invalid: Number(invalid) || 0,
  }).bytes;
}

function parseJsonBody(bodyStr) {
  if (typeof bodyStr !== 'string' || !bodyStr) throw new HttpError(400, 'request body must be JSON');
  try {
    const value = JSON.parse(bodyStr);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `invalid JSON body: ${error.message}`);
  }
}

function jsonText(value, field) {
  if (value === undefined) return '[]';
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch (error) {
      throw new HttpError(400, `invalid JSON in ${field}: ${error.message}`);
    }
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new HttpError(400, `invalid JSON in ${field}`);
  return encoded;
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  return value;
}

function validateLessonLinks(encodedLinks) {
  const links = JSON.parse(encodedLinks);
  const problems = lessonLinksProblems(links);
  // `must be a JSON object` is TERMINAL: there is no `.anchor` to reach on a
  // null, an array or a number, and reaching for one turned a clean 400 into a
  // 500 with an internal TypeError in the body. Four independent reviewers
  // measured `links: null` -> HTTP 500 "Cannot read properties of null
  // (reading 'anchor')" against this route; the non-object cases also collected
  // a nonsense second sentence about `anchor "undefined"`.
  const isObject = links !== null && typeof links === 'object' && !Array.isArray(links);
  // The anchor's SHAPE is only a meaningful question once the anchor is a
  // non-empty string at all; otherwise the caller would be told twice about the
  // same missing field.
  if (isObject && !problems.some((problem) => problem.startsWith('anchor '))) {
    const anchorProblem = lessonAnchorProblem(links.anchor);
    if (anchorProblem) problems.push(anchorProblem);
  }
  // One refusal carries every problem AND the shape, so a caller needs exactly
  // one round trip to learn what this route wants.
  if (problems.length) {
    throw new HttpError(400, `lesson links ${problems.join('; ')} — ${LESSON_LINKS_SHAPE}`);
  }
}

/// Server half of the lesson capture gate (decisions #12326, #12329). The
/// client gate (capture-gate.mjs gateNewLesson) needs git refs and Jev, which
/// memoryd, run from installed code, has neither of, so it stamps `links.gate`; here a NEW
/// lesson is refused without that stamp, or when its domain is not the route of
/// its anchor in the map memoryd serves. A supersede that moves the anchor needs
/// a FRESH stamp (not the one the old row carried), and one that moves the anchor
/// or the domain must land on the anchor's route; a supersede that keeps both
/// (status, retire, body edit, legacy rows) is not judged. The stamp is an
/// accident guard against an agent using the wrong command (a raw append, an MCP
/// append, an importer), NOT authentication: anyone holding the write token can
/// forge it.
export const LESSON_GATE_VERSION = 1;
const LESSON_GATE_FIX = 'capture new lessons with scripts/memory/capture-lesson.mjs';

function lessonGateStamped(gate) {
  return gate !== null && typeof gate === 'object' && !Array.isArray(gate)
    && gate.v === LESSON_GATE_VERSION && typeof gate.at === 'string'
    && Number.isFinite(Date.parse(gate.at)) && new Date(gate.at).toISOString() === gate.at;
}

function lessonRouteProblem(links, routingMap) {
  const raw = links.anchor.trim();
  const file = raw.includes(':') ? raw.slice(0, raw.indexOf(':')).trim() : raw;
  const domain = resolveDomain(file, routingMap);
  return links.domain === domain ? null : `anchor ${raw} routes to ${domain ?? 'no domain'}, not ${links.domain}`;
}

function lessonGateProblem(encodedLinks, routingMap) {
  const links = JSON.parse(encodedLinks);
  if (!lessonGateStamped(links.gate)) return `new lesson refused: links carry no capture-gate marker; ${LESSON_GATE_FIX}`;
  const route = lessonRouteProblem(links, routingMap);
  return route ? `new lesson refused: ${route}; ${LESSON_GATE_FIX}` : null;
}

function lessonSupersedeProblem(oldEncoded, newEncoded, routingMap) {
  const previous = JSON.parse(oldEncoded ?? 'null') ?? {};
  const links = JSON.parse(newEncoded);
  const anchorMoved = previous.anchor !== links.anchor;
  if (!anchorMoved && previous.domain === links.domain) return null;
  // Fresh = a stamp newer than the one the row already carries; comparing whole JSON let an
  // added key pass as fresh (review reviewer-grok-c17553.1).
  if (anchorMoved && (!lessonGateStamped(links.gate)
    || (lessonGateStamped(previous.gate) && Date.parse(links.gate.at) <= Date.parse(previous.gate.at)))) {
    return 'lesson supersede refused: a moved anchor needs a fresh capture-gate marker; '
      + 'move it with scripts/memory/reanchor-lesson.mjs, which runs the gate';
  }
  const route = lessonRouteProblem(links, routingMap);
  return route ? `lesson supersede refused: ${route}; keep the anchor's routed domain` : null;
}

function validateEntry(input, forcedKind = null) {
  const kind = forcedKind || input.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    throw new HttpError(400, unknownKind(kind));
  }
  if (typeof input.title !== 'string' || !input.title.trim()) {
    throw new HttpError(400, 'missing title');
  }
  if ([...input.title].length > MAX_TITLE_CHARS) {
    throw new HttpError(400, `title exceeds ${MAX_TITLE_CHARS} characters`);
  }
  if (typeof input.body !== 'string' || input.body.length === 0) {
    throw new HttpError(400, 'missing body');
  }
  const bodyBytes = Buffer.byteLength(input.body, 'utf8');
  if (bodyBytes > MAX_BODY_BYTES) {
    throw new HttpError(400, `body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  if (input.pinned !== undefined && ![true, false, 0, 1].includes(input.pinned)) {
    throw new HttpError(400, 'pinned must be a boolean');
  }

  const links = jsonText(input.links, 'links');
  if (kind === 'lesson') validateLessonLinks(links);
  // The track a handoff declares — in links or in the body marker — is judged
  // here, at the ONE door append, handoff and supersede all pass through.
  // gen-tracks REFUSES a bad slug or status and exits 1, so a row written with
  // one breaks `npm run tracks` for every session after it: measured 2026-09-14
  // on handoffs #8119/#8212, which carried the WHOLE links JSON double-encoded
  // as the track. A JSON-looking string or an object under `track` is the
  // caller encoding twice; it is refused, never parsed back.
  //
  // A handoff whose own title marks it as history (SEARCH_DEAD_TITLE —
  // `ARCHIVED:` from a consolidation) is not a track at all: gen-tracks skips
  // it by the same regex, so the writer does not judge its declaration. That
  // predicate runs FIRST — the consolidator's links.status "archived" is
  // legitimate exactly there and nowhere else.
  {
    const history = kind === 'handoff' && SEARCH_DEAD_TITLE.test(input.title);
    const decoded = JSON.parse(links);
    if (!history && decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
      // The SLUG is judged on every kind (nothing but a handoff has a use for
      // links.track at all); the STATUS vocabulary is a handoff-track concept —
      // lesson links carry their own statuses (active|inbox|retired), judged by
      // validateLessonLinks above.
      const problem = trackSlugProblem(decoded.track)
        ?? (kind === 'handoff' ? trackStatusProblem(decoded.status) : null);
      if (problem) throw new HttpError(400, `links ${problem} — ${TRACK_LINKS_SHAPE}`);
    }
    if (kind === 'handoff' && !history) {
      const marker = parseTrackMarker(input.body);
      const problem = trackSlugProblem(marker.track) ?? trackStatusProblem(marker.status);
      if (problem) {
        throw new HttpError(400, `body marker ${problem} — the marker takes <!-- track: <slug> | status: <s> | next: <step> -->`);
      }
    }
  }
  // A report is a STRUCTURED answer, and the one kind whose body is machine-read
  // rather than human-read. Accepting prose under it does not store a report - it
  // stores a row that every reader downstream must reject, and by then the member
  // that could have fixed it in one line has finished and gone.
  //
  // Measured 2026-08-07: a member that delivered a valid verdict and then filed a
  // prose "I delivered too early" note had the prose returned as its NEWEST
  // delivery, which the engine turned into a refusal - the junk vetoed both the
  // member's own valid report and its message. Refusing at the door is what stops
  // a junk row from ever becoming the newest one.
  //
  // JSON and nothing more: the store owns the kind, not the schema of any
  // particular profile's report. What shape a verdict or a criteria list must
  // take is Svod's question, and it stays there.
  if (kind === 'report') {
    try {
      JSON.parse(input.body);
    } catch (error) {
      throw new HttpError(
        400,
        `a report body must be the JSON object itself, not prose about it (${error.message}) — `
        + 'deliver the object your completion contract asks for',
      );
    }
  }

  return {
    kind,
    key: optionalString(input.key, 'key'),
    title: input.title,
    body: input.body,
    sessionId: optionalString(input.session_id, 'session_id'),
    agent: optionalString(input.agent, 'agent'),
    links,
    shaRefs: jsonText(input.sha_refs, 'sha_refs'),
    pinned: input.pinned ? 1 : 0,
    sourcePath: optionalString(input.source_path, 'source_path'),
  };
}

function taskText(value, field, maxChars, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `missing ${field}`);
    return null;
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new HttpError(400, `missing ${field}`);
    return null;
  }
  if ([...trimmed].length > maxChars) {
    throw new HttpError(400, `${field} exceeds ${maxChars} characters`);
  }
  return trimmed;
}

/**
 * The priority a WRITE may carry.
 *
 * An update with no priority keeps the row's own — including a retired one, so
 * closing a legacy P2 does not have to rewrite it into something it never was.
 */
function taskPriority(value, fallback = null) {
  if (value === undefined || value === null) {
    if (fallback) return fallback;
    throw new HttpError(400, 'missing priority');
  }
  if (TASK_PRIORITIES.includes(value)) return value;
  if (TASK_PRIORITIES_STORED.includes(value)) {
    // Named explicitly, because "must be one of P0, P1" reads as a typo report
    // when the caller deliberately typed a priority that used to exist.
    throw new HttpError(400, `${value} was retired on 2026-08-05: work below P1 is not a task — `
      + 'do it now, or let it go. '
      + 'Ready: memoryctl task create --title <t> --priority P0|P1 --next <step>');
  }
  throw new HttpError(400, `priority must be one of ${TASK_PRIORITIES.join(', ')}. `
    + 'Ready: memoryctl task create --title <t> --priority P0|P1 --next <step>');
}

/** The priority a READ may name: everything the table can hold. */
function storedTaskPriority(value) {
  if (!TASK_PRIORITIES_STORED.includes(value)) {
    throw new HttpError(400, `priority must be one of ${TASK_PRIORITIES_STORED.join(', ')}`);
  }
  return value;
}

function taskStatus(value, fallback = 'open') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !TASK_STATUSES.has(value)) {
    throw new HttpError(400, `status must be one of ${[...TASK_STATUSES].join(', ')}`);
  }
  return value;
}

function taskIdList(value, field) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be an array of task ids`);
  if (value.length > MAX_TASK_DEPENDENCIES) {
    throw new HttpError(400, `${field} exceeds ${MAX_TASK_DEPENDENCIES} entries`);
  }
  const ids = value.map((entry) => {
    const id = Number(entry);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new HttpError(400, `${field} must contain positive integer task ids`);
    }
    return id;
  });
  return [...new Set(ids)];
}

function taskIdParam(value, field = 'id') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(400, `${field} must be a positive integer`);
  }
  return id;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, payload, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(payload);
}

function firstLine(value, maxChars = 200) {
  const line = String(value).split(/\r?\n/, 1)[0].replace(/\r/g, ' ');
  const chars = [...line];
  return chars.length <= maxChars ? line : `${chars.slice(0, maxChars - 1).join('')}…`;
}

function sameToken(presented, expected) {
  if (typeof presented !== 'string') return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readToken(tokenPath) {
  const value = fs.readFileSync(tokenPath, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`memory token must contain exactly 32 bytes as lowercase hex: ${tokenPath}`);
  }
  return value;
}

// The patience every lock in the open sequence gets, in milliseconds.
//
// `PRAGMA journal_mode=WAL` is the one statement this budget does NOT buy
// patience for: measured on this tree, the mode switch attempted while a
// sibling opener holds the write lock returns SQLITE_BUSY IMMEDIATELY
// (errcode 5, "database is locked", 0 ms wait) with busy_timeout already set -
// SQLite does not consult the busy handler for a journal-mode change - while
// BEGIN IMMEDIATE under the same held lock waits the timeout out and takes
// the lock. Every opener runs that switch, so two processes opening one fresh
// database raced here and the loser died with "database is locked": on macOS
// the test's children genuinely overlap and the suite went red every other
// run, on Windows spawn overhead serialized them and hid the same defect
// (1 dead round in 30 with the children barrier-aligned). The Rust half of
// this repository met the same wall in svod's index store and settled on the
// same cure: retry the contention yourself, bounded, and rethrow past the
// deadline - never succeed quietly.
const BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;

function setWalJournalMode(db) {
  // performance.now(), not Date.now(): a deadline is a duration, and the wall
  // clock can jump under it.
  const deadline = performance.now() + BUSY_TIMEOUT_MS;
  let backoffMs = 1;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode=WAL');
      return;
    } catch (error) {
      // Only plain lock contention is retried: the switch has no other
      // transient failure, and swallowing anything else here would be a
      // success-shaped stub. Past the deadline the original error goes out.
      if (error?.errcode !== SQLITE_BUSY || performance.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 25);
    }
  }
}

export function openMemoryDb(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir must be a non-empty string');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const tokenPath = path.join(stateDir, 'memory.token');
  ensureToken(tokenPath);

  const dbPath = path.join(stateDir, 'memory.db');
  try {
    // Only create a missing database: never truncate or chmod an existing one.
    // SQLite derives WAL/SHM permissions from the database's mode.
    const fd = fs.openSync(dbPath, 'wx', 0o600);
    try {
      // A restrictive umask may remove owner bits, so set the exact mode on
      // our newly created inode before SQLite opens it.
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const db = new DatabaseSync(dbPath);
  try {
    // busy_timeout FIRST: it is what makes BEGIN IMMEDIATE - the migration
    // lock - and everything after it patient. The journal-mode switch above is
    // the one statement it cannot help.
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    setWalJournalMode(db);
    db.exec(`
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
`);
    migrate(db);
    // The closed twin of the live dedup index (task 2800), created at OPEN
    // rather than by a migration: a schema bump would make every older opener
    // refuse the migrated file - the NAS rollback copy and
    // verify-memory-transfer.mjs among them (review r2, grok). Partial on
    // closed rows only, so live rows stay indexed exactly once, by the unique
    // index that already governs them. IF NOT EXISTS keeps re-opens cheap.
    db.exec('CREATE INDEX IF NOT EXISTS idx_mem_entries_closed_dedup'
      + ' ON mem_entries(kind, title, content_hash) WHERE superseded_by IS NOT NULL');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function createMemory({ db, tokenPath, denseVectors = new Map(), textHashes = createTextHashCache(db), routing = loadRoutingMap }) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db must be a DatabaseSync instance');
  if (typeof tokenPath !== 'string' || !tokenPath) throw new TypeError('tokenPath must be a non-empty string');

  let token = readToken(tokenPath);

  // The scope predicate is the SAME expression the unique index carries. Written
  // once and interpolated into both statements: a query that compares less than
  // the index enforces does not dedup - it hits a constraint error instead, which
  // is the same lost write wearing a 500.
  const findDuplicate = db.prepare(`
SELECT id, uuid FROM mem_entries
WHERE kind = ? AND title = ? AND content_hash = ? AND superseded_by IS NULL
  AND (${SESSION_SCOPE_SQL}) = ?
LIMIT 1`);
  // supersede path: the row being replaced is still live during the check — exclude it,
  // else a status-only supersede (same body) false-409s against itself (3C finding).
  const findDuplicateExcluding = db.prepare(`
SELECT id, uuid FROM mem_entries
WHERE kind = ? AND title = ? AND content_hash = ? AND superseded_by IS NULL
  AND (${SESSION_SCOPE_SQL}) = ? AND id != ?
LIMIT 1`);
  // The closed twin of the same lookup (task 2800): SAME key columns and scope,
  // no looser, but over rows already superseded — a claim retired as wrong must
  // not return as a fresh live row just because its old row stopped being live.
  // Newest closed match first: its chain is the one a later re-assertion lives
  // in. Served by idx_mem_entries_closed_dedup (migration v8).
  const findClosedDuplicate = db.prepare(`
SELECT id, superseded_by FROM mem_entries
WHERE kind = ? AND title = ? AND content_hash = ? AND superseded_by IS NOT NULL
  AND (${SESSION_SCOPE_SQL}) = ?
ORDER BY id DESC
LIMIT 1`);
  const insertVersion = db.prepare(`
INSERT INTO mem_entries(
  uuid, ts, session_id, agent, kind, key, title, body, links, sha_refs,
  pinned, content_hash, source_path, supersedes, superseded_by, version
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
  const getEntryById = db.prepare('SELECT * FROM mem_entries WHERE id = ?');
  const getEntryByUuid = db.prepare('SELECT * FROM mem_entries WHERE uuid = ?');
  const getLiveByKey = db.prepare(
    'SELECT * FROM mem_entries WHERE key = ? AND superseded_by IS NULL LIMIT 1',
  );
  const markSuperseded = db.prepare(
    'UPDATE mem_entries SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL',
  );
  // second hop of the supersede two-step: old row is already self-closed, re-point to the real successor
  const repointSuperseded = db.prepare(
    'UPDATE mem_entries SET superseded_by = ? WHERE id = ? AND superseded_by = id',
  );
  const setEntryKey = db.prepare('UPDATE mem_entries SET key = ? WHERE id = ?');
  const setSupersedesIfEmpty = db.prepare('UPDATE mem_entries SET supersedes = ? WHERE id = ? AND supersedes IS NULL');
  const searchAll = db.prepare(`
SELECT e.id, e.uuid, e.kind, e.title,
       snippet(mem_entries_fts, 1, '<mark>', '</mark>', '…', 24) AS snippet,
       e.ts, e.pinned, bm25(mem_entries_fts, ${SEARCH_BM25_WEIGHTS.join(', ')}) AS rank
FROM mem_entries_fts
JOIN mem_entries e ON e.id = mem_entries_fts.rowid
WHERE mem_entries_fts MATCH ? AND e.superseded_by IS NULL AND e.kind != 'report'
ORDER BY bm25(mem_entries_fts, ${SEARCH_BM25_WEIGHTS.join(', ')}), e.ts DESC, e.id DESC
LIMIT ? OFFSET ?`);
  const denseEntries = db.prepare(`
SELECT id, uuid, kind, title, ts, pinned FROM mem_entries
WHERE superseded_by IS NULL AND kind != 'report'`);
  const idMatches = db.prepare('SELECT rowid FROM mem_entries_fts WHERE mem_entries_fts MATCH ?');
  const denseBody = db.prepare('SELECT body FROM mem_entries WHERE id = ?');
  const searchKind = db.prepare(`
SELECT e.id, e.uuid, e.kind, e.title,
       snippet(mem_entries_fts, 1, '<mark>', '</mark>', '…', 24) AS snippet,
       e.ts, e.pinned, bm25(mem_entries_fts, ${SEARCH_BM25_WEIGHTS.join(', ')}) AS rank
FROM mem_entries_fts
JOIN mem_entries e ON e.id = mem_entries_fts.rowid
WHERE mem_entries_fts MATCH ? AND e.superseded_by IS NULL AND e.kind = ?
ORDER BY bm25(mem_entries_fts, ${SEARCH_BM25_WEIGHTS.join(', ')}), e.ts DESC, e.id DESC
LIMIT ? OFFSET ?`);
  const liveEntries = db.prepare(`
SELECT id, version, kind, title, body, pinned, ts, links
FROM mem_entries
WHERE superseded_by IS NULL`);
  // The session lookup goes through `idx_mem_entries_session_ts` rather than
  // filtering `liveEntries` in JS: that query carries neither `session_id` nor
  // `agent`, and over a thousand live entries a per-call scan is a scan.
  const sessionEntries = db.prepare(`
SELECT id, uuid, ts, session_id, agent, kind, title, body, pinned
FROM mem_entries
WHERE session_id = ? AND superseded_by IS NULL
ORDER BY ts DESC, id DESC`);
  const sessionEntriesOfKind = db.prepare(`
SELECT id, uuid, ts, session_id, agent, kind, title, body, pinned
FROM mem_entries
WHERE session_id = ? AND kind = ? AND superseded_by IS NULL
ORDER BY ts DESC, id DESC`);
  const liveLessonRows = db.prepare(`
SELECT id, uuid, title, body, links, version
FROM mem_entries
WHERE kind = 'lesson' AND superseded_by IS NULL
ORDER BY id`);
  const denseLessonRows = db.prepare(`
SELECT id, links FROM mem_entries
WHERE kind = 'lesson' AND superseded_by IS NULL ORDER BY id`);
  const handoffRows = db.prepare(`
SELECT id, title, ts, body, source_path
FROM mem_entries
WHERE kind = 'handoff' AND superseded_by IS NULL
ORDER BY ts DESC, id DESC`);
  const allEntries = db.prepare('SELECT * FROM mem_entries ORDER BY id');
  const insertTask = db.prepare(`
INSERT INTO mem_tasks(
  uuid, created_ts, updated_ts, closed_ts, title, body, priority, status, track,
  next_action, blocked_reason, claimed_by, claimed_at, session_id, depends_on, links
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getTaskById = db.prepare('SELECT * FROM mem_tasks WHERE id = ?');
  // Titles alone, for the duplicate check on creation: 750 short strings on
  // this machine, and reading the whole row would carry every body with it.
  const allTaskTitles = db.prepare('SELECT id, title, status FROM mem_tasks ORDER BY id');
  const allTasks = db.prepare('SELECT * FROM mem_tasks ORDER BY id');
  // `carried`: how many entries this task is linked to. A tail re-declared on
  // handoff after handoff is shown with that number instead of being refused
  // (operator 2026-09-14: no gate on carrying a tail).
  const openTasks = db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM mem_task_handoffs h WHERE h.task_id = t.id) AS carried
     FROM mem_tasks t WHERE t.status NOT IN ('done', 'cancelled') ORDER BY t.id`,
  );
  const taskHandoffIds = db.prepare(
    'SELECT entry_id FROM mem_task_handoffs WHERE task_id = ? ORDER BY entry_id',
  );
  const linkTaskHandoff = db.prepare(
    'INSERT OR IGNORE INTO mem_task_handoffs(task_id, entry_id, ts) VALUES (?, ?, ?)',
  );
  const handoffTaskIds = db.prepare(
    'SELECT task_id FROM mem_task_handoffs WHERE entry_id = ? ORDER BY task_id',
  );
  const getDeclaration = db.prepare(
    'SELECT handoff_declaration FROM mem_entries WHERE id = ?',
  );
  const setDeclaration = db.prepare(
    'UPDATE mem_entries SET handoff_declaration = ? WHERE id = ?',
  );
  // The claim is the whole point of putting tasks in the single-writer service:
  // one UPDATE guarded on the current owner, not a lock file two agents race.
  const claimTaskRow = db.prepare(`
UPDATE mem_tasks
SET claimed_by = ?, claimed_at = ?, session_id = ?, updated_ts = ?,
    status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END
WHERE id = ? AND (claimed_by IS NULL OR claimed_by = ?)`);
  const releaseTaskRow = db.prepare(`
UPDATE mem_tasks
SET claimed_by = NULL, claimed_at = NULL, updated_ts = ?,
    status = CASE WHEN status = 'in_progress' THEN 'open' ELSE status END
WHERE id = ?`);
  // The closing half of the session-end gate: a handoff that names finished work
  // closes it in the same transaction that writes the handoff, and a decision
  // that withdraws work closes it the same way. Either entry is the evidence,
  // and the task says which one in `links.closed_evidence`.
  const closeTaskRow = db.prepare(`
UPDATE mem_tasks
SET status = ?, blocked_reason = NULL, updated_ts = ?, closed_ts = ?,
    claimed_by = NULL, claimed_at = NULL,
    links = json_set(links, '$.closed_evidence', ?)
WHERE id = ?`);
  const writeListeners = new Set();
  let exportStatusFn = null;

  function authorized(req) {
    const presented = req?.headers?.['x-memory-token'] ?? req?.headers?.['X-Memory-Token'];
    if (sameToken(presented, token)) return true;
    token = readToken(tokenPath);
    return sameToken(presented, token);
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'memory transaction and rollback failed');
      }
      throw error;
    }
  }

  /// Live rule entries that look like the one just written: same content words
  /// in the title, ranked like a search. The writer decides whether the new
  /// entry overturns any of them - the service only makes sure it is asked.
  function relatedRules(title, excludeIds) {
    const terms = ftsTerms(title).filter((term) => !SEARCH_STOPWORDS.has(term));
    if (!terms.length) return [];
    let rows = [];
    try {
      rows = searchAll.all(terms.map(matchTerm).join(' OR '), SEARCH_POOL, 0);
    } catch (error) {
      if (error?.code !== 'ERR_SQLITE_ERROR') throw error;
      return [];
    }
    return rows
      .filter((row) => RULE_KINDS.has(row.kind) && row.kind !== 'lesson' && !excludeIds.has(Number(row.id))
        && !SEARCH_DEAD_TITLE.test(row.title))
      .slice(0, RELATED_ON_WRITE)
      .map((row) => ({
        id: Number(row.id), kind: row.kind, title: row.title, date: entryDay(row.ts), pinned: Boolean(row.pinned),
      }));
  }

  /// `overturns`: ids of LIVE rule entries the new entry replaces, of any rule
  /// kind. Unlike `supersede` it needs no same-kind successor, which is exactly
  /// the case that went unlinked. Every problem is named in one refusal.
  function parseOverturns(input, kind) {
    const raw = input.overturns;
    if (raw === undefined || raw === null) return { ids: [], closedBy: new Map() };
    const list = Array.isArray(raw) ? raw : [raw];
    const problems = [];
    if (!RULE_KINDS.has(kind)) problems.push(`a ${kind} cannot overturn anything; only ${[...RULE_KINDS].join(', ')} can`);
    const ids = [];
    const closedBy = new Map();
    for (const value of list) {
      // An id is an integer or its decimal string, nothing else: Number(true)
      // is 1, and `overturns: true` closed entry #1 (review r1, codex).
      const id = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);
      if (!Number.isInteger(id) || id <= 0) {
        problems.push(`overturns: ${JSON.stringify(value)} is not an entry id`);
        continue;
      }
      const row = getEntryById.get(id);
      if (!row) problems.push(`overturns: entry ${id} does not exist`);
      else if (!RULE_KINDS.has(row.kind)) problems.push(`overturns: entry ${id} is a ${row.kind}, not a rule`);
      else if (row.superseded_by !== null) closedBy.set(id, Number(row.superseded_by));
      else if (!ids.includes(id)) ids.push(id);
    }
    if (problems.length) throw new HttpError(400, problems.join('; '));
    return { ids, closedBy };
  }

  /// Task 2800: describe a CLOSED row carrying this exact claim, for the append
  /// refusal. How it was closed is stored, not guessed: the route that wrote
  /// `superseded_by` signed the closer — an append-named overturn closes with a
  /// version-1 entry, a rewrite with old.version+1 — and a retired lesson chain
  /// carries links.status 'retired' at its head, with the RETIRED reason in the
  /// head title (retire-lesson.mjs). Returns null when the closer is missing
  /// (broken history): nothing to name, so the write proceeds.
  function closedClaimBlock(row) {
    const closedId = Number(row.id);
    const closer = getEntryById.get(row.superseded_by);
    if (!closer) return null;
    // Walk to the live head with a VISITED SET: a supersede chain has no
    // length limit, so a step cap would invent a false "no live head" deep in
    // a long chain (review r1, codex - 66 supersedes answered head_id null).
    // A self-pointer is a close whose transaction died between its two
    // statements; a cycle is corrupt history. Both mean no live head to
    // overturn, and the refusal says which it ran into.
    const visited = new Set([Number(closer.id)]);
    let head = closer;
    while (head.superseded_by !== null) {
      const nextId = Number(head.superseded_by);
      if (nextId === Number(head.id) || visited.has(nextId)) break;
      const next = getEntryById.get(nextId);
      if (!next) break;
      head = next;
      visited.add(nextId);
    }
    const liveHead = head.superseded_by === null ? head : null;
    const cycle = liveHead === null
      && (Number(head.superseded_by) === Number(head.id) || visited.has(Number(head.superseded_by)));
    const headId = liveHead === null ? null : Number(liveHead.id);
    let headLinks = {};
    try { headLinks = JSON.parse(liveHead?.links ?? '{}') ?? {}; } catch { headLinks = {}; }
    const retired = liveHead?.kind === 'lesson' && headLinks.status === 'retired';
    const closure = Number(closer.version) === 1 ? 'overturned' : retired ? 'retired' : 'rewritten';
    // The retirement reason is prose in the head title (retire-lesson.mjs),
    // not a field: shown as written, up to the em-dash separator it added.
    let reason = '';
    if (retired) {
      const title = String(liveHead.title ?? '');
      reason = /^(?:RETIRED|MERGED-INTO):\s*(.*?)(?:\s+—\s|$)/.exec(title)?.[1] ?? title;
    }
    const when = entryDay(closer.ts);
    const wayThrough = headId !== null && RULE_KINDS.has(liveHead.kind)
      ? `if the claim is right now, re-assert it in one write: append with --overturns ${headId}`
      : 'this chain has no live head that can be overturned; write a distinct claim (different title or body)';
    return {
      headId,
      message: `closed-duplicate: memory entry ${closedId} already carries this exact claim, closed by entry ${Number(closer.id)} `
        + `on ${when} as ${closure}${reason ? ` (${reason})` : ''}`
        + (headId !== null ? `; the chain's live head is entry ${headId}`
          : `; the chain has no live head${cycle ? ' (it points into itself - corrupt history)' : ''}`)
        + ` — ${wayThrough}`,
      details: {
        refusal: 'closed-duplicate',
        existing_id: closedId,
        closed_by: Number(closer.id),
        closed_on: when,
        head_id: headId,
        closure,
        ...(reason ? { reason } : {}),
      },
    };
  }

  function append(input, forcedKind = null) {
    if (forcedKind === null && input.kind === 'registry') {
      throw new HttpError(400, 'registry entries must be written through the CAS registry route');
    }
    const entry = validateEntry(input, forcedKind);
    if (entry.kind === 'lesson') {
      const problem = lessonGateProblem(entry.links, routing());
      if (problem) throw new HttpError(400, problem);
    }
    const { ids: overturns, closedBy } = parseOverturns(input, entry.kind);
    // A row this write names that is ALREADY closed is fine only on a retry:
    // closed by the very entry this write dedups to. Anything else is a stale
    // id and is refused (review r1, grok: a retried overturn answered 400).
    const requireClosedBy = (entryId) => {
      const stale = [...closedBy].filter(([, by]) => by !== entryId);
      if (stale.length) {
        throw new HttpError(400, stale.map(([id, by]) => `overturns: entry ${id} is already superseded by ${by}`).join('; '));
      }
    };
    const closeOverturned = (entryId) => {
      requireClosedBy(entryId);
      for (const oldId of overturns) {
        if (oldId === entryId) throw new HttpError(400, `overturns: entry ${oldId} is the entry being written`);
        if (markSuperseded.run(entryId, oldId).changes !== 1) {
          throw new HttpError(409, `overturns: entry ${oldId} was superseded while this write ran`);
        }
      }
      // The backward link, so `get --follow full_history` on the new rule shows
      // what it replaced (review r2, glm). One column holds one id: the first.
      if (overturns.length) setSupersedesIfEmpty.run(overturns[0], entryId);
    };
    const withRelated = (result) => {
      if (!result.mutated || !RULE_KINDS.has(entry.kind) || entry.kind === 'lesson') return result;
      const related = relatedRules(entry.title, new Set([result.id, ...overturns, ...closedBy.keys()]));
      if (!related.length) return result;
      return {
        ...result,
        related,
        related_hint: 'live rules that look like this one: if the new entry replaces one, close it with '
          + '`memoryctl append ... --overturns <id>` (any rule kind) or `memoryctl supersede --id <id>` (same kind)',
      };
    };
    // Session-end gate: a handoff is the moment work stops, so it is the one
    // write that must account for what is left open. Every other kind is
    // untouched - a gate that fires ten times a day gets removed in a week.
    const declaration = entry.kind === 'handoff' ? handoffDeclaration(input) : null;
    const withdrawn = withdrawnTasks(input, entry.kind);
    const closeWithdrawn = (entryId) => {
      const now = Date.now();
      for (const taskId of withdrawn) {
        linkTaskHandoff.run(taskId, entryId, now);
        closeTaskWithHandoff(taskId, entry.agent, entry.sessionId, entryId, 'cancelled');
      }
    };
    // Both halves of the declaration are linked to the entry: what this session
    // left open, and what it closed. The dedup comparison below reads the same
    // union back, so a retry has to send the same payload to match.
    const declaredTails = declaration
      ? [...declaration.tails, ...declaration.closes]
      : null;
    const contentHash = sha256(entry.body);
    const linkTails = (entryId) => {
      if (!declaration) return;
      const now = Date.now();
      // Record WHICH declaration was made, not just its consequences: an empty
      // link set is indistinguishable from a row that never declared anything.
      setDeclaration.run(declaration.tails.length ? 'tails' : 'none', entryId);
      for (const taskId of declaredTails) linkTaskHandoff.run(taskId, entryId, now);
      // Closing is part of the handoff, not a second command after it. The
      // handoff that closes a task is the evidence it was closed, linked above.
      for (const taskId of declaration.closes) closeTaskWithHandoff(taskId, entry.agent, entry.sessionId, entryId);
    };
    // A re-sent handoff is an idempotent retry only when it declares the SAME
    // tails. Folding a different declaration into the matching prose made one
    // entry own two sessions' tails, and nothing said so.
    //
    // "Nothing is open" IS a declaration, so an entry with no links is not an
    // entry waiting to be given some: guarding on `already.size` let a
    // --no-open-work handoff silently acquire the tails of a later one with the
    // same prose. Empty and non-empty are compared alike, both directions.
    const reconcileDedup = (entryId) => {
      if (!declaredTails) return;
      // Three states, not two. NULL is UNKNOWN - the entry was written before
      // the gate existed - and an unknown declaration cannot be matched against
      // anything, so the retry has to be refused rather than assumed identical.
      const stored = getDeclaration.get(entryId)?.handoff_declaration ?? null;
      if (stored === null) {
        throw new HttpError(409, `memory entry ${entryId} predates the session-end gate, so its declaration is unknown and cannot be matched — write a distinct handoff body`, {
          existing_id: entryId,
          declaration: 'unknown',
        });
      }
      // The link table records WHICH tasks a handoff declared, not which ROLE it
      // gave each one, so the comparison below sees `tails ∪ closes` and cannot
      // tell a retry from the same prose with a task moved between the two.
      // Three reviewers measured that: `A tasks=[5,6] closes=[7]` followed by
      // `B tasks=[5] closes=[6,7]` deduped, and task 6 went open → done although
      // A had deliberately left it open.
      //
      // State answers what the schema cannot. A genuine retry closed its
      // `closes` the first time round, so every one of them is closed NOW; one
      // still open means this is a different declaration wearing the same words.
      // That needs no role column and no migration.
      const notActuallyClosed = declaration.closes.filter((id) => {
        const row = getTaskById.get(id);
        return !row || !TASK_CLOSED_STATUSES.has(row.status);
      });
      if (notActuallyClosed.length) {
        throw new HttpError(409, `memory entry ${entryId} carries this prose already, but task ${notActuallyClosed.join(', ')} is still open — a retry of a handoff that closed it would find it closed, so this is a different declaration; write a distinct handoff body`, {
          existing_id: entryId,
          still_open: notActuallyClosed,
        });
      }
      const already = new Set(handoffTaskIds.all(entryId).map((row) => Number(row.task_id)));
      const same = already.size === declaredTails.length
        && declaredTails.every((id) => already.has(id));
      if (!same) {
        const describe = (ids) => (ids.length ? `[${ids.join(', ')}]` : 'no open work');
        throw new HttpError(409, `memory entry ${entryId} already declared ${describe([...already])}; this handoff declares ${describe(declaredTails)} — write a distinct handoff body`, {
          existing_id: entryId,
          declared_tasks: [...already],
        });
      }
      linkTails(entryId);
    };
    // The entry and its declaration are ONE fact. Written apart, a rejected link
    // left a live handoff claiming tails it had none of - measured by a reviewer
    // with a trigger on the link table: handoff persisted, links zero, HTTP 500.
    // Non-handoff writes keep the old single-statement path: there is nothing to
    // pair them with, and wrapping every append in a transaction would serialize
    // the whole service for no gain.
    const writeEntry = () => {
    const scope = dedupScope(entry.kind, entry.sessionId);
    const duplicate = findDuplicate.get(entry.kind, entry.title, contentHash, scope);
    if (duplicate) {
      reconcileDedup(Number(duplicate.id));
      closeWithdrawn(Number(duplicate.id));
      closeOverturned(Number(duplicate.id));
      return { id: Number(duplicate.id), uuid: duplicate.uuid, kind: entry.kind, dedup: true, mutated: overturns.length > 0, overturned: overturns };
    }
    // Task 2800: no live duplicate, but the exact claim already exists as a
    // CLOSED row (overturned, rewritten or retired). Refuse before any write,
    // naming the chain — unless this write IS the named way through: it
    // overturns the chain's live head itself, which parseOverturns already
    // accepts, so no new flag and no re-opening of closed rows.
    const closedDuplicate = findClosedDuplicate.get(entry.kind, entry.title, contentHash, scope);
    if (closedDuplicate) {
      const block = closedClaimBlock(closedDuplicate);
      if (block && !(block.headId !== null && overturns.includes(block.headId))) {
        throw new HttpError(409, block.message, block.details);
      }
    }
    if (entry.key !== null) {
      const keyed = getLiveByKey.get(entry.key);
      if (keyed) {
        throw new HttpError(409, `live key '${entry.key}' already belongs to memory entry ${keyed.id}`);
      }
    }

    const uuid = crypto.randomUUID();
    let result;
    try {
      result = insertVersion.run(
        uuid,
        Date.now(),
        entry.sessionId,
        entry.agent,
        entry.kind,
        entry.key,
        entry.title,
        entry.body,
        entry.links,
        entry.shaRefs,
        entry.pinned,
        contentHash,
        entry.sourcePath,
        null,
        1,
      );
    } catch (error) {
      if (String(error?.code || '').startsWith('ERR_SQLITE_CONSTRAINT')) {
        const racedDuplicate = findDuplicate.get(entry.kind, entry.title, contentHash, scope);
        if (racedDuplicate) {
          // Losing the insert race is still a dedup, so it answers to the same
          // rule: a writer that lost may not quietly graft its declaration onto
          // the winner's entry.
          reconcileDedup(Number(racedDuplicate.id));
          closeWithdrawn(Number(racedDuplicate.id));
          closeOverturned(Number(racedDuplicate.id));
          return {
            id: Number(racedDuplicate.id),
            uuid: racedDuplicate.uuid,
            kind: entry.kind,
            dedup: true,
            mutated: overturns.length > 0,
            overturned: overturns,
          };
        }
      }
      throw error;
    }
    linkTails(Number(result.lastInsertRowid));
    closeWithdrawn(Number(result.lastInsertRowid));
    closeOverturned(Number(result.lastInsertRowid));
    return { id: Number(result.lastInsertRowid), uuid, kind: entry.kind, dedup: false, mutated: true, overturned: overturns };
    };

    const written = withRelated(declaredTails || withdrawn.length || overturns.length || closedBy.size
      ? transaction(writeEntry)
      : writeEntry());
    const result = withdrawn.length ? { ...written, closed_tasks: withdrawn } : written;
    if (written.dedup) return result;
    const openTasksNamed = namedOpenTasks(entry, written.id, (id) => getTaskById.get(id));
    return openTasksNamed.length ? { ...result, open_tasks_named: openTasksNamed } : result;
  }

  function supersede(input) {
    const rawId = input.id ?? input.old_id;
    if (input.id !== undefined && input.old_id !== undefined && input.id !== input.old_id) {
      throw new HttpError(400, 'id and old_id disagree');
    }
    const oldId = Number(rawId);
    if (!Number.isSafeInteger(oldId) || oldId <= 0) throw new HttpError(400, 'id must be a positive integer');

    return transaction(() => {
      const old = getEntryById.get(oldId);
      if (!old) throw new HttpError(404, `memory entry ${oldId} not found`);
      if (old.kind === 'registry') {
        throw new HttpError(400, 'registry entries must be written through the CAS registry route');
      }
      if (old.superseded_by !== null) {
        throw new HttpError(409, `memory entry ${oldId} is already superseded`, {
          current_id: Number(old.superseded_by),
        });
      }
      if (input.kind !== undefined && input.kind !== old.kind) {
        throw new HttpError(400, 'kind cannot change when superseding an entry');
      }
      // The gate has to hold on EVERY route that produces a live handoff.
      // Superseding produced one without a declaration, so "the gate lives in
      // the service" was false on the one path an agent reaches by rewriting.
      const declaration = old.kind === 'handoff' ? handoffDeclaration(input) : null;
      const withdrawn = withdrawnTasks(input, old.kind);

      const entry = validateEntry({
        kind: old.kind,
        key: old.key,
        title: input.title,
        body: input.body,
        session_id: input.session_id ?? old.session_id,
        agent: input.agent ?? old.agent,
        links: input.links ?? old.links,
        sha_refs: input.sha_refs ?? old.sha_refs,
        pinned: input.pinned ?? old.pinned,
        source_path: input.source_path ?? old.source_path,
      });
      // kind cannot change above, so only a lesson becomes a lesson here.
      if (entry.kind === 'lesson') {
        const problem = lessonSupersedeProblem(old.links, entry.links, routing());
        if (problem) throw new HttpError(400, problem);
      }
      const contentHash = sha256(entry.body);
      const duplicate = findDuplicateExcluding.get(
        entry.kind,
        entry.title,
        contentHash,
        dedupScope(entry.kind, entry.sessionId),
        oldId,
      );
      if (duplicate) {
        throw new HttpError(409, 'replacement duplicates an existing memory entry', {
          existing_id: Number(duplicate.id),
        });
      }

      const uuid = crypto.randomUUID();
      const version = Number(old.version) + 1;
      // Two-step close: the live partial-unique indexes (key AND kind/title/hash dedup)
      // both forbid old+new coexisting as live rows, so the old row must stop being
      // live BEFORE the replacement inserts. Self-pointer keeps the FK valid; the
      // second hop re-points it to the real successor — one immediate transaction.
      const closed = markSuperseded.run(oldId, oldId);
      if (Number(closed.changes) !== 1) {
        throw new Error(`failed to close live memory entry ${oldId}`);
      }
      const inserted = insertVersion.run(
        uuid,
        Date.now(),
        entry.sessionId,
        entry.agent,
        entry.kind,
        null,
        entry.title,
        entry.body,
        entry.links,
        entry.shaRefs,
        entry.pinned,
        contentHash,
        entry.sourcePath,
        oldId,
        version,
      );
      const newId = Number(inserted.lastInsertRowid);
      const repointed = repointSuperseded.run(newId, oldId);
      if (Number(repointed.changes) !== 1) {
        throw new Error(`failed to re-point superseded memory entry ${oldId}`);
      }
      if (entry.key !== null) setEntryKey.run(entry.key, newId);
      // Same transaction as the replacement row: a rewritten handoff carries its
      // declaration forward or the rewrite does not happen.
      if (declaration) {
        const now = Date.now();
        setDeclaration.run(declaration.tails.length ? 'tails' : 'none', newId);
        for (const taskId of [...declaration.tails, ...declaration.closes]) {
          linkTaskHandoff.run(taskId, newId, now);
        }
        for (const taskId of declaration.closes) closeTaskWithHandoff(taskId, entry.agent, entry.sessionId, newId);
      }
      for (const taskId of withdrawn) {
        linkTaskHandoff.run(taskId, newId, Date.now());
        closeTaskWithHandoff(taskId, entry.agent, entry.sessionId, newId, 'cancelled');
      }
      const superseded = { id: newId, uuid, kind: entry.kind, version, supersedes: oldId, mutated: true };
      return withdrawn.length ? { ...superseded, closed_tasks: withdrawn } : superseded;
    });
  }

  // Rank stored lesson vectors directly: no query embedder, guessed score, or local DB.
  function nearestLessons(url) {
    const id = Number(url.searchParams.get('id'));
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'nearest-lessons needs positive id');
    const rows = [];
    const skippedMalformed = [];
    for (const row of denseLessonRows.all()) {
      let linksObj;
      try { linksObj = parseStoredLessonLinks(row); }
      catch (error) {
        skippedMalformed.push(Number(row.id));
        console.error(`[memory] nearest-lessons: skipping ${error.message}`);
        continue;
      }
      if (!['inbox', 'retired'].includes(linksObj.status)) rows.push({ ...row, linksObj });
    }
    if (skippedMalformed.includes(id)) return { neighbours: [], skippedMalformed, missingVectors: [] };
    const source = rows.find(row => Number(row.id) === id);
    if (!source) throw new HttpError(404, `active lesson ${id} not found`);
    const hashes = textHashes.current();
    const currentVector = (lessonId) => {
      const cached = denseVectors.get(lessonId);
      if (!cached || cached.textSha !== hashes.get(lessonId) || !(cached.vector instanceof Float32Array)
        || !cached.vector.length) return null;
      return cached.vector;
    };
    const vector = currentVector(id);
    if (!vector) throw new HttpError(503, `dense query vector unavailable for active lesson ${id}`);
    let queryNorm = 0;
    for (const value of vector) queryNorm += value ** 2;
    if (!(queryNorm > 0)) throw new HttpError(503, `invalid dense query vector for active lesson ${id}`);
    const missingVectors = [];
    const neighbours = [];
    for (const row of rows) {
      if (Number(row.id) === id || row.linksObj.domain !== source.linksObj.domain) continue;
      const other = currentVector(Number(row.id));
      if (!other || other.length !== vector.length) {
        missingVectors.push(Number(row.id));
        continue;
      }
      let dot = 0;
      let norm = 0;
      for (let i = 0; i < vector.length; i++) { dot += vector[i] * other[i]; norm += other[i] ** 2; }
      if (!(norm > 0) || !Number.isFinite(dot)) {
        missingVectors.push(Number(row.id));
        continue;
      }
      neighbours.push({ id: Number(row.id), cosine: Math.max(-1, Math.min(1, dot / Math.sqrt(queryNorm * norm))) });
    }
    neighbours.sort((a, b) => b.cosine - a.cosine || b.id - a.id);
    return { neighbours, skippedMalformed, missingVectors };
  }

  function search(url, queryVector) {
    const query = url.searchParams.get('q');
    const kind = url.searchParams.get('kind');
    if (kind !== null && !KINDS.has(kind)) throw new HttpError(400, unknownKind(kind));

    // A SESSION is an exact identity, not a phrase, so it is answered by the
    // session index rather than by full-text search - and it is the one lookup
    // that must never depend on how a title was worded. Svod names a member's
    // attempt as its session id and asks for that attempt's report back; a
    // recall that went through FTS could return a different attempt's answer
    // because the words happened to match, and handing one member's verdict to
    // another is the worst failure this whole channel exists to prevent.
    const session = url.searchParams.get('session');
    if (session !== null) {
      if (!session.trim()) throw new HttpError(400, 'session must not be empty');
      const rows = kind === null
        ? sessionEntries.all(session)
        : sessionEntriesOfKind.all(session, kind);
      // The BODY, not a snippet. Full-text search answers "where might this be
      // written down" and a 24-token excerpt serves that; a session lookup
      // answers "give me the thing this attempt delivered", and an excerpt of a
      // report is not a report.
      return { rows: rows.map((row) => ({
        id: Number(row.id),
        uuid: row.uuid,
        kind: row.kind,
        agent: row.agent ?? null,
        session_id: row.session_id ?? null,
        title: row.title,
        body: row.body,
        ts: Number(row.ts),
        pinned: Boolean(row.pinned),
      })) };
    }

    if (!query || !query.trim()) {
      throw new HttpError(400, 'search query q is required (or filter by session)');
    }

    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new HttpError(400, 'limit must be an integer between 1 and 200');
    }

    const rawOffset = url.searchParams.get('offset');
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HttpError(400, 'offset must be a non-negative safe integer');
    }
    const runSearch = (q, n, skip = 0) => (kind === null
      ? searchAll.all(q, n, skip) : searchKind.all(q, kind, n, skip));
    try {
      let rows;
      if (FTS_SYNTAX.test(query)) {
        // The caller wrote FTS5 on purpose: run it as written. On a syntax
        // error retry once with every term double-quoted - a natural query
        // like "owner-pointer NO-GO" must not 400.
        try {
          rows = runSearch(query, limit, offset);
        } catch (error) {
          if (error?.code !== 'ERR_SQLITE_ERROR') throw error;
          // A query of syntax alone (a lone quote or star) has no terms left:
          // that is "nothing matches", not an invalid request (review r1, glm).
          const terms = ftsTerms(query);
          rows = terms.length ? runSearch(terms.map(quoteTerm).join(' '), limit, offset) : [];
        }
      } else {
        if (!(queryVector instanceof Float32Array) || !queryVector.length) {
          throw new HttpError(503, 'query embedder unavailable: MEMORYCTL_EMBED_URL');
        }
        const ids = new Set();
        for (const token of idTokens(query)) {
          for (const row of idMatches.all(quoteTerm(token))) ids.add(Number(row.rowid));
        }
        const hashes = textHashes.current();
        rows = denseEntries.all().filter((row) => {
          const cached = denseVectors.get(Number(row.id));
          return cached && cached.vector.length === queryVector.length && cached.textSha === hashes.get(Number(row.id))
            && (kind === null ? !SEARCH_DEAD_TITLE.test(row.title) : row.kind === kind);
        }).map((row) => {
          const vector = denseVectors.get(Number(row.id)).vector;
          let dot = 0;
          let queryNorm = 0;
          let entryNorm = 0;
          for (let i = 0; i < queryVector.length; i++) {
            dot += queryVector[i] * vector[i];
            queryNorm += queryVector[i] ** 2;
            entryNorm += vector[i] ** 2;
          }
          if (!(entryNorm > 0)) throw new HttpError(503, `invalid current vector for entry ${row.id}`);
          const score = dot / Math.sqrt(queryNorm * entryNorm);
          return { ...row, score, idMatch: ids.has(Number(row.id)) };
        }).sort((a, b) => Number(ids.has(Number(b.id))) - Number(ids.has(Number(a.id)))
          || b.score - a.score || b.id - a.id);
        // Rank once, synchronously. memoryd can await the worker on this snapshot
        // before handle applies the page. Never rerank an offset-dependent pool.
        return { rows, offset, limit, dense: true, rerank: kind === null,
          docs: kind === null ? rows.slice(0, RERANK_HEAD).map((row) =>
            entryText({ ...row, body: denseBody.get(row.id).body })) : [] };
      }
      return { rows: searchResults(rows, searchNow()) };
    } catch (error) {
      if (error?.code === 'ERR_SQLITE_ERROR') {
        throw new HttpError(400, `invalid FTS query: ${error.message}`);
      }
      throw error;
    }
  }

  // Walking a supersession chain must terminate on data it did not write.
  // `supersede` closes the old row by pointing it at ITSELF before re-pointing it
  // at the successor; a row imported by hand, or one left behind by a future path
  // that dies between those hops, keeps `superseded_by = id`. This service is
  // single-writer, so a walker that trusts the pointer does not hang one caller —
  // it hangs every later one.
  // What makes this terminate is `seen`, not a length limit: rows are finite and
  // no id is walked twice. A cap on top of that cannot prevent a hang it is not
  // needed for, and it CAN produce a wrong answer — a cap of 1000 made
  // `follow=latest` hand back version 1000 of a 1001-version lineage while
  // calling it the live head (measured by codex, review round 019fe627).
  //
  // `seen` is passed in when one lineage is walked in both directions, so a row
  // reached by the backward walk cannot be listed again by the forward one. A
  // hand-edited table where `supersedes` and `superseded_by` name the same row
  // otherwise produced a timeline with a version in it twice.
  function walkChain(startRow, column, seen = new Set()) {
    seen.add(Number(startRow.id));
    const chain = [startRow];
    let row = startRow;
    for (;;) {
      const nextId = row[column];
      if (nextId === null || nextId === undefined) break;
      const id = Number(nextId);
      if (seen.has(id)) break; // self-pointer, a cycle, or the other half's rows
      const next = getEntryById.get(id);
      if (next === undefined) break; // a dangling pointer is an end, not a 500
      seen.add(id);
      chain.push(next);
      row = next;
    }
    return chain;
  }

  /// One line per version: id, when, how far along the chain, and whether it is
  /// the live one. Deliberately BODYLESS — a chain of ten handoffs is a chain of
  /// ten bodies, and this is read where the context budget is the whole point.
  function lineageRow(row) {
    return {
      id: Number(row.id),
      uuid: row.uuid,
      version: Number(row.version),
      title: row.title,
      ts: Number(row.ts),
      agent: row.agent ?? null,
      live: row.superseded_by === null || row.superseded_by === undefined,
    };
  }

  // GET /api/memory/entry?id=N|uuid=... — the whole record, body included.
  // search returns a 24-token snippet and hot returns one line per entry, so
  // without this route "read handoff 90" has no supported answer and every
  // caller improvises its own sqlite reader against memory.db.
  //
  // `follow` answers the question an id cannot: an id written into a lesson, a
  // handoff or a Svod brief names the row that was live when it was written, and
  // every rewrite since made it a dead end. `latest` walks to the live head;
  // `full_history` hands back the lineage root-to-leaf. Absent means the raw row,
  // which is what auditing and debugging want and what every caller gets today.
  const FOLLOW_MODES = new Set(['latest', 'full_history']);

  function entry(url) {
    const rawId = url.searchParams.get('id');
    const uuid = url.searchParams.get('uuid');
    const follow = url.searchParams.get('follow');
    if (follow !== null && !FOLLOW_MODES.has(follow)) {
      throw new HttpError(
        400,
        `unknown follow mode: ${follow} (allowed: latest, full_history; omit follow for the raw row)`,
      );
    }
    if (rawId === null && uuid === null) {
      throw new HttpError(400, 'entry requires id or uuid');
    }
    if (rawId !== null && uuid !== null) {
      throw new HttpError(400, 'entry takes id or uuid, not both');
    }

    let row;
    if (rawId !== null) {
      const id = Number(rawId);
      if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'id must be a positive integer');
      row = getEntryById.get(id);
    } else {
      if (!uuid.trim()) throw new HttpError(400, 'uuid must be non-empty');
      row = getEntryByUuid.get(uuid);
    }
    if (row === undefined) throw new HttpError(404, 'memory entry not found');

    const requestedId = Number(row.id);
    let history = null;
    if (follow === 'latest') {
      const forward = walkChain(row, 'superseded_by');
      row = forward[forward.length - 1];
    } else if (follow === 'full_history') {
      // back to the root, then forward from the row that was asked for: the two
      // halves meet at the requested row, which is why it is dropped from one.
      // They share `seen`, so a row the backward walk already listed cannot come
      // back a second time through a pointer that disagrees with it.
      const seen = new Set();
      const back = walkChain(row, 'supersedes', seen).reverse();
      const forward = walkChain(row, 'superseded_by', seen).slice(1);
      history = [...back, ...forward].map(lineageRow);
    }

    // links/sha_refs are stored as JSON text; hand back the parsed value when it
    // parses and the raw text otherwise, so a hand-imported row still reads.
    const decode = (value) => {
      if (value === null || value === undefined) return null;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    };
    return {
      ...(follow === 'latest'
        // the redirect is stated rather than silent: a caller must be able to see
        // that the id it asked for is not the id it is reading.
        ? { followed_from: Number(row.id) === requestedId ? null : requestedId }
        : {}),
      ...(history === null ? {} : { history }),
      id: Number(row.id),
      uuid: row.uuid,
      kind: row.kind,
      key: row.key ?? null,
      title: row.title,
      body: row.body,
      links: decode(row.links),
      sha_refs: decode(row.sha_refs),
      pinned: Boolean(row.pinned),
      ts: Number(row.ts),
      agent: row.agent ?? null,
      session_id: row.session_id ?? null,
      source_path: row.source_path ?? null,
      supersedes: row.supersedes === null || row.supersedes === undefined ? null : Number(row.supersedes),
      superseded_by: row.superseded_by === null || row.superseded_by === undefined
        ? null
        : Number(row.superseded_by),
      version: Number(row.version),
      live: row.superseded_by === null || row.superseded_by === undefined,
    };
  }

  function lessons(url) {
    return selectLessonsForPath(liveLessonRows.all(), validateLessonPath(url), loadRoutingMap());
  }

  function registryKey(value) {
    const key = value ?? 'session-registry';
    if (typeof key !== 'string' || !key.trim()) throw new HttpError(400, 'registry key must be a non-empty string');
    return key;
  }

  function readRegistry(key) {
    const row = getLiveByKey.get(key);
    if (!row) return { key, id: null, version: 0, body: null };
    if (row.kind !== 'registry') {
      throw new HttpError(409, `live key '${key}' belongs to kind '${row.kind}'`);
    }
    return {
      key,
      id: Number(row.id),
      uuid: row.uuid,
      version: Number(row.version),
      body: row.body,
      session_id: row.session_id,
      agent: row.agent,
      ts: Number(row.ts),
    };
  }

  function updateRegistry(input) {
    const key = registryKey(input.key);
    const expectedVersion = Number(input.expected_version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new HttpError(400, 'expected_version must be a non-negative integer');
    }

    return transaction(() => {
      const current = getLiveByKey.get(key);
      if (current && current.kind !== 'registry') {
        throw new HttpError(409, `live key '${key}' belongs to kind '${current.kind}'`);
      }
      const currentVersion = current ? Number(current.version) : 0;
      if (currentVersion !== expectedVersion) {
        throw new HttpError(409, 'registry version conflict', {
          current_version: currentVersion,
          current_body: current?.body ?? null,
        });
      }

      const version = currentVersion + 1;
      const entry = validateEntry({
        kind: 'registry',
        key,
        title: `${key} v${version}`,
        body: input.body,
        session_id: input.session_id ?? current?.session_id,
        agent: input.agent ?? current?.agent,
        links: input.links ?? current?.links,
        sha_refs: input.sha_refs ?? current?.sha_refs,
        pinned: input.pinned ?? current?.pinned ?? 0,
        source_path: input.source_path ?? current?.source_path,
      });
      const uuid = crypto.randomUUID();
      const oldId = current ? Number(current.id) : null;
      const inserted = insertVersion.run(
        uuid,
        Date.now(),
        entry.sessionId,
        entry.agent,
        entry.kind,
        current ? null : key,
        entry.title,
        entry.body,
        entry.links,
        entry.shaRefs,
        entry.pinned,
        sha256(entry.body),
        entry.sourcePath,
        oldId,
        version,
      );
      const newId = Number(inserted.lastInsertRowid);
      if (current) {
        const updated = markSuperseded.run(newId, oldId);
        if (Number(updated.changes) !== 1) throw new Error(`failed to close registry entry ${oldId}`);
        setEntryKey.run(key, newId);
      }
      return { id: newId, uuid, kind: 'registry', key, version, supersedes: oldId, mutated: true };
    });
  }

  function emitWrite(event) {
    for (const callback of writeListeners) {
      try {
        callback(event);
      } catch (error) {
        console.error('[memory] onWrite callback failed:', error?.stack || error);
      }
    }
  }

  function onWrite(callback) {
    if (typeof callback !== 'function') throw new TypeError('onWrite callback must be a function');
    writeListeners.add(callback);
    return () => writeListeners.delete(callback);
  }

  function renderRegistry() {
    const current = getLiveByKey.get('session-registry');
    const header = '<!-- generated — write via memoryctl/MCP, manual edits will be overwritten -->';
    if (!current) return `${header}\n<!-- empty registry -->\n`;
    if (current.kind !== 'registry') {
      throw new Error(`session-registry key belongs to unexpected kind '${current.kind}'`);
    }
    return `${header}\n${current.body}`;
  }

  function listHandoffs() {
    return handoffRows.all().map((row) => ({
      id: Number(row.id),
      title: row.title,
      ts: Number(row.ts),
      body: row.body,
      source_path: row.source_path,
    }));
  }

  function dumpEntries() {
    return allEntries.iterate();
  }

  // Optional status seam for a projection/export implementation.
  function setExportStatusFn(callback) {
    if (typeof callback !== 'function') throw new TypeError('export status callback must be a function');
    exportStatusFn = callback;
  }

  function renderHotDocument(included, omitted, pinnedOverflow, taskLineLimit = HOT_MAX_TASKS, hiddenByKind = new Map()) {
    const pairs = included.map((entry) => [Number(entry.id), Number(entry.version)]);
    const inputsHash = sha256(JSON.stringify(pairs));
    const lines = [
      `<!-- hot-digest algo=v2 inputs=${inputsHash} generated-from=memory.db -->`,
    ];
    if (pinnedOverflow) lines.push('<!-- PINNED OVERFLOW -->');

    // Open tails go ABOVE the narrative. A session that reads only the top of
    // the digest still learns what is unfinished; the reverse order is how the
    // prose got read and the open work did not.
    const open = sortTasks(openTasks.all());
    if (open.length) {
      lines.push('', `## tasks (${open.length} open)`);
      const shown = Math.min(open.length, taskLineLimit);
      for (const task of open.slice(0, shown)) {
        const owner = task.claimed_by ? ` @${task.claimed_by}` : '';
        const track = task.track ? ` [${task.track}]` : '';
        const detail = task.status === 'blocked'
          ? `blocked: ${firstLine(task.blocked_reason)}`
          : firstLine(task.next_action || task.body || '—');
        const carried = Number(task.carried) >= 2 ? ` ×${Number(task.carried)}` : '';
        lines.push(`- ${task.priority} #${task.id} ${task.status}${carried}${owner}${track} ${firstLine(task.title, MAX_TASK_TITLE_CHARS)} — ${detail}`);
      }
      if (open.length > shown) {
        // Two cuts, named differently: HOT_MAX_TASKS is the standing display
        // cap, anything smaller is the byte budget speaking - and the caller
        // budgeting the whole document needs to know which one fired.
        lines.push(shown < Math.min(open.length, HOT_MAX_TASKS)
          ? `- <!-- ${open.length - shown} task line(s) cut by budget: memoryctl task list -->`
          : `- <!-- ${open.length - shown} more open task(s): memoryctl task list -->`);
      }
    }

    for (const kind of KIND_PRIORITY) {
      const entries = included.filter((entry) => entry.kind === kind);
      if (!entries.length) continue;
      lines.push('', `## ${kind}`);
      for (const entry of entries) {
        const title = firstLine(entry.title, MAX_TITLE_CHARS);
        lines.push(`- [${kind}] ${title} · ${entryDay(entry.ts)} — ${firstLine(entry.body)}`);
      }
      const hidden = hiddenByKind.get(kind) ?? 0;
      if (hidden > 0) {
        lines.push(`- <!-- ${hidden} older ${kind}(s): memoryctl search --kind ${kind} -->`);
      }
    }
    lines.push('', `<!-- omitted: ${omitted} entries -->`);
    return `${lines.join('\n')}\n`;
  }

  function renderHot(budgetKb = 12, scope = null) {
    const budget = Number(budgetKb);
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new HttpError(400, 'budget_kb must be a positive number');
    }
    if (scope !== null && (!KINDS.has(scope) || typeof scope !== 'string')) {
      throw new HttpError(400, `unknown scope kind: ${String(scope)}`);
    }
    const maxBytes = Math.floor(budget * 1024);
    const rows = liveEntries.all()
      // An explicit `--scope report` still answers; what the DEFAULT digest must
      // not do is spend a session's opening budget on per-attempt machinery.
      // A live entry whose own title marks it as history (MERGED-INTO:,
      // RETIRED:, ОТМЕНЕНО:) is left out of the default digest for the same
      // reason the default search leaves it out: it states no rule in force.
      .filter((entry) => (scope === null
        ? !HOT_EXCLUDED_KINDS.has(entry.kind) && !SEARCH_DEAD_TITLE.test(entry.title)
        : entry.kind === scope))
      .sort((left, right) => (
        Number(right.pinned) - Number(left.pinned)
        || KIND_RANK.get(left.kind) - KIND_RANK.get(right.kind)
        || Number(right.ts) - Number(left.ts)
        || Number(right.id) - Number(left.id)
      ));
    const fits = (document) => Buffer.byteLength(document, 'utf8') <= maxBytes;

    // The per-kind cap is applied BEFORE admission, not at render time. Capped
    // at render, every live handoff was still admitted against the budget and
    // counted as included, so `omitted` under-reported by a thousand entries
    // and the budget was spent on lines nobody saw. A hidden entry is omitted,
    // and says so.
    const hiddenByKind = new Map();
    const shownByKind = new Map();
    const tracksByKind = new Map();
    const candidates = rows.filter((entry) => {
      const cap = HOT_MAX_PER_KIND.get(entry.kind);
      if (cap === undefined || entry.pinned) return true;
      const track = entry.kind === 'handoff' ? handoffTrack(entry) : null;
      const tracks = tracksByKind.get(entry.kind) ?? new Set();
      const shown = shownByKind.get(entry.kind) ?? 0;
      if (shown >= cap || (track !== null && tracks.has(track))) {
        hiddenByKind.set(entry.kind, (hiddenByKind.get(entry.kind) ?? 0) + 1);
        return false;
      }
      if (track !== null) tracks.add(track);
      tracksByKind.set(entry.kind, tracks);
      shownByKind.set(entry.kind, shown + 1);
      return true;
    });
    const doc = (includedEntries, omitted, pinnedOverflow, taskLineLimit) => (
      renderHotDocument(includedEntries, omitted, pinnedOverflow, taskLineLimit, hiddenByKind)
    );

    // The budget owns the WHOLE document, not only the digest entries - and
    // the open-task block is what gets cut FIRST. The entry loop always did
    // budget the entries, but the task block above them rendered
    // unconditionally, and it showed: measured 2026-07-31, `memoryctl hot`
    // returned 8593 bytes at both --budget-kb 2 and --budget-kb 6, because 44
    // open task lines never entered the budget at all. So admission trials
    // are rendered with the task block at its floor (the `## tasks (N open)`
    // count line plus the cut note - the same fact at a fixed price), and
    // task lines are then re-admitted one at a time with whatever the entries
    // left over. What never yields: the hot-digest header, the count line,
    // the entry sections in kind order (the feedback section included), and
    // the omitted marker.
    const withTaskLines = (includedEntries, omitted, pinnedOverflow) => {
      const openCount = sortTasks(openTasks.all()).length;
      const cap = Math.min(openCount, HOT_MAX_TASKS);
      let limit = 0;
      let document = doc(includedEntries, omitted, pinnedOverflow, 0);
      while (limit < cap) {
        const trial = doc(includedEntries, omitted, pinnedOverflow, limit + 1);
        if (!fits(trial)) break;
        limit += 1;
        document = trial;
      }
      return document;
    };

    const included = candidates.filter((entry) => Boolean(entry.pinned));
    if (!fits(doc(included, rows.length - included.length, false, 0))) {
      // Pinned entries still win over the budget - the overflow stays loud -
      // but the task lines riding above them get no such exemption.
      return withTaskLines(included, rows.length - included.length, true);
    }

    // Open work is admitted FIRST, entries fill what is left.
    //
    // This reverses the 2026-07-31 order, and the reversal is measured: on
    // 2026-08-05 the live digest carried 54 open tasks as ZERO task lines —
    // the count line plus "cut by budget" — while 5260 of 6000 bytes went to
    // sixteen handoff titles. Capping handoffs alone only handed the space to
    // the next kind in rank (decisions took 4940 bytes on the very next run).
    // The earlier order was right that the budget must own the whole document;
    // it was wrong about which half is the point of the document. A task line
    // costs ~80 bytes and names something unfinished; an entry title is
    // narrative that `memoryctl search` can fetch on demand.
    // Half the budget, not all of it. Open work goes first, but a digest that
    // is nothing BUT tasks loses the pointer to what happened — so the task
    // block may take at most half, and entries fill the rest. At 6 KB that is
    // 3 KB, more than the twenty-line cap ever needs; at 1 KB it is ~6 lines,
    // and the narrative sections still make the page.
    const taskShare = Math.floor(maxBytes / 2);
    let taskLines = Math.min(sortTasks(openTasks.all()).length, HOT_MAX_TASKS);
    const taskBlockBytes = (lines) => Buffer.byteLength(renderHotDocument([], 0, false, lines), 'utf8');
    while (taskLines > 0 && taskBlockBytes(taskLines) > taskShare) taskLines -= 1;
    while (taskLines > 0 && !fits(doc(included, rows.length - included.length, false, taskLines))) {
      taskLines -= 1;
    }
    for (const entry of candidates) {
      if (entry.pinned) continue;
      const trial = [...included, entry];
      const rendered = doc(trial, rows.length - trial.length, false, taskLines);
      if (!fits(rendered)) break;
      included.push(entry);
    }
    return doc(included, rows.length - included.length, false, taskLines);
  }

  function taskView(row) {
    if (!row) return null;
    const links = JSON.parse(row.links);
    return {
      id: Number(row.id),
      uuid: row.uuid,
      created_ts: Number(row.created_ts),
      updated_ts: Number(row.updated_ts),
      closed_ts: row.closed_ts === null ? null : Number(row.closed_ts),
      title: row.title,
      body: row.body,
      priority: row.priority,
      status: row.status,
      track: row.track,
      next_action: row.next_action,
      blocked_reason: row.blocked_reason,
      claimed_by: row.claimed_by,
      claimed_at: row.claimed_at === null ? null : Number(row.claimed_at),
      session_id: row.session_id,
      depends_on: JSON.parse(row.depends_on),
      links,
      // The task's domain is its `links.domain`: a routing id of the routing map
      // as lessons use, or null when the task is filed under no domain.
      domain: taskRowDomain(row),
      handoffs: taskHandoffIds.all(Number(row.id)).map((link) => Number(link.entry_id)),
    };
  }

  function requireTask(id) {
    const row = getTaskById.get(id);
    if (!row) throw new HttpError(404, `task ${id} not found`);
    return row;
  }

  function validateDependencies(ids, selfId = null) {
    if (!ids) return null;
    for (const id of ids) {
      if (selfId !== null && id === selfId) {
        throw new HttpError(400, `task ${id} cannot depend on itself`);
      }
      if (!getTaskById.get(id)) throw new HttpError(400, `depends_on names unknown task ${id}`);
    }
    return ids;
  }

  /// The task this new title would be a second copy of, or nothing.
  ///
  /// Both states are looked at in ONE pass and told apart only by the sentence
  /// they produce: what the measurement says is that the duplicates on this
  /// machine are all "opened again what was already closed", and a gate written
  /// for open-against-open alone would have caught nothing in 750 tasks.
  function duplicateTask(title) {
    const words = titleWords(title);
    if (!words.size) return null;
    for (const row of allTaskTitles.all()) {
      if (titlesAlike(words, titleWords(row.title))) {
        return { id: Number(row.id), title: row.title, status: row.status };
      }
    }
    return null;
  }

  // A task that closes by hand says why, or it does not close. A handoff or a
  // decision is its own evidence; `task done` / `task update --status done|
  // cancelled` has nothing but this field. Operator 2026-09-14: evidence on
  // closure is required. Re-labelling an already closed task (done ->
  // cancelled) may carry new evidence but does not have to.
  function closureEvidence(input, status, alreadyClosed, id) {
    const evidence = taskText(input.evidence, 'evidence', MAX_TASK_TEXT_CHARS)?.trim() || null;
    const closing = TASK_CLOSED_STATUSES.has(status);
    if (closing && !alreadyClosed && !evidence) {
      const ready = status === 'done' ? `memoryctl task done --id ${id}` : `memoryctl task update --id ${id} --status ${status}`;
      throw new HttpError(400, `closing task ${id} as ${status} needs its evidence: ${ready} --evidence "<sha | memory#id | what proves it>"`, { task: id });
    }
    if (evidence && !closing) {
      throw new HttpError(400, `evidence is recorded when a task closes; task ${id} is not being closed`, { task: id });
    }
    return evidence;
  }

  function createTask(input) {
    const now = Date.now();
    // A DUPLICATE IS REFUSED BY NUMBER, and the refusal is escapable in one
    // word. `again: true` is a decision the caller makes out loud rather than
    // a silent second row.
    if (!input.again) {
      const twin = duplicateTask(input.title ?? '');
      if (twin) {
        const closed = TASK_CLOSED_STATUSES.has(twin.status);
        throw new HttpError(
          400,
          closed
            ? `task #${twin.id} says the same thing and is already ${twin.status}: `
              + `"${twin.title}". If the work really came back, say so: --again. `
              + `If it never went away, reopen that one: memoryctl task update --id ${twin.id} --status open`
            : `task #${twin.id} says the same thing and is ${twin.status}: `
              + `"${twin.title}". Work in that one, or --again if this is genuinely a second job`,
          // The twin is named in the body too: a board client acts on the id,
          // and parsing the message for it is how a wrong id gets quoted back.
          { duplicate_of: twin.id },
        );
      }
    }
    const status = taskStatus(input.status);
    const evidence = closureEvidence(input, status, false, '(new)');
    const blockedReason = taskText(input.blocked_reason, 'blocked_reason', MAX_TASK_TEXT_CHARS);
    if (status === 'blocked' && !blockedReason) {
      throw new HttpError(400, 'a blocked task must carry blocked_reason');
    }
    const task = {
      title: taskText(input.title, 'title', MAX_TASK_TITLE_CHARS, { required: true }),
      body: taskText(input.body, 'body', MAX_BODY_BYTES) ?? '',
      priority: taskPriority(input.priority),
      status,
      track: taskText(input.track, 'track', MAX_TASK_TITLE_CHARS),
      nextAction: taskText(input.next_action, 'next_action', MAX_TASK_TEXT_CHARS),
      blockedReason,
      sessionId: optionalString(input.session_id, 'session_id'),
      dependsOn: taskIdList(input.depends_on, 'depends_on') ?? [],
      // The domain merges into `links` and every other key of the write survives.
      links: taskLinks(
        jsonText(input.links === undefined ? {} : input.links, 'links'),
        input, routing(), evidence, input.links !== undefined, null,
      ),
    };

    return transaction(() => {
      validateDependencies(task.dependsOn);
      // Being born closed is still closing: a task created `done` on top of
      // open prerequisites asserts the same order nobody can check.
      if (TASK_CLOSED_STATUSES.has(task.status)) {
        refuseUnmetPrerequisites('(new)', JSON.stringify(task.dependsOn));
      }
      const uuid = crypto.randomUUID();
      const result = insertTask.run(
        uuid,
        now,
        now,
        TASK_CLOSED_STATUSES.has(task.status) ? now : null,
        task.title,
        task.body,
        task.priority,
        task.status,
        task.track,
        task.nextAction,
        task.blockedReason,
        null,
        null,
        task.sessionId,
        JSON.stringify(task.dependsOn),
        task.links,
      );
      return taskView(getTaskById.get(Number(result.lastInsertRowid)));
    });
  }

  function updateTask(rawInput) {
    // The CLI's payload builder always emits `body`, so an empty one means "the
    // caller passed no body", not "erase the body". Taking it literally made
    // `task update --status done` silently wipe the task's description.
    const input = { ...rawInput };
    if (typeof input.body === 'string' && !input.body.trim()) delete input.body;
    const id = taskIdParam(input.id);
    const fields = [
      'status', 'priority', 'title', 'body', 'track',
      'next_action', 'blocked_reason', 'depends_on', 'links', 'evidence',
      'domain',
    ];
    if (!fields.some((field) => input[field] !== undefined)) {
      throw new HttpError(400, `update names no field to change; one of ${fields.join(', ')} is required`);
    }
    // Filing a task under a domain is not progress on it: an update whose only
    // field is `domain` leaves `updated_ts` as it was, so "what changed recently"
    // keeps meaning what it meant.
    const onlyDomain = input.domain !== undefined
      && fields.every((field) => field === 'domain' || input[field] === undefined);

    return transaction(() => {
      const current = requireTask(id);
      const status = taskStatus(input.status, current.status);
      const closing = TASK_CLOSED_STATUSES.has(status);
      const evidence = closureEvidence(input, status, TASK_CLOSED_STATUSES.has(current.status), id);
      let blockedReason = input.blocked_reason === undefined
        ? current.blocked_reason
        : taskText(input.blocked_reason, 'blocked_reason', MAX_TASK_TEXT_CHARS);
      if (status === 'blocked' && !blockedReason) {
        throw new HttpError(400, 'a blocked task must carry blocked_reason');
      }
      // A task that is no longer blocked must not keep saying why it is: a stale
      // reason reads as a live blocker in every listing that prints it. Closure
      // is the same case — done "because the host was unverified" is a lie.
      if (closing || status !== 'blocked') blockedReason = null;

      const dependsOn = input.depends_on === undefined
        ? JSON.parse(current.depends_on)
        : validateDependencies(taskIdList(input.depends_on, 'depends_on'), id);
      // Closing here answers to the same rule as closing from a handoff. The
      // dependencies checked are the ones this update LEAVES behind, so an
      // update that drops a stale dependency and closes in one call is legal.
      if (closing) refuseUnmetPrerequisites(id, JSON.stringify(dependsOn));

      const next = {
        title: input.title === undefined
          ? current.title
          : taskText(input.title, 'title', MAX_TASK_TITLE_CHARS, { required: true }),
        body: input.body === undefined
          ? current.body
          : (taskText(input.body, 'body', MAX_BODY_BYTES) ?? ''),
        priority: taskPriority(input.priority, current.priority),
        track: input.track === undefined
          ? current.track
          : taskText(input.track, 'track', MAX_TASK_TITLE_CHARS),
        nextAction: input.next_action === undefined
          ? current.next_action
          : taskText(input.next_action, 'next_action', MAX_TASK_TEXT_CHARS),
        // The domain merges into whichever links the write leaves behind: a
        // wholesale `links` write that names no domain keeps the stored one.
        links: taskLinks(
          input.links === undefined ? current.links : jsonText(input.links, 'links'),
          input, routing(), evidence, input.links !== undefined, current.links,
        ),
      };

      db.prepare(`
UPDATE mem_tasks
SET title = ?, body = ?, priority = ?, status = ?, track = ?, next_action = ?,
    blocked_reason = ?, depends_on = ?, links = ?, updated_ts = ?, closed_ts = ?,
    claimed_by = ?, claimed_at = ?
WHERE id = ?`).run(
        next.title,
        next.body,
        next.priority,
        status,
        next.track,
        next.nextAction,
        blockedReason,
        JSON.stringify(dependsOn),
        next.links,
        // A domain-only update keeps the timestamp it had.
        onlyDomain ? current.updated_ts : Date.now(),
        closing ? (current.closed_ts ?? Date.now()) : null,
        // Closing hands the claim back: a done task owned by a session that
        // ended is a claim nobody will ever release.
        closing ? null : current.claimed_by,
        closing ? null : current.claimed_at,
        id,
      );
      return taskView(getTaskById.get(id));
    });
  }

  function claimTask(input) {
    const id = taskIdParam(input.id);
    const agent = taskText(input.agent, 'agent', MAX_TASK_TITLE_CHARS, { required: true });
    const sessionId = optionalString(input.session_id, 'session_id');
    return transaction(() => {
      const current = requireTask(id);
      if (TASK_CLOSED_STATUSES.has(current.status)) {
        throw new HttpError(409, `task ${id} is ${current.status} and cannot be claimed`);
      }
      const result = claimTaskRow.run(agent, Date.now(), sessionId, Date.now(), id, agent);
      if (Number(result.changes) === 0) {
        throw new HttpError(409, `task ${id} is already claimed by ${current.claimed_by}`, {
          claimed_by: current.claimed_by,
        });
      }
      return taskView(getTaskById.get(id));
    });
  }

  function releaseTask(input) {
    const id = taskIdParam(input.id);
    return transaction(() => {
      requireTask(id);
      releaseTaskRow.run(Date.now(), id);
      return taskView(getTaskById.get(id));
    });
  }

  function sortTasks(rows) {
    return rows.sort((left, right) => (
      TASK_PRIORITY_RANK.get(left.priority) - TASK_PRIORITY_RANK.get(right.priority)
      || Number(left.id) - Number(right.id)
    ));
  }

  function listTasks(url) {
    const status = url.searchParams.get('status');
    const priority = url.searchParams.get('priority');
    const track = url.searchParams.get('track');
    const closedSince = url.searchParams.get('closed_since');
    const fields = url.searchParams.get('fields');
    const domain = url.searchParams.get('domain');
    if (status !== null) taskStatus(status, undefined);
    // A FILTER is a read: `?priority=P2` must still answer, or the 46 rows
    // written before the retirement become unqueryable.
    if (priority !== null) storedTaskPriority(priority);
    if (closedSince !== null && !/^\d+$/.test(closedSince)) {
      throw new HttpError(400, `closed_since must be a whole number of milliseconds, got ${JSON.stringify(closedSince)}`);
    }
    if (fields !== null && fields !== 'compact') {
      throw new HttpError(400, `fields must be compact (no body, no handoffs), got ${JSON.stringify(fields)}`);
    }
    if (domain !== null && domain !== 'none') {
      const problem = taskDomainProblem(domain, routing());
      if (problem) throw new HttpError(400, `domain filter: ${problem}`);
    }
    const rows = allTasks.all().filter((row) => taskMatchesListFilters(
      row, status, priority, track, closedSince, domain,
    ));
    const applied = taskListApplied(status, priority, track, closedSince, fields, domain);
    const view = (row) => {
      const task = taskView(row);
      if (fields === 'compact') {
        delete task.body;
        delete task.handoffs;
      }
      return task;
    };
    return { tasks: rows.map(view), applied };
  }

  function readyTasks() {
    const rows = allTasks.all();
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    const ready = rows.filter((row) => {
      if (row.status !== 'open') return false;
      if (row.claimed_by !== null) return false;
      return JSON.parse(row.depends_on).every((dependency) => {
        const blocker = byId.get(Number(dependency));
        return !blocker || TASK_CLOSED_STATUSES.has(blocker.status);
      });
    });
    return { tasks: sortTasks(ready).map(taskView) };
  }

  function readTask(url) {
    const id = taskIdParam(url.searchParams.get('id'));
    return taskView(requireTask(id));
  }

  // The session-end gate. A handoff either names the tails it leaves or denies
  // that any exist - the same shape as a Svod review's OPEN_BLOCKERS, and for
  // the same reason: a field that may be left silent is a field that is.
  // `depends_on` holds prerequisites: `readyTasks` treats a task as ready only
  // when every dependency is closed, so closing a task whose prerequisite is
  // still open asserts an order that did not happen.
  //
  // A prerequisite that is GONE is refused too. `validateDependencies` rejects a
  // dependency on a task that does not exist, so a missing row is not a
  // satisfied prerequisite - it is one whose fate cannot be read at all.
  //
  // Shared by every route that closes, because an invariant one route enforces
  // and another ignores is not an invariant. A reviewer found exactly that: the
  // handoff path refused, `task update --status done` did not, and one command
  // walked around the rule.
  function refuseUnmetPrerequisites(taskId, dependsOnJson) {
    const prerequisites = JSON.parse(dependsOnJson ?? '[]');
    const unmet = prerequisites.filter((id) => {
      const row = getTaskById.get(id);
      return !row || !TASK_CLOSED_STATUSES.has(row.status);
    });
    if (unmet.length) {
      throw new HttpError(409, `task ${taskId} depends on ${unmet.join(', ')}, which is not closed — close the prerequisite first, or drop the dependency if it no longer holds`, {
        task: taskId,
        open_dependencies: unmet,
      });
    }
  }

  // Closing a task from inside a handoff, in that handoff's transaction. The
  // handoff row is already linked to the task by `linkTaskHandoff`, so the
  // evidence for the closure is the handoff itself.
  //
  // The same three consequences `updateTask` applies when it closes: the closing
  // timestamp, the released claim, and the dropped blocked_reason - a task done
  // "because the host was unverified" is a lie either way. Already-closed is a no-op
  // so a re-sent handoff replays cleanly.
  function closeTaskWithHandoff(taskId, closingAgent, closingSession, entryId, status = 'done') {
    const current = getTaskById.get(taskId);
    if (!current) throw new HttpError(400, `entry closes unknown task ${taskId}`);
    if (TASK_CLOSED_STATUSES.has(current.status)) return;

    // Closing is an accountable act: it ends a task and, below, may release a
    // claim. An anonymous writer can be neither asked about it nor blamed for
    // it, so it does not get to do it.
    //
    // A blank name is anonymity that passed a truthiness check: `optionalString`
    // does not trim, so `" "` and `"\t"` reached this line as agents and closed
    // unclaimed work. Measured by a reviewer, `agent: " "` → 200 and the task
    // done. Identity is what is left after the whitespace.
    const agent = typeof closingAgent === 'string' ? closingAgent.trim() : '';
    if (!agent) {
      throw new HttpError(400, `closing task ${taskId} requires an agent — send --agent, or leave the task as a tail`, {
        task: taskId,
      });
    }

    // A live claim belongs to a session that is still working. Closing across it
    // does not just mark a row - it CLEARS the claim, so the owner's next write
    // lands on a task the store already considers finished.
    //
    // The owner is the PAIR. Comparing the agent name alone let a second session
    // of the same model close the first one's work - measured by a reviewer as
    // `sameNameOtherSession: 200`, claim gone - and same-model-twice is the
    // ordinary case here, not an exotic one: every Svod roster can seat it, and
    // `claimTask` stores both halves precisely so they can be told apart.
    const session = typeof closingSession === 'string' ? closingSession.trim() : '';
    const sameOwner = current.claimed_by === agent
      && (current.session_id ?? '') === session;
    if (current.claimed_by && !sameOwner) {
      throw new HttpError(409, `task ${taskId} is claimed by ${current.claimed_by} in session ${current.session_id ?? '(none)'} and cannot be closed by ${agent} in session ${session || '(none)'} — ask that session to close it, or release the claim first`, {
        task: taskId,
        claimed_by: current.claimed_by,
        claimed_session: current.session_id ?? null,
      });
    }

    refuseUnmetPrerequisites(taskId, current.depends_on);

    const now = Date.now();
    closeTaskRow.run(status, now, now, `memory#${entryId}`, taskId);
  }

  // `closes` on a non-handoff entry. A decision that withdraws work names the
  // tasks and closes them as `cancelled` in its own write. Every other kind
  // closes nothing and says so: measured 2026-09-14, `append --kind decision
  // --closes N` answered 200 and left the task open, and the decision that
  // stopped the server elements on 2026-09-04 left seven tasks behind it.
  function withdrawnTasks(input, kind) {
    if (kind === 'handoff') return [];
    const ids = taskIdList(input.closes, 'closes');
    if (!Array.isArray(ids) || !ids.length) return [];
    if (kind !== 'decision') {
      throw new HttpError(400, `a ${kind} closes no task: --closes belongs on a handoff (finished work) or a decision (withdrawn work)`);
    }
    for (const id of ids) {
      if (!getTaskById.get(id)) throw new HttpError(400, `decision closes unknown task ${id}`);
    }
    return ids;
  }

  function handoffDeclaration(input) {
    // A session-end write must declare its open work or its absence.
    const declaredTasks = taskIdList(input.tasks, 'tasks');
    const declaredCloses = taskIdList(input.closes, 'closes');
    const noOpenWork = input.no_open_work === true || input.no_open_work === 1;
    const hasTasks = Array.isArray(declaredTasks) && declaredTasks.length > 0;
    const closes = Array.isArray(declaredCloses) ? declaredCloses : [];

    if (hasTasks && noOpenWork) {
      throw new HttpError(400, `a handoff cannot both name tails and declare none: ${HANDOFF_GATE_HINT}`);
    }
    if (!hasTasks && !noOpenWork) {
      throw new HttpError(400, `handoff refused: ${HANDOFF_GATE_HINT}`);
    }

    const tails = hasTasks ? declaredTasks : [];
    // A task cannot be both what this session finished and what it leaves for
    // the next one. Measured before this check existed: fifty-two open tasks,
    // most of them finished work nobody had a moment to close, because closing
    // was a second command after the handoff and the session was already over.
    const both = closes.filter((id) => tails.includes(id));
    if (both.length) {
      throw new HttpError(400, `handoff both leaves and closes task ${both.join(', ')}: a tail is what remains, --closes is what is finished`);
    }
    for (const id of tails) {
      const row = getTaskById.get(id);
      if (!row) throw new HttpError(400, `handoff names unknown task ${id}: ${HANDOFF_GATE_HINT}`);
      if (TASK_CLOSED_STATUSES.has(row.status)) {
        throw new HttpError(400, `task ${id} is ${row.status} and is not a tail of this session`);
      }
    }
    // Closing an already-closed task is a no-op, not an error: a re-sent handoff
    // is an idempotent retry, and the dedup path replays this same declaration.
    for (const id of closes) {
      if (!getTaskById.get(id)) {
        throw new HttpError(400, `handoff closes unknown task ${id}: ${HANDOFF_GATE_HINT}`);
      }
    }
    return { tails, closes };
  }

  function searchResponse(prepared, scores) {
    if (!prepared.dense) return prepared.rows;
    const rows = rerankedRows(prepared.rows, scores).slice(prepared.offset, prepared.offset + prepared.limit)
      .map((row) => {
        const words = denseBody.get(row.id).body.trim().split(/\s+/u);
        return { ...row, snippet: words.slice(0, 24).join(' ') + (words.length > 24 ? '…' : '') };
      });
    return searchResults(rows, searchNow());
  }

  function handle(req, res, url, bodyStr, context = {}) {
    const knownPaths = new Set([
      '/api/memory/append',
      '/api/memory/supersede',
      '/api/memory/search',
      '/api/memory/nearest-lessons',
      '/api/memory/entry',
      '/api/memory/entries',
      '/api/memory/lessons',
      '/api/memory/registry',
      '/api/memory/hot',
      '/api/memory/handoff',
      '/api/memory/export_status',
      '/api/memory/task',
      '/api/memory/task/update',
      '/api/memory/task/claim',
      '/api/memory/task/release',
      '/api/memory/tasks',
      '/api/memory/tasks/ready',
    ]);
    if (!knownPaths.has(url.pathname)) return false;
    try {
      if (url.pathname === '/api/memory/tasks' || url.pathname === '/api/memory/tasks/ready') {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed', { allowed: ['GET'] });
        sendJson(res, 200, url.pathname.endsWith('/ready') ? readyTasks() : listTasks(url));
        return true;
      }
      if (url.pathname === '/api/memory/task' && req.method === 'GET') {
        sendJson(res, 200, readTask(url));
        return true;
      }
      if (url.pathname === '/api/memory/search') {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed', { allowed: ['GET'] });
        sendJson(res, 200, searchResponse(context.searchResult ?? search(url, context.queryVector), context.rerankScores));
        return true;
      }
      if (url.pathname === '/api/memory/nearest-lessons') {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed', { allowed: ['GET'] });
        sendJson(res, 200, nearestLessons(url));
        return true;
      }
      if (url.pathname === '/api/memory/entries') {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed', { allowed: ['GET'] });
        const kind = url.searchParams.get('kind');
        if (kind !== 'lesson' && kind !== 'handoff') {
          throw new HttpError(400, 'entries kind must be lesson or handoff');
        }
        // Gates need the complete set, including links and bodies, not ranked search hits.
        sendJson(res, 200, db.prepare(
          'SELECT * FROM mem_entries WHERE kind = ? AND superseded_by IS NULL ORDER BY id',
        ).all(kind));
        return true;
      }
      if (url.pathname === '/api/memory/entry') {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed', { allowed: ['GET'] });
        sendJson(res, 200, entry(url));
        return true;
      }
      if (url.pathname === '/api/memory/lessons') {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed', { allowed: ['GET'] });
        sendJson(res, 200, lessons(url));
        return true;
      }
      if (url.pathname === '/api/memory/hot') {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed', { allowed: ['GET'] });
        const rawBudget = url.searchParams.get('budget_kb');
        const scope = url.searchParams.get('scope');
        sendText(
          res,
          200,
          renderHot(rawBudget === null ? 12 : Number(rawBudget), scope),
          'text/markdown; charset=utf-8',
        );
        return true;
      }
      if (url.pathname === '/api/memory/export_status') {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed', { allowed: ['GET'] });
        if (!exportStatusFn) {
          sendJson(res, 503, { error: 'memory exporter status is not wired' });
        } else {
          sendJson(res, 200, exportStatusFn());
        }
        return true;
      }
      if (url.pathname === '/api/memory/registry' && req.method === 'GET') {
        sendJson(res, 200, readRegistry(registryKey(url.searchParams.get('key') ?? undefined)));
        return true;
      }

      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed', { allowed: ['POST'] });
      if (!authorized(req)) {
        sendJson(res, 401, { error: 'invalid memory mutation token' });
        return true;
      }
      const input = parseJsonBody(bodyStr);
      if (url.pathname === '/api/memory/append') {
        const result = append(input);
        if (result.mutated) emitWrite({ type: 'append', kind: result.kind, id: result.id });
        for (const oldId of result.overturned ?? []) {
          emitWrite({ type: 'supersede', kind: result.kind, id: result.id, supersedes: oldId });
        }
        // A handoff written through append has the same response as /handoff.
        if (result.kind === 'handoff' || input.kind === 'handoff') {
          sendJson(res, 200, handoffWritePayload(result));
        } else {
          const extra = {};
          if (result.overturned?.length) extra.overturned = result.overturned;
          if (result.closed_tasks?.length) extra.closed_tasks = result.closed_tasks;
          if (result.open_tasks_named?.length) extra.open_tasks_named = result.open_tasks_named;
          if (result.related?.length) {
            extra.related = result.related;
            extra.related_hint = result.related_hint;
          }
          sendJson(res, 200, { id: result.id, uuid: result.uuid, dedup: result.dedup, ...extra });
        }
      } else if (url.pathname === '/api/memory/supersede') {
        const result = supersede(input);
        emitWrite({ type: 'supersede', kind: result.kind, id: result.id, supersedes: result.supersedes });
        sendJson(res, 200, result);
      } else if (url.pathname === '/api/memory/registry') {
        const result = updateRegistry(input);
        emitWrite({ type: 'registry', kind: 'registry', id: result.id, supersedes: result.supersedes });
        sendJson(res, 200, result);
      } else if (url.pathname.startsWith('/api/memory/task')) {
        // Spelled out to the end, with a 404 under it. The chain used to finish
        // in an unconditional `: releaseTask(input)`, so a path added to
        // `knownPaths` and forgotten here would have RELEASED A CLAIM instead of
        // answering "no such route".
        const task = url.pathname === '/api/memory/task' ? createTask(input)
          : url.pathname === '/api/memory/task/update' ? updateTask(input)
            : url.pathname === '/api/memory/task/claim' ? claimTask(input)
              : url.pathname === '/api/memory/task/release' ? releaseTask(input)
                : (() => { throw new HttpError(404, `unknown route ${url.pathname}`); })();
        emitWrite({ type: 'task', kind: 'task', id: task.id });
        sendJson(res, 200, task);
      } else if (url.pathname === '/api/memory/handoff') {
        const result = append(input, 'handoff');
        if (result.mutated) emitWrite({ type: 'handoff', kind: 'handoff', id: result.id });
        sendJson(res, 200, handoffWritePayload(result));
      } else {
        // `knownPaths` let it in and nothing here answers it: say so, rather than
        // returning 200 with an empty body a client would read as success.
        throw new HttpError(404, `unknown route ${url.pathname}`);
      }
      return true;
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message, ...error.details });
        return true;
      }
      console.error('[memory] request failed:', error?.stack || error);
      sendJson(res, 500, { error: String(error?.message || error) });
      return true;
    }
  }

  return {
    handle,
    search,
    // Routes served outside handle (memoryd's vector import) check the same token.
    authorized,
    onWrite,
    renderHot,
    renderRegistry,
    listHandoffs,
    listOpenTasks: () => sortTasks(openTasks.all()).map(taskView),
    dumpEntries,
    setExportStatusFn,
  };
}
