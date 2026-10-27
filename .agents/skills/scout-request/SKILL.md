---
name: scout-request
description: "Delegate a repository sweep across 3+ files, logs, or memory to the read-only scout_request tool instead of spending the seat's own context on it."
---

# Scout request

When the answer needs a sweep across **3 or more files, logs, or memory entries**, call `scout_request` before reading through them yourself. Questions like “who calls X?” or “where is Y handled?” are good scout work when they require that sweep. If you already know the single file you need, read it directly; do not spend a scout call on it.

Ask **ONE English question** (at most 200 words) and say what the scout should report back. Pass `files` with repo-relative paths when you know them (at most 20). For example:

> `scout_request({question: "Across the seat context builder, skill router and their tests, where are role-default skills selected and checked? Report the relevant paths and the delivery boundary.", files: ["ops/orchestrator/src/context.ts", "ops/bootstrap/skill-router.mjs", "scripts/test-skill-router.mjs"]})`

Bad: “Read everything in the repository, fix the routing, and run all tests.” That is neither one bounded question nor read-only scout work.

Bad: “How should we add X, and will the rate limit be enough?” A scout collects facts and does not design or judge a plan. Ask for the facts the decision needs (where X would attach, the current request count, the documented limit) and decide yourself.

The scout returns a digest, not edits. Calls block until it reports; use **one at a time per seat**. Continue your own targeted reading, edits and checks after the digest.
