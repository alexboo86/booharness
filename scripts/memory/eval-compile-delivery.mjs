#!/usr/bin/env node
// Content delivery of one domain's lessons before and after a proposed compilation.
// Read-only toward memory and tracked files. The lesson router may write its
// score cache under ~/.cache; that is not a memory write and not a tracked file.
// This script writes nothing except --out.
//
//   node scripts/memory/eval-compile-delivery.mjs --domain domain-example [--multi] [--no-cache] [--out f]
//   node scripts/memory/eval-compile-delivery.mjs --lessons <json> [--tree root] [--retire <file of ids>] [--compiled json] [--merged json]
//   node scripts/memory/eval-compile-delivery.mjs compare --before before.json --after after.json [--retire <file of ids>]
//   node scripts/memory/eval-compile-delivery.mjs compare --domain <name> [--retire <file of ids>] [--merged json] [--compiled json] [--moved json] [--tree root]
// --moved: JSON object of lesson id -> {anchor, domain?, title?, body?, trigger?}.
// A body/title/trigger-only supersede keeps the current anchor. All ids must be
// in the requested probe set. Destination neighbours are checked in both phases.
//
// Exit 0: nothing to report, or compare found no non-retired loss.
// Exit 1: compare found ids delivered before and lost after, or movedUndelivered ids.
// Exit 2: fail closed. The cause is on stderr. A probe source other than jev, cache
// or anchors (including unavailable) voids the run.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { domainsOfFiles, readKnowledgePage, routeKnowledgeSections } from '../../ops/bootstrap/knowledge-page-lib.mjs';
import { renderLessonContext, LESSON_CONTEXT_BYTES } from '../../ops/bootstrap/lesson-router.mjs';
import { leadEditContext } from '../../ops/bootstrap/domain-lessons-hook.mjs';
import { buildLessonLinks, parseLinks } from './lesson-lib.mjs';
import { readLessons } from './service-client.mjs';
import { selectLessonsForPath } from './store.mjs';
import { reanchoredLinks } from './reanchor-lesson.mjs';
import { scrubbedGitEnv } from '../git-env.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VALID_SOURCES = new Set(['jev', 'cache', 'anchors']);
const FLAGS = new Set(['multi', 'no-cache']);
const OPTIONS = new Set(['domain', 'ids', 'lessons', 'retire', 'merged', 'compiled', 'moved', 'tree', 'out', 'before', 'after']);

const bytes = (text) => Buffer.byteLength(text, 'utf8');
const field = (body, name) => String(body ?? '').match(new RegExp(`^- ${name}: (.*)$`, 'm'))?.[1] ?? '';
const fileOf = (lesson) => String(lesson.anchor ?? '').split(':')[0];
export const GLOB_PROBE_CAP = 8;
const isPattern = (value) => /[*?\[\]]/.test(value);

function patternsOf(lesson) {
  const out = [];
  const anchor = fileOf(lesson);
  if (anchor) out.push(anchor);
  for (const glob of lesson.links?.globs ?? []) {
    const text = String(glob || '').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** Tracked files a glob delivers to, capped and sorted. A literal tracked path
 *  is returned as itself so a bracket in a real filename is not a character class. */
export function expandTracked(pattern, repoRoot = REPO) {
  const listed = (magic) => execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', '--', magic], {
    env: scrubbedGitEnv(),
    encoding: 'utf8', maxBuffer: 1 << 26,
  }).split('\0').filter(Boolean);
  if (listed(`:(literal)${pattern}`).includes(pattern)) return [pattern];
  if (!isPattern(pattern)) return [pattern];
  return listed(pattern).sort().slice(0, GLOB_PROBE_CAP);
}

function parseArgs(argv) {
  const sub = argv[0] === 'compare' ? 'compare' : null;
  const rest = sub ? argv.slice(1) : argv;
  const flags = new Set();
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (FLAGS.has(name)) { flags.add(name); continue; }
    if (!OPTIONS.has(name)) throw new Error(`unknown option: --${name}`);
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    opts[name] = value;
  }
  return { sub, flags, opts };
}

function parseIdList(text, label) {
  const ids = [];
  for (const token of String(text).split(/[\s,]+/)) {
    if (!token) continue;
    if (!/^[1-9]\d*$/.test(token)) throw new Error(`${label} has an invalid lesson id: ${token}`);
    const id = Number(token);
    if (!Number.isSafeInteger(id)) throw new Error(`${label} has an invalid lesson id: ${token}`);
    ids.push(id);
  }
  return ids;
}

