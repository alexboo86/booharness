// Edit-reliability baseline for the A/B stand (decision #12807): reads the Pi
// session JSONL files of orch seats READ-ONLY and reports, per arm/family/role,
// first-edit success, missing results, per-call failures and their causes, and
// how often a failed edit is followed by an immediate re-read of the same path.
//
// Session->seat mapping: the orch store (read-only) keeps the provider session
// id in seats.data.sessionId; for Pi seats that is the session FILE's absolute
// path (ops/orchestrator/src/providers/pi.ts `state.sessionFile`). Remote win
// seats keep the session on the host: those are counted uncovered and named.
// Native claude seats write no Pi session at all (providers/index.ts).
//
// CLI: node ops/ab-stand/edit-metrics.mjs --since 7d [--json] [--db <path>]

import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// Pi built-ins, pi-toolkit@0.9.3 extensions/codex-edit/index.ts (apply_patch),
// and pi-hashline-edit-pro@4.4.4 src/{replace,insert,replace-undo}.ts registrations.
// The latter replaces edit; read and anchor_grep are not editing tools.
const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'replace', 'insert', 'undo_last_change']);

/** Error kinds, taken from the real error texts found in live sessions (2026-09). */
export function classifyEditError(text) {
  if (/^Could not find /.test(text)) return 'not-found';
  if (/^Found \d+ occurrences /.test(text)) return 'non-unique';
  if (/overlap in /.test(text)) return 'overlap';
  if (/^No changes made /.test(text)) return 'no-change';
  if (/^Validation failed /.test(text)) return 'validation';
  if (/\b(ENOENT|EACCES|EPERM|EISDIR|ENOSPC)\b/.test(text)) return 'io-error';
  return 'other';
}

/** Ordered tool-call stream, with timestamps and explicit result presence. */
export function toolCallsOf(file, sinceMs = 0) {
  const results = new Map(); // toolCallId -> {isError, text}
  const calls = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || !line.includes('"type":"message"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // a truncated tail line of a live session
    const message = entry.message;
    if (!message || typeof message !== 'object') continue;
    const ts = Date.parse(entry.timestamp ?? '');
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const text = (message.content ?? []).map((c) => c?.text ?? '').join('\n');
      results.set(message.toolCallId, { isError: message.isError === true, text });
    } else if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item?.type === 'toolCall' && typeof item.name === 'string') {
          calls.push({ id: item.id, name: item.name, path: item.arguments?.path ?? null, timestamp: ts });
        }
      }
    }
  }
  for (const call of calls) {
    const result = results.get(call.id);
    call.hasResult = result !== undefined;
    call.isError = call.hasResult ? result.isError : null;
    if (call.isError) call.errorKind = classifyEditError(result.text);
  }
  // Match results across the full transcript before applying the call window.
  return calls.filter((call) => !Number.isFinite(call.timestamp) || call.timestamp >= sinceMs);
}

/** Per-call window metrics; the actual session-first edit counts only if in the window. */
export function sessionMetrics(file, sinceMs = 0) {
  const calls = toolCallsOf(file);
  const metrics = {
    calls: 0, failed: 0, unknown: 0, kinds: {}, rereadLoops: 0,
    firstEdits: 0, firstEditSucceeded: 0, firstEditFailed: 0, firstEditUnknown: 0,
  };
  let firstEditSeen = false;
  calls.forEach((call, i) => {
    if (!EDIT_TOOLS.has(call.name)) return;
    // An undo reverts rather than edits, and only hashline arms have one: it never decides first-edit success.
    const isFirstEdit = !firstEditSeen && call.name !== 'undo_last_change';
    if (isFirstEdit) firstEditSeen = true;
    if (Number.isFinite(call.timestamp) && call.timestamp < sinceMs) return;
    if (isFirstEdit) {
      metrics.firstEdits += 1;
      if (!call.hasResult) metrics.firstEditUnknown += 1;
      else if (call.isError) metrics.firstEditFailed += 1;
      else metrics.firstEditSucceeded += 1;
    }
    metrics.calls += 1;
    if (!call.hasResult) { metrics.unknown += 1; return; }
    if (!call.isError) return;
    metrics.failed += 1;
    if (call.errorKind) metrics.kinds[call.errorKind] = (metrics.kinds[call.errorKind] ?? 0) + 1;
    const next = calls[i + 1];
    if (call.path && next?.name === 'read' && next.path === call.path) metrics.rereadLoops += 1;
  });
  return metrics;
}

