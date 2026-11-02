// The DSH `workspaceFiles` HTTP service (task 3459 D1c): the pult web client's
// file pane and preview, served read-only from a seat's worktree. The JSON
// shapes mirror the DSH wire types at
// pult-dsh/packages/api/workspace-files/src/types.ts field for field
// (WorkspaceFileStat/Text/Bytes, WorkspaceDirectoryListing,
// WorkspaceFileWatchFrame); that file stays the source of truth, this one only
// mirrors it. Requested and resolved paths undergo worktree containment and
// case-insensitive `.git` checks, with `/` and `\` treated as separators.
// The root device is sampled once per request; targets, opened fds and intervening
// path components must stay on it. Foreign-device list entries are 'other' without size.
// Hard-linked regular files are refused (listed as 'other' without size).
// Content and stat metadata use an O_NOFOLLOW fd checked against pre-open and
// freshly re-resolved identities. Listings pin enumeration and compare entry
// identities between parent checks. These path-based checks do not close all
// same-user ABA races: see the accepted race limitations in the surface
// contract. Content is byte-capped by what was actually read.
import { watch, constants as fsConstants, type FSWatcher } from 'node:fs';
import { open as openFile, lstat, opendir, realpath, stat, type FileHandle } from 'node:fs/promises';
import type { Dir, Dirent, Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Runtime } from './http.ts';

/** The caps a client can rely on; frozen so a route cannot drift from its contract row. */
export const PULT_FILES_LIMITS = Object.freeze({
  /** A `read` refuses a whole file larger than this instead of paging it (bytes, not lines). */
  maxTextBytes: 1 << 20,
  /** Default and maximum lines on one `read` page. */
  maxTextLines: 2_000,
  /** One `bytes` window, and the whole-file cap when `length` is omitted. */
  maxBytesWindow: 1 << 20,
  /** Children one `list` returns before `truncated` turns true. */
  maxListEntries: 500,
});

/** Debounce for one watch path: coalesce the rename+change pair a write produces. */
const WATCH_DEBOUNCE_MS = 40;
/** A watch stream the client stopped reading is dropped past this, never buffered without bound. */
const WATCH_BUFFER_LIMIT = 262_144;
const ROUTES = new Set(['/api/pult/files/stat', '/api/pult/files/list', '/api/pult/files/read', '/api/pult/files/bytes', '/api/pult/files/changes']);
const OUTSIDE = 'workspace-file/outside-workspace';
const NOT_FOUND = 'workspace-file/not-found';
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The daemon pieces this service reads: the seat store for worktree roots and the logger. */
type PultFilesRuntime = Pick<Runtime, 'store' | 'log'>;

function sendJson(res: ServerResponse, status: number, body: unknown): boolean {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
  return true;
}

/** The contract's error shape: 4xx with `{"error":{"code","message"}}`. */
function sendError(res: ServerResponse, status: number, code: string, message: string): boolean {
  return sendJson(res, status, { error: { code, message } });
}

/** Opaque freshness token; clients never parse it (WorkspaceFileStat.version). */
function versionOf(node: Stats): string {
  return `${Math.round(node.mtimeMs)}:${node.size}`;
}

/**
 * Workspace-relative path segments, or null when the path can never name an entry inside the
 * worktree: absolute paths (`/` or `\\` led), `.`, `..`, NUL and any `.git` segment are refused
 * before any filesystem call. Empty segments (`a//b`, a trailing `/`) are tolerated.
 */
function workspaceSegments(raw: string): string[] | null {
  if (raw.includes('\0') || raw.startsWith('/') || raw.startsWith('\\')) return null;
  const segments = raw.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  if (namesGit(segments)) return null;
  return segments;
}

/** True when any segment is the repository metadata directory `.git`, by name and case-insensitively. */
const namesGit = (segments: string[]): boolean => segments.some((segment) => segment.toLowerCase() === '.git');

type WorkspaceRoot = { rootReal: string; rootDev: number; checkedParents: Set<string> };
type Resolved = WorkspaceRoot & { real: string; node: Stats };
type Refusal = { status: number; code: string; message: string };

