---
id: scripts-memory
owner: domain-harness
paths:
  - "scripts/memory/!(lesson-lib.mjs|capture-gate.mjs|lesson-quality.mjs|service-client.mjs|store.mjs|embed-recipe.mjs|search-results.mjs|task-pure.mjs|track-fields.mjs)"
  - "scripts/memory/*/**"
entry: scripts/memory/mcp-server.mjs
layer: harness
---
# Module: scripts-memory

## Purpose

Provides durable memory storage, retrieval, lesson maintenance and their evaluation tools.

The live service is the single writer; explicit database access is maintenance, not an implicit substitute for an unavailable service.

## Public API

`mcp-server.mjs` is the command/service registry entry, not a barrel.
The lesson-helper, service-read, capture-admission and store tables below document
unchanged consumer APIs now owned by `scripts-memory-core`; the B1 and
routing-audit sections remain owned here. MCP retains its rendering compatibility export.
Runtime definitions: `lesson-lib.mjs`, `service-client.mjs`, `capture-gate.mjs`
and `store.mjs`, with unchanged import paths.

| Export | Kind | Description |
|---|---|---|
| `REPO_ROOT` | constant | Repository root for lesson tools. |
| `requireDbPath` | function | Refuse direct SQLite access without an explicit database path. |
| `anchorFile` | function | Extract an anchor's file path without its citation suffix. |
| `SKILLS_DIR` | constant | Relative canonical skill tree. |
| `SKILLS_ROOT` | constant | Absolute canonical skill tree. |
| `DOMAINS_DIR` | constant | Relative domain-source tree. |
| `DOMAINS_ROOT` | constant | Absolute domain-source tree. |
| `SESSION_IMPORT` | constant | Import session marker. |
| `AGENT_IMPORT` | constant | Import agent marker. |
| `SWEEP_REPORT_KEY` | constant | Anchor-sweep registry key. |
| `LESSON_PAYLOAD_BUDGET_PER_FILE` | constant | Re-export of the store's lesson byte budget. |
| `EXPECTED_MEM_ENTRIES_COLUMNS` | constant | Required exact entry-column set for maintenance probes. |
| `sha256` | function | Hash string or buffer content. |
| `isGlobAnchor` | function | Recognize glob hints without treating lone `?` as a glob. |
| `buildLessonLinks` | function | Construct domain, anchor, globs, status and optional trigger/probe links. |
| `PROBE_READ_VERBS` | constant | Allowed probe binaries and read verbs. |
| `PROBE_ALLOWED_FLAGS` | constant | Allowed flags per probe command. |
| `PROBE_NODE_SCRIPTS` | constant | Individually admitted Node probe entrypoints. |
| `PROBE_NPM_SCRIPTS` | constant | Individually admitted npm probe scripts. |
| `PROBE_ALLOWED` | constant | Readable command/verb allowlist. |
| `PROBE_PATTERN_MAX` | constant | Maximum expectation-pattern length. |
| `PROBE_PATTERN_MAX_QUANTIFIERS` | constant | Expectation-pattern quantifier ceiling. |
| `ambiguousAlternation` | function | Detect overlapping alternatives in a pattern body. |
| `ambiguousRepetition` | function | Detect repetition ambiguity in a pattern body. |
| `probePatternRisk` | function | Report heuristic regexp backtracking risk. |
| `probeObjections` | function | Return objections to a proposed executable probe. |
| `lessonDedupKey` | function | Normalize domain, anchor and title into a deduplication key. |
| `fieldOf` | function | Read a named lesson-body field. |
| `titleOfBlock` | function | Read a level-two lesson heading. |
| `anchorOfBlock` | function | Read a lesson anchor field. |
| `triggerOfBlock` | function | Read a lesson trigger field. |
| `splitLessonFile` | function | Split preamble and level-two sections with exact text reconstruction. |
| `matchGlob` | function | Re-export the store's shared glob matcher. |
| `globResolves` | function | Test whether a glob matches any supplied repository path. |
| `classifyAnchor` | function | Classify an anchor as keep, drift or gone against supplied code. |
| `validateMemEntriesSchema` | function | Refuse missing, extra or absent entry columns. |
| `openExistingMemoryDb` | function | Open an explicitly named existing database and validate its schema. |
| `parseLinks` | function | Read object links JSON, treating malformed/non-object values as empty. |
| `listLiveLessons` | function | Read non-superseded lesson rows from an explicit database. |
| `filterLessons` | function | Filter lesson rows by domain/status while preserving retired status. |
| `insertLessonEntry` | function | Insert a maintenance import idempotently by title/content hash. |
| `listLessonSourceFiles` | function | Discover domain lesson and inbox source files. |
| `readUtf8` | function | Read text with strict UTF-8 round-trip validation. |
| `listRepoPaths` | function | Discover tracked paths or configured anchor roots. |
| `resolveMemoryctl` | function | Locate the installed CLI or repository launcher, otherwise refuse. |
| `spawnPlan` | function | Produce a shell-free executable/argv plan, including Windows script handling. |
| `runMemoryctl` | function | Execute the CLI and preserve failure status/stdout/stderr. |

