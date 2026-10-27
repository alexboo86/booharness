#!/usr/bin/env node
// Recursive forced deletion (`rm` with a recursive and a force flag) is refused
// by a HOOK, not a permission rule (operator decisions #14075, #14077): the
// desktop app keeps its terminal approval card while ANY shell rule sits in
// permissions.deny or ask of ~/.claude/settings.json, and a rule cannot see
// mcp__terminal__run_in_terminal at all. A hook is not a rule, and the matcher
// Bash|mcp__terminal__run_in_terminal reaches both shells. install-harness.mjs
// wires it for the claude runtime only. Leads and seats alike are judged —
// unlike seat-stash-hook.mjs there is no lead early exit: rm -rf of a worktree
// costs the operator whoever runs it.
//
// The judgement is the reviewed guard, not a substring: every top-level
// segment (split at &&, ||, ;, | outside quotes) and, through invocations,
// every launcher layer (sudo, env, xargs, timeout, bash -c, rtk run, a quoted
// command string) is unwrapped, and any link whose program is rm carrying both
// a recursive flag (-r, -R, --recursive) and a force flag (-f, --force) in any
// spelling (-rf, -fr, -r -f, --recursive --force, mixed) is denied, with the
// reason naming the refused link. Force is the lowercase -f and --force only:
// uppercase -F is not an rm force flag (`rm -R -F x` fails in rm itself,
// reviewer-glm-28927e.1) and is deliberately not matched. Backslash-newline
// continuations are joined before splitting and before every namesRm call.
// A command split cannot see through — an unclosed quote — is retried once by
// split itself with shell comments removed (task 2051, reviewer-codex-
// 243386.1); a text that still does not parse fails closed through namesRm
// (reviewer-grok-31fbca.1). `rm x`, `rm -r x`, `echo rm -rf x` and
// `git rm -rf x` pass.
//
// Known over-refusals, deliberate (reviewer-codex-243386.1): the terminal
// tool types into an interactive zsh, where `#` is an ordinary word unless
// interactivecomments is set, so `echo hello # ; rm -rf x` and `rm -r x # -f`
// stay refused although a non-interactive sh would never run the rm; and a
// heredoc body holding an `rm -rf x` line stays refused because the body may
// feed a shell.
//
// Fail closed, narrowly: a payload that cannot be parsed and a command the
// guard cannot split are denied only when their text names rm, and a broken
// guard import denies only a command that
// names rm — a broken hook must not block every Bash call of every session
// (seat-stash-hook.mjs precedent, review 2026-10-08). The main-module guard
// compares real paths, so a symlinked file or directory cannot skip the body
// (lessons #14032/#14033).
//
// Limits, accepted (they are exactly what the retired prefix rules
// `Bash(rm -rf *)` / `Bash(rm -fr *)` never saw either): `find -delete`,
// `git clean`, interpreter one-liners (`python -c`, `node -e`), long-flag
// abbreviations, and any program hidden in a command substitution. This
// deters a mistake; it is not a sandbox.

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

/** rm named as a word through quotes, backslashes, continuations or case: `r"m"`, `r\m`, `r\<newline>m`, `RM`; `format` or `npm` do not match. */
function namesRm(text) {
  return /\brm\b/i.test(String(text ?? '').replace(/\\\r?\n/g, '').replace(/['"\\]/g, ''));
}

function parsePayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The command string of a Bash or terminal payload, or null when no structure names one. */
function payloadCommand(input) {
  let body = input.tool_input ?? input.toolInput;
  if (typeof body === 'string') {
    body = parsePayload(body);
  }
  return body && typeof body === 'object' && typeof body.command === 'string' ? body.command : null;
}

/** The run is an rm carrying both a recursive and a force flag, in any spelling. */
function recursiveForcedRun(run) {
  const name = String(run[0] ?? '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
  if (name !== 'rm') return false;
  let recursive = false;
  let force = false;
  for (const arg of run.slice(1)) {
    if (arg === '--') break;
    if (!arg.startsWith('-') || arg === '-') continue;
    if (arg.startsWith('--')) {
      const flag = arg.split('=')[0];
      if (flag === '--recursive') recursive = true;
      if (flag === '--force') force = true;
      continue;
    }
    for (const ch of arg.slice(1)) {
      if (ch === 'r' || ch === 'R') recursive = true;
      else if (ch === 'f') force = true;
    }
  }
  return recursive && force;
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
let invoked = '';
if (process.argv[1]) {
  try { invoked = realpathSync(path.resolve(process.argv[1])); } catch { invoked = ''; }
}
let self = '';
try { self = realpathSync(fileURLToPath(import.meta.url)); } catch { self = ''; }
if (invoked && self && same(invoked, self)) {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  const input = parsePayload(raw);
  // The matcher promises Bash|mcp__terminal__run_in_terminal; a payload naming
  // another tool is not ours to judge.
  if (input && !/^(?:Bash|mcp__terminal__run_in_terminal)$/i.test(String(input.tool_name || input.toolName || ''))) process.exit(0);
  const command = input ? payloadCommand(input) : null;
  if (command === null) {
    // Nothing structural to judge: deny only when the raw payload names rm.
    if (raw.trim() && namesRm(raw)) {
      deny(input, 'shell-delete-hook cannot parse this payload and denies it because it names rm. Send tool_input as an object with a command string; remove named paths without -f, or ask the operator.');
    }
    process.exit(0);
  }
  // The command is structural: any failure to judge it denies, naming the cause.
  try {
    const { split, invocations } = await import('../orchestrator/src/seat-guard.ts');
    // `rm \<newline>-rf x` is a line continuation to the shell (it runs as
    // rm -rf) but a literal backslash inside a word to split; join
    // continuations before splitting (reviewer-grok-31fbca.1).
    const segments = split(command.replace(/\\\r?\n/g, ''));
    if (segments === null) {
      // split already retried with shell comments removed; a text that still
      // does not parse cannot be judged. Fail closed through the same
      // namesRm path as a broken import (reviewer-grok-31fbca.1).
      if (namesRm(command)) {
        deny(input, 'shell-delete-hook cannot judge this command and denies it because it names rm (the guard could not split it, even with shell comments removed). Remove named paths without -f, or ask the operator.');
      }
      process.exit(0);
    }
    for (const words of segments) {
      for (const run of invocations(words)) {
        if (recursiveForcedRun(run)) {
          deny(input, `${run.join(' ')}: recursive forced deletion is refused. Remove named paths without -f, or ask the operator.`);
          process.exit(0);
        }
      }
    }
  } catch (error) {
    if (namesRm(command)) {
      deny(input, `shell-delete-hook cannot judge this command and denies it because it names rm (${String(error?.message ?? error)}). Remove named paths without -f, or ask the operator.`);
    }
  }
  process.exit(0);
}
