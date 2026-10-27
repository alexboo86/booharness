#!/usr/bin/env node
// Sweep the COMMANDS live lessons name, the way sweep-anchors.mjs sweeps the
// files they anchor to.
//
// sweep-anchors answers "does the anchored file still exist". This answers the
// next question up: does the thing the lesson tells you to RUN still exist.
// Measured 2026-08-05 over 147 live lessons: 102 (69%) name a command, a config
// key or a symbol — something beyond a path — and one of them (#124) told the
// next agent to rely on `npm run check:skills-drift`, a gate that had never been
// written.
//
//   node scripts/memory/sweep-probes.mjs [--db <path>] [--json]
//
// SEVERITY, and why they differ:
//   gone (exit 1)  an npm script the lesson names is absent from package.json.
//                  `npm run X` can only mean this repository, so there is no
//                  reading of it that is still true.
//   drift (warn)   a CLI verb absent from its binary's --help, or a repo-shaped
//                  path that is not in the tree. Both are ambiguous by nature:
//                  a lesson may quote another project's path (`agtop/src/rtk.rs`)
//                  or a verb of a tool not installed on this machine. Measured
//                  2026-08-05, naive path extraction was right 2 times in 5 —
//                  which is exactly why this half warns instead of failing.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { dbArgument, readLessons } from './service-client.mjs';
import { scrubbedGitEnv } from '../git-env.mjs';
import { probeObjections } from './lesson-lib.mjs';
import { projectConfig } from '../lib/harness-config.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A script name may CONTAIN `:`, `-` and `_`, and never ends with one — so the
// last character has to be alphanumeric. Without that boundary the class eats
// the colon of ordinary prose: `npm run check:harness-audit: проза вернулась`
// extracted `check:harness-audit:`, no such script exists, and the sweep called
// a live gate gone. That is the ONE severity here that fails the build, so a
// single sentence of punctuation kept `sweep:probes` red for good — measured
// 2026-08-20 on lesson #3236, whose script has existed the whole time.
export const NPM_RE = /npm run ([a-z0-9](?:[a-z0-9:_-]*[a-z0-9])?)/g;
export const CLI_RE = /\b(rtk|memoryctl|probe|svod)\s+([a-z][a-z0-9-]{1,20})\b/g;
const probeRoots = projectConfig().probeRoots.map((root) => root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
export const PATH_RE = new RegExp(`\\b((?:${probeRoots.length ? probeRoots.join('|') : '(?!)'})/[\\w./-]+\\.(?:mjs|js|ts|tsx|rs|ps1|sh|md|json|toml|py))\\b`, 'g');

// Verbs that read as a subcommand but are prose: "rtk чтобы", "svod status" is
// real, "memoryctl не" is not. Anything non-ASCII is filtered by the regex
// already; these are the English words that survive it.
const NOT_A_VERB = new Set(['is', 'in', 'and', 'or', 'the', 'to', 'for', 'of', 'a', 'an', 'not', 'no', 'via', 'on', 'at', 'by', 'it', 'as', 'this', 'that', 'with', 'from']);

export function extract(text) {
  const grab = (re, pick) => {
    const out = new Set();
    for (const m of String(text).matchAll(re)) out.add(pick(m));
    return [...out];
  };
  return {
    npm: grab(NPM_RE, (m) => m[1]),
    cli: grab(CLI_RE, (m) => `${m[1]} ${m[2]}`).filter((pair) => !NOT_A_VERB.has(pair.split(' ')[1])),
    paths: grab(PATH_RE, (m) => m[1]),
  };
}

/**
 * Does `binary --help` mention `verb`?
 * Cached per binary: a sweep asks about the same four tools dozens of times, and
 * a tool that is not installed must answer once, not once per lesson.
 */
export function makeVerbChecker(run = (bin) => spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 8000, windowsHide: true })) {
  const cache = new Map();
  return (binary, verb) => {
    if (!cache.has(binary)) {
      const r = run(binary);
      // A binary that is not installed here answers `null`, and every verb of it
      // is then unknowable rather than absent — the sweep must not call that
      // drift, or a laptop without cargo would report the whole corpus rotten.
      cache.set(binary, r && !r.error ? `${r.stdout || ''}${r.stderr || ''}` : null);
    }
    const help = cache.get(binary);
    if (help === null) return 'unknown';
    return new RegExp(`(^|[\\s|,\`'"])${verb}([\\s|,\`'".]|$)`, 'm').test(help) ? 'keep' : 'drift';
  };
}

