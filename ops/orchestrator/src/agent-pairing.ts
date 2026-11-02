// Orch side of the host-agent link: pairing windows, the typed check code,
// credential issuance and the hashed-credential state file. Wire behavior is
// owned by ops/host-agent/PROTOCOL.md v1 ("Pairing and credentials"); this file
// implements its orch-side rules and keeps secrets out of every string it
// produces. No sockets here: the listener (agent-listener.ts) drives this.
import { createHash, createHmac, createPrivateKey, generateKeyPairSync, randomBytes as nodeRandomBytes, sign, timingSafeEqual, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const QR_SECRET_BYTES = 16;
export const CREDENTIAL_BYTES = 32;
/** 32-symbol alphabet (40 bits over 8 characters) fixed by PROTOCOL.md. */
export const TYPED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TYPED_SECRET_LENGTH = 8;
export const MAX_WINDOW_FAILURES = 5;
/** PROTOCOL.md: a ten-minute window; every caller can inject ttlMs. */
export const DEFAULT_WINDOW_TTL_MS = 10 * 60 * 1000;

export type PairingMode = 'qr' | 'typed';
export type RandomBytes = (size: number) => Buffer;
export type PairingWindowTerminalState = 'expired' | 'used' | 'locked';
export type PairingVerifyReason = 'auth' | PairingWindowTerminalState;

const DUMMY_32 = Buffer.alloc(32, 0x5a);

/** Decode a submitted pairing secret to its fixed-length bytes; null when malformed. */
function decodePairSecret(mode: PairingMode, presented: string): Buffer | null {
  if (mode === 'qr' && /^[A-Za-z0-9_-]{22}$/.test(presented)) return Buffer.from(presented, 'base64url');
  if (mode === 'typed' && new RegExp(`^[${TYPED_ALPHABET}]{${TYPED_SECRET_LENGTH}}$`).test(presented)) {
    return Buffer.from(presented, 'ascii');
  }
  return null;
}

/** Default random source for windows and credentials; tests inject their own. */
export const nodeRandom: RandomBytes = (size: number) => nodeRandomBytes(size);

/**
 * Six-digit check code, exactly per PROTOCOL.md: HMAC-SHA256 keyed by the
 * uppercase ASCII typed secret over UTF8("orch-host-agent/check/v1\0") ||
 * SHA256(DER leaf certificate); first four digest bytes unsigned big-endian
 * modulo 1,000,000, left-padded to six digits. certDigest is the 32 DER digest
 * bytes (the fingerprint decoded from hex).
 */
export function deriveCheckCode(certDigest: Buffer, typedSecret: string): string {
  const message = Buffer.concat([Buffer.from('orch-host-agent/check/v1\0', 'utf8'), certDigest]);
  const digest = createHmac('sha256', Buffer.from(typedSecret.toUpperCase(), 'ascii')).update(message).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** Uniform 8-character secret: 256 % 32 === 0, so byte & 31 stays uniform. */
function sampleTypedSecret(random: RandomBytes): string {
  const bytes = random(TYPED_SECRET_LENGTH);
  let out = '';
  for (const byte of bytes) out += TYPED_ALPHABET[byte & 31];
  return out;
}

/**
 * One local-operator-opened pairing window. Single use, at most five failed
 * attempts across all connections and both modes (malformed included), secrets
 * erased on success, expiry, cancellation or the fifth failure.
 */
export class PairingWindow {
  readonly id: string;
  readonly address: string;
  readonly certFingerprint: string;
  readonly expiresAt: number;
  failures = 0;
  issued = false;
  private secrets: { qr: Buffer; typed: Buffer } | null = null;
  private check: string | null = null;

  constructor(options: {
    address: string; certFingerprint: string; now: number; ttlMs: number; random: RandomBytes;
  }) {
    this.id = 'win-' + options.random(9).toString('base64url');
    this.address = options.address;
    this.certFingerprint = options.certFingerprint;
    this.expiresAt = options.now + options.ttlMs;
    const qr = options.random(QR_SECRET_BYTES);
    this.secrets = { qr, typed: Buffer.from(sampleTypedSecret(options.random), 'ascii') };
    this.check = deriveCheckCode(Buffer.from(options.certFingerprint, 'hex'), this.typedSecretOf());
  }

  /** Display-only check code for the typed path; erased with the window. */
  get checkCode(): string {
    if (this.check === null) throw new Error('pairing window secrets are erased');
    return this.check;
  }

  private typedSecretOf(): string {
    if (this.secrets === null) throw new Error('pairing window secrets are erased');
    return this.secrets.typed.toString('ascii');
  }

  state(now: number): 'open' | PairingWindowTerminalState {
    if (this.issued) return 'used';
    if (this.failures >= MAX_WINDOW_FAILURES) return 'locked';
    if (now >= this.expiresAt) {
      this.erase();
      return 'expired';
    }
    return 'open';
  }

  /** The local QR payload: {version:1,address,fingerprint,secret} with the 128-bit secret base64url. */
  qrPayload(): string {
    if (this.secrets === null) throw new Error('pairing window secrets are erased');
    return JSON.stringify({
      version: 1, address: this.address, fingerprint: this.certFingerprint,
      secret: this.secrets.qr.toString('base64url'),
    });
  }

  /** The 8-character secret the local UI shows for the typed path. */
  typedCode(): string {
    return this.typedSecretOf();
  }

  /** Count one failed attempt (malformed lines included); locks at five. */
  registerFailure(): void {
    this.failures += 1;
    if (this.failures >= MAX_WINDOW_FAILURES) this.erase();
  }

  /**
   * Verify one submitted pairing secret. Timing-safe; a wrong length or
   * encoding still pays one fixed-length comparison before rejection. Every
   * failure while the window is open counts toward the five-attempt lockout.
   */
  verify(mode: PairingMode, presented: string, now: number): { ok: boolean; reason?: PairingVerifyReason } {
    const state = this.state(now);
    if (state !== 'open') return { ok: false, reason: state };
    if (this.secrets === null) return { ok: false, reason: 'locked' };
    const decoded = decodePairSecret(mode, presented);
    const expected = mode === 'qr' ? this.secrets.qr : this.secrets.typed;
    const candidate = decoded !== null && decoded.length === expected.length ? decoded : Buffer.alloc(expected.length);
    const matches = timingSafeEqual(candidate, expected);
    if (decoded === null || !matches) {
      this.registerFailure();
      return { ok: false, reason: 'auth' };
    }
    return { ok: true };
  }

  /**
   * Issue the one credential of this window for a caller-claimed agent
   * identity: a fresh opaque 32-byte value with its SHA-256 (the only thing
   * orch persists). Marks the window used and erases the pairing secrets.
   * Returns null when the window is not open; the caller claims the identity
   * first, so a refused claim leaves this window open and issues nothing.
   */
  issueCredential(agentId: string, random: RandomBytes, now: number): { agentId: string; credential: string; credentialHash: string } | null {
    if (this.state(now) !== 'open') return null;
    const credential = random(CREDENTIAL_BYTES);
    const credentialHash = createHash('sha256').update(credential).digest('hex');
    this.issued = true;
    this.erase();
    return { agentId, credential: credential.toString('base64url'), credentialHash };
  }

  /** Erase every secret of the window (success, expiry, cancellation, lockout). */
  erase(): void {
    if (this.secrets !== null) {
      this.secrets.qr.fill(0);
      this.secrets.typed.fill(0);
    }
    this.secrets = null;
    this.check = null;
  }
}

export function openPairingWindow(options: {
  address: string; certFingerprint: string; now: number; ttlMs?: number; random?: RandomBytes;
}): PairingWindow {
  return new PairingWindow({
    address: options.address,
    certFingerprint: options.certFingerprint,
    now: options.now,
    ttlMs: options.ttlMs ?? DEFAULT_WINDOW_TTL_MS,
    random: options.random ?? nodeRandom,
  });
}

export interface AgentCredentialRecord {
  /** SHA-256 hex of the 32-byte credential; the credential itself is never stored. */
  credentialHash: string;
  pairedAt: number;
  /** Certificate fingerprint the agent pinned at pairing (updated on rotation ack). */
  fingerprint: string;
}

export interface AgentLinkState {
  version: 1;
  /** Fingerprint of the currently active leaf certificate. */
  fingerprint: string;
  agents: Record<string, AgentCredentialRecord>;
  /** Active TLS material, atomically published with its pin during rotation. */
  tls?: { cert: string; key: string };
}

export function agentLinkStatePath(stateDir: string): string {
  return join(stateDir, 'agent-link.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFingerprintHex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function parseAgentRecord(agentId: string, record: unknown): AgentCredentialRecord | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId) || !isRecord(record)) return null;
  const { credentialHash, pairedAt, fingerprint } = record;
  if (!isFingerprintHex(credentialHash)) return null;
  if (typeof pairedAt !== 'number' || !Number.isSafeInteger(pairedAt) || pairedAt < 0) return null;
  if (!isFingerprintHex(fingerprint)) return null;
  return { credentialHash, pairedAt, fingerprint };
}

function parseAgents(value: unknown): Record<string, AgentCredentialRecord> {
  if (!isRecord(value)) throw new Error('invalid agents');
  const agents: Record<string, AgentCredentialRecord> = {};
  for (const [agentId, record] of Object.entries(value)) {
    const parsed = parseAgentRecord(agentId, record);
    if (parsed === null) throw new Error('invalid agent record');
    agents[agentId] = parsed;
  }
  return agents;
}

function parseTls(value: unknown, fingerprint: string): AgentLinkState['tls'] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.cert !== 'string' || typeof value.key !== 'string') {
    throw new Error('invalid TLS material');
  }
  const cert = new X509Certificate(value.cert);
  if (createHash('sha256').update(cert.raw).digest('hex') !== fingerprint ||
      !cert.checkPrivateKey(createPrivateKey(value.key))) throw new Error('TLS material does not match fingerprint/key');
  return { cert: value.cert, key: value.key };
}

function parseAgentLinkState(text: string): AgentLinkState {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 1) throw new Error('unsupported state version');
  if (!isFingerprintHex(value.fingerprint)) throw new Error('invalid fingerprint');
  return { version: 1, fingerprint: value.fingerprint, agents: parseAgents(value.agents),
    tls: parseTls(value.tls, value.fingerprint) };
}

