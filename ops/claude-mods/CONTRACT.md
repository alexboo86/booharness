---
id: ops-claude-mods
owner: domain-harness
paths:
  - ops/claude-mods/**
  - ops/claude-mods/collision-guard/.claude-plugin/plugin.json
  - ops/claude-mods/delay-no-more/.claude-plugin/icon.png
  - ops/claude-mods/delay-no-more/.claude-plugin/plugin.json
  - ops/claude-mods/delay-no-more/.gitignore
  - ops/claude-mods/handover/.claude-plugin/plugin.json
  - ops/claude-mods/lead-wake/.claude-plugin/plugin.json
  - ops/claude-mods/secrets-veil/.claude-plugin/plugin.json
  - ops/claude-mods/secrets-veil/.gitignore
entry: ops/claude-mods/lead-wake/hooks/register.ts
layer: harness
---
# Module: ops-claude-mods

## Purpose

Provides the harness's Claude Code mods for idle-lead wake, lead handover, and vendored tool-safety integrations.
The mods are engine-loaded plugin folders, not an application-side React or orchestrator library.

## Public API

- `register` (`lead-wake/hooks/register.ts`) — registry-entry Claude Code hook registration: starts the idle wake hold and gates it on turn start/complete, without any pane or surface.
- `register` (`handover/hooks/register.ts`) — engine hook registration exposing the handover tool with text and clear intent.
- `register` (`collision-guard/hooks/register.mjs`) — engine hook registration for same-file edit collision warnings.
- `register` (`delay-no-more/hooks/register.ts`) — engine hook registration adjusting deferred tool placement during tool description.
- `register` (`secrets-veil/hooks/register.ts`) — engine hook registration masking sensitive tool output and denying unsafe results.

Paths above are relative to `ops/claude-mods/`; each plugin's `hooks/hooks.json` selects its registration module.
There is no external source import of the registry entry: the Claude Code engine discovers it through plugin metadata.
`ops/bootstrap/permissions-target.mjs` selects installable folders; `ops/harness-kit/build-kit.mjs` (not in this kit) packages their files.

### Wire names

- `mcp__handover__run` — handover MCP tool accepting text and clear intent.

## Inputs

- Claude Code `session.start`, `session.attach`, turn, command, UI, tool and session-end events, according to each mod's hook registration.
- `CLAUDE_CODE_PLUGIN_DIRS` points the engine at the registered plugin directories in user settings.
- Lead-wake holds `http://127.0.0.1:7760/chat/wake?session=…&holder=mod` through the engine HTTP API and validates released batches.
- Current session identity, turn lifecycle and handover `{text, clear}` tool arguments.
- Collision-guard reads repository file membership with Git; secrets-veil reads the configured named secret values and tool-result structures.
- Vendored `NOTICE` and `VENDOR.json` files describe upstream provenance, licensing and unchanged-file hashes.

## Outputs

- Lead-wake submits released chat batches through `$.prompt.submit` and then posts delivery receipts to the fixed daemon base with Origin and X-Orch-Chat headers.
- Handover submits text in the same session, or after a requested clear; failed clear drops pending text.
- Collision-guard maintains a per-chat ledger beneath `~/.claude/mods-data/collision-guard/` and emits warnings.
- Delay-no-more changes tool descriptions without file writes; secrets-veil emits masked results or a denial, not the unmasked result on failure.
- No existing `docs/contracts/wire/*` contract describes the orchestrator dashboard/chat or Claude Code mod event protocol.

## Invariants

- Mods load from configured plugin directories, not simultaneously from dev-mods and that list; double registration loads them twice. Source: `ops/bootstrap/permissions-target.mjs`.
- Lead-wake runs only while idle, needs no surface, retries network/5xx failures after five seconds and other refusals after five minutes, and caps post lines at 1500 UTF-8 bytes. Source: `ops/claude-mods/lead-wake/hooks/wake.ts`.
- A replaced or mid-turn poll answer cannot submit, receipt or stop the current hold; generation tagging preserves at-least-once delivery. Source: `ops/claude-mods/lead-wake/hooks/wake.ts`; `ops/claude-mods/lead-wake/tests/wake.test.ts`.
- Before a nonempty wake batch, lead-wake calls `$.session.compact({})` at 40 minutes of proven main-loop idle, with no context-size floor. Unknown age never qualifies. Independent per-session store keys preserve idle evidence and successful compaction across reload: another session cannot evict either, and there is no shared-map read/modify/write. Each session has at most one record; the host's 4 MiB whole-store limit refuses writes rather than evicting records. Main turns invalidate only their session; child events do not. A compact veto does not block the wake: delivery proceeds without compaction, the skip reason is logged, and the idle is recorded as handled so the same idle is not compacted twice. Storage failure leaves delivery pending, with a diagnostic that names the cause and a five-minute retry. Failed writes do not poison later reads; successful compaction is retained locally until persistence recovers, preventing a second compact in the live context. Successful compaction is not repeated after submit failure.
- The handover text is delivered after clear only for a clear session-end, and a refused clear drops pending text. Source: `ops/claude-mods/handover/hooks/register.ts`.
- Secrets-veil fails closed when masking fails; encoded PNG/JPEG/GIF/WEBP/PDF media fields use named-value masking rather than generic entropy masking that corrupts media. Source: `ops/claude-mods/secrets-veil/tests/fail-closed.test.ts`.

## Dependencies

### Internal Modules

- No direct imports of another repository module; local hooks/helpers remain within the plugin trees.
- The orchestrator chat API is an HTTP integration, not a runtime source import.
- `ops-bootstrap` registers the known folders and `ops-harness-kit` packages them; these are consumers, not reverse import dependencies.

### External Libraries

- `claude-code` — engine hook, state, UI, HTTP and command API; its generated plugin types are not tracked.
- `vitest` and `claude-code/testing` — mod test execution and engine mocks.

## Tests

- `ops/claude-mods/lead-wake/tests/wake.test.ts` — idle wake delivery, retry/backoff, stale-poll safety and lifecycle gating without a surface.
- `ops/claude-mods/secrets-veil/tests/register.test.ts` — hook masking and registration behavior.
- `ops/claude-mods/secrets-veil/tests/fail-closed.test.ts` — masking failure/oversize safety.
- `ops/claude-mods/secrets-veil/tests/fail-closed-env.test.ts` — secret-environment failure handling.
- `ops/claude-mods/delay-no-more/tests/patterns.test.ts` — deferred-tool matching patterns.
- Fresh worktrees lack engine-generated `.claude-plugin/types/`; mod typechecking requires those types from an engine-loaded checkout.

### Command

From a prepared mod folder: `claude plugin validate .`, `npx tsc -p . --noEmit`, and `claude plugin test .`.

## Owner

`domain-harness` owns mod integration and local changes; vendored upstream ownership is recorded separately in each mod's NOTICE and VENDOR files.

## Changelog

- Task 2409, slice C, batch 40: documented engine-facing plugin interfaces, safety and lifecycle rules; no plugin behavior changes.
