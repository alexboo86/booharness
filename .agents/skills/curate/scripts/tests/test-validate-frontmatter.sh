#!/usr/bin/env bash
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; V="$HERE/../validate-frontmatter.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0
cat > "$tmp/good.md" <<'EOF'
---
name: x-fact
description: a fact
metadata:
  type: feedback
  confidence: high
  tags: [alpha]
  date: 2026-06-22
  source: curator
---
body
EOF
bash "$V" "$tmp/good.md"; [ $? -eq 0 ] || { echo "FAIL: good(confidence) rejected"; fail=1; }
# NEW: evidence_class instead of confidence -> accepted
cat > "$tmp/good2.md" <<'EOF'
---
name: ev-fact
description: a fact
metadata:
  type: reference
  evidence_class: test-confirmed
  status: active
  tags: [alpha]
  date: 2026-06-23
  source: curator
---
body
EOF
bash "$V" "$tmp/good2.md"; [ $? -eq 0 ] || { echo "FAIL: good(evidence_class) rejected"; fail=1; }
cat > "$tmp/bad.md" <<'EOF'
---
name: y
description: d
metadata:
  type: feedback
---
body
EOF
bash "$V" "$tmp/bad.md"; [ $? -eq 1 ] || { echo "FAIL: bad accepted"; fail=1; }
[ $fail -eq 0 ] && echo "PASS" || exit 1
