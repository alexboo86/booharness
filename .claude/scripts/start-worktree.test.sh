#!/usr/bin/env bash
# start-worktree.test.sh — T1.4(a): shared build-dep symlink helper.
# Hermetic: sources start-worktree.sh in library mode (STARTWT_LIB=1) so link_shared_deps
# is testable WITHOUT running the real worktree provisioning. Run:
#   bash .claude/scripts/start-worktree.test.sh
set -uo pipefail

scripts="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWT="$scripts/start-worktree.sh"
pass=0; fail=0
ok()  { pass=$(( pass + 1 )); echo "  ok  - $1"; }
bad() { fail=$(( fail + 1 )); echo "  FAIL- $1"; }
check(){ if [ "$1" = 0 ]; then ok "$2"; else bad "$2"; fi; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Source in library mode: helper functions exposed, main provisioning body NOT run.
# shellcheck disable=SC1090
( STARTWT_LIB=1 source "$SWT" && type link_shared_deps >/dev/null 2>&1 )
check $? "library mode (STARTWT_LIB=1) exposes link_shared_deps without provisioning"

# ---------------------------------------------------------------------------
# Fixture source repo: node_modules present, build/target ABSENT (no build yet).
sroot="$tmp/src"; mkdir -p "$sroot/node_modules" "$sroot/build" "$sroot/ops/bootstrap"
printf '%s\n' '{"memory":{"embed":{"model":"example"}},"names":{"prefix":"example"},"project":{"sharedBuildDirs":["node_modules","build/target"]}}' > "$sroot/ops/bootstrap/harness.config.json"
echo marker > "$sroot/node_modules/.mk"

# TEST A1 — present dep is symlinked into a fresh worktree; absent dep is skipped.
(
  set -e
  STARTWT_LIB=1 source "$SWT"
  link_shared_deps "$sroot" "$tmp/wt1"
) >/dev/null 2>&1
[ -L "$tmp/wt1/node_modules" ]; check $? "node_modules linked into fresh worktree (symlink)"
[ "$(cat "$tmp/wt1/node_modules/.mk" 2>/dev/null)" = marker ]; check $? "linked node_modules resolves to source contents"
[ ! -e "$tmp/wt1/build/target" ]; check $? "absent build/target skipped (no dangling link)"

# TEST A2 — idempotent: a second call over the same worktree is a no-op, exits clean.
(
  set -e
  STARTWT_LIB=1 source "$SWT"
  link_shared_deps "$sroot" "$tmp/wt1"
) >/dev/null 2>&1
check $? "second link_shared_deps call idempotent (exit 0, no error)"
[ -L "$tmp/wt1/node_modules" ]; check $? "node_modules still a symlink after idempotent re-run"

# TEST A3 — never clobbers a real dep the worktree already owns.
mkdir -p "$tmp/wt2/node_modules"; echo own > "$tmp/wt2/node_modules/.own"
(
  set -e
  STARTWT_LIB=1 source "$SWT"
  link_shared_deps "$sroot" "$tmp/wt2"
) >/dev/null 2>&1
{ [ ! -L "$tmp/wt2/node_modules" ] && [ -f "$tmp/wt2/node_modules/.own" ]; }
check $? "existing real node_modules dir left untouched (not replaced by symlink)"

# TEST A4 — build/target IS linked once the build dir exists.
mkdir -p "$sroot/build/target"; echo t > "$sroot/build/target/.t"
(
  set -e
  STARTWT_LIB=1 source "$SWT"
  link_shared_deps "$sroot" "$tmp/wt3"
) >/dev/null 2>&1
[ -L "$tmp/wt3/build/target" ]; check $? "build/target linked when present in source"

# An unrelated repository with no configured sharing must not acquire links.
mkdir -p "$tmp/neutral/node_modules"
(
  set -e
  STARTWT_LIB=1 source "$SWT"
  link_shared_deps "$tmp/neutral" "$tmp/wt-neutral"
) >/dev/null 2>&1
check $? "unconfigured repository is accepted"
[ ! -e "$tmp/wt-neutral/node_modules" ]; check $? "no sharing is inferred from directory names"

echo ""
echo "start-worktree tests: $pass passed, $fail failed"
[ "$fail" = 0 ]
