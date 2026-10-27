---
name: curate
description: Memory curator over memoryctl memory.db.
lead_only: true
---

You are the memory curator. **The store is memoryctl memory.db** and nothing else — append-only
plus supersede, every mutation through `memoryctl`. There are no generated export files: the
`MEMORY.md` / `SESSION-REGISTRY.md` / `handoffs/` / `lessons/` this skill used to warn about were
removed with the move to the standalone service, and warning about files that do not exist taught
the reader the store had a second face.
**Autonomy boundary (HARD):** you may supersede/append/promote INSIDE the
DB (reversible — old rows stay in the chain). You may NOT edit CLAUDE.md/AGENTS.md/skills/hooks —
prepare a diff, show the operator, wait for approval. Closed self-learn loops stay FORBIDDEN;
every promotion or supersede requires human/lead judgment per item.

## Inputs (read first)
1. `memoryctl status` and `memoryctl hot` — prove the standalone service is healthy.
2. Inbox: `memoryctl search "inbox" --kind lesson --limit 100`; captured lessons
   come only from `capture-lesson.mjs`.
3. Sweep: `node scripts/memory/sweep-anchors.mjs` — anchor health (keep/drift/gone) and writes the
   `anchor-sweep-latest` report entry.
4. Budget: **the sum of active lesson BODIES anchored at one FILE, ≤ 24 576 B** — the budget the
   memory-routing suite enforces (agents may run it again, #14235).
   That is the only lesson budget there is. A per-DOMAIN count
   guard existed until 2026-08-11 and was removed: a domain has not entered any context as a unit
   since delivery went per-file, and the count was blocking promotion of 77 captured lessons to
   protect a number no agent reads. Near-duplicates are still caught here, because near-duplicates
   about one file share its anchor.

## Procedure
1. **Review inbox entries** — per item decide with evidence; promote actionable
   entries, supersede obsolete entries with an explicit reason, and surface
   ambiguous entries to the operator instead of guessing.
   Judge each entry the way a training set is cleaned (operator 2026-09-25):
   a lesson must teach a behaviour; one that only states a fact about the
   subsystem (what exists, how it is wired, what it stores) belongs on the
   domain's `knowledge.md` and is retired from lessons once the page carries it;
   near-repeats are merged, not stacked; a lesson whose fix was later reverted
   or judged wrong is retired, because delivery repeats it as confidently as a
   good one.
   Candidates for merging and for contradictions come from
   `node scripts/memory/lesson-duplicates.mjs` (read-only, lexical: same-anchor near-duplicates,
   and opposite-polarity rule pairs with high word overlap; no model judges them); every pair is
   your call.
2. **Re-anchor drift and rot.** The anchor is the ONLY delivery route: `memoryctl lessons --path`
   returns what matched `anchor`/`globs` and nothing else, so a lesson pointing at a path that no
   longer exists reaches nobody who edits the code it describes.
   ```bash
   node scripts/memory/reanchor-lesson.mjs --id <n> --to <file[:symbol]> [--id <n> --to ...] [--dry]
   ```
   It refuses a target file that does not exist — re-anchoring to a second ghost is the same defect
   with a fresh date — and one bad move refuses the whole batch. When symbols churn, a FILE-level or
   glob anchor is the durable choice.
   `gone>0` is a fork, and the third branch is the one that gets forgotten:
   - the code MOVED → re-anchor;
   - the subject was DELETED for good → `node scripts/memory/retire-lesson.mjs --id <n> --reason "<why>"`;
   - the anchor names a file that exists only on a BRANCH → the lesson landed before its code. Leave
     it (or put it back) at `status: inbox`; it is not rot and retiring it throws away knowledge that
     becomes deliverable the day the branch lands.
   NEVER silent-drop knowledge.
3. **Promote captured lessons**: `node scripts/memory/promote-lesson.mjs <domain>|--all` —
   supersedes inbox→active with `{domain,anchor,title}`+content_hash dedup. Contradiction with an
   existing active lesson → surface to operator, don't pick silently.
4. **Budget squeeze** (domain >30 active): merge overlapping lessons (one supersede carrying the
   merged body, others superseded with `MERGED-INTO: <id>`), retire historical-incident ones.
5. **Hygiene while touching entries**: titles ≤500 chars (short rule-style), structured lesson links
   `{domain, anchor, globs, status}`, evidence lines honest (observed-once ≠ operator-confirmed).
6. **Verify (evidence, not assertions)**: re-run sweep → expect `drift=0 gone=0`; inbox count of
   unresolved items → report; spot-check delivery with `memoryctl lessons --path <a touched anchor>`;
   run the memory-routing suite for routing/budget regressions (#14235).
7. **Record**: `memoryctl append --kind decision --title "curate YYYY-MM-DD" --body "<counts:
   resolved/re-anchored/promoted/merged/deferred>" --agent curator`. The DB is the whole story —
   the agent-memory git projection is decommissioned (`.gitignore:239`, `memoryd.mjs`
   `projection_enabled: false`); there is no export/push step.
8. **Contract/skill proposals (GATED)**: durable process lesson that belongs in CLAUDE.md/AGENTS.md/
   a skill/hook → write the diff, show operator with a one-line summary, apply only on «го»
   (contract edits then go through the edit-contract-mirror skill).

## Hard rules
- Supersede, never edit-in-place; never delete — chains keep history.
- Every lesson write passes deterministic code-point ceilings in the memoryctl client
  (`scripts/memory/lesson-quality.mjs`). Only new or changed fields are checked:
  promote, re-anchor and retire of an unchanged lesson pass as before. A MERGE
  body is new text: title ≤120, rule ≤300, trigger/why/evidence ≤400, or
  `--long "<reason>"` explaining why a field exceeds its ceiling.
  A refusal names every faulty field; fix them all in one retry.
- Registry only via CAS (`registry-update --expected-version`); 409/exit 9 → re-read, retry.
- Don't touch the domain-routing frontmatter (`SKILL.md files:` globs) — that's code-reviewed routing.
- data-integrity contradictions and operator preferences are never resolved silently.
