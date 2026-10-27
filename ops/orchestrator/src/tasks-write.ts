// Write routes for the task board (TASKS-BOARD.md). Thin validated proxies:
// the browser never calls memoryd. The lead wires this into the loopback
// server only (http.ts), never the LAN board server.
//
// Dependencies the lead passes:
//   guard — rejectReason (ops/orchestrator/src/http.ts) plus header
//     X-Orch-Tasks: 1. Chat checks X-Orch-Chat inline next to /chat/post;
//     that header check is not an export.
//   memory — createMemoryClient from tasks-read.ts (same MemoryClient).
//     Not readMemory / updateRegistry (scripts/memory/service-client.mjs):
//     those throw a plain Error and do not carry an HTTP status.
// A memoryd refusal is MemoryResponseError: status, message, and payload (the JSON body).
// A rejection with no 4xx/5xx status is memoryd down.

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface MemoryClient {
  get(path: string, query?: Record<string, string>): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

/** What post/get reject with when memoryd answered. No status means it is down. */
export interface MemoryRefusal {
  status: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface TasksWriteDeps {
  memory: MemoryClient;
  guard(req: IncomingMessage): string | null;
}

type Route = 'create' | 'update' | 'cancel' | 'done' | 'release';

const ROUTE_BY_PATH = new Map<string, Route>([
  ['/api/tasks/create', 'create'],
  ['/api/tasks/update', 'update'],
  ['/api/tasks/cancel', 'cancel'],
  ['/api/tasks/done', 'done'],
  ['/api/tasks/release', 'release'],
]);

const BODY_LIMIT = 64 * 1024;
const MAX_TITLE = 200;
const MAX_TEXT = 2000;
const UPDATE_STATUSES = new Set(['open', 'blocked', 'deferred']);
// Older memoryd refuses a twin with this sentence and no duplicate_of.
// A current refusal keeps its status and puts duplicate_of on the JSON body;
// we still answer 409, and the sentence is only the fallback.
const DUPLICATE_MESSAGE = /^task #(\d+) says the same thing\b/;

class BadBody extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadBody';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > BODY_LIMIT) throw new BadBody(`body exceeds ${BODY_LIMIT} bytes`);
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw new BadBody('body must be a JSON object');
  try {
    return JSON.parse(text);
  } catch {
    throw new BadBody('body must be JSON');
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadBody('body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new BadBody(`unknown field '${key}'`);
  }
}

function present(body: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(body, field) && body[field] !== undefined;
}

function stringValue(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new BadBody(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new BadBody(`${field} must be a non-empty string`);
  if ([...trimmed].length > max) throw new BadBody(`${field} exceeds ${max} characters`);
  return trimmed;
}

function requireString(body: Record<string, unknown>, field: string, max: number): string {
  if (!present(body, field)) throw new BadBody(`${field} is required`);
  return stringValue(body[field], field, max);
}

function optionalString(body: Record<string, unknown>, field: string, max: number): string | undefined {
  if (!present(body, field)) return undefined;
  return stringValue(body[field], field, max);
}

function requireId(body: Record<string, unknown>): number {
  if (!present(body, 'id')) throw new BadBody('id is required');
  const id = body.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new BadBody('id must be a positive integer');
  }
  return id;
}

function priority(body: Record<string, unknown>, required: boolean): 'P0' | 'P1' | undefined {
  if (!present(body, 'priority')) {
    if (required) throw new BadBody('priority is required');
    return undefined;
  }
  if (body.priority !== 'P0' && body.priority !== 'P1') {
    throw new BadBody('priority must be one of P0, P1');
  }
  return body.priority;
}

function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

// The board speaks a bare name. The store takes domain-<name>, or null to clear.
// Whether that id exists is the store's refusal, not this proxy's.
function optionalDomain(body: Record<string, unknown>): string | null | undefined {
  if (!present(body, 'domain')) return undefined;
  const value = body.domain;
  if (value === null) return null;
  if (typeof value !== 'string') throw new BadBody('domain must be a string or null');
  const trimmed = value.trim();
  if (!trimmed) throw new BadBody('domain must be a non-empty string or null');
  return trimmed.startsWith('domain-') ? trimmed : `domain-${trimmed}`;
}

function createBody(body: Record<string, unknown>): Record<string, unknown> {
  rejectUnknown(body, ['title', 'priority', 'next', 'track', 'domain', 'again']);
  const outbound: Record<string, unknown> = {
    title: requireString(body, 'title', MAX_TITLE),
    priority: priority(body, true),
  };
  put(outbound, 'next_action', optionalString(body, 'next', MAX_TEXT));
  put(outbound, 'track', optionalString(body, 'track', MAX_TITLE));
  // The board speaks a bare name (harness). The store takes the routing id
  // and merges that one key into links. An absent key sends nothing.
  const domain = optionalDomain(body);
  if (domain !== undefined) outbound.domain = domain;
  if (present(body, 'again')) {
    if (typeof body.again !== 'boolean') throw new BadBody('again must be a boolean');
    if (body.again) outbound.again = true;
  }
  return outbound;
}

function updateBody(body: Record<string, unknown>): Record<string, unknown> {
  // The store merges domain into links and keeps the other keys. null clears.
  rejectUnknown(body, ['id', 'title', 'next', 'priority', 'track', 'domain', 'status', 'blocked_reason']);
  const domain = optionalDomain(body);
  const outbound: Record<string, unknown> = { id: requireId(body) };
  put(outbound, 'title', optionalString(body, 'title', MAX_TITLE));
  put(outbound, 'next_action', optionalString(body, 'next', MAX_TEXT));
  put(outbound, 'priority', priority(body, false));
  put(outbound, 'track', optionalString(body, 'track', MAX_TITLE));
  if (present(body, 'status')) {
    if (typeof body.status !== 'string' || !UPDATE_STATUSES.has(body.status)) {
      throw new BadBody('status must be one of open, blocked, deferred');
    }
    outbound.status = body.status;
  }
  if (outbound.status === 'blocked' && !present(body, 'blocked_reason')) {
    throw new BadBody('blocked_reason is required when status is blocked');
  }
  put(outbound, 'blocked_reason', optionalString(body, 'blocked_reason', MAX_TEXT));
  if (domain !== undefined) outbound.domain = domain;
  const fields = ['title', 'next_action', 'priority', 'track', 'status', 'blocked_reason'];
  if (domain === undefined && !fields.some((field) => outbound[field] !== undefined)) {
    throw new BadBody('update names no field to change');
  }
  return outbound;
}

function closeBody(body: Record<string, unknown>, status: 'cancelled' | 'done', field: 'reason' | 'evidence'): Record<string, unknown> {
  rejectUnknown(body, ['id', field]);
  return {
    id: requireId(body),
    status,
    // closureEvidence reads input.evidence, not reason (store.mjs).
    evidence: requireString(body, field, MAX_TEXT),
  };
}

function releaseBody(body: Record<string, unknown>): Record<string, unknown> {
  rejectUnknown(body, ['id']);
  return { id: requireId(body) };
}

function outboundFor(route: Route, raw: unknown): { path: string; body: Record<string, unknown> } {
  const body = objectBody(raw);
  if (route === 'create') return { path: '/task', body: createBody(body) };
  if (route === 'update') return { path: '/task/update', body: updateBody(body) };
  if (route === 'cancel') return { path: '/task/update', body: closeBody(body, 'cancelled', 'reason') };
  if (route === 'done') return { path: '/task/update', body: closeBody(body, 'done', 'evidence') };
  return { path: '/task/release', body: releaseBody(body) };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function asRefusal(error: unknown): { status: number; message: string; details: Record<string, unknown>; duplicate_of?: unknown } | null {
  if (error === null || typeof error !== 'object') return null;
  const status = (error as { status?: unknown }).status;
  const message = (error as { message?: unknown }).message;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) return null;
  if (typeof message !== 'string' || message.length === 0) return null;
  const payload = plainRecord((error as { payload?: unknown }).payload);
  const legacy = plainRecord((error as { details?: unknown }).details);
  const source = payload ?? legacy;
  const details: Record<string, unknown> = source ? { ...source } : {};
  const duplicate_of = Object.hasOwn(error, 'duplicate_of')
    ? (error as { duplicate_of?: unknown }).duplicate_of
    : details.duplicate_of;
  return { status, message, details, duplicate_of };
}

function positiveId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function duplicateId(refusal: { message: string; details: Record<string, unknown>; duplicate_of?: unknown }): number | null {
  const stamped = positiveId(refusal.duplicate_of) ?? positiveId(refusal.details.duplicate_of);
  if (stamped !== null) return stamped;
  const match = DUPLICATE_MESSAGE.exec(refusal.message);
  if (!match) return null;
  return positiveId(Number(match[1]));
}

function refusalBody(route: Route, refusal: { status: number; message: string; details: Record<string, unknown>; duplicate_of?: unknown }): { status: number; body: Record<string, unknown> } {
  const id = route === 'create' ? duplicateId(refusal) : null;
  if (id !== null) {
    return { status: 409, body: { ...refusal.details, error: refusal.message, duplicate_of: id } };
  }
  return { status: refusal.status, body: { ...refusal.details, error: refusal.message } };
}

function downMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0 && error.message.length <= 300 && !error.message.includes('\n')) {
    return error.message;
  }
  return 'memoryd unavailable';
}

export function createTasksWriteRoutes(deps: TasksWriteDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  return async (req, res, url) => {
    const route = ROUTE_BY_PATH.get(url.pathname);
    if (!route) return false;
    const reason = deps.guard(req);
    if (reason !== null) {
      sendJson(res, 403, { error: typeof reason === 'string' && reason.length > 0 ? reason : 'forbidden' });
      return true;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    let outbound: { path: string; body: Record<string, unknown> };
    try {
      outbound = outboundFor(route, await readJson(req));
    } catch (error) {
      sendJson(res, error instanceof BadBody ? 400 : 500, {
        error: error instanceof BadBody ? error.message : 'internal error',
      });
      return true;
    }
    try {
      sendJson(res, 200, await deps.memory.post(outbound.path, outbound.body));
    } catch (error) {
      const refusal = asRefusal(error);
      if (refusal) {
        const mapped = refusalBody(route, refusal);
        sendJson(res, mapped.status, mapped.body);
      } else {
        sendJson(res, 502, { error: downMessage(error) });
      }
    }
    return true;
  };
}
