#!/usr/bin/env bash
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; E="$HERE/../eval.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# fake search: returns a hit for queries containing "good", a miss otherwise
cat > "$tmp/fakesearch.sh" <<'EOF'
#!/usr/bin/env bash
q="$1"
if [[ "$q" == *good* ]]; then
  echo '{"results":[{"file_path":"reference_target.md"},{"file_path":"other.md"}]}'
else
  echo '{"results":[{"file_path":"unrelated_a.md"},{"file_path":"unrelated_b.md"}]}'
fi
EOF
chmod +x "$tmp/fakesearch.sh"
# goldens: 2 hits (good), 1 miss
printf 'good query one\treference_target\ten\n' >  "$tmp/g.tsv"
printf '# comment line\n'                        >> "$tmp/g.tsv"
printf 'good query two\treference_target\tru\n'  >> "$tmp/g.tsv"
printf 'bad query\treference_target\ten\n'       >> "$tmp/g.tsv"
out=$(BM_SEARCH_CMD="$tmp/fakesearch.sh" GOLDENS="$tmp/g.tsv" K=5 RECALL_FLOOR=0 bash "$E" 2>&1)
fail=0
grep -q 'recall@5: 2/3' <<<"$out" || { echo "FAIL: wrong recall line"; echo "$out"; fail=1; }
grep -q "MISS \[en\] 'bad query'" <<<"$out" || { echo "FAIL: miss not reported"; fail=1; }
# floor gating: floor 90 with 66% -> exit non-zero
BM_SEARCH_CMD="$tmp/fakesearch.sh" GOLDENS="$tmp/g.tsv" RECALL_FLOOR=90 bash "$E" >/dev/null 2>&1 && { echo "FAIL: floor 90 should fail at 66%"; fail=1; }
[ $fail -eq 0 ] && echo PASS || exit 1
