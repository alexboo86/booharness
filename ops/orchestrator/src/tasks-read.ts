// Read side of the tasks board (ops/orchestrator/TASKS-BOARD.md, Read).
// Loopback only: the lead wires the handler into http.ts. This module does not.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AssignNotice } from './tasks-notice.ts';

/** GET /api/memory<path>, POST /api/memory<path> with the token. Same shape in every tasks module. */
export interface MemoryClient {
  get(path: string, query?: Record<string, string>): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

/**
 * memoryd answered with an HTTP status. A 4xx is a refusal and is passed through.
 * A 5xx is not a task list the board can show.
 */
export class MemoryResponseError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = 'MemoryResponseError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * A status=done|cancelled list is the whole closed table on an older memoryd, which ignores
 * unknown query keys. The board poll does not use a status filter. It asks once, with
 * closed_since and fields=compact, and trusts that window only when the answer's applied
 * names both. This error is the refusal of the old closed-status fetch.
 */
export class ClosedWindowUnsupported extends Error {
  readonly code = 'closed_window_unsupported';

  constructor(message: string) {
    super(message);
    this.name = 'ClosedWindowUnsupported';
  }
}

const CLOSED_WINDOW_MESSAGE = 'refusing status=done|cancelled: that list is the whole closed table unless memoryd applied closed_since';
const UNAPPLIED_WINDOW_MESSAGE = 'memoryd did not apply closed_since and fields=compact; closed tasks were not accepted';

export type TasksLeadScan = { session: string; family: string; at: string | number | null };
export type TasksChatBinding = { handle: string; session: string; ended_at: string | null };

/**
 * Narrow dependencies. The lead passes, from http.ts on the loopback server only:
 * - memory: createMemoryClient()
 * - leads: leadsReader(store)
 *   leadsReader is dashboard.ts: the board's lead scan (activeLeads over windowSeatSessions, ACTIVE_LEAD_MINUTES, the
 *   handed-over filter), one shared scan promise per 10 s, so polls that arrive during a scan wait for it.
 * - bindings: () => chatList(store).handles
 *   chatList is chat.ts. It returns live bindings only (ended_at null). A wider list is honoured:
 *   ended_at set is not a live binding.
 * - domainNames: () => readdirSync(fileURLToPath(new URL('../../../.agents/domains/', import.meta.url)))
 *   No lister exists. Same repo root as context.ts REPO. This module strips the domain- prefix.
 */
export type TasksReadDeps = {
  memory: MemoryClient;
  leads: () => readonly TasksLeadScan[] | Promise<readonly TasksLeadScan[]>;
  bindings: () => readonly TasksChatBinding[];
  domainNames: () => readonly string[];
  /** Supplemental chat projection: failure leaves the task readable with notice: null. */
  notice?: (id: number) => AssignNotice | null;
  now?: () => number;
};

type Priority = 'P0' | 'P1' | 'P2' | 'P3';
type Status = 'open' | 'in_progress' | 'blocked' | 'deferred' | 'done' | 'cancelled';
type TaskLead = { handle: string; source: 'claim' | 'track'; live: boolean };
type TaskRow = {
  id: number;
  title: string;
  priority: Priority;
  status: Status;
  track: string | null;
  domain: string | null;
  next: string | null;
  blocked_reason: string | null;
  claimed_by: string | null;
  created: number;
  updated: number;
  closed: number | null;
  lead: TaskLead | null;
};
type BoardLead = { handle: string | null; session: string; family: string; live: boolean; at: number };
type Board = {
  at: number;
  memory: { ok: boolean; error?: string };
  domains: string[];
  leads: BoardLead[];
  tasks: TaskRow[];
};

const PRIORITIES = new Set<Priority>(['P0', 'P1', 'P2', 'P3']);
const STATUSES = new Set<Status>(['open', 'in_progress', 'blocked', 'deferred', 'done', 'cancelled']);
const CLOSED_STATUSES = new Set<Status>(['done', 'cancelled']);
const LIVE_STATUSES = ['open', 'in_progress', 'blocked', 'deferred'] as const;
const DAY_MS = 86_400_000;
const DEFAULT_CLOSED_DAYS = 7;
const REQUEST_TIMEOUT_MS = 30_000;

const stateDirOf = (env: NodeJS.ProcessEnv): string =>
  env.MEMORYCTL_STATE_DIR || join(env.HOME || homedir(), '.local', 'state', 'memoryctl');

/** URL: MEMORYCTL_URL, else service.url in the state dir, else loopback. Same order as service-client.mjs and the memoryctl CLI. */
export function memoryServiceUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MEMORYCTL_URL) return env.MEMORYCTL_URL;
  const file = join(stateDirOf(env), 'service.url');
  try {
    const url = readFileSync(file, 'utf8').replace(/\s/g, '');
    if (url) return url;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return 'http://127.0.0.1:7717';
}

