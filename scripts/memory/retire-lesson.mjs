#!/usr/bin/env node
// Retire a lesson: keep it in the chain, stop counting it as knowledge in force.
//
// Retirement used to be a TITLE convention - `RETIRED: <reason>` - and nothing
// else, so a retired lesson stayed `links.status=active`. Measured 2026-07-30:
// 14 of 77 live lessons were retired in their titles and still counted against
// the per-domain budget, still came back from a domain query, and still read like
// rules to whoever received them. A convention that only the title carries is not
// a state.
//
// So retirement is a status, and the two halves move together: the title says why
// and the status says it is no longer in force. Nothing is deleted - the row stays
// superseded-into, the way every other correction in this store works.
//
// Usage:
//   node scripts/memory/retire-lesson.mjs --id <n> [--id <n> ...] --reason "<why>"
//   node scripts/memory/retire-lesson.mjs --id 386 --merged-into 469   (a duplicate)
import { dbArgument, readLessons, requireServiceWrite } from './service-client.mjs';

import {
  REPO_ROOT,
  parseLinks,
  runMemoryctl as runShared,
} from './lesson-lib.mjs';

import { cutTitle } from './archive-handoff.mjs';

const argv = process.argv.slice(2);
const ids = [];
let reason = '';
let mergedInto = '';
const dbPath = dbArgument();
requireServiceWrite(dbPath, false);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--id') ids.push(Number(argv[i + 1]));
  else if (argv[i] === '--reason') reason = String(argv[i + 1] ?? '');
  else if (argv[i] === '--merged-into') mergedInto = String(argv[i + 1] ?? '');
}
if (!ids.length || (!reason && !mergedInto)) {
  console.error('usage: retire-lesson.mjs --id <n> [--id <n>...] (--reason "<why>" | --merged-into <id>)');
  process.exit(2);
}

// Was a private copy that spawned `cmd.exe /d /s /c memoryctl.cmd`. It stopped
// resolving — measured 2026-08-05, every retire failed with a mojibake "the
// system cannot find the path specified" while capture-lesson, which uses the
// shared resolver, worked in the same shell. A second implementation of one
// thing is a second thing to rot, and this one rotted where nobody looks: the
// path that RETIRES a stale lesson. Now the same resolver everywhere.
// The body travels on stdin (`--body-file -`, task 2868) for the same reason
// archive-handoff.mjs moved there (task 2758): a predictable temp file under
// os.tmpdir() is a name anyone can plant a symlink at, and writeFileSync
// follows it.
function runMemoryctl(args, input) {
  return String(runShared(args, { cwd: REPO_ROOT, input }).stdout ?? '');
}

const lessons = await readLessons();
const byId = new Map(lessons.map(row => [Number(row.id), row]));
let done = 0;
for (const id of ids) {
  const row = byId.get(id);
  if (!row) {
    console.error(`skip id=${id}: no live lesson with that id`);
    continue;
  }
  const links = { ...parseLinks(row.links), status: 'retired' };
  const prefix = mergedInto ? `MERGED-INTO: ${mergedInto}` : `RETIRED: ${reason}`;
  const title = /^(RETIRED|MERGED-INTO):/.test(row.title) ? row.title : `${prefix} — ${row.title}`;
  const stamped = `${String(row.body ?? '').trimEnd()}\n- retired: ${mergedInto ? `merged into ${mergedInto}` : reason} (${new Date().toISOString().slice(0, 10)})\n`;
  try {
    runMemoryctl([
      'supersede',
      '--id', String(id),
      '--title', cutTitle(title),
      '--body-file', '-',
      '--links', JSON.stringify(links),
      '--session', process.env.MEMORYCTL_SESSION_ID || 'retire',
      '--agent', process.env.MEMORYCTL_AGENT_ID || 'retire-lesson',
    ], stamped);
    console.log(`retired id=${id} ${row.title.slice(0, 60)}`);
    done += 1;
  } catch (error) {
    console.error(`FAIL id=${id}: ${error.message}`);
  }
}
console.log(`retire: ${done} of ${ids.length}`);
if (done !== ids.length) process.exit(1);
