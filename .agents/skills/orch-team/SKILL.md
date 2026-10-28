---
name: orch-team
description: "Lead worker seats through orch (the seat_* MCP tools): pick the role, let orch pick the family by pace on its budget window, brief in 300 words, wait without polling, accept unflagged reports, review the accumulated own diff with zero, one or two seats as review_plan decides. Use when the lead hands work to seats, says 'review', 'scout', 'bughunt', 'research', or the work is bigger than one file."
---

# orch-team — leading seats through orch

orch is the local daemon at `127.0.0.1:7760` (MCP `orch`, board at
`http://127.0.0.1:7760/`). Its rules are enforced in code; this page is what
the code cannot enforce. Reference: `ops/orchestrator/README.md`.

**The board for the operator** (operator decisions #10530, #17572 and #17608):
a Claude desktop lead never opens the web board, also not after a handover and
not when it cannot see the pane: the orch-board mod pane is the operator's view,
and he opens it himself with `/orch-board`. Codex desktop opens
`http://127.0.0.1:7760/` in its browser.
The board is the operator's view of the seats; do not read it into your context.

**Not every task gets a seat.** A trivial or single-file change: do it yourself.

## The lead chat

At start, run the `chat_join` line SessionStart prints, replacing `<track slug>`
with your track's handle and keeping its `session` id. SessionStart prints the
instruction; it does not join for you. Pass `desktop` too: the `sessionId`
that `get_session "self"` answers (the desktop session id, not the hook session
id), so that a lead can reach you with one desktop message when no watcher
holds you. A lead with no such tool leaves `desktop` out, and a join with no
`desktop` keeps the stored one. A successor joins the same handle with
its own session id; a superseded predecessor cannot reclaim it until the
operator releases the handle on the board (Chat panel, "Release handle"; task
2155). After a release any session joins next. A post refused with "live
binding" means your handle was released or superseded: run `chat_join` again.
A post to a handle that was never bound is refused: the refusal names each unknown handle
and lists the live ones, and nothing is written; a handle with rows but no live binding is
accepted and the answer carries `notLive`. `operator` has no binding: a lead never addresses
it. On the board an `all` post hides an addressee row that has no receipt and whose binding
was last seen over 24 hours ago; a named post keeps every row (task 2305).

- Coordinate with other leads in orch chat, not in operator replies. Use
  `chat_post {as: "<track slug>", session: "<session_id>", body, to?, wake?}`.
  A body holds at most 600 characters; longer posts are refused.
- **Address every post, as narrowly as it reaches** (operator #14757). One
  lead: `to: ["<handle>"]`; several: `to: ["a", "b"]`; everyone joined:
  `to: "all"`. A handle is a track slug, and the board lists the live ones.
  `all` is for what changes every lead's work (an orch restart, a new commit
  rule); anything else names who must act or must know. A landing notice
  names only the leads whose files or waits it touches: a feature commit is
  never an `all` post (operator #14945). Omit `to` only for a log line that
  is injected into nobody. An address does not wake its lead (below); the
  post is injected into that lead's next own turn, so every name still costs.
- **Post only what another lead must act on, or must know to do its own
  work** (operator #14945, 2026-10-07). A fact for the record with nothing
  owed (a check that passed, "for your record", a seat failure nobody must
  fix) goes to memory with `memoryctl append`, not to the chat: each addressed
  post is injected into its addressee's context, and a `wake` post costs a
  turn that reads that whole context again.
  Measured 2026-10-07: of 141 posts, 59 were start lines with their answers
  and 25 were restart consents.
- **An app start takes a lease, not a start line** (operator #14945, task
  2171, plan #14955). Before a start, run the main checkout's script with the
  handle and the session id of your live chat binding:
  `node scripts/app-lease.mjs take --as <handle> --session <session_id> --minutes <1-180> --note "<what, which host>" <resource>...` (`scripts/app-lease.mjs` not in this kit)
  - Resources are slots of the account pool: each instance runs on its own
    terminal account, because one account holds one live instance (operator
    #15099, plan #15109). `mac-window` (root `lead1`, port 5183) and `mac-2`
    (root `lead6`, port 5188) are the two app instances on this Mac. The
    operator signed `lead6` in on 2026-10-10, so both run signed at one time;
    start `mac-2` with `PERF_PORT=5188`.
    `win-1` to `win-4` are four instances on <configured-windows-host>, roots `lead2` to
    `lead5`, ports 5184 to 5187; the word `win` is the lowest free one. A
    start on the Mac takes `mac-window` or `mac-2` by name, a start on win
    takes `win`. A take is all or nothing.
  - `take` and `show` print `root=`, `port=` and `label=` for each slot you
    hold. Start the instance on that root: on win
    `node scripts/perf/win-perf.mjs --root <root> ...` (`scripts/perf/win-perf.mjs` not in this kit) takes the slot's port by
    itself when `PERF_PORT` is not set; on the Mac a signed root needs
    `PERF_BRIDGE=1`. A second win slot is a named take (`win-2`): a bare `win`
    extends the slot you hold.
  - The operator signed each root in himself, with "remember" on (#15110): a
    signed root lives until its password changes or the root is deleted. No
    agent types a password, copies a root or deletes one (#13049). A root that
    shows the login form is not signed in: stop the instance and tell the
    orch-nodes lead. A check on both hosts uses two accounts and two
    workspaces.
  - `account` is the operator's own session, and the lease still accepts it.
    While a signed-in slot is free, no lead starts an instance on his account
    or on the root `signed-in`: take the slot.
  - Exit 0: the lease is yours. A start needs exit 0 AND your own check on the
    host of the start (pgrep, the port, `instance.json`; on win the process
    list): the lease does not look at processes. Take again to extend.
  - Exit 3: another lead holds it. The refusal names the holder, its promised
    end and its note, and nothing is written. Wait, or ask the holder in the
    chat: that is the only chat post a start needs. Set `wake: true` on the
    ask only when you cannot wait for the promised end.
  - `release --as <handle> --session <session_id>` frees everything you hold.
    Run it when the instance has stopped, never before.
  - A lease never frees itself: past its promised end it is overdue and still
    held. `--takeover` replaces an overdue lease only, and needs the holder's
    "free" in the chat (ask with `wake: true`: an overdue holder is idle) or
    your own check on BOTH hosts.
  - `take ... --wait`: a refused take (exit 3) also puts you in the advisory queue of each
    refused resource (`win` queues on `win`). When the holder releases, you get ONE chat post
    from that lead: the resource is released and you are first in its queue; take it and run
    your own host check. The queue promises no lease: the next take decides. `take` and `show`
    print who waits; a wait row goes when you take the resource, when your binding is not
    live, or after 24 hours (task 2305).
  - `show` lists the leases. Exit 4: no live binding, run `chat_join`. Exit 6:
    the lease file cannot be read; that is never "free": check both hosts
    before you remove the file.
  A start without a lease is a violation. A lead that starts no app owes
  nothing here.
- **Short, and only what the reader can use** (operator #14757). One post is
  one fact or one request: what changed or what you need, the id that holds
  the detail (a sha, a memory id, a seat or turn id), and by when if it
  matters. No greeting, no restated context, no account of your own progress,
  no thanks. What does not fit 600 characters belongs in memory: post its id.
- **A post does not wake an idle lead** (operator #15057, 2026-10-07; the first reply to a wake post is the exception below; it
  replaces #14795 and #14818). A post, named or to `all`, reaches its
  addressee at that lead's next own turn, through the hook injection. A lead
  that stands waiting for a seat sees it when the seat finishes: minutes,
  sometimes tens of minutes. A log line never wakes. The operator's board
  posts wake only with his Wake checkbox (#14783).
- **A task the operator assigns from the tasks board is an order to start
  now** (operator #15281, 2026-10-08). The post `Task #N assigned to you`
  from the handle `operator` comes with `wake` and the task is already
  claimed for your handle and `in_progress`. Read it
  (`memoryctl task show --id N`) and take it into work in that turn. In the
  middle of other work: it is next, or it runs in parallel through seats; it
  is never parked without a reason he can see. Write your first step into the
  task at once, `memoryctl task update --id N --next "<step>"`: the board
  shows it, and no acknowledgement post is wanted. If the task is not yours
  to do (another track owns the files), say so in the task's `next` and tell
  that lead in the chat; do not release it silently.
- **Set `wake: true` only when the addressee must act now and you cannot
  continue without that act.** A question that can wait an hour is not
  urgent. One wake reads the addressee's whole context again, about 251
  thousand cache-read tokens (memory 15055); past the prompt-cache lifetime
  the woken turn is cache creation (probe #14696). A restart that interrupts
  turns sets it; a drain notice and a landing notice never do. Idle wake is
  established for attended Claude desktop leads within the watcher's
  lifetime, not for Codex or unattended runs.
- The first post back to a lead whose named wake post reached you in the last
  24 hours wakes that lead even without `wake`, and the answer names that post
  in `replyWake`. A reply that also goes to `all` is not promoted. Pass
  `class: "fyi"` when that reply must not wake; `class: "fyi"` with `wake: true`
  is refused.
- **The board says what happened to a post**, per addressee: `read`
  (confirmed), `delivered` (printed, not confirmed), `pending` (no receipt; a
  watcher is held or the post is under two minutes old; a post without `wake`
  stays here until its addressee's next own turn), `no watcher` (no
  receipt after two minutes and no held poll: the lead is deep in a turn or
  its session has no process). The handles line counts the held watchers.
- **A wake post answers who will get it** (task 2160 slice A2, plan #15380).
  The answer of `chat_post` with `wake: true` holds `addressees`, one row for
  each live addressee: `handle`, `state`, `lastSeen` and `desktop`. A post
  without `wake` answers as before, unless `replyWake` promoted it.
  - `watcher`: a poll is held; the lead wakes now.
  - `in turn`: no poll, but its session made a request in the last 3 minutes;
    the hook delivers at its next tool event. The 3 minutes are an assumption
    and are not measured.
  - `no watcher`: nothing will deliver the post. When you cannot continue
    without that lead and its `lastSeen` is within 6 hours, send ONE desktop
    message to its `desktop` id (`send_message`) that names the post id and
    never the body. A lead seen longer ago is started only when the post names
    it and the act is needed: such a start reads its whole context.
  - A `desktop` of null (a Codex lead, or a join before this change) is reached
    by the operator only.
  - A desktop send is refused after 10 sends since your user last typed: report
    that refusal to the operator.
  - For one minute after an orch restart do not trust `no watcher`: the
    daemon's request times start empty.
- **After a desktop app restart no watcher lives** (evidence #14813): the
  count is zero and no post wakes anyone. The operator types into ONE session,
  orch-nodes, and that lead sends ONE wake post to `all` and applies the rule
  above to its answer: one desktop message for each `no watcher` lead that was
  seen in the last 6 hours. `list_sessions` is not needed. Each lead's turn
  then re-arms its own watcher.
- No acknowledgement posts: no "read it", "received" or join announcement.
  A reply supplies the requested action or decision, not a receipt.
- Never narrate lead traffic to the operator. The board is their view.
  Chat is coordination; memory remains the durable record of decisions.
- `chat_read {as, session}` reads and confirms unread posts; `all: true` reads
  the log without changing receipts. Hooks bring addressed posts into the
  next eligible prompt/tool event; duplicates are possible, so do not repeat
  an action merely because its post is injected again.

## Roles

| role | for | seat |
|---|---|---|
| scout | facts across 3+ files, logs, memory; one question; never a design or a "how to"; never a measurement (a node, sqlite or timing run): a tester or the lead runs it (task 3227, operator #20706) | read-only (rg, codegraph, memoryctl search), cheap families only, closes after one answer |
| researcher | the open web: versions, docs, prior art | read-only, one question, URL and date per claim; this Mac or a host with brightdata-web (`BRIGHTDATA_API_KEY`) |
| debater | a fork with two defensible answers; two seats, one side each | read-only; one answer, then one rebuttal of the other side |
| coder | an agreed plan with a named check | own worktree, branch `orch/<seat>`, kept for landing |
| tester | proof by tests: a change, a defect, a user path (Test 0 or Test 3) | own branch worktree, landed like a coder, outside the coder cap; writes only test files, fixtures and `captures/**`; `seat_land` refuses another path unless `override_reason` says why |
| designer | a new look or a redesign of a surface, desktop terminal UI or web: directions, the chosen one, canon checks | own branch worktree, landed like a coder; writes only `src/**/*.tsx`, `src/**/*.css`, `web/apps/**`; this Mac or a host with brightdata-web (`BRIGHTDATA_API_KEY`); reads images by default |
| copywriter | web copy and metadata, SEO, locale strings, academy content | own branch worktree, landed like a coder; writes only `web/apps/**`, `src/locales/**`; this Mac or a host with brightdata-web (`BRIGHTDATA_API_KEY`) |
| legal | a diff or page that touches legal copy, payments, personal data or consent (Russian law) | reviewer rights: `base` or `snapshot`, nothing lands; this Mac or a host with brightdata-web (`BRIGHTDATA_API_KEY`) |
| security | a diff on a security path: threat model, reproduced PoC | reviewer rights: `base` or `snapshot`, nothing lands; bughunter matrix at max effort |
| reviewer | the accumulated diff of a task | disposable worktree at `base` or `snapshot` |
| critic | a plan that changes existing behaviour, before any code | read-only, reviewer matrix, one answer, never routed |
| bughunter | reproduced defects in existing code, not a diff | disposable worktree, max effort |

## Using the specialist roles

### Which role

Pick the role by the work before you create a coder (task 2953: in 10-17..10-24 leads made 985 coders, 2 testers, 5 designers, 1 security seat and no legal seat). orch adds a reminder to the `warning` of a coder's `seat_create` and first `seat_prompt` answer when the files or Jev's reading of the brief fit a specialist; switching means closing the coder and creating the role seat.

**`role: "auto"` picks tester or coder for you** (task 2955, operator #19868). Pass `brief` (the first-turn brief, the same 300-word rules) and `files`, no `seat_prompt`: orch creates ONE seat, queues the brief as its first turn and answers with `turn`, `wait` and `picked` (role, rule, Jev numbers, `next`). Rules in order: every file is a test file, or Jev reads tests only → tester; Jev reads a reported defect → tester with a Test 0 line, and `next` says "then a coder on the red test"; else coder. Jev unavailable refuses: pick the role yourself. It never picks a designer, copywriter, legal or security seat: create those by role. After the orch restart that brings `auto`, reconnect the orch MCP before you pass it.

- **A reported defect:** a tester writes the red test first (Test 0), then the fix coder gets that test.
- **Tests, fixtures or captures only** (regression cover, a test migration): a tester, not a coder.
- **A user-visible change, desktop terminal or web, before you call it done:** a tester walks the same user path before and after (Test 3); for a desktop or visual kit you hold the lease. An entry point (a button, a menu item) is walked together with the surface it opens (operator #13245).
- **How a surface looks** (layout, spacing, colour, type, icons, the look of a new dialog, panel or component), in the desktop terminal (`src/**`) as much as on the web (`web/apps/**`): a designer. Work with a look part and a logic part (an indicator's computation and its appearance) is one task with two seats on disjoint files: the designer sets the look (colours, line styles, defaults, the `.tsx`/`.css` settings form, mocks), the coder writes the logic and any `.ts` renderer code (chart-engine draw code is outside the designer's write scope). A designer needs an image-capable family; orch picks it and the host. Without a Jev reading orch adds no reminder; this list decides.
- **Text a user reads** (dialog, button and error strings in `src/locales/**`, web copy, docs, academy): a copywriter.
- **Legal copy, payments, personal data or consent:** a legal reviewer besides the ordinary one. **A security path:** a security seat besides `review_plan`'s count.
- **A defect hunt in existing code without a diff:** a bughunter. **A fork with two defensible answers:** two debaters. **A plan that changes behaviour:** a critic before any code.

Each role brings its defining skill or skills (`.agents/domains/_skill-map.json` roleDefaults: designer `design-direction`, security `security-and-hardening`, copywriter its product copy skill and `anti-slop` (#19584), legal its compliance skill; the copy and compliance skills are product-bound and kit-excluded, so read their names in roleDefaults). Its other skills are trigger candidates that Jev filters against the brief, so a brief that names the surface and the task brings them; the brief does not name skills. Researcher, designer, copywriter and legal run on this Mac or a host with brightdata-web (`BRIGHTDATA_API_KEY`); this Mac always offers it. Legal and security share the reviewer class with reviewer: one family never takes two of them on one title, the cap of 2 counts per role, and the author's family steps aside for each as for a reviewer.

- **tester.** Pick it for proof by tests: Test 0 reproduces a reported bug before any fix (a test that fails on the target commit); Test 3 accepts a landed change by the same user path, before and after. Brief: mode, kit (desktop, visual, web, data, install), target (the report, or the landed commit and its base), the user path with expected and observed results, `files`; for a desktop or visual kit the lease you hold (root, port, minutes): the tester never takes a lease and never starts the app. Report: the coder contract; `criteria[0]` is the verdict (reproduced, not reproduced, accept, reject). Land: `seat_land` as a coder; to hand a red test to the fixing coder, land it into a task worktree and create the coder with `repo: <task worktree>, snapshot: true`. A flagged change of an existing test needs the commit to name the changed behaviour (#14245). Limits: outside the coder cap, no blocker rechecks.
- **designer.** Pick it for a new look, a redesign or a visual direction with alternatives; a logic change in a component stays a coder's. Brief: the surface and its files, the goal in the operator's words, what must stay (the project's design rules), the captures or lease you have. Report: the coder contract; directions and the chosen one with why; capture paths in `checked`; the project's UI checks in `checks`. Land as a coder; a path outside its scope needs `override_reason`. It reads images by default (`design-direction` requires `input:image`): `images` is true even when omitted, and `images: false` does not turn it off, so a model with no image input leaves the pick.
- **copywriter.** Pick it for page copy, metadata, SEO, locale strings and academy text. Brief: the pages, the audience, the keyword source. Report: the coder contract; each keyword or market fact with its URL and read date in evidence. Land as a coder; a path outside its write scope needs `override_reason`.
- **legal.** Create it as a reviewer of the diff (`snapshot` or `base`, `author: <coder>`) when the change touches legal copy, payments, personal data or consent. Report: the reviewer contract; each finding names the law article, the URL and its read date. It is a review, not advice to the operator.
- **security.** Create it as a reviewer of the diff on a security path (auth, tokens, credentials, install, hooks, Tauri capabilities, IPC). Report: the reviewer contract; each finding names the CWE, a reproduced PoC and the severity. `review_plan` does not create a security seat: it only sets the ordinary reviewer count (a security path keeps at least one; two when own security lines changed and Jev risk is at least 0.7, or when Jev is unavailable and those lines changed). A security seat is extra, and only the lead creates it.

## Screenshots

A lead or seat captures only when a picture is necessary. Prefer tests, logs, DOM and accessibility reads when sufficient. Use the adopted project's documented offscreen capture route; never take over the operator's screen. Set `images: true` when a seat must read a picture. There is no screenshotter role.


## Debate

A fork with two defensible answers goes to two debater seats, one side each (task 2156).

1. `seat_create {role: "debater", ...}` twice, then `seat_prompt` each with the fork and its side. Wait for both first answers. Give the two seats ONE title: the two debaters of a fork never run the same model, so orch steps the second aside from every family that would run the first's model, refuses an explicit family or model that gives it, and refuses a rebuttal between two seats of one model (operator #16088).
2. Rebuttal: `seat_prompt {seat: <A>, prompt, rebut: "<first turn id of B>"}`, and the same for B with the first turn of A. orch appends the stored report of that turn (claims, evidence, forLead) verbatim to the brief, outside the 300-word count. Write only what the rebuttal must answer; never retell the other side.
3. A third turn is refused. The seat closes after its rebuttal.

- `rebut` names the done first turn of ANOTHER debater seat with a parsed report. Anything else is refused, and the message names the parameter. `rebut` on another role or on a first turn is refused.
- A debater that gets no rebuttal closes 60 minutes after its first answer. Close it yourself when you will not rebut it.
- An orch restart between the rounds closes both debaters: create a new pair or accept the first answers.
- You may rebut one side only: nothing ties the pair.
- A first turn that fails or is cancelled still counts as the answer: create a new debater for that side.
- A client that connected before `rebut` existed refuses the unknown property: reconnect the orch MCP or call by JSON-RPC.
- A rebuttal doubles the burn of a debater.

A round table (operator #19423) is debaters on different families answering ONE question. `options` is 2-4 distinct strings, each at most 60 characters, identical on every open sibling of the title; `options` on another role is refused. Use 3-4 members when you want a majority. The table's majority is the decision, and you are the chairman: record it, override only with a reproduced fact and say why, break a tie.

1. `seat_create {role: "debater", options: ["opt a", "opt b", ...], ...}` for each member, all on ONE title and ONE repo; every open sibling must carry the identical list. Each member runs a different model (the fork rule). Pass `session` so orch stores your lead-chat handle: the tally post arrives under the reserved handle `table`.
2. `seat_prompt` each member the same question; round 1 is its initial position, carried in the report's `vote`.
3. `seat_prompt {rebut: "table"}` each member for round 2: each sees every OTHER member's round-1 report anonymized as Member A/B/C. The report's `vote.option` must be one of the options, `confidence` 0..1, and `changedBy` names the other member's new evidence or is null.
4. orch tallies round 2 and posts the result once to your lead chat; a tie or fewer than 2 votes falls to `chairman` (you decide). A member that never votes is listed, not counted.

- `rebut: "table"` on a debater without `options` is refused; a third turn is still refused.
- A debater closed or failed before round 2 keeps its round-1 vote shown, not counted; nothing is recreated.

## Creating a seat

- **Leave `family` out.** orch ranks families on each family's budget window
  (longest quota window; shorter ones only throttle;
  `ops/orchestrator/src/profiles.ts`). A family at or behind a linear pace
  comes first, highest `need` first (`need` is the unspent share over the share
  of the window still left: 1 spends the budget exactly by its reset), so a
  budget about to reset is used before it expires (operator #14790); a family
  ahead of pace follows, by headroom in days. Your own family and the author's
  step aside (your own family does not step aside from a coder seat) — pass
  `session` (your hook session id, the same one the chat tools take) so the
  own-family step-aside covers only YOUR family: without it every lead active
  in the last 10 minutes steps aside, `picked` says so, and one active lead
  can empty another lead's reviewer pool (decision #17805 D2). orch stores
  your family on the seat, so its own recheck reviewer steps aside from the
  task's lead too. Paused
  families are out; unreadable load, a provider outage (20 min) and an auth
  failure (60 min) rank last. For a coder
  seat, so does a family already at its working coder cap (10 for codex and glm, 5 for every other family; `picked` names the cap; every
  family capped falls back to the first-ranked one, and a family you name is never
  refused by it).
  `picked` in the answer says why. Name a family only for a reason you can state.
- Model and effort come from the matrix, and the board card shows both.
  Override only on purpose.
- **Leave `needs` out too.** Distribution exists to offload this Mac (operator
  #12590, #12591): orch probes the Mac and every host in `hosts.json` and places
  the seat on the highest free capacity (free cores and free memory, task 2358;
  this Mac counts 6 cores and 12 GB less, and a tie goes to a host, task 3288);
  claude, native harnesses and stand arms stay
  on the local machine by their configured runtime policy. Adapt project-specific placement rules before enabling remote work. Pass
  `needs: mac`, with `needs_reason` naming the thing (orch refuses a bare pin
  without a `<project-specific>/` file, task 3288), only when the seat must touch
  something that exists only on this Mac: a project runtime installed only there, the orch store or other state under
  `~/.local/state`, a service on the Mac's loopback or credentials kept only on
  the Mac (a host's 127.0.0.1 is the host, and remote seats do not inherit the
  daemon's environment), uncommitted files a scout or researcher reads in place
  (a host checkout holds lead HEAD only). "Its checks were validated on darwin" or
  "orch code" is not such a reason: Node/TypeScript coders, reviewers and
  bughunters run on the host. Pinning coders to a loaded Mac is the mistake this
  rule exists for (2026-09-28: three orch coders pinned while load was 13.8 on
  18 cores and placement already read `local 163 · win 42`). When in doubt,
  read the `placement` in the create answer, not your assumption.
- Researcher, designer, copywriter and legal run on this Mac or a host with
  brightdata-web (`BRIGHTDATA_API_KEY` in the host environment or its prefixed
  secrets file). This Mac always offers it. An explicit `host` without the key
  is refused; automatic placement skips that host (task 2802 slice W).
- While your own timing or memory measurement runs on <configured-windows-host>, create every other seat with `host: "<configured-host>"` (or `needs: mac` when it must reach the Mac) and read `placement.target`: with `needs` left out orch may place it on win (2026-10-12, track page-memory).
- Title = what the seat is for. Reviewers of one task share one title: orch
  compares their findings and caps them at two.
- A create whose answer was lost is retried with the same `request_id`
  (1-128 characters of letters, digits, `_`, `-` or `.`): orch returns that
  seat. Role, title, repo, effective images and the option list must match;
  a different create reusing the id is refused.
- Close with `seat_close {seat}`. A running turn is cancelled. A detached
  worktree (reviewer, legal, security, bughunter) is removed; a branch
  worktree (coder, tester, designer, copywriter) stays for landing. While
  provisioning, the answer is immediate with `closePending: true` and closure
  waits for setup to finish.
- **Land a coder within 2 days.** An idle coder seat is closed after 2 days without a turn, landed or not, and its checkout goes a day later (task 1953, operator #13916). Land before that, or recover the work from branch `orch/<seat>` (a remote coder: `refs/orch/snapshots/<seat>`) and `~/.local/state/orch/worktree-backups/`.
- **One task per coder seat.** A follow-up turn only corrects the same change;
  new work goes to a fresh seat. A correction that opens new work (profile
  first, optimize to a target, redesign) is new work: brief a fresh coder with
  the old seat's findings (decision #12694). coder-codex-a21187 spent about
  50M tokens in five turns, 19M of one turn re-reading its own long session.
- **Small slices.** A coder task is one bounded slice that finishes in one turn:
  one feature or behavior (e.g. 3–5 drawing tools, one cluster mode, one
  indicator group), a handful of files, one named check. Split a large port
  into sequential seats; never brief "port everything missing". A seat that
  returns partial on scope is a sign the brief was too big — cut the next one
  smaller.
- Parallel coder seats need independent causes and disjoint files or resources;
  serialize related failures. Two open coder seats that own the same file are
  serialized, never "resolved at merge".

## The loop

A plan critic comes before any code only when a wrong plan costs more than one
correction turn (operator #15067, 2026-10-07; it narrows decision #13250). For
every other plan the reviewer of the diff is the check. Create a critic when
the plan holds any one of these:

- **Existing behaviour changes in more than one coder slice.** A wrong plan is
  then paid for in every slice.
- **A step that a revert of the commit does not undo:** stored data or its
  format (a store schema, a migration, ClickHouse, memory), a deletion of
  data, a run against production or the operator's account.
- **A contract that code or agents outside the diff rely on:** the schema or
  the meaning of an MCP tool, a wire or file format, a hook or gate that every
  session or seat passes, a CLI verb that a script calls, a `public.ts`
  boundary.
- **Concurrency, restart or recovery, integrity, money or trading, credentials
  or security:** the paths for which `review_plan` asks for two reviewers.
- **The removal of a guard, a check or a rule** whose reason you cannot name
  by a memory id, a lesson or a test.

No line holds: no critic. That covers additive work; one slice in one module
that a revert undoes, whatever behaviour it changes, and also when the
operator stated the new behaviour himself; a fix of a reproduced defect with
its failing test; a mechanical change (a rename, a move, unused imports,
lint); text only (skills, pages, docs); tests only; a measurement. An
assumption about existing code that you did not check is a scout's question,
not a critic's. The operator's word to call or to skip a critic outranks this
list.

Measured 2026-10-07 (orch store, 170 critic turns in 6 days, about 28 a day):
one critic costs a median of 0.83M tokens and 6 minutes (p90 12.5) before the
first coder starts; 34 reports held a blocker and 116 a finding that the
critic itself rated major.

The critic is one seat created with
`seat_create {role: "critic", ...}`, holding the task and your plan; its context
carries [plan-critic](../plan-critic/SKILL.md) as a role default, so the brief
needs no opening words. The
role puts the seat on the reviewer matrix's model at high effort, never on the
scout tier, and keeps the named plan author's and every coauthor's family out
(operator #13286). `author: <seat>` names a seat that drafted the plan. Yours
steps aside even when named, except Claude may take a critic seat when no named
author or coauthor is Claude (#13875); `author` may be omitted. Claude reviewers
and critics run claude-sonnet-5-5 high; Claude coders stay on Opus. Leave
`family`, `model` and `effort` out; a critic is never routed. A plain scout
briefed with the words `Plan critic` is not refused and gets a scout-tier answer
with no skill: create the role instead. `role: "scout", critic: true` still
makes a critic (an alias kept for one release).
Answer its findings in the plan, then brief the coder.

One pipeline per task; do not announce your own order or add steps to it:
brief → wait → accept the digest (check only what a flag names) →
`review_plan` → reviewers on the accumulated diff → `seat_land` →
`npm run check:commit` → commit (unasked once the change is verified and
reviewed, PRIME 7; otherwise with the operator's word). The operator sees progress on the board, not in
chat step lists.

- In a multi-slice task, run `npm run check:commit` on the landed paths in the task worktree before `review_plan` (10-minute timeout): the gate records nothing, and a refusal after approval costs a coder turn and a reviewer turn (tasks 2458, 2456: about one hour).
- Before the commit, also run each existing test file that names a changed product file, one file at a time with a bound: the commit gate runs no vitest (fab209f46 broke 3 tests of `drawingVolumeProfile.test.ts`, task 2466).

## Brief and wait

- The brief is English and at most 300 words: task, owned files, evidence,
  acceptance, and out of scope: each thing the seat must not do, with its reason
  (an exclusion without a reason is a default the seat fills in; decision #12668).
  Pass repo-relative `files` of the area (the suspected area for a bug with an unknown cause) to select knowledge pages, lessons and skills; a first coder, tester, designer, copywriter or bughunter brief without files in the brief or seat is refused, while a reviewer inherits its author's files or warns (decision #17906).
  Link large artifacts, never paste them. A brief over 300 words is refused unless `long_brief` says why it cannot be shorter.
- The brief names the touched module ids. The seat's first context carries their
  contract summaries in its `## Modules` section. A coder that changes a Public API also edits its contract.
- Run the returned `wait` command as a background task. You may send a
  follow-up to a busy seat: orch queues it FIFO (at most 5 queued turns) and
  returns its own turn id and wait command; each wait reports its own turn.
- **Several turns: ONE wait** (operator #15073, #18497):
  `node <main checkout>/ops/orchestrator/src/main.ts wait <turn> <turn>...` as
  one background task. It returns when every turn has ended, or 180 seconds
  after the first one ends (`--grace-seconds n`), prints the ended digests in
  argument order, and ends with `still running: ...` and the command for the
  rest: run that command as the next background task. One notification is one
  lead turn that reads the whole context again, so turns that end close
  together cost one turn, not one each. Exit 0: every ended turn is done; 1: a
  turn ended otherwise or orch stayed unreachable; 3: the timeout
  (`--timeout-minutes n`) passed with nothing ended. One id behaves as before.
  Use `seat_wait` only where you cannot run a background task (Codex desktop).
  A coder prompt's `overlap` warns of shared files with open coder seats; `overlapUnchecked` names failed git observations. Serialize or coordinate, never treat either as a refusal.
- The wait command and `seat_wait` return a compact human digest; flags are at
  the top. Use `wait --json` or `seat_wait` with `json: true` for full JSON.
- **No flags: accept the report as it stands.** A flag names what to check;
  check only that. Call `seat_report` only when `report` is null.
- A report's `memory` list is only a proposal: inspect the digest (links and body shown), then select zero-based indexes with `memory_apply {turn,pick?}`. For supersede/retire, the first call previews live kind/title without writing; verify it and call `memory_apply {turn,pick?,confirm:true}` to approve. It stops on the first refusal; never treat the digest or preview as approval.
  A refusal is fixed, not dropped: it names the field, the expected
  `- rule:` / `- why:` / `- evidence:` lines and the budgets; rewrite the lesson
  with `node scripts/memory/capture-lesson.mjs` (its `--help` lists the budgets).
- A brief holds no precondition only the lead can check (another lead's word, a lease): mark it done in the brief with its evidence (post id, lease end), or the seat stops as blocked (memory 17255).
- A load proof on the Mac is bounded: at most 6 busy processes for at most 2 minutes, or it runs on a remote host (task 2413: 24 busy processes made the board answer in 6.25 s and a `seat_create` time out).
- A measurement seat on <configured-windows-host> gets: the proven harness directory on the host and a rule for what it may change there, with the watchdog deadline at the lease end; the sentence that the lease authorizes a visible window through `schtasks /IT` (`--offscreen` is Mac only), repeated in each follow-up turn, which can start in a fresh session; one validation start; `files` on `seat_prompt` (memory 16600: two turns and 1.9M tokens lost).

## Language

- While `node ops/orchestrator/src/main.ts language` prints a mode that is not
  `off`, a brief, a report and a chat post are written in ASD-STE100.
- The rule block reaches a seat in its first message and a lead at session
  start: this skill does not repeat the rules.
- The lead sees the check on the `seat_prompt` answer, the `chat_post` answer
  and the turn digest.
- In `enforce` a brief with a rejected word, an unknown word or a long sentence
  is refused, and the refusal names the words. A chat post and a report are
  never refused.
- The switch is `main.ts language off|flag|enforce`; `enforce` is the
  operator's word.
- Never judged: code, commands, paths, identifiers, quoted evidence, the
  operator's Russian quotes. Replies to him stay Russian.

## Review

- The reviewer brief uses the touched modules' invariants as its invariant list.
- Call `review_plan {seat: <coder seat>}` (or `node ops/orchestrator/src/main.ts review-plan <seat>`) for count and concern-based focus: every reviewer examines the entire accumulated diff, never an exclusive file slice; Jev failure is labelled and the floor remains.
- Count (operator #17931), for a coder seat, repo with base, or snapshot alike:
  exclude a changed file only when a parent `VENDOR.json` lists its folder-relative
  path under `files` with the SHA-256 of its reviewed Git blob. Manifest shape:
  `{source, sha, path, license, files: {"relative/path": "sha256"}}`.
  Differing bytes count as own code; no upstream network check. `VENDOR.json`
  and `NOTICE` are documentation. Documentation-only stays zero. Jev judges the
  complete remaining own diff: below 0.2 gives zero, 0.2 to below 0.7 gives one,
  0.7 or more gives two. A security path retains at least one; two requires
  changed own security lines and risk at least 0.7. Jev unavailable or a cut
  diff gives one (two when own security lines changed), labelled. The answer
  names excluded `vendored` paths and `jevRisk` per theme (null when not scored).
  At zero, spot-check the report's evidence yourself. Never your own family, never the author's
  (`author: <coder seat>`). The one exception (operator #13728): claude may review a change
  another family authored, even under a claude lead, and only when `author` names that
  non-claude coder and every coauthor is non-claude; a claude author or coauthor, or no `author`, never lands on claude. Take review_plan's count as given: a second
  reviewer comes from review_plan, never from the
  lead adding one by hand.
- **One theme per review** (operator #12934): a review batch holds slices of
  one theme only, because each theme brings its own invariants, knowledge page
  and lessons, and a mixed brief dilutes them (unrelated application features never
  share a reviewer). `review_plan` splits a diff that spans several domains into
  `themes`, one reviewer set per theme, titled by the theme and briefed on its
  paths. Inside one broad domain the
  lead batches by feature: rendering, a panel, the shell, backend logic.
- **A multi-slice task is reviewed once per theme** (#12879): make a task worktree from
  master, create each slice's coder with `repo: <task worktree>` so it builds on
  the previous slice, `seat_land {seat, into: <task worktree>}` each finished
  slice, then one `review_plan {repo: <task worktree>, base: <master sha>}` and
  its reviewers on the whole task. Commit once, after the batch is fixed.
- **Fix findings in one batch** (#12879): wait for every reviewer of the task,
  then send the coder ONE correction turn listing all reproduced blockers (and
  the notes worth fixing); never a correction per reviewer.
- **Invariants first** (operator #12792): for a diff touching concurrency,
  persistence or integrity, data loss, deletion or recovery, the reviewer
  brief lists the 3–9 invariants the change must keep (what must never be
  lost, run twice, skipped or left half-done, on every path including restart),
  and asks for a verdict with evidence per invariant. Name invariants, not
  suspected bugs: the list steers attention, it must not hand over a conclusion.
- **Three lenses, author claims last** (operator #19645, BMAD study 19640):
  every reviewer runs the three lenses of
  [review-verification-protocol](../review-verification-protocol/SKILL.md)
  (verification gap, implicit branch, deleted behaviour; stale map when the diff
  touches a knowledge page, #19762) and tags each such finding. The brief puts the requirement, the range and the invariants first
  and the coder's claims and evidence in its LAST block, headed
  `Author claims: check after your own trace`.
- **A defect this diff caused is never deferred** (#19645): a reproduced one is
  fixed in this task's correction turn, never parked as a follow-up task or a
  `// debt:` note. A defect the diff did not cause stays a separate task.
- The reviewer-count policy is re-measured from `main.ts pick-stats`: recall AND
  precision (share of blocker/major findings reproduced) per family, not recall
  alone (arXiv 2603.11078, task 1562).
- Review once per task, on the **accumulated diff**: give `base` (the commit
  that holds the whole change; brief the requirement and exact `base..head` range,
  never session history) or `snapshot` for uncommitted work. Never review per edit.
- Before acting on a finding, check the current code's invariant, supported
  platforms and operator decisions; push back with code or reproduced evidence.
- A blocker is reproduced (a command, a failing check, a log); anything else is
  a note. Adjudicate from the reports. Never pass findings between seats to make
  them agree.
- Fixing a note or minor finding: your own check (tsc/lint/cargo check on the
  touched path), with no re-review. After a coder correction turn (not its first) finishes done, orch
  routes each authored reviewer whose latest report has reproduced blockers
  by a code rule: a fix whose every changed path the blockers name gets a
  recheck on the **same** reviewer, limited to them; any other changed path brings a **new**
  reviewer from a family no earlier reviewer, the author or the lead used, on
  the whole diff, and the old one is closed. With no family left, or an empty
  delta, the blockers go back to the same reviewer. The coder digest names each
  recheck turn, its kind and what it replaces; wait for them. Approving
  reviewers get none; a closed reviewer is skipped with a note. If the correction does
  not warrant recheck, set `recheck: false` on its `seat_prompt`. Do not send
  rechecks by hand.
- A reviewer on a remote host (`seats_list {seat}`, field `host`) sees only its own checkout of the seat's base: copy a recheck diff to the host (<configured-host>: `<home>/orch/review-inbox/`), run `git apply --check` in its worktree, and name that path in the brief (2026-10-17: reviewer-codex-e007b0 answered blocked on a Mac path).

## Instruments the seats get

Pi seats run rtk automatically (rtk's own registry decides what is rewritten)
and have `codegraph_explore` and `memoryctl_memory` as direct tools. Read-only
seats get a guarded bash (rg, ast-grep, codegraph CLI, memoryctl reads, git
reads) and three read-only orch commands (task 2142, decision #14672):
`node ops/orchestrator/src/main.ts` with `status`, `pick-stats [--json]` or
`wait <turn> [--json]`, so a scout can read an earlier seat's report itself.
A seat on a remote host cannot run `wait` (task 2266: the daemon is on this
Mac), so a critic or scout that must read an earlier report gets `needs: mac`.
Any other `node` call is refused (no flag, no other script, no relative script
after a `cd`); `review-plan` writes Jev events and stays the lead's. The board shows every seat's skills, tools, MCP servers and Pi extensions as four badge rows:
- a red rtk badge counts commands rtk has a filter for that ran without it
  (native claude and glm seats are credited, their rtk hook rewrites the command);
- a skill badge lights when the seat read that SKILL.md.

A seat that ignores its instruments is a finding. Write it to memory with
`seat` and `turn` ids.

## Your own context is the dearest line

- **The lead saves its own tokens:** reading, coding and checks go to seats,
  unless the operator explicitly told the lead to code itself (operator,
  2026-09-23). A trivial single-file edit is still yours.
- A screenshot only when a picture is necessary (Screenshots, above); a lead takes and reads it itself.
- No status polling and no transcript reading: the digest is the delivery.
- Past the `/next` limit the hook reminds you: finish the step, write the
  handoff, run `/next`.

## What stays yours

- **Git.** Seats never commit. Land a coder seat with `seat_land {seat, into?}`; resolve or revert any reported conflicts before continuing, and commit under PRIME 7 of CLAUDE.md: unasked once the change is verified and reviewed, otherwise with the operator's word. The lead then lands on `master` itself (operator #14534): commit on the session branch, `git -C <main checkout> merge --ff-only <sha>`, `git -C <main checkout> push origin master`. After `EnterWorktree` the desktop app refuses the session's git outside that worktree until `ExitWorktree {action: "keep"}`: enter only to edit another app worktree's files, and exit before landing ([land-worktree](../land-worktree/SKILL.md), task 2126). A refusal that calls a path "dirty and unstaged, but its bytes equal the seat's base" (a change you made by hand or with `git apply` under a snapshot coder) is cleared by the `git add` it names; then land again. If the same refusal repeats (a clean filter or eol normalization made `git add` stage other bytes), apply the seat's patch by hand: `git -C <seat worktree> diff <seat base>`, then `git apply`, and copy the new files `git -C <seat worktree> ls-files --others --exclude-standard` lists (a plain diff leaves them out). A coder seat a predecessor created is landed with `into` set to your own checkout: without it the patch goes to that seat's original repo.
- **Memory.** An operator decision is written as `decision` in the same turn.
  Use `handoff_draft` (`since` or `repo` if needed) for an orch-store-only draft;
  edit it and close each chunk with `memoryctl handoff`. The tool never writes
  memory; do not copy full seat reports into memory.

## Mechanics that cost turns (measured 2026-09-25)

Each line below was one or more refused calls in a single lead session.

- **Brief:** at most 300 words, counted by orch (301 is refused unless `long_brief` says why it cannot be shorter). orch counts code spans, paths and punctuation about 10 percent above `wc -w`: write the brief to a scratch file and send it at 265 words or less by `wc -w` (14 refused calls on 2026-10-11 and 12, handoff 16450).
- **Scope gate:** Jev refuses a coder's first brief only above 0.85 (exactly 0.85 passes). It also refuses
  text work that is not code (three skill documents scored 0.90; one scored 0.77).
  For docs or a JSON routing entry, pass `wide_brief` at once with the reason (at most 300 characters after trimming);
  its trimmed reason, timestamp and turn id persist in `data.wideBrief` on the seat.
  Code: split into sequential seats instead.
- **Researcher/scout:** closes after one answer; a follow-up is refused. Put
  the whole question in the first brief; a second pass is a new seat that
  links the first report (`main.ts wait <turn>`). One slice ≤ ~100 rows or
  one pack; a 500-row slice came back `partial` after 7 rows. A researcher or
  bughunter brief names one bounded read set; a wider one is split into
  parallel seats (task 3067: researcher turns that compacted their context
  ended not done 26 of 34; 13% of researcher turns compacted).
- **Scouts are cheap: use them** (operator #12934). Any read across 3+ files,
  logs or memory goes to scouts, not to the lead or a coder. A large
  reconnaissance is several scout seats in parallel, one slice and one question
  each, with `family` left out so the pick spreads them across families; the
  codex luna scout runs at high since a medium one returned `partial` on large
  lifecycle questions.
- **A scout collects facts, it does not decide** (operator #17974). Ask what
  exists, where, how it is wired, what a source or a measurement says. "How to
  embed remote API books-full in the minute snapshot and is the remote API limit enough" is
  not a scout question: ask for the snapshot path, the current remote API requests and
  the documented limit, then the lead decides, or a coder designs it.
- **Family:** trust `picked`. It ranks on the longest window: a family at or
  behind pace first, by `need` (#14790), then the families ahead of pace by
  headroom in days (elapsed minus used, #10685, #11851). 85% used at 86% elapsed
  is on pace (`need 1.1x`), and the window resets within a day. A high `used%`
  in `warning` is no reason to override: two claude seats were closed for nothing.
- **Waits:** one `run_in_background` command for all the turns you wait on:
  `main.ts wait <turn> <turn>...` (Brief and wait). A task per turn wakes you
  one time for each turn. A detached `( … &)` gives no notification.
- **seats_list:** one seat by id is `seats_list {seat}` (full row, any status).
  `closed: true` pages compact rows (50 by default, `offset` for more); a
  closed seat's report still comes from `main.ts wait <turn>`.
- **Reviewer:** a coder seat is reviewed with `repo: <coder worktree>, snapshot: true, author: <seat>`.
  `author` picks no tree; orch refuses `author` + `base` at the commit the coder started from (task 1897).
  Several coder seats share one review: `git worktree add` from HEAD,
  `seat_land {into}` each seat, `review_plan {repo, snapshot}`, then create the
  reviewer with `author: <last coder>` and `coauthors: [<the other slice coders>]`:
  every named family steps aside, on the automatic recheck too (task 1997).
- **Commit, first try.** Settle every gate before the first `check:commit`,
  because the gates report one failure at a time:
  1. No commit needs a page edit or a lesson (operator #19505). When the change
     moves what a knowledge page maps, edit that page and run
     `node scripts/stamp-knowledge-page.mjs <page> --amended "<what>"` (`scripts/stamp-knowledge-page.mjs` not in this kit). The page
     holds the map; progress and history go to memoryctl. The size gate (`scripts/check-knowledge-size.mjs` (not in this kit),
     task 2398) refuses growth of a page part above 16,384 prose bytes and a new
     line above 2,048 bytes. A part is a `## ` section, or a file of a split page.
     Put new text in a new part with its `verified:` line and a proof (in a split
     page: a new file plus its line in the table of contents), or replace text of
     at least the same size. A changed anchor costs no bytes.
  2. When the work reproduced a reusable contrast, capture a lesson anchored at a
     file IN the commit (`node scripts/memory/capture-lesson.mjs <domain> ...`).
     `--no-lesson` and `--no-knowledge-page` are refused: the gates are gone.
  3. For a vendored skill with `npx`/`pip` lines, run
     `node scripts/check-unpinned-installs.mjs --write-baseline` (`scripts/check-unpinned-installs.mjs` not in this kit) (never edit
     vendored text). After the commit, run
     `node ops/bootstrap/install-harness.mjs --only skills` and then
     `node scripts/check-skills-drift.mjs`.
  4. Commit with `git add -- <paths>` and `git commit -F - -- <paths>`, never `-A`.
  5. `check:commit` runs no orch test (operator #20673, task 3227). For a change under
     `ops/orchestrator`, run the tests that cover it once, after the last edit:
     `node scripts/check-orch-tests.mjs --commit-scope <paths>` (`scripts/check-orch-tests.mjs` not in this kit) runs the non-live orch
     tests whose own inputs hold one of the paths (the test file, each file it imports
     or names in a string, and the role-default `SKILL.md` files for a test that reads
     the skill map). It needs `npm ci --prefix ops/orchestrator` and runs on the Mac
     only. The whole suite runs before an orch restart, not at a commit:
     `npm run check:orch-tests` on the checkout that the daemon loads. A pass writes
     `<stateDir>/orch-suite-pass.json` with the hash of the suite inputs; a restart
     without it is refused.
- **Lesson size:** the budgets (title 120, rule 300, why/evidence 400) are hard
  ceilings unless `--long` explains why; the targets are advice: title ~40
  characters, rule one sentence ~110, why ~120, evidence ~70 (a seat/turn id or sha).
- **rtk by hand:** the hook rewrites plain commands and `&&`/`;` chains.
  The native rtk hook does rewrite eligible multi-line commands (`rtk hook claude` on `git status\ngit log --oneline -1` prefixes both lines); our JS helper `rewritePlus` still declines them.
  It never rewrites `$()` or heredocs. Call these yourself, since no raw
  command maps to them: `rtk err <cmd>` (only errors; literal argv: operators, `VAR=value cmd` and globs need `rtk err --shell sh '<script>'`), `rtk test <cmd>` (only
  failures; same literal argv), `rtk summary <cmd>` (same; `rtk run` needs `-c '<script>'`), `rtk json --keys-only <file>` (shape of big JSON), `rtk log <file>`,
  `rtk recall <hash>` (what a filter elided). For big tool JSON, use `jq` on the saved file.
- **Restart orch by drain: one notice, no consent round** (operator #14945,
  2026-10-07). A drain interrupts nothing, so run
  `node ops/orchestrator/src/main.ts restart --when-idle --as <handle> --session <session_id> --note "<the master sha and what changes for a lead>"`:
  the route writes ONE post to `all` as you before it arms the drain (a refused
  post arms nothing; a second note request during a drain gets 409), and no
  "orch is back" post follows: the board shows the drain banner, and the restart
  is over when `main.ts status` prints a different pid with draining null
  (task 2305). `restart --when-idle` refuses unless the whole non-live orch suite
  passed on the suite inputs of its checkout: run `npm run check:orch-tests` there
  first (about 5 minutes). `--no-suite "<reason>"` passes and logs the reason;
  `restart --cancel` is not gated; a SIGTERM restart passes no gate, so run the
  suite before it (operator #16333). Running
  turns finish, new non-scout turns stay queued and resume after it (scout
  turns start at once, task 1785), and orch_status, seat answers and the board
  show the drain. A lead replies only to ask for a delay, naming the turn or
  the land that must end first; nobody posts "go".
  **A restart that interrupts turns keeps decision #12709:** one `chat_post`
  with `to: "all"` and `wake: true` saying a restart is coming and listing the
  running turns. Wait for every active lead's "go" as a reply addressed to the
  restarter in the chat (interrupt now, or which turns finish first; no new
  turns meanwhile). A receipt is not consent; an unreachable lead is not a
  "go". Then SIGTERM the pid `orch_status` names; launchd (`com.<prefix>.orch` from `names.prefix` of `ops/bootstrap/harness.config.json`, default `booharness` so `com.booharness.orch`)
  brings it back on master. Running turns are interrupted; queued turns
  survive only a drain-flagged restart. Before exit begins,
  `node ops/orchestrator/src/main.ts restart --cancel` withdraws an armed drain,
  clears its persisted flag and resumes held turns in seat order without restarting
  orch; no armed drain or an exit already begun is an error. The drain then stops
  showing in orch_status, seat answers and the board. `main.ts stop` is Windows-only.
  Observed 2026-09-27: the Claude MCP client kept the seat_* schemas from its
  connect; after a restart that changed them, reconnect the orch MCP before
  relying on new fields.
  From a restart notice until `main.ts status` prints the new pid, make no orch
  MCP call; watch the daemon with the CLI (`main.ts status`,
  `main.ts wait <turn>`).
  Observed 2026-10-04 (task 2053): after the 13:28Z SIGTERM restart two lead
  sessions had the orch MCP server `failed` (ECONNREFUSED) and could not re-dial
  it (`reconnect_session_connector` answers that orch is not a connector; the
  operator's `/mcp` reconnects it); through the 14:26Z drained restart the two
  lead sessions that made no MCP call in the window kept their tools. With the
  tools failed, call them by JSON-RPC `tools/call`, POST to
  `http://127.0.0.1:7760/mcp`; a new session connects normally.
- **Shell:** macOS has no `timeout`; use the tool's own timeout. The first
  `rg` on source in a session is refused until one `codegraph_explore` call.

Adapted in part from obra/superpowers (MIT), read 2026-09-23.
