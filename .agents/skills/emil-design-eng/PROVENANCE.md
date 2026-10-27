# emil-design-eng

Upstream: https://github.com/emilkowalski/skills
Source: `skills/emil-design-eng/` at commit `2d228630ba1446365f614a108cb8252f1feda202`, copied unmodified (SKILL.md sha256 `ffbe68e6007fb42cb8149f089b400a1ca007d59ba23e8948e2be4476f3175939`).
Installed 2026-10-22 by operator approval (memory decision #19474).
License: MIT, per upstream `LICENSE` at the repository root (Copyright (c) 2026 Emil Kowalski). Local `LICENSE` records that text verbatim; it is not part of the upstream skill folder.
Not vendored: the rest of emilkowalski/skills (other skills, `README.md`, `performance-cheatsheet.md`, `.pl`). SKILL.md does not call files outside its folder. It links to https://easing.dev/ and https://easings.co/ as documentation; those pages are not vendored and not approved fetches.
Supply-chain surface: no executable scripts, install steps, or network calls in this skill folder.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline`. This section is written by that command.

```run-scripts
```
