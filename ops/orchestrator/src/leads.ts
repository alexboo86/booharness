// Phase 5: a lead's context, read from its own session log (decision #10478).
// A lead in the Claude Code or Codex GUI has no successor from outside: Paseo's
// lead-successor works only under Paseo. So orch reads what the runtime already
// writes — the claude transcript (`~/.claude/projects/<project>/<session>.jsonl`)
// and the codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) — and
// the dashboard shows it; the PostToolUse hook (ops/bootstrap/lead-context-hook.mjs)
// reminds the lead to hand over. No model call, no provider API.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';
import { countTool, toolKinds, rtkVerdict } from './toolkinds.ts';
type SeatSessionReader = {
  listSeats(query: { notStatus: string } | { status: string; updatedSince: string }): readonly { data: Record<string, unknown> }[];
};

/**
 * The reminder fires at min(LEAD_CAP, LEAD_WINDOW_SHARE of the window): the operator set the cap at
 * 300k on 2026-10-13 (#17064, over 400k in #11903, 500k in #10521 and 350k in #10520; the Paseo successor uses 250k); the window share is lesson #10446 — codex
 * (window 258,400) compacts itself at 218-234k, so a flat cap above that point never fires.
 */
export const LEAD_CAP = 300_000;
export const LEAD_WINDOW_SHARE = 0.7;
/** After the first reminder, the next comes each further tenth of the limit. */
export const LEAD_BAND_SHARE = 0.1;

export type LeadFamily = 'claude' | 'codex';
export type LeadContext = {
  family: LeadFamily;
  session: string;
  cwd: string | null;
  model: string | null;
  /** Tokens the last model call carried in: what the next call starts from. */
  tokens: number;
  /** The model's context window when the log states it (codex); claude's transcript does not. */
  window: number | null;
  at: string | null;
  /** Who started the session: claude's `entrypoint`, codex's `originator`. */
  origin: string | null;
  /** A session a person drives (the Claude or Codex app, a terminal), not a seat, a one-shot or a subagent. */
  interactive: boolean;
  /** Claude completed /next's successor step since the last human message. */
  handedOver: boolean;
};

export function leadLimit(window: number | null): number {
  return typeof window === 'number' && window > 0 ? Math.min(LEAD_CAP, Math.floor(window * LEAD_WINDOW_SHARE)) : LEAD_CAP;
}

/** 0 at the limit, 1 a tenth of the limit above it, …; null below the limit. */
export function leadBand(tokens: number, limit: number): number | null {
  return tokens < limit ? null : Math.floor((tokens - limit) / (limit * LEAD_BAND_SHARE));
}

/** The last `bytes` of a file as whole lines (the first, cut line dropped). */
function tail(file: string, bytes: number): string[] {
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

function parse(line: string): any {
  if (!line.trim()) return null;
  try { return JSON.parse(line); } catch { return null; }
}

/** The first line of a file: a codex rollout opens with its session_meta. */
function head(file: string): any {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return parse(buffer.subarray(0, read).toString('utf8').split('\n')[0]);
  } finally {
    closeSync(fd);
  }
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

/** A claude transcript entry's context: everything the call read, cached or not. Subagents and synthetic entries are not the lead's. */
function claudeEntry(entry: any): { tokens: number; model: string | null } | null {
  if (entry?.type !== 'assistant' || entry.isSidechain || !entry.message?.usage) return null;
  const model = typeof entry.message.model === 'string' ? entry.message.model : null;
  if (model === '<synthetic>') return null;
  const usage = entry.message.usage;
  const tokens = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
  return tokens > 0 ? { tokens, model } : null;
}

/** Only the already-read tail: injected user messages do not resume a handed-over lead. */
function claudeHandedOver(lines: readonly string[]): boolean {
  let next = false;
  let handedOver = false;
  for (const line of lines) {
    const entry = parse(line);
    if (!entry || entry.isSidechain || entry.isMeta) continue;
    const content = entry.message?.content;
    if (entry.type === 'user') {
      // Desktop human input also has promptSource "sdk"; sender metadata takes precedence.
      const origin = entry.origin?.kind ?? entry.turnOrigin;
      if (origin ? origin !== 'human' : entry.promptSource === 'system') continue;
      if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) continue;
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : null;
      if (text === null) continue;
      handedOver = false;
      next = /^\/next(?:\s|$)/.test(text.trim()) || text.includes('<command-name>/next</command-name>');
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use') continue;
        if (block.name === 'Skill' && block.input?.skill === 'next') next = true;
        else if (next && (block.name === 'mcp__ccd_session__spawn_task' || block.name === 'mcp__scheduled-tasks__run_scheduled_task')) handedOver = true;
        // The handover mod with clear starts the successor in a new transcript; without clear this log goes on.
        else if (next && block.name === 'mcp__handover__run' && block.input?.clear === true) handedOver = true;
      }
    }
  }
  return handedOver;
}