/**
 * The agent-link state file (its own file under orch's state dir). Loads
 * fail-closed: an unreadable or corrupt file throws instead of resetting
 * credentials. Saves are atomic (temp + rename, owner-only mode).
 */
export class CredentialStore {
  private state: AgentLinkState;
  private readonly path: string;

  private constructor(path: string, state: AgentLinkState) {
    this.path = path;
    this.state = state;
  }

  static open(path: string, activeFingerprint: string): CredentialStore {
    let text: string | null = null;
    if (existsSync(path)) text = readFileSync(path, 'utf8');
    if (text === null) return new CredentialStore(path, { version: 1, fingerprint: activeFingerprint, agents: {} });
    try {
      const state = parseAgentLinkState(text);
      if (state.fingerprint !== activeFingerprint) throw new Error('supplied certificate fingerprint does not match persisted state');
      return new CredentialStore(path, state);
    } catch (error) {
      throw new Error(`agent link state file is unreadable (${path}): ${(error as Error).message}`);
    }
  }

  get fingerprint(): string {
    return this.state.fingerprint;
  }

  setFingerprint(fingerprint: string): void {
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('invalid fingerprint');
    this.state.fingerprint = fingerprint;
  }

  agentIds(): string[] {
    return Object.keys(this.state.agents);
  }