function linksOf(row) {
  if (row.linksObj && typeof row.linksObj === 'object') return row.linksObj;
  if (row.links && typeof row.links === 'object' && !Array.isArray(row.links)) return row.links;
  return parseLinks(typeof row.links === 'string' ? row.links : '');
}

function toLesson(row) {
  const links = linksOf(row);
  const raw = links.anchor ?? links.anchors ?? links.path ?? row.anchor ?? '';
  const anchor = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw);
  const id = Number(row.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`lesson has an invalid id: ${row.id}`);
  return { id, uuid: row.uuid, version: row.version, ts: row.ts, title: row.title, anchor, links, body: row.body ?? '' };
}

function loadJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error.message}`);
  }
}

function loadMerged(file) {
  const raw = loadJson(file, '--merged');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('--merged must be a JSON object of retired id to survivor id');
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const from = Number(key);
    const to = Number(value);
    if (!Number.isSafeInteger(from) || from <= 0 || !Number.isSafeInteger(to) || to <= 0) {
      throw new Error(`--merged has an invalid id pair: ${key} -> ${value}`);
    }
    out[from] = to;
  }
  return out;
}

function loadMoved(file) {
  const raw = loadJson(file, '--moved');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('--moved must be a JSON object of lesson id to proposed fields');
  const fields = new Set(['anchor', 'domain', 'title', 'body', 'trigger']);
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = Number(key);
    if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(id)) throw new Error(`--moved has an invalid lesson id: ${key}`);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length
      || (!Object.hasOwn(value, 'anchor') && Object.hasOwn(value, 'domain'))) {
      throw new Error(`--moved has an invalid entry: ${key}`);
    }
    for (const [name, text] of Object.entries(value)) {
      if (!fields.has(name)) throw new Error(`--moved has an unknown field ${name} on lesson ${key}`);
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`--moved has an invalid ${name} on lesson ${key}`);
      }
    }
    out[id] = value;
  }
  return out;
}

function loadCompiled(file) {
  const raw = loadJson(file, '--compiled');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('--compiled must be a JSON object of id to exact page line');
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id <= 0 || typeof value !== 'string' || value.length === 0) {
      throw new Error(`--compiled has an invalid entry: ${key}`);
    }
    out[id] = value;
  }
  return out;
}

function loadRetire(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read --retire ${file}: ${error.message}`);
  }
  return new Set(parseIdList(text, '--retire'));
}

