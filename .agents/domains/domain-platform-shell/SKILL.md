---
name: domain-platform-shell
description: Catch-all routing floor — any path no other domain owns lands here. Holds cross-cutting gotchas of the harness home that belong to no narrower domain.
files:
  - "**"
---

# Domain: platform-shell (catch-all floor)

The domain router needs one domain that owns `**`: a path nothing more specific claims
routes here, and a more specific domain always wins. The name is the one the generator
and the lesson gate already know (`scripts/gen-domain-routing.mjs`).

Add a domain of your own when a subsystem earns its page: create
`.agents/domains/domain-<name>/SKILL.md` with a `files:` list and a `knowledge.md`, then
run `npm run check:memory-routing`. Rules: [domain-routing schema](../_domain-routing.schema.md).
