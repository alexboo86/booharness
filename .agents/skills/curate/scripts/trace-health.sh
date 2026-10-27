#!/usr/bin/env bash
# Self-serve check: are failure-traces accruing REAL content (not hollow)?
# Usage:  bash trace-health.sh           # report
#         bash trace-health.sh --probe   # also emit one synthetic line to prove the pipe end-to-end
set -u
T="${TRACES_DIR:-$HOME/.claude/projects/$(pwd | sed 's/[^A-Za-z0-9]/-/g')/traces}"
S="$HOME/.claude/settings.json"
HOOK="$HOME/.claude/hooks/selfimprove-trace.sh"

if [ "${1:-}" = "--probe" ]; then
  printf '{"session_id":"probe","hook_event_name":"PostToolUseFailure","tool_name":"Bash","tool_input":{"command":"probe-check"},"error":"Exit code 1 (probe)","is_interrupt":false,"duration_ms":5}' | bash "$HOOK"
  echo "[probe] emitted one synthetic failure line"
fi

echo "== trace health =="
# 1) wiring
reg=$(jq -r '[.hooks.PostToolUseFailure[]?.hooks[]?.command] | map(select(test("selfimprove-trace")))|length' "$S" 2>/dev/null)
[ "${reg:-0}" -ge 1 ] && echo "hook registered on PostToolUseFailure: YES" || echo "hook registered: NO  <-- PIPE OFF"

# 2) content  (one JSON object per line; -c keeps it that way)
blob="$(cat "$T"/*.jsonl 2>/dev/null)"
total=$(printf '%s' "$blob" | grep -c '^{' ; true)
rich=$(printf '%s' "$blob" | jq -c 'select((.error // "")!="" and (.tool // "")!="")' 2>/dev/null | grep -c '^{' ; true)
hollow=$(printf '%s' "$blob" | jq -c 'select((.error // "")=="" or (.outcome=="unknown"))' 2>/dev/null | grep -c '^{' ; true)
echo "lines total: $total | rich (tool+error): $rich | hollow: $hollow"

# 3) verdict
if [ "$total" -eq 0 ]; then
  echo "VERDICT: empty — no tool has failed yet (healthy if work is going smoothly). Run with --probe to prove the pipe."
elif [ "$hollow" -gt 0 ]; then
  echo "VERDICT: !! HOLLOW lines present — regression, investigate."
else
  echo "VERDICT: OK — every line is real failure signal (GEPA substrate is good)."
fi

# 4) recency + sample
echo "-- last 3 (ts / tool / error head) --"
printf '%s' "$blob" | tail -3 | jq -r '"\(.ts)  \(.tool)  \((.error // "")[0:60])"' 2>/dev/null
echo "-- tools that failed (counts) --"
printf '%s' "$blob" | jq -r '.tool // empty' 2>/dev/null | sort | uniq -c | sort -rn | head
