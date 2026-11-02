// The daemon's push channel: one WebSocket endpoint (GET /events) streams typed JSON events
// to loopback clients (the pult desktop). No installed dependency provides a WebSocket
// server — package.json pins only the MCP SDK and undici, and undici's WebSocket is a
// client — so this file carries the minimal RFC 6455 server framing (handshake, text
// frames, ping/pong, close). Events are emitted where the state changes already happen
// (http.ts wires store and chat observers); this module holds no state of its own beyond
// the per-run seq, the replay ring and the socket registry.
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Logger } from './log.ts';
import type { TurnEvent } from './providers/index.ts';

/** The stream event types a client may receive; `resync` answers a replay gap. */
export type EventType = 'seat.created' | 'seat.status' | 'seat.closed' | 'seat.landed' | 'turn.started' | 'turn.finished' | 'turn.event' | 'chat.post' | 'lead.event';
export type StreamEvent = { type: EventType | 'resync'; at: string; seq: number; data: Record<string, unknown> };

/** How many recent events a reconnecting client can still replay; older gaps force a resync. */
export const RING_SIZE = 512;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** This server never reads client payloads; it only refuses unreasonably large ones. */
const MAX_CLIENT_FRAME = 64 * 1024;
/** Buffered server output one client may hold before it is evicted; recovery is a `?since` replay. */
const MAX_CLIENT_BUFFERED = 1024 * 1024;
/** How long a closing socket may take to flush its close frame before it is force-destroyed. */
const CLOSE_GRACE_MS = 300;

/** `Sec-WebSocket-Accept` for a handshake key (RFC 6455 §4.2.2). */
function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

/** One server frame: FIN + opcode, unmasked, with the 7/16/64-bit length forms. */
function serverFrame(opcode: number, payload: Buffer): Buffer {
  const extra = payload.length < 126 ? 0 : payload.length < 65_536 ? 2 : 8;
  const frame = Buffer.alloc(2 + extra + payload.length);
  frame[0] = 0x80 | opcode;
  frame[1] = extra === 0 ? payload.length : extra === 2 ? 126 : 127;
  if (extra === 2) frame.writeUInt16BE(payload.length, 2);
  if (extra === 8) frame.writeBigUInt64BE(BigInt(payload.length), 2);
  payload.copy(frame, 2 + extra);
  return frame;
}

/** The extended length of a client frame: 7-bit, 16-bit or 64-bit form. `null` while incomplete. */
function takeLength(buffer: Buffer, marker: number): { length: number; next: number } | null {
  if (marker < 126) return { length: marker, next: 2 };
  if (marker === 126) {
    if (buffer.length < 4) return null;
    return { length: buffer.readUInt16BE(2), next: 4 };
  }
  if (buffer.length < 10) return null;
  const length = buffer.readBigUInt64BE(2);
  if (length > BigInt(MAX_CLIENT_FRAME)) throw new Error('frame too large');
  return { length: Number(length), next: 10 };
}

/** A close frame payload: the status code plus at most 123 bytes of reason text. */
function closePayload(code: number, reason: string): Buffer {
  return Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason, 'utf8').subarray(0, 123)]);
}

/** One parsed client frame from `buffer`; `null` while more bytes are needed. Throws on a protocol fault. */
function readFrame(buffer: Buffer): { opcode: number; rsv: number; fin: boolean; payload: Buffer; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const rsv = buffer[0] & 0x70;
  const fin = (buffer[0] & 0x80) !== 0;
  const masked = (buffer[1] & 0x80) !== 0;
  const taken = takeLength(buffer, buffer[1] & 0x7f);
  if (taken === null) return null;
  const { length, next } = taken;
  if (length > MAX_CLIENT_FRAME) throw new Error('frame too large');
  if (!masked) throw new Error('client frames must be masked');
  if (buffer.length < next + 4 + length) return null;
  const mask = buffer.subarray(next, next + 4);
  const payload = Buffer.from(buffer.subarray(next + 4, next + 4 + length));
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
  return { opcode, rsv, fin, payload, rest: buffer.subarray(next + 4 + length) };
}

