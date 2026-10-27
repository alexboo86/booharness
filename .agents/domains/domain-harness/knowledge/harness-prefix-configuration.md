## Harness prefix configuration

`names.prefix` defaults to `booharness`, matches `^[a-z][a-z0-9-]*$`, max 32 characters. `harnessPaths` in `scripts/lib/harness-config.mjs` builds `~/.cache/<prefix>`, `~/.local/state/<prefix>`, `~/.local/share/<prefix>`, `~/.claude/<prefix>-secrets.env`; `harnessLabel` gives `com.<prefix>.<name>`. All schema keys are required; no literal fallback.

Consumers and failure behavior:
- `ops/bootstrap/lesson-router.mjs`: cache, silent fail-open hook. `ops/bootstrap/install-harness.mjs`: `canonical-path`, failed read names file/stops before writes. Daemon uses its own checkout's reader/config; `lessonSection` in `ops/orchestrator/src/context.ts` emits `lessons: unavailable (<reason>)`, code `lesson-router-unavailable`, not turn failure. Skill cache (`ops/bootstrap/skill-router.mjs`) yields `skills: unavailable` with reason.
- `cacheFile` in `ops/usage-cache.mjs` is shared by CLI snapshots, detached hook refresh and `Limits`. `readCache`/`writeCache` take `onUnavailable`: hooks stay silent; `Limits` keeps the warning. Config failure does not stop live usage or turn it into 0%; an absent snapshot means no reading yet.
- Secrets readers defer to first use. `installMcp` reads config only without `--secrets-file`; `readApiKey` in `ops/bootstrap/jev-client.mjs` treats failure as absent file, letting environment decide. `scripts/check-mcp-delivery.mjs` emits FAIL, secret-gated servers unjudged. `tools/anthropic-usage` needs config only without `ANTHROPIC_ADMIN_KEY`, never for help. No secrets migration; key writer: `harness-secret set`.
- `ops/bootstrap/install-memory.mjs` uses the share directory and labels for services, forward/backup units, retirement and worker-plist inventory. Environment overrides win; the state directory retains `memoryctl`. Default plist bytes are pinned by `scripts/test-install-memory-prefix.mjs`. Only current-prefix units are retired; old-prefix units remain loaded.

The memory installer writes `<state dir>/launchd.label` and `task.name`, mode 0600, through `writePrivateFile` using a temporary file and rename. `--check` reports wider modes. The label is a managed target on each host, not on `--landed-map`; the task-name row exists on each platform. `.claude/scripts/memoryctl` validates these files before service revival, uses `MEMORYCTL_LAUNCHD_LABEL` when set, and names `npm run install:memory` when the label file is absent. `harnessTaskName` capitalizes the prefix's first letter and adds `Memoryctl` (`booharnessMemoryctl` by default); installer, cutover and transfer scripts use it.

Other readers: `scripts/check-installed-line-endings.mjs`, `scripts/memory/cutover-macos.mjs`, `scripts/probe-memory-service.mjs`, `ops/bootstrap/verify-memory-transfer.mjs`; config failure fails/refuses, no literal name. `ops/update-tools.mjs` reads at module load for `com.<prefix>.update-tools`/`<prefix>-update-tools`; scheduled job runs the main checkout's file. `scripts/harness-report/collect-memory.mjs` uses the configured installed store; config failure is a fail row.

`ops/bootstrap/install-git-hooks.mjs` and `dormantHooks` in `scripts/audit-rule-sensors.mjs` own only hooks bearing `# <prefix>-githook-shim:`. The tracked `ops/bootstrap/githook-shim.sh` template keeps the default; installed copies use the configured marker. Other-prefix hooks are foreign, refused and kept. `scripts/check-hook-topology.mjs` reads grok's `hooks/<prefix>.json`.

`ops/orchestrator/install.mjs` builds `com.<prefix>.orch`, `<prefix>-orch` and its Description. `installOrchestrator`, `renderPlist` and `renderTaskXml` take optional `prefix`; otherwise they read their own checkout's config at first use, not import. State stays `~/.local/state/orch`. `scripts/test-orch-install.mjs` pins default plist/XML bytes; a changed plist triggers bootout/bootstrap. Old-prefix agents are not retired.

Harness installer markers are `<prefix>-bootstrap`, `<prefix>-rtk-text`, `<prefix>-harness-path`, `<prefix>-codex-trust`; grok uses `hooks/<prefix>.json`. Each consuming step validates before its first write, not in `main()`. Changing prefix appends new blocks and leaves old blocks/files and foreign marker interiors intact. Defaults are pinned in `scripts/fixtures/harness-prefix-golden.json`. The kimi header `# --- booharness session hooks` is a fixed comment, not a marker.

`Read-HarnessPrefix` in `ops/bootstrap/windows-bringup.ps1` validates adjacent config before each stage; bad/missing config stops with path. Secrets lists/shim markers use it; `Install-HarnessHookShims` refuses foreign hooks, keeps equal shims. `scripts/test-windows-bringup-prefix.mjs` requires PowerShell.

MCP `install_hint` entries in `ops/bootstrap/mcp-servers.json` and `ops/bootstrap/mcp-servers.operator.json` use `<prefix>`. `installMcp` skip reasons name the actual secrets path, including explicit `--secrets-file`, abbreviating home paths with `~` and preserving literal `$&`. `ops/setup-machine.sh` validates prefix at runtime for its checklist; `scripts/test-harness-secrets-path.mjs` pins that rule.

verified: 2026-09-23

