---
id: scripts-harness-report
owner: domain-harness
paths:
  - "scripts/harness-report/**"
entry: scripts/harness-report/collect-rtk.mjs
layer: harness
---
# Module: scripts-harness-report

## Purpose

Joins harness journals into operational reports.
The report reads independent RTK, memory and lead journals, showing source
health before volume metrics. It neither repairs journals nor changes tasks.

## Public API

| Export | Kind | Consumer contract |
|---|---|---|
| `candidatePaths` | function | `collect-rtk.mjs`: ordered, deduplicated history database candidates; also consumed by `scripts/rtk-gain-split.mjs`. |
| `isValidTimestamp` | function | `collect-rtk.mjs`: reject malformed command timestamps before aggregation. |
| `isViaRtk` | function | `collect-rtk.mjs`: distinguish filtered routing from bare/fallback commands. |
| `firstVerb` | function | `collect-rtk.mjs`: extract the underlying command verb for grouping. |
| `collect` | async function | Each collector file returns a Section with id/title, health, metrics, rows and errors. |

The entry is the RTK collector; `collect-memory.mjs` and `collect-lead.mjs`
implement the same report-section convention. `index.mjs [--days <n>]
[--json] [--strict]` is the report CLI, also exposed as `npm run harness:report`.

## Inputs

- RTK SQLite candidates from `RTK_DB_PATH` and OS-specific default locations.
- Memory store, task records and installed-source information, located using harness configuration.
- The memory service's HTTP `/health` response, probed separately from local database readability.
- Lead transcript JSONL from the selected project checkout roots.
- A positive day window (default seven); collectors also accept fixture home/env/time options.
- The Section convention is local reporting data, not a product `docs/contracts/wire/` protocol.

## Outputs

- A text report or JSON `{days, sections}` with separate health, metrics, rows and errors.
- Visible missing, malformed, short-window and multiple-live-source diagnostics.
- Strict mode exits nonzero for a failed health section; normal reporting remains inspectable without strict gating.
- Empty/unavailable measurements are labelled rather than silently reported as successful activity.

## Invariants

- RTK database reads use read-only SQLite URIs; source inspection does not create a missing history. Source: `collect-rtk.mjs`, `collect-rtk.test.mjs`.
- A path-shaped or invalid timestamp marks corrupt history instead of becoming a false newest timestamp. Source: `collect-rtk.mjs`, `collect-rtk.test.mjs`.
- Missing candidates, malformed databases and multiple live histories remain visible rather than merged into a misleading total. Source: `collect-rtk.test.mjs`.
- RTK fallback commands count as bare, not filtered successes. Source: `isViaRtk` in `collect-rtk.mjs`.
- A collector exception becomes a failed Section; errors are rendered even if other health checks pass. Source: `index.mjs`.
- Memory corruption and empty lead activity remain explicit report states, not thrown-away sections. Source: `collect-memory.test.mjs`, `collect-lead.test.mjs`.

## Dependencies

- `scripts-lib-harness`: harness config and prefix-derived memory paths.
- `ops-bootstrap`: shell command parsing shared by the lead transcript collector.
- Node `node:sqlite`, filesystem, OS, path and URL APIs; no third-party JavaScript package is imported.
- Journal schemas belong to their producers; collector tests pin the supported read shape.

## Tests

- `scripts/harness-report/collect-rtk.test.mjs` pins candidate discovery, corrupt/live/absent history and window diagnostics.
- `scripts/harness-report/collect-memory.test.mjs` pins store joins, prefix paths, source drift and corruption reporting.
- `scripts/harness-report/collect-lead.test.mjs` pins command parsing, transcript scope and empty measurement.
- Narrow check: `node --test scripts/harness-report/collect-rtk.test.mjs scripts/harness-report/collect-memory.test.mjs scripts/harness-report/collect-lead.test.mjs`.

## Owner

`domain-harness`; report changes must retain the distinction between unreadable and empty.
