# Harness kit: full installation guide

First rule: before your first message, read the system UI language: on macOS run
`defaults read -g AppleLanguages` (first entry, drop the region tag); on Windows run
PowerShell `(Get-UICulture).Name` and drop the region tag. Write every message in
that language from the first. If the probe fails or is unclear, ask the language first.
If the user answers in another language, switch. This is the interview language.

One question per message, with its default and a one-line reason; wait for the answer.
If a required detail has no default, say so and explain why it is needed.

## Install with an agent

**Recommended setup:** paste this install prompt into the **Claude Code desktop app (GUI)**
with local terminal access. Keep that app as the lead; worker seats run under orch.

An interactive **Claude Code terminal CLI** lead can also clone the kit, run its
configuration and dependency commands, invoke the Node installer and doctor, and
manage orch seats. The installer writes Claude instructions, skills, MCP, hooks
and permissions for the chosen checkout/home; it has no desktop-only install
switch. It does not install the desktop app. Codex lead configs are also generated,
but Claude Code mods are not Codex extensions.

The rich orch-board pane is a desktop surface; its terminal surface renders a
text summary instead. A headless session with no attached surface gets no pane,
and collision-guard cannot ask there, so it lets an edit proceed. See 7.2.1;
do not treat successful settings registration as proof of a loaded mod.

Paste:

```text
Clone https://github.com/alexboo86/booharness.git into ~/Developer/harness if it is absent. Read INSTALL.md there in full and install BooHarness by its instructions.
```

First agent step on macOS, before any Git command: run `xcode-select -p`.
If it fails, run `xcode-select --install`. The dialog is the user's to confirm;
wait for "done", then verify the selected Git binary:

```bash
git_bin="$(xcrun --find git)" && "$git_bin" --version
```

Do not clone until both checks pass. For a LAN kit URL, Claude may need macOS
Local Network permission (**not yet proven**): System Settings › Privacy & Security › Local Network.
Let the user grant it; do not change the setting yourself.

If `~/Developer/harness` is absent, run:

POSIX:

```bash
mkdir -p ~/Developer
git clone 'https://github.com/alexboo86/booharness.git' ~/Developer/harness
```

Windows PowerShell (install Git first if it is absent; see 4.2):

```powershell
New-Item -ItemType Directory -Force "$HOME/Developer" | Out-Null
git clone 'https://github.com/alexboo86/booharness.git' "$HOME/Developer/harness"
```

If the directory already exists, do not overwrite it or reset its changes: verify
that it is the intended harness checkout, or stop and ask the user.
Then read this whole guide and [INSTALL-PROMPT.md](INSTALL-PROMPT.md) in that
checkout and continue with its existing question and install sequence.
Start every sign-in and key prompt yourself and wait: before each family login, say that
family's card in 7.3, one family at a time. The user only signs in in the
browser you opened, or pastes a key into the window you opened. Never read, print
or store a key. A key never goes into the chat.

Everything below is written for the installing agent.

---

## 0. Rules for the installing agent

- Read this whole file before the first command. Work phase by phase; each phase ends with a
  **Verify** block. Do not start the next phase while a Verify line fails: diagnose it
  (section 12), and if it stays red, stop and show the user the exact command and output.
- Follow the first-rule interview language, switching when the user does. Keep a visible checklist of the phases.
- **Sign-ins:** start every login yourself, one family at a time — Pi `/login` for codex, kimi, grok, opencode,
  qwen and mimo, Claude Code for claude — and start the key prompt
  with the secret command when one is needed (5.5). Before you open the window, say that
  family's card in 7.3. The user only signs in in the browser
  window you opened, or pastes a key into the window you opened. Never read, print or store a
  key; prove a stored key with `harness-secret.mjs has`. Wait until the user says done.
  Xcode prompts that ask for the macOS
  password stay the user's.
- **Ask before:** any `git commit` of the harness home, installing the daily tool
  updater (phase 8.3), running `smoke` (it spends a few requests of each subscription).
- Never guess a download URL. Every URL in this file is one the kit's own code uses or the
  vendor's documented package name. For anything else, ask the user or read the vendor's site.
- Do not edit files under `ops/`, `scripts/` or `.agents/skills/` to make an error go away.
  Diagnose the error against the shipped source and prerequisites instead.
  `KIT-MANIFEST.json` holds the release sha256 of every shipped file (except itself).
  Deliberate configuration and project adaptation later in this guide change those bytes.
- `HARNESS` below means the absolute path of the cloned kit. Use `~/Developer/harness`
  unless the user names another place. It must not be moved later without re-running phases 6
  and 7.4 (installed links and the orch service point into it; memory has copied service files).

## 1. What this is

An agent harness with macOS and Windows service installers: the recommended **lead**
is the Claude Code desktop app (GUI), working with the user and handing work to
**worker seats** through orch. Claude Code terminal CLI and Codex leads can use
the generated runtime configs; they do not get the same desktop mod surfaces.
The macOS prerequisite commands below target Apple Silicon. The Windows 11 ARM64
rehearsal is incomplete (4.2); Linux is accepted for remote seat hosts, not by this kit's local memory installer.

| Part | What it is | Where it runs |
|---|---|---|
| **orch** | orchestration daemon: creates seats, picks the model family by quota pace, provisions git worktrees, grades reports, serves a dashboard | macOS LaunchAgent `com.booharness.orch` or Windows task `booharness-orch`; `http://127.0.0.1:7760` (MCP at `/mcp`, board at `/`), state `~/.local/state/orch` |
| **memoryd + memoryctl** | durable memory: handoffs, decisions, lessons, tasks; SQLite + FTS5 + configured embedding vectors | macOS LaunchAgent `local.harness.memoryd` or Windows task `booharness-memoryd`; `http://127.0.0.1:7717`, database `~/.local/state/memoryctl/memory.db`; client `~/.local/bin/memoryctl` (`memoryctl.cmd` on Windows) |
| **Ollama** | embedder for memory's dense search (configured model, default ~640 MB GGUF import) | macOS commands create LaunchAgent `com.booharness.ollama` when needed; Windows uses a separately installed, answering endpoint; configurable with `memory.embed.url` (6.1) |
| **Pi** | the lean agent runtime worker seats run in (pinned 1.4.0) | `HARNESS/ops/pi-runtime/node_modules/.bin/pi` (`pi.cmd` on Windows), never a global `pi` |
| **Tools** | `rtk` 1.0.1 (shell output compressor), `codegraph` 1.6.2 (code graph + MCP), `ast-grep`, `rg` | `~/.local/bin`, npm global |
| **Hooks, MCP, permissions, instructions** | written into each runtime's home by one installer | `~/.claude`, `~/.codex`, `~/.kimi-code`, `~/.grok`, `~/.pi/agent`; PATH block in `~/.zshenv` on POSIX, user PATH on Windows |
| **Skills** | methods as `SKILL.md` files: a default lead set (18) and per-role sets for seats | `HARNESS/.agents/skills`, linked into `HARNESS/.claude/skills` and `~/.codex/skills` |
| **Claude Code mods** | orch-board, handover, collision-guard, delay-no-more, secrets-veil | five checkout folders registered by `permissions` (7.2.1) |
| **Doctor and routines** | read-only diagnostic CLI; five optional recurring-task definitions | `npm run doctor`; `ops/routines/`, activated only through the lead's scheduler (9.6) |

The kit ships `orch.lanPort: "off"`. The orch API and local memory service bind to
loopback. Opting into a LAN board opens a separate read-only listener on `0.0.0.0`;
clearing that key restores the daemon default of port 7761. The board is not the MCP
endpoint. An external embedding endpoint is also an explicit choice.

### 1.1 What the software does on this machine (tell the user before installing)

- Writes the configs listed above; in `~/.claude/settings.json` it adds hooks and a permission
  allowlist and keeps unrelated keys. Its `plugins` step installs no plugin: it retires the old
  `caveman@caveman` plugin (kits before 2026-10-08 installed it) by flagging it off and removing
  its registry keys; it also registers the official Anthropic plugin marketplace
  and quarantines plugin skills whose names collide with the harness canon; see 11.6.
- Every 5 minutes orch reads each family's **quota usage** with its stored credentials,
  read-only: Pi's `~/.pi/agent/auth.json`, the Claude Code token (login Keychain item
  `Claude Code-credentials`, through `/usr/bin/security`), and
  `~/.local/state/orch/providers.json` (GLM key). Vendor CLI credential files, when already
  present, remain an optional second source; their absence is not an error. It calls only
  the vendors' own usage endpoints. Without usable credentials, limits are unreadable.
- The MiMo usage reader looks for a `platform.xiaomimimo.com` session in Google Chrome's cookie
  database (it copies the database to a temp folder, reads the rows of that one host, deletes
  the copy). With no such login it stops there: no Keychain prompt, nothing sent. It runs even
  when MiMo is paused; it finds nothing unless the user signs in to MiMo in Chrome.
- With a `TYPESAFE_API_KEY` (optional, phase 5) orch sends report JSON, brief text and diff
  excerpts to the Jev judge at `api.typesafe.ai`. Without the key nothing is sent.
- Coder, reviewer and bughunter seats get their own git worktree
  (`~/.local/state/orch/worktrees/<seat>`). Read-only Pi roles get no edit tools;
  their shell is guarded and they do not get a separate worktree by default.
- A PreToolUse hook refuses `rm` with both a recursive and a force flag, for leads and seats.

## 2. Supported AI families

**Lead runtimes** (the session the user talks to): recommended, the Claude Code desktop
app (GUI); also configurable, Claude Code terminal CLI and Codex (desktop app or CLI).
By default both Claude Code and Codex get the `orch`, `memoryctl` and `codegraph` MCP servers.
The config key `mcp.off` turns an optional server off; `codegraph` and `memoryctl` are required
and cannot be turned off. For example, to leave Bright Data off even when its key exists:

```bash
node ops/bootstrap/harness-config.mjs set mcp.off '["brightdata-web"]'
```

Windows PowerShell (native argument mode described in 4.2):

```powershell
node ops/bootstrap/harness-config.mjs set mcp.off '[\"brightdata-web\"]'
```

Rerun the installer after changing this key; it also removes an earlier installed entry for
an off server. The server ids and required flags are in `ops/bootstrap/mcp-servers.json`.

**Worker families** (what orch can seat). "Harness" is how orch drives the family: `pi` = the
pinned Pi runtime with that vendor's subscription route, `native` = the vendor's own CLI.

