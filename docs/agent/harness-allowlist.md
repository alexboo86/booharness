# Harness allowlist (policy 2026-07-25)

> Часть свода правил агента. Корень — [CLAUDE.md](../../CLAUDE.md).
> **Читать когда:** настраиваешь MCP / plugins / skills / hooks; перед добавлением любого нового tool/skill.

Текущий аудит: план экономики харнесса, 18.09.2026 (`docs/agent/harness-economy-plan-2026-09-18.md` not in this kit) и проверенные результаты (`docs/agent/harness-economy-results-2026-09-18.md` not in this kit).

Class and requires of every canon skill: skill classes (`docs/agent/skill-classes.generated.md` not in this kit), generated from the `skills` key of `.agents/domains/_skill-map.json`.

## Канон одной строкой

```
method skills (investigate-first, surgical-patch, verify-and-stop,
plan-before-code, enumerate-cases) + codegraph + ast-grep + RTK
+ domain-* + project ops skills + memoryctl + PreToolUse rtk
+ booharness MCP (ops/support only)
```

Всё остальное — **вне allowlist**. Не подключать «на всякий случай».

### Web design — explicit operator addition, 2026-09-08

The operator approved [`impeccable`](../../.agents/skills/impeccable/PROVENANCE.md) (pbakaus/impeccable) for refining booharness's Optics/Aperture web prototype. Canonical vendored skill sources live under `.agents/skills/`, with upstream revisions and licenses in each `PROVENANCE.md`; distribute with the existing `install-harness.mjs --only skills` route. Impeccable's versioned local engine is included in this approval; automatic edit hooks and unrelated MCP servers are not added. Motion is an existing web dependency. This addition is for the approved design workflow and does not relax the other allowlist boundaries.

### Skill discovery — explicit operator addition, 2026-09-25

The operator approved Vercel Labs' [`find-skills`](../../.agents/skills/find-skills/PROVENANCE.md) (vercel-labs/skills, MIT) for the lead, vendored unmodified under `.agents/skills/find-skills` with its upstream commit and license in `PROVENANCE.md` (memory decision #11984). It is a search tool, not an install route: the lead runs the pinned `npx -y skills@1.7.0 find <query>`; `npx skills add` and the upstream `-g -y` auto-install are never run by an agent here. Each candidate it surfaces enters the catalogue only by a separate operator approval, vendored with its own `PROVENANCE.md` and routed through `.agents/domains/_skill-map.json`.

### Operator reply style — explicit operator addition, decision #13207

The operator approved [`i-have-adhd`](../../.agents/skills/i-have-adhd/PROVENANCE.md) (ayghri/i-have-adhd, MIT), vendored unmodified at its pinned upstream commit with LICENSE retained. It is mandatory and always on for every operator-facing Claude desktop lead and Codex GUI lead session, delivered without frontmatter by `ops/bootstrap/session-start.mjs`; the project contract outranks its rules. It belongs only to `leadInstalledSkills`, never to seats. Only SKILL.md and LICENSE were reviewed: upstream hooks, extensions and plugin manifests are not approved.

### Vetted skills — explicit operator addition, 2026-09-25

By decision #11988 (survey #11987), the retained upstream skills are vendored at pinned commits with their licenses and per-skill provenance: [`diagnosing-bugs`](../../.agents/skills/diagnosing-bugs/PROVENANCE.md) for coder/bughunter investigation; [`vercel-composition-patterns`](../../.agents/skills/vercel-composition-patterns/PROVENANCE.md) for React composition work; and [`playwright-best-practices`](../../.agents/skills/playwright-best-practices/PROVENANCE.md) for explicit Playwright work. The web skills use narrow negatable task triggers for coder/reviewer, not a web domain. They do not authorize browser/Vite preview as a Tauri runtime. Bundled scripts and network/install commands are supply-chain surfaces named in provenance, not auto-approved execution. The rest of those upstream packs, their MCPs and agent dispatch mechanisms are not added.

### External web and test skills — explicit operator addition, 2026-10-22

By decision #19444 the operator approved two external skills, vendored unmodified at pinned commits with their licenses and per-skill provenance: [`vercel-react-best-practices`](../../.agents/skills/vercel-react-best-practices/PROVENANCE.md) (vercel-labs/agent-skills, `skills/react-best-practices`, MIT) for React and Next.js performance work in the web domain; and [`vitest`](../../.agents/skills/vitest/PROVENANCE.md) (antfu/skills, `skills/vitest`, MIT) for Vitest test authoring. The vitest skill is generated against Vitest 5 while this repo runs Vitest 4 (root `package.json`) and 2 (`web/package.json` (not in this kit)): its `PROVENANCE.md` lists every rule that does not hold on those versions, checked against the Vitest docs and changelog, and that list outranks the vendored text here. As with the vetted skills, bundled scripts and network/install commands are supply-chain surfaces named in provenance, not auto-approved execution, and the rest of those upstream packs, their MCPs and tooling are not added. Neither skill authorizes browser/Vite preview as a Tauri runtime. Routing through `.agents/domains/_skill-map.json` and the web domain arrive separately; until then these are allowlisted content, not routed skills.

### Design skills — explicit operator addition, 2026-10-22

By decision #19474 the operator approved two external skills for the future designer role, vendored unmodified at pinned commits with their licenses and per-skill provenance: [`ui-ux-pro-max`](../../.agents/skills/ui-ux-pro-max/PROVENANCE.md) (nextlevelbuilder/ui-ux-pro-max-skill, `.claude/skills/ui-ux-pro-max`, MIT) and [`emil-design-eng`](../../.agents/skills/emil-design-eng/PROVENANCE.md) (emilkowalski/skills, `skills/emil-design-eng`, MIT). Designer role defaults arrive in a later slice; these entries are class `method` with no trigger, so until then they are allowlisted content, not routed skills. ui-ux-pro-max's mobile-sized defaults (44×44px touch targets, mobile-first breakpoints, 16px base type) lose to the adopted project's UI rules. As with the vetted skills, bundled scripts and network/install commands are supply-chain surfaces named in provenance, not auto-approved execution, and the rest of those upstream packs, their CLIs, repo-root refresh scripts and tooling are not added. Neither skill authorizes browser/Vite preview as a Tauri runtime.

