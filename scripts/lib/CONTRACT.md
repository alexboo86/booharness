---
id: scripts-lib-platform-shell
owner: domain-platform-shell
paths:
  - "scripts/lib/anchor-grammar.mjs"
  - "scripts/lib/bench.mjs"
  - "scripts/lib/check-kimi-hook-wiring.mjs"
  - "scripts/lib/check-lead-chat-wiring.mjs"
  - "scripts/lib/domain-of.mjs"
  - "scripts/lib/expand-index-css.mjs"
  - "scripts/lib/import-embed-model.mjs"
  - "scripts/lib/locale-source.mjs"
  - "scripts/lib/memory-forward.mjs"
  - "scripts/lib/memory-installer.mjs"
  - "scripts/lib/ts-module-loader.mjs"
  - "scripts/lib/worker-closure.mjs"
  - "scripts/lib/CONTRACT.md"
entry: scripts/lib/anchor-grammar.mjs
layer: tooling
---
# Module: scripts-lib-platform-shell

## Purpose

Shares repository tooling helpers for environment, routing and command execution.

This module owns only the explicit files in its header, not all of `scripts/lib`.
Harness configuration and login helpers belong to `scripts-lib-harness`.

## Public API

Consumers import individual helper files; `anchor-grammar.mjs` is the registry entry, not a barrel.
`is-main.mjs` retains its path and API in `scripts-runtime-shared`.

| Export | Kind | Defining file | Description |
|---|---|---|---|
| `loadBenchRevision` | function | `scripts/lib/bench.mjs` | Bundle benchmark exports from a Git revision or the working tree. |
| `startAllocationSampling` | function | `scripts/lib/bench.mjs` | Start inspector sampling and return a function-name allocation collector. |
| `checkKimiHookWiring` | function | `scripts/lib/check-kimi-hook-wiring.mjs` | Check configured Kimi hook wiring through supplied readers and checks. |
| `checkLeadChatWiring` | function | `scripts/lib/check-lead-chat-wiring.mjs` | Probe installed lead-chat hook wiring. |
| `globToRegExp` | function | `scripts/lib/domain-of.mjs` | Compile the domain-routing glob dialect to an anchored regexp. |
| `domainOf` | function | `scripts/lib/domain-of.mjs` | Return the first matching domain from the ordered routing map, or null. |
| `INDEX_CSS_REL` | constant | `scripts/lib/expand-index-css.mjs` | Repository-relative CSS facade path. |
| `STYLE_MODULES` | constant | `scripts/lib/expand-index-css.mjs` | Named facade style-module paths. |
| `expandIndexCss` | function | `scripts/lib/expand-index-css.mjs` | Expand local style imports while preserving facade-level external directives. |
| `listFacadeStyleImports` | function | `scripts/lib/expand-index-css.mjs` | Read ordered local style imports from the CSS facade. |
| `countLines` | function | `scripts/lib/expand-index-css.mjs` | Count physical text lines without double-counting the trailing newline. |
| `readEmbedImportPin` | function | `scripts/lib/import-embed-model.mjs` | Validate the pinned GGUF model URL, size and digest. |
| `importPinnedEmbedModel` | function | `scripts/lib/import-embed-model.mjs` | Download, verify and import that model through the supplied runner. |
| `forwardLaunchdLabel` | function | `scripts/lib/memory-forward.mjs` | Build a filename-budgeted launchd label for an SSH alias. |
| `workerPlistPath` | function | `scripts/lib/memory-forward.mjs` | Locate a worker plist beside the daemon plist. |
| `forwardSshArgs` | function | `scripts/lib/memory-forward.mjs` | Render loopback reverse-forward SSH arguments; caller validates ports. |
| `memoryInstallerFor` | function | `scripts/lib/memory-installer.mjs` | Select the kit-local installer when present, otherwise the repository installer. |
| `createTsModuleLoader` | function | `scripts/lib/ts-module-loader.mjs` | Create a root-scoped TS/JS/JSON loader with resolution, cache and reset methods. |
| `FILE_EXTENSIONS` | constant | `scripts/lib/ts-module-loader.mjs` | Loader resolution suffixes. |
| `INDEX_FILES` | constant | `scripts/lib/ts-module-loader.mjs` | Loader directory-entry candidates. |
| `isFile` | function | `scripts/lib/ts-module-loader.mjs` | Test whether a filesystem path is a file. |
| `isDirectory` | function | `scripts/lib/ts-module-loader.mjs` | Test whether a filesystem path is a directory. |
| `resolveFileFromBase` | function | `scripts/lib/ts-module-loader.mjs` | Resolve a loader file candidate from its base. |
| `runtimeClosures` | function | `scripts/lib/worker-closure.mjs` | Given `{rootDir, files, resolve, resolveWorker?, sources?}`, discover worker seeds, deferred-inclusive worker/client reachability (client traversal stops before first-statement `'use server'` modules), load-time specifiers and runtime edges; `loadTimeClosure(seeds)` walks static imports/exports. Paths and resolver results are absolute; optional parsed sources preserve AST identity for codemod edits. |
| `readCompilerOptions` | function | `scripts/lib/ts-module-loader.mjs` | Read TypeScript compiler options for the loader. |
| `buildImportMetaLiteral` | function | `scripts/lib/ts-module-loader.mjs` | Build the loader's import-meta replacement. |
| `rewriteImportMeta` | function | `scripts/lib/ts-module-loader.mjs` | Rewrite import-meta expressions for loaded modules. |
| `PLAIN_SEGMENT` | constant | `scripts/lib/anchor-grammar.mjs` | Plain path-segment grammar. |
| `BRACKET_SEGMENT` | constant | `scripts/lib/anchor-grammar.mjs` | Whole Next.js dynamic route-segment grammar. |
| `PATH_SEGMENT` | constant | `scripts/lib/anchor-grammar.mjs` | Combined directory-segment grammar. |
| `NUMBER_TAIL` | constant | `scripts/lib/anchor-grammar.mjs` | Legacy numeric citation-tail grammar. |
| `SYMBOL_TAIL` | constant | `scripts/lib/anchor-grammar.mjs` | Qualified symbol citation-tail grammar. |
| `ANCHOR_TAIL` | constant | `scripts/lib/anchor-grammar.mjs` | Numeric or symbolic citation tail. |
| `PATH_END` | constant | `scripts/lib/anchor-grammar.mjs` | Citation end-boundary assertion. |
| `PATH_START` | constant | `scripts/lib/anchor-grammar.mjs` | Bare citation start-boundary assertion. |
| `SOURCE_EXT` | constant | `scripts/lib/anchor-grammar.mjs` | Source-file extension alternation. |
| `PAGE_EXT` | constant | `scripts/lib/anchor-grammar.mjs` | Source plus page/catalogue extension alternation. |
| `NUMERIC_ANCHOR_PATTERN` | constant | `scripts/lib/anchor-grammar.mjs` | Pattern detecting numeric source/Markdown citations. |
| `anchorPattern` | function | `scripts/lib/anchor-grammar.mjs` | Compose a path with an optional citation tail. |
| `extAlternation` | function | `scripts/lib/anchor-grammar.mjs` | Build a longest-extension-first alternation. |
| `pathPattern` | function | `scripts/lib/anchor-grammar.mjs` | Compose a repository-relative path grammar. |