/**
 * Token file: MEMORYCTL_TOKEN_FILE, else <state dir>/memory.token.
 * service-client.mjs and mcp-server.mjs use the state dir. The memoryctl CLI defaults to
 * $HOME/.local/state/memoryctl/memory.token and ignores MEMORYCTL_STATE_DIR for the token
 * (scripts/memory is not this module's to edit). They agree when STATE_DIR is unset.
 */
export function memoryTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MEMORYCTL_TOKEN_FILE || join(stateDirOf(env), 'memory.token');
}

function timeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.MEMORYCTL_TIMEOUT_MS;
  const parsed = raw === undefined || raw === '' ? REQUEST_TIMEOUT_MS : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : REQUEST_TIMEOUT_MS;
}

function memoryUrl(base: string, path: string, query?: Record<string, string>): URL {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`/api/memory${suffix}`, base);
  if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

async function readBody(response: Response): Promise<{ message: string; payload: unknown }> {
  // Parse the whole body first: a refusal that lists the routing ids is longer than any cap on raw text.
  const text = (await response.text().catch(() => '')).trim();
  if (!text) return { message: `HTTP ${response.status}`, payload: { error: `HTTP ${response.status}` } };
  const cut = text.slice(0, 300);
  try {
    const payload = JSON.parse(text) as unknown;
    const message = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : cut;
    return { message, payload: payload && typeof payload === 'object' ? payload : { error: message } };
  } catch {
    return { message: cut, payload: { error: cut } };
  }
}

/**
 * The poll client. A task list with no status is the board poll, and only after this client
 * has learned that memoryd applies closed_since and fields. That answer is learned once,
 * from a status=open probe, and kept here. Without it a status-less list is never sent:
 * an older memoryd ignores those keys and would return the whole closed table.
 * status=done|cancelled is refused before any request.
 */
export function createMemoryClient(options?: { env?: NodeJS.ProcessEnv }): MemoryClient {
  const env = options?.env ?? process.env;
  const call = async (method: 'GET' | 'POST', path: string, query: Record<string, string> | undefined, body: unknown): Promise<unknown> => {
    const base = memoryServiceUrl(env);
    const url = memoryUrl(base, path, query);
    const headers: Record<string, string> = {};
    let payload: string | undefined;
    if (method === 'POST') {
      const tokenFile = memoryTokenPath(env);
      let token: string;
      try {
        token = readFileSync(tokenFile, 'utf8').trim();
      } catch (error) {
        throw new Error(`memoryd token unavailable (${tokenFile}): ${(error as Error).message}`);
      }
      if (!token) throw new Error(`memoryd token unavailable (${tokenFile}): empty`);
      headers['x-memory-token'] = token;
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs(env)), redirect: 'error' });
    } catch (error) {
      throw new Error(`memoryd unavailable (${url.origin}): ${(error as Error).message}`);
    }
    if (!response.ok) {
      const detail = await readBody(response);
      throw new MemoryResponseError(response.status, detail.message, detail.payload);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`memoryd ${method} ${url.pathname}: invalid JSON`);
    }
  };
  let windowCapable: boolean | null = null;
  function tasksOf(value: unknown): unknown[] {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { tasks?: unknown }).tasks)) {
      throw new Error('invalid memoryd tasks response');
    }
    return (value as { tasks: unknown[] }).tasks;
  }
  async function listLive(closedSince: string, openProbe: unknown | null): Promise<unknown> {
    const tasks: unknown[] = [];
    if (openProbe) tasks.push(...tasksOf(openProbe));
    for (const status of LIVE_STATUSES) {
      if (openProbe && status === 'open') continue;
      const payload = await call('GET', '/tasks', { status, closed_since: closedSince, fields: 'compact' }, undefined);
      tasks.push(...tasksOf(payload));
    }
    return { tasks };
  }
  async function windowedList(query: Record<string, string>): Promise<unknown> {
    if (windowCapable === true) return call('GET', '/tasks', query, undefined);
    if (windowCapable === false) return listLive(query.closed_since, null);
    const probe = await call('GET', '/tasks', { status: 'open', closed_since: query.closed_since, fields: 'compact' }, undefined);
    windowCapable = windowTrusted(appliedOf(probe));
    if (windowCapable) return call('GET', '/tasks', query, undefined);
    return listLive(query.closed_since, probe);
  }
  return {
    async get(path, query) {
      const normalized = (path.startsWith('/') ? path : `/${path}`).replace(/\/+$/, '') || '/';
      if (normalized === '/tasks') {
        const status = query?.status;
        const windowed = Boolean(query?.closed_since) && query?.fields === 'compact';
        if (status && CLOSED_STATUSES.has(status as Status)) throw new ClosedWindowUnsupported(CLOSED_WINDOW_MESSAGE);
        if (!status && !windowed) throw new Error('refusing unfiltered GET /api/memory/tasks');
        if (!status && windowed && query) return windowedList(query);
      }
      return call('GET', path, query, undefined);
    },
    post(path, body) {
      return call('POST', path, undefined, body);
    },
  };
}

function textOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`invalid memoryd task: ${field} must be a string or null`);
  return value;
}

function millis(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`invalid memoryd task: ${field} must be a safe integer`);
  return value;
}

function bareDomain(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const name = value.startsWith('domain-') ? value.slice('domain-'.length) : value;
  return name || null;
}

function taskDomain(row: Record<string, unknown>): string | null {
  if (Object.prototype.hasOwnProperty.call(row, 'domain')) return bareDomain(row.domain);
  return bareDomain(domainOf(row.links));
}

function domainOf(links: unknown): string | null {
  if (!links || typeof links !== 'object' || Array.isArray(links)) return null;
  const domain = (links as { domain?: unknown }).domain;
  return typeof domain === 'string' && domain ? domain : null;
}

type StoreTask = {
  id: number;
  title: string;
  priority: Priority;
  status: Status;
  track: string | null;
  domain: string | null;
  next: string | null;
  blocked_reason: string | null;
  claimed_by: string | null;
  created: number;
  updated: number;
  closed: number | null;
  body?: string;
  handoffs?: number[];
};

function parseTask(value: unknown, whole: boolean): StoreTask {
  if (!value || typeof value !== 'object') throw new Error('invalid memoryd task');
  const row = value as Record<string, unknown>;
  const priority = row.priority;
  const status = row.status;
  if (typeof priority !== 'string' || !PRIORITIES.has(priority as Priority)) throw new Error('invalid memoryd task: priority');
  if (typeof status !== 'string' || !STATUSES.has(status as Status)) throw new Error('invalid memoryd task: status');
  const task: StoreTask = {
    id: millis(row.id, 'id'),
    title: textOrNull(row.title, 'title') ?? (() => { throw new Error('invalid memoryd task: title'); })(),
    priority: priority as Priority,
    status: status as Status,
    track: textOrNull(row.track, 'track'),
    domain: taskDomain(row),
    next: textOrNull(row.next_action, 'next_action'),
    blocked_reason: textOrNull(row.blocked_reason, 'blocked_reason'),
    claimed_by: textOrNull(row.claimed_by, 'claimed_by'),
    created: millis(row.created_ts, 'created_ts'),
    updated: millis(row.updated_ts, 'updated_ts'),
    closed: row.closed_ts === null || row.closed_ts === undefined ? null : millis(row.closed_ts, 'closed_ts'),
  };
  if (!whole) return task;
  if (typeof row.body !== 'string') throw new Error('invalid memoryd task: body');
  if (!Array.isArray(row.handoffs) || row.handoffs.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('invalid memoryd task: handoffs');
  }
  task.body = row.body;
  task.handoffs = row.handoffs as number[];
  return task;
}

function taskList(payload: unknown): StoreTask[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { tasks?: unknown }).tasks)) {
    throw new Error('invalid memoryd tasks response');
  }
  return (payload as { tasks: unknown[] }).tasks.map((row) => parseTask(row, false));
}

type Join = { liveSessionByHandle: Map<string, string>; knownHandles: Set<string>; activeSessions: Set<string> };

function joinOf(bindings: readonly TasksChatBinding[], activeSessions: ReadonlySet<string>): Join {
  const liveSessionByHandle = new Map<string, string>();
  const knownHandles = new Set<string>();
  for (const binding of bindings) {
    if (typeof binding.handle !== 'string' || !binding.handle) continue;
    knownHandles.add(binding.handle);
    if (binding.ended_at === null && typeof binding.session === 'string' && binding.session) {
      liveSessionByHandle.set(binding.handle, binding.session);
    }
  }
  return { liveSessionByHandle, knownHandles, activeSessions: new Set(activeSessions) };
}

