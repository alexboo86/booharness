#!/usr/bin/env bash
# Admission step 1: given an _inbox/ note, hybrid-search existing memory for similar notes so the
# /admit judge can decide new/merge/supersede/contradict/reject (update-in-place, not duplicate).
# Emits "score<TAB>file_path" lines (top-K), highest first. Search is injectable for tests via
# BM_SEARCH_CMD (a command taking the query, emitting basic-memory JSON).
set -u
f="${1:?usage: admit-candidates.sh <inbox-note.md>}"; K="${K:-6}"
# query = description (best one-liner) + name tokens
desc="$(awk -F'description: ' '/^description:/{print $2; exit}' "$f" | tr -d '"')"
name="$(awk -F': ' '/^name:/{print $2; exit}' "$f" | tr -d '"' | tr '-' ' ')"
query="$(printf '%s %s' "$desc" "$name" | cut -c1-300)"
[ -n "${query// }" ] || { echo "no query (empty description+name)" >&2; exit 2; }
search(){ if [ -n "${BM_SEARCH_CMD:-}" ]; then "$BM_SEARCH_CMD" "$1"; else
  uvx --python 3.12 basic-memory tool search-notes "$1" --hybrid --project terminal 2>/dev/null; fi; }
self="$(basename "$f")"
search "$query" | jq -r --arg self "$self" \
  '.results[] | select((.file_path|endswith($self))|not) | "\(.score)\t\(.file_path)"' 2>/dev/null \
  | head -n "$K"
