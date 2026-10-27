#!/usr/bin/env bash
# glm.sh — GLM-5.3 worker via Z.ai's Anthropic-compatible endpoint, run as an
# independent Claude Code CLI worker (same pattern as `kimi -p` / `codex exec`).
# The calling top-level lead session is untouched — env is scoped to this subprocess only.
# Full repo access, no sandbox, no timeout (operator directive). Key from gitignored
# .secrets/zai-glm.env. Team-verified wiring (Codex+Kimi, 2026-06-24).
#
# Usage:  bash .claude/scripts/glm.sh -p "one-line task; return a digest"
#         bash .claude/scripts/glm.sh -p "implement X in file Y per this contract ..."
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$repo" ] || repo="$(cd "$here/../.." && pwd)"
keyfile="${ZAI_GLM_ENV_FILE:-$repo/.secrets/zai-glm.env}"
if [ -f "$keyfile" ]; then . "$keyfile"; fi
: "${ZAI_API_KEY:?ZAI_API_KEY missing — put it in .secrets/zai-glm.env or set ZAI_GLM_ENV_FILE}"

# LEAN worker config dir (NO MCP servers / heavy harness) — a full nested claude
# that loads our ~20 MCP servers + skills HANGS on startup (verified: exit 124).
# A minimal CLAUDE_CONFIG_DIR starts fast; the worker still has Read/Edit/Bash =
# full code access. (Trade-off: no code-search server for the worker → it greps.)
export CLAUDE_CONFIG_DIR="${GLM_CONFIG_DIR:-$HOME/.glm-worker-config}"
mkdir -p "$CLAUDE_CONFIG_DIR" 2>/dev/null

# macOS KEYCHAIN BYPASS (verified 2026-07-06). On a machine logged into Claude Max, claude reads
# the subscription oauth from $HOME/Library/Keychains and forces oauth-mode (?beta=true +
# `anthropic-beta: ...oauth-2025-04-20...`), which z.ai REJECTS with 401 — no env/apiKeyHelper/
# settings.json override helps (diagnosed via ANTHROPIC_LOG=debug). Fix: run claude under a
# DEDICATED keychain-free HOME so it can't find the oauth and falls back to the env
# ANTHROPIC_AUTH_TOKEN (api-key mode) -> z.ai accepts. Persistent dir (not mktemp) so npm/uv caches
# survive between runs. CLAUDE_CONFIG_DIR above stays the real path (absolute). The calling lead
# session (real $HOME + its keychain) is completely untouched. On Windows this was never needed
# (creds are a file, isolated by CLAUDE_CONFIG_DIR).
export GLM_HOME="${GLM_HOME:-$HOME/.glm-worker-home}"
mkdir -p "$GLM_HOME" 2>/dev/null

# USAGE ENVELOPE (measured 2026-06-24): GLM on z.ai has ~17s time-to-first-token PER TURN
# (latency compounds over tool calls). So GLM is for BOUNDED, FEW-TURN tasks: one-file
# read+digest (~45s), one-file create from a clear spec, a bounded verification — ideally
# with the needed context PASTED INLINE so it needs few Read turns. For multi-file agentic
# coding (read N files + write a big component) latency × turns blows the budget — use a
# native worker pool of the calling platform (shared harness, low latency) instead. See
# reference-glm-invocation-gotchas.
GLM_MODEL="${GLM_MODEL:-glm-5.3}"   # glm-5.3 = 200K ctx; set GLM_MODEL=glm-5.3[1m] for 1M ctx
GLM_EFFORT="${GLM_EFFORT:-max}"
if [ "${TEAM_PROFILE_LOCKED:-0}" = 1 ]; then
  [ "$GLM_MODEL" = "glm-5.3" ] || { echo "glm.sh: locked profile requires glm-5.3" >&2; exit 2; }
  [ "$GLM_EFFORT" = "max" ] || { echo "glm.sh: locked profile requires effort max" >&2; exit 2; }