function leadOf(task: StoreTask, join: Join): TaskLead | null {
  const claim = task.claimed_by;
  const track = task.track;
  const handle = claim || (track && join.knownHandles.has(track) ? track : null);
  if (!handle) return null;
  const session = join.liveSessionByHandle.get(handle);
  const live = session !== undefined && join.activeSessions.has(session);
  return { handle, source: claim ? 'claim' : 'track', live };
}

function toRow(task: StoreTask, join: Join): TaskRow {
  return {
    id: task.id,
    title: task.title,
    priority: task.priority,
    status: task.status,
    track: task.track,
    domain: task.domain,
    next: task.next,
    blocked_reason: task.blocked_reason,
    claimed_by: task.claimed_by,
    created: task.created,
    updated: task.updated,
    closed: task.closed,
    lead: leadOf(task, join),
  };
}

function appliedOf(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const applied = (payload as { applied?: unknown }).applied;
  if (!Array.isArray(applied) || applied.some((item) => typeof item !== 'string')) return [];
  return applied;
}

function windowTrusted(applied: readonly string[]): boolean {
  return applied.includes('closed_since') && applied.includes('fields');
}

function domainsOf(names: readonly string[]): string[] {
  const found = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string' || !name.startsWith('domain-')) continue;
    const stripped = name.slice('domain-'.length);
    if (stripped) found.add(stripped);
  }
  return [...found].sort();
}

function boardLeads(scans: readonly TasksLeadScan[], bindings: readonly TasksChatBinding[]): BoardLead[] {
  const liveHandleBySession = new Map<string, string>();
  for (const binding of bindings) {
    if (binding.ended_at !== null || typeof binding.session !== 'string' || !binding.session) continue;
    if (typeof binding.handle !== 'string' || !binding.handle) continue;
    if (!liveHandleBySession.has(binding.session)) liveHandleBySession.set(binding.session, binding.handle);
  }
  const leads: BoardLead[] = [];
  const seen = new Set<string>();
  for (const scan of scans) {
    if (typeof scan.session !== 'string' || !scan.session || typeof scan.family !== 'string' || !scan.family) {
      throw new Error('invalid lead scan');
    }
    if (seen.has(scan.session)) continue;
    const at = typeof scan.at === 'number' ? scan.at : typeof scan.at === 'string' ? Date.parse(scan.at) : NaN;
    if (!Number.isFinite(at)) throw new Error(`invalid lead scan: ${scan.session} has no timestamp`);
    seen.add(scan.session);
    const handle = liveHandleBySession.get(scan.session) ?? null;
    leads.push({ handle, session: scan.session, family: scan.family, live: handle !== null, at });
  }
  leads.sort((a, b) => a.session < b.session ? -1 : a.session > b.session ? 1 : 0);
  return leads;
}

function etagOf(board: Board): string {
  // `at` is the answer clock. Hashing it would make every 5 s poll a new body.
  const stable = { memory: board.memory, domains: board.domains, leads: board.leads, tasks: board.tasks };
  return `"${createHash('sha256').update(JSON.stringify(stable)).digest('hex')}"`;
}

