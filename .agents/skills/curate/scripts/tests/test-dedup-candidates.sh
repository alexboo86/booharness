#!/usr/bin/env bash
set -u; D="$(dirname "$0")/../dedup-candidates.sh"; d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
mk(){ printf -- '---\nname: %s\ndescription: d\nmetadata:\n  type: feedback\n  tags: [%s]\n  date: 2026-06-22\n  source: x\n  confidence: low\n---\n' "$1" "$2" > "$d/$1.md"; }
mk handoff_block_geometry_a smc-blocks; mk handoff_block_geometry_b smc-blocks; mk unrelated funding
out=$(bash "$D" "$d")
grep -q 'handoff_block_geometry_a' <<<"$out" && grep -q 'handoff_block_geometry_b' <<<"$out" && echo PASS || { echo "FAIL"; echo "$out"; exit 1; }