/**
 * Run a lesson's DECLARED probe and judge it against its own expectation.
 *
 * This is the exact half of the sweep. The heuristic half below can only see
 * that a lesson mentions `rtk stat`; it cannot tell "this exists" from "this
 * deliberately does not" — and measured 2026-08-05, five of eleven drift rows
 * were lessons whose whole point was an ABSENCE. A declared probe removes the
 * ambiguity because the lesson says which way it meant it.
 *
 * Validated again before running: memory is data, and data that is about to be
 * executed is checked at the moment of execution, not only when it was written.
 *
 * A probe answers only when the command SUCCEEDED. A failed command prints
 * nothing, and with --expect-absent nothing is exactly what the lesson wanted to
 * see — so swallowing the exit code turns a broken probe into "the lesson still
 * holds", the one direction this must never fail in.
 */
export const PROBE_OUTPUT_MAX = 64 * 1024;
export const PROBE_MATCH_TIMEOUT_MS = 2000;

/**
 * Run one pattern against one text SOMEWHERE KILLABLE.
 *
 * The write-time scanner (`probePatternRisk`) is a heuristic over regexp source
 * and cannot be anything else: measured 2026-08-05, its first version missed
 * `a?a?a?…` and its second missed `a*a*a*b` — four quantifiers, no nesting, and
 * V8 does not finish it on 2000 characters. A heuristic that has been wrong
 * twice is not what should stand between the memory database and a sweep wedged
 * at 100% CPU, so the guarantee lives here instead: the match runs in a child
 * process under a wall clock, and a pattern that will not finish is reported as
 * unanswered rather than waited on. The scanner stays as the loud early refusal.
 *
 * @returns {{ answered: boolean, matched?: boolean }}
 */