fi
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
# AUTH: our .secrets ZAI_API_KEY. Diagnosed 2026-07-14: this key and zcode's
# coding-plan key are DIFFERENT 49-char keys, BUT swapping in zcode's key still
# 529'd at the same moment → the KEY is NOT the difference. zcode never SHOWS a
# 529 most likely because it retries/backoff transparently on the same
# "overloaded" response, while glm.sh is single-shot and surfaces the first one.
# Real fix (if we invest): add a 529/overload retry wrapper here. See handoff.
export ANTHROPIC_AUTH_TOKEN="$ZAI_API_KEY"
export ANTHROPIC_MODEL="$GLM_MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$GLM_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$GLM_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-5.3"
# auto-compact window must sit JUST UNDER the model's real context, else a big task
# overflows and errors instead of compacting. [1m] variant -> 1M; default glm-5.3 -> ~180K (200K ctx).
case "$GLM_MODEL" in *'[1m]'*) export CLAUDE_CODE_AUTO_COMPACT_WINDOW="1000000" ;; *) export CLAUDE_CODE_AUTO_COMPACT_WINDOW="180000" ;; esac
export API_TIMEOUT_MS="3000000"          # effectively no timeout (operator directive)
unset ANTHROPIC_API_KEY   # ensure z.ai auth-token is used, not a stray Anthropic key / OAuth

# WRITER-LOCK GUARD (edit-war root-cause fix, 2026-07-19). A live
# per-worktree .team-writer.lock means another process owns the checkout.
# Refuse a second writer, tolerate a lock owned by our ancestor, and reap only
# a stale lock whose recorded process is no longer alive.
# Opt-out: GLM_SKIP_LOCK_CHECK=1 (operator-only, for recovery when a lock is wedged).
_glm_is_ancestor() {  # _glm_is_ancestor <pid> — is <pid> in OUR parent chain? (bounded walk)
  local _target="$1" _p="$$" _guard=0
  [ -n "$_target" ] || return 1
  while [ -n "$_p" ] && [ "$_p" -gt 1 ] 2>/dev/null && [ "$_guard" -lt 40 ]; do
    [ "$_p" = "$_target" ] && return 0
    _p="$(ps -o ppid= -p "$_p" 2>/dev/null | tr -d '[:space:]')"
    _guard=$((_guard + 1))
  done
  return 1
}
if [ "${GLM_SKIP_LOCK_CHECK:-0}" != "1" ]; then
  _glm_wt="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$_glm_wt" ] && [ -d "$_glm_wt/.team-writer.lock" ]; then
    _glm_lk="$_glm_wt/.team-writer.lock"
    _glm_lkslug="$(cat "$_glm_lk/slug" 2>/dev/null || true)"
    _glm_lkpid="$(cat "$_glm_lk/pid" 2>/dev/null | tr -d '[:space:]' || true)"
    if [ -n "$_glm_lkpid" ] && [ "$_glm_lkpid" != "$$" ] \
       && ! _glm_is_ancestor "$_glm_lkpid" \
       && kill -0 "$_glm_lkpid" 2>/dev/null; then
      cat >&2 <<EOF
glm.sh: REFUSING — worktree $_glm_wt is locked by writer '${_glm_lkslug:-?}' (pid $_glm_lkpid).
Two writers on one worktree = edit-war (incident 2026-07-17). Either:
  (a) wait for pid $_glm_lkpid to finish
  (b) stop that process through the tool that launched it
  (c) if pid $_glm_lkpid is dead, remove the stale lock: rm -rf $_glm_lk
  (d) operator recovery override: GLM_SKIP_LOCK_CHECK=1 $0 "$@"
EOF
      exit 2
    fi
    if [ -z "$_glm_lkpid" ]; then
      _glm_lkage=$(( $(date +%s) - $(stat -f%m "$_glm_lk" 2>/dev/null || stat -c%Y "$_glm_lk" 2>/dev/null || echo 0) ))
      if [ "$_glm_lkage" -lt 30 ]; then
        echo "glm.sh: REFUSING — worktree $_glm_wt lock is being taken by '${_glm_lkslug:-?}' right now (age ${_glm_lkage}s) — refusing the race" >&2
        exit 2
      fi
    fi
    rm -rf "$_glm_lk" 2>/dev/null || true   # stale (dead pid / abandoned take) — reap + proceed
  fi
  unset _glm_wt _glm_lk _glm_lkslug _glm_lkpid _glm_lkage
