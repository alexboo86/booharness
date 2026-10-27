#!/usr/bin/env node
// A native orch seat may not rewrite the stash stack every worktree of this
// repository shares (task 1999, operator decision #14007) — the twin of the
// Pi-side refusal in ops/orchestrator/src/pi-extension.ts. install-harness.mjs
// wires it as PreToolUse on Bash, claude runtime only: a glm seat reads that
// same ~/.claude/settings.json while glm.env carries no CLAUDE_CONFIG_DIR
// (measured 2026-10-04; scripts/check-hook-topology.mjs fails if that changes).
//
// Order of exits: a session with no seat env is a lead and exits 0 before any
// read. A seat's Bash payload that
// cannot be parsed — broken JSON, or a tool_input that is not a command
// object — denies when its raw text names stash. Every parsed seat Bash
// command goes to the reviewed guard: a raw substring prefilter was measured
// missing `git sta"sh" pop` and `git sta\sh pop`, which refuseStash refuses
// (review 2026-10-08). If the import or the guard throws, the command with
// quotes and backslashes removed is checked case-insensitively for `stash`:
// fail closed for stash commands, open for everything else — a broken guard
// must not block every Bash call of every seat. `git stash list` and
// `git stash show` pass, by refuseStash itself. The main-module guard compares
// real paths, so a symlinked file or directory cannot skip the body.
//
// Limits, measured and accepted: this deters a mistake, it is not a sandbox
// (seat-guard.ts refuseStash). A command substitution hides any program from
// it. The codex deny contract is unmeasured and is a second slice, and codex
// desktop `exec` bodies are likewise not covered. Native ACP seats (qwen,
// mimo, grok, kimi, opencode) are not wired at all.

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function deny(input, reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: (input && typeof input === 'object' && input.hook_event_name) || 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`);
}

/** Stash named through quotes, backslashes or case: `git sta"sh" pop`, `git sta\sh pop`, `git Stash pop`. */
function namesStash(text) {
  return String(text ?? '').replace(/['"\\]/g, '').toLowerCase().includes('stash');
}

function parsePayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The command string of a Bash payload, or null when no structure names one. */
function payloadCommand(input) {
  let body = input.tool_input ?? input.toolInput;
  if (typeof body === 'string') {
    body = parsePayload(body);
  }
  return body && typeof body === 'object' && typeof body.command === 'string' ? body.command : null;
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
let invoked = '';
if (process.argv[1]) {
  try { invoked = realpathSync(path.resolve(process.argv[1])); } catch { invoked = ''; }
}
let self = '';
try { self = realpathSync(fileURLToPath(import.meta.url)); } catch { self = ''; }
if (invoked && self && same(invoked, self)) {
  // A lead is never denied (seats.ts sets one of these for every seat).
  if (!(process.env.ORCH_SEAT_ID || process.env.SEAT_POLICY_ROLE)) process.exit(0);
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  const input = parsePayload(raw);
  // The matcher promises Bash; a payload naming another tool is not ours to judge.
  if (input && !/^Bash$/i.test(String(input.tool_name || input.toolName || ''))) process.exit(0);
  const command = input ? payloadCommand(input) : null;
  if (command === null) {
    // Nothing structural to judge: deny only when the raw payload names stash.
    if (raw.trim() && namesStash(raw)) {
      deny(input, 'seat-stash-hook cannot parse this Bash payload and denies it because it names stash. Send tool_input as an object with a command string; set work aside with a WIP commit on your seat branch or a file copy.');
    }
    process.exit(0);
  }
  // The command is structural: any failure to judge it denies, naming the cause.
  try {
    const { refuseStash, STASH_REFUSAL } = await import('../orchestrator/src/seat-guard.ts');
    const reason = refuseStash(command);
    if (reason) deny(input, `${reason}: ${STASH_REFUSAL}.`);
  } catch (error) {
    if (namesStash(command)) {
      deny(input, `seat-stash-hook cannot judge this stash command and denies it (${String(error?.message ?? error)}). Set work aside with a WIP commit on your seat branch or a file copy.`);
    }
  }
  process.exit(0);
}