| Family | Roles in the matrix | Default model / effort | Harness | What must exist on the machine |
|---|---|---|---|---|
| **claude** | researcher, coder, tester, designer, copywriter, reviewer, plan critic, legal (not scout, debater, bughunter or security) | coder, tester, designer and copywriter `claude-opus-5-5` high; reviewer, critic and legal `claude-sonnet-5-5` high; researcher `claude-sonnet-5` high | native Claude Code | `claude` CLI signed in to a Claude subscription |
| **codex** | scout, researcher, debater, coder, tester, designer, copywriter, reviewer, critic, legal, bughunter, security | `gpt-6.1-sol` (coder, tester, designer, copywriter, reviewer, critic and legal high; researcher and debater medium; bughunter and security max); scout `gpt-6-luna` high | pi (`openai-codex`) | Pi `/login` for `openai-codex` (ChatGPT subscription); the `codex-edit` Pi extension (phase 7.3) |
| **glm** | scout, researcher, debater, coder, tester, designer, copywriter, reviewer, critic, legal, bughunter, security | `glm-5.3` (high; researcher low; bughunter and security max); scout `glm-5.3-flash` high | pi (`zai`) | Z.AI Coding Plan API key in `~/.local/state/orch/providers.json`; installer also requires `claude` for this family (native mode reuses it) |
| **kimi** | researcher, debater, coder, tester, designer, copywriter, reviewer, critic, legal, bughunter, security (not scout) | `k3.1-pro` high in every role it has | pi (`kimi-coding`) | Pi `/login` for `kimi-coding` |
| grok | scout, researcher, debater, coder, tester, designer, copywriter, reviewer, critic, legal (not bughunter or security) | `grok-4.7` (scout low; researcher medium; other roles high) | pi (`xai`) | Pi `/login` for `xai` |
| opencode | scout | `glm-5.3-flash` | pi (`opencode-go`) | Pi `/login` for `opencode-go` |
| qwen | scout, researcher, debater, coder, tester, designer, copywriter, reviewer, critic, legal, bughunter, security | `qwen3.8-max` (researcher, coder, tester, designer and copywriter medium; debater, reviewer, critic and legal high; bughunter and security max); scout `qwen3.8-flash` low | pi (`qwen-token-plan-individual`) | Pi `/login` with the Qwen token-plan key |
| mimo | scout, researcher, debater, coder, tester, designer, copywriter, reviewer, critic, legal, bughunter, security | `mimo-v2.6-pro` (researcher medium; other roles high, including bughunter and security); scout `mimo-v2.6-flash` low | pi (`xiaomi-token-plan-*`) | Pi `/login` with the Xiaomi token-plan key |

The screenshotter role was removed on 2026-10-21. A lead or a seat captures the screen or a window and reads the image itself, only when a picture is necessary; a log, test, DOM or accessibility read that proves the point comes first. Peekaboo runs on macOS and needs Screen Recording and Accessibility rights granted by the user; `npm run doctor` shows its state.

Source of truth: `ops/orchestrator/src/profiles.ts` (matrix) and
`ops/orchestrator/src/providers/index.ts` (routes). The model ids are the kit's values on its
build date; if a vendor renames a model, the seat start fails with the vendor's message and
`seat_create` accepts an explicit `model`.

A glm coder whose effort is max gets 60 minutes when the lead names no time limit; every other seat keeps the 30-minute default (`ops/orchestrator/src/seats-defs.ts`, `ops/orchestrator/src/seats.ts`). The default glm coder cell is effort high, not max.

**Example set (claude + codex + glm):** every role is covered.
Scouts and bughunters come from codex and glm; an image-reading seat needs an image-capable model; review always has
a second family available. With a Claude lead, claude still codes and may review another
family's change. Every family that is not installed must be **paused** (phase 7.5), or orch
may pick it when the others step aside and the seat start will fail.

Rule the harness enforces: the author's family and the lead's family do not review their own
change (one exception: claude may review a change another family authored). So two worker
families besides the lead's are the practical minimum; this set has it.

## 3. Ask the user first

Follow INSTALL-PROMPT.md in this order, not a second interview. Each item can
contain several messages, but never several questions in one message.

1. Machines: add a seat host (default no); then LAN board (stored default, kit off);
   then memory writer (default this machine). Reason: choose where seats, board and memory run.
   Ask each host detail and each forward separately.
2. Families: default stored list, else all eight; reason: match the user's subscriptions.
3. Logins: one family at a time, default log in now when missing; reason: prove access without exposing keys.
4. Teams: default keep the matrix; reason: preserve working role assignments.
5. Screenshots: no question; explain the capture tools.
6. Skills: per class, default stored selection; reason: disable only unwanted tools.
7. Lead skills: default installed selection; reason: choose lead-session tools.
8. MCP: default stored disabled list; reason: preserve server choices.
9. Memory: endpoint URL first, then model in a new message, defaults stored values
   (absent URL stays unset; absent model requires an answer); reason: configure dense search.
10. Jev: default no; reason: optional paid judging. Ask paid-proof consent separately.
11. Lead: reply language defaults to the interview language, then each other lead field
    separately; reason: keep replies understandable. Set a non-Russian default explicitly:
    the absent-key runtime default is still Russian.
12. Routines: no question; describe the available routines.

Keep updater consent and git identity questions at Apply, where they are used
(§8.3 and §5.1), not in this interview. Ask each separately with its default and
reason; ask name and email in separate messages if missing. Harness home defaults
to `~/Developer/harness`; ask only if the user requests a different home.

## 4. Phase A: prerequisites

### 4.1 macOS

The commands in this section target macOS on Apple Silicon. No package manager is required.
Git comes only from Xcode Command Line Tools, verified before clone in the first
agent step above; `/usr/bin/git` alone can be an uninstalled dispatcher.

The agent installs prerequisites from official archives, never Homebrew. Verify
the checksum before extraction and stop on a missing, duplicate or mismatched entry.

| Tool | What for | Pin | Official source | Checksum verified before extract | Location | Check |
|---|---|---|---|---|---|---|
| Node | installer, orch, memory | 26.7.0 | https://nodejs.org/dist/ | release SHASUMS256.txt | `~/.local/share/booharness/node/current`, `~/.local/bin` links | `node --version`, `npm --version` |
| ripgrep | code search | 15.1.0 | https://github.com/BurntSushi/ripgrep/releases | asset `.sha256` | `~/.local/share/booharness/ripgrep/current`, `~/.local/bin/rg` link | `rg --version` |
| Python | rerank worker | 3.12.15 | https://github.com/astral-sh/python-build-standalone/releases/download/20261021/cpython-3.12.15%2B20261021-aarch64-apple-darwin-install_only.tar.gz | a18cc33862b53bd54a148c710def5375c1b47470cccedf817a19c2d211764584 | `~/.local/share/booharness/python/current`, `~/.local/bin/python3` link | `python3 --version` |
| Ollama binary | embedding endpoint | 0.35.1 | https://github.com/ollama/ollama/releases | unique ollama-darwin.tgz entry in sha256sum.txt | `~/.local/share/booharness/ollama/current`, `~/.local/bin/ollama` link | `ollama --version` matches pin |

Keep an existing Node at 26.7.0 or newer and ripgrep at 15.1.0 or newer.
If either is missing or older, install its official Apple Silicon archive below.
The versions come from `ops/bootstrap/tool-pins.json` at kit build time.

```bash
NODE_VERSION='26.7.0'
RIPGREP_VERSION='15.1.0'
export PATH="$HOME/.local/bin:$PATH"
```

For Node (only when missing or older), download and verify before extracting:

```bash
tmp=$(mktemp -d)
node_dir="node-v$NODE_VERSION-darwin-arm64"
asset="$node_dir.tar.gz"
base="https://nodejs.org/dist/v$NODE_VERSION"
curl --proto '=https' --proto-redir '=https' -fsSL "$base/$asset" -o "$tmp/$asset"
curl --proto '=https' --proto-redir '=https' -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
(cd "$tmp" && awk -v name="$asset" '$2 == name' SHASUMS256.txt | shasum -a 256 -c -) || exit 1
node_home="$HOME/.local/share/booharness/node"
mkdir -p "$node_home" "$HOME/.local/bin"
tar -xzf "$tmp/$asset" -C "$node_home"
ln -sfn "$node_dir" "$node_home/current"
for executable in node npm npx; do
  ln -sfn "$node_home/current/bin/$executable" "$HOME/.local/bin/$executable"
done
export npm_config_prefix="$HOME/.local"
rm -r "$tmp"
```

For ripgrep (only when missing or older):

```bash
tmp=$(mktemp -d)
rg_dir="ripgrep-$RIPGREP_VERSION-aarch64-apple-darwin"
asset="$rg_dir.tar.gz"
base="https://github.com/BurntSushi/ripgrep/releases/download/$RIPGREP_VERSION"
curl --proto '=https' --proto-redir '=https' -fsSL "$base/$asset" -o "$tmp/$asset"
curl --proto '=https' --proto-redir '=https' -fsSL "$base/$asset.sha256" -o "$tmp/checksum"
(cd "$tmp" && shasum -a 256 -c checksum) || exit 1
rg_home="$HOME/.local/share/booharness/ripgrep"
mkdir -p "$rg_home" "$HOME/.local/bin"
tar -xzf "$tmp/$asset" -C "$rg_home"
ln -sfn "$rg_dir" "$rg_home/current"
ln -sfn "$rg_home/current/rg" "$HOME/.local/bin/rg"
rm -r "$tmp"
```

For Python (only when no Python 3.10 or newer exists), download the pinned
python-build-standalone Apple Silicon `install_only` archive, verify the checksum,
and extract Python 3.12.15 under `~/.local/share/booharness/python`, then link `current`. The version,
URL and SHA-256 come from `ops/bootstrap/tool-pins.json` at kit build time.
An existing Python 3.10 or newer is left in place. Either way, export
`MEMORYCTL_PYTHON_BIN` for the memory install.

```bash
python_url='https://github.com/astral-sh/python-build-standalone/releases/download/20261021/cpython-3.12.15%2B20261021-aarch64-apple-darwin-install_only.tar.gz'
python_sha256='a18cc33862b53bd54a148c710def5375c1b47470cccedf817a19c2d211764584'
python_ok=0
if command -v python3 >/dev/null 2>&1; then
  python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' && python_ok=1
fi
if [ "$python_ok" -eq 1 ]; then
  export MEMORYCTL_PYTHON_BIN="$(command -v python3)"
else
  tmp=$(mktemp -d)
  asset="${python_url##*/}"
  curl --proto '=https' --proto-redir '=https' -fsSL "$python_url" -o "$tmp/$asset"
  printf '%s  %s\n' "$python_sha256" "$asset" > "$tmp/checksum"
  (cd "$tmp" && shasum -a 256 -c checksum) || exit 1
  python_home="$HOME/.local/share/booharness/python"
  mkdir -p "$python_home"
  tar -xzf "$tmp/$asset" -C "$python_home"
  ln -sfn python "$python_home/current"
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$python_home/current/bin/python3" "$HOME/.local/bin/python3"
  export MEMORYCTL_PYTHON_BIN="$python_home/current/bin/python3"
  rm -r "$tmp"
fi
"$MEMORYCTL_PYTHON_BIN" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])'
```


**Verify**

```bash
node --version
rg --version
xcrun git --version
command -v node npm rg
export MEMORYCTL_NODE_BIN="$(command -v node)"
```

Node must satisfy the pinned floor; orch needs its TypeScript stripping and `node:sqlite`.
The managed Node path is `~/.local/bin/node`, linked through
`~/.local/share/booharness/node/current`; it stays unchanged across upgrades.
Memory uses `MEMORYCTL_NODE_BIN` (not the resolved, versioned `process.execPath`);
orch resolves the same local-bin link on its canonical path. Global npm tools stay under
`~/.local` on a managed Node install. Add `~/.local/bin` to the terminal's PATH if needed;
the harness installer also manages that entry for services and automatic shells.

#### macOS Ollama commands

The agent installs the Ollama binary at 0.35.1 as a prerequisite.
Download `ollama-darwin.tgz` and `sha256sum.txt` from
`https://github.com/ollama/ollama/releases/download/v0.35.1/`.
Require exactly one checksum entry for `ollama-darwin.tgz` (optionally prefixed
`./` or `*`); verify its SHA-256 before extracting. Extract the complete Darwin
distribution, including its libraries, under `~/.local/share/booharness/ollama/0.35.1`.
Verify that directory's `ollama --version` matches the pin before linking
`~/.local/share/booharness/ollama/current` to that version and `~/.local/bin/ollama`
to `~/.local/share/booharness/ollama/current/ollama`. Refuse unrelated existing
paths or links; never overwrite a user's binary. Keep an already verified
pinned distribution and links. No Homebrew or app window.

