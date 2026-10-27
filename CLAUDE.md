# Agent contract

Harness-home contract, shipped by the harness kit. orch slices this file into the first
message of every Pi seat (`ops/orchestrator/src/context.ts`: `seatContract`, `codeIntelRules`)
and fails the seat when an anchor is gone. Keep every `## ` heading below, the item numbers of
PRIME and Work contract, the `check:commit` line of Tree and checks, the three routing bullets
`Code intel`, `Blast radius`, `RTK is mandatory`, and the seven bullet labels of Product and
harness sensors. Change their text freely, never their shape.
Agent instructions, briefs and reports are English; operator replies are Russian.
Keep briefs within 300 words and reports within 200 by default. Include necessary evidence
and failure reproductions; omit repeated instructions and narrated work.

## PRIME — hard invariants

1. **Runtime:** each project names its own valid runtime in its README or contract; never assume another one.
2. **Dev:** use the project's own dev command; no release build without the operator's word.
3. **Typecheck:** run the project's own typecheck or compile check; a command the project does not define is not proof.
4. **Stack:** read the project's manifest files before designing; do not introduce a second stack.
5. **Data integrity is inviolable:** never fabricate or lose data.
6. **No fallbacks, MVPs or placeholder zeros.** Fix the root cause.
7. **Publish, deploy and commit require operator approval.** Commits require explicit pathspecs. No `git add -A/./-u`, bare commit or `amend` without separate approval.
8. **Use the default branch by default;** worktrees are for parallel editing.
9. **UI:** follow the project's design system where one exists; no hardcoded colours or sizes where the project has tokens.
10. **Reply to the operator in Russian.**
    Lead sessions apply [`i-have-adhd`](.agents/skills/i-have-adhd/SKILL.md) to operator replies; this contract outranks it; seats do not receive it.
11. **Memory before git:** use `memoryctl search` for prior work/decisions; git log supplies SHAs/diffs.

`AGENTS.md` and `CLAUDE.md` must be byte-identical. Apply [edit-contract-mirror](.agents/skills/edit-contract-mirror/SKILL.md) to contract changes.

## Harness

- **This repository is the harness home.** The orch daemon, the memory service files, the hooks and every installed link point into this checkout. Do not move or delete it; after moving it re-run `node ops/bootstrap/install-harness.mjs --no-require-providers` and `node ops/orchestrator/install.mjs`.
- **orch** is orchestration: the local daemon at `127.0.0.1:7760` (MCP `orch`, board at `http://127.0.0.1:7760/`). A lead loads [`orch-team`](.agents/skills/orch-team/SKILL.md), picks the role and leaves the family to orch: the role matrix ([profiles.ts](ops/orchestrator/src/profiles.ts)) picks the family with the most headroom against a linear pace through its budget window. Families that are not installed on this machine stay paused: `node ops/orchestrator/src/main.ts pause <family> --reason "<why>"`, `unpause <family>`, `paused`. [orch README](ops/orchestrator/README.md).
- **No quorum.** Independent review finds reproduced defects; the lead adjudicates evidence. Neither author nor lead family reviews its own change, with one exception: claude may review a change another family authored, even under a claude lead. Review depth: one reviewer, two on a security path or when orch's `review_plan` raises it. Reports need claim/evidence or explicit no findings. Recreate an empty-returning seat once.
- **Skills:** a lead sees only the lead set in `.agents/domains/_skill-map.json`; seats get their role's skills from `.agents/skills` through orch. Load by trigger.
- **One memory:** `memoryd` on this machine at `http://127.0.0.1:7717` (LaunchAgent `local.harness.memoryd`, database `~/.local/state/memoryctl/memory.db`, embedder Ollama `qwen3-embedding:0.6b` at `127.0.0.1:11434`). No `service.url`: with that file absent every client defaults to the loopback URL. One daemon, one database, no second writer. Verify: `node ops/memory-local/install.mjs --check`, `curl -s http://127.0.0.1:7717/health`.
- **Git hooks:** the installer wires `.githooks` (deletion-reference and push-safety guards) for THIS repository only. Project repositories keep their own hooks.

## Work contract

1. Understand cause and agree on a plan before a non-trivial fix. Keep scope; ask one precise question if intent is unclear. Name subsystem constraints and failure modes before designing unfamiliar work.
2. Tests are allowed: write them and run them. A new or changed test passes the [`test-audit`](.agents/skills/test-audit/SKILL.md) authoring gate. Run the narrowest test that covers the change: a whole suite does not prove a one-file change. Prove a fix with logs, tests or data. A blocker requires reproduction. Hypothetical risk is a note; report a prevented check verbatim as unverified.
3. Prefer the smallest working mechanism. Deferred simplification requires `// debt: <reason>` plus a `memoryctl task`.
4. Report result, proof, next step and required operator action. Check memory for conflicting decisions and ask which stands. Do not treat a new question as cancellation of authorized work.
5. The lead sends a change to independent review and spot-checks the evidence; a worker seat never commissions review of its own work. Reviewer format: claim · evidence(file:line|command|URL) · confidence · checked · not-checked; APPROVE/REQUEST_CHANGES.
6. Before deleting a tracked path, search the whole tree for references and prove the project still builds.
7. Before a commit: `git add -- <paths>`, inspect status/diff, obtain confirmation, then `git commit -m "..." -- <paths>`.

