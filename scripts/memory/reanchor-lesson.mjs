#!/usr/bin/env node
// Point a lesson at the file that now holds the code it is about.
//
// Why this exists as a tool rather than a hand-written `memoryctl supersede`.
// An anchor rots on every rename, and a rotten anchor is not a cosmetic defect:
// delivery matches `links.anchor` against the path being edited, so a lesson
// anchored at a path that no longer exists reaches NOBODY who edits the code it
// describes. Measured 2026-08-11 over 138 active lessons in five domains: 130
// anchors resolved, 9 did not, and 8 of those 9 were the whole of what the store
// knew about the Svod adapter - undeliverable since `svod/src/adapter.rs` became
// `svod/src/adapter/`. `sweep-anchors.mjs` REPORTS that state and nothing acts
// on the report.
//
// The one rule this tool enforces, and the reason it is not a shell one-liner:
// **the new anchor's file must exist**. Re-anchoring to a second ghost is the
// same defect with a fresh timestamp, and it is exactly what a hurried hand
// edit produces.
//
// Route: `memoryctl supersede`, one call per lesson, same title and same body -
// the same route `normalize-lesson-domains.mjs` takes, for the same reason.
// Direct SQL would bypass the service that owns the store, its FTS index and its
// versioning.
//
// Usage:
//   node scripts/memory/reanchor-lesson.mjs --id <n> --to <anchor> [--id <n> --to <anchor>...] [--dry] [--refile]
//   node scripts/memory/reanchor-lesson.mjs --map <file.json> [--dry] [--refile] # {"<id>": "<anchor>"}
// --refile explicitly crosses a domain boundary: capture in the single routed
// domain, then retire the source into the new id. Ambiguous/floor routes refuse.
// --dry prints both commands, with a placeholder for the not-yet-captured id.
//
// An anchor is `<repo-relative file>` or `<repo-relative file>:<symbol>`. To
// RETIRE a lesson whose subject was deleted outright, this is the wrong tool:
// `retire-lesson.mjs --id <n> --reason "<why>"`.
import { dbArgument, readLessons, requireServiceWrite } from './service-client.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/is-main.mjs';
import { spawnSync } from 'node:child_process';

import {
  REPO_ROOT,
  parseLinks,
} from './lesson-lib.mjs';
// The delivery matcher and the routing map, asked rather than reimplemented —
// see `lessonMatchesPath` in store.mjs for what asking the anchor string alone
// missed.
import { lessonMatchesPath, loadRoutingMap, resolveDomain } from './store.mjs';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const refile = argv.includes('--refile');

function flagValue(name) {
  const index = argv.indexOf(name);
  return index > -1 ? argv[index + 1] : null;
}

const dbPath = dbArgument();

/** `--id A --to X --id B --to Y` in order, plus `--map <file>`. */
function requestedMoves() {
  const moves = new Map();
  const mapFile = flagValue('--map');
  if (mapFile) {
    const parsed = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const [id, anchor] of Object.entries(parsed)) moves.set(Number(id), String(anchor));
  }
  let pendingId = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--id') {
      pendingId = Number(argv[index + 1]);
      continue;
    }
    if (argv[index] === '--to') {
      if (pendingId === null) throw new Error('--to without a preceding --id');
      moves.set(pendingId, String(argv[index + 1] ?? ''));
      pendingId = null;
    }
  }
  if (pendingId !== null) throw new Error(`--id ${pendingId} has no --to`);
  return moves;
}

import { anchorFile } from './lesson-lib.mjs';
import { gateMovedLesson, routedLessonDomain } from './capture-gate.mjs';
import { lessonFields, LIMITS } from './lesson-quality.mjs';
import { validateCaptureArgs } from './capture-lesson.mjs';

/** The file half of an anchor lives in lesson-lib.mjs, shared with the other
 * anchor tooling (lesson-duplicates.mjs); re-exported here for its tests. */
export { anchorFile };

function runMemoryctl(args, input) {
  const options = { encoding: 'utf8', cwd: REPO_ROOT, timeout: 20000, input };
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'memoryctl.cmd', ...args], options)
      : spawnSync('memoryctl', args, options);
  if (!result || result.status !== 0) {
    const detail = String(result?.stderr || result?.stdout || result?.error?.message || 'unknown');
    throw new Error(`memoryctl ${args[0]} failed: ${detail.trim().slice(0, 400)}`);
  }
  return String(result.stdout ?? '');
}

