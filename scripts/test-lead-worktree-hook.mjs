#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('../ops/bootstrap/lead-worktree-hook.mjs', import.meta.url));
const leadEnv = { ...process.env };
delete leadEnv.ORCH_SEAT_ID;
delete leadEnv.SEAT_POLICY_ROLE;

function invoke(tool, env = leadEnv, stdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} })) {
  const result = spawnSync(process.execPath, [hook], {
    input: stdin,
    encoding: 'utf8',
    env,
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('a lead EnterWorktree event receives cycle advice without a permission decision', () => {
  // No transcript required: even an early tool call receives the cycle advice.
  const output = JSON.parse(invoke('EnterWorktree')).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal('permissionDecision' in output, false);
  assert.equal('permissionDecisionReason' in output, false);
  const advice = output.additionalContext;
  assert.match(advice, /EnterWorktree isolates this session/);
  assert.match(advice, /until `ExitWorktree \{action: "keep"\}`.*refuses git outside this worktree.*landing on master/);
  assert.match(advice, /Enter only to edit and commit files of this worktree/);
  assert.match(advice, /Before any git outside it.*ExitWorktree \{action: "keep"\}/);
  assert.match(advice, /worktree and branch stay/);
  assert.match(advice, /then land yourself with `git -C <main checkout> merge --ff-only <sha>`/);
  assert.match(advice, /git -C <main checkout> push origin master/);
  assert.match(advice, /Do not ask the operator to run the fast-forward/);
  assert.doesNotMatch(advice, /\/next|not proven/i);
});

for (const tool of ['Bash', 'Read', 'ExitWorktree']) {
  test(`another tool (${tool}) passes silently`, () => {
    assert.equal(invoke(tool), '');
  });
}

for (const [key, value] of [['ORCH_SEAT_ID', 'probe-seat'], ['SEAT_POLICY_ROLE', 'coder']]) {
  test(`an EnterWorktree event from a seat (${key}) passes silently`, () => {
    assert.equal(invoke('EnterWorktree', { ...leadEnv, [key]: value }), '');
  });
}

for (const stdin of ['', '{', 'null', '[]', '"EnterWorktree"']) {
  test(`malformed or non-event stdin (${JSON.stringify(stdin)}) passes silently`, () => {
    assert.equal(invoke('EnterWorktree', leadEnv, stdin), '');
  });
}
