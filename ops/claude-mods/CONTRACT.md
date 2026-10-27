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
  - ops/claude-mods/orch-board/.claude-plugin/plugin.json
  - ops/claude-mods/secrets-veil/.claude-plugin/plugin.json
  - ops/claude-mods/secrets-veil/.gitignore
entry: ops/claude-mods/orch-board/hooks/register.tsx
layer: harness
---
# Module: ops-claude-mods

## Purpose

Provides the harness's Claude Code mods for the orchestration board, lead handover, and vendored tool-safety integrations.
The mods are engine-loaded plugin folders, not an application-side React or orchestrator library.

## Public API

- `register` (`orch-board/hooks/register.tsx`) — registry-entry Claude Code hook registration: pane lifecycle, `/orch-board`, polling, rendering, chat forms and wake hold.
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
- Orch-board reads JSON from `http://127.0.0.1:7760/api/dashboard` and `/api/chat` through the engine HTTP API; its parsers validate the envelopes.
- Pane surface/body-column dimensions, persisted fold state, native chat form input and handover `{text, clear}` tool arguments.
- Collision-guard reads repository file membership with Git; secrets-veil reads the configured named secret values and tool-result structures.
- Vendored `NOTICE` and `VENDOR.json` files describe upstream provenance, licensing and unchanged-file hashes.

## Outputs

- Desktop orch pane with SVG sections and native controls; terminal/non-desktop surfaces receive a textual summary rather than desktop images.
- Chat post/release HTTP actions use the fixed daemon base with Origin and X-Orch-Chat headers; text is limited to 600 code points.
- Orch-board fold state is stored under `section-open`; dashboard/chat snapshots and forms use engine atoms.
- Handover submits text in the same session, or after a requested clear; failed clear drops pending text.
- Collision-guard maintains a per-chat ledger beneath `~/.claude/mods-data/collision-guard/` and emits warnings.
- Delay-no-more changes tool descriptions without file writes; secrets-veil emits masked results or a denial, not the unmasked result on failure.
- No existing `docs/contracts/wire/*` contract describes the orchestrator dashboard/chat or Claude Code mod event protocol.

## Invariants

- Mods load from configured plugin directories, not simultaneously from dev-mods and that list; double registration loads them twice. Source: `.agents/domains/domain-harness/knowledge/claude-mods-orch-board-pane.md`.
- Automatic pane opening requires a nonempty surface list and an absent pane; first attach retries opening when start had no surface. Source: `ops/claude-mods/orch-board/hooks/register.tsx`; `ops/claude-mods/orch-board/tests/open.test.ts`.
- Only one dashboard request and one chat request may be in flight; unmount/reset does not release a lock owned by a still-pending request. Source: `pollRoute` and `resetPoll` in `ops/claude-mods/orch-board/hooks/register.tsx`.
- Chat 404 stops chat polling and hides the section; failed/unparsed/read-only chat cannot enable writes. Source: `pollRoute` and `noteChat` in `ops/claude-mods/orch-board/hooks/register.tsx`.
- Daemon strings are escaped before SVG embedding; large sections are paginated instead of exceeding image limits. Source: `.agents/domains/domain-harness/knowledge/claude-mods-orch-board-pane.md`; `ops/claude-mods/orch-board/hooks/svg/kinora.ts`.
- The handover text is delivered after clear only for a clear session-end, and a refused clear drops pending text. Source: `.agents/domains/domain-harness/knowledge/claude-mods-orch-board-pane.md` handover section.
- Secrets-veil fails closed when masking fails; encoded PNG/JPEG/GIF/WEBP/PDF media fields use named-value masking rather than generic entropy masking that corrupts media. Source: `.agents/domains/domain-harness/knowledge/claude-mods-orch-board-pane.md`; `ops/claude-mods/secrets-veil/tests/fail-closed.test.ts`.
- A family-logo registry change requires regenerating the plugin-local copy because mods cannot import outside their folder. Source: `.agents/domains/domain-harness/knowledge/claude-mods-orch-board-pane.md`; `scripts/test-orch-family-logo-copy.mjs` (not in this kit).

## Dependencies

### Internal Modules

- No direct imports of another repository module; local hooks/helpers remain within the plugin trees.
- `ops-orchestrator-surface` is an HTTP/data and build-generation integration, not a runtime source import: `orch-board/scripts/prepare.mjs` copies its family-logo registry into the mod.
- `ops-bootstrap` registers the known folders and `ops-harness-kit` packages them; these are consumers, not reverse import dependencies.

### External Libraries

- `claude-code` — engine hook, state, UI, HTTP and command API; its generated plugin types are not tracked.
- `esbuild` — plugin-local generated family-logo source preparation.
- `vitest` and `claude-code/testing` — mod test execution and engine mocks.

## Tests

- `ops/claude-mods/orch-board/tests/open.test.ts` — surface-aware, non-duplicate automatic pane opening.
- `ops/claude-mods/orch-board/tests/parse.test.ts` — dashboard/chat input validation.
- `ops/claude-mods/secrets-veil/tests/register.test.ts` — hook masking and registration behavior.
- `ops/claude-mods/secrets-veil/tests/fail-closed.test.ts` — masking failure/oversize safety.
- `ops/claude-mods/secrets-veil/tests/fail-closed-env.test.ts` — secret-environment failure handling.
- `ops/claude-mods/delay-no-more/tests/patterns.test.ts` — deferred-tool matching patterns.
- `scripts/test-orch-family-logo-copy.mjs` (not in this kit) — generated logo-copy freshness.
- Fresh worktrees lack engine-generated `.claude-plugin/types/`; mod typechecking requires those types from an engine-loaded checkout.

### Command

From a prepared mod folder: `claude plugin validate .`, `npx tsc -p . --noEmit`, and `claude plugin test .`.

## Owner

`domain-harness` owns mod integration and local changes; vendored upstream ownership is recorded separately in each mod's NOTICE and VENDOR files.

## Changelog

- Task 2409, slice C, batch 40: documented engine-facing plugin interfaces, safety and lifecycle rules; no plugin behavior changes.
