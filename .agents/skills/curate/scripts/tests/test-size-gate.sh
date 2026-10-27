#!/usr/bin/env bash
set -u; G="$(dirname "$0")/../size-gate.sh"; tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
head -c 100 /dev/zero > "$tmp"
bash "$G" "$tmp" 200; a=$?
bash "$G" "$tmp" 50;  b=$?
{ [ $a -eq 0 ] && [ $b -eq 1 ]; } && echo PASS || { echo FAIL; exit 1; }
