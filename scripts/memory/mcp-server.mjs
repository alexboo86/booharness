#!/usr/bin/env node
// memoryctl as ONE MCP tool, for the runtimes that cannot be reached any other
// way.
//
// Why this exists, and why it is deliberately small. Memory reaches an agent
// today through two channels: prose in the contract, and the PreToolUse hooks.
// Prose does not deliver — measured twice. The hooks do, but not everywhere: the
// domain-lessons hook exists on claude, codex and kimi, while grok and glm have
// no domain-lessons hook WIRED — grok dispatches hooks perfectly well
// (~/.grok/config.toml, ~/.grok/logs/hooks.log), it simply has none for this —
// so a lesson about the file they are editing never arrived. That is the gap
// this closes: MCP is not better than a hook, it is available where a hook is
// not.
//
// Measured 2026-08-02, each reviewer reporting its own tool list: every runtime
// now holds this tool. Kimi was the exception for one round — its server
// connected while the roster allowlist left the tool uncallable — and it called
// memory in the round after the registry fix.
//
// Two earlier versions of this comment were wrong in the same way, and the way
// is worth naming: "claude and codex only" came from globbing
// `~/.kimi-code/*.json`, which does not match `config.toml`; "grok has no hook
// mechanism at all" was copied from an installer comment. Both were mechanism
// claims written without measuring the mechanism.
//
// It does NOT promise to change which tool an agent reaches for. Measured
// 2026-08-02: code intelligence had been delivered over MCP to three runtimes for
// weeks, and the week's transcripts still hold 6816 grep/rg calls against 619
// index ones. Visibility is not preference. What MCP buys here is reach,
// plus attribution — every call carries the client's own name, so the journal
// can finally answer how much memory the MEMBERS write versus the lead.
//
// ONE tool, not one per verb. A tool schema is re-sent on every turn of every
// session that has the server enabled, so eight tools would be eight schemas
// of permanent overhead to save the model one enum lookup.
//
// Zero dependencies: the MCP stdio transport is newline-delimited JSON-RPC 2.0,
// and the memory service is plain HTTP. Pulling the SDK into the app package
// for a harness tool would be a dependency the product does not need.

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { checkLesson, lessonFields, lessonChanges, withLongReason } from './lesson-quality.mjs';
import { checkCaptureFields } from './capture-gate.mjs';
import { renderLessons } from './lesson-lib.mjs';
export { renderLessons } from './lesson-lib.mjs';

const STATE_DIR = process.env.MEMORYCTL_STATE_DIR || join(homedir(), '.local', 'state', 'memoryctl');
// Service URL: env, else the per-machine `service.url` written by
// `install-memory.mjs --remote <url>` (win's ssh forward), else Mac loopback.
function readServiceUrl(dir) {
  try { return readFileSync(join(dir, 'service.url'), 'utf8').trim() || null; } catch { return null; }
}
const BASE = (process.env.MEMORYCTL_URL || readServiceUrl(STATE_DIR) || 'http://127.0.0.1:7717').replace(/\/+$/, '');
const TOKEN_FILE = process.env.MEMORYCTL_TOKEN_FILE || join(STATE_DIR, 'memory.token');
const SERVER_INFO = { name: 'memoryctl', version: '1.0.0' };

// The service is single-writer SQLite: a stuck one accepts the connection and
// then says nothing, which `fetch` waits on forever. This server is SERIAL, so
// one such call blocks every later one — the head-of-line stall three reviewers
// reproduced against the contract's own "memory must never break a session".
// `curl --max-time 30` is what the CLI uses; matching it keeps the two routes
// failing at the same moment rather than one of them hanging.
const REQUEST_TIMEOUT_MS = Number(process.env.MEMORYCTL_TIMEOUT_MS) || 30000;

// Filled at initialize: the client tells us who it is, and every write carries
// it. Without this the store sees one anonymous writer and the "members versus
// lead" question stays unanswerable.
//
// The env names are the CLI's, `_ID` and all (memoryctl:25-26). They were
// spelled without it here, so an operator who set MEMORYCTL_AGENT_ID saw it
// silently ignored on this route and honoured on the other.
let clientName = process.env.MEMORYCTL_AGENT_ID || '';
let sessionId = process.env.MEMORYCTL_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
let clientInfoName = '';

