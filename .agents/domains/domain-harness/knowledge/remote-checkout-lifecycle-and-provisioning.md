## Remote checkout lifecycle and provisioning

Remote scout/debater seats use verified detached checkouts; reviewer/bughunter checkouts
use `base` or a bundled local snapshot. A snapshot exceeding
`SNAPSHOT_REMOTE_MAX_BYTES` (256 MiB) stays local; an explicit host/`needs: win` refuses
with the largest untracked directories. Roles whose MCP row holds `brightdata-web`
require a host probe reporting its key; default/any skips incapable hosts, explicit
host/win refuses before insert (`ops/orchestrator/src/seats-create.ts`,
`ops/orchestrator/src/placement.ts`). Recovery removes sealed/interrupted checkouts
before closing (`ops/orchestrator/src/seats-recover.ts`).

`moveCheckout` transfers a fresh snapshot for same-reviewer recheck, then read-tree,
forced checkout and clean remove leftovers and index flags while ignored dependencies
stay. It asserts HEAD/tree/clean index under `MOVE_TIMEOUT_MS` (120 s). Failure sends no
prompt and keeps the old base/blockers. `withHostClone` serializes clone mutations in a
per-host FIFO; different hosts do not block each other, queued waits honor AbortSignal,
and the 120 s move deadline starts when the queue grants the turn (queue wait bounded at ten minutes). `snapshotBack`'s temporary ref is outside
that queue. Temporary ref/index cleanup uses the caller deadline; expired leftovers
remain with UUID names and no sweep (`ops/orchestrator/src/remote-repo.ts`,
`ops/orchestrator/src/remote-worktree.ts`). `addAcceptedPaths` excludes at most 64 invalid
Windows paths, reports `invalidPaths` in `data.remoteSyncInvalidPaths`, and rethrows any
other add failure.

`removeCheckout` accepts only `<host repo>/../worktrees/<seat-id>`. A never-existing
checkout counts removed only with git's not-a-working-tree answer and a definite absent
probe. Reserved-device-only Windows failures use `purgeReservedNames`; locked or other
failures throw. Authorized `allowDeadLeftover` removes a real non-link directory with
no `.git` and only its matching registration. `removeDeadLeftover` requires the native
path equal its lexical form and real directories through the repo parent, rejecting
links/junctions; a plain directory at the seat path is removable
(`ops/orchestrator/src/remote-repo.ts`).

`provisionRemoteCoder` prepares/provisions the checkout without copying `.env`, writes
seat-local Pi MCP config and creates `<stateDir>/mirrors/<seat>`. It is the chain's first
step after runtime sync; `seat_create` returns `provisioning`, prompts wait, and failure
fails the seat. `remoteCheckoutOwned` becomes true after prepare succeeds; close/recover/
prune act only on owned checkouts (absent legacy field counts owned). An interrupted
never-run coder is removed without snapshot. Close returns locally, then snapshot/removal
run on the chain, recording seat data and `seat.remote_checkout_removal`; recovery
replays unfinished cleanup (`ops/orchestrator/src/remote-provision.ts`,
`ops/orchestrator/src/seats-close.ts`).

Close during provisioning durably sets `closePending`, queues close/cleanup and returns
without removing a live checkout. Status remains provisioning for drain accounting;
prompt/land refuse, reviewer cap excludes it, recovery closes it. Repeated close queues
no duplicate while pending and can restart a failed close
(`ops/orchestrator/src/seats-close.ts`). Optional `request_id` makes creation idempotent;
a different role/title/repo refuses. MCP rejects undeclared arguments before side effects
(`ops/orchestrator/src/http.ts`). Creation inside a coder checkout and its sweep removal
share that coder's chain; `checkoutTop` resolves subdirectories, `checkoutInUse` is
rechecked before removal, and `chainHolds` avoids self-wait. Request lookup uses the SQL
expression index; owning-coder lookup uses the checkout basename, not closed history.
CLI prune has only the recheck (`ops/orchestrator/src/seats-create.ts`).

Remote reviewers/bughunters run full setup; read-only roles run only codegraph indexing.
Every role selects its seat MCP config. Entries use gate/script paths from `host.repo`
and omit role env for shared servers, allowing shared adapter cache; role-limited servers
retain `SEAT_POLICY_ROLE` interpolation (`ops/orchestrator/src/remote-pi-mcp.ts`).
`runCodegraphInit` probes availability separately, verifies status after init, deletes
and rebuilds once for definite failed/incomplete status, but retries timeout once
without deleting. Init errors retain exit/output tail. Notes persist as
`remoteProvisionNotes` (`ops/orchestrator/src/remote-provision.ts`).

verified: 2026-09-27

