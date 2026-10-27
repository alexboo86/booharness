#!/usr/bin/env bash
# Emit groups (>=2 files) that share a tag — curator's merge candidates. Deterministic.
# bash 3.2 safe: no associative arrays (macOS /bin/bash is 3.2). Group via sort+awk.
set -u; dir="${1:?dir}"
{
  for f in "$dir"/*.md; do
    [ -e "$f" ] || continue
    base="$(basename "$f" .md)"
    awk -v b="$base" '/^  tags:/{gsub(/[][,]/," ");for(i=2;i<=NF;i++)print $i"\t"b}' "$f"
  done
} | LC_ALL=C sort | awk -F'\t' '
  function flush(){ if(cnt>=2){ print "## tag:" tag; for(i=1;i<=cnt;i++) print members[i]; } }
  NR==1 { tag=$1 }
  $1!=tag { flush(); tag=$1; cnt=0 }
  { members[++cnt]=$2 }
  END { flush() }
'