const TOOL = {
  name: 'memory',
  description:
    'Durable project memory (memoryctl). One tool, pick an action.\n'
    + 'Reading is three steps and they are not interchangeable: hot says what matters '
    + 'now, search finds WHERE something is written (it answers with a snippet, never '
    + 'the text), get reads that entry whole.\n'
    + '• hot {} — an on-demand digest of what matters now (not injected at session start)\n'
    + '• lessons {path} — durable lessons for a REPO-RELATIVE file; run before editing it\n'
    + '• search {query, kind?, limit?} — search before writing anything; ask in English, and '
    + 'quote a stored title or an exact identifier verbatim to reach a record '
    + 'written in another language. Answers a BARE ARRAY of {id, title, snippet}\n'
    + '• get {id|uuid, follow?} — one entry whole, body included. An id written down '
    + 'earlier names the version live back then: follow:"latest" reads the current one '
    + 'instead, follow:"full_history" adds the lineage root to leaf\n'
    + '• append {kind, title, body, links?, overturns?, closes?} — a durable fact; overturns: ids of live rules it replaces; '
    + 'closes: task ids a DECISION withdraws (closed cancelled, the decision is the evidence; any other kind is refused) '
    + '(kind: feedback|reference|project|decision), or report to DELIVER a Svod '
    + 'report (body must be the JSON object itself). A report answer naming an id IS the '
    + 'delivery — do NOT re-deliver via the CLI; with no MEMORYCTL_SESSION_ID this route '
    + 'refuses reports and names the CLI command that carries your attempt identity\n'
    + '• supersede {id, title, body, long?} — replace a live entry; lesson replacements pass the brevity gate\n'
    + '• handoff {title, body, tasks?[], no_open_work?, closes?[]} — end of a work chunk. '
    + 'REFUSED unless it declares this session\'s open tails: tasks:[id,...] or no_open_work:true\n'
    + '• task_create {title, priority, next?, again?, domain?} — priority P0|P1; domain is a routing id (domain-<name>) or null to clear it; a reproduced defect or work the operator agreed to becomes a task, a finished one is closed instead; a title that repeats an existing task is REFUSED by number unless again:true\n'
    + '• task_list {status?} — open tails\n'
    + '• task_done {id, evidence} — close what you finished; evidence (sha | memory#id | what proves it) is REQUIRED\n'
    + 'A refusal names every problem at once and ends with the required shape: fix them together, '
    + 'do not re-send to discover the next one. Lessons are NOT written here — use '
    + 'scripts/memory/capture-lesson.mjs so they land in curator quarantine.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['hot', 'lessons', 'search', 'get', 'append', 'supersede', 'handoff', 'task_create', 'task_list', 'task_done'],
        description: 'Which memory operation to run.',
      },
      args: {
        type: 'object',
        description: 'Arguments for the action, as listed in the tool description. Omit for hot.',
        additionalProperties: true,
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

function readToken() {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/// Every write carries who wrote it and in which session, exactly as the CLI
/// does — attribution is the point, not decoration.
function attributed(body) {
  return {
    // An explicit env override wins, exactly as it does for the CLI; the MCP
    // client's own name is the fallback, because "which member wrote this" is
    // the question this route exists to make answerable.
    session_id: sessionId || `mcp-${process.pid}`,
    agent: clientName || clientInfoName || 'mcp',
    ...body,
  };
}

/// action -> HTTP. Kept parallel to the CLI's own mapping so the two cannot
/// drift into disagreeing about the same store.
function plan(action, args) {
  const a = args && typeof args === 'object' ? args : {};
  switch (action) {
    case 'hot':
      return { method: 'GET', path: `/api/memory/hot${query({ budget_kb: a.budget_kb, scope: a.scope })}` };
    case 'lessons': {
      if (!a.path) throw new Error('lessons needs {path} — a REPO-RELATIVE file path');
      return { method: 'GET', path: `/api/memory/lessons${query({ path: a.path })}` };
    }
    case 'search': {
      if (!a.query) throw new Error('search needs {query}');
      return { method: 'GET', path: `/api/memory/search${query({ q: a.query, kind: a.kind, limit: a.limit })}` };
    }
    case 'get': {
      // search answers with a snippet and hot with a line apiece, so without this
      // an MCP-only runtime — grok and glm have no memory hook at all — could not
      // read the handoff it was just told to read.
      if (a.id === undefined && !a.uuid) throw new Error('get needs {id} or {uuid}');
      return {
        method: 'GET',
        path: `/api/memory/entry${query({ id: a.id, uuid: a.uuid, follow: a.follow })}`,
      };
    }
    case 'append': {
      if (!a.kind || !a.title) throw new Error('append needs {kind, title, body}');
      // A report is a DELIVERY, read back by attempt session - not an ordinary
      // fact. This route is bound to the attempt only through
      // MEMORYCTL_SESSION_ID, which Svod sets on the member's launch and a
      // runtime may or may not pass on to its MCP servers. Without it the
      // entry lands under `mcp-<pid>`: filed, answered with an id, and
      // invisible to the read-back - measured 2026-08-12, six codex-seat
      // reports orphaned exactly this way (ids 2149, 2152, 2365, 2404, 2419,
      // 2437), each a "successful" delivery Svod never saw. An invisible
      // success is worse than a refusal: the refusal reaches the member while
      // it still has the context to take the route that IS bound. Only
      // kind=report is gated - a decision or a handoff has no attempt reader,
      // and the operator's own sessions run unbound by design.
      if (a.kind === 'report' && !process.env.MEMORYCTL_SESSION_ID) {
        throw new Error(
          'refusing kind=report over this MCP route: it holds no MEMORYCTL_SESSION_ID, so the '
          + `report would be filed under session mcp-${process.pid}, which no Svod attempt can `
          + 'read back - delivered and invisible at once. Nothing was written. Deliver through '
          + 'the CLI instead: pipe the JSON object into `memoryctl append --kind report --title '
          + '"review" -` - the CLI inherits MEMORYCTL_SESSION_ID from your launch, and an answer '
          + 'naming an id IS the delivery.',
        );
      }
      return {
        method: 'POST',
        path: '/api/memory/append',
        body: attributed({
          kind: a.kind,
          title: a.title,
          body: a.body ?? '',
          links: a.links,
          sha_refs: a.sha_refs,
          overturns: a.overturns,
          pinned: Boolean(a.pinned),
          key: a.key,
          no_open_work: Boolean(a.no_open_work),
          tasks: a.tasks,
          closes: a.closes,
        }),
      };
    }
    case 'supersede': {
      if (!a.id || !a.title || typeof a.body !== 'string') throw new Error('supersede needs {id, title, body}');
      return { method: 'POST', path: '/api/memory/supersede', body: attributed({
        id: Number(a.id), title: a.title, body: a.body, links: a.links,
        sha_refs: a.sha_refs, pinned: a.pinned, no_open_work: Boolean(a.no_open_work),
        tasks: a.tasks, closes: a.closes,
      }) };
    }
    case 'handoff': {
      if (!a.title) throw new Error('handoff needs {title, body}');
      return {
        method: 'POST',
        path: '/api/memory/handoff',
        body: attributed({
          title: a.title,
          body: a.body ?? '',
          no_open_work: Boolean(a.no_open_work),
          tasks: a.tasks,
          closes: a.closes,
        }),
      };
    }
    case 'task_create': {
      if (!a.title || !a.priority) throw new Error('task_create needs {title, priority} (P0|P1)');
      return {
        method: 'POST',
        path: '/api/memory/task',
        body: attributed({
          title: a.title,
          priority: a.priority,
          next_action: a.next ?? a.next_action,
          status: a.status,
          track: a.track,
          body: a.body,
          depends_on: a.depends_on,
          links: a.links,
          // A routing id of the routing map, or null to clear; omitted keeps
          // what the row has. Judged in the service, like the duplicate gate.
          domain: a.domain,
          // The duplicate refusal is in the SERVICE, so both routes meet it and
          // neither can be used to dodge the other. This is how a caller says
          // out loud that the work genuinely came back.
          again: a.again === true,
        }),
      };
    }
    case 'task_list':
      // No default status. `status: 'open'` was a helpful-looking invention that
      // made this route unable to answer what the CLI answers with no flag at
      // all — and `status: 'all'` is not a value the service knows, so the
      // caller could not get back to the unfiltered view either.
      return {
        method: 'GET',
        path: `/api/memory/tasks${query({ status: a.status, priority: a.priority, track: a.track })}`,
      };
    case 'task_done': {
      if (a.id === undefined || !a.evidence) throw new Error('task_done needs {id, evidence}: the sha, memory#id or measurement that proves it is done');
      return {
        method: 'POST',
        path: '/api/memory/task/update',
        body: attributed({ id: Number(a.id), status: 'done', evidence: String(a.evidence) }),
      };
    }
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}`);
  }
}

async function callMemory(action, args) {
  const step = plan(action, args);
  let quality;
  if (action === 'append' && args?.kind === 'lesson') {
    checkCaptureFields(lessonFields(args.title, args.body));
    // memoryd refuses a new lesson without the capture-gate marker (store.mjs
    // lessonGateProblem); refusing here names the right command before the POST.
    throw new Error('lesson append refused: use scripts/memory/capture-lesson.mjs to run the route, anchor, Jev and duplicate gates');
  }
  if (action === 'supersede') {
    const old = await callMemory('get', { id: args.id });
    let entry;
    try { entry = JSON.parse(old); } catch { throw new Error('cannot identify entry kind before supersede'); }
    if (entry.kind === 'lesson') {
      const change = lessonChanges(entry, args.title, args.body, { links: args.links });
      quality = await checkLesson(change.fields, { only: change.only, long: args.long });
      checkCaptureFields(change.fields, { only: change.only });
      step.body.body = withLongReason(step.body.body, quality.longIgnored ? undefined : args.long);
    } else if (args.long !== undefined) throw new Error('--long is for lessons only');
  }
  // The same Accept the CLI sends. It matters: with json alone the service
  // returns the lessons ENVELOPE, and an agent wants the rendered markdown that
  // `memoryctl lessons` prints.
  const headers = { accept: 'application/json, text/markdown, */*' };
  let payload;
  if (step.body) {
    headers['content-type'] = 'application/json; charset=utf-8';
    const token = readToken();
    // GETs need no token; a write without one is a 401 the caller cannot fix,
    // so say where the token is expected rather than echoing the refusal.
    if (!token) throw new Error(`no memory token at ${TOKEN_FILE} — is the memory service running?`);
    // X-Memory-Token, NOT Authorization: Bearer. Guessing the latter cost a 401
    // that reads like a bad token rather than a wrong header.
    headers['x-memory-token'] = token;
    payload = JSON.stringify(step.body);
  }
  let answer;
  try {
    answer = await fetch(`${BASE}${step.path}`, {
      method: step.method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Name the stall rather than letting it read like a network refusal: a
    // timeout here means the service ACCEPTED the connection and went quiet,
    // which is what a stuck single-writer SQLite looks like from outside.
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(
        `memory service did not answer ${step.path} within ${REQUEST_TIMEOUT_MS}ms — it is up but stuck; nothing was written`,
      );
    }
    throw error;
  }
  const text = await answer.text();
  if (!answer.ok) {
    // The refusal body IS the contract message — hand it back verbatim.
    throw new Error(`HTTP ${answer.status} from ${step.path}: ${text.trim()}`);
  }
  if (action === 'lessons') return renderLessons(text);
  if (action === 'append' && args && args.kind === 'report') return reportDelivery(text);
  return text;
}

/// A delivered report must SAY it is delivered, in the words the member's
/// completion contract uses — a bare `{"id":...}` did not.
///
/// Measured 2026-08-10 (task 396): a glm member filed its report through this
/// tool, got an id back, read its contract's "do not substitute an MCP" as
/// "that did not count", and spent nine more calls pushing the identical
/// bytes through the CLI. The id was in the answer; what was missing was the
/// sentence saying the delivery is DONE and a repeat is a second report, not
/// a confirmation. Only the BOUND route gets here — `plan` refuses an unbound
/// report above — so the session this names is the attempt Svod reads back.
function reportDelivery(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // an unexpected answer shape is the service's own to explain
  }
  if (parsed.dedup) {
    return `ALREADY DELIVERED: this exact report is on file as id ${parsed.id} under this `
      + 'attempt\'s session - the first delivery counted, and this repeat changed nothing. '
      + `Do not deliver again through any route. (service answer: ${raw})`;
  }
  return `DELIVERED: report id ${parsed.id} is filed under this attempt's session, which is `
    + 'exactly what Svod reads back. This IS the delivery - it ends the task; do NOT re-deliver '
    + 'through the memoryctl CLI or a second MCP call, because a repeat is a second report, not '
    + 'a confirmation. Keep the id only for a genuine correction (memoryctl supersede). '
    + `(service answer: ${raw})`;
}

/// The lessons route answers a JSON envelope and the CLI renders it client-side;
/// this renders the SAME blocks, because the whole point of the tool is to give
/// a runtime without the domain-lessons hook exactly what that hook delivers.
/// Returning the envelope instead would hand the agent a parsing chore where the
/// hook hands its peers prose.

// ---------------------------------------------------------------- transport

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  if (id === undefined || id === null) return; // a notification takes no answer
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(request) {
  const { id, method, params } = request;

  if (method === 'initialize') {
    const client = params && params.clientInfo;
    if (client && client.name) clientInfoName = String(client.name);
    if (!sessionId && params && params.sessionId) sessionId = String(params.sessionId);
    reply(id, {
      // Echo the client's version when it names one: this server speaks a
      // subset every revision shares, so refusing on a version it did not
      // anticipate would cost reach for nothing.
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: [TOOL] });
  if (method === 'resources/list') return reply(id, { resources: [] });
  if (method === 'prompts/list') return reply(id, { prompts: [] });

  if (method === 'tools/call') {
    const name = params && params.name;
    if (name !== TOOL.name) return replyError(id, -32602, `unknown tool ${JSON.stringify(name)}`);
    const args = (params && params.arguments) || {};
    try {
      const text = await callMemory(args.action, args.args);
      reply(id, { content: [{ type: 'text', text: text || '(empty)' }] });
    } catch (error) {
      // A tool error, never a protocol error: memory must never break a
      // session, and the caller needs the refusal text to act on it.
      reply(id, {
        content: [{ type: 'text', text: String((error && error.message) || error) }],
        isError: true,
      });
    }
    return;
  }

  replyError(id, -32601, `method not found: ${method}`);
}

// Only when this file IS the program. Importing it (a test reaching for
// `renderLessons`) must not start a server that then waits on stdin forever.
//
// Compared by REAL path on both sides. `import.meta.url` is already resolved
// through symlinks while `process.argv[1]` is whatever the caller typed, so a
// launch through a symlinked path made the two differ and the server would have
// started, printed nothing and waited on a stdin it never read - a silent MCP
// server, which is the one failure mode a client cannot tell from a slow one.
// Nothing spawns it that way today (`ops/bootstrap/mcp-servers.json` names the
// unsymlinked file), which is why this is written before it is needed rather
// than after. Named by the glm seat of round `harness-tails-r1`.
const startedAsProgram = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    // An argv[1] that cannot be resolved is not this file.
    return false;
  }
})();
if (startedAsProgram) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      continue; // a malformed frame is not ours to answer
    }
    try {
      await handle(request);
    } catch (error) {
      replyError(request && request.id, -32603, String((error && error.message) || error));
    }
  }
}
