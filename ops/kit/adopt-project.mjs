#!/usr/bin/env node
// Makes a project repository usable by a Claude Code lead of this harness.
//
//   node ops/kit/adopt-project.mjs /abs/path/to/project [--dry]
//
// Claude Code resolves skills from `<project>/.claude/skills`, and the harness
// installer links the lead skill set only into the harness home. This links the
// same set (effectiveLeadSkills for skills.lead, minus skills.off) into the
// project, hides the links and the codegraph index from the project's git
// status through `.git/info/exclude`, and builds the project's codegraph index.
// It never writes a tracked project file and never replaces an entry it did not make.
// A later run unlinks a harness link that has left the lead set only when the
// link's own name is the skill it points at. The installer sweep is unchanged.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveLeadSkills, readHarnessConfig } from '../../scripts/lib/harness-config.mjs';
import { inspectSkillEntry, skillKey } from '../bootstrap/skill-entry.mjs';

const HOME_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const target = args.find((arg) => !arg.startsWith('--'));
const fail = (message) => { console.error(`adopt-project: ${message}`); process.exit(1); };
if (!target || !path.isAbsolute(target)) fail('usage: node ops/kit/adopt-project.mjs /abs/path/to/project [--dry]');

const git = (...argv) => execFileSync('git', ['-C', target, ...argv], { encoding: 'utf8' }).trim();
let top;
try { top = git('rev-parse', '--show-toplevel'); } catch { fail(`${target} is not inside a git work tree`); }
if (path.resolve(top) === HOME_REPO) fail('this is the harness home; the installer already linked its skills');
const commonDir = path.resolve(top, git('rev-parse', '--git-common-dir'));

// The installer reads the config before it links. A refusal writes nothing, and
// the message is the reader's, the same text install-harness prints.
let config;
try {
  config = readHarnessConfig({ repoRoot: HOME_REPO });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

try {
  const skillMap = JSON.parse(readFileSync(path.join(HOME_REPO, '.agents', 'domains', '_skill-map.json'), 'utf8'));
  const off = new Set((config.skills?.off ?? []).map(skillKey));
  const lead = effectiveLeadSkills({ map: skillMap, lead: config.skills?.lead }).filter((name) => !off.has(skillKey(name)));
  const report = { project: top, linked: [], kept: [], skipped: [], removed: [], excluded: [], codegraph: null, dry };
  const skillsDir = path.join(top, '.claude', 'skills');
  if (!dry) mkdirSync(skillsDir, { recursive: true });
  for (const name of lead) {
    const source = path.join(HOME_REPO, '.agents', 'skills', name);
    const dest = path.join(skillsDir, name);
    if (!existsSync(path.join(source, 'SKILL.md'))) { report.skipped.push(`${name}: not in this harness home`); continue; }
    let entry = null;
    try { entry = lstatSync(dest); } catch { /* absent */ }
    if (entry?.isSymbolicLink() && sameSkillPath(path.resolve(skillsDir, readlinkSync(dest)), source)) { report.kept.push(name); continue; }
    if (entry) { report.skipped.push(`${name}: ${dest} already exists and is not this harness's link`); continue; }
    if (!dry) symlinkSync(source, dest, 'dir');
    report.linked.push(name);
  }
  const canon = path.join(HOME_REPO, '.agents', 'skills');
  const leadSet = new Set(lead);
  if (!dry && existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const dest = path.join(skillsDir, name);
      const judged = inspectSkillEntry(dest, canon);
      // The harness names a link after the skill. A user's link into the canon
      // under another name is not removed. The installer sweep has no such check.
      if (judged.kind !== 'managed' || name !== judged.skill) continue;
      if (leadSet.has(judged.skill) && existsSync(path.join(canon, judged.skill))) continue;
      unlinkSync(dest);
      report.removed.push(name);
    }
  }

  // Per-clone ignore: nothing tracked changes, so the project's own .gitignore stays its owner's.
  const excludeFile = path.join(commonDir, 'info', 'exclude');
  const drop = new Set(report.removed.map((name) => `/.claude/skills/${name}`));
  const wanted = [...report.linked, ...report.kept].map((name) => `/.claude/skills/${name}`).concat('/.codegraph/');
  const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const keptLines = lines.filter((line) => !drop.has(line));
  const have = new Set(keptLines);
  const missing = wanted.filter((line) => !have.has(line));
  if ((keptLines.length !== lines.length || missing.length) && !dry) {
    mkdirSync(path.dirname(excludeFile), { recursive: true });
    const body = [...keptLines, ...missing];
    writeFileSync(excludeFile, body.length ? `${body.join('\n')}\n` : '');
  }
  report.excluded = missing;

  if (dry) report.codegraph = 'skipped (--dry)';
  else {
    const run = spawnSync('codegraph', ['init', '--yes', '.'], { cwd: top, encoding: 'utf8', timeout: 20 * 60_000 });
    report.codegraph = run.error ? `not run: ${run.error.code ?? run.error.message}` : run.status === 0 ? 'index built' : `exit ${run.status}: ${(run.stderr || run.stdout || '').trim().slice(-200)}`;
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function sameSkillPath(linked, source) {
  try {
    return realpathSync(linked) === realpathSync(source);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.resolve(linked) === path.resolve(source);
  }
}
