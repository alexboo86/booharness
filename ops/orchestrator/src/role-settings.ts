// Operator-owned per-role skill and MCP settings, backed by the existing JSON SSOT files.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { leadWriteAllowed, readJson, sendJson } from './http-leads.ts';
import { excludedSkillNames, listClass, listSkillDirs, mcpServerIds, skillProblems } from '../../../scripts/lib/harness-config.mjs';
import { SettingsError, type SettingsStore, type SettingsLinkAdapter, type SettingsPublication, type SettingValue, type SettingDefinition } from './settings/index.ts';

const DEFAULT_REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BODY_LIMIT = 64 * 1024;
const LICENSE_MARKERS = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'];
/** Classes listClass can derive back from the map's lists; others (stack, method) are not recoverable once changed. */
const LIST_DERIVED_CLASSES = new Set(['core', 'product', 'lead']);

type RoleSettings = {
  roles: Record<string, { skills: string[]; mcp: string[] }>;
  catalogue: { skills: string[]; mcp: string[] };
};

type Sources = ReturnType<typeof readSources>;

class RoleSettingsError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function objectJson(text: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`${label} must be an array of strings`);
  return value as string[];
}

function readSources(repoRoot: string) {
  const skillPath = path.join(repoRoot, '.agents/domains/_skill-map.json');
  const mcpPath = path.join(repoRoot, 'ops/orchestrator/mcp-by-role.json');
  const skillText = readFileSync(skillPath, 'utf8');
  const mcpText = readFileSync(mcpPath, 'utf8');
  const skillMap = objectJson(skillText, 'skill map');
  const defaults = objectJson(JSON.stringify(skillMap.roleDefaults ?? null), 'roleDefaults');
  const mcpByRole = objectJson(mcpText, 'MCP role table');
  return { repoRoot, skillPath, mcpPath, skillText, mcpText, defaults, mcpByRole };
}

function approvedSkills(repoRoot: string): string[] {
  const root = path.join(repoRoot, '.agents/skills');
  const allowlist = readFileSync(path.join(repoRoot, 'docs/agent/harness-allowlist.md'), 'utf8');
  const vendored = new Set([...allowlist.matchAll(/\.agents\/skills\/([A-Za-z0-9._-]+)\/PROVENANCE\.md/g)].map((match) => match[1]));
  const approved: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(path.join(root, entry.name, 'SKILL.md'))) continue;
    const markers = ['PROVENANCE.md', ...LICENSE_MARKERS].some((marker) => existsSync(path.join(root, entry.name, marker)));
    if (!markers || vendored.has(entry.name)) approved.push(entry.name);
  }
  return approved.sort();
}

function registryServers(repoRoot: string, filename: string): string[] {
  const file = path.join(repoRoot, 'ops/bootstrap', filename);
  if (!existsSync(file)) return [];
  const registry = objectJson(readFileSync(file, 'utf8'), filename);
  const servers = objectJson(JSON.stringify(registry.servers ?? {}), `${filename} servers`);
  return Object.entries(servers).filter(([, spec]) => spec === null || typeof spec !== 'object' || !('disabled' in spec) || !spec.disabled).map(([name]) => name);
}

function registryMcpIds(repoRoot: string): Set<string> {
  const file = path.join(repoRoot, 'ops/bootstrap/mcp-servers.json');
  return mcpServerIds(existsSync(file) ? objectJson(readFileSync(file, 'utf8'), 'mcp-servers.json') : {});
}

function model(sources: Sources): RoleSettings {
  const names = [...new Set([...Object.keys(sources.defaults), ...Object.keys(sources.mcpByRole)])];
  const roles = Object.fromEntries(names.map((role) => [role, {
    skills: stringArray(sources.defaults[role] ?? [], `${role} skills`),
    mcp: stringArray(sources.mcpByRole[role] ?? [], `${role} MCP servers`),
  }]));
  return {
    roles,
    catalogue: {
      skills: approvedSkills(sources.repoRoot),
      mcp: [...new Set([...registryServers(sources.repoRoot, 'mcp-servers.json'), ...registryServers(sources.repoRoot, 'mcp-servers.operator.json')])].sort(),
    },
  };
}

function skipSpace(text: string, from: number): number {
  let at = from;
  while (/\s/.test(text[at] ?? '')) at++;
  return at;
}

function stringEnd(text: string, from: number): number {
  let at = from + 1;
  while (at < text.length) {
    if (text[at] === '\\') at += 2;
    else if (text[at++] === '"') return at;
  }
  throw new Error('unterminated JSON string');
}

