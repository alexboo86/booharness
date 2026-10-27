# playwright-best-practices

Upstream: https://github.com/currents-dev/playwright-best-practices-skill
Source: `playwright-best-practices/` at commit `283d5cbc5d11aac1abda058b16ad22c317d54dc0`, copied unmodified (SKILL.md sha256 `42684b93abd595551d6f4b6949b951645503baa445aefa76aa2f0d52ddda2bf7`). Repository `LICENSE.md` retained verbatim.
Installed 2026-09-25 by operator approval (memory decision #11988).
License: MIT (`LICENSE.md`).
Not vendored: repository docs, config and tooling outside this skill; use the runtime required by the adopted project; a browser preview is not evidence for a native app.
Supply-chain surface: upstream examples invoke `npx playwright test`, `npx playwright show-trace`, `npx playwright install --with-deps` / `install chromium`, `npm ci`, `npx prisma migrate deploy`, `npx ng build`, `npx next dev`, `npx http-server`, `npx serve`, and `npx vite preview` (package/browser/OS install, network, migration or alternate runtime). These references are documentation, not approved automatic steps. Use installed project dependencies and its documented runtime; never substitute a different runtime for acceptance.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline`. This section is written by that command.

```run-scripts
```
