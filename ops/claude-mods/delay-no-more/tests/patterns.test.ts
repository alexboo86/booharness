import { expect, test } from 'claude-code/testing'
import { matchesAny, parsePatterns } from '../hooks/patterns.ts'

test('parses separators', () => {
  const p = parsePatterns('WebSearch, WebFetch\nmcp__gh__*  Cron.*')
  expect(p.length).toBe(4)
  expect(matchesAny(p, 'WebFetch')).toBe(true)
  expect(matchesAny(p, 'Monitor')).toBe(false)
})

test('wildcards and exact names', () => {
  const p = parsePatterns('mcp__github__*,Web?earch')
  expect(matchesAny(p, 'mcp__github__create_issue')).toBe(true)
  expect(matchesAny(p, 'mcp__gitlab__x')).toBe(false)
  expect(matchesAny(p, 'WebSearch')).toBe(false)
  expect(matchesAny(p, 'Web?earch')).toBe(true)
})

test('non-string or empty gives no patterns', () => {
  expect(parsePatterns(undefined).length).toBe(0)
  expect(parsePatterns('  ').length).toBe(0)
})
