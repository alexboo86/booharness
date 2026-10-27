---
id: ops-bootstrap
owner: domain-harness
paths:
  - ops/bootstrap/CONTRACT.md
  - ops/bootstrap/agent-instructions.md
  - ops/bootstrap/codex-trust.json
  - ops/bootstrap/doctor.mjs
  - ops/bootstrap/domain-skills.json
  - ops/bootstrap/family-logins.json
  - ops/bootstrap/githook-shim.sh
  - ops/bootstrap/harness-config.mjs
  - ops/bootstrap/harness-login.mjs
  - ops/bootstrap/harness-secret.mjs
  - ops/bootstrap/harness.config.json
  - ops/bootstrap/install-git-hooks.mjs
  - ops/bootstrap/install-harness-args.mjs
  - ops/bootstrap/install-harness.mjs
  - ops/bootstrap/install-lock.mjs
  - ops/bootstrap/install-memory.mjs
  - ops/bootstrap/json-context-wrap.mjs
  - ops/bootstrap/lead-probe.txt
  - ops/bootstrap/lead-probe2.txt
  - ops/bootstrap/marked-blocks.mjs
  - ops/bootstrap/mcp-config-target.mjs
  - ops/bootstrap/mcp-role-gate.mjs
  - ops/bootstrap/mcp-servers.json
  - ops/bootstrap/mcp-servers.operator.json
  - ops/bootstrap/mcp-tool-baseline.json
  - ops/bootstrap/ollama-setup.mjs
  - ops/bootstrap/orch-dependencies.mjs
  - ops/bootstrap/owned-entries.mjs
  - ops/bootstrap/package.json
  - ops/bootstrap/permissions-lib.mjs
  - ops/bootstrap/permissions-target.mjs
  - ops/bootstrap/permissions.json
  - ops/bootstrap/provision-worktree.sh
  - ops/bootstrap/resolve-runtime-path.mjs
  - ops/bootstrap/rtk-commands.json
  - ops/bootstrap/rtk-config-target.mjs
  - ops/bootstrap/secret-bindings.mjs
  - ops/bootstrap/skill-entry.mjs
  - ops/bootstrap/team-presets.json
  - ops/bootstrap/test-rtk-rewrite-plus.mjs
  - ops/bootstrap/tool-pins.json
  - ops/bootstrap/toolset.json
  - ops/bootstrap/verify-memory-transfer.mjs
  - ops/bootstrap/win-task.mjs
  - ops/bootstrap/windows-bringup.ps1
  - ops/bootstrap/windows-user-path.mjs
  - ops/bootstrap/wizard-steps/families.mjs
entry: ops/bootstrap/resolve-runtime-path.mjs
layer: harness
---
# Module: ops-bootstrap

## Purpose

Installs and configures the agent harness, permission rules, runtime discovery and managed assets.
It owns installation policy, not runtime hook execution (`ops-bootstrap-hooks`), context routing (`ops-bootstrap-routing`), the orchestrator's seat lifecycle or the memory database implementation.

## Public API

The registry entry `resolve-runtime-path.mjs` exposes canonical runtime discovery:

- `canonicalSearchDirs` — platform-specific ordered runtime search directories.
- `resolveOnPath` — first existing executable candidate, or null.
- `requiredCliNames` — deduplicated CLI requirements for enabled families.
- `REQUIRED_PROVIDERS`, `FAMILY_CLI_NAMES` — shared provider/family CLI policy.
- `pinnedPi` — installed pinned Pi package entry, or an error for an invalid installation.
- `resolveProviders` — found providers, missing providers and canonical search directories.
- `resolveRequiredProviders` — provider resolution that throws if a required provider is absent.
- `formatSearchPath`, `posixSearchPath` — canonical search directories formatted for native or POSIX consumers.

Other production consumers import these helpers directly (paths below are within `ops/bootstrap/`):

- `currentUserSid` (`win-task.mjs`) — obtains the Windows account SID or throws.
- `renderTaskXml` (`win-task.mjs`) — renders scheduled-task XML.
- `queryTask` (`win-task.mjs`) — queries a scheduled task and returns command status/output.
- `endTask` (`win-task.mjs`) — ends a scheduled task and returns command status/output.
- `createTask` (`win-task.mjs`) — creates a scheduled task from XML.
- `runTask` (`win-task.mjs`) — starts a scheduled task.
- `deleteTask` (`win-task.mjs`) — deletes a scheduled task.
- `secretBindings` (`secret-bindings.mjs`) — validates server secret declarations and returns environment bindings.

Outside consumers include `ops/orchestrator/install.mjs`, `ops/harness-kit/build-kit.mjs` (not in this kit) and memory tooling.
Operator CLI entrypoints include `install-harness.mjs`, `install-memory.mjs`, `doctor.mjs`, `harness-config.mjs`, `harness-login.mjs` and `harness-secret.mjs`.
This ownership-only split preserves existing direct-helper imports; it adds no facade or importer rewrite.

