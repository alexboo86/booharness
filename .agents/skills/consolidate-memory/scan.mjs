#!/usr/bin/env node
// Read-only scan of memoryd for the daily consolidation routine.
// Prints a compact markdown digest; writes NOTHING. Every mutation is the
// agent's own memoryctl call, gated by the skill next to this file.
//
// Why a script and not 61 `memoryctl task show` calls: the whole point of the
// routine is to compare items with each other — duplicate titles, tracks with a
// newer handoff, lessons on one anchor. Pairwise comparison over the CLI costs
// thousands of lines of JSON to learn what one query already knows.
//
// Usage: node .agents/skills/consolidate-memory/scan.mjs [--stale-days 30]

import { B1_ARCHIVE_DAYS, classifyB1, latestLiveByTrack } from '../../../scripts/memory/b1-handoff.mjs';
import { trackFieldsOf } from '../../../scripts/gen-tracks.mjs';
import { readContradictions, readEntries, readTasks, serviceUrl } from '../../../scripts/memory/service-client.mjs';

const DAY = 86400000;
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
if (argv.includes('--db')) throw new Error('REFUSED --db: scan reads memoryd only');
const STALE_DAYS = Number(argOf('--stale-days', '30'));
const ORPHAN_DAYS = Number(argOf('--orphan-days', '30'));
const TASK_SIM = Number(argOf('--task-jaccard', '0.6'));
const TASK_SIM_TRACK = Number(argOf('--task-jaccard-track', '0.45'));
const LESSON_SIM = Number(argOf('--lesson-jaccard', '0.7'));
// То же число, которым гейтит check-domain-routing: LESSON_PAYLOAD_BUDGET_PER_FILE.
const ANCHOR_BUDGET = Number(argOf('--anchor-budget', '24576'));
const NOW = Date.now();

const STOP = new Set([
  'the', 'and', 'for', 'with', 'not', 'that', 'this', 'from', 'into', 'has', 'have', 'are',
  'что', 'как', 'для', 'при', 'над', 'под', 'без', 'все', 'всё', 'это', 'этот', 'или', 'уже',
  'так', 'там', 'тут', 'нет', 'его', 'ещё', 'еще', 'они', 'она',
]);

