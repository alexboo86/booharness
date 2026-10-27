#!/usr/bin/env bash
#
# ops/setup-machine.sh — toolchain plus the ONE node harness installer.
#
# Brings a fresh clone of this repo to "fully operational for agent work":
#   1. verifies / installs the toolchain (node, uv, rust, git, docker, claude)
#   2. installs the code-intel CLIs (codegraph, ast-grep) - codegraph keeps an index,
#   3. runs ops/bootstrap/install-harness.mjs (MCP, skills, hooks, instructions,
#      canonical PATH). That file is the installer on every platform. There is
#      no .sh twin of the PowerShell scripts — duplicating them is how the
#      live MCP set drifted from this file.
#
# The CODE, project skills, project hooks and rules already arrive via `git pull`.
# Secrets stay in the gitignored env file the node installer reads
# (~/.claude/<prefix>-secrets.env, where <prefix> is names.prefix of
# ops/bootstrap/harness.config.json). They are
# never written into a committed SSOT or registry.
#
# Idempotent: safe to re-run.
#
# Usage:
#     bash ops/setup-machine.sh                 # run from the repo root
#     REPO_ROOT=/path/to/clone bash ops/setup-machine.sh   # or over `ssh host bash -s`
#
set -euo pipefail

# ---------------------------------------------------------------------------
# locate repo root. Honor an explicit REPO_ROOT (needed when piped over SSH
# stdin, where BASH_SOURCE is unreliable); else derive from the script path.
# ---------------------------------------------------------------------------
if [ -z "${REPO_ROOT:-}" ]; then
  _src="${BASH_SOURCE[0]:-$0}"
  if [ -f "$_src" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$_src")" && pwd)"
    REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  else
    REPO_ROOT="$(pwd)"
  fi
fi

OS="$(uname -s)"   # Darwin | Linux | MINGW*/MSYS* (Windows git-bash)

