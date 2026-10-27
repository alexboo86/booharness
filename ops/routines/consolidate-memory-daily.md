---
id: consolidate-memory-daily
title: Daily memory consolidation
cron: 0 3 * * *
summary: Preserve active tasks and handoffs; verify lessons nightly and apply only code-rechecked, delivery-gated corrections.
---

You are the memory consolidator. The store is the memory service reached through `memoryctl`. The judgment rules are the same as those of the `admit` skill (merge / supersede / contradict / reject) and the `curate` skill (append-only, supersede, never delete). This routine adds one thing: what may be done without asking every day, and what may never be done.

The routine is installed since 2026-10-20 and runs on cron 0 3 * * * (03:00 daily). An asleep Mac misses the run; the registry date exposes that gap. Scheduled wake is the operator's system setting, not this routine's action.

**Unattended commands:** each shell call is ONE plain command admitted by `Bash(node scripts/*)`, `Bash(node ops/*)`, `Bash(memoryctl *)` or `Bash(rtk *)`. No pipes, chaining, redirects, variable assignments, substitutions or inline `node -e`. Run the examples separately, replace quoted placeholders with observed values, and carry SHAs and versions in your own text. Read/Write tools handle scratch files under `.lead-scratch/lesson-compile/`; use Write for every JSON input and for retained command output, never shell redirection. MCP calls are tool calls, not shell commands: write their JSON arguments to scratch first, then pass the object. Where a CLI accepts only literal JSON (`--links`), copy the exact saved JSON as one quoted argument; do not invent `--links-file` or use command substitution.

## Iron invariant: the active is never touched

Before changing anything, check it against this list. The scan prints a PROTECTED mark itself, but the responsibility is yours.

- A **task is active** if: status != open · claimed_by is not empty · P0 · another open task's depends_on references it · updated less than 24 h ago.
- A **lesson is active** if links.status=active AND its anchor is kept by sweep-anchors.
- A **handoff is active** if it is the newest on its track, or its track is status blocked, or one of the tasks it declares is not closed.
- **Never** touch pinned=1 and entries changed in the last 24 h.

The active is never merged, archived or closed — even when it looks like a duplicate. Such a case goes to the proposals, not into action.

**Only lesson exception:** stage E may retire, supersede or re-anchor an active lesson (a re-anchor to a file of another domain is a re-file: capture in that domain, then retire into the new id) with code evidence the routine itself re-checked and a passing pre-write delivery gate. There is no exception for tasks or handoffs, pinned entries, or entries changed in the last 24 h.

## 1. Scan

```bash
rtk node .agents/skills/consolidate-memory/scan.mjs
```

```bash
node scripts/memory/sweep-anchors.mjs --json
```

`scan.mjs` only reads the service; `sweep-anchors.mjs` publishes a CAS report `anchor-sweep-latest` (for a probe without writing: `--no-report`). An unreachable service is an error; there is no local fallback source. Thresholds are adjusted by flags: `--stale-days 30 --orphan-days 30 --task-jaccard 0.6 --lesson-jaccard 0.7 --anchor-budget 24576`. B1 age is `B1_ARCHIVE_DAYS` (14), the same constant `archive-handoff.mjs` enforces; the scan has no flag for it.

## 2. What you apply yourself (auto classes)

Only A1 and B1 here. Both are provable without judgment and reversible (the supersede chain stays whole, nothing is deleted). Lesson changes belong only to stage E.

**A1 — exact task duplicate.** The scan marked it free (otherwise skip).
```bash
memoryctl task update --id "<duplicate>" --status cancelled --evidence "duplicate #<original>" --title "MERGED-INTO: #<original> — <original title>"
```
Title at most 200 characters. If the original has an empty next_action and the duplicate has one, move it: `memoryctl task update --id "<original>" --next "<step>"`. Change nothing else in the original.

**B1 — a handoff whose track is continued by a newer one.** Conditions: the track is declared, a newer handoff of the same track exists, all declared tasks are closed, age 14 d or more, not pinned, and the track's current status is not `blocked`. The scan prints the track status in the candidate line: `[track · status]`.
```bash
rtk node scripts/memory/archive-handoff.mjs --id <n> [--id <n> ...] [--dry-run]
```
The script checks every condition itself (including live row and history title) and refuses each one, printing the reason and writing nothing; `--dry-run` shows what would apply. The body is carried byte for byte and verified by SHA-256 of the re-read new version: an archive is a status, not a retelling. `--no-open-work` is honest here exactly because all tails are closed — that is the class condition.

