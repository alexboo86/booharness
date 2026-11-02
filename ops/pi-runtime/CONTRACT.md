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
| override `undici` | Exact `8.12.3` (task 3354): Pi 1.4.0 itself pins undici `8.10.2` exactly, which npm audit rates high (GHSA-4qv8-2p9j-2685 et al., first patched 8.12.2); only an override clears it while the Pi pin stays put. |

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
- Gitignored per-machine switch state beside it (`current.json`, `versions/<version>` trees) is read by the adapter's resolver; this module installs none of it (task 3536).
- Pi's transitive runtime dependencies; this module owns no seat transcript or session state.

## Invariants

- The runtime package is private and pins Pi to an exact version. Source: `package.json`; `package-lock.json`.
- The `overrides` map pins `undici` to the exact patched `8.12.3`; the Pi pin itself does not move (a pin change needs every host installed first — lesson #17884). Source: `package.json` (`overrides`).
- Pi stays outside `ops/orchestrator/package.json` so seat-worktree daemon installs do not reinstall it. Source: `package.json` (`description`); `ops/orchestrator/package.json`.
- A seat start requires the resolved runtime binary and its installed manifest: the repo pin, or — task 3536 — a `current.json` switch above the pin whose `versions/<version>` tree validates. A missing or mismatched install refuses rather than falling back to PATH, and a broken switch refuses rather than falling back to the repo pin. Source: `ops/orchestrator/src/providers/pi.ts` (`assertPiRuntime`, `resolvePiInstall`).
- The runtime install and adapter configuration are separate prerequisites; installing this package alone does not provision the adapter's MCP/trust resources. Source: `ops/orchestrator/src/providers/pi.ts` (`open`, adapter version checks).

## Dependencies

### Internal Modules

- No repository source imports; only package/lock metadata is owned here.
- `ops-orchestrator-providers` and `ops-ab-stand` consume the installation, not vice versa.

### External Libraries

- `@earendil-works/pi-coding-agent` `1.4.0` and its lock-resolved dependencies.
- Node.js and npm; host configuration and credentials remain outside this module.

## Tests

- `scripts/test-orch-providers.mjs` (not in this kit) — exercises Pi start/resume with a fixture runtime root and installed metadata.
- `scripts/test-orch-remote-pi-mcp-live.mjs` (not in this kit) — opt-in live remote probe using the pinned host binary.
- No package-local test script exists.
- Installation command: `npm ci --prefix ops/pi-runtime`; this mutates the host install and requires registry access.

## Owner

`domain-harness`; the provider module owns runtime validation and launch policy.

## Changelog

- Task 3354 step (a): add exact-version `overrides` for `undici` `8.12.3`; Pi stays `1.4.0`; `npm audit --omit=dev` now reports 0 high / 0 critical (2 no-fix moderates remain).
- Task 2409 slice C: document the existing shared installation and version boundary; no pin or rollout change.
- Task 3536 slice A: document the beside-the-pin switch state (`current.json` and `versions/<version>`, both gitignored and left alone by `git clean -fdq` and `npm ci --prefix ops/pi-runtime`); resolution lives in the providers module, and this module has no install job for the tree.