/**
 * Measured 2026-09-22 over the recent logs: claude-desktop and cli are people; sdk-cli (130 of 150
 * transcripts) is `claude -p` — Jev, scouts, seats. Codex Desktop and codex_cli_rs are people;
 * orch's own codex seats (originator `orch`), `codex exec` and subagent threads write to the same
 * ~/.codex/sessions and are not.
 */
function claudeInteractive(entrypoint: unknown): boolean {
  return typeof entrypoint === 'string' && !entrypoint.startsWith('sdk');
}
function codexInteractive(payload: any): boolean {
  const source = payload?.source;
  if (['orch', 'codex_exec'].includes(payload?.originator)) return false;
  return source !== 'exec' && !(source && typeof source === 'object' && 'subagent' in source);
}

/** A codex token_count event: the last call's tokens and the window the model reports. */
function codexEntry(entry: any): { tokens: number; window: number | null } | null {
  const info = entry?.type === 'event_msg' && entry.payload?.type === 'token_count' ? entry.payload.info : null;
  const last = info?.last_token_usage;
  if (!last) return null;
  const window = count(info.model_context_window) || null;
  return { tokens: count(last.total_tokens), window };
}

/**
 * The context of the session whose log is `file`, or null when the log has no model call yet.
 * The tail is read first; a long tool result can push the last usage further back, so a miss
 * reads a larger tail once.
 */
export function readLeadContext(file: string): LeadContext | null {
  if (!existsSync(file)) return null;
  const meta = head(file);
  const codex = meta?.type === 'session_meta';
  let context: LeadContext | null = null;
  let at: string | null = null;
  for (const bytes of [512 * 1024, 8 * 1024 * 1024]) {
    const lines = tail(file, bytes);
    const handedOver = !codex && claudeHandedOver(lines);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const entry = parse(lines[i]);
      if (!entry) continue;
      if (at === null && typeof entry.timestamp === 'string') at = entry.timestamp;
      if (context) {
        if (at !== null) return { ...context, at, handedOver };
        continue;
      }
      if (codex) {
        const found = codexEntry(entry);
        if (found) {
          // The model and the current directory of the turn that made this call.
          let turn: any = null;
          for (let j = i - 1; j >= 0 && !turn; j -= 1) {
            const earlier = parse(lines[j]);
            if (earlier?.type === 'turn_context') turn = earlier.payload;
          }
          context = {
            family: 'codex', session: String(meta.payload?.id ?? path.basename(file, '.jsonl')), cwd: turn?.cwd ?? meta.payload?.cwd ?? null,
            model: typeof turn?.model === 'string' ? turn.model : null, tokens: found.tokens, window: found.window, at,
            origin: meta.payload?.originator ?? null, interactive: codexInteractive(meta.payload), handedOver: false,
          };
          if (at !== null) return context;
        }
      } else {
        const found = claudeEntry(entry);
        if (found) {
          context = {
            family: 'claude', session: String(entry.sessionId ?? path.basename(file, '.jsonl')), cwd: entry.cwd ?? null,
            model: found.model, tokens: found.tokens, window: null, at,
            origin: entry.entrypoint ?? null, interactive: claudeInteractive(entry.entrypoint), handedOver,
          };
          if (at !== null) return context;
        }
      }
    }
    if (statSync(file).size <= bytes) break;
  }
  return context;
}

