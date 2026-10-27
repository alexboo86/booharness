# Происхождение

Скил перенят извне. Это НЕ наш текст — правки в нём расходятся с апстримом и
теряются при обновлении. Правь только то, что перечислено ниже как «наша правка».

- источник: https://github.com/addyosmani/agent-skills
- путь в апстриме: `skills/security-and-hardening`
- лицензия: MIT (файл `LICENSE` рядом)
- перенято: 2026-08-07, прогоны 20260807T153353754Z-svod-skills-research-2 и
  20260807T160043559Z-svod-skills-gap, решение оператора memoryctl #1297

**Наша правка.** Апстримный SKILL.md трижды ссылается на `references/security-checklist.md`, который лежит в корне репозитория, а не в каталоге скила — файл втянут. То есть «самодостаточен» из ресёрча было неверно, проверено замером.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline` (`scripts/check-skill-contract.mjs` not in this kit). This section is written by that command.

```run-scripts
```