**C1 — dead-anchor lessons are folded into stage E.** A missing anchor alone is never STALE evidence. Search for the symbol or mechanism and try re-anchoring first; keep and report a refused move, never retire it as a substitute. Tree-only absence may be a switched branch; inspect HEAD too with `rtk git cat-file -e "HEAD:<file>"`. Retirement requires a re-checked STALE/FALSE rule, not just a gone path. Duplicate lessons are reported for the weekly dedupe routine, not merged here.

## 3. What you only propose (never apply silently)

- **A2 adjacent tasks** — similar wording. Merging an adjacent task changes the meaning of a tail; that is the user's decision or a separate session.
- **A3 "looks closed"** — a match with a closed task or a track declared done. Closing needs proof (a commit, a measurement, a sensor), not a wording match. If the proof turned up in this same run: close it `memoryctl task done --id "<n>" --evidence "<sha or memory#id>"` (without --evidence the service refuses) and repeat the proof in the report. The iron invariant still excludes protected tasks.
- **B2 a handoff without a track** older than 30 d.
- **C2 overlapping lessons** on one anchor, **C3 a domain over its budget**, a domain outside the routing map (its lessons are undeliverable — that is a defect, not a style point).
- **D contradictions** (CONTRADICTS id N) — to the user only, never resolved silently.

## 4. Report (and why this routine does not breed litter)

The report is one CAS record, version after version, not a new record every day.
```bash
memoryctl registry-read --key consolidate-latest
```
Take the version (no key means 0), write the report with Write, then:
```bash
memoryctl registry-update --key consolidate-latest --expected-version "<v>" --body-file .lead-scratch/lesson-compile/consolidate-report.json
```
Exit 9 = a race: re-read the version and retry once.

Report body: date · counters of what was scanned · what was applied (by class, with ids) · what was proposed · what was protected and why · what failed.

Then:
- **There are proposals** → one task with track `memory-consolidation`. If one is already open, do not create a second: update it `memoryctl task update --id "<n>" --next "<date>: N proposals"`. Otherwise `memoryctl task create --title "[routine:consolidate-memory-daily] Memory consolidation review <date>" --priority P1 --track memory-consolidation --next "<summary>"`.
- **Something was applied** → `memoryctl append --kind decision --title "routine consolidate-memory-daily <YYYY-MM-DD>: consolidate" --body "<counters>" --agent consolidator`. Nothing applied → write nothing.
- **The routine writes no handoff.** A daily handoff is 365 records a year into the store this routine cleans.

## 5. Stage E — nightly lesson verification

Run after the existing stages: A1, B1, then E; there is no separate C1 write. Do not change `orch-role-matrix-weekly` or the weekly dedupe procedure.

### E1. Batch

Read the ledger at `.lead-scratch/lesson-compile/ledger.jsonl` (inside the scratch directory the Read/Write rule above admits; git-excluded, so it outlives each run) with Read (a missing ledger means no prior verifications). Choose one domain, rotating by oldest median verification, and at most 48 active lessons not verified in 30 days, including UNSURE retries due tonight with a different family. Prioritize dead anchors and active rows whose titles say `RETIRED:` or `MERGED-INTO:`. One more source joins the selection: the newest memory entry titled `role-matrix dead-weight lessons <YYYY-MM-DD>` (`memoryctl search "role-matrix dead-weight lessons"`, open the newest with `memoryctl get <id>`) — its lesson ids join tonight's selection inside the same 48-lesson cap and get the same verification as every other selected lesson. Presence on that list alone never retires a lesson: delivery/usage numbers alone never justify retirement. Skip pinned lessons, lessons changed in 24 h, and every lesson in a candidate pair returned fresh tonight:

```bash
node scripts/memory/lesson-dedupe.mjs candidates --json
```

If the candidate read fails, do not guess an empty exclusion set: defer E. Save each selected lesson's ID, lineage head, version, body, links, timestamp and verifier family in scratch. No eligible lessons means an empty, reported night, not a forced batch.

### E2. Verify

