---
id: orch-rejected-review-weekly
title: Weekly review of what orch refused
cron: 0 9 * * 2
summary: Read-only look at scope-gate refusals, unreproduced reviewer findings, unadopted recommendations, RTK adoption and retained code per family.
---

You are a read-only weekly review run for the orch harness in this project's main checkout (work in that checkout; do not edit tracked files, commit, push, restart orch or create orch seats; a throwaway script in /tmp is fine). Reply to the user plainly, under 400 words.

Why: a system that knows what usually works under-rates the genuinely new; what it rejects must be looked at by a human on a schedule, or good ideas and good findings die silently.

The orch state directory is printed by `node ops/orchestrator/src/main.ts status` (field stateDir).

Window: the last 7 days.
1. Scope-gate refusals of coder first briefs: read `<stateDir>/orch.log` for events named seat.brief_refused (if none exist, say so in one line and skip). List each: seat title, score, threshold, one-line gist. Note how many were later re-briefed with wide_brief or split, and whether scores cluster just above the 0.85 threshold (decision #12635; raised from 0.75 by task 2817), which would suggest the threshold is too strict.
2. Reviewer findings that did not change the code: open `<stateDir>/orch.sqlite` read-only (node:sqlite, new DatabaseSync(file, {readOnly:true})); read ops/orchestrator/src/store.ts and ops/orchestrator/src/pick-stats.ts first for the schema. List reviewer findings of severity blocker or major that were not reproduced, or whose coder had no later correction turn, with seat, claim (one line) and evidence pointer. Pick the 3 that look most likely to be real and say why.
3. Researcher and scout reports: list recommendations marked ADOPT-CANDIDATE or WATCH in the window that have no memoryctl task or decision (memoryctl search by title words), one line each.
4. RTK adoption: run `rtk discover --since 7 --limit 15` in the main checkout. Classify its missed list: by design (raw commands the rewrite rules leave alone on purpose; `$()`, heredoc and multi-line commands), not a loss (`X=$(...)` captures never reach the context), and real misses. Give the share already using RTK, the real-miss top 5 with counts, and the change against last week's run if you can find it in memory (search "rtk discover weekly").
5. Retained code per family: run `node ops/orchestrator/src/main.ts pick-stats --json` (read-only) and read coderRetained. That table covers all landing commits, not the 7-day window of this run. Per family give exactly what it prints, with each window named: `measured` and `mean share` (added seat lines kept by a trailer-linked or first post-land touching commit, over all landings), `young` (landings too recent to read survival — an age floor the table's legend states, not a count of new seats this week), `survival n` and `mean survival` (only landings at least as old as that floor). If nothing is measured, say so in one line. When two or more families reach 8 measured seats for the first time, say so as the first line of the report: the user decides whether retained share should steer the coder pick. Mark n < 8 as not conclusive.

6. Routine value: run `node scripts/routine-ledger.mjs value` and put every routine's line in the report. A routine with 4 or more reported runs and no closed task is a disable candidate — name it with its counts.

End with at most 3 concrete suggestions (re-open a finding, re-brief a refused task, adjust a threshold, an rtk rewrite to add). Decisions stay with the user. If memory or orch state is unreachable, say so.

## Report and delivery

Record the run first (without it the ledger cannot count this routine): `memoryctl append --kind project --title "routine orch-rejected-review-weekly <YYYY-MM-DD>: <one-line gist>" --body "<the report>"`.
a. Each finding this run reproduced AND that needs work: `memoryctl search` for an open task on its key words first; only when none is open, `memoryctl task create --title "[routine:orch-rejected-review-weekly] <finding>" --priority P1 --next "<first step>"`. Hypotheses stay in the report only.
b. Run `node scripts/routine-ledger.mjs value --routine orch-rejected-review-weekly` and put its line into the report.
c. Last action of the run: the PushNotification tool, one line under 200 characters, in Russian — first what needs the operator, then the counts.
