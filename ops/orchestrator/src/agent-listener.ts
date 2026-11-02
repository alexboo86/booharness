// Orch side of the host-agent link (R10 slice 2): the separate LAN TLS listener
// host agents dial. Wire behavior is owned by ops/host-agent/PROTOCOL.md v1:
// a raw-TLS JSON prelude (hello, pair/auth, switch) under quarantine limits,
// then orch becomes the HTTP/2 *client* on the accepted socket and opens
// /v1/control plus exec streams. Pairing and credential rules live in
// agent-pairing.ts. Slices 4 and 6 wire this into http.ts/config.ts.
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { connect as connectHttp2, constants as h2, type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from 'node:tls';
import { Readable, Writable } from 'node:stream';
import type { Socket } from 'node:net';
import * as hostAgentModule from '../../host-agent/index.mjs';
import { agentCredentialStatus, CredentialStore, loadListenerTls, nodeRandom, openPairingWindow, PairingWindow } from './agent-pairing.ts';
import type { AgentCredentialRecord, PairingMode, RandomBytes } from './agent-pairing.ts';
import { AgentCommandError, type AgentLink as AgentExecLink } from './providers/spawn.ts';

const hostAgent = hostAgentModule as {
  parseExecHeader: (line: string) => ExecHeader;
  openExecStream: (session: ClientHttp2Session, id: string) => ClientHttp2Stream;
  readExecOutput: (stream: ClientHttp2Stream, sinks: { stdout: Writable; stderr: Writable }) => Promise<void>;
  pipeWithBackpressure: (source: Readable, destination: Writable) => Promise<void>;
};

export const ORCH_HOST_AGENT_ALPN = 'orch-host-agent/1';
/** One JSON line excluding LF, prelude and control alike (PROTOCOL.md). */
export const MAX_LINE_BYTES = 65_536;
export const MAX_EXECS_PER_SESSION = 64;
export const MAX_CERTIFICATE_BYTES = 16 * 1024;
/** Window retention bound: the listener's window map and the hosts service's closed-window map (http-hosts.ts) both prune oldest-first to this many entries, so a retained superseded window still answers its 409. */
export const MAX_PAIRING_WINDOWS = 32;
export const DEFAULT_PRE_AUTH_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_PRE_AUTH_BYTES = 65_536;
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 4;
export const DEFAULT_CONTROL_ACK_TIMEOUT_MS = 10_000;

const OP_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const AGENT_ID = /^ag-[A-Za-z0-9_-]{1,32}$/;
const CREDENTIAL_B64URL = /^[A-Za-z0-9_-]{43}$/;
const PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const ARCHES = new Set(['x64', 'arm64']);
const ERROR_CODES = new Set(['version', 'auth', 'protocol', 'denied', 'busy', 'failed', 'no-runtime']);
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

export interface PreAuthLimits {
  /** Time from TCP accept through TLS, authentication, switch and control response. */
  handshakeTimeoutMs: number;
  /** Received application bytes allowed before authentication. */
  maxPreAuthBytes: number;
  /** Concurrent open connections per source IP. */
  maxConnectionsPerIp: number;
}

export interface AgentLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ExecHeader {
  kind: 'seat' | 'bootstrap';
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  pid: number;
}

export interface ExecIo {
  stdin?: Readable;
  stdout: Writable;
  stderr: Writable;
}

export interface RotationResult {
  fingerprint: string;
  acknowledged: string[];
  missing: string[];
  activated: boolean;
}

export interface AgentListenerOptions {
  /** LAN port of this listener; 0 binds an ephemeral port (tests). Never 7760. */
  port: number;
  host?: string;
  cert: string | Buffer;
  key: string | Buffer;
  /** Own state file under orch's state dir (agentLinkStatePath(stateDir)). */
  statePath: string;
  orchVersion: string;
  daemonCommit: string;
  /** https://host:port origin encoded into pairing QRs and typed displays. */
  advertisedAddress?: string;
  limits?: Partial<PreAuthLimits>;
  logger?: AgentLogger;
  now?: () => number;
  random?: RandomBytes;
  controlAckTimeoutMs?: number;
}

/** SHA-256 of the DER leaf certificate as 64 lowercase hex digits (the full pin). */
export function certificateFingerprint(cert: string | Buffer): string {
  return createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
}

/** Strict NDJSON line: valid fatal UTF-8, one JSON object, no duplicate keys. */
export function parseJsonLine(line: Buffer): Record<string, unknown> | null {
  let text: string;
  try {
    text = fatalUtf8.decode(line);
  } catch {
    return null;
  }
  if (text.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (hasDuplicateKeys(text)) return null;
  return value as Record<string, unknown>;
}

/** True when the just-closed string is a duplicate object key at its scope. */
function duplicateKeyAt(text: string, close: number, stringStart: number, scopes: Set<string>[]): boolean {
  let j = close + 1;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j += 1;
  if (text[j] !== ':') return false; // a string value: only keys are followed by a colon
  const key = JSON.parse(text.slice(stringStart - 1, close + 1)) as string;
  const scope = scopes[scopes.length - 1];
  if (scope === undefined) return false;
  if (scope.has(key)) return true;
  scope.add(key);
  return false;
}

/** Duplicate-key scan for already-valid JSON text (PROTOCOL.md forbids duplicates). */
export function hasDuplicateKeys(text: string): boolean {
  const scopes: Set<string>[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        if (duplicateKeyAt(text, i, stringStart, scopes)) return true;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i + 1;
    } else if (ch === '{') {
      scopes.push(new Set());
    } else if (ch === '}') {
      scopes.pop();
    }
  }
  return false;
}

class LineReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly maxLineBytes: number;

  constructor(maxLineBytes: number) {
    this.maxLineBytes = maxLineBytes;
  }

  /** Returns complete LF-terminated lines; error 'size' on an over-long line. */
  push(chunk: Buffer): { lines: Buffer[]; error?: 'size' } {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const lines: Buffer[] = [];
    for (;;) {
      const end = this.buffer.indexOf(0x0a);
      if (end === -1) break;
      const line = this.buffer.subarray(0, end);
      if (line.length > this.maxLineBytes) return { lines, error: 'size' };
      lines.push(Buffer.from(line));
      this.buffer = this.buffer.subarray(end + 1);
    }
    if (this.buffer.length > this.maxLineBytes) return { lines, error: 'size' };
    return { lines };
  }

  /** Bytes after the last consumed LF; handed back to the socket before HTTP/2. */
  remainder(): Buffer<ArrayBufferLike> {
    return this.buffer;
  }
}

