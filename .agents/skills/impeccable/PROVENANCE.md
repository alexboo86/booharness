# Impeccable

Upstream: https://github.com/pbakaus/impeccable
Source: `.agents/skills/impeccable` at commit `508d7e8955de3b3caf2d8676e85206723d41a887` (2026-10-02), skill version 4.5.0.
Installed 2026-09-08 with the operator's explicit approval for the booharness web design work; updated 2026-10-04 from 4.2.2 (`2bc2879276c1f321a53c4ca99d3371e411329b52`) per operator decision #14184.
License: Apache-2.0 (upstream LICENSE).
Installed through skill-installer into the canonical source tree; executable permission restored on scripts/impeccable after archive extraction. Native engine is fetched and checksum-verified by the upstream launcher. No global edit hooks installed.

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline` (`scripts/check-skill-contract.mjs` not in this kit). This section is written by that command.

```run-scripts
scripts/impeccable sha256:39d9600489073e227e4f4d55c451ce4252a6632ed7ae37923efbbcbc91f16d07
scripts/impeccable.cmd sha256:69cad1ae7355825ef320ac9638a1c9675ba9fda01c9a0fa12244cc4a1973e550
scripts/live-browser-dom.js sha256:de1b7404f4cdfd7b515196afb17b74b1980f0bc88cb8681ae93a76ca48ec7bdb
scripts/live-browser-ignores.js sha256:c1cb6877ca99a0c1b38ba0c7d59f32702d3022f6821d8045f7133f7c40b6362f
scripts/live-browser-session.js sha256:42831c3cd874346d8e7f120808d91e6ed3cda5c3eca6eefd76b126659536bc87
scripts/live-browser.js sha256:f68a3d68ac92606e91aa8878e003d9432ddd09aa97ca01c6b3ce46c937dca316
scripts/modern-screenshot.umd.js sha256:bb36665889124a0b6e15f16045265737449c3bdcf2712cdb08af3cfa01563e2b
```
