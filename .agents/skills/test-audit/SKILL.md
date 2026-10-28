---
name: test-audit
description: "Invoke whenever writing, changing, running or reviewing tests. Decides whether a test is written at all, how small it is, which tests run and how often, and which tests are deleted. Default: no new test and no extra run."
---

# Test Audit

A test is paid for on every commit, review and orch restart for as long as it
lives: CPU, wall time and reading. It pays back only when it catches a
regression that no cheaper check catches. The default answer is **no new test
and no extra run** (operator 2026-10-28).

## 1. Write a test only when all three hold

1. It protects observable behaviour where a mistake loses or corrupts data or
   money, opens a security hole, or breaks a user path — or it reproduces a
   reported defect (Test 0).
2. A credible change breaks it, and typecheck, lint, an existing test or a
   commit gate does not already catch that change.
3. It runs at the real boundary; no production seam (export, flag, wrapper,
   hook) exists only for it.

Never write a test for: wiring, a gate's or a runner's file list, docs, skill,
contract or knowledge prose, config tables, a rename or move, log or report
wording, instruction text, or a fix that typecheck already covers.

An acceptance criterion with no runnable check gets `check: null` and one
reason. Name an existing check that fails without the change before you write
a new one.

A defect regression test fails on the pre-fix code for its own assertion — not
on a typo, import or fixture error (operator #19762) — and passes after the
fix. One such test at the owner boundary covers the defect; do not replay it at
every layer.

## 2. Keep it small

- Add a case to an existing table or test before you add a test; a new test
  file needs one sentence on why no existing file fits.
- No fixture git repository, child process, sleep or real timer unless the
  contract itself is git, process or timing behaviour.
- One test file per change is the norm; more needs a reason in the report.

## 3. Junk: reject when new, delete when touched

- no assertion, or an assertion the code under test computes for itself;
- source, import or string greps; copied inventories, manifests, schemas or
  export lists;
- private predicate or call-shape tests of something a boundary test owns;
- a second test of a contract another test owns;
- a mock or fixture that implements the behaviour, receipt or ordering it
  asserts;
- a negative control that passes for an unrelated reason;
- a test that exists only to keep a test-only export, global or wrapper alive.

## 4. Running tests

- Run only the test files that cover the changed code, once, after the last
  edit. Run again only after a code change, with one exception: a check that
  fails on the branch runs once on master to tell pre-existing from ours
  (CLAUDE.md work contract 2).
- Never a whole suite for a scoped change. A whole suite runs only when the
  lead asks for it (orch restart proof) and on the registered Linux host, not
  on this Mac.
- On this Mac at most 2 workers: `node --test --test-concurrency=2`,
  `npx vitest run --maxWorkers=2 <file>`.
- A reviewer does not repeat the coder's runs: it reads the reported tails and
  runs a test only to prove its own finding.
- No retries to turn a flaky test green: a flaky test is a finding.

## 5. Deleting tests

Delete, do not repair: a test that matches §3, a duplicate, a test whose target
is gone, a test that pins wiring, wording or a file list. Removing a tracked
file still needs what CLAUDE.md work contract 6 asks: a search of the whole
tree for references, `npm run check:deletions` and `cargo check`.

Keep: the curated money/data set (it changes only by operator decision), a
regression test of a real defect, and a security or data-integrity contract.

## 6. Changing an existing assertion

Only when the behaviour changed on purpose and the commit names that change
(operator #14245).

Adapted from openclaw/openclaw .agents/skills/test-audit/SKILL.md at 80930af4 (MIT, Copyright (c) 2026 OpenClaw Foundation), 2026-09-28; rewritten for operator decision #20673, 2026-10-28.