type Phase = 'hello' | 'identity' | 'pending-confirm' | 'await-switch' | 'switched' | 'closed';

interface PendingOp {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TcpAdmission {
  socket: Socket;
  deadline: number;
  timer: NodeJS.Timeout;
  link?: AgentLink;
}

/** One quarantined inbound connection until it becomes an authenticated agent. */
class AgentLink {
  agentId: string | null = null;
  /** Last `update-result` reported by this agent (PROTOCOL.md), kept on the link. */
  lastUpdateResult: Record<string, unknown> | null = null;
  session: ClientHttp2Session | null = null;
  control: ClientHttp2Stream | null = null;
  execCount = 0;
  draining = false;
  private drainScheduled = false;
  pairRequestId: string | null = null;
  private phase: Phase = 'hello';
  private readonly reader = new LineReader(MAX_LINE_BYTES);
  private readonly timer: NodeJS.Timeout;
  private countBytes = true;
  private preAuthBytes = 0;
  private readonly onData = (chunk: Buffer) => this.receive(chunk);
  private readonly pendingOps = new Map<string, PendingOp>();
  private readonly usedOpIds = new Set<string>();
  readonly ready: Promise<void>;
  private markReady!: () => void;

  private readonly listener: AgentListener;
  readonly socket: TLSSocket;
  readonly ip: string;

  constructor(listener: AgentListener, socket: TLSSocket, ip: string, timeoutMs: number) {
    this.listener = listener;
    this.socket = socket;
    this.ip = ip;
    this.timer = setTimeout(() => {
      if (this.phase === 'switched') this.h2Fail('control response deadline');
      else this.fail('protocol', 'pre-auth deadline');
    }, timeoutMs);
    this.timer.unref();
    this.ready = new Promise(resolve => { this.markReady = resolve; });
    socket.setNoDelay(true);
    socket.on('data', this.onData);
    socket.once('close', () => this.release());
    socket.on('error', () => this.release());
  }

  private get open(): boolean {
    return this.phase !== 'closed' && !this.socket.destroyed;
  }

  private writeLine(value: Record<string, unknown>): void {
    if (this.open) this.socket.write(`${JSON.stringify(value)}\n`);
  }

  /** Pre-auth failures close the socket with an error code and no secret text. */
  fail(code: 'version' | 'auth' | 'protocol' | 'denied' | 'busy', reason: string): void {
    if (this.phase === 'closed') return;
    this.listener.logger.warn(`agent-link: closing ${this.ip}: ${reason}`);
    this.writeLine({ type: 'error', id: null, code });
    this.socket.end(() => this.socket.destroy());
    this.release(false);
  }

  /** Post-handoff failures: raw JSON is invalid once HTTP/2 has started. */
  private h2Fail(reason: string): void {
    this.listener.logger.warn(`agent-link: closing ${this.agentId ?? this.ip}: ${reason}`);
    this.session?.destroy();
    this.socket.destroy();
    this.release();
  }

  release(destroySocket = true): void {
    if (this.phase === 'closed') return;
    const phase = this.phase;
    this.phase = 'closed';
    this.markReady();
    const session = this.session;
    if (session !== null) {
      // Socket close may be inside Node's HTTP/2 stream teardown. Do not
      // recursively destroy that session from its own transport callback.
      setImmediate(() => { if (!session.destroyed) session.destroy(); });
    } else if (destroySocket) this.socket.destroy();
    clearTimeout(this.timer);
    this.socket.removeListener('data', this.onData);
    for (const [, op] of this.pendingOps) {
      clearTimeout(op.timer);
      op.reject(new Error('connection closed'));
    }
    this.pendingOps.clear();
    this.listener.dropLink(this, phase);
  }

  private receive(chunk: Buffer): void {
    if (this.phase === 'closed' || this.phase === 'switched') return;
    if (this.countBytes) {
      this.preAuthBytes += chunk.length;
      if (this.preAuthBytes > this.listener.limits.maxPreAuthBytes) {
        this.fail('protocol', 'pre-auth byte limit');
        return;
      }
    }
    const { lines, error } = this.reader.push(chunk);
    if (error === 'size') {
      this.fail('protocol', 'line too long');
      return;
    }
    for (const line of lines) {
      this.handleLine(line);
      const phase = this.phase as Phase;
      if (phase === 'closed' || phase === 'switched') return;
    }
  }

