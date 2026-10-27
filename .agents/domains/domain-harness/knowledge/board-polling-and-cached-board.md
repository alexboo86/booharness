## Board polling and the cached board

verified: 2026-10-17

The board `/`, chat and `/tasks` poll with `setTimeout` after the prior request ends, aborting after 20 s (`tick`, `pollChat`, `ops/orchestrator/src/dashboard.ts`; `refresh`, `pollNotice`, `ops/orchestrator/src/tasks-page.ts`). Each loop has at most one request; write-triggered refreshes wait for an active read.

`board()` (`ops/orchestrator/src/dashboard.ts`) serves its runtime's cached board and starts one background build when older than 3 s. Only the first request after start waits; a failure retains the last good board. Answers can be one poll interval plus one build old; status prints `board Ns old` above 15 s. A new runtime object has no cached board. Coverage: `scripts/test-orch-board-polling.mjs`.

Polled reads use bounded `store.listSeats` filters or `closedSeatPage` (`ops/orchestrator/src/store.ts`), not all stored seats. Consumers include the board, `cachedLeads`, tasks board (`ops/orchestrator/src/tasks-routes.ts`), `windowSeatSessions` (`ops/orchestrator/src/leads.ts`), `seats_list` and scout limits. Closed `seats_list` reads only its page. Unbounded reads remain on action/CLI history paths.

Store indexes (`ops/orchestrator/src/store.ts`):
- Schema 9: `seats_status_created`, `seats_status_updated`, expression `seats_scout_parent`; drops `seats_status`. Migration is idempotent over surviving indexes; older daemon code refuses schema 9.
- Schema 10: `turns_status_ended` on `(status, ended_at, id)` and `seats_role_title` on `(role, title)`. `doneUsage` walks newest done turns; reviewer `siblings` (`ops/orchestrator/src/seats-verify.ts`) uses `listSeats({role, title})`.
- Schema 11: `seats_request_id` on `json_extract(data, '$.requestId')`, matching `Store.seatByRequestId`; `taskSiblings` (`ops/orchestrator/src/seats-scope.ts`) uses the role/title bound at reviewer/debater creation.
- Schema 12: `seats_family_role` on `(family, role)`. `doneUsage` computes accounting role in SQL via `accountingRoleSql`, consistent with `accountingRole` (`ops/orchestrator/src/profiles.ts`), walking only family seats whose raw role can map to the requested role.

`checkoutTop` (`ops/orchestrator/src/worktrees.ts`) runs git asynchronously (`scripts/test-orch-store-hot-paths.mjs`).

`activeLeads` (`ops/orchestrator/src/leads.ts`) is async, yielding after synchronous stretches exceed 8 ms (`LOOP_BUDGET_MS`). `leadsReader(store)` (`ops/orchestrator/src/dashboard.ts`) shares a 10-second cached scan promise, dropping failures for retry. Board and tasks board each hold a reader per store. Coverage: `scripts/test-orch-lead-scan.mjs`.

`startLoopDelay` (`ops/orchestrator/src/loop-delay.ts`), started by `serve` (`ops/orchestrator/src/main.ts`), uses `monitorEventLoopDelay` and a 50 ms interval. Ticks later than 100 ms log `loop.stall` with delay, `label`, `span`, `last`; `/health` reports lifetime `loop {p50, p99, max, stalls, since}` in milliseconds. `span(name, fn)` retains the window's longest synchronous span; each tick/start resets it. Label names it when duration covers the delay or exceeds `STALL_MS`, otherwise `unattributed`; `last` is the last `mark()`. Spans cover HTTP/LAN synchronous prefixes (method/path without query), chat wake polls, provider stdout lines/exits and seat-chain starts, not later async continuations. MCP calls read `http POST /mcp`. Coverage: `scripts/test-orch-loop-delay.mjs`.