Through the **orch MCP**, create exactly 3 verifying scout seats (`seat_create`, role `scout`, repo this checkout; E3 adds at most one confirming scout of another family for the STALE/FALSE verdicts) and give each at most 16 lessons with `seat_prompt`; empty slices need no turn. Use non-claude families while claude seats are paused. Wait with `seat_wait` and read `seat_report`; do not use a shell seat launcher. The brief requires whole-function reads of current code, verdicts TRUE / PARTIAL / STALE / FALSE / UNSURE, exact file:line evidence, and **ALL verdict lines in `forLead`**, not just the eight-entry findings list. Record the actual family per verdict. Missing, truncated or unreturned verdicts are UNSURE, not approval.

### E3. Re-check

The routine itself opens the cited evidence and whole relevant functions for **every non-TRUE verdict**, including moved-anchor and duplicate suggestions. A STALE/FALSE verdict is also confirmed by one more scout of a family other than the first verifier's before it may enter the retire set (operator #19007; one cheap family was wrong on 3 of 4, #18548). If it cannot confirm a verdict, mark UNSURE, keep the lesson, and assign another family on the next night. Search the current tree for the old symbol/mechanism before calling a dead-anchor rule STALE; run the re-anchor dry check when a replacement is found. No usage count alone decides retirement.

### E4. Propose in scratch, do not write

Use Write for the proposed set and evidence ledger; no lesson or tracked-page mutation yet (a compile task below changes no lesson and needs no gate). TRUE needs a ledger stamp and a compile target, in this order (operator #19007; memory #19003: code mechanisms carry the gain, prompt text least): (a) when the rule is mechanically checkable, an executable check, hook or script; (b) otherwise a knowledge-page line for a FACT (E7) or a skill line for a METHOD; (c) else the lesson stays as a sharp, file-anchored scar. The routine writes no code and no skill: for (a) and for a skill line it opens one `memoryctl task` for a coder seat, which lands through review like any change:

```bash
memoryctl task create --title "[routine:consolidate-memory-daily] Compile lesson #<id> into <check|skill line>" --priority P1 --track lesson-compile --next "<target file and the mechanical rule>"
```

The lesson itself stays until that change has landed and a later night gates its retirement or sharpening. No new delivery study: E5's compare gate stays the only measurement. TRUE with a moved anchor proposes re-anchor; PARTIAL proposes supersede retaining the still-true part and the current fact; STALE/FALSE proposes retirement with cited code evidence. UNSURE stays. A real duplicate (same trigger and do/don't) goes only to the Wednesday `lesson-dedupe-weekly` report.

Retired-looking titles get the same verification, never automatic status repair. Before retiring a `MERGED-INTO:` row, read its target with `memoryctl get "<target>" --follow latest` and require a live head other than the retiree that holds the rule and covers its anchor; otherwise keep and report it. The routine never moves a METHOD lesson into a skill itself; a skill line goes only through the compile task above. A TRUE FACT missing from a knowledge page may propose a delta line, but copying it never replaces or retires its lesson.

### E5. Delivery gate BEFORE any write

Prerequisite: `scripts/memory/eval-compile-delivery.mjs` must be landed and able to simulate the exact proposed set. A missing script or unsupported simulation defers the affected proposals, never authorizes unmeasured writes. The CLI simulates retirements (`--retire` is a **file of whitespace/comma-separated IDs**, not an inline ID list), page lines (`--compiled` is a JSON object mapping lesson ID to exact line; `--tree` is the scratch page tree) and moved or rewritten lessons (`--moved` is a JSON object mapping lesson ID to `{anchor, domain?, title?, body?, trigger?}`: a re-anchor gives the target anchor, plus `domain` when the target routes to another domain; a supersede gives the new title, body and trigger and keeps the anchor). A move whose target does not route to the given domain exits 2. A moved lesson still not delivered after the move is listed in `movedUndelivered` and exits 1 like a loss: drop that proposal. Do not pretend `--lessons` substitutes the live candidate envelopes.

Use Write to prepare `.lead-scratch/lesson-compile/retire.txt` (only confirmed STALE/FALSE IDs; empty if none), `compiled.json` (`{}` if none), `moved.json` (`{}` if none; one entry per proposed re-anchor or supersede), and the proposed page tree (the domain entry page and all its parts, preserving untouched content). Probe the **whole touched domain**, not just the batch:

