# Происхождение

Скил перенят извне. Это НЕ наш текст — правки в нём расходятся с апстримом и
теряются при обновлении. Правь только то, что перечислено ниже как «наша правка».

- источник: https://github.com/existential-birds/beagle
- путь в апстриме: `plugins/beagle-rust/skills/tokio-async-code-review`
- лицензия: Apache-2.0 (файл `LICENSE` рядом)
- перенято: 2026-08-07, прогоны 20260807T153353754Z-svod-skills-research-2 и
  20260807T160043559Z-svod-skills-gap, решение оператора memoryctl #1297

**Наши правки.** Апстрим ссылается на три файла соседнего скила `rust-code-review` (`concurrency-primitives.md`, `lock-free-patterns.md`, `memory-ordering.md`) — они втянуты в `references/` и пути в `references/sync-primitives.md` переписаны на локальные. Ссылка на соседний скил `review-verification-protocol` переписана с относительного пути на имя скила: у члена Свода скилы лежат каждый в своём каталоге, и относительного пути между ними нет. Сам `review-verification-protocol` перенят отдельным скилом, потому что этот его ТРЕБУЕТ как гейт.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline` (`scripts/check-skill-contract.mjs` not in this kit). This section is written by that command.

```run-scripts
```
