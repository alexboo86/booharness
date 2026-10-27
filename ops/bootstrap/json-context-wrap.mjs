#!/usr/bin/env node
// Wrap a plain-text context hook for hosts that only accept JSON stdout.
//
// ZCode's hook protocol (zcode.z.ai/en/docs/hooks) drops non-JSON stdout as
// diagnostics; Claude Code injects plain stdout as-is. Plain-text context
// producers like session-start.mjs go to ZCode through this wrapper:
//
//   node json-context-wrap.mjs -- <command> [args...]
//
// stdin (the host's one-line JSON event) is forwarded to the child; the
// child's stdout becomes {hookSpecificOutput:{hookEventName,additionalContext}}.
// Fail-open like everything else in this family: exit 0 always, empty stdout
// when there is nothing to inject.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TIMEOUT_MS = 30000;

function stdinText() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

try {
  const sep = process.argv.indexOf('--');
  const argv = sep >= 0 ? process.argv.slice(sep + 1) : process.argv.slice(2);
  if (argv.length === 0) throw new Error('no command given after --');

  const raw = stdinText();
  let event = 'SessionStart';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.hook_event_name === 'string') event = parsed.hook_event_name;
  } catch {
    /* no or malformed stdin: keep the default event name */
  }

  const child = spawnSync(argv[0], argv.slice(1), {
    input: raw,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
    shell: process.platform === 'win32',
  });

  const text = (child.stdout || '').trim();
  if (text.length > 0) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: text },
      })
    );
  }
} catch (error) {
  process.stderr.write(`json-context-wrap: ${String(error && error.message ? error.message : error)}\n`);
}
process.exit(0);
