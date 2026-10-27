#!/bin/bash
# ================================================================
# qwen-upgrade.sh — switch basic-memory embeddings to Qwen3-Embedding via litellm->Ollama (LOCAL)
#   usage: bash .claude/scripts/qwen-upgrade.sh [ollama-model]   (default: qwen3-embedding:4b)
# ================================================================
# basic-memory providers = fastembed | openai | litellm (verified in source by Codex+Kimi).
# litellm routes to a LOCAL Ollama via model "ollama/<m>" + env OLLAMA_API_BASE; basic-memory does
# NOT pass api_base, so litellm reads OLLAMA_API_BASE itself. Self-calibrates the embedding dim from
# a live sample and HARD-GATES on a non-empty vector BEFORE the destructive reindex (lesson: mpnet
# gave 0% because the model never actually loaded). Backup-first → reversible. RUN WITH ALL CLAUDE
# SESSIONS CLOSED (reindex drops the vector table; basic-memory must not be attached).
# ================================================================
set -euo pipefail
export PATH="/usr/bin:/mingw64/bin:$HOME/.local/bin:$PATH"
BM="$HOME/.basic-memory"
MODEL="${1:-qwen3-embedding:4b}"
LLMODEL="ollama/$MODEL"
: "${OLLAMA_API_BASE:=http://localhost:11434}"
export OLLAMA_API_BASE
TS="$(date +%Y%m%d-%H%M%S)"
BK="$BM/_qwen-backup-$TS"

procs_attached() {
  if command -v tasklist >/dev/null 2>&1; then tasklist 2>/dev/null | grep -qiE 'basic-memory|uvx'
  else pgrep -fi 'basic-memory|uvx' >/dev/null 2>&1; fi
}
echo "0) Verify NO basic-memory/uvx process attached..."
procs_attached && { echo "ABORT: close ALL Claude sessions first." >&2; exit 1; }

echo "1) Ollama reachable at $OLLAMA_API_BASE ?"
curl -fsS "$OLLAMA_API_BASE/api/tags" >/dev/null 2>&1 || { echo "ABORT: Ollama not serving. Run:  ollama serve   (and: ollama pull $MODEL)" >&2; exit 1; }
echo "   ok. Ensuring model present (pull if missing)..."
ollama pull "$MODEL" || { echo "ABORT: could not pull $MODEL" >&2; exit 1; }

echo "2) PRECHECK — embed a bilingual sample via litellm->ollama, capture dim, assert non-empty..."
DIM="$(uv run --python 3.12 --with litellm python - "$LLMODEL" <<'PY'
import sys, asyncio, litellm
model = sys.argv[1]
async def main():
    r = await litellm.aembedding(model=model, input=["почему поиск памяти не находит hybrid semantic recall RU EN"])
    v = r["data"][0]["embedding"]
    assert v and sum(abs(x) for x in v) > 0, "empty/zero vector"
    print(len(v))
asyncio.run(main())
PY
)" || { echo "ABORT: precheck failed (model did not return a usable vector). NOTHING changed." >&2; exit 1; }
echo "   ✓ live embedding dim = $DIM (non-empty). Safe to proceed."

echo "3) Backup memory.db + config.json -> $BK"
mkdir -p "$BK"; cp "$BM/memory.db" "$BK/memory.db"; cp "$BM/config.json" "$BK/config.json"
echo "   backed up ($(du -h "$BK/memory.db" | cut -f1))"

echo "4) Point basic-memory at litellm/ollama (dim=$DIM)..."
tmp="$(mktemp)"
jq --arg m "$LLMODEL" --argjson d "$DIM" '
  .semantic_embedding_provider="litellm" |
  .semantic_embedding_model=$m |
  .semantic_embedding_dimensions=$d |
  .semantic_embedding_forward_dimensions=false |
  .semantic_embedding_request_concurrency=1
' "$BM/config.json" > "$tmp" && mv "$tmp" "$BM/config.json"
echo "   model -> $(jq -r '.semantic_embedding_model' "$BM/config.json") (dim $DIM)"

echo "5) reset --reindex --force (rebuilds vector table at $DIM dim; embeds 600 notes via Ollama)..."
uvx --python 3.12 --with litellm basic-memory reset --reindex --force

echo "6) eval BOTH numbers..."
EVAL="$HOME/.claude/skills/curate/scripts/eval.sh"
echo "--- RERANK=0 (raw) ---"; RERANK=0 RECALL_FLOOR=0 bash "$EVAL" || true
echo "--- RERANK=1 (reranked) ---"; RERANK=1 RECALL_FLOOR=0 bash "$EVAL" || true
echo ""
echo "MiniLM baseline (38 goldens): RERANK=0 50% / RU 39% ; RERANK=1 65% / RU 52%."
echo "KEEP Qwen only if RU clearly beats that. Then set the env for the live MCP launchers:"
echo "    setx OLLAMA_API_BASE \"$OLLAMA_API_BASE\"   (PowerShell, then restart Claude/Codex/Kimi)"
echo "DONE. Backup: $BK"
echo "Rollback:  bash .claude/scripts/mpnet-rollback.sh \"$BK\"   (restores db+config)"
