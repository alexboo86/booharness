#!/usr/bin/env bash
# glm-lead.sh — run a FULL-HARNESS Claude Code session with GLM-5.3 as the LEAD
# model (instead of Opus), via Z.ai's Anthropic-compatible endpoint.
#
# This is the "GLM instead of Opus" launcher (operator request 2026-06-25). It
# differs from glm.sh (the WORKER) in one decisive way: it does NOT swap to a lean
# MCP-less config — it uses your REAL config dir, so the GLM session keeps the full
# harness (all MCP servers, skills, hooks, code search). GLM becomes the brain;
# everything else is unchanged.
#
# ⚠️ KNOWN CAVEAT being verified: glm.sh found that a freshly-spawned nested claude
# loading our ~20 MCP servers HANGS under GLM latency (exit 124), which is exactly
# why the WORKER uses a lean config. Whether that hang also hits a full-harness LEAD
# launch is what the `--smoke` path below checks. Run `glm-lead.sh --smoke` first.
#
# Usage:
#   bash .claude/scripts/glm-lead.sh --smoke      # non-interactive startup probe (bounded)
#   bash .claude/scripts/glm-lead.sh              # launch an interactive GLM-lead session
#   bash .claude/scripts/glm-lead.sh -p "task"    # one-shot GLM-lead print mode
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$repo" ] || repo="$(cd "$here/../.." && pwd)"
keyfile="$repo/.secrets/zai-glm.env"
if [ -f "$keyfile" ]; then . "$keyfile"; fi
: "${ZAI_API_KEY:?ZAI_API_KEY missing — put it in .secrets/zai-glm.env}"

# TRIMMED-MCP lead config (verified fix for the exit-124 hang): the full ~/.claude
# loads ~20 MCP servers (chrome/playwright/figma/supabase/voicemode/…) which HANG
# startup under z.ai latency. A fresh config dir loads ZERO MCP (worker proves it
# starts fast). This lead config adds back ONLY the code search (local binary,
# fast, the highest-value code-intel) — heavy/network servers stay out so the
# lead boots.
# Add more later by editing ~/.glm-lead-config/.claude.json mcpServers, re-smoking.
export CLAUDE_CONFIG_DIR="${GLM_LEAD_CONFIG_DIR:-$HOME/.glm-lead-config}"
mkdir -p "$CLAUDE_CONFIG_DIR" 2>/dev/null
GLM_MODEL="${GLM_MODEL:-glm-5.3}"   # glm-5.3 = 200K ctx; GLM_MODEL=glm-5.3[1m] for 1M ctx
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
export ANTHROPIC_AUTH_TOKEN="$ZAI_API_KEY"
export ANTHROPIC_MODEL="$GLM_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$GLM_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$GLM_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-5.3"
case "$GLM_MODEL" in *'[1m]'*) export CLAUDE_CODE_AUTO_COMPACT_WINDOW="1000000" ;; *) export CLAUDE_CODE_AUTO_COMPACT_WINDOW="180000" ;; esac
export API_TIMEOUT_MS="3000000"
unset ANTHROPIC_API_KEY   # ensure z.ai auth-token is used, not a stray Anthropic key / OAuth

if [ "${1:-}" = "--smoke" ]; then
  echo "GLM-lead startup probe: model=$GLM_MODEL, trimmed config ($CLAUDE_CONFIG_DIR), bounded 150s..."
  start=$(date +%s)
  out="$(timeout 150 claude --dangerously-skip-permissions -p 'Reply with exactly: GLM_LEAD_OK' 2>&1)"; rc=$?
  dur=$(( $(date +%s) - start ))
  echo "--- output (${dur}s, rc=$rc) ---"; printf '%s\n' "$out" | tail -5
  if [ $rc -eq 124 ]; then
    echo "RESULT: HANG (exit 124) — full-harness GLM lead does NOT start cleanly; the glm.sh caveat applies. Needs a lean-but-MCP-trimmed lead config, not a drop-in."
  elif printf '%s' "$out" | grep -q 'GLM_LEAD_OK'; then
    echo "RESULT: OK — full-harness GLM lead starts and responds. Drop-in viable."
  else
    echo "RESULT: started (rc=$rc) but no clean marker — inspect output above."
  fi
  exit $rc
fi

exec claude --dangerously-skip-permissions "$@"