  private handleLine(line: Buffer): void {
    const message = parseJsonLine(line);
    if (message === null) {
      this.fail('protocol', 'invalid JSON line');
      return;
    }
    switch (this.phase) {
      case 'hello': return this.handleHello(message);
      case 'identity': return this.handleIdentity(message);
      case 'pending-confirm':
        return this.fail('protocol', 'unexpected line while pairing awaits local confirmation');
      case 'await-switch': return this.handleSwitch(message);
      default: return this.fail('protocol', 'unexpected raw line');
    }
  }

  private handleHello(message: Record<string, unknown>): void {
    if (!exactKeys(message, ['type', 'version', 'agentVersion', 'nodeVersion', 'platform', 'arch'])) {
      this.fail('protocol', 'hello fields');
      return;
    }
    if (message.version !== 1) {
      this.fail('version', 'unsupported protocol version');
      return;
    }
    const { agentVersion, nodeVersion, platform, arch } = message;
    if (typeof agentVersion !== 'string' || typeof nodeVersion !== 'string' ||
      Buffer.byteLength(agentVersion) > 64 || Buffer.byteLength(nodeVersion) > 64 ||
      !PLATFORMS.has(platform as string) || !ARCHES.has(arch as string)) {
      this.fail('protocol', 'hello values');
      return;
    }
    this.writeLine({
      type: 'hello', version: 1,
      orchVersion: this.listener.orchVersion, daemonCommit: this.listener.daemonCommit,
    });
    this.phase = 'identity';
  }

  private handleIdentity(message: Record<string, unknown>): void {
    if (message.type === 'error') return this.peerError(message);
    if (message.type === 'auth') return this.handleAuth(message);
    if (message.type === 'pair') return this.handlePair(message);
    this.fail('protocol', 'expected pair or auth');
  }

  private handleAuth(message: Record<string, unknown>): void {
    if (!exactKeys(message, ['type', 'id', 'agentId', 'credential'])) {
      this.fail('protocol', 'auth fields');
      return;
    }
    const { id, agentId, credential } = message;
    if (typeof id !== 'string' || !OP_ID.test(id) || typeof agentId !== 'string' || !AGENT_ID.test(agentId) ||
      typeof credential !== 'string' || !CREDENTIAL_B64URL.test(credential)) {
      this.fail('auth', 'auth values');
      return;
    }
    if (!this.listener.store.verify(agentId, credential)) {
      this.fail('auth', 'credential rejected');
      return;
    }
    if (!this.listener.claimIdentity(agentId, this)) {
      this.fail('busy', 'agent already has a live session');
      return;
    }
    this.agentId = agentId;
    this.countBytes = false;
    this.writeLine({ type: 'authenticated', id, agentId });
    this.phase = 'await-switch';
  }

  /** Strictly typed pair fields, or null when the line is malformed. */
  private pairFieldsOf(message: Record<string, unknown>): { id: string; mode: PairingMode; secret: string } | null {
    if (!exactKeys(message, ['type', 'id', 'mode', 'secret'])) return null;
    const { id, mode, secret } = message;
    if (typeof id !== 'string' || !OP_ID.test(id)) return null;
    if (mode !== 'qr' && mode !== 'typed') return null;
    if (typeof secret !== 'string') return null;
    return { id, mode, secret };
  }

  private handlePair(message: Record<string, unknown>): void {
    const fields = this.pairFieldsOf(message);
    const window = this.listener.openWindow();
    if (fields === null) {
      // Malformed pair attempts count toward the open window's lockout too.
      if (window !== null && window.state(this.listener.now()) === 'open') window.registerFailure();
      this.fail('protocol', 'pair fields');
      return;
    }
    if (window === null || window.state(this.listener.now()) !== 'open') {
      this.fail('auth', 'no open pairing window');
      return;
    }
    const verdict = window.verify(fields.mode, fields.secret, this.listener.now());
    if (!verdict.ok) {
      this.fail('auth', 'pairing rejected');
      return;
    }
    this.pairRequestId = fields.id;
    this.phase = 'pending-confirm';
    this.listener.addPendingPairing(window, this, fields.mode);
  }

  private handleSwitch(message: Record<string, unknown>): void {
    if (!exactKeys(message, ['type', 'version'])) {
      this.fail('protocol', 'switch fields');
      return;
    }
    if (message.version !== 1) {
      this.fail('version', 'unsupported switch version');
      return;
    }
    if (this.agentId === null) {
      this.fail('auth', 'switch before authentication');
      return;
    }
    // Leave await-switch before the first async write: the current TLS chunk
    // may contain another switch line, which must never bind a second session.
    this.phase = 'switched';
    void this.handOff({ type: 'switch-ready', version: 1 }).catch(() => this.release());
  }

  /**
   * Last raw line sent: orch becomes the HTTP/2 client on the accepted socket.
   * The raw switch-ready write must fully flush before http2.connect takes
   * over the socket's write path — a concurrent raw write corrupts the
   * session's write accounting (native assertion in node's http2).
   */
  private async handOff(switchReady: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    socket.pause();
    socket.removeListener('data', this.onData);
    await new Promise<void>(resolve => {
      const done = () => {
        socket.off('close', done);
        resolve();
      };
      socket.once('close', done);
      socket.write(`${JSON.stringify(switchReady)}\n`, done);
    });
    if (this.phase === 'closed') return;
    const extra = this.reader.remainder();
    if (extra.length > 0) socket.unshift(extra);
    this.phase = 'switched';
    const session = connectHttp2(this.listener.origin, {
      createConnection: () => socket,
      settings: { enablePush: false, maxHeaderListSize: 16384 },
    });
    this.session = session;
    session.on('error', () => this.release());
    session.once('close', () => this.release());
    void this.openControl(session);
  }

