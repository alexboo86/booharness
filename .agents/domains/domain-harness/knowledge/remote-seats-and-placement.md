## Remote seats and placement

`needs: mac|win|any` defaults to any; claude, native harnesses and stand arms stay local
without probes, as does a create with no registered hosts. `mac` pins local; explicit
`host` chooses that registered host. Only omitted needs fall back locally when all
probes fail; explicit any/win refuses (`ops/orchestrator/src/seats-create.ts`).
`placeSeat` chooses highest free capacity: free cores = cpus * (1 - cpuBusyPct / 100),
share = 100 * min(freeCores / largest freeCores, freeGb / largest freeGb), then subtracts
one point per active seat. Only working/provisioning seats count; failed/timed-out/
nonzero probes are ineligible and ties keep local first. No measured seat-footprint
constant is used (`ops/orchestrator/src/placement.ts`).

Worker roles receive `scout-request` from `roleDefaults` in `.agents/domains/_skill-map.json`.
Pi nudges on every eighth read-like result; counts reset on scout result and
`agent_settled`. `SCOUT_TOOL` owns the tool description (`ops/orchestrator/src/scout-tool.ts`);
`ROLE_NOTES.scout` owns its context note (`ops/orchestrator/src/context.ts`). A scout
follows its parent: local worktree or borrowed remote checkout (`borrowedRemote`), with
no provisioning or cleanup of the borrowed path. Missing/unregistered checkout or
unreachable host refuses with no row or local fallback (`ops/orchestrator/src/scout-request.ts`,
`ops/orchestrator/src/remote-worktree.ts`). Replacement reviewers inherit explicit
placement from the replaced reviewer's journal; absent journal refuses, omitted needs
stay load-placed (`ops/orchestrator/src/seats-verify.ts`).

`orchSeat` in `ops/orchestrator/src/pi-extension.ts` owns Pi result accounting:

- Coder-only verify loop: successful edit/write marks unchecked; an executed bash check
  accepted by `planCheck` clears it, pass or fail. Numeric `structuredContent.exit_code`
  proves execution; timeout/abort/pre-spawn failure does not. `agent_before_settle`
  emits a visible verify message and continuation at most twice per turn; state resets
  on `agent_settled`. `nudgeCheckCommand` peels cwd-matching cd and status/redirection
  suffixes for accounting only, never authorization (`ops/orchestrator/src/check-verify.ts`).
- Advisory notes, never blocks: third consecutive identical call (name + stable JSON),
  and second completed bash/fused then_run with a sleep segment. Sleep detection ignores
  quotes/comments/heredocs; counters reset on settle.
- Results over `SPILL_CHARS` (20,000 characters) spill in full under a per-seat temp
  directory (0700, files 0600), returning line-aligned head, marker/path and tail.
  Codegraph/scout results never spill; failed writes leave content unchanged.
- Tool preflight compares `piExpectedTools`/`ORCH_SEAT_EXPECTED_TOOLS` with active tools
  once before the first model request, after adapter registration. Missing names use
  status key `orch-tools-missing`, persist as `toolsMissingByTurn` and become a digest
  FLAG. A complete manifest emits nothing; later tool arrival does not clear it.

`compactBeforePrompt` in `ops/orchestrator/src/providers/pi.ts` reads usage/window/state
before a continued prompt. It compacts only above 150k, with a larger window and idle
agent; failure/skip flags the digest but still sends the prompt. No in-run compaction is
requested. `session_compact` counts compaction entry ids per turn. The digest flags more
than `MODEL_CALL_LIMIT` (100) recorded calls, for Pi/native opencode only when available
(`ops/orchestrator/src/digest-text.ts`). It also flags a done first turn with no tools
for scout/coder/reviewer/bughunter, not follow-ups or researcher/debater.

verified: 2026-09-27

