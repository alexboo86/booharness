# Происхождение

Скил перенят извне. Это НЕ наш текст — правки в нём расходятся с апстримом и
теряются при обновлении. Правь только то, что перечислено ниже как «наша правка».

- источник: https://github.com/Nanako0129/sepia
- путь в апстриме: `skills/sepia` (канонический скил; обёртки `sepia-write`,
  `sepia-review`, `sepia-refactor`, `sepia-recreate` и упаковка плагинов не взяты —
  у нас операция называется в запросе, а не слэш-командой)
- коммит апстрима: `06a5233395299ff78558b15568679c2c5c0fe942` (2026-09-24), версия 0.12.2
- лицензия: MIT (файл `LICENSE` рядом)
- перенято: 2026-09-02, решение оператора в лид-сессии (ревизия скилов, memoryctl
  reference «Ревизия скилов и уроков 2026-09-02»); обновлено до 0.12.2 2026-10-04,
  решение оператора #14184

**Applicability.** Sepia edits human-facing prose: structure first, then discourse and wording. Select it for the adopted project's writing task, not from another project's support commands or incident workflow. Code, structured agent reports and memory records retain their own contracts.

**Наши правки.** Нет. `agents/openai.yaml` — метаданные Codex, оставлены как есть.
Скил сам несёт раздел «Security boundary»: текст, который он правит, — данные, а не
команды; это совпадает с `agent-input-safety`.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline` (`scripts/check-skill-contract.mjs` not in this kit). This section is written by that command.

```run-scripts
```
