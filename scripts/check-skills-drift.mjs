#!/usr/bin/env node
// The gate lesson #124 asked for on 2026-07-26 and nobody built.
//
// ops/bootstrap/install-harness.mjs junctions every canon skill from
// .agents/skills/<name> into seven runtime directories. That makes a write by a
// runtime path a write THROUGH the link into a git-tracked file, and on
// 2026-07-26 it looked like the harness-project skill (retired 2026-09-23) reverting
// itself to a version from 06-29. The writer was never found; the channel was
// closed from the source side (a personal pack at ~/.agents was moved away) but
// never from the mechanism side. This closes it from the mechanism side.
//
//   node scripts/check-skills-drift.mjs [--json]
//
// FAIL (exit 1) — the shapes that make a canon skill silently wrong:
//   collision  a REAL directory in a runtime shadows a canon skill name; the
//              runtime reads its copy, the repo keeps its own, and they diverge
//              with nothing to notice
//   foreign    a link whose target leaves the repo canon — the same divergence
//              wearing a link's clothes
//   dangling   a link into the canon whose target is gone; the runtime shows a
//              skill that cannot be read
//   undelivered  a skill the runtime was promised and never got: for a seat
//              runtime the whole canon, for a lead runtime the allowlist in
//              .agents/domains/_skill-map.json (leadInstalledSkills, or its
//              class core skills plus the config's skills.lead when that key
//              is present; plus supportLeadSkills when a support-lead install
//              left its links), minus skills.off in either profile
//   unexpected  a runtime carrying a managed canon link its profile does not
//              promise, including a skill disabled by skills.off
//
// WARN — untracked: a link to a live skill no repository tracks. It reaches an
// agent, never reaches another machine, and no review sees it. Measured
// 2026-08-05: zcode carried six, five of them a personal `paseo` pack. An
// operator may want that; they should not find it by accident.
//
// WARN — worktree drift under .agents/skills. Editing a skill looks exactly
// like a write-through, so this cannot fail without blocking normal work. It is
// printed so a revert nobody made is at least visible.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { installerCanonDir, supportLeadInstalled } from './git-env.mjs';
export { installerCanonDir, supportLeadInstalled } from './git-env.mjs';
import { effectiveLeadSkills, readHarnessConfig } from './lib/harness-config.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CANON_DIR = join(REPO, '.agents', 'skills');

// Mirrors SKILL_TARGETS in ops/bootstrap/install-harness.mjs. A runtime that is
// absent is not a failure — that runtime is simply not installed here.
//
// `claude` left this table on 2026-08-18: its skills are now laid beside the
// WORKING TREE (`<checkout>/.claude/skills`), because one shared home let a
// session in the other checkout write through the link into this canon — four
// reverts in two and a half hours. Per-checkout links are judged by
// `projectSkillRoot` below, against the checkout they belong to.
//
// `glm-lead` left it on the same day and for the same reason: `glm-lead.sh`
// launches Claude Code with `CLAUDE_CONFIG_DIR=~/.glm-lead-config`, and a config
// directory does not move project resolution, so it reads the per-checkout
// `.claude/skills` below. `zcode` stays because it is the GLM desktop GUI, not
// Claude Code, and its project resolution is unmeasured.
export const RUNTIME_SKILL_DIRS = Object.freeze([
  ['codex', '.codex/skills'],
  ['grok', '.grok/skills'],
  ['kimi', '.kimi-code/skills'],
  ['glm', '.glm-worker-config/skills'],
  ['zcode', '.zcode/skills'],
]);

/** Where the per-checkout links live, for the runtimes that read a project. */
export const PROJECT_SKILL_DIRS = Object.freeze([['claude', '.claude/skills']]);

/**
 * Runtimes the installer feeds the LEAD allowlist instead of the whole canon.
 *
 * Mirrors `leadTarget` in ops/bootstrap/install-harness.mjs (`parts[0]` of
 * `.claude` or `.codex`): codex reads its home, claude the per-checkout
 * project root. Judging these against the full canon made a correctly
 * installed lead permanently red — measured 66 "undelivered" problems on the
 * operator Mac, 33 per lead runtime, none of them a real defect.
 */
