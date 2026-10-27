// Shared pure helpers for domain-lesson scripts (import / capture / promote / sweep / CI).
// Zero deps. Phase 3 contract: links = {domain, anchor, globs[], status: active|inbox}.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { projectConfig } from '../lib/harness-config.mjs';
import { scrubbedGitEnv } from '../git-env.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Render a lesson-service envelope identically for MCP and hook consumers. */
export function renderLessons(raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw || '{}');
  } catch (error) {
    // The CLI exits 1 on this (memoryctl:1057-1063). Returning the malformed
    // body as a SUCCESSFUL tool result was the worse half of the bug: the caller
    // would have read corrupt bytes as lessons and acted on them.
    throw new Error(`invalid lessons JSON from the memory service: ${error.message}`);
  }
  const items = Array.isArray(envelope.items) ? envelope.items : [];
  const domain = envelope.domain || '';
  if (!items.length) {
    // WHICH emptiness, not just emptiness. "no lessons" read identically whether
    // nothing was ever written about this code or plenty was written and none of
    // it is anchored here - and a lead reading it concluded the first while the
    // domain held 145.
    const held = Number(envelope.domain_active || 0);
    const lost = Number(envelope.omitted || 0);
    // THE THIRD emptiness, and the one that used to be silent: rules matched
    // this path and every one of them was too big to send. The JSON said
    // `omitted > 0` the whole time; the marker that carries it was pushed only
    // inside the non-empty branch, so a reader was told "nothing is known" when
    // the truth was "known, did not fit" - exactly the lie the nearby channel
    // was split out to end. Found by the glm seat of round `harness-memory-r2`
    // in BOTH renderers.
    if (lost > 0) {
      return `${lost} lesson(s) match this path and NONE of them fit the delivery `
        + `ceiling, so none are shown - this is "known but did not fit", not `
        + `"nothing is known". Reach them with \`memoryctl search\` and \`memoryctl get <id>\`, `
        + `or split the file so its rules travel apart.\n<!-- omitted: ${lost} -->`;
    }
    if (domain && held > 0) {
      return `no lesson is anchored to this path, and none is near enough to offer; `
        + `domain ${domain} holds ${held} active lesson(s) - ask for a nearer path, `
        + `or anchor what you learn here (path query ok)`;
    }
    return `no lessons${domain ? ` for domain ${domain}` : ''} (path query ok)`;
  }

  const lines = [];
  if (domain) lines.push(`# domain: ${domain}${envelope.inputs_hash ? `  revision=${envelope.inputs_hash}` : ''}`);
  // Said ONCE, above the blocks, because every one of them carries `match: nearby`
  // and a reader should know before the first line what it is looking at.
  const nearby = Number(envelope.nearby || 0);
  if (nearby > 0 && nearby === items.length) {
    lines.push(`# NOTHING is anchored to this path. The ${items.length} lesson(s) below are the`);
    lines.push(`# NEAREST by directory, not about this file - weigh them accordingly.`);
  } else if (nearby > 0) {
    // Mixed: a glob matched this path, so something IS delivered about it - but
    // it is a rule about a CLASS, and it does not make the neighbours below any
    // more about this file. Claiming "nothing is anchored" here would be false,
    // and counting every item as nearby would be false too.
    lines.push(`# No lesson NAMES this path - what matched it is a rule about a CLASS of files.`);
    lines.push(`# The last ${nearby} lesson(s), marked \`match: nearby\`, are the NEAREST by`);
    lines.push(`# directory - not about this file.`);
  }
  for (const item of items) {
    lines.push(`## ${item.title || 'untitled'}`);
    for (const field of ['anchor', 'trigger', 'rule', 'why', 'evidence', 'date', 'match']) {
      if (item[field]) lines.push(`- ${field}: ${item[field]}`);
    }
    lines.push('');
  }
  if (Number(envelope.omitted) > 0) lines.push(`<!-- omitted: ${envelope.omitted} -->`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** Direct SQLite is maintenance-only: callers must supply an explicit --db. */
export function requireDbPath(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath.trim() || dbPath.startsWith('--')) {
    throw new Error('REFUSED: direct SQLite access requires explicit --db <path>. '
      + 'Mac launchd memoryd owns live memory; client scripts must not open its database implicitly. '
      + 'Atomic lesson import API is not available.');
  }
  return dbPath;
}

/**
 * The repo-relative file an anchor names, without its `:symbol` suffix.
 * An anchor with no path at all (glob-only lesson, bare word) returns null.
 * `path/to/file.ts:symbolName` — strip the symbol, keep a Windows drive letter
 * out of the question by only cutting at a colon that is not the second char.
 * Shared by the anchor tooling (promote, reanchor, duplicates).
 * @param {string} anchor
 * @returns {string|null}
 */
export function anchorFile(anchor) {
  const raw = String(anchor || '').trim();
  if (!raw) return null;
  const cut = raw.indexOf(':', 2);
  const file = cut === -1 ? raw : raw.slice(0, cut);
  return file.includes('/') || file.includes('.') ? file : null;
}

// The one skill tree, per ops/bootstrap/install-harness.mjs. Every runtime is junctioned at
// it. <repo>/.claude/skills was the rival copy and was removed on 2026-07-25; each script
// that spelled the path itself kept a private copy of the answer and went on reading the
// deleted tree long after the import path was fixed, so the spelling lives here alone.
export const SKILLS_DIR = '.agents/skills';
export const SKILLS_ROOT = path.join(REPO_ROOT, ...SKILLS_DIR.split('/'));
// Domain routing digests: build input for gen-domain-routing.mjs, not delivered as skills.
export const DOMAINS_DIR = '.agents/domains';
export const DOMAINS_ROOT = path.join(REPO_ROOT, ...DOMAINS_DIR.split('/'));

export const SESSION_IMPORT = 'lessons-import';
export const AGENT_IMPORT = 'importer';
export const SWEEP_REPORT_KEY = 'anchor-sweep-latest';
// There is no per-DOMAIN count guard, and removing it on 2026-08-11 was the
// point rather than a concession.
//
// It survived two moves of its own basis. Delivery became per-FILE on
// 2026-07-30, so a domain stopped entering any context whole; the guard was kept
// anyway "to catch a domain quietly filling with near-duplicates", and was
// raised 60 -> 65 on 2026-08-03 when it fired on growth that was legitimate.
// Then delivery stopped shipping the domain's other titles at all (see the
// `title-index` note in store.mjs `lessons`), and what a domain TOTALS became
// unobservable from any agent's context.
//
// What it cost while it stood: 77 captured lessons could not be promoted because
// promotion would push an active count past a number measuring nothing anyone
// reads (task 367). It refused new knowledge to protect a budget that no
// delivery spends. The axis worth guarding is what ONE file's delivery costs,
// and LESSON_PAYLOAD_BUDGET_PER_FILE below already guards exactly that -
// including the near-duplicate case, since near-duplicates about one file share
// its anchor and add up under that budget.

