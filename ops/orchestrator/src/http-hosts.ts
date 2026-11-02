// The daemon side of Add machine (task 3459 R10 S6a): the host-agent listener
// lifecycle and the hosts and pairing routes. The listener binds its own LAN
// port (machines.agentPort) only when a host uses the agent transport or a
// pairing window opens, closes on daemon shutdown and drain, and never binds a
// board port. Every write takes the writer guard (http-leads.ts); window
// secrets appear in the one POST /api/hosts/pair answer only — never in a GET,
// a log line or a status output.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import {
  agentCredentialStatus, agentLinkStatePath, ensureListenerTls, revokeStoredCredential, type PairingWindow,
} from './agent-pairing.ts';
import { agentExecLink, MAX_PAIRING_WINDOWS, startAgentListener, type AgentListener } from './agent-listener.ts';
import { hostTransport, HOST_NAME, readHosts, VERSION, type HostTransport, type RemoteHost } from './config.ts';
import { leadWriteAllowed, sendJson } from './http-leads.ts';
import { revokeAgentLink, setAgentLink } from './providers/spawn.ts';
import { readInstallSetting } from './settings/index.ts';

type Logger = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;

/** The listener slice of orch_status: no secret, no credential, only bound facts. */
export type AgentListenerStatus = {
  state: 'off' | 'listening';
  port?: number;
  fingerprint?: string;
  windows?: number;
  agents?: number;
};

export type HostRow = {
  name: string;
  transport: HostTransport;
  agent?: string;
  credential: 'none' | 'active' | 'revoked';
};

/** A route refusal with its HTTP status (404 unknown, 409 conflict). */
export class HostsHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type HostsServiceOptions = {
  stateDir: string;
  /** The ports the board listeners hold; the agent listener never binds one. */
  boardPorts: () => number[];
  daemonCommit: string;
  log: Logger;
  version?: string;
};

/**
 * One daemon-owned host-agent listener plus the host/credential reads the hosts
 * routes answer from. Off until `ensureStarted` (a host on the agent transport
 * at startup, or a pairing window); `stop` is the shutdown and drain seam.
 */
export class HostsService {
  private readonly stateDir: string;
  private readonly boardPorts: () => number[];
  private readonly daemonCommit: string;
  private readonly log: Logger;
  private readonly version: string;
  private listener: AgentListener | null = null;
  private starting: Promise<AgentListener> | null = null;
  private readonly closedWindows = new Map<string, 'cancelled' | 'superseded'>();

  constructor(options: HostsServiceOptions) {
    this.stateDir = options.stateDir;
    this.boardPorts = options.boardPorts;
    this.daemonCommit = options.daemonCommit;
    this.log = options.log;
    this.version = options.version ?? VERSION;
  }

  /** True when at least one host entry reaches its commands over the agent transport. */
  hasAgentTransportHosts(): boolean {
    return Object.values(readHosts(this.stateDir)).some((entry) => hostTransport(entry) === 'agent');
  }

