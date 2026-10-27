#!/usr/bin/env node
// PreToolUse: refuse a built-in Agent/Task subagent that would inherit the
// parent's Claude model. A hint already named the cheap route and was stepped
// over (measured 2026-09-17, session 2f9c3c20: three Opus subagents, no model).
//
//   node subagent-route-hook.mjs
//
// A cheap model must be proven (`model: haiku` on the call, or a definition
// whose frontmatter `model:` is haiku). Fail-open is only unparsable stdin, an
// unreadable definition file, or an exception: a hook that breaks a session is
// worse than the cost it was written to save. A missing definition is an
// answer, not an error — the Agent tool omits `subagent_type` to mean
// general-purpose on the parent's model, which is the incident this gate
// exists for. Outside this repository the call is not ours to police.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUBAGENT_TOOL = /^(Agent|Task)$/i;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DENY_REASON = [
  'The built-in Agent/Task subagent inherits the parent\'s model when `model` is omitted, so this call spends the operator\'s Claude quota.',
  'Route the work instead:',
  '- reading and sweeps: mcp__orch__seat_create with role: "scout" (orch picks the family)',
  '- a sweep of 3+ files, another branch, logs, transcripts or memory -> an orch scout seat (seat_create role scout, one question)',
  '- escape: pass model: "haiku" when a claude-family subagent really is the right tool.',
].join('\n');

const allow = () => process.exit(0);

function deny(reason) {
  writeSync(1, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function insideRepo(cwd) {
  // Prefix first: a session whose cwd is the checkout that owns this file.
  // Git answers the worktree case the prefix misses (Paseo seats). One spawn,
  // only after prefix fails, only on Agent|Task. Git unavailable or error
  // keeps the prefix answer. Fail open on anything unexpected.
  let prefix = false;
  try {
    const root = realpathSync(REPO_ROOT);
    const at = realpathSync(String(cwd));
    prefix = at === root || at.startsWith(root + sep);
    if (prefix) return true;
  } catch {
    // prefix unavailable; git may still answer
  }
  try {
    const probe = spawnSync('git', ['-C', String(cwd), 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      timeout: 4000,
    });
    if (!probe || probe.status !== 0) return prefix;
    const raw = String(probe.stdout ?? '').trim();
    if (!raw) return prefix;
    const common = realpathSync(resolve(String(cwd), raw));
    const ours = realpathSync(join(REPO_ROOT, '.git'));
    return common === ours;
  } catch {
    return prefix;
  }
}

function isHaiku(model) {
  const value = String(model ?? '').trim().toLowerCase();
  return value === 'haiku' || value.startsWith('claude-haiku');
}

function agentFileName(type) {
  const name = String(type ?? '');
  if (!name || name.includes('..') || /[\\/]/.test(name) || name.includes('\0')) return null;
  return `${name}.md`;
}

function frontmatterModel(text) {
  if (!text.startsWith('---')) return '';
  const end = text.indexOf('\n---', 3);
  if (end < 0) return '';
  const match = text.slice(3, end).match(/^model:\s*["']?([^\s"']+)/m);
  return match ? match[1] : '';
}

function definedModel(type, home) {
  const fileName = agentFileName(type);
  // Absent, empty, or not a file name: no cheap model can be proven. That is
  // an answer (deny), not an error. The Agent tool omits subagent_type to mean
  // general-purpose on the parent's model — the incident this gate exists for.
  if (!fileName) return { ok: true, missing: true };
  for (const file of [
    join(REPO_ROOT, '.claude', 'agents', fileName),
    join(home, '.claude', 'agents', fileName),
  ]) {
    try {
      if (!existsSync(file)) continue;
      return { ok: true, model: frontmatterModel(readFileSync(file, 'utf8')) };
    } catch {
      // Unreadable (EPERM, EISDIR): fail open. A hook that cannot read a
      // definition must not break the session.
      return { ok: false };
    }
  }
  return { ok: true, missing: true };
}

function runtimeHome() {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    allow();
  }

  const toolName = String(event.tool_name ?? event.toolName ?? '');
  if (!SUBAGENT_TOOL.test(toolName)) allow();

  if (!insideRepo(event.cwd)) allow();

  const input = (event.tool_input ?? event.toolInput) ?? {};
  if (isHaiku(input.model)) allow();

  const defined = definedModel(input.subagent_type, runtimeHome());
  if (!defined.ok) allow();
  if (!defined.missing && isHaiku(defined.model)) allow();

  deny(DENY_REASON);
}

let isMainModule = false;
try {
  isMainModule = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
} catch {
  isMainModule = false;
}
if (isMainModule) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}
