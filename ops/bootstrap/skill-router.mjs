import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessPaths, readHarnessConfig } from '../../scripts/lib/harness-config.mjs';
import YAML from 'yaml';
import { ask as askJev, jevFailureReason, JEV_MODEL } from './jev-client.mjs';
import { extractTask } from './jev-gate.mjs';
import { domainsOfFiles } from './knowledge-page-lib.mjs';

const MAP = new URL('../../.agents/domains/_skill-map.json', import.meta.url);
const ROUTING = new URL('../../docs/agent/domain-routing.generated.json', import.meta.url);
/** A candidate stays at or above this need probability (the regression set reads it). */
export const NEED_P = 0.6;
/** A jevAdds trigger's skill the map did not select is added only at or above this probability. */
export const ADD_P = 0.75;
const hash = (text) => createHash('sha256').update(text).digest('hex');
export const questionKey = (name) => `need_${name.replace(/[^a-z0-9_]/gi, '_')}`;

export function describe(name, catalogue = fileURLToPath(new URL('../../.agents/skills', import.meta.url))) {
  // Names come from the local map, never from Jev. Keep their file read local.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Invalid skill name');
  const body = readFileSync(join(catalogue, name, 'SKILL.md'), 'utf8');
  const front = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const description = front && YAML.parse(front[1])?.description;
  if (typeof description !== 'string' || !description.trim()) throw new Error(`Missing description: ${name}`);
  const plain = description.replace(/\s+/g, ' ').trim();
  const first = new Intl.Segmenter('en', { granularity: 'sentence' }).segment(plain)[Symbol.iterator]().next().value.segment.trim();
  return { name, description: [...first].slice(0, 160).join(''), questionDescription: description.slice(0, 400) };
}

/** The map's own candidates — role defaults, file domains and (negation-stripped) triggers. Jev only removes from these. */
export function mapCandidates({ role, files = [], brief, map = MAP,
  repoRoot = fileURLToPath(new URL('../..', import.meta.url)),
} = {}) {
  const mapText = typeof map === 'string' || map instanceof URL
    ? readFileSync(map, 'utf8') : JSON.stringify(map);
  const skillMap = JSON.parse(mapText);
  const off = new Set(readHarnessConfig({ repoRoot }).skills?.off ?? []);
  const names = new Set((skillMap.roleDefaults[role] || []).filter((name) => !off.has(name)));
  const routingText = readFileSync(ROUTING, 'utf8');
  const task = extractTask(brief);
  for (const domain of domainsOfFiles(files, JSON.parse(routingText))) {
    const entry = skillMap.domains[domain.replace(/^domain-/, '')] || {};
    for (const name of [...(entry.all || []), ...(entry[role] || [])]) names.add(name);
  }
  const plain = skillMap.negation ? task.replace(new RegExp(skillMap.negation, 'giu'), ' ') : task;
  for (const trigger of skillMap.triggers) {
    if (trigger.roles.includes(role)
      && new RegExp(trigger.match, 'iu').test(trigger.negatable ? plain : task)) {
      for (const name of trigger.skills) names.add(name);
    }
  }
  // jevAdds triggers whose regex missed: Jev may still add their skills at the ADD_P bar.
  const addable = new Set();
  for (const trigger of skillMap.triggers) {
    if (trigger.jevAdds === true && trigger.roles.includes(role)) {
      for (const name of trigger.skills) if (!names.has(name)) addable.add(name);
    }
  }
  for (const name of off) {
    names.delete(name);
    addable.delete(name);
  }
  return { names, addable, mapText, routingText };
}

