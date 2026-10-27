---
id: ops-orchestrator-runtime
owner: domain-harness
paths:
  - ops/orchestrator/src/CONTRACT.md
  - ops/orchestrator/src/chat.ts
  - ops/orchestrator/src/config-health.ts
  - ops/orchestrator/src/context-modules.ts
  - ops/orchestrator/src/context.ts
  - ops/orchestrator/src/digest-text.ts
  - ops/orchestrator/src/grading.ts
  - ops/orchestrator/src/handoff-draft.ts
  - ops/orchestrator/src/lesson-stats.ts
  - ops/orchestrator/src/limits.ts
  - ops/orchestrator/src/machine-load.ts
  - ops/orchestrator/src/memory-proposals.ts
  - ops/orchestrator/src/paused-families.ts
  - ops/orchestrator/src/pi-extension.ts
  - ops/orchestrator/src/pick-stats.ts
  - ops/orchestrator/src/placement.ts
  - ops/orchestrator/src/profiles.ts
  - ops/orchestrator/src/prune.ts
  - ops/orchestrator/src/quota-rates.ts
  - ops/orchestrator/src/remote-worktree.ts
  - ops/orchestrator/src/report.ts
  - ops/orchestrator/src/review-plan.ts
  - ops/orchestrator/src/role-quality.ts
  - ops/orchestrator/src/role-stats.ts
  - ops/orchestrator/src/seats-close.ts
  - ops/orchestrator/src/seats-create.ts
  - ops/orchestrator/src/seats-defs.ts
  - ops/orchestrator/src/seats-digest.ts
  - ops/orchestrator/src/seats-drain.ts
  - ops/orchestrator/src/seats-prompt.ts
  - ops/orchestrator/src/seats-provision.ts
  - ops/orchestrator/src/seats-recover.ts
  - ops/orchestrator/src/seats-scope.ts
  - ops/orchestrator/src/seats-verify.ts
  - ops/orchestrator/src/seats.ts
  - ops/orchestrator/src/stand.ts
  - ops/orchestrator/src/store.ts
  - ops/orchestrator/src/sweep-shared.ts
  - ops/orchestrator/src/target-sweep.ts
  - ops/orchestrator/src/token-kick.ts
  - ops/orchestrator/src/watch.ts
entry: ops/orchestrator/src/store.ts
layer: harness
---
## Purpose

Implements the local orchestration daemon's seat lifecycle, durable state, chat, placement, context assembly and reporting. The control surface belongs to `ops-orchestrator-surface`, execution primitives to `ops-orchestrator-exec`, and provider adapters retain their own module.

## Public API
`store.ts` is the registry entry; remaining rows are existing production cross-module imports, not a single facade.

