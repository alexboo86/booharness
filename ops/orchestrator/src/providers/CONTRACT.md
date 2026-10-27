---
id: ops-orchestrator-providers
owner: domain-harness
paths:
  - ops/orchestrator/src/providers/**
entry: ops/orchestrator/src/providers/index.ts
layer: harness
---
## Purpose

Selects and runs agent provider adapters through a shared session interface, including native vendor protocols and the pinned Pi worker runtime.

## Public API

`index.ts` re-exports `types.ts`; the daemon imports that facade for routing.
Existing deep-import consumers are listed separately rather than implying facade-only use.

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
| `TurnEvent` | Streamed text, thought, tool, usage, compaction and permission events. |
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
| `hasAdapter` | Reports route availability, not proof that a given access/role may launch it. |
| `FAMILY_EFFORTS` | Accepted effort strings consumed by the role configuration loader. |
| `defaultHarness` | Selects native Claude and Pi for the other routed families. |
| `adapterFor` | Returns the selected adapter or refuses an unsupported route. |
| `Command` | `spawn.ts` executable plus argv shape used by remote execution. |
| `resolveCommand` | Resolves host executables and npm shims, including Node-distributed npm/npx wrappers and their existing global-prefix CLI override. |
| `spawnProvider` | Starts a local or SSH-host provider with the required environment/lifetime handling. |
| `ownGroup` | Requests a dedicated process group where the platform supports it. |
| `refuseHostSsh` | Prevents seat commands from bypassing managed host SSH. |
| `sshNodeArgs` | Builds the managed remote Node invocation arguments. |
| `quoteShellPath` | Quotes host paths for remote shell use. |
| `providerEnv` | Constructs the guarded provider child environment. |
| `cargoBuildJobsDefault` | Pure half-core cargo jobs default (minimum two), shared by provider and auxiliary launches without writing build-gate shims. |
| `smallCargoTargetEnv` | Task 2861 C: line-tables-only/no-incremental cargo defaults for review seats (reviewer, security, legal, bughunter), keeping values the env already sets; applied by `providerEnv` locally and the parent remote launcher on hosts. |
| `providerLaunch` | Converts resolved command/args to the platform launch form. |
| `PiToolManifest` | `pi.ts` missing-tool preflight result used by placement. |
| `piArgs` | Builds Pi RPC/session/trust/tool arguments; used by stand probes. |
| `piRuntimeLayout` | Resolves the pinned shared runtime binary and installed package metadata. |
| `CODEX_DEFAULT` | `codex.ts` default model/effort used by routing and dashboard consumers. |

Production consumers include runtime `seats.ts`, `profiles.ts`, `placement.ts`,
`seat-guard.ts`, the parent `remote-exec.mjs`, and `ops/ab-stand/pi-runtime.mjs`.
Protocol-specific helpers and test setters are not a replacement public facade.

### Wire names

- `SEAT_POLICY_ROLE` — environment variable identifying the seat role used to select review-seat cargo defaults.

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

- Usage input is uncached input; unavailable cache/cost/whole-turn usage stays null rather than guessed. Source: `types.ts`; `index.ts` (native turn usage); `scripts/test-orch-providers.mjs`.
- Start and resume return the same session interface; a closed process must not be treated as a usable continuing session. Source: `types.ts` (`ProviderAdapter`, `ProviderSession`); `pi.ts`.
- Credential parse failures expose fixed error classes/codes, not JSON parser messages containing credential bytes. Source: `index.ts` (`credentialErrorKind`).
- Native Qwen/MiMo require a landable role and full access; route availability alone does not authorize read-only launch. Source: `index.ts` (`nativeCoderArgs`); `scripts/test-orch-providers.mjs`.
- Pi launch requires the pinned installed runtime and adapter configuration; it refuses missing/mismatched prerequisites instead of using a different binary. Source: `pi.ts` (`assertPiRuntime`, MCP adapter checks).
- Pi arguments reject project trust through `--no-approve` while supplying explicit managed resources. Source: `pi.ts` (`piArgs`); `scripts/test-orch-providers.mjs`.

## Dependencies

### Internal Modules

- `ops-orchestrator-shared` — configuration, role policy, instruments, seat tool protocol, host/MCP paths, build gate and lifecycle diagnostics. Process-output helpers (`collect`, `text`) come from its pure facade without depending on runtime Git transport.
- `ops-pi-runtime` — shared installed package/binary read by the Pi adapter, not a TypeScript import.
- `ops-orchestrator` — remote launcher/build-gate artifacts used by spawning; the reverse runtime/provider imports are existing cycles.

### External Libraries

- Node.js built-ins; native Claude/Codex/ACP provider CLIs, SSH and the pinned Pi installation.
- Provider protocols are translated here; none is the market-data wire format under `docs/contracts/wire/`.

## Tests

- `scripts/test-orch-providers.mjs` — adapter start/resume, events, usage, credentials and Pi configuration boundaries.
- `scripts/test-orch-remote.mjs` — command resolution, remote launch environment and transport helpers.
- `scripts/test-orch-remote-pi-mcp-live.mjs` — opt-in real remote Pi/MCP preflight.
- Narrow adapter command: `node scripts/test-orch-providers.mjs`.

## Owner

`domain-harness`; runtime owns seat scheduling/authorization and this module enforces its launch-level provider boundaries.

## Changelog

- Task 2409 slice C: document existing facade, deep-import consumers and provider lifecycle; no route or policy change.