/** A seat's orch checkout: an interactive session there is still a seat's. */
export function inSeatCheckout(cwd: string | null, home = os.homedir()): boolean {
  if (!cwd) return false;
  const inside = (root: string) => {
    const relative = path.relative(root, cwd);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  return inside(path.join(home, '.local', 'state', 'orch', 'worktrees'));
}

/**
 * The provider session ids orch's seats have recorded (`seat.data.sessionId`). A native claude seat
 * writes its transcript under ~/.claude/projects like a lead and can carry an interactive-looking
 * `entrypoint` (decision #11849), so its id, not its label, says it is a seat's.
 */
export function seatSessions(seats: readonly { data: Record<string, unknown> }[]): Set<string> {
  const ids = new Set<string>();
  for (const seat of seats) if (typeof seat.data.sessionId === 'string' && seat.data.sessionId) ids.add(seat.data.sessionId);
  return ids;
}

/**
 * The seat sessions that can shadow a lead inside the window: every open seat, plus seats closed
 * inside the window (their transcript can still carry entries from just before the close). A seat
 * closed earlier cannot have a transcript entry inside the window, so the closed history stays out
 * of this read (defect 2026-10-16: the unbounded form parsed 42 MB of closed seats per poll).
 */
export function windowSeatSessions(store: SeatSessionReader, now: number, minutes: number): Set<string> {
  const since = new Date(now - minutes * 60_000).toISOString();
  return seatSessions([...store.listSeats({ notStatus: 'closed' }), ...store.listSeats({ status: 'closed', updatedSince: since })]);
}

/** A lead: a session a person drives, outside a seat's checkout, and no seat's session. */
export function isLead(context: LeadContext, home = os.homedir(), seats: ReadonlySet<string> = new Set()): boolean {
  return context.interactive && !seats.has(context.session) && !inSeatCheckout(context.cwd, home);
}

/** One macrotask. A walk of microtasks only fuses into one event-loop stretch (lesson 18266). */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/**
 * Stay under the 50 ms event-loop limit at the live shape (about 1800 project dirs and 2500
 * transcripts). The overshoot after this check is one readdir or one stat: about 17 ms on the Mac
 * (budget 20 measured 47-49 ms, budget 8 measured 25 ms, 2026-10-18).
 * Appending to a .jsonl does not change its directory mtime, so a directory is never skipped.
 */
const LOOP_BUDGET_MS = 8;

type ScanClock = { stretch: number };

async function breathe(clock: ScanClock): Promise<void> {
  if (performance.now() - clock.stretch < LOOP_BUDGET_MS) return;
  await yieldToLoop();
  clock.stretch = performance.now();
}

async function recent(dir: string, since: number, depth: number, clock: ScanClock): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  let entries: import('node:fs').Dirent<string>[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; /* removed after existsSync */ }
  for (const entry of entries) {
    await breathe(clock);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) found.push(...await recent(full, since, depth - 1, clock));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try { if (statSync(full).mtimeMs >= since) found.push(full); } catch { /* removed after readdir */ }
    }
  }
  return found;
}

/**
 * The tool calls of a lead's own session by kind (toolkinds.ts), the same badges a seat gets
 * (operator, 2026-09-23). Read the tail first, then the older prefix and new appends in bounded
 * chunks across scans; each complete line is parsed only once.
 */
const TOOL_SCAN_BYTES = 256 * 1024;
/** Shell calls whose rtk verdict has not come back yet: pending, neither a miss nor a zero. */
const RTK_PENDING = 'rtk-pending';
type LineStream = { decoder: StringDecoder; rest: string };
type ToolScan = {
  file: string; dev: number; ino: number; signature: Buffer; codex: boolean | null; kinds: Record<string, number>;
  prefixOffset: number; prefixEnd: number; prefix: LineStream;
  tailOffset: number; tail: LineStream; parked: Buffer | null; first: LineStream; pending: string[];
  /** Pending calls rtk gave no verdict for (killed, timed out): asked again on the next scan. */
  reask: Array<() => Promise<boolean | null>>;
};
const toolCache = new Map<string, ToolScan>();
const lineStream = (): LineStream => ({ decoder: new StringDecoder('utf8'), rest: '' });

