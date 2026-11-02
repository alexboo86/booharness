// The seat diff HTTP route (task 3459 R6): a read-only view of the accumulated
// change over GET /api/seats/<seatId>/diff. It lives on the loopback board only;
// the LAN board never calls it, and the Host/Origin guard runs before routing.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readSeatDiff, SEAT_DIFF_PATCH_CAP } from './land.ts';
import type { Runtime } from './http.ts';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const DIFF_ROUTE = /^\/api\/seats\/([^/]+)\/diff$/;

type DiffRuntime = Pick<Runtime, 'store'>;

/** An optional integer query parameter, parsed like the other GET routes parse numbers. */
function intParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

/**
 * The accumulated seat diff service. `maxBytes` can lower (never raise) the 1 MiB
 * aggregate patch budget. Every file keeps its metadata when its patch is cut or
 * omitted, and per-file plus overall `truncated` flags make every omission explicit.
 * An unknown seat is 404, a malformed parameter 400 and a non-GET 405.
 */
export async function handleSeatDiff(rt: DiffRuntime, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = DIFF_ROUTE.exec(url.pathname);
  if (!match) return false;
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'the seat diff route is GET only' });
    return true;
  }
  let seatId: string;
  let maxBytes: number | undefined;
  try {
    seatId = decodeURIComponent(match[1]);
    maxBytes = intParam(url.searchParams, 'maxBytes');
    if (maxBytes !== undefined && (maxBytes <= 0 || maxBytes > SEAT_DIFF_PATCH_CAP)) throw new Error(`maxBytes must be an integer from 1 to ${SEAT_DIFF_PATCH_CAP}`);
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
    return true;
  }
  const seat = rt.store.getSeat(seatId);
  if (!seat) {
    sendJson(res, 404, { error: `no seat '${seatId}'` });
    return true;
  }
  sendJson(res, 200, await readSeatDiff(seat, maxBytes));
  return true;
}
