#!/usr/bin/env bash
# Retrieval eval: for each golden (query -> expected-note), check the expected note appears in the
# top-K semantic results. Reports recall@k overall + per-language + the misses.
# Search is injectable for tests: set BM_SEARCH_CMD to a command taking the query and emitting the
# basic-memory JSON ({results:[{file_path,...}]}). Default = live basic-memory CLI.
set -u
K="${K:-5}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GOLD="${GOLDENS:-$HERE/eval/goldens.tsv}"
search(){ # $1=query -> JSON on stdout
  if [ -n "${BM_SEARCH_CMD:-}" ]; then "$BM_SEARCH_CMD" "$1"; else
    uvx --python 3.12 basic-memory tool search-notes "$1" --hybrid --project terminal 2>/dev/null; fi
}
[ -f "$GOLD" ] || { echo "no goldens at $GOLD" >&2; exit 2; }
# bash 3.2 safe: no associative arrays (macOS /bin/bash is 3.2). Per-lang tallies
# are logged to a temp file (lang<TAB>hitflag) and aggregated with awk at the end.
total=0; hit=0; misses=""
langtmp="$(mktemp)"; trap 'rm -f "$langtmp"' EXIT
while IFS=$'\t' read -r q expected lang; do
  [ -z "${q:-}" ] && continue; case "$q" in \#*) continue;; esac
  lang="${lang:-mix}"; total=$((total+1))
  if [ "${RERANK:-0}" = "1" ]; then
    top="$(bash "$HERE/recall.sh" "$q" "$K" 2>/dev/null | cut -f2 | head -n "$K")"
  else
    json="$(search "$q")"
    top="$(printf '%s' "$json" | jq -r '.results[].file_path' 2>/dev/null | head -n "$K")"
  fi
  if grep -q "$expected" <<<"$top"; then hit=$((hit+1)); h=1;
  else h=0; misses="$misses\n  MISS [$lang] '$q' -> expected '$expected'"; fi
  printf '%s\t%d\n' "$lang" "$h" >> "$langtmp"
done < "$GOLD"
[ "$total" -eq 0 ] && { echo "no goldens parsed" >&2; exit 2; }
pct=$(( hit * 100 / total ))
echo "recall@$K: $hit/$total (${pct}%)"
awk -F'\t' '{t[$1]++; h[$1]+=$2} END{for(l in t) print "  "l": "h[l]"/"t[l]}' "$langtmp" | LC_ALL=C sort
[ -n "$misses" ] && printf '%b\n' "$misses"
# exit non-zero if recall below floor (default 70%) so it can gate CI/curation
floor="${RECALL_FLOOR:-70}"; [ "$pct" -ge "$floor" ]
