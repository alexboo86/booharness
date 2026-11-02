// The seat transcript HTTP route (task 3459 D1b-wire): serves readSeatTranscript
// over GET /api/seats/<seatId>/transcript for the pult client, unchanged. The
// route lives on the loopback server only (serveBoardAndFiles); the LAN board
// never calls it, and the loopback Host/Origin guard runs before routing.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readSeatTranscript, type SeatTranscriptOptions } from './store.ts';
import type { Runtime } from './http.ts';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const TRANSCRIPT_ROUTE = /^\/api\/seats\/([^/]+)\/transcript$/;

/** The daemon piece this route reads: the seat store. */
type TranscriptRuntime = Pick<Runtime, 'store'>;

/** An optional integer query parameter, parsed the way the other GET routes parse numbers. */
function intParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

/**
 * The seat transcript service. Returns true when the request was served (any
 * `/api/seats/<seatId>/transcript` answer, success or error); false when the path is not
 * this route's, so the caller falls through. Answers the readSeatTranscript result as JSON
 * unchanged, including its available:false reasons; range validation stays in the reader
 * (invalid_options). An unknown seat is 404, a malformed parameter 400, a non-GET 405;
 * errors are the loopback board's `{"error": "<message>"}` shape.
 */
export async function handleSeatTranscript(rt: TranscriptRuntime, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = TRANSCRIPT_ROUTE.exec(url.pathname);
  if (!match) return false;
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'the seat transcript route is GET only' });
    return true;
  }
  let seatId: string;
  let options: SeatTranscriptOptions;
  try {
    seatId = decodeURIComponent(match[1]);
    const limit = intParam(url.searchParams, 'limit');
    if (limit === undefined) throw new Error('limit is required');
    options = { limit, since: intParam(url.searchParams, 'since'), turn: intParam(url.searchParams, 'turn') };
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
    return true;
  }
  const seat = rt.store.getSeat(seatId);
  if (!seat) {
    sendJson(res, 404, { error: `no seat '${seatId}'` });
    return true;
  }
  sendJson(res, 200, await readSeatTranscript(seat, options));
  return true;
}
