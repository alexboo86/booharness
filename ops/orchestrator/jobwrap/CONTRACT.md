---
id: ops-orchestrator-jobwrap
owner: domain-harness
paths:
  - ops/orchestrator/jobwrap/**
  - ops/orchestrator/jobwrap/.gitignore
entry: ops/orchestrator/jobwrap/src/main.rs
layer: crate
---
## Purpose

Runs a remote Windows command inside a kill-on-close Job Object so its process tree cannot outlive the wrapper or its supervising parent.

## Public API

| Interface | Description |
|---|---|
| `orch-jobwrap` | Windows executable taking `<program> [args...]`, inheriting stdio and returning the command's exit code. |

There is no Rust library export. `ops/orchestrator/remote-exec.mjs` builds
and launches this binary for remote Windows commands.

## Inputs

- Program and arguments from the remote launcher, preserved as Windows wide strings.
- Inherited stdin, stdout, stderr and environment.
- The wrapper's actual parent process, discovered through the Windows process snapshot.
- Windows Job Object and process synchronization facilities.

## Outputs

- The child process's inherited stdio without an extra framing protocol.
- Child exit code on normal completion.
- Exit 2 and usage text if no program is supplied.
- Exit 1 with a Win32 error diagnostic when required job/process setup fails.
- Termination of surviving job members when the wrapper exits or loses its parent.

## Internals

The source's private `main` is the executable entry, not an importable API.

## Invariants

- The helper is Windows-only; non-Windows compilation is explicitly refused. Source: `src/main.rs` (`compile_error!`).
- The wrapper joins its kill-on-close job before creating the child, so a child cannot spawn an unassigned grandchild in that interval. Source: `src/main.rs` (`AssignProcessToJobObject` before `CreateProcessW`).
- The job uses `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; closing its last handle kills surviving descendants, including orphaned branches. Source: `src/main.rs`.
- Failure to find/open the parent refuses launch instead of creating an unsupervised child. Source: `src/main.rs` (`parent_pid`, `OpenProcess`).
- The wait observes both child and parent; parent loss exits the wrapper and closes its job handle. Source: `src/main.rs` (`WaitForMultipleObjects`).
- Argument quoting follows MSVCRT rules, including empty arguments, quotes and trailing backslashes. Source: `src/main.rs` (`push_quoted`).

## Dependencies

### Internal Modules

- No repository source imports; `ops-orchestrator` is the executable's consumer and build owner.
- The remote launcher's cache key includes Cargo manifests and this source.

### External Libraries

- `windows-sys` `0.59` — JobObjects, Threading, ToolHelp, Console, Foundation and Security bindings.
- Rust standard library and Windows kernel process/handle APIs.

## Tests

- `scripts/test-orch-remote-exec-disconnect.mjs` — checks remote child shutdown on stdin disconnect; on Windows it prebuilds this helper.
- That integration test is not an independent assertion of every Job Object or quoting invariant.
- No module-local Rust unit test exists.
- Windows build check: `cargo check --manifest-path ops/orchestrator/jobwrap/Cargo.toml`.
- Non-Windows refusal is intentional; running that build on Linux cannot verify the Windows implementation.

## Owner

`domain-harness`; changes require preserving the remote launcher's process-lifetime boundary.

## Changelog

- Task 2409 slice C: document existing Windows executable and fail-closed lifetime rules; no code change.
