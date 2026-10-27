#!/usr/bin/env node
// Value per routine: reported runs against the tasks those runs produced.
// A run is a memory entry titled "routine <id> <YYYY-MM-DD>: ..." and a finding
// task is titled "[routine:<id>] <finding>" (ops/routines/*.md, "Report and
// delivery"). Read-only: every read goes through scripts/memory/service-client.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { readMemory, readTasks } from './memory/service-client.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTINES_DIR = path.join(REPO_ROOT, 'ops', 'routines');
const PAGE = 200;

export function routineIds(dir = ROUTINES_DIR) {
  return fs.readdirSync(dir)
    // CONTRACT.md is the module contract of this directory (task 2409), not a routine.
    .filter((name) => name.endsWith('.md') && name !== 'CONTRACT.md')
    .map((name) => name.slice(0, -3))
    .sort();
}

// The default search kind set excludes only kind 'report'; routine reports are
// project/reference entries, so they are in it. The FTS phrase survives the
// hyphens of a routine id: unicode61 tokenizes them apart on both the indexed
// title and the query, and the prefix filter below keeps `routine alpha ` from
// counting `routine alpha-beta`.
export async function routineRuns(id, read = readMemory) {
  const prefix = `routine ${id} `;
  const query = encodeURIComponent(`title:"routine ${id}"`);
  const runs = [];
  const seen = new Set();
  for (let offset = 0; ; offset += PAGE) {
    const page = await read(`search?q=${query}&limit=${PAGE}&offset=${offset}`);
    if (!Array.isArray(page) || page.length > PAGE
      || page.some((row) => !Number.isSafeInteger(row?.id) || typeof row?.title !== 'string')) {
      throw new Error('invalid memoryd search response');
    }
    for (const row of page) {
      if (seen.has(row.id)) throw new Error('memoryd search repeated a page (offset unsupported)');
      seen.add(row.id);
      if (row.title.startsWith(prefix)) runs.push(row);
    }
    // A short page is complete; only a full page needs another offset probe.
    if (page.length < PAGE) break;
  }
  return runs;
}

// One run may write more than one report entry (consolidate-memory-daily
// appends one for A1/B1 and one for stage E on the same night), so a run is a
// distinct date, not an entry. A same-day rerun is a retry of that run.
export function runDates(id, runs) {
  const pattern = new RegExp(`^routine ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d{4}-\\d{2}-\\d{2})\\b`);
  const dates = new Set();
  for (const row of runs) {
    const match = pattern.exec(row.title);
    if (match) dates.add(match[1]);
  }
  return [...dates].sort();
}

export function taskCounts(id, tasks) {
  const prefix = `[routine:${id}]`;
  const mine = tasks.filter((task) => typeof task?.title === 'string' && task.title.startsWith(prefix));
  // done IS "closed with evidence": the service refuses a close without it.
  const closed = mine.filter((task) => task.status === 'done').length;
  const cancelled = mine.filter((task) => task.status === 'cancelled').length;
  const open = mine.length - closed - cancelled;
  return {
    tasks: mine.length, closed, cancelled, open,
    closedShare: mine.length === 0 ? null : closed / mine.length,
  };
}

export function formatLine(value) {
  const share = value.closedShare === null ? 'n/a' : `${Math.round(value.closedShare * 100)}%`;
  return `${value.routine}: runs ${value.runs}, tasks ${value.tasks}, closed ${value.closed}, `
    + `cancelled ${value.cancelled}, open ${value.open}, closed share ${share}`;
}

export function parseArgs(argv) {
  let routine = null;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--routine') {
      routine = argv[index + 1];
      if (!routine || routine.startsWith('--')) throw new Error('--routine requires an id');
      index++;
    } else if (argv[index] === '--json') {
      json = true;
    } else {
      throw new Error(`unknown argument: ${argv[index]} (usage: value [--routine <id>] [--json])`);
    }
  }
  return { routine, json };
}

export async function valueCommand(argv, { read = readMemory, tasks = readTasks, ids = routineIds, print = console.log } = {}) {
  const { routine, json } = parseArgs(argv);
  const wanted = routine === null ? ids() : [routine];
  // One task list serves every routine; only the run search is per id.
  const allTasks = await tasks();
  if (!Array.isArray(allTasks)
    || allTasks.some((task) => typeof task?.title !== 'string' || typeof task?.status !== 'string')) {
    throw new Error('invalid memoryd tasks response');
  }
  const values = [];
  for (const id of wanted) {
    const runs = await routineRuns(id, read);
    values.push({ routine: id, runs: runDates(id, runs).length, ...taskCounts(id, allTasks) });
  }
  print(json ? JSON.stringify(values, null, 2) : values.map(formatLine).join('\n'));
  return values;
}

if (isMain(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'value') {
    console.error('usage: node scripts/routine-ledger.mjs value [--routine <id>] [--json]');
    process.exit(2);
  }
  valueCommand(rest).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
