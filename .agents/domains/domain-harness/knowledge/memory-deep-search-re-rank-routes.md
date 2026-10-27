## Memory deep-search: the re-rank routes

`scripts/memory/deep-search.mjs` is a service client: it asks `GET /api/memory/search` for the top 30, then a model selects five current entries by title, date and snippet. Ordinary `memoryctl search` uses no model. Jev is the default route; Terra and Grok are manual alternatives.

Jev errors, timeouts, blocked answers or unknown/repeated ids exit 1 with empty stdout and a manual Terra retry hint, never automatic fallback. `none` and short pools succeed with fewer ids. Candidate titles/snippets are redacted by `ops/bootstrap/jev-gate.mjs`, cut to 160 characters and sent as JSON in one marked task with escaped `<`, preventing candidate text from closing the task.

`scripts/memory/bench-search.mjs` compares routes on frozen pools; without a route it is lexical. Deep-search/bench tests pin `scripts/jev-test-state.mjs` before reaching the client; `scripts/test-jev-ledger-isolation.mjs` enforces isolation. The timeout test waits the real 10 s.

verified: 2026-10-13 (task 2478; reviewer-opencode-890453.2 reverted each rule against its test; one live call 1.9 s)
