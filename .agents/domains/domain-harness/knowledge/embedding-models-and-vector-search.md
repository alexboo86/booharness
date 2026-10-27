## Embedding models and vector search

`MODELS` (`scripts/memory/embed-recipe.mjs`) defines query/document prefixes; Qwen prefixes queries only. Memoryd refuses unlisted models, prefixes plain searches and exposes `embedder.queryPrefix` in `/health`. Other-model vectors are stale and overwritten on embedding; model changes empty plain search until cache import (`scripts/memory/import-vectors.mjs`) or backlog re-embedding.

`idTokens` (`scripts/memory/store.mjs`) recognizes seat ids, mixed letter/digit shas, `task N` and `#N` with 3–6 digits. Plain queries promote FTS5 quoted-token matches, retaining cosine order within groups and the dense filter as sole gate. Without the embedder, search returns 503, surfaced by CLI, MCP, `ops/update-tools.mjs` and `scripts/memory/service-client.mjs`.

The worker (`scripts/memory/memoryd.mjs`) embeds missing/stale vectors after writes, using `MEMORYCTL_EMBED_BACKLOG_URL` or the query embedder. Mac uses local for both. `scripts/memory/import-vectors.mjs` seeds Windows-GPU caches. `/health` reports embedder/vector counts; `scripts/probe-memory-service.mjs` fails dense servers without working embedding. The bench shares the recipe; `scripts/memory/bench-hybrid.mjs` (not in this kit) uses `search-bench.cases.json`.

`importPinnedEmbedModel` (`scripts/lib/import-embed-model.mjs`) downloads default `qwen3-embedding:0.6b` as the official Q8_0 GGUF pinned in `ops/bootstrap/tool-pins.json`, HTTPS/huggingface.co only. Size/sha256 mismatch stops before `ollama create`. Imported vectors equal the registry model's; other models use `ollama pull`.

verified: 2026-09-23
