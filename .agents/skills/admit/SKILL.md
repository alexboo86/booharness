---
name: admit
description: Write-time admission judgment for a durable memory fact or lesson in memoryctl.
lead_only: true
---

You are the memory ADMISSION judge. The store is **memoryctl memory.db**; the mechanical layers are
already automatic — content_hash dedup on append, lesson-links validation, inbox quarantine,
selfreview drafts. What is NOT automatic is JUDGMENT: does this fact merge into an existing entry,
supersede it, or contradict it? That is this skill.

## Procedure (per candidate fact/lesson)
1. **Search first**: `memoryctl search "<topic>" --limit 10` (bilingual query: русская фраза +
   english token) + for lessons `memoryctl lessons --path <anchor-file>`. Read the top hits.
2. **Classify** against the best match:
   - **new** — no real overlap → `memoryctl append` (lesson → via
     `node scripts/memory/capture-lesson.mjs` so it lands in inbox quarantine with structured links;
     non-lesson kinds → direct append, `--pinned` only for prod-axioms).
   - **merge** — same topic, complementary → `memoryctl supersede --id <existing>` with the merged
     body (existing + new evidence). ONE entry, richer; not entry #N+1.
   - **supersede** — replaces an older truth → supersede with the new body; the chain keeps history.
   - **contradict** — conflicts with a live entry and you can't prove which is true → append the new
     fact with `CONTRADICTS id <N>` in the body AND surface to the operator. Never pick silently.
   - **reject** — duplicate (append will dedup anyway) / speculative / narrative «we fixed X» /
     derivable from code (a codegraph or `rg` query away) → don't write; say why.
3. **Evidence honesty**: state what proved it (test output / operator confirmation / prod metric).
   An inferred guess is not a lesson.
4. **Smoke retrieval**: `memoryctl search "<how a future agent would ask>"` — the entry must surface
   in top-5. If it doesn't, sharpen the title (short rule-style, ≤500 chars).
5. Lessons additionally: correct `links.domain` (path must route there — `resolveDomain` semantics),
   live anchor, promotion to active only via `/curate` / promote-lesson.mjs.

## Hard rules
- Update-in-place (supersede/merge) beats creating a near-duplicate. Default to merge when overlap is real.
- Never resolve a contradiction silently — surface it.
- There are no generated export files. `MEMORY.md` / `SESSION-REGISTRY.md` / `handoffs/` / `lessons/`
  were removed with the move to the standalone service; memory.db is the whole store, and a rule
  guarding files that do not exist reads as if it had a second face.
- Contract/skill/hook changes stay operator-gated — this skill writes only memory entries.
