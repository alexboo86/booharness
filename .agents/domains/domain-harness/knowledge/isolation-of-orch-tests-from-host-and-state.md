## Isolation of orch tests from host and state

`refuseHostSsh` in `ops/orchestrator/src/providers/spawn.ts` throws before SSH starts in `spawnProvider`/`cloneReady` (`ops/orchestrator/src/remote-repo.ts`) when `ORCH_REFUSE_HOST_SSH=1`. Production does not set it; remote seats do not inherit Mac environment. `scripts/test-orch-seats-lifecycle.mjs` (not in this kit) sets it first. Seat-manager `Options` in `ops/orchestrator/src/seats-defs.ts` expose `hashlineEditFor`, `codexEditFor`, `snapshotRemote` stubs; absent options use real methods.

`scripts/orch-test-state.mjs` (not in this kit) is first import of non-live test-orch files and `runOrchTests` preload (`scripts/check-orch-tests.mjs` (not in this kit)). Without ORCH_STATE_DIR it creates empty temp state removed at exit; explicit directories stay and children inherit. Parent runner does not preload it, so suite-pass records use real state.

The helper disables background git housekeeping through inherited `GIT_CONFIG_COUNT` entries `maintenance.auto=false`/`gc.auto=0`. `scrubbedGitEnv` in `scripts/git-env.mjs` preserves only those `GIT_CONFIG_*` keys via `HOUSEKEEPING_CONFIG_KEYS`. Production git does not load the preload.

`runOrchTests` in `scripts/check-orch-tests.mjs` (not in this kit) holds state-dir `orch-tests.lock` around one test child, with half-core concurrency, minimum 2 (`orchTestConcurrency`). The child is `node --import <orch-test-state.mjs URL> scripts/orch-test-run.mjs` (`scripts/orch-test-run.mjs` not in this kit) (node:test `run()`, process isolation, the same argv shape as `node --test`, exit 1 unless the summary succeeds); it dequeues the selected `SLOW_FIRST_TESTS` first in list order, then the rest sorted (task 3023 C8b). Waiters report the holder every 30 s and fail after 20 minutes naming the lock. Records hold pid, OS start time (`born`/`processBorn` in `ops/orchestrator/src/lock.ts`) and detached child process group. Matching live pid or live group keeps ownership; reused pid frees it. Stale removal serializes through `orch-tests.lock.steal` and rereads the record under that guard.

verified: 2026-09-23

Check: `node --test scripts/test-check-orch-tests-lock.mjs` (`scripts/test-check-orch-tests-lock.mjs` not in this kit)