# ---------------------------------------------------------------------------
# logging helpers (no color codes — safe over SSH / in logs)
# ---------------------------------------------------------------------------
log()  { printf '\n=== %s ===\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

FAIL=0
need() {  # need <cmd> <human-install-hint>
  if have "$1"; then
    info "ok: $1 ($("$1" --version 2>&1 | head -1))"
  else
    warn "MISSING required: $1 — $2"
    FAIL=1
  fi
}

log "machine setup — repo: $REPO_ROOT  os: $OS"

# ---------------------------------------------------------------------------
# 1. toolchain
# ---------------------------------------------------------------------------
log "1/3  toolchain"
need git    "install git"
need node   "install Node.js 20+ (https://nodejs.org or nvm)"
need npm    "ships with Node.js"
# claude (and glm, which is the same CLI) only when an enabled family needs it.
# Absent families.enabled prints today's four, so this step still runs.
# Without node the list cannot be read: node is reported missing above, and the
# claude check runs as it did before the list existed. A config that the reader
# refuses is a failed check, not an abort of this script.
CLIS="claude"
if have node; then
  if ! CLIS="$(node "$REPO_ROOT/ops/bootstrap/resolve-runtime-path.mjs" --clis)"; then
    warn "cannot read the provider CLI list — fix ops/bootstrap/harness.config.json (the error is above)"
    FAIL=1
  fi
fi
if printf '%s\n' "$CLIS" | grep -qx 'claude'; then
  need claude "install Claude Code (npm i -g @anthropic-ai/claude-code)"
fi

# cargo/rustup: required to build Rust crates. Don't auto-install a
# whole toolchain silently; instruct instead.
need cargo   "install Rust (https://rustup.rs)"

# uv/uvx: kept for python-based tooling. Small + safe to auto-install.
if have uvx; then
  info "ok: uvx ($(uvx --version 2>&1 | head -1))"
else
  warn "uvx missing — installing uv…"
  if have curl; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    # uv installs to ~/.local/bin or ~/.cargo/bin — add to PATH for this run
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
    have uvx && info "uv installed" || warn "uv install did not expose uvx on PATH — re-open your shell"
  else
    warn "no curl — install uv manually: https://docs.astral.sh/uv/getting-started/installation/"
    FAIL=1
  fi
fi

if have docker; then
  info "ok: docker ($(docker --version 2>&1 | head -1))"
else
  warn "docker missing — optional, not required for the harness"
fi

if [ "$FAIL" -ne 0 ]; then
  warn "required tooling missing (see above). Install it, then re-run."
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. code-search CLIs (no index to build, on any machine)
# ---------------------------------------------------------------------------
log "2/3  codegraph + ast-grep (code intel)"
info "installing/upgrading @colbymchenry/codegraph and @ast-grep/cli (global)…"
CODEGRAPH_PIN="$(node -e 'const fs = require("node:fs"); const pin = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).codegraph; if (!/^\d+\.\d+\.\d+$/.test(pin)) throw new Error("invalid codegraph pin"); process.stdout.write(pin)' "$REPO_ROOT/ops/bootstrap/tool-pins.json")"
npm install -g "@colbymchenry/codegraph@$CODEGRAPH_PIN" >/dev/null 2>&1 || npm install -g "@colbymchenry/codegraph@$CODEGRAPH_PIN"
npm install -g @ast-grep/cli >/dev/null 2>&1 || npm install -g @ast-grep/cli
info "codegraph $(codegraph --version 2>&1 | head -1)"
info "ast-grep $(ast-grep --version 2>&1 | head -1)"

# NOTHING to build here, and that is the point of the pair. Until 2026-08-13 this
# step also built a per-machine index and re-synced it on every run; the
# replacement reads the tree it is pointed at and keeps nothing, so a fresh
# machine is searchable the moment the install finishes.
#
# The MCP set, skills, hooks, instructions and the canonical PATH are owned by
# the node installer. This file used to write a stale .mcp.json by hand.

# ---------------------------------------------------------------------------
# 3. harness (MCP / skills / hooks / instructions / PATH)
# ---------------------------------------------------------------------------
log "3/3  harness installer"
if ! have node; then
  warn "node missing — cannot run ops/bootstrap/install-harness.mjs"
  exit 1
fi
node "$REPO_ROOT/ops/bootstrap/install-harness.mjs" --repo "$REPO_ROOT"
if [ "$OS" = Darwin ]; then
  node "$REPO_ROOT/ops/update-tools.mjs" --install-schedule
fi
info "harness installed; provider PATH is the same from ssh, launchd and env -i"

# ---------------------------------------------------------------------------
# 7. retired orchestration cleanup
# ---------------------------------------------------------------------------
log "7  retired orchestration cleanup"
# Per-clone Kimi skills are not git-tracked. Remove former orchestration and
# direct-consultant wrappers so they cannot survive an upgrade. Skills for a
# member seat are installed and verified by its own launcher (Paseo, formerly
# Svod); setup-machine must not synthesize them.
for s in team team-code codex kimi; do
  d="$REPO_ROOT/.kimi-code/skills/$s"
  if [ -d "$d" ]; then rm -rf "$d" && info "removed retired .kimi-code/skills/$s"; fi
done

# ---------------------------------------------------------------------------
# verification checklist
# ---------------------------------------------------------------------------
log "DONE — verify"
# The prefix rule (pattern and the 32-character limit) is owned by the shared
# reader, scripts/lib/harness-config.mjs validatePrefix; keep this guard equal.
SECRETS_PREFIX="$(node -e 'const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).names.prefix; if (typeof p !== "string" || !/^[a-z][a-z0-9-]*$/.test(p) || p.length > 32) throw new Error("invalid names.prefix"); process.stdout.write(p)' "$REPO_ROOT/ops/bootstrap/harness.config.json")"
cat <<EOF
  code intel      : codegraph --version && ast-grep --version
  harness         : node ops/bootstrap/resolve-runtime-path.mjs --require --json
  MCP servers     : rendered from ops/bootstrap/mcp-servers.json into each runtime

  Secrets for required MCP servers live in ~/.claude/${SECRETS_PREFIX}-secrets.env
  and are never written into git.
EOF