  /** The demand start: one listener per daemon, bound at first use and idempotent. */
  ensureStarted(): Promise<AgentListener> {
    if (this.listener !== null) return Promise.resolve(this.listener);
    if (this.starting === null) {
      this.starting = this.start().finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  private async start(): Promise<AgentListener> {
    const setting = readInstallSetting(this.stateDir, 'machines.agentPort');
    const port = typeof setting === 'number' ? setting : Number.NaN;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
      throw new Error(`machines.agentPort must be a port number, got ${JSON.stringify(setting)}`);
    }
    const boards = new Set(this.boardPorts().filter((board) => board > 0));
    if (boards.has(port)) {
      throw new Error(`the host-agent listener port ${port} is a board port; set machines.agentPort to another port`);
    }
    const statePath = agentLinkStatePath(this.stateDir);
    const tls = ensureListenerTls(statePath);
    const listener = await startAgentListener({
      port, host: '0.0.0.0', statePath, orchVersion: this.version, daemonCommit: this.daemonCommit, ...tls,
      logger: {
        info: (message) => this.log('info', 'daemon.agent_listener', { message }),
        warn: (message) => this.log('warn', 'daemon.agent_listener', { message }),
        error: (message) => this.log('error', 'daemon.agent_listener', { message }),
      },
    });
    // The provider agent-link registry follows the listener's agent lifecycle (task 3459):
    // a paired or authenticated agent registers its exec link, and a disconnect removes it.
    listener.on('paired', (event: { agentId: string }) => {
      setAgentLink(event.agentId, agentExecLink(listener, event.agentId));
    });
    listener.on('authenticated', (event: { agentId: string }) => {
      setAgentLink(event.agentId, agentExecLink(listener, event.agentId));
    });
    listener.on('disconnected', (event: { agentId: string }) => {
      setAgentLink(event.agentId, null);
    });
    listener.on('window-closed', (event: { windowId: string; reason: 'cancelled' | 'superseded' }) => {
      this.closedWindows.set(event.windowId, event.reason);
      // Bounded retention, aligned with the listener's own window map (MAX_PAIRING_WINDOWS):
      // oldest closed windows are pruned first; a retained one still answers its 409.
      while (this.closedWindows.size > MAX_PAIRING_WINDOWS) {
        const oldest = this.closedWindows.keys().next().value;
        if (oldest === undefined) break;
        this.closedWindows.delete(oldest);
      }
    });
    this.listener = listener;
    this.log('info', 'daemon.agent_listener_started', { port: listener.boundPort, fingerprint: listener.fingerprint });
    return listener;
  }

  /** Shutdown and drain seam: a stop drains accepted execs before it resolves. */
  async stop(options: { deadline?: number } = {}): Promise<void> {
    let listener = this.listener;
    if (listener === null && this.starting !== null) {
      try { listener = await this.starting; } catch { return; }
    }
    this.listener = null;
    if (listener !== null) await listener.stop(options);
    if (this.listener === listener) this.listener = null;
  }

  status(): AgentListenerStatus {
    const listener = this.listener;
    if (listener === null) return { state: 'off' };
    return {
      state: 'listening',
      port: listener.boundPort,
      fingerprint: listener.fingerprint,
      windows: listener.openWindow() === null ? 0 : 1,
      agents: listener.store.agentIds().length,
    };
  }

  /** Open a fresh pairing window (the previous one closes as superseded). */
  async openPairingWindow(address?: string): Promise<PairingWindow> {
    const listener = await this.ensureStarted();
    return listener.openPairingWindow({ address: address ?? `https://${hostname()}:${listener.boundPort}` });
  }

  /** The window's state and check code; its secrets are never part of any read. */
  windowState(id: string): { id: string; state: string; checkCode?: string } | null {
    const closed = this.closedWindows.get(id);
    if (closed !== undefined) return { id, state: closed };
    const listener = this.listener;
    if (listener === null) return null;
    const window = listener.windowById(id);
    if (window === undefined) return null;
    const state = window.state(listener.now());
    return state === 'open' ? { id, state, checkCode: window.checkCode } : { id, state };
  }

  /** The local operator's confirmation issues the one credential of the window. */
  confirmPairing(id: string): { agentId: string } | null {
    return this.listener?.confirmPairing(id) ?? null;
  }

  /** Durable revocation by host name, plus the live link and the facade tombstone. */
  revokeHost(name: string): { host: string; agent: string; credential: 'revoked' | 'already absent' } {
    const hosts = readHosts(this.stateDir);
    const entry: RemoteHost | undefined = hosts[name];
    if (entry === undefined) throw new HostsHttpError(404, `unknown orch host '${name}'`);
    if (entry.agent === undefined) throw new HostsHttpError(409, `host '${name}' has no paired agent link to revoke`);
    // The durable revocation runs first and reports what it removed; the facade tombstone
    // comes last, so the disconnect the revoke triggers cannot erase it, and the first
    // revoke answers 'revoked' (the live link's own revoke is not a second removal).
    const listener = this.listener;
    const removed = listener !== null
      ? listener.revoke(entry.agent) === 'revoked'
      : revokeStoredCredential(agentLinkStatePath(this.stateDir), entry.agent);
    revokeAgentLink(entry.agent);
    return { host: name, agent: entry.agent, credential: removed ? 'revoked' : 'already absent' };
  }

  /** Every configured host with its transport and durable credential state. */
  list(): HostRow[] {
    const statePath = agentLinkStatePath(this.stateDir);
    return Object.entries(readHosts(this.stateDir)).map(([name, entry]) => ({
      name,
      transport: hostTransport(entry),
      ...(entry.agent === undefined ? {} : { agent: entry.agent }),
      credential: entry.agent === undefined ? 'none' : agentCredentialStatus(statePath, entry.agent),
    }));
  }
}

export function createHostsService(options: HostsServiceOptions): HostsService {
  return new HostsService(options);
}

type LoopbackRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

const PAIR_ID = /^\/api\/hosts\/pair\/(win-[A-Za-z0-9_-]{12})$/;
const CONFIRM_ID = /^\/api\/hosts\/pair\/(win-[A-Za-z0-9_-]{12})\/confirm$/;
// One name rule with the registry (config.ts HOST_NAME): every name checkHosts accepts must be removable by its own revoke route.
const REVOKE_NAME = new RegExp(`^/api/hosts/(${HOST_NAME})/revoke$`);

type HostsRoute =
  | { kind: 'list' } | { kind: 'pair' } | { kind: 'pairState'; id: string }
  | { kind: 'confirm'; id: string } | { kind: 'revoke'; name: string } | { kind: 'unknown' };

function hostsRouteOf(path: string): HostsRoute | null {
  if (path === '/api/hosts') return { kind: 'list' };
  if (path === '/api/hosts/pair') return { kind: 'pair' };
  const confirm = CONFIRM_ID.exec(path);
  if (confirm !== null) return { kind: 'confirm', id: confirm[1] };
  const pair = PAIR_ID.exec(path);
  if (pair !== null) return { kind: 'pairState', id: pair[1] };
  const revoke = REVOKE_NAME.exec(path);
  if (revoke !== null) return { kind: 'revoke', name: revoke[1] };
  return path.startsWith('/api/hosts/') ? { kind: 'unknown' } : null;
}

function writeAllowed(req: IncomingMessage): boolean {
  return typeof req.socket.localPort === 'number' && leadWriteAllowed(req, req.socket.localPort);
}

function expectMethod(req: IncomingMessage, method: string): void {
  if (req.method !== method) throw new HostsHttpError(405, 'method not allowed');
}

function guardWrite(req: IncomingMessage): void {
  if (!writeAllowed(req)) throw new HostsHttpError(403, 'hosts writes require the daemon origin and X-Orch-Chat: 1');
}

function bareHttps(url: URL): boolean {
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '';
}

function bareOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 300) throw new Error('address must be at most 300 characters');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('address must be a https origin'); }
  if (!bareHttps(url) || value !== url.origin) throw new Error('address must be a bare https origin (https://host[:port])');
  return url.origin;
}

