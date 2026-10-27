## Knowledge page cut tool

verified: 2026-10-13

`node scripts/split-knowledge-page.mjs <domain>` (`scripts/split-knowledge-page.mjs` not in this kit) splits one-file pages into `knowledge/<slug>.md`, or multi-section parts into one file per section with adjacent table lines. Body bytes/digest stay unchanged; reruns are idempotent; `--check` writes nothing. `partSections`/`fenceEdge` in `ops/bootstrap/knowledge-page-lib.mjs` ignore `## ` inside fences indented at most three spaces. Committed parts hold exactly one section.

Writes order new parts, table, source truncation, preserving every section through interruption. Rerun completes or names conflicting author-edited parts. Duplicate titles refuse; colliding filenames gain `-2`.

First split refuses upward Markdown targets via `UP_LINK`: inline/reference definitions, same/next line, bare/angle-bracket `../`. It also checks code spans/fences. Raw HTML, escaped/character-reference targets and reference labels with escaped brackets/line ends are outside the guard.

Check: `npx vitest run scripts/split-knowledge-part.test.mjs` (`scripts/split-knowledge-part.test.mjs` not in this kit)
