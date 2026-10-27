---
name: flaky-test-reproduction
description: Turn a flaky test into a deterministic reproduction before any fix. Use when a test passes and fails without a code change, fails sometimes or only under load — especially Rust async and concurrency tests.
---

# Flaky-test reproduction

A fix without a captured reproduction is a guess; both outcomes are evidence
(2605.21677).

## Steps

1. Capture both outcomes on the same commit: the full passing and failing runs
   — command, exit code, seed and order, log tail.
2. Record the environment: toolchain, OS, CPU load, sanitizer and thread
   settings, timeouts, parallelism — anything timing-dependent.
3. Write a failure script: a bounded loop or stress invocation that reproduces
   the failure on demand. Bound the iterations, bound the runtime, keep the
   output.
4. In Rust, suspect async waits and concurrency first: among inspected flakes
   the leading causes were asynchronous waits and concurrency — missing
   timeouts, races on shared state, unordered completion (2502.02760).
5. Fix only after the script reproduces on demand; prove the fix by replaying
   the script repeatedly and keeping the logs.

## Verification

The failure script failing before the fix and passing after, with iteration
counts and captured logs from both runs.

## Failure modes

- Declaring "cannot reproduce" without a bounded stress loop.
- Fixing the symptom — a sleep, a retry, a longer timeout — while the race
  remains.
- Discarding the passing run; it narrows the interleaving space.
