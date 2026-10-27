#!/usr/bin/env bash
set -u
A="${A:-$PWD/CLAUDE.md}"; B="${B:-$PWD/AGENTS.md}"
cmp -s "$A" "$B" && exit 0
echo "MIRROR DESYNC: $A != $B" >&2; exit 1
