// Supervised-lead HTTP routes and the request primitives shared with the main listener.
import path from 'node:path';
import { statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { LeadDriver, LEAD_ID_PATTERN, LEAD_PERMISSION_TOOL, permissionToolCall, type LeadStartSpec } from './lead-driver.ts';
import { FAMILIES, type Family } from './providers/index.ts';
import { readInstallSetting } from './settings/index.ts';

/** The hostname of a Host header value, without its port. */
export function hostOf(value: string): string {
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':')[0];
}

export const str = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
};

/** One file of a task file list: repo-relative, bounded, with no traversal segment. */
function parseTaskFile(file: unknown): string {
  if (typeof file !== 'string' || !file.trim() || file.length > 512) throw new Error('files must be repo-relative paths of at most 512 characters');
  const normalized = file.replaceAll('\\', '/');
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || file.startsWith('\\') || /^[A-Za-z]:/.test(file) || normalized.split('/').includes('..')) {
    throw new Error('files must be an array of repo-relative paths');
  }
  return normalized;
}

/** One trust boundary for both MCP file lists and the lesson promote anchor: reject absolute/escaping paths before using them for routing. */
export function parseTaskFiles(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('files must be an array of repo-relative paths');
  if (value.length > 200) throw new Error('files may contain at most 200 paths');
  return value.map(parseTaskFile);
}

/** One optional per-start field (family, model or effort): 1-200 printable ASCII characters that
 *  cannot read as a command-line flag of the child. */
function optStr(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const text = str(value, name);
  if (text.length > 200 || !/^[ -~]+$/.test(text)) throw new Error(`${name} must be 1-200 printable ASCII characters`);
  if (text.startsWith('-')) throw new Error(`${name} must not start with a dash`);
  return text;
}

export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error(`body over ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The supervised-lead endpoints' writer guard: the daemon's exact origin plus the board's header. Shared with the role-settings PUT routes, the quality routes and the lessons routes. */
export function leadWriteAllowed(req: IncomingMessage, port: number): boolean {
  if (!req.headers.host) return false;
  const ownOrigin = new URL(`http://${hostOf(req.headers.host!)}:${port}`).origin;
  return req.headers.origin === ownOrigin && req.headers['x-orch-chat'] === '1';
}

/** Read one lead-route POST body: a JSON object whose keys are all in `allowed`. */
export async function leadBody(req: IncomingMessage, allowed: readonly string[], limit = 16 * 1024): Promise<Record<string, unknown>> {
  const raw = await readJson(req, limit);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('body must be a JSON object');
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new Error(`lead route takes no '${key}'`);
  return body;
}

/** POST /api/leads: a bounded ASCII id, an existing absolute directory, an optional provider
 *  (claude, codex or pi) and optional per-start family/model/effort (task 3459 L0c); pi needs a
 *  family, codex implies family codex and takes model and effort like pi (task 3535 L0d), and
 *  nothing reaches a shell. */
async function leadCreate(leads: LeadDriver, req: IncomingMessage): Promise<unknown> {
  const body = await leadBody(req, ['id', 'cwd', 'provider', 'family', 'model', 'effort']);
  const id = str(body.id, 'id');
  if (!LEAD_ID_PATTERN.test(id)) throw new Error('id must be 1-64 characters of ASCII letters, digits, dot, underscore or hyphen, starting with a letter or digit');
  const cwd = str(body.cwd, 'cwd');
  if (!path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
  if (!statSync(cwd).isDirectory()) throw new Error(`cwd is not an existing directory: ${cwd}`);
  const { provider, spec } = leadStartChoice(body);
  leads.start(id, cwd, provider, spec);
  return leads.list().find((row) => row.id === id);
}

/** The provider of one create body and its per-start choice; each provider's field rule is
 *  leadStartFields' own. */
function leadStartChoice(body: Record<string, unknown>): { provider: 'claude' | 'codex' | 'pi'; spec: LeadStartSpec } {
  const provider = body.provider === undefined ? 'claude' : str(body.provider, 'provider');
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'pi') throw new Error('provider must be claude, codex or pi');
  const spec = leadStartSpec(body);
  leadStartFields(provider, spec);
  return { provider, spec };
}