Outside consumers include `scripts/module-registry.mjs`, knowledge-anchor gates,
`ops/bootstrap/domain-lessons-hook.mjs`, `ops/bootstrap/install-memory.mjs`,
benchmark scripts and `scripts/audit-theme-colors.mjs`.
The kit overlay installer also consumes the pinned-model import helpers.

## Inputs

- Module URLs and argv, ordered domain maps, repository roots, source paths and compiler options.
- CSS facade/import files, Git revisions and TypeScript benchmark source.
- Model pins from `ops/bootstrap/tool-pins.json`, a command runner and process environment.
- Hook configuration/readers, SSH host aliases, ports and daemon plist locations.

## Outputs

- Booleans, routing results, expanded CSS, loaded module exports and benchmark allocation totals.
- Installer paths, launchd labels, plist paths and SSH argv; these renderers do not launch workers.
- The model importer invokes curl and Ollama after verification and removes its temporary directory.

## Invariants

- Main guards compare realpaths and return false for missing/unresolvable argv; source: `scripts/lib/is-main.mjs`, `scripts/test-is-main.mjs`.
- Domain selection respects map order and returns null on no match; source: `scripts/lib/domain-of.mjs`.
- CSS expansion rejects cycles, duplicate imports, qualified relative imports and realpath escapes from `src/styles`; source: `scripts/lib/expand-index-css.mjs`.
- Model creation occurs only after the pinned byte length and SHA-256 both match; temporary files are removed even on failure; source: `scripts/lib/import-embed-model.mjs`.
- Anchor extensions are longest-first so `tsx` cannot be consumed as `ts`; source: `scripts/lib/anchor-grammar.mjs`.
- Runtime closure discovery erases whole-statement type imports/exports, retains inline type edges and rejects unresolved project-relative, `@/`, workspace imports and literal Worker/SharedWorker URLs with importer/specifier diagnostics. Unresolved import candidates that Git identifies as ignored (including absent generated directories) add no edge; ignore checks are cached per candidate for each walk. Existing literal files omitted by source inventories are resolved from disk; source dependencies are traversed, non-code and raw/url assets are not. Client traversal includes deferred imports but stops before a module whose first statement is `'use server'`; `loadTimeClosure` remains static. Worker seeds come from `workers/`, `.worker.*` and literal constructor URLs, not header declarations. Source: `scripts/lib/worker-closure.mjs`.

## Dependencies

### Internal Modules

- `scripts-runtime-shared` — main-module identity and scrubbed Git execution.
- `scripts-lib-harness` — `harnessLabel` from `scripts/lib/harness-config.mjs` for forward labels.
- This list records observed imports; contract headers carry no dependency list (task 2996).

### External Libraries

- `esbuild` — revision-aware benchmark bundling.
- `typescript` — compiler configuration, transforms and module resolution.
- Node built-ins provide filesystem, subprocess, crypto and inspector facilities.

## Tests

- `scripts/test-is-main.mjs` — symlink-safe entry detection and gate usage.
- `scripts/test-ts-module-loader.mjs` — TS resolution, import-meta handling and loader behavior.
- `scripts/test-index-css-cascade-contract.mjs` — facade expansion and cascade ordering.
- `scripts/test-hook-topology.mjs` — Kimi wiring checks.
- `scripts/test-lead-chat-topology.mjs` — installed lead-chat probes.
- `scripts/test-install-memory.mjs` — installer integration with forward rendering.

## Owner

`domain-platform-shell`; ownership is limited to the header's explicit paths.