/**
 * One transcript's first-edit outcome for an A/B stand row (task 1868 slice 3a):
 * 'success', 'failed', or 'unknown' (the call has no recorded result), and null when the
 * session never reached a first edit. The same split sessionMetrics counts, so the undo
 * exclusion and the cross-transcript result matching stay single-sourced.
 */
export function firstEditOutcome(file) {
  const metrics = sessionMetrics(file);
  if (!metrics.firstEdits) return null;
  return metrics.firstEditSucceeded ? 'success' : metrics.firstEditFailed ? 'failed' : 'unknown';
}

/** seat rows: id, arm, role, family, harness, host, session path, last activity. Read-only. */
export function loadSeats(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare(
      `SELECT id, role, family, updated_at,
              json_extract(data, '$.standArm') AS arm,
              json_extract(data, '$.harness') AS harness,
              json_extract(data, '$.host') AS host,
              json_extract(data, '$.sessionId') AS sessionId,
              (SELECT MAX(COALESCE(t.ended_at, t.created_at)) FROM turns t WHERE t.seat_id = seats.id) AS lastTurnAt
       FROM seats`,
    ).all().map((row) => ({
      ...row,
      arm: row.arm ?? 'stock',
      // Rows older than the harness column: claude is native, every routed family is Pi
      // (defaultHarness in ops/orchestrator/src/providers/index.ts).
      harness: row.harness ?? (row.family === 'claude' ? 'native' : 'pi'),
      // Seat activity: its last turn's end (or start); a seat that never turned: its last update.
      lastActivityAt: row.lastTurnAt ?? row.updated_at,
    }));
  } finally {
    db.close();
  }
}

/**
 * Aggregate edit metrics over every orch seat's Pi session.
 * Returns { groups, uncovered, nativeSeats, missing, noSession }.
 */
export function collect({ dbFile, sinceMs = 0 }) {
  const groups = new Map(); // `${arm}/${family}/${role}` -> metrics
  const uncovered = []; // remote host seats: session lives on the host, never guessed
  const nativeSeats = []; // native harness: no Pi session transcript at all
  const missing = []; // local session path recorded but the file is gone
  const noSession = []; // Pi seat that never started a session
  const group = (arm, family, role) => {
    const key = `${arm}/${family}/${role}`;
    if (!groups.has(key)) groups.set(key, {
      arm, family, role, sessions: 0, calls: 0, failed: 0, unknown: 0, kinds: {}, rereadLoops: 0,
      firstEdits: 0, firstEditSucceeded: 0, firstEditFailed: 0, firstEditUnknown: 0,
    });
    return groups.get(key);
  };
  for (const seat of loadSeats(dbFile)) {
    // The window applies to coverage the same as to counted sessions: a seat counts
    // only when its last activity (last turn, else its last update) is in the window.
    const active = Date.parse(seat.lastActivityAt ?? '') >= sinceMs;
    if (seat.harness !== 'pi') { if (active) nativeSeats.push(seat.id); continue; }
    if (seat.host) { if (active) uncovered.push(seat.id); continue; }
    if (!seat.sessionId) { if (active) noSession.push(seat.id); continue; }
    if (!existsSync(seat.sessionId)) { if (active) missing.push(seat.id); continue; }
    let stats;
    try { stats = statSync(seat.sessionId); } catch { missing.push(seat.id); continue; }
    if (stats.mtimeMs < sinceMs) continue; // untouched in the window: nothing to count
    const g = group(seat.arm, seat.family, seat.role);
    g.sessions += 1;
    const m = sessionMetrics(seat.sessionId, sinceMs);
    g.calls += m.calls;
    g.failed += m.failed;
    g.unknown += m.unknown;
    g.rereadLoops += m.rereadLoops;
    g.firstEdits += m.firstEdits;
    g.firstEditSucceeded += m.firstEditSucceeded;
    g.firstEditFailed += m.firstEditFailed;
    g.firstEditUnknown += m.firstEditUnknown;
    for (const [kind, n] of Object.entries(m.kinds)) g.kinds[kind] = (g.kinds[kind] ?? 0) + n;
  }
  const sort = (list) => list.sort();
  return {
    sinceMs,
    groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([key, g]) => ({
        group: key, ...g, failShare: g.calls ? g.failed / g.calls : 0,
        // Unknown first results stay in the denominator, never counted as successes.
        firstEditSuccessShare: g.firstEdits ? g.firstEditSucceeded / g.firstEdits : null,
      })),
    uncovered: sort(uncovered), nativeSeats: sort(nativeSeats),
    missing: sort(missing), noSession: sort(noSession),
  };
}

