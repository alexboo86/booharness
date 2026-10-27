#!/usr/bin/env bash
set -u
MEM="${MEM_DIR:-$HOME/.claude/projects/$(pwd | sed 's/[^A-Za-z0-9]/-/g')/memory}"
fail=0
[ -f "$MEM/USER.md" ] || { echo "FAIL: USER.md missing"; fail=1; }
[ -f "$MEM/LESSONS.md" ] || { echo "FAIL: LESSONS.md missing"; fail=1; }
grep -q '_archive/feedback/' "$MEM/LESSONS.md" 2>/dev/null || { echo "FAIL: LESSONS.md has no source anchors"; fail=1; }
n=$(wc -l < "$MEM/USER.md" 2>/dev/null || echo 9999)
[ "$n" -le 150 ] || { echo "FAIL: USER.md $n lines > 150"; fail=1; }
arch=$(ls "$MEM/_archive/feedback/"feedback_*.md 2>/dev/null | wc -l)
[ "$arch" -ge 1 ] || { echo "FAIL: no archived feedback originals"; fail=1; }
[ $fail -eq 0 ] && echo "PASS" || exit 1
