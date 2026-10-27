---
id: ops-pi-runtime
owner: domain-harness
paths:
  - ops/pi-runtime/**
entry: ops/pi-runtime/package.json
layer: harness
---
## Purpose

Pins the shared Pi runtime used by orchestration worker seats without installing a separate runtime in every seat worktree.

## Public API

This module has no source exports; its package and lockfile form an installation API.

Consumers include `ops/orchestrator/src/providers/pi.ts` and
`ops/ab-stand/pi-runtime.mjs`.

### Wire names

| Interface | Description |
|---|---|
| `orch-pi-runtime` | Private npm package identity for the shared worker installation. |
| `@earendil-works/pi-coding-agent` | Exact `1.4.0` dependency providing the Pi CLI and SDK. |

The provider adapter resolves the repository-local installed binary, not an
arbitrary `pi` on PATH.

## Inputs

- `package.json` supplies the expected exact Pi version.
- `package-lock.json` supplies resolved packages and integrity values to `npm ci`.
- Host npm installation environment and registry access.
- The adapter independently supplies session arguments, MCP configuration, trust policy and extensions.

## Outputs

- Shared installed Pi binary at `ops/pi-runtime/node_modules/.bin/pi` (Windows shim on Windows).
- Installed package metadata used by the adapter's version probe.
- Pi's transitive runtime dependencies; this module owns no seat transcript or session state.

## Invariants

- The runtime package is private and pins Pi to an exact version. Source: `package.json`; `package-lock.json`.
- Pi stays outside `ops/orchestrator/package.json` so seat-worktree daemon installs do not reinstall it. Source: `package.json` (`description`); `ops/orchestrator/package.json`.
- A seat start requires the expected local binary and an installed version equal to this package's pin; mismatch refuses rather than falling back to PATH. Source: `ops/orchestrator/src/providers/pi.ts` (`assertPiRuntime`, `piRuntimeLayout`).
- The runtime install and adapter configuration are separate prerequisites; installing this package alone does not provision the adapter's MCP/trust resources. Source: `ops/orchestrator/src/providers/pi.ts` (`open`, adapter version checks).

## Dependencies

### Internal Modules

- No repository source imports; only package/lock metadata is owned here.
- `ops-orchestrator-providers` and `ops-ab-stand` consume the installation, not vice versa.

### External Libraries

- `@earendil-works/pi-coding-agent` `1.4.0` and its lock-resolved dependencies.
- Node.js and npm; host configuration and credentials remain outside this module.

## Tests

- `scripts/test-orch-providers.mjs` — exercises Pi start/resume with a fixture runtime root and installed metadata.
- `scripts/test-orch-remote-pi-mcp-live.mjs` — opt-in live remote probe using the pinned host binary.
- No package-local test script exists.
- Installation command: `npm ci --prefix ops/pi-runtime`; this mutates the host install and requires registry access.

## Owner

`domain-harness`; the provider module owns runtime validation and launch policy.

## Changelog

- Task 2409 slice C: document the existing shared installation and version boundary; no pin or rollout change.
