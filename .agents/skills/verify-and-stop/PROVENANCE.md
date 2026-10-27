# Происхождение

Скил перенят извне. Это НЕ наш текст — правки в нём расходятся с апстримом и
теряются при обновлении. Правь только то, что перечислено ниже как «наша правка».

- источник: https://github.com/JuliusBrussee/caveman
- автор: Julius Brussee
- путь в апстриме: `skills/verify-and-stop/SKILL.md`
- ревизия на момент переноса: `27d5a3981a34`
- лицензия: MIT (файл `LICENSE` рядом). BSL-1.1 в этом репозитории накрывает
  только каталоги движка; `skills/` остаётся MIT — проверено в `LICENSING.md`
  апстрима 2026-08-17.
- перенято: 2026-08-17, задача 665, по итогам круга `method-alternatives-r3`

## Почему именно он

Заменяет `superpowers:verification-before-completion` (3 646 Б) на 704 Б, и одна
его строка — наш собственный канон слово в слово: различать pass, fail,
unavailable и blocked ТОЧНО. Отсутствие у нас называется, а не подразумевается;
тот же принцип держат `memory_block` и коллекторы отчёта харнесса.

Остальное — наименьший достаточный набор доказательств, переиспользование ещё
действительных результатов, запрет полировать после того, как критерии сошлись,
и остановка на доказательстве.

## Что здесь НАШЕ

Только `PROVENANCE.md`. `SKILL.md` — апстримный, не тронут. Апстримный каталог
`agents/` не перенесён: нужен текст метода, а не чужой агент. Исполняемых файлов
нет намеренно (arXiv 2601.10338: скилы со скриптами уязвимы в 2.12 раза чаще,
p < 0.001).

## Как обновлять

Скопировать `SKILL.md` заново из апстрима, обновить ревизию выше тем же
коммитом, перечитать текст: он обязателен для ВСЕХ ШЕСТИ профилей и доезжает до
члена дословно.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline`. This section is written by that command.

```run-scripts
```