function compoundValueEnd(text: string, from: number): number {
  const close = text[from] === '{' ? '}' : ']';
  let depth = 0;
  let at = from;
  while (at < text.length) {
    if (text[at] === '"') at = stringEnd(text, at);
    else {
      if (text[at] === text[from]) depth++;
      else if (text[at] === close && --depth === 0) return at + 1;
      at++;
    }
  }
  throw new Error('unterminated JSON value');
}

function valueEnd(text: string, from: number): number {
  if (text[from] === '"') return stringEnd(text, from);
  if (text[from] === '{' || text[from] === '[') return compoundValueEnd(text, from);
  let at = from;
  while (at < text.length && !/[\s,\]}]/.test(text[at])) at++;
  return at;
}

/** Locate one property value without rendering any other part of the JSON document. */
function propertySpan(text: string, keys: string[], from = 0): { start: number; end: number } {
  let at = skipSpace(text, from);
  if (text[at++] !== '{') throw new Error(`${keys.join('.')} parent must be a JSON object`);
  while (at < text.length) {
    at = skipSpace(text, at);
    if (text[at] === '}') break;
    if (text[at] !== '"') throw new Error('JSON object key must be a string');
    const keyEnd = stringEnd(text, at);
    const key = JSON.parse(text.slice(at, keyEnd)) as string;
    at = skipSpace(text, keyEnd);
    if (text[at++] !== ':') throw new Error('JSON object key must have a value');
    const start = skipSpace(text, at);
    const end = valueEnd(text, start);
    if (key === keys[0]) {
      if (keys.length === 1) return { start, end };
      return propertySpan(text, keys.slice(1), start);
    }
    at = skipSpace(text, end);
    if (text[at] === ',') at++;
    else break;
  }
  throw new Error(`missing JSON property ${keys.join('.')}`);
}

function replacementArray(raw: string, text: string, start: number, names: string[]): string {
  if (!/[\r\n]/.test(raw) || names.length === 0) return `[${names.map((name) => JSON.stringify(name)).join(', ')}]`;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, start))?.[0] ?? '';
  return `[${eol}${names.map((name) => `${indent}  ${JSON.stringify(name)}`).join(`,${eol}`)}${eol}${indent}]`;
}

function replaceRoleArray(text: string, keys: string[], names: string[]): string {
  const span = propertySpan(text, keys);
  const raw = text.slice(span.start, span.end);
  stringArray(JSON.parse(raw), keys.join('.'));
  return text.slice(0, span.start) + replacementArray(raw, text, span.start, names) + text.slice(span.end);
}

/** The class a skill entry carries today, or undefined when it has no readable entry. */
function currentClassOf(map: Record<string, unknown>, name: string): unknown {
  const entry = (map.skills as Record<string, unknown> | undefined)?.[name];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>).class : undefined;
}

/** Rewrite skills.<name>.class for membership changes, refusing changes the map could not restore. */
function recomputeChangedClasses(
  text: string,
  map: Record<string, unknown>,
  changed: string[],
  lists: { roleDefaults: Set<string>; excluded: Set<string>; leadInstalled: Set<string> },
): string {
  for (const name of changed) {
    const classification = listClass(name, lists.roleDefaults, lists.excluded, lists.leadInstalled);
    if (classification === null) throw new RoleSettingsError(400, `skill '${name}' would have no class`);
    const currentClass = currentClassOf(map, name);
    if (typeof currentClass === 'string' && !LIST_DERIVED_CLASSES.has(currentClass)) {
      throw new RoleSettingsError(400, `skill '${name}' has class '${currentClass}' that is not derived from list membership; changing it to '${classification}' is refused because the previous class could not be restored from the map`);
    }
    const span = propertySpan(text, ['skills', name, 'class']);
    text = text.slice(0, span.start) + JSON.stringify(classification) + text.slice(span.end);
  }
  return text;
}

function excludedSkills(repoRoot: string): Set<string> {
  const file = path.join(repoRoot, 'ops/harness-kit/excluded-skills.json');
  return existsSync(file) ? excludedSkillNames(readFileSync(file, 'utf8')) : new Set<string>();
}

/** Refuse the write when the computed map would fail the skill-map checker. */
function assertCheckerPasses(text: string, repoRoot: string): void {
  const problems = skillProblems({
    map: objectJson(text, 'skill map'),
    skillNames: listSkillDirs(path.join(repoRoot, '.agents/skills')).names,
    excluded: excludedSkills(repoRoot),
    mcpIds: registryMcpIds(repoRoot),
  });
  if (problems.length) throw new RoleSettingsError(400, `computed skill map would fail check-skill-map: ${problems.join('; ')}`);
}

