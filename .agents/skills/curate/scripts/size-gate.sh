#!/usr/bin/env bash
set -u; f="${1:?file}"; max="${2:?maxbytes}"
n=$(wc -c < "$f"); [ "$n" -le "$max" ] && exit 0
echo "OVER: $f is $n bytes > $max" >&2; exit 1
