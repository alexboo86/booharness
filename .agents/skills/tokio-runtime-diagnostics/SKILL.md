---
name: tokio-runtime-diagnostics
description: Finding out what a Tokio runtime is actually doing — leaked and stuck tasks, a blocked worker thread starving every other task, an unbounded channel growing until the process dies, and deadlocks that look like "it just stopped". Covers tokio-console, tracing instrumentation, runtime metrics and the JoinHandle discipline that makes any of it legible. Use this when a service stops making progress, memory grows without an obvious leak, latency spikes with no CPU load, a task "should have finished" or a shutdown hangs. Reach for it before adding logging to a hang — the runtime already knows the answer and logging usually does not.
---

# Tokio runtime diagnostics

An async service that stops making progress rarely tells you so. There is no
crash, CPU may be near zero, `/health` may answer, and the only symptom is that
something downstream is stale. This skill is about asking the runtime directly
instead of guessing.

For the *rules* that prevent these defects, use `rust-async-rules` (cancel
safety, bounded channels, locks across await) and `tokio-async-code-review` for
the review procedure. This one is about a system already running badly.

## Start by classifying the symptom

| Symptom | Most likely cause | First move |
|---|---|---|
| no progress, CPU ~0 | a task parked on something that never completes, or a deadlock | tokio-console: task with a long idle and no wakes |
| no progress, one core pinned | blocking work on a runtime worker | find the sync call inside async |
| memory grows steadily | unbounded channel, or tasks accumulating | count live tasks; check every channel's bound |
| latency spikes, no load | worker starvation by a long poll | look for the task with a large *poll time* |
| shutdown hangs | a task that ignores cancellation, or a handle never awaited | who holds the shutdown token, and who is not selecting on it |

## tokio-console

[`tokio-console`](https://github.com/tokio-rs/console) shows every task the
runtime knows about: state, poll count, total busy time, idle time, wakers, and
the location it was spawned from. It is the single highest-yield tool here and it
answers questions logging cannot.

Setup, briefly:

- build with `RUSTFLAGS="--cfg tokio_unstable"` and the `tracing` feature on
  `tokio`
- add `console-subscriber` and initialise it before the runtime starts
- it is a *diagnostic* build. Do not ship it enabled by default; do make it a
  documented, reproducible build so it can be reached during an incident rather
  than invented during one.

What to read:

- **Tasks that never complete** and have a low poll count are parked on something
  that will not fire. The spawn location tells you which.
- **Tasks with a large single poll time** are blocking the worker. Everything else
  on that worker is stalled for that duration.
- **A growing task count** with a stable workload is a leak: something spawns per
  message/connection and never finishes.
- **Wakers that fire with no progress** point at a busy-wait or a `select!` losing
  a branch's state.

## Naming tasks is what makes the tool usable

An unnamed task shows up as a spawn location and nothing else. Name them, and
attach the identity that matters here — venue and symbol:

```rust
tokio::task::Builder::new()
    .name(&format!("feed:{venue}:{symbol}"))
    .spawn(async move { /* ... */ })?;
```

With `tracing`, `#[instrument]` on the entry point of each long-lived task, with
the venue/symbol as fields, gives the same identity in logs and in spans. The
combination is what turns "one of 400 tasks is stuck" into "a backend operation is
stuck".

## The JoinHandle discipline

A dropped `JoinHandle` is a task whose panic nobody sees and whose completion
nobody waits for. Two consequences that show up as production mysteries: a
supervisor that thinks a feed is running when its task panicked at startup, and a
shutdown that "completes" while work is still in flight.

- keep handles in a `JoinSet` per supervisor, or store them
- on shutdown, await them with a timeout and **log which ones did not finish**
- a task that panicked must escalate; `JoinError::is_panic` is the check

## Blocking inside async

The most common cause of "latency spikes, no load". Anything that can block for
more than a few hundred microseconds belongs in `spawn_blocking` or on its own
thread: filesystem IO, synchronous database drivers, compression, big
serialisation, and — easy to miss — a `std::sync::Mutex` that is contended.

The diagnostic without tokio-console: enable the runtime's own metrics
(`RuntimeMetrics`, unstable) and watch `worker_park_count` versus busy time, or
simply look for a poll that takes milliseconds.

## Channels

- **Unbounded is a memory leak with extra steps.** The bound is the backpressure;
  without it the queue is the failure.
- A bounded channel whose producer never yields to the consumer is a deadlock.
  When both directions can block, one of them needs `try_send` plus an explicit
  drop policy — and the drop must be counted, because silently dropped market
  data is the same lie as a silently missing level.
- Measure depth. A channel with no depth metric is a queue you will discover the
  size of only when it is too late.

## Cancellation

- One shared cancellation token means one component can silently stop others.
  Measured in this codebase: a routine repair error cancelled a token shared by
  every raw-trade producer; the drivers exited "stopped cooperatively" with no
  respawn and `/health` stayed green. Scope tokens to the thing they own, and
  make it structurally impossible for the wrong code to reach the wrong token.
- A task that never selects on its token cannot be shut down; that is what a
  hanging shutdown usually is.

## When you cannot attach a console

Production without `tokio_unstable`:

- a periodic **liveness beat per task** written to a shared registry (task name,
  last progress timestamp) turns "something is stuck" into "this is stuck"
- **counters, not logs**: messages in, messages applied, gaps recorded, queue
  depth. A rate that goes to zero is more legible than any log line.
- `/health` must be derived from those counters. A health endpoint that returns
  ok while the feeds are dead is a health endpoint that has never been checked
  against a dead feed — which is exactly what happened here.

## Checklist for a hang

- [ ] classified the symptom (parked / blocked / leaking / starved)
- [ ] tasks are named and instrumented, or a liveness registry exists
- [ ] every `spawn` has an owned handle, and panics escalate
- [ ] no blocking call on a runtime worker
- [ ] every channel is bounded and its depth is observable
- [ ] cancellation tokens are scoped to what they own
- [ ] the health signal is derived from progress counters, not from process liveness

If the hang reproduces only under a particular ordering, stop guessing and pin it
with a seed: a deterministic-simulation harness (turmoil/loom-style) turns the
ordering into a reproducible run.