function skillMapWithRole(sources: Sources, role: string, skills: string[], finalDefaults?: Set<string>): string {
  let text = replaceRoleArray(sources.skillText, ['roleDefaults', role], skills);
  const map = objectJson(text, 'skill map');
  const defaults = objectJson(JSON.stringify(map.roleDefaults), 'roleDefaults');
  const roleDefaults = finalDefaults ?? new Set(Object.values(defaults).flatMap((names) => stringArray(names, 'role skills')));
  const leadInstalled = new Set(stringArray(map.leadInstalledSkills ?? [], 'leadInstalledSkills'));
  const excluded = excludedSkills(sources.repoRoot);
  const previous = new Set(stringArray(sources.defaults[role], `${role} skills`));
  const next = new Set(skills);
  const changed = [...new Set([...previous, ...next])].filter((name) => previous.has(name) !== next.has(name));
  text = recomputeChangedClasses(text, map, changed, { roleDefaults, excluded, leadInstalled });
  // A batch can temporarily move a skill out of every role; validate its final map below.
  if (!finalDefaults) assertCheckerPasses(text, sources.repoRoot);
  return text;
}

function requestedNames(value: unknown, field: 'skills' | 'mcp', catalogue: string[]): string[] {
  const names = stringArray(value, field);
  if (new Set(names).size !== names.length) throw new RoleSettingsError(400, `${field} must not contain duplicates`);
  const approved = new Set(catalogue);
  for (const name of names) {
    if (!approved.has(name)) throw new RoleSettingsError(400, `unknown ${field === 'skills' ? 'skill' : 'MCP server'} '${name}'`);
  }
  return names;
}

function planRole(sources: Sources, current: RoleSettings, role: string, body: unknown, finalDefaults?: Set<string>) {
  if (!Object.hasOwn(current.roles, role)) throw new RoleSettingsError(404, `unknown role '${role}'`);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new RoleSettingsError(400, 'body must be a JSON object');
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'skills' && key !== 'mcp')) throw new RoleSettingsError(400, 'body takes only skills and mcp');
  const skills = requestedNames(input.skills, 'skills', current.catalogue.skills);
  const mcp = requestedNames(input.mcp, 'mcp', current.catalogue.mcp);
  const skillText = skillMapWithRole(sources, role, skills, finalDefaults);
  const mcpText = replaceRoleArray(sources.mcpText, [role], mcp);
  const plans: SettingsPublication[] = [
    ...(skillText === sources.skillText ? [] : [{ file: sources.skillPath, text: skillText, before: sources.skillText }]),
    ...(mcpText === sources.mcpText ? [] : [{ file: sources.mcpPath, text: mcpText, before: sources.mcpText }]),
  ];
  return { result: { role, skills, mcp }, plans };
}

async function write(sources: Sources, current: RoleSettings, role: string, body: unknown, settings: SettingsStore) {
  const { result } = planRole(sources, current, role, body);
  const { revision } = await settings.listSettings();
  await settings.putSettings({ [`roles.${role}.skills`]: result.skills, [`roles.${role}.mcp`]: result.mcp }, revision, 'operator');
  return result;
}

/** Link scope owns no copy of role values: both surfaces read and edit S2a's original files. */
export function createRoleSettingsAdapter(repoRoot = DEFAULT_REPO): SettingsLinkAdapter {
  return {
    read() {
      const sources = readSources(repoRoot);
      const current = model(sources);
      const values: Record<string, SettingValue> = {};
      const definitions: SettingDefinition[] = [];
      for (const [role, value] of Object.entries(current.roles)) {
        for (const field of ['skills', 'mcp'] as const) {
          const key = `roles.${role}.${field}`;
          values[key] = value[field];
          definitions.push({ key, label: `${field === 'skills' ? 'Skills' : 'MCP servers'} for ${role}`, category: 'roles',
            group: 'tools', tier: 'advanced', control: 'list', class: 'operator-only', scope: 'link', type: 'list', default: value[field],
            options: [...new Set([...current.catalogue[field], ...value[field]])], apply: 'next-seat',
            help: `Approved ${field} for the ${role} role.`, reads: '/api/role-settings; seat context and MCP selection' });
        }
      }
      const source = Object.fromEntries(definitions.map(({ key }) => [key, key.endsWith('.skills') ? sources.skillPath : sources.mcpPath]));
      return { definitions, values, source, fingerprint: JSON.stringify([sources.skillText, sources.mcpText, current.catalogue]) };
    },
    prepare(changes) { return prepareRoleLinks(repoRoot, changes); },
  };
}

