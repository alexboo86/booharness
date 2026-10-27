# orch — local orchestration daemon (phases 0–5, task 1436)

orch will replace Paseo as the harness orchestrator. The lead is Claude Code or
the Codex desktop app, and it talks to orch over MCP (operator decision
2026-09-22, memory #10457). Phase 0 is the skeleton; phase 1 adds the provider
adapters and their smoke command; phase 2 lets the lead run worker seats through
MCP (below).

Tests are allowed (operator #14235): write and run them. New or changed tests pass the [`test-audit`](../../.agents/skills/test-audit/SKILL.md) authoring gate. Run the narrowest test covering the change; a whole suite does not prove a one-file change.
Changing existing test assertions follows PRIME 7. Reviewers and bughunters may run tests as evidence, but edit nothing. The curated money/data set is the CI and pre-deploy gate and changes only by operator decision.
Other proof is independent review, typecheck, lint, cargo check and reproduction commands;
a blocker requires command reproduction. Performance measurement (perf harnesses,
`scripts/perf`, project-specific performance tools) and visual evaluation (screenshots, parity
stands, ui-canon, light-theme/contrast audits, desktop-interaction-review) remain
allowed and runnable (scope #12895).

## Run

```bash
npm ci --omit=dev --prefix ops/orchestrator   # the one dependency: @modelcontextprotocol/sdk
node ops/orchestrator/src/main.ts serve       # foreground daemon
node ops/orchestrator/src/main.ts status      # JSON; exit 1 when nothing is running; a live daemon whose health probe stalls prints healthUnanswered and exits 0
node ops/orchestrator/src/main.ts check-on win [--repo <lead checkout>] -- npx tsc --noEmit -p tsconfig.app.json
node ops/orchestrator/src/main.ts pick-stats [--since 30d] [--json] # read-only turn outcomes by family, role, domain
node ops/orchestrator/src/main.ts lesson-stats [--since 7d] [--json] # read-only lesson usage and capture outcomes
node ops/orchestrator/src/main.ts lesson-repeat --lesson L --duplicate-of N [--json] # confirm a duplicate through the running daemon
node ops/orchestrator/src/main.ts smoke       # every family against its real CLI; exit 1 on any failure
node ops/orchestrator/src/main.ts jev-balance 10.00 # enter the operator's current Jev USD balance after a top-up
node ops/orchestrator/src/main.ts hosts list # print the hosts.json registry as JSON
node ops/orchestrator/src/main.ts hosts add <name> --ssh <alias> --platform <p> --repo <path> --node <path> [--native <json>] [--replace] [--no-probe] # register a remote host once it answers the probe (ssh runs its node, which must be the major of package.json engines); a failed probe names its reason (unreachable, node not found, timeout, unsupported node; required node unknown when this checkout's package.json states no `>=<major>`) and writes nothing; a name that exists is refused before the probe; --no-probe writes the host unproved; --native takes the Windows toolchain as one JSON object
node ops/orchestrator/src/main.ts hosts remove <name> # unregister a host; add and remove print the registry as written
node ops/orchestrator/src/main.ts hosts probe <name> # probe a registered host: prints {host, ok, version} or {host, ok, reason, error} as JSON, non-zero exit on a failure
```

After the weekly duplicate review confirms that orch-captured lesson L duplicates N, run `lesson-repeat --lesson L --duplicate-of N` against the running daemon. It checks the lesson's applied proposal and earlier delivery before recording a REPEAT and creating at most one mechanical-check task per duplicated lesson; lead-captured lessons report no orch provenance.

`check-on <host> [--repo <lead checkout>] -- <command...>` runs a heavy check on a
registered host (for example `win` or `<configured-host>`), never silently on the lead's machine.
The default checkout is the current directory's Git checkout. It refuses during
a merge (`MERGE_HEAD`), above 256 MiB of new snapshot objects, for unknown or
unreachable hosts, or without the running daemon. The snapshot includes staged,
unstaged and untracked non-ignored files without changing the lead's index.
The loopback-only `POST /check-on` route uses the daemon's shared host-clone queue
to create or reset `<host repo>/../lead-check/<lead checkout directory name>`.
Two different local checkouts with the same directory name cannot share that
host checkout. Root, `ops/orchestrator` and `ops/mcp-vendor` dependencies are
installed on first use and subsequently only for changed lockfiles; provisioning
does not copy `.env` or set up a seat. The command uses the managed seat transport
(including Windows jobwrap), streams stdout/stderr and returns its exit code.
Only one run per host and lead checkout is admitted: a lock under the orch state
directory's `lead-check/` names the holder pid on refusal and is released when the
run ends. This command does not issue a commit stamp.

TypeScript runs directly under Node type stripping (Node >= 24; verified
on 26). There is no build step, so only erasable syntax is allowed: no enums,
namespaces or parameter properties, and relative imports carry `.ts`.

## What it is

Design rule for every guard, hook and nudge (operator #18532): a fix never breaks the seats' working process. It offers the seat an alternative (a tool hint, a spill file with head and tail, a recognised form) instead of a new refusal, and asks the decision model where intent decides.

| Piece | File |
|---|---|
| Config: state dir `~/.local/state/orch` on both OSes, `127.0.0.1:7760` (`ORCH_PORT`, `ORCH_STATE_DIR` exist for tests) | `src/config.ts` |
| Store: `node:sqlite`, WAL, `synchronous=FULL`; `schema_version` + migration v1 (`seats`, `reports`, append-only `events`) | `src/store.ts` |
| Single instance: `orch.pid` is the lock, taken exclusively before the store opens; the record carries `born`, the OS start time of its pid: a live pid whose start time matches holds the lock whatever its port or `/health` answers, a mismatch is a reused pid (stale), and a missing or unreadable start time is refused as held | `src/lock.ts` |
| HTTP: `GET /health`, stateless MCP Streamable HTTP at `/mcp` (`orch_status` with family load, `seats_list` omits closed seats unless `closed: true`, then pages them); non-loopback Host or Origin gets 403 | `src/http.ts` |
| JSONL log `orch.log` in the state dir, rotated at 5 MB, 3 generations | `src/log.ts` |
| Service install: macOS LaunchAgent `com.<prefix>.orch` (KeepAlive), Windows logon task `<prefix>-orch` from `names.prefix` of `ops/bootstrap/harness.config.json` (default `booharness`, so `com.booharness.orch` and `booharness-orch`), via `conhost --headless`, run as the user SID, restarted by a per-minute trigger | `install.mjs` |

## Providers (phase 1)

One adapter shape (`src/providers/types.ts`) over each vendor protocol:

| Family | Protocol | Command | Model / effort |
|---|---|---|---|
| claude | stream-json | `claude -p --input-format stream-json --output-format stream-json` | `--model`, `--effort` |
| glm | same CLI, Z.AI env from `~/.local/state/orch/providers.json` (0600; install-harness migrates it once from `~/.paseo/config.json`) | same | default `glm-5.3` |
| codex | app-server JSON-RPC | `codex app-server` | `thread/start` model, `turn/start` effort |
| grok | ACP | `grok agent stdio` | `--model`, `--reasoning-effort` |
| kimi | ACP | `kimi acp` | `session/set_config_option` |
| opencode | ACP | `opencode acp` | `session/set_config_option` |

### Pi harness for workers

Leads stay in the native Claude Code / Codex GUIs; worker seats run through
Pi (`<repo>/ops/pi-runtime/node_modules/.bin/pi --mode rpc`, or `pi.cmd` at that same pinned path on win32; the version source is `ops/pi-runtime`, pinning `@earendil-works/pi-coding-agent` at 1.4.0 since 2026-10-22 (task 2799; 1.3.0 from 2026-10-16 on the Mac, win and <configured-host>; 1.0.1 from 2026-10-03; task 2553) — an upgrade is a commit of that pin plus `npm ci --prefix ops/pi-runtime` and, after Pi `auth.json` is in place, `ops/pi-runtime/node_modules/.bin/pi update --models` (`pi.cmd` on Windows; set `PI_CODING_AGENT_DIR` first for a custom agent directory; a provider without a login gets no catalog even on exit 0, and kimi seats require Pi's `kimi-coding` OAuth login) on each machine before the orch restart, because RPC reads the saved catalog) by default for
every family with a route — except claude, which returned to native Claude Code
by decision #11849 after its Pi smoke failed "out of extra usage" (Anthropic
bills the Max OAuth from Pi as extra usage, memory #11848); `--harness native`
still reaches a vendor CLI and `--harness pi` opts claude back into Pi
(operator decisions, memory #10477 and #10485: on the
2026-09-22 A/B stand Pi used 1.8-7x fewer total tokens at the same correctness). Routes: claude `anthropic`, glm `zai`, codex
`openai-codex`, grok `xai`, kimi `kimi-coding`, opencode `opencode-go`, qwen
`qwen-token-plan-individual`, and mimo one of `xiaomi-token-plan-ams`, `-sgp`, `-cn`
selected per seat start from Pi `auth.json` or `XIAOMI_TOKEN_PLAN_{AMS,SGP,CN}_API_KEY`;
without a credential it fails before spawning Pi. Each route names a model (Pi
otherwise runs its settings default, and the adapter refuses a mismatched provider). codex's is
GPT-6.1-Sol at effort `high` on both harnesses (operator 2026-09-29, memory
#12885; Pi 0.99.1 lists it in its catalog, native needs codex-cli 0.159.0 or newer); claude's Pi route is the Claude Max subscription
OAuth (decision #11838; the #10476 billing risk accepted) and is now an explicit
opt-in only (decision #11849). API keys come from the existing configs as
env; OAuth routes need one `/login` in Pi. Pi seats run with `PI_OFFLINE=1`,
`PI_TELEMETRY=0`, `PI_MCP_CONFIG_MODE=exclusive` and without `TYPESAFE_*` or
`ANTHROPIC_*`; read-only is `--tools read,grep,find,ls,mcp` (the role gate
cuts which servers `mcp` reaches). MCP reaches them through
`pi-mcp-adapter` 5.3.2 and the installer's `~/.pi/agent/mcp-adapter.json`. Pi 0.99
ships built-in `mcp`, `llama.cpp`, `codemode` and `tool-search` extensions; the
adapter's `/mcp` replaces the built-in one, and `~/.pi/agent/settings.json` on
every machine sets `"extensions": ["-builtin:mcp", "-builtin:llama.cpp"]` so
no seat start warns about the clash (codemode and `tool_search` stay off unless
`defaultTools` names them). Measured
2026-09-22: glm's first turn costs ~2k input tokens through Pi against ~28k
through the Claude CLI.

Every Pi seat, including stand arms, loads `src/pi-extension.ts` through `-e`.
Read-only Pi seats may run the fixed orch read grammar with either their cwd's `ops/orchestrator/src/main.ts` or the `main.ts` beside the loaded seat guard; the context names that loaded-checkout path for `wait <turn>` locally and from registered remote host metadata, and reports an unknown remote path rather than guessing.

A stock Pi seat of family codex that edits (`access: full`, no `standArm`) loads a
second `-e`: the `codex-edit` extension (`apply_patch`) of
`@maxiaochao/pi-toolkit@0.9.3`, operator #13098 after the pilot #13097 (equal
correctness, ~45% fewer tokens, half the wall time on `edit-1`/`edit-2`). Other
families, native harnesses, read-only codex seats and every stand arm keep Pi's
stock edit tools, so the `base` arm stays a valid comparison (#13099).
`src/codex-edit.ts` decides and proves it; the pins (package, version, sha512,
entry file, `config.json` models, hashed files) live once in
`ops/ab-stand/codex-edit.json`, and the one verified install path is
`ops/ab-stand/codex-edit-install.mjs` — the same script the A/B stand arm uses:
it checks registry integrity and tarball origin, hashes the bytes against the
pinned sha512 before npm sees them, installs with `--ignore-scripts` (the toolkit
postinstall would write into `~/.pi` and `~/.local/bin`) and overwrites the
`config.json` next to `index.ts` with the pinned models (`gpt-6.1-sol`; upstream
ships `gpt-5.6-*`). Nothing is downloaded inside the daemon and nothing falls
back silently: on this Mac the install lives in
`<state dir>/pi-extensions/codex-edit` (`node
ops/ab-stand/codex-edit-install.mjs --ensure`) and every seat start re-verifies it
— toolkit version, the config content and the per-file sha256 pinned in
`codex-edit.json`, with every read and write contained in the prefix (a symlink
or junction inside it is refused) — throwing with the repair command when it does
not. On a host, `provisionRemote` runs the host clone's own copy of that script
into `<host.repo>/.pi-extensions/codex-edit` (git-ignored, one install per host)
and records the resulting host path on the seat row as `codexEditExtension`; a
seat start accepts only that exact path and then has the host re-run the same
`--check` before Pi starts, so a host without the extension — or with a tampered
one — fails provisioning or the seat start instead of running a codex coder on
stock edit. Because the extension swaps built-in `edit` for `apply_patch`
at `session_start` when the model matches its config, `piExpectedTools` expects
`apply_patch` for those seats: a codex seat proves the extension loaded by a turn
with no `tools missing` flag (and by `apply_patch` in its edit-tool calls, which
`ops/ab-stand/edit-metrics.mjs` already counts).
Before sending the next prompt to a continued/resumed session, the Pi adapter
reads public RPC `get_session_stats` context usage. When known usage exceeds
`PI_COMPACTION_CONTEXT_TOKENS` (150,000) and the model window is larger than
150,000, it confirms idle state with `get_state`, requests public RPC `compact`,
awaits completion, then sends the prompt (operator #13093). There is no mid-run
orch compaction: Pi's manual compaction aborts active work and does not resume it.
Undefined usage, null token counts and exactly 150,000 do not trigger.
Each prompt is serialized; failed compaction still sends the prompt and records
`FLAG: Pi compaction failed: ...` in that new turn's digest. A later prompt may
retry if usage is still above the ceiling. Cancellation or timeout during
preparation prevents a late prompt from starting.

Models with windows at or below 150,000 retain Pi's ordinary automatic
threshold/overflow handling; the orch adapter makes no additional request.
The normal Pi CLI, installed profile, credentials, resources and stand-arm
profile paths remain unchanged. No settings files, reserve-token overrides,
custom launcher or version pin are introduced. `keepRecentTokens` and the
summary prompt stay as configured. Stand arms use the same Pi adapter and
extension; native Claude seats do not load them.

Turn digests prepend `FLAG: long turn: N model calls (limit 100): cut the next
brief smaller` when recorded calls exceed the named `MODEL_CALL_LIMIT` (100).
The count comes only from per-call `usage.raw` entries: all Pi families (including
codex) and native opencode exports. Repair/support arrays are flattened before
counting. Exactly 100 calls does not flag. Native Codex currently collapses its
per-call notifications into summed usage; native Claude/GLM and generic ACP usage
also store aggregates, so these formats emit no call-count flag rather than a
guessed count. Missing, unknown or malformed per-call entries emit no flag.
Operator-owned coverage should add the 100/101 boundary, nested repair/support
arrays, native opencode exports and unavailable/aggregate usage formats.

Pi digests include `compactions: N` (JSON `compactions`); successful
`session_compact` hooks identify entries already persisted in Pi's session JSONL.
The hook uses `event.compactionEntry`; Pi's own successful threshold/overflow
compactions are counted too. Counts are deduplicated by entry ID within the orch
turn, including report repairs/support rounds, and survive later turns/resumes
in the seat store. Between-turn compaction belongs to the NEW turn whose prompt
it prepares, not the previous turn. Failed attempts do not count; native seats
omit the field, and an unavailable count is `n/a`/null.

For Pi roles that land nothing (`!landable(role)` and no write-scope list), a positive
count also adds `FLAG: compacted: N times; spot-check the evidence before use`.
Zero or unavailable counts, landing roles (including coder and tester), and
native seats do not get this flag. The `compactions` row is unchanged.

Operator-owned coverage should exercise a tool-heavy run crossing the ceiling and its next prompt,
smaller windows, custom model windows, disabled inherited compaction, settings
reload, stand/remote profiles, cancelled/failed compactions with prompt recovery,
multiple compactions, repairs/support rounds and resumed turn isolation. Agent
checks follow #14235 above: use the narrowest test, not this whole matrix.

`access: full` approves every tool request; `read-only` is always named, never
left to a CLI default: claude `--permission-mode plan`, grok `--permission-mode
default` with orch rejecting non-read tool kinds, opencode mode `plan`, kimi mode
`default`, codex sandbox `read-only`. A timed-out turn is cancelled and drained
(up to 10 s) before the session takes another prompt, or the process is closed. `Usage.inputTokens` is uncached input for every family; a
provider cost appears only where it is real (Claude, not glm, never the first
turn after a resume). `smoke` runs read-only in `$TMPDIR/orch-smoke`: nonce echo,
close, resume in a fresh process, nonce recall.

## Seats (phase 2)

The lead creates and drives seats with the orch MCP tools (`src/seats.ts`,
`src/http.ts`):

| Tool | What it does |
|---|---|
| `seats_list` | seats that are not closed, oldest first, in full. `closed: true` includes closed seats; optional exact `status` (including `closed`). Closed seats come newest first, `limit` per page (default 50, at most 500), as compact rows (`id`, `role`, `family`, `title`, `status`, last `turn` and `turnStatus`, `ended`, `failure` when stored) for `main.ts wait <turn>`; `closedPage` gives `total`, `omitted` and `nextOffset` to pass back as `offset` (task 1569: ~900 full closed rows were 579K characters). `seat: <id>` alone returns that one seat's full row whatever its status, or `[]` (the A/B stand's `waitReady`) |
| `seat_create` | role, family, title, `repo` (the lead's checkout), optional `base` or `snapshot` (coder/reviewer: the lead's working tree with its uncommitted changes as one commit on HEAD, so the change is `git diff HEAD^`), `harness`, `model`, `effort`, `instruments` (per-seat override, task 1452: `{codegraph:false, …}` turns a named instrument — codegraph tool+CLI, ast-grep CLI, memory tool+CLI — off for this seat alone; the answer and every seat row carry the effective map), `images` (task 2385: `true` for a seat that reads an image itself; the pick leaves out each model with no image input in `src/model-input.ts`, an explicit family or model with none is refused, and the value is stored on the seat; a role whose default skill holds the `requires` token `input:image` gets it with no flag; a turn whose routed skills hold that token fails before the provider is prompted when the model of the seat has no image input), `session` (the lead's hook session id, the same one the chat tools take: with it the own-family step-aside covers only that lead's family and orch stores the family on the seat, so its own recheck reviewer steps aside from the task's lead — decision #17805 D2; without it, or when it does not resolve, every lead active in the last 10 minutes steps aside and `picked` says so) ; answers with the family's `load` |
| `review_plan` | coder `seat`, or `repo` with `base`/`snapshot`: the same reviewer-count rules for every input mode (decision #17931). Returns diff stats, count, reason, concern-based focus, `vendored` paths left out and `jevRisk` (null when not scored). A Jev `weakens_tests` probability of 0.5 or more (the diff weakens, skips or deletes existing test assertions) adds `weakensTests` and a reviewer focus line to the plan and its theme; it never changes the count (task 2677). A changed file is excluded only when a `VENDOR.json` in a parent folder lists its folder-relative path under `files` with the SHA-256 of the file in the reviewed Git tree. Manifest shape: `{source, sha, path, license, files: {"relative/path": "sha256"}}`; no upstream network check. Differing bytes, deleted files and unverifiable metadata count as own code. `VENDOR.json` and `NOTICE` are documentation; documentation-only stays zero. Jev judges the remaining complete own diff: risk below 0.2 gives zero reviewers, 0.2 to below 0.7 gives one, 0.7 or more gives two. A security path (the existing auth/token/secret/credential/security/permission/install/guard/hook/oauth and named harness paths) gives at least one; two requires changed own security lines and risk at least 0.7. Jev unavailable or a cut diff (80,000-character cap or gate alteration) gives one, or two when own security lines changed, labelled. With two or more code themes, adds `themes: [{theme, paths, stats, count, reason, focus, vendored, jevRisk}]`, resolved by the domain routing map; unrouted code uses `unrouted`, documentation joins no theme. The total count sums independent theme counts: create one reviewer set per theme, briefed on **only its own paths** (decision #12934). Stats retain the full changed-path inventory; focus and Jev input exclude verified vendor files. The sole reviewer, or reviewer 1 of two, checks new helpers/types/constants/copied bodies for repository duplicates and names the existing symbol to reuse or extend. Every Jev answer is stored as event `review.jev`: score or failure code, thresholds, subject, base, own diff counts and model on a scored answer, plus `weakensTests` when Jev answered it. CLI: `node ops/orchestrator/src/main.ts review-plan <seat>` |
| `seat_prompt` | queues the brief (at most 300 words, or `long_brief` with the reason; `files` select knowledge pages and lessons), returns the queued turn id and the absolute `wait` command at once even when a turn is running. A first coder or bughunter brief without files in the brief or seat is refused before queueing: pass the repo-relative files of the area (for a bug with an unknown cause, the suspected area). A reviewer inherits its author's files; without any, it still queues with `warning: "no files: this seat gets no knowledge page and no lessons; pass files"` and that turn's digest repeats it as its first flag. Follow-ups are unaffected (decision #17906, overturns #12418). For coders it also returns `overlap: [{seat, files, more}]` (warn only) against unlanded open coders in the same repo; normalized directory paths match children, with at most 20 files per seat and `more` counting the rest. Files combine the persisted union of turn `files` and asynchronous worktree `git status` plus committed changes since base, observed on prompts. Failed observations are logged and reported as `overlapUnchecked: [seat]` rather than silently treated as disjoint. The board does not show overlap warnings (decision #11839); they reach the lead only in this answer. Failed or removed checkouts are excluded. A clean seat matching the lead HEAD stops warning once landed. A coder's first `seat_prompt` is scored by Jev for more than one bounded behavior or many new units that cannot finish in one turn; score above 0.85 refuses the brief and recommends sequential seats, logging `seat.brief_refused` at info level with seat, title, score, threshold, the brief's SHA-256 and its first 300 characters for review. `wide_brief: "<why it cannot be split>"` (at most 300 characters) bypasses the gate. Jev unavailable, invalid, or an input the privacy gate would cut passes labelled; the score or bypass reason is stored on the turn (`scope` in the digest), and a bypass also stores the trimmed reason, timestamp and turn id in the seat's `data.wideBrief`. Subsequent turns are not gated. A coder digest flags a turn over 25 minutes as `long turn`; from turn 3 it also flags `circling: <file> back to turn N-2 content` (up to three files changed in the previous turn whose current blob matches the blob two turns ago) or `circling: <check> failed 3 turns running` (the same normalized check's final result failed in all three consecutive reports). It also flags `regressed: <check> passed at turn K (tree <short sha>)` when a normalized check fails after passing in an earlier turn with a retained tree, naming the latest recorded passing checkout; it never restores automatically. These are warnings, not blockers; unavailable tree records do not imply a revert. The first turn is wrapped in the role context, every turn ends in the role's JSON report contract, and an off-schema reply gets up to two repair turns that name every fault; size is never a fault (memory #10514) |
| `seat_wait` | waits up to 50 s and returns the human digest (the Codex-desktop path); `json: true` returns full JSON |
| `seat_report` | the raw final message, read only when the JSON report is missing or unclear |
| `memory_apply` | apply a completed turn's typed `memory` proposals (`turn`, optional zero-based `pick`); supersede/retire require a read-only preview with live kind/title, then `confirm: true` to write; stops at first refusal; never automatic |
| `seat_close` | cancels a running turn; removes a reviewer's worktree; always keeps a coder's for explicit CLI pruning |
| `handoff_draft` | read-only markdown from orch's stored seats and parsed report fields; optional `since` (ISO UTC time or turn id) and `repo` (checkout path). Default: earliest open seat, else last 12 hours. Landing checks commit ancestry first, then reverse-applies the seat diff against HEAD in temporary indexes (full, partial or not landed); an unavailable diff is unknown; at most four checks run together under an overall deadline. The under-3-KB aim is for sparse 20-seat reports; blocker/major claims and evidence are never truncated (whitespace is collapsed), while notes are bounded. Neither real index is touched. Edit before saving with `memoryctl handoff` |
| `seat_land` | applies a coder seat's accumulated change onto the lead checkout without committing; `into` selects another checkout of the same repository |

At every coder turn end orch records the checkout as a git tree (a copy of the real index under a temporary `GIT_INDEX_FILE` in a scratch directory under the OS temp dir, removed after, `add -A`, `write-tree`; the real index and the shared stash are never touched). After a coder's non-first turn completes `done`, orch routes the reproduced blockers of every authored reviewer (`author: <coder seat>`) whose latest settled report requests changes (decision #11871). The correction delta is the diff from the tree the reviewer's report saw (the last one recorded before that turn started; the coder base if none) to the tree at the correction's end. An empty delta, or one whose every changed path is named in a reproduced blocker's claim or evidence (exact repo-relative path, enclosing directory, or unique delta basename), queues a recheck on the same reviewer, even when a newer turn is running or queued (FIFO); its brief contains only that reviewer's blockers (claim and evidence). An unmentioned path or unavailable delta creates a NEW reviewer instead: same title, `author` the coder, `base` the coder base, a family that is not the author's, a lead's or any earlier reviewer's on the title; its brief is the task's ORIGINAL first review brief (never an earlier replacement's wrapper) plus the fixed blockers, over the whole accumulated diff. The superseded reviewer is closed (its queued recheck turns are cancelled), stops counting toward the two-reviewer cap, and its family stays excluded. Both briefs pass at most 12 largest changed paths as `files` (naming omitted paths or their remaining count) and point read-only at `git -C <coder worktree> diff <coder base>` for committed, staged and unstaged changes, with untracked files listed separately. An approving reviewer gets no recheck; closed reviewers or reviewers without a settled report produce skip notes, and when no family is left for a new reviewer the same reviewer rechecks its blockers, with a note. The coder's digest includes `rechecks: [{reviewer, turn, kind: 'same'|'new', replaces?}]` and `recheckNotes` (each replacement names its reason); the text digest shows each recheck as `same reviewer` or `new reviewer, replaces <seat>`; the immediate `seat_prompt` answer does not promise future turn IDs. The board shows queued/running reviewer turns. Pass `recheck: false` on a coder correction prompt to opt out. The lead waits on digest turn IDs rather than sending rechecks by hand.
A done coder report carries `criteria`: one entry per acceptance criterion of the brief with `check` naming the command in `checks` (typecheck, lint, cargo check or reproduction) that would fail if the criterion were false, or `check: null` with a reason when nothing runnable exists; the digest flags every criterion whose check is null, absent from `checks`, or not verified by orch's rerun (task 1641).

Turns on a seat run one at a time in prompt order, including prompts sent during
provisioning or a running turn. At most five turns may be queued on a seat;
additional prompts are refused until one starts. A failed predecessor does not
block the queue; `wait` on a queued turn waits for that turn's own result. Sealed one-answer roles
still refuse a second prompt. The board shows the running turn's live tools
and elapsed time alongside the number of queued followers.

### Landing a coder seat

`node ops/orchestrator/src/main.ts prune --dry-run` lists closed coder seats,
what would be lost, and why, without deleting anything. An explicit `prune`
CLI call removes a coder's checkout only when every path changed since the
seat base has identical content in the repository's HEAD commit (not the
lead's working tree or an earlier `seat_land` result). `prune --older-than 7d`
explicitly discards older unlanded tracked changes, **never** unknown untracked
or ignored files. Known disposable build caches alone may be removed. Destructive
CLI pruning refuses while the daemon owns the lock. Paths must be directly under
orch's `stateDir/worktrees`, and only `orch/<seat-id>` branches are removed. No
historical Paseo or manually named target directory is touched.

The daemon sweep closes a ready coder after two days since its last turn ended,
even without landing proof (between one and two days, proof is still required).
Running/queued turns, use of its checkout by another active turn, and deferred
replacements prevent idle close; a newly idle-closed coder is never removed in
that sweep or before a full day after `closedAt`. A missing lead checkout is
resolved through the coder checkout's common Git directory against `master`;
a dead common directory keeps the seat.

The daemon sweep also removes a closed local coder's checkout without the CLI:
once its whole change is on the lead HEAD (task 1522), and once a seat kept
only for unlanded work — unlanded tracked changes or commits, or unsafe
untracked/ignored files — has been closed at least 24 h (task 1953). A landing
verdict that is unknown (the check could not decide) ages the same way
(operator #13349 covers unlanded and undetermined work), and only through the
verified backup; an error inside the aged path keeps the seat. The age
basis (`closedAt`, else `updated_at` at first observation) is written once and
never moved by kept verdicts. Before the aged removal the checkout is backed
up under `stateDir/worktree-backups/`: `<seat>.patch` from `git diff --binary
<base>`, plus `<seat>.untracked.tgz` with unsafe untracked and ignored paths
selected smallest first up to 300 MB, written to temporary names and renamed.
If any non-ignored untracked path does not fit, the checkout is kept with
`backup over cap: untracked <path>`: no backup, removal marker or removal.
That reason is logged once and the plan is retried at most once per 24 h,
without moving the age basis. Only ignored leftovers may be lost; their paths
are named in `lost`, while the selected paths are archived and removal proceeds.
This cap rule also applies to aged final mirrors. The non-ignored tree identity
is captured before the audit; it must still match before removal. The full
checkout identity (HEAD, that tree, content hashes of archived files and the
ordered ignored-name set folded behind SHA-256) is taken before the backup and
verified again immediately before removal. A restarted daemon re-verifies the
marker's backup files and a surviving checkout's identity before finishing an
interrupted removal. Before dropping a stale marker, its existing canonical
owned backups are set aside in `worktree-backups/` as
`<seat>.interrupted-<UTC stamp>.patch` and `.untracked.tgz`, taking the next free
name on collision. One event records the new paths. Set-aside files are never
removed automatically; a move failure keeps the marker, backups and seat and
records the reason. A changed checkout stays for that sweep; a later fresh
judgment can write new backups under the canonical names. New aged markers
carry `capRule: 2`; older cap and identity gates apply only to surviving
checkouts, which are judged afresh rather than resumed under the old rules.
The removal is logged as `seat.auto_pruned` with an aged reason, and the `orch/<seat-id>`
branch is never deleted by it. The same daemon-only age policy covers a closed
remote coder's **final** mirror kept as not landed, partly landed or `lead repo
missing` (resolved through its own common directory). An unremoved host checkout
never ages. The mirror's backup is parsed and hashed before a `checkoutOnly`
marker stores the resolved repository, mirror fingerprint and archived-content
identity; all are rechecked before removal and on restart, and `worktreeRemoved`
is recorded only after removal. A stale backup is set aside and the mirror kept.
The snapshot ref `refs/orch/snapshots/<seat>` stays, including on resume.
Proof-backed removal and CLI pruning are unchanged: `prune --older-than` never
discards an unlanded mirror.

Closing a seat also frees its regenerable caches (task 1521): once the seat is
closed, orch deletes `.codegraph`, `node_modules`, `ops/orchestrator/node_modules`,
`target`, `<project-specific>/target`, `<project-specific>/target` and `<project-specific>/gen/schemas` inside
the seat's own worktree, in the background
behind `seat_close`, with async file operations so the HTTP loop keeps
answering. A path is removed only when Git ignores it and tracks nothing under
it, and no parent component is a symlink; a symlinked cache is unlinked, never
its target. The branch, tracked files and untracked source stay, so `seat_land`
works after close. `node ops/orchestrator/src/main.ts prune --caches [--dry-run]`
does the same for every closed seat worktree still on disk and prints one JSON
line per seat with the bytes freed (allocated blocks, as `du` counts them; an
APFS clone shares blocks, so the disk may gain less) and each path removed or
skipped with its reason. It only touches closed seats, so it runs beside the
daemon without its lock; it does not combine with `--older-than`.

`seat_land { seat, into? }` takes the coder worktree's committed, staged,
unstaged and untracked changes since its resolved seat base (including a snapshot
base). A temporary Git index leaves the seat index untouched. Git writes the
whole binary patch to a temp file, then applies it **once** with `git apply
--3way` to `into` (default: the `repo` supplied at creation). The target must
be another checkout of the same repository. A per-target mutex serializes
landings; Git runs asynchronously so other daemon requests remain responsive.

A non-coder, a seat with a queued/running turn, or a target with staged,
unstaged, untracked **or ignored** files at a patch path is refused before
applying. Leading symlink directories are refused, including ignored ones;
tracked leaf symlinks are permitted. On success the result includes
`status:"clean"`, `files:[{path,created|modified|deleted,conflicted:false}]`,
`skippedIgnored`, and `recovery.commands`. Ignored seat files and compact
ignored directory paths are listed in `skippedIgnored`, not silently omitted.
No commit is made.

A textual merge conflict returns `status:"conflict"`, per-file `conflicted`
flags, `conflicts:[{file,hunks:[{start,end}]}]` and exact rollback commands
in `recovery.commands`. Hunk ranges include marker lines (1-based). Resolve
unmerged entries and `git add` the files, or run the returned commands in
order: restore tracked paths, unstage/remove created paths, remove newly made
empty directories. A refused delete/modify three-way returns
`conflict:{kind:"delete-modify",files:[...]}`, `nothingApplied:true` and an
empty command list: the target remains unchanged. Other failed applies are
errors requiring inspection of `git status` before retrying.

Waiting is not polling: in Claude Code the lead runs the returned
`node …/main.ts wait <turn>` as a background Bash task and is notified with the
human digest: flags first, seat/role/family/turn/status/time/tokens/error, report
status, complete one-line findings and evidence, checks, changed files, not-checked
items and lead notes. When the report is null, it names `seat_report <turn>` for
raw text. `wait --json` (or MCP `seat_wait` with `json: true`) returns the full
JSON digest including grade, watch and worktree; the dashboard retains JSON.
`wait` long-polls `GET /turns/<id>?wait=` and exits 0 only for `done`.

`wait <turn> <turn>... [--grace-seconds n] [--timeout-minutes n] [--json]` waits
for several turns in one process (decision #15073): one notification, so one lead
turn, for the turns that end close together. It polls every id at once. After the
first turn ends it keeps collecting for the grace (180 seconds by default, never
past the deadline) or until every turn has ended, then prints the ended digests
in argument order, separated by an empty line, and a last line
`still running: <ids>; wait again: <command>` when some have not ended. `--json`
prints one object `{turns, running}`. Exit 0: every ended turn is `done`; 1: a
turn ended otherwise or orch stayed unreachable; 3: the timeout passed with
nothing ended. One id keeps the bytes and the exit code described above and
ignores `--grace-seconds`. A read-only seat's guard still accepts one id only.

| Role | Access | Checkout | Seat lives |
|---|---|---|---|
| coder | full | own worktree on `orch/<seat>` from `base`, kept after close | many turns |
| reviewer | full | disposable detached worktree at `base` or a `snapshot`, removed on close | many turns |
| bughunter | full | disposable detached worktree at `base`, removed on close | many turns |
| scout, researcher, critic | read-only | the lead's checkout, in place | one answer, then closed |
| debater | read-only | the lead's checkout, in place | one answer, then one rebuttal (`seat_prompt` with `rebut`); closed after the rebuttal, or 60 minutes after the first answer when no rebuttal comes |

The screenshotter role and the Claude lead's `lead-capture-hook.mjs` were removed
on 2026-10-21 (operator decision #19248, overturning #13911 and #13933).
A lead or a seat captures the screen or a window and reads the image itself,
only when a picture is necessary; a log, test, DOM or accessibility read that
proves the point comes first. A win offscreen Qt grab stays a coder seat with
the `screen-capture` trigger, because it needs a build worktree.

A plan critic is its own role, created with `seat_create {role: "critic"}`
(operator decision #13286): the same read-only, one-answer seat, on the
reviewer matrix's model and effort instead of the scout tier, and never routed.
`author` names the seat that drafted the plan, and
its family and every coauthor's step aside. The lead's family is refused even
when named, except Claude may take a critic seat when no named author or coauthor
is Claude (decision #13875); `author` may be omitted. An explicit model, effort
or native harness is refused (omitted harness runs Claude natively with the matrix
model). The role's context carries `plan-critic` as a role default, so the brief
needs no opening words; a plain scout brief that opens with
`Plan critic` is not refused and routes no skill — it gets a scout-tier answer,
so the lead must create the role. `seat_create {role: "scout", critic: true}`
still makes a critic: an alias kept for one release. Its turns are accounted
apart from scout turns as `critic`, and a stored scout row with the flag still
counts as a critic.

A worktree lives under `~/.local/state/orch/worktrees/<seat>` and is
provisioned from the seat's `ops/orchestrator/worktree-setup.json`, or the
lead checkout's copy when the seat branch lacks it, before the first turn runs:
every setup line (npm ci, `.env`, rtk trust, the worktree's own codegraph
index) runs in the seat and records its config source, then
`ops/bootstrap/provision-worktree.sh` (hooks,
scripts and skills from main). A failing step fails the seat with its output
tail and removes the checkout and its branch; a step past its time limit is
killed with its whole process tree. MCP servers start in the seat's cwd, so codegraph answers about the
seat's branch, not about main (acceptance 2026-09-22: a scout found a class
that existed only in the lead's worktree).

A seat gets `SEAT_POLICY_ROLE` and `ORCH_SEAT_ID`; native claude seats run
with `--disallowedTools mcp__orch` and native codex seats with
`-c mcp_servers.orch.enabled=false`, and Pi seats never get orch, so no worker
can create or steer seats (both verified live 2026-09-22). `seat_close` cancels
and wakes waiters for every queued turn without starting it, and ends a running one
as `cancelled`, also while
the provider is still starting. The store keeps the provider session id: after
a crash or SIGTERM every queued or running turn stays recorded with its prompt and
is marked `interrupted` (not silently replayed or left pending; a subsequent wait
returns that digest). `restart --when-idle [--as <handle> --session <id> --note "<what changes for a lead>"]`
is the exception: it sets a drain flag in the store, accepts new turns without starting them,
and when nothing is running exits 0 so launchd KeepAlive restarts it; the next start
clears the flag and starts those queued turns. With a note, the route first writes one
broadcast as the lead holding that live binding; a refused post leaves the drain unarmed.
The whole post must fit 600 characters. It names the exiting pid and the check:
`node ops/orchestrator/src/main.ts status` prints a different pid with `draining: null`.
No note means no post; there is no post after startup. Before the idle exit begins,
`node ops/orchestrator/src/main.ts restart --cancel` withdraws an armed drain:
it clears the persisted flag and starts drain-held turns in per-seat order without
restarting the daemon or duplicating turns already in its FIFO. It errors if no
drain is armed or the exit has already begun. The drain disappears from
`orch_status`, seat answers and the board. A seat caught provisioning is failed and
its checkout removed, a sealed seat whose one question was interrupted is closed,
and any other seat's
next prompt resumes the same provider session. A resume the provider refuses
starts a fresh session, whose first message carries the whole role context again.

What a Linux host needs before its hosts.json entry (always-on, PATH symlinks, the Pi agent
directory, git identity, memory forward, the live proof) is the checklist in
[docs/agent/linux-host-bringup.md](../../docs/agent/linux-host-bringup.md) (task 2342).

On a Windows host a remote seat runs through [remote-exec.mjs](remote-exec.mjs) over SSH, and
every remote command is spawned through [jobwrap](jobwrap/), the `orch-jobwrap` helper (task 1838):
it puts itself into a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, starts the
command inside it, watches both the command and its own parent, and exits with the command's code.
When the helper dies by any path — `taskkill`, a dropped ssh killing remote-exec, or
TerminateProcess — the last job handle closes and Windows kills every process ever started in the
job, including npm -> cmd -> node branches whose intermediate parent already exited and that
`taskkill /T`'s parent-pid walk cannot find; without it every kill path left such a branch alive
and the seat's checkout locked (bughunter-codex-13c9da). remote-exec builds the helper once per
crate source hash into `<orch state dir>/jobwrap/bin`, serialized by cargo's target-dir lock, and a
build failure fails the seat loudly rather than falling back to an unwrapped spawn.
Windows Pi bash calls use that same helper via `ORCH_JOBWRAP` in a separate per-call job around Git Bash, so timeout or abort kills the call's descendants immediately; a missing or unstartable helper fails the call without an unwrapped fallback.

### scout_request (decision #11990, task 1571)

A coder, bughunter or reviewer seat may ask orch for one read-only scout with
`scout_request {question, files?}` ([scout-request.ts](src/scout-request.ts),
[scout-tool.ts](src/scout-tool.ts)). orch creates a `scout` seat (pace-picked
family, `data.parent` = the caller, shown on the board card as `for <seat>`),
reading the caller's worktree, waits for its turn, returns the digest as the
tool result and closes the scout. Enforced in orch: depth 1 (a seat with a
parent gets no token), one scout at a time per seat, question at
most 200 words; each call logs `seat.scout_requested` or `seat.scout_refused`.

Identity: each worker session is spawned with a random token that alone names
its seat. A native claude-CLI seat (claude, glm) gets it as the `scout` server
in its private `--mcp-config` (`/seat-mcp`, which serves only this tool;
`--disallowedTools mcp__orch` stays); a Pi seat gets `ORCH_SEAT_TOOL_URL` and
`ORCH_SEAT_TOKEN`, and the Pi extension registers the tool (`/seat/scout_request`).
Other native harnesses (codex, ACP) have no scout tool. An unknown token gets
HTTP 401. Seats share the operator's uid, so the token is a binding, not a
sandbox: a full-access seat able to read another process's environment or
temp files could read another seat's token.

## Report grading (phase 3)

When a turn ends with a valid report, it is graded once (`src/grading.ts`).
Jev is asked only whether it is a finished report (memory #12435). Whether a
finding's evidence supports its claim is a structural check: a backticked
command, a named binary (`node`/`npm`/`npx`/`cargo`/`git`/`bash`/`rg`/`sqlite3`/`curl`),
a file:line, or a URL. A test name or test-shaped filename earns no special support. The grade is kept in the store's `reports`
table, so a later read never re-grades. The digest carries `grade` and `flags`.
No flags means the lead accepts the report without re-verifying it (operator,
memory #10313). A flag names what to check: not a finished report, a blocker or
major whose evidence names no concrete command, file:line or URL, or a
report Jev could not grade. Only the JSON report goes to Jev, never the seat's prose.

A reviewer's report is also compared with its siblings': the other reviewer
seats with the same title in the same repo whose turns have all ended and
whose latest one gave a valid report Jev did not grade as unfinished (at most 3, the most recent
first). Same defect is a code rule, not a Jev call: both evidences name the same
repo file at the same line or an overlapping range (`path:line`, `path:a-b`;
`./`, an absolute path whose suffix is the repo-relative path, and `<root>/worktrees/<seat>/` stripped so two reviewer checkouts match). No file:line
on either side is not the same. A match is a flag (`finding 1 is the same defect as <seat> finding 2`),
so the lead merges the two instead of fixing one defect twice. The first reviewer
to finish has no settled sibling, so the comparison shows on the later report.
Sibling reviewers settle one at a time (grade, then end the turn): two that finished
together would otherwise each grade while the other was still running, and neither
would be compared. A lead that wants two reviewers compared gives them the same title.

## Loop watch and continue-or-fresh (phase 3)

orch watches a running turn and acts at once (operator decision, memory
#10511; `src/watch.ts`). A loop is the same tool call, name and identical
arguments, 3 times in a row or 5 times in one turn; a file edit in between
resets the count, since edit, check, edit, check is a coder working. Calls whose
arguments the adapter cannot see do not count. The first loop steers the seat
mid-turn (Pi `steer`, codex `turn/steer`) with a message naming the repeated
call. A second loop in the same turn interrupts it, and the turn ends as an
error `orch interrupted the turn: ...`. A claude or ACP seat has no steer, so
the first loop interrupts it. The watch ends when the main prompt returns: a
steer the provider refuses afterwards changes nothing, and a cancelled turn
gets no report repair. Drift scoring was removed (task 2185): no new drift
steer is written, and a stored action of kind drift stays readable.

Every closing names the turn limit (`timeout_minutes`, default 30) and asks
for a `partial` report with `notChecked` by 80% of it. At 80% orch also steers
a still-running seat once with "report now" where the provider has steer (Pi,
codex); claude and ACP seats rely on the closing alone. A turn that reaches the
limit is an error even if its text parses as a report. The watch no longer
asks Jev, so it writes no `seat.watch_unjudged` or `seat.watch_jev` events;
rows already stored stay in place. The digest's `watch.actions` lists what happened
and `flags` names it. The text digest prints these flags first; the full
`watch.actions` record is available with `wait --json` or `seat_wait` `json: true`.

A seat continues its conversation regardless of the next brief. The existing
context-cap override starts a fresh provider session when context is 60% full
(Pi `get_session_stats`, codex `modelContextWindow`, claude `modelUsage`). A
fresh session, like one whose resume the provider refused, gets the role
context and the reports of the seat's last 3 turns; the checkout stays as it
was. The text digest shows `watch.session` when it is `continued` or `fresh`,
with its reason; `first` and the context reading are available in the full
JSON (`wait --json` or `seat_wait` `json: true`). Both are stored per turn
(schema 3, `turns.watch`).

## Limits (phase 4)

orch reports each family's subscription load to the lead and never refuses a
seat for it (design #10457). The reading is `ops/usage-snapshot.mjs`, one
HTTP call per vendor with the credentials its own CLI keeps; `src/limits.ts`
serves it from memory, seeds it from the snapshot the session-start line
reads, and refreshes it in the background once it is older than 5 minutes.
`seat_create` answers with `load` for the seat's family (highest share of any
window, the windows, the reading's age) and, from 85% up, a `warning` naming
the less loaded families. `orch_status` lists every family, least loaded
first; a family that could not be read says why and sorts last, unless it was
read in the last 24 hours: then its last good reading stands, with its own
age and `stale` saying why it is not newer (grok's and kimi's tokens expire
every few hours and only their CLI's next run refreshes them). That reading
survives a daemon restart: it is kept in `limits-last-good.json` in the state
dir. codex's
subscription is the snapshot's `astra` row. qwen's plan key reaches no usage
API; its load comes from the console session of the official Model Studio CLI
(`bl auth login --console --console-site international`, memory #10506), which
lapses without a refresh token and then asks for that login again. For any
family a turn error that says the quota ran out (`quota`, `usage limit`, `limit exceeded`, …; throttling does not
count) is kept for 24 hours as `quotaError` with a warning, until the family's
next completed turn. MiMo reads its monthly credits from the console `tokenPlan/usage` with the Cookie of the operator's macOS Chrome session, read fresh on each snapshot by `ops/chrome-cookies.mjs` (decision #12040; orch never stores it). The first read asks macOS for the `Chrome Safe Storage` Keychain item: answer "Always Allow" once, or later reads ask again. A read with no Chrome login (`not logged in to platform.xiaomimimo.com in Chrome`), a denied Keychain, or a rejected Cookie (`mimo cookie expired or rejected`: log in again in Chrome) is unknown with a reason and ranks last, never zero.
A test daemon runs with `ORCH_USAGE=off`.

## Dashboard and lead context (phase 5)

`http://127.0.0.1:7760/` is a page for the in-app browser of the Claude or
Codex app (decisions #10457, #10478). It shows the lead active in the last 10
minutes as a ring against its /next limit; the seats at work with turn status,
time, diff, flags and four labelled badge rows (operator 2026-10-01), each drawn
only when it has something to show: `skills` (inlined, routed and read, knowledge
page read, the `no jev` fallback), `tools` (our shell instruments rtk, rg, ast-grep
and scout when used, red for rtk when the seat ran the shell without it, the
provider's own tools, and one `shell` badge whose tooltip lists the other
programs), `mcp` (codegraph, memoryctl and every other MCP server called) and
`pi` (the Pi extensions orch loads into the session: its guard, codex-edit or
hashline-edit lit by calls of their tools, a stand arm); an instrument that was
not used gets no badge; finished seats folded into one closed list; every
section of the board folds on its title, and the browser remembers which ones
are folded;
and each family's weekly and monthly load as rings (hour windows refill on their
own and are left out). `src/toolkinds.ts` sorts every tool call by kind from
each provider's shape; the counts are live for a running turn and stored in
`turns.watch.tools`. It polls `/api/dashboard` every 3 s; the lead scan is
cached for 10 s. Same loopback and DNS-rebinding guard as `/mcp`. No statusLine:
the operator skipped it.

The header beside the rtk gain pill shows Jev spend from the shared append-only
`~/.local/state/jev/usage-YYYY-MM.jsonl` (Jev input tokens at $0.042/M, each row labelled with the model that answered;
output free). With no entered balance it shows today's machine-local spend only.
After `jev-balance <usd>` writes a timestamped `balance.json`, it estimates the
remaining balance by subtracting spend since that entry; days left uses the last
seven days of spend. Under two days or overspent is a warning; zero recent spend
has unknown days, and very long runway displays `>365 d`. Unreadable ledger rows
are counted in the pill's title, so its spend is a lower bound rather than a
silent zero. Files are per month; the reader also includes the earlier
`usage.jsonl` for continuity. Balance is a manual entry, not a provider API.

A lead's context is read from its own session log by `src/leads.ts`, never
from a provider: the claude transcript's last main-thread call (input plus
cache read plus cache write) and the codex rollout's last `token_count`, which
also states the window. Only sessions a person drives count as leads — claude
`entrypoint` `claude-desktop` or `cli`, codex originator `Codex Desktop` or
`codex_cli_rs` — never `claude -p` (`sdk-cli`), orch's own codex seats
(originator `orch`), `codex exec` or subagent threads, nor anything in an orch
or Paseo seat checkout. The limit is min(300k, 70% of the window)
(decision #17064; the window share is lesson #10446): 300k for claude, 180,880
for codex on a 258,400 window.

`ops/bootstrap/lead-context-hook.mjs` is a PostToolUse hook for claude leads
and codex (installed by `install-harness.mjs`; codex asks to trust it once).
Past the limit it adds one reminder to the lead's context — finish the step,
let seats report, write the handoff, run /next — then one per further tenth of
the limit; back under it (a compaction) the band is forgotten. It skips seats
(`ORCH_SEAT_ID`, `SEAT_POLICY_ROLE`), never fails a tool call, and keeps its
state in `lead-reminders.json` in the state dir.

## Lead chat

Lead-to-lead coordination lives in orch, not in operator replies (task 2139,
plan #14640). Memory remains the durable record of decisions; seats deliver
reports, not chat posts. `src/chat.ts` stores bindings, posts and per-handle
receipts in SQLite (schema 7).

| Tool | Contract |
|---|---|
| `chat_join {handle, session}` | Bind the track handle to the session id SessionStart prints. |
| `chat_post {as, session, body, to?, wake?}` | Post only under the matching live binding; body is 1–600 Unicode code points. |
| `chat_read {as, session, all?, limit?}` | Read unread posts and atomically deliver and confirm the returned posts; `all: true` is a read-only log. Limit defaults to 50, maximum 200. |

`ops/bootstrap/session-start.mjs` prints `session_id` and the join line for a
lead with a usable id; it does not automatically join. Handles are 1–64 letters,
digits, dots, underscores or hyphens; `operator` is reserved for board posts
and `all` for broadcast addressing, so neither can be joined.
The same live join is a no-op. A successor's join supersedes the predecessor
and inherits the handle's receipts; a superseded session cannot reclaim it.
Joining a second handle releases the session's first.

Address classes are separate from wake:

- `to: ["handle", ...]`: offer to those handles at their next eligible hook event.
- `to: "all"` (also `"all"` inside an address array): offer to every joined
  handle except the author.
- Omitted `to`: log only, injected into nobody; visible on the board and with
  `chat_read {as, session, all: true}`.
- `wake: true`: a post reaches its addressee at that lead's next own turn; only
  `wake` wakes an idle lead. Set it when the addressee must act now and the
  sender cannot continue without that act. Only an addressed, never-delivered
  wake post triggers the watcher; delivery retries alone do not start another turn.

Eligibility begins after the handle's **first** join, excludes its own posts
and persists across successor bindings. Ordinary `chat_read` returns oldest
unconfirmed posts, even after hook retries are exhausted; log mode returns the
newest window, oldest first, without receipts.

### Receipts and hooks

Delivery is **at-least-once**, not exactly-once or proof of action. Offering an
unread batch writes no receipt. `delivered_at` records a hook's report after
output flush; `confirmed_at` records transcript evidence on a later eligible
hook run (or an explicit unread `chat_read`). Confirmation requires delivery.
Hook offers stop once confirmed or after two recorded delivery attempts per
post/handle; an unconfirmed post then remains available to explicit read.
Lost output or receipt responses can cause duplicates. No acknowledgement
posts are wanted.

`ops/bootstrap/lead-hooks.mjs` registers `lead-chat-hook.mjs` on
UserPromptSubmit and PostToolUse for Claude-family and Codex leads. It skips
seats and non-interactive/non-lead transcripts. Per-session polling is at most
once per 20 s; each HTTP request has a 300 ms default budget, not a single
budget for the whole hook (`ORCH_CHAT_REQUEST_BUDGET_MS` overrides it with
positive integer milliseconds, maximum 2,147,483,647). Empty, unavailable,
slow or malformed responses end silently without failing a tool call.
State is `lead-chat.json` in the orch state dir, with a seven-day TTL.
Post-request slot saves reload current state and merge only the target
session, preserving other sessions' slots.

Post lines alone are capped at 1500 UTF-8 bytes, followed by `N more: chat_read`
for omitted posts and an `[orch-chat <ids>]` marker. The wrapper, remainder hint
and marker are outside that cap. The first post always prints: if oversized,
its line is clipped at a code-point boundary to fit, ending with `… [chat_read]`;
later non-fitting posts are omitted whole and counted in `N more`.
Hook context and watcher stderr replace runs of CR/LF with one space and strip
C0/C1 controls from bodies; stored bodies and board text remain unchanged.
Receipts cover printed ids, including the clipped first post (at most 200 per
request). On a later eligible hook run, confirmation scans only the last
512 KiB of transcript for exact markers in `type: "attachment"` records or
system-origin user notifications carrying asyncRewake Stop-hook feedback,
never markers quoted in ordinary user/assistant text.
An unreadable or missing marker cannot confirm delivery.

### Idle wake

`ops/bootstrap/lead-chat-watch.mjs` is the watcher. `lead-hooks.mjs` installs
it for Claude-family leads (`claude`, `glm-lead`), not Codex, as a **Stop**
command hook with `asyncRewake: true` and
`timeout: 7200` seconds, checked by `scripts/lib/check-lead-chat-wiring.mjs`.
The checker rejects a Codex Stop watcher, uses a 10 s request budget for probes,
and retries a failed probe once before reporting failure.
Install before starting a session: adding the hook to a running desktop
session was not picked up (probe #14696).

The watcher long-polls `/chat/wake?session=...`, writes a batch to stderr,
reports delivery after flush, persists printed ids for later confirmation
by `lead-chat-hook.mjs` and exits 2 to request a new turn. It does not
itself report confirmation. A newer watcher for the same session displaces
the old one, which exits silently. Connection/socket failures and 5xx retry
silently every 5 s; other non-200 responses, malformed JSON or no deliverable
batch stop it. Its own deadline aborts 7100 s after start, before the hook timeout.

Probe #14696 established idle rewake and Stop re-arming in **attended Claude
desktop leads** (also interactive Claude CLI), not Codex or unattended runs.
A lead beyond the watcher lifetime is out of reach until its next turn
re-arms it; desktop behavior at timeout was not established. `wake: true`
is only for "act now": past the prompt-cache lifetime a wake re-reads the
whole context as cache creation, not merely the new post. Do not narrate
lead traffic to the operator; address only who must act.

### Board and HTTP boundary

The loopback board's Chat panel polls its own `GET /api/chat` independently
of `/api/dashboard`. It shows live handles, the newest 50 posts oldest first,
and waiting/delivered/confirmed recipient status; an address array containing
`all` expands to broadcast recipients rather than a recipient named `all`.
The operator composer posts
as `operator`, has a 600-character counter and an explicit Wake checkbox;
its empty To field means **all**, unlike an omitted tool address (log only).
Enter sends, Shift+Enter inserts a newline.

The LAN listener also serves `GET /api/chat` with `after`/`limit`, posts and only `handle`/`bound_at` binding fields plus the `watchers` count and `readOnly: true`, so the board shows chat without post or release forms, with the receipt states of the loopback board (it reads the held wake polls of the loopback server); all other chat routes, `/tasks`, `/mcp` and non-GET methods remain 404 there.

The loopback chat routes are:

| Route | Purpose |
|---|---|
| `GET /api/chat?after=<id>&limit=<n>` | Read-only log and live bindings; default limit 50, maximum 200. |
| `GET /chat/unread?session=<id>` | Offer oldest pending posts (up to 20) without receipts. |
| `POST /chat/delivered`, `POST /chat/confirmed` | `{session, posts}` receipts, at most 200 positive post ids. |
| `POST /chat/post` | Operator post `{body, to?, wake?}`; no lead binding. |
| `GET /chat/wake?session=<id>` | Hold for a never-delivered addressed wake; a newer same-session poll supersedes it. |

The loopback listener rejects non-loopback Host/Origin. Operator posting
additionally requires the daemon's exact Origin and `X-Orch-Chat: 1`;
receipts require that header and either no Origin (hooks) or the exact daemon
Origin. There is no CORS/preflight grant to a page on another localhost port.
This is not authentication against local processes of the same user.

### Tasks board

`http://127.0.0.1:7760/tasks` is the operator's task board (task 2189, decision
#15090): the open tasks of the memoryctl store grouped by domain, with create,
edit, block, cancel, done, assign to a live lead, and advice or a duplicate
search by a scout seat. memoryd stays the one writer; the daemon proxies
`/api/tasks*` on the loopback server only, behind the same Host/Origin guard
plus `X-Orch-Tasks: 1` for a write. Contract, routes and the page seam:
[TASKS-BOARD.md](TASKS-BOARD.md).

## Seat instruments and the role matrix (task 1436)

Operator decisions #10522 and #10523: orch chooses each seat's instruments and makes the seat
use them. rtk rewrites only commands that are in its own registry. Pi needs no catalogue package:

| What | How |
|---|---|
| rtk | rtk's own Pi extension (`rtk init -g --agent pi`, installer step `pi-rtk`) asks `rtk rewrite` on every bash call |
| codegraph, memory | pi-mcp-adapter `directTools`: `codegraph_explore` and `memoryctl_memory` are ordinary Pi tools; booharness and brightdata stay behind the `mcp` proxy |
| orch extension | `src/pi-extension.ts`, passed with `-e`. A read-only seat's bash runs only what `src/seat-guard.ts` allows: bare program names on an allowlist, no redirection to a file, no substitution. `node` passes only as three read-only orch commands of either the seat checkout's own `ops/orchestrator/src/main.ts` or the `main.ts` beside the loaded seat guard (tasks 2142 and 2216, decision #14672): `status`, `pick-stats [--json]` and `wait <turn> [--json]`; a node flag, another script, a `..` segment, a relative script after a `cd`, an extra argument or any other verb (`review-plan` writes Jev events) is refused, and the refusal names the three forms. A coder, reviewer or bughunter seat's bash is also refused `git stash` (only `stash list` and `stash show` pass): the stash stack is shared by every worktree, so set work aside with a WIP commit on your seat branch and build a base with `git worktree add`. It records the command that actually ran in `details.orchCommand`. Every bash call is capped at `SEAT_BASH_TIMEOUT_SECONDS` (600 s), or a shorter timeout the seat asks for. The 45 min bound (`SEAT_BASH_BUILD_TIMEOUT_SECONDS`) applies only when every unwrapped segment is a `heavy()` build, a cmake configure (`-S`/`-B`, `--preset`, or a source dir), `ctest` running tests, or a plain `cd`; any other segment keeps the 600 s cap. Configure and ctest do not take a build slot. A seat whose Pi did not load it fails to start |
| skills | `--no-skills`. The role's own skills (`roleDefaults` in `.agents/domains/_skill-map.json`) are inlined into the first message; the routed rest are listed by path |
| context | a `## Your instruments (Pi)` section in every Pi seat's first message |

Every seat card on the board shows:
- the model the provider reports and the effort;
- the role's skills: lit when inlined, and lit for a listed skill once its SKILL.md was read;
- a red rtk badge only for commands that ran without rtk although `rtk rewrite` would have changed
  them.

Lead cards count the lead's own tool calls from its session log.

`src/profiles.ts` is the role matrix: which families take each role, at which model and effort.
- Scouts: opencode glm-5.3-flash, grok 4.7 low, qwen3.8-flash low, mimo-v2.6-flash low.
- MiMo researcher uses mimo-v2.6-pro medium; debater, coder and reviewer use pro high; bughunter uses pro high, Pi's highest accepted level for MiMo (its model catalog has no `thinkingLevelMap` for `max`). No native MiMo CLI route.
- claude runs native Claude Code (decision #11849; Pi anthropic is an explicit
  opt-in) as researcher, coder, reviewer or plan critic (not a plain scout).
  Claude reviewers and critics use claude-sonnet-5-5 high; coders stay on claude-opus-5-5 high (#13875).
- A bughunter runs at `max`.
- `seat_create` refuses a family outside the matrix.
- Without `family`, a family at or behind pace is picked first, by need (unspent
  over the share of the longest readable window still left). At or behind pace
  reads the spent budget against elapsed; open seats' reservations lower the need
  that ranks the group but never move a family out of it (task 2974). A family ahead of pace
  then ranks by pace headroom in days of that window (decision #14790; #11851 for
  the ahead group). An automatic coder pick steps aside at 5 working coders
  (decision #14790); a named family is never refused by the cap.
  Kimi paces on its month like every family; its 5h window only throttles (decision
  #14189 revises #12717). Negative headroom ranks and is not blocked for that deficit;
  a named family bypasses the ranking, not the existing creation guards.
  Shorter or equal-length applicable windows only throttle. A throttling window without a calibrated burn carries no reservation,
  only the 5% floor (plus any family-specific reserve).
  A family under 5% left is out, a per-turn burn estimate vetoes a turn that would not
  fit, paused families (`main.ts pause <family> --reason "<text>"|unpause <family>|paused`) are out, unreadable ones last. The lead's families
  (except for a coder seat, decision #11829, or an eligible Claude reviewer/critic, #13728/#13875), the author's (`author`), every coauthor's and a sibling reviewer's step aside. `picked` shows the evidence.
- A reviewer needs `base` (the commit that holds the whole change; the brief names its diff range) or
  `snapshot` (uncommitted work, `git diff HEAD^`). Each task (one title in one
  repo) gets at most two reviewers. An accumulated diff spanning unrelated themes gets a separate title and reviewer set per theme (decision #12934), not one shared set.

## Install as a service

```bash
node ops/orchestrator/install.mjs --dry        # print the plist / task XML; touch nothing
node ops/orchestrator/install.mjs              # write, (re)load, start; idempotent
node ops/orchestrator/install.mjs --uninstall
```

The harness installer runs it as step `orchestrator` (`--skip-orchestrator` to
skip). It runs `npm ci --omit=dev` when the dependencies are missing, and reports
`skipped` (never a failed install) without npm or from a linked worktree. Under a declared `--home` or a foreign `--platform` it writes the file and
never calls launchctl or schtasks. The MCP entry comes from
`ops/bootstrap/mcp-servers.json` (`orch`, leads only through `runtimes`).

Typecheck: `npx tsc --noEmit -p ops/orchestrator/tsconfig.json`.
Claimed-check reruns allow typecheck, lint (`npm run lint` or `npx eslint .`),
`cargo check -p <crate>` (offline), `node --check <file>`,
`node scripts/check-*.mjs` and one test file (`node --test <file>`,
`node scripts/test-*.mjs`, `npx vitest run <path>`); a suite command
(`npm test`, `cargo test`) is not rerun. Tool and
script paths remain realpath-confined to the checkout.
