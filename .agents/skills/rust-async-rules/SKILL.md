---
name: rust-async-rules
description: "Rule-by-rule reference for async and concurrent Rust — cancellation safety, locks held across await, channel choice and backpressure, JoinHandle and structured concurrency, atomics ordering, and how to test any of it deterministically. Use this whenever you are reading, writing or reviewing Rust that spawns tasks, awaits, selects, sends on a channel, shares an Arc or takes a lock — including exchange feeds, WebSocket readers, schedulers, background writers and anything under a tokio runtime. Reach for it even when the task sounds like ordinary Rust: the defects this covers compile cleanly and only appear under concurrent load."
---

# Async Rust, one rule per file

Thirty rules for the class of defect that a type checker cannot see: code that
compiles, passes a single-threaded test, and then loses data under load. Each
rule is a separate file with a bad example, a good example and the reasoning.

## How to use this

Do not read all thirty. Read the two or three that match what is in front of
you — that is why they are separate files. The table below is the index; open a
rule when its symptom is on your screen, and cite the rule name in your finding
so the reader can check it against the same text you did.

If nothing in the table matches, this skill has nothing to say about that code.
Say so rather than stretching a rule to fit — a rule cited where it does not
apply costs more credibility than a finding you did not make.

The directory holds the upstream corpus in full — 265 rules covering all of Rust
style, not only async — so that a cross-reference inside a rule leads somewhere
real. The table below is the curated part and the reason this skill exists; the
rest is reachable through [rules/INDEX.md](rules/INDEX.md) when a question turns
out to be about Rust generally rather than about concurrency.

## Index

**A task is spawned, joined or blocked**

| What you are looking at | Rule |
|---|---|
| Runtime construction, `#[tokio::main]`, worker threads | [rules/async-tokio-runtime.md](rules/async-tokio-runtime.md) |
| CPU-bound or blocking work inside an async fn | [rules/async-spawn-blocking.md](rules/async-spawn-blocking.md) |
| `tokio::spawn` whose `JoinHandle` is dropped | [rules/async-joinset-structured.md](rules/async-joinset-structured.md) |
| Several independent awaits run one after another | [rules/async-join-parallel.md](rules/async-join-parallel.md) |
| Parallel awaits where one failure should abort the rest | [rules/async-try-join.md](rules/async-try-join.md) |

**Something can be cancelled**

| What you are looking at | Rule |
|---|---|
| `tokio::select!` over anything that holds partial state | [rules/async-cancel-safety.md](rules/async-cancel-safety.md) |
| Shutdown, timeouts, "stop everything" paths | [rules/async-cancellation-token.md](rules/async-cancellation-token.md) |
| `select!` used to race two futures | [rules/async-select-racing.md](rules/async-select-racing.md) |

**Data moves between tasks**

| What you are looking at | Rule |
|---|---|
| A channel created without a bound | [rules/async-bounded-channel.md](rules/async-bounded-channel.md) |
| Work queue, producer/consumer | [rules/async-mpsc-queue.md](rules/async-mpsc-queue.md) |
| Fan-out to many subscribers | [rules/async-broadcast-pubsub.md](rules/async-broadcast-pubsub.md) |
| One request, one reply | [rules/async-oneshot-response.md](rules/async-oneshot-response.md) |
| Subscribers that only need the LATEST value | [rules/async-watch-latest.md](rules/async-watch-latest.md) |

**A lock or a shared value crosses an await**

| What you are looking at | Rule |
|---|---|
| A guard alive across `.await` | [rules/async-no-lock-await.md](rules/async-no-lock-await.md) |
| The same defect stated as an anti-pattern | [rules/anti-lock-across-await.md](rules/anti-lock-across-await.md) |
| Cloning out of a guard before awaiting | [rules/async-clone-before-await.md](rules/async-clone-before-await.md) |
| `Mutex` chosen for interior mutability | [rules/own-mutex-interior.md](rules/own-mutex-interior.md) |
| `RwLock` where readers dominate | [rules/own-rwlock-readers.md](rules/own-rwlock-readers.md) |
| `Arc` for shared ownership across tasks | [rules/own-arc-shared.md](rules/own-arc-shared.md) |

**Threads and atomics, without a runtime**

| What you are looking at | Rule |
|---|---|
| `Ordering::` on any atomic operation | [rules/conc-atomic-ordering.md](rules/conc-atomic-ordering.md) |
| Borrowing stack data into threads | [rules/conc-scoped-threads.md](rules/conc-scoped-threads.md) |
| `thread_local!` state | [rules/conc-thread-local.md](rules/conc-thread-local.md) |
| Data-parallel loops over a collection | [rules/conc-rayon-par-iter.md](rules/conc-rayon-par-iter.md) |

**Signatures and traits**

| What you are looking at | Rule |
|---|---|
| `Send`/`Sync`/`'static` bounds on async fns | [rules/async-async-fn-bounds.md](rules/async-async-fn-bounds.md) |
| `async fn` in a trait | [rules/async-fn-in-trait.md](rules/async-fn-in-trait.md) |
| Filesystem access inside async code | [rules/async-tokio-fs.md](rules/async-tokio-fs.md) |

**Proving it**

| What you are looking at | Rule |
|---|---|
| Tests for async code | [rules/test-tokio-async.md](rules/test-tokio-async.md) |
| A race you cannot reproduce | [rules/test-loom-concurrency.md](rules/test-loom-concurrency.md) |
| An invariant that should hold for all inputs | [rules/test-proptest-properties.md](rules/test-proptest-properties.md) |
| Spans and instrumentation across await points | [rules/obs-instrument-spans.md](rules/obs-instrument-spans.md) |

## What this is not

This is a rule reference, not a review procedure. If your task is "review this
async Rust", run `tokio-async-code-review` for the procedure and reach here for
the specific rule behind a finding. The two are meant to be used together, and
neither replaces reading the code.