async function defaultLoadLessons({ domain, ids }) {
  if (!domain && !ids) return (await readLessons({}, { status: 'active' })).map(toLesson);
  if (domain && ids) {
    const rows = await readLessons({}, { status: 'active', domain });
    const found = new Map(rows.map((row) => [Number(row.id), row]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`missing active lesson ids in ${domain}: ${missing.join(', ')}`);
    return ids.map((id) => toLesson(found.get(id)));
  }
  if (domain) {
    const rows = await readLessons({}, { status: 'active', domain });
    if (!rows.length) throw new Error(`no active lessons for ${domain}`);
    return rows.map(toLesson);
  }
  const rows = await readLessons();
  const found = new Map(rows.map((row) => [Number(row.id), row]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new Error(`missing lesson ids: ${missing.join(', ')}`);
  return ids.map((id) => toLesson(found.get(id)));
}

function defaultLessonsForPath(file) {
  const raw = execFileSync('memoryctl', ['lessons', '--path', file, '--json'], {
    encoding: 'utf8', maxBuffer: 1 << 26, timeout: 30_000,
  });
  return JSON.parse(raw);
}

function readerFor(tree) {
  return (rel) => {
    try {
      return readFileSync(path.join(tree, rel), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
}

function channels(row) {
  if (!row || row.skipped) return { seat: false, lead: false };
  return {
    seat: Boolean(row.seat?.lesson || row.seat?.page),
    lead: Boolean(row.leadEdit?.lesson || row.leadEdit?.page || row.leadRead?.page),
  };
}

/** Ids delivered before and missing after, on seat (lesson or page) or lead content. Retire-set ids are intended losses. */
export function lossesOf(beforeRows, afterRows, retired) {
  // Destination probes are separate obligations, even when a neighbour still
  // reaches its own anchor. A moved lesson's primary probe keeps its identity.
  const key = (row) => `${Number(row.id)}:${row.probeFile ?? ''}`;
  const after = new Map(afterRows.map((row) => [key(row), row]));
  const lost = new Map();
  const seen = new Set();
  for (const row of beforeRows) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || seen.has(key(row)) || retired.has(id) || row.skipped) continue;
    seen.add(key(row));
    const before = channels(row);
    const later = channels(after.get(key(row)));
    const seat = before.seat && !later.seat;
    const lead = before.lead && !later.lead;
    if (seat || lead) {
      const previous = lost.get(id);
      lost.set(id, { id, seat: seat || Boolean(previous?.seat), lead: lead || Boolean(previous?.lead) });
    }
  }
  return [...lost.values()];
}

function sourceFault(row) {
  if (row.skipped) return null;
  for (const [where, block] of [['seat', row.seat], ['lead', row.leadEdit]]) {
    const source = block?.source;
    if (!VALID_SOURCES.has(source)) {
      const reason = block?.reason ? ` (${block.reason})` : '';
      return `Jev source ${source ?? 'missing'}${reason} on lesson ${row.id} ${where} probe`;
    }
  }
  return null;
}

function reportFault(report, label) {
  const unavailable = report?.summary?.jevSources?.unavailable;
  if (unavailable) return `${label} summary jevSources.unavailable=${unavailable}`;
  for (const row of report?.rows ?? []) {
    if (row.seat?.source === 'unavailable' || row.leadEdit?.source === 'unavailable') {
      const block = row.seat?.source === 'unavailable' ? row.seat : row.leadEdit;
      const where = row.seat?.source === 'unavailable' ? 'seat' : 'lead';
      const reason = block?.reason ? ` (${block.reason})` : '';
      return `${label} lesson ${row.id} ${where} source unavailable${reason}`;
    }
  }
  return null;
}

function summaryOf(rows, retired, compiled) {
  const scored = rows.filter((row) => !row.skipped);
  const rate = (pick) => (scored.length ? +(scored.filter(pick).length / scored.length).toFixed(3) : null);
  const sources = scored.map((row) => row.seat.source);
  return {
    probes: scored.length,
    skipped: rows.length - scored.length,
    retired: retired.size,
    compiled: Object.keys(compiled).length,
    seatContent: rate((row) => row.seat.lesson || row.seat.page),
    seatLessonBody: rate((row) => row.seat.lesson),
    seatIndexOnly: rate((row) => !row.seat.lesson && row.seat.index),
    leadEditContent: rate((row) => row.leadEdit.lesson || row.leadEdit.page),
    leadEditPageAdmitted: rate((row) => row.leadEdit.pageAdmitted),
    leadReadContent: rate((row) => row.leadRead.page),
    jevSources: Object.fromEntries([...new Set(sources)].map((source) => [source, sources.filter((item) => item === source).length])),
  };
}

/** Anchor files ranked by how many probed lessons name them; --multi probes the top 2 as companions. */
function denseFilesOf(lessons) {
  const density = new Map();
  for (const lesson of lessons) {
    const file = fileOf(lesson);
    if (file && !file.includes('*')) density.set(file, (density.get(file) ?? 0) + 1);
  }
  return [...density.entries()].sort((a, b) => b[1] - a[1]).map(([file]) => file);
}

async function probeLessons(lessons, {
  retired, merged, compiled, multi, noCache, phase, tree, repoRoot, map, render, lessonsForPath, route, rawEnvelopes,
  expandGlob, failClosed, activeLessons, dense: denseOverride, scoreCache, rescoreIds,
}) {
  const read = readerFor(tree);
  const pageFor = (domain) => readKnowledgePage(domain, read);
  const selectedEnvelopes = new Map();
  // Compare ranks companions once from the before set and passes the same ranking
  // to both phases: after-lessons carry moved anchors, and a re-ranked --multi
  // probe would compare different file sets and name unrelated lessons lost.
  const dense = denseOverride ?? denseFilesOf(lessons);
  const rows = [];
  for (const lesson of lessons) {
    const patterns = lesson.probeFile ? [lesson.probeFile] : patternsOf(lesson);
    const files = [];
    for (const pattern of patterns) {
      const expanded = [...expandGlob(pattern, repoRoot)].sort();
      for (const probed of expanded) {
        if (probed && !files.includes(probed)) files.push(probed);
      }
    }
    if (!files.length) {
      const named = `lesson ${lesson.id} cannot be probed: ${patterns.join(', ') || 'no anchor'}`;
      if (failClosed) return { rows, fault: named, summary: null };
      rows.push({ id: lesson.id, file: patterns[0] ?? '', skipped: named });
      continue;
    }
    const file = files[0];
    const trigger = lesson.links?.trigger || field(lesson.body, 'trigger') || lesson.title;
    const probedFiles = [...files];
    if (multi) {
      for (const other of dense.filter((item) => !probedFiles.includes(item)).slice(0, 2)) probedFiles.push(other);
    }
    const brief = `${probedFiles.join('\n')}\n${trigger}`;
    const sources = [];
    for (const probed of probedFiles) {
      let envelope;
      if (activeLessons) {
        // Re-run the actual matcher AND byte packer over the full active set:
        // a live envelope is already packed and omits candidates we still owe.
        if (!selectedEnvelopes.has(probed)) selectedEnvelopes.set(probed, selectLessonsForPath(activeLessons, probed, map));
        envelope = selectedEnvelopes.get(probed);
      } else {
        if (!rawEnvelopes.has(probed)) {
          rawEnvelopes.set(probed, Promise.resolve().then(() => lessonsForPath(probed)));
        }
        const raw = await rawEnvelopes.get(probed);
        if (!raw || !Array.isArray(raw.items)) throw new Error(`memoryctl lessons --path ${probed} returned no items array`);
        envelope = retired.size ? { ...raw, items: raw.items.filter((item) => !retired.has(Number(item.id))) } : raw;
      }
      sources.push({ file: probed, envelope });
    }
    const seatCall = { sources, brief, role: 'coder', repoRoot, phase, scoreCache, rescoreIds };
    const { prefix } = leadEditContext(sources.map(({ file: probed, envelope }) => ({ file: probed, envelope })));
    const leadCall = {
      sources, brief, role: 'lead', repoRoot, phase, scoreCache, rescoreIds,
      budget: LESSON_CONTEXT_BYTES - bytes(prefix),
    };
    if (noCache) {
      seatCall.cacheDir = null;
      leadCall.cacheDir = null;
    }
    const seatLessons = await render(seatCall);
    const leadLessons = await render(leadCall);
    if (!seatLessons || !leadLessons) throw new Error(`router returned no result for lesson ${lesson.id}`);
    const seatPage = route({ files: probedFiles, map, pageFor }).sections.join('\n\n');
    const leadEditText = prefix + leadLessons.text;
    const leadPageFits = bytes(leadEditText + '\n\n' + seatPage) <= LESSON_CONTEXT_BYTES;
    const line = compiled[lesson.id];
    const inPage = (text) => Boolean(line) && text.includes(line);
    const want = Number(merged[lesson.id] ?? lesson.id);
    const selectedIds = (result) => (result.selectedIds ?? []).map(Number);
    const indexed = (result) => (result.indexedIds ?? []).map(Number);
    const claimed = sources.filter((source) => files.includes(source.file));
    const onPath = (result, source) => source.envelope.items.some((item) => Number(item.id) === want)
      && selectedIds(result).includes(want);
    const row = {
      id: lesson.id,
      file,
      ...(lesson.probeFile ? { probeFile: lesson.probeFile } : {}),
      retired: retired.has(Number(lesson.id)),
      compiled: Boolean(line),
      seat: {
        lesson: claimed.every((source) => onPath(seatLessons, source)),
        index: indexed(seatLessons).includes(want),
        page: inPage(seatPage),
        source: seatLessons.source,
        ...(seatLessons.reason ? { reason: seatLessons.reason } : {}),
        lessonBytes: seatLessons.bytes,
        pageBytes: bytes(seatPage),
      },
      leadEdit: {
        lesson: claimed.every((source) => onPath(leadLessons, source)),
        index: indexed(leadLessons).includes(want),
        pageAdmitted: leadPageFits,
        page: leadPageFits && inPage(seatPage),
        source: leadLessons.source,
        ...(leadLessons.reason ? { reason: leadLessons.reason } : {}),
      },
      leadRead: { page: inPage(seatPage) },
    };
    const fault = sourceFault(row);
    if (fault) return { rows, fault, summary: null };
    rows.push(row);
  }
  return { rows, fault: null, summary: summaryOf(rows, retired, compiled) };
}

function loadReport(file) {
  const raw = loadJson(file, 'report');
  const rows = Array.isArray(raw) ? raw : raw?.rows;
  if (!Array.isArray(rows)) throw new Error(`${file} has no rows array`);
  return { summary: raw.summary, rows };
}

function retireIds(opts, afterRows) {
  const retired = opts.retire ? loadRetire(opts.retire) : new Set();
  for (const row of afterRows) if (row.retired) retired.add(Number(row.id));
  return retired;
}

function lessonRequest(opts) {
  if (opts.lessons && (opts.domain || opts.ids)) throw new Error('--lessons cannot be combined with --domain or --ids');
  if (!opts.lessons && !opts.domain && !opts.ids) throw new Error('pass --domain, --ids, or --lessons');
  return {
    domain: opts.domain,
    ids: opts.ids ? parseIdList(opts.ids, '--ids') : undefined,
    lessonsPath: opts.lessons,
  };
}

async function loadRequested(opts, loadLessons) {
  const request = lessonRequest(opts);
  if (request.lessonsPath) {
    const parsed = loadJson(request.lessonsPath, '--lessons');
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('--lessons must be a non-empty JSON array');
    return parsed.map(toLesson);
  }
  const lessons = await loadLessons(request);
  if (!lessons.length) throw new Error('no lessons to probe');
  return lessons;
}

function proposed(opts) {
  return {
    retired: opts.retire ? loadRetire(opts.retire) : new Set(),
    merged: opts.merged ? loadMerged(opts.merged) : {},
    compiled: opts.compiled ? loadCompiled(opts.compiled) : {},
    moved: opts.moved ? loadMoved(opts.moved) : {},
    tree: opts.tree ? path.resolve(opts.tree) : null,
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const err = deps.err ?? ((line) => console.error(line));
  try {
    return await run(argv, deps, log, err);
  } catch (error) {
    err(`eval-compile-delivery: ${error.message}`);
    return 2;
  }
}

async function run(argv, deps, log, err) {
  const { sub, flags, opts } = parseArgs(argv);
  const pair = Boolean(opts.before || opts.after);
  if (pair && (!opts.before || !opts.after)) throw new Error('--before and --after are a pair');
  if ((sub === 'compare' || pair) && pair && (opts.domain || opts.ids || opts.lessons || opts.tree || opts.merged || opts.compiled || opts.moved)) {
    throw new Error('file compare takes --before, --after, and optional --retire only');
  }
  if (pair || (sub === 'compare' && opts.before)) {
    const before = loadReport(opts.before);
    const after = loadReport(opts.after);
    const cause = reportFault(before, opts.before) ?? reportFault(after, opts.after);
    if (cause) {
      err(`eval-compile-delivery: Jev source unavailable: ${cause}`);
      return 2;
    }
    const lost = lossesOf(before.rows, after.rows, retireIds(opts, after.rows));
    log(JSON.stringify({ lost: lost.map((item) => item.id), detail: lost }, null, 1));
    return lost.length ? 1 : 0;
  }

  if (opts.moved && sub !== 'compare') throw new Error('--moved requires compare');
  const render = deps.renderLessonContext ?? renderLessonContext;
  const lessonsForPath = deps.lessonsForPath ?? defaultLessonsForPath;
  const loadLessons = deps.loadLessons ?? defaultLoadLessons;
  const route = deps.routeKnowledgeSections ?? routeKnowledgeSections;
  const repoRoot = deps.repoRoot ?? REPO;
  const lessons = await loadRequested(opts, loadLessons);
  const set = proposed(opts);
  const map = JSON.parse(readFileSync(path.join(repoRoot, 'docs/agent/domain-routing.generated.json'), 'utf8'));
  const rawEnvelopes = new Map();
  const expandGlob = deps.expandGlob ?? expandTracked;
  const moved = {};
  for (const [key, patch] of Object.entries(set.moved)) {
    const id = Number(key);
    const current = lessons.find((lesson) => lesson.id === id);
    if (!current) throw new Error(`--moved lesson ${id} is not in the probed set`);
    if (set.retired.has(id) || Object.hasOwn(set.merged, id)) throw new Error(`--moved lesson ${id} cannot also be retired or merged`);
    const anchor = patch.anchor ?? current.anchor;
    const domain = patch.domain ?? current.links.domain;
    const routed = domainsOfFiles([fileOf({ anchor })], map);
    if (!routed.includes(domain)) {
      throw new Error(`--moved lesson ${id} anchor ${anchor} routes to ${routed.join(', ') || 'no domain'}, not ${domain}`);
    }
    const links = !Object.hasOwn(patch, 'anchor') ? current.links
      : domain === current.links.domain ? reanchoredLinks(current.links, anchor)
        : buildLessonLinks({
          domain, anchor, status: 'active',
          trigger: patch.trigger ?? current.links.trigger ?? field(patch.body ?? current.body, 'trigger'),
        });
    moved[id] = {
      ...current, ...patch, anchor: links.anchor, links,
    };
  }
  let activeLessons;
  if (Object.keys(moved).length) {
    const active = new Map((await loadLessons({})).map((row) => {
      const lesson = toLesson(row);
      return [lesson.id, lesson];
    }));
    for (const lesson of Object.values(moved)) active.set(lesson.id, lesson);
    activeLessons = [...active.values()].filter((lesson) => !set.retired.has(lesson.id)).map((lesson) => ({
      ...lesson, links: JSON.stringify(lesson.links),
    }));
  }
  const neighbours = new Map();
  for (const lesson of Object.values(moved)) {
    const files = new Set(patternsOf(lesson).flatMap((pattern) => [...expandGlob(pattern, repoRoot)]));
    for (const file of files) {
      if (!rawEnvelopes.has(file)) rawEnvelopes.set(file, Promise.resolve().then(() => lessonsForPath(file)));
      const envelope = await rawEnvelopes.get(file);
      if (!envelope || !Array.isArray(envelope.items)) throw new Error(`memoryctl lessons --path ${file} returned no items array`);
      for (const item of envelope.items) {
        if (!Number.isSafeInteger(Number(item.id)) || Number(item.id) <= 0) throw new Error(`invalid neighbour lesson id on ${file}`);
        if (Object.hasOwn(moved, Number(item.id))) continue;
        neighbours.set(`${item.id}:${file}`, {
          ...item, id: Number(item.id), probeFile: file, body: '',
          links: { anchor: item.anchor ?? file, trigger: item.trigger },
        });
      }
    }
  }
  const beforeLessons = [...lessons, ...neighbours.values()];
  const afterLessons = beforeLessons.map((lesson) => moved[lesson.id]
    ? { ...moved[lesson.id], ...(lesson.probeFile ? { probeFile: lesson.probeFile } : {}) }
    : lesson);
  const shared = {
    multi: flags.has('multi'), noCache: flags.has('no-cache'), repoRoot, map, render, lessonsForPath, route, rawEnvelopes, expandGlob,
  };

  if (sub === 'compare') {
    // Pair candidate scores, never selected ids: each phase still matches and packs.
    const scoreCache = new Map();
    const rescoreIds = new Set([
      ...Object.keys(moved), ...Object.keys(set.compiled),
      ...Object.keys(set.merged), ...Object.values(set.merged),
    ].map(Number));
    const dense = denseFilesOf(beforeLessons);
    const before = await probeLessons(beforeLessons, {
      ...shared, scoreCache, phase: 'before', retired: new Set(), merged: {}, compiled: set.compiled, tree: repoRoot, failClosed: true, dense,
    });
    if (before.fault) {
      err(`eval-compile-delivery: ${before.fault}`);
      return 2;
    }
    const after = await probeLessons(afterLessons, {
      ...shared, scoreCache, rescoreIds, phase: 'after', retired: set.retired, merged: set.merged, compiled: set.compiled,
      tree: set.tree ?? repoRoot, failClosed: true, activeLessons, dense,
    });
    if (after.fault) {
      err(`eval-compile-delivery: ${after.fault}`);
      return 2;
    }
    const lost = lossesOf(before.rows, after.rows, set.retired);
    const movedUndelivered = after.rows.filter((row) => Object.hasOwn(moved, row.id) && !row.probeFile
      && !channels(row).seat && !channels(row).lead).map((row) => row.id);
    const payload = {
      lost: lost.map((item) => item.id), detail: lost, movedUndelivered, before: before.summary, after: after.summary,
    };
    log(JSON.stringify(payload, null, 1));
    if (opts.out) writeFileSync(opts.out, JSON.stringify({ ...payload, beforeRows: before.rows, afterRows: after.rows }, null, 1));
    return lost.length || movedUndelivered.length ? 1 : 0;
  }

  const measured = await probeLessons(lessons, {
    ...shared,
    phase: 'measure', failClosed: false,
    retired: set.retired,
    merged: set.merged,
    compiled: set.compiled,
    tree: set.tree ?? repoRoot,
  });
  if (measured.fault) {
    err(`eval-compile-delivery: ${measured.fault}`);
    return 2;
  }
  log(JSON.stringify(measured.summary, null, 1));
  if (opts.out) writeFileSync(opts.out, JSON.stringify({ summary: measured.summary, rows: measured.rows }, null, 1));
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
