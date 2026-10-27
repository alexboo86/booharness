# Происхождение

Скил перенят извне. Это НЕ наш текст — правки в нём расходятся с апстримом и
теряются при обновлении. Правь только то, что перечислено ниже как «наша правка».

- источник: https://github.com/existential-birds/beagle
- путь в апстриме: `plugins/beagle-rust/skills/rust-code-review`
- коммит апстрима: `d1a74899fbfec74974d1818e4cac7c3d54d44b65` (main, 2026-08-09)
- лицензия: Apache-2.0 (файл `LICENSE` рядом)
- перенято: 2026-09-02, решение оператора в лид-сессии (ревизия скилов, memoryctl
  reference «Ревизия скилов и уроков 2026-09-02»). Сосед уже перенятого
  `tokio-async-code-review` (2026-08-07) из того же плагина: тот покрывает рантайм и
  каналы, этот — владение, ошибки, трейты, unsafe, раскладку типов, дизайн интерфейса.

**Наши правки** — только ссылки между скилами, текст правил не тронут:

- `[review-verification-protocol](../review-verification-protocol/SKILL.md)` →
  `` `review-verification-protocol` `` (имя скила; у члена Свода нет относительного
  пути между скилами — та же правка, что в `tokio-async-code-review`).
- `[tokio-async-code-review](../../tokio-async-code-review/SKILL.md)` → имя скила.
- `references/pinning-cancellation.md` и `references/concurrency-testing.md` втянуты
  из соседних `tokio-async-code-review` и `rust-testing-code-review` (тот же коммит
  апстрима), ссылки на них переписаны на локальные.
- `rust-best-practices` (соседний скил апстрима: performance, clippy config, type
  state, iterators, docs) НЕ перенят — этот пласт уже лежит в `rust-async-rules/rules/`
  (perf, lint, api, doc). Ссылки на него переписаны в имя скила с пометкой
  «not vendored here», плюс одна строка-примечание под фронтматтером `SKILL.md`.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline`. This section is written by that command.

```run-scripts
```
