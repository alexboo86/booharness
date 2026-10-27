#!/usr/bin/env node
// Decision curator: before the lead's context is compacted, find what the
// operator DECIDED in this session that memory does not hold, and hand it back
// to the lead right after compaction as a proposal. It never writes memory:
// auto-self-learn is forbidden by the contract, so the lead confirms and writes.
//
// Why (2026-09-11, session-log analysis of the 15 worst memory failures over
// 147 lead sessions): in 5 of them the operator's rule reached memory only AFTER
// he had to repeat it - "watch-tui always" (#3789, 3 min after the complaint),
// "the MCP 401 is a client token" (#3698, 3 min), "kimi at effort low" (#5361,
// 1 min), "no merging into master" (#5951, six days later) - and one was lost
// across an overnight compaction. The contract line "write the decision in the
// same turn" is prose; this is the mechanism behind it.
//
//   node decision-curator.mjs precompact   # PreCompact hook: detach, never block
//   node decision-curator.mjs extract <session> <transcript>   # the detached work
//   node decision-curator.mjs deliver      # SessionStart(compact) hook
//
// The extraction is a scout run (.claude/scripts/scout.sh, grok by default) on
// another vendor's quota: it reads the operator's messages, checks each decision
// against memoryctl, and reports only the ones memory does not hold.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnPlan } from '../../scripts/memory/lesson-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const stateDir = process.env.DECISION_CURATOR_STATE || join(tmpdir(), 'decision-curator');
const scout = process.env.DECISION_CURATOR_SCOUT || join(repo, '.claude', 'scripts', 'scout.sh');
const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 700;
const DELIVER_WAIT_MS = Number(process.env.DECISION_CURATOR_WAIT_MS ?? 25_000);
const PENDING_STALE_MS = 10 * 60 * 1000;
const RESULT_STALE_MS = 6 * 60 * 60 * 1000;

const safeId = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
const paths = (session) => ({
  pending: join(stateDir, `${session}.pending`),
  result: join(stateDir, `${session}.md`),
  state: join(stateDir, `${session}.state.json`),
});