/** The pair body: at most one address, a bare https origin the agent can dial. */
function pairAddress(body: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(body)) {
    if (key !== 'address') throw new Error(`hosts pair takes no '${key}'`);
  }
  return body.address === undefined ? undefined : bareOrigin(body.address);
}

async function pairBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024) throw new Error('body over 16384 bytes');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('body must be a JSON object'); }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('body must be a JSON object');
  return body as Record<string, unknown>;
}

/** One matched route; every write takes the writer guard before its body is read. */
async function runHostsRoute(route: HostsRoute, hosts: HostsService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (route.kind === 'list') {
    expectMethod(req, 'GET');
    sendJson(res, 200, { hosts: hosts.list() });
    return;
  }
  if (route.kind === 'pair') {
    expectMethod(req, 'POST');
    guardWrite(req);
    const window = await hosts.openPairingWindow(pairAddress(await pairBody(req)));
    // The only answer that carries secrets: the typed secret and the QR payload
    // (with the 128-bit QR secret) are shown once, never re-read.
    // The one secret response is never cacheable (task 3459 S6a).
    res.setHeader('cache-control', 'no-store');
    sendJson(res, 200, {
      id: window.id, address: window.address, fingerprint: window.certFingerprint,
      secret: window.typedCode(), expiresAt: window.expiresAt, qr: window.qrPayload(),
    });
    return;
  }
  if (route.kind === 'confirm') {
    expectMethod(req, 'POST');
    guardWrite(req);
    const state = hosts.windowState(route.id);
    if (state === null) throw new HostsHttpError(404, 'unknown pairing window');
    if (state.state !== 'open') throw new HostsHttpError(409, `pairing window is ${state.state}`);
    const issued = hosts.confirmPairing(route.id);
    if (issued === null) throw new HostsHttpError(409, 'no agent is waiting to pair with this window');
    sendJson(res, 200, issued);
    return;
  }
  if (route.kind === 'pairState') {
    expectMethod(req, 'GET');
    const state = hosts.windowState(route.id);
    if (state === null) throw new HostsHttpError(404, 'unknown pairing window');
    sendJson(res, 200, state);
    return;
  }
  if (route.kind === 'revoke') {
    expectMethod(req, 'POST');
    guardWrite(req);
    sendJson(res, 200, hosts.revokeHost(route.name));
    return;
  }
  throw new HostsHttpError(404, 'unknown hosts route');
}

/**
 * The hosts routes (S6a), loopback-only with the daemon route chain: pairing
 * windows, confirmation, revocation and the transport/credential read. The
 * writer guard covers every write before its body is read.
 */
export function createHostsRoutes(hosts: HostsService | undefined): LoopbackRoute {
  return async (req, res, url) => {
    const route = hostsRouteOf(url.pathname);
    if (route === null) return false;
    try {
      if (hosts === undefined) throw new HostsHttpError(503, 'the hosts service is not wired in this runtime');
      await runHostsRoute(route, hosts, req, res);
    } catch (error) {
      sendJson(res, error instanceof HostsHttpError ? error.status : 400, { error: (error as Error).message });
    }
    return true;
  };
}
