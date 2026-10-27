---
id: orch-role-matrix-weekly
title: Weekly families-by-role evaluation
cron: 0 9 * * 1
summary: Mean score, cost and speed of each model family by seat role over the last 7 days, a proposed role-matrix change, and lesson usefulness numbers. Its role-stats step writes role-quality.json, which the seat pick reads.
---

You are a weekly evaluation run for the orch harness, read-only except for one commanded write: step 2's --write-tiers writes the tier file role-quality.json in the orch state directory, which the seat pick reads. Work in this project's main checkout (in that checkout; do not edit tracked files, commit, push, deploy, restart orch or create orch seats; a throwaway script in your scratch directory is fine). Reply to the user plainly, under 450 words. A task number never stands alone: say what the task is in 3 to 5 words. Part A is the table of model families for each seat role. Part B is lesson usefulness.

Background: the family for a seat is picked by the budget pace rule among the families of the role matrix. This run is the weekly human decision point: the user reads the table and changes the role matrix by hand when the numbers say so.

Unattended run (task 2669): nobody answers a permission prompt, and one prompt stopped this run for five hours on 2026-10-19. Run each shell command as ONE plain command that the allow list holds: every git verb as `rtk git <verb> ...` (fetch, rev-parse, rev-list, merge-base, worktree add and remove), `node ops/...`, `memoryctl ...`, `rg`, `ls`. No shell variable assignment (`S=...`), no `;`, `&&` or `|` chain, no `tee`, no `$(...)`. Carry a sha from one command to the next in your own text; to keep an output, write it with the Write tool into your scratch directory.

## Part A: families by role, last 7 days

1. `rtk git fetch origin -q`, then `rtk git rev-parse origin/master`; note master HEAD.
2. Run `node ops/orchestrator/src/main.ts role-stats --since 7d --write-tiers`. It prints the table and writes the tier file `role-quality.json` in the orch state directory, which the seat pick reads: a WEAK cell ranks after the NORMAL cells of its role. Put each cell that the command names as entered or left WEAK into the report. The command keeps the `manual` key of the file; never edit the file by hand in this routine. If the command answers that the verb or the flag is unknown, say so in the report and skip Part A.
3. For each seat role that appears in the answer give one table: family, model, effort, seats, rated seats, mean score, tokens for each turn, median seconds, share of failed or empty turns. Sort by mean score.
4. Mark each row that rests on fewer than 30 rated seats as "few data" and never recommend from it. The score is the grade of the seat's report, not a proof of the work's quality: say that in one line.
5. Recommend, do not decide. For each role name at most one change of the role matrix: a family to take out (clearly the worst score with enough data, or the same score at a much higher cost), or an effort to change. Name the numbers that support it. When nothing is clear, say "no change". When every family of a role moved the same way against last week (for example all coder rows down about 0.1), say it is a shift of the grader or of the task mix, not of family quality; judge families only by their gaps within the week, and check the gap against the retained share of `node ops/orchestrator/src/main.ts pick-stats --since 7d --json` before naming a family to take out.
6. Also report the budget state of each family: the `picked` text of the newest seat (orch `seats_list`) ranks every family with its window, elapsed share, used share, headroom and need, including the 7d windows; `orch_status` adds the reading age and banked resets. A family that is over its pace must not get more work from a recommendation.

## Part B: lesson usefulness

7. Run `node ops/orchestrator/src/main.ts lesson-stats --since 7d --json` (read-only; it reads the orch store and reads lessons from the memory service). If the memory service is unavailable, say so and skip Part B.
8. Report: lessons delivered (full against indexed), lessonsApplied answers (applied, not applicable, not reported) and the applied rate; captures accepted against refused with the top refusal reasons; the REPEAT count and the repeat tasks raised; lessons answered "not applicable" three or more times and never applied, with ids and titles; the zeroFull count (a window count, not a retirement signal).
9. Retirement candidates come only from that delivered-never-applied list; never retire, supersede or edit a lesson yourself, and do not ask the user about them — the same ids (11020, 15510, 15696) were listed three weeks running and nobody acted. Write them as ONE memory entry for the consolidate-memory-daily stage E to verify against code: `memoryctl append --kind project --title "role-matrix dead-weight lessons <YYYY-MM-DD>" --body "<ids and titles, one per line; mark each lesson that is on the list two weeks in a row>"`.

## Save

10. Compare with last week's numbers where memory has them (`memoryctl search "routine orch-role-matrix-weekly"`), then `memoryctl append --kind project --title "routine orch-role-matrix-weekly <YYYY-MM-DD>: families by role and lesson usefulness" --body "<Part A tables in short form with sample sizes and the recommendation for each role; Part B numbers, top refusal reasons, dead-weight ids>"`. If memory is unreachable, say so in the report.

End with the report text only.

## Report and delivery

a. Each finding this run reproduced AND that needs work: `memoryctl search` for an open task on its key words first; only when none is open, `memoryctl task create --title "[routine:orch-role-matrix-weekly] <finding>" --priority P1 --next "<first step>"`. Hypotheses stay in the report only.
b. Run `node scripts/routine-ledger.mjs value --routine orch-role-matrix-weekly` and put its line into the report.
c. Last action of the run: the PushNotification tool, one line under 200 characters, in Russian — first what needs the operator (a role-matrix change recommendation repeated from last week without an operator answer leads the line), then the counts.
