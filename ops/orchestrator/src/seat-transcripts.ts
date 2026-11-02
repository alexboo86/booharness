// Disk-only seat history: persisted provider IDs survive daemon restarts. A seat on
// a host is streamed from that host over the managed transport (task 3459).
import { createReadStream } from 'node:fs';
import { opendir } from 'node:fs/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Seat } from './store.ts';
import { readHost, type RemoteHost } from './config.ts';
import { claudeTranscriptPath } from './seats-defs.ts';
import { spawnProvider } from './providers/spawn.ts';

export type SeatTranscriptEntry = {
  i: number;
  at: string | null;
  role: 'user' | 'assistant' | 'tool';
  kind: 'text' | 'tool_call' | 'tool_result' | 'thinking';
  text?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
};
export type SeatTranscriptOptions = { turn?: number; since?: number; limit: number };
export type SeatTranscript =
  | { available: false; reason: string }
  | { available: true; entries: SeatTranscriptEntry[]; skipped: number; nextSince: number; hasMore: boolean };
type Row = Record<string, unknown>;
type Item = Omit<SeatTranscriptEntry, 'i' | 'at'>;
type Format = 'pi' | 'claude' | 'codex';
const MAX_LINE = 1024 * 1024;

// Read fixed-size chunks, retaining at most one capped line. Oversize lines are
// skipped, not truncated into valid-looking data. Only complete lines are read:
// the last unterminated line may still be being appended by the provider.
async function* lines(file: string): AsyncGenerator<string | null> {
  yield* lineSource(createReadStream(file, { highWaterMark: 64 * 1024 }));
}
async function* lineSource(stream: Readable): AsyncGenerator<string | null> {
  let parts: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      let start = 0;
      for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
        const part = buffer.subarray(start, end);
        bytes += part.length;
        if (bytes <= MAX_LINE) parts.push(part);
        yield bytes > MAX_LINE ? null : Buffer.concat(parts).toString('utf8');
        parts = [];
        bytes = 0;
        start = end + 1;
      }
      bytes += buffer.length - start;
      if (bytes <= MAX_LINE) parts.push(buffer.subarray(start));
    }
  } finally { stream.destroy(); }
}

function object(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => object(part)?.type === 'text').map((part) => part.text).join('\n');
}
function block(part: Row, role: 'user' | 'assistant'): Item | null {
  switch (part.type) {
    case 'text': return typeof part.text === 'string' ? { role, kind: 'text', text: part.text } : null;
    case 'thinking': return typeof part.thinking === 'string' ? { role, kind: 'thinking', text: part.thinking } : null;
    case 'toolCall': return { role, kind: 'tool_call', tool: text(part.name), input: part.arguments };
    case 'tool_use': return { role, kind: 'tool_call', tool: text(part.name), input: part.input };
    case 'tool_result': return { role: 'tool', kind: 'tool_result', output: part.content, isError: part.is_error === true };
    default: return null;
  }
}
function messageItems(message: Row): Item[] {
  if (message.role === 'toolResult') return [{ role: 'tool', kind: 'tool_result', tool: text(message.toolName),
    output: message.content, isError: message.isError === true }];
  const role = message.role;
  if (role !== 'user' && role !== 'assistant') return [];
  if (typeof message.content === 'string') return [{ role, kind: 'text', text: message.content }];
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((part: unknown) => {
    const value = object(part);
    const item = value ? block(value, role) : null;
    return item ? [item] : [];
  });
}
function codexContent(content: unknown): Row[] {
  return Array.isArray(content) ? content.filter((part) => object(part)).map((part) => ({ ...part, type: 'text' })) : [];
}
function codexItems(row: Row): Item[] {
  if (row.type !== 'response_item') return [];
  const item = object(row.payload);
  if (!item) return [];
  switch (item.type) {
    case 'message': return messageItems({ ...item, content: codexContent(item.content) });
    case 'function_call': return [{ role: 'assistant', kind: 'tool_call', tool: text(item.name), input: item.arguments }];
    case 'custom_tool_call': return [{ role: 'assistant', kind: 'tool_call', tool: text(item.name), input: item.input }];
    case 'function_call_output':
    case 'custom_tool_call_output': return [{ role: 'tool', kind: 'tool_result', output: item.output }];
    case 'reasoning': return [{ role: 'assistant', kind: 'thinking', text: contentText(codexContent(item.summary)) }];
    default: return [];
  }
}
function normalize(row: Row, format: Format): Item[] {
  if (format === 'codex') return codexItems(row);
  if (format === 'pi' && row.type !== 'message') return [];
  if (format === 'claude' && row.isSidechain) return [];
  const message = object(row.message);
  return message ? messageItems(message) : [];
}
function timestamp(row: Row): string | null {
  if (typeof row.timestamp === 'string') return row.timestamp;
  const ms = object(row.message)?.timestamp;
  return typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}