const deviceRefusal = (): Refusal => ({
  status: 400, code: OUTSIDE, message: 'path crosses onto a different filesystem device',
});

/** Root-relative ancestors only: the target stat is already available and the root was sampled once. */
function parentPaths(rootReal: string, absolute: string): string[] {
  let parent = rootReal;
  return path.relative(rootReal, absolute).split(path.sep).filter(Boolean).slice(0, -1).map((segment) => {
    parent = path.join(parent, segment);
    return parent;
  });
}

/**
 * Check both the requested and canonical ancestry, so a symlink cannot hide a mount crossing
 * followed by a return to the root device. Reuse target stats and each checked ancestor within
 * this request; same-user concurrent mutations remain the accepted task 3485 residual.
 */
async function checkedDevices(root: WorkspaceRoot, absolute: string, real: string, node: Stats): Promise<Resolved | Refusal> {
  if (node.dev !== root.rootDev) return deviceRefusal();
  const parents = new Set([...parentPaths(root.rootReal, absolute), ...parentPaths(root.rootReal, real)]);
  for (const parent of parents) {
    if (root.checkedParents.has(parent)) continue;
    if ((await stat(parent)).dev !== root.rootDev) return deviceRefusal();
    root.checkedParents.add(parent);
  }
  if (node.isDirectory()) root.checkedParents.add(real);
  return { ...root, real, node };
}

/**
 * True when the resolved real path is the worktree root or lives under it, and no segment of it
 * relative to the root names `.git`: the one confinement predicate every served path and change
 * frame must pass, whatever its lexical name looked like.
 */
function insideWorkspace(rootReal: string, real: string): boolean {
  const relative = path.relative(rootReal, real);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative) && !namesGit(relative.split(/[\\/]+/)));
}

/**
 * Resolve one workspace path inside the worktree and stat it. Confinement is by realpath: the
 * resolved path must be the worktree root or live under it, so a symlink leading out is refused
 * however harmless its lexical name looks (the stat follows the same resolution a read would).
 * The resolved path relative to the root must also be `.git`-free at every segment, so an alias
 * to `.git` or a nested `.git` is refused even though it lives inside the worktree. A regular
 * file with more than one hard link is refused as well: one name's bytes must never be served
 * under another (`nlink > 1`; normal working trees never hard-link a working file).
 */
async function resolveInside(root: WorkspaceRoot, raw: string): Promise<Resolved | Refusal> {
  const { rootReal } = root;
  const segments = workspaceSegments(raw);
  if (!segments) return { status: 400, code: OUTSIDE, message: `path '${raw}' does not name a file inside the worktree` };
  const target = path.join(rootReal, ...segments);
  let real: string;
  try {
    real = await realpath(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 404, code: NOT_FOUND, message: `no entry at '${raw}'` };
    return { status: 403, code: 'workspace-file/forbidden', message: `cannot resolve '${raw}': ${code ?? 'filesystem error'}` };
  }
  if (!insideWorkspace(rootReal, real)) {
    return { status: 400, code: OUTSIDE, message: `path '${raw}' resolves outside the worktree` };
  }
  try {
    const node = await stat(real);
    if (node.isFile() && node.nlink > 1) {
      return { status: 400, code: 'workspace-file/hard-linked', message: `path '${raw}' has ${node.nlink} hard links; hard-linked regular files are not served` };
    }
    return await checkedDevices(root, target, real, node);
  } catch {
    return { status: 404, code: NOT_FOUND, message: `no entry at '${raw}'` };
  }
}

/**
 * A bounded unsigned integer query parameter: undefined when absent, null when malformed or out
 * of range, the value otherwise. `Number.isSafeInteger` keeps the arithmetic below honest.
 */
