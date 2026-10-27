#!/usr/bin/env bash
# Single-writer lock for the shared memory store. mkdir is atomic across processes.
set -u; dir="${1:?dir}"; lock="$dir/.curate.lock"
if mkdir "$lock" 2>/dev/null; then echo "$$" > "$lock/pid"; exit 0; fi
echo "LOCKED by pid $(cat "$lock/pid" 2>/dev/null)" >&2; exit 3