```bash
node scripts/memory/eval-compile-delivery.mjs compare --domain "<domain>" --retire .lead-scratch/lesson-compile/retire.txt --compiled .lead-scratch/lesson-compile/compiled.json --moved .lead-scratch/lesson-compile/moved.json --tree .lead-scratch/lesson-compile/tree --out .lead-scratch/lesson-compile/gate-one.json
```

```bash
node scripts/memory/eval-compile-delivery.mjs compare --domain "<domain>" --multi --retire .lead-scratch/lesson-compile/retire.txt --compiled .lead-scratch/lesson-compile/compiled.json --moved .lead-scratch/lesson-compile/moved.json --tree .lead-scratch/lesson-compile/tree --out .lead-scratch/lesson-compile/gate-three.json
```

Compare per-lesson delivery, not aggregate recall, across one-file and three-file probes, seat, lead Edit and lead Read. Inspect each channel's rows too; a gain in one channel must not hide a loss in another. Only confirmed STALE/FALSE retirements are intended losses. On exit **1**, retry the losing probe once with the same command plus `--no-cache` (save to a distinct scratch output). A TRUE/PARTIAL lesson still lost is dropped from the proposed changes; also remove any other proposal causing its loss. Rebuild and re-gate until both probes exit 0. If the cause is unclear, defer the entire set rather than lose an unchanged lesson.

Exit **2** voids the night: no stage-E lessons or page lines are applied, even if another probe passed. Any Jev source `unavailable` in ANY probe, including a retry, voids the night and is named in the report. Only `jev`, `cache`, and `anchors` (no scoring needed) are valid. Keep all probe receipts; do not retry an unavailable result into apparent approval.

### E6. Apply lessons by lineage head

Before any mutation, re-read every proposed lesson:

```bash
memoryctl get "<id>" --follow latest --json
```

Compare head ID and version with E1; skip anything moved, pinned or newly changed in 24 h. **After any skip, re-run E5 on the actual remaining set BEFORE writing it**, dropping further losses as above; never reuse the larger set's approval. Lesson writes must also pass E5 without unlanded page lines: use the current repository tree and an empty compiled map for that check. If preservation depends on a proposed page line, defer that lesson change until the page has landed and re-gate against the landed tree. Apply only the gated set, in order re-anchor, supersede, retire, each with its evidence line retained in the body or report:

```bash
node scripts/memory/reanchor-lesson.mjs --map .lead-scratch/lesson-compile/reanchor.json --refile --dry
```

```bash
node scripts/memory/reanchor-lesson.mjs --map .lead-scratch/lesson-compile/reanchor.json --refile
```

```bash
memoryctl supersede --id "<current-head>" --title-file .lead-scratch/lesson-compile/title.txt --body-file .lead-scratch/lesson-compile/body.md
```

```bash
node scripts/memory/retire-lesson.mjs --id "<current-head>" --reason "<re-checked code evidence>"
```

Write `reanchor.json` as ID to target anchor, the same targets as `moved.json`. With `--refile` a target that routes to exactly one other domain is re-filed (capture in that domain, then retire the old lesson into the new ID); the dry run must show that domain, the same one `moved.json` named, or the move is dropped. Report each `re-filed #old -> #new`; a capture whose retire failed prints both IDs and a finishing command: report them and stop. Supersede preserves domain/anchor/status/globs, obeys the brevity gate, and carries rule/why/evidence lines. A refused re-anchor is kept, never retired instead. These are sequential, non-atomic writes: stop on the first refusal or uncertain write; report applied IDs, failed ID and untouched IDs, re-read lineage, and re-gate the remaining set before any continuation. Invoke retire once per ID, not a batch that continues past failure. Keep lineage intact; an erroneous retirement can be restored by supersede, not deletion.

### E7. Optional page lines

At most 10 delta lines per page part per night, only TRUE FACTs the page lacks, in the part naming the anchor file. Write a fact, its proof and bare `verified: YYYY-MM-DD`, with no lesson field labels. No page rewrite, no METHOD migration, and no lesson retirement for a copied line. Skip a part still over the 16 KB gate (an oversized part stays skipped until it is split); lesson verification continues.

Before proposing, post the exact part in orch-chat, fetch with `rtk git fetch origin`, and inspect its last change with `rtk git log -1 --format=%cI origin/master -- "<part>"`. Skip parts changed there in 24 h. The routine never edits a tracked file in its own checkout: the page lines and the stamp of the domain entry page are part of the gated delta the E8 coder seat applies in its page worktree. The coder runs the stamp there, after the lines:

