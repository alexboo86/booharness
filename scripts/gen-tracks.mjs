// Generates docs/TRACKS.md — a one-screen index of LIVE work tracks.
//
// Source of truth is the memoryctl DB (mem_entries, kind='handoff'); this file is a
// derived VIEW and is gitignored: committing it would make every machine fight over a
// file whose content is local session state. Regenerate with `npm run tracks`.
//
// A handoff joins a track by declaring it in its links JSON (the `handoff` subcommand takes
// no --links, so a tracked handoff is written through `append --kind handoff`):
//   memoryctl append --kind handoff --title "..." --links '{"track":"svod-windows","status":"active","next":"verify Kimi adapter"}' --task <id>|--no-open-work
// The gate applies here too: without a declaration this command is a 400, and an
// example that cannot be run teaches agents the doc is wrong.
// or by a marker anywhere in the body (last one wins, so an updated handoff can append):
//   <!-- track: svod-windows | status: active | next: verify Kimi adapter -->
// links wins over the marker. Nothing is inferred: a handoff without a track lands in
// the "без трека" section and a missing next step renders as "—", never a guess.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { trackFieldsOf } from './memory/track-fields.mjs';
export { trackFieldsOf } from './memory/track-fields.mjs';
import { openExistingMemoryDb } from './memory/lesson-lib.mjs';
import { dbArgument, readEntries, readMemory } from './memory/service-client.mjs';
// The slug regex, the status set, the marker parse and the history predicate
// live in the store, which refuses at WRITE time what this view would refuse
// at READ time — one implementation, two gates.
import { SEARCH_DEAD_TITLE, TRACK_SLUG, TRACK_STATUSES, parseTrackMarker } from './memory/store.mjs';

export { parseTrackMarker, TRACK_STATUSES };

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex < 0 ? join(REPO, 'docs', 'TRACKS.md') : process.argv[outIndex + 1];

const TITLE_MAX = 70;
const CLOSED_MAX = 5;

/**
 * Merge links JSON (authoritative) over the body marker.
 * @param {{ links?: string, body?: string }} row
 */
/**
 * Fold live handoff rows into one entry per track (latest wins) plus the untracked rest.
 * @param {Array<{ id: number, ts: number|bigint, agent?: string, title: string, body: string, links: string }>} rows
 */
export function buildTracks(rows) {
  /** @type {Map<string, object>} */
  const byTrack = new Map();
  const untracked = [];
  const invalid = [];

  for (const row of rows) {
    // A handoff whose own title marks it as history (ARCHIVED: from the
    // consolidation, MERGED-INTO:, RETIRED:, ОТМЕНЕНО:) is not a live track:
    // the store excludes the same titles from default search and the digest,
    // by THIS regex — and its links.status "archived" is legitimate there.
    if (SEARCH_DEAD_TITLE.test(row.title || '')) continue;
    const ts = Number(row.ts);
    const { track, status, next } = trackFieldsOf(row);
    const entry = {
      id: Number(row.id),
      ts,
      agent: row.agent || '',
      title: row.title || '',
      track,
      status: status || 'active',
      next,
    };
    if (!track) {
      untracked.push(entry);
      continue;
    }
    if (!TRACK_SLUG.test(track)) {
      invalid.push({ ...entry, reason: `track slug "${track}" is not [a-z0-9][a-z0-9-]*` });
      continue;
    }
    if (status && !TRACK_STATUSES.includes(status)) {
      invalid.push({ ...entry, reason: `status "${status}" not in ${TRACK_STATUSES.join('|')}` });
      continue;
    }
    const prev = byTrack.get(track);
    if (!prev || entry.ts > prev.ts || (entry.ts === prev.ts && entry.id > prev.id)) {
      byTrack.set(track, entry);
    }
  }

  const byRecency = (a, b) => b.ts - a.ts || b.id - a.id;
  const all = [...byTrack.values()].sort(byRecency);
  return {
    open: all.filter((t) => t.status !== 'done'),
    closed: all.filter((t) => t.status === 'done').slice(0, CLOSED_MAX),
    untracked: untracked.sort(byRecency),
    invalid,
    newestTs: rows.length ? Math.max(...rows.map((r) => Number(r.ts))) : 0,
  };
}

const day = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '—');
const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const short = (s) => {
  const t = cell(s);
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
};

const TASK_PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3'];

// "P0 first" is a property of the view, so the view enforces it — a caller that
// hands over rows in database order must not be able to publish them that way.
const byPriority = (a, b) => (
  TASK_PRIORITY_ORDER.indexOf(a.priority) - TASK_PRIORITY_ORDER.indexOf(b.priority)
  || Number(a.id) - Number(b.id)
);