  private async openControl(session: ClientHttp2Session): Promise<void> {
    try {
      const control = session.request(
        { ':method': 'POST', ':path': '/v1/control', 'content-type': 'application/x-ndjson' },
        { endStream: false },
      );
      control.on('error', () => this.release());
      control.once('end', () => this.release());
      control.once('close', () => this.release());
      const response = await responseOrClose(control, session);
      if (!this.open) return;
      if (response[':status'] !== 200) throw new Error('control rejected');
      clearTimeout(this.timer);
      this.control = control;
      const reader = new LineReader(MAX_LINE_BYTES);
      control.on('data', (chunk: Buffer) => {
        const { lines, error } = reader.push(chunk);
        if (error === 'size') {
          this.h2Fail('control line too long');
          return;
        }
        for (const line of lines) this.handleControlLine(line);
      });
      this.markReady();
      this.listener.logger.info(`agent-link: ${this.agentId} authenticated`);
      this.listener.emit('authenticated', { agentId: this.agentId });
    } catch {
      this.release();
    }
  }

  private handleControlLine(line: Buffer): void {
    const message = parseJsonLine(line);
    if (message === null) return this.h2Fail('invalid control event');
    if (message.type === 'exec-ready' || message.type === 'cert-rotate-ready') {
      if (!exactKeys(message, ['type', 'id']) || typeof message.id !== 'string') {
        return this.h2Fail('ready fields');
      }
      const op = this.pendingOps.get(message.id);
      if (op !== undefined) {
        this.pendingOps.delete(message.id);
        clearTimeout(op.timer);
        op.resolve();
      }
      return;
    }
    if (message.type === 'update-result') return this.handleUpdateResult(message);
    if (message.type === 'error') return this.peerError(message);
    this.h2Fail('unexpected control event');
  }

  /**
   * A post-restart update outcome (PROTOCOL.md). Delivery is at most once: the
   * agent removes its result file after this send, so a loss here drops it.
   */
  private handleUpdateResult(message: Record<string, unknown>): void {
    const activated = message.status === 'activated'
      && this.updateResultOf(message, ['type', 'status', 'version', 'at'], 'version', 64);
    const rolledBack = message.status === 'rolled-back-or-failed'
      && this.updateResultOf(message, ['type', 'status', 'message', 'at'], 'message', 4096);
    if (!activated && !rolledBack) return this.h2Fail('update-result fields');
    this.lastUpdateResult = message;
    if (rolledBack) this.listener.logger.warn(`agent-link: ${this.agentId} update rolled back or failed: ${message.message}`);
    else this.listener.logger.info(`agent-link: ${this.agentId} update activated: ${message.version}`);
  }

  /** Exact keys plus one payload field and `at`, both strings within `limit` utf8 bytes. */
  private updateResultOf(message: Record<string, unknown>, keys: string[], field: string, limit: number): boolean {
    return exactKeys(message, keys) && typeof message[field] === 'string'
      && Buffer.byteLength(message[field] as string) <= limit
      && typeof message.at === 'string' && Buffer.byteLength(message.at) <= 64;
  }

  private peerError(message: Record<string, unknown>): void {
    if (!exactKeys(message, ['type', 'id', 'code']) || typeof message.code !== 'string' ||
      !ERROR_CODES.has(message.code)) {
      this.fail('protocol', 'error fields');
      return;
    }
    const { id, code } = message;
    if (id === null) {
      this.listener.logger.warn(`agent-link: peer error ${code as string}`);
      if (this.session !== null) this.h2Fail(`peer error ${code as string}`);
      else this.release();
      return;
    }
    if (typeof id === 'string') {
      const op = this.pendingOps.get(id);
      if (op !== undefined) {
        this.pendingOps.delete(id);
        clearTimeout(op.timer);
        // An agent policy refusal names itself end to end; other peer codes stay
        // generic here and are named by the provider facade (namedExecFailure).
        op.reject(code === 'denied' || code === 'no-runtime'
          ? new AgentCommandError(code, `peer error ${code as string}`)
          : new Error(`peer error ${code as string}`));
      }
    }
  }

  newOpId(): string {
    for (;;) {
      const id = this.listener.random(9).toString('base64url');
      if (!this.usedOpIds.has(id)) {
        this.usedOpIds.add(id);
        return id;
      }
    }
  }

  stop(): void {
    if (this.session === null || this.control === null) this.release();
    else this.drain();
  }

  /** GOAWAY prevents new work, but existing execs own their full drain time. */
  drain(): void {
    this.draining = true;
    this.session?.goaway(h2.NGHTTP2_NO_ERROR, 0);
    this.finishDrain();
  }

  finishDrain(): void {
    if (!this.draining || this.execCount !== 0 || this.drainScheduled) return;
    this.drainScheduled = true;
    // An exec rejection can settle inside Node's RST/stream-close callback.
    // Let that teardown finish before closing another stream on the session.
    setImmediate(() => {
      this.control?.close(h2.NGHTTP2_NO_ERROR);
      this.session?.close();
    });
  }

  sendCommand(command: Record<string, unknown>): void {
    if (!this.open || this.draining || this.control === null || this.control.destroyed) throw new Error('control stream not ready or closed');
    this.control.write(`${JSON.stringify(command)}\n`);
  }