export function matchUnderDeadline(pattern, text, timeoutMs = PROBE_MATCH_TIMEOUT_MS) {
  // The answer travels on STDOUT, not in the exit code. A child that dies —
  // uncompilable pattern, out of memory, killed — also exits non-zero, and
  // measured by review 2026-08-05 an exit code of 1 meaning "crashed" was read
  // as 1 meaning "matched": an invalid pattern came back `matched: true`.
  const script = 'const t=require("node:fs").readFileSync(0,"utf8");'
    + 'process.stdout.write(new RegExp(process.argv[1],"m").test(t)?"1":"0")';
  // `--` or node eats a pattern that starts with a dash: `node -e … --reset`
  // dies with `bad option: --reset` before the script ever runs.
  const r = spawnSync(process.execPath, ['-e', script, '--', pattern], {
    input: text,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (r.error || r.signal || r.status !== 0) return { answered: false };
  const said = String(r.stdout || '').trim();
  if (said !== '0' && said !== '1') return { answered: false };
  return { answered: true, matched: said === '1' };
}

/**
 * What Windows must be handed to run a Node-ecosystem launcher.
 *
 * `npm` and `npx` are `.cmd` shims there, and the executor takes no shell by
 * design (a shell is what the metacharacter ban exists to keep out). Measured
 * 2026-08-05: an allowlisted npm memory probe answered `cannot run npm
 * here` on every sweep, so the probe was never judged and the report said so —
 * honestly, and uselessly.
 */
export function windowsEntryPoint(bin) {
  if (process.platform !== 'win32') return bin;
  return bin === 'npm' || bin === 'npx' ? `${bin}.cmd` : bin;
}

export function runProbe(probe, exec, match = matchUnderDeadline) {
  try {
    return judgeProbe(probe, exec, match);
  } catch (err) {
    // A probe is one row of a corpus. Whatever it does to itself, the sweep
    // must keep judging the rows behind it — measured 2026-08-05, a command
    // string with a leading space reached `spawnSync('')`, and the TypeError
    // took the whole sweep out from the middle of the corpus.
    return { verdict: 'unknown', detail: `probe threw: ${err && err.message ? err.message : String(err)}` };
  }
}

function judgeProbe(probe, exec, match) {
  const objections = probeObjections(probe);
  if (objections.length) return { verdict: 'refused', detail: objections.join('; ') };
  // The SAME string the validator judged. It trims; splitting the raw one gave
  // `['', 'git', …]` and spawned an empty file name.
  const parts = String(probe.cmd).trim().split(/\s+/);
  const r = exec(parts[0], parts.slice(1));
  if (!r || r.error) return { verdict: 'unknown', detail: `cannot run ${parts[0]} here` };
  if (r.signal) return { verdict: 'unknown', detail: `\`${probe.cmd}\` was killed by ${r.signal} — it never got to answer` };
  // Zero, and nothing else. `status !== 0` alone let `undefined` through, and an
  // exit status nobody recorded is not evidence that the command succeeded.
  if (r.status !== 0) {
    return { verdict: 'unknown', detail: `\`${probe.cmd}\` exited ${r.status}; only a command that succeeded says anything about the lesson` };
  }
  // Truncated before the match: the pattern comes out of the database, and the
  // output is whatever the command felt like printing.
  //
  // A cut changes what a NON-match means. Absence proven over the first 64 KB of
  // a longer output is not absence — measured by review 2026-08-05: a needle
  // placed past the cut turned `--expect-absent` into `keep`, which is the same
  // false "the lesson still holds" the exit code used to produce. A match still
  // decides, because what was found was really there; only a miss becomes unknown.
  const raw = `${r.stdout || ''}${r.stderr || ''}`;
  // BYTES, because that is what the cap says and what a process actually
  // printed: measured by review 2026-08-05, 65538 bytes of `€` are 21846 UTF-16
  // units, so counting characters called a truncated read a complete one.
  const bytes = Buffer.byteLength(raw, 'utf8');
  const out = bytes > PROBE_OUTPUT_MAX
    ? Buffer.from(raw, 'utf8').subarray(0, PROBE_OUTPUT_MAX).toString('utf8')
    : raw;
  const cut = bytes > PROBE_OUTPUT_MAX
    ? `output truncated at ${PROBE_OUTPUT_MAX} bytes of ${bytes}`
    : null;
  const pattern = probe.absent || probe.expect;
  const answer = match(pattern, out);
  if (!answer.answered) {
    return { verdict: 'unknown', detail: `/${pattern}/ did not finish against ${out.length} bytes within ${PROBE_MATCH_TIMEOUT_MS}ms` };
  }
  if (probe.absent) {
    if (answer.matched) {
      return { verdict: 'broken', detail: `expected NOT to find /${probe.absent}/, but it is there now` };
    }
    return cut
      ? { verdict: 'unknown', detail: `${cut}; /${probe.absent}/ is absent from what was read, and absence cannot be proven from a cut` }
      : { verdict: 'keep' };
  }
  if (answer.matched) return { verdict: 'keep' };
  return cut
    ? { verdict: 'unknown', detail: `${cut}; /${probe.expect}/ did not match what was read, and the rest was never seen` }
    : { verdict: 'broken', detail: `expected /${probe.expect}/, output no longer matches` };
}

export function sweep(lessons, world) {
  const rows = [];
  for (const lesson of lessons) {
    const text = `${lesson.title}\n${lesson.body}`;
    const { npm, cli, paths } = extract(text);
    const gone = [];
    const drift = [];
    const unknown = [];
    let keep = 0;
    let declared = null;

    // A declared probe is judged first and on its own terms: when a lesson says
    // what it expects, no heuristic gets a vote on the same lesson.
    if (lesson.probe && world.exec) {
      const r = runProbe(lesson.probe, world.exec);
      declared = { ...r, cmd: lesson.probe.cmd };
      if (r.verdict === 'keep') keep += 1;
    }

    for (const script of npm) {
      if (world.npmScripts.has(script)) keep += 1;
      else gone.push(`npm run ${script}`);
    }
    for (const pair of cli) {
      const [binary, verb] = pair.split(' ');
      const verdict = world.verb(binary, verb);
      if (verdict === 'keep') keep += 1;
      else if (verdict === 'drift') drift.push(pair);
      // 'unknown' — the binary is not installed here. Counted, never silent: a
      // lesson nobody could judge is not a lesson that passed, and a row that
      // vanishes from the report reads as the latter.
      else unknown.push(pair);
    }
    for (const p of paths) {
      if (world.repoFiles.has(p)) keep += 1;
      else drift.push(p);
    }
    if (keep || gone.length || drift.length || unknown.length || declared) {
      rows.push({ id: lesson.id, title: lesson.title, domain: lesson.domain, keep, gone, drift, unknown, declared });
    }
  }
  return rows;
}

if (isMain(import.meta.url)) {
  const lessons = (await readLessons({ dbPath: dbArgument() }))
    .map((r) => {
      let links = {};
      try {
        links = JSON.parse(r.links || '{}');
      } catch {
        /* a lesson with unreadable links still has a body worth sweeping */
      }
      return { ...r, domain: links.domain || '?', status: links.status, probe: links.probe || null };
    })
    .filter((r) => r.status !== 'retired');

  const world = {
    npmScripts: new Set(Object.keys(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts || {})),
    repoFiles: new Set(
      execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64e6, env: scrubbedGitEnv() })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    verb: makeVerbChecker(),
    exec: (bin, args) => spawnSync(windowsEntryPoint(bin), args, {
      encoding: 'utf8', timeout: 30000, windowsHide: true, cwd: REPO, shell: false,
    }),
  };

  const rows = sweep(lessons, world);
  const broken = rows.filter((r) => r.declared && r.declared.verdict === 'broken');
  // A declared probe that was REFUSED or could not run is the same failure as an
  // 'unknown' verb: nobody judged the lesson. Measured 2026-08-05: probe
  // `npm run sweep:probes` answers `cannot run npm here` on Windows (npm is a
  // .cmd and the executor takes no shell) and the report said nothing at all.
  const unrun = rows.filter((r) => r.declared && (r.declared.verdict === 'refused' || r.declared.verdict === 'unknown'));
  const unjudged = rows.reduce((a, r) => a + (r.unknown?.length || 0), 0);
  const gone = rows.filter((r) => r.gone.length);
  const drift = rows.filter((r) => r.drift.length);
  const totals = rows.reduce((a, r) => a + r.keep, 0);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ lessons: lessons.length, probes: totals, gone, drift }, null, 2));
  } else {
    const declaredCount = rows.filter((r) => r.declared).length;
    console.log(
      `swept ${lessons.length} live lessons — ${declaredCount} declare a probe, ` +
        `${totals} probe(s) still answer, ${broken.length} broken, ${gone.length} gone, ` +
        `${drift.length} drifting, ${unjudged} unjudged on this machine\n`,
    );
    if (broken.length) {
      console.log('BROKEN — the lesson declared what it expects, and that is no longer true:');
      for (const r of broken) {
        console.log(`  #${r.id} ${r.declared.cmd}`);
        console.log(`        ${r.declared.detail}`);
        console.log(`        ${r.title.slice(0, 90)}`);
      }
      console.log('');
    }
    if (unrun.length) {
      console.log('UNRUN — the lesson declared a probe that nobody could judge:');
      for (const r of unrun) {
        console.log(`  #${r.id} [${r.declared.verdict}] ${r.declared.cmd}`);
        console.log(`        ${r.declared.detail}`);
      }
      console.log('');
    }
    if (gone.length) {
      console.log('GONE — the lesson names an npm script this repository does not have:');
      for (const r of gone) console.log(`  #${r.id} ${r.gone.join(', ')}\n        ${r.title.slice(0, 90)}`);
      console.log('');
    }
    if (drift.length) {
      console.log('DRIFT — a verb or path that did not answer; ambiguous by nature, read before acting:');
      for (const r of drift.slice(0, 20)) console.log(`  #${r.id} ${r.drift.slice(0, 3).join(', ')}\n        ${r.title.slice(0, 90)}`);
      if (drift.length > 20) console.log(`  … and ${drift.length - 20} more`);
    }
  }
  console.log(
    `\nsweep-probes: keep=${totals} broken=${broken.length} unrun=${unrun.length} gone=${gone.length} drift=${drift.length} unjudged=${unjudged}`,
  );
  // broken and gone fail; drift only warns, for the reason in the header.
  process.exit(broken.length || gone.length ? 1 : 0);
}
