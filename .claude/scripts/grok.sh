#!/usr/bin/env bash
# grok.sh — Grok CLI (xAI) worker/consultant, headless one-shot. Same call shape
# as glm.sh / `kimi -p` / `codex exec`: bash .claude/scripts/grok.sh -p "task".
# Auth = OIDC session in ~/.grok/auth.json (grok.com SuperGrok subscription, flat
# quota — NOT the metered xAI API). If auth expires: run `grok login` interactively.
#
# Model probe updated 2026-07-22: `grok -m grok-4.5 --reasoning-effort high`
# exits 0 and returns a result. Manual wrapper calls keep the CLI default when
# GROK_MODEL is empty; daemon profile mode pins the verified grok-4.5/high pair.
#
# Usage:  bash .claude/scripts/grok.sh -p "one-line task; return a digest"
#         GROK_MODEL=<known-good-id> bash .claude/scripts/grok.sh -p "..."
# Extra grok flags pass through (e.g. --worktree feat, --json-schema '...').
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$repo" ] || repo="$(cd "$here/../.." && pwd)"

# Binary resolve: PATH first, then the default install location (installer does
# NOT add it to Git Bash / PowerShell PATH on Windows — verified 2026-07-08).
GROK_BIN="${GROK_BIN:-}"
if [ -z "$GROK_BIN" ]; then
  if command -v grok >/dev/null 2>&1; then GROK_BIN="grok"
  elif [ -x "$HOME/.grok/bin/grok.exe" ]; then GROK_BIN="$HOME/.grok/bin/grok.exe"
  elif [ -x "$HOME/.grok/bin/grok" ]; then GROK_BIN="$HOME/.grok/bin/grok"
  else echo "grok CLI not found (PATH, ~/.grok/bin). Install: https://x.ai/cli" >&2; exit 127
  fi
fi

GROK_MODEL="${GROK_MODEL:-}"   # empty = CLI default model (no -m); xAI ids churn
GROK_EFFORT="${GROK_EFFORT:-high}"
if [ "${TEAM_PROFILE_LOCKED:-0}" = 1 ]; then
  [ "$GROK_MODEL" = "grok-4.5" ] || { echo "grok.sh: locked profile requires grok-4.5" >&2; exit 2; }
  [ "$GROK_EFFORT" = "high" ] || { echo "grok.sh: locked profile requires effort high" >&2; exit 2; }
  unset GROK_NO_EFFORT
fi

# Full access, no sandbox, no timeout (operator directive: the team runs full-access).
# --always-approve: headless runs must never park on an approval prompt.
# stderr note: grok may log "Failed to spawn MCP server ..." for MCP servers from the
# host config it can't launch — harmless noise, the run continues (verified 2026-07-08).
cap="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/grok-out.$$")"
grok_model_args=()
[ -n "$GROK_MODEL" ] && grok_model_args=(-m "$GROK_MODEL")
# max effort always (operator: external models ALWAYS max effort); verified for
# grok-4.5 on 2026-07-22. Manual calls may explicitly opt out via GROK_NO_EFFORT.
grok_effort_args=(--reasoning-effort "$GROK_EFFORT")
[ "${GROK_NO_EFFORT:-0}" = 1 ] && grok_effort_args=()
"$GROK_BIN" ${grok_model_args[@]+"${grok_model_args[@]}"} ${grok_effort_args[@]+"${grok_effort_args[@]}"} --always-approve "$@" 2>&1 | tee "$cap"
rc="${PIPESTATUS[0]}"

rm -f "$cap" 2>/dev/null || true
exit "$rc"