/**
 * A late rtk verdict lands on the scan that queued it. Never block the daemon's loop waiting for
 * rtk (review 2026-09-23: spawnSync per command made one board refresh take 10 s), so the count
 * moves out of pending when rtk answers — and a rotated or evicted log's new scan is left alone.
 */
function creditRtk(scan: ToolScan): void {
  const key = scan.codex ? 'rtk-missed' : 'rtk';
  scan.kinds[key] = (scan.kinds[key] ?? 0) + 1;
}

function settleRtk(scan: ToolScan, rewritten: boolean | null, evaluate: () => Promise<boolean | null>): void {
  if (toolCache.get(scan.file) !== scan) return;
  // No verdict is not a false one: the call stays pending until rtk answers (task 2771).
  if (rewritten === null) { scan.reask.push(evaluate); return; }
  const pending = (scan.kinds[RTK_PENDING] ?? 0) - 1;
  if (pending > 0) scan.kinds[RTK_PENDING] = pending;
  else delete scan.kinds[RTK_PENDING];
  if (rewritten) creditRtk(scan);
}

function askRtk(scan: ToolScan, evaluate: () => Promise<boolean | null>): void {
  void evaluate().then((rewritten) => settleRtk(scan, rewritten, evaluate));
}

function countLines(scan: ToolScan, stream: LineStream, bytes: Buffer, rtk: string): void {
  const lines = (stream.rest + stream.decoder.write(bytes)).split('\n');
  stream.rest = lines.pop() ?? '';
  const countLine = (line: string) => {
    const entry = parse(line);
    let calls = leadCalls(entry, scan.codex === true);
    const counts: Record<string, number> = {};
    for (const [name, args] of calls) countTool(counts, name, args);
    // Typed Codex calls still count tool kinds, but only completed executions judge rtk.
    if (scan.codex) delete counts.rtk;
    for (const [kind, count] of Object.entries(counts)) scan.kinds[kind] = (scan.kinds[kind] ?? 0) + count;
    if (scan.codex) {
      const item = entry?.type === 'event_msg' && entry.payload?.type === 'item_completed' ? entry.payload.item : null;
      const command = item?.type === 'CommandExecution' && Array.isArray(item.command) ? item.command.at(-1) : null;
      calls = typeof command === 'string' ? [['exec_command', { command }]] : [];
    }
    for (const [name, args] of calls) {
      // Claude records the pre-hook command: credit registry matches as rtk. Codex's
      // completed command is post-hook: credit literal rtk, judge bare matches as missed.
      const kinds = toolKinds(name, args);
      if (!kinds.includes('shell')) continue;
      if (kinds.includes('rtk')) {
        if (scan.codex) scan.kinds.rtk = (scan.kinds.rtk ?? 0) + 1;
        continue;
      }
      const verdict = rtkVerdict(name, args, rtk);
      if (verdict.known !== null) {
        if (verdict.known) creditRtk(scan);
        continue;
      }
      if (!verdict.evaluate) continue;
      scan.kinds[RTK_PENDING] = (scan.kinds[RTK_PENDING] ?? 0) + 1;
      askRtk(scan, verdict.evaluate);
    }
  };
  for (const line of lines) {
    if (scan.codex === null && stream === scan.first) {
      scan.codex = parse(line)?.type === 'session_meta';
      for (const pending of scan.pending) countLine(pending);
      scan.pending = [];
    }
    if (scan.codex === null) scan.pending.push(line);
    else countLine(line);
  }
}

