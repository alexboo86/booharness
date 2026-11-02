#!/usr/bin/env node
// PreToolUse gate for the Claude desktop lead, one refusal per session: the
// operator's board comes FIRST (orch SKILL.md:12, operator decisions
// #10530 and #21159). On 2026-10-30 a Claude desktop lead (session f1a4d8cd)
// called mcp__orch__seats_list, seat_create and seat_land and opened the board
// only after the operator asked; the prose rule had not stopped it, so the
// operator ordered the rule enforced in code (order 2026-10-30).
//
// The refusal shape and the once-per-session marks are the pattern
// code-intel-order-hook.mjs proves on every claude runtime: the FIRST
// `mcp__orch__*` call of a session is denied with one message naming
// `mcp__Claude_Browser__preview_start` and the board URL; after that refusal,
// or after a board open, every later orch call of the session passes. A board
// open recorded BEFORE the first orch call means no refusal at all.
//
// A board open is `mcp__Claude_Browser__preview_start` or `navigate` whose url
// host is 127.0.0.1:7760 or localhost:7760 — the daemon address the skill page
// names. Chat tools are NOT exempt: they are `mcp__orch__*` like the rest.
//
// Task 3448 (operator order 2026-10-30): /clear changes the session id, so
// after a handover the board mark is gone while the board tab is still open in
// the pane, and a fresh preview_start opened a SECOND tab (observed
// reused:false). A PostToolUse on `mcp__Claude_Browser__tabs_context` lists
// the open tabs; a tab whose ORIGIN is the board address records the SAME
// board mark, so the lead only has to tabs_select the existing tab. The
// result is parsed defensively — the {browserOpen, tabs:[{tabId, origin,
// isActive}]} shape directly or as MCP content text that parses to it — and
// anything unparseable records nothing (fail open, like every other input).
//
// Orch worker seats are exempt the way the sibling lead hooks tell a seat:
// the seat-launch environment marker ORCH_SEAT_ID (SEAT_POLICY_ROLE also marks
// a seat). A Codex lead has no browser pane and is out of scope; this hook is
// wired into the claude runtime's settings.json only.
//
// Fail-open everywhere: this is an ordering rule, not a security gate — an
// unparseable event, a missing session id, an unknown tool, a non-string
// field or an unwritable refusal mark passes silently, and nothing but the
// decision JSON ever reaches stdout.
//
//   node lead-board-first-hook.mjs

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

if (process.env.ORCH_SEAT_ID || process.env.SEAT_POLICY_ROLE) process.exit(0);

let event = null;
try {
  event = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
if (event === null || typeof event !== 'object' || Array.isArray(event)) process.exit(0);

// Field values come from the harness as strings; anything else is malformed
// input and passes silently (String() on an object whose toString is null
// throws a TypeError and used to exit 1).
const toolNameField = event.tool_name ?? event.toolName;
const sessionIdField = event.session_id ?? event.sessionId;
if (typeof toolNameField !== 'string' || typeof sessionIdField !== 'string') process.exit(0);
const toolName = toolNameField;
const input = (event.tool_input ?? event.toolInput) ?? {};
if (!sessionIdField || !toolName) process.exit(0);
// Collision-free mark name: sanitizing to [A-Za-z0-9._-] aliased 'a:b' and
// 'a?b' onto one shared mark; the sha256 hex of the raw id cannot collide and
// keeps the filename bounded for any session id length.
const sessionId = createHash('sha256').update(sessionIdField).digest('hex');

const mark = join(tmpdir(), 'toolset-board-first', sessionId);
const stateDir = dirname(mark);
const boardMark = `${mark}.board`;
const refusedMark = `${mark}.refused`;

const BOARD_PORT = '7760';
const BOARD_HOSTS = new Set(['127.0.0.1', 'localhost']);
const isBoardUrl = (value) => {
  if (typeof value !== 'string' || !value) return false;
  let url = null;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return BOARD_HOSTS.has(url.hostname) && url.port === BOARD_PORT;
};

const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

// Marks are one per session and would otherwise live forever under tmpdir();
// every successful write prunes marks older than the bound. Best-effort.
const pruneMarks = () => {
  const cutoff = Date.now() - PRUNE_MS;
  for (const entry of readdirSync(stateDir)) {
    try {
      const path = join(stateDir, entry);
      const stats = statSync(path);
      if (stats.isFile() && stats.mtimeMs < cutoff) unlinkSync(path);
    } catch {
      /* best-effort, per entry */
    }
  }
};

// Write one mark, then prune aged ones; false when the mark could not be
// written. With `exclusive` the mark is created with 'wx': of any number of
// concurrent writers exactly ONE owns the mark — a plain overwrite let every
// racer through the existsSync/write gap and a barrier run denied 8 of 32
// first calls for one session (reviewer 2026-10-31) — and every loser,
// EEXIST included, returns false like any other failed write.
const recordMark = (path, exclusive = false) => {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path, String(Date.now()), exclusive ? { flag: 'wx' } : undefined);
  } catch {
    return false;
  }
  try {
    pruneMarks();
  } catch {
    /* best-effort */
  }
  return true;
};