const pct = (share) => `${(100 * share).toFixed(1)}%`;
const kindsLine = (kinds) => Object.entries(kinds).sort((a, b) => b[1] - a[1])
  .map(([kind, n]) => `${kind}:${n}`).join(' ') || '-';
const nameList = (ids) => ids.length <= 12 ? ids.join(', ') : `${ids.slice(0, 12).join(', ')}, +${ids.length - 12} more`;

export function format(result, since) {
  const lines = [
    `Edit reliability of orch Pi seats, last ${since} (session files read-only)`,
    `window: since ${new Date(result.sinceMs).toISOString()}; calls counted by entry timestamp, seats covered by last activity (last turn, else seat update)`,
    'first edit: actual session-first edit, only if in window; first% = first-ok / first (including unknown); no first edit = —',
  ];
  const width = Math.max(22, ...result.groups.map((g) => g.group.length));
  lines.push(['arm/family/role'.padEnd(width), 'sessions'.padStart(8), 'edits'.padStart(7), 'failed'.padStart(7), 'unknown'.padStart(7), 'fail%'.padStart(7), 'rereads'.padStart(8), 'first'.padStart(7), 'first-ok'.padStart(8), 'first-fail'.padStart(10), 'first-unk'.padStart(9), 'first%'.padStart(7), '  error kinds'].join(' '));
  for (const g of result.groups) {
    lines.push([g.group.padEnd(width), String(g.sessions).padStart(8), String(g.calls).padStart(7), String(g.failed).padStart(7), String(g.unknown).padStart(7), pct(g.failShare).padStart(7), String(g.rereadLoops).padStart(8), String(g.firstEdits).padStart(7), String(g.firstEditSucceeded).padStart(8), String(g.firstEditFailed).padStart(10), String(g.firstEditUnknown).padStart(9), (g.firstEditSuccessShare === null ? '—' : pct(g.firstEditSuccessShare)).padStart(7), `  ${kindsLine(g.kinds)}`].join(' '));
  }
  lines.push(`uncovered (remote host seats, session only on the host): ${result.uncovered.length}${result.uncovered.length ? ` — ${nameList(result.uncovered)}` : ''}`);
  lines.push(`native claude seats write no Pi session: ${result.nativeSeats.length}${result.nativeSeats.length ? ` — ${nameList(result.nativeSeats)}` : ''}`);
  if (result.missing.length) lines.push(`session file missing: ${result.missing.length} — ${nameList(result.missing)}`);
  if (result.noSession.length) lines.push(`pi seats without a session yet: ${result.noSession.length} — ${nameList(result.noSession)}`);
  return lines.join('\n');
}

export function parseSince(arg) {
  const match = /^(\d+)([dhm])$/.exec(arg ?? '7d');
  if (!match) throw new Error(`--since takes Nd, Nh or Nm (got ${arg})`);
  const unit = { d: 86400e3, h: 3600e3, m: 60e3 }[match[2]];
  return Date.now() - Number(match[1]) * unit;
}

export function defaultDbFile(home = os.homedir()) {
  return path.join(process.env.ORCH_STATE_DIR ?? path.join(home, '.local', 'state', 'orch'), 'orch.sqlite');
}

export function main(argv = process.argv.slice(2)) {
  const argAfter = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const json = argv.includes('--json');
  const sinceArg = argAfter('--since') ?? '7d';
  const dbArg = argAfter('--db') ?? defaultDbFile();
  const sinceMs = parseSince(sinceArg);
  const result = collect({ dbFile: dbArg, sinceMs });
  console.log(json ? JSON.stringify({ since: sinceArg, ...result }, null, 2) : format(result, sinceArg));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