  waitOp(id: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOps.delete(id);
        reject(new Error('operation timed out'));
      }, timeoutMs);
      timer.unref();
      this.pendingOps.set(id, { resolve, reject, timer });
    });
  }

  /** After the local operator confirms a pairing, claim the identity first, then issue and deliver the credential. */
  completePairing(window: PairingWindow): { agentId: string } | null {
    // Claim before anything is issued: a refused claim leaves no credential
    // behind (stored, sent or in memory) and does not burn the window.
    const agentId = 'ag-' + this.listener.random(9).toString('base64url');
    if (!this.listener.claimIdentity(agentId, this)) {
      this.fail('busy', 'agent already has a live session');
      return null;
    }
    this.agentId = agentId;
    const issued = window.issueCredential(agentId, this.listener.random, this.listener.now());
    if (issued === null) {
      this.fail('auth', 'no open pairing window');
      return null;
    }
    const record: AgentCredentialRecord = {
      credentialHash: issued.credentialHash,
      pairedAt: this.listener.now(),
      fingerprint: this.listener.store.fingerprint,
    };
    this.listener.store.upsertAgent(issued.agentId, record);
    this.listener.store.save();
    this.countBytes = false;
    this.writeLine({ type: 'paired', id: this.pairRequestId, agentId: issued.agentId, credential: issued.credential });
    this.phase = 'await-switch';
    this.listener.emit('paired', { agentId: issued.agentId, windowId: window.id });
    return { agentId: issued.agentId };
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function connectionKey(socket: Socket): string {
  return `${normalizeIp(socket.remoteAddress)}:${socket.remotePort}`;
}

function normalizeIp(address: string | undefined): string {
  const ip = (address ?? 'unknown').toLowerCase();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * The host-agent listener: TLS 1.3 + ALPN on its own LAN port. Quarantines
 * every connection (time, bytes, per-IP), runs the raw-TLS prelude, pairs via
 * agent-pairing.ts, then owns the HTTP/2 client sessions of authenticated
 * agents for control commands, exec offers, certificate rotation and revoke.
 */
export class AgentListener extends EventEmitter {
  readonly limits: Required<PreAuthLimits>;
  readonly statePath: string;
  readonly orchVersion: string;
  readonly daemonCommit: string;
  readonly logger: AgentLogger;
  readonly now: () => number;
  readonly random: RandomBytes;
  private readonly requestedPort: number;
  private readonly server: TlsServer;
  readonly store: CredentialStore;
  private certX509: X509Certificate;
  private key: string | Buffer;
  private readonly perIp = new Map<string, number>();
  private readonly rawSockets = new Map<string, TcpAdmission>();
  private stopPromise: Promise<void> | null = null;
  private readonly quarantined = new Set<AgentLink>();
  private readonly links = new Map<string, AgentLink>();
  private readonly windows = new Map<string, PairingWindow>();
  private readonly pendingByWindow = new Map<string, AgentLink[]>();
  private readonly controlAckTimeoutMs: number;
  private readonly host: string;
  private readonly advertisedAddress?: string;
  private port = 0;

  constructor(options: AgentListenerOptions) {
    super();
    if (options.port === 7760) throw new Error('the agent listener must not share the orch port 7760');
    this.limits = resolvePreAuthLimits(options.limits);
    this.statePath = options.statePath;
    this.orchVersion = options.orchVersion;
    this.daemonCommit = options.daemonCommit;
    this.logger = options.logger ?? { info() {}, warn() {}, error() {} };
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? nodeRandom;
    this.controlAckTimeoutMs = options.controlAckTimeoutMs ?? DEFAULT_CONTROL_ACK_TIMEOUT_MS;
    this.host = options.host ?? '0.0.0.0';
    this.advertisedAddress = options.advertisedAddress;
    this.requestedPort = options.port;
    this.certX509 = new X509Certificate(options.cert);
    this.key = options.key;
    this.store = CredentialStore.open(this.statePath, certificateFingerprint(options.cert));
    this.server = createTlsServer({
      key: this.key,
      cert: options.cert,
      minVersion: 'TLSv1.3',
      ALPNProtocols: [ORCH_HOST_AGENT_ALPN],
      handshakeTimeout: this.limits.handshakeTimeoutMs,
    });
    this.server.on('connection', socket => this.acceptTcp(socket));
    this.server.on('tlsClientError', (_error, socket) => socket.destroy());
    this.server.on('secureConnection', socket => this.accept(socket));
  }

  get origin(): string {
    return this.advertisedAddress ?? `https://127.0.0.1:${this.port}`;
  }

  /** Full SHA-256 fingerprint of the active leaf certificate. */
  get fingerprint(): string {
    return createHash('sha256').update(this.certX509.raw).digest('hex');
  }

  get boundPort(): number {
    return this.port;
  }

  async start(): Promise<{ port: number; fingerprint: string }> {
    if (this.server.listening) throw new Error('listener already started');
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.requestedPort, this.host);
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('listener has no port');
    this.port = address.port;
    return { port: this.port, fingerprint: this.fingerprint };
  }

  /** Stop admissions/offers and await accepted execs; only an explicit operator
   * deadline may interrupt them. Repeated calls share the first stop request. */
  stop(options: { deadline?: number } = {}): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    if (options.deadline !== undefined && !Number.isFinite(options.deadline)) return Promise.reject(new Error('invalid drain deadline'));
    this.stopPromise = this.closeServer(options.deadline);
    for (const link of new Set([...this.quarantined, ...this.links.values()])) link.stop();
    for (const admission of this.rawSockets.values()) {
      if (admission.link === undefined) admission.socket.destroy();
    }
    return this.stopPromise;
  }

  private closeServer(deadline: number | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = deadline === undefined ? undefined
        : setTimeout(() => this.interruptLinks(), Math.max(0, deadline - this.now()));
      timer?.unref();
      this.server.close(error => {
        clearTimeout(timer);
        if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    });
  }

  private interruptLinks(): void {
    for (const link of new Set([...this.quarantined, ...this.links.values()])) link.release();
    for (const admission of this.rawSockets.values()) admission.socket.destroy();
  }

  private acceptTcp(socket: Socket): void {
    if (this.stopPromise !== null) return void socket.destroy();
    const ip = normalizeIp(socket.remoteAddress);
    const open = (this.perIp.get(ip) ?? 0) + 1;
    if (open > this.limits.maxConnectionsPerIp) {
      this.logger.warn(`agent-link: connection limit reached for ${ip}`);
      socket.destroy();
      return;
    }
    this.perIp.set(ip, open);
    const key = connectionKey(socket);
    const timer = setTimeout(() => socket.destroy(), this.limits.handshakeTimeoutMs);
    timer.unref();
    const admission = { socket, timer, deadline: performance.now() + this.limits.handshakeTimeoutMs };
    this.rawSockets.set(key, admission);
    socket.once('close', () => {
      clearTimeout(timer);
      this.rawSockets.delete(key);
      const remaining = (this.perIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, remaining);
    });
  }

  private accept(socket: TLSSocket): void {
    if (this.stopPromise !== null || socket.alpnProtocol !== ORCH_HOST_AGENT_ALPN) {
      socket.destroy();
      return;
    }
    const admission = this.rawSockets.get(connectionKey(socket));
    if (admission === undefined) return void socket.destroy();
    const remaining = admission.deadline - performance.now();
    if (remaining <= 0) return void socket.destroy();
    clearTimeout(admission.timer);
    const ip = normalizeIp(socket.remoteAddress);
    const link = new AgentLink(this, socket, ip, remaining);
    admission.link = link;
    this.quarantined.add(link);
    socket.once('close', () => this.quarantined.delete(link));
  }

  claimIdentity(agentId: string, link: AgentLink): boolean {
    if (this.links.has(agentId)) return false;
    this.links.set(agentId, link);
    return true;
  }

  dropLink(link: AgentLink, phase: Phase): void {
    this.quarantined.delete(link);
    if (link.agentId !== null && this.links.get(link.agentId) === link) {
      this.links.delete(link.agentId);
      if (phase === 'switched' || phase === 'await-switch') {
        this.emit('disconnected', { agentId: link.agentId });
      }
    }
    for (const [windowId, pending] of this.pendingByWindow) {
      const next = pending.filter(entry => entry !== link);
      if (next.length === 0) this.pendingByWindow.delete(windowId);
      else this.pendingByWindow.set(windowId, next);
    }
  }

  /** The single open pairing window, if any (the pair line carries no window id). */
  openWindow(): PairingWindow | null {
    let open: PairingWindow | null = null;
    for (const window of this.windows.values()) {
      if (window.state(this.now()) === 'open') open = window;
    }
    return open;
  }

  /** The pairing window by id whatever its state (the hosts routes read it). */
  windowById(id: string): PairingWindow | undefined {
    return this.windows.get(id);
  }

  addPendingPairing(window: PairingWindow, link: AgentLink, mode: PairingMode): void {
    const pending = this.pendingByWindow.get(window.id) ?? [];
    pending.push(link);
    this.pendingByWindow.set(window.id, pending);
    this.emit('pairing-requested', { windowId: window.id, mode, ip: link.ip });
  }

  /** Open a fresh pairing window; an existing open window is closed first. */
  openPairingWindow(options: { address?: string; ttlMs?: number } = {}): PairingWindow {
    const previous = this.openWindow();
    if (previous !== null) this.closePairingWindow(previous.id, 'superseded');
    const address = options.address ?? this.advertisedAddress;
    if (address === undefined) throw new Error('pairing needs an advertised address');
    const window = openPairingWindow({
      address,
      certFingerprint: this.fingerprint,
      now: this.now(),
      ttlMs: options.ttlMs,
      random: this.random,
    });
    this.windows.set(window.id, window);
    // Bounded retention (task 3459): oldest windows are pruned first; the just-opened
    // window is always the newest, and a retained superseded window still answers its 409.
    while (this.windows.size > MAX_PAIRING_WINDOWS) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
    this.logger.info(`agent-link: pairing window ${window.id} opened`);
    return window;
  }

  /** Local operator confirms the displayed code; the credential then issues once. */
  confirmPairing(windowId: string): { agentId: string } | null {
    const window = this.windows.get(windowId);
    const pending = this.pendingByWindow.get(windowId);
    if (window === undefined || pending === undefined || pending.length === 0) return null;
    const link = pending[0];
    this.pendingByWindow.set(windowId, pending.slice(1));
    return link.completePairing(window);
  }

  closePairingWindow(windowId: string, reason: 'cancelled' | 'superseded'): void {
    const window = this.windows.get(windowId);
    if (window === undefined) return;
    window.erase();
    const pending = this.pendingByWindow.get(windowId) ?? [];
    this.pendingByWindow.delete(windowId);
    for (const link of pending) link.fail('denied', `pairing window ${reason}`);
    this.emit('window-closed', { windowId, reason });
  }

  /** Delete the credential and GOAWAY the identity's live session. */
  revoke(agentId: string): 'revoked' | 'unknown' {
    const link = this.links.get(agentId);
    const removed = this.store.removeAgent(agentId);
    if (removed) this.store.save();
    if (link !== undefined) {
      // Revocation is immediate, including authenticated raw-TLS links.
      // Unlike rotation, it must also cancel the agent's owned command trees.
      link.release();
    }
    this.logger.info(`agent-link: revoked ${agentId}`);
    return removed ? 'revoked' : 'unknown';
  }

  /**
   * Push a certificate rotation over every authenticated connection. The new
   * leaf must be signed by the active key ("sign the new cert with the old
   * key"); orch activates only after every connected agent acknowledged
   * (cert-rotate-ready), then GOAWAYs sessions so agents reconnect under the
   * new pin. Agents offline during rotation re-pair through a fresh window.
   */
  /** Validate a rotation candidate: signed by the active key, size-bounded, key matched. */
  private rotationCandidate(options: { cert: string | Buffer; key?: string | Buffer }): { next: X509Certificate; key: string | Buffer; fingerprint: string } {
    const next = new X509Certificate(options.cert);
    if (next.raw.length > MAX_CERTIFICATE_BYTES) throw new Error('certificate exceeds 16 KiB');
    if (!next.verify(this.certX509.publicKey)) throw new Error('certificate is not signed by the active key');
    let key = options.key;
    if (key === undefined) {
      if (!next.publicKey.equals(this.certX509.publicKey)) {
        throw new Error('rotation without a new key must reuse the active public key');
      }
      key = this.key;
    } else if (!next.checkPrivateKey(createPrivateKey(key as string | Buffer))) {
      throw new Error('certificate does not match the supplied key');
    }
    return { next, key, fingerprint: createHash('sha256').update(next.raw).digest('hex') };
  }

  /** Offer one agent the rotation; true once it acknowledged. */
  private async pushRotation(agentId: string, link: AgentLink, candidate: { next: X509Certificate; fingerprint: string }, activateAfter: number): Promise<boolean> {
    try {
      await link.ready;
      const id = link.newOpId();
      link.sendCommand({
        type: 'cert-rotate', id, fingerprint: candidate.fingerprint,
        certificate: candidate.next.raw.toString('base64url'), activateAfter,
      });
      await link.waitOp(id, this.controlAckTimeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /** Swap the secure context and persist the new pin; GOAWAY acked sessions. */
  private activateRotation(candidate: { next: X509Certificate; key: string | Buffer; fingerprint: string }, acknowledged: string[]): void {
    const cert = candidate.next.toString();
    this.store.activateCertificate({ cert, key: candidate.key.toString() }, candidate.fingerprint, acknowledged);
    this.server.setSecureContext({ key: candidate.key, cert });
    this.certX509 = candidate.next;
    this.key = candidate.key;
    for (const agentId of acknowledged) this.links.get(agentId)?.drain();
    this.logger.info('agent-link: certificate rotation activated');
  }

  async rotateCert(options: { cert: string | Buffer; key?: string | Buffer; activateAfter?: number }): Promise<RotationResult> {
    const candidate = this.rotationCandidate(options);
    const activateAfter = options.activateAfter ?? this.now();
    const acknowledged: string[] = [];
    const missing: string[] = [];
    await Promise.all([...this.links.entries()].map(async ([agentId, link]) => {
      const ok = await this.pushRotation(agentId, link, candidate, activateAfter);
      (ok ? acknowledged : missing).push(agentId);
    }));
    if (missing.length > 0) {
      this.logger.warn(`agent-link: rotation not activated; ${missing.length} acknowledgement(s) missing`);
      return { fingerprint: candidate.fingerprint, acknowledged, missing, activated: false };
    }
    this.activateRotation(candidate, acknowledged);
    return { fingerprint: candidate.fingerprint, acknowledged, missing, activated: true };
  }

  /** The durable credential re-check every command pays: a revoked credential is
   *  named, and an unreadable link state file is its own named failure, never a
   *  reset stream. */
  private assertDurable(agentId: string): void {
    let durable: 'active' | 'revoked';
    try { durable = agentCredentialStatus(this.statePath, agentId); }
    catch (error) { throw new AgentCommandError('state unreadable', (error as Error).message); }
    if (durable !== 'active') {
      throw new AgentCommandError('revoked', `agent '${agentId}' is revoked; pair again before any further command`);
    }
  }

  /**
   * Offer one execution to an authenticated agent and stream it end to end:
   * exec offer on control, exec-ready, then the /v1/exec/<id> stream with
   * slice-1 helpers (openExecStream, readExecOutput) and exit trailers.
   */
  async exec(agentId: string, header: ExecHeader, io: ExecIo, options: { signal?: AbortSignal } = {}): Promise<ExecResult> {
    const link = this.links.get(agentId);
    if (link === undefined) throw new Error('agent is not connected');
    if (options.signal?.aborted) throw new Error('exec aborted');
    await link.ready;
    if (link.session === null || link.session.destroyed || link.draining) throw new Error('agent session is not ready');
    if (link.execCount >= MAX_EXECS_PER_SESSION) throw new Error('session exec limit reached');
    // A revoke from another process (`hosts revoke`) deletes the durable
    // credential while this link stays established: re-check the link state file
    // before every command and refuse by name. A command already running ends at
    // the S6 route, not here.
    this.assertDurable(agentId);
    const validated = hostAgent.parseExecHeader(JSON.stringify(header));
    const id = link.newOpId();
    link.execCount += 1;
    try {
      link.sendCommand({
        type: 'exec', id, header: validated,
        runtimeCommit: validated.kind === 'seat' ? this.daemonCommit : null,
      });
      await link.waitOp(id, this.controlAckTimeoutMs);
      return await this.streamExec(link, id, io, options);
    } finally {
      link.execCount -= 1;
      link.finishDrain();
    }
  }

  /** One exec stream end to end; an abort destroys the stream (RST), which kills the remote tree. */
  private async streamExec(link: AgentLink, id: string, io: ExecIo, options: { signal?: AbortSignal }): Promise<ExecResult> {
    const stream = hostAgent.openExecStream(link.session, id);
    // Kill-tree: an aborted command destroys its stream (HTTP/2 RST_STREAM), and the agent kills
    // the whole command tree with it — the ssh launcher's kill semantics. stream.close(code) is
    // not enough: with the stdin pipeline attached it never reaches the wire (measured, S4).
    const cancel = () => { stream.destroy(); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try { return await execResult(stream, link.session, io); }
    finally { options.signal?.removeEventListener('abort', cancel); }
  }
}

/** The providers facade's agent link for one paired agent on this listener (providers/spawn.ts `AgentLink`). */
export function agentExecLink(listener: AgentListener, agentId: string): AgentExecLink {
  return {
    protocolVersion: 1,
    exec: (header, io, options) => listener.exec(agentId, header, io, options),
    revoke: () => listener.revoke(agentId),
  };
}

/**
 * The named listener startup (S4): `state.tls` restores a rotated pair at startup, otherwise the
 * supplied certificate starts — a mismatch with the persisted pin names its cause (loadListenerTls).
 * Shutdown is the returned listener's awaited `stop({ deadline })`.
 */
export async function startAgentListener(options: Omit<AgentListenerOptions, 'cert' | 'key'> & { cert?: string | Buffer; key?: string | Buffer }): Promise<AgentListener> {
  const tls = loadListenerTls(options.statePath,
    options.cert === undefined || options.key === undefined ? undefined : { cert: options.cert, key: options.key });
  const listener = new AgentListener({ ...options, cert: tls.cert, key: tls.key });
  await listener.start();
  return listener;
}

function resolvePreAuthLimits(limits?: Partial<PreAuthLimits>): Required<PreAuthLimits> {
  return {
    handshakeTimeoutMs: limits?.handshakeTimeoutMs ?? DEFAULT_PRE_AUTH_TIMEOUT_MS,
    maxPreAuthBytes: limits?.maxPreAuthBytes ?? DEFAULT_MAX_PRE_AUTH_BYTES,
    maxConnectionsPerIp: limits?.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP,
  };
}

/** Close/error must settle waits even when Node emits no error (e.g. CANCEL). */
function streamLifetime(stream: ClientHttp2Stream, session: ClientHttp2Session): { signal: AbortSignal; dispose: () => void } {
  const abort = new AbortController();
  const closed = () => abort.abort(new Error('agent stream or session closed'));
  stream.once('close', closed);
  session.once('close', closed);
  if (stream.destroyed || session.destroyed) closed();
  return {
    signal: abort.signal,
    dispose: () => {
      stream.off('close', closed);
      session.off('close', closed);
      abort.abort();
    },
  };
}

async function responseOrClose(stream: ClientHttp2Stream, session: ClientHttp2Session): Promise<Record<string, unknown>> {
  const lifetime = streamLifetime(stream, session);
  try {
    const [response] = await once(stream, 'response', { signal: lifetime.signal });
    return response as Record<string, unknown>;
  } finally {
    lifetime.dispose();
  }
}

async function execResult(stream: ClientHttp2Stream, session: ClientHttp2Session, io: ExecIo): Promise<ExecResult> {
  const lifetime = streamLifetime(stream, session);
  try {
    // Register both before awaiting headers: a fast peer may send trailers in
    // the same read, or reset without emitting a stream error.
    const response = once(stream, 'response', { signal: lifetime.signal });
    let receivedTrailers = false;
    const terminal = once(stream, 'trailers', { signal: lifetime.signal }).then(([exit]) => {
      receivedTrailers = true;
      if (!stream.writableEnded) stream.end();
      return exitFromTrailers(exit as Record<string, string>);
    });
    const output = hostAgent.readExecOutput(stream, { stdout: io.stdout, stderr: io.stderr }).then(() => {
      if (!receivedTrailers) throw new Error('interrupted exec: missing required exit trailers');
    });
    const stdin = io.stdin === undefined ? Promise.resolve()
      : hostAgent.pipeWithBackpressure(io.stdin, stream).catch(() => undefined);
    // Attach every rejection immediately; never strand output behind trailers.
    const [exit] = await Promise.all([terminal, output, stdin, response.then(([headers]) => {
      if (headers[':status'] !== 200) throw new Error('exec stream rejected');
    })]);
    return exit;
  } finally {
    lifetime.dispose();
    stream.destroy();
  }
}

function exitCodeOf(codeText: string | undefined): number | null {
  if (codeText === undefined || codeText === '') return null;
  const code = Number(codeText);
  if (!Number.isSafeInteger(code) || code < 0 || code > 4_294_967_295) {
    throw new Error('exit trailer code out of range');
  }
  return code;
}

function exitFromTrailers(trailers: Record<string, string>): ExecResult {
  const code = exitCodeOf(trailers['orch-exit-code']);
  const signalText = trailers['orch-exit-signal'] ?? '';
  const pid = Number(trailers['orch-remote-pid']);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('exit trailers lack a valid remote pid');
  if (code === null && signalText === '') throw new Error('exit trailers carry neither code nor signal');
  return { code, signal: signalText === '' ? null : signalText, pid };
}