### Service reads: `service-client.mjs`

| Export | Kind | Description |
|---|---|---|
| `serviceUrl` | function | Resolve service location from env, pointer file, then Mac loopback. |
| `readMemory` | function | GET a memory API resource without local database substitution. |
| `dbArgument` | function | Read and validate an explicit maintenance `--db` argument. |
| `readEntries` | function | Read live lessons/handoffs from the service or an explicit read-only DB. |
| `readLessons` | function | Read and filter live lesson entries. |
| `readTasks` | function | Read the validated task list from memoryd. |
| `readContradictions` | function | Find contradiction candidates from service search. |

### Handoff classification: `b1-handoff.mjs`

| Export | Kind | Description |
|---|---|---|
| `classifyB1` | function | B1 verdict for a live handoff row; the one predicate the consolidation scan and the unattended archiver share. |
| `latestLiveByTrack` | function | Newest live handoff row per track under the store's history-title rule. |
| `REFUSED_TRACK_STATUSES` | constant | Track statuses that protect a B1 handoff from archiving. |

### Capture admission: `capture-gate.mjs`

| Export | Kind | Description |
|---|---|---|
| `canonicalAnchorFile` | function | Validate/canonicalize the file portion of a capture anchor. |
| `gateNewLesson` | function | Validate capture routing, committed anchor, fields and brevity; return gate-stamped links. |

### Lesson rendering: `lesson-lib.mjs` (`scripts-memory-core`)

`mcp-server.mjs` re-exports this helper for compatibility; runtime consumers
import the defining lower-module entry.

| Export | Kind | Description |
|---|---|---|
| `renderLessons` | function | Render a lesson-service envelope for context delivery. |

### Store operations: `store.mjs`

| Export | Kind | Description |
|---|---|---|
| `SCHEMA_VERSION` | constant | Current store schema version. |
| `lessonMatchesPath` | function | Match lesson anchor/globs to a delivery path. |
| `deliveredLessonBytes` | function | Measure serialized lesson delivery size. |
| `resolveDomain` | function | Resolve an ordered domain route. |
| `resolveExplicitDomain` | function | Resolve without treating the catchall as an explicit route. |
| `openMemoryDb` | function | Open/migrate store state for the service and explicit fixtures. |
| `createMemory` | function | Create the store's memory operation handler. |
| `SEARCH_DEAD_TITLE` | constant | Search exclusion pattern for dead task titles. |
| `TRACK_SLUG` | constant | Track marker slug grammar. |
| `TRACK_STATUSES` | constant | Accepted track status values. |
| `parseTrackMarker` | function | Parse a track marker from record content. |

### Routing audit: `lesson-domain-routes.mjs`

| Export | Kind | Description |
|---|---|---|
| `auditLessonDomainRoutes` | function | Audit lesson rows against the routing map. |
| `mismatchedLessonDomains` | function | Select rows whose filed domains disagree with routes. |

## Inputs

