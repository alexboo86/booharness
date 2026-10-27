---
id: ops-mcp-vendor
owner: domain-platform-shell
paths:
  - ops/mcp-vendor/**
entry: ops/mcp-vendor/package.json
layer: tooling
---
## Purpose

Pins locally installed third-party MCP servers so agent runtimes can launch known packages by absolute path rather than fetching them at startup.

## Public API

This is a private npm installation boundary, not a JavaScript export facade.

`ops/bootstrap/mcp-servers.json` owns launcher definitions. Consumers install
with `npm ci --prefix ops/mcp-vendor`; the kit builder ships this package.

### Wire names

| Interface | Description |
|---|---|
| package `name` | Private package identity (see `package.json`) for the shared vendor dependency tree. |
| `install:vendor` | Runs `npm ci --omit=dev` in this package. |
| `@brightdata/mcp` | Pins version `2.11.1`; bootstrap launches its installed server by absolute path. |
| `@sinco-lab/mcp-youtube-transcript` | Pins version `0.0.12` for the configured transcript server. |
| `@upstash/context7-mcp` | Pins version `3.2.5` for the configured documentation server. |

## Inputs

- `package.json` and `package-lock.json`, read by npm's clean-install workflow.
- Package registry access during installation, not an unpinned fetch on each agent startup.
- Host-side MCP configuration and credentials belong to the installer/server, not these manifests.

## Outputs

- Local `node_modules` containing the lock-resolved MCP server executables.
- Stable installed paths for bootstrap's MCP launch configuration.
- MCP stdio behavior belongs to the selected external server; this module defines no product wire format.

## Invariants

- The package is private and is not a publishable application artifact. Source: `package.json` (`private`).
- Each direct server dependency is an exact version, not a floating range. Source: `package.json`; `package-lock.json`.
- The installation verb uses `npm ci --omit=dev`, retaining lockfile-based resolution rather than a startup-time latest-package fetch. Source: `package.json` (`scripts`).
- Bright Data's configured launcher uses the repository-local installed server path. Source: `ops/bootstrap/mcp-servers.json`; `docs/agent/harness-allowlist.md`.

## Dependencies

### Internal Modules

- No repository source imports: this module contains only its contract and npm manifests.
- `ops-bootstrap` and `ops-harness-kit` are consumers, not imported dependencies.

### External Libraries

- The three pinned MCP packages listed in Public API and their locked transitive dependencies.
- Node.js and npm provide execution and reproducible installation.

## Tests

- No module-owned executable test exists; the tracked implementation is the package manifest/lockfile pair.
- `scripts/test-mcp-ssot-render.mjs` — consumer-side MCP configuration rendering, not server protocol behavior.
- `ops/harness-kit/test-neutral-config.mjs` — checks shipped vendor manifests for donor-specific metadata in a built kit.
- Installation command: `npm ci --omit=dev --prefix ops/mcp-vendor` (requires registry/network access).

## Owner

`domain-platform-shell`; launcher selection is maintained by the bootstrap module.

## Changelog

- Task 2409 slice C: describe existing package pins and the local installation boundary; no dependency change.