After the embedding answers are stored, include this setup command in Apply
consent and run it from the checkout root on macOS, before installing memory.
It refuses an absent or wrong pinned binary; it never installs prerequisite tools.
An answering endpoint keeps its existing server owner. An unanswered remote endpoint
is refused before any service write; only an HTTP loopback endpoint at
its root path can get the LaunchAgent `com.booharness.ollama`. The script lists
models against the chosen endpoint. A missing pinned default model is imported from
its official GGUF: size and sha256 are checked against `ops/bootstrap/tool-pins.json`
before `ollama create`, and a mismatch stops with an error. Any other missing
configured model is pulled. Never `ollama pull qwen3-embedding:0.6b`. The script then proves embedding. A verified default URL is stored through `harness-config` only
when `memory.embed.url` was absent. Existing configured values are preserved.
On failure, stop and ask; do not continue to the memory install.

```bash
node ops/bootstrap/ollama-setup.mjs setup
```

An already-loaded but unanswered Ollama unit makes `launchctl bootstrap` fail:
stop and inspect that unit rather than starting a second server. Doctor’s `memory
service` row checks memoryd health, not the embedding endpoint (§6.1).

### 4.2 Windows 11 ARM64

This path records a clean Windows 11 ARM64 run on 2026-10-14, not a completed
end-to-end install. Do not run the macOS `xcode-select`, `brew`, `launchctl` or
Darwin download commands on Windows. `~` below means `%USERPROFILE%`; use Windows
paths and shell syntax, not the POSIX unpack/PATH one-liners. The kit now arrives on Windows
through `git clone`. Other Windows versions and native x64 hosts are
**not yet measured** here.

Install the prerequisites with these winget ids. Let the user approve installation
and system-setting prompts. The architecture column distinguishes observed binaries
from prerequisites whose installation is **not yet measured**:

| winget id | Architecture on this ARM64 host | Result in the run |
|---|---|---|
| `OpenJS.NodeJS.LTS` | ARM64 | Node 24.20.0 ran; require Node 24+ |
| `Git.Git` | x64, emulated | Git 2.55.0 ran |
| `BurntSushi.ripgrep.MSVC` | ARM64 (`aarch64-pc-windows-msvc`) | Installed; `rg --version` failed with `0xC0000135` |
| `Ollama.Ollama` | x64 Windows installer (**not yet measured**) | Download stalled; installation and embedding were not proved |
| `Python.Python.3.12` | ARM64 | **not yet measured** on this host; required by the reranker in 6.2 |
| `Microsoft.VCRedist.2015+.arm64` | ARM64 VC++ runtime | Installation timed out; repair **not yet measured** |
| `Microsoft.VCRedist.2015+.x64` | x64 VC++ runtime for emulated tools | Installation and repair **not yet measured** |

```powershell
winget install --id OpenJS.NodeJS.LTS -e --silent
winget install --id Git.Git -e --silent
winget install --id Microsoft.VCRedist.2015+.arm64 -e
winget install --id Microsoft.VCRedist.2015+.x64 -e
winget install --id BurntSushi.ripgrep.MSVC -e --silent
winget install --id Ollama.Ollama -e
winget install --id Python.Python.3.12 -e --silent
```

Python is the reranker runtime (6.2): the memory install builds its venv from
the interpreter `MEMORYCTL_PYTHON_BIN` names and refuses a Windows install
without it. On this host `Python.Python.3.12` is the ARM64 build; prove both the
version and the machine architecture — an x64 Python under emulation cannot hold
the win_arm64 torch wheel — then point the variable at it for this session and
the next:

```powershell
python -c "import sys, platform; raise SystemExit(0 if sys.version_info >= (3, 10) and platform.machine() == 'ARM64' else 'need Python 3.10+ ARM64, got %s (%s)' % (sys.version.split()[0], platform.machine()))"
[Environment]::SetEnvironmentVariable('MEMORYCTL_PYTHON_BIN', (Get-Command python).Source, 'User')
$env:MEMORYCTL_PYTHON_BIN = (Get-Command python).Source
```

The tested MSVC `rg.exe` and x64 `rtk.exe` died with `0xC0000135` (missing DLL)
without the VC++ runtimes. Install both runtime architectures before verifying
these tools; successful execution after that repair is **not yet measured**.
Do not treat winget's success message as proof that a tool runs.

Before continuing, read the Windows notes in 5.3 and enable Developer Mode as
described immediately before the installer in 7.2. When you answer the families
step, the answer must name at least one family (for example `codex`): an empty
list is refused with `families.enabled must list at least one family`.

**npm commands in Windows PowerShell.** The default execution policy of a
clean Windows 11 (`Restricted`) refuses the `npm.ps1` shim: `npm ci` stops with
`npm.ps1 cannot be loaded because running scripts is disabled on this system`.
The same holds for every command npm installs globally (`claude`, `codegraph`,
`ast-grep`). In Windows PowerShell, call the `.cmd` name: `npm.cmd`, `npx.cmd`,
`claude.cmd`, `codegraph.cmd`, `ast-grep.cmd`. Do not change the execution
policy. A `bash` block below that starts with `npm` or `npx` means the same
command with `npm.cmd` or `npx.cmd` in PowerShell.

**Config JSON in Windows PowerShell.** Do not copy the POSIX JSON quoting from
later `bash` blocks. A POSIX string argument is `'"keep"'` and an array is
`'["glm"]'`; Windows PowerShell needs `'\"keep\"'` and `'[\"glm\"]'`.
Booleans and numbers are unchanged. These PowerShell examples use legacy native
argument passing, the default in Windows PowerShell. In PowerShell 7.3+, first
set `$PSNativeCommandArgumentPassing = 'Legacy'` for this session. When invoking
Node with an argv array directly, pass plain JSON text without shell quotes or
backslashes. For the agent-led install, use the PowerShell blocks in
[INSTALL-PROMPT.md](INSTALL-PROMPT.md), including Apply:

```powershell
node ops/bootstrap/harness-config.mjs set install.userEntries '\"keep\"'
node ops/bootstrap/harness-config.mjs get install.userEntries
node ops/bootstrap/harness-config.mjs set families.enabled '[\"glm\"]'
node ops/bootstrap/harness-config.mjs get families.enabled
node ops/bootstrap/harness-config.mjs validate
```

The families line is an example, not a default: store the user's chosen nonempty
list. Stop on a failed config command; do not continue to the installer.

The historical run used Pi 1.0.1, not today's 1.4.0 pin; it does not prove
the current runtime on Windows. After Developer Mode
was enabled, the 7.2 installer exited 0 and orch and memory service health endpoints
answered. That did not prove a working embedder, provider login or seat. Ollama
never served in this run: its download stalled on a slow link. Windows embedding,
dense memory search, provider logins, smoke and the daily updater are **not yet
measured**. The macOS service commands later in this guide are not Windows steps;
do not invent replacements or declare final acceptance while a Verify fails.

## 5. Phase B: harness home, dependencies, tools, secrets file

### 5.1 Harness home

```bash
# If absent, clone as described in the first agent step above.
cd ~/Developer/harness
```

A clone already has Git history and a commit from which seats can branch. Do not
initialize another repository, import an archive or amend the public release
commit. If Git history is missing, stop and return to the clone step.

The harness home **must be a git repository and a main checkout**, not a linked worktree:
the installer skips the orch service and home skill linking from a worktree.
After dependencies are installed in 5.2, regenerate the routing identity for
this public repository rather than retaining the builder repository's identity.

### 5.2 npm dependencies (three separate installs, all with lockfiles)

```bash
npm ci --no-audit --no-fund
```

```bash
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix ops/orchestrator
```

```bash
npm ci --no-audit --no-fund --prefix ops/pi-runtime
```