export const LEAD_RUNTIMES = Object.freeze(new Set(['codex', 'claude']));

/** Skill dirs of the lead runtimes in one runtime table, rooted at `root`. */
export const leadDirs = (table, root) => table.filter(([name]) => LEAD_RUNTIMES.has(name)).map(([, rel]) => join(root, rel));

/**
 * Canon skill names: a directory under .agents/skills carrying a SKILL.md.
 *
 * A directory the process cannot LIST counts too, and that is not pedantry.
 * `existsSync` answers false for a denied path exactly as it does for an absent
 * one, so an unreadable skill used to drop out of the canon entirely and every
 * later check passed over a skill nobody looked at — round `svod-method-swap-r6`
 * measured the whole gate exiting 0 that way. Keeping the name puts it in front
 * of `retiredMethodMentions`, which reports it as UNJUDGED.
 */
export function canonSkills(dir = CANON_DIR, fs = { existsSync, readdirSync }) {
  if (!fs.existsSync(dir)) return [];
  // The canon root itself can be a wall. A member seat resolves the MAIN
  // checkout's canon and may not list it: the throw here took the sensor down
  // before it judged one runtime, which is the class this round removed from
  // three siblings and left standing in the fourth. An unreadable canon is not
  // an empty one, so it answers null and the caller says so by name.
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return null;
    throw error;
  }
  return entries
    .filter((e) => {
      if (!e.isDirectory()) return false;
      const skill = join(dir, e.name);
      let entries;
      try {
        entries = fs.readdirSync(skill, { withFileTypes: true });
      } catch {
        return true;
      }
      // The LISTING answers, not `existsSync`. A directory can be readable and
      // not searchable (POSIX mode 0400): the names come back, and every stat
      // through it fails — so `existsSync('SKILL.md')` says false and the skill
      // vanished from the canon with nothing judged. Round `svod-method-swap-r7`
      // built exactly that fixture.
      return entries.some((entry) => entry.name === 'SKILL.md');
    })
    .map((e) => e.name)
    .sort();
}

/**
 * Classify one runtime directory against the canon.
 * Pure enough to test: every filesystem question arrives through `fs`.
 * @param {string} dir runtime skills directory
 * @param {Set<string>} canon canon skill names
 * @param {string} canonDir absolute canon path, for the foreign/dangling test
 * @param {object} fs filesystem surface
 * @param {Set<string>} [expectedSet] skills THIS runtime was promised; defaults
 *   to the canon, which is the seat-runtime rule. A lead runtime passes its
 *   allowlist, and a managed canon link beyond it is `unexpected`.
 */
export function classifyRuntime(dir, canon, canonDir, fs = { readdirSync, existsSync, realpathSync, statSync }, expectedSet = canon) {
  const findings = { collision: [], foreign: [], dangling: [], undelivered: [], unexpected: [], untracked: [], links: 0, real: 0 };
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const linked = new Set();

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      findings.links += 1;
      let target;
      try {
        target = fs.realpathSync(full);
      } catch {
        // realpath throws only when the target is gone. Resolve BEFORE judging
        // the name: a link can point at a live directory the canon simply does
        // not have, and calling that "dangling" reads as breakage when it is
        // not (measured 2026-08-05: zcode's six links all resolved).
        findings.dangling.push(entry.name);
        continue;
      }
      const expected = join(canonDir, entry.name);
      if (!canon.has(entry.name)) {
        // Delivered instruction that no repository tracks: it reaches an agent,
        // does not reach another machine, and no review ever sees it. Reported,
        // not failed — an operator may want a personal pack; they may not want
        // to discover it by accident.
        findings.untracked.push(`${entry.name} -> ${target}`);
        continue;
      }
      if (resolve(target).toLowerCase() !== resolve(expected).toLowerCase()) {
        findings.foreign.push(`${entry.name} -> ${target}`);
        continue;
      }
      if (!expectedSet.has(entry.name)) {
        // A managed link the runtime was never promised. For a lead runtime the
        // installer unlinks exactly this on every run, so its presence is drift
        // in one of two directions: a stale link, or an allowlist that forgot a
        // skill. A skills.off entry is unexpected in any runtime.
        findings.unexpected.push(entry.name);
        continue;
      }
      linked.add(entry.name);
      continue;
    }
    if (!entry.isDirectory()) continue;
    findings.real += 1;
    // A real directory is fine — runtimes ship their own skills — UNLESS it
    // takes a canon name, because then two files claim to be the same skill.
    if (canon.has(entry.name)) findings.collision.push(entry.name);
  }

  for (const name of expectedSet) {
    if (linked.has(name)) continue;
    findings.undelivered.push(name);
  }
  return findings;
}

