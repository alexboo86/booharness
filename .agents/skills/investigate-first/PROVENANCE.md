# Происхождение

Скил перенят извне. Это НЕ наш текст — правки в нём расходятся с апстримом и
теряются при обновлении. Правь только то, что перечислено ниже как «наша правка».

- источник: https://github.com/JuliusBrussee/caveman
- автор: Julius Brussee
- путь в апстриме: `skills/investigate-first/SKILL.md`
- ревизия на момент переноса: `27d5a3981a34`
- лицензия: MIT (файл `LICENSE` рядом). Репозиторий двулицензионный: BSL-1.1
  накрывает только каталоги движка (`engine/`, `proxy/`, `cacheengine/`,
  `rewriter/`, `browse/`, `mcp/`, `shrink/`, Go-ядро cavemem,
  `shared/platform/`); `skills/` в это исключение НЕ входит и остаётся MIT —
  проверено в `LICENSING.md` апстрима 2026-08-17.
- перенято: 2026-08-17, задача 665, по итогам круга `method-alternatives-r3`

## Почему именно он

Заменяет `superpowers:systematic-debugging` (9 465 Б) на 688 Б. Правило то же —
не править, пока один механизм не объясняет улики, — без четырёх фаз и таблицы
рационализаций.

Измерение, ради которого замена и делалась (круг `method-alternatives-r3`,
2026-08-17): SkillsBench (arXiv 2602.12670) на 87 задачах даёт компактному
классу текста +19.0 п.п., а «исчерпывающей прозе» +0.7 п.п.; по размеру набора
два-три скила дают +19.0, четыре и больше — только +10.1. Мы стояли за
оптимумом по обеим осям.

## Что здесь НАШЕ

Только `PROVENANCE.md`. `SKILL.md` — апстримный, не тронут.

Апстримный каталог `agents/` (файл `openai.yaml`) НЕ перенесён намеренно: нам
нужен текст метода, а не описание чужого агента. Исполняемых файлов в скиле
нет и быть не должно — «Agent Skills in the Wild» (arXiv 2601.10338) меряет у
скилов со скриптами шансы уязвимости в 2.12 раза выше при p < 0.001.

## Как обновлять

Скопировать `SKILL.md` заново из апстрима, обновить ревизию выше тем же
коммитом, перечитать текст: он обязателен для профилей и его формулировки
доезжают до члена дословно.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline` (`scripts/check-skill-contract.mjs` not in this kit). This section is written by that command.

```run-scripts
```