/** A fault that keeps the 101 handshake from being sent, as a plain HTTP refusal with its status. */
function upgradeFault(req: IncomingMessage): { status: number; error: string } | null {
  if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return { status: 400, error: 'expected Upgrade: websocket' };
  if (req.method !== 'GET') return { status: 405, error: 'websocket upgrade requires GET' };
  if (req.headers['sec-websocket-version'] !== '13') return { status: 400, error: 'Sec-WebSocket-Version must be 13' };
  // RFC 6455 §4.2.1: exactly 16 random bytes, base64 — 24 characters ending in '=' padding.
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) {
    return { status: 400, error: 'Sec-WebSocket-Key must be base64 of 16 bytes' };
  }
  return null;
}

/** `?since=<seq>`: a non-negative integer, or the refusal for anything else. */
function sinceOf(url: URL): { value: number } | { error: string } | undefined {
  const raw = url.searchParams.get('since');
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) > Number.MAX_SAFE_INTEGER) return { error: 'since must be a non-negative integer event seq' };
  return { value: Number(raw) };
}

/** One connected client: writes frames, parses whatever it sends (close, ping; data is ignored). */
class StreamClient {
  private pending: Buffer = Buffer.alloc(0);
  private grace: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => { if (this.grace) clearTimeout(this.grace); });
  }

  send(text: string): void {
    if (this.closing || this.socket.destroyed) return;
    this.socket.write(serverFrame(0x1, Buffer.from(text, 'utf8')));
    // A peer that never reads may not turn the daemon into its buffer: past the budget it is
    // evicted (close frame + reason) and recovers by reconnecting with `?since=<seq>`.
    if (this.socket.writableLength > MAX_CLIENT_BUFFERED) this.close(1008, 'buffered events exceed the client budget');
  }

  /** A close frame carrying the reason; past the grace the connection is reset, FIN or no FIN from the peer. */
  close(code = 1001, reason = 'the server is closing', graceMs = CLOSE_GRACE_MS): void {
    if (this.closing || this.socket.destroyed) return;
    this.closing = true;
    this.socket.write(serverFrame(0x8, closePayload(code, reason)));
    // A cleanly ended socket can no longer reset its peer (measured: a reset after a flushed
    // end() is never delivered), so the grace resets the still-open socket instead: a peer
    // that answers the close frame closes first and never sees the reset.
    this.grace = setTimeout(() => {
      if (typeof this.socket.resetAndDestroy === 'function') this.socket.resetAndDestroy();
      else this.socket.destroy(new Error('close grace elapsed'));
    }, graceMs);
    this.grace.unref();
  }

  private onData(chunk: Buffer): void {
    let buffer: Buffer = Buffer.concat([this.pending, chunk]);
    try {
      for (let frame: ReturnType<typeof readFrame>; (frame = readFrame(buffer)) !== null;) {
        buffer = frame.rest;
        if (!this.handleFrame(frame)) return;
      }
    } catch (error) {
      // A framing fault drops this client only; it may not crash the daemon.
      this.socket.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.pending = buffer;
  }

  /** `false` ends the loop: the socket is gone or the peer must be dropped. */
  private handleFrame(frame: { opcode: number; rsv: number; fin: boolean; payload: Buffer }): boolean {
    if (frame.rsv !== 0) { this.drop(1002, 'extension bits were never negotiated'); return false; }
    if (!frame.fin) { this.drop(1002, 'fragmented client frames are not accepted'); return false; }
    if (frame.opcode === 0x8) { this.close(1000, 'client closed'); return false; }
    if (frame.opcode === 0x9) { this.socket.write(serverFrame(0xa, frame.payload.subarray(0, 125))); return true; }
    // 0x1 text, 0x2 binary, 0xa pong: this server never reads client data.
    const reserved = frame.opcode === 0x0 || (frame.opcode >= 0x3 && frame.opcode <= 0x7) || frame.opcode > 0xa;
    if (reserved) { this.drop(1002, `unexpected opcode ${frame.opcode}`); return false; }
    return true;
  }

  private drop(code: number, why: string): void {
    this.closing = true;
    if (this.grace) clearTimeout(this.grace);
    this.socket.write(serverFrame(0x8, closePayload(code, why)));
    this.socket.destroy(new Error(why));
  }
}

