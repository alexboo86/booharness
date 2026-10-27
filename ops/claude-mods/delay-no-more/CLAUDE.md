# delay-no-more

A Claude Mod (v2.1.287+) that makes it configurable which tools are *not* deferred behind ToolSearch. A mod is a plugin directory whose hooks run as JS/TS middleware.

## Layout

- `.claude-plugin/plugin.json`: manifest; `userConfig.eager` is the knob (`tools` is a legacy alias, merged in)
- `hooks/hooks.json`: `modules` points to `./register.ts`
- `hooks/register.ts`: the `tool.describe` hook
- `hooks/patterns.ts`: `parsePatterns` / `matchesAny`, pure (unit tested)
- `tests/patterns.test.ts`: run with `claude plugin test`
- `.claude-plugin/types/`: generated per version, authoritative, not hand-edited
- `docs/`: downloaded docs

## Behavior

- `eager` (legacy alias `tools`, merged) is a list of tool names (`WebSearch`, `mcp__server__tool`), separated by commas/whitespace, `*` wildcard.
- `tool.describe` fires once per tool when the engine first renders its schema; for a tool that is deferred and matches, the result becomes `{ ...(await next(e)), isDeferred: false }`. Everything else passes through.
- Empty lists: the hook is not registered.

## Spike findings (2.1.287+)

- The first plan was `$.tool.call` of ToolSearch, then injecting its output. It does not work: the call at `session.start` works but is not recorded in the transcript; ToolSearch's result is `tool_reference` blocks (`text` is `''`, `result.matches` holds names); `$.session.append` and `prompt.submit` `context` take text only. `tool.describe` with `isDeferred: false` is the supported way.
- `isDeferred` must be set on the *result* (`{ ...(await next(e)), isDeferred: false }`); passing `{ ...e, isDeferred: false }` to `next` is ignored.
- MCP tool names use the server name verbatim, so hyphens stay: `mcp__persistent-monitor__waitpid`.
- `pluginConfigs` for a `--plugin-dir` mod: `{"pluginConfigs":{"delay-no-more@inline":{"options":{"tools":"..."}}}}`.

## Verifying changes

1. `claude plugin validate .` and `claude plugin test`
2. Typecheck: `npx -p typescript tsc -p .` (TS5097 on `.ts` imports is expected)
3. End to end, with the `CLAUDE*`/`AI_AGENT` env vars unset:
   `FORCE_PROMPT_CACHING_5M=1 MAX_THINKING_TOKENS=0 CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 claude --model claude-haiku-4-5 --max-turns 1 --plugin-dir . --settings '{"pluginConfigs":{"delay-no-more@inline":{"options":{"eager":"WebSearch"}}}}' -p "List the tools you can call without ToolSearch" </dev/null`

## Docs (downloaded; consult before changing APIs)

- `docs/mods-reference.md`, `docs/mods-events.md`, `docs/mods-api.md`, `docs/mods-create.md`, `docs/mods-test.md`

If docs and types disagree, trust the types (`.claude-plugin/types/claude-code/index.d.ts`).
