## Runtime installation, provisioning and updates

`AGENTS.md` and `CLAUDE.md` are byte-identical contracts. `.agents/skills/` holds task
methods; domain SKILL frontmatter declares ownership, not runtime skills
(`.agents/domains/_domain-routing.schema.md`). `scripts/gen-domain-routing.mjs` builds
committed `docs/agent/domain-routing.generated.json`: most-specific glob wins,
platform-shell loses ties. Memoryd's routing map is a separate installed copy
(`ops/bootstrap/install-memory.mjs`).

`ops/bootstrap/install-harness.mjs` owns permissions, MCP registry, managed skill links,
hooks and orch service installation. `ops/bootstrap/permissions.json` has no Bash deny
rule; `ops/bootstrap/shell-delete-hook.mjs` refuses recursive forced deletion on Bash
and terminal tools for leads/seats, through launcher/compound unwrapping. It is wired
for Claude and checked by `scripts/check-hook-topology.mjs`. Comment/heredoc-looking
commands can deliberately over-refuse; `split` retries unparseable text with shell
comments removed (`ops/orchestrator/src/seat-guard.ts`). The deny list removes bare tool
schemas for Artifact, ListAgents, ReportFindings, ScheduleWakeup, SearchPlugins,
SuggestPluginInstall, SuggestSkills and Workflow on darwin/win32. `installPermissions`
writes only `~/.claude/settings.json`, not launchers' separate config homes. Retired
lead-hook cleanup covers Claude/GLM-lead homes, not member homes.

`ops/bootstrap/mcp-tool-baseline.json` pins tools/list names, descriptions and schemas.
`npm run check:mcp-tools` fails changes or unverifiable pinned servers. Probes use a
minimal environment, secretless streamable HTTP only, and never contact entries with
`bearer_from_secret`/`env_from_secrets`; replies cap at 1 MiB, schema nesting at 64
(`scripts/check-mcp-delivery.mjs`). Skill installation protects real directories/foreign
links. Lead runtimes receive `_skill-map.json`'s allowlist; drift checking detects support
installs by linked support skills and refuses extra canon links
(`scripts/check-skills-drift.mjs`). GLM seats/usage read orch-owned providers.json;
installer migration refuses symlink components and overwrites nothing
(`ops/orchestrator/src/providers/index.ts`, `ops/usage-snapshot.mjs`).

`ops/orchestrator/worktree-setup.json` provisions seats. Older branches lacking it use
the lead copy and record which ran. `ops/bootstrap/provision-worktree.sh` runs from the
lead checkout in seat cwd, provisioning ignored skill links/codegraph, skipping skill
links on legacy tracked `.claude/skills`, trusting only identical rtk filters and never
copying tracked hooks/scripts/routing. Seats keep their committed harness and installed
memoryctl; historical native SessionStart still runs its own script
(`ops/orchestrator/src/worktrees.ts`). Node_modules APFS clone requires matching package
lock packages (host-optional dependencies allowed); mismatch runs npm ci. Setup lines
marked `gate` use the provisioning machine's build gate; `ORCH_BUILD_SLOT` avoids a
second slot, light steps remain outside (`ops/orchestrator/src/remote-provision.ts`).

For desktop worktrees, `rtkFilterTrust` grants trust only to filters identical to the
hook checkout's already-trusted hash; mismatch/probe failure grants nothing.
SessionStart probes have `PROBE_TIMEOUT_MS` 4 s: timeout is NO ANSWER, missing/nonzero is
DEAD, both fail trust accounting (`ops/bootstrap/session-start.mjs`). Pi installation
registers direct codegraph/memoryctl tools, other servers through proxy, and rtk's Pi
hook. `installLeadRtk` runs rtk global init for Claude/Codex and embeds Codex RTK.md text
between `booharness-rtk-text` markers, refusing empty/marker-containing input without
changing AGENTS.md (`ops/bootstrap/install-harness.mjs`).

`ops/update-tools.mjs` resolves exact codegraph/rtk targets against
`ops/bootstrap/tool-pins.json`; breaking versions (minor change at major 0, major change
otherwise) are held, reported and given one memory task per version. Moving the pin
releases the hold. Resolution failure installs nothing. Codegraph changes stop only a
daemon answering as codegraph and index the main checkout, retaining
`codegraphRefreshPending` until success; absent .codegraph is reported, worktrees only
flagged stale. Win32 defers while codegraph lives, reporting the third consecutive
deferral. `--check` writes nothing. Setup scripts use the same pin; ast-grep remains
outside it. `rtkInstallTarget` writes the PATH binary's linked target, preserving links.

verified: 2026-09-23

`env_from_secrets` entries in `ops/bootstrap/mcp-servers.json` accept boolean `optional`.
`resolveSecretEnv` is shared by installer, wizard and delivery checks: missing required
returns null, missing optional omits the key, present writes it, non-boolean throws
(`ops/bootstrap/secret-bindings.mjs`). booharness's optional `WATCHDOG_API_TOKEN_DE2`
falls back to `WATCHDOG_API_TOKEN` in its stdio config (`mcp-booharness-servers/src/config.ts`).

verified: 2026-10-14
