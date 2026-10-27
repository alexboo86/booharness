// The inputs of the non-live orch suite, per test file, and the record that the
// whole suite passed on a tree. The commit gate selects tests by these inputs;
// `main.ts restart` refuses a checkout whose inputs the record does not name.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { relativeImportFiles } from './code-hash.mjs';
import { ROLE_POLICY } from './src/role-policy.ts';

const SKILL_MAP = '.agents/domains/_skill-map.json';

export const isOrchTest = (name) => /^scripts\/test-orch-.*\.mjs$/.test(name) && !name.endsWith('-live.mjs');

/** Checkout-relative names of the non-live orch tests. */
export function orchSuiteTests(repo) {
  return readdirSync(path.join(repo, 'scripts'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && isOrchTest(`scripts/${entry.name}`))
    .map((entry) => `scripts/${entry.name}`)
    .sort();
}

/** Each test's own inputs: itself, every file that it imports or names in a
 * string and, for a test that reads the skill map, each role-default SKILL.md.
 * `contents` overrides working-tree bytes (null means absent). */
export function suiteInputs(repo, tests, contents = new Map()) {
  const edges = new Map();
  const files = relativeImportFiles(repo, tests, {
    allowMissing: true, includeFileLiterals: true, contents, edges,
  });
  // seatContext reads these interpolated paths; match its skill-name filter. It
  // reads only a seat role's list: `lead` and `advisor` defaults reach no seat, and
  // counting them made a lead skill edit select every skill-map reader (task 2809).
  const skills = [];
  const mapBytes = files.get(SKILL_MAP);
  if (mapBytes) {
    const roleDefaults = JSON.parse(mapBytes.toString('utf8')).roleDefaults ?? {};
    for (const names of Object.keys(ROLE_POLICY).map((role) => roleDefaults[role] ?? [])) {
      for (const name of names.filter((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
        skills.push(`.agents/skills/${name}/SKILL.md`);
      }
    }
  }
  const inputs = new Map();
  for (const test of tests) {
    const reached = new Set();
    const pending = [test];
    while (pending.length) {
      const name = pending.pop();
      if (reached.has(name)) continue;
      reached.add(name);
      pending.push(...(edges.get(name) ?? []));
    }
    if (reached.has(SKILL_MAP)) for (const skill of skills) reached.add(skill);
    inputs.set(test, reached);
  }
  return { files, inputs };
}

/** sha256 of restart-relevant suite inputs, absent ones included. */
export function suiteHash(repo) {
  const { files, inputs } = suiteInputs(repo, orchSuiteTests(repo));
  const names = new Set();
  for (const reached of inputs.values()) for (const name of reached) names.add(name);
  const hash = createHash('sha256');
  for (const name of [...names].sort()) {
    // Knowledge pages are prose, not executable code or configuration. Literal
    // paths in context/security tests reach them incidentally; doc-only merges
    // must not starve the restart record during a long run. Keep them in the
    // commit selector, but omit their bytes AND presence from the shared hash
    // used before/after the suite and at restart. Code, fixtures and skills
    // (including code under knowledge/) still invalidate the record.
    if (/^\.agents\/domains\/[^/]+\/knowledge(?:\.md|\/.*\.md)$/i.test(name)) continue;
    // Git's own metadata is never suite code. A fixture literal such as '.git/index'
    // names the shared checkout's index, which every other lead's git command
    // rewrites, so it voided each pass record (task 2779).
    if (name === '.git' || name.startsWith('.git/')) continue;
    let bytes = files.get(name);
    if (bytes === undefined) {
      try { bytes = readFileSync(path.join(repo, name)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        bytes = null;
      }
    }
    hash.update(`${name}\0${bytes === null ? 'absent' : 'file'}\0`);
    if (bytes !== null) hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export const suitePassFile = (stateDir) => path.join(stateDir, 'orch-suite-pass.json');

/** Record that the whole suite passed on the tree with this hash. */
export function writeSuitePass(stateDir, hash, repo) {
  const file = suitePassFile(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ hash, at: new Date().toISOString(), repo })}\n`);
  renameSync(temporary, file);
}

/** Why this checkout may not be restarted onto, or null when the suite passed on it. */
export function suitePassRefusal(checkout, stateDir) {
  const repo = path.resolve(checkout);
  const remedy = `run npm run check:orch-tests in ${repo}, or pass --no-suite "<reason>"`;
  const hash = suiteHash(repo);
  const tree = `tree ${repo} has ${hash.slice(0, 16)}`;
  let record;
  try {
    record = JSON.parse(readFileSync(suitePassFile(stateDir), 'utf8'));
  } catch (error) {
    return `no ${error.code === 'ENOENT' ? '' : 'readable '}record that the whole orch suite passed (${suitePassFile(stateDir)}), ${tree}; ${remedy}`;
  }
  if (record?.hash === hash) return null;
  return `the whole orch suite last passed on different suite inputs (record ${String(record?.hash).slice(0, 16)} of ${record?.at}, ${tree}); ${remedy}`;
}
