#!/usr/bin/env bash
set -u; L="$(dirname "$0")/../memory-lock.sh"; d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
bash "$L" "$d"; a=$?
[ -d "$d/.curate.lock" ] || { echo FAIL; exit 1; }
bash "$L" "$d"; b=$?
{ [ $a -eq 0 ] && [ $b -ne 0 ]; } && echo PASS || { echo FAIL; exit 1; }
