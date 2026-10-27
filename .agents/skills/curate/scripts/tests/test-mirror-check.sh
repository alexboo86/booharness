#!/usr/bin/env bash
set -u; M="$(dirname "$0")/../mirror-check.sh"; d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
printf 'same\n' > "$d/CLAUDE.md"; printf 'same\n' > "$d/AGENTS.md"
A="$d/CLAUDE.md" B="$d/AGENTS.md" bash "$M"; x=$?
printf 'diff\n' > "$d/AGENTS.md"
A="$d/CLAUDE.md" B="$d/AGENTS.md" bash "$M"; y=$?
{ [ $x -eq 0 ] && [ $y -eq 1 ]; } && echo PASS || { echo FAIL; exit 1; }
