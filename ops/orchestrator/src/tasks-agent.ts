// The Agent routes of the operator's task board (task 2189, TASKS-BOARD.md "Agent"):
// two seat pairs that answer one question about one memory task with a scout seat of
// their own — the advice pair and the duplicate-search pair, one mechanism twice.
//
//   POST /api/tasks/advise {id, question?} -> {seat, turn}
//   GET  /api/tasks/advice?id=N            -> {state, seat?, turn?, at?, answer?}
//   POST /api/tasks/duplicates {id}        -> {seat, turn}
//   GET  /api/tasks/duplicates?id=N        -> {state, seat?, turn?, at?, answer?}
//
// The seat is found again by its title, `Task advice #<id>` or `Task duplicates
// #<id>`: the orch store gets no new table for this. The brief is at most
// BRIEF_WORDS (300) words, because seats-prompt.ts refuses 301 — so the task body is
// trimmed to fit while the id, the title, the next step and the question always stay.
// The duplicate brief also carries the two `memoryctl task list` commands, with the
// 90-day cutoff's ms computed when the request arrived.
//
// Dependencies are the narrow interfaces below, so this module is testable alone with
// fakes. When the lead wires it (http.ts, loopback server only) the objects are:
//   seats  — rt.seats, the SeatManager: create/promptScoped/reportOf/close and its store;
//   memory — the MemoryClient of tasks-read.ts (createMemoryClient), whose refusal of a
//            memoryd 4xx carries that status and message;
//   guard  — the loopback Host/Origin check http.ts already applies (rejectReason) plus
//            the board's `X-Orch-Tasks: 1` header, as the write routes use it;
//   repo   — the daemon's repo root (main.ts's daemonRuntime.repo, from daemonCheckout):
//            the scout reads the tree the daemon itself runs from.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TERMINAL_TURN, type Seat, type Turn } from './store.ts';

/** seats-prompt.ts refuses a brief over BRIEF_WORDS words; orch's own limit, restated. */
export const MAX_BRIEF_WORDS = 300;
/** A scout's one answer: the same window scout-request.ts gives a seat's scout. */
export const ADVICE_TIMEOUT_MS = 15 * 60_000;
const BODY_LIMIT = 64 * 1024;
/** The question the contract asks when the operator types none of their own. */
export const DEFAULT_QUESTION = 'what the task needs, what blocks it, and the first step';
/** The fixed question of the duplicate search: the operator asks none of their own. */
export const DUPLICATES_QUESTION = 'which other tasks ask for the same outcome';
/** How far back the duplicate search lists closed tasks: a reopened task is a duplicate. */
export const DUPLICATE_DAYS = 90;

/** The exact title of an advice seat: the only key that finds one again. */
export const adviceTitle = (id: number) => `Task advice #${id}`;
/** The exact title of a duplicate-search seat: the only key that finds one again. */
export const duplicatesTitle = (id: number) => `Task duplicates #${id}`;

/** What memoryd answers for one task; only the read side is used here. */
export interface TaskMemory {
  get(path: string, query?: Record<string, string>): Promise<unknown>;
}

/** The part of the SeatManager these routes drive. */
export interface TaskSeats {
  create(input: { role: string; title: string; repo: string; needs: string }): Promise<Seat>;
  promptScoped(seatId: string, text: string, timeoutMs: number): Promise<Turn>;
  reportOf(turn: Turn): { report: Record<string, unknown> | null; reportError: string | null };
  close(seatId: string): Promise<unknown>;
  store: { listSeats: (query?: { role: string; title: string }) => Seat[]; listTurns: (seatId: string) => Turn[] };
}

export type TasksAgentDeps = {
  seats: TaskSeats;
  memory: TaskMemory;
  /** The loopback/header guard the write routes share; a reason is a 403. */
  guard: (req: IncomingMessage) => string | null;
  repo: string;
};

export type AdviceState = 'none' | 'running' | 'done' | 'failed';

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** The first `max` words of `text`, keeping its own whitespace; a cut says so. */
export function fit(text: string, max: number): string {
  const trimmed = text.trim();
  if (max <= 0) return '';
  if (words(trimmed) <= max) return trimmed;
  const marks = [...trimmed.matchAll(/\S+/g)];
  const cut = marks[max - 1]?.index ?? trimmed.length;
  return `${trimmed.slice(0, cut).trimEnd()} [trimmed]`;
}

type Task = { id: number; title: string; body: string; next: string };

