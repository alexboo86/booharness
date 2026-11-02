---
id: ops-orchestrator-runtime
owner: domain-harness
paths:
  - ops/orchestrator/src/CONTRACT.md
  - ops/orchestrator/src/agent-listener.ts
  - ops/orchestrator/src/agent-pairing.ts
  - ops/orchestrator/src/chat.ts
  - ops/orchestrator/src/config-health.ts
  - ops/orchestrator/src/context-modules.ts
  - ops/orchestrator/src/context.ts
  - ops/orchestrator/src/digest-text.ts
  - ops/orchestrator/src/grading.ts
  - ops/orchestrator/src/handoff-draft.ts
  - ops/orchestrator/src/land-domain.ts
  - ops/orchestrator/src/lesson-stats.ts
  - ops/orchestrator/src/limits.ts
  - ops/orchestrator/src/limits-reauth.ts
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
  - ops/orchestrator/src/seat-transcripts.ts
  - ops/orchestrator/src/secrets-veil-mask.d.mts
  - ops/orchestrator/src/secrets-veil-mask.mjs
  - ops/orchestrator/src/stand.ts
  - ops/orchestrator/src/store.ts
  - ops/orchestrator/src/sweep-shared.ts
  - ops/orchestrator/src/target-sweep.ts
  - ops/orchestrator/src/token-kick.ts
  - ops/orchestrator/src/watch.ts
entry: ops/orchestrator/src/store.ts
sideEffectEntries:
  - ops/orchestrator/src/prune.ts
  - ops/orchestrator/src/target-sweep.ts
layer: harness
---
## Purpose

Implements the local orchestration daemon's seat lifecycle, durable state, chat, placement, context assembly and reporting. The control surface (`http.ts` and its supervised-lead routes in `http-leads.ts`) belongs to `ops-orchestrator-surface`, execution primitives to `ops-orchestrator-exec`, and provider adapters retain their own module.

## Public API
`store.ts` is the registry entry; remaining rows are existing production cross-module imports, not a single facade.

`pickFamily` and `rankFamilies` accept an optional final install state directory, defaulting to the configured one; `coderCap` accepts it after the family. The placement functions accept it in their input. Creation supplies the manager's state directory, so overrides are read at the decision site rather than captured on import.

`CreateSeat.writeScope?: { globs: string[]; reason: string }` grants extra paths only to restricted specialist roles. Creation validates and stores the addition as `SeatData.writeScope`; stored and in-flight request_id retries must match it. `writeScopeOf(role, extra?)` returns the role-plus-addition union for session launch and landing. `pathInWriteScope` remains a compatibility re-export of the shared path matcher.

Review-class, critic and debater creates persist data.independenceWarning when their corresponding operator independence setting is none; the surface includes it in the create answer, and replacement-reviewer recheck notes carry it to the coder digest. Pairing levels govern author/coauthor and debater separation, not reviewer caps or earlier-reviewer independence. Review/critic lead-family exclusions apply at `different-family` and, without a named author, at `different-model`, retaining the existing Claude exceptions; a single-provider install can review by naming the author and using a different model. Model separation compares named authors' resolved models, never a guessed lead model. logic.recheckMode defaults to the existing automatic correction-path route; explicit same/new selects that route while stale-checkout protection remains enforced: remote sync failure records a deferred new route even in same mode. If a forced-new replacement cannot be created, the digest records the failure rather than silently reusing the old reviewer; auto retains its existing fallback.

