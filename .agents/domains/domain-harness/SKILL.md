---
name: domain-harness
description: Load when editing the agent harness itself — the memory store and its scripts, RTK routing, the skills tree and its installers. Holds harness gotchas.
files:
  - .codex/**
  - .claude/agents/**
  - .claude/hooks/**
  - .claude/rtk-shims/**
  - .claude/scripts/**
  - .claude/skill-compass/**
  - .claude/settings*.json
  - scripts/memory/**
  - scripts/harness-report/**
  - scripts/lib/install-*.mjs
  - scripts/lib/harness-config.mjs
  - scripts/test-harness-*.mjs
  - scripts/check-knowledge-*.mjs
  - scripts/rtk-*.mjs
  - scripts/test-rtk-*.mjs
  - scripts/check-commit-safety.mjs
  - scripts/check-push-safety.mjs
  - scripts/gen-domain-routing.mjs
  - scripts/check-domain-routing.mjs
  - scripts/check-hook-topology.mjs
  - scripts/check-mcp-delivery.mjs
  - ops/bootstrap/**
  - ops/orchestrator/**
  - ops/memory-nas/**
  - ops/harness-kit/**
  - ops/routines/**
  - ops/claude-mods/**
  - scripts/routines.mjs
  - scripts/lib/routines.mjs
  - scripts/lib/family-logins.mjs
  - ops/*.mjs
  - scripts/*orch*.mjs
  - scripts/ste-check.mjs
  - .agents/skills/**
  - .agents/domains/**
  - RTK.md
  - docs/agent/**
  - scripts/check-installed-line-endings.mjs
  - scripts/test-lead-worktree-hook.mjs
  - CLAUDE.md
  - AGENTS.md
  - scripts/check-skills-drift.mjs
  - scripts/git-env.mjs
  - scripts/home-read-lib.mjs
  - scripts/harness-bench/**
  - scripts/corpus/**
  - ops/update-tools.mjs
  - ops/usage-snapshot.mjs
  - ops/usage-cache.mjs
  - scripts/test-orch-*.mjs
  - ops/setup-machine.sh
  - scripts/test-install-*.mjs
  - scripts/test-doctor.mjs
  - scripts/test-seat-*.mjs
  - scripts/test-jev-*.mjs
  - scripts/check-skill-map.mjs
  - scripts/test-mcp-*.mjs
  - .githooks/**
  - scripts/test-memory*.mjs
  - scripts/probe-memory-service.mjs
  - ops/ab-stand/**
  - ops/pi-runtime/**
---

# Domain: harness

The machinery the agents themselves run on. It has no product feature to point at, and
that is exactly why its lessons kept going nowhere: every `domain-*` route covered the
original repository, so `memoryctl lessons --path svod/src/adapter/mod.rs` answered "no lessons"
while four lessons about that very file sat in the store. This domain is the route.

**Entry points** (found live with `codegraph explore '<name in English>'`, or `rg` when you already know the name, and open the sources directly — do NOT cache bodies here; **"who calls X" is answered by the COMPILER: `node scripts/blast-radius.mjs <symbol> --ts` or `--rust [-p <crate>]`; dispatch by STRING stays `rg` on the literal**):
- `ops/bootstrap/permissions.json` — lead allow/deny canon. `platforms` is the OS;
  `machine` is computed at install (`ssh-host` reads this HOME's `~/.ssh/config`).
  An ssh alias, a checkout path or a disk name is a machine value and must not
  sit in the canon as a bare rule — `ungatedMachineBoundEntries` in
  `ops/bootstrap/permissions-lib.mjs` is the sensor.
- `scripts/memory/*` — the memory store, its lesson capture/promotion and the domain routing
  that decides which lessons a file gets.
- `ops/bootstrap/*` — installers. Configuration here is GENERATED into runtimes; editing an
  installed copy is lost on the next run.
- No member exemptions: every seat gets session inject and lessons; the
  code-intel order hook is wired for the lead runtimes only (`CODE_INTEL_LEADS`
  in `install-harness.mjs`: claude, glm-lead, zcode) plus codex, kimi and grok
  seats — the GLM worker home has none. Lessons are delivered to every runtime;
  the transport differs per CLI.
- Runtime hooks map: claude/glm via `~/.claude/settings.json` (installed by
  `install-harness.mjs`, which repairs stale SessionStart matchers and
  REMOVES any retired `<tool> prompt-hook` / `*-prompt-guard.mjs`
  UserPromptSubmit wiring — the 16KB-per-prompt injector was dropped
  2026-07-31 by operator decision after harness deep-research
  019fba5e-201d-7c80-bb0b-c8de004c1186); codex/kimi hook tables live in their
  `config.toml` (hand-edited — the installer reports `missing_hand_install_required`);
  grok has hooks in `~/.grok/hooks/booharness.json` (SessionStart, domain lessons,
  code-intel, RTK rewrite).
- RTK routing exists only where the runtime applies a REWRITE. `codex-rtk-hook.mjs`
  covers codex, including its desktop `exec` branch, and grok (PreToolUse Bash in
  `~/.grok/hooks/booharness.json`, written by the installer; sensor `grok/rtk-routing`).
  It does not deny — a deny cost a full extra model turn (~137K cache-read) per
  bare command (2026-07-31). The kimi WARN hook is removed (2026-08-19): kimi
  applies no `updatedInput`, so it could only comment, and the comment was
  measured at seven would-deny lines in nineteen days while one kimi seat ran 78
  shell calls against 1 rtk with the hook installed throughout. grok was retired
  with kimi on that belief; re-measured 2026-09-14, grok does apply `updatedInput`
  (task #1210). The silent-rewrite hooks (claude/codex/grok) stay. Reverting to
  deny is a contract change: `scripts/check-hook-topology.mjs` fails on
  `permissionDecision:"deny"` in either file.
- Harness cost policy (operator, 2026-07-31): no needless multi-seat rounds for small
  closures — an independent review through orch-team only for a moved tree or a new
  dimension, not for a question that is just about evidence; burn lives in marathon
  sessions, not in hooks (~1.5-5% of cache-read).

**Durable gotchas:** before editing this domain, run `memoryctl lessons --path <repo-relative-file>`
and apply the returned active lessons. If that command answers "no lessons" for a file this
domain claims, the delivery is broken - fix the route before trusting the silence.

**How to work this domain:** load lessons explicitly → find the current code with `codegraph explore` (English query) and read the sources themselves →
verify on the platform you HAVE — there is one, and the "verify on both" that stood here
until 2026-08-21 asked for a Windows machine the fleet no longer carries, which is advice
nobody can follow. What the `#![cfg(unix)]` split still costs is real and now one-sided:
a struct or fixture change compiles here while the windows-gated files are never built, so
say in your report that the other half is UNVERIFIED rather than implying it passed →
after a CONFIRMED fix,
`node scripts/memory/capture-lesson.mjs domain-harness "<title>" --anchor <file:symbol> --trigger "<when>" --rule "..." --why "..." --evidence "..."`.