  record(agentId: string): AgentCredentialRecord | undefined {
    return this.state.agents[agentId];
  }

  /** Timing-safe credential check; malformed input pays a dummy comparison. */
  verify(agentId: string, presented: string): boolean {
    const record = this.state.agents[agentId];
    const stored = record ? Buffer.from(record.credentialHash, 'hex') : DUMMY_32;
    let presentedHash = DUMMY_32;
    if (/^[A-Za-z0-9_-]{43}$/.test(presented)) {
      const decoded = Buffer.from(presented, 'base64url');
      if (decoded.length === CREDENTIAL_BYTES) {
        presentedHash = createHash('sha256').update(decoded).digest();
      }
    }
    const matches = timingSafeEqual(presentedHash, stored);
    return record !== undefined && matches;
  }

  upsertAgent(agentId: string, record: AgentCredentialRecord): void {
    this.state.agents[agentId] = record;
  }

  removeAgent(agentId: string): boolean {
    if (!(agentId in this.state.agents)) return false;
    delete this.state.agents[agentId];
    return true;
  }

  /** Publish the TLS pair and pin together, before the listener activates it. */
  activateCertificate(tls: { cert: string; key: string }, fingerprint: string, acknowledged: string[]): void {
    const agents = { ...this.state.agents };
    for (const id of acknowledged) {
      if (agents[id] !== undefined) agents[id] = { ...agents[id], fingerprint };
    }
    const next = { ...this.state, fingerprint, tls: parseTls(tls, fingerprint), agents };
    this.saveState(next);
    this.state = next;
  }

