#!/usr/bin/env bash
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; A="$HERE/../admit-candidates.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# inbox note
cat > "$tmp/_inbox_new.md" <<'EOF'
---
name: new-liq-lesson
description: Hyperliquid liquidations require a self-hosted L1 node
metadata:
  type: reference
  evidence_class: observed-once
  status: active
  tags: [liquidations]
  date: 2026-06-23
  source: curator
---
body
EOF
# fake search returns 2 existing candidates + the note itself (must be filtered out)
cat > "$tmp/fakesearch.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"results":[
 {"score":0.91,"file_path":"reference_hyperliquid_liquidations_sourcing.md"},
 {"score":0.40,"file_path":"_inbox/_inbox_new.md"},
 {"score":0.33,"file_path":"handoff_old.md"}]}'
EOF
chmod +x "$tmp/fakesearch.sh"
out=$(BM_SEARCH_CMD="$tmp/fakesearch.sh" K=6 bash "$A" "$tmp/_inbox_new.md")
fail=0
grep -q 'reference_hyperliquid_liquidations_sourcing.md' <<<"$out" || { echo "FAIL: top candidate missing"; fail=1; }
grep -q '_inbox_new.md' <<<"$out" && { echo "FAIL: self not filtered"; fail=1; }
[ "$(printf '%s\n' "$out" | head -1 | cut -f2)" = "reference_hyperliquid_liquidations_sourcing.md" ] || { echo "FAIL: not ranked first"; fail=1; }
[ $fail -eq 0 ] && echo PASS || { echo "--out--"; echo "$out"; exit 1; }