| Symbol | Description |
|---|---|
| `SCHEMA_VERSION` | Latest supported database migration version. |
| `Seat` | Persisted seat record with lifecycle data. |
| `NewSeat` | Seat insertion shape with optional initial location/data. |
| `provisioningStarted` | Identifies provisioning rows that block drain exit, excluding held setup. |
| `TurnStatus` | Queued/running and terminal turn status union. |
| `TERMINAL_TURN` | Terminal status membership set. |
| `Turn` | Persisted prompt/result/usage/watch record. |
| `ScopeFeatures` | Nullable Jev scope probabilities. |
| `BypassScope` | Recorded bypass score or explicit refusal reason. |
| `ShadowRank` | Legacy stored coder ranking evidence. |
| `ShadowPick` | Legacy stored coder recommendation. |
| `ReviewerShadowRank` | Legacy stored reviewer ranking evidence. |
| `ReviewerShadow` | Legacy stored reviewer recommendation. |
| `TurnWatchRecord` | Session continuity, scope and turn-watch evidence. |
| `TurnPending` | Persisted queued launch arguments. |
| `TurnEnd` | Completion fields accepted by the store. |
| `DoneUsage` | Completed-turn quota/raw-token accounting row. |
| `DoneUsageOptions` | Accounting role/time/limit filter. |
| `LessonDelivery` | Worker lesson delivery/application record. |
| `LeadLessonDelivery` | Lead lesson delivery/application record. |
| `DrainStatus` | Durable restart drain snapshot. |
| `drainWarning` | Lead-facing drain explanation. |
| `SeatQuery` | Index-bounded seat query variants. |
| `Store` | Durable seats, turns, events, grades, delivery and drain operations. |
| `transaction` | Immediate SQLite transaction with rollback on failure. |
| `migrate` | Atomic forward migration; refuses a newer database schema. |
| `openReadOnlyStore` | Read-only SQLite connection for metrics consumers. |
| `openStore` | Opens/configures/migrates the durable orchestration store. |
| `SeatManager` | `seats.ts` seat/turn lifecycle controller used by integrations. |
| `TurnLiveLog` | `seats.ts` bounded per-turn live log served to the board (task 2883). |
| `TurnLiveEntry` | One live-log entry: a merged text/thought run or one tool call. |
| `TURN_LOG_MAX_ENTRIES` | Live-log entry cap per turn; oldest dropped and counted as trimmed. |
| `TURN_LOG_MAX_BYTES` | Live-log content byte cap per turn. |
| `TURN_LOG_MAX_TURNS` | Retained live-log count cap across seats. |
| `chatPostDocsNote` | `chat.ts`: creates one bounded, non-waking git FYI to the owner without spawning Git; the loopback route belongs to `ops-orchestrator-surface`. |
| `ConfigHealth`, `startConfigHealth`, `checkConfigHealth` | `config-health.ts`: daemon-local strict config checks, confirmed rejection/recovery, boot-frozen project keys and restart guidance shared by status, seat answers and the board. |
| `loadConfig` | `config.ts` canonical daemon/host configuration reader. |
| `HOST` | Local host identity used by hooks and reporting. |
| `stateDirFor` | Resolves canonical orchestration state location. |
| `readHost` | Reads configured remote-host details for provider spawning. |
| `RemoteHost` | Remote host configuration type. |
| `RTK_DB_PATH` | RTK state database location used by provider environment. |
| `readLeadContext` | `leads.ts` lead context reader for bootstrap hooks. |
| `isLead` | Lead identity predicate for hooks. |
| `leadLimit` | Current lead budget boundary. |
| `leadBand` | Lead budget-band classification. |
| `LEAD_BAND_SHARE` | Lead band thresholds consumed by hooks. |
| `LEAD_CAP` | Lead quota cap consumed by hooks. |
| `LEAD_WINDOW_SHARE` | Lead rolling-window share consumed by hooks. |
| `readLanguageMode` | `language.ts` installed language-mode reader. |
| `writeLanguageMode` | Installed language-mode writer used by bootstrap. |
| `refuseStash` | `seat-guard.ts` stash refusal used by the shell hook. |
| `STASH_REFUSAL` | Shared stash refusal explanation. |
| `split` | Shell command splitting used by hooks and RTK mining. |
| `invocations` | Shell invocation extraction for deletion guards. |
| `SKILL_INSTALL_DENY` | Provider launch restriction on skill installation. |
| `peekabooVerdict` | `peekaboo.ts` GUI-operation safety decision. |
| `MIMO_PLAN_START_UTC` | `config.ts` billing-period reference used by usage snapshots. |
| `usageParts` | `pick-stats.ts` usage normalization for stand metrics. |
| `budgetReading` | `profiles.ts` quota evidence used by stand runs. |
| `roleMatrix` | `profiles.ts` effective role/family configuration. |
| `windowLength` | `profiles.ts` rolling-window length for stand accounting. |
| `windowMs` | Rolling-window duration conversion. |
| `MIN_LEFT` | Remaining-capacity threshold consumed by stand runs. |
| `standEnv` | `stand.ts` environment for stand smoke execution. |
| `TokenKick` | `token-kick.ts`: bounded vendor-CLI credential kicks for expired Claude/Grok/Kimi tokens; accepts synchronous or asynchronous expiry readers and persists per-family cooldowns. |
| `seatContext` | `context.ts` seat brief assembly used by probes. |
| `readReviewYieldByClass` | `pick-stats.ts` reporting query. |
| `toolKinds` | `toolkinds.ts` tool classification for RTK mining. |
| `shellPrograms` | Shell-program extraction for RTK mining. |
| `rtkVerdict` | `toolkinds.ts` rewrite-policy decision for mining. |
| `rtkHookRewrites` | Installed-hook rewrite evidence for mining. |
| `MCP_SERVERS` | `instruments.ts` provider MCP inventory. |
| `InstrumentKey` | Instrument-selection type consumed by adapters. |
| `PI_DIRECT_TOOLS` | Direct Pi tool mapping consumed by adapters. |
| `span` | `loop-delay.ts` timed diagnostic span used by provider transport. |
| `buildGateScript` | `build-gate.ts` host build-gate executable path. |
| `gateEnv` | Host build-gate environment for remote launchers. |
| `writeBuildShims` | Creates host-owned guarded build shims. |
| `landable` | `seats-defs.ts` role policy consumed by native provider checks. |
| `remotePiMcpPath` | `remote-pi-mcp.ts` provisioned Pi MCP configuration path. |
| `SCOUT_TOOL` | `scout-tool.ts` managed scout tool identity. |
| `SEAT_MCP_PATH` | Seat tool HTTP endpoint path. |
| `SEAT_MCP_SERVER` | Managed seat MCP server identity. |
| `codexEditActive` | `codex-edit.ts` verified editor activation predicate. |

