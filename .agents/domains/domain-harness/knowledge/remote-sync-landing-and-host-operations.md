## Remote sync, landing, and host operations

Remote coder turns run bounded `snapshotBack`/`syncMirror` before local observation.
Failed sync is recorded, not treated as current bytes; claimed checks rerun on the
host (`ops/orchestrator/src/seats-provision.ts`, `ops/orchestrator/src/seats-verify.ts`,
`ops/orchestrator/src/check-verify.ts`). Landing requires safe mirror proof and refuses
introduced CRLF/LF drift unless base attributes exempt it. Closed landed mirrors prune
only after the landing check (`ops/orchestrator/src/land.ts`, `ops/orchestrator/src/prune.ts`).

A failed host removal permits mirror landing only after `remoteCleanupPending` clears,
a durable close event later than every turn end proves the snapshot, and mirror/snapshot
trees match; ambiguity refuses. The answer carries `hostCheckoutNeedsRemoval` and
`remoteRemoveError`. Pending close answers/refusals name its start time;
`seat.close_waiting` and `seat.close_now_start` distinguish chain wait from close start
(`ops/orchestrator/src/land.ts`, `ops/orchestrator/src/http.ts`,
`ops/orchestrator/src/seats-close.ts`).

`matchesBase` allows dirty/staged target paths only when raw bytes equal base checkout
filter output, and index blob/mode and file type/mode equal base. Recovery restores the
seat base. Both preflight passes raw-check status-clean regular patch paths too; only
symlinks/gitlinks skip. Size is checked before reading. Host line-ending drift checks
precede preflight over every patch path; `--literal-pathspecs` prevents glob aliasing,
and missing/multiple/non-stage-0/unexpected-mode index entries refuse. Raw base bytes
with an index still at HEAD refuse with a quoted git-add remedy; land never stages the
path itself (`baseState`, `lineEndingDrift`, `ops/orchestrator/src/land.ts`).

Windows remote commands run in `orch-jobwrap`, a KILL_ON_JOB_CLOSE Job Object ending
with the command or parent and killing descendant branches. `ops/orchestrator/remote-exec.mjs`
builds by crate source hash with locked offline release cargo into `<stateDir>/jobwrap/bin`
and passes `ORCH_JOBWRAP`; build/start failure never falls back unwrapped
(`ops/orchestrator/jobwrap/src/main.rs`). Each Windows Pi bash uses `spawnHook` for its
own job; `user_bash` is not wrapped (`ops/orchestrator/src/pi-extension.ts`).

The Machines panel reads local CPU in-process, background vm_stat memory with age,
and macOS Available decimal GB; host probes use placement CPU/memory and statfs GiB.
`REFRESH_AFTER_MS` is 5 s, one background probe per machine, kill timeout 10 s; the board
shows stale/probing state without waiting. Failure is unreachable, never 0%; malformed
hosts.json does not remove the local card (`ops/orchestrator/src/machine-load.ts`,
`ops/orchestrator/src/placement.ts`). Seat host chips distinguish mac/remote; `local` and
`mac` are reserved names (`ops/orchestrator/src/dashboard.ts`, `ops/orchestrator/src/config.ts`).

Before listening, recovery removes orphan host worktrees/local mirrors without seat
rows (5 s per host, failures logged, dirty mirrors kept)
(`ops/orchestrator/src/seats-recover.ts`). Failed sync records owed reviewers in
`data.deferredReplacements`; the next successful coder sync creates them once and close
drops the deferred recheck (`ops/orchestrator/src/seats-close.ts`).

`finishRemoteClose` stops removal replay on definite absent directory or three failed
attempts with it present, recording `remoteCleanupStopped: {reason, at}`. Unknown probes
do not count. This is not `remoteRemoved`: cleanup remains outstanding, failure remains,
and nothing is certified/deleted; no automatic or seat_close retry clears it.
Recovery probes stopped closed coders once per restart. Only absent invokes
`dropGoneRegistration`, under the host-clone lock, with one 60 s deadline including queue
wait. Zero gitdir matches succeeds; multiple matches or a reappeared directory refuses.
Unknown/HostTimeout skips that host for the rest of the pass. The row records
`remoteCheckoutGone: {at}`, still not `remoteRemoved`, preserving `remoteRemoveError`.
With that proof, prune treats the mirror as final (landed/empty required), and land drops
`hostCheckoutNeedsRemoval` but still checks snapshot proof
(`ops/orchestrator/src/remote-repo.ts`, `ops/orchestrator/src/seats-recover.ts`,
`ops/orchestrator/src/seats-defs.ts`).

verified: 2026-09-27 (code anchors for this section only)