// Codex records only the thread UUID. Walk its known YYYY/MM/DD layout lazily;
// never accept a caller-supplied path or descend into symlinks.
function codexFileName(name: string, id: string): boolean {
  return name.startsWith('rollout-') && name.endsWith(`-${id}.jsonl`);
}
async function findCodex(dir: string, id: string, depth = 3): Promise<string | null> {
  let entries;
  try { entries = await opendir(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for await (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && codexFileName(entry.name, id)) return full;
    if (entry.isDirectory() && depth > 0 && /^\d{2,4}$/.test(entry.name)) {
      const found = await findCodex(full, id, depth - 1);
      if (found) return found;
    }
  }
  return null;
}
async function nativeLocation(seat: Seat, id: string): Promise<{ file: string | null; format: Format }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return { file: null, format: 'claude' };
  if (seat.family === 'claude' || seat.family === 'glm') {
    return { file: claudeTranscriptPath(os.homedir(), seat.cwd ?? '', id), format: 'claude' };
  }
  if (seat.family === 'codex' && seat.data.harness === 'native') {
    return { file: await findCodex(path.join(os.homedir(), '.codex', 'sessions'), id), format: 'codex' };
  }
  return { file: null, format: 'pi' };
}
async function locate(seat: Seat): Promise<{ file: string | null; format: Format }> {
  const id = typeof seat.data.sessionId === 'string' ? seat.data.sessionId : '';
  // Pi persists get_state.sessionFile, not the UUID in the session header. This
  // includes stand-arm and custom session directories without guessing env paths.
  if (seat.data.harness === 'pi' || path.isAbsolute(id)) {
    return { file: path.isAbsolute(id) && id.endsWith('.jsonl') ? id : null, format: 'pi' };
  }
  return nativeLocation(seat, id);
}
function validOptions(options: SeatTranscriptOptions): boolean {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) return false;
  if (options.since !== undefined && (!Number.isSafeInteger(options.since) || options.since < -1)) return false;
  return options.turn === undefined || (Number.isSafeInteger(options.turn) && options.turn > 0);
}
function parsedLine(line: string | null, format: Format): { row: Row; items: Item[] } | null {
  try {
    const row = line === null ? null : object(JSON.parse(line));
    return row ? { row, items: normalize(row, format) } : null;
  } catch { return null; }
}
function inPage(i: number, turn: number, options: SeatTranscriptOptions): boolean {
  return i > (options.since ?? -1) && (options.turn === undefined || options.turn === turn);
}
function pageResult(entries: SeatTranscriptEntry[], skipped: number, since: number, hasMore: boolean): SeatTranscript {
  return { available: true, entries, skipped, nextSince: entries.at(-1)?.i ?? since, hasMore };
}
function pastTurn(turn: number, options: SeatTranscriptOptions): boolean {
  return options.turn !== undefined && turn > options.turn;
}
async function page(source: AsyncIterable<string | null>, format: Format, options: SeatTranscriptOptions): Promise<SeatTranscript> {
  const entries: SeatTranscriptEntry[] = [];
  let skipped = 0;
  let i = -1;
  let turn = 0;
  const since = options.since ?? -1;
  for await (const line of source) {
    const parsed = parsedLine(line, format);
    if (!parsed) { skipped++; continue; }
    const { row, items } = parsed;
    if (items.some((item) => item.role === 'user')) turn++;
    for (const item of items) {
      i++;
      if (!inPage(i, turn, options)) continue;
      if (entries.length >= Math.min(options.limit, 500)) return pageResult(entries, skipped, since, true);
      entries.push({ i, at: timestamp(row), ...item });
    }
    if (pastTurn(turn, options)) break;
  }
  return pageResult(entries, skipped, since, false);
}

/** One remote refusal, thrown inside the remote line source and mapped to its
 * reason at the read boundary. */
class RemoteRefused extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}