export type EventStreamOptions = { log: Logger; refuseUpgrade: (req: IncomingMessage) => string | null; ringSize?: number };

/** The /events endpoint: per-run seq, bounded replay ring and the connected client sockets. */
export class EventStream {
  private seq = 0;
  private readonly ring: StreamEvent[] = [];
  private readonly size: number;
  private readonly clients = new Set<StreamClient>();
  private readonly log: Logger;
  private readonly refuseUpgrade: (req: IncomingMessage) => string | null;

  constructor(options: EventStreamOptions) {
    this.log = options.log;
    this.refuseUpgrade = options.refuseUpgrade;
    this.size = options.ringSize ?? RING_SIZE;
  }

  /** Cursor for an initial HTTP read to resume this per-run stream without a gap. */
  get currentSeq(): number { return this.seq; }

  /** Record one event (monotonic per-run seq) and push it to every connected client. */
  emit(type: EventType, data: Record<string, unknown>): void {
    const event: StreamEvent = { type, at: new Date().toISOString(), seq: (this.seq += 1), data };
    this.ring.push(event);
    if (this.ring.length > this.size) this.ring.splice(0, this.ring.length - this.size);
    const text = JSON.stringify(event);
    for (const client of [...this.clients]) client.send(text);
  }

  /** Refuse an upgrade (or any request on an upgraded socket) with a plain HTTP status, then close. */
  refuse(socket: Socket, status: number, error: string): void {
    const body = JSON.stringify({ error });
    const reason = status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 405 ? 'Method Not Allowed' : 'Bad Request';
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    // No StreamClient ever tracks a refused socket, so closeClients() cannot reap it: without this
    // grace a peer that withholds FIN keeps the connection in the server's set and holds
    // `httpServer.close()` open forever. The refusal is flushed by `end()` before the grace fires,
    // and a peer that closes normally clears the timer on 'close'.
    const grace = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
    grace.unref();
    socket.once('close', () => clearTimeout(grace));
  }

  /** Accept one upgrade after the caller's loopback guard: handshake, optional replay, then live events. */
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const refusal = this.refuseUpgrade(req);
    if (refusal) {
      this.log('warn', 'events.refused', { reason: refusal, url: req.url });
      this.refuse(socket, 403, refusal);
      return;
    }
    const fault = upgradeFault(req);
    if (fault) { this.refuse(socket, fault.status, fault.error); return; }
    let url: URL;
    try {
      url = new URL(req.url ?? '/events', 'http://127.0.0.1');
    } catch {
      this.refuse(socket, 400, 'malformed request target');
      return;
    }
    const since = sinceOf(url);
    if (since && 'error' in since) { this.refuse(socket, 400, since.error); return; }
    const key = req.headers['sec-websocket-key'] as string;
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    // An upgraded socket leaves the server's HTTP timers behind; keepalive detects dead clients.
    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    const client = new StreamClient(socket);
    this.clients.add(client);
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => socket.destroy());
    if (head.length) socket.emit('data', head);
    if (since && 'value' in since) this.replay(client, since.value);
  }

  /** Events after `since` from the ring; a gap the ring no longer covers answers `resync`. */
  private replay(client: StreamClient, since: number): void {
    const oldest = this.ring.length ? this.ring[0].seq : this.seq + 1;
    if (since > this.seq || since + 1 < oldest) {
      client.send(JSON.stringify({ type: 'resync', at: new Date().toISOString(), seq: this.seq, data: {} }));
      return;
    }
    for (const event of this.ring) if (event.seq > since) client.send(JSON.stringify(event));
  }

  /** Server shutdown: no live client may hold `httpServer.close()` open. */
  closeClients(): void {
    for (const client of [...this.clients]) client.close();
  }
}

