// Local adjudication queue: memoryd is read-only; verdicts live in a JSONL ledger.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { readLessons, readDenseLessonNeighbours, readDenseModel } from './service-client.mjs';
import { findDuplicatePairs } from './lesson-duplicates.mjs';

export const DENSE_FITS = fileURLToPath(new URL('./lesson-dedupe-fit.json', import.meta.url));

const HELP = `Usage: node scripts/memory/lesson-dedupe.mjs candidates [--json] [--since <iso>]
       node scripts/memory/lesson-dedupe.mjs run-done
       node scripts/memory/lesson-dedupe.mjs record --newer <L> --older <N> --verdict duplicate|distinct [--note <t>]

Weekly routine: list candidates; adjudicate each pair. For a duplicate, memoryctl
supersede the older with merged evidence or retire the newer; then run
node ops/orchestrator/src/main.ts lesson-repeat --lesson <L> --duplicate-of <N>.
Record each verdict. The ledger is local (LESSON_DEDUPE_LEDGER overrides its path).`;

export function ledgerPath(env = process.env) {
  return env.LESSON_DEDUPE_LEDGER || path.join(env.HOME || os.homedir(), '.local/state/lesson-dedupe/ledger.jsonl');
}

function positiveId(value, name) {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(id)) throw new Error(`${name} must be a positive safe integer`);
  return id;
}

function pairIds(newer, older) {
  const n = positiveId(newer, 'newer');
  const o = positiveId(older, 'older');
  if (n <= o) throw new Error('newer must have a greater ID than older');
  return [n, o];
}

function pairKey(newer, older) { return `${newer}:${older}`; }

export function readDenseThreshold(model, file = DENSE_FITS) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('dense threshold unavailable: embedding model is required');
  const key = `models[${JSON.stringify(model)}].threshold`;
  let measured;
  try {
    const fits = JSON.parse(fs.readFileSync(file, 'utf8')).models;
    measured = fits && Object.hasOwn(fits, model) ? fits[model]?.threshold : undefined;
  } catch (error) { throw new Error(`dense threshold unavailable: ${file} ${key}: ${error.message}`); }
  if (typeof measured !== 'number' || !Number.isFinite(measured) || measured < -1 || measured > 1) {
    throw new Error(`dense threshold unavailable: ${file} ${key} is missing or invalid`);
  }
  return measured;
}

function isoTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d{1,3})?Z)?$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error('since must be a valid ISO UTC timestamp');
  }
  return Date.parse(value);
}

export function readLedger(file = ledgerPath()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter(Boolean).map((line, index) => {
    let row;
    try { row = JSON.parse(line); }
    catch { throw new Error(`invalid ledger JSON at line ${index + 1}`); }
    if (row.type === 'run-done') {
      try { isoTime(row.recordedAt); }
      catch { throw new Error(`invalid ledger run-done at line ${index + 1}`); }
      return row;
    }
    try { pairIds(row.newer, row.older); }
    catch (error) { throw new Error(`invalid ledger line ${index + 1}: ${error.message}`); }
    if (!['duplicate', 'distinct'].includes(row.verdict)) throw new Error(`invalid ledger verdict at line ${index + 1}`);
    return row;
  });
}