/** The add pass: its own request and its own cache entry; any failure adds nothing. */
async function addSkills({ brief, role, addable, mapText, ask, timeoutMs, cacheDir }) {
  if (!addable.size) return [];
  const descriptions = [...addable].map((name) => describe(name));
  const candidates = descriptions.map(({ name, description }) => ({ name, description }));
  const questions = Object.fromEntries(descriptions.map(({ name, questionDescription }) => [questionKey(name), {
    type: 'noul', instructions: `Does this task need the skill '${name}'? The skill: ${questionDescription}`,
  }]));
  const key = hash(JSON.stringify([2, brief, role, hash(mapText), candidates, questions]));
  const cacheFile = cacheDir ? join(cacheDir, `adds-${key}.json`) : null;
  if (cacheFile) {
    try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (saved?.model === JEV_MODEL && Array.isArray(saved.added)
        && saved.added.every((name) => typeof name === 'string' && addable.has(name))) {
        return candidates.filter(({ name }) => saved.added.includes(name));
      }
    } catch { /* Missing, interrupted or unreadable cache: ask Jev. */ }
  }
  let result;
  try { result = await ask({ text: brief, questions, ...(timeoutMs === undefined ? {} : { timeoutMs }) }); }
  catch { return []; }
  if (result?.error || !result?.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) return [];
  const added = candidates.filter(({ name }) => {
    const p = result.answers[questionKey(name)]?.noul;
    // Unlike the removal pass, an unanswered (or malformed) probability adds nothing.
    return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 && p >= ADD_P;
  });
  if (cacheFile) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      if (typeof result.model === 'string') {
        writeFileSync(cacheFile, JSON.stringify({ model: result.model, added: added.map(({ name }) => name) }), { mode: 0o600 });
      }
    } catch { /* A cache write failure does not change a successful selection. */ }
  }
  return added;
}

/** Map candidates first; Jev can only remove candidates, never a role default. Cache contains names, not task text. */
export async function route({ role, files = [], brief, map = MAP, ask = askJev, timeoutMs,
  repoRoot = fileURLToPath(new URL('../..', import.meta.url)),
  cacheDir = join(harnessPaths({ home: homedir(), prefix: readHarnessConfig({ repoRoot }).names.prefix }).cacheDir, 'skill-router'),
} = {}) {
  const { names, addable, mapText, routingText } = mapCandidates({ role, files, brief, map, repoRoot });
  const descriptions = [...names].map((name) => describe(name));
  const candidates = descriptions.map(({ name, description }) => ({ name, description }));
  const fallback = { skills: candidates, source: 'map', model: null };
  // A role default survives every Jev answer, including an answer cached before this rule (task 2275 slice S1b-2).
  const defaults = new Set(JSON.parse(mapText).roleDefaults?.[role] ?? []);
  // The add pass runs after the candidate flow, whatever it decided (even with no candidates).
  const withAdds = async (base) => {
    const added = await addSkills({ brief, role, addable, mapText, ask, timeoutMs, cacheDir });
    return added.length ? { ...base, skills: [...base.skills, ...added], added: added.map(({ name }) => name) } : base;
  };
  if (!candidates.length) return withAdds(fallback);
  const questions = Object.fromEntries(descriptions.map(({ name, questionDescription }) => [questionKey(name), {
    type: 'noul', instructions: `Does this task need the skill '${name}'? The skill: ${questionDescription}`,
  }]));
  const key = hash(JSON.stringify([2, brief, [...files].sort(), role, hash(mapText), candidates, questions, hash(routingText)]));
  const cacheFile = cacheDir ? join(cacheDir, `${key}.json`) : null;
  if (cacheFile) {
    try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (saved?.model === JEV_MODEL && Array.isArray(saved.skills)
        && saved.skills.every((name) => typeof name === 'string' && names.has(name))) {
        return withAdds({ skills: candidates.filter(({ name }) => defaults.has(name) || saved.skills.includes(name)), source: 'cache', model: saved.model });
      }
    } catch { /* Missing, interrupted or unreadable cache: ask Jev. */ }
  }
  let result;
  try { result = await ask({ text: brief, questions, ...(timeoutMs === undefined ? {} : { timeoutMs }) }); }
  catch { return withAdds({ ...fallback, reason: 'request-failed' }); }
  if (result?.error || !result?.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) {
    return withAdds({ ...fallback, reason: jevFailureReason(result) });
  }
  const skills = candidates.filter(({ name }) => {
    if (defaults.has(name)) return true;
    const p = result.answers[questionKey(name)]?.noul;
    // An unanswered (or malformed) probability must not silently remove a skill.
    return typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1 || p >= NEED_P;
  });
  if (cacheFile) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      if (typeof result.model === 'string') {
        writeFileSync(cacheFile, JSON.stringify({ model: result.model, skills: skills.map(({ name }) => name) }), { mode: 0o600 });
      }
    } catch { /* A cache write failure does not change a successful selection. */ }
  }
  return withAdds({ skills, source: 'jev', model: typeof result.model === 'string' ? result.model : null });
}
