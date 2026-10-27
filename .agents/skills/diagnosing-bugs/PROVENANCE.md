# diagnosing-bugs

Upstream: https://github.com/mattpocock/skills
Source: `skills/engineering/diagnosing-bugs/` at commit `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`, copied unmodified (SKILL.md sha256 `77f3cf31bc99b2f49af943222526531fcc9fc41d047626d3640e875e85af3e84`). Repository `LICENSE` retained verbatim.
Installed 2026-09-25 by operator approval (memory decision #11988).
Local edit: the first paragraph and the last sentence of "Phase 5: Fix + prove" state this project's test rule (commit 54ce05180, revised by operator decision #14235); every other line is upstream, so the sha256 above is the upstream file's, not this tree's.
License: MIT (`LICENSE`).
Not vendored: other skills, repository docs and tooling outside this skill, and `docs/engineering/diagnosing-bugs.md`.
Supply-chain surface: bundled `scripts/hitl-loop.template.sh` (human-in-the-loop shell script); the skill also proposes executing reproduction commands/curl. Inspect and approve before running any script or network command; no automatic installation.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline` (`scripts/check-skill-contract.mjs` not in this kit). This section is written by that command.

```run-scripts
scripts/hitl-loop.template.sh sha256:35103539fc36873eea36074769ad454f9379d6fc8b2dc0e26ce987fd3bfe5503
```
