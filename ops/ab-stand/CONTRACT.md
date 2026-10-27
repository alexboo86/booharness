---
id: ops-ab-stand
owner: domain-harness
paths:
  - ops/ab-stand/**
  - ops/ab-stand/.gitignore
entry: ops/ab-stand/codex-edit-install.mjs
layer: harness
---
# Module: ops-ab-stand

## Purpose

Provides isolated, pinned experiment arms and measurement tools for comparing agent runtimes and extensions without changing live worker profiles.
The pinned edit installers also serve stock orchestrator seats; their default prefix is not an isolated stand prefix.

## Public API

There is no single barrel. The registry entry is the shared codex-edit installer; its exports are:

- `CODEX_EDIT_PINS` — committed package, integrity, configuration and resource pins from `codex-edit.json`.
- `CODEX_EDIT_PACKAGE` — pinned npm package/version specifier.
- `CODEX_EDIT_INTEGRITY` — expected published tarball integrity.
- `CODEX_EDIT_CONFIG` — required extension configuration, including eligible models.
- `CODEX_EDIT_FILES` — required package resources.
- `CODEX_EDIT_HASHES` — expected resource digests.
- `CODEX_EDIT_PACKAGE_DIRECTORY` — extension directory relative to the install prefix.
- `stockCodexEditPrefix` — resolves the shared stock prefix beneath the orchestrator state directory.
- `codexEditExtension` — resolves the extension entry path for a prefix.
- `assertRealDir` — rejects absent, non-directory and symlink/junction directories.
- `contained` — validates a target below a real prefix, rejecting escape and linked ancestors.
- `writeContained` — writes a containment-checked file and sets mode 0600.
- `removeContained` — removes a containment-checked target without traversing links.
- `codexEditProblem` — returns a verification failure string, or null for a verified prefix.
- `verifiedTarball` — obtains an integrity-verified cached npm tarball.
- `npm` — runs npm with the platform-specific invocation used by the installers.
- `ensureCodexEdit` — installs/verifies the pinned extension and returns its readiness result.

`ops/orchestrator/src/codex-edit.ts` invokes the entry as a subprocess, not an ESM facade.
`scripts/orch-seats-test-helpers.mjs` (not in this kit) imports the stock-prefix and verification helpers.
The other operator entrypoints are `install.mjs`, `smoke.mjs`, `run.mjs`, `report.mjs`, `metrics.mjs` and `edit-metrics.mjs`; see `ops/ab-stand/README.md` for their commands.
`scripts/test-ab-stand*.mjs` additionally import the scoring, arm, authentication, matrix, reporting and observation-mask helpers directly; these are not an application runtime facade.

## Inputs

- Entry CLI: `--ensure [--prefix DIR] [--force]` or `--check --prefix DIR`; absent prefix uses the stock state directory, with `ORCH_STATE_DIR` overriding its root.
- Committed arm JSON, npm lockfiles, hash-pinned Python requirements and fixture/truth data select reproducible installations and measurements.
- Stand commands consume an isolated stand root, checkout, arm/model/fixture selection, repetition limits, auth material and raw seat transcripts.
- Installer verification reads installed package metadata, dependency integrity, configuration and resource hashes; installation fetches pinned registry tarballs.
- Matrix execution reads live orchestrator readiness, provider limits, authentication and usage evidence rather than substituting an estimated successful run.

## Outputs

- Entry stdout is one JSON result with `ok`, `prefix` and readiness fields (`extension`, `models`, `installed`) or `reason`; failure exits 1.
- Installers write isolated arm prefixes when explicitly supplied; the stock installer can write the shared stock prefix.
- Stand runs create per-cell checkout/session artifacts, raw usage/tool evidence and result rows; reports aggregate these into operator-readable comparisons.
- `metrics.mjs` reads orchestrator usage data; `edit-metrics.mjs` summarizes editing outcomes from recorded sessions.
- No existing `docs/contracts/wire/*` document owns this tooling's JSON result or transcript formats.

## Invariants

- Managed install targets stay below a real prefix: writes reject linked components/escapes; removal can unlink a linked leaf but refuses linked ancestors. The separately checked tarball cache may be outside the prefix. Source: `ops/ab-stand/codex-edit-install.mjs` containment helpers and `verifiedTarball`.
- A verification refusal is a reason string, not an uncaught containment exception; `--check` prints a verdict and performs no repair. Source: `codexEditProblem` and the entry CLI in `ops/ab-stand/codex-edit-install.mjs`.
- Downloaded codex-edit tarballs must match the committed integrity before installation. Source: `verifiedTarball` in `ops/ab-stand/codex-edit-install.mjs`.
- Stand extension installations use pinned arm-local state rather than changing stock worker profiles. Source: `.agents/domains/domain-harness/knowledge/isolated-a-b-stand-task-1452.md` and `ops/ab-stand/README.md`.
- Readiness/smoke evidence is arm-specific: package presence alone does not prove the replaced tool or MCP operation worked. Source: `.agents/domains/domain-harness/knowledge/isolated-a-b-stand-task-1452.md`.

## Dependencies

### Internal Modules

Direct import targets, resolved against the generated module registry (the unchanged header does not yet enumerate these):

- `ops-orchestrator-runtime` — profile/limit handling, stand checks, store and usage statistics.
- `ops-orchestrator-providers` — Pi runtime resolution and provider creation.
- `ops-tools` — usage snapshot parsing from `ops/usage-snapshot.mjs`.
- `ops-bootstrap` — `lesson-probe.mjs` dynamically loads code-intelligence ordering helpers and invokes their hook.

### External Libraries

- `typescript` — scorer syntax analysis.
- Node.js built-ins and host `git`, npm, uv and provider CLIs — process, filesystem and isolated runtime installation.
- Pi and the explicitly pinned arm packages — experimental runtimes/extensions, not ambient package versions.

## Tests

- `scripts/test-ab-stand.mjs` (not in this kit) — matrix planning, guards, authentication, fixture scoring and report behavior.
- `scripts/test-ab-stand-metrics.mjs` (not in this kit) — usage metric formatting and selection.
- `scripts/test-ab-stand-edit-metrics.mjs` (not in this kit) — edit failure classification and session metrics.
- `scripts/test-ab-stand-obs-mask.mjs` (not in this kit) — observation masking behavior.
- `scripts/orch-seats-test-helpers.mjs` (not in this kit) verifies an existing stock prefix as fixture preparation; it is not an install/check regression test.
- No dedicated installer behavior test was found for the entry's containment and tarball verification; those guarantees above are code-sourced.

### Command

`node --test scripts/test-ab-stand-metrics.mjs scripts/test-ab-stand-edit-metrics.mjs scripts/test-ab-stand-obs-mask.mjs` (`scripts/test-ab-stand-metrics.mjs` not in this kit, `scripts/test-ab-stand-edit-metrics.mjs` not in this kit, `scripts/test-ab-stand-obs-mask.mjs` not in this kit)

## Owner

`domain-harness` owns the stand, shared pinned installers and this contract; experiment workflow lives in `ops/ab-stand/README.md`.

## Changelog

- Task 2409, slice C, batch 40: documented existing tooling interfaces and isolated-versus-stock installation boundaries; no runtime change.
