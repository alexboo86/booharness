// Argument transport for memoryctl: what the caller passes is what the program gets.
//
// This file exists because two reviewers broke the previous shape from opposite
// sides on the same day: one showed every quote of a `--links` JSON value being
// eaten before the program ran, the other got a nested command to execute out of a
// value that only looked like a lesson title. Both came from routing argv through
// cmd.exe. A unit test on the quoting function could not have caught either - only
// spawning a real shim and comparing what came out the far end can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawnPlan } from './lesson-lib.mjs';

/** A stand-in for memoryctl: prints one argument per line, verbatim. */
const ECHO_SCRIPT = ['#!/usr/bin/env bash', 'for arg in "$@"; do', '  printf "%s\\n" "$arg"', 'done', ''].join(
  '\n',
);

/** The Git-for-Windows shim shape, byte for byte what `memoryctl.cmd` holds. */
const SHIM = ['@echo off', '"C:\\Program Files\\Git\\bin\\bash.exe" "%~dp0fake-memoryctl" %*', ''].join('\r\n');

function makeFakeBinary(dir, kind) {
  const script = path.join(dir, 'fake-memoryctl');
  fs.writeFileSync(script, ECHO_SCRIPT, { mode: 0o755 });
  if (process.platform !== 'win32' || kind === 'script') return script;
  const shim = `${script}.cmd`;
  fs.writeFileSync(shim, SHIM);
  return shim;
}

// Both spellings `resolveMemoryctl` can return on Windows: the extensionless bash
// script (preferred, and what `where` lists first here) and the `.cmd` shim.
// Neither may reach cmd.exe, and the script cannot be spawned directly at all -
// CreateProcess answers ENOENT for a file that is not a PE image.
for (const kind of ['script', 'shim']) {
  test(`arguments reach the program unchanged via the ${kind}, whatever they contain`, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svod-spawn-'));
  try {
    const bin = makeFakeBinary(tmp, kind);
    const args = [
      'append',
      '--title',
      'a title that is a whole sentence',
      // The shape `buildLessonLinks` produces on EVERY capture. Quote-heavy, and
      // therefore the exact value cmd.exe used to strip down to invalid JSON.
      '--links',
      JSON.stringify({ domain: 'domain-harness', anchor: 'svod/src/adapter/mod.rs', status: 'active' }),
      // Payloads that cmd.exe would have interpreted rather than delivered.
      '--body',
      'quote " ampersand & pipe | caret ^ redirect > paren ) percent %PATH% bang !x!',
      '--note',
      'trailing backslash \\',
      '--probe',
      '"&echo SVOD_QUOTE_INJECTION_PROBE&"',
    ];

    const plan = spawnPlan(bin, args);
    assert.equal(plan.shell, false, 'no shell may be involved in the plan');
    if (process.platform === 'win32') {
      assert.match(plan.file, /bash\.exe$/i, 'a non-image entry point must be routed to bash');
      assert.equal(plan.argv[0], bin.replace(/\.cmd$/i, ''));
      assert.deepEqual(plan.argv.slice(1), args);
    } else {
      assert.equal(plan.file, bin);
      assert.deepEqual(plan.argv, args);
    }

    const stdout = execFileSync(plan.file, plan.argv, { encoding: 'utf8', shell: plan.shell });
    const received = stdout.split('\n').slice(0, args.length);
    assert.deepEqual(received, args, 'every argument must arrive byte-identical');
    assert.doesNotMatch(
      stdout.slice(args.join('\n').length),
      /SVOD_QUOTE_INJECTION_PROBE/,
      'the payload may appear as a value, never as executed output',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  });
}

test('an entry point that is neither an image nor a script is refused, not shelled', { skip: process.platform !== 'win32' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svod-spawn-'));
  try {
    const orphan = path.join(tmp, 'orphan-memoryctl.cmd');
    fs.writeFileSync(orphan, SHIM);
    assert.throws(() => spawnPlan(orphan, ['append']), /Refusing to route/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
