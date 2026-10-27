#!/usr/bin/env node
// Guards .agents/domains/_skill-map.json, the deterministic skill router input:
// every skill it names exists in .agents/skills, every domain directory has an entry,
// roles are the known seat roles, and every trigger regex compiles without control
// characters (a shell-quoted "\b" once became a backspace and matched nothing).
// The skills key is class and requires data: each canon directory has one entry,
// and a core or product class must match the first list that claims that skill.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isMain } from './lib/is-main.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLASSES = Object.freeze(['core', 'product', 'lead', 'stack', 'method']);
export const STACKS = Object.freeze(['rust', 'clickhouse', 'qt', 'tauri', 'web']);
const BIN = /^bin:[A-Za-z0-9][A-Za-z0-9+._-]*$/;
const ENTRY_KEYS = new Set(['class', 'stack', 'requires']);

/** The product-skill list, read from the file the kit builder reads (ops/harness-kit/excluded-skills.json), so the check judges that set, not a copy. */
export function excludedSkillNames(source) {
  const names = JSON.parse(String(source));
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name)) throw new Error('excluded-skills.json must be an array of skill names');
  if (!names.length) throw new Error('excluded-skills.json is empty');
  return new Set(names);
}

/** Server ids a requires token may name. A key starting with _ is a note, not a server. */
export function mcpServerIds(registry) {
  const servers = registry && typeof registry === 'object' ? registry.servers : null;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return new Set();
  return new Set(Object.keys(servers).filter((id) => !id.startsWith('_')));
}

/**
 * Real skill directories. A symlink is refused: it is not a directory of this tree
 * (a link named like a skill would admit a file from outside the directory).
 */
export function listSkillDirs(skillsRoot, fs = { readdirSync, lstatSync }) {
  const names = [];
  const problems = [];
  for (const name of fs.readdirSync(skillsRoot)) {
    const st = fs.lstatSync(join(skillsRoot, name));
    if (st.isSymbolicLink()) {
      problems.push(`skills: "${name}" is a symlink, not a directory`);
      continue;
    }
    if (st.isDirectory()) names.push(name);
  }
  return { names, problems };
}

/** First list that claims the skill. Overlap is not a union: roleDefaults wins, then the kit exclusion, then the lead set. */
export function listClass(name, roleDefaults, excluded, leadInstalled) {
  if (roleDefaults.has(name)) return 'core';
  if (excluded.has(name)) return 'product';
  if (leadInstalled.has(name)) return 'lead';
  return null;
}

function tokenProblem(token, mcpIds) {
  if (typeof token !== 'string' || !token) return 'is outside the vocabulary';
  if (BIN.test(token)) return null;
  if (token.startsWith('mcp:')) {
    const id = token.slice(4);
    if (!mcpIds.has(id)) return `is an unknown mcp id "${id}"`;
    return null;
  }
  if (token === 'service:jev' || token === 'service:clickhouse' || token === 'host:win' || token === 'input:image') return null;
  return 'is outside the vocabulary';
}

/**
 * Refusals for the skills key. skillNames is the set of real directories.
 * excluded is the kit list from ops/harness-kit/excluded-skills.json. mcpIds is the server-id set.
 */
export function skillProblems({ map, skillNames, excluded, mcpIds }) {
  const problems = [];
  const skills = map.skills;
  const entries = skills && typeof skills === 'object' && !Array.isArray(skills) ? skills : null;
  if (!entries) problems.push('skills: must be an object');
  const roleDefaults = new Set(Object.values(map.roleDefaults ?? {}).filter(Array.isArray).flat());
  const leadInstalled = new Set(Array.isArray(map.leadInstalledSkills) ? map.leadInstalledSkills : []);
  const dirs = new Set(skillNames);
  for (const name of [...dirs].sort()) {
    if (!entries || !Object.hasOwn(entries, name)) problems.push(`skills: no entry for directory "${name}"`);
  }
  if (!entries) return problems;
  for (const name of Object.keys(entries).sort()) {
    if (!dirs.has(name)) problems.push(`skills: entry "${name}" has no directory`);
    const entry = entries[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`skills.${name}: entry must be an object`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) problems.push(`skills.${name}: unknown key "${key}"`);
    }
    if (!CLASSES.includes(entry.class)) {
      problems.push(`skills.${name}: class ${JSON.stringify(entry.class)} is outside the vocabulary`);
    } else {
      const expected = listClass(name, roleDefaults, excluded, leadInstalled);
      if (expected && entry.class !== expected) {
        problems.push(`skills.${name}: class ${entry.class} disagrees with ${expected} (first matching list)`);
      }
      if (!expected && (entry.class === 'core' || entry.class === 'product' || entry.class === 'lead')) {
        problems.push(`skills.${name}: class ${entry.class} but it is not in that list`);
      }
      if (entry.class === 'stack') {
        if (!STACKS.includes(entry.stack)) problems.push(`skills.${name}: stack ${JSON.stringify(entry.stack)} is outside the vocabulary`);
      } else if (Object.hasOwn(entry, 'stack')) {
        problems.push(`skills.${name}: stack is only valid when class is stack`);
      }
    }
    if (!Array.isArray(entry.requires)) {
      problems.push(`skills.${name}: requires must be a list`);
    } else {
      const seen = new Set();
      for (const token of entry.requires) {
        const why = tokenProblem(token, mcpIds);
        if (why) problems.push(`skills.${name}: requires ${JSON.stringify(token)} ${why}`);
        else if (seen.has(token)) problems.push(`skills.${name}: requires ${JSON.stringify(token)} is duplicated`);
        else seen.add(token);
      }
    }
  }
  return problems;
}

