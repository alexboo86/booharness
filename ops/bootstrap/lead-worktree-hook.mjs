#!/usr/bin/env node
/**
 * Task 2126: advise the Enter/edit+commit/ExitWorktree keep/self-land cycle
 * without blocking EnterWorktree. Orch seats own their worktrees and
 * are distinguished by ORCH_SEAT_ID (SEAT_POLICY_ROLE also marks a seat).
 * Claude-only wiring lives in install-harness.mjs; no transcript is needed.
 */
import { readFileSync } from 'node:fs';

const ADVICE = [
  'EnterWorktree isolates this session: until `ExitWorktree {action: "keep"}` the desktop app refuses git outside this worktree, landing on master included.',
  'Enter only to edit and commit files of this worktree.',
  'Before any git outside it call `ExitWorktree {action: "keep"}` (the worktree and branch stay), then land yourself with `git -C <main checkout> merge --ff-only <sha>` and `git -C <main checkout> push origin master`.',
  'Do not ask the operator to run the fast-forward.',
].join(' ');

try {
  // Seat environments bypass the lead advice before any input is read.
  if (!process.env.ORCH_SEAT_ID && !process.env.SEAT_POLICY_ROLE) {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (input && typeof input === 'object' && !Array.isArray(input)
      && (input.tool_name ?? input.toolName) === 'EnterWorktree') {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: ADVICE,
        },
      })}\n`);
    }
  }
} catch {
  // Empty or malformed input is not an EnterWorktree event. Stay silent.
}
