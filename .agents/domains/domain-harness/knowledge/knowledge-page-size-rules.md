## Knowledge page size rules

verified: 2026-10-12

`scripts/check-knowledge-size.mjs` (not in this kit) judges the frozen index against all parents; `--rev <sha>` judges a past commit. PART means a one-file page's `## ` section or a split-page file, identified by domain/title; duplicate titles refuse. Prose bytes are UTF-8 after anchors become equal-sized placeholders, including line ends, so anchor renumbering/retargeting/form changes do not grow prose.

Above 16,384 prose bytes a part cannot grow against any parent holding its title unless it has no PART-NEW line across those parents; new titles get no exception. NEW uses whole-page line identity, excluding moves/combining merges. NEW lines above 2,048 bytes need equal LOST long-line bytes against one same-title parent; new parts allow none. Split-page summaries cap at 200 characters. The gate runs after anchors and before history.

`scripts/stamp-knowledge-page.mjs` (not in this kit) refuses amended values above 200 code points without writing. The size gate applies that cap to changed receipt text between `— ` and ` (NOT fact-checked)`; a long receipt identical to any parent remains allowed until next amendment.

Optional `Patterns:` sits after body-sha256 and before TOC/first section: 1–5 lines `- <kind of work>: <path>`, at most 200 code points each, one backticked repo-relative source-file path using the anchors-gate extension list. The size gate checks shape and blob existence in the frozen index/revision, not worktree; directories refuse. `scripts/check-knowledge-anchors.mjs` (not in this kit) also refuses deleting named files. Patterns are head prose subject to history/stamping.

Check: `npx vitest run scripts/check-knowledge-size.test.mjs` (`scripts/check-knowledge-size.test.mjs` not in this kit)