function run() {
  const map = JSON.parse(readFileSync(join(root, '.agents/domains/_skill-map.json'), 'utf8'));
  const canon = new Set(readdirSync(join(root, '.agents/skills')));
  const domainDirs = readdirSync(join(root, '.agents/domains')).filter((d) => d.startsWith('domain-'));
  const ROLES = ['lead', 'scout', 'critic', 'researcher', 'debater', 'advisor', 'coder', 'tester', 'designer', 'copywriter', 'reviewer', 'legal', 'security', 'bughunter'];
  const problems = [];
  const names = (where, list) => {
    if (!Array.isArray(list)) { problems.push(`${where}: not a list`); return; }
    for (const n of list) if (!canon.has(n)) problems.push(`${where}: unknown skill "${n}"`);
  };

  for (const r of map.roles ?? []) if (!ROLES.includes(r)) problems.push(`roles: unknown role "${r}"`);
  for (const [r, list] of Object.entries(map.roleDefaults ?? {})) {
    if (!ROLES.includes(r)) problems.push(`roleDefaults: unknown role "${r}"`);
    names(`roleDefaults.${r}`, list);
  }
  for (const [d, byRole] of Object.entries(map.domains ?? {})) {
    if (!domainDirs.includes(`domain-${d}`)) problems.push(`domains: no .agents/domains/domain-${d}`);
    for (const [r, list] of Object.entries(byRole)) {
      if (r !== 'all' && !ROLES.includes(r)) problems.push(`domains.${d}: unknown role "${r}"`);
      names(`domains.${d}.${r}`, list);
    }
  }
  for (const d of domainDirs) if (!map.domains?.[d.replace(/^domain-/, '')]) problems.push(`domains: ${d} has no entry`);
  for (const t of map.triggers ?? []) {
    names(`triggers.${t.id}`, t.skills);
    for (const r of t.roles ?? []) if (!ROLES.includes(r)) problems.push(`triggers.${t.id}: unknown role "${r}"`);
    // new RegExp(undefined) matches every string, so a missing pattern would fire everywhere.
    if (typeof t.match !== 'string' || !t.match.trim()) { problems.push(`triggers.${t.id}: match must be a non-empty string`); continue; }
    if (/[\u0000-\u001f\u007f]/.test(t.match)) problems.push(`triggers.${t.id}: control character in regex (shell-mangled \\b?)`);
    try { new RegExp(t.match, 'iu'); } catch (e) { problems.push(`triggers.${t.id}: ${e.message}`); }
  }

  if (map.negation !== undefined) {
    if (typeof map.negation !== 'string' || !map.negation.trim()) problems.push('negation: must be a non-empty string');
    else {
      if (/[\u0000-\u001f\u007f]/.test(map.negation)) problems.push('negation: control character in regex');
      try { new RegExp(map.negation, 'giu'); } catch (e) { problems.push(`negation: ${e.message}`); }
    }
  }
  for (const t of map.triggers ?? []) {
    if (t.negatable !== undefined && typeof t.negatable !== 'boolean') problems.push(`triggers.${t.id}: negatable must be boolean`);
    if (t.negatable && !map.negation) problems.push(`triggers.${t.id}: negatable without a top-level negation pattern`);
  }

  // A lead_only or slash-only skill routed to a worker role is a skill that seat cannot use.
  const front = (name) => readFileSync(join(root, '.agents/skills', name, 'SKILL.md'), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const leadOnly = new Set([...canon].filter((n) => /^lead_only:\s*true\b/m.test(front(n))));
  const slashOnly = new Set([...canon].filter((n) => /^disable-model-invocation:\s*true\b/m.test(front(n))));
  const routedTo = (where, list, roles) => {
    for (const n of list ?? []) {
      if (slashOnly.has(n)) problems.push(`${where}: "${n}" is slash-only and cannot be routed`);
      if (leadOnly.has(n) && roles.some((r) => r !== 'lead')) problems.push(`${where}: "${n}" is lead_only but routed to ${roles.filter((r) => r !== 'lead').join(', ')}`);
    }
  };
  for (const [r, list] of Object.entries(map.roleDefaults ?? {})) routedTo(`roleDefaults.${r}`, list, [r]);
  for (const [d, byRole] of Object.entries(map.domains ?? {})) for (const [r, list] of Object.entries(byRole)) routedTo(`domains.${d}.${r}`, list, r === 'all' ? ROLES : [r]);
  for (const t of map.triggers ?? []) routedTo(`triggers.${t.id}`, t.skills, t.roles ?? ROLES);

  const skillsRoot = join(root, '.agents/skills');
  const listed = listSkillDirs(skillsRoot);
  problems.push(...listed.problems);
  const excludedFile = join(root, 'ops/harness-kit/excluded-skills.json');
  let excluded = new Set();
  const hasProduct = Object.values(map.skills ?? {}).some((entry) => entry && entry.class === 'product');
  if (!existsSync(excludedFile)) {
    if (hasProduct) problems.push('skills: excluded skills unreadable (ops/harness-kit/excluded-skills.json missing)');
  } else excluded = excludedSkillNames(readFileSync(excludedFile, 'utf8'));
  const registry = JSON.parse(readFileSync(join(root, 'ops/bootstrap/mcp-servers.json'), 'utf8'));
  problems.push(...skillProblems({
    map, skillNames: listed.names, excluded, mcpIds: mcpServerIds(registry),
  }));

  if (problems.length) {
    console.error(`check-skill-map: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  const skillCount = map.skills && typeof map.skills === 'object' ? Object.keys(map.skills).length : 0;
  console.log(`check-skill-map: OK (${Object.keys(map.domains).length} domains, ${map.triggers.length} triggers, ${canon.size} canon skills, ${skillCount} skill entries)`);
}

if (isMain(import.meta.url)) run();
