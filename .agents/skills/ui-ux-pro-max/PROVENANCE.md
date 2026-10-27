# ui-ux-pro-max

Upstream: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
Source: `.claude/skills/ui-ux-pro-max/` at commit `623a9a9037d006ea727f8213f084d02a6b6f11b5`, copied unmodified (SKILL.md sha256 `ea087c341bfb5b23195c7302027268ede86da802554c18a5c4896a6017b439f9`).
Installed 2026-10-22 by operator approval (memory decision #19474).
License: MIT, per upstream `LICENSE` at the repository root (Copyright (c) 2024 Next Level Builder). Local `LICENSE` records that text verbatim; it is not part of the upstream skill folder.
Not vendored: the rest of nextlevelbuilder/ui-ux-pro-max-skill (other `.claude/skills/*`, `cli/`, `src/`, `docs/`, `gallery/`, `preview/`, `projects/`, `screenshots/`, `stack/`, and repo-root `scripts/`). SKILL.md calls only files inside this folder (`references/quick-reference.md`, `references/pro-rules.md`, `scripts/search.py` and the `data/` that script reads). It addresses the search script as `${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/scripts/search.py`, the upstream plugin layout, not `.agents/skills/ui-ux-pro-max/scripts/search.py`. Here run it as `python3 .agents/skills/ui-ux-pro-max/scripts/search.py` from the repository root; this local errata outranks every `${CLAUDE_PLUGIN_ROOT}` command line of the vendored SKILL.md. In-folder tests walk parents looking for repo-root `scripts/refresh-google-fonts.py` and `scripts/refresh-icon-catalog.py`; those files are not copied. `scripts/refresh-google-fonts.py` reaches the network (`urllib.request.urlopen`).
In an adopted project, the skill's mobile-sized defaults (44×44px touch targets, mobile-first breakpoints, 16px base type, px density scales) lose to that project's design rules.
Supply-chain surface: Python only. None of the vendored scripts open a network connection (stdlib; `validate_data.py` uses `urllib.parse` only). `scripts/search.py` is the entry SKILL.md tells an agent to run; it imports `scripts/core.py`, `scripts/design_system.py` and `scripts/reasoning_contract.py` and reads local `data/`. `scripts/design_system.py` can write `design-system/` under a caller-supplied `--output-dir` when `--persist` is passed (filesystem, not network). These scripts are not approved automatic steps.

Runtime scripts, each `#!/usr/bin/env python3`, no network:

- `scripts/core.py`
- `scripts/design_system.py`
- `scripts/reasoning_contract.py`
- `scripts/search.py`
- `scripts/validate_data.py`

Tests, Python, no network of their own (subprocess of local Python only). `scripts/tests/test_skill_script_paths.py` has no shebang; the other twelve start with `#!/usr/bin/env python3`. `scripts/tests/test_catalog_refresh.py` would execute the unvendored repo-root refresh scripts if a parent directory contained them. Two tests import unvendored ancestor scripts in-process (`importlib` `exec_module`): `test_catalog_summary_line_endings.py` loads the first parent's `scripts/generate-catalog-summary.py`, `test_relevance_evaluator.py` the first parent's `scripts/evaluate-relevance.py`; neither file exists in this repository, so both tests fail to load here and must not be run:

- `scripts/tests/test_catalog_refresh.py`
- `scripts/tests/test_catalog_summary_line_endings.py`
- `scripts/tests/test_core.py`
- `scripts/tests/test_core_data_quality.py`
- `scripts/tests/test_data_contracts.py`
- `scripts/tests/test_design_system_mode.py`
- `scripts/tests/test_design_system_stack.py`
- `scripts/tests/test_native_desktop_stack_freshness.py`
- `scripts/tests/test_relevance_evaluator.py`
- `scripts/tests/test_skill_script_paths.py`
- `scripts/tests/test_style_taxonomy.py`
- `scripts/tests/test_text_layout_resilience.py`
- `scripts/tests/test_web_stack_freshness.py`

## Run scripts

Every shipped file of this skill that can run (exec bit, `#!` line or script extension), plus any shipped file its markdown runs, pinned by sha256. `npm run check:skill-contract` fails when one changes, appears or disappears; re-read the script, then re-pin with `node scripts/check-skill-contract.mjs --write-run-script-baseline` (`scripts/check-skill-contract.mjs` not in this kit). This section is written by that command.

```run-scripts
scripts/core.py sha256:c3be4b23e7150e6b45095213158cfa3c8ad96502f01dde3f6ffff9de64a4f481
scripts/design_system.py sha256:e7d1c94c4b2eada17c5551157668362659ccf9626d34dbd58e68142410f90103
scripts/reasoning_contract.py sha256:b8bac1af82aa280d3e06f00aabaeac4337e632996b07fed874e2b6ee6e9c5913
scripts/search.py sha256:d54e648fe0ec2932cac66684220cc17be4bd4b4eba1d23d3195d509d398db374
scripts/tests/test_catalog_refresh.py sha256:3e2ca5d12702318f641ae62d0c14f22a3bcc84d84e79b863c0e947d475604adb
scripts/tests/test_catalog_summary_line_endings.py sha256:fa6ff09f0ec2c99013588c77397f5082dddebe8f467e94c5f8378ec9595f4989
scripts/tests/test_core_data_quality.py sha256:3ffc6b4905c9ea26d7ac4527ab154d153584231aee71b2ae4bd017977fa09cc5
scripts/tests/test_core.py sha256:3527fe2f4b852f69f07c17ddc0d615d9a6e025c924e45a33985579a94a8d2118
scripts/tests/test_data_contracts.py sha256:0360d6e10080c0bca214f2b0bbad582ba50702a542ce21013351aca54938df3a
scripts/tests/test_design_system_mode.py sha256:95ad2c154349f7021f55a558f8dcdd71df1a24fcf531a4364a8e49526a0865ef
scripts/tests/test_design_system_stack.py sha256:83d09ffe8cfbf7b265f362129f061dfe8e5e167ce5db43adaead197cabc9ca38
scripts/tests/test_native_desktop_stack_freshness.py sha256:3942845712b9a829323cd3568511483135f2a8c7cd79ccf61679da4b0f624dbb
scripts/tests/test_relevance_evaluator.py sha256:2fe56a4d6fe5fff15ff592274b0eeaba925146cefea6c0fa29d8f1b77c9aca1f
scripts/tests/test_skill_script_paths.py sha256:7cec24b94be771bc60bc84f8993e614bb16d4047930e1dd3d3bed91628311d44
scripts/tests/test_style_taxonomy.py sha256:cd14d0092e8a454d213aa104b53e4e70ba698491fa00fde9fdec5ca8a3d70011
scripts/tests/test_text_layout_resilience.py sha256:b51d32ee8a15505b87cb81957fb2d1b385e041e8beb4463c311d236bfd29ebd4
scripts/tests/test_web_stack_freshness.py sha256:74897571398585f27e2c35d09d81b0a531c8c774f4a2967e5e1b1d1b05a483d9
scripts/validate_data.py sha256:a599aa256049cf30954d1f164721b99e453eb7e4cb8241bcab2d5573e6cf58b8
```