// What one delivery may cost, measured on the only thing a gate can read without
// the service: the sum of active lesson BODIES that `lessonMatchesPath` would
// deliver to a single file — the anchor path, the basename route, and every
// entry in `globs` (scripts/check-domain-routing.mjs does the counting; two
// lessons under DIFFERENT anchors that delivery converges onto one path add up
// there, which is exactly the near-duplicate case this constant exists to catch).
//
// RE-EXPORTED, not redeclared. The service enforces this ceiling on the wire
// (`LESSONS_MAX_BYTES` in store.mjs) and this sensor warns before a file reaches
// it; they are two executors of one rule, and on 2026-08-21 they disagreed for
// half an hour because the sensor was raised and the service was not — the WARN
// went quiet while delivery kept dropping the last lesson of the very file the
// WARN had been about. One of them has to read the other, and the service is the
// one that decides.
//
// The two count slightly different things — bodies here, the JSON envelope
// there — and that asymmetry is deliberate: a sensor may not depend on a running
// service, so it approximates with what SQLite can hand it. The approximation is
// close (an item carries the body's own fields) and errs toward warning early.
export { LESSONS_MAX_BYTES as LESSON_PAYLOAD_BUDGET_PER_FILE } from './store.mjs';

/** Exact schema v1 column set (mirrors memory-import.mjs / chunk A). */
export const EXPECTED_MEM_ENTRIES_COLUMNS = Object.freeze([
  'id', 'uuid', 'ts', 'session_id', 'agent', 'kind', 'key', 'title', 'body',
  'links', 'sha_refs', 'pinned', 'content_hash', 'source_path', 'supersedes',
  'superseded_by', 'version',
  // v4: which declaration a handoff made at session end ('none' | 'tails'),
  // NULL for everything written before the gate existed. Readers must list it
  // here or the strict probe rejects a database the service itself wrote -
  // `npm run tracks` died exactly that way when the column landed.
  'handoff_declaration',
]);

// ---------------------------------------------------------------------------
// Hash / anchors / links
// ---------------------------------------------------------------------------

/** @param {string|Buffer} value */
export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * True if anchor is a file-glob hint.
 * Lone `?` is a placeholder ("not yet anchored"), NOT a glob — old sweep
 * auto-kept it via /[*?]/ which hid real rot. Glob requires `*` or a `?`
 * inside a longer path pattern (e.g. `src/?.ts`).
 */
export function isGlobAnchor(anchor) {
  if (typeof anchor !== 'string' || !anchor) return false;
  if (anchor.includes('*')) return true;
  if (anchor === '?') return false;
  return anchor.includes('?');
}

/**
 * Build links object for kind=lesson (Phase 3 PINNED schema).
 * @param {{ domain: string, anchor?: string|null, status: 'active'|'inbox', trigger?: string|null, globs?: string[] }} p
 */
export function buildLessonLinks(p) {
  const anchor = (p.anchor ?? '').trim();
  let globs = Array.isArray(p.globs) ? [...p.globs] : [];
  if (anchor && isGlobAnchor(anchor) && !globs.includes(anchor)) {
    globs = [anchor, ...globs.filter((g) => g !== anchor)];
  }
  /** @type {Record<string, unknown>} */
  const links = {
    domain: p.domain,
    anchor: anchor || '',
    globs,
    status: p.status === 'inbox' ? 'inbox' : 'active',
  };
  if (p.trigger) links.trigger = p.trigger;
  if (p.probe) links.probe = p.probe;
  return links;
}

/**
 * A probe is memory that will later be EXECUTED, so what may be recorded is
 * narrower than what may be written.
 *
 * What this actually guarantees — stated as narrowly as the code enforces it,
 * and rewritten four times because each earlier version promised more than it
 * delivered (four independent review rounds, 2026-08-05):
 *   - a binary from PROBE_READ_VERBS, whose SECOND token is a verb from that
 *     binary's read list, whose FLAGS are all in PROBE_ALLOWED_FLAGS. A prefix
 *     admits the whole tool (`rtk <cmd>` runs <cmd>, `memoryctl append` writes)
 *     and a verb admits the whole flag surface (`git log --output=<path>` writes
 *     a file, `--ext-diff` runs a program). Both were measured, not imagined;
 *   - a binary with no read-only form at all is not here: `svod status` needs
 *     `--state`, which persists, and refreshes an index even when it only reads;
 *   - repository entry points BY NAME: PROBE_NODE_SCRIPTS and PROBE_NPM_SCRIPTS.
 *     A family (`check-*`) or a namespace (`check:*`) is what a script is called,
 *     not what it does — `check-portability.mjs --write-baseline` rewrites a
 *     tracked baseline and `sweep-anchors.mjs` writes the memory registry;
 *   - one command: no shell metacharacters and no control characters. Without the
 *     first, `--probe "rtk gain; rm -rf x"` deletes a tree the day somebody
 *     sweeps; without the second, a NUL made the executor throw mid-corpus;
 *   - exactly ONE expectation, a string, ≤200 characters, without the shapes that
 *     backtrack exponentially.
 *
 * What it does NOT guarantee — and what covers that instead: nothing here proves
 * a regexp is safe, because that is a heuristic and it has been wrong twice. The
 * match runs under a wall clock in a child process (`matchUnderDeadline`), so a
 * pattern this scanner lets through costs one `unknown`, not a wedged sweep.
 */
export const PROBE_READ_VERBS = Object.freeze({
  git: ['diff', 'log', 'show', 'status', 'rev-parse', 'ls-files'],
  rtk: ['gain', 'discover'],
  memoryctl: ['hot', 'search', 'get', 'lessons'],
  // codegraph replaced probe 2026-09-19 (#9838). These five verbs READ the
  // graph; `init` builds an index and `serve` runs a server, so neither is here.
  codegraph: ['callers', 'callees', 'impact', 'node', 'explore'],
  // No `svod`. Measured by review 2026-08-05: `svod status` requires --audit AND
  // --state, --state persists the projection to whatever path it is given (847
  // bytes written, parent directories created), and even the read refreshes
  // `.git/svod/index.db`. A binary whose only working invocation writes has no
  // read-only form to allow.
});

