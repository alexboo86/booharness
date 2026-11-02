#!/usr/bin/env node
// Guards .agents/domains/_skill-map.json, the deterministic skill router input:
// every skill it names exists in .agents/skills, every domain directory has an entry,
// roles are the known seat roles, and every trigger regex compiles without control
// characters (a shell-quoted "\b" once became a backspace and matched nothing).
// The skills key is class and requires data: each canon directory has one entry,
// and a core or product class must match the first list that claims that skill.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { excludedSkillNames, listSkillDirs, mcpServerIds, skillProblems } from './lib/harness-config.mjs';
export { CLASSES, STACKS, excludedSkillNames, listClass, listSkillDirs, mcpServerIds, skillProblems } from './lib/harness-config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Product walls (task 3555): every walled domain exists and names canon skills. */
function noTriggerSkillProblems(map, domainDirs, canon) {
  const problems = [];
  for (const [d, list] of Object.entries(map.noTriggerSkills ?? {})) {
    if (!domainDirs.includes(`domain-${d}`)) problems.push(`noTriggerSkills: no .agents/domains/domain-${d}`);
    if (!Array.isArray(list)) { problems.push(`noTriggerSkills.${d}: not a list`); continue; }
    for (const n of list) if (!canon.has(n)) problems.push(`noTriggerSkills.${d}: unknown skill "${n}"`);
  }
  return problems;
}

/** Product words (task 3555): the fileless wall's words are non-empty strings keyed by an existing domain. */
function noTriggerBriefWordProblems(map, domainDirs) {
  const problems = [];
  for (const [d, words] of Object.entries(map.noTriggerBriefWords ?? {})) {
    if (!domainDirs.includes(`domain-${d}`)) problems.push(`noTriggerBriefWords: no .agents/domains/domain-${d}`);
    if (!Array.isArray(words)) { problems.push(`noTriggerBriefWords.${d}: not a list`); continue; }
    for (const w of words) if (typeof w !== 'string' || !w.trim()) problems.push(`noTriggerBriefWords.${d}: not a word "${w}"`);
  }
  return problems;
}
function run() {
  const map = JSON.parse(readFileSync(join(root, '.agents/domains/_skill-map.json'), 'utf8'));
  const canon = new Set(readdirSync(join(root, '.agents/skills')));
  const domainDirs = readdirSync(join(root, '.agents/domains')).filter((d) => d.startsWith('domain-'));
  const ROLES = ['lead', 'scout', 'critic', 'researcher', 'debater', 'advisor', 'coder', 'tester', 'designer', 'copywriter', 'motion', 'reviewer', 'legal', 'security', 'bughunter'];
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
  problems.push(...noTriggerSkillProblems(map, domainDirs, canon), ...noTriggerBriefWordProblems(map, domainDirs));
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
