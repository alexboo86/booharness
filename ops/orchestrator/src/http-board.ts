// Board HTTP routes shared by the loopback and restricted LAN listeners.
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { hostname } from 'node:os';
import type { Runtime } from './http.ts';
import { board, DASHBOARD_HTML } from './dashboard.ts';
import { chatList, chatPostOperator } from './chat.ts';
import { readJson, sendJson } from './http-leads.ts';
import { handlePultFiles } from './pult-files.ts';
import { handleSeatTranscript } from './pult-transcript.ts';
import { handleSeatDiff } from './pult-diff.ts';
import { handleModelLogin } from './http-model-login.ts';
import { section, span } from './shared.entry.ts';

async function serveDashboard(rt: Runtime, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(DASHBOARD_HTML);
    return true;
  }
  if (pathname === '/api/dashboard') {
    sendJson(res, 200, await board(rt));
    return true;
  }
  return false;
}

/** The loopback board, the pult chat projection, the model login argv, workspace files, seat transcripts and diffs; the LAN board calls serveDashboard alone. */
export async function serveBoardAndFiles(rt: Runtime, req: IncomingMessage, res: ServerResponse, url: URL, pultChat: () => boolean): Promise<boolean> {
  // Each async handler is awaited: an un-awaited Promise is always truthy and would end the chain.
  // The login route stays ahead of any general /api/models handler that joins later (A1).
  return (await serveDashboard(rt, req, res, url.pathname)) || pultChat() || handleModelLogin(req, res, url) || (await handlePultFiles(rt, req, res, url)) || (await handleSeatTranscript(rt, req, res, url)) || (await handleSeatDiff(rt, req, res, url));
}

export async function serveOperatorPost(rt: Runtime, req: IncomingMessage, res: ServerResponse, ownOrigin: string): Promise<void> {
  // Host is validated by the listener first; browser writes also need its exact Origin and this header.
  if (req.headers.origin !== ownOrigin || req.headers['x-orch-chat'] !== '1') {
    sendJson(res, 403, { error: 'chat post requires the board origin and X-Orch-Chat: 1' });
    return;
  }
  try {
    const body = await readJson(req, 64 * 1024);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object');
    for (const key of Object.keys(body)) {
      if (!['body', 'to', 'wake'].includes(key)) throw new Error(`chat post takes no '${key}'`);
    }
    sendJson(res, 200, chatPostOperator(rt.store, body as Parameters<typeof chatPostOperator>[1]));
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
  }
}

// The sessions with a held /chat/wake poll, for each runtime. The loopback server owns the polls; the LAN
// chat feed reads them through chatList, so a receipt state on the phone equals the one on the loopback
// board (task 2286). The session ids stay inside chatList.
export const heldWakes = new WeakMap<Runtime, () => string[]>();
export const chatRequests = new WeakMap<Runtime, ReadonlyMap<string, number>>();

function serveLanChat(rt: Runtime, res: ServerResponse, url: URL): void {
  const numberParam = (name: string) => {
    const value = url.searchParams.get(name);
    return value === null ? undefined : value.trim() === '' ? NaN : Number(value);
  };
  try {
    const { posts, handles, watchers } = chatList(rt.store, {
      after: numberParam('after'), limit: numberParam('limit'), held: heldWakes.get(rt)?.() ?? [], requests: chatRequests.get(rt),
    });
    sendJson(res, 200, { posts, handles: handles.map(({ handle, bound_at }) => ({ handle, bound_at })), watchers, readOnly: false, canRelease: false });
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
  }
}

function lanHostReason(value: string | undefined, ownNames: ReadonlySet<string>): string | null {
  if (!value) return 'Host is required';
  const parts = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(value.toLowerCase());
  if (!parts || Number(parts[2] ?? 0) > 65535) return 'Invalid Host';
  const name = parts[1];
  const literal = name.startsWith('[') ? isIP(name.slice(1, -1)) === 6 : isIP(name) === 4;
  return literal || ownNames.has(name) ? null : 'Host must be an IP literal or this machine';
}

async function serveLanRoute(rt: Runtime, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname;
  const route = `${req.method} ${pathname}`;
  if (route === 'POST /chat/post') {
    await serveOperatorPost(rt, req, res, `http://${req.headers.host ?? ''}`);
    return;
  }
  if (pathname === '/api/chat') {
    serveLanChat(rt, res, url);
    return;
  }
  await serveDashboard(rt, req, res, pathname);
}

async function serveLanRequest(rt: Runtime, ownNames: ReadonlySet<string>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const refused = lanHostReason(req.headers.host, ownNames);
  if (refused) {
    sendJson(res, 403, { error: refused });
    return;
  }
  let url: URL;
  try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
  catch { res.writeHead(404); res.end(); return; }
  const pathname = url.pathname;
  rt.loop?.mark(`lan ${req.method} ${pathname}`);
  const route = `${req.method} ${pathname}`;
  if (!['GET /', 'GET /api/dashboard', 'GET /api/chat', 'POST /chat/post'].includes(route)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    await serveLanRoute(rt, req, res, url);
  } catch (error) {
    rt.log('error', 'http.error', { url: req.url, message: (error as Error).message });
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
}

/** LAN board with operator chat posting; every control-plane route stays loopback-only. */
export function createLanBoardServer(rt: Runtime): HttpServer {
  const machine = hostname().toLowerCase().replace(/\.local$/, '');
  const ownNames = new Set([machine, machine + '.local']);
  // The span times the handler's synchronous prefix (the run until its first
  // await); the section spans the whole request, awaits included, so a stall
  // records which requests were in flight (context, not the proven blocker).
  // Let our Host guard return a consistent JSON 403 even when HTTP/1.1 omits Host.
  const server = createServer({ requireHostHeader: false }, (req, res) => {
    const label = `lan ${req.method} ${(req.url ?? '/').split('?')[0]}`;
    res.once('close', section(label));
    span(label, () => serveLanRequest(rt, ownNames, req, res));
  });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}
