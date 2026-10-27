# find-skills

Upstream: https://github.com/vercel-labs/skills
Source: `skills/find-skills/SKILL.md` and the repository `LICENSE` at commit `7407f3893ad4dceab546ac002c3ef806e4000c73`, unmodified (SKILL.md sha256 `c00eeea0e13e74fe4a9d84ba0a8542205a1b736d65f13134fe1a6647eb14976f`).
Installed 2026-09-25 with the operator's explicit approval (memory decision #11984) for the lead: searching the open skills ecosystem for catalogue candidates.
License: MIT (LICENSE, retained).
Search runs through the pinned CLI `npx -y skills@1.7.0 find <query>`. In this tree `npx skills add` (including the upstream `-g -y` step) is never run by an agent: a candidate enters the catalogue only by operator approval, vendored with its own PROVENANCE.md (docs/agent/harness-allowlist.md).

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline`. This section is written by that command.

```run-scripts
```
