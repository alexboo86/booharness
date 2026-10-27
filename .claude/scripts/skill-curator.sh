#!/usr/bin/env bash
# skill-curator.sh — DRY-RUN report over distilled-skill candidates + active
# auto-skills: lists them and flags likely duplicates by TEXT similarity of
# name/description (NO vector DB). Prints only; never moves/edits files.
# Part of the lean self-improving-skill loop (see skills/distill-skill).
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CANDIDATES="$ROOT/.claude/skill-candidates"
SKILLS="$ROOT/.agents/skills"

tokenize() {
  LC_ALL=C tr '[:upper:]' '[:lower:]' |
    LC_ALL=C sed -E 's/[^a-z0-9_-]+/ /g' |
    tr ' ' '\n' |
    sed '/^$/d' |
    sort -u
}

frontmatter_value() {
  local key="$1"
  local file="$2"
  awk -F': *' -v k="$key" '
    /^---$/ { fence++; next }
    fence == 1 && $1 == k {
      sub("^[^:]+: *", "")
      gsub(/^"|"$/, "")
      print
      exit
    }
  ' "$file" 2>/dev/null
}

skill_summary() {
  local file="$1"
  local name desc
  name="$(frontmatter_value name "$file")"
  desc="$(frontmatter_value description "$file")"
  printf '%s\t%s\t%s\n' "$file" "$name" "$desc"
}

similarity_report() {
  local tmp="$1"
  local threshold=3

  while IFS=$'\t' read -r file_a name_a desc_a; do
    [ -n "$file_a" ] || continue
    text_a="$name_a $desc_a"
    tokens_a="$(printf '%s' "$text_a" | tokenize | tr '\n' ' ')"

    while IFS=$'\t' read -r file_b name_b desc_b; do
      [ "$file_a" = "$file_b" ] && continue
      [[ "$file_a" > "$file_b" ]] && continue

      text_b="$name_b $desc_b"
      tokens_b="$(printf '%s' "$text_b" | tokenize | tr '\n' ' ')"

      shared=0
      for token in $tokens_a; do
        case " $tokens_b " in
          *" $token "*) shared=$((shared + 1)) ;;
        esac
      done

      substring="no"
      a_lc="$(printf '%s' "$text_a" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
      b_lc="$(printf '%s' "$text_b" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
      if [ -n "$a_lc" ] && [ -n "$b_lc" ]; then
        [[ $a_lc == *"$b_lc"* ]] && substring="yes"
        [[ $b_lc == *"$a_lc"* ]] && substring="yes"
      fi

      if [ "$shared" -ge "$threshold" ] || [ "$substring" = "yes" ]; then
        printf 'POSSIBLE DUPLICATE shared_tokens=%s substring=%s\n' "$shared" "$substring"
        printf '  A: %s | %s | %s\n' "$file_a" "$name_a" "$desc_a"
        printf '  B: %s | %s | %s\n' "$file_b" "$name_b" "$desc_b"
        printf '  suggestion: review for merge or archive one candidate\n\n'
      fi
    done < "$tmp"
  done < "$tmp"
}

tmp="$(mktemp "${TMPDIR:-/tmp}/skill-curator.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

echo "== Skill curator report =="
echo "root: $ROOT"
echo

echo "== Candidates =="
if [ -d "$CANDIDATES" ]; then
  find "$CANDIDATES" -maxdepth 1 -type f -name '*.md' | sort | while read -r file; do
    printf '%s\n' "$file"
  done
else
  echo "none: $CANDIDATES does not exist"
fi
echo

echo "== Active skills =="
if [ -d "$SKILLS" ]; then
  find "$SKILLS" -mindepth 2 -maxdepth 2 -type f -name 'SKILL.md' | sort | while read -r file; do
    skill_summary "$file" | tee -a "$tmp"
  done
else
  echo "none: $SKILLS does not exist"
fi
echo

echo "== Candidate text index =="
if [ -d "$CANDIDATES" ]; then
  find "$CANDIDATES" -maxdepth 1 -type f -name '*.md' | sort | while read -r file; do
    title="$(sed -n '1s/^# *//p' "$file" 2>/dev/null)"
    triggers="$(awk '/^trigger_conditions:/ { on=1; next } /^[a-zA-Z_]+:/ { on=0 } on { print }' "$file" 2>/dev/null | tr '\n' ' ')"
    printf '%s\t%s\t%s\n' "$file" "$title" "$triggers" | tee -a "$tmp"
  done
fi
echo

echo "== Likely duplicates =="
if [ -s "$tmp" ]; then
  similarity_report "$tmp"
else
  echo "no skills or candidates to compare"
fi

echo "DRY-RUN only: no files were moved or edited."
exit 0
