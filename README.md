<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="img/banner-light.svg">
  <img alt="BooHarness — local orchestration for coding agents" src="img/banner-light.svg">
</picture>

# BooHarness

[Русский](README.ru.md) · [Installation guide](INSTALL.md) · [Install prompt](INSTALL-PROMPT.md) · [Licence](LICENSE)

BooHarness coordinates coding agents from several model families in a local development environment. A lead session plans work, briefs worker **seats**, reads their reports and commits accepted changes. The harness supplies orchestration, isolated working copies, review rules, durable memory and a board showing work in progress.

In the authors' setup, **Claude is the team lead, running in the Claude Code desktop app**. Other families work as seats under orch. Claude Code is also available as a worker family. Most seats run in Pi through their family's subscription route; Claude seats use native Claude Code.

**Checked on macOS only. Windows has not been tested; whether the complete installation and workflow work there is unknown.**

![orch board: worker seats](img/web-seats.png)

## Purpose and audience

BooHarness is for repository maintainers coordinating research, implementation and review across model subscriptions. It separates the lead's decisions from seat execution: a scout maps a flow, a coder changes it, a reviewer checks the result, and the lead decides what lands.

The harness home holds the tools and shared methods; adopted repositories hold the project work. Adoption links lead skills and builds a code index without changing tracked project files. Project-specific runtime rules, checks and knowledge pages still need configuration: BooHarness does not infer a project's engineering contract from its source tree.

## Quick start

The recommended installation session is the **Claude Code desktop app with local terminal access**. The agent handles commands and opens sign-in windows; the owner approves installation changes and completes logins. The install prompt is:

```text
Clone https://github.com/alexboo86/booharness.git into ~/Developer/harness if it is absent. Read INSTALL.md there in full and install BooHarness by its instructions.
```

![Installation flow](img/install-flow.svg)

[INSTALL-PROMPT.md](INSTALL-PROMPT.md) defines the interview and installation sequence. [INSTALL.md](INSTALL.md) contains the commands and verification blocks. An existing harness directory is checked, not overwritten. On a clean Mac, Xcode Command Line Tools must be installed and Git verified before cloning.

Installation selects families, proves logins, configures memory and optional services, installs runtime integrations and checks service health. Subscription smoke tests spend requests and require consent. Keys are entered in the helper's local window, never in the agent chat. `npm run doctor` checks the installed parts without changing them.

## How it works

![From brief to accepted change](img/how-it-works.svg)

1. **Adopt a repository.** `node ops/kit/adopt-project.mjs /abs/path/to/project` links lead skills and builds its codegraph index. The project's instructions and verification commands are adapted after the harness installation works.
2. **Write a bounded brief.** The lead chooses a role, names the repository and files, and states the expected result. A scout can first resolve an unknown flow; a coder receives an agreed implementation task.
3. **Choose a family.** Without an explicit family, orch picks from the role matrix by quota pace. Usage is read periodically; unavailable families must be paused rather than left eligible for selection.
4. **Start the seat.** orch supplies role duties, the brief, selected skills and relevant lessons. Coder, reviewer and bughunter seats get separate git worktrees. Read-only Pi roles have no edit tools and normally share the repository checkout.
5. **Return a report.** The seat reports changes, checks, evidence and unfinished work as JSON. orch records and grades the report, then returns a digest to the lead. A grade is not proof that the code is correct.
6. **Plan and run review.** `review_plan` determines the required review. Reviewer families differ from the author's and the lead's, with one exception: Claude may review another family's change even with a Claude lead. A blocking finding needs a reproduction.
7. **Land and commit.** `seat_land` applies the accepted change to the lead checkout; it never commits. The lead commits explicit paths through `npm run check:commit`, with the owner's approval.
8. **Keep the result.** Durable decisions and lessons go to memory, remaining work becomes tasks, and handoffs carry the state into the next session.

