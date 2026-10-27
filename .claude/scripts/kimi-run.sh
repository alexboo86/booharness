#!/usr/bin/env bash
# kimi-run.sh — run `kimi -p` and RETURN PROMPTLY once the answer is written.
#
# WHY: `kimi -p "<prompt>"` writes its full answer to stdout but then the process
# HANGS (holds the tty / does not exit). A caller that waits for the process to
# finish (e.g. TaskOutput block:true, or a foreground `kimi -p ... > f`) blocks for
# the full timeout even though the verdict was ready minutes ago (operator pain,
# 2026-07-01). Kimi terminates its answer with a reliable sentinel line:
#     To resume this session: kimi -r session_<id>
# So: background kimi, poll the output file for that sentinel, then stop — the data
# is already captured. Best-effort kill the orphan (idle, harmless if it survives).
#
# Usage:  bash .claude/scripts/kimi-run.sh "<prompt>" <outfile> [--write --dir <wt>]
#         read (default): consult/review — no autonomous edits.
#         --write --dir <wt>: WRITE/code mode — `kimi -p <brief>` run INSIDE the worktree
#         <wt>. `-p` (one-shot non-interactive) ALREADY auto-executes tool calls incl. the
#         Write/Edit tools, so Kimi edits code autonomously with NO extra flag. Do NOT add
#         `-y`/--yolo — the CLI rejects it ("Cannot combine --prompt with --yolo", verified
#         2026-07-17 smoke). Write mode differs from read ONLY by cwd + a longer poll ceiling.
set -u
KIMI_MODEL="${KIMI_MODEL:-}"
if [ "${TEAM_PROFILE_LOCKED:-0}" = 1 ]; then
  [ "$KIMI_MODEL" = "kimi-code/k3" ] || { echo "kimi-run.sh: locked profile requires kimi-code/k3" >&2; exit 2; }
fi
prompt="${1:?usage: kimi-run.sh <prompt> <outfile> [--write --dir <wt>]}"
out="${2:?usage: kimi-run.sh <prompt> <outfile> [--write --dir <wt>]}"
shift 2
mode="read"; dir="."
while [ "$#" -gt 0 ]; do
  case "$1" in
    --write) mode="write"; shift ;;
    --dir) dir="${2:-.}"; shift 2 ;;
    *) shift ;;
  esac
done
sentinel="To resume this session"
if [ "$mode" = "write" ]; then
  max_polls="${KIMI_MAX_POLLS:-360}"   # 360 × 5s = ~30min — autonomous coding is slow
else
  max_polls="${KIMI_MAX_POLLS:-160}"   # 160 × 5s = ~13min ceiling
fi
if [ -n "$KIMI_MODEL" ]; then
  set -- --model "$KIMI_MODEL" -p "$prompt"
else
  set -- -p "$prompt"                   # `-p` already auto-runs tools; NO -y (CLI rejects the combo)
fi
: > "$out"
( cd "$dir" && kimi "$@" > "$out" 2>&1 ) &
pid=$!
done_ok=0
for _ in $(seq 1 "$max_polls"); do
  if grep -q "$sentinel" "$out" 2>/dev/null; then done_ok=1; break; fi
  kill -0 "$pid" 2>/dev/null || { done_ok=1; break; }   # exited on its own
  sleep 5
done
sleep 1   # let the final flush land
# Best-effort kill the (likely hung) process tree; orphan is idle/harmless if it survives.
kill "$pid" 2>/dev/null || true
if command -v taskkill >/dev/null 2>&1; then taskkill //F //T //PID "$pid" >/dev/null 2>&1 || true; fi
[ "$done_ok" = 1 ] || echo "[kimi-run] WARN: sentinel not seen within ${max_polls} polls — output may be partial" >> "$out"
exit 0
