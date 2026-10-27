#!/usr/bin/env bash
set -u
HOOK="$HOME/.claude/hooks/selfimprove-nudge.sh"
export CLAUDE_STATE_DIR="$(mktemp -d)"; trap 'rm -rf "$CLAUDE_STATE_DIR"' EXIT
fail=0; sid="test-sess-1"; emit_count=0
post(){ printf '{"session_id":"%s","tool_name":"Bash","hook_event_name":"PostToolUse"}' "$sid" | N=30 STOP_MIN=12 bash "$HOOK"; }
stop(){ printf '{"session_id":"%s","hook_event_name":"Stop"}' "$sid" | N=30 STOP_MIN=12 bash "$HOOK"; }
# 30 PostToolUse -> exactly one emit (on the 30th)
for i in $(seq 1 30); do out=$(post); grep -q 'additionalContext' <<<"$out" && emit_count=$((emit_count+1)); done
[ "$emit_count" -eq 1 ] || { echo "FAIL: PostToolUse emitted $emit_count in 30 (want 1)"; fail=1; }
# Stop immediately after a nudge (delta 0) -> NO fire (gated)
grep -q 'additionalContext' <<<"$(stop)" && { echo "FAIL: Stop fired with no new work"; fail=1; }
# 12 more tool-uses (no PostToolUse fire: 31..42 hit no multiple of 30), then Stop -> fire (delta>=STOP_MIN)
for i in $(seq 1 12); do post >/dev/null; done
grep -q 'additionalContext' <<<"$(stop)" || { echo "FAIL: Stop did not fire after STOP_MIN work"; fail=1; }
[ $fail -eq 0 ] && echo "PASS" || exit 1
