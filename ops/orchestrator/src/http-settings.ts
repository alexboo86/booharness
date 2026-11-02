// Only the guarded loopback listener mounts these routes; MCP shares its runtime-local store.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { initializeSettings, composeSettingsLinks, createRatchetSettingsAdapter, SettingsError, type SettingsStore, type SettingsActor } from './settings/index.ts';
import { createRoleSettingsAdapter } from './role-settings.ts';
import { readJson, sendJson, leadWriteAllowed } from './http-leads.ts';

export const SETTINGS_TOOLS = [
  {
    name: 'settings_get',
    description: 'Read settings schemas, effective values, sources and a CAS revision. With key, read one setting.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'settings_set',
    description: 'On the user’s request, set user-class settings or reset one key/group. Operator-only keys require the guarded BooHarness operator UI. Supply a CAS revision and your live chat session for attribution.',
    inputSchema: {
      type: 'object', properties: { changes: { type: 'object' }, reset: { type: 'object' }, revision: { type: 'string' }, session: { type: 'string' } },
      required: ['revision', 'session'], additionalProperties: false,
    },
  },
];

// Shared MCP argument guard, extracted unchanged from http.ts before extending its tool set.
export function unknownToolArguments(name: string, args: Record<string, unknown>, tools: readonly { name: string; inputSchema: { properties: object } }[]): string | null {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return null;
  const known = Object.keys(tool.inputSchema.properties);
  const unknown = Object.keys(args).filter((key) => !known.includes(key));
  if (!unknown.length) return null;
  const fields = unknown.map((key) => `'${key}'`).join(', ');
  return name === 'seat_create' && unknown.includes('prompt')
    ? `seat_create takes no prompt: create the seat, then call seat_prompt with the brief${unknown.length > 1 ? `; also unknown: ${unknown.filter((key) => key !== 'prompt').map((key) => `'${key}'`).join(', ')}` : ''}`
    : `${name} takes no ${fields}`;
}

function mutateSettings(store: SettingsStore, input: Record<string, unknown>, who: SettingsActor) {
  if (Number(Object.hasOwn(input, 'changes')) + Number(Object.hasOwn(input, 'reset')) !== 1) throw new SettingsError(400, 'settings_set requires exactly one of changes or reset');
  return Object.hasOwn(input, 'reset') ? store.resetSettings(input.reset, input.revision, who) : store.putSettings(input.changes, input.revision, who);
}

export async function callSettingsTool(rt: { stateDir: string }, name: string, args: Record<string, unknown>, resolveLead: (session: unknown) => string | null) {
  if (name !== 'settings_get' && name !== 'settings_set') return null;
  try {
    const store = settingsFor(rt);
    let result;
    if (name === 'settings_set') {
      const lead = resolveLead(args.session);
      if (!lead) throw new SettingsError(403, 'settings_set requires your live chat binding; use chat_join first');
      result = await mutateSettings(store, args, `lead ${lead}`);
    } else result = args.key === undefined ? await store.listSettings() : await store.getSetting(settingKey(args.key));
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] };
  }
}

function settingKey(key: unknown): string {
  if (typeof key !== 'string') throw new SettingsError(400, 'key must be a string');
  return key;
}

type LoopbackRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
export function withRoleSettings(roleSettings: LoopbackRoute, next: LoopbackRoute): LoopbackRoute {
  return async (req, res, url) => (await roleSettings(req, res, url)) || next(req, res, url);
}

const stores = new WeakMap<object, SettingsStore>();
export function settingsFor(rt: { stateDir: string }): SettingsStore {
  let store = stores.get(rt);
  if (!store) {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    store = initializeSettings({ stateDir: rt.stateDir, repoRoot, links: composeSettingsLinks(createRoleSettingsAdapter(repoRoot), createRatchetSettingsAdapter(repoRoot)) });
    stores.set(rt, store);
  }
  return store;
}

async function settingsBody(req: IncomingMessage, allowed: string[]) {
  const body = await readJson(req, 64 * 1024);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SettingsError(400, 'settings body must be an object');
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new SettingsError(400, `settings body takes no '${key}'`);
  }
  return input;
}

async function settingsOperation(operation: string, req: IncomingMessage, store: SettingsStore) {
  if (operation === 'read') return store.listSettings();
  if (operation === 'history') return store.listHistory();
  if (typeof req.socket.localPort !== 'number' || !leadWriteAllowed(req, req.socket.localPort)) throw new SettingsError(403, 'settings writes require the orch origin and X-Orch-Chat: 1');
  if (operation === 'set') {
    const input = await settingsBody(req, ['changes', 'revision']);
    return store.putSettings(input.changes, input.revision, 'operator');
  }
  const { revision, ...selector } = await settingsBody(req, ['key', 'group', 'revision']);
  return store.resetSettings(selector, revision, 'operator');
}

const operations: Record<string, string> = { 'GET /api/settings': 'read', 'GET /api/settings/history': 'history',
  'PUT /api/settings': 'set', 'POST /api/settings/reset': 'reset' };

export function createSettingsRoutes(getStore: () => SettingsStore) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!['/api/settings', '/api/settings/history', '/api/settings/reset'].includes(url.pathname)) return false;
    try {
      const operation = operations[`${req.method} ${url.pathname}`];
      if (!operation) sendJson(res, 405, { error: 'method not allowed' });
      else sendJson(res, 200, await settingsOperation(operation, req, getStore()));
    } catch (error) {
      sendJson(res, error instanceof SettingsError ? error.status : 400, { error: (error as Error).message });
    }
    return true;
  };
}