function noneMatch(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return false;
  if (raw.trim() === '*') return true;
  return raw.split(',').some((part) => {
    const tag = part.trim().replace(/^W\//i, '');
    return tag === etag;
  });
}

function send(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closedDaysOf(url: URL): number {
  const raw = url.searchParams.get('closed_days');
  if (raw === null) return DEFAULT_CLOSED_DAYS;
  if (!/^\d+$/.test(raw)) throw new Error('closed_days must be a non-negative integer');
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days > Number.MAX_SAFE_INTEGER / DAY_MS) throw new Error('closed_days must be a non-negative integer');
  return days;
}

async function loadTasks(memory: MemoryClient, closedDays: number, now: number): Promise<{ tasks: StoreTask[]; closedNote: string | null }> {
  const cutoff = now - closedDays * DAY_MS;
  const payload = await memory.get('/tasks', { closed_since: String(cutoff), fields: 'compact' });
  const rows = taskList(payload);
  const trusted = windowTrusted(appliedOf(payload));
  const kept = trusted ? rows : rows.filter((row) => !CLOSED_STATUSES.has(row.status));
  const byId = new Map<number, StoreTask>();
  for (const row of kept) if (!byId.has(row.id)) byId.set(row.id, row);
  return {
    tasks: [...byId.values()].sort((a, b) => a.id - b.id),
    closedNote: trusted ? null : UNAPPLIED_WINDOW_MESSAGE,
  };
}

function downBoard(at: number, error: string, domains: string[], leads: BoardLead[]): Board {
  return { at, memory: { ok: false, error }, domains, leads, tasks: [] };
}

export function createTasksReadRoutes(deps: TasksReadDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  const now = deps.now ?? Date.now;
  return async (req, res, url) => {
    if (url.pathname !== '/api/tasks' && url.pathname !== '/api/tasks/one') return false;
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method not allowed' });
      return true;
    }
    try {
      if (url.pathname === '/api/tasks/one') {
        await one(deps, res, url);
        return true;
      }
      await board(deps, req, res, url, now());
      return true;
    } catch (error) {
      if (error instanceof MemoryResponseError && error.status >= 400 && error.status < 500) {
        send(res, error.status, error.payload ?? { error: error.message });
        return true;
      }
      if (!res.headersSent) send(res, 500, { error: messageOf(error) });
      return true;
    }
  };
}

async function board(deps: TasksReadDeps, req: IncomingMessage, res: ServerResponse, url: URL, at: number): Promise<void> {
  let domains: string[];
  let leads: BoardLead[];
  try {
    domains = domainsOf(deps.domainNames());
    leads = boardLeads(await deps.leads(), deps.bindings());
  } catch (error) {
    send(res, 500, { error: messageOf(error) });
    return;
  }
  let closedDays: number;
  try {
    closedDays = closedDaysOf(url);
  } catch (error) {
    send(res, 400, { error: messageOf(error) });
    return;
  }
  let loaded: { tasks: StoreTask[]; closedNote: string | null };
  try {
    loaded = await loadTasks(deps.memory, closedDays, at);
  } catch (error) {
    if (error instanceof MemoryResponseError && error.status >= 400 && error.status < 500) {
      send(res, error.status, error.payload ?? { error: error.message });
      return;
    }
    // Transport failure and memoryd 5xx are "down": the page shows the error, never an empty board as if true.
    const text = error instanceof MemoryResponseError ? `HTTP ${error.status}: ${error.message}` : messageOf(error);
    reply(res, downBoard(at, text, domains, leads), header(req, 'if-none-match'));
    return;
  }
  const join = joinOf(deps.bindings(), new Set(leads.map((lead) => lead.session)));
  const body: Board = {
    at,
    memory: loaded.closedNote ? { ok: true, error: loaded.closedNote } : { ok: true },
    domains,
    leads,
    tasks: loaded.tasks.map((task) => toRow(task, join)),
  };
  reply(res, body, header(req, 'if-none-match'));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

function reply(res: ServerResponse, body: Board, match: string | undefined): void {
  const etag = etagOf(body);
  if (match && noneMatch(match, etag)) {
    res.writeHead(304, { etag });
    res.end();
    return;
  }
  send(res, 200, body, { etag });
}

async function one(deps: TasksReadDeps, res: ServerResponse, url: URL): Promise<void> {
  const raw = url.searchParams.get('id');
  if (raw === null || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    send(res, 400, { error: 'id must be a positive integer' });
    return;
  }
  let payload: unknown;
  try {
    payload = await deps.memory.get('/task', { id: raw });
  } catch (error) {
    if (error instanceof MemoryResponseError && error.status >= 400 && error.status < 500) {
      send(res, error.status, error.payload ?? { error: error.message });
      return;
    }
    const text = error instanceof MemoryResponseError ? `HTTP ${error.status}: ${error.message}` : messageOf(error);
    send(res, 502, { error: text });
    return;
  }
  const task = parseTask(payload, true);
  let bindings: readonly TasksChatBinding[] = [];
  let notice: AssignNotice | null = null;
  try {
    bindings = deps.bindings();
    notice = deps.notice?.(task.id) ?? null;
  } catch {
    // Both projections read chat: neither may turn a successful memoryd read into a failure.
  }
  const leads = boardLeads(await deps.leads(), bindings);
  const row = toRow(task, joinOf(bindings, new Set(leads.map((lead) => lead.session))));
  send(res, 200, { ...row, body: task.body, handoffs: task.handoffs, notice });
}