function readEvent() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/// The operator's own messages from a Claude Code transcript, newest last:
/// user turns that are text, not tool results, not harness reminders or
/// slash-command wrappers. Only messages after `sinceTs` (the last curated one).
export function operatorMessages(transcriptText, sinceTs = '') {
  const out = [];
  for (const line of String(transcriptText).split('\n')) {
    if (!line.includes('"user"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== 'user' || event.isMeta) continue;
    const content = event.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      if (content.some((block) => block?.type === 'tool_result')) continue;
      text = content.filter((block) => block?.type === 'text').map((block) => block.text).join(' ');
    }
    text = text.trim();
    if (!text || text.startsWith('<') || text.includes('<system-reminder>')) continue;
    const ts = String(event.timestamp ?? '');
    if (sinceTs && ts && ts <= sinceTs) continue;
    out.push({ ts, text: text.replace(/\s+/g, ' ').slice(0, MAX_MESSAGE_CHARS) });
  }
  return out.slice(-MAX_MESSAGES);
}

export function curatorBrief(messages) {
  return [
    'TASK - decision curator. Below are the operator\'s messages from one lead session (oldest first), taken',
    'just before the lead\'s context is compacted. Extract every DECISION, RULE or STANDING INSTRUCTION the',
    'operator gave: a choice between options, an "always/never", a setting (model, effort, branch, server,',
    'roster), an approval or refusal of a design. Skip one-off requests, questions and status talk.',
    'For each, check memory: memoryctl search \'<russian phrase + english tokens>\' --limit 5, and memoryctl get <id>',
    'for a candidate. It is HELD only if a live entry states the same thing. Report ONLY the ones not held,',
    'one line each, in Russian:',
    '- <the decision in one sentence> | quote: "<operator words, at most 20>" | <timestamp> | replaces: #<id> or none',
    'If there are none, or every one is held, the report is exactly: NONE',
    '',
    'Operator messages:',
    ...messages.map((message) => `[${message.ts}] ${message.text}`),
  ].join('\n');
}

function precompact() {
  const event = readEvent();
  const session = safeId(event.session_id ?? event.sessionId);
  const transcript = String(event.transcript_path ?? event.transcriptPath ?? '');
  if (!session || !transcript || !existsSync(transcript)) return;
  // The pending mark is written HERE, before detaching: the compaction can end
  // before the detached process gets to run, and a deliver that finds no mark
  // would give up at once and the proposals would never reach the lead.
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(paths(session).pending, String(Date.now()));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'extract', session, transcript], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

function extract(session, transcript) {
  const p = paths(session);
  mkdirSync(stateDir, { recursive: true });
  let since = '';
  try {
    since = JSON.parse(readFileSync(p.state, 'utf8')).last_ts ?? '';
  } catch {
    since = '';
  }
  try {
    const messages = operatorMessages(readFileSync(transcript, 'utf8'), since);
    if (!messages.length) return;
    const briefFile = join(stateDir, `${session}.brief.txt`);
    writeFileSync(briefFile, curatorBrief(messages));
    // terra, not the scout's default: this brief carries transcript text, and
    // codex runs the scout in a scratch cwd with the repository read-only - the
    // grok path holds read-only by the prompt alone (review r1, all four seats).
    // Same WSL trap as session-start: `bash` by name is System32's WSL stub on
    // Windows, and the curator dies before the scout ever runs.
    const plan = process.platform === 'win32'
      ? spawnPlan(scout, ['--via', 'terra', '--brief-file', briefFile])
      : { file: 'bash', argv: [scout, '--via', 'terra', '--brief-file', briefFile] };
    // scout.sh refuses everyone but named automation (decision #12069).
    const run = spawnSync(plan.file, plan.argv, {
      encoding: 'utf8', timeout: 8 * 60 * 1000, env: { ...process.env, SCOUT_INTERNAL: 'decision-curator' },
    });
    const report = String(run.stdout ?? '').trim();
    // Advance the cursor only on an answer: a failed scout run leaves these
    // messages for the next compaction instead of dropping them.
    if (run.status !== 0 || !report) return;
    writeFileSync(p.state, JSON.stringify({ last_ts: messages[messages.length - 1].ts }));
    // APPEND, never overwrite: a proposal that missed its delivery window is
    // still undelivered when the next compaction extracts again, and its
    // messages are already behind the cursor (review r1, codex: A was lost to B).
    if (!/^NONE\.?$/i.test(report)) appendFileSync(p.result, `${report}\n`);
  } finally {
    rmSync(p.pending, { force: true });
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function deliver() {
  const event = readEvent();
  const session = safeId(event.session_id ?? event.sessionId);
  if (!session) return;
  const p = paths(session);
  // The extraction runs while the compaction does; wait for it a bounded time.
  const deadline = Date.now() + DELIVER_WAIT_MS;
  while (!existsSync(p.result) && existsSync(p.pending) && Date.now() < deadline) {
    // The extraction removes the mark when it ends; a mark that vanished
    // between the two calls is a finished run, not an error (review r2, glm).
    const age = (() => {
      try {
        return Date.now() - statSync(p.pending).mtimeMs;
      } catch {
        return null;
      }
    })();
    if (age === null) continue;
    if (age > PENDING_STALE_MS) break;
    sleep(500);
  }
  if (!existsSync(p.result)) return;
  if (Date.now() - statSync(p.result).mtimeMs > RESULT_STALE_MS) return;
  const report = readFileSync(p.result, 'utf8').trim();
  renameSync(p.result, `${p.result}.delivered-${Date.now()}`);
  process.stdout.write([
    '# Operator decisions from before the compaction that memory does not hold',
    '(decision curator, a grok scout; NOTHING was written. Check each against the operator\'s words,',
    'then record the ones that stand: memoryctl append --kind decision --title ... [--overturns <id>])',
    '',
    report,
    '',
  ].join('\n'));
}

// Resolved paths, not spellings: on macOS /tmp and /var are symlinks, and a
// URL-vs-argv comparison exits silently having done nothing (lesson on
// session-start.mjs, 2026-08-20).
let isMain = false;
try {
  isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
} catch {
  isMain = false;
}
if (isMain) {
  const mode = process.argv[2];
  try {
    if (mode === 'precompact') precompact();
    else if (mode === 'extract') extract(safeId(process.argv[3]), process.argv[4]);
    else if (mode === 'deliver') deliver();
  } catch {
    // A curator failure must never break compaction or the session.
  }
  process.exit(0);
}
