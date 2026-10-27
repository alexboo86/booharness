---
name: memory-domain-extraction
description: Mine raw notes/handoffs into durable anchored lessons in the memoryctl database.
lead_only: true
---

# Memory domain extraction (anchor-first fan-out, DB store)

Lead procedure for bulk-porting history into domain lessons. Store = **memoryctl memory.db kind=lesson**
(`links={domain, anchor, globs, status}`); delivery is explicit through
`memoryctl lessons --path <repo-relative-file>`.
Day-to-day single-lesson flow = `node scripts/memory/capture-lesson.mjs` → `/curate`.
Lifecycle ref = [docs/agent/memory.md](../../../docs/agent/memory.md).

## When to use
- Mining legacy notes / handoffs (searchable via `memoryctl search --kind archive|handoff`) into lessons.
- Splitting a domain because ONE FILE's lessons exceed the delivery budget (24 576 B of active
  bodies on a single anchor; the curated memory-routing suite, run in CI, names the file). Not because a domain
  has many lessons: the per-domain count guard was removed 2026-08-11 and a big domain costs a
  reader nothing, since delivery is per-file. The "selfreview lesson-budget detector" this line
  used to cite has not existed for as long as anyone can measure.
- Seeding a brand-new domain (new `domain-<x>/SKILL.md` `files:` globs stay the file-based routing SSOT;
  a new domain needs operator go + `node scripts/gen-domain-routing.mjs`).
NOT for a single confirmed gotcha — `capture-lesson.mjs` directly.

## Core principle
Two layers stay separate: **how the code works = live codegraph / `rg`** (never store);
**what code can't tell you = memory** (anchored rules + operator prefs). Every lesson carries an
anchor (`file:symbol` / `file:line` / file path / glob) so the sweep detects rot for free.

## Steps
1. **Map sources + targets.** Sources: `memoryctl search` over archive/handoff kinds (or legacy files
   read-only). Targets: confirm each domain's `files:` globs.
2. **Fan out one read-only worker per domain** — an orch scout seat
   (codegraph + `rg` for anchor-first). Brief: domain globs, sources, the schema below, the
   discipline block. Workers return DIGESTS (lesson text + verified anchors) — the LEAD writes to the
   DB (verify layer; workers never append themselves).
3. **Lead writes each lesson** from the digests: `capture-lesson.mjs <domain> "<title>" --anchor ...
   --trigger ... --rule ... --why ... --evidence ...` (lands in inbox), then promote the batch via
   `node scripts/memory/promote-lesson.mjs <domain>`. RESOLVER-CHECK every anchor first: its path must
   route to the domain you're writing (most-specific glob; `resolveDomain` in scripts/memory/store.mjs
   is the SSOT). Routes elsewhere → move the lesson there, or fix the owning skill's globs.
4. **Curate as you write:** drop fake/uncertain anchors, de-dup cross-domain (content_hash helps but
   judge semantics yourself), keep `domain-platform-shell` SHORT (cross-cutting platform facts only).
5. **Verify:** `node scripts/memory/sweep-anchors.mjs` → `drift=0 gone=0`;
   budgets and routing are enforced by the curated memory-routing suite in CI; spot-check delivery:
   `memoryctl lessons --path <a-file-of-the-domain>` shows the new lessons.
6. **Record counts** per domain via `memoryctl append --kind decision` (density → split candidates).

## Lesson body schema (markdown block, stored verbatim in the entry body)
```markdown
## <short rule title>
- anchor: <project-specific>/src/<...>.rs:<symbol>   (or file:line, file path, or glob)
- trigger: <when this applies>
- rule: <actionable future behavior>
- why: <root cause, one line>
- evidence: <commit/test/log>
- date: YYYY-MM-DD
```

## Worker brief discipline (paste into each fan-out worker)
- ANCHOR-FIRST: find the live symbol with codegraph (`rg` for a known literal)
  BEFORE writing, and CONFIRM it by
  reading the file the search names — a text hit is not a resolved symbol. Only if it resolves. Never
  paraphrase a note and invent an anchor.
- CLASSIFY each candidate `durable-invariant | historical-incident | discard`; only durable future
  RULES become lessons. Skip narratives / «we fixed X» / file-line-only facts.
- RESOLVER-CHECK: anchor path must match THIS domain's globs; else report wrong-domain.
- No padding — quality over count. Return a digest (title + anchor + keep/wrong-domain list).

## Failure modes
- Note-first fabrication / fake anchors → rot the moment code moves. Anchor-first only.
- Wrong-domain anchor → the lesson never delivers on the files it's about. Resolver-check.
- `domain-platform-shell` as dumping ground → the old 683-file rot relocated. Reject domain-specific
  lessons from it.
- Storing code structure in memory → a search finds it live; memory = what code can't tell.
- Closed self-learn loop (Hermes attractor) — capture immediate, promote gated via `/curate`.
- Skipping sweep/CI → stale anchors slip in. The ratchet is the safety net; run it.
