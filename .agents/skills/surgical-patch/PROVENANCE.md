# Происхождение

Скил перенят извне. Это НЕ наш текст — правки в нём расходятся с апстримом и
теряются при обновлении. Правь только то, что перечислено ниже как «наша правка».

- источник: https://github.com/JuliusBrussee/caveman
- автор: Julius Brussee
- путь в апстриме: `skills/surgical-patch/SKILL.md`
- ревизия на момент переноса: `27d5a3981a34`
- лицензия: MIT (файл `LICENSE` рядом). BSL-1.1 в этом репозитории накрывает
  только каталоги движка; `skills/` остаётся MIT — проверено в `LICENSING.md`
  апстрима 2026-08-17.
- перенято: 2026-08-17, задача 665, по итогам круга `method-alternatives-r3`

## Почему именно он

Аналога у нас не было вовсе, а правило повторяется в каждом круге ревью: менять
самый узкий слой, владеющий неверным поведением, не чистить и не абстрагировать
вне правки, добавлять только релевантное доказательство регрессии. 664 байта.

Он занимает в обязательном наборе профиля coding место, освободившееся после
`superpowers:test-driven-development`. TDD как ИНСТРУКЦИЯ О ПРОЦЕССЕ измеренной
поддержки не имеет: контролируемое сравнение Бёкелер (Sonnet пишет, Opus судит
вслепую) поставило прогоны с TDD-инструкцией чуть НИЖЕ, разницы в mutation
score не нашло и намеряло от 2.96 до 8.50 раза больше токенов, а агенты
«пропускали или имитировали красный шаг».

## Что здесь НАШЕ

Только `PROVENANCE.md`. `SKILL.md` — апстримный, не тронут. Апстримный каталог
`agents/` не перенесён: нужен текст метода, а не чужой агент. Исполняемых файлов
нет намеренно (arXiv 2601.10338: скилы со скриптами уязвимы в 2.12 раза чаще,
p < 0.001).

## Как обновлять

Скопировать `SKILL.md` заново из апстрима, обновить ревизию выше тем же
коммитом, перечитать текст: он обязателен для профиля и доезжает до члена
дословно.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline` (`scripts/check-skill-contract.mjs` not in this kit). This section is written by that command.

```run-scripts
```