Process-output helpers, configuration, lead readers, language, guards, instruments, diagnostic spans, build shims, role policy and host MCP/editor helpers now belong to `ops-orchestrator-shared`; their rows above describe the relocated APIs, not runtime ownership. `seats-defs.ts` retains compatibility re-exports of role policy for existing daemon consumers.

Consumers include bootstrap hooks, provider adapters, remote-exec, stand runners
and reporting/check scripts. `pi-extension.ts` also has an SDK-loaded default extension.

## Inputs
- Seat/turn requests, role/host configuration, repository snapshots and provider results/events.
- SQLite state, memory-service records, lead context, credential/quota evidence and requests from the surface module.

## Outputs
- Durable seat/turn/event/grade/delivery records, task-board/chat state, reports and lifecycle responses.
- Context briefs, lifecycle decisions and provider launches; execution primitives manage worktrees and the surface renders HTTP/MCP/dashboard responses.
- These control-plane messages are not the product market-data formats in `docs/contracts/wire/`.

## Internals

- `idleCloseCandidate` in `prune.ts` supplies idle-close age and kind to the seat lifecycle; it does not change `idleDays`' terminal-turn semantics.
- `HIGH_LOAD` in `limits.ts` is the high-load threshold consumed by stand runs; the registry entry does not re-export it.

