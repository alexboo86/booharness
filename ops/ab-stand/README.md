# Fixed A/B stand (task 1452)

The stand is **Pi in isolated profiles**, not a change to the live worker setup.
Every arm lives in `~/.local/state/orch/ab-stand/arms/<arm>/`. Orch validates
`standArm` at `seat_create`, stores the identifier (never a caller-supplied path),
and passes `PI_CODING_AGENT_DIR`, `PI_PACKAGE_DIR`, session/cache paths and a
stand HOME only to that seat. Omitted `standArm` leaves stock seat context and
SessionSpec env unchanged. Pi strips inherited Pi directory and stand-arm
variables before applying this seat's own env. The stand config has
`pi-mcp-adapter@5.3.2` (exclusive discovery), the baseline codegraph/memoryctl
servers and a **copy** of the rtk Pi extension; RTK is never an arm. Auth is a
private `0600` snapshot into the stand profile, never a symlink or committed. Install and each cell replace it from **live** Pi auth: API-key
entries are unchanged; OAuth access tokens are copied but all refresh grants
are removed (Pi requires an empty `refresh` string). The runner skips an OAuth
cell if the live access token expires before its timeout plus a 1-minute margin;
refresh it from a live seat first. Stand sessions cannot rotate live grants.
Install and each cell also copy a present live `models-store.json` into the arm so offline Pi uses the current catalog without running an update.
Only the stand-root directory contains third-party binaries, models, caches,
transcripts and tool-delivery proofs. No `npm -g`, `npx` server, Pi `--local`,
installer into `~/.pi` or changes to the live orch Pi profile.

Install on this Mac (`node` 22.13+, `uv`, `npm` already on PATH; Pi comes from
the pinned `ops/pi-runtime` install, never from PATH: `npm ci --prefix ops/pi-runtime`):

```sh
node ops/ab-stand/install.mjs --all
# Or install one profile: node ops/ab-stand/install.mjs context-mode
node ops/ab-stand/smoke.mjs --arm context-mode
```

The installer is idempotent, pins `pi-mcp-adapter@5.3.2`,
`context-mode@1.0.169` (Elastic-2.0), `pi-condense@2.10.6` (MIT),
`codebase-memory-mcp@0.11.0` (MIT), `open-codebase-index@0.32.1` (MIT),
`pi-hashline-edit-pro@4.4.4` (MIT), `pi-hashline-edit-pro@4.5.1` (MIT) with its
peer `typebox@1.3.34`, `billion-context-pi@0.1.82` (MIT),
`pi-dynamic-context-pruning@0.1.10` (MIT),
`@probelabs/probe@0.6.0-rc339` (ISC),
`openviking==0.4.22` (AGPL-3.0, PyPI wheel for macOS arm64),
`sleev@1.8.5` with its `sleev-darwin-arm64@1.8.5` platform package (proprietary,
Sleev Labs Inc: `SEE LICENSE IN LICENSE.md` plus `EULA.md`; not open-source),
`@maxiaochao/pi-toolkit@0.9.3` (package license undeclared in the published
manifest; no root LICENSE in the 0.9.3 tarball, so not assumed MIT), `aider-chat==0.86.1` (Apache-2.0) and
Serena at git commit
`949a27ef1e5fda1a6e7b561e777bcece345c6ffd` (the resolved `v1.7.0` tag;
readiness checks the installed commit and 1.7.0 metadata). Upstream tag/PyPI declare
MIT; the older GPL-3.0 decision was explicitly lifted
by operator #10695. `uv python install 3.12` uses `UV_PYTHON_INSTALL_DIR`
inside the stand root and `uv venv` creates per-arm environments. On this
macOS 27 machine aider's required scipy 1.15.3 wheel fails to load
(`__thread_bss` offset). The installer overrides it **in this venv only** with
scipy 1.16.2, which produced a real repo map; `uv pip check` will report the
upstream exact-pin mismatch. Aider's read-only seat permits only the exact
`aider --show-repo-map` command, disables startup updates/gitignore changes,
and uses a real model name for metadata; the inspect-and-exit command makes no
LLM request. Other aider commands remain refused to scouts.

The `hashline-edit` arm installs `pi-hashline-edit-pro@4.4.4` with
`npm install --ignore-scripts --no-audit` at the exact version into the arm's
own Pi package directory (declared in the arm settings); it never touches the
stock Pi profile or `~/.pi`. The arm env sets `PI_HASHLINE_DIR` under
`arms/hashline-edit/hashline` for the package's config, SQLite hash store and
session claims. `rg` must already be on PATH: install and smoke both refuse
otherwise, because the package would download a ripgrep binary at runtime.
The extension replaces `read` with `anchor│content` rows and disables the
built-in `edit` tool. Its default swaps `grep` for `anchor_grep`, which no role's
`--tools` list grants, so the arm writes `hashline/config.json` with
`anchorGrepEnabled: false` and keeps the built-in `grep` working for every role;
smoke proves the replaced `read` by requiring those anchor rows in its
successful result.

The `hashline-edit-451` arm installs `pi-hashline-edit-pro@4.5.1` beside
4.4.4 under the same audit conditions, with the version selected per arm and
`pi-mcp-adapter@5.3.2` named in the same npm command. 4.5.1 moved `typebox`
to a peer dependency (`*`), which `--legacy-peer-deps` never installs, so
`typebox@1.3.34` is pinned explicitly in that command and checked after
install and at readiness. Its new copy/move tools stay out of the trial: the
arm writes `hashline/config.json` with `copyMoveEnabled: false` and
`anchorGrepEnabled: false` (booleans), readiness requires both, and that
config file joins the arm's profile hash. The arm gets its own
`PI_HASHLINE_DIR` (`arms/hashline-edit-451/hashline`), never shared with
4.4.4: the 4.5.1 hash store is version 9 and deletes undo and snapshots when
it opens a version 8 store. Smoke proves the replaced `read` by its anchor
rows and, through a smoke-only observer extension removed in `finally`, that
`copy`, `move` and `anchor_grep` are absent from the session's active tools.