// A board open is recorded before the tool runs, best-effort: a state write
// that fails must not block the browser pane the operator is waiting for.
if (toolName === 'mcp__Claude_Browser__preview_start' || toolName === 'mcp__Claude_Browser__navigate') {
  if (isBoardUrl(input.url)) recordMark(boardMark);
  process.exit(0);
}

if (toolName === 'mcp__Claude_Browser__tabs_context') {
  const response = event.tool_response ?? event.toolResponse;
  const tabs = [];
  if (response !== null && typeof response === 'object' && !Array.isArray(response)) {
    // A loop, not push(...): spreading a huge array overflows the call stack (reviewer-codex-76fd44).
    if (Array.isArray(response.tabs)) for (const tab of response.tabs) tabs.push(tab);
    if (Array.isArray(response.content)) {
      for (const item of response.content) {
        if (item === null || typeof item !== 'object' || typeof item.text !== 'string') continue;
        try {
          const parsed = JSON.parse(item.text);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.tabs)) {
            for (const tab of parsed.tabs) tabs.push(tab);
          }
        } catch {
          /* content text that is not JSON contributes no tabs */
        }
      }
    }
  }
  // tab null/non-object is skipped, not fatal: isBoardUrl guards the origin type.
  if (tabs.some((tab) => tab !== null && typeof tab === 'object' && isBoardUrl(tab.origin))) recordMark(boardMark);
  process.exit(0);
}

if (!toolName.startsWith('mcp__orch__')) process.exit(0);
if (existsSync(boardMark) || existsSync(refusedMark)) process.exit(0);

// The refusal, ONCE per session — mark first, deny second, and the mark is
// owned EXCLUSIVELY: only the process whose 'wx' create won emits the denial;
// every loser of the race passes silently with the rest. When the mark cannot
// be created at all the call PASSES (fail open): swallowing a failed mark
// write used to deny every later orch call of the session, and stdout must
// carry nothing but the decision JSON the harness reads.
if (!recordMark(refusedMark, true)) process.exit(0);
try {
  writeSync(1, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Board first (operator decisions #10530, #21159): open the board for the operator before any orch tool — '
        + 'call `mcp__Claude_Browser__tabs_context` first and `tabs_select` a board tab that is already open; '
        + 'only when none exists call `mcp__Claude_Browser__preview_start` with `url: "http://127.0.0.1:7760/"`. '
        + 'This refusal comes once per session: after it, orch calls pass.',
    },
  }));
} catch {
  // A destroyed pipe: the mark stands, so the session's one refusal is spent
  // fail-open instead of being re-denied on every later call.
  process.exit(0);
}
process.exit(0);