  /** Atomic owner-only write; the directory is created on demand. */
  save(): void {
    this.saveState(this.state);
  }

  private saveState(state: AgentLinkState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${nodeRandomBytes(9).toString('hex')}.tmp`;
    // Exclusive creation prevents a stale file/symlink from weakening the
    // owner-only permissions now that this state also holds a TLS private key.
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    try {
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

function fingerprintOf(cert: string | Buffer): string {
  return createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
}

/**
 * The TLS pair a listener starts with (S4 listener startup). A rotated pair persisted in the
 * state (`state.tls`) restores at startup and wins over whatever else is supplied; without one,
 * the supplied pair must match the pinned fingerprint, and a mismatch names its cause instead of
 * silently replacing the pin.
 */
export function loadListenerTls(statePath: string, supplied?: { cert: string | Buffer; key: string | Buffer }): { cert: string | Buffer; key: string | Buffer } {
  if (!existsSync(statePath)) {
    if (supplied === undefined) throw new Error(`agent link startup: no ${statePath} and no certificate supplied`);
    return supplied;
  }
  let state: AgentLinkState;
  try { state = parseAgentLinkState(readFileSync(statePath, 'utf8')); }
  catch (error) { throw new Error(`agent link state file is unreadable (${statePath}): ${(error as Error).message}`); }
  // A rotation published its pair with the pin: restore it, never start the stale pre-rotation cert.
  if (state.tls !== undefined) return { cert: state.tls.cert, key: state.tls.key };
  if (supplied === undefined) throw new Error(`agent link startup: ${statePath} pins certificate ${state.fingerprint} but no certificate was supplied`);
  const seen = fingerprintOf(supplied.cert);
  if (seen !== state.fingerprint) {
    throw new Error(`agent link startup certificate mismatch: ${statePath} pins ${state.fingerprint} but the startup certificate is ${seen}; the certificate changed outside orch — restore the paired certificate (or clear the link state to pair again)`);
  }
  return supplied;
}


// ---- first-run TLS pair: one self-signed P-256 leaf, DER written by hand ----

function der(tag: number, body: Buffer): Buffer {
  const length = body.length;
  const head = length < 0x80 ? Buffer.from([length])
    : length <= 0xff ? Buffer.from([0x81, length])
    : Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), head, body]);
}

const derSeq = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts));

function derInt(bytes: Buffer): Buffer {
  return der(0x02, (bytes[0] & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

/** A base-128 object identifier, every arc after the first two byte-packed. */
function derOid(arcs: number[]): Buffer {
  const body: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunks = [arc & 0x7f];
    for (let n = arc >> 7; n > 0; n >>= 7) chunks.unshift((n & 0x7f) | 0x80);
    body.push(...chunks);
  }
  return der(0x06, Buffer.from(body));
}

function derTime(date: Date): Buffer {
  const iso = date.toISOString();
  return der(0x17, Buffer.from(`${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`, 'ascii'));
}

function pem(label: string, body: Buffer | string): string {
  const b64 = (typeof body === 'string' ? Buffer.from(body, 'utf8') : body).toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** ecdsa-with-SHA256 (1.2.840.10045.4.3.2); RFC 5758 keeps the parameters absent. */
const ECDSA_SHA256 = derSeq(derOid([1, 2, 840, 10045, 4, 3, 2]));
/** commonName (2.5.4.3) with the fixed subject CN=orch-host-agent. */
const SUBJECT = derSeq(der(0x31, derSeq(derOid([2, 5, 4, 3]), der(0x0c, Buffer.from('orch-host-agent', 'utf8')))));

/**
 * One self-signed P-256 leaf for a fresh install (S6 daemon startup). Agents pin
 * the SHA-256 of this DER leaf (PROTOCOL.md), so no PKI and no external tool is
 * involved and the key never leaves the owner-only link state file.
 */
export function issueSelfSignedPair(random: RandomBytes = nodeRandom): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = random(16);
  serial[0] &= 0x7f;
  const notBefore = Date.now() - 24 * 3600_000;
  const validity = derSeq(derTime(new Date(notBefore)), derTime(new Date(notBefore + 10 * 365 * 24 * 3600_000)));
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const tbs = derSeq(derInt(serial), ECDSA_SHA256, SUBJECT, validity, SUBJECT, spki);
  const signature = der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)]));
  return { cert: pem('CERTIFICATE', derSeq(tbs, ECDSA_SHA256, signature)), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

/**
 * The TLS pair a daemon listener starts from (S6): a first run issues one
 * self-signed pair and persists it with its pin in the link state file; later
 * runs restore it or refuse by name (loadListenerTls).
 */
export function ensureListenerTls(statePath: string): { cert: string | Buffer; key: string | Buffer } {
  if (existsSync(statePath)) return loadListenerTls(statePath);
  const pair = issueSelfSignedPair();
  const store = CredentialStore.open(statePath, fingerprintOf(pair.cert));
  store.activateCertificate(pair, store.fingerprint, []);
  return pair;
}
/** Durable revocation: the paired credential is deleted from the link state. True when one was there. */
export function revokeStoredCredential(statePath: string, agentId: string): boolean {
  if (!existsSync(statePath)) return false;
  let state: AgentLinkState;
  try { state = parseAgentLinkState(readFileSync(statePath, 'utf8')); }
  catch (error) { throw new Error(`agent link state file is unreadable (${statePath}): ${(error as Error).message}`); }
  const store = CredentialStore.open(statePath, state.fingerprint);
  const removed = store.removeAgent(agentId);
  if (removed) store.save();
  return removed;
}

/** The durable side of the named refusals: a credential left the link state when it was revoked. */
export function agentCredentialStatus(statePath: string, agentId: string): 'active' | 'revoked' {
  if (!existsSync(statePath)) return 'revoked';
  let state: AgentLinkState;
  try { state = parseAgentLinkState(readFileSync(statePath, 'utf8')); }
  catch (error) { throw new Error(`agent link state file is unreadable (${statePath}): ${(error as Error).message}`); }
  return Object.hasOwn(state.agents, agentId) ? 'active' : 'revoked';
}