/**
 * The verb is not the whole command: a READING git verb still writes and still
 * executes when handed the right flag. Measured by review 2026-08-05 against
 * the first fix, which judged only the verb — `git log -1 --output=<path>` was
 * accepted and wrote 191 bytes to disk, `git show --output=` wrote 16785, and
 * `--textconv` / `--ext-diff` run a program named by git's own config. The
 * verdict was `keep`, because the write does not depend on the verdict.
 *
 * So flags are a closed allowlist too, matched on the part before `=`. Anything
 * not listed is refused rather than reasoned about — a probe is a short command,
 * and the cost of refusing a rare-but-safe flag is one loud refusal in the sweep
 * report, while the cost of admitting an unknown one is what this comment is about.
 * Operands (refs, paths, patterns) are free: only tokens starting with `-` are judged.
 */
const PROBE_UNIVERSAL_FLAGS = ['--help', '-h', '--version', '--json', '--'];
export const PROBE_ALLOWED_FLAGS = Object.freeze({
  git: [
    '-n', '--max-count', '--skip', '--stat', '--numstat', '--shortstat', '--summary',
    '--name-only', '--name-status', '--oneline', '--format', '--pretty', '--abbrev-commit',
    '--no-color', '--color', '--porcelain', '--short', '--branch', '--untracked-files',
    '--cached', '--staged', '--unified', '-U', '-u', '-s', '--reverse', '--follow',
    '--author', '--since', '--until', '--grep', '--all', '--decorate', '--no-patch',
    '--word-diff', '--find-renames', '--no-renames', '--verify', '--abbrev-ref', '--show-toplevel',
  ],
  rtk: ['--quota', '-q'],
  memoryctl: ['--path', '--kind', '--limit', '--budget-kb', '--id', '--domain'],
  codegraph: ['--limit', '--depth'],
  npm: ['--silent'],
  // NOT `-p`/`--project`: measured by review 2026-08-05, TypeScript 5.9.3 writes
  // `.tsbuildinfo` under `--noEmit` whenever the named tsconfig sets
  // `incremental: true` — and three of this repo's do — so pointing tsc at a
  // project is a write, on a failing compile too. Bare `npx tsc --noEmit` reads.
  npx: ['--noEmit', '--pretty'],
});
/**
 * Repository entry points a probe may run, BY NAME.
 *
 * A family of names is not an audit. Measured by review 2026-08-05, the
 * `test-`/`check-`/`sweep-` rule admitted `check-portability.mjs --write-baseline`
 * (rewrites a tracked baseline), `sweep-anchors.mjs` (calls
 * `memoryctl registry-update`) and `test-deepseek-classifier.mjs` (network) —
 * the prefixes describe what a script is called, not what it does. So each entry
 * is listed and was checked by running it: `git status` is byte-identical
 * afterwards and the memory database has the same row count. What they MAY do is
 * write inside the OS temp directory — memory probes build throwaway SQLite
 * files there, and that is the boundary this list draws, not "no syscalls".
 * Adding an entry is a reviewed change to this file, which is the point.
 */
