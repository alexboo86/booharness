## Providers, roles and worktrees

Families with a Pi route default to Pi except claude, whose workers default to native
Claude Code. `harness: 'pi'` selects Pi's `anthropic` provider with its stored Claude Max
OAuth; `harness: 'native'` selects the family's CLI
(`ops/orchestrator/src/providers/index.ts`). Native Claude/GLM emit live usage per
assistant message (`ops/orchestrator/src/providers/claude.ts`). `claudeTranscriptPath`
returns the existing `~/.claude/projects/<cwd slug>/<sessionId>.jsonl`, with non-alphanumeric,
non-hyphen cwd characters replaced by `-` (`ops/orchestrator/src/seats-defs.ts`).

Pi launches from the exact-version install and lockfile in `ops/pi-runtime/package.json`,
not PATH. `open` uses the daemon checkout locally and `host.repo` remotely;
`piRuntimeLayout` selects the absolute bin (`pi.cmd` on win32). `assertPiRuntime` checks
that it exists and its installed version string equals the pin; the remote probe is
bounded. Failure names the machine and `npm ci --prefix ops/pi-runtime`. Runtime sync
is git-only and the installer's orchestrator step is marker-gated
(`ops/orchestrator/src/providers/pi.ts`). Stand scripts use the same install through
`requirePiRuntime`, which refuses a missing/mismatched runtime before creation
(`ops/ab-stand/pi-runtime.mjs`, `ops/ab-stand/install.mjs`).

`piArgs` passes `--no-approve`, `--no-skills` and `--no-context-files`: checkout resources
remain untrusted. Explicit extensions/config and agent-directory packages are outside
the project-trust gate (`ops/orchestrator/src/providers/pi.ts`). Local and isolated stand
seats explicitly select `~/.pi/agent/mcp-adapter.json`; remote seats select `.mcp.json`.
Exclusive mode does not read legacy `mcp.json`; `settings.scriptMode:true` retains
`mcpScript`. Missing local config or an installed adapter differing from the committed
stand lock pin fails startup. Explicit selection avoids the adapter's builtin MCP
user-settings write. The installer carries legacy entries under keep/preserve/ownership
rules, prefers existing adapter entries on collision, never writes the legacy file and
refuses source/target symlink aliases (`ops/bootstrap/install-harness.mjs`).

`seat_create` validates and stores the effective boolean instrument map for codegraph,
ast-grep and memory. Pi refuses disabled direct tools, addressed MCP calls and CLI bash
commands; native Claude/Codex lose the MCP server only, with a context-only shell ban
(`ops/orchestrator/src/instruments.ts`). Context removes stock mentions and adds an
instrument-off retraction. `codeIntelRules` copies the contract's Code intel, Blast radius
and RTK lines whole, throwing if a line is missing. `seatContract` gives non-native seats
a drift-checked CLAUDE.md slice; native Claude/GLM load the whole contract and receive no
slice (`ops/orchestrator/src/context.ts`). Stand `--arm` maps to an instrument override
and refuses an uninstalled tool; RTK is always on, never an arm (`ops/ab-stand/arms.mjs`).

verified: 2026-09-23

