## Provider session contracts and adapters

`ops/orchestrator/src/providers/types.ts` defines the session contract. Native adapters use
Claude stream JSON, Codex app-server and ACP (`ops/orchestrator/src/providers/claude.ts`,
`ops/orchestrator/src/providers/codex.ts`, `ops/orchestrator/src/providers/acp.ts`).
Claude/GLM workers build a private MCP config from enabled installed codegraph/memoryctl
entries, require the operator-only server list, pass `--strict-mcp-config` and deny those
operator names plus orch. `system/init` must confirm precisely the expected connected
servers. This isolates the MCP catalog, not shared settings, plugins, hooks, skills,
memory or filesystem (`ops/orchestrator/src/providers/claude.ts`).

Native qwen and mimo are coder-only ACP adapters; Pi remains their default harness.
`nativeCoderArgs` refuses a non-coder `SEAT_POLICY_ROLE` or non-full access on start and
resume before spawning. Credentials come from Pi: `qwenEnv` reads its token-plan key and
model baseUrl; `mimoEnv` reads the selected region key/baseUrl and overrides saved login
through `MIMOCODE_AUTH_CONTENT`. Missing credentials/model/baseUrl throws with the file,
without fallback. State lives under `<stateDir>/providers/<family>` (0700), through
`QWEN_HOME`/`QWEN_RUNTIME_DIR` or `MIMOCODE_HOME`, not operator CLI homes. MiMo usage comes
from `mimo export` with that home; qwen sums `_meta.usage` once per turn. Qwen ignores
effort; mimo maps it to a model variant (`ops/orchestrator/src/providers/index.ts`,
`ops/orchestrator/src/providers/acp.ts`). With `deferredToolInput`, a call's counted
`pending` event waits for nonempty input or turn end; an update without a string
`toolCallId` takes the default `acpToolEvent` path.

On Pi, `mimoProvider` selects the first credentialed AMS/SGP/CN region from auth.json or
its region environment key, refusing missing credentials. MiMo auth.json and GLM
providers.json failures expose only a file path and fixed error class/code, never the
original error message (`ops/orchestrator/src/providers/index.ts`). The MiMo role matrix
uses flash low for scout, pro medium for researcher and pro high for
debater/coder/reviewer/bughunter (`ops/orchestrator/src/profiles.ts`). Its credits reader
uses the operator's Chrome console Cookie and `tokenPlan/usage`, requires code 0 and
numeric used/limit, and derives the month reset from plan start. A failed/malformed read
is unknown with a reason and ranks last, never zero; cookie/body are never echoed
(`ops/usage-snapshot.mjs`, `ops/chrome-cookies.mjs`).

Worker Pi uses JSONL RPC, `agent_settled` as the turn boundary and session-file resume.
It selects provider/model, strips parent agent credentials/session environment and
restricts read-only tools (`ops/orchestrator/src/providers/pi.ts`,
`ops/orchestrator/src/providers/spawn.ts`). `ops/orchestrator/src/pi-extension.ts` records
the executed shell command and applies `ops/orchestrator/src/seat-guard.ts`:

- `refuseOrchRead` allows read-only `node` only for the cwd's own orch `main.ts` or the
  loaded guard's sibling `main.ts` (`ORCH_LOADED_SCRIPT`), lexically, with no `..`,
  relative script after `cd`, node flag, env prefix or launcher. Arguments are exactly
  `status`, `pick-stats [--json]` or `wait <turn> [--json]`; other forms refuse.
- Local read-only context names the loaded path, quoted by `quoteShellPath`; remote
  context names no wait command (`ops/orchestrator/src/context.ts`).
- `refuseSkillInstall` applies to every role. Only skills CLI read verbs pass.
  `invocations` sees through launchers; substitutions are not parsed. Native Claude
  uses `--disallowedTools` for known mutating verbs.
- `refuseStash` applies to Pi coder/reviewer/bughunter bash: only `stash list` and
  `stash show` pass, including git global options, rtk runners and `.exe` launchers.
  Native Claude/GLM seats use `ops/bootstrap/seat-stash-hook.mjs`: leads are exempt;
  guard/import/stdin failures deny stash-naming text after quote/backslash removal.
  Its entry guard compares real paths. `ops/bootstrap/install-harness.mjs` wires it
  for Claude; `scripts/check-hook-topology.mjs` checks wiring and live probes.

Stash enforcement does not cover codex seats, codex desktop exec or native ACP seats;
aliases/substitutions hide it. Prompt-level bans are not credential isolation
(`ops/orchestrator/src/context.ts`).

verified: 2026-09-23