/**
 * Decide the whole batch before any of it is written.
 *
 * Pure so every rule can be tested without a store, and ONE defect refuses the
 * WHOLE batch: a half-applied re-anchor leaves the store in a state nobody
 * wrote down, and the caller cannot tell which half went through.
 *
 * The target test is DELIVERY, not existence. `existsSync` alone was the first
 * version, and a review round broke it the same day: it is true for a
 * DIRECTORY, so `svod/src/adapter` was accepted, reported as moved, and left
 * the lesson reachable by nobody — `lessonMatchesPath` does not treat a
 * directory as a prefix — while `sweep-anchors` then threw `EISDIR` on it and
 * `check-domain-routing` turned that into a red gate for the whole repository.
 * Asking the matcher instead of the filesystem closes the family, not the one
 * shape that got reported.
 *
 * @param {Map<number, string>} moves id -> new anchor
 * @param {(id: number) => {id: number, title: string, body: string, links: string}|undefined} lookup
 * @param {{ isFile: (repoRelativeFile: string) => boolean,
 *           delivers: (links: object, repoRelativeFile: string) => boolean,
 *           domainOf: (repoRelativeFile: string) => string|null }} tree
 */
export function planReanchor(moves, lookup, tree, { refile = false } = {}) {
  const plan = [];
  const problems = [];
  for (const [id, anchor] of moves) {
    const row = lookup(id);
    if (!row) {
      problems.push(`#${id}: no LIVE lesson with this id (superseded ids cannot be re-anchored)`);
      continue;
    }
    if (!anchor) {
      problems.push(`#${id}: empty anchor`);
      continue;
    }
    // The shared anchorFile returns null for a bare word ('renderCandles',
    // 'LICENSE'), so a move target falls back to the literal file half: a
    // tracked root file without an extension is a real target, and the
    // isFile check below refuses a bare word by name. Feeding null into
    // tree.isFile/path.join once threw an uncaught TypeError instead of
    // refusing the batch (reviewer-mimo-5e69b2).
    const file = anchorFile(anchor) || anchor.split(':')[0];
    if (!file || !tree.isFile(file)) {
      problems.push(
        `#${id}: anchor ${JSON.stringify(anchor)} names no file in this checkout — a missing path is a second ghost, `
          + 'and a DIRECTORY is worse: it exists, so the move looks accepted, and reaches nobody',
      );
      continue;
    }
    const links = parseLinks(row.links);
    const moved = reanchoredLinks(links, anchor);
    if (!tree.delivers(moved, file)) {
      problems.push(
        `#${id}: ${file} would NOT be delivered this lesson after the move — the path exists but `
          + 'the matcher does not reach it, which is the failure this tool exists to prevent',
      );
      continue;
    }
    // Delivery filters by DOMAIN before it looks at the anchor at all, so an
    // anchor moved across a routing boundary leaves a lesson that is active,
    // correct, and reaches nobody. Refused rather than silently re-domained:
    // moving a domain is `normalize-lesson-domains.mjs`, and doing it as a side
    // effect of a rename is how a lesson ends up filed where no one looks.
    const domain = tree.domainOf(file);
    if (domain && links.domain && domain !== links.domain) {
      if (refile) {
        try {
          // Ask with the OLD domain: passing the winner would skip the shared
          // off-route guard against ambiguous explicit domains and floor routes.
          const routed = routedLessonDomain(anchor, links.domain, tree.routing);
          plan.push({
            row: { ...row, linksObj: links }, from: String(links.anchor ?? ''), to: anchor,
            capture: captureArgs(row, links, anchor, routed),
          });
        } catch (error) {
          problems.push(`#${id}: ${error.message}`);
        }
        continue;
      }
      problems.push(
        `#${id}: ${file} routes to ${domain} but the lesson is filed under ${links.domain} — `
          + 'delivery matches the domain before the anchor, so this move would make it '
          + 'undeliverable. Move the domain deliberately (normalize-lesson-domains.mjs), or '
          + 'pick a target inside the same domain',
      );
      continue;
    }
    plan.push({ row: { ...row, linksObj: links }, from: String(links.anchor ?? ''), to: anchor });
  }
  return problems.length ? { plan: [], problems } : { plan, problems };
}