/** One live provider event of a running turn, as a `turn.event` frame carries it. */
export type TurnEventFrame = {
  seat: string;
  turn: string;
  kind: 'text' | 'thinking' | 'tool_start' | 'tool_end' | 'status';
  /** The coalesced delta text (`text`, `thinking`) or the status line (`status`). */
  text?: string;
  /** Present on `tool_start`/`tool_end`: `input` on start, `durationMs`/`isError` on end. */
  tool?: { id: string; name: string; input?: unknown; durationMs?: number; isError?: boolean };
};

/** Tool-event statuses that open a call; adapters may add others, which carry no frame. */
const TOOL_START_STATUSES = new Set(['started', 'pending', 'running']);
/** Tool-event statuses that close a call. */
const TOOL_END_STATUSES = new Set(['ended', 'completed', 'failed']);
/** Turns tracked at once: a turn whose `turn.ended` never lands (a killed daemon's client replaying) must not grow this forever. */
const MAX_TRACKED_TURNS = 256;

/** One tracked turn: the deltas a window still holds, per kind, and when each kind last left. */
type TrackedTurn = { seat: string; buffered: { text: string; thinking: string }; left: { text: number; thinking: number }; timer: ReturnType<typeof setTimeout> | null };

/** The status line for the provider events a turn reports without a frame kind of its own. */
function statusText(event: Exclude<TurnEvent, { kind: 'text' | 'thought' | 'tool' }>): string {
  switch (event.kind) {
    case 'usage': return `usage: ${event.tokens} tokens`;
    case 'compaction': return `context compacted (${event.entryId})`;
    case 'compaction_error': return `compaction failed: ${event.error}`;
    case 'permission': return `permission ${event.decision}: ${event.tool}`;
  }
}

/**
 * Publishes a running turn's provider events as `turn.event` frames (task 3465). Text and
 * thinking deltas coalesce to at most one frame per kind per 100 ms window — the first delta
 * of a window leaves at once, the rest waits for the window timer — so no delta text is lost
 * and a delta burst never spams the socket. Tool and status frames are never coalesced away
 * and never wait: each first drains whatever a window still held, so frames keep arrival
 * order (that drain may momentarily beat the 100 ms spacing; it merges everything pending
 * into one frame). `flush` drains a turn when it ends; `close` disarms every timer at shutdown.
 */
export class TurnEventPublisher {
  private readonly events: Pick<EventStream, 'emit'>;
  private readonly windowMs: number;
  private readonly turns = new Map<string, TrackedTurn>();

  constructor(events: Pick<EventStream, 'emit'>, windowMs = 100) {
    this.events = events;
    this.windowMs = windowMs;
  }

  /** One provider event of one running turn, sourced from the session's own event callback. */
  observe(seat: string, turn: string, event: TurnEvent): void {
    const state = this.track(seat, turn);
    if (event.kind === 'text' || event.kind === 'thought') this.buffer(turn, state, event.kind === 'text' ? 'text' : 'thinking', event.delta);
    else this.boundary(turn, state, event);
  }

  /** A turn's last frames: its buffered deltas drain whole and the tracked state goes. */
  flush(turn: string): void {
    const state = this.turns.get(turn);
    if (state === undefined) return;
    this.drop(turn);
    this.drain(turn, state);
  }

  /** Shutdown: disarm every window timer; buffered deltas are live-only and do not outlive the server. */
  close(): void {
    for (const turn of [...this.turns.keys()]) this.drop(turn);
  }

  /** The turn's tracked state; a turn never seen starts one, evicting the oldest past the cap. */
  private track(seat: string, turn: string): TrackedTurn {
    const existing = this.turns.get(turn);
    if (existing !== undefined) return existing;
    // Evict the oldest tracked turn rather than grow past the cap; its buffered deltas are live-only.
    if (this.turns.size >= MAX_TRACKED_TURNS) this.drop(this.turns.keys().next().value);
    const state: TrackedTurn = { seat, buffered: { text: '', thinking: '' }, left: { text: 0, thinking: 0 }, timer: null };
    this.turns.set(turn, state);
    return state;
  }

