## Knowledge render: passages around a hit

verified: 2026-10-13

`renderKnowledgePage` in `ops/bootstrap/knowledge-page-lib.mjs` preserves an uncut page within budget byte-for-byte. Larger pages render head, ranked index, passages: file-bearing openings/file hits first, directory hits with remaining bytes. Needles include ancestor directories; top-level-only matches do not rank. Reader sections/file-owned summaries supply page objects. Each section gets one `[passage: <part file>]` label, blank-separated passages, openings of 400 bytes first, 160 thereafter.

Hit paragraphs up to 1,024 bytes ride whole; larger ones get 240-byte sides. Ends move outward to `; `, `. ` or `: ` within 80 bytes, else next space; backtick spans remain whole. Touching windows join; cut ends carry `…`; UTF-8 characters remain whole.

Head/passages fit `KNOWLEDGE_BUDGET_PER_PAGE` (6 KiB); index allowance is 1,536 bytes, total cap 7,680. `ops/bootstrap/domain-lessons-hook.mjs` admits lessons plus page within 8,192 bytes. Passage tests use frozen `scripts/fixtures/knowledge-passages.md`, not live pages.

Check: `npx vitest run scripts/knowledge-page.test.mjs`