/**
 * Open tails, P0 first. A database written before tasks existed simply has none —
 * the index degrades to tracks rather than failing the whole regeneration.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function readOpenTasks(db) {
  const present = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mem_tasks'")
    .get();
  if (!present) return [];
  return db
    .prepare(
      `SELECT id, priority, status, title, track, next_action, blocked_reason, claimed_by, updated_ts
         FROM mem_tasks
        WHERE status NOT IN ('done', 'cancelled')`,
    )
    .all()
    .sort(byPriority);
}

/**
 * @param {ReturnType<typeof buildTracks>} model
 * @param {Array<object>} tasks open tails, in any order
 */
export function renderTracks(model, rawTasks = []) {
  const tasks = [...rawTasks].sort(byPriority);
  const out = [];
  out.push('# TRACKS — живые треки');
  out.push('');
  out.push('<!-- GENERATED by scripts/gen-tracks.mjs — руками не править. SSOT = memoryd. -->');
  out.push(`Свежий handoff: ${day(model.newestTs)} · регенерация: \`npm run tracks\``);
  out.push('');

  // Tails first: a track says what is being worked on, a tail says what is left
  // undone. Reading order is the whole point — the second one is the one that
  // used to get lost.
  out.push(`## Хвосты (${tasks.length} открыто)`);
  out.push('');
  if (tasks.length) {
    out.push('| # | Приоритет | Статус | Трек | Хвост | Следующий шаг / блокер |');
    out.push('|---|---|---|---|---|---|');
    for (const t of tasks) {
      const owner = t.claimed_by ? ` @${cell(t.claimed_by)}` : '';
      const detail = t.status === 'blocked'
        ? `⛔ ${short(t.blocked_reason)}`
        : short(t.next_action) || '—';
      out.push(`| ${Number(t.id)} | ${cell(t.priority)} | ${cell(t.status)}${owner} | ${cell(t.track) || '—'} | ${short(t.title)} | ${detail} |`);
    }
    out.push('');
    out.push('Очередь: `memoryctl task ready` · закрыть: `memoryctl task done --id <id> --evidence <sha|memory#id>`');
  } else {
    out.push('_ни одного открытого хвоста_');
  }
  out.push('');

  out.push(`## Активные (${model.open.length})`);
  out.push('');
  if (model.open.length) {
    out.push('| Трек | Статус | Обновлён | Следующий шаг | Handoff |');
    out.push('|---|---|---|---|---|');
    for (const t of model.open) {
      out.push(`| ${cell(t.track)} | ${t.status} | ${day(t.ts)} | ${short(t.next) || '—'} | #${t.id} ${short(t.title)} |`);
    }
  } else {
    out.push('_нет живых треков_');
  }
  out.push('');

  out.push(`## Без трека (${model.untracked.length})`);
  out.push('');
  if (model.untracked.length) {
    out.push('Handoff не объявил трек — переключение по нему стоит полного чтения тела.');
    // The remediation line is printed INTO the index an agent then copies, so a
    // flagless form here hands out a command that is refused by the gate.
    out.push('Почини: `memoryctl append --kind handoff --title "<t>" --links \'{"track":"<slug>","status":"active","next":"<шаг>"}\' --task <id>` (или `--no-open-work`).');
    out.push('');
    for (const t of model.untracked) {
      out.push(`- ${day(t.ts)} · #${t.id} ${short(t.title)}`);
    }
  } else {
    out.push('_пусто — каждый живой handoff привязан к треку_');
  }
  out.push('');

  if (model.closed.length) {
    out.push(`## Закрыто недавно (${model.closed.length})`);
    out.push('');
    for (const t of model.closed) {
      out.push(`- ${day(t.ts)} · ${cell(t.track)} · #${t.id} ${short(t.title)}`);
    }
    out.push('');
  }

  return `${out.join('\n')}\n`;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function readLiveHandoffs(db) {
  return db
    .prepare(
      `SELECT id, ts, agent, title, body, links
         FROM mem_entries
        WHERE kind = 'handoff' AND superseded_by IS NULL
        ORDER BY ts DESC, id DESC`,
    )
    .all();
}

if (isMain(import.meta.url)) {
  const dbPath = dbArgument();
  let db;
  try {
    let handoffs, tasks;
    if (dbPath !== undefined) {
      db = openExistingMemoryDb(dbPath, { readOnly: true });
      handoffs = readLiveHandoffs(db);
      tasks = readOpenTasks(db);
    } else {
      handoffs = await readEntries('handoff');
      const result = await readMemory('tasks');
      if (!Array.isArray(result.tasks)) throw new Error('invalid memoryd tasks response');
      tasks = result.tasks.filter(task => !['done', 'cancelled'].includes(task.status));
    }
    const model = buildTracks(handoffs);
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, renderTracks(model, tasks));
    console.log(
      `wrote ${OUT} — ${tasks.length} open tail(s), ${model.open.length} open track(s), ${model.closed.length} closed, ${model.untracked.length} untracked`,
    );
    if (model.invalid.length) {
      for (const bad of model.invalid) console.error(`FAIL: handoff #${bad.id}: ${bad.reason}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`tracks: FAIL: ${error.message}`);
    process.exitCode = 1;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}