```bash
node scripts/stamp-knowledge-page.mjs "<domain-entry-page>" --amended "<receipt>"
```

The receipt is at most 200 code points (the script refuses longer text and writes nothing): the parts touched and the source lesson IDs, not the facts themselves. Never use `--checked` without fact-checking the WHOLE page. Gate the exact page delta in E5 before the coder gets it; if a page line is skipped or review changes it, re-gate the actual set before continuing.

### E8. Page worktree, review and lead land

Before the first dry night's page edit, prove that this top-level scheduled lead session can use orch `seat_land`; if not proven, keep page lines as scratch proposals only. Land is lead-only, never delegated to a seat.

Use orch MCP `seat_create` for a coder worktree based on freshly fetched `origin/master`; `seat_prompt` supplies only the gated delta and the part reservation. The coder runs `npm run check:commit` via its allowed equivalent `node scripts/check-commit.mjs` (`scripts/check-commit.mjs` not in this kit), then the routine uses `review_plan`, commissions independent review through orch MCP, and resolves review before proceeding. The routine itself runs this in the page worktree immediately before lead `seat_land` (the land-worktree skill does not run it):

```bash
node scripts/verify-land.mjs --strict-freshness
```

A failed gate prevents land. A land conflict drops tonight's page lines without resolving it; propose them again next night. Re-gate the lesson set without those lines before any remaining lesson write; never rely on an unlanded page to preserve delivery.

### E9. Report

Use Write to preserve the ledger's existing JSONL lines and append IDs, versions, actual verifier families, confirmed verdicts/evidence, UNSURE retry families, exclusions, gate receipts and applied/failed/untouched IDs. Only completed verifications get a verification date; UNSURE or missing reports never reset the 30-day clock and remain due next night. Report to one CAS registry:

```bash
memoryctl registry-read --key lesson-compile-latest
```

```bash
memoryctl registry-update --key lesson-compile-latest --expected-version "<v>" --body-file .lead-scratch/lesson-compile/report.json
```

Exit 9 means re-read and retry once, not overwrite another run. Report date/domain, batch counts, compile tasks opened, all gate losses/dropped proposals, Jev failures, lineage skips/refusals, page land receipt or conflict, and no-run/empty/deferred reasons. Search before appending:

```bash
memoryctl search "Nightly lesson verification" --kind project --limit 10
```

```bash
memoryctl append --kind project --title "routine consolidate-memory-daily <YYYY-MM-DD>: nightly lesson verification" --body-file .lead-scratch/lesson-compile/report.md --agent consolidator
```

Append that one project entry only on a night that applied something in E; no E writes means no project append. Open items go to the same single `memory-consolidation` task used above, never a second task or daily handoff; the only other tasks are the per-lesson compile tasks of E4 (search `memoryctl task list --track lesson-compile` first and never open a second one for the same lesson). Keep earlier A1/B1 decision reporting separate. Delivery/usage numbers alone never justify retirement.

## Bounds

- Mutations only through `memoryctl` / `scripts/memory/*`. Direct SQL writes — never: the store's gates live in the service.
- CLAUDE.md, AGENTS.md, skills and hooks are not edited by this routine. A contract change is a proposal to the user.
- Stage E alone may correct active lessons with re-checked code evidence and its delivery gate, and add gated knowledge-page delta lines through a coder and lead land. No other scope is lifted.
- Promoting lessons from inbox to active is not here; that is the `/curate` decision.
- Service down → say so and exit. Memory never blocks the work.

## Report and delivery

a. Each finding this run reproduced AND that needs work: `memoryctl search` for an open task on its key words first; only when none is open, `memoryctl task create --title "[routine:consolidate-memory-daily] <finding>" --priority P1 --next "<first step>"`. Hypotheses stay in the report only. The single `memory-consolidation` task and the per-lesson `lesson-compile` tasks above carry this same `[routine:consolidate-memory-daily]` title; the search finds them, so nothing is created twice.
b. Run `node scripts/routine-ledger.mjs value --routine consolidate-memory-daily` and put its line into the report.
c. Last action of the run: the PushNotification tool, one line under 200 characters, in Russian — first what needs the operator, then the counts.
