# Sourced by memoryctl. Keep HTTP transport separate from command parsing.
http_request() {
  local method="$1" path="$2" body_file="${3:-}" need_token="${4:-0}"
  local url="${MEMORYCTL_URL}${path}"
  local tmp_body tmp_err tmp_headers
  tmp_body="$(mktemp "$_MCTL_TMP/mctl-body.XXXXXX")"
  tmp_err="$(mktemp "$_MCTL_TMP/mctl-err.XXXXXX")"
  tmp_headers="$(mktemp "$_MCTL_TMP/mctl-headers.XXXXXX")"

  local -a args
  args=(-sS -X "$method" -o "$tmp_body" -D "$tmp_headers" -w '%{http_code}' --connect-timeout 3 --max-time 30)
  args+=(-H "Accept: application/json, text/markdown, */*")
  if [[ "$need_token" == "1" ]]; then
    local tok
    if ! tok="$(read_token)"; then
      rm -f "$tmp_body" "$tmp_err" "$tmp_headers"
      printf '0' >"$_MCTL_CODE_FILE"
      return 1
    fi
    args+=(-H "X-Memory-Token: ${tok}")
  fi
  if [[ -n "$body_file" ]]; then
    args+=(-H "Content-Type: application/json; charset=utf-8")
    args+=(--data-binary @"$body_file")
  fi
  args+=("$url")

  local code revived=0
  if ! code="$(curl "${args[@]}" 2>"$tmp_err")"; then
    if revive_service; then
      revived=1
      code="$(curl "${args[@]}" 2>"$tmp_err")" || revived=0
    fi
    if [[ "$revived" != "1" ]]; then
      local err
      err="$(cat "$tmp_err" 2>/dev/null || true)"
      rm -f "$tmp_body" "$tmp_err" "$tmp_headers"
      printf '0' >"$_MCTL_CODE_FILE"
      die "curl failed contacting ${url}: ${err:-network error}"
    fi
  fi
  rm -f "$tmp_err"
  local rerank_notice
  rerank_notice="$(awk 'tolower($0) ~ /^x-memory-rerank:[[:space:]]*unavailable:/ {
    sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); value=$0
  } END { print value }' "$tmp_headers")"
  rm -f "$tmp_headers"
  if [[ -n "$rerank_notice" ]]; then
    printf 'memoryctl: rerank %s\n' "$rerank_notice" >&2
  fi
  printf '%s' "${code:-0}" >"$_MCTL_CODE_FILE"
  cat "$tmp_body"
  rm -f "$tmp_body"
}
