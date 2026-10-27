#!/bin/bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

shim_dir="$tmp/rtk-shims"
win_bin="$tmp/windows-bin"
mkdir -p "$shim_dir" "$win_bin"
ln -s "$here/_rtk_shim" "$shim_dir/git"

cat > "$win_bin/rtk.exe" <<'SH'
#!/bin/bash
printf '%s\n' "$*" > "$RTK_TEST_LOG"
SH
chmod +x "$win_bin/rtk.exe"

log="$tmp/rtk.log"
PATH="$shim_dir:$win_bin:/usr/bin:/bin" \
  RTK_BIN= \
  RTK_FALLBACK_DIRS= \
  RTK_TEST_LOG="$log" \
  HOME="$tmp/home" \
  "$shim_dir/git" status

test "$(cat "$log")" = "git status"

telemetry_dir="$tmp/telemetry"
mkdir -p "$telemetry_dir"
telemetry_file="$telemetry_dir/rtk-telemetry.jsonl"
/bin/dd if=/dev/zero of="$telemetry_file" bs=1048576 count=3 2>/dev/null
size_before="$(/usr/bin/wc -c < "$telemetry_file")"
PATH="$shim_dir:$win_bin:/usr/bin:/bin" \
  RTK_BIN= \
  RTK_FALLBACK_DIRS= \
  RTK_TEST_LOG="$log" \
  RTK_RUN_DIR="$telemetry_dir" \
  HOME="$tmp/home" \
  "$shim_dir/git" status
test "$(/usr/bin/wc -c < "$telemetry_file")" = "$size_before"

raw_marker="$tmp/raw-ran"
cat > "$win_bin/git" <<'SH'
#!/bin/bash
touch "$RTK_RAW_MARKER"
SH
chmod +x "$win_bin/git"
rm -f "$win_bin/rtk.exe"

set +e
PATH="$shim_dir:$win_bin:/usr/bin:/bin" \
  RTK_BIN= \
  RTK_FALLBACK_DIRS= \
  RTK_RAW_MARKER="$raw_marker" \
  HOME="$tmp/home" \
  "$shim_dir/git" status >"$tmp/missing.out" 2>"$tmp/missing.err"
rc=$?
set -e

test "$rc" -eq 127
test ! -e "$raw_marker"
grep -q "rtk binary not found" "$tmp/missing.err"

echo "rtk-shim.test: PASS"
