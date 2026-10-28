## Safety gates and proof boundaries

`.githooks/post-commit` syncs LAN origin, with force-with-lease for claude/lead session
branches; `.githooks/pre-push` distinguishes LAN sync from publication.
`check:push` judges INIT_CWD, while the hook judges the pushed tree, refusing directories
outside worktrees (`scripts/check-push-safety.mjs`).

`scripts/check-commit.mjs` (not in this kit) checks domain-page coverage or reasoned source exceptions,
paths-mode large-file/module-boundary checks, and knowledge anchors/size; every
gate child runs at niceness 10. Commit entries select the whole-corpus gates: legal
copy (web/**, ledger), i18n (src/**), duplicate constants and runtime cycles (src/**, root resolver configs, baselines), module cycles (code,
contracts, docs/architecture/**), the Jev ledger guard from repository root (.mjs/.js/.ts
outside web/); a gate's own script or import selects it, an unreadable tree selects all.
Docs-only entries select no lint gate.
Commit-tree entries, not pathspec spelling, select lint: eslint config/package/lock
changes run the ratchet; other lintable files compare HEAD and commit-tree counts,
using old paths on rename. Growth fails, equal/lower passes (`scripts/check-lint-ratchet.mjs` (not in this kit),
`scripts/check-lint-growth.mjs` (not in this kit)). Boundary checks require TypeScript installed;
the rules live in `docs/architecture/module-boundaries.md` (not in this kit).

check:commit runs no orch test, contract script or kit build; by hand,
`scripts/check-orch-tests.mjs --commit-scope <paths>` (`scripts/check-orch-tests.mjs` not in this kit) selects tests whose input sets
contain a staged named path, including added tests; deleted tests select all. A merge
selects a test only when both sides changed its inputs since a merge base, or an input
differs from HEAD and every MERGE_HEAD (resolution); task 3216. Inputs include
non-live test-orch files, their import/existing-file-literal closure and roleDefaults
skills; non-named dirty inputs use HEAD bytes. Segment-built paths/other templates are
outside the walk. No inputs passes; missing dependencies fail, suite-requiring changes
refuse outside darwin, and children stop after 600 s. Clean merges/fast-forwards pass no
gate (`ops/orchestrator/code-hash.mjs`, `scripts/check-orch-tests.mjs` (not in this kit)).

A full `check:orch-tests` pass with unchanged suite hash atomically writes
`<stateDir>/orch-suite-pass.json`; commit-scope/red/timed-out runs do not. Knowledge-page
Markdown and .git names are excluded from that hash. Timing-sensitive tests run alone
in a second concurrency-1 child, with separate timeout; either failure fails the run.
`restart --when-idle` hashes the daemon's health checkout and refuses missing/different
proof; `--no-suite` logs a reason, restart cancel and SIGTERM are ungated
(`ops/orchestrator/suite-pass.mjs`).

On success, check:commit stamps `<git-common-dir>/check-pass/<commitTree>-<workTree>`.
CommitTree is HEAD plus named paths in a temporary index, or merge index; workTree is
the whole tree. Equal hashes allow cached pass; stamps expire after 7 days, unborn HEAD
gets none. Pre-commit requires a stamp for its index tree; git errors refuse and
`SKIP_GIT_GUARD=1` escapes (`.githooks/pre-commit`, `scripts/check-commit.mjs` (not in this kit)).
Post-commit checks even after no-verify: missing proof appends check-pass-misses.jsonl
and posts fail-open to `/commit-miss` (1000 ms), unless skipped. Sequencer/rebase/cherry-
pick/revert state and old-writer branches skip reporting; clean revert/merge-continue
can be reported. This is a hint, never a block (`scripts/report-commit-miss.mjs` (not in this kit),
`ops/orchestrator/src/chat.ts`). The Bash hook refuses hook bypasses, not check status:
commit no-verify/-n, SKIP_GIT_GUARD, core.hooksPath, commit-tree and update-ref, including
normalized hidden spellings and case variants. Missing session/malformed JSON does not
bypass detection (`ops/bootstrap/code-intel-order-hook.mjs`).

`scripts/check-flow-records.mjs` (not in this kit) warns before cached-pass return when touched manifest
provenance lacks a readable matching-checkout/current-tree record. It prints record,
lease/run/release lines and always exits 0 (`scripts/test-flow-record.mjs` (not in this kit)).

`scripts/check-knowledge-anchors.mjs` (not in this kit) checks paths, optional symbols, section shape and
digest, not semantic support. Commit-scope reads all pages, blocks new breaks and warns
on untouched pre-existing ones; unborn HEAD still checks staged pages. File citations
check existence, symbols whole-word last segments. All physical entry/part lines reject
numeric anchors/short tails, including Markdown paths; TSV rows remain allowed
(`scripts/lib/anchor-grammar.mjs`). Stale citations use a shrink-only multiset baseline:
listed occurrences warn, excess fails, surplus warns to trim.

`scripts/check-knowledge-history.mjs` (not in this kit), run by hand outside check:commit, compares
frozen-tree page-line identity across all parents, replacing citations with
placeholders but judging backtick changes. Jev scores
new prose for narrated history/progress; >= 0.6 fails, unanswered batches skip and count.
`lineIdentity`, shared with size checking, takes maximum parent multiplicity, not sum;
numeric-anchor cleanup grants no replacement credit. Semantic fact-check is separate
(`.agents/domains/_domain-routing.schema.md`). Gate entry guards compare realpaths
through `scripts/lib/is-main.mjs`; hook topology tests probe symlinked invocation.

The large-file ratchet covers tracked sources including shebang files, threshold 1500
lines: new/grown large files fail, improved/stale entries are notices. Check:commit
uses named paths, pre-commit staged mode includes typechanges. New/raised baseline
entries require justification; removing a still-large entry fails
(`scripts/check-large-file-ratchet.mjs` (not in this kit), `scripts/large-file-ratchet.mjs` (not in this kit)). Cyrillic
literal AST ratcheting runs in check:i18n, not check:commit
(`scripts/check-i18n-literals.mjs` (not in this kit)). Doc graph checks mirror equality/reachability;
domain routing checks ownership, memory routing regenerates/checks JSON, harness audit
covers installation/configuration, not fleet state (`scripts/check-doc-graph.mjs` (not in this kit),
`scripts/check-domain-routing.mjs`, `package.json`).

verified: 2026-09-23

