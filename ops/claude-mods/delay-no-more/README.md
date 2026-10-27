# delay-no-more

A Claude Mod that lets you choose which tools Claude Code defers behind ToolSearch and which it does not. By default many built-in tools and all MCP tools sit behind ToolSearch, so Claude must spend a turn fetching a schema before first use. Tools you list in `eager` have their schemas in the prompt from the first turn. Tools you list in `defer` go the other way: their schemas stay out of the prompt until Claude asks for them.

## Installation

Requires Claude Code v2.1.287 or later.

Install it from the official Anthropic plugin directory. In case you haven't added this marketplace yet, add it first, and refresh it to get the latest listing:

```
claude plugin marketplace add anthropic-plugin-directory
claude plugin marketplace update anthropic-plugin-directory
claude plugin install delay-no-more@anthropic-plugin-directory
```

If you prefer using the TUI, inside a session, use `/plugin marketplace add`, `/plugin marketplace update` and `/plugin install` with the same arguments.

To update to a newer release later:

```
claude plugin marketplace update anthropic-plugin-directory
claude plugin update delay-no-more@anthropic-plugin-directory
```

To try a local checkout while developing, load it directly instead (its plugin id is then `delay-no-more@inline`):

```
claude --plugin-dir /path/to/delay-no-more
```

## Configuration

Two options, each a list of tool names separated by commas or spaces. `*` matches any characters. Names that match nothing are ignored.

- `eager`: tools to load up front, taking them out from behind ToolSearch.
- `defer`: tools to put behind ToolSearch, so their schemas load only when Claude asks for them. Use it to trim prompt tokens, e.g. a built-in tool you rarely use, or a wildcard `eager` pattern with a few exceptions.

If a tool matches both lists, `eager` wins. Tools matching neither are left as Claude Code places them. Both empty (the default) changes nothing, and the hook is not registered.

The older name `tools` still works and is merged with `eager`. Prefer `eager` in new configuration.

Set it in your Claude Code settings under `pluginConfigs`, keyed by the plugin id:

```json
{
  "pluginConfigs": {
    "delay-no-more@anthropic-plugin-directory": {
      "options": {
        "eager": "WebSearch, WebFetch, mcp__github__*",
        "defer": "mcp__github__create_repository"
      }
    }
  }
}
```

When loaded locally with `--plugin-dir`, use `delay-no-more@inline` as the key instead:

```json
{
  "pluginConfigs": {
    "delay-no-more@inline": {
      "options": {
        "eager": "WebSearch, WebFetch, mcp__github__*",
        "defer": "mcp__github__create_repository"
      }
    }
  }
}
```

The change applies to new sessions.

MCP tool names are `mcp__<server>__<tool>` with the server name as configured (hyphens included), e.g. `mcp__persistent-monitor__waitpid`.

## Trade-off

Every `eager` tool's schema costs prompt tokens on every request. List the tools you use constantly, not whole servers with dozens of tools. `defer` is the opposite trade: it saves prompt tokens, but Claude needs an extra ToolSearch turn before first use.

## How it works

A `tool.describe` hook moves each deferred tool matching `eager` into the prompt's tool list (`isDeferred: false`), and each non-deferred tool matching `defer` behind ToolSearch (`isDeferred: true`). Other tools are untouched.

## What it runs, sends, and fetches

- It runs a single `tool.describe` hook, written in TypeScript (`hooks/register.ts` and `hooks/patterns.ts`), inside Claude Code.
- It makes **no model calls**, **no network requests**, and **no shell commands**.
- It does not read or write any files, and it uses no credentials, environment variables, or MCP servers.
- It does not collect, store, or transmit any data.
- It has no package dependencies and no install step.

## Development

The matching logic is in `hooks/patterns.ts` (`parsePatterns`, `matchesAny`), covered by unit tests in `tests/patterns.test.ts`.

```
claude plugin validate .
claude plugin test
```