/**
 * The scout's one brief, at most MAX_BRIEF_WORDS words. The frame (id, title, question,
 * next step) keeps its caps so the body always has room; the body takes what is left and
 * is cut at a word boundary when it does not fit. `tail` is the pair's own instruction
 * text: it always stays in full, and the body pays its words.
 */
export function adviceBrief(task: Task, question: string, tail = ''): string {
  const frame = [
    `Task #${task.id}: ${fit(task.title, 40)}`,
    `Question: ${fit(question, 60)}`,
    `Next step: ${task.next.trim() ? fit(task.next, 30) : 'none recorded'}`,
  ].join('\n\n');
  const label = 'Task body:';
  const end = tail ? `\n\n${tail}` : '';
  let budget = MAX_BRIEF_WORDS - words(frame) - words(label) - words(end);
  // Exact by measurement, not by arithmetic: a word more than the limit is a refusal.
  while (budget > 0 && words(`${frame}\n\n${label}\n${fit(task.body, budget - 1)}${end}`) > MAX_BRIEF_WORDS) budget -= 1;
  if (budget <= 0) return `${frame}${end}`;
  const body = fit(task.body, budget - 1);
  return body ? `${frame}\n\n${label}\n${body}${end}` : `${frame}${end}`;
}

/**
 * The duplicate search's brief. The scout reads every other task's line from the two
 * `memoryctl task list` commands (a duplicate is often a task opened again after it was
 * closed) and reports each task that asks for the same outcome: one finding per
 * duplicate, the claim "#<id> <title>" of that task and the evidence why and how sure.
 * The cutoff's ms is computed now — at request time, never a constant that goes stale.
 */
export function duplicatesBrief(task: Task, now: number): string {
  const cutoff = now - DUPLICATE_DAYS * 24 * 60 * 60 * 1000;
  const tail = [
    'Find every other task that asks for the same outcome. Read the other tasks from these commands:',
    'memoryctl task list --compact',
    `memoryctl task list --compact --closed-since ${cutoff}`,
    'A duplicate is often a task opened again after it was closed. Report one finding per duplicate: the claim is "#<id> <title>" of that task, the evidence is why it asks for the same outcome and how sure you are. Report only: merging is the operator\'s act on the board.',
  ].join('\n');
  return adviceBrief(task, DUPLICATES_QUESTION, tail);
}

/** memoryd's task row (store.mjs taskView), read down to what the brief needs. */
function taskOf(value: unknown): Task | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = Number(row.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const text = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : '');
  return { id, title: text('title'), body: text('body'), next: text('next_action') };
}

/** A memoryd refusal keeps its status and message; anything else is 502. No retry, no fallback. */
export function memoryFailure(error: unknown): { status: number; error: string } {
  const raw = (error ?? {}) as { status?: unknown; statusCode?: unknown };
  const status = typeof raw.status === 'number' ? raw.status : typeof raw.statusCode === 'number' ? raw.statusCode : 0;
  const message = error instanceof Error && error.message ? error.message : 'memoryd error';
  return status >= 400 && status < 600 ? { status, error: message } : { status: 502, error: message };
}