`node ops/bootstrap/ollama-setup.mjs setup` configures the macOS embedding service
and proves embedding against the configured endpoint. It requires the pinned,
agent-installed managed binary; it does not install prerequisite tools. It
preserves answering servers, refuses unanswered remote replacements and foreign
paths/units, and verifies pinned default GGUF size/hash before model creation.

## Inputs

- `harness.config.json`, permissions/MCP/family/domain routing manifests, enabled family policy, secret bindings and installer command-line flags.
- Existing user JSON/TOML settings, installer ownership manifest, home directory and installed tool paths; user-owned entries are not assumed to belong to this harness.
- Memory service, package/tool installers and platform task/service managers are integration boundaries.

## Outputs

- Managed settings, hooks, skills, MCP config, runtime wrappers and memory service/task configuration in the selected home/state directories.
- Installer diagnostics, doctor results and installed-entry ownership JSON; installer lock is scoped to the target home.
- No existing `docs/contracts/wire/*` document specifies these harness config formats.

## Invariants

- Installer arguments are validated before any step; malformed/unknown flags exit 2 without writes, while help exits 0 without steps. Source: `.agents/domains/domain-harness/knowledge/contract-ownership-and-installer.md`; `scripts/test-install-harness-safety.mjs` (not in this kit).
- One installer owns a target home at a time: a live PID lock refuses, and release removes only the current run's published lock. Source: `.agents/domains/domain-harness/knowledge/contract-ownership-and-installer.md`; `scripts/test-install-lock.mjs` (not in this kit).
- Keep-mode ownership is tracked by canonical target path; a failed target write must not orphan previously installed entries. Source: `.agents/domains/domain-harness/knowledge/contract-ownership-and-installer.md`; `scripts/test-install-owned-entries.mjs` (not in this kit).
- Invalid config/target JSON refuses before settings or ownership writes; MCP batch publication restores committed configs and ownership on failure. Source: `.agents/domains/domain-harness/knowledge/contract-ownership-and-installer.md`; `scripts/test-install-permissions-keep.mjs` (not in this kit) and `scripts/test-install-mcp-keep.mjs` (not in this kit).
- Hook migration removes/repoints only recognized harness command forms, preserving composed or otherwise user-owned commands. Source: `.agents/domains/domain-harness/knowledge/contract-ownership-and-installer.md` hooks ownership section.

## Dependencies

### Internal Modules

Observed imports resolved through the generated registry:

- `ops-bootstrap-hooks` — lead-hook registration and RTK shell parsing; installation configures hooks but does not own their execution.
- `scripts-lib-harness` — harness configuration and family login policy.
- `scripts-lib-platform-shell` — main-entry detection, domain mapping and memory installation/forwarding helpers; lightweight domain resolution does not import a command gate.
- `scripts-runtime-shared` — sanitized Git execution and installer skill-state helpers from `scripts/git-env.mjs`.
- `scripts-memory-core` — memory clients/schema and embedding recipe.
- `ops-tools` — memory backup operations.
- `ops-orchestrator-shared` — dynamically loaded config, leads, language, guard and platform integration helpers.

### External Libraries

- `yaml` — manifest parsing; Node.js built-ins provide process, filesystem, HTTP, crypto and SQLite support.
- Runtime CLIs, service managers, Git, npm and uv are installer prerequisites/invocations, not bundled API dependencies.

## Tests

- `scripts/test-install-harness-safety.mjs` (not in this kit) — no-write refusals and safe marked-config handling.
- `scripts/test-install-lock.mjs` (not in this kit) — mutual exclusion and stale-lock recovery.
- `scripts/test-install-owned-entries.mjs` (not in this kit) — keep-mode ownership and failure safety.
- `scripts/test-install-permissions-keep.mjs` (not in this kit) — permission preservation and invalid-target refusals.
- `scripts/test-install-mcp-keep.mjs` (not in this kit) — MCP preservation, retirement and rollback.
- `scripts/test-resolve-runtime-path.mjs` (not in this kit) — platform runtime discovery and family requirements.

### Command

`node scripts/test-resolve-runtime-path.mjs` (`scripts/test-resolve-runtime-path.mjs` not in this kit)

## Owner

`domain-harness` owns installation; the owner knowledge page and its installer part define policy.

## Changelog

- Task 2409, slice C, batch 40: documented existing installation/context APIs and observed dependencies; no installer or hook changes.
- Task 3141, slice B: split routing and runtime hooks into separate ownership contracts; retain installer/helpers/assets and select the existing runtime-discovery entry. No code or file moves.