## Invariants
- Host admission keeps instrument availability boolean and fail-closed; per-tool checks distinguish `ok`, `absent`, and `timed out` with the raw error. Checks run in parallel with 4-second deadlines inside the 10-second load probe. Creation retries once only when unavailable required checks all timed out, never an absent or unknown verdict; refusals include each cause.
- Image capabilities and catalog exceptions come from the ops-orchestrator-model-input (`docs/contracts/modules/ops-orchestrator-model-input.md` not in this kit) module's data-only entry, `model-input.ts`.
- Credential kicks leave refreshes and credential writes to vendor CLIs; Claude uses non-inference `doctor` with auto-updates disabled, closed stdin, a hard SIGKILL deadline and a persisted 30-minute cooldown. Missing/unreadable credentials never authorize a kick. Source: `token-kick.ts`; `scripts/test-orch-usage.mjs` (not in this kit).
- Writable connections use busy timeout before WAL, `synchronous=FULL` and foreign keys; committed state is durable. Source: `store.ts` (`openStore`).
- Migrations run atomically and refuse a schema newer than this daemon; failed immediate transactions roll back. Source: `store.ts` (`transaction`, `migrate`); `scripts/test-orch-core.mjs` (not in this kit).
- Event history is append-only, enforced by UPDATE/DELETE abort triggers. Source: `store.ts` (migration SQL); `scripts/test-orch-core.mjs` (not in this kit).
- Seats created during a drain hold new provisioning (except scout/critic); held rows survive restart and resume setup before queued turns, or resume on drain cancel. Closing a held row creates no checkout. Started provisioning still blocks drain exit.
- Restart interrupts running turns but preserves queued work; the drain flag is committed state. Source: `store.ts` (`interruptOrphans`, `setDrain`); `scripts/test-orch-drain.mjs` (not in this kit).
- Idle close ages failed seats and ready seats with no turns from `created_at`, using `idleFloorDays(role)`. Never-prompted landable seats still require landed proof at every age; the two-day unlanded rule applies only to terminal-turn idleness. Closing/scope fences, fresh checks and normal close cleanup remain in force. Source: `prune.ts`, `seats-close.ts`; `scripts/test-orch-idle-close.mjs` (not in this kit).
- Hot-path seat reads use bounded queries/pages rather than parsing all closed history. Source: `store.ts` (`SeatQuery`, `pruneCandidatesPage`); `scripts/test-orch-store-hot-paths.mjs` (not in this kit).
- Sweep leases and daily stamps supplied by `sweep-shared.ts` serialize daemon and manual CLI passes; scoped host passes never publish the all-host daily stamp, and dry-run leaves gate state untouched. Sweep scheduling and candidate safety belong to `ops-orchestrator-surface`.
- Checkout-owning roles (coder, tester, designer, copywriter, reviewer, legal, security and bughunter) are told to remove comparison worktrees before reporting; read-only roles receive no such instruction. Source: `context.ts`; `scripts/test-orch-context-wait.mjs` (not in this kit).
- Lesson application is recorded only for lessons actually delivered in full; full lead delivery cannot be downgraded by indexed delivery. Source: `store.ts` (delivery methods); `scripts/test-orch-core.mjs` (not in this kit).

## Dependencies

- `ops-orchestrator-exec` — worktree/process execution, remote repository operations, locks, logging and check verification.
- `ops-orchestrator-shared` — configuration, guards, instruments and shared launch policy.
- `ops-orchestrator-model-input` — data-only image capabilities and catalog exceptions.
- `ops-orchestrator-providers` — session types, routing and managed process launch.
- `ops-orchestrator` — suite receipt, code fingerprint and build-gate tooling.
- `ops-bootstrap-routing` — knowledge pages, lesson and skill routing, Jev client, gate and ledger.
- `scripts-lib-harness` — canonical config, paths and shared harness readers.
- `scripts-memory-core` — memory client and delivery/proposal tooling.
- `scripts-runtime-shared` — shared runtime helpers.
- `ops-tools` — usage snapshot/cache readers.
- External: Node.js built-ins including `node:sqlite`, Git, SSH and managed provider CLIs.

## Tests

- `scripts/test-orch-core.mjs` (not in this kit) — schema/store and core daemon behavior.
- `scripts/test-orch-store-hot-paths.mjs` (not in this kit) — bounded store reads and query behavior.
- `scripts/test-orch-drain.mjs` (not in this kit) — restart drain and queued-turn preservation.
- `scripts/test-orch-chat.mjs` (not in this kit) — chat state and delivery boundary.
- `scripts/test-orch-provisioning-close.mjs` (not in this kit) — provisioning/close lifecycle.
- `scripts/test-orch-turn-live.mjs` (not in this kit) — bounded live turn log, its loopback route and LAN refusal.
- Narrow store command: `node scripts/test-orch-store-hot-paths.mjs` (`scripts/test-orch-store-hot-paths.mjs` not in this kit).

## Owner

`domain-harness`; surface, execution primitives, providers and parent support tooling retain separate module contracts.

## Changelog

- Task 2409 slice C: document existing store entry and production integration seams; no daemon behavior change.
- Task 3141 slice A: retain 40 runtime source files and this contract; split surface and execution ownership without moving files or changing code.
