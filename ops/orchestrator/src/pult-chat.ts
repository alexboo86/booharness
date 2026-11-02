// Lead-oriented, read-only projection for the pult chat. The SQLite rows stay
// private to the daemon: every response below is built from named fields.
import type { Seat, Store } from './store.ts';

type Binding = {
  handle: string;
  session: string;
  generation: number;
  bound_at: string;
  ended_at: string | null;
  desktop: string | null;
  receipt_at: string | null;
};

export type PultSeat = {
  id: string;
  role: string;
  family: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type PultLead = {
  handle: string;
  session: string;
  desktop: string | null;
  live: boolean;
  boundAt: string;
  endedAt: string | null;
  lastSeen: string;
  seats: PultSeat[];
};

export type PultFeedEvent = {
  id: string;
  /** Resume cursor after this event: `<last events.seq>:<last chat_posts.id>` delivered so far. */
  cursor: string;
  at: string;
  type: 'seat.created' | 'turn.started' | 'turn.finished' | 'seat.closed' | 'seat.landed' | 'chat.post';
  data: Record<string, unknown>;
};

function bindings(store: Store): Binding[] {
  return store.db.prepare(`SELECT b.*, (
    SELECT MAX(at) FROM (
      SELECT delivered_at AS at FROM chat_receipts WHERE handle = b.handle
      UNION ALL SELECT confirmed_at AS at FROM chat_receipts WHERE handle = b.handle
    )
  ) AS receipt_at FROM chat_bindings b ORDER BY b.bound_at, b.generation, b.handle`).all()
    .map((row) => ({ ...(row as unknown as Binding), receipt_at: (row.receipt_at ?? null) as string | null }));
}

function seatView(seat: Seat): PultSeat {
  return {
    id: seat.id, role: seat.role, family: seat.family, title: seat.title, status: seat.status,
    createdAt: seat.created_at, updatedAt: seat.updated_at,
  };
}

function leadOf(seat: Seat, rows: readonly Binding[]): string | null {
  const session = seat.data.leadSession;
  if (typeof session !== 'string') return null;
  const candidates = rows.filter((row) => row.session === session);
  // Prefer the binding that was current at seat creation. The fallback still
  // resolves legacy rows whose timestamps predate the recorded binding.
  return (candidates.filter((row) => row.bound_at <= seat.created_at && (row.ended_at === null || row.ended_at >= seat.created_at)).at(-1)
    ?? candidates.at(-1))?.handle ?? null;
}

/** The creating lead of one seat, resolved across live and ended chat bindings. */
export function pultLeadHandle(store: Store, seat: Seat): string | null {
  return leadOf(seat, bindings(store));
}

function grouped(store: Store): { rows: Binding[]; seats: Seat[]; byLead: Map<string, Seat[]>; unassigned: Seat[] } {
  const rows = bindings(store);
  // This is a history read, not a polled hot path: the roster intentionally
  // includes closed seats and ended leads.
  const seats = store.listSeats();
  const byLead = new Map<string, Seat[]>();
  const unassigned: Seat[] = [];
  for (const seat of seats) {
    const handle = leadOf(seat, rows);
    if (handle === null) unassigned.push(seat);
    else {
      const owned = byLead.get(handle) ?? [];
      owned.push(seat);
      byLead.set(handle, owned);
    }
  }
  return { rows, seats, byLead, unassigned };
}

/** Every handle that has held a lead chat binding, with all of its seats nested. */
export function pultRoster(store: Store, requests: ReadonlyMap<string, number> = new Map()): { leads: PultLead[]; unassigned: PultSeat[] } {
  const { rows, byLead, unassigned } = grouped(store);
  const latest = new Map<string, Binding>();
  for (const row of rows) {
    // A board release writes an operator tombstone generation; it ends the
    // lead binding but is not the lead's session identity.
    if (row.session === 'operator') continue;
    const current = latest.get(row.handle);
    if (!current || row.generation > current.generation) latest.set(row.handle, row);
  }
  const leads = [...latest.values()].map((row): PultLead => {
    const request = requests.get(row.session);
    const lastSeen = [row.bound_at, row.ended_at, row.receipt_at, request === undefined ? null : new Date(request).toISOString()]
      .filter((at): at is string => at !== null).sort().at(-1)!;
    return {
      handle: row.handle, session: row.session, desktop: row.desktop, live: row.ended_at === null,
      boundAt: row.bound_at, endedAt: row.ended_at, lastSeen,
      seats: (byLead.get(row.handle) ?? []).map(seatView),
    };
  }).sort((a, b) => a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0);
  return { leads, unassigned: unassigned.map(seatView) };
}

function reportFacts(text: string | null): { reportStatus: string | null; verdict: string | null; changedFileCount: number | null } {
  if (text === null) return { reportStatus: null, verdict: null, changedFileCount: null };
  const match = /^```json\r?\n([\s\S]*?)\r?\n```$/.exec(text.trim());
  if (!match) return { reportStatus: null, verdict: null, changedFileCount: null };
  try {
    const report: unknown = JSON.parse(match[1]);
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('not an object');
    const row = report as Record<string, unknown>;
    return {
      reportStatus: typeof row.status === 'string' ? row.status : null,
      verdict: typeof row.verdict === 'string' ? row.verdict : null,
      changedFileCount: Array.isArray(row.changedFiles) ? row.changedFiles.length : null,
    };
  } catch {
    return { reportStatus: null, verdict: null, changedFileCount: null };
  }
}

type StoredEventRow = { seq: number; ts: string; kind: string; seat_id: string; payload: string };
type FeedFact = Omit<PultFeedEvent, 'cursor'>;
/** A fact with its position in its own append-only source (events.seq or chat_posts.id). */
type SourcedFact = { fact: FeedFact; source: number };

function landedFact(base: Pick<FeedFact, 'id' | 'at'>, seat: Seat, payload: Record<string, unknown>): FeedFact | null {
  if (!payload.landed || typeof payload.landed !== 'object' || Array.isArray(payload.landed)) return null;
  const landed = payload.landed as Record<string, unknown>;
  return { ...base, type: 'seat.landed', data: { seat: seat.id, into: landed.into ?? null, paths: landed.paths ?? null } };
}

function finishedFact(store: Store, seat: Seat, base: Pick<FeedFact, 'id' | 'at'>, payload: Record<string, unknown>): FeedFact {
  const turn = typeof payload.turn === 'string' ? store.getTurn(payload.turn) : null;
  return { ...base, type: 'turn.finished', data: {
    seat: seat.id, turn: payload.turn ?? null, status: payload.status ?? turn?.status ?? null,
    ...(turn ? reportFacts(turn.text) : { reportStatus: null, verdict: null, changedFileCount: null }),
    error: turn?.error ?? null,
  } };
}

function storeFact(store: Store, seat: Seat, row: StoredEventRow): FeedFact | null {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const base = { id: `event:${row.seq}`, at: row.ts };
  if (row.kind === 'seat.created') return { ...base, type: 'seat.created', data: { seat: seat.id, role: seat.role, family: seat.family, title: seat.title, status: payload.status ?? seat.status } };
  if (row.kind === 'turn.started') return { ...base, type: 'turn.started', data: { seat: seat.id, turn: payload.turn ?? null } };
  if (row.kind === 'seat.closed') return { ...base, type: 'seat.closed', data: { seat: seat.id, status: payload.status ?? 'closed' } };
  if (row.kind === 'seat.updated') return landedFact(base, seat, payload);
  if (row.kind === 'turn.ended') return finishedFact(store, seat, base, payload);
  return null;
}

function storeFacts(store: Store, seats: readonly Seat[], after: number): SourcedFact[] {
  if (!seats.length) return [];
  const byId = new Map(seats.map((seat) => [seat.id, seat]));
  const placeholders = seats.map(() => '?').join(',');
  const rows = store.db.prepare(`SELECT seq, ts, kind, seat_id, payload FROM events
    WHERE seq > ? AND seat_id IN (${placeholders}) AND kind IN ('seat.created', 'turn.started', 'turn.ended', 'seat.closed', 'seat.updated')
    ORDER BY seq`).all(after, ...byId.keys()) as unknown as StoredEventRow[];
  return rows.flatMap((row) => {
    const fact = storeFact(store, byId.get(row.seat_id)!, row);
    return fact ? [{ fact, source: row.seq }] : [];
  });
}

function chatFacts(store: Store, handle: string, after: number): SourcedFact[] {
  const rows = store.db.prepare(`SELECT id, at, author, body, to_json, wake FROM chat_posts WHERE id > ? AND (author = ?
    OR to_json = 'all' OR EXISTS (SELECT 1 FROM json_each(chat_posts.to_json) WHERE json_each.value = ? OR json_each.value = 'all'))
    ORDER BY id`).all(after, handle, handle) as unknown as { id: number; at: string; author: string; body: string; to_json: string | null; wake: number }[];
  return rows.map((row) => ({ source: row.id, fact: {
    id: `chat:${row.id}`, at: row.at, type: 'chat.post',
    data: { id: row.id, at: row.at, author: row.author, body: row.body, to: row.to_json === null ? null : JSON.parse(row.to_json), wake: row.wake === 1 },
  } }));
}

function parseCursor(value: string): [number, number] {
  const match = /^(\d+):(\d+)$/.exec(value);
  const parts = match ? [Number(match[1]), Number(match[2])] as [number, number] : null;
  if (!parts || !parts.every(Number.isSafeInteger)) throw new Error("since must be a cursor '<events seq>:<chat post id>'");
  return parts;
}

/** Merge two source-ordered fact lists by timestamp, advancing each source's cursor part. */
function mergeFacts(stored: SourcedFact[], chats: SourcedFact[], cursor: [number, number], limit: number): {
  events: PultFeedEvent[]; cursor: [number, number]; hasMore: boolean;
} {
  let [eventAfter, chatAfter] = cursor;
  const events: PultFeedEvent[] = [];
  let s = 0, c = 0;
  while (events.length < limit && (s < stored.length || c < chats.length)) {
    // Ties go to the store event so the merge order is deterministic.
    const fromStore = c >= chats.length || (s < stored.length && stored[s]!.fact.at <= chats[c]!.fact.at);
    const next = fromStore ? stored[s++]! : chats[c++]!;
    if (fromStore) eventAfter = next.source;
    else chatAfter = next.source;
    events.push({ ...next.fact, cursor: `${eventAfter}:${chatAfter}` });
  }
  return { events, cursor: [eventAfter, chatAfter], hasMore: s < stored.length || c < chats.length };
}

/**
 * One lead's immutable facts. Each source (store events, chat posts) is read in
 * its own append-only id order and the two are merged by timestamp, so the
 * cursor `<events seq>:<chat post id>` names exactly the delivered prefix of
 * each source: a resume never repeats or skips a fact, even one stamped earlier
 * than facts already read. `streamSeq` at the HTTP boundary is the independent
 * per-run /events cursor used for live replay.
 */
export function pultFeed(store: Store, { handle, since = '0:0', limit = 200 }: { handle: string; since?: string; limit?: number }): {
  handle: string; events: PultFeedEvent[]; nextCursor: string; hasMore: boolean;
} | null {
  const start = parseCursor(since);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be an integer from 1-500');
  const { rows, byLead } = grouped(store);
  if (!rows.some((row) => row.handle === handle)) return null;
  const stored = storeFacts(store, byLead.get(handle) ?? [], start[0]);
  const chats = chatFacts(store, handle, start[1]);
  const { events, cursor, hasMore } = mergeFacts(stored, chats, start, limit);
  return { handle, events, nextCursor: cursor.join(':'), hasMore };
}
