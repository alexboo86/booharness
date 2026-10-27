#!/usr/bin/env bash
# High-recall memory lookup: retrieve candidates from BOTH hybrid (vector) AND FTS (keyword),
# then rerank the UNION with a multilingual cross-encoder → top-K. Union matters: some notes embed
# poorly (vector misses them) but match by keyword (FTS finds them), and vice-versa; the reranker
# can only surface what was retrieved, so feed it both pools. The union/dedup happens in rerank.py.
# Usage: recall.sh "<query>" [K]
set -u
q="${1:?usage: recall.sh <query> [K]}"; K="${2:-5}"; N="${RECALL_N:-30}"
HERE="$(cd "$(dirname "$0")" && pwd)"
th="$(mktemp)"; tf="$(mktemp)"; trap 'rm -f "$th" "$tf"' EXIT
uvx --python 3.12 basic-memory tool search-notes "$q" --hybrid --project terminal --page-size "$N" 2>/dev/null > "$th"
uvx --python 3.12 basic-memory tool search-notes "$q"           --project terminal --page-size "$N" 2>/dev/null > "$tf"
uvx --python 3.12 --with fastembed python "$HERE/rerank.py" "$q" "$K" "$th" "$tf"