function uintParam(raw: string | null, min: number, max: number): number | null | undefined {
  if (raw === null || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

const isRefusal = <T extends object>(value: T | Refusal): value is Refusal => 'status' in value;
const served = (res: ServerResponse, resolved: Resolved | Refusal, serve: (resolved: Resolved) => Promise<boolean>): Promise<boolean> =>
  isRefusal(resolved) ? Promise.resolve(sendError(res, resolved.status, resolved.code, resolved.message)) : serve(resolved);

type OpenedFile = { handle: FileHandle; node: Stats };

const sameIdentity = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/** Freshly resolve containment, then inspect the resolved entry without following its last component. */
async function inspectInside(root: WorkspaceRoot, absolute: string): Promise<Resolved | Refusal> {
  // debt: same-user rename race; Node has no descriptor-relative open (task 3485)
  const { rootReal } = root;
  try {
    const real = await realpath(absolute);
    if (!insideWorkspace(rootReal, real)) {
      return { status: 400, code: OUTSIDE, message: 'the entry now resolves outside the worktree' };
    }
    return await checkedDevices(root, absolute, real, await lstat(real));
  } catch (error) {
    return openRefusal(error);
  }
}

/** The refusal for an open that failed on a validated path: a vanished or raced entry is 404, anything else forbidden. */
function openRefusal(error: unknown): Refusal {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    return { status: 404, code: NOT_FOUND, message: 'the entry vanished or changed while being read' };
  }
  return { status: 403, code: 'workspace-file/forbidden', message: `cannot open the validated entry: ${code ?? 'filesystem error'}` };
}

/** The opened handle once its fstat identity is confirmed against the validated stat, or the refusal. */
async function confirmedHandle(handle: FileHandle, node: Stats, validated: Stats): Promise<OpenedFile | Refusal> {
  if (!sameIdentity(node, validated)) {
    await handle.close();
    return { status: 404, code: NOT_FOUND, message: 'the entry was replaced while being read' };
  }
  if (node.isFile() && node.nlink > 1) {
    await handle.close();
    return { status: 400, code: 'workspace-file/hard-linked', message: 'the entry gained a hard link while being read' };
  }
  return { handle, node };
}

/**
 * Open the validated real path and stat through the handle, so what is read is what was
 * validated: `O_NOFOLLOW` (where the platform has it) refuses a last-second symlink swap, and
 * the dev/ino identity against the validated stat refuses a rename swap. A hard link gained
 * between validation and the open is refused by the same nlink rule. `extraFlags` widens the
 * open — a `list` adds `O_DIRECTORY`, so what is checked is a directory. The handle is the
 * caller's to close.
 */
async function openValidated(resolved: Resolved, extraFlags = 0): Promise<OpenedFile | Refusal> {
  const { real, node: validated, rootDev } = resolved;
  let handle: FileHandle;
  try {
    handle = await openFile(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | extraFlags);
  } catch (error) {
    return openRefusal(error);
  }
  let node: Stats;
  try {
    node = await handle.stat();
  } catch {
    await handle.close();
    return { status: 404, code: NOT_FOUND, message: 'the entry vanished or changed while being read' };
  }
  if (node.dev !== rootDev) {
    await handle.close();
    return deviceRefusal();
  }
  return confirmedHandle(handle, node, validated);
}

/** Bind the opened object to a fresh confined path identity, not just the pre-open path stat. */
async function openConfined(resolved: Resolved, extraFlags = 0): Promise<OpenedFile | Refusal> {
  const opened = await openValidated(resolved, extraFlags);
  if (isRefusal(opened)) return opened;
  const current = await inspectInside(resolved, resolved.real);
  if (isRefusal(current)) {
    await opened.handle.close();
    return current;
  }
  return confirmedHandle(opened.handle, opened.node, current.node);
}

/**
 * The whole file through one handle, at most cap+1 bytes: a file that grew after validation is
 * refused by the bytes actually read, never served unbounded.
 */
async function readCapped(handle: FileHandle, size: number, cap: number, raw: string): Promise<{ content: Buffer } | Refusal> {
  const want = Math.min(size, cap) + 1;
  const buffer = Buffer.alloc(want);
  const { bytesRead } = await handle.read(buffer, 0, want, 0);
  if (bytesRead > cap) {
    return { status: 400, code: 'workspace-file/too-large', message: `file '${raw}' is at least ${bytesRead} bytes; the text read limit is ${cap}` };
  }
  return { content: buffer.subarray(0, bytesRead) };
}

/** GET /api/pult/files/stat — WorkspaceFileStat. */
async function serveStat(res: ServerResponse, resolved: Resolved): Promise<boolean> {
  const opened = await openConfined(resolved, fsConstants.O_NONBLOCK ?? 0);
  if (isRefusal(opened)) return sendError(res, opened.status, opened.code, opened.message);
  try {
    return sendJson(res, 200, {
      absolutePath: resolved.real,
      version: versionOf(opened.node),
      ...(opened.node.isFile() ? { bytes: opened.node.size } : {}),
    });
  } finally {
    await opened.handle.close();
  }
}

/** GET /api/pult/files/read — one WorkspaceFileText page. */
async function serveRead(res: ServerResponse, resolved: Resolved, raw: string, offset: number, limit: number): Promise<boolean> {
  if (!resolved.node.isFile()) {
    return sendError(res, 400, 'workspace-file/not-regular-file', `path '${raw}' is a ${resolved.node.isDirectory() ? 'directory' : 'non-file entry'}, not a text file`);
  }
  const opened = await openConfined(resolved);
  if (isRefusal(opened)) return sendError(res, opened.status, opened.code, opened.message);
  const { handle, node } = opened;
  try {
    const read = await readCapped(handle, node.size, PULT_FILES_LIMITS.maxTextBytes, raw);
    if (isRefusal(read)) return sendError(res, read.status, read.code, read.message);
    const content = read.content;
    if (content.includes(0)) return sendError(res, 400, 'workspace-file/not-text', `file '${raw}' carries NUL bytes`);
    let whole: string;
    try {
      whole = UTF8.decode(content);
    } catch {
      return sendError(res, 400, 'workspace-file/not-text', `file '${raw}' is not valid UTF-8`);
    }
    // Lines are 1-based and end at \n; a final \n terminates the last line rather than starting an empty one.
    const lines = whole === '' ? [] : whole.split('\n').slice(0, whole.endsWith('\n') ? -1 : undefined);
    const page = lines.slice(offset - 1, offset - 1 + limit);
    return sendJson(res, 200, {
      absolutePath: resolved.real,
      version: versionOf(node),
      bytes: content.length,
      offset,
      text: page.join('\n'),
      lines: page.length,
      eof: offset - 1 + page.length >= lines.length,
    });
  } finally {
    await handle.close();
  }
}

/** GET /api/pult/files/bytes — one WorkspaceFileBytes window, data as base64. */
async function serveBytes(res: ServerResponse, resolved: Resolved, raw: string, offset: number, length: number | null): Promise<boolean> {
  if (!resolved.node.isFile()) {
    return sendError(res, 400, 'workspace-file/not-regular-file', `path '${raw}' is a ${resolved.node.isDirectory() ? 'directory' : 'non-file entry'}, not a file`);
  }
  const opened = await openConfined(resolved);
  if (isRefusal(opened)) return sendError(res, opened.status, opened.code, opened.message);
  const { handle, node } = opened;
  try {
    const size = node.size;
    if (length === null && size - offset > PULT_FILES_LIMITS.maxBytesWindow) {
      return sendError(res, 400, 'workspace-file/too-large', `file '${raw}' is ${size} bytes at offset ${offset}; the byte window limit is ${PULT_FILES_LIMITS.maxBytesWindow}. Pass a length`);
    }
    const window = length === null ? size - offset : Math.min(length, size - offset);
    let data = '';
    let bytesRead = 0;
    if (offset < size && window > 0) {
      const buffer = Buffer.alloc(window);
      ({ bytesRead } = await handle.read(buffer, 0, window, offset));
      data = buffer.subarray(0, bytesRead).toString('base64');
    }
    return sendJson(res, 200, {
      absolutePath: resolved.real,
      version: versionOf(node),
      bytes: size,
      offset,
      data,
      eof: offset + bytesRead >= size,
    });
  } finally {
    await handle.close();
  }
}

/** One WorkspaceDirectoryListing entry: a name, a type, and a byte size for regular files only. */
type ListedEntry = { name: string; type: 'file' | 'directory' | 'other'; size?: number };

/** Hard-linked files and unconfined or unavailable destinations have no disclosed type or size. */
function summarizeNode(name: string, node: Stats): ListedEntry {
  if (node.isFile() && node.nlink <= 1) return { name, type: 'file', size: node.size };
  if (node.isDirectory()) return { name, type: 'directory' };
  return { name, type: 'other' };
}

type ListedSnapshot = { summary: ListedEntry; target?: Resolved };

/**
 * Collect identities for every entry, including directories and symlink destinations.
 * These summaries are provisional until checkedEntries and both parent checks succeed.
 */
async function entrySummary(resolved: Resolved, entry: Dirent): Promise<ListedSnapshot> {
  const target = await inspectInside(resolved, path.join(resolved.real, entry.name));
  if (isRefusal(target)) return { summary: { name: entry.name, type: 'other' } };
  return { summary: summarizeNode(entry.name, target.node), target };
}

/** Re-read every disclosed entry's identity after the parent was revalidated. */
async function checkedEntries(resolved: Resolved, snapshots: ListedSnapshot[]): Promise<ListedEntry[] | Refusal> {
  // debt: swapping only during both entry lstats defeats matching identities while
  // every parent check sees the original directory; listing exposes metadata, not content.
  const entries: ListedEntry[] = [];
  for (const snapshot of snapshots) {
    const name = snapshot.summary.name;
    if (!snapshot.target) {
      entries.push(snapshot.summary);
      continue;
    }
    const current = await inspectInside(resolved, path.join(resolved.real, name));
    if (isRefusal(current)) return current;
    if (!sameIdentity(snapshot.target.node, current.node)) {
      return { status: 404, code: NOT_FOUND, message: 'a directory entry changed while being listed' };
    }
    entries.push(summarizeNode(name, current.node));
  }
  return entries;
}

/** Check the directory against its original identity and the freshly resolved confined path. */
async function checkDirectory(resolved: Resolved): Promise<Refusal | null> {
  const opened = await openConfined(resolved, fsConstants.O_DIRECTORY ?? 0);
  if (isRefusal(opened)) return opened;
  await opened.handle.close();
  return null;
}

/** WorkspaceDirectoryListing order: entries are reported in name order. */
const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * The .git-free dirents of one pinned enumeration fd, in name order. The worktree's `.git`
 * directories are not part of the served workspace: never listed, never counted, at any depth
 * and whatever the case of the name.
 */
async function readVisibleEntries(dir: Dir): Promise<Dirent[]> {
  const visible: Dirent[] = [];
  for (;;) {
    const entry = await dir.read();
    if (entry === null) return visible.sort(byName);
    if (entry.name.toLowerCase() !== '.git') visible.push(entry);
  }
}

type ListedDirectory = { entries: ListedEntry[]; truncated: boolean };

/**
 * One listing attempt: opendir pins enumeration, while adjacent O_NOFOLLOW dev/ino opens
 * check the parent before collection and on both sides of a fresh per-entry identity pass.
 * A failed check discards the whole attempt, not just sizes.
 */
async function listAttempt(resolved: Resolved): Promise<ListedDirectory | Refusal> {
  let dir: Dir;
  try {
    dir = await opendir(resolved.real);
  } catch (error) {
    return openRefusal(error);
  }
  try {
    const initial = await checkDirectory(resolved);
    if (initial) return initial;
    const visible = await readVisibleEntries(dir);
    const page = visible.slice(0, PULT_FILES_LIMITS.maxListEntries);
    const snapshots = await Promise.all(page.map((entry) => entrySummary(resolved, entry)));
    const before = await checkDirectory(resolved);
    if (before) return before;
    const entries = await checkedEntries(resolved, snapshots);
    if (isRefusal(entries)) return entries;
    const after = await checkDirectory(resolved);
    if (after) return after;
    return { entries, truncated: visible.length > page.length };
  } finally {
    await dir.close();
  }
}

/** GET /api/pult/files/list — WorkspaceDirectoryListing; retry one discarded attempt, then refuse. */
async function serveList(res: ServerResponse, resolved: Resolved, raw: string): Promise<boolean> {
  if (!resolved.node.isDirectory()) {
    return sendError(res, 400, 'workspace-file/not-directory', `path '${raw}' is a ${resolved.node.isFile() ? 'file' : 'non-directory entry'}, not a directory`);
  }
  let listing = await listAttempt(resolved);
  if (isRefusal(listing)) listing = await listAttempt(resolved);
  if (isRefusal(listing)) return sendError(res, listing.status, listing.code, listing.message);
  return sendJson(res, 200, { path: workspaceSegments(raw)?.join('/') ?? '', ...listing });
}

/** The change frame for one changed path, or null when the path is not part of the served workspace. */
async function changeOf(root: WorkspaceRoot, absolutePath: string): Promise<{ kind: 'change'; change: { absolutePath: string; version: string } | { absolutePath: string; absent: true } } | null> {
  const { rootReal } = root;
  try {
    const real = await realpath(absolutePath);
    // A symlink escape never frames, and neither does anything inside a .git directory however it was named.
    if (!insideWorkspace(rootReal, real)) return null;
    const node = await stat(real);
    // An event gets a fresh ancestor cache: a long-lived watch must not retain every observed path.
    const deviceChecked = await checkedDevices({ ...root, checkedParents: new Set([rootReal]) }, absolutePath, real, node);
    if (isRefusal(deviceChecked)) return null;
    return { kind: 'change', change: { absolutePath: real, version: versionOf(node) } };
  } catch {
    return { kind: 'change', change: { absolutePath, absent: true } };
  }
}

/** Queue one watcher event: lexically inside the worktree, outside every .git, one timer per path. */
function enqueueChange(root: WorkspaceRoot, pending: Map<string, ReturnType<typeof setTimeout>>, send: (frame: unknown) => void, file: string | Buffer | null, closed: () => boolean): void {
  const { rootReal } = root;
  if (closed() || typeof file !== 'string' || file === '') return;
  if (namesGit(file.split(/[\\/]+/))) return;
  const absolutePath = path.resolve(rootReal, file);
  if (absolutePath !== rootReal && !absolutePath.startsWith(rootReal + path.sep)) return;
  if (pending.has(absolutePath)) return; // one frame per path per debounce window
  pending.set(absolutePath, setTimeout(() => {
    pending.delete(absolutePath);
    changeOf(root, absolutePath).then((frame) => {
      if (frame !== null) send(frame);
    });
  }, WATCH_DEBOUNCE_MS));
}

/** GET /api/pult/files/changes — text/event-stream of WorkspaceFileWatchFrame JSON. */
function serveChanges(rt: PultFilesRuntime, res: ServerResponse, seatId: string, root: WorkspaceRoot): boolean {
  const { rootReal } = root;
  let watcher: FSWatcher;
  try {
    watcher = watch(rootReal, { recursive: true });
  } catch (error) {
    return sendError(res, 400, 'workspace-file/watch-unsupported', `cannot watch the worktree of seat '${seatId}': ${(error as Error).message}`);
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let closed = false;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const beat = setInterval(() => {
    if (!closed && res.writableLength === 0) res.write(': ping\n\n');
  }, 15_000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    watcher.close();
  };
  res.on('close', cleanup);
  const send = (frame: unknown) => {
    // A stream the client stopped reading is dropped, never buffered without bound.
    if (closed || res.destroyed || res.writableLength > WATCH_BUFFER_LIMIT) {
      cleanup();
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  };
  watcher.on('change', (_event: string, file: string | Buffer | null) => enqueueChange(root, pending, send, file, () => closed));
  watcher.on('error', (error: Error) => {
    rt.log('warn', 'pult.files.watch', { seat: seatId, error: error.message });
    cleanup();
    res.end();
  });
  send({ kind: 'ready' });
  return true;
}

/** Resolve the root and record its device once for this request, or answer the 404 refusal. */
async function seatRoot(rt: PultFilesRuntime, res: ServerResponse, url: URL): Promise<WorkspaceRoot | null> {
  const seatId = url.searchParams.get('seat') ?? '';
  if (!seatId) {
    sendError(res, 400, 'bad-request', 'seat is required');
    return null;
  }
  const seat = rt.store.getSeat(seatId);
  if (!seat) {
    sendError(res, 404, 'seat-not-found', `no seat '${seatId}'`);
    return null;
  }
  if (typeof seat.worktree !== 'string' || !seat.worktree) {
    sendError(res, 404, 'worktree-missing', `seat '${seatId}' has no worktree`);
    return null;
  }
  try {
    const rootReal = await realpath(seat.worktree);
    const rootDev = (await stat(rootReal)).dev;
    return { rootReal, rootDev, checkedParents: new Set([rootReal]) };
  } catch {
    sendError(res, 404, 'worktree-missing', `the worktree of seat '${seatId}' is not on disk`);
    return null;
  }
}

/** The read page's line window, or null once the malformed-parameter refusal is answered. */
function readParams(res: ServerResponse, url: URL): { offset: number; limit: number } | null {
  const offsetParam = uintParam(url.searchParams.get('offset'), 1, Number.MAX_SAFE_INTEGER);
  const limitParam = uintParam(url.searchParams.get('limit'), 1, PULT_FILES_LIMITS.maxTextLines);
  if (offsetParam === null || limitParam === null) {
    sendError(res, 400, 'bad-request', 'offset is a line number of at least 1 and limit 1 to ' + PULT_FILES_LIMITS.maxTextLines);
    return null;
  }
  return { offset: offsetParam ?? 1, limit: limitParam ?? PULT_FILES_LIMITS.maxTextLines };
}

/** The bytes window, or null once the malformed-parameter or over-cap refusal is answered. */
function bytesParams(res: ServerResponse, url: URL): { offset: number; length: number | null } | null {
  const offsetParam = uintParam(url.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER);
  const lengthParam = uintParam(url.searchParams.get('length'), 0, Number.MAX_SAFE_INTEGER);
  if (offsetParam === null || lengthParam === null) {
    sendError(res, 400, 'bad-request', 'offset and length are byte counts of at least 0');
    return null;
  }
  if (lengthParam !== undefined && lengthParam > PULT_FILES_LIMITS.maxBytesWindow) {
    sendError(res, 400, 'workspace-file/too-large', `length ${lengthParam} exceeds the byte window limit ${PULT_FILES_LIMITS.maxBytesWindow}`);
    return null;
  }
  return { offset: offsetParam ?? 0, length: lengthParam ?? null };
}

/** The four path-addressed routes: stat, list, read and bytes. */
async function serveFileRoute(res: ServerResponse, root: WorkspaceRoot, url: URL): Promise<boolean> {
  const raw = url.searchParams.get('path');
  if (raw === null) return sendError(res, 400, 'bad-request', 'path is required');
  if (url.pathname === '/api/pult/files/stat') return served(res, await resolveInside(root, raw), (r) => serveStat(res, r));
  if (url.pathname === '/api/pult/files/list') return served(res, await resolveInside(root, raw), (r) => serveList(res, r, raw));
  if (url.pathname === '/api/pult/files/read') {
    const params = readParams(res, url);
    if (params === null) return true;
    return served(res, await resolveInside(root, raw), (r) => serveRead(res, r, raw, params.offset, params.limit));
  }
  const params = bytesParams(res, url);
  if (params === null) return true;
  return served(res, await resolveInside(root, raw), (r) => serveBytes(res, r, raw, params.offset, params.length));
}

/**
 * The DSH workspace files service. Returns true when the request was served (any
 * `/api/pult/files/*` route, success or error); false when the path is not this service's, so
 * the caller falls through to its next route. `seat` names a seat whose worktree from the store
 * is the served root; an unknown seat and a seat without a worktree both answer 404.
 */
export async function handlePultFiles(rt: PultFilesRuntime, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!ROUTES.has(url.pathname)) return false;
  if (req.method !== 'GET') return sendError(res, 405, 'method-not-allowed', 'the workspace files service is GET only');
  const root = await seatRoot(rt, res, url);
  if (root === null) return true;
  if (url.pathname === '/api/pult/files/changes') return serveChanges(rt, res, url.searchParams.get('seat') ?? '', root);
  return serveFileRoute(res, root, url);
}