function positiveId(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) return Number(value.trim());
  return null;
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error(`body over ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** One agent pair: a POST that starts (or joins) one seat per task, and a GET that reads it back. */
type AgentPair = {
  /** The POST's route stem in its refusals: `advise takes no 'x'`. */
  name: string;
  postPath: string;
  getPath: string;
  title: (id: number) => string;
  brief: (task: Task, question: string) => string;
  /** The POST may carry an operator question (the advice pair only). */
  question: boolean;
};

const ADVICE_PAIR: AgentPair = {
  name: 'advise',
  postPath: '/api/tasks/advise',
  getPath: '/api/tasks/advice',
  title: adviceTitle,
  brief: (task, question) => adviceBrief(task, question || DEFAULT_QUESTION,
    'The operator reads this report. Write each claim and forLead in Russian, in plain words. '
    + 'forLead opens with the direct answer to the question in one sentence, then the next step. '
    + 'Keep identifiers, paths and commands as they are.'),
  question: true,
};

const DUPLICATES_PAIR: AgentPair = {
  name: 'duplicates',
  postPath: '/api/tasks/duplicates',
  getPath: '/api/tasks/duplicates',
  title: duplicatesTitle,
  brief: (task) => duplicatesBrief(task, Date.now()),
  question: false,
};

/** One pair's routes; `true` means the request was handled. */
function agentPair(
  deps: TasksAgentDeps,
  spec: AgentPair,
): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  /** One seat per task at a time: a second POST joins the first instead of making a second seat. */
  const inFlight = new Map<number, Promise<{ seat: string; turn: string }>>();

  const lastTurn = (seat: Seat): Turn | null => {
    const turns = deps.seats.store.listTurns(seat.id);
    return turns.length ? (turns[turns.length - 1] as Turn) : null;
  };
  /** Seats of this task, newest first (the store orders seats by created_at, id). These seats are
   * always created as role scout (start below), so the (role, title) bound — migration 10's
   * seats_role_title — finds them and nothing else without reading the closed history (task 2640). */
  const candidates = (id: number): Seat[] =>
    deps.seats.store.listSeats({ role: 'scout', title: spec.title(id) }).reverse();

  async function start(id: number, question: string): Promise<{ seat: string; turn: string }> {
    const task = taskOf(await deps.memory.get('/task', { id: String(id) }));
    if (!task) throw Object.assign(new Error(`memoryd answered no task ${id}`), { status: 502 });
    // A search of this task already running: the operator gets that seat, never a second one.
    for (const seat of candidates(id)) {
      const turn = lastTurn(seat);
      if (turn && !TERMINAL_TURN.has(turn.status)) return { seat: seat.id, turn: turn.id };
    }
    const scout = await deps.seats.create({ role: 'scout', title: spec.title(id), repo: deps.repo, needs: 'mac' });
    try {
      const turn = await deps.seats.promptScoped(scout.id, spec.brief(task, question), ADVICE_TIMEOUT_MS);
      return { seat: scout.id, turn: turn.id };
    } catch (error) {
      // A seat that never got its question is no answer: close it so a retry starts clean.
      await deps.seats.close(scout.id).catch(() => undefined);
      throw error;
    }
  }

  async function post(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reason = deps.guard(req);
    if (reason) return sendJson(res, 403, { error: reason });
    let body: unknown;
    try {
      body = await readJson(req, BODY_LIMIT);
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'body must be a JSON object' });
    const input = body as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (key !== 'id' && !(spec.question && key === 'question')) return sendJson(res, 400, { error: `${spec.name} takes no '${key}'` });
    }
    const id = positiveId(input.id);
    if (id === null) return sendJson(res, 400, { error: 'id must be a positive task id' });
    if (spec.question && input.question !== undefined && typeof input.question !== 'string') return sendJson(res, 400, { error: 'question must be text' });
    const asked = spec.question && typeof input.question === 'string' ? input.question.trim() : '';
    const work = inFlight.get(id) ?? start(id, asked);
    if (!inFlight.has(id)) inFlight.set(id, work);
    try {
      sendJson(res, 200, await work);
    } catch (error) {
      const failure = memoryFailure(error);
      sendJson(res, failure.status, { error: failure.error });
    } finally {
      if (inFlight.get(id) === work) inFlight.delete(id);
    }
  }

  function get(res: ServerResponse, url: URL): void {
    const id = positiveId(url.searchParams.get('id'));
    if (id === null) return sendJson(res, 400, { error: 'id must be a positive task id' });
    const [seat] = candidates(id) as [Seat?];
    if (!seat) return sendJson(res, 200, { state: 'none' satisfies AdviceState });
    const turn = lastTurn(seat);
    if (!turn) return sendJson(res, 200, { state: 'none', seat: seat.id });
    const state: AdviceState = !TERMINAL_TURN.has(turn.status) ? 'running' : turn.status === 'done' ? 'done' : 'failed';
    const at = turn.ended_at ?? turn.started_at ?? turn.created_at;
    const answer = state === 'done' ? deps.seats.reportOf(turn).report : null;
    sendJson(res, 200, { state, seat: seat.id, turn: turn.id, at, ...(answer ? { answer } : {}) });
  }

  return async (req, res, url) => {
    if (url.pathname === spec.postPath && req.method === 'POST') {
      await post(req, res);
      return true;
    }
    if (url.pathname === spec.getPath && req.method === 'GET') {
      get(res, url);
      return true;
    }
    return false;
  };
}

/** The board's four agent routes; `true` means the request was handled. */
export function createTasksAgentRoutes(
  deps: TasksAgentDeps,
): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  const pairs = [agentPair(deps, ADVICE_PAIR), agentPair(deps, DUPLICATES_PAIR)];
  return async (req, res, url) => {
    for (const pair of pairs) if (await pair(req, res, url)) return true;
    return false;
  };
}
