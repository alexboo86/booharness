#!/usr/bin/env bash
# glm-ask.sh — direct z.ai HTTP ping helper. **CONSULTS ARE FORBIDDEN HERE.**
#
# OPERATOR POLICY (2026-07-18): all substantive GLM work — consult, review,
# digest, write — goes through the LOCAL CLI worker:
#     bash .claude/scripts/glm.sh -p "<brief>"
# Reason: the raw HTTP path creates no session, no transcript and no tool
# telemetry, so GLM work was invisible to the fleet monitor (agtop overlay).
# The local CLI gives sessions, tool counters (rtk/cg/mem) and quota
# attribution for free.
#
# The ONLY sanctioned use of this script is an explicit 1-token infrastructure
# health ping:
#   GLM_ASK_PING=1 bash .claude/scripts/glm-ask.sh --max-tokens 8 -p ping
# Anything else exits with rc=4 and points to glm.sh.
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$repo" ] || repo="$(cd "$here/../.." && pwd)"

# ── resolve the z.ai key from the SAME gitignored secret glm.sh uses ──
keyfile="${ZAI_GLM_ENV_FILE:-$repo/.secrets/zai-glm.env}"
[ -f "$keyfile" ] && . "$keyfile"
: "${ZAI_API_KEY:?ZAI_API_KEY missing — put it in .secrets/zai-glm.env or set ZAI_GLM_ENV_FILE}"

command -v jq   >/dev/null || { echo "glm-ask: jq required"   >&2; exit 3; }
command -v curl >/dev/null || { echo "glm-ask: curl required" >&2; exit 3; }

# ── args ──
prompt=""
system=""
model="${GLM_MODEL:-glm-5.3}"
max_tokens="${GLM_MAX_TOKENS:-8192}"
timeout_s="${GLM_HTTP_TIMEOUT:-300}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p|--prompt)     prompt="$2"; shift 2 ;;
    -m|--model)      model="$2"; shift 2 ;;
    --system)        system="$2"; shift 2 ;;
    --max-tokens)    max_tokens="$2"; shift 2 ;;
    --timeout)       timeout_s="$2"; shift 2 ;;
    -h|--help)       grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               prompt="${prompt:+$prompt }$1"; shift ;;
  esac
done
# No -p → read the prompt from stdin (so `cat brief | glm-ask.sh` works).
if [ -z "$prompt" ] && [ ! -t 0 ]; then prompt="$(cat)"; fi
[ -n "$prompt" ] || { echo "glm-ask: empty prompt (use -p or pipe stdin)" >&2; exit 2; }

# ── OPERATOR POLICY (2026-07-18): consults via raw HTTP are FORBIDDEN ────────
# Direct API calls bypass the local CLI entirely — no session, no transcript,
# no tool telemetry — so GLM work was invisible to the fleet monitor (agtop).
# ALL substantive GLM work (consult / review / digest / write) must go through
# the local CLI worker:
#     bash .claude/scripts/glm.sh -p "<brief>"
# The ONLY sanctioned use of this script is the infrastructure health ping
# set GLM_ASK_PING=1 and keep --max-tokens ≤ 16.
if [ "${GLM_ASK_PING:-0}" != "1" ]; then
  {
    echo "glm-ask: BLOCKED — HTTP consults are forbidden (invisible to the fleet monitor)."
    echo "glm-ask: use the local CLI instead:  bash .claude/scripts/glm.sh -p \"...\""
    echo "glm-ask: health pings only:         GLM_ASK_PING=1 glm-ask.sh --max-tokens 8 -p ping"
  } >&2
  exit 4
fi
if [ "$max_tokens" -gt 16 ]; then
  echo "glm-ask: ping mode caps --max-tokens at 16 (got $max_tokens) — real work goes через glm.sh" >&2
  exit 4
fi

# z.ai's Anthropic-compat endpoint does not understand the claude-CLI-only
# `glm-5.3[1m]` context tag — strip any [..] suffix for the raw API model id.
api_model="${model%%\[*}"
base_url="${ZAI_BASE_URL:-https://api.z.ai/api/anthropic}"