The `sol-pi` arm (operator #13470, outside `MATRIX_ARMS`) loads the Pi extension
github.com/NVlabs/SoL-Pi (MIT) with only Action Fusion and ObservationPack on. Upstream
publishes no npm package, so the pin in `ops/ab-stand/sol-pi.json` is one commit
(`e1a586af0ad8956f42ae5b26bba20e48fbf30e00`): install fetches that commit alone with
`git fetch --depth 1`, with no user or system git config and no hooks, checks it out
into `arms/sol-pi/sol-pi`, and refuses unless `HEAD` is the pin and the tree is clean.
No npm and no lifecycle script runs; Pi supplies its SDK and `typebox` to the extension.
Settings load it as a local package filtered to `src/sol-pi/index.ts`. The config is
`arms/sol-pi/agent/sol-pi.json` (the Pi agent dir; a project `.pi/sol-pi.json` would need
a trusted project), with the reducer and Online Context Compact off. The commit is in
`install.json` and the config file joins this arm's profile hash. Action Fusion
re-registers `edit` and `write` under their built-in names with an optional `then_run`
command; ObservationPack adds `obs_recall`, which every access level of this arm expects.
Readiness starts Pi in RPC mode with stdin closed (no model call) and requires `edit`,
`write` and `obs_recall` active and `then_run` on both edit tools; upstream tests on
Pi 0.85.1, and this check is what proves the load on the installed Pi. `then_run` runs
inside the tool, with no `bash` tool call: orch applies its bash refusals and timeout cap
to it, the verify loop counts a succeeded allow-listed `then_run` as the check, and RTK
does not rewrite it. Smoke proves one fused `edit` by its `[then_run:succeeded]` marker,
on codex `gpt-6.1-sol`: `qwen3.8-flash` sent `then_run` as a JSON string in 5 of 5 calls
and Action Fusion's schema refuses anything but an object.

The `hashline-edit-500` arm installs `pi-hashline-edit-pro@5.0.0` the same way,
beside the unchanged 4.4.4 and 4.5.1 arms. Pins are `ops/ab-stand/hashline-edit-500.json`
(npm sha512 `sha512-uDFXXzITMNbIjPhiqId6BqLf5VAH6WepEMhfXIrOKsUyY6tumIeZOv9LhXwoLKQJ9RLqmzUiSzpeim42Xp6KQQ==`,
`typebox@1.3.34`). The npm command still names `pi-mcp-adapter@5.3.2` and requires `rg`.
5.0.0 keeps store version 9 and `PI_HASHLINE_DIR`, and still gets its own directory
(`arms/hashline-edit-500/hashline`). It registers `replace_within` only when
`replaceWithinEnabled` is boolean true, so the arm writes that flag true next to
`copyMoveEnabled: false` and `anchorGrepEnabled: false`. Readiness requires the true flag
and the two false flags, and that config joins this arm's profile hash only. Smoke uses
`zz-hashline-500-smoke.js` and proves `replace_within` present and `copy`, `move` and
`anchor_grep` absent, and the replaced `read` by its anchor rows. A full-access seat on
this arm expects `replace_within`, and the verify loop treats it as a mutating edit only
for this arm.
The `billion-context` arm installs `billion-context-pi@0.1.82` (MIT) the same
way, into the same arm-local prefix, and names `pi-mcp-adapter@5.3.2` in that
npm command: every install into the shared Pi prefix retains the exact pin; a second
npm install would re-resolve it to a newer minor that readiness refuses. The
arm env sets `ACP_AUTO_UPDATE=0`, because the package otherwise runs
`npm view`/`npm install` against its own install at session start. Its
`acp_delegate` child is spawned with the parent's `process.env`, so it keeps
the arm's `HOME`, `PI_CODING_AGENT_DIR` and `ACP_AUTO_UPDATE`. Read-only seats
on this arm additionally get `compress`, `decompress`, `search_context` and
`acp_status` (session tools; `decompress` writes files only under the temp dir
or the arm's `~/.cache/pi`); `acp_delegate` is not granted to them, since its
child runs without orch's read-only guard. Smoke proves the extension by a
no-argument `acp_status` whose result carries the `CONTEXT BREAKDOWN`
overview; a stood-down extension answers with its refusal text instead.

The `context-pruning` arm installs `pi-dynamic-context-pruning@0.1.10` (MIT) the same
way, into the arm's own prefix, and names `pi-mcp-adapter@5.3.2` in that npm command.
Pins are `ops/ab-stand/context-pruning.json` (npm sha512
`sha512-0FoTqkS2evBRcRVFGLf3WoadD6wKB+UtEzQrcOySdcbgDO18uvhPdbiqfSVTdZfqYKZrZJ95naGHLlllAs7eVQ==`).
Install downloads the registry tarball, refuses a mismatched `dist.integrity`, and hashes
the bytes before npm sees them (`--ignore-scripts --no-audit`). Readiness refuses any other
package version and a missing integrity pin. The extension adds no tool and removes none
(stock `read`, `grep`, `edit` and `bash` stay). It hooks `context`, `session_start` and
`session_tree`, and registers `/prune` and `/context-pruning`. Smoke proves it loaded and
active in the arm session: both commands come from `pi-dynamic-context-pruning`, and after a
real turn `/context-pruning status` is handled and reports `Dynamic context pruning: ENABLED`
plus a `Last call: raw=` snapshot. A package that is only installed does not handle the
command; a stood-down config does not report ENABLED with a snapshot.

### agent-lsp (operator #13197)

The `agent-lsp` arm is an isolated, stdio MCP code-intelligence server, not a Pi
extension. Pins live in `ops/ab-stand/agent-lsp.json`: scoped npm package
`@blackwell-systems/agent-lsp@0.21.0`, its native
`@blackwell-systems/agent-lsp-darwin-arm64@0.21.0` binary,
`typescript-language-server@5.0.0` and `typescript@5.9.3`. The unrelated bare
`agent-lsp` npm name is a placeholder and is never installed. This profile is
macOS arm64 only. Each tarball's registry `dist.integrity` and actual sha512
bytes are verified before `npm install --ignore-scripts --no-audit`, in the
arm's separate `npm` prefix (not Pi's adapter prefix). Readiness checks every
version and recorded integrity, the exact MCP config and the local executables.
No `agent-lsp init`, global install, downloaded skills or paid keys are needed.

The server uses the arm's HOME, cache and temp directories. Only navigation,
symbol and diagnostic tools are exposed; disk edits, build/test tools and skill
workflows are excluded. This allowlist is not an OS sandbox. Smoke opens this
repository's `ops/orchestrator/src/stand.ts` and requires a successful
`list_symbols` result containing the `isStandArm` symbol, plus the RTK proof.
Install and smoke remain operator-run, quota-approved commands:

```sh
node ops/ab-stand/install.mjs agent-lsp
node ops/ab-stand/smoke.mjs --arm agent-lsp
```

The `probe` arm installs `@probelabs/probe@0.6.0-rc339` (ISC) into the arm's own npm prefix
(not the Pi package prefix) and registers it as an MCP server the way `serena` and
`codebase-memory-mcp` do: command is the arm-local `probe` shim, args `mcp --timeout 90`,
`inheritEnv: false`, `lifecycle: lazy`. Pins are `ops/ab-stand/probe.json`. Install downloads
the registry tarball, refuses a mismatched `dist.integrity`, and hashes the bytes before npm
sees them. It copies the root manifest and committed npm v3 `ops/ab-stand/probe.lock.json`
into the arm prefix and runs `npm ci --ignore-scripts --no-audit`, fixing registry
dependencies by version and sha512 and `@nyariv/sandboxjs` by git commit. Install
refuses a missing lock or a top-level version/integrity different from the pin.
The package `postinstall` extracts a bundled
binary or, if that fails, downloads one from GitHub; this arm never runs that script.
It extracts the bundled `aarch64-apple-darwin` archive and refuses any other sha256 than
`c2db3416997099ff81963da8b1185298054fbd675f42a98d39617b42e0e39c34`. Readiness refuses any
other package version, integrity pin, binary hash, or MCP entry. `PROBE_PATH` points at
that binary so a missing file cannot fall through to a download. The arm adds no stock
tool and removes none; it turns codegraph off so the trial measures probe against base.
Smoke proves one `search_code` call from the probe server against this repository
(path is the checkout root; the result must name `standDirectory` in `ops/ab-stand/arms.mjs`),
not the disposable fixture. npm also fetches the package's git dependency
`@nyariv/sandboxjs`; the MCP search path does not import it.
When the Probe pin moves, generate a fresh lock in an empty scratch directory:
write a private `package.json` with `dependencies: {"@probelabs/probe": "<new pinned version>"}`,
run `npm install --package-lock-only --ignore-scripts --no-audit`, review the resolved
versions/integrities and git commit, and copy `package-lock.json` to
`ops/ab-stand/probe.lock.json` alongside the updated `probe.json`.

The `gitnexus` arm installs `gitnexus@1.6.12` (PolyForm-Noncommercial-1.0.0, evaluation-only; not a stock seat loadout) as an MCP server in the arm's own npm prefix, never `~/.pi`. Pins are `ops/ab-stand/gitnexus.json` (npm sha512 `sha512-Wz++hOW73SkluTkQLJbRIT8+IW649Kmf4mI+99ZxzcQg2Nl47sSjlfe89NN/q0uutGTvbVeXaYMHRDSznDsk5g==`). Install downloads the registry tarball, refuses a mismatched `dist.integrity`, hashes the bytes before npm sees them, then copies the root manifest and committed npm v3 `ops/ab-stand/gitnexus.lock.json` into the arm prefix and runs `npm ci --ignore-scripts --no-audit`. Every registry dependency is fixed by version and sha512; install refuses a missing lock or a top-level version/integrity different from the pin. Readiness refuses any other package version and a missing integrity pin. The server is `gitnexus mcp` in the arm `mcp.json`, with `GITNEXUS_HOME` and `GITNEXUS_STORAGE_ROOT` under `arms/gitnexus/gitnexus` so the index is never written into the repository. `analyze --index-only` skips AGENTS.md, CLAUDE.md and skill injection, and the indexer refuses if `git status` changes. `GITNEXUS_MCP_READ_ONLY=1` keeps mutating GitNexus tools out of the trial. `GITNEXUS_NO_UPDATE_NOTIFIER=1` stops the update check. Smoke indexes this repository into the arm state directory, then proves one `query` call for `standEnv` succeeds in the arm session. It is outside `MATRIX_ARMS`.
When the GitNexus pin moves, generate a fresh lock in an empty scratch directory:
write a private `package.json` with `dependencies: {"gitnexus": "<new pinned version>"}`,
run `npm install --package-lock-only --ignore-scripts --no-audit`, review the resolved
versions/integrities, and copy `package-lock.json` to `ops/ab-stand/gitnexus.lock.json`
alongside the updated `gitnexus.json`.

The `jcodemunch` arm installs PyPI `jcodemunch-mcp==1.108.320` (jCodeMunch-MCP Dual-Use License 1.1, effective 2026-06-30, copyright 2024-2026 J. Gravelle) the way `serena` does: `uv python install 3.12`, an arm-local venv, and a lazy MCP server in that venv. Pins are `ops/ab-stand/jcodemunch.json` (wheel sha256 `658ccb0a902b5ae3010fccf403a86973291fc65040d180bb5d98ffe561ecca3e`). Install checks the PyPI file URL and digest, hashes the wheel before `uv pip` sees it, and installs `jcodemunch.requirements.txt` with `--require-hashes --no-deps`: the top-level package and all transitive dependencies have exact versions and sha256 hashes. A missing lock file or a top-level version differing from the JSON pin refuses installation before arm state changes. Readiness refuses any other version and a missing integrity pin. `CODE_INDEX_PATH` and `XDG_CACHE_HOME` are inside the arm state directory; the installer does not run `jcodemunch-mcp init` and does not write `.jcodemunch.jsonc` into the repository. The server is `jcodemunch-mcp serve --transport stdio --watcher false`. Savings upload, AI summaries, perf telemetry and remote summarizers are opted out (`JCODEMUNCH_SHARE_SAVINGS=0` and the matching flags). No stock tool is removed. `codegraph` is off on this arm only, as on the other code-index arms. Smoke proves one `jcodemunch_index_folder` call with `success: true` against this repository's `ops/ab-stand` (small enough for the smoke timeout; the index still lands under the arm, not in the tree).

When the `jcodemunch.json` pin moves, regenerate the committed lock on Darwin
arm64 for Python 3.12 from the repository root:
`node -e 'const p=require("./ops/ab-stand/jcodemunch.json"); console.log(p.package+"=="+p.version)' | uv pip compile --python 3.12 --python-platform aarch64-apple-darwin --generate-hashes - -o ops/ab-stand/jcodemunch.requirements.txt`.
Review all changed versions/hashes and verify a fresh scratch venv install with
`uv pip install --python <scratch-venv>/bin/python --require-hashes --no-deps -r ops/ab-stand/jcodemunch.requirements.txt`;
compare `uv pip freeze --python <scratch-venv>/bin/python` with the lock's exact package set.
Licence (wheel `licenses/LICENSE`, Dual-Use 1.1): free for personal, academic, research, or other non-commercial use, including this stand (operator #13163). Commercial use — a for-profit organization, a product or service offered for a fee, or internal tooling that supports revenue — needs a paid license (Builder $79, Studio $349, Platform $1,999). Copies must keep the copyright and attribution notices, must not rename or rebrand the software, and must not be published to a public package registry. The software is provided "AS IS" without warranty. This arm does not modify or republish the package.

The `openviking` arm installs PyPI `openviking==0.4.22` (AGPL-3.0, ByteDance) in
the serena uv shape: pinned Python 3.12, its own venv inside the arm, and the
macOS arm64 wheel whose sha256 is verified against `ops/ab-stand/openviking.json`
before `uv pip install` ever sees it (install.mjs refuses a registry digest that
differs from the pin). Readiness refuses any other package version, a missing
wheel-hash pin, or a moved MCP URL. The arm loads no Pi package: its profile adds
a URL MCP entry (`http://127.0.0.1:11497/mcp`) for the openviking server that
`smoke.mjs` and `run.mjs` start under `withOpenVikingServer` for exactly their
duration — the server and the stand Ollama both stop in `finally`, so no
long-lived process remains and the port never serves outside a smoke/run. All
state (venv, `ov.conf`, `ovcli.conf`, the `openviking/data` workspace, caches)
stays under `arms/openviking/`. Models come only from the stand's Ollama on
`127.0.0.1:11498`: embeddings reuse the verified `nomic-embed-text:v1.5`
(dimension 768) and the chat model is `qwen3:4b`, pulled once and pinned by its
manifest sha256 `359d7dd4…`; `ov.conf` names no cloud key or hosted endpoint.
The VLM uses LiteLLM's `ollama_chat/` route (native `/api/chat`), disables
thinking, and writes Qwen's non-thinking sampling profile into `ov.conf`:
temperature 0.7, top-p 0.8, top-k 20 and min-p 0, retaining OpenViking's
16384-token context. The previous `ollama/` route used `/api/generate` with
the default greedy temperature 0.
Before each session the runner drops the previous cell's imported trees and
imports the checkout with `ov add-resource … --parent viking://resources --wait`
(`indexWithOpenViking`), so a cell sees exactly its own repository — count the
local embedding/VLM indexing time separately, as for OCI. Smoke proves one real
openviking tool call: the seat's `openviking_grep` over `viking://resources`
returns the fixture's `greet` definition, recorded in `delivery.json` against
the profile hash.

Import timing is a pilot feasibility gate, not something to conceal with a
larger timeout. In OpenViking 0.4.22, Rust CLI local-file/directory imports use
a size-derived HTTP timeout (minimum 60 seconds), overriding `ovcli.conf.timeout`;
`ov config show` reporting 300 seconds did not prevent a 60.1-second timeout.
The one-file, 57-byte fixture incurred a 134-second VLM call with the original
profile. A chat/temperature-0.7 comparison completed its import request in
53.3 seconds, but another observation needed 181 seconds for one overview and
still had two running jobs after 304 seconds. These are request/model timings,
not proof that every background job finished. A checkout count found 10025
tracked files, 8253 non-hidden files, 881 non-hidden directories and 810 Markdown
files. At 52–181 seconds per directory overview, 881 directories project to
roughly **13–44 hours**, before additional Markdown processing. This is an
extrapolation, not a full-checkout benchmark; do not treat this arm as pilot-ready
without a measured end-to-end import.
Both subsequent smoke attempts still hit the 60-second import timeout, including
the complete sampling profile on a fresh workspace (the prior workspace was
preserved). Neither reached the paid seat turn. After the timeout, graceful
server shutdown continued waiting on processing and was manually terminated;
the sampling correction is not a verified smoke fix.

The install uses `openviking.requirements.txt` with `--require-hashes --no-deps`,
including the top-level package and every transitive dependency. A missing lock
file or a top-level version differing from `openviking.json` refuses installation
before arm state changes. When that JSON pin moves, regenerate the committed
lock on Darwin arm64 for Python 3.12 from the repository root:
`node -e 'const p=require("./ops/ab-stand/openviking.json"); console.log(p.package+"=="+p.version)' | uv pip compile --python 3.12 --python-platform aarch64-apple-darwin --generate-hashes - -o ops/ab-stand/openviking.requirements.txt`.
Review all changed versions/hashes and verify a fresh scratch venv install with
`uv pip install --python <scratch-venv>/bin/python --require-hashes --no-deps -r ops/ab-stand/openviking.requirements.txt`;
compare `uv pip freeze --python <scratch-venv>/bin/python` with the lock's exact package set.

The `sleev` arm (operator #13197) installs `sleev@1.8.5` plus its
`sleev-darwin-arm64@1.8.5` platform package (proprietary, Sleev Labs Inc;
`SEE LICENSE IN LICENSE.md`, `EULA.md`) into the arm's root npm prefix — the one
standEnv puts first on the seat PATH — from two tarballs whose published
`dist.integrity` is checked against the registry metadata and hashed again
before npm sees them (`--ignore-scripts --no-audit`); both are named in one npm
command so the wrapper's `sleev-darwin-arm64` optional dependency resolves to
the verified tarball, never the registry. Readiness re-hashes the installed
gateway binary (sha256 pinned in `ops/ab-stand/sleev.json`), refuses any other
version, any extra `sleev-*` platform package, a missing arm-home LaunchAgent
plist, or an `agent/models.json` without the Qwen pilot provider routed through
sleev on `127.0.0.1`. Install verification runs after `install.json` is written,
so the recorded wrapper/platform/binary pins are checked, not bypassed.
Local mode is forced, account-free: a signed-out `sleev setup --yes` accepts
the guest legal terms without a prompt, writes the gateway config under the
arm HOME and starts the gateway. Setup alone does not configure Pi: the installer
then runs `sleev harness pi enable qwen-token-plan` with the same arm HOME and
`PI_CODING_AGENT_DIR`. Sleev 1.8.5 calls Bailian `qwen-token-plan`; the installer
also applies that generated gateway override to `qwen-token-plan-individual`,
the provider orch selects for the `qwen` pilot, preserving existing provider
fields and headers. `sleev harness pi list` shows the CLI-supported provider.
The stand never signs in, creates an account
or sends repository content to the vendor (conversation content transits the
local gateway by design, and in guest mode the vendor control plane sees usage
counters). Update checks are closed by pointing `SLEEV_NPM_REGISTRY` and
`UPDATES_BASE_URL` at an unreachable local endpoint (`SLEEV_CHANNEL=stable`,
`SLEEV_TUI_GRAPHICS=text` for headless smoke); no other telemetry endpoint was
observed in the 1.8.5 binary beyond the guest control calls (its session
charts are a local database). Licence: proprietary — the Sleev Terms and EULA
govern (package ships `LICENSE.md`, `EULA.md`, `THIRD_PARTY_NOTICES.md`).
Network destinations the tool contacts: `api.sleev.ai` (control: guest
preflight, legal acceptance, usage — required by guest mode), `api.workos.com`
and `securetoken.googleapis.com` (sign-in paths only; this arm never signs
in), `sleev.ai` including `/install.sh` (docs, pricing, installer),
`storage.googleapis.com/sleeve-releases` and `registry.npmjs.org` (self-update,
closed off by the arm env), `models.dev/api.json` (pricing metadata), plus the
model-provider endpoints the gateway proxies for Pi. The gateway runs as a
macOS LaunchAgent whose plist lives under the arm home, but launchctl
registration is per-user: roll back with `sleev gateway stop` (or `launchctl
bootout`) before removing the stand root. Smoke proves the arm session active:
the seat calls `sleev gateway status` over bash and the recorded output must
carry the pinned version and a running gateway.

Open-codebase-index needs embeddings: the stand installs Ollama `v0.34.3` and
its verified `nomic-embed-text:v1.5` model under the stand root. Its local
server listens only on `127.0.0.1:11498` **while an OCI smoke/run is active**
and is stopped in `finally`. The indexed fixture yields a real `codebase_context`
result, not a zero-valued fallback. This is a separate intervention from the
other code-intel arms; count model/index startup separately. The runner
pre-indexes the scout checkout; a coder's separately provisioned worktree still
needs explicit index preparation before claiming comparable coder measurements.
Generated `.codebase-index/`, `.serena/`, and aider cache files in scratch
checkouts belong to the stand, not an implementation diff.

`smoke.mjs` starts a **real Pi RPC session through orch's provider adapter**
(Pi extension and guard included), read-only except for the codex-edit arm's
full-access disposable fixture edit; this is not a scored matrix repetition.
The codex-edit arm loads only `extensions/codex-edit/index.ts` using a plain
include filter, with no toolkit skills, prompts or themes. Readiness and smoke
use Pi's own resource resolver to enforce that isolation. Its adjacent arm-local
config permits only `gpt-6.1-sol`; smoke restores the fixture in `finally`.
Smoke makes model turns and requires quota approval.
It checks command registration, the distinctive tool's actual successful
result and the actual `rtk ...` command; it records proof in
`arms/<arm>/delivery.json`, tied to the profile hash. `pi-condense` is enabled
via `contextPrune.enabled=true`, and `context_tree_query` must respond; a short
smoke is not proof of token savings. `arms.mjs` refuses a third-party arm
without its pinned local package, MCP registration where relevant, and delivery
proof; it never consults the live Pi MCP config.

## Before a pilot (operator #13312)

A pilot starts only after four checks; a pilot that fails one is reported as
"invalid, no result", never as "no effect":

1. The fixture needs the tool: a navigation or search tool runs on the scout
   fixtures, not on an edit fixture that names the file to change.
2. The seat is told the tool exists: the arm's `hint` (`arms.mjs`) is appended
   to the brief.
3. The control differs from the challenger only by the treatment: compare the
   copied Pi runtime version, settings, extensions and `mcp.json` of both arms.
4. A trial cell shows the tool in use: `armToolCalls` above zero on the first
   finished challenger cell before the other cells run (nothing stops an arm
   at zero automatically: the lead checks it).

## Step 3 matrix (operator #10721; do not start before approval)

```sh
node scripts/test-ab-stand.mjs
node ops/ab-stand/run.mjs --families kimi,grok,glm,codex --dry-run
# Only after inspecting the guard verdicts and the live daemon's standArm support:
node ops/ab-stand/run.mjs --families kimi,grok,glm,codex --budget kimi=+5 --dry-run
# Once approved: same command without --dry-run (optionally --reps 1).
# Optional per-run cap override: --token-cap 500000 (also supported with --dry-run).
# Resume with --budget kimi=+5 unchanged after the vendor quotas refresh.
```

The full plan is **64 cells**: two short tasks (`scout-short`, `coder-short`)
× `{base,no-codegraph,pi-condense,context-mode,aider-repo-map,serena,
codebase-memory-mcp,open-codebase-index}` × four families. Each family uses
its vendor model on the **same pinned fixture commit**
`5e77e0a9a287997128a35eea2b2ec5b5b4d5b9df`; arm comparisons are
within one family, never a cross-vendor model claim. In the matrix the `base`
seat turns off codegraph, ast-grep and memory; RTK remains on. The
`no-codegraph` arm enables ast-grep only; every other challenger enables only
its named stand package/server. This overrides the step-2b all-on control
semantics **for matrix seats only**, without changing installed profiles or
stock seats. Scout questions use the
read-only researcher seat because the shared role matrix does not offer a scout
seat for kimi/glm/codex; coder uses the coder role. All four families use low
effort (explicit for kimi). Family is explicitly passed to `seat_create`, so
orch's automatic pace chooser cannot substitute another model. Cheapest work
comes first: short read-only task before coder, baseline before replacements,
embedding/index startup last. OCI's *coder* worktree is indexed after its own
provisioning, not by assuming the indexed scout checkout transfers.

For each **actual** cell the runner reads that family's vendor usage endpoint
before creating a seat **and again after provisioning, immediately before the
prompt** (no stale cache). A paused orch family is skipped, never forced through.
Unknown credentials/window/reset, ahead-of-linear-pace
weekly/monthly budget, ≥85% long-window use, or any shorter window above orch's
95% throttle **skip the family**, with reason recorded. For the operator-approved
Kimi exception, `--budget kimi=+5` substitutes a fixed ceiling (first fresh 7d
reading + five percentage points) for the ahead-of-pace test **only**. The start
reading, 7d reset and ceiling are stored as a `budget-start` result before any
cell runs; a resume reuses them and refuses a changed allowance or reset.
The 5h throttle, ≥85% weekly stop, and per-run token cap still bind. Dry-run
shows the proposed or stored ceiling without appending results. Grok at 94%
waits for its weekly reset. A short turn gets 2 minutes and a default 400,000-token
**per-run cumulative** input+output+cacheRead cap (`--token-cap N` overrides it;
256–1,000,000). Cache-read counts repeat on each assistant message: a measured
short review turn with two tools used ~65k total, and a 12-call bughunt ~345k;
12k capped ordinary cells before they could finish. Pi aborts after a response
reaches the cap (one response can overshoot; this is not a vendor-side reservation).
No more than two runs per
family occur in one invocation; the remainder are deferred for an explicit
resume and a fresh quota reading. Missing usage is *not* zero. `--dry-run`
prints every cell's guard verdict without making seats or appending results.

Rows append to ignored `results/YYYY-MM-DD.jsonl`. A recorded terminal cell
(`done`, `capped`, genuine task `error`) with identical fixture and arm-profile hashes,
family, arm, model, effort and caps is not repeated; skipped/deferred cells
are reconsidered after refresh. OAuth-refresh and provider-unavailable/capacity
failures use nonterminal `retryable` rows; historical `error` rows with those
failures are also retried on resume. Completed/capped rows retain the stand session
JSONL path, actual tool calls with success markers, actual RTK commands, arm
activation proof path/hash, input/output/cache-read tokens (unknown stays null),
guard reading and score. Early errors retain a path if available, not invented
proof.
A cap is stored as `capped` with zero score. A missing or out-of-stand transcript
is an error, **not** a silently scored success. Scout score checks pinned-fact
citation precision; coder score needs a named passing TAP test and only owned
implementation/test paths (known stand-created `.codebase-index/`, `.serena/`
and aider cache paths are excluded, not implementation edits). `seat_close` runs in
`finally`; if closing cannot be proved, both disposable checkouts are retained
for manual recovery rather than deleted beneath a live seat. Otherwise cleanup
runs there too. No commit or memory write. A listed tool alone does not prove delivery; a
short pi-condense turn does not prove token savings.

## Guarded edit pilots (task 1868; operator #13099)

```sh
node ops/ab-stand/run.mjs --pilot codex-edit --reps 1 --dry-run
node ops/ab-stand/run.mjs --pilot hashline-edit --reps 3 --dry-run
node ops/ab-stand/run.mjs --pilot hashline-500 --reps 1 --dry-run
# Only after inspecting the guard verdicts, and on operator approval (it spends vendor quota):
node ops/ab-stand/run.mjs --pilot codex-edit --reps 3
node ops/ab-stand/run.mjs --pilot hashline-edit --reps 3 [--pace-override "<operator reason>"]
```

One constant (`PILOTS` in `run.mjs`) defines both pilots. `codex-edit` uses
family `codex` with arms `base` and `codex-edit`. `hashline-edit` uses families
`kimi`, `mimo`, `qwen` and `grok` with arms `base` and `hashline-edit-451`;
`glm` is excluded (reserved for hermes, operator #12969). Both use tasks
`edit-1` and `edit-2` (edit-only fixtures scored by the owned diff alone; their
frozen briefs exclude test writing and execution, a cohort-specific override
separate from general test permission #14235), low effort and a per-pilot turn limit (`turnMinutes`: 10 for codex-edit, 5 for hashline-edit, because the kimi OAuth access token must outlive the turn plus a minute).
Arms alternate within each rep, fixture and family: base then challenger.
`--pace-override "<operator reason>"` (pilots only, operator #13110) waives the
"ahead of pace" rule alone; unreadable usage, a short-window throttle, high load
(>= 85%) and the reserve still refuse, and the verdict records the reason. A
family's usage is read in the stand's own process: mimo's Chrome cookie is
unreadable from a process the Claude app started (macOS privacy), so run mimo
cells from a terminal that can read Chrome, or they skip.
Five hashline reps plan **80 cells** (5 × 2 fixtures × 4 families × 2 arms).
Unarmed profiles remain refused; a dry-run does not install or arm them. Each pilot runs
through the **same cellKey path as the matrix**: the per-family vendor guard is
read before seat creation and rechecked immediately before the prompt, the
per-run token cap applies, a turn without measured usage refuses to score, and
the arm activation-proof hash is compared before and after. Pilot cells carry a
`cohort: pilot:<pilot ID>` tag that `cellKey` appends, so a pilot row can never
share a key with a matrix row; matrix `cellKey`/`budgetKey` digests are
byte-identical to before. The pilot takes no `--budget` and never writes a
`budget-start` row. One invocation starts **at most two runs per family**
(`MAX_FAMILY_RUNS` binds unchanged, up to eight runs for the hashline pilot);
the remaining cells are
deferred with `batch cap 2 runs per family; resume after quota refresh`. A
stopped or deferred pilot resumes by re-invoking the same command after the
quota reading refreshes: recorded `done`/`capped`/`error` cellKeys are skipped,
skipped/deferred cells are reconsidered. `--dry-run` prints every planned
cell's guard verdict without creating a seat or appending results. `report.mjs`
shows pilot rows per arm with runs, score, a first-edit success/failed/unknown
tally and tokens, with the same done-only, one-cohort delta rules as the matrix.


Pilot `hashline-500` (operator #13170) runs family `qwen` on arms `hashline-edit-451`
(control) and `hashline-edit-500`, tasks `edit-1` and `edit-2`, `turnMinutes` 5.
`--reps` above 3 is refused. `run.mjs` does not assume the control arm is `base`:
cells follow `PILOTS.arms` order. `report.mjs` pairs this pilot's other arm with
`hashline-edit-451` rows of the same cohort, family, task and model (`deltaVsControl`,
control arm named). Base-first pilots and the matrix still use `deltaVsBase`.

Pilot `context-pruning` (operator #13197) runs family `qwen`, control arm `base`, challenger
`context-pruning`, `turnMinutes` 15. Tasks are `lesson-12737` and `lesson-12713`: they are the
two longest replay briefs (332 and 319 words), so the coder re-reads and edits the same owned
files and tool-result context grows, which is what this extension prunes. `edit-1`/`edit-2` are
smaller single-file edits (the only recorded run tokens, memory #13097, are about 91k and 133k);
`ops/ab-stand/results` is absent in this checkout, so the ranking uses brief size, the observed
proxy, not a recorded growth table. `--reps` above 3 is refused. Cells follow `PILOTS.arms`
order, so `report.mjs` still pairs the challenger with `base` (`deltaVsBase`).

Pilot `agent-lsp` (operator #13197) uses family `qwen`, control `base`, challenger
`agent-lsp`, tasks `edit-1` and `edit-2`, and `turnMinutes` 5. Default is one rep;
`--reps` above 3 is refused. Existing quota, token, delivery and batch gates bind.

```sh
node ops/ab-stand/run.mjs --pilot agent-lsp --reps 1 --dry-run
# On quota approval only: repeat without --dry-run.
```

Pilot `probe` (operator #13197) runs family `qwen`, control arm `base`, challenger `probe`,
`turnMinutes` 5. Tasks are `scout-1` and `scout-2`: they exercise code search. `scout-1`
must cite how a seat, a turn and its usage are persisted, and what restart does to running
turns, in `ops/orchestrator/src/store.ts`. `scout-2` must cite Codex cached-input handling
in `ops/orchestrator/src/providers/codex.ts` and the digest token total in
`ops/orchestrator/src/seats.ts`. `edit-1`/`edit-2` are single-file edits, not searches.
`--reps` above 3 is refused (operator allows 1, never above 3). Cells follow `PILOTS.arms`
order, so `report.mjs` pairs the challenger with `base` (`deltaVsBase`).

Pilot `gitnexus` (operator #13197) runs family `qwen`, control `base`, challenger `gitnexus`, `turnMinutes` 5. Tasks are `scout-short` (where a seat is persisted: file:line navigation) and `coder-short` (must find `item()` in `digest-text.ts` before editing). Those are the existing code-navigation fixtures; `edit-1`/`edit-2` are the single-file fallback and are not used. `--reps` above 3 is refused. Short runs: the operator allows 1, ceiling 3.

Pilot `jcodemunch` (operator #13197) runs family `qwen`, control arm `base`, challenger `jcodemunch`, `turnMinutes` 15. Tasks are `scout-1` and `scout-2`: each asks for repo-relative file:line of symbols the seat must find (`store.ts` seats, turns and usage; `codex.ts` cached input and `seats.ts` digest totals). `edit-1` and `edit-2` name the single file to change, so they do not exercise code navigation. `--reps` above 3 is refused. Cells follow `PILOTS.arms` order, so `report.mjs` pairs the challenger with `base`.

Pilot `openviking` (operator #13197) runs family `qwen`, control arm `base`,
challenger `openviking`, `turnMinutes` 5. Tasks are `scout-short` and `scout-1`:
both are code-navigation fixtures that locate orch's seat persistence at the
pinned commit and cite repo-relative file:line, and in a pilot every arm runs
with codegraph off (`matrixInstruments`), so navigation quality is exactly what
this arm changes; `edit-1`/`edit-2` are smaller single-file edits and remain the
fallback. `--reps` above 3 is refused (short runs, 1 rep by default). Cells follow
`PILOTS.arms` order, so `report.mjs` pairs the challenger with `base`
(`deltaVsBase`).

Pilot `sleev` (operator #13197) runs family `qwen`, control arm `base`, challenger `sleev`,
`turnMinutes` 15, on the same two longest replay briefs `lesson-12737` and `lesson-12713`:
the gateway compresses growing conversation history between turns, and those briefs grow
tool-result context across a multi-file replay (`edit-1`/`edit-2` are smaller single-file
edits, memory #13097: 91k/133k). `--reps` above 3 is refused (operator: short runs,
1 rep, never above 3).

## Compare recorded runs

```sh
node ops/ab-stand/report.mjs --json ops/ab-stand/comparison.json
```

Reads dated `results/*.jsonl` files and prints one Markdown table and
text chart per recorded arm. The JSON contains per-run measurements, status counts and **done-only** medians
by pilot tag and fixture/profile/model/cap cohort. Deltas use the same cohort tag, task, family, fixture,
model, limits and repetition, and require an unambiguous base profile; arm
profiles necessarily differ from base. A pilot whose first arm is not `base`
instead pairs other arms with that control arm (`deltaVsControl`, control arm named);
base-first pilots and the matrix stay on `deltaVsBase`. A later row for the same cell supersedes
an earlier one. Capped, error, cancelled and skipped/deferred rows count but do
not enter medians; capped runs retain their recorded zero per-run score. The
runner currently records batch deferrals as `skipped`, so the table combines
skipped/deferred counts. Sparse error/skip rows join a recorded cohort only
when their `cellKey` verifies its configuration; opaque unmatched keys do not
supply guessed metadata. Unknown measurements and incomparable deltas remain
null (`—` in Markdown); unknown statuses warn with file:line. Use
`--results <dir>` to read an alternate results directory.

Cache economics (task 1716c) judge an arm such as `obs-mask` by bill, not raw
tokens: rewriting an old message breaks the provider prompt cache there. The
runner adds `usage.cacheWrite` and `usage.cost` from the Pi session's own
per-message usage (`cost.total`, Pi's catalog USD price, not a subscription
bill). The table adds base/arm cache write, cache hit share
`cacheRead / (input + cacheRead + cacheWrite)` (Pi's `input` excludes cache
tokens) and cost, each with its delta. Rows recorded before this, runs where
some message lacks the field, sessions that bill outside assistant messages
(a compaction, a usage row), and models Pi has no price for (non-zero tokens
at zero cost) show `—`; the stand keeps no price table of its own.

The live orch daemon keeps its startup code: `seat_create.standArm`,
`seat_prompt.token_cap` and the stand-only transcript path require a normal,
operator-scheduled reload when existing live seats can drain. Never restart it
as part of stand installation or `--dry-run`.

Rollback **after closing stand sessions and Ollama/CBM servers**: delete only
`~/.local/state/orch/ab-stand/`. A manual `uv` command may also leave a single
interpreter entry under `~/.cache/uv/`; inspect it and remove only that entry if
it came from the stand (the installer otherwise directs uv to the stand root).
The installer prints the stand-root `rm -rf --` command but never runs it. Compare SHA-256 hashes of live
`~/.pi/agent/{settings.json,mcp-adapter.json,auth.json,extensions/rtk.ts}` and
`~/.local/state/orch/providers.json` before and after install/smoke; active
unrelated OAuth refreshes must be identified rather than called stand changes.
Tests: `node scripts/test-ab-stand.mjs`,
`node --test scripts/test-orch-seat-guard.mjs scripts/test-orch-providers.mjs scripts/test-orch-seats-core.mjs scripts/test-orch-seats-reports.mjs scripts/test-orch-seats-lifecycle.mjs scripts/test-orch-seats-board.mjs`,
`npx tsc --noEmit -p tsconfig.app.json`.