The delegation commands and family rules are in the [orch reference](ops/orchestrator/README.md) and [installation guide, §9](INSTALL.md#9-using-the-harness).

## The parts

### orch daemon and CLI

orch creates and tracks seats, selects families, provisions worktrees, collects reports and serves the board. It runs locally as a background service. Its API is at `http://127.0.0.1:7760`, MCP at `/mcp`, and the board at `/`; state is stored under `~/.local/state/orch` in a SQLite WAL store.

The lead uses MCP for delegation. The CLI, `node ops/orchestrator/src/main.ts`, provides service status, seat waits, host management, smoke tests and family-selection statistics. `wait <turn>` returns the completed turn's digest. Remote seat hosts are added over SSH; orch and the lead remain on the main machine.

### Board and lead chat

The web board shows leads and their context use, seats and their role/family/model, tools, skills, Pi extensions, and each family's quota window and pace. It makes pending and running work visible without opening every seat transcript.

![orch board: leads and lead chat](img/web-leads-chat.png)

Lead chat carries messages into a running lead session through hooks. A watcher can wake a stopped lead when a message arrives. It is distinct from the worker reports: chat coordinates leads, while reports deliver a seat's result.

![orch board: family quotas and pace](img/web-limits.png)

### Roles and family selection

Roles define a seat's job and available methods; families define which provider and model execute it. The role matrix can be kept as shipped or configured during installation.

| Role | Job |
|---|---|
| Scout | Locate code and answer a bounded question with source evidence |
| Researcher | Investigate a subject and return sourced findings |
| Coder | Implement an agreed task and run the relevant checks |
| Reviewer | Inspect a change and reproduce blocking findings |
| Bughunter | Investigate and reproduce a defect |
| Debater | Examine competing approaches |
| Plan critic | Check a proposed plan before implementation |

Quota selection is not a claim that one family is best at every task. orch reads vendor usage every five minutes and prefers eligible families at or behind their budget pace. Credentials come from the configured provider stores; unreadable limits are not a proven spare budget. Families without working access must be paused.

### Pi and its pinned extensions

[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) is the worker runtime for non-Claude seats. orch starts it without automatic skill discovery and supplies the task's context itself. This keeps the role's instructions and tools under harness control instead of loading a vendor CLI's full default context.

#### Why Pi

A vendor CLI loads its own system prompt, tool catalogue and skills before the seat reads the brief. Pi starts bare: no skills, no context files, no telemetry. orch puts the role's skills and lessons into the first message.

Stand of 2026-09-22: two tasks (a scout answers a question checked against a known file:line, a coder makes an edit with a test in a disposable worktree), each family in its own CLI and in Pi, two runs each. Average tokens per task:

| Family | Scout: own CLI → Pi | Coder: own CLI → Pi |
|---|---|---|
| glm | 233k → 130k | 293k → 167k |
| grok | 175k → 33k | 339k → 109k |
| codex | 248k → 36k | 159k → 77k |
| opencode | 272k → 80k | own CLI did not allow file edits |

Correctness was 100% in both setups. The tasks were small, two runs per cell, cache reads counted; without cache reads the gap is smaller. These are local measurements, not a guarantee.

The shipped runtime is **Pi 1.4.0**, launched from `ops/pi-runtime/node_modules/.bin/pi`, not a global installation.

| Integration | Purpose |
|---|---|
| orch extension | Enforce seat tool restrictions, including guarded shell access for read-only roles |
| `pi-mcp-adapter` 5.3.2 | Expose codegraph and memory MCP capabilities as seat tools |
| `codex-edit`, `@maxiaochao/pi-toolkit` 0.9.3 | Editing extension required for Codex coder seats, pinned by version and hash. Local measurement, not a guarantee: 2026-09-30, two small single-file edit tasks, 10 runs per arm: 10 of 10 correct with and without it; 45% fewer tokens, half the time |

An extension installation is not unrestricted permission to replace seat tools. orch checks the expected tool list; arbitrary shell or editing replacements can break that contract. [Installation guide, §7.3](INSTALL.md#73-pi-mcp-adapter-settings-sign-ins-codex-edit) covers the managed setup.

Claude seats stay in Claude Code. The authors' Pi-to-Anthropic subscription probes failed with extra-usage errors; that path is not treated as proven subscription access.

### Worktrees

Editing and inspection seats that need isolation work in `~/.local/state/orch/worktrees/<seat>`. Each worktree belongs to the target repository, not to a copy of the harness. Optional per-project setup commands can install the project's dependencies in a new worktree.

Isolation keeps concurrent edits apart; it does not merge conflicting changes or validate them. Landing and committing remain separate operations. The stash is shared across a repository's worktrees, so seat hooks forbid `git stash`.

### Reports, grading and review

Reports separate observations, evidence, checks and open work. orch performs structural grading in code; optional Jev grading asks whether the result is a real completion report. Jev does **not** judge whether each evidence pair is true.

Review planning considers the seat's own diff and its risk. Depending on the plan, independent reviewer seats inspect the change. If Jev is unavailable, review does not silently disappear: the planner keeps a minimum review requirement, with stricter handling for security paths. The [Jev section](#jev) describes the data sent and the failure behaviour.

### Commit gate

The lead owns the final commit. The shipped `npm run check:commit` runs the kit's commit-safety check; it is not a substitute for the adopted project's typecheck, tests or build. Project-specific commands must be configured as part of adoption. The kit also supplies Git hook shims and a push check; it does not push automatically.

### Memory, lessons, tasks, handoffs and knowledge pages

`memoryd` is the durable local service; `memoryctl` is its CLI and MCP interface. The store combines SQLite, full-text search and embedding vectors. The default embedder is Ollama with `qwen3-embedding:0.6b`; the macOS setup also installs a local reranker.

| Record or page | Purpose |
|---|---|
| Decisions | Preserve an agreed rule or choice beyond the chat that produced it |
| Lessons | Bring a previous finding back when work touches the relevant file or task |
| Tasks | Keep unfinished work explicit instead of burying it in a completion summary |
| Handoffs | Carry completed work, current state and open tails into the next session |
| Domain knowledge pages | Keep subsystem context in repository files and route the relevant material into agent context |

The memory database has one writer. Dense search requires a working embedding endpoint. The kit starts with generic domains; an adopted project's knowledge pages and routing are configured for that project. See the [memory reference](docs/agent/memory.md).

### Handover and Claude Code mods

A memory handoff is a durable record. The **handover mod** handles the session transition: it queues a successor prompt, optionally after clearing the old conversation. It does not replace the need to record unfinished work.

The installer registers these Claude Code mods from `ops/claude-mods/`:

| Mod | Behaviour and limit |
|---|---|
| `orch-board` | Opens the board beside the conversation. Desktop shows cards and forms; the terminal surface shows a text summary. Requires local orch. |
| `handover` | Provides `mcp__handover__run` to queue the next lead session's prompt. Requires Claude's mod APIs. |
| `collision-guard` | Asks before an edit touches a file recently changed by another open chat. Without an attached UI surface the edit proceeds; this is not a file lock. |
| `delay-no-more` | Controls deferred tool search with configured `eager`/`defer` patterns. Empty defaults change nothing. |
| `secrets-veil` | Masks secret values in tool results and withholds a result if masking fails. It cannot guarantee recognition of every possible secret. |

![Claude Code desktop pane: leads](img/desktop-leads.svg)

![Claude Code desktop pane: seats](img/desktop-seats.svg)

![Claude Code desktop pane: lead chat](img/desktop-chat.svg)

The pictures show a real run with private names replaced. Registering mod folders is not proof that the app loaded them. Windows mod loading is untested. These are Claude Code mods, not Pi or Codex extensions.

### Codegraph, rtk and ast-grep

| Tool | Use |
|---|---|
| `codegraph` | Index code relationships and return relevant source for flow, caller and dependency questions; adoption builds the project's index |
| `rg` | Find a known literal; a graph answer is not always the cheapest way to locate a string |
| `ast-grep` | Match source structure rather than text, such as implementations or a particular call shape |
| `rtk` | Filter supported shell output before it reaches agent context; `rtk gain` reports observed savings |

These tools have different jobs. A shell hook routes supported commands through rtk; codegraph and memory are also available through MCP. Tool-output reduction does not establish that a task used fewer total tokens or produced a correct result.

### Skills and hooks

Skills are reusable methods in `SKILL.md` files. The harness skill map selects the lead set, role defaults and brief-triggered seat skills. Pi seats receive skills from orch, not from automatic discovery in arbitrary skill directories. Adding a skill means vetting its instructions and scripts, keeping its licence and provenance, registering it in the map and checking delivery.

Hooks connect the method to runtime events: session health checks, lessons before file work, shell-output filtering, code-intelligence reminders, lead chat and context-limit handover reminders. Other hooks guard shared-stash use and recursive forced deletion. They are installed from the harness sources; rerunning the installer repairs managed integrations while preserving unrelated entries under the kit's default ownership policy.

### Routines, project adoption and doctor

- **Routines** are recurring-task definitions in `ops/routines/`. `node scripts/routines.mjs list` lists them; the `setup-routines` skill uses the lead app's scheduler to create selected tasks. Listing definitions does not schedule anything.
- **adopt-project** links the configured lead skills into a repository and builds its codegraph index. Links and index data are hidden through `.git/info/exclude`; tracked project files are unchanged by that command. Runtime rules, project checks and domain knowledge still need adaptation.
- **doctor** is the read-only installation diagnostic, run as `npm run doctor`. It reports the state of installed parts; it neither repairs them nor proves provider access in place of a smoke test.

## Jev

Jev is an **optional paid classifier/judge**, not a coding family. The shipped client uses model `jev-1.13.0` at `api.typesafe.ai`. `TYPESAFE_API_KEY` enables requests; without a key nothing is sent. Installation asks separately about Jev and paid-proof consent.

| Integration | What Jev receives and decides | If judging fails |
|---|---|---|
| Seat lesson routing | Brief plus candidate lesson titles, anchors, triggers and rule excerpts; ranks relevant lessons | Anchor-based selection remains |
| Seat skill routing | Brief plus skill names/descriptions; can remove candidates, never role defaults | Skill-map selection remains |
| Lead first-prompt routing | Lead prompt and domain/skill choices; selects lead context | No routed result; a later attempt remains possible |
| Coder brief scope gate | Labelled brief; classifies scope and feature probabilities | Marked unjudged; automatic role selection refuses to create a seat |
| Review planning | The seat's own diff, with paths and hunks; classifies logic risk and test weakening | Minimum reviewer requirement remains |
| Report grading | Report JSON; asks whether it is a real completion report, not whether its evidence is true | Report marked ungraded with the reason |
| Refused-command hint | Refused command text; chooses a hint from fixed tool options | No hint; the original refusal stands |
| Memory deep search | Search question and redacted candidate titles/snippets; reranks results | Command exits with an error, not a silent alternative ranking |

These requests can send project text outside the machine, including briefs, report content and diff excerpts. Jev is not a replacement for tests, reproduced findings or the lead's decision. The [client](ops/bootstrap/jev-client.mjs) records an audit hash for each request, and the local usage ledger feeds the board's estimate.

## Families

The authors use Claude as lead in the Claude Code desktop app. Claude Code terminal CLI and Codex desktop/CLI leads can also use the generated configurations; they do not get the same Claude desktop mod surfaces.

| Worker family | Runtime route | Access |
|---|---|---|
| `claude` | Native Claude Code | Signed-in `claude` CLI |
| `codex` | Pi `openai-codex` | ChatGPT subscription via Pi `/login` |
| `glm` | Pi `zai`; optional native Claude CLI route | Z.AI Coding Plan key |
| `kimi` | Pi `kimi-coding` | Pi `/login` |
| `grok` | Pi `xai` | Pi `/login` |
| `opencode` | Pi `opencode-go` | Pi `/login` |
| `qwen` | Pi `qwen-token-plan-individual` | Token-plan key through Pi `/login` |
| `mimo` | Pi `xiaomi-token-plan-*` | Token-plan key through Pi `/login` |

Not every family has every role: OpenCode is scout-only in the default matrix; Claude has researcher, coder, reviewer and plan-critic assignments. The full role/model matrix and login requirements are in [INSTALL.md, §2](INSTALL.md#2-supported-ai-families).

## Requirements

- **macOS on Apple Silicon** is the checked setup. [The guide's 16 GB guidance](INSTALL.md#113-16-gb-guidance) covers memory-constrained machines.
- **Local tools:** Git from Xcode Command Line Tools; Node ≥ 26.7.0, ripgrep ≥ 15.1.0, Ollama ≥ 0.35.1. The guide installs prerequisites from official archives and verifies checksums; no package manager is required for that path. Python is also installed for the reranker.
- **Provider access:** working subscriptions or plan keys for the enabled families. Review needs a different worker family; two worker families besides the lead's are the practical minimum described in the guide.
- **Local services and storage:** orch, memoryd, an answering embedding endpoint, and space for the memory database, models and project worktrees.
- **Optional services:** Jev and Bright Data need their own keys. macOS capture with Peekaboo needs permissions granted by the owner.

Windows has not been tested; it is unknown whether everything installs and works there. The guide contains Windows instructions, not a support guarantee. Linux is accepted for remote seat hosts, not for this kit's local memory installation.

## Measured numbers

| Observation | Sample and method |
|---|---|
| **28.3% fewer tool-output tokens with rtk** | `rtk gain`, 4,255 commands across operator sessions and worker seats, 2026-10-20–21 |
| **56–73% of a seat's context spent reading files** | Token audit of 583 worker seats, 2026-09-21 |
| **3,183 vs 78 tokens for one literal lookup** | Codegraph answer with source vs `rg`; one query answered both ways, codegraph 1.6.2, cl100k_base, 2026-10-03 |
| **Memory search hit@1 0.640, hit@5 0.757** | Live-service search quality, 92-case bench, 214 queries, 2026-10-06 |
| **0 tokens per memory write** | Write-path observation, 2026-10-05: the row is stored at once; the vector is built in the background |

Each number is a local measurement, not a guarantee. The rtk result measures tool output, not total task-token savings. `rtk gain` reports the installed machine's own sample.

## Limits

- **macOS only is checked. Windows is untested and the outcome is unknown**, including mod loading.
- orch and leads run on one machine; additional machines run seats over SSH.
- Quota-aware selection depends on readable vendor usage. A working login or an installed runtime alone does not prove a seat can complete a task.
- Local memory has one writer; dense retrieval depends on the embedding endpoint. Durable records do not automatically create a project's knowledge pages.
- Optional Jev requests send selected project text to a third party. Missing or failed judging has integration-specific consequences, including ungraded reports and refused automatic choices.
- Model names reflect the build date. A vendor rename can fail seat startup and needs an explicit model/configuration update.
- The manifest verifies shipped bytes, not a working installation. Service health, logins, smoke tests and desktop mod loading are separate checks.
- No support promise, warranty or update schedule is offered. [INSTALL.md, §1.1](INSTALL.md#11-what-the-software-does-on-this-machine-tell-the-user-before-installing) details machine changes; [§14](INSTALL.md#14-what-the-kit-is-and-what-was-checked) describes verification scope.

## Documentation

- [INSTALL.md](INSTALL.md) — installation commands, checks and project adaptation
- [INSTALL-PROMPT.md](INSTALL-PROMPT.md) — agent-led interview and installation sequence
- [ops/orchestrator/README.md](ops/orchestrator/README.md) — orchestration reference
- [docs/agent/memory.md](docs/agent/memory.md) — durable local memory
- [docs/agent/environment.md](docs/agent/environment.md) — environment and tool rules
- [RTK.md](RTK.md) — rtk filter catalogue

## Licence

[MIT with the Commons Clause condition](LICENSE). Use, copying, modification and sharing are permitted, including at work. Selling BooHarness, or a paid service whose value derives entirely or substantially from it, is not permitted. This is source-available software, not OSI open source. Vendored skills with their own `LICENSE` retain those terms.
