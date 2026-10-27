#!/usr/bin/env node
// PreToolUse RTK routing: rewrite for codex/grok, deny with the command for kimi.
// (Named for codex, its first runtime. grok joined 2026-09-14: its hooks
// documentation applies a PreToolUse `updatedInput`, and its event carries
// `toolInput`, read beside `tool_input` below — one script serves both.)
//
// Claude and zcode get this from the native `rtk hook claude`. Codex cannot:
// its DESKTOP app (originator codex_work_desktop) does not call a shell tool
// at all - it calls one tool named `exec` whose input is JavaScript, and the
// command lives inside `await tools.shell_command({ command: 'bash -lc "…"' })`.
// Measured 2026-07-28 (rolled-back gate, memory #254/#255): with a hook that
// judged only the shell tool, the CLI was covered and the app was not - the
// model said "повторяю через встроенный раннер" and read the file that way.
// The extraction below is lifted verbatim from that gate, which was proven by
// live fire on both the Codex CLI and the GUI.
//
// Scope is deliberately RTK-only (operator, 2026-07-28: точечно, не каждый
// ход) - no read-ordering, no lesson gating, no Stop blocks. And unlike the
// gate this hook FAILS OPEN: a hook that cannot parse its input or reach rtk
// says nothing, because delivery hooks must never break a session.
//
// Trust: Codex runs a hook only after the operator confirms it in the app UI
// (Хуки → ⟳ → «Доверять»); a hand-written [hooks.state] trusted_hash does not
// survive the app's reconciliation, so none is written.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { alreadyRouted, rewriteHeavy, rewritePlus, unwrapUndispatchable } from './rtk-rewrite-lib.mjs';

const allow = () => process.exit(0);
const mode = process.argv[2] || 'codex';

/// `bash -lc "sed ..."` is a `sed` call wearing a coat - unwrap to the command.
function unwrapShell(text) {
  const match = text
    .trim()
    .match(/^(?:bash|sh|zsh|pwsh|powershell)\s+(?:-[a-zA-Z]+\s+)*(['"])([\s\S]+)\1\s*$/);
  return match ? unwrapShell(match[2]) : text;
}

/// The shell command this call is about to run, wherever Codex keeps it:
/// `command` on the CLI shell tool, `command:` string literals inside the
/// desktop app's `exec` JavaScript body.
function shellCommandOf(value) {
  if (typeof value.command === 'string') return unwrapShell(value.command);
  const source = typeof value.input === 'string' ? value.input : '';
  if (!source) return '';
  const found = [...source.matchAll(/command\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) =>
    m[2].replaceAll('\\"', '"').replaceAll("\\'", "'").replaceAll('\\\\', '\\'),
  );
  return found.map(unwrapShell).join(' ; ');
}

let event;
try {
  event = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow();
}

const input = (event && (event.tool_input ?? event.toolInput)) ?? {};
const command = shellCommandOf(input);
if (!command) allow();
if (mode === 'kimi' && alreadyRouted(command)) allow();

// rewritePlus = upstream `rtk rewrite` plus a pass that now mostly REFUSES
// upstream answers rtk cannot dispatch — see rtk-rewrite-lib.mjs
// for the 2026-08-05 re-measurement.
//
// Codex arrives having ALREADY typed `rtk` on things rtk cannot filter —
// measured 2026-08-05 in two live rollouts, `rtk powershell …` 8 and 9 times,
// plus `rtk memoryctl`. A Paseo member has to do that (its `--allowedTools` is
// `Bash(rtk *)`, so `rtk proxy x` is the only legal way to run `x`), and codex
// does NOT: its adapter passes no allowlist. So here the correction runs the
// other way — unwrap back to the bare command, and let rewritePlus judge THAT.
// Without this, the same call became `rtk proxy powershell …`: one extra process
// and a 0% row, which is what "rtk where it does not belong" looks like from
// the savings table.
let rewritten = '';
try {
  if (mode === 'kimi') {
    rewritten = rewriteHeavy(command);
  } else {
    const bare = unwrapUndispatchable(command) || command;
    rewritten = rewritePlus(bare) || (bare === command ? '' : bare);
  }
} catch {
  allow();
}
if (!rewritten || rewritten === command) allow();

if (process.platform === 'win32' && rewritten.startsWith('"')) {
  // Codex executes through `pwsh -Command`; a quoted path in command position
  // is an expression, not an invocation - the call operator fixes that.
  rewritten = `& ${rewritten}`;
}

// The desktop app's `exec` JavaScript body cannot be rewritten through
// `updatedInput.command` - there is no command field to replace. It USED to
// get a refusal carrying the correct form; operator decision 2026-07-31
// (harness deep-research 019fba5e): a deny costs a full extra model turn, so
// enforcement is now WARN-ONLY - let the exec body run, log the
// would-have-denied event for measurement. The topology probes keep this
// codex path non-blocking independently of kimi's deny transport.
function logRewrite(mode) {
  try {
    const logPath =
      process.env.RTK_GUARD_LOG ||
      join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'state'), 'rtk-guard', 'warnings.jsonl');
    mkdirSync(join(logPath, '..'), { recursive: true });
    appendFileSync(
      logPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        mode,
        // Same discriminator the guard writes: only `bare` is a would-deny
        // event. See alreadyRouted in rtk-rewrite-lib.mjs.
        kind: alreadyRouted(command) ? 'routed' : 'bare',
        svod: !!process.env.SVOD_MEMBER,
        cmd: command.slice(0, 200),
        use: rewritten.slice(0, 200),
      }) + '\n',
    );
  } catch {
    /* logging is best-effort */
  }
}

if (mode === 'kimi') {
  logRewrite('kimi');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Context economy: heavy output must go through RTK. Re-run this command as:\n${rewritten}`,
    },
  }));
  allow();
}

if (typeof input.command !== 'string') {
  logRewrite('codex-exec');
  allow();
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...input, command: rewritten },
    },
  }),
);
process.exit(0);
