// Parses the `eager` and `defer` options into patterns and matches tool names against them.
// A pattern is a tool name, or a name with `*` wildcards (`mcp__github__*`).
// Patterns are separated by commas or whitespace.

export function parsePatterns(value: unknown): RegExp[] {
  if (typeof value !== 'string') return []
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((p) => new RegExp('^' + p.split('*').map(escape).join('.*') + '$'))
}

export function matchesAny(patterns: readonly RegExp[], tool: string): boolean {
  return patterns.some((re) => re.test(tool))
}

function escape(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}