const norm = (value) => String(value ?? '')
  .replace(/^\s*(?:MERGED-INTO|ARCHIVED|RETIRED)\s*:\s*(?:#\d+\s*(?:—|-)?\s*)?/iu, '')
  .toLowerCase()
  .replace(/[\p{P}\p{S}]+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

const tokens = (value) => {
  const out = new Set();
  for (const token of norm(value).split(' ')) {
    if (token.length >= 3 && !STOP.has(token)) out.add(token);
  }
  return out;
};

// Two empty sets are not "identical" — an empty intersection over an empty
// union must read as 0, not the 1 the formula would hand back.
const jaccard = (left, right) => {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
};

const parseLinks = (raw) => {
  if (!raw || raw === '[]' || raw === '{}') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

const days = (ts) => Math.round((NOW - Number(ts)) / DAY);
const cut = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

const [tasks, liveHandoffs, liveLessons, contradictions] = await Promise.all([
  readTasks(), readEntries('handoff'), readEntries('lesson'), readContradictions(),
]);
const handoffs = [...liveHandoffs].sort((a, b) => Number(a.ts) - Number(b.ts));
const lessons = liveLessons.map((row) => {
  const linksObj = parseLinks(row.links);
  const raw = String(linksObj.status || '');
  return { ...row, linksObj, status: raw === 'inbox' || raw === 'retired' ? raw : 'active' };
});
const CLOSED = new Set(['done', 'cancelled']);
const open = tasks.filter((task) => !CLOSED.has(task.status));
const closed = tasks.filter((task) => CLOSED.has(task.status));
const dependedOn = new Set();
for (const task of open) for (const dep of task.depends_on) dependedOn.add(dep);

// The "не трогать активное" invariant, in one place and printed per item, so a
// refusal to touch something is visible rather than implied by absence.
const protection = (task) => {
  if (task.status !== 'open') return `status=${task.status}`;
  if (task.claimed_by) return `claimed:${task.claimed_by}`;
  if (task.priority === 'P0') return 'P0';
  if (dependedOn.has(Number(task.id))) return 'depends-target';
  if (NOW - Number(task.updated_ts) < DAY) return 'touched<24h';
  return '';
};

const out = [];
const push = (line) => out.push(line);

push(`# consolidation scan ${new Date(NOW).toISOString().slice(0, 10)}`);
push('');
push(`db: ${serviceUrl()}`);
push(`tasks: ${tasks.length} (open-ish ${open.length}, closed ${closed.length}) · handoffs live: ${handoffs.length} · lessons live: ${lessons.length}`);

// ---- A1: byte-equal tails -------------------------------------------------
push('');
push('## A1 точные дубли задач (нормализованный заголовок)');
const byTitle = new Map();
for (const task of open) {
  const key = norm(task.title);
  if (!key) continue;
  if (!byTitle.has(key)) byTitle.set(key, []);
  byTitle.get(key).push(task);
}
const dupGroups = [...byTitle.values()].filter((group) => group.length > 1);
if (!dupGroups.length) push('- нет');
for (const group of dupGroups) {
  const ordered = [...group].sort((a, b) => Number(a.id) - Number(b.id));
  const keep = ordered[0];
  for (const drop of ordered.slice(1)) {
    const block = protection(drop) || protection(keep);
    push(`- #${drop.id} → #${keep.id} ${block ? `ЗАЩИЩЕНО(${block})` : 'свободно'} :: ${cut(keep.title, 90)}`);
    if (!String(keep.next_action || '').trim() && String(drop.next_action || '').trim()) {
      push(`    keep без next, у дубля есть: ${cut(drop.next_action, 90)}`);
    }
  }
}

// ---- A2: near-duplicates ---------------------------------------------------
push('');
push(`## A2 смежные задачи (jaccard ≥ ${TASK_SIM}, один трек ≥ ${TASK_SIM_TRACK})`);
const tokenCache = new Map(open.map((task) => [Number(task.id), tokens(`${task.title} ${task.next_action || ''}`)]));
const near = [];
for (let i = 0; i < open.length; i += 1) {
  for (let j = i + 1; j < open.length; j += 1) {
    const left = open[i];
    const right = open[j];
    if (norm(left.title) === norm(right.title)) continue;
    const sameTrack = Boolean(left.track) && left.track === right.track;
    const score = jaccard(tokenCache.get(Number(left.id)), tokenCache.get(Number(right.id)));
    if (score < (sameTrack ? TASK_SIM_TRACK : TASK_SIM)) continue;
    near.push({ score, left, right, sameTrack });
  }
}
near.sort((a, b) => b.score - a.score);
if (!near.length) push('- нет');
for (const pair of near) {
  push(`- ${pair.score.toFixed(2)}${pair.sameTrack ? ` [${pair.left.track}]` : ''} #${pair.left.id} ${cut(pair.left.title, 70)} || #${pair.right.id} ${cut(pair.right.title, 70)}`);
}

// ---- A3: evidence the tail is already finished -----------------------------
push('');
push('## A3 похоже закрыто (нужно доказательство)');
const doneByTitle = new Map();
for (const task of closed) {
  const key = norm(task.title);
  if (key && !doneByTitle.has(key)) doneByTitle.set(key, task);
}
const doneTracks = new Map();
for (const handoff of handoffs) {
  const marker = trackFieldsOf(handoff);
  if (marker.track && marker.status === 'done') doneTracks.set(marker.track, handoff);
}
const a3 = [];
for (const task of open) {
  const twin = doneByTitle.get(norm(task.title));
  if (twin) a3.push(`- #${task.id} ← закрытая #${twin.id} (${twin.status}) с тем же заголовком :: ${cut(task.title, 80)}`);
  else if (task.track && doneTracks.has(task.track)) {
    a3.push(`- #${task.id} трек ${task.track} объявлен done в handoff #${doneTracks.get(task.track).id} :: ${cut(task.title, 80)}`);
  }
}
if (!a3.length) push('- нет');
for (const line of a3) push(line);

// ---- A4: stale ------------------------------------------------------------
push('');
push(`## A4 протухшие задачи (без трека, простой ≥ ${STALE_DAYS} д)`);
const stale = open
  .filter((task) => !task.track && task.priority !== 'P0' && !task.claimed_by && days(task.updated_ts) >= STALE_DAYS)
  .sort((a, b) => days(b.updated_ts) - days(a.updated_ts));
if (!stale.length) push('- нет');
for (const task of stale) push(`- #${task.id} ${task.priority} простой ${days(task.updated_ts)} д :: ${cut(task.title, 90)}`);

// ---- B: handoffs ----------------------------------------------------------
// One predicate with the archiver (scripts/memory/archive-handoff.mjs,
// b1-handoff.mjs): the scan never suggests what the routine would refuse.
const latestByTrack = latestLiveByTrack(handoffs);

push('');
push(`## B1 перекрытые handoff (трек продолжен свежим, возраст ≥ ${B1_ARCHIVE_DAYS} д)`);
const b1 = [];
const b2 = [];
// Protected items collapse into one counted line per reason. Printed per item
// they drown the free ones: 60 lines of "ЗАЩИЩЕНО(возраст 9 д < 14)" is a wall
// nobody reads, and the two candidates that mattered sat inside it.
const b1Blocked = new Map();
const blockedLabel = (decision) => ({
  pinned: 'pinned',
  'open-tails': 'незакрытые хвосты',
  young: `моложе ${B1_ARCHIVE_DAYS} д`,
  'track-status': `трек ${decision.trackStatus}`,
})[decision.reason];
for (const handoff of handoffs) {
  const decision = classifyB1({ handoff, latestByTrack, tasks, archiveDays: B1_ARCHIVE_DAYS, now: NOW });
  if (decision.verdict === 'candidate') {
    b1.push(`- #${handoff.id} [${decision.track} · ${decision.trackStatus}] возраст ${decision.ageDays} д, свежий #${decision.latestId} :: ${cut(handoff.title, 80)}`);
  } else if (decision.verdict === 'refused') {
    const label = blockedLabel(decision);
    if (!b1Blocked.has(label)) b1Blocked.set(label, []);
    b1Blocked.get(label).push(Number(handoff.id));
  } else if (decision.reason === 'no-track'
    && decision.ageDays >= ORPHAN_DAYS && !decision.openTails && !Number(handoff.pinned)) {
    b2.push(`- #${handoff.id} без трека, возраст ${decision.ageDays} д, хвостов нет :: ${cut(handoff.title, 80)}`);
  }
}
if (!b1.length) push('- нет');
for (const line of b1) push(line);
for (const [reason, ids] of b1Blocked) {
  push(`- ЗАЩИЩЕНО ${ids.length} (${reason}): ${ids.slice(0, 12).map((id) => `#${id}`).join(' ')}${ids.length > 12 ? ' …' : ''}`);
}
push('');
push(`## B2 handoff без трека старше ${ORPHAN_DAYS} д (предложение, не авто)`);
if (!b2.length) push('- нет');
for (const line of b2) push(line);

// ---- C: lessons -----------------------------------------------------------
const active = lessons.filter((lesson) => lesson.status === 'active');
push('');
// Бюджет считается НА ЯКОРЬ, а не на домен. Домен целиком не приезжает ни в
// один контекст с 2026-07-30 (доставка пофайловая), а с 2026-08-11 не приезжают
// и заголовки соседей, поэтому счётчик домена не измеряет ничего, что кто-то
// читает — гейт на него снят (scripts/memory/lesson-lib.mjs). Здесь остаётся то
// же число, которым гейтит check-domain-routing: сумма тел уроков одного файла.
push(`## C3 бюджет якорей (> ${ANCHOR_BUDGET} Б активных тел на один файл)`);
const anchorBytes = new Map();
const domainCount = new Map();
for (const lesson of active) {
  const domain = String(lesson.linksObj.domain || '?');
  domainCount.set(domain, (domainCount.get(domain) || 0) + 1);
  const file = String(lesson.linksObj.anchor || '').split(':')[0];
  if (!file) continue;
  anchorBytes.set(file, (anchorBytes.get(file) || 0) + String(lesson.body || '').length);
}
const overBudget = [...anchorBytes].sort((a, b) => b[1] - a[1]);
for (const [file, bytes] of overBudget) {
  if (bytes > ANCHOR_BUDGET) push(`- ${file}: ${bytes} Б ПРЕВЫШЕН — слить пересекающиеся правила или ретайрнуть отжившее`);
}
if (!overBudget.some(([, bytes]) => bytes > ANCHOR_BUDGET)) push('- нет');
push(`  (самые тяжёлые: ${overBudget.slice(0, 5).map(([file, bytes]) => `${file}=${bytes}`).join(' ')})`);
push(`  (уроков по доменам, справочно: ${[...domainCount].sort((a, b) => b[1] - a[1]).map(([domain, count]) => `${domain}=${count}`).join(' ')})`);
// A domain written without the `domain-` prefix is not a small typo: lesson
// delivery resolves a path to a routing-map name, so `chart-engine` is a
// bucket nothing ever asks for. The lesson is alive and unreachable.
const misrouted = [...domainCount].filter(([domain]) => domain !== '?' && !domain.startsWith('domain-'));
if (misrouted.length) {
  push(`- ИМЯ ДОМЕНА ВНЕ КАРТЫ (уроки недоставляемы): ${misrouted.map(([domain, count]) => `${domain}=${count}`).join(' ')}`);
}

push('');
push(`## C2 уроки на одном якоре с пересечением ≥ ${LESSON_SIM}`);
const byAnchor = new Map();
for (const lesson of active) {
  const anchor = String(lesson.linksObj.anchor || '').trim();
  const file = anchor.split(':')[0];
  if (!file || anchor.includes('*')) continue;
  const key = `${lesson.linksObj.domain || '?'}::${file}`;
  if (!byAnchor.has(key)) byAnchor.set(key, []);
  byAnchor.get(key).push(lesson);
}
const c2 = [];
for (const [key, group] of byAnchor) {
  if (group.length < 2) continue;
  const cache = new Map(group.map((lesson) => [Number(lesson.id), tokens(`${lesson.title} ${lesson.body || ''}`)]));
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      const score = jaccard(cache.get(Number(group[i].id)), cache.get(Number(group[j].id)));
      if (score < LESSON_SIM) continue;
      c2.push(`- ${score.toFixed(2)} ${key.split('::')[1]} #${group[i].id} ${cut(group[i].title, 60)} || #${group[j].id} ${cut(group[j].title, 60)}`);
    }
  }
}
if (!c2.length) push('- нет');
for (const line of c2) push(line);

push('');
push('## D противоречия (только оператору)');
if (!contradictions.length) push('- нет');
for (const entry of contradictions) push(`- #${entry.id} [${entry.kind}] ${cut(entry.title, 100)}`);

// The routine must not become a source of the tails it exists to clear: one
// review task, updated, not one per day.
push('');
push('## задача разбора (трек memory-consolidation)');
const reviewOpen = open.filter((task) => task.track === 'memory-consolidation');
if (!reviewOpen.length) push('- открытой нет — создавай новую только если есть предложения');
for (const task of reviewOpen) push(`- УЖЕ ОТКРЫТА #${task.id} :: обнови --next, вторую НЕ создавай`);

push('');
push('## C1 мёртвые якоря — запусти отдельно:');
push('- node scripts/memory/sweep-anchors.mjs --json   (gone = кандидат на retire, drift = переякорить)');

console.log(out.join('\n'));