export function candidates(rows, ledger = [], warn = console.error, dense = [], skippedMalformed = [], model) {
  const skipped = new Set(skippedMalformed);
  const active = rows.filter(row => row.status === 'active' && !skipped.has(Number(row.id)));
  const byId = new Map(active.map(row => [positiveId(row.id, 'lesson id'), row]));
  if (byId.size !== active.length) throw new Error('duplicate lesson ID in memoryd response');
  const seen = new Set(ledger.filter(row => row.type !== 'run-done').map(row => pairKey(...pairIds(row.newer, row.older))));
  const pairs = new Map();
  function add(idA, idB, source) {
    // Advisory links may be stale or malformed. Neither can block other candidates.
    const a = Number(idA);
    const b = Number(idB);
    if (!byId.has(a) || !byId.has(b)) return; // Retired or missing lessons are not candidates.
    if (a === b) {
      warn(`lesson-dedupe: skipping self-link for lesson ${a}`);
      return;
    }
    const newer = Math.max(a, b);
    const older = Math.min(a, b);
    const key = pairKey(newer, older);
    if (seen.has(key)) return;
    if (!pairs.has(key)) {
      const a = byId.get(newer);
      const b = byId.get(older);
      pairs.set(key, {
        newer, older,
        newerTitle: a.title, olderTitle: b.title,
        newerAnchor: a.linksObj.anchor, olderAnchor: b.linksObj.anchor,
        newerDomain: a.linksObj.domain, olderDomain: b.linksObj.domain,
        sources: [],
      });
    }
    const sources = pairs.get(key).sources;
    if (!sources.includes(source)) sources.push(source);
  }
  for (const row of active) {
    const linked = row.linksObj.possibleDuplicateOf ?? [];
    if (!Array.isArray(linked)) {
      warn(`lesson-dedupe: skipping malformed possibleDuplicateOf on lesson ${row.id}`);
      continue;
    }
    for (const older of linked) add(row.id, older, 'possibleDuplicateOf');
  }
  for (const pair of findDuplicatePairs(active)) {
    const newer = Math.max(pair.idA, pair.idB);
    const older = Math.min(pair.idA, pair.idB);
    add(newer, older, 'lexical');
  }
  const threshold = dense.length ? readDenseThreshold(model) : null;
  for (const { id, neighbours } of dense) {
    if (!Array.isArray(neighbours)) throw new Error(`dense unavailable for lesson ${id}`);
    for (const neighbour of neighbours) {
      if (!Number.isSafeInteger(neighbour?.id) || typeof neighbour.cosine !== 'number'
        || !Number.isFinite(neighbour.cosine)) throw new Error(`invalid dense neighbour for lesson ${id}`);
      if (neighbour.cosine >= threshold && byId.get(id)?.linksObj.domain === byId.get(neighbour.id)?.linksObj.domain) {
        add(id, neighbour.id, 'dense');
      }
    }
  }
  return [...pairs.values()].sort((a, b) => a.newer - b.newer || a.older - b.older);
}

export function record({ newer, older, verdict, note }, file = ledgerPath()) {
  const [n, o] = pairIds(newer, older);
  if (!['duplicate', 'distinct'].includes(verdict)) throw new Error('verdict must be duplicate or distinct');
  if (note !== undefined && (typeof note !== 'string' || !note.trim())) throw new Error('note must be nonempty text');
  if (readLedger(file).some(row => row.newer === n && row.older === o)) throw new Error(`pair ${n}:${o} already recorded`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ newer: n, older: o, verdict, ...(note === undefined ? {} : { note }), recordedAt: new Date().toISOString() }) + '\n');
}