/**
 * The lead allowlist for one scope, read from the checkout that owns the canon.
 *
 * Answers `{ map }` or `{ error }`; the caller fails loudly on an error, the
 * same rule as an empty canon: a gate that goes green when its input vanished
 * is the defect this file exists to catch.
 */
export function leadSkillMap(canonDir, read = readFileSync) {
  const mapPath = join(canonDir, '..', 'domains', '_skill-map.json');
  let map;
  try {
    map = JSON.parse(read(mapPath, 'utf8'));
  } catch (error) {
    return { error: `${mapPath}: ${error.message}` };
  }
  if (!Array.isArray(map.leadInstalledSkills) || !Array.isArray(map.supportLeadSkills)) {
    return { error: `${mapPath}: leadInstalledSkills and supportLeadSkills must be string arrays` };
  }
  return { map };
}

/**
 * Method documents the harness no longer carries, and their dead namespace.
 *
 * The plugin was removed from this machine on 2026-08-17, so `superpowers:`
 * cannot resolve for anyone; the five bare names left with it. A canon skill
 * naming one of them tells its reader to open a document that does not exist —
 * the reader answers "Unknown skill", loses the turn, and cannot carry out the
 * rule the document just gave it.
 *
 * A CLOSED list, not a growing one: it is what the swap retired. When a set
 * changes again, what leaves it belongs here in the same commit.
 */
export const RETIRED_METHOD_IDS = [
  'superpowers:',
  'systematic-debugging',
  'verification-before-completion',
  'test-driven-development',
  'writing-plans',
];

/**
 * Retired names that are also ordinary English, and are only a defect AS AN ID.
 *
 * `brainstorming` is the whole list today. Matched bare it fails a sentence like
 * "run a short brainstorming session", which is prose and not an instruction to
 * open anything — three reviewers of round `svod-method-swap-r3` each built that
 * probe. So it counts only in identifier shape: in backticks, or namespaced.
 */
export const RETIRED_AMBIGUOUS_IDS = ['brainstorming'];

/** What a hit carries instead of an id when the document could not be judged. */
export const UNREADABLE = '(unreadable)';

/**
 * How an ambiguous name has to be written before it counts as an id.
 *
 * Parentheses were a third shape and are gone: round `svod-method-swap-r4`
 * showed `a session (brainstorming) first` hitting, which is the prose case this
 * split exists to spare. Backticks and a namespace are unambiguous; a bracketed
 * aside is not.
 */
const idShapes = (id) => [`\`${id}\``, `superpowers:${id}`];

/**
 * Does this line name THIS id, rather than one that merely starts with it?
 *
 * `systematic-debugging-v2` is a different document, and a bare `includes` calls
 * it the retired one — measured in round `svod-method-swap-r5`. BOTH sides are
 * bounded: r6 then named the mirror case, `better-systematic-debugging`, which
 * the right-hand check alone still blocked. A namespace ends in `:` and has no
 * such neighbour, so only the bare names are bounded.
 */
