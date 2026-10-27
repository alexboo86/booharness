# Происхождение

Скил перенят извне. Это НЕ наш текст — правки в нём расходятся с апстримом и
теряются при обновлении. Правь только то, что перечислено ниже как «наша правка».

- источник: https://github.com/existential-birds/beagle
- путь в апстриме: `plugins/beagle-rust/skills/review-verification-protocol`
- лицензия: Apache-2.0 (файл `LICENSE` рядом)
- перенято: 2026-08-07, прогоны 20260807T153353754Z-svod-skills-research-2 и
  20260807T160043559Z-svod-skills-gap, решение оператора memoryctl #1297
- наша правка: `SKILL.md` переписан локально коммитом 2c90fd702 (2026-09-16,
  решение оператора #9243): 397 строк убрано, 58 написано заново. Тем же
  коммитом добавлен наш `references/rust-review.md`. С этого коммита оба файла —
  наш текст, а не копия апстрима: обновление из апстрима на них не
  накладывается, сверка по sha256 с апстримом к ним неприменима. Запись
  внесена по решению оператора memoryctl #14218 (задача 2038).

Перенят потому, что `tokio-async-code-review` требует его как гейт перед выдачей находки: доказательство file:line до утверждения. Совпадает с правилом доказательности нашего контракта.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline` (`scripts/check-skill-contract.mjs` not in this kit). This section is written by that command.

```run-scripts
```