  /** One delta: the first frame of a window leaves at once; the rest waits for the window timer. */
  private buffer(turn: string, state: TrackedTurn, kind: 'text' | 'thinking', delta: string): void {
    state.buffered[kind] += delta;
    if (Date.now() - state.left[kind] >= this.windowMs) this.emitBuffered(turn, state, kind);
    else this.armWindow(turn, state);
  }

  /** Arm the single window timer for the held kind whose window ends first; each kind leaves only once its own window has passed. */
  private armWindow(turn: string, state: TrackedTurn): void {
    if (state.timer !== null) return;
    const now = Date.now();
    const waits = (['thinking', 'text'] as const)
      .filter((kind) => state.buffered[kind] !== '')
      .map((kind) => Math.max(0, state.left[kind] + this.windowMs - now));
    if (waits.length === 0) return;
    state.timer = setTimeout(() => {
      // A dropped turn (flushed, closed, evicted) has nothing left to drain.
      if (this.turns.get(turn) !== state) return;
      state.timer = null;
      for (const kind of ['thinking', 'text'] as const) {
        if (Date.now() - state.left[kind] >= this.windowMs) this.emitBuffered(turn, state, kind);
      }
      this.armWindow(turn, state);
    }, Math.min(...waits));
    state.timer.unref();
  }

  /** Tool and status frames never wait: a window's held deltas leave first, then the frame. */
  private boundary(turn: string, state: TrackedTurn, event: Exclude<TurnEvent, { kind: 'text' | 'thought' }>): void {
    this.drain(turn, state);
    if (event.kind !== 'tool') {
      this.events.emit('turn.event', { seat: state.seat, turn, kind: 'status', text: statusText(event) });
      return;
    }
    if (TOOL_START_STATUSES.has(event.status)) {
      this.events.emit('turn.event', { seat: state.seat, turn, kind: 'tool_start', tool: this.toolFrame(event, 'tool_start') });
    } else if (TOOL_END_STATUSES.has(event.status)) {
      this.events.emit('turn.event', { seat: state.seat, turn, kind: 'tool_end', tool: this.toolFrame(event, 'tool_end') });
    }
  }

  /** The tool frame for a start (`input`) or end (`durationMs`/`isError`) event. */
  private toolFrame(event: Extract<TurnEvent, { kind: 'tool' }>, kind: 'tool_start' | 'tool_end'): NonNullable<TurnEventFrame['tool']> {
    const tool: NonNullable<TurnEventFrame['tool']> = { id: event.id ?? event.name, name: event.name };
    if (kind === 'tool_start' && event.args !== undefined) tool.input = event.args;
    if (kind === 'tool_end') {
      if (event.durationMs !== undefined) tool.durationMs = event.durationMs;
      if (event.isError !== undefined) tool.isError = event.isError;
    }
    return tool;
  }

  /** Emit both kinds' held deltas (thinking before text: models think, then speak); the turn stays tracked. */
  private drain(turn: string, state: TrackedTurn): void {
    this.emitBuffered(turn, state, 'thinking');
    this.emitBuffered(turn, state, 'text');
  }

  private emitBuffered(turn: string, state: TrackedTurn, kind: 'text' | 'thinking'): void {
    if (state.buffered[kind] === '') return;
    this.events.emit('turn.event', { seat: state.seat, turn, kind, text: state.buffered[kind] });
    state.buffered[kind] = '';
    state.left[kind] = Date.now();
  }

  /** Stop tracking a turn: disarm its timer and forget its buffers without emitting. */
  private drop(turn: string | undefined): void {
    if (turn === undefined) return;
    const state = this.turns.get(turn);
    if (state === undefined) return;
    if (state.timer !== null) { clearTimeout(state.timer); state.timer = null; }
    this.turns.delete(turn);
  }
}