Windows PowerShell (`npm.cmd`, see the npm note in 4.2):

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix ops/orchestrator
npm.cmd ci --no-audit --no-fund --prefix ops/pi-runtime
```

After installing Pi and putting its provider login in `auth.json`, run `ops/pi-runtime/node_modules/.bin/pi update --models` (PowerShell: `.\ops\pi-runtime\node_modules\.bin\pi.cmd update --models`) before kimi seats start: a provider without a login gets no catalog even on exit 0; kimi seats require Pi's `kimi-coding` OAuth login, and a custom agent directory requires `PI_CODING_AGENT_DIR` set first.

The root one installs `yaml` and `typescript`, which orch and the hooks import from the root
`node_modules`. Without it every seat start fails with `Cannot find package 'yaml'`.

**Verify**

```bash
ops/pi-runtime/node_modules/.bin/pi --version
```

Must print `1.4.0` exactly (orch compares the string and refuses another version).
On Windows PowerShell, run `.\ops\pi-runtime\node_modules\.bin\pi.cmd --version`.

Then regenerate the routing map for this clone:

```bash
node scripts/gen-domain-routing.mjs
```

Inspect `git diff -- docs/agent/domain-routing.generated.json`. The generator
uses this repository's root commit for `repository`; a freshly published clone
can differ from the build source. Review any diff with the user and ask before
committing it. Do not amend the release commit or overwrite unrelated changes.

The full routing check, `npm run check:memory-routing`, also reads the lessons
from memoryd, which phase 6 installs. It runs in the §6.2 Verify, not here.

### 5.3 Tools

**Windows:** the pinned rtk 1.0.1 release checked in the run has no win-arm64
build. Its Windows asset is `rtk-x86_64-pc-windows-msvc.zip`, not the Darwin archive
below. Verify it against that release's `checksums.txt` before placing `rtk.exe`
in `%USERPROFILE%\.local\bin`. The x64 build runs under Windows ARM64 emulation
with the x64 VC++ runtime; successful execution and performance are **not yet
measured** here (the logged binary failed with `0xC0000135`). Do not substitute
an unverified download or silently skip a failed tool check.

For code-intel, winget/PATH alone does not satisfy the Windows installer's
canonical search. Copy the installed `rg.exe` into
`%USERPROFILE%\.cargo\bin\rg.exe`, creating that directory if needed, or install
a Rust toolchain so the installer can build ripgrep with cargo. For a custom
`--home`, use that home's `.cargo\bin`. This is the required route, not a
code-intel fix in this guide: successful copy/toolchain remediation is **not yet
measured**. The logged `--only code-intel` run refused the winget/PATH copy.

With npm 11.19, the `allowScripts` policy blocked `@ast-grep/cli`'s postinstall.
Review and approve that package's install script. The logged retry was
`npm install -g @ast-grep/cli --allow-scripts`; it still left `ast-grep --version`
hanging. Approval is not a proven repair: a working Windows ast-grep install is
**not yet measured**. Stop on a hang or unreadable result; do not proceed as if
the Verify passed. The following download and PATH shell commands are **macOS
only**; the npm package pins apply on both platforms.

`rtk` 1.0.1 from its GitHub release, checksum-verified (the same source and check
`ops/update-tools.mjs` uses):

```bash
(mkdir -p ~/.local/bin && cd "$(mktemp -d)" && curl -fsSLO https://github.com/rtk-ai/rtk/releases/download/v1.0.1/rtk-aarch64-apple-darwin.tar.gz && curl -fsSL https://github.com/rtk-ai/rtk/releases/download/v1.0.1/checksums.txt -o checksums.txt && want=$(grep 'rtk-aarch64-apple-darwin.tar.gz$' checksums.txt | awk '{print $1}') && have=$(shasum -a 256 rtk-aarch64-apple-darwin.tar.gz | awk '{print $1}') && [ -n "$want" ] && [ "$want" = "$have" ] && tar -xzf rtk-aarch64-apple-darwin.tar.gz && install -m 755 "$(find . -type f -name rtk | head -1)" ~/.local/bin/rtk && ~/.local/bin/rtk --version)
```

If the checksum does not match, stop: do not install the binary.

```bash
npm install -g @colbymchenry/codegraph@1.6.2 @ast-grep/cli
```

The pins live in `ops/bootstrap/tool-pins.json` (`codegraph` 1.6.2, `rtk` 1.0.1). Do not
install a newer rtk or codegraph by hand: the hooks are written against these versions.

Put `~/.local/bin` on PATH for this shell (the installer makes it permanent in phase 6):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

**Verify**

```bash
rtk --version && codegraph --version && ast-grep --version && rg --version | head -1
```

Expect `rtk 1.0.1` and `1.6.2`.

### 5.4 Claude Code CLI and family sign-ins

The only vendor CLI offered by this guide is `claude`. Claude seats default to native
Claude Code; all seven other families default to Pi. GLM uses its stored key in Pi
and can also run natively through Claude Code.
The config key `families.enabled` requires `claude` only when claude or glm is enabled.
For example:

```bash
node ops/bootstrap/harness-config.mjs set families.enabled '["claude","codex","glm"]'
```

Windows PowerShell:

```powershell
node ops/bootstrap/harness-config.mjs set families.enabled '[\"claude\",\"codex\",\"glm\"]'
```

With no stored list the installer requires only `claude`.
This key does not pause orch families; still do 7.5.
The mapping is in `ops/bootstrap/resolve-runtime-path.mjs`.

| Family | Install | Sign-in (the user does it) | Verify |
|---|---|---|---|
| claude | `npm install -g @anthropic-ai/claude-code` | run `claude`, then `/login` | `claude --version`; `claude -p "say ok"` answers |
| glm | none | none here; key goes into `providers.json` in phase 7.1 | phase 7.6 |

For codex, kimi, grok, opencode, qwen and mimo, use Pi `/login <provider>` (7.3).
Do not install or offer their vendor CLIs.

The Claude **desktop app** (if that is the lead) is installed by the user from Anthropic's
site; it uses the same `~/.claude` home as the CLI. The installer requires the `claude`
binary when claude or glm is selected, even though GLM defaults to Pi. It must be on
the canonical path (`/opt/homebrew/bin`, `~/.local/bin` or `~/.claude/bin` on macOS).

### 5.5 Optional keys

For Jev, open the login helper's window and wait for the user to enter the key there:

```bash
node ops/bootstrap/harness-login.mjs jev
```

The window runs `harness-secret.mjs set jev`. It writes `TYPESAFE_API_KEY` into `~/.claude/booharness-secrets.env`, creates the file when absent,
and keeps other entries. No copying of `secrets.env.example` is needed.
`ops/bootstrap/family-logins.json` names the store and entry.
Prove it with `node ops/bootstrap/harness-secret.mjs has jev`, not the login exit code.
When the helper exits 3, show its exact terminal command for the user to run; do not
read or print the secret. This is the same fallback as INSTALL-PROMPT.md step 3.

`BRIGHTDATA_API_KEY` has no login descriptor, so it stays manual. If the user wants Bright
Data, they create the secrets file if absent, keep its permissions at 0600, and add or edit
that entry in their own editor. `secrets.env.example` shows the line. Do not copy the example
over an existing secrets file. The server also needs its pinned package:

```bash
npm ci --prefix ops/mcp-vendor --no-audit --no-fund
```

`ops/bootstrap/mcp-servers.json` names both prerequisites. Every key is optional; without
these keys the corresponding features remain unavailable.

## 6. Phase C: memory (Ollama, memoryd, memoryctl)

Memory goes first: the harness installer and orch both call it.

### 6.1 Embedder

The kit defaults to `http://127.0.0.1:11434`. For a different embedding endpoint, set the
config key `memory.embed.url` before installing memory. For example, to use the local default:

```bash
node ops/bootstrap/harness-config.mjs set memory.embed.url '"http://127.0.0.1:11434"'
```

Windows PowerShell:

```powershell
node ops/bootstrap/harness-config.mjs set memory.embed.url '\"http://127.0.0.1:11434\"'
```

`ops/memory-local/install.mjs` uses an explicit `--embed-url` first, then the saved URL in
`local-service.json`, then this config key, then the kit default. On an existing installation,
pass `--embed-url` to change a saved URL. Use the chosen endpoint in the probe below.
The saved model also precedes `memory.embed.model` on a reinstall. The wrapper
has no `--embed-model` option. A model change on an existing writer therefore
needs a separately reviewed update of its saved service settings, preserving
the kit's unit identity; do not assume a config write applied it.

On macOS, run the consented Ollama commands in §4.1 before this phase. They install
the pinned client, start or reuse the chosen endpoint, and import the pinned default
model when it is missing (or pull a different configured model). They use the headless `ollama serve` route, not a GUI. Use the
chosen endpoint for the list too:

```bash
OLLAMA_HOST="$(node --input-type=module -e 'import {readHarnessConfig} from "./scripts/lib/harness-config.mjs"; console.log(readHarnessConfig({repoRoot:process.cwd()}).memory.embed.url ?? "http://127.0.0.1:11434");')" ollama list
```

That shell assignment is POSIX-only. On Windows, first install and start Ollama
using its Windows installation, or prove the chosen existing endpoint. The
Windows `memory-local` path checks `/api/tags` before changing service files. If a
model is missing at a local endpoint, it imports the pinned default GGUF (size
and sha256 checked), or pulls a different configured model. It refuses to
populate a non-local endpoint. It does not install or start the Ollama server.
This source path is not evidence of a completed Windows embedding rehearsal.

**Verify** (must print `1024` for `qwen3-embedding:0.6b`; another model has its own dimension):

```bash
node --input-type=module -e 'import {readHarnessConfig} from "./scripts/lib/harness-config.mjs"; import {embed} from "./scripts/memory/embed-recipe.mjs"; const c=readHarnessConfig({repoRoot:process.cwd()}); const [v]=await embed(c.memory.embed.url ?? "http://127.0.0.1:11434",c.memory.embed.model,["probe"]); console.log(v.length);'
```

### 6.2 Client, service files and the memoryd unit

```bash
node ops/memory-local/install.mjs
```

It runs `ops/bootstrap/install-memory.mjs` in LOCAL mode under the kit's unit name: it copies
the client to `~/.local/bin/memoryctl`, the service (`store.mjs`, `memoryd.mjs`,
`embed-recipe.mjs`) to `~/.local/share/booharness/scripts/memory/` and the routing map beside it,
and records the embed URL and model in `~/.local/state/memoryctl/local-service.json`.
On macOS it writes `~/Library/LaunchAgents/local.harness.memoryd.plist` (KeepAlive).
On Windows it writes `memoryd.cmd` and `memoryd-task.xml` in the memory state
directory and registers the per-user `booharness-memoryd` task. The task
runs only while that user is logged on; a per-minute trigger restarts a stopped
daemon, and `IgnoreNew` prevents concurrent instances. The service environment
uses the selected `MEMORYCTL_EMBED_URL` and `MEMORYCTL_EMBED_MODEL` (default
`qwen3-embedding:0.6b`), `MEMORYCTL_PORT=7717` and
`MEMORYCTL_STATE_DIR=~/.local/state/memoryctl`. The installer starts the unit and
waits for `/health`. `--check` re-verifies the whole install (exit 1 on drift); `--dry` prints
that plan without writing anything; `--uninstall` unloads
the unit and keeps the database. The daemon creates `memory.db` and `memory.token` (mode 0600)
on first start; the client reads the same token file.

On macOS the kit config carries no `memory.rerank` key, so memory install is rerank-managed,
the same as the donor writer. It creates the venv, installs pinned torch 2.14.1,
transformers 5.20.2, sentencepiece 0.2.2 and huggingface_hub 2.2.0, and downloads
`BAAI/bge-reranker-v2-m3`. Measured artifact sizes, not an installed tree: the torch
2.14.1 macOS arm64 wheel is 121 MiB (127,307,099 bytes, PyPI) and the pinned model
snapshot is 2.14 GiB (2,293,260,907 bytes). Allow about 3 GiB of disk (estimate: those
two plus the other wheels and the venv). First download time was not measured; expect
several minutes on a home link (estimate). Resident RSS is about +2.1 GiB (decision
#19106). After install, `/health` shows the reranker `"status":"ready"` and one search
carries `X-Memory-Rerank: ok`. Opt out by setting `memory.rerank` to `off` and
reinstalling: `/health` then says `off` and search sends no `X-Memory-Rerank`. On
Windows the same pins install, but torch comes from the pytorch CPU index (the
`2.14.1+cpu` win_arm64 wheel; PyPI has no win_arm64 build) and the venv is built
from `MEMORYCTL_PYTHON_BIN` (4.2), which a managed Windows install requires.

For a local writer, do **not** run `install-memory.mjs` bare: on macOS its default
label (`com.booharness.memoryctl`) conflicts with `memory-local`'s unit. Use the
wrapper so one unit owns one database. For an existing remote writer, use
`node ops/bootstrap/install-memory.mjs --remote <url>` **instead** of the local
install, as INSTALL-PROMPT.md says. That retires the local unit and writes
`service.url`; `memory-local` refuses while that file exists. A remote client
also needs the writer's token provisioned securely; the URL command does not
copy one.

**Verify** (every line must hold)

```bash
node ops/memory-local/install.mjs --check
```

Exit 0 and `"ok": true`.

```bash
npm run check:memory-routing
```

Exit 0: the routing map regenerated in §5.2 checks out, and its lesson probe reads
the memoryd installed above.

```bash
memoryctl status
```

`"durable": true`.

```bash
memoryctl append --kind reference --title "Harness installed on this machine" --body "Harness kit installed from KIT-MANIFEST sourceCommit; harness home is the checkout that holds INSTALL.md."
```

Prints an `id`. Then the dense search, which proves the embedder path end to end:

```bash
memoryctl search "when was the harness set up on this machine" --limit 3
```

Must return the entry (HTTP 200, a JSON array). `HTTP 503 ... embedder ... unavailable` means
Ollama is not answering or the unit lacks `MEMORYCTL_EMBED_URL` (section 12).

```bash
curl -s http://127.0.0.1:7717/health
```

`"embedder"` shows the endpoint selected in 6.1 and `"reachable":true`; `"vectors"` shows `"missing":0`
(`reachable` turns true only after the first successful embed, so read it after the search).
On macOS, `"reranker"` must show `"status":"ready"` (poll while it is `warming`). Then one search
must carry `X-Memory-Rerank: ok`:

```bash
curl -sD - -o /dev/null -H "X-Memory-Token: $(tr -d '\n' < ~/.local/state/memoryctl/memory.token)" \
  'http://127.0.0.1:7717/api/memory/search?q=when%20was%20the%20harness%20set%20up&limit=3'
```


Read `.agents/skills/memoryctl/SKILL.md` before any further memory writes: tasks, handoffs and
lessons have required flags, and a refusal (HTTP 400) names its own fix.

## 7. Phase D: harness installer and orch

### 7.1 GLM key (only if glm is chosen)

Before you open the window, say the glm card, in full. Do not add a URL. Never ask for, read or print a key.

Say: (1) This is GLM on Pi, not a Claude login. GLM defaults to Pi with the Z.AI key, not a Claude login. Its optional native route uses the `claude` CLI with the same key. (2) The window runs `harness-secret set glm` and shows one hidden prompt. The endpoint is set automatically; never ask the human to enter a base URL. (3) Paste the Z.AI GLM Coding Plan API key into that hidden prompt. Do not paste it in this chat. (4) That key is the Z.AI Coding Plan API key. (5) When the prompt finishes, close the window and say "done".

Then open the login helper's window; the user enters the key there:

```bash
node ops/bootstrap/harness-login.mjs glm
```

The window runs `harness-secret.mjs set glm`. At the single hidden prompt, the user enters only the Z.AI Coding Plan key for
`glm.env.ANTHROPIC_AUTH_TOKEN`. The command also sets `glm.env.ANTHROPIC_BASE_URL` to
`https://api.z.ai/api/anthropic` if absent, keeping an existing base URL unchanged.
It writes `~/.local/state/orch/providers.json` with mode 0600 and keeps other entries.
`ops/bootstrap/family-logins.json` names the key entry and the fixed, non-secret endpoint.
orch reads this file at every glm seat start and passes the key to Pi as `ZAI_API_KEY`.
Prove storage with `node ops/bootstrap/harness-secret.mjs has glm`. If the
helper exits 3, show its exact terminal command, as in INSTALL-PROMPT.md step 3.

### 7.2 The installer

**Windows prerequisite — Developer Mode:** before running this installer, have
the user turn on **Developer Mode** in
Windows Settings (search Settings for “Developer Mode”, under **For developers**).
The Settings UI route is **not yet measured**; the logged run enabled
`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock` /
`AllowDevelopmentWithoutDevLicense=1` with elevation, then the installer exited 0.
Do not work around the symlink guard with a junction or reparse fallback.

The clean-host refusal was (machine-specific paths anonymized; refusal wording
unchanged):

```text
cannot create directory symlink at C:\Users\USER\.codex\skills\consolidate-memory: EPERM: operation not permitted, symlink 'C:\Users\USER\Developer\harness\.agents\skills\consolidate-memory' -> 'C:\Users\USER\.codex\skills\consolidate-memory'. Refusing a Windows reparse fallback; enable Developer Mode or install from a POSIX host.
```

Run from the harness home, main checkout:

```bash
node ops/bootstrap/install-harness.mjs --skip-code-intel
```

- The required CLIs come from `families.enabled` (5.4). A missing required CLI makes the run
  exit 1 without `--no-require-providers`. This flag bypasses that requirement; it does not
  install or sign in a CLI. The command above does not bypass that check.
- `--skip-code-intel`: its code-intel step installs codegraph **unpinned**; phase 5.3 already
  installed the pinned versions.

It prints one JSON report. Steps and what each wrote:

| Step (`--only <name>` reruns one) | Result |
|---|---|
| `instructions` | the shared block from `ops/bootstrap/agent-instructions.md` into `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.kimi-code/AGENTS.md`, `~/.grok/AGENTS.md` and the GLM/zcode homes, between `<!-- BEGIN booharness-bootstrap -->` markers; text outside the markers is kept |
| `skills` | the default lead set as symlinks in `HARNESS/.claude/skills` and `~/.codex/skills` (18 each); `.grok`, `.kimi-code` homes get theirs |
| `codex` | `~/.codex/config.toml`: trust for the harness home, MCP servers, `~/.codex/hooks.json` |
| `mcp` | selected servers from `ops/bootstrap/mcp-servers.json` in `~/.claude.json` (global) and `~/.codex/config.toml`; `~/.pi/agent/mcp-adapter.json` for Pi seats (codegraph and memory as direct tools, each behind `ops/bootstrap/mcp-role-gate.mjs`); `mcp.off` excludes optional servers; `brightdata-web` also needs its key and pinned package |
| `hooks` | `~/.claude/settings.json` hooks (table below); git hook shims for the harness home from `.githooks` |
| `permissions` | the allowlist from `ops/bootstrap/permissions.json` and the five Claude Code mod directories (7.2.1) |
| `rtk-filters` | `rtk trust` for `HARNESS/.rtk/filters.toml` after its inline tests pass |
| `pi-rtk`, `lead-rtk` | `~/.pi/agent/extensions/rtk.ts`; `~/.claude/RTK.md` and `~/.codex/RTK.md` with their references |
| `opencode` | `~/.config/opencode/opencode.json` (harmless when opencode is absent) |
| `path` | `~/.local/state/booharness/canonical-path`; one marked block in `~/.zshenv` on POSIX, or persisted user PATH on Windows |
| `orchestrator` | `orchProviders: no-source` or `present` (7.1), then macOS LaunchAgent `com.booharness.orch` or Windows task `booharness-orch`; activated unless an explicit `--home` or foreign `--platform` prevents it |
| `plugins` | retires `caveman@caveman`, registers `anthropics/claude-plugins-official`, checks its receipt and quarantines colliding plugin skills; installs no plugin |

Hooks it wires for the Claude runtime (`~/.claude/settings.json`), all from `HARNESS/ops/bootstrap/`:

| Event | Matcher | Script | Effect |
|---|---|---|---|
| SessionStart | all | `session-start.mjs` | prints the tool health line, MCP list, lead skills, seat load |
| SessionStart / PreCompact | compact | `decision-curator.mjs` | carries operator decisions across a compaction |
| PreToolUse | Bash | `rtk hook claude` | rewrites heavy shell commands to `rtk <cmd>` |
| PreToolUse | Read, Edit, Write | `domain-lessons-hook.mjs` | delivers lessons and the knowledge page of the edited file's domain |
| PreToolUse | Bash, Read, Grep, Glob, Agent | `code-intel-order-hook.mjs` | once per session: asks for a `codegraph_explore` before grepping source |
| PreToolUse | Agent, Task | `subagent-route-hook.mjs` | routes sub-agent use toward orch seats |
| PreToolUse | EnterWorktree | `lead-worktree-hook.mjs` | advises the Enter / edit+commit / ExitWorktree cycle for a worktree task |
| PreToolUse | Bash | `seat-stash-hook.mjs` | seats may not `git stash` (the stash is shared by all worktrees) |
| PreToolUse | Bash, terminal | `shell-delete-hook.mjs` | refuses recursive forced deletion |
| PostToolUse | all | `lead-context-hook.mjs` | reminds the lead to hand over past the context limit |
| UserPromptSubmit / PostToolUse | all | `lead-chat-hook.mjs` | lead chat: hands chat messages sent to the lead into its session |
| Stop | all | `lead-chat-watch.mjs` (async, rewakes) | wakes the lead session when a chat message arrives after it stopped |

Rerunning the installer is safe and is the way to repair or update any of these: edit the
source under `ops/bootstrap/`, rerun, never hand-edit an installer-owned copy.

#### User entries and installer-owned entries

The kit sets `install.userEntries` to `keep` in `ops/bootstrap/harness.config.json`.
In `keep` mode, your own permission rules and your own servers in JSON MCP configs stay
yours. Use a different server id from the canon; operator and retired ids are reserved.

On each run of the relevant step, the installer owns and rewrites the canon rules and
servers. Your edit of a canon server is overwritten in each config that the installer
writes that server to; an owned entry leaves when it leaves the canon. It also owns the
instruction blocks between `booharness-bootstrap` markers and between
`booharness-rtk-text` markers, the PATH block (`booharness-harness-path`), the
codex trust block (`booharness-codex-trust`), the managed skill links, and the whole
Grok file `hooks/booharness.json` in the Grok home (`$GROK_HOME` when it is set,
else `~/.grok`). Real skill directories and foreign links stay yours, with one exception:
in the Claude and Codex skill roots a real directory whose name starts with `paseo` is
moved to `.skills-replaced-by-harness` beside that root, and a foreign link of such a name
is removed. In OpenCode it sets `$schema`, `autoupdate`, `model` and `small_model` and
controls the permission keys `bash`, `edit`, `webfetch` and `external_directory`; other
permission keys stay yours. In TOML MCP configs it replaces or removes each selected,
operator and retired id; other server ids stay yours.

Read the allow list once after the first `keep` run. With no ownership record, present
rules that equal the canon become installer-owned, so even a rule you added yourself
leaves when that canon rule retires. A rule installed by an older installer and already
dropped from the canon cannot be distinguished from your own rule, so it can remain in
the allow list. Remove any such obsolete allowance after that review.

The ownership record for permission rules, JSON MCP server ids and mod directories is
`~/.local/state/booharness/installed-entries.json`, keyed by target config path.

**Verify**

```bash
node ops/bootstrap/install-harness.mjs --no-require-providers --skip-code-intel --only path
```

With the example set in 5.4, `found` lists only `claude` with an absolute path and `missing` is empty.

```bash
claude mcp list
```

The selected servers are connected. With `mcp.off` as in section 2 these are `codegraph`,
`memoryctl` and `orch`. If `orch` shows a connection error, finish 7.4 first.

#### 7.2.1 Claude Code mods

The kit ships all five mods under `HARNESS/ops/claude-mods/`. On both macOS and
Windows, the installer's `permissions` step registers the five checkout folders in
`~/.claude/settings.json` → `env.CLAUDE_CODE_PLUGIN_DIRS`, joined with the host's
path delimiter. This enables discovery from the checkout, not a copied mod or a
live-load receipt. It is separate from the `plugins` marketplace step.
Your other folders and env keys stay; only the installer's five
entries are owned and repointed on a rerun. Do not also put these mods in a
per-session dev-mods folder: that loads them twice and asks about hot reloading.

| Mod | Purpose | What the user sees; limits |
|---|---|---|
| `collision-guard` | asks before Edit/Write/NotebookEdit touches a file another open chat recently changed | Collision question with Proceed/Cancel and, for tracked files, Move to a worktree; `/guard` or `/collision-guard` status. No attached surface means no question and the edit proceeds; not an OS lock. |
| `delay-no-more` | places named tools into or out of deferred ToolSearch | a `tool.describe` hook, no pane/band/toast; tool availability changes only with configured `eager`/`defer` patterns. All default patterns are empty: registration alone changes nothing. |
| `handover` | queues a successor prompt, optionally after `/clear` | `mcp__handover__run`, a queued tool result and log messages, not a pane; requires the Claude mod tool/command/prompt APIs. |
| `orch-board` | shows orch seats, leads, quotas and chat | desktop pane with header band and cards/forms; terminal pane has a text summary, not the rich cards. With no attached surface, opening waits for an attach. Requires the local orch API. |
| `secrets-veil` | masks secret values in tool results, withholding a result when masking fails | masked output, best-effort toast and status line; optional clipboard offer only when explicitly enabled. A missing UI surface does not disable masking; not a guarantee that every possible secret is recognized. |

These are Claude Code mods, not Pi or Codex extensions. Their hooks do not
exclude either macOS or Windows, but runtime API/surface availability still
matters. The installer registers every mod on both platforms; this is not proof
of successful loading on either. Windows mod loading is **not measured**.

The shipped orch service and this pane use the fixed loopback port **7760**
(`http://127.0.0.1:7760`). `ORCH_PORT` is a test-daemon override, not a kit setting;
`orch.lanPort` controls a separate LAN listener, not the pane's API.
**Verify:** inspect the five absolute folders (and any folders you already listed):

```bash
node -e 'const fs=require("fs"),os=require("os"),p=require("path");const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),".claude/settings.json"),"utf8"));console.log(s.env.CLAUDE_CODE_PLUGIN_DIRS.split(p.delimiter).join("\n"))'
```

Quit and reopen the Claude Code desktop app, then run `/orch-board` if the pane
has not already opened. With `curl -s http://127.0.0.1:7760/health` answering,
the desktop pane must show live orch data (the terminal CLI shows a summary);
ask the session to list its tools and confirm `mcp__handover__run` is available.
Settings alone do not prove the mods loaded.

### 7.3 Pi: MCP adapter, settings, sign-ins, codex-edit

Pi is launched only from the pinned path. Define it once:

```bash
PI="$PWD/ops/pi-runtime/node_modules/.bin/pi"
```

MCP adapter (the version orch was measured with):

```bash
"$PI" install npm:pi-mcp-adapter@5.3.2
```

Turn off two built-in extensions that clash with the adapter (merge, keep other keys):

```bash
node -e 'const fs=require("fs"),f=require("path").join(require("os").homedir(),".pi","agent","settings.json");const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};j.extensions=[...new Set([...(j.extensions||[]),"-builtin:mcp","-builtin:llama.cpp"])];fs.mkdirSync(require("path").dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");console.log(j)'
```

`packages` must now hold `npm:pi-mcp-adapter@5.3.2` and `extensions` both `-builtin:` entries.

Adapter 5.3.2 reads its settings and direct-tool declarations from
`~/.pi/agent/mcp-adapter.json`, generated by the `mcp` installer step, not
Pi's built-in `mcp.json`. The installer enables `settings.scriptMode:true`
to retain `mcpScript`. Stock and stand seats pass `--mcp-config` explicitly
so the adapter does not write `-builtin:mcp` into the user's `settings.json`.
Local startup refuses a missing config or an adapter version different from
the committed stand lock's pin. Remote seats keep their explicitly selected
`.mcp.json`. The installer carries eligible legacy `mcp.json` servers into
the new config using the existing keep/preserve rules, without modifying the
legacy file; existing adapter entries win user-entry name collisions.
Upgrade the adapter and regenerate the MCP config together before restarting
orch; reinstall stand arms to migrate their isolated profiles.

Sign-ins: one family at a time. Before you run `node ops/bootstrap/harness-login.mjs <family>`,
say that family's card below, in full. Do not open the window until the card has been said.
Do not add a URL. Never ask for, read or print a key; a key never goes into the chat.
Wait until the user says "done", then prove with `node ops/bootstrap/harness-secret.mjs has <family>`.
The exit code of the login is not the proof. The helper prints the card's `/login` line and starts
Pi; it does not type that line. Do not tell the human to type a different provider line than the
one the window printed.

Cards (say the matching one):

- `claude`. Say: (1) This is Claude Code. (2) The window runs `claude auth login` and opens a browser. (3) Sign in in that browser. Type no key in this chat. (4) The account is your Claude subscription. (5) Close the window and say "done".
- `codex`. Say: (1) This is Codex. (2) The window shows a printed line and then Pi: the helper prints `type /login openai-codex` and then starts Pi; it does not type that line into Pi. (3) In the Pi session, type `/login openai-codex` and sign in in the browser. Type no key in this chat. (4) The account is the ChatGPT subscription. (5) Leave Pi and say "done".
- `grok`. Say: (1) This is Grok. (2) The window shows a printed line and then Pi: the helper prints `type /login xai` and then starts Pi; it does not type that line into Pi. (3) In the Pi session, type `/login xai` and sign in in the browser. Type no key in this chat. (4) The account is the Grok subscription. (5) Leave Pi and say "done".
- `kimi`. Say: (1) This is Kimi. (2) The window shows a printed line and then Pi: the helper prints `type /login kimi-coding` and then starts Pi; it does not type that line into Pi. (3) In the Pi session, type `/login kimi-coding` and sign in in the browser. Type no key in this chat. (4) The account is the Kimi Coding login this sign-in bills. (5) Leave Pi and say "done".
- `opencode`. Say: (1) This is OpenCode Go. (2) The window shows a printed line and then Pi: the helper prints `type /login opencode-go` and then starts Pi; it does not type that line into Pi. (3) In the Pi session, type `/login opencode-go` and paste the OpenCode Go API key there. Do not paste it in this chat. (4) That key is the OpenCode Go API key. (5) Leave Pi and say "done".
- `glm`. Say: (1) This is GLM on Pi, not a Claude login. GLM defaults to Pi with the Z.AI key, not a Claude login. Its optional native route uses the `claude` CLI with the same key. (2) The window runs `harness-secret set glm` and shows one hidden prompt. The endpoint is set automatically; never ask the human to enter a base URL. (3) Paste the Z.AI GLM Coding Plan API key into that hidden prompt. Do not paste it in this chat. (4) That key is the Z.AI Coding Plan API key. (5) When the prompt finishes, close the window and say "done".
- `qwen`. Say: (1) This is Qwen. (2) The window shows a printed line and then Pi: the helper prints `type /login qwen-token-plan-individual` and then starts Pi; it does not type that line into Pi. (3) In the Pi session, type `/login qwen-token-plan-individual` and paste the Qwen token-plan key there. Do not paste it in this chat. (4) That key is the Qwen token-plan key. (5) Leave Pi and say "done".
- `mimo`. Say: (1) This is MiMo. (2) The window shows a printed line and then Pi: the helper prints `type /login xiaomi-token-plan-ams` and then starts Pi; it does not type that line into Pi. (3) In the Pi session, type `/login xiaomi-token-plan-ams` and paste the Xiaomi token-plan key there. Do not paste it in this chat. (4) That key is the Xiaomi token-plan key for `xiaomi-token-plan-ams`. (5) Leave Pi and say "done".

No vendor CLI is needed. The table names the provider the card's line already gives:

| Family | Pi provider to choose | Notes |
|---|---|---|
| codex | `openai-codex` | the ChatGPT subscription; this is what codex seats bill |
| kimi | `kimi-coding` | later, section 10 |
| grok | `xai` | Grok subscription login |
| opencode | `opencode-go` | API key in Pi |
| qwen | `qwen-token-plan-individual` | token-plan key in Pi |
| mimo | `xiaomi-token-plan-ams`, `-sgp` or `-cn` | key for the chosen region in Pi |
| glm | none | key comes from `providers.json` |
| claude | none | claude seats run native Claude Code. Do **not** log Pi in to `anthropic`: Anthropic bills a subscription login from Pi as extra usage |

The `codex-edit` Pi extension (required for codex **coder** seats; a seat start re-verifies it
and fails with this command when it is missing):

```bash
node ops/ab-stand/codex-edit-install.mjs --ensure
```

It downloads `@maxiaochao/pi-toolkit@0.9.3` from npm, checks it against the sha512 pinned in
`ops/ab-stand/codex-edit.json`, installs into `~/.local/state/orch/pi-extensions/codex-edit`
without running package scripts.

### 7.4 The orch service

The installer already loaded it. To (re)install by hand:

```bash
node ops/orchestrator/install.mjs
```

`--dry` prints the platform's service plan (plist on macOS, task XML on Windows);
`--uninstall` removes that unit. Windows uses the same per-user logged-on,
per-minute restart and single-instance task policy as memory (6.2).

**Verify**

```bash
curl -s http://127.0.0.1:7760/health
```

A JSON line with `"version"`, `"schema"`, `"busy":0`.

```bash
node ops/orchestrator/src/main.ts status
```

`"running":true`. Open `http://127.0.0.1:7760/` in a browser: the board loads.

### 7.5 Pause every family that is not installed

For the example set claude + codex + glm (Kimi is added in section 10):

```bash
for f in grok opencode qwen mimo kimi; do node ops/orchestrator/src/main.ts pause "$f" --reason "not installed on this machine"; done; node ops/orchestrator/src/main.ts paused
```

Adjust the list to the families the user did not choose. A pause takes effect on the next seat,
no restart. `unpause <family>` reverses it.

### 7.6 Smoke test (ask the user first: it spends a few real requests per family)

```bash
node ops/orchestrator/src/main.ts smoke --family claude,codex,glm
```

Per family: starts a read-only session in `$TMPDIR/orch-smoke`, gets a nonce echoed, closes,
resumes in a fresh process, asks for the nonce again. Exit 0 means every listed family can be
seated on its default harness. A failure names the family and the vendor's error:

- codex `not logged in` / 401: Pi `/login` for `openai-codex` (7.3).
- glm `glm needs glm.env from .../providers.json`: 7.1; a 401 means the key is wrong.
- claude `out of extra usage` or auth errors: `claude` then `/login`.
- `Pi ... version` / `npm ci --prefix ops/pi-runtime`: phase 5.2.

## 8. Phase E: lead runtime, index, updater

### 8.1 Claude Code lead

Quit and reopen the Claude desktop app (or start a new `claude` session) in the harness home.
The first message of a session shows the SessionStart block. **Verify** it reads:

- `rtk: OK`, `memoryctl: OK`, `codegraph: OK`, `ast-grep: OK`, `rg: OK`, `scout: OK`
- `MCP servers - configured` matches the selected servers (section 2)
- `lead skills linked: 18` with the default skill config

A `DEAD` tool there is a failed phase: fix it before real work.

The app asks once to trust the project and may ask to approve the hooks: the user approves.

### 8.2 Code index for the harness home

```bash
codegraph init --yes .
```

### 8.3 Daily tool updater (optional, the user decides)

```bash
node ops/update-tools.mjs --install-schedule
```

A launchd job on macOS or Task Scheduler job on Windows, once a day: `claude update` (the only vendor CLI),
ast-grep latest, codegraph and rtk only within the pin (a breaking release is held and filed
as a memory task), memoryctl reinstalled when the checkout's copy is newer. Its report is
written in Russian. Remove with `--remove-schedule`. Without it, update tools by hand and keep
`ops/bootstrap/tool-pins.json` as the ceiling for codegraph and rtk.

## 9. Using the harness

### 9.1 A project of the user's

The harness home holds the harness; real work happens in the user's own repositories.

```bash
node ops/kit/adopt-project.mjs /abs/path/to/project
```

With the default skill config, this links the 18 lead skills into `<project>/.claude/skills` (Claude Code resolves skills per
project), hides the links and `.codegraph/` through `.git/info/exclude` (no tracked file
changes) and builds the project's codegraph index. Then the user opens the project in Claude
Code as usual. A Codex lead needs nothing: its skills are in `~/.codex/skills`.

What a seat receives when it works on a project:

- `seat_create { role, title, repo: "/abs/path/to/project" }`: coder, reviewer and bughunter
  seats get their own worktree of **that** repository under `~/.local/state/orch/worktrees/`.
- A Pi seat's first message carries the role duties, the brief, a slice of the **harness
  home's** `CLAUDE.md` (PRIME 1, 3, 4, 5, 6, 9, Work contract 2 and 6, the ladder, the checks,
  the sensor bullets) and the role's skills. A native claude seat loads the **project's** own
  `CLAUDE.md` instead.
- Optional per project: `ops/orchestrator/worktree-setup.json` in the project with a `setup`
  list of shell lines (for example `npm ci`) that orch runs in every new seat worktree. Absent
  means nothing runs, which is correct for a project without install steps.

### 9.2 First delegation, from a lead session

The lead loads the `orch-team` skill and uses the orch MCP tools. Minimal round:

1. `seat_create { role: "scout", title: "map the auth flow", repo: "<project>" }` (no `family`: orch picks by pace).
2. `seat_prompt { seat, text: "<one question, at most 300 words>", files: ["src/auth.ts"] }` returns a turn id and a `wait` command.
3. Run that `node .../main.ts wait <turn>` as a background shell job; its exit prints the digest.
4. For edits: role `coder`, then `review_plan { seat }`, one `reviewer` seat per its answer, `seat_land { seat }` to apply the change to the lead checkout (never commits), then the lead commits explicit paths with `npm run check:commit` and the user's approval. That check runs the commit-safety check and the gates those paths select; it does not run the orchestrator tests, the kit build or the knowledge-history judgement. A reviewer runs a test only to prove a finding of its own.
When several machines can run a seat, the machine that runs orch is ranked after a reserve of 6 cores and 12 GB of free memory, floored at zero (`ops/orchestrator/src/placement.ts`); a tie goes to a host. `seat_create` with `needs` set to `mac` requires `needs_reason` of at most 300 characters (`ops/orchestrator/src/http.ts`), unless the seat is Claude, a native harness, a stand arm, or a task file is a configured Mac-only path.
Full rules: `.agents/skills/orch-team/SKILL.md` and `ops/orchestrator/README.md`.


### 9.3 Adapt these to the user's project (do it with the user, after the install works)

The kit is cut from a working product repository. The mechanics are generic; some texts still
name that product's commands. They do not break the install, they mislead a seat:

- `CLAUDE.md` / `AGENTS.md` (must stay byte-identical): PRIME 1, 3, 4, 9 are neutral
  placeholders; write the user's real runtime, typecheck command, stack and UI rule there.
  Keep every heading, item number and bullet label (the file's first paragraph lists them);
  orch refuses to start Pi seats when one is missing. Restart is not needed: it is read per seat.
- Skills that are inlined into every coder or lead turn and name donor commands
  (`tsconfig.app.json`, `npx vitest run`, `cargo check -p`, `npm run check:*`): `verify-change`
  (coder default), `land-worktree`, `next`, `orch-team`, `edit-contract-mirror`,
  `visual-critique`, `desktop-interaction-review`. Replace those commands with the project's,
  keep the method.
- Environment and memory pages describe the portable local layout. Donor NAS deployment,
  workstation cloning, migration tooling and private frozen benchmark data are excluded.
  Configure your own remotes and backup destination; no remote bypasses publication
  acknowledgement, and the kit never pushes commits automatically. Generate your own
  evaluation inputs before scoring. Set `HARNESS_PROJECT_ROOT` when collecting reports
  outside the project checkout.
- Domains: only `domain-harness` and the catch-all `domain-platform-shell` exist. A knowledge
  page for the user's own subsystem: `.agents/domains/_domain-routing.schema.md`, then
  `npm run check:memory-routing`.

### 9.4 Skills: where to find them and how to install them

For document work (contracts, invoices, Word/Excel/PDF files), the kit ships
no document skills; add them this way.

**Where to look**

| Source | What it is | How to search |
|---|---|---|
| https://skills.sh/ | directory and leaderboard of the open Agent Skills ecosystem | browse, or `npx skills find <query>` (for example `npx skills find docx`, `npx skills find pdf`, `npx skills find invoice`) |
| https://github.com/anthropics/skills | Anthropic's own collection; holds the document skills `docx`, `xlsx`, `pptx`, `pdf` | read the repository; its README carries the current Claude Code plugin commands |
| https://github.com/badlogic/pi-skills | the Pi author's skill collection | read the repository |
| https://agentskills.io/specification | the format every one of them follows (a directory with `SKILL.md`) | reference |

The lead skill `find-skills` (`.agents/skills/find-skills/SKILL.md`, already linked) is the
method for this search: the lead runs it when the user asks "is there a skill for X".
A lead app's bundled skills do not populate the harness skill map. The steps
below deliver vetted skills to leads and worker seats through that map.

**How skills reach each runtime here (this decides where to install)**

- Worker seats never discover skills on their own: orch starts Pi with `--no-skills` and
  delivers skills itself from `HARNESS/.agents/skills`, chosen by
  `HARNESS/.agents/domains/_skill-map.json`. A skill installed anywhere else
  (`~/.pi/agent/skills`, `~/.agents/skills`, a project's `.pi/skills`) is invisible to seats.
- Seats cannot install skills: the seat guard lets the skills CLI run read verbs only.
- A Claude lead reads `<project>/.claude/skills`; a Codex lead reads `~/.codex/skills`. Both are
  filled by the installer from the map's `leadInstalledSkills`.

So the one place a skill is installed is the harness home, and the map decides who gets it:

1. **Vet it first.** A skill is instructions plus scripts that agents will execute. Read its
   `SKILL.md` and every script; check the `LICENSE` (Anthropic's document skills carry their
   own license terms: read them before copying); prefer official owners (`anthropics`,
   `vercel-labs`, `microsoft`) and note the commit you took.
2. **Copy it in:** `HARNESS/.agents/skills/<name>/` with its `SKILL.md`, scripts and `LICENSE`,
   unmodified. Add `PROVENANCE.md` beside it: source URL, commit, license, your own edits (the
   existing vendored skills, for example `.agents/skills/find-skills/PROVENANCE.md`, show the
   shape). Do not use `npx skills add -g`: it writes into agent homes behind the map's back.
3. **Register it** in `.agents/domains/_skill-map.json`:
   - for the lead: append the name to `leadInstalledSkills`;
   - for seats, by task wording: add a `triggers` entry. The `match` is a regular expression
     over the brief, so include the user's own words in both languages. Example for documents:
     `{ "id": "documents", "match": "\\b(docx|xlsx|pptx|pdf|word|excel|spreadsheet|invoice|contract|template)\\b|документ|договор|счёт|счет|акт|таблиц|шаблон", "skills": ["docx", "xlsx", "pdf"], "roles": ["lead", "coder", "researcher"] }`
   - `roleDefaults` inlines a skill into **every** seat of that role: use it only for a skill
     every such seat needs, it costs tokens each time.
4. **Check and deliver:** `npm run check:skill-map`, then
   `node ops/bootstrap/install-harness.mjs --no-require-providers --skip-code-intel --only skills`,
   then `node ops/kit/adopt-project.mjs <project>` again for each adopted project (it links
   the new lead skills). No orch restart: the map and the skills are read per seat.
5. **Prove it:** create a seat whose brief contains a trigger word; its board card lists the
   skill, lit once the seat read it.
6. Commit the skill, its provenance and the map together.

**System tools document skills usually call** (the skill's own `SKILL.md` is the authority;
install what it names): Python through `uv` (`brew install uv`), LibreOffice for conversion
(`brew install --cask libreoffice`), `brew install pandoc poppler qpdf`, `brew install tesseract`
for OCR of scans. Seats run them through their shell, so they must be on the canonical PATH
(`/opt/homebrew/bin` is).

A repeated document procedure of the user's own (how a contract is checked, where invoices are
filed) becomes a skill of its own through the lead skill `distill-skill`, and durable facts
about the process go to memory (`memoryctl append`), not into a skill.

### 9.5 Pi extensions: where to find them and how to install them

**Where to look:** the Pi package gallery https://pi.dev/packages (it lists npm packages that
carry the `pi-package` keyword; `npm search pi-package` reaches the same set), and the Pi
documentation shipped with the pinned runtime:
`HARNESS/ops/pi-runtime/node_modules/@earendil-works/pi-coding-agent/docs/` (`packages.md`,
`extensions.md`, `skills.md`, `security.md`, `mcp.md`). Read those for version 1.4.0 rather
than a newer online page.

**How to install** (always through the pinned binary, with an exact version or ref):

```bash
PI="$PWD/ops/pi-runtime/node_modules/.bin/pi"
```

| Action | Command |
|---|---|
| personal install (every Pi session of this user, **including every orch seat**) | `"$PI" install npm:<package>@<version>` or `"$PI" install git:github.com/<owner>/<repo>@<ref>` |
| project-only install (written to `.pi/settings.json`) | add `-l`; orch seats do **not** load it (they run with `--no-approve`, which skips project-trust-gated resources) |
| try once without installing | `"$PI" -e npm:<package>` |
| list / remove / update | `"$PI" list`, `"$PI" remove <source>`, `"$PI" update` |

Personal installs are recorded in `~/.pi/agent/settings.json` under `packages` (that is where
`npm:pi-mcp-adapter@5.3.2` already sits).

**Rules for this harness**

- A package runs code with the user's rights and may bring skills that tell the model to run
  programs. Read its source before installing, as Pi's own `security.md` says.
- A personal package loads into every seat. One that replaces or removes a built-in tool
  (`bash`, `edit`, `read`, `mcp`) breaks seats: orch checks the tool list it expects and flags
  `tools missing`, and orch's own guard extension must stay in control of `bash`. Do not
  install editing or shell replacements; `codex-edit` is the one such extension and orch
  manages it itself.
- Read-only seats start Pi with an explicit tool list: built-in read/search tools,
  guarded `bash`, `mcp`, and the harness-approved direct and context tools.
  An arbitrary extension tool is not automatically added to that list.
- Keep `pi-mcp-adapter` at 5.3.2 and Pi at 1.4.0; do not run `"$PI" update` blindly. After any
  change run `node ops/orchestrator/src/main.ts smoke --family codex` and check that the next
  seat digest has no `tools missing` flag. Remove the package if it does.
- A capability every runtime should have (not only Pi seats), such as access to a document
  store, belongs in an **MCP server**, not a Pi extension: add it to
  `ops/bootstrap/mcp-servers.json`, name the roles that may use it in
  `ops/orchestrator/mcp-by-role.json`, record it in `docs/agent/harness-allowlist.md`, rerun
  the installer and restart orch.

### 9.6 Recurring routines

`ops/routines/` holds the shipped routine definitions: id, title, five-field cron, summary
and prompt. List them with:

```bash
node scripts/routines.mjs list
```

The lead skill `setup-routines` shows the list and asks which routines the user wants.
Only the lead app's scheduler creates the chosen tasks; this command only lists the data.
The skill skips existing ids and never edits or deletes scheduled tasks.
See `.agents/skills/setup-routines/SKILL.md`.

### 9.7 To change a choice later

`orch` below means `node ops/orchestrator/src/main.ts`. For anything the table does not
cover, ask a lead session to follow [INSTALL-PROMPT.md](INSTALL-PROMPT.md) again.

| To change | Run |
|---|---|
| The machines that run seats | `orch hosts add <name> --ssh <alias> --platform <p> --repo <path> --node <path>`, `orch hosts remove <name>`; see them with `orch hosts list` |
| Where the memory writer runs, a memory forward | the `machines` step of [INSTALL-PROMPT.md](INSTALL-PROMPT.md) |
| The families you have | the `families` step of [INSTALL-PROMPT.md](INSTALL-PROMPT.md). To take one out for a time: `orch pause <family> --reason "<text>"`, back with `orch unpause <family>`; see them with `orch paused` |
| A login or a provider key | the `logins` step of [INSTALL-PROMPT.md](INSTALL-PROMPT.md). For a key: `node ops/bootstrap/harness-secret.mjs set <name>` |
| The role team | `orch roles preset <tier> --families <a,b,...>` (add `--dry-run` to see it first), `orch roles set <role> <family> <model> [<effort>]`, `orch roles reset <role>`; see them with `orch roles show` |
| The skills that are off, the skills of a lead | the `skills` and `lead skills` steps of [INSTALL-PROMPT.md](INSTALL-PROMPT.md) |
| The MCP servers that are off | the `mcp` step of [INSTALL-PROMPT.md](INSTALL-PROMPT.md) |
| The embedding endpoint or model | the `memory` step of [INSTALL-PROMPT.md](INSTALL-PROMPT.md) |
| The Jev key | `node ops/bootstrap/harness-secret.mjs set jev` |
| The reply language, the answer style, your own instruction text | the `lead` step of [INSTALL-PROMPT.md](INSTALL-PROMPT.md) |
| The brief-language mode | `orch language off`, `orch language flag` or `orch language enforce`; `orch language` shows it |
| The scheduled routines | ask your lead session to run the skill `setup-routines` |

## 10. Adding Kimi later

1. Say the kimi card, then run `node ops/bootstrap/harness-login.mjs kimi`. Do not open the
   window until the card has been said. Say: (1) This is Kimi. (2) The window shows a printed
   line and then Pi: the helper prints `type /login kimi-coding` and then starts Pi; it does
   not type that line into Pi. (3) In the Pi session, type `/login kimi-coding` and sign in
   in the browser. Type no key in this chat. (4) The account is the Kimi Coding login this
   sign-in bills. (5) Leave Pi and say "done". This login is what kimi seats bill.
   orch passes no other Kimi key and unsets an inherited `KIMI_API_KEY`.
2. Add Kimi to the chosen set, then rerun the installer so the Kimi home gets instructions,
   skills, MCP and hooks:
   `node ops/bootstrap/harness-config.mjs set families.enabled '["claude","codex","glm","kimi"]'`
   (POSIX), or
   `node ops/bootstrap/harness-config.mjs set families.enabled '[\"claude\",\"codex\",\"glm\",\"kimi\"]'`
   (Windows PowerShell),
   then `node ops/bootstrap/install-harness.mjs --no-require-providers --skip-code-intel`.
3. `node ops/orchestrator/src/main.ts unpause kimi`
4. `node ops/orchestrator/src/main.ts smoke --family kimi` must exit 0.

No orch restart or vendor CLI installation is needed.

Any other Pi family from section 2 follows the same four steps with its own family and
Pi provider; `grok` uses `xai`, and `opencode` uses `opencode-go`.

## 11. Operations

### 11.1 Services

| Action | Command |
|---|---|
| orch status | `node ops/orchestrator/src/main.ts status` |
| orch restart when idle (keeps queued turns) | `node ops/orchestrator/src/main.ts restart --when-idle` |
| orch restart now (macOS) | `launchctl kickstart -k gui/$(id -u)/com.booharness.orch` (running turns end as `interrupted`) |
| orch log | `~/.local/state/orch/orch.log` (JSONL); macOS also has `launchd.out.log` and `launchd.err.log` |
| memoryd restart (macOS) | `launchctl kickstart -k gui/$(id -u)/local.harness.memoryd` |
| memoryd log | `~/.local/state/memoryctl/memoryd.log`; macOS also has `service.err.log` |
| Windows service inspection | Task Scheduler: `booharness-orch` and `booharness-memoryd`; do not run `launchctl` there |
| Ollama restart (macOS) | Bootstrap-owned: `launchctl kickstart -k gui/$(id -u)/com.booharness.ollama`; otherwise use the existing owner's restart route |

orch must be restarted after its source changes (`ops/orchestrator/src`, the files it imports
from `ops/bootstrap`); `/health` shows the code fingerprint.

### 11.2 Memory backup

`~/.local/state/memoryctl/memory.db` is the live database of handoffs, decisions and lessons.
The installer does not arrange backups. On macOS, Time Machine can cover it when enabled.
For a consistent manual snapshot onto **another disk**
(the script refuses a destination on the same filesystem):

```bash
node ops/backup-memory.mjs --source ~/.local/state/memoryctl/memory.db --destination /Volumes/<disk>/memory-backup
```

Check `node ops/backup-memory.mjs --help` first; the destination directory must already exist.
Never copy `memory.db` alone while memoryd runs: the WAL file belongs with it.

### 11.3 16 GB guidance

Orch's heavy provisioning steps (`npm ci`, `codegraph init`) pass a machine-wide build gate
with 2 slots by default (`ORCH_BUILD_SLOTS`). Automatic coder picks default to a cap
of 5 working coders per family, except Codex, whose cap is 10.
On 16 GB start with two or three seats at once and watch memory pressure; the embedder
(`qwen3-embedding:0.6b`, a ~640 MB pinned GGUF import) is small and Ollama unloads it after idle minutes.
The cross-encoder reranker adds about 2.1 GiB RSS while memoryd is up (decision #19106).

### 11.4 Disk

Seat worktrees live in `~/.local/state/orch/worktrees`. orch safely prunes landed coder
worktrees; an idle-auto-close delays that pruning. Idle closure defaults are 12 hours
for landed coders, two days for unlanded coders and one day for other roles.
`node ops/orchestrator/src/main.ts prune --dry-run`
lists what a manual prune would remove; `prune --caches` frees build caches of closed seats.
Closing a seat stops processes whose working directory is that seat's worktree, after the provider stops. A sweep of remote-host checkouts keeps one that still has unlanded edits, including edits hidden by assume-unchanged or skip-worktree, and removes a checkout only with `git worktree remove` and without `--force`.

### 11.5 Changing the reply language or the shared instructions

Set the config key `lead.replyLanguage`; for example:

```bash
node ops/bootstrap/harness-config.mjs set lead.replyLanguage '"English"'
```

Windows PowerShell:

```powershell
node ops/bootstrap/harness-config.mjs set lead.replyLanguage '\"English\"'
```

Then rerun the instruction step:

```bash
node ops/bootstrap/install-harness.mjs --only instructions
```

The installer renders the language in the shared instruction block; absent the key, it uses
Russian. Do not edit the language token in `ops/bootstrap/agent-instructions.md`.
For other shared instructions, edit that source and rerun the same step. Keep `CLAUDE.md`
and `AGENTS.md` identical when adapting the project contract (9.3).
The SessionStart plain lead style defaults on. Set `lead.plainStyle` to `false`
through `harness-config`; the next session reads it without an installer rerun. The
`i-have-adhd` skill is also in the default lead set; step 7 of INSTALL-PROMPT.md
controls the installed skill selection independently.

### 11.6 The caveman plugin (retired)

Kits before 2026-10-08 installed the Claude Code plugin `caveman@caveman` for terse replies.
It is retired: the installer's `plugins` step now turns the plugin off (its `enabledPlugins`
flag in `~/.claude/settings.json` becomes `false`) and removes its marketplace and registry
keys, keeping every unrelated entry. A full installer rerun retires it on its own; a
`--only <other step>` run skips the retirement. The step also registers the official
Anthropic plugin marketplace and checks that Claude Code wrote its registry receipt.
It moves plugin skill directories whose declared names collide with harness skills
into `.skills-removed-by-harness` beside their skill root. The lead style is
configured separately (11.5), not by the retired plugin.

### 11.7 Uninstall

```bash
node ops/orchestrator/install.mjs --uninstall; node ops/memory-local/install.mjs --uninstall; node ops/update-tools.mjs --remove-schedule
```

Configs in the runtime homes stay; the marked blocks (`booharness-bootstrap`,
`booharness-harness-path`, `booharness-codex-trust`) can be deleted by hand. State stays in
`~/.local/state/orch` and `~/.local/state/memoryctl` until the user removes it.

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find package 'yaml'` at a seat start or in a hook | root `npm ci` not run | phase 5.2, first command |
| `memoryctl search` answers `HTTP 503 ... embedder` | Ollama down, model absent, or memoryd started without the embed URL | Restart its owning service (11.1); `ollama list` must show the configured model; follow phase 6, then `node ops/memory-local/install.mjs` |
| `memoryctl: token file missing` | memoryd never started, so no token | phase 6.2; read `service.err.log` |
| `memory-local: ... service.url ...` | an older remote-mode install left `~/.local/state/memoryctl/service.url` | if it names `http://127.0.0.1:7717`, `rm` that file, then `node ops/memory-local/install.mjs` again |
| `memory-local: ... com.booharness.memoryctl.plist exists` | someone ran `install-memory.mjs` bare (its default label) | `launchctl bootout gui/$(id -u)/com.booharness.memoryctl`, remove that plist, then `node ops/memory-local/install.mjs` again |
| installer exits 1 `required provider(s) not found` | Claude Code is required by the chosen set and missing | install the `claude` CLI (5.4); use `--no-require-providers` only to bypass the check |
| installer: `is a git checkout without .githooks` | the checkout is incomplete | compare with `KIT-MANIFEST.json`; clone into a fresh directory, never overwrite existing changes |
| `orchestrator: skipped ... linked worktree` | installer run from a worktree | run it from the main checkout |
| orch `/health` refuses the connection | unit not loaded or crashed at start | macOS: `launchctl print gui/$(id -u)/com.booharness.orch` and `launchd.err.log`; Windows: inspect task `booharness-orch`; check Node and all three npm installs (5.2) |
| seat fails: `CLAUDE.md: missing ... heading` or `... drifted` | the harness home contract lost an anchor | restore the heading, item number or bullet label named in the message (compare with git history) |
| seat fails: Pi version or `npm ci --prefix ops/pi-runtime` | Pi not installed at the pin | phase 5.2, third command |
| codex coder seat fails naming `codex-edit` | extension missing or changed | `node ops/ab-stand/codex-edit-install.mjs --ensure` |
| `seat_create`: `no family is left for a <role>` | too many families paused or stepping aside | `main.ts paused`; unpause an installed family or name `family` explicitly |
| seat picked a family that is not installed | that family is not paused | phase 7.5 |
| a family shows `usage unreadable` on the board | credentials are missing or expired, or quota needs a separate login | use the family's login helper (7.3); qwen and mimo quota limits are described in INSTALL-PROMPT.md |
| SessionStart shows `codegraph ... parent branch` | a new worktree has no index | `codegraph init --yes .` in that checkout |
| `rtk filters: NOT applied` | this checkout's `.rtk/filters.toml` is not trusted | `node ops/bootstrap/install-harness.mjs --no-require-providers --skip-code-intel --only rtk-filters` |
| Claude Code: `orch` MCP disconnected | orch was down when the session started | start orch, then reconnect MCP servers or open a new session |

## 13. Final acceptance

All must pass before telling the user the install is done:

1. `node --version` is v24+; Pi is 1.4.0; `rtk --version` is 1.0.1; `codegraph --version` is 1.6.2; `rg` and `ast-grep` run.
2. `node ops/memory-local/install.mjs --check` and `npm run check:memory-routing` exit 0.
3. `curl -s http://127.0.0.1:7717/health` shows `"reachable":true` and `"missing":0`.
4. `memoryctl search "<a phrase, not the exact title>"` returns the entry written in phase 6.
5. `curl -s http://127.0.0.1:7760/health` answers; `http://127.0.0.1:7760/` loads.
6. `node ops/orchestrator/src/main.ts paused` lists exactly the families the user did not choose.
7. `node ops/orchestrator/src/main.ts smoke --family <chosen families>` exits 0.
8. A new lead session shows every tool `OK`, the selected MCP servers, and `lead skills linked: 18` with the default skill config.
9. From that session: one scout seat on any repository answers a question (9.2, steps 1 to 3).
10. `git status` in the harness home is clean apart from ignored files. The install itself
    changes two tracked files: `docs/agent/domain-routing.generated.json` (5.2) and
    `ops/bootstrap/harness.config.json` (6.1 embedding URL, 11.5 reply language). Show that
    diff to the user and ask; commit only those two files after the user agrees.
11. `node ops/bootstrap/doctor.mjs` has no remaining fault. Show each `not checked`
    row and optional unavailable feature; neither is proof that the feature works.

Then write the handoff the next session will read:
`memoryctl handoff --title "Harness installed" --body "<what was installed, which families, what was left open>" --no-open-work`
(or `--task <id>` for anything left open; read the `memoryctl` skill for the exact flags).

## 14. What the kit is and what was checked

- Source: the donor repository at the commit in `KIT-MANIFEST.json` (`sourceCommit`), tracked
  files only. No secrets, no memory database, no product code.
- The shipped `.agents/domains/_skill-map.json` is the inventory of skills, default
  lead selection, role defaults and triggers. Run `npm run check:skill-map` to
  validate its references. The kit retains the harness and platform-shell domains.
- `excluded`, `excludedSkills`, `closureAdded` and `overlays` in the manifest
  describe the cut and its adaptations. These include data, contracts, portable
  docs and selected source text changes; the kit is not a byte-identical donor
  checkout. Product-specific skills, private endpoints and build tooling are
  excluded. No `kit-builder/` or private leak-pattern inventory ships.
- The local memory wrapper supports macOS LaunchAgents and Windows tasks;
  `ops/kit/adopt-project.mjs` links lead skills and indexes projects. Root
  `package.json` supplies the harness commands; dependencies are installed from
  the three lockfiles in 5.2, not bundled `node_modules`.
- A manifest and a successful kit build prove package integrity, not a working
  installation. The Verify blocks and §13 must be run on the target machine.
  The dated Windows observations in 4.2 are historical evidence, not a claim
  that today's pins, provider logins, mods, embeddings or updater passed there.
