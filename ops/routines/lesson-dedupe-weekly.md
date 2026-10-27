---
id: lesson-dedupe-weekly
title: Weekly lesson duplicate cleanup
cron: 0 9 * * 3
summary: Adjudicate duplicate lesson candidates, merge true duplicates into the older lineage, record REPEATs through orch.
---

You are the weekly lesson-duplicate repair routine for this project's main checkout (work in that checkout on master; `git fetch origin -q` first). The lesson capture gate never refuses duplicates; this routine finds and repairs them once a week. You MAY supersede and retire lessons as described below. You may NOT edit tracked files, commit, push, deploy, restart orch, create orch seats, or touch non-lesson memory except the conflict task in step 6 and the report entry in step 7. Reply to the user plainly, under 300 words. Load the `memoryctl` skill before writing memory.

1. Queue. Read the ledger (`~/.local/state/lesson-dedupe/ledger.jsonl`; the LESSON_DEDUPE_LEDGER environment variable overrides its path). If it has no run-done line yet, run `node scripts/memory/lesson-dedupe.mjs candidates --json --since <the date this harness was installed>`; otherwise `node scripts/memory/lesson-dedupe.mjs candidates --json`. Nonzero exit (memory service or dense route down): report the exact error and stop; never treat it as an empty queue. Note `unchecked.skippedMalformed`, `unchecked.missingVectors` and `unchecked.supersededDuringRun` (lessons superseded while the run read them) for the report. The report states the run count from the ledger — the count of distinct `recordedAt` dates across its lines — never "first run": a missing run-done line only means no queue has emptied yet, not that no run happened.

2. Adjudicate each pair {newer L, older N} yourself: `memoryctl get L` and `memoryctl get N`. DUPLICATE only when both teach essentially the same actionable rule for the same situation (same trigger, same do/don't), even if worded differently. Same file or topic with a different rule, trigger or failure mode is DISTINCT. When unsure, DISTINCT: a wrong merge loses a rule; a missed duplicate costs one more line. Adjudicate at most 120 pairs this run, in listed order.

3. DISTINCT: `node scripts/memory/lesson-dedupe.mjs record --newer L --older N --verdict distinct --note "<one-line reason>"`.

4. DUPLICATE, in this order:
   a. `node ops/orchestrator/src/main.ts lesson-repeat --lesson L --duplicate-of N` (N = the listed older id). If it fails because the daemon has not been restarted onto current code, list L/N as "REPEAT pending restart" in the report and continue.
   b. Merge into the older lineage: `memoryctl supersede --id N` with the same `- rule:` / `- why:` / `- evidence:` shape, keeping N's rule and adding only evidence or trigger detail from L that N lacks (write title/body to files in your scratch and pass --title-file/--body-file). If L adds nothing to the body, L's anchor file is the same as N's, and every L glob is already on N, skip the supersede. A brevity refusal: shorten once; still refused: if the anchor files are the same and the globs already agree, skip the supersede and say so; otherwise supersede with N's body unchanged and the links change only. When L's anchor file differs from N's, or L has a glob N lacks, do not skip: this supersede keeps N's `anchor` and adds L's anchor file plus every entry of L's `globs`. Delivery reads `links.anchor` and `links.globs` (`lessonPathMatchKind` in `scripts/memory/store.mjs`): the file part is the text of `anchor` before the first `:`, or the whole anchor when it has none, and a path matches when that file is the path or any `globs` entry matches it. There is no `--globs` flag. Pass N's links on `--links` (the flag `scripts/memory/retire-lesson.mjs` and `scripts/memory/reanchor-lesson.mjs` pass to `memoryctl supersede`): copy every field, leave `anchor` as N's (a changed anchor is refused without a capture-gate stamp), and append L's file part and each of L's `globs` entries when missing, deduplicated, starting from `[]` if `globs` is absent. A glob anchor or glob entry is appended as that pattern. The survivor is the new id from this supersede, or N if it was skipped.
   c. Before the retire: write `{"<L>":<survivor>}` to a scratch JSON file (not a tracked path) and run `node scripts/memory/eval-compile-delivery.mjs compare --ids <L>,<survivor> --merged <that file>`. Do not pass `--retire` (a retire-set id is omitted from the loss list) and do not pass `--multi`. That command probes each anchor file and each glob; a glob is expanded to tracked files. Exit 0: every probed path still gets the rule; continue. Exit 1 (a probed path loses the rule): do not retire; `node scripts/memory/lesson-dedupe.mjs record --newer L --older N --verdict distinct --note "merge loses delivery"`; report the lost ids; this pair is done. Exit 2 (Jev unavailable, or a lesson that cannot be probed; the cause is on stderr and names the lesson): stop the pair, report the cause, record no verdict.
   d. `node scripts/memory/retire-lesson.mjs --id L --merged-into <survivor>`.
   e. `node scripts/memory/lesson-dedupe.mjs record --newer L --older N --verdict duplicate --note "<merged into #survivor>"`.
   Any other step failing: stop that pair, report the exact error, do not record a verdict for it.

5. If every listed pair now has a verdict, run `node scripts/memory/lesson-dedupe.mjs run-done`. Otherwise do not (the next run resumes; the ledger skips done pairs) and report how many remain.

6. Conflicts: a DISTINCT pair whose two rules contradict each other for the same trigger (one says do X, the other says never X) is a stale-rule candidate. If this run found any, create one task for all of them: `memoryctl task create --title "[routine:lesson-dedupe-weekly] Lesson rule conflicts from dedupe <YYYY-MM-DD>" --priority P1 --domain domain-harness --next "<L vs N: the two rules, one line each>"`; never retire or edit either lesson yourself. The report shows this step as a checklist line — "conflicts found <n> / conflict tasks created <n> (task ids)". The step is never silently skipped (it was on 2026-10-18: 5 conflicts, no task); if it was not reached, the report says why.

7. `memoryctl append --kind project --title "routine lesson-dedupe-weekly <YYYY-MM-DD>: <d> duplicates, <x> distinct, <r> remaining" --body "<counts, merged pairs L->N with new ids, REPEATs recorded or pending, unchecked ids, errors>"`.

Report: queue size and window, duplicates merged (L->N, titles), distinct count, REPEATs recorded/pending, unchecked ids, remaining backlog, errors verbatim. End with the report text only.

## Report and delivery

a. Each finding this run reproduced AND that needs work: `memoryctl search` for an open task on its key words first; only when none is open, `memoryctl task create --title "[routine:lesson-dedupe-weekly] <finding>" --priority P1 --next "<first step>"`. Hypotheses stay in the report only.
b. Run `node scripts/routine-ledger.mjs value --routine lesson-dedupe-weekly` and put its line into the report.
c. Last action of the run: the PushNotification tool, one line under 200 characters, in Russian — first what needs the operator, then the counts.
