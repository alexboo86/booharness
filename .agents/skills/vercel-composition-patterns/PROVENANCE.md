# vercel-composition-patterns

Upstream: https://github.com/vercel-labs/agent-skills
Source: `skills/composition-patterns/` at commit `063bee94c3f4df8453406c830b0a7df0f2860278`, copied unmodified (SKILL.md sha256 `e38e0eaa609316b10423a9a138ed95e35099accd3f735585295c8a8f165c28a3`).
Installed 2026-09-25 by operator approval (memory decision #11988).
License: MIT, per upstream `README.md` License section and SKILL.md frontmatter. Upstream has no license file: local `LICENSE` records the standard MIT text with Vercel, Inc. attribution; it is not represented as an upstream file.
Not vendored: other skills, repository tooling, root AGENTS.md and packages. React patterns are for applicable component architecture only; the adopted project's declared module boundaries and runtime still govern.
Supply-chain surface: no executable scripts or install/network steps in this skill; `AGENTS.md` is upstream instructional content, not the project contract.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline`. This section is written by that command.

```run-scripts
```
