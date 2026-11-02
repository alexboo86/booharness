---
id: ops-orchestrator-providers
owner: domain-harness
paths:
  - ops/orchestrator/src/providers/**
entry: ops/orchestrator/src/providers/index.ts
sideEffectEntries:
  - ops/orchestrator/src/providers/spawn.ts
layer: harness
---
## Purpose

Selects and runs agent provider adapters through a shared session interface, including native vendor protocols and the pinned Pi worker runtime.

## Public API

`index.ts` re-exports `types.ts`; the daemon imports that facade for routing.
Existing deep-import consumers are listed separately rather than implying facade-only use.
`spawn.ts` is an explicit side-effect entry for managed auxiliary commands, including disk-cleanup's host-volume statfs readings.

| Symbol | Description |
|---|---|
| `Family` | Supported provider-family union. |
| `FAMILIES` | Ordered family inventory used by profiles and configuration. |
| `Harness` | Native CLI or Pi harness selection. |
| `Access` | Full or read-only access request. |
| `SessionSpec` | Family, working directory, model, access, host and verified launch resources. |
| `Usage` | Normalized uncached input/output, nullable cache/cost fields and raw evidence. |
| `StopReason` | Normalized completion/cancellation/refusal reason. |
| `TurnResult` | Completed text, stop reason, usage, error and duration. |
| `TurnEvent` | Streamed text, thought, tool, usage, compaction and permission events. Tool events carry the call id; started/pending/running statuses open a call and `status: 'ended'` closes it with durationMs/isError for the live turn stream (task 3465). |
| `PromptOptions` | Event callback and optional turn timeout. |
| `ContextUsage` | Reported context tokens and window size. |
| `ProviderSession` | Session id/model, prompt, cancel/close and optional steering/context capabilities. |
| `ProviderAdapter` | Starts or resumes a provider session. |
| `glmEnv` | Loads GLM coding-plan environment from the canonical provider store. |
| `opencodeKey` | Resolves a Pi auth-store API key into a requested environment variable. |
| `qwenKey` | Resolves the Qwen token-plan API key. |
| `qwenEnv` | Combines Qwen model endpoint, key and isolated native CLI directories. |
| `mimoProvider` | Chooses a configured Xiaomi token-plan region, refusing absent credentials. |
| `mimoEnv` | Builds native MiMo credentials/model environment without changing the operator's saved login. |
| `mimoRouteKey` | The raw api_key the Pi smoke could echo for the mimo route (`~/.pi/agent/auth.json`, then the env key) — redaction input only; it rides no child env (task 3536 slice B correction 2). |
| `hasAdapter` | Reports route availability, not proof that a given access/role may launch it. |
| `FAMILY_EFFORTS` | Accepted effort strings consumed by the role configuration loader. |
| `defaultHarness` | Selects native Claude and Pi for the other routed families. |
| `adapterFor` | Returns the selected adapter or refuses an unsupported route. |
| `Command` | `spawn.ts` executable plus argv shape used by remote execution. |
| `resolveCommand` | Resolves host executables and npm shims, including Node-distributed npm/npx wrappers and their existing global-prefix CLI override. Re-exported by `index.ts` for the pi-client job and routes (task 3536 slice B): a win32 spawn of a `.cmd` shim needs its resolved target. |
| `spawnProvider` | Starts a local or SSH-host provider with the required environment/lifetime handling. |
| `spawnSsh`, `SSH_START_LIMIT`, `SSH_START_BOUND_MS` | Starts managed SSH through a per-target FIFO authentication gate: six starts, released on first output, exit/error or 15 seconds. |
| `ownGroup` | Requests a dedicated process group where the platform supports it. |
| `refuseHostSsh` | Prevents seat commands from bypassing managed host SSH. |
| `sshNodeArgs` | Builds the managed remote Node invocation arguments. |
| `spawnHost`, `HostCommand` | The one remote host-command facade (task 3459): kind seat runs through the checkout's remote-exec relay and kind bootstrap is a self-contained direct command with pipe or ignored stdin. Dispatch reads the host entry's transport field — ssh (default) keeps the managed ssh shapes, agent runs the same argv through the paired host agent's exec stream with the same stdio, exit code, signal and kill-tree semantics. A forwarded seat over the agent link is refused with a named error; there is no silent fallback to ssh. |
| `AgentLink`, `AgentExecHeader`, `AgentExecResult`, `AgentCommandError` | The in-process agent-link registry behind the facade's agent transport (task 3459): live links, durable link status and a protocol-version guard resolve to an exec stream, presented to callers as a child process (streams, exit and signal codes; kill aborts the stream so the agent kills the tree). `AgentCommandError` names the failure: not connected, version too old, revoked, denied, no-runtime, stream reset, state unreadable. |
| `setAgentLink`, `revokeAgentLink`, `setAgentLinkStatus` | Register and withdraw the live link for an agent id, and persist revoked/not-connected link status across restarts (task 3459). Revocation drops the live link first, then the durable status; further commands for that agent fail by name (revoked). |
| `quoteShellPath` | Quotes host paths for remote shell use. |
| `providerEnv` | Constructs the guarded provider child environment. |
| `cargoBuildJobsDefault` | Pure half-core cargo jobs default (minimum two), shared by provider and auxiliary launches without writing build-gate shims. |
| `smallCargoTargetEnv` | Task 2861 C: line-tables-only/no-incremental cargo defaults for review seats (reviewer, security, legal, bughunter), keeping values the env already sets; applied by `providerEnv` locally and the parent remote launcher on hosts. |
| `providerLaunch` | Converts resolved command/args to the platform launch form. |
| `PiToolManifest` | `pi.ts` missing-tool preflight result used by placement. |
| `piArgs` | Builds Pi RPC/session/trust/tool arguments; used by stand probes. |
| `piRuntimeLayout` | Resolves the pinned shared runtime binary and installed package metadata. |
| `piVersionedLayout` | `pi.ts`: the beside-the-pin runtime tree per platform (task 3536) — the `current.json` switch-record path and the `versions/<version>` bin/manifest paths. |
| `piInstallProbeArgs` | `pi.ts`: the host probe argv reading the pin install, the `current.json` record and the tree its switch selects. |
| `resolvePiInstall`, `PiInstallFacts` | `pi.ts`: THE runtime resolver shared by the local assert and the remote probe (task 3536): no switch record, or a switch at/below the pin, runs the repo pin (below the pin adds a status line naming both versions); an above-the-pin switch runs its `versions/<version>` tree when valid; a broken record refuses with a message naming the file — never the repo pin. |
| `readLocalPiInstall`, `probePiInstall`, `piPinVersion`, `comparePiVersions` | `pi.ts` (task 3536 slice B): the install facts a pi-client consumer gathers (synchronously for the local machine, through the host probe for a named host), the pin in a target checkout's `ops/pi-runtime/package.json`, and numeric per-part version comparison. Re-exported by `index.ts` for the pi-client job and routes. |
| `piSecretValues`, `piCredentialValues`, `redactPiSecrets` | `pi.ts` (task 3536 slice B): the PI_UNSET-named values of an environment plus a caller's selected route keys and the userinfo of its admitted registry/proxy URLs, and their `[redacted]` substitution — the pi-client job and routes scrub child stderr before it leaves the job. `piCredentialValues` is the key/token/userinfo subset: fragment masking applies only to it, never to paths or configuration (whole-value redaction still does). |
| `PI_CHILD_ENV`, `PI_INSTALL_ENV`, `piChildEnv` | `pi.ts` (task 3536 slice B correction 2): the shared daemon-side tool-child environment — PI_CHILD_ENV names only (plus the exact PI_INSTALL_ENV registry/proxy/TLS names when install is requested), never a credential, plus the caller's extras. |
| `CODEX_DEFAULT` | `codex.ts` default model/effort used by routing and dashboard consumers. |
| `codexUsageParts`, `codexAddUsage`, `CodexUsageTotal` | `codex.ts` codex usage math: one record's cached input split out of inputTokens, and per-model-call accumulation into a turn total with repeated-total dedup (memory #10741). |
| `isToolItem`, `codexToolFailed`, `callArgs`, `ToolItem` | `codex.ts` item classification (tool calls vs the model's own words), completed-tool failure (failed/rejected status or non-zero exit) and call arguments without the fields that change as it runs. |
| `LeadProviderKind` | The provider a new lead speaks, by the lead's spawn option or the driver's default: claude (default), codex or pi (task 3459); since task 3535 L0d a codex start resolves to family codex through `PiLeadProvider`. |
| `LeadPermissionMode` | The operator's lead.permissionMode values (task 3459 C9): claude's `--permission-mode` spellings; `default` is today's bare child argv. |
| `LeadProvider` | `lead-provider.ts` (task 3459): the lead-runtime seam — `buildSpawn({resumeSession, cwd, secretsVeil}) → {argv, env}`, `parseLine(line) → LeadProviderEvent[]` and supportsResume; the secretsVeil spawn flag (task 3459 L3, from the driver's lead.secretsVeil state per spawn) arms the vendored secrets-veil masking of the child's tool results before its model reads them — `ClaudeLeadProvider` loads the plugin through the CLAUDE_CODE_PLUGIN_DIRS env, `PiLeadProvider` sets the ORCH_PI_LEAD_SECRETS_VEIL env for `pi-extension.ts`'s tool_result veil (both under Wire names). One instance per lead session because parsing keeps per-session protocol state. Optional readonly permissionModes declares which lead.permissionMode values the child can honour (absent means none beyond today's argv); the driver refuses a set mode a provider cannot honour. Optional compact queues between-turn compaction through takeWrites without creating a driver pending user turn; compactProducesResult distinguishes Claude's own /compact result from the following wake turn. Optional idempotent dispose releases session resources on stop, replacement or terminal failure, never between crash restarts. |
| `LeadProviderEvent`, `LeadUsage`, `LeadProviderSpawn`, `LeadPermissionAnswer` | Normalized lead provider events (whole/delta text and thinking, tool start/end, usage, compaction, result, session id, fatal protocol failure, and a child-originated permission ask carrying the child's request id) and the spawn/answer shapes; usage fields the protocol does not report stay null, never guessed. A fatal event reports the error without answering the pending turn; the driver terminates the child under its existing restart cap. The spawn options also carry the child's cwd for protocols whose thread settings name one. |
| `ClaudeLeadProvider` | `claude-lead.ts`: the claude lead child — `-p --input-format stream-json --output-format stream-json --include-partial-messages --verbose` argv, `--resume <session>`, `CLAUDE_CODE_ENTRYPOINT=sdk-cli` env, optional permission-tool/MCP wiring, and an optional `--permission-mode <mode>` from lead.permissionMode (no flag for default; task 3459 C9) — the stream-json line parser moved unchanged in effect from `lead-driver.ts` (usage and compaction lines now normalize instead of being discarded), and between-turn `/compact` requests drained through takeWrites. |
| `PiLeadProvider` | `pi-lead.ts` (task 3459 L0b): the Pi lead child — the runtime `resolvePiInstall` selects, in `--mode rpc` through the same `piArgs`/route env/`PI_ENV` builder the seats use, wrapped by the dependency-free `pi-lead-child.mjs` shim (driver user lines → RPC prompt, agent_settled gated per open turn, U+2028/U+2029 escaped for the driver's line reader, startup provider/extension verification), `--session <file>` resume from the reported session file, the RPC event parser to the same normalized lead events, and the shim's orch-compact control line translated to Pi's compact RPC without opening a prompt turn. |
| `piRouteFor` | `index.ts`: the Pi route a family runs as a lead child, refused like `adapterFor` for a family without one. |
| `assertLocalPiRuntime` | `pi.ts`: the synchronous local half of assertPiRuntime — same resolution and refusal through `resolvePiInstall`; a lead child's buildSpawn resolves the runtime without an await. |
| `PI_ENV`, `PI_UNSET`, `ORCH_SEAT_COMMAND` | `pi.ts` shared constants: the offline/exclusive Pi env, the env keys no Pi child inherits, and the extension command a launcher verifies via get_commands. |

Production consumers include runtime `seats.ts`, `profiles.ts`, `placement.ts`,
`seat-guard.ts`, the parent `remote-exec.mjs`, and `ops/ab-stand/pi-runtime.mjs`.
Protocol-specific helpers and test setters are not a replacement public facade.

### Wire names

- `SEAT_POLICY_ROLE` — environment variable identifying the seat role used to select review-seat cargo defaults.
- `ORCH_SEAT_WRITE_SCOPE` — combined role and lead-declared extra globs. Native Claude/GLM inject a managed PreToolUse command for Write/Edit/MultiEdit/NotebookEdit using this scope and the fixed launch checkout root; malformed or absent scope in that hook denies edits. Pi uses the same shared matcher. Bash remains outside this file-tool guard.
- `CLAUDE_CODE_PLUGIN_DIRS` — environment variable naming plugin directories a claude child loads; the driver appends the vendored secrets-veil directory per spawn when lead.secretsVeil is on (task 3459 L3), keeping every other listed directory.
- `ORCH_PI_LEAD_SECRETS_VEIL` — environment variable arming the Pi lead extension's tool_result veil (task 3459 L3); only a lead child sets it, 'off' under lead.secretsVeil.

## Inputs

- Session specifications, prompts, optional event callbacks, timeouts and provider session ids.
- Host configuration and provisioned MCP/extension paths, never arbitrary project-discovered trust.
- Canonical credential stores and provider-specific environment overrides.
- Provider stream-json, JSON-RPC/ACP or Pi RPC messages; local/remote child stdio and exit events.

## Outputs

- Provider sessions with cancellable lifecycle and normalized turn results/events.
- Raw provider usage/stop evidence retained beside normalized fields.
- Child processes, session files and isolated native CLI homes.
- Fixed-class credential errors without parser messages that could expose secret bytes.

## Internals

- The parent `remote-exec.mjs` helper `seatEnvironment` applies `smallCargoTargetEnv` on hosts; it belongs to the parent module, not this module's public exports.

## Invariants

- Usage input is uncached input; unavailable cache/cost/whole-turn usage stays null rather than guessed. Source: `types.ts`; `index.ts` (native turn usage); `scripts/test-orch-providers.mjs` (not in this kit).
- Start and resume return the same session interface; a closed process must not be treated as a usable continuing session. Source: `types.ts` (`ProviderAdapter`, `ProviderSession`); `pi.ts`.
- Lead handshake errors and refused Pi prompts are visible failures, not successful turn completions. Pi prompts sent during an open run use followUp; only the drained run settles, while an extension-handled prompt cannot settle another open run. Temporary Pi MCP configuration survives crash resumes and is removed on disposal.
- A supervised lead's tool results are masked before its model reads them (task 3459 L3, `lead.secretsVeil`): the vendored secrets-veil is reused (never copied) and a mask failure or cap overrun withholds the result with refusal text, never passing it raw. Media follows the vendored handler's rule (register.ts, 2026-10-21): an encoded image or PDF under a base64/data key, or encoded media inside an image block, masks named values only and reaches the model intact (no pattern/entropy pass, no single-value text cap) — a lead must still read a screenshot. Every other string, including the text fields of an unknown block that Anthropic-compatible routes serialize as text, is masked in all three layers and refused past the caps. Named gaps by design: streamed partial tool output and tool_execution_update frames, thinking text, nested-tool results that only reach the calling tool, a secret hidden inside image or PDF bytes (the media rule masks named values there only), and `lead.secretsVeil: false` stops the driver's loading but cannot subtract a secrets-veil plugin the operator's own claude settings load. Source: `claude-lead.ts`, `pi-lead.ts`, `pi-extension.ts`; `scripts/test-orch-lead-driver.mjs` (not in this kit), `scripts/test-orch-lead-pi.mjs` (not in this kit).
- Credential parse failures expose fixed error classes/codes, not JSON parser messages containing credential bytes. Source: `index.ts` (`credentialErrorKind`).
- Native Qwen/MiMo require a landable role and full access; route availability alone does not authorize read-only launch. Source: `index.ts` (`nativeCoderArgs`); `scripts/test-orch-providers.mjs` (not in this kit).
- Pi launch requires the resolved runtime and adapter configuration; it refuses missing/mismatched prerequisites instead of using a different binary. Since task 3536 a machine's `current.json` switch may select a beside-the-pin `versions/<version>` tree, and a broken switch refuses with a message naming the file rather than falling back to the repo pin. Source: `pi.ts` (`assertPiRuntime`, `resolvePiInstall`, MCP adapter checks).
- Pi arguments reject project trust through `--no-approve` while supplying explicit managed resources. Source: `pi.ts` (`piArgs`); `scripts/test-orch-providers.mjs` (not in this kit).
- Managed SSH never has more than six unauthenticated processes per target; waiters are FIFO, release is idempotent, and caller cancellation still applies while queued. A caller's destroy of a facade stdin/stdout/stderr reaches the real pipe (also after ssh exits and after a queued start), while a normal stdin end() still flushes every buffered byte. The gate starts each command exactly once and never repeats it: a connection/authentication refusal on stderr cannot prove the remote command never ran, so the one retry of a refused start belongs to a caller that can prove its own step is repeatable (ops/orchestrator/src/remote-provision.ts). Source: `ssh-start-gate.ts`; `scripts/test-orch-ssh-start-gate.mjs` (not in this kit).

## Dependencies

### Internal Modules

- `ops-orchestrator-shared` — configuration, role policy, instruments, seat tool protocol, host/MCP paths, build gate and lifecycle diagnostics. Process-output helpers (`collect`, `text`) come from its pure facade without depending on runtime Git transport.
- `ops-pi-runtime` — shared installed package/binary read by the Pi adapter, not a TypeScript import.
- `ops-orchestrator` — remote launcher/build-gate artifacts used by spawning; the reverse runtime/provider imports are existing cycles.

### External Libraries

- Node.js built-ins; native Claude/Codex/ACP provider CLIs, SSH and the pinned Pi installation.
- Provider protocols are translated here; none is the market-data wire format under `docs/contracts/wire/`.

## Tests

- `scripts/test-orch-providers.mjs` (not in this kit) — adapter start/resume, events, usage, credentials and Pi configuration boundaries.
- `scripts/test-orch-pi-switch.mjs` (not in this kit) — the beside-the-pin runtime switch through `resolvePiInstall`, at the local assert and the install probe.
- `scripts/test-orch-remote.mjs` (not in this kit) — command resolution, remote launch environment and transport helpers.
- `scripts/test-orch-ssh-start-gate.mjs` (not in this kit) — per-host SSH authentication concurrency, release triggers, timeout and FIFO order.
- `scripts/test-orch-remote-pi-mcp-live.mjs` (not in this kit) — opt-in real remote Pi/MCP preflight.
- `scripts/test-orch-lead-driver.mjs` (not in this kit) — claude lead provider line parsing (parity with the pre-task fixtures), usage normalization and fresh-session restart through `lead-driver.ts`.
- Narrow adapter command: `node scripts/test-orch-providers.mjs` (`scripts/test-orch-providers.mjs` not in this kit).

## Owner

`domain-harness`; runtime owns seat scheduling/authorization and this module enforces its launch-level provider boundaries.

## Changelog

- Task 2409 slice C: document existing facade, deep-import consumers and provider lifecycle; no route or policy change.
- Task 3122: gate managed SSH authentication starts per target without changing caller process APIs.
- Task 3122 correction: a facade stream destroy now destroys the real SSH pipe, so probeEnd's timeout path frees the daemon's event loop when a descendant holds the pipe open.
- Task 3459: lead-runtime provider seam — `LeadProvider` types and the claude lead child (`ClaudeLeadProvider`) behind them; claude parsing moved from `lead-driver.ts` unchanged in effect. L0b: the codex lead child (`CodexLeadProvider`) with the seam's permission-ask event and optional stdin methods, sharing `codex.ts` protocol helpers.
- Task 3535 L0d: `CodexLeadProvider` and `codex-lead.ts` deleted — a codex lead runs family codex through `PiLeadProvider` (the pinned Pi runtime), keeping model/effort per start; the leads.models gate reads both `codex[:model]` and `pi:codex[:model]` for a codex start. The native codex sandbox is removed with it: a Pi lead runs with full access and MCP permission cards.
- Task 3536 slice A: a machine may run a Pi beside the repo pin — one resolver (`resolvePiInstall`) behind the local assert and the remote probe: no `current.json`, or a switch at/below the pin, runs the repo pin (below the pin with a status line naming both versions); an above-the-pin switch runs its valid `versions/<version>` tree; a broken switch refuses naming the file. Stand arms, the installer and harness-login stay on the repo pin; `piArgs` is unchanged.
- Task 3459 L3: `buildSpawn` gains `secretsVeil`; a supervised lead's tool results are masked by the vendored secrets-veil before its model reads them (claude: plugin loaded per spawn; pi: extension tool_result veil), refusal text on a mask failure, raw results only under `lead.secretsVeil: false`.