function namesTheId(line, id) {
  if (id.endsWith(':')) return line.includes(id);
  let from = 0;
  for (;;) {
    const at = line.indexOf(id, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : line[at - 1];
    const after = line[at + id.length] ?? '';
    // Underscore belongs to the class: `pre_systematic-debugging` is a name of
    // its own, and r7 measured it counting as the retired document.
    if (!/[a-z0-9_-]/.test(before) && !/[a-z0-9_-]/.test(after)) return true;
    from = at + 1;
  }
}

/**
 * Canon skill text that still orders a reader to reach for a retired document.
 *
 * Found twice by review before this existed: round `svod-method-swap-r1` in the
 * skill the operator's own sessions load, and r2 in five more after the first
 * was fixed one file at a time.
 *
 * SKILL.md and any `reference/`, `references/` or `rules/` document beside it —
 * a member can be sent into those, and the r3 probe put a retired id in one and
 * watched the first version of this sensor miss it. `PROVENANCE.md` is exempt on
 * purpose: a vendored document's provenance records WHICH document it replaced,
 * and that sentence is history rather than an instruction.
 */
export function retiredMethodMentions(canonList, canonDir, read = readFileSync, list = readdirSync) {
  const hits = [];
  for (const name of canonList) {
    // A retired document's OWN files may name it; nothing else may.
    if (RETIRED_METHOD_IDS.includes(name) || RETIRED_AMBIGUOUS_IDS.includes(name)) continue;
    const { docs, unread } = instructionDocuments(join(canonDir, name), list);
    // A directory the sensor could not list is not a clean directory. Reported
    // as its own hit rather than swallowed: round `svod-method-swap-r5`
    // chmod-000'd a `rules/` holding a retired id and watched this answer "no
    // problems", which is the third time this line of rounds has found a check
    // going green because its input disappeared.
    for (const rel of unread) {
      hits.push({ skill: name, file: rel, line: 0, id: UNREADABLE, text: 'this directory could not be listed, so nothing in it was judged' });
    }
    for (const rel of docs) {
      let text;
      try {
        text = read(join(canonDir, name, rel), 'utf8');
      } catch (error) {
        hits.push({ skill: name, file: rel, line: 0, id: UNREADABLE, text: `this document could not be read (${error.code ?? error.message}), so it was not judged` });
        continue;
      }
      for (const [index, raw] of text.split('\n').entries()) {
        // Case-insensitive: `Systematic-Debugging` is the same dead id, and the
        // r3 probe showed the first version reading straight past it.
        const line = raw.toLowerCase();
        // ONE hit per line: `superpowers:systematic-debugging` matches both the
        // namespace and the bare name, and printing it twice reads as two
        // defects in one sentence.
        const named =
          RETIRED_METHOD_IDS.find((id) => namesTheId(line, id)) ??
          RETIRED_AMBIGUOUS_IDS.find((id) => idShapes(id).some((shape) => line.includes(shape)));
        if (named) hits.push({ skill: name, file: rel, line: index + 1, id: named, text: raw.trim() });
      }
    }
  }
  return hits;
}

/**
 * Every markdown document of a skill, at any depth, except its provenance.
 *
 * A skill is delivered as a TREE and a member can be sent into any of it, so a
 * named subdirectory list was the wrong shape: round `svod-method-swap-r4`
 * listed what it missed on the live canon — `AGENTS.md` and `README.md` at a
 * skill's root, `examples/*.md`, `assets/template.md`. `PROVENANCE.md` stays out
 * at any depth: recording WHICH document was replaced is history, not an order.
 */
function instructionDocuments(skillDir, list) {
  const docs = [];
  const unread = [];
  const walk = (rel, depth) => {
    // The reader's own bound, exactly: `collect_skill_files` in driver.rs
    // refuses at `prefix.len() >= SKILL_BUNDLE_DEPTH`, so a directory at depth 8
    // is never delivered and there is nothing there to judge. The sensor was one
    // level deeper until round `svod-method-swap-r5` measured the difference.
    if (depth >= 8) return;
    let entries;
    try {
      entries = list(rel ? join(skillDir, rel) : skillDir, { withFileTypes: true });
    } catch {
      // Including the skill's OWN root. The first version exempted it — `rel` is
      // empty there — and round `svod-method-swap-r6` chmod-000'd a skill
      // directory that `canonSkills` had already listed and watched the sensor
      // answer "clean" over a tree nothing of which was judged. Same fail-open,
      // one level up.
      unread.push(rel || '.');
      return;
    }
    for (const entry of entries) {
      const next = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(next, depth + 1);
        continue;
      }
      // Case-folded: a delivered `README.MD` is the same document to a reader.
      const lower = entry.name.toLowerCase();
      if (entry.isFile() && lower.endsWith('.md') && lower !== 'provenance.md') {
        docs.push(next);
      }
    }
  };
  walk('', 0);
  return { docs: docs.sort(), unread: unread.sort() };
}

