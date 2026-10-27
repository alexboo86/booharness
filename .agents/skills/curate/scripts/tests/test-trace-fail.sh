#!/usr/bin/env bash
set -u
HOOK="$HOME/.claude/hooks/selfimprove-trace.sh"
export TRACES_DIR="$(mktemp -d)"; trap 'rm -rf "$TRACES_DIR"' EXIT
fail=0
# 1) a real PostToolUseFailure -> rich JSONL line
printf '{"session_id":"s1","hook_event_name":"PostToolUseFailure","tool_name":"Bash","tool_input":{"command":"exit 7","description":"d"},"error":"Exit code 7","is_interrupt":false,"duration_ms":188}' | bash "$HOOK" >/dev/null
line=$(cat "$TRACES_DIR"/*.jsonl 2>/dev/null | tail -1)
for k in ts session tool error; do jq -e ".$k" <<<"$line" >/dev/null 2>&1 || { echo "FAIL: missing $k"; fail=1; }; done
[ "$(jq -r '.tool' <<<"$line")" = "Bash" ] || { echo "FAIL: wrong tool"; fail=1; }
[ "$(jq -r '.error' <<<"$line")" = "Exit code 7" ] || { echo "FAIL: wrong error"; fail=1; }
# 2) user interrupt -> NOT logged (not a real failure)
before=$(cat "$TRACES_DIR"/*.jsonl 2>/dev/null | wc -l)
printf '{"session_id":"s1","hook_event_name":"PostToolUseFailure","tool_name":"Bash","tool_input":{"command":"x"},"error":"interrupted","is_interrupt":true,"duration_ms":1}' | bash "$HOOK" >/dev/null
after=$(cat "$TRACES_DIR"/*.jsonl 2>/dev/null | wc -l)
[ "$after" -eq "$before" ] || { echo "FAIL: interrupt was logged (should skip)"; fail=1; }
[ $fail -eq 0 ] && echo "PASS" || exit 1
