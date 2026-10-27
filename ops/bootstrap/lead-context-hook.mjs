#!/usr/bin/env node
// PostToolUse (claude and codex): order a lead whose context passed the handover
// limit to finish the step in hand and invoke /next itself, unasked (orch phase 5, decisions
// #10478 and #11903). A GUI lead cannot be handed to a successor from outside;
// this is the one channel that reaches it mid-work, between the operator's
// messages. Once at the limit, then once per further tenth of it: a reminder on
// every tool call would be noise the lead learns to skip.
//
// The context comes from the session's own log (transcript_path), read by
// ops/orchestrator/src/leads.ts: no daemon, no model call. Seats are skipped (orch
// gives them SEAT_POLICY_ROLE and ORCH_SEAT_ID), and so is any session that is not
// a person's (a `claude -p`, a `codex exec`, a subagent) or sits in a seat checkout. The hook never fails a
// tool call: every error ends in silence.
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_TTL_MS = 7 * 86_400_000;

function readStdin() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function loadState(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

function saveState(file, state, now) {
  for (const [key, value] of Object.entries(state)) if (!(now - (value?.at ?? 0) < STATE_TTL_MS)) delete state[key];
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, file);
}

const k = (tokens) => `${Math.round(tokens / 1000)}k`;

/** The reminder for `context`, or null. Exported for the tests. */
export async function remind(input, env = process.env, now = Date.now()) {
  if (env.ORCH_SEAT_ID || env.SEAT_POLICY_ROLE) return null;
  const transcript = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (!transcript) return null;
  const { readLeadContext, leadLimit, leadBand, isLead, LEAD_BAND_SHARE, LEAD_CAP, LEAD_WINDOW_SHARE } = await import('../orchestrator/src/leads.ts');
  const { loadConfig } = await import('../orchestrator/src/config.ts');
  const context = readLeadContext(transcript);
  if (!context || !isLead(context)) return null;
  const limit = leadLimit(context.window);
  const band = leadBand(context.tokens, limit);
  const file = path.join(loadConfig(env).stateDir, 'lead-reminders.json');
  const state = loadState(file);
  const key = String(input.session_id || context.session);
  if (band === null) {
    // Below the limit again (a compaction, a /clear): the next crossing reminds afresh.
    if (state[key]) { delete state[key]; saveState(file, state, now); }
    return null;
  }
  if (typeof state[key]?.band === 'number' && state[key].band >= band) return null;
  state[key] = { band, at: now };
  saveState(file, state, now);
  const basis = context.window ? `${LEAD_WINDOW_SHARE * 100}% of the ${k(context.window)} window, capped at ${k(LEAD_CAP)}` : `the ${k(LEAD_CAP)} cap`;
  const next = limit + (band + 1) * limit * LEAD_BAND_SHARE;
  return `[orch] This lead's context is ${k(context.tokens)} tokens, past the ${k(limit)} handover limit (${basis}; decision #11903). `
    + 'Finish the step in hand, then invoke /next yourself now, without asking the operator (decision #11903): the Skill tool with skill `next` '
    + '(codex: run /next, .agents/skills/next/SKILL.md). It commits, writes the handoff (memoryctl handoff) with the running seats for the successor, '
    + `and opens a fresh session. Next reminder at ${k(next)}.`;
}

// Run as a hook, not imported by a test. Compare filesystem identities: Node
// resolves the module but leaves argv[1] as typed, so a symlinked file or
// directory must still run the body (the seat-stash-hook.mjs guard, task
// 2043); an error fails closed into silence. Windows spells a drive letter
// either case.
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
let invoked = '';
if (process.argv[1]) {
  try { invoked = realpathSync(path.resolve(process.argv[1])); } catch { invoked = ''; }
}
let self = '';
try { self = realpathSync(fileURLToPath(import.meta.url)); } catch { self = ''; }
if (invoked && self && same(invoked, self)) {
  const input = readStdin();
  try {
    const text = await remind(input);
    if (text) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name || 'PostToolUse', additionalContext: text } })}\n`);
    }
  } catch {
    // A reminder is never worth a failed tool call.
  }
  process.exit(0);
}
