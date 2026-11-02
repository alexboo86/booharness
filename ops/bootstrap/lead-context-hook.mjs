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
import { closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
const nextSkill = fileURLToPath(new URL('../../.agents/skills/next/SKILL.md', import.meta.url));
const relayTitle = 'Run the handover relay for leads';

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
}

function parsed(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function selfSessionCall(block) {
  return block?.type === 'tool_use' && block.name === 'mcp__ccd_session_mgmt__get_session' && block.input?.session_id === 'self';
}

function relaySessionResult(block, selfCalls) {
  if (block?.type !== 'tool_result' || !selfCalls.has(block.tool_use_id)) return null;
  const session = parsed(textContent(block.content));
  return session?.title === relayTitle && session.pinned === true;
}

/** The protocol refreshes self metadata immediately before relaying, so only the tail is relevant. */
function transcriptTail(file) {
  const size = statSync(file).size;
  const start = Math.max(0, size - 256 * 1024);
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

/** Only this session's own metadata counts: a lead can list another session's relay title and pin. */
function isHandoverRelay(transcript) {
  let lines;
  try { lines = transcriptTail(transcript); } catch { return false; }
  const selfCalls = new Set();
  let relay = false;
  for (const line of lines) {
    const content = parsed(line)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (selfSessionCall(block)) selfCalls.add(block.id);
      const result = relaySessionResult(block, selfCalls);
      if (result !== null) relay = result;
    }
  }
  return relay;
}

function reminderDue(previous, tokens, band, step) {
  if (!previous) return band !== null;
  if (previous.compacted) return tokens <= previous.tokens - step || tokens >= previous.tokens + step;
  return band === null || band > previous.band;
}

function reminderProgress(previous, tokens, band, limit, share) {
  const step = limit * share;
  if (!reminderDue(previous, tokens, band, step)) return null;
  const compacted = Boolean(previous?.compacted || (previous && band === null));
  const next = compacted ? tokens + step : limit + (band + 1) * step;
  return { band, tokens, compacted, next };
}

function handoverInstruction(family) {
  if (family === 'codex') {
    return `The operator's standing order #21159 is the explicit request authorizing mcp__codex_app.create_thread for this context-limit handover. `
      + `Finish the step in hand, then read and follow the next skill at ${nextSkill} and create the successor now, without asking again. `
      + 'The old thread does no task work after the successor exists; stop once its threadId returns. ';
  }
  return 'Finish the step in hand, then invoke /next yourself now, without asking the operator (decision #11903): the Skill tool with skill `next` '
    + '(codex: run /next, .agents/skills/next/SKILL.md). It commits, writes the handoff (memoryctl handoff) with the running seats for the successor, '
    + 'and opens a fresh session. ';
}

function reminderBasis(window, cap, windowShare) {
  return window ? `${windowShare * 100}% of the ${k(window)} window, capped at ${k(cap)}` : `the ${k(cap)} cap`;
}

/** The reminder for `context`, or null. Exported for the tests. */
export async function remind(input, env = process.env, now = Date.now()) {
  if (env.ORCH_SEAT_ID || env.SEAT_POLICY_ROLE) return null;
  const transcript = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (!transcript) return null;
  if (isHandoverRelay(transcript)) return null;
  const { readLeadContext, leadLimit, leadBand, isLead, LEAD_BAND_SHARE, LEAD_CAP, LEAD_WINDOW_SHARE } = await import('../orchestrator/src/leads.ts');
  const { loadConfig } = await import('../orchestrator/src/config.ts');
  const context = readLeadContext(transcript);
  if (!context || context.handedOver || !isLead(context)) return null;
  const limit = leadLimit(context.window);
  const band = leadBand(context.tokens, limit);
  const file = path.join(loadConfig(env).stateDir, 'lead-reminders.json');
  const state = loadState(file);
  const key = String(input.session_id || context.session);
  const progress = reminderProgress(state[key], context.tokens, band, limit, LEAD_BAND_SHARE);
  if (!progress) return null;
  state[key] = { ...progress, at: now };
  saveState(file, state, now);
  const basis = reminderBasis(context.window, LEAD_CAP, LEAD_WINDOW_SHARE);
  const position = band === null ? 'below' : 'past';
  const compaction = progress.compacted ? 'Compaction is not a handover; this session already crossed its handover limit. ' : '';
  return `[orch] This lead's context is ${k(context.tokens)} tokens, ${position} the ${k(limit)} handover limit (${basis}; decision #11903). `
    + compaction + handoverInstruction(context.family) + `Next reminder at ${k(progress.next)}.`;
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
