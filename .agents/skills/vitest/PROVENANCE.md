# vitest

Upstream: https://github.com/antfu/skills
Source: `skills/vitest/` at commit `feb0f3aba6566426f12230e7fc7a10d97c1293bb`, copied unmodified (SKILL.md sha256 `d0c470a07b90936ca77fea9fbe25ab657a5bc1f386eb45b18bb70899df7e6baf`).
Installed 2026-10-22 by operator approval (memory decision #19444).
License: MIT, per upstream `LICENSE.md` at the repository root (Copyright 2025-PRESENT Anthony Fu). Local `LICENSE` records that text verbatim; it is not part of the upstream skill folder.
Not vendored: the rest of antfu/skills (its `instructions/`, `scripts/`, `sources/`, other skills and repo tooling) and the vitest-dev/vitest docs the skill was generated from (`GENERATION.md` records their SHA `ea1c44fb581978421f9f0901ce8c635970ea72fb`). The skill is documentation only; its vitest CLI examples are illustrative and our runs stay inside the named project checks.
Supply-chain surface: no executable scripts or install/network steps in this skill folder.

## Version surface — this repo runs Vitest 4 and 2, upstream targets 5

Upstream states the skill is based on **Vitest 5.0.1** (SKILL.md). This repo runs **Vitest 4** (`package.json` `^4.1.5`, installed 4.1.9) and **Vitest 2** (`web/package.json` (not in this kit) `^2.1.8`). Every rule below does **not** hold on the named versions. Checked against the vitest-dev/vitest GitHub release notes (v3.0.0 2025-01-16, v4.0.0 2025-10-22, v5.0.0 2026-09-03, and 4.x/5.x minor notes) and the v4.1.9 / v2.1.8 docs. The vendored text is unedited; this section is the local errata. Checked and holding on both: `test.for` (2.0.0) and `toMatchTypeOf`→`toExtend` (`toExtend` ships with expect-type 1.3.0, pinned in both trees).

Rules holding on neither Vitest 4 nor Vitest 2 (v5 surface):

1. `references/features-benchmarking.md` (whole) and `references/core-test-api.md` "Benchmarks (v5)": `bench` is a test-context fixture, not a top-level import — v5.0.0 breaking "**benchmark**: Rewrite the public API"; v4/v2 import `bench` from `vitest`.
2. `references/features-mocking.md` "Conditional Mocking with vi.when (v5)": `vi.when()` — v5.0.0 feature "Create `vi.when()`".
3. `references/features-mocking.md` and `references/core-config.md` `clearMocks` "defaults to `true`" — v5.0.0 breaking "Clear mocks by default before each test"; v4.1.9 `docs/config/clearmocks.md` and v2.1.8 docs say default `false`.
4. `references/core-test-api.md` titles formatted with `pretty-format`, `$` strings unquoted, `taskTitleValueFormatTruncate` — v5.0.0 breaking "Replace `loupe.inspect` with pretty-format" and "Remove quotes from string values in `test.for/each` title `$` variable"; v4/v2 quote them.
5. `references/core-expect.md` "unawaited async assertions … fail the test" — v5.0.0 breaking "Fail the test when an asynchronous assertion is not awaited"; v4 only warns and auto-awaits.
6. `references/core-test-api.md`, `references/core-describe.md`, `references/features-concurrency.md`: "`test.sequential`/`describe.sequential` was removed in v5 — use `{ concurrent: false }`" — removal is v5.0.0 ("Remove `sequential` test/suite options in favor of `concurrent`"); 4.1.6+ only deprecates `sequential` (it still runs) and formalises `{ concurrent: false }`; on 2.x `test.sequential`/`describe.sequential` are the documented API.
7. `references/core-cli.md` `vitest doctor` — v5 command (v5.0.1 notes); absent from v4 and v2 CLIs.
8. `references/core-cli.md` `--repeats <n>` — v5.0.0 feature "Add `--repeats` CLI option".
9. `references/core-cli.md` and `references/advanced-projects.md` "`-p` shorthand for `--project`" — v5.0.0 feature.
10. `references/core-config.md` and `references/features-reporters.md` the `.vitest/` artifact dir (`createReport`, blob `.vitest/blob/`, `.vitest/attachments/`, html reporter default output, single-file html) — v5.0.0 features "Add `createReport` and `.vitest` report directory convention", "Change html reporter default output to `.vitest`", "Support html reporter single file output".
11. `references/features-coverage.md`: `coverage.autoAttachSubprocess` v8 subprocess/worker coverage — v5.0.0 feature "V8 to track `node:child_process` and `node:worker_threads` contexts"; glob thresholds no longer inheriting top-level `perFile`; `coverage.ignoreEmptyLines` "removed" — v5 semantics, v4 still has `ignoreEmptyLines` and the old inheritance.
12. `references/advanced-environments.md` "v5" note: DOM-environment global assignments propagate to jsdom/happy-dom (v5.0.0 "Allow mutating happy-dom/jsdom window object"), strict/exact locators (v5.0.0 "Enable `locators.exact` by default"), `browser.api` deprecated in favour of top-level `api`, `browser.traceView`.
13. `references/advanced-projects.md`: inline projects share the declaring config's Vite server (`sharedViteServer`) and inherit its plugins without `extends: true`, nested projects — v5.0.0 breaking "Share the Vite server between inline projects", "Inline projects extend the root config by default", "Support nested projects"; v4 needs `extends: true`, has no nesting, 2.x has no `test.projects`.

Rules additionally not holding on Vitest 2 (`web/`, 3.x/4.x surface):

14. `references/core-test-api.md` "options as the second argument; the 3rd-arg options object was removed in v4" — on 2.x the third-arg options object is valid (only deprecated from 3.0.0, "deprecation warning if suite or test uses object as the third argument").
15. `references/features-test-tags.md` (whole, marked 4.1+) and `references/core-test-api.md` tags: added 4.1.0 ("Support tags"), `TestRunner.matchesTags` 4.1.1.
16. `references/features-context.md` `test.override` (4.1.0) replacing deprecated `test.scoped` (3.1.0): neither exists on 2.x.
17. `references/features-context.md` builder-pattern fixtures and `test.beforeAll` file/worker fixtures (marked 4.1+): not on 2.x.
18. `references/features-context.md` and `references/core-test-api.md` test-context `signal` and `annotate` (marked 3.2+): not on 2.x.
19. `references/features-context.md` fixture scopes (marked 3.2+): v2.1.8 `docs/guide/test-context.md` has no `scope`.
20. `references/features-concurrency.md` "Pools (v4)" and `maxWorkers` "not `maxThreads`/`maxForks`", `poolOptions` "removed in v4"; `references/core-config.md` "pool options are top-level": on 2.x the documented options are `maxThreads`/`maxForks`/`minThreads` and `poolOptions` (v2.1.8 config docs).
21. `references/features-concurrency.md` `sequence.groupOrder` (marked 3.2+): added 3.2.0 ("Add `sequence.groupOrder` option").
22. `references/core-config.md` "`workspace` removed — use `projects`; `vitest.workspace.ts` no longer supported": on 2.x `workspace`/`vitest.workspace.ts` is the multi-config mechanism.
23. `references/core-config.md` coverage "v4+: define `include`, no more `all`": 2.x still has `coverage.all`.
24. `references/core-describe.md` `describe.for`: added 3.0.0 ("Add `describe.for`").
25. `references/core-expect.md` `toHaveBeenCalledExactlyOnceWith` (3.0.0), `expect.toBeOneOf` (3.0.0), `expect.schemaMatching` (4.0.0 "Add schema validation matchers"), `expect.assert` (4.0.0 "Support `expect.assert` for type narrowing"): not on 2.x.
26. `references/advanced-vi.md` `vi.mockObject` (3.2.0) and its `{ spy: true }` option (4.0.0): not on 2.x.
27. `references/features-snapshots.md` ARIA snapshots (marked 4.1+, experimental) and custom snapshot matchers (4.1.3 "Support custom snapshot matcher"): not on 2.x.
28. `references/core-config.md` "`deps.optimizer.web` renamed to `deps.optimizer.client`": the rename is the Vite 6 line (v5.0.1 warns on the old name); on 2.x (Vite 5) `deps.optimizer.web` is correct.
29. `references/core-cli.md` `--standalone` "(v4: runs matched files if a filter is passed)": the v4 behaviour note (v4.0.0, filters with `--standalone`) does not describe 2.x, which lists tests in the UI (v2.1.2).

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline` (`scripts/check-skill-contract.mjs` not in this kit). This section is written by that command.

```run-scripts
```
