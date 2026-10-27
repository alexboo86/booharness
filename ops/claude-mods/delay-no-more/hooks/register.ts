import { matchesAny, parsePatterns } from './patterns.ts'

export function register(on: any, options?: Record<string, unknown>) {
  // `tools` is the legacy name for `eager`; both are honored.
  const load = [...parsePatterns(options?.eager), ...parsePatterns(options?.tools)]
  const defer = parsePatterns(options?.defer)
  if (!load.length && !defer.length) return
  // The engine asks once per tool, when it first renders the tool's schema. A tool named by
  // `eager` is moved from behind ToolSearch into the prompt's tool list; one named by `defer`
  // goes the other way. `eager` wins when both match. Everything else is left as the engine
  // placed it.
  on('tool.describe', async ($: any, e: any, next: any) => {
    const wantLoad = !!e.isDeferred && matchesAny(load, e.tool)
    const wantDefer = !e.isDeferred && !matchesAny(load, e.tool) && matchesAny(defer, e.tool)
    if (!wantLoad && !wantDefer) return next(e)
    // The placement is part of the answer, so override it on the result, not on the event
    return { ...(await next(e)), isDeferred: wantDefer }
  })
}
