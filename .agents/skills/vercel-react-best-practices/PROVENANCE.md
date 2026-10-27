# vercel-react-best-practices

Upstream: https://github.com/vercel-labs/agent-skills
Source: `skills/react-best-practices/` (the upstream folder name; the skill's `name` frontmatter is `vercel-react-best-practices`) at commit `063bee94c3f4df8453406c830b0a7df0f2860278`, copied unmodified (SKILL.md sha256 `71ed7794962fa6e803ee83030517b5b93a9f70fbfeb431ec4535c5480a8d8355`).
Installed 2026-10-22 by operator approval (memory decision #19444).
License: MIT, per upstream `README.md` License section and SKILL.md frontmatter. Upstream has no license file: local `LICENSE` records the standard MIT text with Vercel, Inc. attribution; it is not represented as an upstream file.
Not vendored: the other skills of the pack, the upstream `src/` build scripts, `test-cases.json` and repository tooling; `AGENTS.md` here is upstream's compiled rule output, not the project contract. React/Next.js patterns are for applicable component architecture only; project `public.ts` boundaries and the Tauri runtime still govern.
Supply-chain surface: no executable scripts or install/network steps in this skill folder. The upstream README's `pnpm install`/build steps belong to upstream tooling that is not vendored and is never run here.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline`. This section is written by that command.

```run-scripts
```