// Runs ON the host, so the host's own home directory and path rules resolve the
// file; the daemon only names WHAT to read, as JSON. Exit codes: 3 the file is
// absent (the local reader's missing_file), 4 it cannot be read (unreadable_file),
// 5 the candidate is not a contained regular transcript file (unsafe_path).
// The session id is untrusted, so ONE containment helper serves every kind: a
// lexical path.relative check BEFORE any fs call (a UNC name is refused without
// touching SMB), then realpath of root and file re-checked against each other,
// and only a regular file streamed, read via its realpath so no symlink in the
// path survives the check. Streaming with pipe keeps backpressure, so an
// early-stopped page never drags the whole file over the wire. The codex walk
// mirrors findCodex one branch for branch; it walks only its own root with a
// bounded id, never a daemon-named path.
const REMOTE_READER = `
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const spec = JSON.parse(process.argv[1]);
  const within = (root, target) => {
    const rel = path.relative(root, target);
    return rel.length > 0 && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };
  const contain = (root, candidate) => {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || !within(root, candidate)) process.exit(5);
    let realRoot, real;
    try { realRoot = fs.realpathSync(root); real = fs.realpathSync(candidate); }
    catch (error) { process.exit(error && error.code === 'ENOENT' ? 3 : 4); }
    if (!within(realRoot, real)) process.exit(5);
    let stat;
    try { stat = fs.statSync(real); }
    catch (error) { process.exit(error && error.code === 'ENOENT' ? 3 : 4); }
    if (!stat.isFile()) process.exit(5);
    return real;
  };
  let root = null;
  let candidate = null;
  if (spec.kind === 'file') {
    root = path.join(os.homedir(), '.pi', 'agent', 'sessions');
    candidate = spec.file;
  } else if (spec.kind === 'home') {
    root = path.join(os.homedir(), '.claude', 'projects');
    candidate = path.join(os.homedir(), ...spec.segments);
  } else if (spec.kind === 'codex') {
    root = path.join(os.homedir(), '.codex', 'sessions');
    const find = (dir, id, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return null; process.exit(4); }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('-' + id + '.jsonl')) return path.join(dir, entry.name);
        if (entry.isDirectory() && depth > 0 && /^\\d{2,4}$/.test(entry.name)) {
          const found = find(path.join(dir, entry.name), id, depth - 1);
          if (found) return found;
        }
      }
      return null;
    };
    candidate = find(root, spec.id, 3);
  }
  if (root === null || candidate === null) process.exit(3);
  const stream = fs.createReadStream(contain(root, candidate), { highWaterMark: 64 * 1024 });
  stream.on('error', (error) => { process.exit(error.code === 'ENOENT' ? 3 : 4); });
  stream.pipe(process.stdout);
`;

/** A remote read is bounded like a host checkout move: a hung ssh fails the page
 * instead of holding a daemon slot forever (task 3459). */
const REMOTE_TRANSCRIPT_TIMEOUT_MS = 120_000;

type RemoteReadSpec = { kind: 'file'; file: string } | { kind: 'home'; segments: string[] } | { kind: 'codex'; id: string };

/** Where a HOST seat's history lives, by the host's own path rules: a Pi session
 * file is host-absolute; a native Claude/GLM or Codex session sits under the host's
 * home, which only the host can resolve. Mirrors locate()'s branches one for one,
 * with the host's platform deciding what "absolute" means. */
function remoteReadSpec(seat: Seat, entry: RemoteHost): { spec: RemoteReadSpec; format: Format } | null {
  const id = seat.data.sessionId;
  if (typeof id !== 'string') return null;
  const hostPath = entry.platform === 'win32' ? path.win32 : path.posix;
  if (seat.data.harness === 'pi' || hostPath.isAbsolute(id)) {
    if (!hostPath.isAbsolute(id) || !id.endsWith('.jsonl')) return null;
    // A win32 host accepts only a drive path (piHostPaths' remoteAbsolute rule):
    // UNC and \\?\ names are refused before any child is spawned, so a crafted
    // session id cannot aim the host's reader at an SMB share.
    if (entry.platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(id)) throw new RemoteRefused('unsafe_path');
    return { spec: { kind: 'file', file: id }, format: 'pi' };
  }
  return nativeRemoteSpec(seat, id);
}

/** The native half of a host seat's location, mirroring nativeLocation: a bounded
 *  session id, then the Claude/GLM project file or the Codex rollout walk, both
 *  under the host's home. */
