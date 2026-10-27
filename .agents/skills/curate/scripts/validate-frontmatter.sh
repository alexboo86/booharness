#!/usr/bin/env bash
# Validate a memory file's frontmatter against CONTRACT.md required keys.
set -u
f="${1:?usage: validate-frontmatter.sh <file.md>}"
fm="$(awk 'NR==1&&$0=="---"{f=1;next} f&&$0=="---"{exit} f{print}' "$f")"
miss=()
for k in 'name:' 'description:' 'type:' 'tags:' 'date:' 'source:'; do
  grep -q "$k" <<<"$fm" || miss+=("$k")
done
# trust key: evidence_class (new standard) OR legacy confidence
grep -qE 'evidence_class:|confidence:' <<<"$fm" || miss+=("evidence_class|confidence")
if [ ${#miss[@]} -ne 0 ]; then printf 'missing: %s\n' "${miss[*]}" >&2; exit 1; fi
exit 0