/** Tracked files under .agents/skills that differ from HEAD. */
function worktreeDrift() {
  try {
    return execFileSync('git', ['diff', '--name-only', 'HEAD', '--', '.agents/skills'], {
      cwd: REPO,
      encoding: 'utf8',
      env: scrubbedGitEnv(),
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

if (isMain(import.meta.url)) {
  const expectDir = installerCanonDir();
  if (expectDir === null) {
    console.log(
      'check-skills-drift: SKIPPED — this copy is not a git checkout, so the checkout that\n' +
        '  installed the machine\'s skill links cannot be resolved from here. Run it from the\n' +
        '  main checkout: node scripts/check-skills-drift.mjs',
    );
    process.exit(0);
  }
  const canonList = canonSkills(expectDir);
  if (canonList === null) {
    console.log(`skip: ${expectDir} — the installer's canon is not readable from here (EPERM/EACCES);`);
    console.log('      a sandboxed seat cannot audit the operator\'s machine-wide skill delivery');
    process.exit(0);
  }
  const canon = new Set(canonList);
  // An empty canon is not "nothing to check", it is "the thing I check against
  // is gone": every expectation disappears, every runtime scores zero problems
  // and the sensor reports OK over a machine it never looked at. A gate that
  // turns green when its own input vanishes is the failure this file exists to
  // catch, found in this file by the grok seat of run 20260806T115336022Z.
  if (canon.size === 0) {
    console.log(
      `check-skills-drift: FAIL — no canon skills found under ${expectDir}.\n` +
        '  Nothing was compared. Check the path exists and holds <skill>/SKILL.md directories.',
    );
    process.exit(1);
  }
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const report = [];
  let failures = 0;

  const retired = retiredMethodMentions(canonList, expectDir);
  failures += retired.length;

  // A HOME scope is machine-wide and belongs to the MAIN checkout's canon, which
  // is what `installerCanonDir` resolved. The PROJECT scope belongs to THIS
  // checkout - since 2026-08-18 a worktree carries its own - so judging it
  // against main audits the neighbour and certifies a worktree that has no
  // `.claude/skills` at all. Measured in review round `harness-fixes-mac`: a
  // linked worktree with no project root exited 0 and printed OK.
  const projectRoot = resolve(REPO);
  const projectCanonDir = join(projectRoot, '.agents', 'skills');
  const projectCanonList = canonSkills(projectCanonDir);
  const projectCanon = new Set(projectCanonList ?? []);
  // One scope = one canon + the lead allowlist that belongs to that canon's
  // checkout. Lead runtimes are judged against the allowlist; seat runtimes
  // against the whole canon, exactly the rule the installer links by.
  const scopes = [
    { canonDir: expectDir, canon, leadDirs: leadDirs(RUNTIME_SKILL_DIRS, home) },
    { canonDir: projectCanonDir, canon: projectCanon, leadDirs: leadDirs(PROJECT_SKILL_DIRS, projectRoot) },
  ];
  for (const scope of scopes) {
    const { map, error } = leadSkillMap(scope.canonDir);
    if (error) {
      console.log(
        `check-skills-drift: FAIL — the lead allowlist cannot be read: ${error}.\n` +
          '  Without it a lead runtime cannot be judged, and a skipped judgement is not a clean one.',
      );
      process.exit(1);
    }
    const support = supportLeadInstalled(scope.leadDirs, scope.canonDir, map.supportLeadSkills);
    const repoRoot = resolve(scope.canonDir, '../..');
    const configFile = join(repoRoot, 'ops/bootstrap/harness.config.json');
    let skillsConfig;
    try {
      skillsConfig = existsSync(configFile) ? readHarnessConfig({ repoRoot }).skills : undefined;
    } catch (error) {
      console.log(`check-skills-drift: FAIL — ${error.message.replace(/[\r\n]+/g, ' ')}`);
      process.exit(1);
    }
    const off = new Set(skillsConfig?.off ?? []);
    scope.expected = new Set([...effectiveLeadSkills({ map, lead: skillsConfig?.lead }), ...(support ? map.supportLeadSkills : [])]
      .filter((name) => !off.has(name)));
    scope.seatExpected = new Set([...scope.canon].filter((name) => !off.has(name)));
    scope.supportLead = support;
  }
  const scoped = [
    ...RUNTIME_SKILL_DIRS.map(([runtime, rel]) => [runtime, join(home, rel), scopes[0]]),
    ...PROJECT_SKILL_DIRS.map(([runtime, rel]) => [runtime, join(projectRoot, rel), scopes[1]]),
  ];
  for (const [runtime, dir, scope] of scoped) {
    const rel = dir;
    if (!existsSync(dir)) {
      report.push({ runtime, rel, absent: true });
      continue;
    }
    const lead = LEAD_RUNTIMES.has(runtime);
    const f = classifyRuntime(dir, scope.canon, scope.canonDir, undefined, lead ? scope.expected : scope.seatExpected);
    // untracked is deliberately OUT of `bad`: it warns, it does not fail.
    const bad =
      f.collision.length + f.foreign.length + f.dangling.length + f.undelivered.length + f.unexpected.length;
    failures += bad;
    report.push({ runtime, rel, lead, ...(lead ? { supportLead: scope.supportLead } : {}), ...f, bad });
  }

  const drift = worktreeDrift();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ canon: canonList.length, report, drift, retired }, null, 2));
  } else {
    console.log(`canon: ${canonList.length} skills under .agents/skills`);
    if (retired.length) {
      console.log(`\nRETIRED: ${retired.length} canon skill document(s) the gate could not clear:`);
      for (const hit of retired) {
        const where = hit.line ? `${hit.skill}/${hit.file}:${hit.line}` : `${hit.skill}/${hit.file}`;
        console.log(`      ${where}  ${hit.id === UNREADABLE ? 'UNJUDGED' : `names "${hit.id}"`}`);
        console.log(`         ${hit.text.slice(0, 120)}`);
      }
    }
    for (const r of report) {
      if (r.absent) {
        console.log(`  ${r.runtime.padEnd(9)} not installed (${r.rel}) — skipped`);
        continue;
      }
      const head = `  ${r.runtime.padEnd(9)} ${String(r.links).padStart(3)} links, ${String(r.real).padStart(3)} own dirs`;
      console.log(r.bad ? `${head}  ${r.bad} PROBLEM(S)` : `${head}  ok`);
      for (const n of r.collision) console.log(`      COLLISION  a real directory shadows canon skill "${n}"`);
      for (const n of r.foreign) console.log(`      FOREIGN    ${n}`);
      for (const n of r.dangling) console.log(`      DANGLING   "${n}" links to a skill the canon no longer has`);
      for (const n of r.undelivered) console.log(`      UNDELIVERED canon skill "${n}" never reached this runtime`);
      for (const n of r.unexpected) console.log(`      UNEXPECTED "${n}" is linked here but the lead allowlist does not name it`);
      for (const n of r.untracked) console.log(`      UNTRACKED  ${n} — delivered to this runtime, tracked by no repository`);
    }
    if (drift.length) {
      console.log(`\nWARN: ${drift.length} tracked file(s) under .agents/skills differ from HEAD.`);
      console.log('  Editing a skill looks identical to a write-through from a runtime path.');
      console.log('  If you did not edit these, a runtime wrote through the junction:');
      for (const f of drift.slice(0, 10)) console.log(`    ${f}`);
      if (drift.length > 10) console.log(`    … and ${drift.length - 10} more`);
    }
  }

  if (failures) {
    console.error(`\nFAIL: ${failures} skill-delivery problem(s).`);
    console.error('  COLLISION / FOREIGN / DANGLING / UNDELIVERED');
    console.error('    remove the shadowing copy, then re-run ops/bootstrap/install-harness.mjs');
    console.error('  UNEXPECTED');
    console.error('    a runtime carries a skill outside its profile or disabled by skills.off;');
    console.error('    re-run the skills installer, or amend the allowlist/config if it should be enabled');
    console.error('  RETIRED');
    console.error('    name a document the set still carries, or drop the sentence: a reader told to');
    console.error('    invoke a removed id answers "Unknown skill" and loses the turn');
    process.exit(1);
  }
  console.log('\ncheck-skills-drift: OK (every promised skill is linked, nothing shadows it)');
}