- CLI/MCP/HTTP operations, lesson bodies/links, task/report records and optimistic versions.
- Installed domain-routing JSON, repository anchors/Git refs and explicit maintenance database paths.
- Service URL/token configuration, SQLite state, embedding model recipes and optional reranker configuration.
- Offline evaluation corpora, manifests and labelled search/delivery cases; these tools are not capture authority.

## Outputs

- Versioned SQLite entries, tasks, reports, registry values and model-stamped vectors; HTTP/MCP responses and context renderings.
- Gate refusals, capture/maintenance plans, sweep reports and evaluation artifacts.
- Protocol ownership is `memoryd.mjs`, `mcp-server.mjs` and `service-client.mjs`; no market-data wire contract applies.

## Invariants

- memoryd is the single live writer; unavailable service reads never silently open local SQLite; source: `service-client.mjs`, [owner knowledge](../../.agents/domains/domain-harness/knowledge/memory-service-and-durable-records.md).
- Direct DB access requires an explicit existing schema-validated path; a local-copy id cannot be mutated live through `--db` without dry mode; source: `lesson-lib.mjs`, `service-client.mjs`.
- New lessons need committed anchors, routed domains, trigger/evidence, deterministic brevity checks and a server-checked gate stamp; the stamp is an accident guard, not authentication; source: `capture-gate.mjs`, [capture knowledge](../../.agents/domains/domain-harness/knowledge/lesson-capture-and-delivery.md).
- Windows CLI arguments never pass through cmd.exe tokenization; unsafe executable/script discovery refuses; source: `spawnPlan` in `lesson-lib.mjs`, `test-spawn-plan.mjs`.
- Probe allowlists validate verbs and flags, not just executable prefixes; regexp safety is heuristic and sweeps also enforce a child deadline; source: `lesson-lib.mjs`, `sweep-probes.mjs`.
- Lesson-file splitting reconstructs the original text exactly and retired lessons retain retired status; source: `splitLessonFile`, `filterLessons`, `test-lesson-lib.mjs`.

## Dependencies

### Internal Modules

- `scripts-lib-platform-shell` — main guards and lightweight domain helpers.
- `scripts-lib-harness` — project configuration and configured anchor roots.
- `scripts-harness` — scrubbed Git environment and routing generation.
- `ops-bootstrap` — runtime discovery, Jev clients and knowledge/context rendering in tools/evaluations.
- `scripts-dev-tools` and `ops-tools` — test-only Jev state isolation and updater integration.
- These are observed imports from registry-owned files; the header's empty `depends` stays unchanged.

### External Libraries

- Node built-ins including `node:sqlite`; the Python reranker pins `torch`, `transformers`, `sentencepiece` and `huggingface_hub` in `rerank-worker.py`; embedding service/model installation is managed separately.

## Tests

- `scripts/memory/test-lesson-lib.mjs` — parser, anchor/link and maintenance helper contracts.
- `scripts/memory/test-spawn-plan.mjs` — safe Windows argv transport.
- `scripts/memory/test-service-client.mjs` — service discovery and no implicit DB substitution.
- `scripts/memory/test-capture-gate.mjs` — capture admission and routing.
- `scripts/memory/test-store-entries.mjs` — entry storage/versioning behavior.
- `scripts/memory/test-store-lessons.mjs` — lesson matching and delivery.
- `scripts/memory/test-store-tasks.mjs` — durable task operations.
- `scripts/memory/test-store-reports.mjs` — report persistence and validation.
- `scripts/memory/mcp-server.test.mjs` — MCP boundary, read/write operations and lesson rendering.
- `scripts/memory/test-lesson-dedupe.mjs` — duplicate candidate/ledger behavior.
- `scripts/memory/test-archive-handoff.mjs` — B1 age/protection boundaries, Unicode preservation, stdin transport and the real CLI archive path against an isolated store.
- `scripts/memory/test-retire-lesson.mjs` — retire write transport: the stamped body reaches memoryctl over stdin, a planted symlink at the former predictable temp name is not followed, and the 480-code-point title cap never splits a surrogate pair.
- `scripts/memory/test-eval-compile-delivery.mjs` — delivery-comparison evaluation semantics.

## Owner

`domain-harness`; installed service changes require the documented install/restart workflow.
