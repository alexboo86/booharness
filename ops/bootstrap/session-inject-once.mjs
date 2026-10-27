#!/usr/bin/env node
// One-shot session delivery over UserPromptSubmit, for providers whose
// SessionStart stdout is ignored (Kimi - measured on the rolled-back gate,
// memory #253/#254). UserPromptSubmit fires on EVERY prompt, and the operator's
// rule is no per-turn noise - so the payload is injected exactly once per
// session attempt and every later prompt is SILENT.
//
// The per-turn reminder this hook used to emit after the first prompt was
// removed (2026-07-31 token audit): ~138 bytes re-persisted into the
// transcript on every turn, and the failure it cited is already covered by a
// hard deny in code-intel-order-hook.mjs, so the reminder was pure duplication.
//
// The once-marker is keyed by session_id.
//
// Output shape: {hookSpecificOutput:{additionalContext}} without hookEventName,
// which Kimi does not document and the measured gate omitted there. Fail-open:
// exit 0 always, quiet stderr, bounded payload (session-start.mjs caps itself).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sanitize = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '_');

try {
  let event = {};
  try {
    event = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    /* no stdin: treat as a fresh anonymous session */
  }
  const sessionId = sanitize(event.session_id ?? event.sessionId ?? 'no-session');

  const stateDir = join(tmpdir(), 'toolset-session-inject');
  mkdirSync(stateDir, { recursive: true });
  const mark = join(stateDir, sessionId);
  // Later prompt of an already-delivered session: not one byte of output.
  if (existsSync(mark)) process.exit(0);

  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawnSync(process.execPath, [join(here, 'session-start.mjs')], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  const text = ((child && child.stdout) || '').trim();

  // The marker is written only AFTER a clean run - written first (or on a
  // nonzero exit with empty stdout), a failed delivery muted the session
  // forever. And it is created atomically ('wx'): two hooks racing the same
  // prompt would both pass the existsSync check above and inject twice. A
  // lost race (EEXIST) means the other hook delivered, so stay silent; any
  // other write failure is fail-open toward delivery, as everywhere else in
  // this hook. A nonzero exit writes NO marker, so the next prompt retries.
  let duplicate = false;
  if (child && !child.error && child.status === 0) {
    try {
      writeFileSync(mark, String(Date.now()), { flag: 'wx' });
    } catch (error) {
      if (error && error.code === 'EEXIST') duplicate = true;
    }
  }
  if (text && !duplicate) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { additionalContext: text } }),
    );
  }
} catch {
  /* a delivery hook must never break a session */
}
process.exit(0);
