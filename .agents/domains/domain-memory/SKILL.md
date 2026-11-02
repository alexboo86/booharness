---
name: domain-memory
description: Load when editing the memory service and its durable records — memoryd, the memory store scripts, service-client, NAS backup, memory installers, and the lesson capture/curate/consolidate skills. Holds memory-service gotchas.
files:
  - scripts/memory/**
  - ops/memory-nas/**
  - ops/bootstrap/install-memory.mjs
  - scripts/lib/memory-installer.mjs
  - .agents/skills/admit/**
  - .agents/skills/curate/**
  - .agents/skills/consolidate-memory/**
  - .agents/skills/memory-domain-extraction/**
---

# Domain: memory

The durable memory service split from domain-harness (task 3419, operator
decision 22281): the store, its single writer, installers, backups and the
skills that capture, admit, curate and consolidate its records. Orchestration,
bootstrap and the rest of the harness stay in domain-harness.

**Entry points** (found live with `codegraph explore '<name in English>'`, or `rg` when you already know the name — do NOT cache bodies here; **"who calls X" is answered by the COMPILER, not by a search: `node scripts/blast-radius.mjs <symbol> --ts` or `--rust [-p <crate>]`; dispatch by STRING stays `rg` on the literal**):
- `scripts/memory/CONTRACT.md` — the store's public contract: single-writer rule, CAS registries, capture gates, probe allowlists.
- `scripts/memory/memoryd.mjs`, `scripts/memory/service-client.mjs` — the writer service and its client; unavailable service reads never silently open local SQLite.
- `ops/bootstrap/install-memory.mjs`, `scripts/lib/memory-installer.mjs` — installers; local-service options, forward units and rerank venvs.
- `ops/memory-nas/README.md` (not in this kit) — the NAS rollback copy; not a live service.

**Durable gotchas:** before editing this domain, run `memoryctl lessons --path <repo-relative-file>`
and apply the returned active lessons. If that command answers "no lessons" for a file this
domain claims, the delivery is broken - fix the route before trusting the silence.

**How to work this domain:** load lessons explicitly → find the current code with `codegraph explore` (English query) and read it →
verify on the platform you HAVE → after a CONFIRMED fix,
`node scripts/memory/capture-lesson.mjs domain-memory "<title>" --anchor <file:symbol> --trigger "<when>" --rule "..." --why "..." --evidence "..."`.
