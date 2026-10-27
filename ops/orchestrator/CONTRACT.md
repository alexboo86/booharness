---
id: ops-orchestrator
owner: domain-harness
paths:
  - ops/orchestrator/CONTRACT.md
  - ops/orchestrator/README.md
  - ops/orchestrator/TASKS-BOARD.md
  - ops/orchestrator/build-gate-launcher.rs
  - ops/orchestrator/code-hash.mjs
  - ops/orchestrator/desktop-run.mjs
  - ops/orchestrator/install.mjs
  - ops/orchestrator/mcp-by-role.json
  - ops/orchestrator/package-lock.json
  - ops/orchestrator/package.json
  - ops/orchestrator/remote-exec.mjs
  - ops/orchestrator/ste/**
  - ops/orchestrator/suite-pass.mjs
  - ops/orchestrator/tsconfig.json
  - ops/orchestrator/worktree-setup.json
entry: ops/orchestrator/suite-pass.mjs
layer: harness
---
## Purpose

Provides orchestration service installation, remote execution, build-gate tooling, and supporting configuration outside the daemon runtime and its provider adapters.

## Public API

The registry entry is `suite-pass.mjs`; runtime startup and the test selector
consume it. The supporting tools also have real callers across the module boundary.

| Symbol / command | Description |
|---|---|
| `isOrchTest` | Selects non-live orchestration test filenames. |
| `orchSuiteTests` | Lists the checkout's sorted non-live suite. |
| `suiteInputs` | Resolves per-test import/file-literal inputs, including role-default skills. |
| `suiteHash` | Hashes restart-relevant suite inputs and absent-file markers. |
| `suitePassFile` | Names the state directory's suite receipt. |
| `writeSuitePass` | Atomically publishes a successful suite hash with time and repository. |
| `suitePassRefusal` | Returns a restart refusal, or null for a matching receipt. |
| `relativeImportFiles` | `code-hash.mjs` file/import closure reader used by suite input selection. |
| `codeHash` | `code-hash.mjs` daemon-code fingerprint consumed by runtime startup. |
| `parseHeader` | `remote-exec.mjs` validates the first JSON input line. |
| `seatEnvironment` | Builds remote child environment without trusting a seat-supplied build gate; applies the review-role small-target cargo defaults (task 2861 C) where the host env sets neither. |
| `jobwrap` | Resolves/builds the cached Windows process-tree wrapper, or returns null off Windows. |
| `vcvarsToolchain` | Captures/caches the Windows compiler environment for remote children. |
| `run` | Remote-execution CLI implementation; streams subsequent stdin to one provider. |
| `node src/main.ts check-on <host> [--repo <lead checkout>] -- <command...>` | Snapshots a lead checkout through the daemon, reuses its host scratch checkout, provisions changed dependency locks and streams a managed check with its exit code; no commit stamp or local fallback. |

Production consumers include `src/main.ts`, `src/seat-guard.ts`, and
`scripts/check-orch-tests.mjs`; the remote launcher is invoked by provider spawning.

## Inputs

- Checkout/test bytes, optional content overrides and role-default skill map.
- With `allowMissing` and file-literal discovery, explicit null content overrides
  retain edges to known absent inputs; arbitrary missing literals are not inputs.
- State directory, prior `orch-suite-pass.json`, service configuration and host toolchain.
- Remote stdin: one JSON header with exactly command, args, cwd and env fields, then raw provider stdin; env may be an empty object.
- The remote header is limited to 64 KiB; the host, not the header, chooses its build-gate path.

## Outputs

- SHA-256 code/suite fingerprints, selected test inputs and atomic suite receipt JSON.
- Restart refusal text with a remediation command.
- Host service definitions, build-gate resources and remote child stdio/exit status.
- Windows helper binary cached by source hash beneath the host's state directory.

## Internals

These installer helpers are file-level exports of `ops/orchestrator/install.mjs`,
not re-exports of the registered entry:

| Helper | Description |
|---|---|
| `daemonPath` | Installer resolves daemon launch PATH directories. |
| `renderPlist` | Installer produces the macOS launchd definition. |
| `renderTaskXml` | Installer produces the Windows scheduled-task definition. |
| `freshness` | Installer compares installed/running daemon code evidence. |
| `installOrchestrator` | Installs/removes/reconciles host service resources. |

## Invariants

- A missing, unreadable or mismatched suite receipt refuses restart; only the current input hash passes. Source: `suite-pass.mjs`; `scripts/test-check-orch-tests-select.mjs`.
- Knowledge Markdown and Git metadata do not invalidate the shared restart hash; executable inputs, fixtures and skills still do. Source: `suite-pass.mjs` (`suiteHash`).
- Receipt publication uses a temporary file and rename, not a partially written final record. Source: `suite-pass.mjs` (`writeSuitePass`).
- Remote header validation precedes spawning; build-gate ownership stays on the execution host. Source: `remote-exec.mjs`; `scripts/test-orch-remote.mjs`.
- Worktree backups keep 14 days (operator decision #19671): an entry directly under `stateDir/worktree-backups` whose newest content is older goes, except a file named by the marker of a removal still in progress (`autoPruned` set, `worktreeRemoved` not true; sampled at the deletion moment); a finished marker protects nothing and a symlinked entry is never followed. Source: `src/backup-sweep.ts`, `src/prune.ts` (`protectedBackupPaths`); `scripts/test-orch-backup-sweep.mjs`.
- Remote stdin disconnect kills the child tree; Windows commands use the job wrapper rather than silently running unwrapped. Source: `remote-exec.mjs`; `scripts/test-orch-remote-exec-disconnect.mjs`.
- Lead checks refuse merges and snapshots above 256 MiB, serialize each host/lead run with a named state-directory lock, and mutate shared clones only through the daemon's host queue. Source: `src/check-on.ts`, `src/remote-repo.ts`; `scripts/test-orch-check-on.mjs`.

## Dependencies

### Internal Modules

- `ops-orchestrator-shared` — host/state configuration, role policy, build-gate classification and environment/shims.
- `ops-orchestrator-providers` — command resolution for remote execution.
- `ops-bootstrap` — runtime-path discovery and Windows task management.
- `scripts-lib-harness` — canonical harness configuration and service naming.
- `ops-orchestrator-jobwrap` — Windows executable built by the remote launcher, not a JavaScript import.

### External Libraries

- Node.js built-ins, Git, SSH, host service managers and Rust/Cargo for Windows helper builds.
- `@modelcontextprotocol/sdk` `1.32.1` is installed by this package for the sibling daemon runtime.

## Tests

- `scripts/test-check-orch-tests-select.mjs` — suite input selection and restart receipt invalidation.
- `scripts/test-orch-remote.mjs` — remote header, environment and launch behavior.
- `scripts/test-orch-remote-exec-disconnect.mjs` — child lifetime on stdin disconnect; Windows builds the helper first.
- `scripts/test-orch-install.mjs` — host installer definitions and activation behavior.
- `scripts/test-orch-backup-sweep.mjs` — worktree-backup retention, marker protection and dry-run behavior.
- Narrow receipt check: `node scripts/test-check-orch-tests-select.mjs`.

## Owner

`domain-harness`; daemon implementation and provider adapters are separate modules despite sharing this directory.

## Changelog

- Task 2409 slice C: document existing support-tool and restart-proof interfaces; no change to gate policy.