function nativeRemoteSpec(seat: Seat, id: string): { spec: RemoteReadSpec; format: Format } | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  if (seat.family === 'claude' || seat.family === 'glm') {
    // The project slug is derived from the seat's checkout; only this branch
    // needs a cwd. A Codex rollout is keyed by session id alone.
    if (!seat.cwd) return null;
    return { spec: { kind: 'home', segments: ['.claude', 'projects', seat.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${id}.jsonl`] }, format: 'claude' };
  }
  if (seat.family === 'codex' && seat.data.harness === 'native') return { spec: { kind: 'codex', id }, format: 'codex' };
  return null;
}

function remoteReason(code: number | null): string {
  if (code === 3) return 'missing_file';
  if (code === 4) return 'unreadable_file';
  if (code === 5) return 'unsafe_path';
  return 'host_unreachable';
}

/** Stream a host seat's lines through one managed remote child. The session path
 * never becomes shell text: it rides the remote-exec JSON header, whose command is
 * spawned without a shell on every platform. A completed page or a refusal kills
 * the child, and the host kills its reader when that session ends; daemon memory
 * holds one page plus one capped line, never the file. */
async function* remoteLines(child: ChildProcessWithoutNullStreams): AsyncGenerator<string | null> {
  const exit = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code ?? null));
  });
  child.stderr.on('data', () => {});
  child.stderr.on('error', () => {});
  child.stdout.on('error', () => {});
  try {
    yield* lineSource(child.stdout);
    const code = await exit;
    if (code !== 0) throw new RemoteRefused(remoteReason(code));
  } finally {
    child.kill('SIGKILL');
  }
}

/** Admission (task 3459): at most two remote reads in flight per seat, so a page
 * burst cannot pin extra children on one host. The count moves before any child
 * is spawned and unwinds with the read. */
const MAX_REMOTE_READS_PER_SEAT = 2;
const remoteReadsInFlight = new Map<string, number>();

async function readRemoteTranscript(seat: Seat, options: SeatTranscriptOptions): Promise<SeatTranscript> {
  const active = remoteReadsInFlight.get(seat.id) ?? 0;
  if (active >= MAX_REMOTE_READS_PER_SEAT) return { available: false, reason: 'host_busy' };
  remoteReadsInFlight.set(seat.id, active + 1);
  try {
    return await streamRemoteTranscript(seat, options);
  } finally {
    const left = (remoteReadsInFlight.get(seat.id) ?? 1) - 1;
    if (left > 0) remoteReadsInFlight.set(seat.id, left);
    else remoteReadsInFlight.delete(seat.id);
  }
}

async function streamRemoteTranscript(seat: Seat, options: SeatTranscriptOptions): Promise<SeatTranscript> {
  const hostName = typeof seat.data.host === 'string' ? seat.data.host : '';
  let child: ChildProcessWithoutNullStreams;
  let format: Format;
  try {
    const entry = readHost(hostName);
    const located = remoteReadSpec(seat, entry);
    if (!located) return { available: false, reason: 'missing_file' };
    format = located.format;
    child = spawnProvider({ host: hostName, cwd: entry.repo, command: entry.node, args: ['-e', REMOTE_READER, JSON.stringify(located.spec)] });
  } catch (error) {
    if (error instanceof RemoteRefused) return { available: false, reason: error.reason };
    // An unknown host, a refused agent link or a spawn that never started is a transport failure.
    return { available: false, reason: 'host_unreachable' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new RemoteRefused('host_unreachable'));
    }, REMOTE_TRANSCRIPT_TIMEOUT_MS);
    timer.unref();
  });
  const reading = page(remoteLines(child), format, options);
  reading.catch(() => {}); // a lost deadline race must not leave an unhandled rejection
  try {
    return await Promise.race([reading, deadline]);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
  }
}

/** Append-order raw history, not Pi's active-branch/model-context projection.
 * since is an exclusive zero-based normalized-entry index (default -1).
 * turn is a one-based provider user-message ordinal, NOT an orch Turn ID.
 * Pages cap at 500 entries; malformed/oversize lines count as skipped. Memory
 * is bounded by page size + 1 MiB line; scanning to since is linear, uncached.
 * A seat on a host streams the same pages from that host over the managed
 * transport, bounded by a deadline; an unreachable host, not silence, answers.
 */
export async function readSeatTranscript(seat: Seat, options: SeatTranscriptOptions): Promise<SeatTranscript> {
  if (!validOptions(options)) return { available: false, reason: 'invalid_options' };
  if (!seat.data.sessionId) return { available: false, reason: 'no_session' };
  try {
    if (seat.data.host) return await readRemoteTranscript(seat, options);
    const { file, format } = await locate(seat);
    if (!file) return { available: false, reason: 'missing_file' };
    return await page(lines(file), format, options);
  } catch (error) {
    if (error instanceof RemoteRefused) return { available: false, reason: error.reason };
    return { available: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing_file' : 'unreadable_file' };
  }
}