fi

# P0.3 delegation-evidence token: stream the worker output live (tee) AND capture it so we
# can write an unlock token ONLY on a real result — exit 0 AND a structural AGENT_FLEET_REPORT_JSON
# marker in the output. The route gate (has_fresh_evidence) reads this token; the wrapper is the
# only layer that sees both the call and its output, so it is the only one that can judge "real
# work". A trivial `glm.sh -p "echo ok"` exits 0 but emits no marker -> no token -> no unlock.
cap="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/glm-out.$$")"
# CLEAN ENV (env -i) + keychain-free HOME. The calling lead process injects
# CLAUDE_CODE_OAUTH_TOKEN / CLAUDECODE / etc.; inheriting them makes the GLM harness use the
# Max oauth -> oauth-mode -> z.ai 401. So we wipe the environment and pass ONLY a curated
# whitelist (mirrors the verified-working minimal env). HOME=$GLM_HOME (no keychain) forces the
# env ANTHROPIC_AUTH_TOKEN (api-key mode). Verified 2026-07-06.
# 529 RETRY (2026-07-14): z.ai returns transient 5xx "overloaded" under load.
# Diagnosed that the operator's zcode never SHOWS a 529 because it retries
# transparently, while this worker was single-shot and surfaced the first one
# (the real "we always 529" cause — NOT the api key). Retry with exponential
# backoff (3,6,12,24,48s, cap 60) so GLM is resilient like zcode. Match ONLY
# the error signature (API Error: 5xx / overloaded_error), never prose. Tune
# with GLM_MAX_RETRIES (default 5).
glm_max_attempts="${GLM_MAX_RETRIES:-5}"
glm_attempt=0
while :; do
  glm_attempt=$((glm_attempt + 1))
  env -i \
    HOME="$GLM_HOME" \
    PATH="$PATH" \
    TERM="${TERM:-xterm-256color}" \
    LANG="${LANG:-en_US.UTF-8}" \
    CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" \
    ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" \
    ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_AUTH_TOKEN" \
    ANTHROPIC_MODEL="$ANTHROPIC_MODEL" \
    ANTHROPIC_DEFAULT_OPUS_MODEL="$ANTHROPIC_DEFAULT_OPUS_MODEL" \
    ANTHROPIC_DEFAULT_SONNET_MODEL="$ANTHROPIC_DEFAULT_SONNET_MODEL" \
    ANTHROPIC_DEFAULT_HAIKU_MODEL="$ANTHROPIC_DEFAULT_HAIKU_MODEL" \
    CLAUDE_CODE_AUTO_COMPACT_WINDOW="$CLAUDE_CODE_AUTO_COMPACT_WINDOW" \
    API_TIMEOUT_MS="$API_TIMEOUT_MS" \
    claude --dangerously-skip-permissions --effort "$GLM_EFFORT" "$@" < /dev/null 2>&1 | tee "$cap"
  rc="${PIPESTATUS[0]}"
  if [ "$glm_attempt" -lt "$glm_max_attempts" ] \
     && grep -qiE 'API Error: 5[0-9][0-9]|overloaded_error|1305|temporarily overloaded' "$cap" 2>/dev/null; then
    glm_backoff=$(( 3 * (1 << (glm_attempt - 1)) )); [ "$glm_backoff" -gt 60 ] && glm_backoff=60
    echo "  (glm: z.ai 5xx overload — retry $glm_attempt/$((glm_max_attempts - 1)) in ${glm_backoff}s)" >&2
    sleep "$glm_backoff"
    continue
  fi
  break
done
rm -f "$cap" 2>/dev/null || true
exit "$rc"
