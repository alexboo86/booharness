---
name: verify-change
description: Verify every meaningful code batch using the adopted project's own checks before declaring it done or requesting commit approval.
---

# Verify a code change

Treat real command output as evidence, never a remembered baseline or a substitute unrelated suite.

## 0. Capture the baseline

Record `git branch --show-current`, `git rev-parse HEAD` and `git status --porcelain` before the first edit. Inspect the target repository's manifests, task runners, CI and contributor instructions to identify its actual check commands. Run those checks and retain their exit codes and error counts. Do not infer a language, framework, package manager or build layout from this harness.

If editing already started, disclose that the baseline is missing; establish it from an isolated checkout of the recorded base before claiming no regression.

## 1. Inventory the exact change

Retain worktree and staged views: `git diff --stat`, `git diff --cached --stat`, `git diff --name-only`, `git diff --cached --name-only` and `git status --porcelain`. Include renamed, deleted and untracked files. For landed work, inspect the full pre-merge-to-current range rather than an empty worktree.

## 2. Run project-native checks

Run the commands established from this project's configuration, with the same inputs as the baseline. A Python project may use its own unit-test runner; a documentation-only repository may have a link checker. Neither implies that a compiler or Node package exists. If no check is defined, identify a runnable reproduction or report the behavior as unverified rather than inventing a successful check.

Compare exit codes and error counts with the baseline. Every new error fails verification, including after a conflict resolution or landing.

## 3. Exercise the changed public seam

Find existing tests near changed code and tests importing the public entrypoint. Select the project's own runner and consolidate the relevant tests. A meaningful test must fail when the intended behavior is removed. Show search output and an explicit gap when no suitable test exists; do not claim an unrelated suite proves it.

## 4. Check structural and generated inputs

Run the target project's ownership, boundary, hook or routing checks when their inputs change and those checks exist. Inspect generated interfaces using that project's documented generator. Do not assume a particular source directory, crate layout, UI framework or generated filename.

## 5. Account for every dirty file

Finish with `git status --porcelain`; explain each path's owner, reason and disposition. Identify generated files as already committed, included in the explicit proposed pathspec, or awaiting a separate decision. An unexplained dirty file fails verification.

## Report

State the baseline revision, changed paths, exact commands, exit codes, output tails, error deltas, targeted tests, generated-file disposition and anything not checked. The last execution determines each command's status. Preserve failures in the report. Verification does not grant permission to commit, publish or incur paid calls; obtain the required operator consent.