## Before adding code

Read the affected flow. Stop at the first sufficient rung: unnecessary → existing
code → standard library → native platform → installed dependency → one line →
minimum new mechanism. Never cut trust-boundary validation, integrity, loss
prevention or security. [The ladder](docs/agent/the-ladder.md).

## Tree and checks

- `ops/bootstrap/`: harness installation, hooks, MCP registry; `ops/orchestrator/`: orch; `ops/pi-runtime/`: the pinned Pi that worker seats launch; `ops/memory-local/`: the local memoryd service.
- `scripts/memory/`: memory service and tools; `.agents/skills/`: methods; `.agents/domains/`: routing and knowledge pages; `docs/agent/`: references below.
- Project code lives in its own repositories: the lead opens the project, orch seats receive it as `repo`.

Use the narrowest relevant check; interrupted or timed-out means unverified:

```bash
node --check <file>
npm run check:commit -- <explicit paths>
```

## Session and tool routing

- Start: read `USER.md` if present, the handoff the operator names (`memoryctl get <id>`), relevant memory search.
- **Code intel** → known literal: `rg`/`rtk grep`. Who calls X, what depends on a file, an unnamed question: `codegraph` (MCP tool codegraph_explore; CLI verbs callers, callees, impact, node, explore). Shape — every impl of a trait, every call of form X: bounded `ast-grep`; exhaustive AST queries use `--no-ignore hidden --no-ignore parent`. codegraph returned nothing: query it again by the file or symbol name; then a literal goes to `rg`, a shape to `ast-grep`. When or by whom a string appeared or vanished: bounded `git log -S'<text>' -- <path>` (`-G` for a regex). codegraph stays fresh through a file watcher, but a new worktree needs `codegraph init` before its answers are about THAT branch. Measured: it does NOT replace ast-grep for an exhaustive shape query nor `rg` on a literal ([measurement](docs/agent/resident-rules-why.md)).
- **Blast radius** → compiler: `node scripts/blast-radius.mjs <symbol> --ts` or `--rust [-p <crate>]`. Close string dispatch (Tauri/serde/ClickHouse/MCP) with `rg`; compiler references cannot see it.
- **Domain knowledge** → read `.agents/domains/domain-<name>/knowledge.md` — the map of what exists, how it is wired and what it stores — BEFORE forming a hypothesis about a subsystem or briefing a seat on it. Lessons are scars, the page is the map. Catalogue and rules: [domain-routing schema](.agents/domains/_domain-routing.schema.md).
- **Domain lessons** → `memoryctl lessons --path <repo-file>` before editing. orch delivers lessons for a seat's `files`; name them in the brief.
- **Memory:** `search` (locate) → `get <id>` (whole); `append` for durable facts and `handoff` at chunk end. Memory never commits, pushes, deploys or starts agents. Loose ends: `memoryctl task create --title <t> --priority P0|P1 --next <step>`, closed with evidence. [Memory contract](docs/agent/memory.md).
- **Mandatory skills by trigger:** enumerate-cases/design, plan-before-code/edit, investigate-first/bug, surgical-patch/fix, verify-and-stop/completion, premortem/irreversible action. Use only available skills; unrelated skills are optional.
- **Economy:** batch independent checks; extract a symbol with `codegraph node <symbol>`; avoid whole-file sweeps. Read a seat's report once; no transcript reading.
- **Delegate:** sweeps across 3+ files/logs/memory to an orch scout, edits to an orch coder ([orch-team](.agents/skills/orch-team/SKILL.md)). Known files can be read directly. Scouts run only as orch seats (`seat_create` role scout).
- **Wait:** finish notifications, no polling/sleep loops; shell jobs run in background.
- **RTK is mandatory** for heavy shell: `rtk <cmd>`. `rtk proxy` filters nothing (0% saving); for exact bytes run the command bare and bound it. Warn-only and logged; do not retry a denied form. [Filter catalogue](docs/agent/environment.md).

## Product and harness sensors

- ChartPane/subcharts: not part of this harness home; a project that has such a component states its own rule in its own contract.
- **Modules:** Feature/shell imports cross a module's public entry file only; never reach into another module's internals.
- Indicator subscription SSOT: not part of this harness home; one registry per subscription kind where a project has them.
- Files ≥1500 lines: extraction seam first.
- Docs: keep links valid; a new document is linked from an index.
- `web/` legal copy: not part of this harness home; legal text changes only with the operator's word.
- MCP/plugins/skills must come from [harness-allowlist](docs/agent/harness-allowlist.md).

## Reference map

| Read | For |
|---|---|
| [INSTALL.md](INSTALL.md) | how this machine was installed, how to add a family, how to repair |
| [environment](docs/agent/environment.md) | RTK filter catalogue (the machine notes there describe the donor machine) |
| [memory](docs/agent/memory.md) | tasks, lessons, registry, CAS |
| [codex](docs/agent/codex.md), [grok](docs/agent/grok.md) | runtime configuration and quotas |
| [resident-rules-why](docs/agent/resident-rules-why.md) | rule evidence and measurements |
| [orch-team](.agents/skills/orch-team/SKILL.md) | delegation, research, review |
| [orch README](ops/orchestrator/README.md) | daemon, seats, roles, limits |
| [harness knowledge page](.agents/domains/domain-harness/knowledge.md) | the map of the whole harness |