/** Shell commands and MCP servers inside a Codex desktop `exec` JavaScript body. */
function codexExecCalls(source: string): Array<[string, unknown]> {
  const calls: Array<[string, unknown]> = [];
  for (const match of source.matchAll(/\b(?:cmd|command)\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) {
    calls.push(['exec_command', { command: match[2].replaceAll('\\"', '"').replaceAll("\\'", "'").replaceAll('\\\\', '\\') }]);
  }
  for (const match of source.matchAll(/tools\.(mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_]+)/g)) calls.push([match[1], {}]);
  return calls;
}

function leadCalls(entry: any, codex: boolean): Array<[string, unknown]> {
  if (!codex) {
    if (entry?.type !== 'assistant' || entry.isSidechain || !Array.isArray(entry.message?.content)) return [];
    return entry.message.content.filter((block: any) => block?.type === 'tool_use' && typeof block.name === 'string').map((block: any) => [block.name, block.input]);
  }
  const item = entry?.type === 'response_item' ? entry.payload : null;
  if (item?.type === 'custom_tool_call' && typeof item.input === 'string') return item.name === 'exec' ? codexExecCalls(item.input) : [[String(item.name), {}]];
  if (item?.type === 'function_call' && typeof item.name === 'string') {
    let args: unknown = {};
    try { args = JSON.parse(item.arguments ?? '{}'); } catch { /* an unparsable argument string counts the call alone */ }
    return [[item.name, args]];
  }
  if (item?.type === 'local_shell_call') return [['local_shell_call', { command: item.action?.command }]];
  return [];
}

/**
 * The tool kinds of one lead log, counted incrementally. `rtk` is the binary asked about shell
 * commands it did not run through (a test seam; the daemon uses the one on PATH) — its verdicts
 * arrive off the event loop, so unjudged commands are counted as `rtk-pending` meanwhile.
 */
export function leadTools(file: string, rtk = 'rtk'): Record<string, number> {
  const fd = openSync(file, 'r');
  try {
    const { size, dev, ino } = fstatSync(fd);
    const signature = Buffer.alloc(Math.min(size, 4096));
    const signatureBytes = readSync(fd, signature, 0, signature.length, 0);
    let cached = toolCache.get(file);
    if (!cached || cached.dev !== dev || cached.ino !== ino || size < cached.tailOffset ||
        !signature.subarray(0, cached.signature.length).equals(cached.signature)) {
      // The first scan spends a bounded budget on the header and the newest complete lines.
      // The older prefix is consumed in later scans, ending where the tail's first full line begins.
      const header = Buffer.alloc(Math.min(size, 64 * 1024));
      const headerBytes = readSync(fd, header, 0, header.length, 0);
      const headerText = header.subarray(0, headerBytes).toString('utf8');
      const codex = headerText.includes('\n') ? parse(headerText.split('\n')[0])?.type === 'session_meta' : null;
      const start = Math.max(0, size - (TOOL_SCAN_BYTES - signatureBytes - headerBytes - 1));
      const buffer = Buffer.alloc(size - start);
      const read = readSync(fd, buffer, 0, buffer.length, start);
      let skip = 0;
      let joinPrefix = false;
      if (start > 0) {
        const previous = Buffer.alloc(1);
        readSync(fd, previous, 0, 1, start - 1);
        if (previous[0] !== 10) {
          const newline = buffer.subarray(0, read).indexOf(10);
          skip = newline < 0 ? read : newline + 1;
          // No line boundary in this tail: its bytes belong to a line begun in the prefix.
          // The prefix stream must carry that line through to future appends.
          joinPrefix = newline < 0;
        }
      }
      // With no boundary, bridge the gap after the already-read header on later scans.
      // Retain the tail bytes so the unfinished line is never discarded.
      const prefixEnd = joinPrefix ? start : start + skip;
      const prefix = lineStream();
      const tail = lineStream();
      cached = { file, dev, ino, signature: signature.subarray(0, signatureBytes), codex, kinds: {},
        prefixOffset: joinPrefix ? Math.min(headerBytes, start) : 0, prefixEnd,
        prefix, tailOffset: start + read, tail, parked: joinPrefix ? buffer.subarray(0, read) : null,
        first: prefixEnd > 0 ? prefix : tail, pending: [], reask: [] };
      toolCache.set(file, cached);
      if (joinPrefix) countLines(cached, prefix, header.subarray(0, cached.prefixOffset), rtk);
      else if (skip < read) countLines(cached, cached.tail, buffer.subarray(skip, read), rtk);
    } else {
      let budget = TOOL_SCAN_BYTES - signatureBytes;
      const scan = cached;
      for (const evaluate of scan.reask.splice(0)) askRtk(scan, evaluate);
      const consume = (stream: LineStream, offset: number, available: number): number => {
        const length = Math.min(budget, available);
        if (!length) return 0;
        const buffer = Buffer.alloc(length);
        const read = readSync(fd, buffer, 0, length, offset);
        if (read) countLines(scan, stream, buffer.subarray(0, read), rtk);
        budget -= read;
        return read;
      };
      // With a known line boundary, new appends are visible on the very next scan.
      if (!cached.parked && size > cached.tailOffset) {
        cached.tailOffset += consume(cached.tail, cached.tailOffset, size - cached.tailOffset);
      }
      if (cached.prefixOffset < cached.prefixEnd) {
        cached.prefixOffset += consume(cached.prefix, cached.prefixOffset, cached.prefixEnd - cached.prefixOffset);
      }
      if (cached.parked && cached.prefixOffset === cached.prefixEnd) {
        countLines(cached, cached.prefix, cached.parked, rtk);
        cached.parked = null;
        cached.tail = cached.prefix;
      }
      if (size > cached.tailOffset) {
        cached.tailOffset += consume(cached.tail, cached.tailOffset, size - cached.tailOffset);
      }
    }
    cached.signature = signature.subarray(0, signatureBytes);
    if (toolCache.size > 200) toolCache.delete(toolCache.keys().next().value!);
    return { ...cached.kinds };
  } finally {
    closeSync(fd);
  }
}