### Copywriter anti-slop skill — explicit operator addition, 2026-10-23

By decision #19584 the operator approved [`anti-slop`](../../.agents/skills/anti-slop/PROVENANCE.md) as the second copywriter role default beside the kit-excluded product copy skill, delivered inlined into every copywriter's first brief. It is an original skill of this tree, not a vendored copy: external sources were restated in our own words, and the closely adapted lists carry their MIT notices in its `PROVENANCE.md`. It ships no runnable files. It owns how English and Russian copy reads (machine-text tells); the kit-excluded product copy skill keeps owning where text lives and the gates a change passes.

### Test authoring gate — explicit operator addition, 2026-09-28

The operator approved [`test-audit`](../../.agents/skills/test-audit/SKILL.md) for the lead and for coder, reviewer and bughunter seats of every domain (memory decisions #12668, #14235). It is our own project skill, not vendored: adapted from openclaw/openclaw `.agents/skills/test-audit/SKILL.md` at `80930af4` (MIT, Copyright (c) 2026 OpenClaw Foundation), with the provenance line at the end of the file. Its rule: before a new test is written, state the behavior it protects, the bug it would catch, and why existing checks are not enough. Only the authoring gate is carried; upstream's audit and campaign sweeps, its OpenClaw validation tooling and its push/PR landing steps are not. It routes through `leadInstalledSkills` and the `roleDefaults` of those three roles in `.agents/domains/_skill-map.json`.

### Scout delegation — explicit operator addition, 2026-09-28

The operator approved [`scout-request`](../../.agents/skills/scout-request/SKILL.md) for coder, reviewer and bughunter seats of every domain. It is our own project skill, not vendored: send a sweep across 3+ files, logs or memory to the read-only `scout_request` tool, while reading a known single file directly. It routes through the `roleDefaults` of those three roles in `.agents/domains/_skill-map.json`. The skill adds no agent dispatch or hard refusal of reads (decision #12699).

### Peekaboo — explicit operator addition, 2026-10-06

The operator approved Peekaboo as a capture and drive tool (decisions #14768 and #14785, task 2157); the screenshotter role was removed on 2026-10-21 (#19248). A lead or a seat captures the screen or a window and reads the image itself, only when a picture is necessary; a log, test, DOM or accessibility read that proves the point comes first. The approved install route is `brew install peekaboo`; measured on 4.4.0. An agent does not install it: a missing tool is reported. An agent may call `peekaboo permissions --json`, `peekaboo window list --pid|--app --json`, `peekaboo see --window-id <id> --tree --json --path <png>` (no `--foreground`), and `peekaboo click <label> --pid <pid> --window-id <id> --wait-for 2s --json` (a label the brief names, or plain navigation). It may not call coordinates, element ids, `type`, `press`, `paste`, `set-value`, `action`, `drag`, `move`, `scroll`, `menu`, `app`, `dialog`, or hand-written Swift for what those commands do.

### ASD-STE100 dictionary source — explicit operator addition, 2026-10-06

The operator approved the open extraction of the ASD-STE100 issue 9 dictionary, the PyPI package `biz.dfch.AsdSte100Vocab` (AGPL-3.0), as the word source of the STE checker (decisions #14851 and #14861, task 2164). It is data, not a tool: the package is unpacked and read, never installed into a runtime and never executed. `scripts/ste-build-dictionary.mjs` (not in this kit) reads its `asdste100_issue9_base.jsonl` (one named `--source` at a time) and writes `ste/dictionary.json` under the orch state directory; it refuses an `--out` inside a git work tree. The dictionary is never committed: the licence of the standard for such extractions is unverified, and only this Mac reads the file. `scripts/ste-check.mjs` reads that dictionary and `ops/orchestrator/ste/technical-names.json`, with no network and no model. When the operator has the official issue 9 PDF from ASD (free, on a request form that is his to send), it becomes the source and the build prints the difference.

### Complexity and duplication tools — explicit operator addition, 2026-10-27

By decision #20542 (after the whole-tree measurement #20541) the operator approved two tools by Robert C. Martin, both 0BSD Python on tree-sitter: [unclebob/crapper](https://github.com/unclebob/crapper) @ `6fd92c4c9bcc` for a check:commit gate that stops function complexity (CC) from growing (task 3184), and [unclebob/dryer](https://github.com/unclebob/dryer) @ `66ff6d21a42c` for a weekly duplicate report, never a commit gate (a whole-tree run takes 27 min on one core). Their sources are vendored at those commits with `NOTICE` and per-file SHA-256; their Python dependencies are pinned wheels with hashes, unpacked by the installer without pip, and the tree-sitter grammars are fetched at install time, never at commit time. Only `--no-coverage` complexity and the duplicate scan are approved: their coverage and mutation runs (which run test suites and install `@vitest/coverage-v8` or `cargo-llvm-cov`), `unclebob/mutator`, `unclebob/uml-viewer` and the `ub-mode` skill are not added.

### Higgsfield CLI — explicit operator addition, 2026-10-28

The operator ordered Higgsfield for the landing animations (site redesign track, annotation call 2026-10-28) and signs in with his own account. The approved route is the official CLI [`@higgsfield/cli`](https://github.com/higgsfield-ai/cli), installed globally on this Mac at a pinned version (`npm i -g @higgsfield/cli@1.2.2`, postinstall script not allowed) and authenticated by `higgsfield auth login` in the operator's browser; no API key is stored. Each generation spends the operator's Higgsfield credits: a lead or a seat runs `higgsfield generate cost` before `generate create` and generates only scenarios the operator approved. The companion skills (`npx skills add higgsfield-ai/skills`) and the remote MCP connector are not added.

### Vendored Claude Code mods — explicit operator addition, 2026-10-16

By decision #17932 the third-party Claude Code mods below are vendored byte-identical under `ops/claude-mods/` with `NOTICE` (source, commit, licence) and `VENDOR.json` (per-file SHA-256) in each folder; the installer registers them all in `env.CLAUDE_CODE_PLUGIN_DIRS` via `CLAUDE_MOD_NAMES`. A vendored file is edited here only with the change named in the mod's `NOTICE` and the file dropped from `VENDOR.json` `files`; a general fix goes upstream too. Pins and audited behaviour:

- **collision-guard** — [nateherkai/claude-code-mods](../../ops/claude-mods/collision-guard/NOTICE) @ `33a936f2ec6b` (MIT). Hooks `Edit`/`Write`/`NotebookEdit`, `session.*`, `prompt.submit`; writes only `~/.claude/mods-data/collision-guard/<chat>.json`; runs `git ls-files` read-only; no network, no model calls.
- **delay-no-more** — [ruihe774/cc-delay-no-more](../../ops/claude-mods/delay-no-more/NOTICE) @ `135b288941` (Unlicense). Hooks only `tool.describe` to re-place tools by `eager`/`defer` patterns; no files, no processes, no network, no model calls.
- **secrets-veil** — [yonatangross/orchestkit](../../ops/claude-mods/secrets-veil/NOTICE) @ `0fe5beba22a` (MIT). Hooks `tool.call` (mask after run, fail closed with `{ deny }`) and `session.start`; reads 21 named vendor env variables plus `SECRETS_VEIL_OFFER_COPY`; optional clipboard copy via `$.ui.copy`; no files, no processes, no network.

## MCP (allowed)

| Name | Role | Config |
|---|---|---|
| `codegraph` | the call graph: who calls a symbol, what depends on a file (re-exports included), and an unnamed question in English. ONE tool, `codegraph_explore`; the narrow verbs are CLI. Replaced `probe` 2026-09-19 after a measurement on this tree (memory #9838); telemetry is anonymous and turned OFF here (`codegraph telemetry off`) | `codegraph serve --mcp`; installed globally from npm package `@colbymchenry/codegraph` |
| `memoryctl` | durable memory where a hook cannot reach — **one** tool with an action enum (`hot`/`lessons`/`search`/`append`/`handoff`/`task_*`), added 2026-08-02. The Edit hook is installed on every runtime; under Paseo its output does not reach grok or kimi (#1212), so the seat asks `lessons` itself | `node {repo}/scripts/memory/mcp-server.mjs`, proxies the one Mac launchd memoryd at `http://127.0.0.1:7717` (no Mac `service.url`); win's `service.url` selects its ssh forward at `http://127.0.0.1:7718`. NAS: backup target and stopped rollback copy, never a second writer |
| `booharness` | наблюдаемость прода — и ТОЛЬКО она: stdio-вход отдаёт 11 read-only инструментов из `mcp-booharness-servers/src/tool-policy.ts`, ни одного support-инструмента ни при каком env | локальный stdio `dist/server-stdio.js` |
| Operator-only MCP | Configure services and credentials explicitly for the adopted project; none are enabled by the kit. | `ops/bootstrap/mcp-servers.operator.json` |
| `operator-trade` | **снят отовсюду** (решение оператора #19215, 2026-10-20): торговый MCP не ставится ни в один рантайм, операторский профиль тоже | `ops/bootstrap/mcp-servers.json` `retired`: установщик УДАЛЯЕТ прежние записи из всех рантаймов при каждом прогоне |
| `brightdata-web` | единственный веб-MCP: поиск (`search_engine`) и ЗАБОР самой страницы через Web Unlocker (`scrape_as_markdown`), проходящий капчу и анти-бот | `node {repo}/ops/mcp-vendor/node_modules/@brightdata/mcp/server.js` (pinned 2.11.1), `API_TOKEN` из секрета `BRIGHTDATA_API_KEY` в гитигнорном файле |
| `orch` | the local orchestration daemon that will replace Paseo (operator decision 2026-09-22, memory #10457); phase 0 exposes two read-only tools, `orch_status` and `seats_list`. **Leads only**: the SSOT `runtimes` field puts it in `~/.claude.json` (Claude Code, zcode) and `~/.codex/config.toml`, never in grok, kimi or the glm configs | HTTP `http://127.0.0.1:7760/mcp`, served by `node ops/orchestrator/src/main.ts serve` (LaunchAgent / logon task from `ops/orchestrator/install.mjs`); SDK `@modelcontextprotocol/sdk` pinned in `ops/orchestrator/package.json`; loopback Host/Origin only |

**Сняты 2026-08-09 по замеру, решение оператора:** `youtube-transcript`,
`grep-app`, `context7`. За 330 прогонов Свода они дали **0**, **16** и **3**
вызова соответственно, при этом каждый вёз свои схемы в каждый ход у всякого
клиента, грузящего их жадно. Ids внесены в `retired` SSOT, а не просто удалены из
`servers`: без этого снятый сервер перестаёт быть управляемым и живёт в
TOML-рантаймах вечно. Проверено — после установки их нет ни в одном из семи
рантаймов, включая `~/.grok/config.toml` и `~/.codex/config.toml`.

Возвращать — записью в `servers` того же SSOT и удалением id из `retired`; повод
должен быть числом, а не ощущением, что «пригодится».

**Сервер может назвать рантаймы, которым он положен** — поле `runtimes` в SSOT;
без поля сервер идёт во все. Установщик это ИСПОЛНЯЕТ, а не описывает: id
остаётся управляемым, поэтому из неположенного рантайма запись удаляется, а не
сохраняется как чужая. Configure `runtimes` explicitly for each adopted operator service. Schema loading has a runtime-dependent context cost; measure the configured service rather than inheriting another project's tool inventory or deployment assumptions.

Смотреть, что реально стоит в сессии, — первые строки `session-start`: он печатает
СОСТАВ конфигов, а не список манифеста, отдельно называет операторский профиль и
отдельно то, чего нет ни в одном SSOT.


Веб-MCP исторически существовал ради требования Svod deep-research profile:
тот отказывался стартовать, если у члена не было способности, в имени которой
есть `web` или `search`, а Svod ничего не инжектил — сервер обязан был реально
существовать в родном доме каждого рантайма. Svod снят 2026-09-14 (заменён
Paseo), это требование ушло вместе с ним, но сервер остаётся общей
web-fetch-возможностью (research-скилы, ручной поиск источников) — поэтому id
по-прежнему несёт `web`: переименование меняет читаемость, а не запуск профиля.

**Exa снята 2026-08-04 решением оператора, на её место встал `brightdata-web`.**
Разница не в качестве поиска, а в том, ЧТО возвращается: Exa отдаёт выжимку
страницы, Bright Data — саму страницу через Web Unlocker, проходя капчу и
анти-бот. Для реестра первоисточников это решает: выжимка теряет ровно те числа и
оговорки, ради которых мы и идём в источник. Замер 2026-08-04: teletype и Notion
взяты с первого раза, публичная папка cloud.mail.ru прочитана без логина.
Это по-прежнему единственный веб-MCP; остальная категория запрещена. Без
`BRIGHTDATA_API_KEY` установщик его пропускает и говорит об этом, а не пишет
сломанный конфиг.

**Никакого `npx` в командах MCP — только пиннованный локальный вход** (`ops/mcp-vendor`,
`npm ci --prefix ops/mcp-vendor`). Замер 2026-08-03 на claude 2.1.220: в одном
сгенерированном `.mcp.json` члена Свода сервер с командой `npx` встаёт в статус
`pending` (CLI держит его как проектный, ждущий одобрения), подключается для
health-check и НЕ отдаёт ни одного инструмента, тогда как `node <локальный файл>`
и `http` из того же файла — `connected`. Из-за этого член deep-research отработал
целый прогон вообще без веба и честно пометил весь отчёт «из памяти». `--strict-mcp-config`
этого не снимает. Побочно: старт упал с 1237 мс до 141 мс.

`youtube-transcript` и `grep-app` добавлены 2026-08-03 по замеру пилота смартмани:
две дыры, а не вкусовщина. У ICT нет книги-первоисточника — весь канон в роликах,
поэтому все члены во всех прогонах ставили тип свидетельства F вместо C, и термин
«1st Presented FVG» остался с двумя конкурирующими определениями. Решающий материал
пилота пришёл из кода (открытый дефект перерисовки зон в чужом детекторе, точные
пороги параметров, `trades.csv` на 78 сделок против вирусного видео с выборкой 15),
а веб-MCP ищет страницы. Синтезирующий поисковик (Perplexity и подобные) в эту категорию
**не берём** и после этого решения: программа построена на «определение / заявление
источника с атрибуцией / чем проверить», а синтезатор сливает продающую страницу и
рецензируемую работу в одну гладкую фразу. Нужен сырой retrieval, судим сами.

`context7` was on the forbidden list until 2026-07-25. Operator decision that day:
the risk of an agent inventing a library API is the bigger one here, because the
stack pins several fast-moving upstreams. It stays the only doc-fetching MCP —
everything else in that category is still forbidden.

### MCP forbidden (examples)

`basic-memory`, `github`, `sequential-thinking`, `shadcn`, `supabase`, `voicemode`, `web-search-prime`, `web-reader`, `zread`, any other personal MCP.

Memory = **standalone `memoryctl`**, not basic-memory.

## Code-intel CLI (allowed)

| Name | Role | Config |
|---|---|---|
| `ast-grep` | exhaustive structural search over syntax trees; query patterns in English | `ast-grep` / `sg`; installed globally from npm package `@ast-grep/cli` |

## OpenCode scout runtime (allowed)

| What | Names | Source |
|---|---|---|
| Seat runtime (orch scout) | `opencode` 1.18.31, `npm install -g opencode-ai` | operator decision 2026-09-19 (memory #9840, overturns #9426 and #9701): the OpenCode Go subscription becomes a READ-ONLY scout seat. Config `~/.config/opencode/opencode.json`, written by `install-harness.mjs --only opencode`, denies `edit` and leaves the shell, `webfetch` and every external directory open (grok parity, operator 2026-09-20, memory #9918; a prompt nobody answers only parks the seat); `auth.json` keeps only the `opencode-go` entry, so no Zen pay-as-you-go call can bill the balance. Orch selects the opencode family for a scout through `ops/orchestrator/src/profiles.ts`. No skills and no plugins: `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` on the provider, `--pure` on any hand run. ToS 2026-08-15 forbids product inference and any process that runs while the operator is not logged in — no schedule and no heartbeat on this key |
| Pi extension, A/B stand arm `sol-pi` only | `github.com/NVlabs/SoL-Pi` (MIT) at commit `e1a586af0ad8956f42ae5b26bba20e48fbf30e00`; Action Fusion and ObservationPack only | operator decision #13470: one git commit pinned in `ops/ab-stand/sol-pi.json`, checked out into the arm's own prefix with no npm and no lifecycle scripts; never `~/.pi/agent`, never a stock seat |

## Native coder runtimes (allowed)

| Runtime | Package / pinned version | Scope |
|---|---|---|
| Qwen Code (`qwen --acp`) | `@qwen-code/qwen-code@0.24.7` | Operator decision #13378; coder only, full access (`--approval-mode yolo`). Existing Pi key passed by environment; personal Token Plan non-interactive-use risk accepted by the operator. |
| MiMo Code (`mimo acp`) | `@mimo-ai/cli@0.1.15` | Operator decision #13378; coder only, full access (`build`), `mimo-v2.6-pro`. Operator-managed login; `plan` is not a proven read-only boundary because bash is left to the model. |

## Paseo (retired; historical inventory)

Paseo and its plugins are no longer installed by this repository. The following
inventory records what the former daemon carried, not a current allowlist.

| What | Names | Source |
|---|---|---|
| Plugins (git-installed, `paseo plugin update` keeps them current) | `fresh-worktrees`, `skills`, `agent-monitor`, `agent-crew`, `branch-garden`, `catppuccin-theme`, `paseo-dracula`, `gruvbox` | `omercnet` / `gpambrozio` / `sleeyax` / `juanlatorre` paseo-plugins marketplaces |
| Plugins (directory-installed, updated BY HAND — see below) | `usage-monitor`, `agents-history`, `paseo-markdown-viewer`, `compact-agent-activity` | checkouts under `C:\Bringup\plugin-src\*` on Windows, `~/.paseo/local-plugins/*` on the Mac |
| Skills (installed into `~/.claude/skills`) | `paseo`, `paseo-advisor`, `paseo-committee`, `paseo-handoff`, `paseo-help`, `paseo-plugin` | installed by the Paseo daemon |

**Why four plugins are installed from a directory (задача #1264, замерено 2026-09-17).**
`paseo plugin install <git-url>` clones the repository and bundles it without ever
installing its npm dependencies, and that breaks two different ways:

- A plugin whose **server** code imports `@getpaseo/client` refuses to build —
  `Could not resolve type dependency "@getpaseo/client" imported by …\server\handlers.server.ts`.
  The same import in **client** code is fine (`agent-monitor` does it and installs
  from git), so the bundler resolves the host's own types for one side only.
  `usage-monitor`, `agents-history` и `paseo-markdown-viewer` импортируют его на
  серверной стороне.
- A plugin that declares a build command dies earlier on Windows:
  `Plugin build command failed to start: "npm" "install" "--legacy-peer-deps" spawn npm ENOENT`
  — npm on Windows is `npm.cmd`, and the daemon spawns it without a shell. The
  same plugin (`compact-agent-activity`) installs from git on the Mac.

Ручное обновление такого плагина — три шага, и никакого `paseo plugin update`:

```sh
git -C <checkout> pull           # C:\Bringup\plugin-src\<name> или ~/.paseo/local-plugins/<name>
npm ci --prefix <checkout>       # именно поэтому git-установка и не работает
paseo plugin install <checkout>  # тот же id, конфиг переписывается на месте
```

## Plugins (allowed)

Разрешённых управляемых Claude plugins больше нет.

Все остальные plugins = **false**.

**`caveman@caveman` снят 2026-10-08 — решение оператора 15303.**
Установщик больше не ставит и не включает плагин: в пользовательском
`~/.claude/settings.json` пишет `enabledPlugins["caveman@caveman"] = false`,
убирает его записи из `plugins/installed_plugins.json`, `extraKnownMarketplaces`
и `plugins/known_marketplaces.json`. SessionStart больше не требует плагин.
Наши `investigate-first`, `surgical-patch`, `verify-and-stop` и их PROVENANCE
остаются обязательными; `i-have-adhd` остаётся по решению 13207.

**`superpowers@claude-plugins-official` снят 2026-08-18** — решение оператора,
задача 665. Он стоял здесь ради обязательного набора методов профилей Свода, а
тот набор больше не его: пять компактных документов под `.agents/skills/` (три
вендорены из caveman с provenance, два написаны нами), и `skill_roots` в обоих
канонах реестра несут только дерево репозитория. Замеры, на которых решение
принято, — круг `method-alternatives-r3` от 2026-08-17: SkillsBench
(arXiv 2602.12670) платит +19.0 п.п. за компактный набор из двух-трёх и только
+10.1 за четыре и больше, «исчерпывающая проза» даёт +0.7; пять документов
плагина весили 44 635 байт против примерно 3 500 сейчас. Отдельно снят
`test-driven-development`: TDD как инструкция о процессе измеренной поддержки не
имеет (контролируемое сравнение Бёкелер — прогоны с ней чуть хуже, токенов в
2.96–8.50 раза больше).

Маркетплейс `anthropics/claude-plugins-official` остаётся зарегистрированным:
лид волен поставить плагин себе. Ушла ЗАВИСИМОСТЬ харнесса от него, а не
возможность им пользоваться.

**Источники записаны здесь потому, что нигде больше их нет.** Список
маркетплейсов живёт в `~/.claude/plugins/known_marketplaces.json`, то есть внутри
того самого каталога, который теряется вместе с домашним; 2026-08-11 он был
уничтожен, и восстановление свелось к поиску репозиториев в интернете. Полная
переустановка с нуля:

```bash
claude plugin marketplace add anthropics/claude-plugins-official
```

**История: caveman возвращён 2026-08-07; это решение отменено решением 15303.**
Оба слоя различались по охвату. Проектный `.claude/settings.json` до claude-членов Свода не доходил —
Svod (снят 2026-09-14, заменён Paseo) запускал их с `--setting-sources user`,
который отбрасывает слои `project` и `local`. Глобальный `~/.claude/settings.json`
доходил. Оператор назвал оба, поэтому тогда включили в обоих; измеренный эффект ниже
(прогон 019fd43b) относится именно к глобальному слою.
Откат глобального — один флаг. `~/.glm-lead-config`
своим конфигом не покрыт ни тем, ни другим и намеренно не тронут.

**Ниже — история удаления, оставлена ради механики (корень = флаг, а не
каталог), а не как действующее решение.**

**Удалено 2026-08-06, отменено 2026-08-07:** `caveman@caveman` и
`claude-code-setup@claude-plugins-official` у claude, `kimi-datasource` у kimi.
Причина у всех одна и измеренная: плагин говорит с агентом мимо промпта. Блок
session-start плагина приезжал в ход ЧЛЕНА Свода (прогон 019fd43b: superpowers
и caveman у claude-члена, superpowers у kimi-члена) и конкурировал с брифом
прогона — стиль ответа, «сначала вызови скил», диспетч сабагентов. superpowers
остаётся: его скилы обязательны по `mandatory_skills` пресетов Свода, и на его
кэш указывает `skill_roots` в `svod/drivers.windows.json`. Остальные не давали
ничего: `kimi-datasource` — 13.5 КБ определений и ноль вызовов за весь инвентарь.

**Применено только 2026-08-06 вечером, и вот почему это заняло день.** Решение
выше было записано здесь и НЕ перенесено в `~/.claude/settings.json`: оба плагина
так и стояли `enabled: true`, то есть работали всё это время. Снести каталог
руками было бы бесполезно — CLI сам синхронизирует маркетплейс и переустанавливает
всё, что числится enabled: 2026-08-06T19:05:55Z он записал 438 файлов, включая
все одиннадцать файлов `claude-code-setup` заново. **Корень — флаг, а не
каталог.** Удаление плагина = `enabledPlugins.<plugin> = false` в
`settings.json`, снятие маркетплейса с регистрации (`extraKnownMarketplaces` и
`plugins/known_marketplaces.json`), и только потом `rm -rf` кэша. Проверять надо
флаг: каталог отсутствует ровно до следующей синхронизации.

## Hooks (allowed)

| Event | Command |
|---|---|
| `SessionStart` | `node ops/bootstrap/session-start.mjs` — обязательный набор, MCP, скилы, загрузка мест и указатель на доменные знания (без memory-дайджеста) |
| `PreToolUse` (Bash) | `rtk hook claude` — НАТИВНЫЙ хук rtk (1.0.1 на 2026-10-20, обе копии: `~/.local/bin/rtk` и `~/.cargo/bin/rtk.exe`, ставится `rtk init -g --hook-only --auto-patch`). Заменил наш собственный переписыватель для claude, удалённый 2026-08-05: тот писался под 0.44.0, пропускавший компаунды, а 0.44.1/0.44.2 переписывают их сами — замер на семи формах (`cd <project-specific> && cargo check`, `ls -la && git log`, `cat f \| head`, простые git/cargo/grep) дал одинаковый результат у обоих. Инертный маркер `NeverMatchesRtkMarker` больше не нужен: наг rtk печатал именно из-за отсутствия настоящего хука |

**Откуда берётся сам rtk (записано 2026-08-11, после того как обе копии были
уничтожены и восстановление свелось к угадыванию).** Источник —
`https://github.com/rtk-ai/rtk`, ставится `cargo install --git
https://github.com/rtk-ai/rtk --locked`. **`cargo install rtk` с crates.io ставит
ЧУЖОЙ пакет** — `rtk = "0.1.0"`, «Rust Type Kit», ни хука, ни `gain` у него нет;
это ловушка, о которой предупреждает и сам апстрим. Пересборка из HEAD 2026-08-11
дала `rtk 0.42.4` — НИЖЕ, чем стоявший до этого 0.44.2, то есть та версия
приезжала не из этого репозитория (готовый бинарь с их сайта либо форк). На 0.42.4
`rtk hook claude` присутствует и сенсор `check-hook-topology` зелёный на всех трёх
настройках; если понадобится ровно 0.44.x — искать релизный zip, а не crates.io.
Вторая копия кладётся руками: `Copy-Item ~/.cargo/bin/rtk.exe ~/.local/bin/rtk.exe`.

**Лицензия движка:** v1.0.1 бандлит rtk-engine под BUSL-1.1, чей Additional Use Grant разрешает бесплатное продакшн-использование внутри бинаря `rtk` и запрещает предлагать его третьим сторонам как платный или хостед-сервис (engine/LICENSE на v1.0.1).

**Чего нативный rtk НЕ заменяет:** `rtk init --agent kimi` — это ИНСТРУКЦИИ (`AGENTS.md` + `RTK.md`), а не перехват (проверено 2026-08-05 на 0.44.2: help прямо говорит «no Claude hook patching»). `rtk init --codex` ставит PreToolUse-хук и инструкции (`~/.codex/hooks.json` несёт `rtk hook codex` рядом с нашим). Поэтому `codex-rtk-hook.mjs` остаётся: переписывает вызов у codex и, с 2026-09-14 (задача #1210), у grok (установщик пишет PreToolUse Bash в `~/.grok/hooks/booharness.json`; сенсор `grok/rtk-routing`). Warn-хук для kimi снят 2026-08-19: kimi не применяет `updatedInput`, поэтому хук мог только комментировать — семь строк would-deny за девятнадцать дней при PreToolUse на каждом вызове Bash. grok тогда сняли вместе с kimi; замер 2026-09-14 показал, что grok `updatedInput` применяет. Плюс `AGENTS.md` в этом репозитории — байтовое зеркало контракта, и писать в него установщиком стороннего инструмента нельзя.

**Форма TOML-хуков codex записана здесь, потому что она жила только в самом
конфиге и погибла вместе с ним 2026-08-11.** Источник — документация Codex
(`learn.chatgpt.com/docs/hooks`): массив таблиц плюс вложенный массив.
`install-harness.mjs` эти файлы намеренно НЕ переписывает (рядом лежат
креденшелы), поэтому установка ручная, а сенсор `check-hook-topology.mjs` с того
же дня краснеет, пока хуков нет.

**Строгое чтение этих конфигов раньше делал `svod hooks-topology --config <path>
[--runtime <id>]`, а не сам сенсор.** Построчный сканер TOML в node ошибся трижды
за четыре круга `harness-delivery-audit` — комментарий с именем скрипта давал
зелёный (r2), экранированный `#` обрезал строку и живой хук читался как
отсутствующий (r3), многострочное `"""`-значение уносило имя скрипта на строку
без `command =` и три подключённых хука читались как ноль (r4). Решение оператора
2026-08-11: менять инструмент, а не патч — TOML разбирает парсер TOML, тем же
инструментом, которым svod уже строго читал эти файлы в preflight.

Svod снят 2026-09-14 (заменён Paseo) и вместе с ним ушёл этот парсер: в дереве
нет зависимости для строгого чтения TOML, и `check-hook-topology.mjs` честно
пропускает эту часть проверки (`debt:` в коде) вместо того, чтобы вернуться к
построчному сканеру с уже измеренными дефектами. Матчер `domain-lessons-hook.mjs`
под `Bash` для kimi/codex остаётся непроверенным строго до тех пор, пока не
появится замена.

```toml
[[hooks.SessionStart]]

[[hooks.SessionStart.hooks]]
type = "command"
command = 'node "D:/Terminal/desktop/ops/bootstrap/session-start.mjs"'
timeout = 60

[[hooks.PreToolUse]]
matcher = "^(apply_patch|Edit|Write|NotebookEdit)$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = 'node "D:/Terminal/desktop/ops/bootstrap/domain-lessons-hook.mjs"'
timeout = 60
```

Путь ведёт в ОСНОВНОЙ чекаут, не в worktree: worktree удаляется, и хук вместе с
ним. **Codex не запустит хук, пока он не доверен** — команда `/hooks` в
интерактивной сессии, доверие пишется по хешу определения, то есть после каждой
правки блока его надо доверить заново. Для kimi форма пока не восстановлена
(своя CLI, конфиг после перелогина — пустая заготовка).

Старые destructive/secret/branch hooks — retired.

## Skills (allowed families)

### Установка из скила: скил — НЕ разрешение ставить (политика 2026-08-24)

Скил это документ, которому агент следует, поэтому команда установки внутри
скила — это установка на этой машине. Правило одно и короткое: **что ставится,
решает этот allowlist, а не текст скила.** Встретив в скиле `curl | sh`,
`pip install`, `uvx`, `npx <пакет>` или `docker run <образ>` без версии, агент
НЕ выполняет её молча — он спрашивает оператора, ровно как перед любой другой
установкой.

Вендоренные документы под это не форкаются. Их пришлось бы форкнуть и потом
вечно держать форк, а цена — расхождение с апстримом на каждом обновлении.
Вместо этого множество известных мест **посчитано и заморожено**:

```bash
npm run check:unpinned-installs        # ратчет; новая непинованная установка = красный
```

Двенадцать записей на 2026-08-24, `scripts/unpinned-installs.json` (not in this kit): три
`pip install`, три `uvx`, три `npx`, два `curl | sh`, один `wget` в
`/usr/local/bin`. Базлайн может только СОКРАЩАТЬСЯ — новая установка валит
проверку, а сознательно добавить запись можно только через `--write-baseline` с
объяснением в коммите.

Повод завести это появился из круга `skills-audit-r1` (2026-08-24), где пять
мест из пяти нашли `curl | sh` в референсе вендоренного скила по харденингу
контейнеров — того самого, который своим же правилом объявляет `curl | sh`
критическим. Сенсор нашёл на четыре места больше, чем круг, включая
`scripts/agent.py` в том же скиле: круг выбирает, сенсор перечисляет.

**Ложные срабатывания вырезаны по принципу, а не списком.** `npx <пакет>`, чей
пакет лежит в наших `dependencies`/`devDependencies`, разрешается из
`node_modules` и в сеть не ходит — таких было девять из тринадцати, почти все
`npx tsc --noEmit`, наш же канонический тайпчек. Сенсор читает package.json, а
не хранит имена. И строка, которая ЗАПРЕЩАЕТ форму, не считается её примером:
иначе правило «никогда не делай `curl | sh`» само зажигало бы проверку.


- **Project domain:** configure `.agents/domains/domain-*` for the adopted repository.
- **Project ops:** select methods from the adopted repository and its manifests.
- **Shipped skills:** select stack-specific methods only when the adopted project declares that stack.
  Upstream provenance and license files remain beside each vendored skill.
  - [`admit`](../../.agents/skills/admit/SKILL.md)
  - [`agent-input-safety`](../../.agents/skills/agent-input-safety/SKILL.md)
  - [`anti-slop`](../../.agents/skills/anti-slop/SKILL.md)
  - [`clickhouse-architecture-advisor`](../../.agents/skills/clickhouse-architecture-advisor/SKILL.md)
  - [`clickhouse-best-practices`](../../.agents/skills/clickhouse-best-practices/SKILL.md)
  - [`consolidate-memory`](../../.agents/skills/consolidate-memory/SKILL.md)
  - [`curate`](../../.agents/skills/curate/SKILL.md)
  - [`design-direction`](../../.agents/skills/design-direction/SKILL.md)
  - [`desktop-interaction-review`](../../.agents/skills/desktop-interaction-review/SKILL.md)
  - [`diagnosing-bugs`](../../.agents/skills/diagnosing-bugs/SKILL.md)
  - [`distill-skill`](../../.agents/skills/distill-skill/SKILL.md)
  - [`edit-contract-mirror`](../../.agents/skills/edit-contract-mirror/SKILL.md)
  - [`emil-design-eng`](../../.agents/skills/emil-design-eng/SKILL.md)
  - [`enumerate-cases`](../../.agents/skills/enumerate-cases/SKILL.md)
  - [`find-skills`](../../.agents/skills/find-skills/SKILL.md)
  - [`flaky-test-reproduction`](../../.agents/skills/flaky-test-reproduction/SKILL.md)
  - [`handoff`](../../.agents/skills/handoff/SKILL.md)
  - [`harness-economy-audit`](../../.agents/skills/harness-economy-audit/SKILL.md)
  - [`i-have-adhd`](../../.agents/skills/i-have-adhd/SKILL.md)
  - [`impeccable`](../../.agents/skills/impeccable/SKILL.md)
  - [`investigate-first`](../../.agents/skills/investigate-first/SKILL.md)
  - [`land-worktree`](../../.agents/skills/land-worktree/SKILL.md)
  - [`llm-grounding-audit`](../../.agents/skills/llm-grounding-audit/SKILL.md)
  - [`memory-domain-extraction`](../../.agents/skills/memory-domain-extraction/SKILL.md)
  - [`memoryctl`](../../.agents/skills/memoryctl/SKILL.md)
  - [`next`](../../.agents/skills/next/SKILL.md)
  - [`orch-team`](../../.agents/skills/orch-team/SKILL.md)
  - [`plan-before-code`](../../.agents/skills/plan-before-code/SKILL.md)
  - [`plan-critic`](../../.agents/skills/plan-critic/SKILL.md)
  - [`playwright-best-practices`](../../.agents/skills/playwright-best-practices/SKILL.md)
  - [`premortem`](../../.agents/skills/premortem/SKILL.md)
  - [`review-verification-protocol`](../../.agents/skills/review-verification-protocol/SKILL.md)
  - [`rust-async-rules`](../../.agents/skills/rust-async-rules/SKILL.md)
  - [`rust-code-review`](../../.agents/skills/rust-code-review/SKILL.md)
  - [`scout-request`](../../.agents/skills/scout-request/SKILL.md)
  - [`security-and-hardening`](../../.agents/skills/security-and-hardening/SKILL.md)
  - [`sensor-strength-audit`](../../.agents/skills/sensor-strength-audit/SKILL.md)
  - [`sepia`](../../.agents/skills/sepia/SKILL.md)
  - [`setup-routines`](../../.agents/skills/setup-routines/SKILL.md)
  - [`surgical-patch`](../../.agents/skills/surgical-patch/SKILL.md)
  - [`tauri-security-checklist`](../../.agents/skills/tauri-security-checklist/SKILL.md)
  - [`test-audit`](../../.agents/skills/test-audit/SKILL.md)
  - [`tester`](../../.agents/skills/tester/SKILL.md)
  - [`tokio-async-code-review`](../../.agents/skills/tokio-async-code-review/SKILL.md)
  - [`tokio-runtime-diagnostics`](../../.agents/skills/tokio-runtime-diagnostics/SKILL.md)
  - [`ui-ux-pro-max`](../../.agents/skills/ui-ux-pro-max/SKILL.md)
  - [`vercel-composition-patterns`](../../.agents/skills/vercel-composition-patterns/SKILL.md)
  - [`vercel-react-best-practices`](../../.agents/skills/vercel-react-best-practices/SKILL.md)
  - [`verify-and-stop`](../../.agents/skills/verify-and-stop/SKILL.md)
  - [`verify-change`](../../.agents/skills/verify-change/SKILL.md)
  - [`visual-critique`](../../.agents/skills/visual-critique/SKILL.md)
  - [`vitest`](../../.agents/skills/vitest/SKILL.md)
  - [`web-search`](../../.agents/skills/web-search/SKILL.md)

## Where the config lives

The source of truth is in this repository, under `ops/bootstrap/`. Everything in
a runtime's home directory is **generated** from it:

| Source (edit here) | Renders into |
|---|---|
| `ops/bootstrap/mcp-servers.json` | each runtime's MCP config (JSON or TOML) |
| `ops/bootstrap/agent-instructions.md` | each runtime's global rules file |
| `.agents/skills/` | each runtime's `skills/` (directory junctions) |

Installers: `install-harness.mjs`, `install-harness.mjs`, `install-harness.mjs`.
All three are idempotent and safe to re-run.

### Runtime homes (there are seven, and they are not interchangeable)

| Runtime | Home | Notes |
|---|---|---|
| Claude | `~/.claude` | |
| Codex | `~/.codex` | rules file is `AGENTS.md` |
| Grok | `~/.grok` | scans for `Agents.md`/`Claude.md`/`AGENT.md`/`AGENTS.md`; 10k char cap |
| Kimi | `~/.kimi-code` | `AGENTS.md` + `mcp.json` |
| GLM worker | `~/.glm-worker-config` | used by `.claude/scripts/glm.sh` |
| GLM lead | `~/.glm-lead-config` | used by `.claude/scripts/glm-lead.sh` — the interactive lead |
| zcode | `~/.zcode` | the GLM desktop GUI |

The three GLM homes are separate on purpose; configuring one does not configure
the others. Each path above was read out of the launcher that uses it.

### Repo-local

| File | What | Git |
|---|---|---|
| `.mcp.json` | live project MCP incl. secrets | **gitignored** |
| `.mcp.json.example` | template | committed |
| `docs/agent/harness-allowlist.md` | this doc | committed |

## Change control

1. Edit the source in `ops/bootstrap/` (and this doc, if the policy itself moved).
2. Re-run the installer(s). They cover all seven runtimes in one pass.
3. Restart the affected runtime so it re-reads its files.
4. Verify by *asking the runtime*, not by reading the file you just wrote: have it
   name the tool it would use for Rust versus TypeScript and quote where it
   learned that. A file on disk proves nothing about what the agent loaded.

Never hand-edit an installed copy: it is overwritten on the next run and lost on
the next machine. `~/.claude/allowlist-toolset.json` is a leftover from the
pre-bootstrap workflow and is **not** authoritative; `ops/bootstrap/` is.

### Why this matters (2026-07-25)

Configuration that lived outside git, or was duplicated in a second place, broke
in four separate ways on one machine — each invisible from inside a session:

- `.agents/skills/*` was blanket-ignored with a two-entry allowlist, so 10 of 58
  skills never survived a clone.
  send Rust questions there.
- `~/.zcode/skills` symlinked into `~/.claude/skills`; pruning that directory left
  18 of 60 links dangling, and the GUI still advertised the dead skills.
- A retired proxy left `ANTHROPIC_BASE_URL` pointing at a dead port, so every new
  Claude session failed to start.

Hence: one source, generated outputs, and verification by asking the agent.