export const PROBE_NODE_SCRIPTS = Object.freeze([
  'scripts/memory/test-sweep-probes.mjs',
  'scripts/test-rtk-gain-split.mjs',
  'scripts/rtk-gain-split.mjs',
]);
export const PROBE_NPM_SCRIPTS = Object.freeze([
  'check:harness-audit',
  'rtk:split',
]);
/** Human-facing summary of the above; used in the refusal message. */
export const PROBE_ALLOWED = Object.freeze([
  `npm run <${PROBE_NPM_SCRIPTS.join('|')}>`, `node <${PROBE_NODE_SCRIPTS.join('|')}>`,
  'rtk gain|discover', 'memoryctl hot|search|get|lessons', 'codegraph callers|callees|impact|node|explore',
  'git diff|log|show|status|rev-parse|ls-files', 'npx tsc --noEmit',
]);
const PROBE_METACHARS = /[;&|><`$\n\r]|\$\(/;

const PROBE_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PROBE_HELP_FLAGS = new Set(['--help', '-h', '--version']);
export const PROBE_PATTERN_MAX = 200;
export const PROBE_PATTERN_MAX_QUANTIFIERS = 12;

/**
 * Scan a regexp source for the shapes that make backtracking exponential:
 * a quantifier on a group that itself quantifies (`(a+)+`), a quantifier on a
 * group that alternates (`(a|aa)+`), and — the one the first fix missed — a long
 * chain of OPTIONAL atoms, `a?a?a?…aaa…`, which contains no `*`, `+` or `{` at
 * all. Measured by review 2026-08-05: at 38 optional atoms, well inside the
 * 200-character limit, the match took 738 ms and roughly doubled every two
 * atoms. What refuses that shape is the COUNT, so `?` has to be counted.
 *
 * `?` counts only where it quantifies: `(?:`, `(?=`, `(?!`, `(?<` open a group,
 * and a `?` after another quantifier is laziness. Character classes and escapes
 * are skipped so `\+` and `[+*]` stay literals.
 * @param {string} src
 * @returns {{ quantifiers: number, catastrophic: boolean }}
 */
/**
 * Can a quantified alternation match the same text two ways?
 *
 * `(a|aa)+` can, and that is the exponential case. `(?:foo|bar)+` cannot, and
 * neither can `(?:[ab]|cd)+` — measured by review 2026-08-05, an earlier version
 * refused every branch that was not a plain literal, which answers a different
 * question than the one that matters and cost real lessons their probe.
 *
 * The question that matters: could one branch match a PREFIX of what another
 * matches? Compare them atom by atom over the character sets each atom really
 * has (`charsOf`); if every position up to the shorter branch's length can hold
 * one and the same character, the two overlap. A branch this cannot parse into
 * single-character atoms — a nested group, a quantifier, an unescaped `.` —
 * stays refused, because the deadline, not this rule, is the safety net.
 * @param {string} body the group's source, without its parentheses or opener
 */
export function ambiguousAlternation(body) {
  const branches = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\') { current += body.slice(i, i + 2); i += 1; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === '|' && depth === 0) { branches.push(current); current = ''; continue; }
    current += ch;
  }
  branches.push(current);

  const parsed = [];
  for (const branch of branches) {
    const { atoms, nested } = atomsOf(branch);
    if (nested || !atoms.length || atoms.some((a) => a.quantified)) return true;
    const sets = atoms.map((a) => charsOf(a.src));
    // An unescaped `.` is every character; `charsOf` says so, and that alone
    // makes `(?:.a|ba)+` overlap however its branches read.
    if (sets.some((set) => set === null)) return true;
    parsed.push(sets);
  }
  for (let i = 0; i < parsed.length; i += 1) {
    for (let j = i + 1; j < parsed.length; j += 1) {
      const shorter = Math.min(parsed[i].length, parsed[j].length);
      let sharesEveryPosition = true;
      for (let k = 0; k < shorter; k += 1) {
        const overlap = [...parsed[i][k]].some((ch) => parsed[j][k].has(ch));
        if (!overlap) { sharesEveryPosition = false; break; }
      }
      if (sharesEveryPosition) return true;
    }
  }
  return false;
}

/**
 * Every character an atom can match, over the whole ASCII range.
 *
 * Reading a regexp atom by eye is what let `` be filed as the letter `f` and
 * `.` as a full stop (both measured by review 2026-08-05). Compiling the atom
 * and asking it is exact for the single-character atoms this rule is about, and
 * an atom that matches nothing here answers `null` — undecidable, never "safe".
 * @returns {Set<string>|null}
 */
function atomsOf(body) {
  const atoms = [];
  let nested = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    let src;
    if (ch === '\\') { src = body.slice(i, i + 2); i += 1; } else if (ch === '[') {
      const start = i;
      i += 1;
      while (i < body.length && body[i] !== ']') {
        if (body[i] === '\\') i += 1;
        i += 1;
      }
      src = body.slice(start, i + 1);
    } else if (ch === '(' || ch === ')') {
      nested = true;
      continue;
    } else if (ch === '^' || ch === '$' || ch === '|') {
      continue;
    } else {
      src = ch;
    }
    let quantified = false;
    const next = body[i + 1];
    if (next === '*' || next === '+' || next === '?') { quantified = true; i += 1; } else if (next === '{') {
      quantified = true;
      while (i + 1 < body.length && body[i + 1] !== '}') i += 1;
      i += 1;
    }
    atoms.push({ src, quantified });
  }
  return { atoms, nested };
}

function charsOf(atomSrc) {
  let re;
  try {
    re = new RegExp(`^(?:${atomSrc})$`, 's');
  } catch {
    return null;
  }
  const set = new Set();
  for (let code = 0; code < 128; code += 1) {
    const ch = String.fromCharCode(code);
    if (re.test(ch)) set.add(ch);
  }
  return set.size ? set : null;
}

/**
 * Is a quantified group ambiguous about WHERE one repetition ends?
 *
 * `(a+)+` is: the inner `+` and the outer `+` split the same run of `a`s in
 * exponentially many ways. `(?:\d+\.){3}\d+` is not: every repetition must
 * consume a `.`, and `\d` cannot eat one, so the split is forced. The same
 * holds wherever that separator sits — `(\w+-\w+)+`, `([A-Z][a-z]+)+`,
 * `(\d+:\d+)+` were all refused by an earlier version that only looked at the
 * ends, and each cost a lesson its probe (measured by review 2026-08-05).
 *
 * So: a group is unambiguous when it contains at least one MANDATORY atom whose
 * character set is disjoint from every repeating atom in the same group. Nested
 * groups, and anything `charsOf` cannot decide, stay refused — the deadline in
 * `matchUnderDeadline` is what makes a wrong guess cost one `unknown` instead of
 * a wedged sweep, and this rule is only the early, loud refusal.
 * @param {string} body the group's source, without its parentheses or opener
 */
export function ambiguousRepetition(body) {
  const { atoms, nested } = atomsOf(body);
  if (nested || atoms.length < 2) return true;
  const repeating = atoms.filter((a) => a.quantified).map((a) => charsOf(a.src));
  if (!repeating.length) return false;
  if (repeating.some((set) => set === null)) return true;
  for (const atom of atoms) {
    if (atom.quantified) continue;
    const set = charsOf(atom.src);
    if (!set) continue;
    const eaten = repeating.some((other) => [...set].some((ch) => other.has(ch)));
    if (!eaten) return false;
  }
  return true;
}

export function probePatternRisk(src) {
  const stack = [];
  const QUANTIFIER_HEADS = new Set(['*', '+', '{', '?']);
  let quantifiers = 0;
  let catastrophic = false;
  let previous = '';
  // Quantified atoms standing next to each other — `a*a*a*b` — are the third
  // exponential shape, and the one no nesting rule sees: measured 2026-08-05,
  // four of them did not finish on 2000 characters while the scanner scored
  // them 4 quantifiers, no nesting. A run of three is refused; `\d+ foo \w+`,
  // where real text separates the quantifiers, is not a run.
  const FAR = 99;
  let atomsSinceQuantifier = FAR;
  let adjacentRun = 0;
  const countQuantifier = () => {
    quantifiers += 1;
    // Exactly one atom between two quantifiers means they stand next to each
    // other: `a*a*`, `(ab)*(cd)*`. Anything longer is separated by real text.
    adjacentRun = atomsSinceQuantifier <= 1 ? adjacentRun + 1 : 1;
    if (adjacentRun >= 3) catastrophic = true;
    atomsSinceQuantifier = 0;
    if (stack.length) stack[stack.length - 1].quantifier = true;
    previous = 'quantifier';
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') { i += 1; previous = 'atom'; atomsSinceQuantifier += 1; continue; }
    if (ch === '[') {
      i += 1;
      while (i < src.length && src[i] !== ']') {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      previous = 'atom';
      atomsSinceQuantifier += 1;
      continue;
    }
    if (ch === '(') {
      // `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>` — the opener is not part
      // of the body, and reading it as one made `(?:foo|bar)+` look ambiguous.
      let body = i + 1;
      if (src[body] === '?') {
        body += 1;
        if (src[body] === ':' || src[body] === '=' || src[body] === '!') body += 1;
        else if (src[body] === '<') {
          body += 1;
          if (src[body] === '=' || src[body] === '!') body += 1;
          else {
            while (body < src.length && src[body] !== '>') body += 1;
            body += 1;
          }
        }
      }
      // A group is ONE atom to the adjacency rule, whatever it contains.
      stack.push({
        quantifier: false, alternation: false, atomsBefore: atomsSinceQuantifier, start: body,
      });
      i = body - 1;
      previous = 'open';
      continue;
    }
    if (ch === '|') {
      if (stack.length) stack[stack.length - 1].alternation = true;
      previous = 'open';
      continue;
    }
    if (ch === ')') {
      const group = stack.pop() || {
        quantifier: false, alternation: false, atomsBefore: FAR, start: -1,
      };
      const next = src[i + 1];
      const quantified = QUANTIFIER_HEADS.has(next);
      // Blowup needs the OUTER repetition to be open-ended. `(\d+){2}` runs
      // twice whatever it contains; `{2,}` and `*`/`+`/`?` do not stop.
      const unbounded = next !== '{' || !/^\{\d+(,\d+)?\}/.test(src.slice(i + 1));
      const body = src.slice(group.start, i);
      const dangerous = group.alternation
        ? ambiguousAlternation(body)
        : group.quantifier && ambiguousRepetition(body);
      if (quantified && unbounded && dangerous) catastrophic = true;
      atomsSinceQuantifier = group.atomsBefore + 1;
      previous = 'atom';
      continue;
    }
    if (ch === '?') {
      // Laziness (`a+?`, `a??`, `a{2,3}?`) modifies the quantifier before it;
      // it does not add one.
      if (previous === 'quantifier') previous = 'atom';
      else countQuantifier();
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '{') {
      countQuantifier();
      continue;
    }
    previous = 'atom';
    atomsSinceQuantifier += 1;
  }
  return { quantifiers, catastrophic };
}

/** `node <file>` — the file must be one of the audited entry points, by path. */
function nodeProbeObjection(args) {
  const file = args[0];
  if (!file) return `--probe: \`node\` needs one of ${PROBE_NODE_SCRIPTS.join(', ')}`;
  if (file.startsWith('-')) return `--probe: node ${file} is a flag, not a file — \`node -e\` is arbitrary code`;
  const resolved = path.resolve(REPO_ROOT, file);
  const named = PROBE_NODE_SCRIPTS.map((entry) => path.resolve(REPO_ROOT, entry));
  if (!named.includes(resolved)) {
    return `--probe: node ${file} is not an audited probe entry point (${PROBE_NODE_SCRIPTS.join(', ')})`;
  }
  // An audited script says nothing about an argument nobody audited:
  // `check-portability.mjs --write-baseline` is the same file doing the opposite.
  const extra = args.slice(1).filter((token) => token !== '--json');
  if (extra.length) return `--probe: node ${file} may take only --json, got ${extra.join(' ')}`;
  return null;
}

/** The first flag of `args` this binary does not allow, or null. */
function flagObjection(binary, args) {
  const allowed = new Set([...PROBE_UNIVERSAL_FLAGS, ...(PROBE_ALLOWED_FLAGS[binary] || [])]);
  for (const token of args) {
    if (!token.startsWith('-')) continue;
    // `-1`, `-5` — git's count shorthand. A digit cannot name a program or a path.
    if (/^-\d+$/.test(token)) continue;
    // `-U0` is `-U` with its value written joined, which is how git's own
    // documentation spells it; the flag is still `-U`.
    const joined = /^-[A-Za-z]\d+$/.test(token) ? token.slice(0, 2) : token;
    const name = joined.split('=')[0];
    if (!allowed.has(name)) {
      return `--probe: \`${binary}\` may not be handed ${name} — a probe takes only read-only flags (${[...allowed].join(' ')})`;
    }
  }
  return null;
}

/**
 * @param {string} cmd already trimmed and free of shell metacharacters
 * @returns {string|null} the reason it may not run, or null
 */
function probeCmdObjection(cmd) {
  const [head, ...args] = cmd.split(/\s+/);
  if (head === 'node') return nodeProbeObjection(args);
  if (head === 'npm') {
    if (args[0] !== 'run' || !args[1]) return '--probe: the only npm entry point is `npm run <script>`';
    if (!PROBE_NPM_SCRIPTS.includes(args[1])) {
      return `--probe: npm run ${args[1]} is not an audited probe entry point (${PROBE_NPM_SCRIPTS.join(', ')})`;
    }
    return flagObjection('npm', args.slice(2));
  }
  if (head === 'npx') {
    if (args[0] !== 'tsc') return '--probe: the only npx entry point is `npx tsc --noEmit`';
    if (!args.includes('--noEmit')) return '--probe: `npx tsc` must carry --noEmit, or it writes files';
    return flagObjection('npx', args.slice(1));
  }
  const verbs = PROBE_READ_VERBS[head];
  if (!verbs) return `--probe must start with one of: ${PROBE_ALLOWED.join(', ')}`;
  const verb = args[0];
  if (!verb) return `--probe: \`${head}\` needs a read-only verb (${verbs.join(', ')})`;
  if (PROBE_HELP_FLAGS.has(verb)) return null;
  if (!verbs.includes(verb)) {
    return `--probe: \`${head} ${verb}\` is not one of ${head}'s read-only verbs (${verbs.join(', ')})`;
  }
  return flagObjection(head, args.slice(1));
}

/**
 * @param {{ cmd?: string, expect?: string, absent?: string }} probe
 * @returns {string[]} reasons it may not be recorded; empty means acceptable
 */
export function probeObjections(probe) {
  const bad = [];
  // Typed before anything is read off them. `new RegExp({})` compiles happily to
  // /[object Object]/ and would judge a lesson by it, and an array `cmd` becomes
  // a comma-joined string that resembles a command — measured by review 2026-08-05.
  for (const [field, value] of [['--probe', probe?.cmd], ['--expect', probe?.expect], ['--expect-absent', probe?.absent]]) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      bad.push(`${field} must be a string, got ${Array.isArray(value) ? 'an array' : typeof value}`);
      continue;
    }
    // A control character is not a pattern and not a command. NUL in particular
    // makes `spawnSync` throw where nobody was catching — measured by review
    // 2026-08-05, one such row killed the sweep mid-corpus and printed no report.
    if (typeof value === 'string' && PROBE_CONTROL_CHARS.test(value)) {
      bad.push(`${field} contains a control character`);
    }
  }
  if (bad.length) return bad;
  const cmd = String(probe?.cmd || '').trim();
  if (!cmd) bad.push('--probe is empty');
  const meta = PROBE_METACHARS.test(cmd);
  if (meta) bad.push('--probe may not contain ; & | > < ` $ or a newline');
  // Judged only once the string is known to be one command: a metacharacter
  // would make the token split meaningless.
  if (cmd && !meta) {
    const objection = probeCmdObjection(cmd);
    if (objection) bad.push(objection);
  }
  const expect = probe?.expect;
  const absent = probe?.absent;
  if (!expect && !absent) bad.push('--probe needs --expect or --expect-absent: a command with no expectation checks nothing');
  // Exactly one of them. Measured by review 2026-08-05: both were accepted and
  // the executor judged by `absent` alone, so an output that satisfied NEITHER
  // came back `keep` — a lesson confirmed by the expectation nobody checked.
  if (expect && absent) bad.push('--probe takes --expect or --expect-absent, not both: only one of them would be judged');
  for (const [flag, re] of [['--expect', expect], ['--expect-absent', absent]]) {
    if (!re) continue;
    if (re.length > PROBE_PATTERN_MAX) {
      bad.push(`${flag} is longer than ${PROBE_PATTERN_MAX} characters`);
      continue;
    }
    try {
      new RegExp(re);
    } catch (err) {
      bad.push(`${flag} is not a valid regexp: ${err.message}`);
      continue;
    }
    const risk = probePatternRisk(re);
    if (risk.catastrophic) {
      bad.push(`${flag} puts a quantifier on a group that already quantifies or alternates — that backtracks exponentially; write it flat`);
    } else if (risk.quantifiers > PROBE_PATTERN_MAX_QUANTIFIERS) {
      bad.push(`${flag} has ${risk.quantifiers} quantifiers, more than ${PROBE_PATTERN_MAX_QUANTIFIERS}: too much to run against process output`);
    }
  }
  return bad;
}

/**
 * Dedup key for promote: {domain, anchor, title} (normalized).
 * Same key → update-evidence, never a second active copy.
 * @param {{ domain?: string, anchor?: string, title?: string }} p
 */
export function lessonDedupKey(p) {
  return [
    String(p.domain || '').trim().toLowerCase(),
    String(p.anchor || '').trim(),
    String(p.title || '').trim().toLowerCase(),
  ].join('\0');
}

/**
 * Parse `- field: value` lines from a lesson block body.
 * @param {string} block
 * @param {string} field
 */
export function fieldOf(block, field) {
  const re = new RegExp(`^\\s*-\\s*${field}:\\s*(.+)$`, 'mi');
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

export function titleOfBlock(block) {
  const m = String(block).match(/^##\s+(.+)$/m);
  return m ? m[1].replace(/\s+$/, '').trim() : null;
}

export function anchorOfBlock(block) {
  return fieldOf(block, 'anchor');
}

export function triggerOfBlock(block) {
  return fieldOf(block, 'trigger');
}

// ---------------------------------------------------------------------------
// Block parser (byte-preserving ## split)
// ---------------------------------------------------------------------------

/**
 * Split markdown into preamble + ## sections.
 * Join of preamble + sections[].body === original text (byte-equal for UTF-8).
 * @param {string} text
 * @returns {{ preamble: string, sections: { index: number, title: string, body: string }[] }}
 */
export function splitLessonFile(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (text.length === 0) return { preamble: '', sections: [] };

  const re = /(^|\n)(## )/g;
  /** @type {number[]} */
  const starts = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const markerAt = m.index + m[1].length;
    // Guard: '## ' must not be '### '
    if (text.startsWith('###', markerAt)) continue;
    starts.push(markerAt);
  }

  if (starts.length === 0) {
    return { preamble: text, sections: [] };
  }

  const preamble = starts[0] > 0 ? text.slice(0, starts[0]) : '';
  /** @type {{ index: number, title: string, body: string }[]} */
  const sections = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : text.length;
    const body = text.slice(start, end);
    const title = titleOfBlock(body) || `section-${i}`;
    sections.push({ index: i, title, body });
  }

  const reconstructed = preamble + sections.map((s) => s.body).join('');
  if (reconstructed !== text) {
    throw new Error('splitLessonFile: concatenation does not reconstruct source (internal bug)');
  }
  return { preamble, sections };
}

// ---------------------------------------------------------------------------
// Glob match (doublestar; SSOT lives in the standalone memory store)
// ---------------------------------------------------------------------------

// ONE glob engine SSOT: endpoint, scripts and CI must match paths identically.
export { matchGlob } from './store.mjs';
import { matchGlob } from './store.mjs';

/**
 * Return true if any candidate path matches the glob.
 * @param {string} glob
 * @param {string[]} paths
 */
export function globResolves(glob, paths) {
  for (const p of paths) {
    if (matchGlob(glob, p)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Anchor classification
// ---------------------------------------------------------------------------

/**
 * Classify one anchor against live code.
 * - missing file → gone
 * - file:symbol → keep if symbol text present, else drift
 * - file:N → keep if file has ≥ N lines, else drift
 * - glob (*|?) → keep if ≥1 path matches, else gone
 * - file-only → keep if file exists
 *
 * @param {string} anchor
 * @param {(file: string) => string|null} reader  returns file text or null if missing
 * @param {{ repoPaths?: string[] }} [opts]  required for glob resolution
 * @returns {'keep'|'drift'|'gone'}
 */
export function classifyAnchor(anchor, reader, opts = {}) {
  const a = String(anchor || '').trim();
  // Empty or placeholder "?" → drift (needs re-anchor), not gone (file missing).
  // Gone is reserved for a concrete path that no longer exists on disk.
  if (!a || a === '?') return 'drift';

  const i = a.indexOf(':');
  const file = i === -1 ? a : a.slice(0, i);
  const ref = i === -1 ? '' : a.slice(i + 1);
  if (isGlobAnchor(file)) {
    const paths = opts.repoPaths;
    if (!Array.isArray(paths) || paths.length === 0) {
      // Without a path list we cannot prove resolution → gone (not old auto-keep)
      return 'gone';
    }
    return globResolves(file, paths) ? 'keep' : 'gone';
  }

  const text = reader(file);
  if (text == null) return 'gone';
  if (!ref) return 'keep';
  if (/^\d+$/.test(ref)) return text.split('\n').length >= Number(ref) ? 'keep' : 'drift';
  return text.includes(ref) ? 'keep' : 'drift';
}

// ---------------------------------------------------------------------------
// SQLite helpers (direct DB — same pattern as memory-import.mjs)
// ---------------------------------------------------------------------------

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [dbPath]
 */
export function validateMemEntriesSchema(db, dbPath = 'memory.db') {
  let cols;
  try {
    const table = db
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'mem_entries' LIMIT 1`,
      )
      .get();
    if (!table) {
      throw new Error(
        `SchemaError: mem_entries table is MISSING from ${dbPath} — start the memory service once so the schema exists. Aborting.`,
      );
    }
    cols = db.prepare('PRAGMA table_info(mem_entries)').all().map((r) => r.name);
  } catch (err) {
    if (String(err?.message || err).startsWith('SchemaError:')) throw err;
    throw new Error(`SchemaError: schema probe failed on ${dbPath}: ${err?.message || err}`);
  }
  const colSet = new Set(cols);
  const missing = EXPECTED_MEM_ENTRIES_COLUMNS.filter((c) => !colSet.has(c));
  const extra = cols.filter((c) => !EXPECTED_MEM_ENTRIES_COLUMNS.includes(c));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`missing columns: ${missing.join(', ')}`);
    if (extra.length) parts.push(`unexpected columns: ${extra.join(', ')}`);
    throw new Error(
      `SchemaError: mem_entries schema mismatch — ${parts.join('; ')}. Aborting.`,
    );
  }
}

/**
 * @param {string} dbPath
 */
export function openExistingMemoryDb(dbPath, { readOnly = false } = {}) {
  const resolved = path.resolve(requireDbPath(dbPath));
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `memory.db not found: ${resolved}\n` +
        'Start the memory service once so store.mjs migrations create the schema, then re-run.',
    );
  }
  const db = new DatabaseSync(resolved, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    validateMemEntriesSchema(db, resolved);
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Parse links JSON from a row; tolerate {} or [] defaults.
 * @param {string|null|undefined} raw
 */
export function parseLinks(raw) {
  if (raw == null || raw === '' || raw === '[]' || raw === '{}') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * List live (not superseded) lesson rows from DB.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ status?: 'active'|'inbox'|null, domain?: string|null }} [filter]
 */
export function listLiveLessons(db, filter = {}) {
  const rows = db
    .prepare(
      `SELECT id, uuid, ts, session_id, agent, kind, key, title, body, links,
              content_hash, source_path, version, superseded_by
       FROM mem_entries
       WHERE kind = 'lesson' AND superseded_by IS NULL
       ORDER BY id ASC`,
    )
    .all();

  return filterLessons(rows, filter);
}

export function filterLessons(rows, filter = {}) {
  /** @type {Array<Record<string, unknown> & { linksObj: Record<string, unknown>, status: string }>} */
  const out = [];
  for (const row of rows) {
    const linksObj = parseLinks(row.links);
    // Three states, read as written. This used to fold everything that was not
    // `inbox` into `active`, so a lesson retired in its status still counted as
    // knowledge in force: the budget check reported 57 active for a domain the
    // store said had 38, and the difference was exactly the retired rows.
    const raw = String(linksObj.status || '');
    const status = raw === 'inbox' || raw === 'retired' ? raw : 'active';
    if (filter.status && status !== filter.status) continue;
    if (filter.domain) {
      const d = String(linksObj.domain || '');
      const want = filter.domain.startsWith('domain-') ? filter.domain : `domain-${filter.domain}`;
      if (d !== filter.domain && d !== want && `domain-${d}` !== want) continue;
    }
    out.push({ ...row, linksObj, status });
  }
  return out;
}

/**
 * Insert a planned lesson entry (idempotent via UNIQUE(kind,title,content_hash)).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   title: string, body: string, content_hash: string, source_path: string,
 *   links: object, ts?: number, session_id?: string, agent?: string
 * }} entry
 * @returns {'inserted'|'deduped'}
 */
export function insertLessonEntry(db, entry) {
  const existing = db
    .prepare(
      `SELECT id FROM mem_entries WHERE kind = ? AND title = ? AND content_hash = ? LIMIT 1`,
    )
    .get('lesson', entry.title, entry.content_hash);
  if (existing) return 'deduped';

  const uuid = crypto.randomUUID();
  const linksJson = JSON.stringify(entry.links ?? {});
  try {
    db.prepare(
      `INSERT INTO mem_entries(
        uuid, ts, session_id, agent, kind, key, title, body, links, sha_refs,
        pinned, content_hash, source_path, supersedes, superseded_by, version
      ) VALUES (?, ?, ?, ?, 'lesson', NULL, ?, ?, ?, '[]', 0, ?, ?, NULL, NULL, 1)`,
    ).run(
      uuid,
      entry.ts ?? Date.now(),
      entry.session_id ?? SESSION_IMPORT,
      entry.agent ?? AGENT_IMPORT,
      entry.title,
      entry.body,
      linksJson,
      entry.content_hash,
      entry.source_path,
    );
  } catch (err) {
    const msg = String(err?.message || err);
    if (/UNIQUE constraint failed/i.test(msg)) return 'deduped';
    throw new Error(
      `insert failed for ${entry.source_path} (${entry.title}): ${msg}`,
    );
  }
  return 'inserted';
}

// ---------------------------------------------------------------------------
// Domain file discovery
// ---------------------------------------------------------------------------

/**
 * List domain lesson source files under the given directory (canon: .agents/domains).
 * @param {string} skillsDir
 * @returns {{ domain: string, status: 'active'|'inbox', abs: string, rel: string }[]}
 */
export function listLessonSourceFiles(skillsDir) {
  /** @type {{ domain: string, status: 'active'|'inbox', abs: string, rel: string }[]} */
  const out = [];
  if (!fs.existsSync(skillsDir)) return out;
  for (const d of fs.readdirSync(skillsDir).sort()) {
    if (!d.startsWith('domain-')) continue;
    const dir = path.join(skillsDir, d);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const [name, status] of [
      ['lessons.md', 'active'],
      ['_inbox.md', 'inbox'],
    ]) {
      const abs = path.join(dir, name);
      if (!fs.existsSync(abs)) continue;
      out.push({
        domain: d,
        status: /** @type {'active'|'inbox'} */ (status),
        abs,
        // Derived from the caller's tree, not hardcoded: a fixed `.claude/skills` prefix
        // kept reporting paths that no longer exist after the trees were consolidated.
        rel: `${path.relative(REPO_ROOT, dir).split(path.sep).join('/')}/${name}`,
      });
    }
  }
  return out;
}

/**
 * Read UTF-8 file; fail loud on non-UTF8.
 * @param {string} absPath
 */
export function readUtf8(absPath) {
  const bytes = fs.readFileSync(absPath);
  const text = bytes.toString('utf8');
  if (Buffer.compare(Buffer.from(text, 'utf8'), bytes) !== 0) {
    throw new Error(`non-UTF8 file (refusing mojibake fallback): ${absPath}`);
  }
  return { text, bytes, byteLength: bytes.length };
}

/**
 * Collect repo-relative file paths for glob resolution (git ls-files preferred).
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function listRepoPaths(repoRoot) {
  try {
    // Same scrub as every other git call: with GIT_DIR exported this would list
    // another repository's files and the glob resolution would silently be about
    // the wrong tree. Nothing here decides a verdict, but a listing that is quietly
    // from elsewhere is the kind of wrong that never announces itself.
    const env = scrubbedGitEnv();
    const out = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
  } catch {
    /** @type {string[]} */
    const paths = [];
    for (const r of projectConfig({ repoRoot }).anchorRoots) {
      walkFiles(path.join(repoRoot, r), repoRoot, paths);
    }
    return paths;
  }
}

function walkFiles(dir, root, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'target') continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(abs, root, acc);
    else if (ent.isFile()) {
      acc.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
}

/**
 * Resolve memoryctl binary: PATH first, then repo .claude/scripts/memoryctl.
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function resolveMemoryctl(repoRoot = REPO_ROOT) {
  // Windows: `which` here is Git Bash's, and it answers with a POSIX path
  // (/c/Users/...) that Node cannot spawn — every call died on ENOENT and the
  // sweep silently lost its report. `where` answers with real Windows paths,
  // including the .cmd shim that is the only spawnable entry point.
  if (process.platform === 'win32') {
    try {
      const found = execFileSync('where', ['memoryctl'], { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      // A native executable first, then the shebang script, and the `.cmd` shim
      // only if nothing else exists. The order is the whole point: the shim can be
      // launched only through cmd.exe, and cmd.exe tokenizes the command line
      // before the program sees it. See `spawnPlan`.
      const runnable =
        found.find((p) => /\.exe$/i.test(p)) ||
        found.find((p) => !/\.(cmd|bat)$/i.test(p)) ||
        found[0];
      if (runnable) return runnable;
    } catch {
      /* fall through */
    }
  } else {
    try {
      const which = execFileSync('which', ['memoryctl'], { encoding: 'utf8' }).trim();
      if (which) return which;
    } catch {
      /* fall through */
    }
  }
  const local = path.join(repoRoot, '.claude', 'scripts', 'memoryctl');
  if (fs.existsSync(local)) return local;
  throw new Error(
    'memoryctl not found on PATH and missing at .claude/scripts/memoryctl — install memoryctl (no silent file fallback)',
  );
}

/**
 * True when the binary must be spawned through a shell. Node 18+ refuses to
 * execFile a .cmd/.bat directly (EINVAL) since CVE-2024-27980.
 * @param {string} bin
 */
function needsShell(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
}

/**
 * The Git-for-Windows `bash.exe`, or null.
 *
 * Deliberately not `where bash`: the first answer there is whatever PATH order
 * gives, and on this machine that list also holds the WSL launcher in System32 and
 * the Store alias in WindowsApps - neither of which can run a script that lives on
 * a Windows path. Git's own installation is located instead, through `git.exe`,
 * which is the same installation the `.cmd` shim points at.
 * @returns {string | null}
 */
function gitBashExecutable() {
  /** @type {string[]} */
  const candidates = [];
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (root) candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
  }
  try {
    for (const line of execFileSync('where', ['git'], { encoding: 'utf8' }).split(/\r?\n/)) {
      const found = line.trim();
      if (!found) continue;
      // <root>/cmd/git.exe and <root>/mingw64/bin/git.exe both give <root>.
      const root = /\\mingw\d+\\bin\\/i.test(found)
        ? path.dirname(path.dirname(path.dirname(found)))
        : path.dirname(path.dirname(found));
      candidates.push(path.join(root, 'bin', 'bash.exe'));
    }
  } catch {
    /* git is not on PATH; the explicit roots above may still hit */
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/**
 * How to spawn `bin` WITHOUT handing a command line to cmd.exe.
 *
 * cmd.exe is not an argv transport. It tokenizes the line it is given before the
 * program ever runs, and it has no backslash escape: `\"` does not protect a quote,
 * it only ends the quoted region. Two reviewers demonstrated both halves of that on
 * the previous shape of this code - one watched every quote of a `--links` JSON
 * value get eaten (so capture never worked on Windows, which this code claimed to
 * fix), the other got a nested `echo` to execute out of a value that merely looked
 * like a title. Escaping harder is not the answer; there is no escape that makes an
 * untrusted string safe through cmd.exe's tokenizer AND the CRT parser behind it.
 *
 * So the shell is removed from the path instead. `memoryctl` on Windows is a bash
 * script plus a `.cmd` shim whose only content is "run that script through Git
 * bash"; doing exactly that ourselves is one process fewer and no tokenizer at all.
 * Node's own argument escaping for `CreateProcess` is CRT-correct, which is what
 * bash.exe parses with.
 *
 * @param {string} bin
 * @param {string[]} args
 * @returns {{ file: string, argv: string[], shell: boolean }}
 */
export function spawnPlan(bin, args) {
  if (process.platform !== 'win32') return { file: bin, argv: args, shell: false };
  // Windows runs PE images and nothing else. Everything here is decided by what
  // the file IS, never by what its name suggests: `memoryctl` on this machine is a
  // bash script with no extension at all, which `CreateProcess` refuses with
  // ENOENT, and `memoryctl.cmd` is a two-line shim that starts bash itself.
  // The claim above has to be true of the executable branch as well. Trusting
  // `.exe` was still trusting the name: a `.exe` that is really a script gets
  // handed to CreateProcess and fails with a message about a missing file, and a
  // renamed image is refused for having the wrong suffix. `MZ` is what
  // CreateProcess itself looks for.
  if (leadingBytes(bin, 2) === 'MZ') return { file: bin, argv: args, shell: false };
  const script = needsShell(bin) ? bin.replace(/\.(cmd|bat)$/i, '') : bin;
  const bash = gitBashExecutable();
  if (bash && leadingBytes(script, 2) === '#!') {
    return { file: bash, argv: [script, ...args], shell: false };
  }
  throw new Error(
    `cannot run ${bin} safely: it is not an executable image, and no bash script ` +
      `(${script}) plus Git bash could be located to run it. Refusing to route ` +
      `arguments through cmd.exe, which strips quotes and executes metacharacters ` +
      `found in values.`,
  );
}

/**
 * The first `count` bytes of a file as latin1, or '' if it cannot be read.
 *
 * `MZ` and `#!` are the two magic numbers that decide how a file can be launched
 * on Windows, and both are answers about the file itself rather than about its
 * name - which is the only kind of answer worth acting on here.
 * @param {string} file
 * @param {number} count
 */
function leadingBytes(file, count) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const head = Buffer.alloc(count);
    const read = fs.readSync(handle, head, 0, count, 0);
    return head.subarray(0, read).toString('latin1');
  } catch {
    return '';
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/**
 * Run memoryctl; throw on non-zero (preserve exit 9 for CAS).
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
export function runMemoryctl(args, opts = {}) {
  const bin = resolveMemoryctl(opts.cwd || REPO_ROOT);
  const plan = spawnPlan(bin, args);
  try {
    const stdout = execFileSync(plan.file, plan.argv, {
      cwd: opts.cwd || REPO_ROOT,
      encoding: 'utf8',
      input: opts.input,
      env: { ...process.env, ...(opts.env || {}) },
      maxBuffer: 16 * 1024 * 1024,
      shell: plan.shell,
    });
    return { stdout: stdout ?? '', stderr: '', status: 0 };
  } catch (err) {
    const status = typeof err.status === 'number' ? err.status : 1;
    const stdout = err.stdout != null ? String(err.stdout) : '';
    const stderr = err.stderr != null ? String(err.stderr) : String(err.message || err);
    const e = new Error(`memoryctl ${args[0] || ''} failed (exit ${status}): ${stderr || stdout}`);
    // @ts-expect-error attach
    e.status = status;
    // @ts-expect-error attach
    e.stdout = stdout;
    // @ts-expect-error attach
    e.stderr = stderr;
    throw e;
  }
}
