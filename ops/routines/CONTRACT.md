---
id: ops-routines
owner: domain-harness
paths:
  - ops/routines/**
entry: ops/routines/consolidate-memory-daily.md
layer: harness
---
## Purpose

Defines scheduled harness maintenance routines for memory consolidation, lesson deduplication, and orchestration and code-review audits.

## Public API

The public surface is prompt data, not an importable function or scheduler implementation.

`scripts/lib/routines.mjs` loads the records;
`scripts/routines.mjs list [--json]` exposes them to the lead-only
`.agents/skills/setup-routines/SKILL.md` workflow.

### Wire names

| Routine id | Description |
|---|---|
| `consolidate-memory-daily` | Daily consolidation and code-rechecked, delivery-gated lesson corrections. |
| `lesson-dedupe-weekly` | Weekly duplicate-lesson review with preservation of delivery coverage. |
| `orch-rejected-review-weekly` | Weekly audit of rejected reviews and routine value. |
| `orch-role-matrix-weekly` | Weekly review of orchestration role/family evidence. |
| `weekly-cumulative-code-review` | Weekly cumulative code-review prompt. |

Each id names a sibling Markdown file with `id`, `title`, `cron`, `summary`
front matter and a prompt body.

## Inputs

- Markdown definitions read by the external loader.
- During execution, the prompts read memory service records, code and orchestration evidence.
- User selection and the lead application's scheduler determine which definitions run.
- Definitions do not create a timer merely by existing in this directory.

## Outputs

- Loader records containing id, title, cron, summary and prompt.
- Scheduler task name = routine id, schedule = cron, prompt = body, when the user elects installation.
- Run reports titled `routine <id> <YYYY-MM-DD>: ...`, reproduced-work task titles prefixed `[routine:<id>]`, ledger value lines and operator notifications.
- Proposals rather than unsupported mutations when a prompt's evidence/authority gates do not permit action.

## Invariants

- Routine data must have complete nonempty front matter, a valid lowercase/hyphen id, five cron fields and a nonempty prompt; duplicates and non-regular files fail the whole load. Source: `scripts/lib/routines.mjs`; `scripts/test-routines.mjs`.
- Scheduler installation belongs to the lead app and user choice; setup skips existing ids and never edits or deletes scheduled tasks. Source: `.agents/domains/domain-harness/knowledge/kit-adoption-routines-and-login-credentials.md`.
- Consolidation never silently changes protected tasks/handoffs, pinned entries or entries changed within 24 hours; the active-lesson exception requires stage E's rechecked evidence and delivery gate. Source: `consolidate-memory-daily.md` (iron invariant and bounds).
- Service unavailability is reported, not replaced with a local memory source; direct SQL mutation is forbidden. Source: `consolidate-memory-daily.md` (scan and bounds).
- A lesson dedupe must preserve the retired anchor's delivery coverage through the survivor's globs and pass delivery comparison before retirement. Source: `lesson-dedupe-weekly.md`.
- Reproduced work searches for an existing task before creating one; reporting includes the routine ledger line and final operator notification. Source: each routine's Report and delivery section.

## Dependencies

### Internal Modules

- No source imports: these Markdown prompts are loaded as data.
- `scripts-lib-harness` — external routine loader, not imported code within this module.
- `scripts-harness` — routine listing command referenced by setup.
- `scripts-dev-tools` — routine ledger command referenced by prompts.
- `scripts-memory` and `agents-skills` — memory service tooling and maintenance workflows invoked by the prompts.
- `ops-orchestrator-runtime` — evidence consumed by orchestration audit routines.

### External Libraries

- No package dependencies declared here; execution requires the lead app's scheduler, memory tools and notification tool.

## Tests

- `scripts/test-routines.mjs` — definition loading, required fields and whole-load refusal cases.
- `scripts/test-routine-ledger.mjs` — consumer-side run/date/task accounting.
- Commands: `node scripts/test-routines.mjs`; `node scripts/test-routine-ledger.mjs`.
- Prompt execution decisions require evidence review; loading tests do not prove unattended maintenance outcomes.

## Owner

`domain-harness`; prompt definitions do not grant additional authority over live services or active work.

## Changelog

- Task 2409 slice C: document existing data, scheduling and evidence gates; no routine prompt or schedule change.