export type LeadRow = LeadContext & { limit: number; percent: number; over: boolean; updated: string; kinds: Record<string, number> };

/**
 * Leads active in the last `minutes`: claude transcripts (one level under ~/.claude/projects, so
 * subagent logs in `<session>/subagents/` stay out) and codex rollouts under every year/month/day directory.
 * Seats (by checkout or by `seatSessions`), one-shot runs and subagents are left out (isLead).
 * The walk yields. Callers that decide from the result await this fresh scan; a cache would miss
 * a lead whose transcript appeared after the last poll.
 */
export async function activeLeads(options: { home?: string; minutes?: number; now?: number; rtk?: string; seatSessions?: ReadonlySet<string> } = {}): Promise<LeadRow[]> {
  const home = options.home ?? os.homedir();
  const now = options.now ?? Date.now();
  const since = now - (options.minutes ?? 30) * 60_000;
  const clock: ScanClock = { stretch: performance.now() };
  const files = [...await recent(path.join(home, '.claude', 'projects'), since, 1, clock)];
  // A rollout stays in its session's start-day directory, even when a Codex GUI lead writes
  // weeks later. Walk every year/month/day directory; recent() filters by file mtime and yields.
  files.push(...await recent(path.join(home, '.codex', 'sessions'), since, 3, clock));
  const rows: LeadRow[] = [];
  for (const file of new Set(files)) {
    await breathe(clock);
    let context: LeadContext | null;
    try { context = readLeadContext(file); } catch { continue; }
    if (!context || !isLead(context, home, options.seatSessions)) continue;
    const updatedMs = context.at === null ? NaN : Date.parse(context.at);
    if (!Number.isFinite(updatedMs) || updatedMs < since) continue;
    const limit = leadLimit(context.window);
    let kinds: Record<string, number> = {};
    try { kinds = leadTools(file, options.rtk); } catch { /* a log that cannot be read shows no badges */ }
    rows.push({ ...context, limit, percent: Math.round((context.tokens / limit) * 100), over: context.tokens >= limit, updated: new Date(updatedMs).toISOString(), kinds });
  }
  return rows.sort((a, b) => b.updated.localeCompare(a.updated));
}