function prepareRoleLinks(repoRoot: string, changes: Record<string, SettingValue>): SettingsPublication[] {
  const original = readSources(repoRoot);
  let staged = original;
  const roles = model(original).roles;
  const edits = new Map<string, { skills: string[]; mcp: string[] }>();
  for (const [key, value] of Object.entries(changes)) {
    const match = /^roles\.(.+)\.(skills|mcp)$/.exec(key);
    if (!match || !Object.hasOwn(roles, match[1])) throw new RoleSettingsError(400, `${key}: unknown role setting`);
    const [, role, field] = match;
    const next = edits.get(role) ?? structuredClone(roles[role]);
    next[field as 'skills' | 'mcp'] = value as string[];
    edits.set(role, next);
  }
  // Class membership is a property of the final batch, not an intermediate role edit.
  const finalRoles = { ...roles, ...Object.fromEntries(edits) };
  const finalDefaults = new Set(Object.values(finalRoles).flatMap((entry) => entry.skills));
  for (const [role, next] of edits) {
    const { plans } = planRole(staged, model(staged), role, next, finalDefaults);
    for (const plan of plans) {
      if (plan.file === staged.skillPath) staged = { ...staged, skillText: plan.text, defaults: objectJson(JSON.stringify(objectJson(plan.text, 'skill map').roleDefaults), 'roleDefaults') };
      else staged = { ...staged, mcpText: plan.text, mcpByRole: objectJson(plan.text, 'MCP role table') };
    }
  }
  assertCheckerPasses(staged.skillText, repoRoot);
  return [
    { file: original.skillPath, before: original.skillText, text: staged.skillText },
    { file: original.mcpPath, before: original.mcpText, text: staged.mcpText },
  ].filter((plan) => plan.text !== plan.before);
}

function routeRole(pathname: string): string | null {
  const encoded = pathname.slice('/api/role-settings/'.length);
  if (!encoded || encoded.includes('/')) return null;
  return decodeURIComponent(encoded);
}

/** The connection's real port: the daemon's single loopback listener, never a header value. Fail-closed when unavailable. */
function writeAllowed(req: IncomingMessage): boolean {
  const port = req.socket?.localPort;
  return typeof port === 'number' && leadWriteAllowed(req, port);
}

/** GET the complete model and PUT one role; unrelated routes return false for the main listener. */
type RouteState = { repoRoot: string; writes: Promise<void>; getSettings: () => SettingsStore };

/** One PUT: the write guard first, then the serialized role write. */
async function putRole(state: RouteState, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!writeAllowed(req)) {
    sendJson(res, 403, { error: 'role-settings writes require the daemon origin and X-Orch-Chat: 1' });
    return;
  }
  const role = routeRole(url.pathname);
  if (role === null) {
    sendJson(res, 404, { error: 'unknown role' });
    return;
  }
  const body = await readJson(req, BODY_LIMIT);
  const operation = state.writes.then(() => {
    const sources = readSources(state.repoRoot);
    return write(sources, model(sources), role, body, state.getSettings());
  });
  state.writes = operation.then(() => undefined, () => undefined);
  sendJson(res, 200, await operation);
}

function roleSettingsStatus(error: unknown): number {
  return error instanceof RoleSettingsError || error instanceof SettingsError ? error.status : 400;
}

/** GET the complete model and PUT one role through the shared settings store. */
export function createRoleSettingsRoutes({ repoRoot = DEFAULT_REPO, getSettings }: { repoRoot?: string; getSettings: () => SettingsStore }) {
  const state: RouteState = { repoRoot, writes: Promise.resolve(), getSettings };
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const collection = url.pathname === '/api/role-settings';
    const item = url.pathname.startsWith('/api/role-settings/');
    if (!collection && !item) return false;
    try {
      if (collection && req.method === 'GET') {
        await state.writes;
        sendJson(res, 200, model(readSources(repoRoot)));
        return true;
      }
      if (!item || req.method !== 'PUT') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      await putRole(state, req, res, url);
    } catch (error) {
      sendJson(res, roleSettingsStatus(error), { error: (error as Error).message });
    }
    return true;
  };
}
