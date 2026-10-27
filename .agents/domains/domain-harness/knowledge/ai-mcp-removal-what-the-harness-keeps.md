## The AI MCP removal: what the harness keeps

The analytical MCP surface of the streaming server (`<project-specific>/src/mcp/**`, route `/mcp`) and its domain are retired; the operations bridge stays.

- `.agents/domains/_retired-domains.json` holds `domain-ai-mcp`; `.agents/domains/_skill-map.json`, `ops/bootstrap/domain-skills.json` and `docs/agent/domain-routing.generated.json` no longer route to it. A retired domain's lesson is history, not a routing mismatch (`scripts/test-retired-domain-routing.mjs`).
- `mcp-booharness-servers/` keeps its tools except `get_market_state`, `get_orderflow_snapshot` and `get_derivative_metrics`, which called the server's `/mcp` (`mcp-booharness-servers/src/http-client.ts`, `mcp-booharness-servers/src/tools.ts`). The bridge's own `/mcp` transport stays (`mcp-booharness-servers/src/server-http.ts`).
- `ALLOWED_REFERRERS` in `scripts/check-deletion-refs.mjs` allows `web/supabase/migrations/20260921000001_retire_terminal_ai_analyst.sql` to name the removed transport. The migration is prepared, not applied.

verified: 2026-10-14 (task 2467; reviewer-opencode-16a9d7.1 read the harness slices, reviewer-opencode-dfabf9.1 ran the checks)
