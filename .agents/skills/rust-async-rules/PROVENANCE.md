# Происхождение

Скил перенят извне. Это НЕ наш текст — правки в нём расходятся с апстримом и
теряются при обновлении. Правь только то, что перечислено ниже как «наша правка».

- источник: https://github.com/leonardomso/rust-skills
- путь в апстриме: `SKILL.md + rules/`
- лицензия: MIT (файл `LICENSE` рядом)
- перенято: 2026-08-07, прогоны 20260807T153353754Z-svod-skills-research-2 и
  20260807T160043559Z-svod-skills-gap, решение оператора memoryctl #1297

**Это производная с НАШИМ индексом, а не апстримный скил, поэтому и имя другое.** У апстрима индекс на 37 КБ, который член прочитал бы целиком ради тридцати нужных правил. Взят весь корпус `rules/` (265 файлов, ~900 КБ) — потому что упстримные правила ссылаются друг на друга веером, и любая обрезка оставляет висячие ссылки; замыкание по ссылкам равно всему корпусу. Цена — диск, не контекст: внимание члена ведёт НАШ индекс `SKILL.md` на 7 КБ, и он указывает только на 30 асинхронно-конкурентных правил — ровно тот класс дефектов, который назвали все четверо: cancel-safety, лок через await, небуферизованные каналы, брошенный JoinHandle. Файлы в `rules/` апстримные, не тронуты. Решение оператора 2026-08-07.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline`. This section is written by that command.

```run-scripts
```
