# i-have-adhd

Upstream: https://github.com/ayghri/i-have-adhd
Source: `skills/i-have-adhd/SKILL.md` and the repository `LICENSE` at commit `839872f9d1cd634fed642b4589ce7226199cc15f`, unmodified (SKILL.md sha256 `3170b16ace00aecb0dd7feb54c0b5aa642e7502acda06ecd24fd89a11c7127e9`).
Installed with the operator's explicit approval (memory decision #13207) for lead-only, always-on replies to the operator in Claude desktop lead and Codex GUI lead sessions. Seats do not receive it: their reader is the lead and their output is the JSON report.
License: MIT (LICENSE, retained).
The existing session-start hook delivers the body without YAML frontmatter because `disable-model-invocation: true` prevents automatic invocation. The project contract outranks these output-style rules. Only SKILL.md and LICENSE were reviewed; upstream hooks, extensions and plugin manifests are not approved or vendored.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline`. This section is written by that command.

```run-scripts
```
