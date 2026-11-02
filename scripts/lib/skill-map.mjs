/** Shared skill metadata validation; importing this module performs no filesystem reads. */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const CLASSES = Object.freeze(['core', 'product', 'lead', 'stack', 'method']);
export const STACKS = Object.freeze(['rust', 'clickhouse', 'qt', 'tauri', 'web']);
const BIN = /^bin:[A-Za-z0-9][A-Za-z0-9+._-]*$/;
const ENTRY_KEYS = new Set(['class', 'stack', 'requires']);

/** The kit builder's product-skill list, not a second copy of that set. */
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

/** Real skill directories; symlinks cannot admit files from outside this tree. */
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

/** First list that claims the skill: roleDefaults, kit exclusion, then lead installation. */
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

function classProblems(name, entry, expected, problems) {
  if (!CLASSES.includes(entry.class)) {
    problems.push(`skills.${name}: class ${JSON.stringify(entry.class)} is outside the vocabulary`);
    return;
  }
  if (expected && entry.class !== expected) {
    problems.push(`skills.${name}: class ${entry.class} disagrees with ${expected} (first matching list)`);
  }
  if (!expected && (entry.class === 'core' || entry.class === 'product' || entry.class === 'lead')) {
    problems.push(`skills.${name}: class ${entry.class} but it is not in that list`);
  }
  stackProblems(name, entry, problems);
}

function stackProblems(name, entry, problems) {
  if (entry.class === 'stack') {
    if (!STACKS.includes(entry.stack)) problems.push(`skills.${name}: stack ${JSON.stringify(entry.stack)} is outside the vocabulary`);
  } else if (Object.hasOwn(entry, 'stack')) {
    problems.push(`skills.${name}: stack is only valid when class is stack`);
  }
}

function requiresProblems(name, entry, mcpIds, problems) {
  if (!Array.isArray(entry.requires)) {
    problems.push(`skills.${name}: requires must be a list`);
    return;
  }
  const seen = new Set();
  for (const token of entry.requires) {
    const why = tokenProblem(token, mcpIds);
    if (why) problems.push(`skills.${name}: requires ${JSON.stringify(token)} ${why}`);
    else if (seen.has(token)) problems.push(`skills.${name}: requires ${JSON.stringify(token)} is duplicated`);
    else seen.add(token);
  }
}

function entryProblems(name, entry, expected, mcpIds, problems) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    problems.push(`skills.${name}: entry must be an object`);
    return;
  }
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) problems.push(`skills.${name}: unknown key "${key}"`);
  }
  classProblems(name, entry, expected, problems);
  requiresProblems(name, entry, mcpIds, problems);
}

/** Refusals for the skills key, preserving deterministic directory/entry/token order. */
export function skillProblems({ map, skillNames, excluded, mcpIds }) {
  const problems = [];
  const entries = skillEntries(map.skills);
  if (!entries) problems.push('skills: must be an object');
  const roleDefaults = new Set(Object.values(map.roleDefaults ?? {}).filter(Array.isArray).flat());
  const leadInstalled = new Set(Array.isArray(map.leadInstalledSkills) ? map.leadInstalledSkills : []);
  const dirs = new Set(skillNames);
  missingEntries(entries, dirs, problems);
  if (!entries) return problems;
  for (const name of Object.keys(entries).sort()) {
    if (!dirs.has(name)) problems.push(`skills: entry "${name}" has no directory`);
    entryProblems(name, entries[name], listClass(name, roleDefaults, excluded, leadInstalled), mcpIds, problems);
  }
  return problems;
}

function skillEntries(skills) {
  return skills && typeof skills === 'object' && !Array.isArray(skills) ? skills : null;
}

function missingEntries(entries, dirs, problems) {
  for (const name of [...dirs].sort()) {
    if (!entries || !Object.hasOwn(entries, name)) problems.push(`skills: no entry for directory "${name}"`);
  }
}