/** One provider's per-start field rule: pi needs a family; codex implies family codex and takes
 *  model and effort (task 3535 L0d); claude takes no per-start fields, so it refuses them rather
 *  than drop them in silence. */
function leadStartFields(provider: 'claude' | 'codex' | 'pi', spec: LeadStartSpec): void {
  if (provider === 'pi' && spec.family === undefined) throw new Error("provider 'pi' needs a family");
  if (provider === 'codex' && spec.family !== undefined && spec.family !== 'codex') throw new Error("provider 'codex' runs family codex; name provider 'pi' for another family");
  if (provider === 'claude' && Object.keys(spec).length > 0) throw new Error("provider 'claude' takes no family, model or effort");
}

/** The bounded per-start family/model/effort of one create body (task 3459 L0c); a family must
 *  name a provider family with a Pi route. */
function leadStartSpec(body: Record<string, unknown>): LeadStartSpec {
  const family = optStr(body.family, 'family');
  if (family !== undefined && !FAMILIES.includes(family as Family)) throw new Error(`family must name one of ${FAMILIES.join(', ')}`);
  const model = optStr(body.model, 'model');
  // The gate matches `entry:` as a prefix, so a colon here would pass an exact-model entry.
  if (model?.includes(':')) throw new Error('model must not contain a colon');
  const effort = optStr(body.effort, 'effort');
  return {
    ...(family !== undefined ? { family: family as Family } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

/** POST /api/leads/:id/send: one non-empty user turn of at most 100000 characters. */
function leadSend(leads: LeadDriver, id: string, body: Record<string, unknown>): unknown {
  const text = str(body.text, 'text');
  if (text.length > 100_000) throw new Error('text must be at most 100000 characters');
  if (!leads.send(id, text)) throw new Error(`lead ${id} is not running`);
  return { id, sent: true };
}

/** POST /api/leads/:id/permission/:request: allow or deny one pending card. */
function leadPermission(leads: LeadDriver, id: string, requestId: string, body: Record<string, unknown>): unknown {
  const decision = str(body.decision, 'decision');
  if (decision !== 'allow' && decision !== 'deny') throw new Error('decision must be allow or deny');
  const message = leadPermissionMessage(body, decision);
  if (!leads.resolvePermission(id, requestId, decision, message)) throw new Error(`no pending permission ${requestId} for lead ${id}`);
  return { id, request: requestId, decision };
}

function leadPermissionMessage(body: Record<string, unknown>, decision: string): string | undefined {
  if (body.message === undefined) return undefined;
  if (decision === 'allow') throw new Error('an allow takes no message');
  const message = str(body.message, 'message');
  if (message.length > 2_000) throw new Error('message must be at most 2000 characters');
  return message;
}

/** Operator-set extra argv for supervised children (task 3466 smoke): bounded printable strings only, never a shell. */
export function leadArgList(raw: string[] | undefined): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 32) throw new Error('leadArgs must be an array of at most 32 strings');
  for (const arg of raw) if (typeof arg !== 'string' || arg.length < 1 || arg.length > 200 || arg.includes('\0')) throw new Error('leadArgs entries must be strings of 1-200 characters without NUL');
  return [...raw];
}

/** Handle POST /api/leads, /api/leads/:id/{send,stop}, /api/leads/:id/permission/:request. */
async function serveLeadPost(leads: LeadDriver, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const segments = url.pathname.slice('/api/leads'.length).split('/').filter(Boolean);
  try {
    if (!segments.length) {
      sendJson(res, 200, await leadCreate(leads, req));
      return;
    }
    const [id, action, requestId] = segments;
    if (!LEAD_ID_PATTERN.test(id)) throw new Error('unknown lead');
    sendJson(res, 200, await leadAction(leads, req, id, action, requestId, url));
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
  }
}

/** One lead action route: send, stop, or a permission decision. */
async function leadAction(leads: LeadDriver, req: IncomingMessage, id: string, action: string, requestId: string | undefined, url: URL): Promise<unknown> {
  if (action === 'send' && requestId === undefined) return leadSend(leads, id, await leadBody(req, ['text'], 1024 * 1024));
  if (action === 'stop' && requestId === undefined) return leadStop(leads, id);
  if (action === 'permission' && requestId !== undefined) {
    if (!LEAD_ID_PATTERN.test(requestId)) throw new Error('unknown permission request');
    return leadPermission(leads, id, requestId, await leadBody(req, ['decision', 'message']));
  }
  throw new Error(`unknown lead route ${url.pathname}`);
}

/** POST /api/leads/:id/stop: end one lead's child; there is no restart after it. */
function leadStop(leads: LeadDriver, id: string): unknown {
  if (leads.status(id) === null) throw new Error(`unknown lead ${id}`);
  leads.stop(id);
  return { id, status: leads.status(id) };
}

/** GET /api/leads/models: what a lead start may name now (task 3459 L0c) — the leads.models
 *  install setting read per request through the same reader the gate uses; null (the default)
 *  means a start is unrestricted. An unreadable settings document answers an error status
 *  naming the cause, never an empty list. */
function serveLeadModels(res: ServerResponse, stateDir: string | undefined): void {
  try {
    const allowed = stateDir === undefined ? null : readInstallSetting(stateDir, 'leads.models') as string[] | null;
    sendJson(res, 200, { models: allowed });
  } catch (error) {
    sendJson(res, 500, { error: `leads.models could not be read: ${(error as Error).message}` });
  }
}

/** The /api/leads routes and the /mcp lead binding: GET lists and reads what a start may name,
 *  every POST needs the daemon origin and X-Orch-Chat: 1. */
export async function serveLeadRoutes(leads: LeadDriver, req: IncomingMessage, res: ServerResponse, url: URL, port: () => number, mcp: () => Promise<void>, stateDir?: string): Promise<boolean> {
  if (url.pathname.startsWith('/api/leads')) {
    if (req.method === 'GET') {
      if (url.pathname === '/api/leads') {
        sendJson(res, 200, { leads: leads.list() });
        return true;
      }
      if (url.pathname === '/api/leads/models') {
        serveLeadModels(res, stateDir);
        return true;
      }
    }
    if (req.method !== 'POST') {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    if (typeof port !== 'function' || !leadWriteAllowed(req, port())) {
      sendJson(res, 403, { error: 'lead routes require the daemon origin and X-Orch-Chat: 1' });
      return true;
    }
    await serveLeadPost(leads, req, res, url);
    return true;
  }
  if (url.pathname !== '/mcp') return false;
  await mcp();
  return true;
}

/** The MCP server a supervised lead child reaches at /mcp?lead=<id>: one tool, bound to that lead. */
export function buildLeadMcpServer(lead: string, leads: LeadDriver, version: string): Server {
  const server = new Server({ name: 'orch', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: LEAD_PERMISSION_TOOL, description: 'Ask the operator whether one tool call of this supervised lead may run.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, tool_input: { type: 'object' } }, required: ['tool_name'] } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== LEAD_PERMISSION_TOOL) return { isError: true, content: [{ type: 'text', text: `unknown tool ${request.params.name}` }] };
    const result = await permissionToolCall(leads, lead, (request.params.arguments ?? {}) as Record<string, unknown>);
    if ('error' in result) return { isError: true, content: [{ type: 'text', text: result.error }] };
    return { content: [{ type: 'text', text: JSON.stringify(result.answer) }], structuredContent: result.answer as Record<string, unknown> };
  });
  return server;
}