# ── consult log for the agtop monitor ─────────────────────────────────────
# HTTP consults have no CLI session/transcript, so without this record they
# are invisible to the fleet HUD ("GLM работает, а сессии нет", 2026-07-18).
# NDJSON pairs: {ev:start,...} then {ev:end, ok, input, output}. The monitor
# shows an unclosed fresh start as a running consult, a closed pair as done.
consult_log="${GLM_CONSULT_LOG:-$HOME/.glm-worker-config/consults.jsonl}"
consult_id="ask-$(date +%s)-$$"
# Health pings are infrastructure noise — keep them out of the monitor.
log_consult_start() {
  [ "${GLM_ASK_PING:-0}" = "1" ] && return 0
  _log_consult_start_impl
}
_log_consult_start_impl() {
  mkdir -p "$(dirname "$consult_log")" 2>/dev/null || true
  jq -cn --arg id "$consult_id" --argjson ts "$(($(date +%s) * 1000))" \
    --arg model "$api_model" --arg cwd "$PWD" --arg ph "${prompt:0:140}" \
    '{ev:"start", id:$id, ts:$ts, model:$model, cwd:$cwd, prompt_head:$ph}' \
    >>"$consult_log" 2>/dev/null || true
}
log_consult_end() { # $1 = ok|fail, $2 = input tokens, $3 = output tokens
  [ "${GLM_ASK_PING:-0}" = "1" ] && return 0
  jq -cn --arg id "$consult_id" --argjson ts "$(($(date +%s) * 1000))" \
    --arg ok "$1" --argjson inp "${2:-0}" --argjson out "${3:-0}" \
    '{ev:"end", id:$id, ts:$ts, ok:($ok=="ok"), input:$inp, output:$out}' \
    >>"$consult_log" 2>/dev/null || true
}
log_consult_start

# Build the request body with jq so arbitrary prompt/diff text can't break JSON.
body="$(jq -n \
  --arg m "$api_model" \
  --argjson mt "$max_tokens" \
  --arg p "$prompt" \
  --arg s "$system" \
  '{model:$m, max_tokens:$mt, messages:[{role:"user", content:$p}]}
   + (if $s == "" then {} else {system:$s} end)')"

# ── call with the same transient-5xx backoff glm.sh uses (z.ai overloads) ──
resp="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/glm-ask.$$")"
trap 'rm -f "$resp" 2>/dev/null || true' EXIT
max_attempts="${GLM_MAX_RETRIES:-5}"
attempt=0
while :; do
  attempt=$((attempt + 1))
  code="$(curl -sS -m "$timeout_s" -o "$resp" -w '%{http_code}' \
    "$base_url/v1/messages" \
    -H "Authorization: Bearer $ZAI_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "$body" 2>>"$resp" || echo 000)"
  # Retry only transient overload (5xx / z.ai code 1305 / overloaded_error).
  if [ "$attempt" -lt "$max_attempts" ] && { \
       case "$code" in 5??|000|429) true ;; *) false ;; esac; } ; then
    backoff=$(( 3 * (1 << (attempt - 1)) )); [ "$backoff" -gt 60 ] && backoff=60
    echo "  (glm-ask: HTTP $code — retry $attempt/$((max_attempts - 1)) in ${backoff}s)" >&2
    sleep "$backoff"; continue
  fi
  break
done

if [ "$code" != "200" ]; then
  log_consult_end fail 0 0
  echo "glm-ask: z.ai HTTP $code" >&2
  jq -r '.error.message // .error // empty' "$resp" 2>/dev/null >&2 || head -c 400 "$resp" >&2
  exit 1
fi

# Concatenate all text blocks. Fail loudly if the shape is unexpected (never
# emit a silent empty "answer" — that would read as a passed review).
text="$(jq -r '[.content[]? | select(.type=="text") | .text] | join("\n")' "$resp" 2>/dev/null)"
if [ -z "$text" ]; then
  log_consult_end fail 0 0
  echo "glm-ask: no text in response" >&2
  head -c 400 "$resp" >&2
  exit 1
fi
log_consult_end ok \
  "$(jq -r '.usage.input_tokens // 0' "$resp" 2>/dev/null || echo 0)" \
  "$(jq -r '.usage.output_tokens // 0' "$resp" 2>/dev/null || echo 0)"
printf '%s\n' "$text"
