#!/usr/bin/env node
// Archive B1 handoffs unattended: a live handoff whose track was continued by
// a newer one, with every declared task closed, at least 14 days old, not
// pinned, on a track whose current status is not blocked.
//
// Until 2026-10 this was a four-step hand procedure (memoryctl get --json,
// node -e extraction, temp file, supersede — see consolidate-memory/SKILL.md),
// impossible for the nightly routine, so ~922 B1 candidates accumulated. This
// script is that procedure behind the same predicate the scan prints, plus a
// write the routine can trust: after each supersede it reads the new version
// back and compares body SHA-256, because an archive that rewrote the body
// would be exactly the silent history edit this store exists to prevent.
//
// Refuses (reason printed, nothing written) anything the predicate refuses,
// plus ids that are not a live handoff or whose title is already history.
// Exit is non-zero when any requested id was not archived.
//
// Usage:
//   node scripts/memory/archive-handoff.mjs --id <n> [--id <n> ...] [--dry-run]
import { isMain } from '../lib/is-main.mjs';
import { B1_ARCHIVE_DAYS, classifyB1, latestLiveByTrack } from './b1-handoff.mjs';
import { parseLinks, REPO_ROOT, runMemoryctl as runShared, sha256 } from './lesson-lib.mjs';
import { readEntries, readMemory, readTasks } from './service-client.mjs';

/**
 * Collect repeatable --id values and --dry-run; refuse everything else.
 * @param {string[]} argv
 */
export function parseArgv(argv = []) {
  const ids = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id') {
      const id = Number(argv[i + 1]);
      if (!Number.isSafeInteger(id) || id <= 0) return { ids: [], dryRun: false, error: `invalid --id value: ${argv[i + 1] ?? '(missing)'}` };
      ids.push(id);
      i += 1;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    } else {
      return { ids: [], dryRun: false, error: `unknown argument: ${argv[i]}` };
    }
  }
  return { ids: [...new Set(ids)], dryRun, error: ids.length ? '' : 'no --id given' };
}

/**
 * Cap at `max` code points, never splitting a surrogate pair: a UTF-16
 * slice can cut an emoji into a lone surrogate that reaches the CLI as U+FFFD
 * (task 2758 here, task 2868 in retire-lesson.mjs — one helper, no copies).
 * @param {string} text
 * @param {number} [max]
 */
export function cutTitle(text, max = 480) {
  return [...String(text ?? '')].slice(0, max).join('');
}

/**
 * The archive payload: title gains the ARCHIVED: prefix, links keep every
 * existing field and gain status "archived", the body moves byte for byte.
 * @param {object} row live handoff row
 */
export function planArchive(row) {
  return {
    title: cutTitle(`ARCHIVED: ${String(row.title ?? '')}`),
    links: { ...parseLinks(row.links), status: 'archived' },
    body: String(row.body ?? ''),
  };
}

/**
 * The exact supersede argv (retire-lesson.mjs shape, plus --no-open-work:
 * honest here precisely because every declared tail is closed).
 */
export function supersedeArgs({ id, title, links }) {
  return [
    'supersede',
    '--id', String(id),
    '--title', title,
    '--body-file', '-',
    '--links', JSON.stringify(links),
    '--no-open-work',
    '--session', process.env.MEMORYCTL_SESSION_ID || 'archive-handoff',
    '--agent', process.env.MEMORYCTL_AGENT_ID || 'archive-handoff',
  ];
}

/**
 * Write one archive through memoryctl supersede and verify the readback.
 * `run` (sync, throws on failure) and `readEntry` are injected so tests stub
 * the CLI and the service; production passes the shared runMemoryctl and the
 * service GET.
 * @returns {Promise<{ dryRun: boolean, newId?: number }>}
 */
export async function archiveOne({ row, run, readEntry, dryRun = false }) {
  const { title, links, body } = planArchive(row);
  if (dryRun) return { dryRun: true };
  run(supersedeArgs({ id: row.id, title, links }), { input: body });
  const after = await readEntry(Number(row.id));
  const newId = Number(after?.superseded_by);
  if (!Number.isSafeInteger(newId) || newId <= 0) {
    throw new Error(`supersede left no successor (superseded_by=${String(after?.superseded_by)})`);
  }
  const fresh = await readEntry(newId);
  const got = sha256(String(fresh?.body ?? ''));
  const want = sha256(body);
  if (got !== want) throw new Error(`readback body SHA-256 mismatch on #${newId}: ${got} != ${want}`);
  return { dryRun: false, newId };
}

const REASONS = {
  archived: 'links.status already archived',
  'dead-title': 'title already history (ARCHIVED/RETIRED/MERGED-INTO prefix)',
  'no-track': 'no track declared',
  'newest-live': (d) => `newest live handoff of track ${d.track}`,
  pinned: 'pinned',
  'open-tails': (d) => `${d.openTails} declared task(s) not done/cancelled`,
  young: (d) => `younger than ${B1_ARCHIVE_DAYS} days (age ${d.ageDays} d)`,
  'track-status': (d) => `track status "${d.trackStatus}" is in REFUSED_TRACK_STATUSES`,
};

/** Human text for a non-candidate verdict. */
export function reasonText(decision) {
  const reason = REASONS[decision.reason];
  return typeof reason === 'function' ? reason(decision) : (reason || decision.reason);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--db')) {
    console.error('REFUSED --db: reads memoryd and writes through memoryctl; a local-copy id must not touch live memory');
    process.exit(2);
  }
  const { ids, dryRun, error } = parseArgv(argv);
  if (error) {
    console.error(`usage: archive-handoff.mjs --id <n> [--id <n> ...] [--dry-run] — ${error}`);
    process.exit(2);
  }
  const handoffs = await readEntries('handoff');
  const tasks = await readTasks();
  const byId = new Map(handoffs.map((row) => [Number(row.id), row]));
  const latestByTrack = latestLiveByTrack(handoffs);
  let done = 0;
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      console.error(`REFUSED id=${id}: no live handoff with that id`);
      continue;
    }
    const decision = classifyB1({ handoff: row, latestByTrack, tasks, archiveDays: B1_ARCHIVE_DAYS });
    if (decision.verdict !== 'candidate') {
      console.error(`REFUSED id=${id}: ${reasonText(decision)}`);
      continue;
    }
    const tail = ` [${decision.track} · ${decision.trackStatus}] возраст ${decision.ageDays} д, свежий #${decision.latestId}`;
    try {
      const result = await archiveOne({
        row,
        dryRun,
        run: (args, options) => runShared(args, { ...options, cwd: REPO_ROOT }),
        readEntry: (entryId) => readMemory(`entry?id=${entryId}`),
      });
      console.log(result.dryRun ? `would archive id=${id}${tail}` : `archived id=${id} -> #${result.newId}${tail}`);
      done += 1;
    } catch (failure) {
      console.error(`FAIL id=${id}: ${failure.message}`);
    }
  }
  console.log(`archive: ${done} of ${ids.length}${dryRun ? ' (dry-run)' : ''}`);
  if (done !== ids.length) process.exit(1);
}

if (isMain(import.meta.url)) {
  main().catch((failure) => {
    console.error(`archive: FAIL: ${failure.message}`);
    process.exit(1);
  });
}