| Symbol | Description |
|---|---|
| `SCHEMA_VERSION` | Latest supported database migration version. |
| `Seat` | Persisted seat record with lifecycle data. |
| `readSeatTranscript`, `SeatTranscript`, `SeatTranscriptEntry`, `SeatTranscriptOptions` | Re-exported through `store.ts` from `seat-transcripts.ts`: asynchronous read-only disk history for local Pi, native Claude/GLM and native Codex seats, and the same pages for a seat on a host, streamed from that host over the managed transport (spawnProvider/remote-exec; the session path rides the shell-free JSON header, never remote shell text) under a 120 s deadline, with at most two remote reads in flight per seat. The host's reader streams only a regular file contained under its transcript roots (~/.pi/agent/sessions, ~/.claude/projects, ~/.codex/sessions): a lexical and realpath containment check runs before any read, a win32 host accepts only drive paths, and refusals never answer an empty page. No live session required. Returns available:false with a reason (host_unreachable, host_busy, no_session, missing_file, unreadable_file, invalid_options, unsafe_path), or available:true with the entries page, the skipped-line count, nextSince and hasMore. |
| `NewSeat` | Seat insertion shape with optional initial location/data. |
| `AgentListener` | `agent-listener.ts`: the host-agent LAN TLS listener (PROTOCOL.md v1 orch side) — raw-TLS prelude under quarantine limits (10 s deadline, 64 KiB pre-auth bytes, per-IP connection bound), QR/typed pairing confirmation, credential auth (one live session per agent, second gets busy), `/v1/control` commands, exec offers streamed through the slice-1 helpers, revoke (credential delete + immediate disconnect, even before switch), a windowById accessor for the hosts routes and rotateCert (new leaf signed by the active key, activated only after every connected agent acknowledged; GOAWAY drains live execs without an implicit kill deadline). `stop({ deadline? })` stops admissions/offers and returns `Promise<void>` after accepted work drains; an optional finite Unix-millisecond operator deadline interrupts remaining connections. Repeated stop calls share the first request. Own state file via `agentLinkStatePath(stateDir)`; secrets never logged. |
| `AgentListenerOptions`, `PreAuthLimits`, `ExecHeader`, `ExecResult`, `ExecIo`, `RotationResult`, `AgentLogger`, `certificateFingerprint`, `parseJsonLine`, `hasDuplicateKeys`, `MAX_PAIRING_WINDOWS` | `agent-listener.ts`: listener construction (explicit port, never 7760), strict NDJSON line validation and certificate fingerprinting helpers used by the surface slices. `MAX_PAIRING_WINDOWS` is the pairing-window retention bound the listener's window map and the hosts service's closed-window map share (oldest-first pruning at window open, aligned FIFO so a retained superseded window still answers its 409). |
| `PairingWindow`, `openPairingWindow`, `deriveCheckCode` | `agent-pairing.ts`: one single-use operator-opened window (QR 128-bit secret, typed 8-char secret), the exact six-digit check-code recipe, five-attempt lockout across connections and modes (malformed included), secret erasure on any terminal state, and 32-byte credential issuance (persisted hashed only). Issuance takes the caller-claimed agent identity: the listener claims the identity before the window issues, so a refused claim leaves the window open and issues nothing. |
| `CredentialStore`, `agentLinkStatePath`, `AgentLinkState`, `AgentCredentialRecord` | `agent-pairing.ts`: the agent-link state file under orch's state dir — hashed credentials, pinned fingerprints, fail-closed load, atomic owner-only saves. `AgentLinkState.tls` optionally holds the active PEM certificate/private key; `CredentialStore.activateCertificate(tls, fingerprint, acknowledged)` publishes them with the new pin atomically before activation. Startup with a supplied certificate whose fingerprint differs from persisted state is refused; callers restore the persisted TLS pair, never silently replace the pin. |
| `loadListenerTls`, `ensureListenerTls`, `issueSelfSignedPair`, `revokeStoredCredential`, `agentCredentialStatus` | `agent-pairing.ts`: startup TLS restoration (task 3459). `ensureListenerTls(statePath)` serves daemon startup (S6): a first run issues one self-signed P-256 leaf (`issueSelfSignedPair`, DER written in-module, agents pin its SHA-256 per PROTOCOL.md) and persists it with its pin in the owner-only state file; later runs restore it or refuse by name. — `loadListenerTls(statePath, supplied?)` restores the persisted `AgentLinkState.tls` pair and refuses a supplied startup certificate whose fingerprint differs from the pin by name (the certificate changed outside orch). `revokeStoredCredential` drops a stored credential; `agentCredentialStatus` reports durable active or revoked status across restarts (a missing credential reads as revoked). |
| `agentExecLink`, `startAgentListener` | `agent-listener.ts`: the exec link the provider facade runs commands through (task 3459) — its exec method accepts an optional abort signal whose abort destroys the stream (RST), so the agent kills the remote command tree; it also re-checks the durable credential via `agentCredentialStatus` before every command and refuses with the named reason revoked when another process deleted it (a running command ends at the S6 route), naming an unreadable link state file `state unreadable` instead of a reset stream; operational counters support the existing drain. `startAgentListener` starts the listener on the TLS pair restored by `loadListenerTls`, keeping `stop({ deadline? })` awaitable with drain. |
| `provisioningStarted` | Identifies provisioning rows that block drain exit, excluding held setup. |
| `TurnStatus` | Queued/running and terminal turn status union. |
| `TERMINAL_TURN` | Terminal status membership set. |
| `Turn` | Persisted prompt/result/usage/watch record. |
| `StoreEvent` | One row of the append-only events log as an in-process observer reads it (payload parsed). |
| `Store.onEvent` | Subscribe an observer to every appended event at its write point; returns the unsubscribe (the `/events` push channel). |
| `ScopeFeatures` | Nullable Jev scope probabilities. |
| `BypassScope` | Recorded bypass score or explicit refusal reason. |
| `ShadowRank` | Legacy stored coder ranking evidence. |
| `ShadowPick` | Legacy stored coder recommendation. |
| `ReviewerShadowRank` | Legacy stored reviewer ranking evidence. |
| `ReviewerShadow` | Legacy stored reviewer recommendation. |
| `TurnWatchRecord` | Session continuity, scope and turn-watch evidence, including each turn's optional `TurnWatchRecord.repeatLessons` validation list. |
| `scopeWarnings(turn, seatData, stateDir?)` | `seats-defs.ts`: shared non-blocking scope advice from the turn's recorded reading; reads live install thresholds for tool answers and digest flags, retaining default advice and a settings-error flag if settings cannot be read. Existing `WARN_BRIEF_P`, `WIDE_BRIEF_P`, `BRIEF_WORDS`, FINISHED_P and SUPPORTED_P owner exports remain defaults shared with settings declarations. |
| `reviewPlan(store, input, ask?, stateDir?)` | Reads live review bands and Auto-or-N count per theme; default state directory is loadConfig().stateDir. Numeric overrides keep a security minimum of one. Each requested reviewer gets a focus brief. Jev input completeness and failure behavior under Auto are unchanged; calibration records the effective bands. |
| gradeFlags(report, grade, stateDir?), `unsupportedFindings(report, grade, stateDir?)` | Live grading thresholds, with the configured daemon state directory passed through settlement, support rounds, sibling filtering and digest flags. Advisory gradeFlags uses defaults and a settings-error flag on read failure; support/refusal reads remain strict. |
| `reportWarnings(report, stateDir?)`, `REPORT_WARN_WORDS` | `report.ts`: nullable advisory report-text word budget (default null/off; inventory table excluded); always independent of parseReport/schema repair. Read failures retain delivery with a settings-error flag; a digest deduplicates advisory settings errors. |
| `turnRepeatLessons` | Reads a turn's persisted repeat-validation list, or undefined for legacy metadata. |
| `TurnPending` | Persisted queued launch arguments. |
| `TurnEnd` | Completion fields accepted by the store. |
| `DoneUsage` | Completed-turn quota/raw-token accounting row. |
| `DoneUsageOptions` | Accounting role/time/limit filter. |
| `LessonDelivery` | Worker lesson delivery/application record. |
| `LeadLessonDelivery` | Lead lesson delivery/application record. |
| `DrainStatus` | Durable restart drain snapshot. |
| `drainWarning` | Lead-facing drain explanation. |
| `SeatQuery` | Index-bounded seat query variants. |
| `landDomainScope` | From `land-domain.ts`: domain-lead ownership gate a landing applies before target mutation; returns the scope note and paths outside the creator's domain. The domain-lead install settings steer it (settings/CONTRACT.md): off returns ungated, and the domain list filters paths requiring owner consent without changing creator lead status from all assignments (unlisted paths need no consent; an empty list gates nothing). |
| `withDomainScopeNote` | From `land-domain.ts`: adds the domain-scope note to a landing response. |
| `Store` | Durable seats, turns, events, grades, delivery and drain operations. |
| `Store.supersededChatSessions` | For candidate session/timestamp rows, return sessions with no live chat binding whose handle was directly taken over at or after their last activity. Operator releases and later joins do not count; this shared rule feeds Board and Tasks through the surface lead reader. |
| `transaction` | Immediate SQLite transaction with rollback on failure. |
| `migrate` | Atomic forward migration; refuses a newer database schema. |
| `openReadOnlyStore` | Read-only SQLite connection for metrics consumers. |
| `openStore` | Opens/configures/migrates the durable orchestration store. |
| `directoryBelow`, `treeBytes`, `newestMtime`, `acquireSweepGate`, `SweepGate`, `DAY`, `DROP_GRACE` | Re-exported by `store.ts` from pure `sweep-shared.ts`: confined tree measurement, sweep lease and retention intervals used by disk-cleanup and its host tmp pass. |
| `clearCaches`, `ownedWorktree` | `prune.ts` side-effect entry: clean only owned closed-seat caches, preserving Git ignore/tracked-path guards. |
| `sweepTargets` | `target-sweep.ts` side-effect entry: lease-guarded local Cargo target cleanup with confinement, age and fresh liveness checks. Dry-run candidates include aged dropping leftovers in checkouts and configured state roots; real leftover deletion guards are unchanged. |
| `SeatManager` | `seats.ts` seat/turn lifecycle controller used by integrations. |
| `formatDigest` | `digest-text.ts`: human report delivery; checks retain the seat's claimed results without rerun annotations. Inventory tables use private artifact paths, or exact inline text for scout-request callers. |
| `chatPostDocsNote` | `chat.ts`: creates one bounded, non-waking git FYI to the owner without spawning Git; the loopback route belongs to `ops-orchestrator-surface`. |
| `onChatPost` | `chat.ts`: subscribe an observer to every post at its single write point (insertPost, a `ChatPost`); returns the unsubscribe (the `/events` push channel). |
| `isBroadcast` | `chat.ts`: recognize both broadcast address forms, the all string and an address array containing all. |
| `SeatManager.onTurnEvent` | `seats.ts`: subscribe an observer to every live provider TurnEvent of a running turn with its seat and turn id; returns the unsubscribe (the `/events` push channel's turn.event frames, task 3465). The provider sessions' own event callbacks are the only source; nothing re-reads disk. The frame data is `{seat, turn, kind: 'text'|'thinking'|'tool_start'|'tool_end'|'status', text?, tool?: {id, name, input?, durationMs?, isError?}}`: text/thinking deltas coalesce to at most one frame per kind per 100 ms per turn (never lost, merged), tool_start/tool_end and status frames are never coalesced away and flush what a window still held first, keeping arrival order; a turn's buffered frames drain when it ends. |
| `chatWakePending` | `chat.ts`: every addressed lead post except class fyi releases any recipient wake holder (operator decisions 22272, 22275, 22280); a FYI post never releases a held poll or the lead-wake mod and reaches its addressee at its next own turn (persisted in column chat_posts.class, schema 16). Compaction belongs to the recipient path, not daemon eligibility. Explicit wakes, logs, operator checkbox semantics and receipts are unchanged. |
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
| `roleStats`, `RoleStatsRow` | Re-exported through store.ts: per-recorded-profile quality metrics over every started turn in a window. |
| `tierOf`, `setManualTier`, `CellRef`, `Tier` | Re-exported through store.ts: read quality tiers or set/clear an operator override in role-quality.json. Manual marks do not expire. Setter and writeTierFile share a bounded directory lock acquired before reading; invalid/unreadable files are refused without overwriting, and computed writes preserve manual marks. |
| `qualityReviewStats`, `qualityProfileKey` | Re-exported through store.ts: first-valid reviewer verdicts and accepted-dismissal samples keyed by recorded family/model/effort; authorless/invalid-author sample counts remain explicit. |
| `qualityRemovalCheck` | Re-exported through store.ts from profiles.ts: read-only current-matrix check, refusing empty rows or any landable author family left without a distinct reviewer family. |
| `windowLength` | `profiles.ts` rolling-window length for stand accounting. |
| `windowMs` | Rolling-window duration conversion. |
| `MIN_LEFT` | Remaining-capacity threshold consumed by stand runs. |
| `standEnv` | `stand.ts` environment for stand smoke execution. |
| `TokenKick` | `token-kick.ts`: bounded vendor-CLI credential kicks for expired Claude/Grok/Kimi tokens; accepts synchronous or asynchronous expiry readers and persists per-family cooldowns. |
| `FamilyLoad.reauth` | `limits.ts`: optional per-family human sign-in state (fields family, since, opened, and command or url), cleared on a successful live reader read. |
| `pickLoads` | `limits.ts`: what a family pick ranks; a stand-in last good reading older than `PICK_STALE_MS` (60 min) becomes unreadable and ranks last (task 3446). The board and orch_status keep `Limits.all()`. |
| `seatContext` | `context.ts` seat brief assembly used by probes; its optional repeat-lesson list holds full author/coauthor deliveries for review. |
| `lessonSection` | `context.ts` lesson delivery with an explicit `{timeoutMs, maxLessons}` routing argument; direct callers never implicitly read install settings. |
| `LESSON_ID` | `report.ts` shared positive-integer/UUID lesson-id validator, re-exported by `context.ts`. |
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
| `processCwdFields` | `sweep-shared.ts`: bounded cwd query in lsof PID/path field format. Linux rejects unreadable entries by default; signalling callers may set the skipUnreadable option to skip EACCES/EPERM. Darwin returns lsof output as supplied, including any unreadable annotations or omissions even on exit 0; it does not certify completeness. |

`AgentListener` readiness remains bounded by the original TCP-accept quarantine
deadline through the successful `/v1/control` response, not just the switch.
Expiry closes the link and settles pending callers: exec rejects with a
not-ready/closed error; rotateCert reports the agent in `missing` without
activating. Rotation accepts PEM or DER Buffer leaf certificates and normalizes
the active/persisted certificate to PEM; the private key retains the same atomic
owner-only state write. An invalid `stop({ deadline })` returns a rejected
Promise, without starting a stop request or throwing synchronously.

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
- `dropIdleSeatTargets` retains `SeatTargetDrop` summaries for ready seats idle at least four hours. Local paths use the local target sweep; remote paths use `data.remoteDir` exclusively on their host, with fresh turn authorization per target and a complete host liveness re-sample after the grant. `target-sweep-rules.ts` (module `ops-orchestrator-exec`) is the single source for builder matching, Cargo markers and recent-build profile/depth policy, interpolated into self-contained host scripts. Sources, mirrors and Git worktree registrations remain untouched.

## Invariants
- Seat brief memory settings are read once per build from the daemon install state: lessons and knowledge default on; a null full-lesson count preserves byte-only packing, zero/off omits lesson blocks and lookups (including author lesson titles). Read-only role lesson suppression remains in force. Both routers share the resolved 5000 ms default timeout, with nonempty `SEAT_JEV_TIMEOUT_MS` taking precedence (empty is unset); no timeout-source digest field is added.
- Host-agent revocation invalidates every link of the identity, including pre-switch links. Loss of transport/control settles readiness and pending execs, releases identity and exec capacity. Raw TCP connections, including partial TLS handshakes, count against the per-IP bound before TLS. One deadline runs from TCP accept through TLS, the switch barrier and the control response; TLS completion never resets it. A clean exec END_STREAM without required exit trailers rejects as interrupted work, never success. Duplicate JSON keys are compared after decoding, pairing expiry erases display secrets, and malformed/unknown credentials still pay a timing-safe comparison.
- Host-agent rotation activates only after all affected connected agents acknowledge, atomically saves matching TLS material and pin before activation, and drains existing execs without a destruction timer. Listener stop also drains accepted execs; only an explicit operator deadline may interrupt them. The private key remains local in the owner-only state file and never crosses the wire or enters logs.
- Quality-file writers serialize the entire read/modify/atomic-rename operation with role-quality.json.lock (five-second bounded wait; a stale lock is refused, never stolen). Manual writes do not refresh computed timestamps; computed writes preserve manual marks. Invalid or unreadable existing state is not discarded. Manual marks survive the 14-day computed-cell expiry.
- Per-seat scope additions never authorize read-only, review-class or unrestricted roles. Default scopes remain unchanged; session launch and landing use the same role-plus-extra union, and malformed stored additions fail closed.
- For writable Pi seats with a worktree, the extension blocks mutating file tools outside the launch worktree and OS temp directory (which includes seat-owned temp files). It resolves existing targets or the nearest existing parent with realpath, following symlinks; unresolved/dangling paths and non-literal tool-expanded spellings fail closed. Existing role write scopes still apply. Read-only access is unchanged. This is a tool-call guard, not an OS sandbox. Residuals: bash (including fused `then_run`) can still write outside the worktree; pathless `insert`/`replace` on the `hashline-edit-451` and `hashline-edit-500` stand arms, plus pathless `replace_within` on 500, are allowed because their opaque anchors resolve through hashline's private session registry, not a path encoded in the call. Those stand calls can therefore edit outside the worktree; explicit write scopes still refuse missing targets, and every path-bearing call retains realpath containment. Concurrent filesystem changes between authorization and execution are not prevented; no shell parser is attempted. Source: `pi-extension.ts`; `scripts/test-orch-seat-guard.mjs` (not in this kit).
- With default settings, the first coder brief and role `auto` create warn non-blockingly above 0.85 through 0.95, with score, thresholds and sequential-seat advice in the tool answer and turn digest; only above 0.95 refuses (decision #22398). Live user-class `jev.scope.warn` and `jev.scope.refuse` change these bands together across both entry paths and digests. `wide_brief` still bypasses and persists on the seat. Scope scores, refusal audit events and unjudged/cut behavior remain recorded unchanged.
- Seat transcripts are append-order raw history, not a Pi active-branch/context projection. `since` is an exclusive zero-based normalized-entry index (default -1); `turn` is an optional positive provider user-message ordinal, not a persisted orch turn ID. `limit` must be positive and caps at 500. Reads stream with a 1 MiB line cap; malformed/oversize lines increment `skipped`, metadata and unknown blocks are ignored, and an unterminated trailing line is deferred until newline publication. Scanning to `since` is linear without a process-local cache. A remote read touches disk only through the host's contained reader: a candidate outside the host's transcript roots is refused before any fs call, a win32 host accepts only drive paths, and refusals answer a reason, never an empty page; disk history is never mutated.
- Local close stops cwd holders of its owned worktree after the provider stops (TERM, then KILL after a short grace); query failures are logged, not closure failures. Remote seats are excluded.
- A current-format backed-up checkout-only removal may finish a gitless leftover without Git only at the seat's owned, non-linked worktree path. It unlinks only enumerated disposable leaves and uses non-recursive rmdir for every directory, so late entries cannot be swept away by recursive deletion. Non-disposable leaves and read/removal errors keep the remainder with a reason; backups are preserved.
- Turn settlement never reruns or host-probes claimed report checks. Digest and handoff delivery ignore legacy `checkVerify` rows; reported failures and missing-check criteria still flag (task 3227, decision #20677). Command recognition for Pi returns only acceptance or refusal, not execution arguments, cost or offline handling; the reported-check entry type is private to its normalizer.
- Scout/researcher reports may carry an optional inventory `table` up to 60,000 characters. Corrections retain the original; grading receives only a row count. The daemon atomically writes private `tables/<turn>.md` artifacts before publishing paths and recreates them from stored reports on delivery after restart. Seats remain read-only.
- Host admission keeps instrument availability boolean and fail-closed; per-tool checks distinguish `ok`, `absent`, and `timed out` with the raw error. Checks run in parallel with 4-second deadlines inside the 10-second load probe. Creation retries once only when unavailable required checks all timed out, never an absent or unknown verdict; refusals include each cause.
- Image capabilities and catalog exceptions come from the ops-orchestrator-model-input (`docs/contracts/modules/ops-orchestrator-model-input.md` not in this kit) module's data-only entry, `model-input.ts`.
- Credential kicks leave refreshes and credential writes to vendor CLIs; Claude uses non-inference `doctor` with auto-updates disabled, closed stdin, a hard SIGKILL deadline and a persisted 30-minute cooldown. Missing/unreadable credentials never authorize a kick. Source: `token-kick.ts`; `scripts/test-orch-usage.mjs` (not in this kit).
- Daemon-enabled limits reauthentication opens only human sign-in, at most once per family per hour across restarts: `lastGoodFile.__reauth` reservations use sibling temporary-file/rename publication and survive fresh-reading saves alongside `__kick`. Missing/corrupt files are tolerated; failed reservation writes refuse automatic opening. Only the limits reader authorizes sign-in, never inference turn auth, transport or quota failures. Darwin uses harness-login (Qwen quota login) or Chrome for MiMo, with one notification per successful open; Claude and non-Darwin only print instructions. Qwen commands and MiMo's HTTPS host come from validated family-login descriptors. Agents never enter credentials, solve CAPTCHA or accept terms. Reader recovery clears the state, not the launch cooldown.
- Writable connections use busy timeout before WAL, `synchronous=FULL` and foreign keys; committed state is durable. Source: `store.ts` (`openStore`).
- Migrations run atomically and refuse a schema newer than this daemon; failed immediate transactions roll back. Source: `store.ts` (`transaction`, `migrate`); `scripts/test-orch-core.mjs` (not in this kit).
- Event history is append-only, enforced by UPDATE/DELETE abort triggers. Source: `store.ts` (migration SQL); `scripts/test-orch-core.mjs` (not in this kit).
- Seats created during a drain hold new provisioning (except scout/critic); held rows survive restart and resume setup before queued turns, or resume on drain cancel. Closing a held row creates no checkout. Started provisioning still blocks drain exit.
- Restart interrupts running turns but preserves queued work; the drain flag is committed state. Source: `store.ts` (`interruptOrphans`, `setDrain`); `scripts/test-orch-drain.mjs` (not in this kit).
- Idle close ages failed seats and ready seats with no turns from `created_at`, using `idleFloorDays(role)`. Never-prompted landable seats still require landed proof at every age; the two-day unlanded rule (scaled by `machines.retentionMultiplier`) applies only to terminal-turn idleness. Closing/scope fences, fresh checks and normal close cleanup remain in force. Source: `prune.ts`, `seats-close.ts`; `scripts/test-orch-idle-close.mjs` (not in this kit).
- Hot-path seat reads use bounded queries/pages rather than parsing all closed history. Source: `store.ts` (`SeatQuery`, `pruneCandidatesPage`); `scripts/test-orch-store-hot-paths.mjs` (not in this kit).
- Sweep leases and daily stamps supplied by `sweep-shared.ts` serialize daemon and manual CLI passes; scoped host passes never publish the all-host daily stamp, and dry-run leaves gate state untouched. Sweep scheduling and candidate safety belong to `ops-orchestrator-surface`.
- Checkout-owning roles (coder, tester, designer, copywriter, motion, reviewer, legal, security and bughunter) are told to remove comparison worktrees before reporting; read-only roles receive no such instruction. Source: `context.ts`; `scripts/test-orch-context-wait.mjs` (not in this kit).
- Seat report memory proposals remain visible in digests and never trigger automatic lesson capture, repair turns or recovery replay. The lead captures lessons with `node scripts/memory/capture-lesson.mjs`; historical application ledger rows remain readable.
- Placement ranks the daemon's local machine with `placement.reserveCores` and `placement.reserveMemoryGb` taken off its free capacity (floored at zero), defaulting to today's 6 cores and 12 GB, and gives an equal value to a host; a lead's `needs: mac` keeps its stated `needs_reason` in the placement reason (task 3288). Platform and explicit-host rules remain unchanged. Source: `placement.ts`, `seats-create.ts`; `scripts/test-orch-placement.mjs` (not in this kit).
- New-seat admission enforces nullable `seats.maxOpen` immediately before insertion with no asynchronous gap; every non-closed status counts, and an idempotent retry returns its existing seat without admission. Default null leaves admission uncapped.
- `routing.supportedFamilies` restricts both automatic picks (including emergency fallback) and named creates without stopping existing seats. The default is the compiled family list. `routing.manual` defaults off, preserving pace, reset, tier and spread ordering. When on, automatic picks rank positive shares from `routing.percentages` divided by 1+A (working seats in the role), then family name; unavailable providers still rank last. Zero/omitted shares are excluded from automatic picks, not explicit requests. Budget, reserve, pause, independence, image and coder-cap guards remain in force; a fully capped field still keeps its best choice. `rankFamilies` also exposes/sorts manual shares, retaining zero-share rows for explicit budget checks.
- `budget.alertAheadOfPace` defaults false and, when enabled, adds an advisory to automatic routing explanations for allowed families whose observed spend exceeds elapsed pace-window share; reservations and the GLM reserve do not themselves trigger it. Source: `scripts/test-orch-routing-settings.mjs` (not in this kit).
- A designer verifies its own visual result (operator #19248, task 3454): its role context tells it to capture the changed surface (Peekaboo on this Mac) and read the image before reporting; a designer whose task files touch `src/**` places only on this Mac (the Tauri runtime lives here), while `web/apps/**` designers stay load-ranked; its report contract requires a capture-read criterion, and `criteriaFlags` flags a done designer report that has none. Source: `context.ts`, `placement.ts`, `report.ts`, `digest-text.ts`; `scripts/test-orch-placement.mjs` (not in this kit), `scripts/test-orch-seats-reports.mjs` (not in this kit).
- Lesson application is recorded only for lessons actually delivered in full; full lead delivery cannot be downgraded by indexed delivery. Source: `store.ts` (delivery methods); `scripts/test-orch-core.mjs` (not in this kit).
- An authored review-rights seat's first brief lists full author/coauthor lesson deliveries by id and title. Unreadable titles are labeled without failing the brief or omitting their listed ids. Its findings may carry `repeats` only for those ids on reproduced blocker/major findings describing exactly that lesson's mistake; repairs, corrections and continuations retain marks only while the corrected finding remains a reproduced blocker/major, dropping them on withdrawal or downgrade below that threshold. Each turn persists its validation list in `watch.repeatLessons`; digest and memory-proposal parsing use that turn's list, with shape-only validation for legacy turns that have none. Valid settled reports use `recordLessonRepeat` per finding after seat settlement, outside sibling grading serialization; the waiter hold remains until recording settles, and failures flag the digest without failing the turn. `lesson-stats` Part B counts these rows with manual duplicate repeats.
- Seat creation resolves the creating lead's handle once from `Choose.leadSession`'s live chat binding and stores it as `data.leadHandle`; while the domain-lead registry holds any assignment, `createSeat` refuses a landable role (coder, tester, designer, copywriter, motion) whose session is missing or holds no live binding, naming the session (registry unavailability or emptiness keeps the fail-open create, decision #22281). `seat_land`'s domain gate keys on the stored handle, never a later lookup, so a release or rebind after creation cannot drop it; legacy `leadSession`-only seats keep the live-binding lookup, and a creator identity that is missing or no longer resolves to a handle (a legacy session that ended or was rebound) fails closed: `seat_land` refuses, naming the seat and the cause, whenever the patch touches a domain registered to any lead, while a patch wholly inside unrouted or unowned paths still lands ungated (registry unavailability alone stays fail-open, decision #22281). The surface `seat_land` response adds `domainScope`; registered leads require addressed owner post citations for paths owned by other domains (decision #22281). Install settings steer the same gate (task 3459 C13, decision 22510): `domainLeads.enabled=false` makes every landing and create behave as a repository with no domain leads (assignments are kept, not deleted), a non-null `domainLeads.domains` list exempts unlisted paths from owner consent without changing lead status from all assignments, and an empty list gates nothing. Both settings are operator-only. Settings are read only after a readable, nonempty registry; corrupt or invalid settings then fail the gate closed. Source: `land-domain.ts`, `seats-create.ts`; `scripts/test-orch-land-domain.mjs` (not in this kit).

## Dependencies

- `ops-orchestrator-exec` — worktree/process execution, remote repository operations, locks, logging and check command recognition.
- `ops-orchestrator-shared` — configuration, guards, instruments and shared launch policy.
- `ops-orchestrator-model-input` — data-only image capabilities and catalog exceptions.
- `ops-orchestrator-providers` — session types, routing and managed process launch.
- `ops-orchestrator` — suite receipt, code fingerprint and build-gate tooling.
- `ops-bootstrap-routing` — knowledge pages, lesson and skill routing, Jev client, gate and ledger.
- `ops-host-agent` — PROTOCOL.md v1 wire ownership and the slice-1 exec/pairing primitives (`openExecStream`, `readExecOutput`, `pipeWithBackpressure`, `parseExecHeader`) imported through `ops/host-agent/index.mjs`.
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
- `scripts/test-orch-event-stream.mjs` (not in this kit) — `/events` push frames, including live turn.event coalescing, ordering and flush-at-end.
- Narrow store command: `node scripts/test-orch-store-hot-paths.mjs` (`scripts/test-orch-store-hot-paths.mjs` not in this kit).

## Owner

`domain-harness`; surface, execution primitives, providers and parent support tooling retain separate module contracts.

## Changelog

- Task 2409 slice C: document existing store entry and production integration seams; no daemon behavior change.
- Task 3141 slice A: retain 40 runtime source files and this contract; split surface and execution ownership without moving files or changing code.
- Task 3288: Mac placement reserve and the stored `needs_reason`; no Public API symbol change.
- Task 3389 (breaking): the board live turn log is removed (operator decision 21173): `TurnLiveLog`, `TurnLiveEntry`, `TURN_LOG_MAX_ENTRIES`, `TURN_LOG_MAX_BYTES`, `TURN_LOG_MAX_TURNS` and the SeatManager turn-log seams leave the Public API.
- Task 3465 slice 1: live turn.event frames on `/events` — `SeatManager.onTurnEvent` observes the provider sessions' own event callbacks; tool TurnEvents gain `id` and a closing `status: 'ended'` with `durationMs`/`isError`.
- Task 3459 L0c: the supervised-lead create route (in `ops-orchestrator-surface`, `http-leads.ts`) takes provider pi plus per-start family/model/effort and the new GET /api/leads/models answers what a start may name; no runtime Public API change.