function parseOptions(args, allowed) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.includes(key) || key in result) throw new Error(`unknown or repeated option: ${key}`);
    if (key === '--json') result.json = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${key} needs a value`);
      result[key.slice(2)] = args[++i];
    }
  }
  return result;
}

export async function run(argv = process.argv.slice(2), { read = () => readLessons({}, { status: 'active' }),
  neighbours = readDenseLessonNeighbours, readModel = readDenseModel,
  file = ledgerPath(), output = console.log, now = () => Date.now() } = {}) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === 'help') {
    if (rest.length) throw new Error('help takes no options');
    output(HELP);
  } else if (command === 'candidates') {
    const options = parseOptions(rest, ['--json', '--since']);
    const ledger = readLedger(file);
    const rows = await read(); // A failed memoryd read must never look like an empty queue.
    const mark = [...ledger].reverse().find(row => row.type === 'run-done');
    const since = options.since ? isoTime(options.since) : mark ? isoTime(mark.recordedAt) : now() - 7 * 86400000;
    const eligible = rows.filter(row => row.status === 'active'
      && (row.linksObj.duplicateCheck === 'incomplete' || Number(row.ts) >= since));
    const model = eligible.length ? await readModel() : undefined;
    if (eligible.length) readDenseThreshold(model); // Fail before an expensive sweep if the served model has no fit.
    const dense = [];
    const skippedMalformed = new Set();
    const missingVectors = new Set();
    const supersededDuringRun = new Set();
    // Bound concurrent reads: a backfill can select most of the active corpus.
    for (let offset = 0; offset < eligible.length; offset += 16) {
      const batch = await Promise.all(eligible.slice(offset, offset + 16).map(async row => {
        const id = Number(row.id);
        try { return { id, result: await neighbours(id) }; }
        catch (error) {
          // The client exposes HTTP failures as messages. A missing route is not a superseded lesson.
          if (!error.message?.startsWith(`dense unavailable for lesson ${id}: memoryd GET /api/memory/nearest-lessons: HTTP 404 `)
            || !error.message.includes(`active lesson ${id} not found`)) throw error;
          return { id, superseded: true };
        }
      }));
      for (const { id, result, superseded } of batch) {
        if (superseded) { supersededDuringRun.add(id); continue; }
        if (!result || !Array.isArray(result.neighbours) || !Array.isArray(result.skippedMalformed)
          || !Array.isArray(result.missingVectors)) throw new Error(`invalid dense response for lesson ${id}`);
        dense.push({ id, neighbours: result.neighbours });
        for (const skipped of result.skippedMalformed) skippedMalformed.add(skipped);
        for (const missing of result.missingVectors) missingVectors.add(missing);
      }
    }
    if (eligible.length && await readModel() !== model) throw new Error('embedding model changed during dense sweep; rerun candidates');
    const pairs = candidates(rows.filter(row => !supersededDuringRun.has(Number(row.id))),
      ledger, console.error, dense, skippedMalformed, model);
    const unchecked = { skippedMalformed: [...skippedMalformed].sort((a, b) => a - b),
      missingVectors: [...missingVectors].sort((a, b) => a - b),
      ...(supersededDuringRun.size ? { supersededDuringRun: [...supersededDuringRun].sort((a, b) => a - b) } : {}) };
    if (options.json) output(JSON.stringify({ pairs, unchecked }, null, 2));
    else {
      for (const pair of pairs) output(`#${pair.newer} ${pair.newerTitle} [${pair.newerAnchor}, ${pair.newerDomain}] ↔ #${pair.older} ${pair.olderTitle} [${pair.olderAnchor}, ${pair.olderDomain}] (${pair.sources.join(', ')})`);
      output(`${pairs.length} candidate pairs`);
      output(`unchecked: skippedMalformed=${JSON.stringify(unchecked.skippedMalformed)} missingVectors=${JSON.stringify(unchecked.missingVectors)}`
        + (supersededDuringRun.size ? ` supersededDuringRun=${JSON.stringify(unchecked.supersededDuringRun)}` : ''));
    }
    return pairs;
  } else if (command === 'run-done') {
    if (rest.length) throw new Error('run-done takes no options');
    // Validate before appending: an invalid ledger must never reset the window.
    readLedger(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const recordedAt = new Date(now()).toISOString();
    fs.appendFileSync(file, JSON.stringify({ type: 'run-done', recordedAt }) + '\n');
    output(`run-done ${recordedAt}`);
  } else if (command === 'record') {
    const options = parseOptions(rest, ['--newer', '--older', '--verdict', '--note']);
    record(options, file);
    output(`recorded ${options.newer}:${options.older} ${options.verdict}`);
  } else throw new Error(HELP);
}

if (isMain(import.meta.url)) {
  try { await run(); }
  catch (error) { console.error(`lesson-dedupe: ${error.message}`); process.exitCode = 1; }
}