function captureArgs(row, links, anchor, domain) {
  const fields = lessonFields(row.title, row.body);
  fields.trigger ||= links.trigger;
  fields.evidence += `; re-filed from #${row.id}`;
  validateCaptureArgs({ ...fields, anchor, domain });
  // Capture renders fields into a body: indent continuation lines so that its
  // shared parser retains every copied line instead of truncating at the first.
  const bodyValue = (text) => text.replace(/\n/g, '\n  ');
  const args = ['scripts/memory/capture-lesson.mjs', domain, fields.title,
    '--anchor', anchor, '--rule', bodyValue(fields.rule), '--why', bodyValue(fields.why),
    '--trigger', bodyValue(fields.trigger), '--evidence', bodyValue(fields.evidence)];
  if (Object.entries(LIMITS).some(([key, limit]) => [...fields[key]].length > limit)) {
    args.push('--long', `re-filed from source lesson #${row.id}; preserving copied fields`);
  }
  return args;
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 120000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`node ${args[0]} failed: ${String(result.stderr || result.stdout || result.error?.message).trim()}`);
  }
  return result.stdout;
}

const shellArg = (value) => /^[\w./:#=-]+$/.test(String(value))
  ? String(value) : `'${String(value).replaceAll("'", "'\\''")}'`;
const nodeCommand = (args) => `node ${args.map(shellArg).join(' ')}`;
const retireArgs = (id, newId) => [
  'scripts/memory/retire-lesson.mjs', '--id', String(id), '--merged-into', String(newId),
];

/**
 * The links a re-anchored lesson carries: everything it had, the new anchor,
 * and the OLD anchor dropped from `globs` — `buildLessonLinks` copies a glob
 * anchor into `globs`, so leaving it there re-delivers the lesson by the very
 * path that just stopped existing.
 */
export function reanchoredLinks(previous, anchor) {
  const globs = Array.isArray(previous.globs)
    ? previous.globs.filter((glob) => glob !== previous.anchor)
    : [];
  return { ...previous, anchor, globs };
}

/**
 * Write the planned moves, and STOP at the first one that does not go through.
 *
 * `memoryctl` has one supersede per call and no batch route, so a plan of N
 * moves is N writes and true atomicity is not on offer. What IS on offer is a
 * KNOWN boundary: this used to catch each failure, continue, and finish with
 * `2 moved, 1 failed of 3` — which names a count and not a state, so the
 * operator had to reconcile by hand which lessons sat at which anchor. Measured
 * 2026-08-12 by the codex seat of `harness-delivery-review-r1` against a
 * memoryctl stub that failed the middle call: all three ran.
 *
 * Stopping leaves a PREFIX that is applied and a REMAINDER that is untouched,
 * and both are printed by id, with the command that finishes the job.
 *
 * @param {{row: {id: number}, to: string}[]} plan
 * @param {(entry: {row: {id: number}, to: string}) => void} apply
 */
export function applyPlan(plan, apply = (entry) => supersedeAnchor(entry.row, entry.to), {
  dry = false, run = runNode, log = console.log,
} = {}) {
  const moved = [];
  if (dry) {
    for (const entry of plan) if (entry.capture) {
      log(nodeCommand(entry.capture));
      log(nodeCommand(retireArgs(entry.row.id, '<new-id>')));
    }
    return { moved, failed: null, remaining: [] };
  }
  for (let index = 0; index < plan.length; index += 1) {
    const entry = plan[index];
    try {
      if (entry.capture) {
        const output = run(entry.capture);
        const match = output.match(/"id"\s*:\s*(\d+)/) || output.match(/#(\d+)/);
        const newId = Number(match?.[1]);
        if (!Number.isSafeInteger(newId) || newId <= 0 || newId === Number(entry.row.id)) {
          throw new Error(`capture for #${entry.row.id} returned no distinct new id; inspect before retrying: ${output}`);
        }
        try {
          run(retireArgs(entry.row.id, newId));
        } catch (cause) {
          const error = new Error(`captured #${entry.row.id} into #${newId}, but retire failed: ${cause.message}; finish by hand: ${nodeCommand(retireArgs(entry.row.id, newId))}`);
          error.newId = newId;
          throw error;
        }
        log(`re-filed #${entry.row.id} -> #${newId}`);
      } else apply(entry);
      moved.push(entry.row.id);
    } catch (error) {
      return {
        moved,
        failed: { id: entry.row.id, to: entry.to, message: error.message,
          ...(error.newId ? { newId: error.newId } : {}) },
        remaining: plan.slice(index + 1).map((rest) => ({ id: rest.row.id, to: rest.to })),
      };
    }
  }
  return { moved, failed: null, remaining: [] };
}

/** The command that finishes a batch this one stopped in the middle of. */
export function resumeCommand(failed, remaining, { refile = false } = {}) {
  const pairs = [failed, ...remaining]
    .filter(Boolean)
    .map((entry) => `--id ${entry.id} --to ${shellArg(entry.to)}`)
    .join(' ');
  return `node scripts/memory/reanchor-lesson.mjs ${pairs}${refile ? ' --refile' : ''}`;
}

function supersedeAnchor(row, anchor) {
  // The move passes the capture gate; a refusal throws before the supersede.
  const links = gateMovedLesson(row, reanchoredLinks(row.linksObj, anchor));
  runMemoryctl([
    'supersede',
    '--id', String(row.id),
    '--title', row.title,
    '--body-file', '-',
    '--links', JSON.stringify(links),
    '--session', process.env.MEMORYCTL_SESSION_ID || 'reanchor',
    '--agent', process.env.MEMORYCTL_AGENT_ID || 'reanchor-lesson',
  ], row.body ?? '');
}

if (isMain(import.meta.url)) {
  const moves = requestedMoves();
  if (moves.size === 0) {
    console.error(
      'usage: reanchor-lesson.mjs (--id <n> --to <anchor> [...] | --map <file.json>) [--dry] [--refile]',
    );
    process.exit(2);
  }

  requireServiceWrite(dbPath, dry);
  const lessons = await readLessons({ dbPath });
  const byId = new Map(lessons.map(row => [Number(row.id), row]));

  const routing = loadRoutingMap();
  const { plan, problems } = planReanchor(moves, (id) => byId.get(id), {
    routing,
    isFile: (file) => {
      const full = path.join(REPO_ROOT, file);
      return fs.existsSync(full) && fs.statSync(full).isFile();
    },
    delivers: (links, file) => lessonMatchesPath(links, file),
    domainOf: (file) => resolveDomain(file, routing),
  }, { refile });
  if (problems.length) {
    for (const problem of problems) console.error(`REFUSED ${problem}`);
    process.exit(1);
  }

  for (const entry of plan) {
    console.log(`#${entry.row.id}\t${entry.from || '(none)'} -> ${entry.to}\t${String(entry.row.title).slice(0, 58)}`);
  }
  if (dry) {
    applyPlan(plan, undefined, { dry });
    console.log(`reanchor: ${plan.length} lesson(s) would move (dry)`);
    process.exit(0);
  }

  const { moved, failed, remaining } = applyPlan(plan);
  if (!failed) {
    console.log(`reanchor: ${moved.length} moved of ${plan.length}`);
    process.exit(0);
  }
  // A count would not say WHICH half is where. The two lists are the state of
  // the store, and the command below is the rest of the batch.
  console.error(`FAIL id=${failed.id}: ${failed.message}`);
  console.error(
    `reanchor STOPPED at #${failed.id}: ${moved.length} of ${plan.length} moved `
      + `[${moved.join(', ') || 'none'}], failed #${failed.id}`
      + `${failed.newId ? ` (captured new #${failed.newId}; retire by hand before resuming)` : ''}, `
      + `untouched [${remaining.map((entry) => entry.id).join(', ') || 'none'}]. `
      + 'Fix the cause before resuming'
      + (failed.newId && !remaining.length ? '.' : ':\n  '
        + resumeCommand(failed.newId ? null : failed, remaining, { refile })),
  );
  process.exit(1);
}
