import { expect, test } from 'claude-code/testing'

import { parseChat, parseDashboard, summaryLine } from '../hooks/parse'
import type { PollSnapshot } from '../types'
import { chatText, dashboardText } from './fixtures/payloads'

test('parser accepts a synthetic dashboard and chat sample', () => {
  const board = parseDashboard(dashboardText)
  const chat = parseChat(chatText)
  expect(board.ok).toBe(true)
  expect(chat.ok).toBe(true)
  if (!board.ok || !chat.ok) return
  expect(board.value.version).toBe('9.9.9')
  expect(board.value.at).toBe('2026-01-15T12:00:00.000Z')
  expect(board.value.draining).not.toBeNull()
  expect(board.value.leads.length).toBe(2)
  expect(board.value.seats.length).toBe(2)
  expect(board.value.rtk?.saved).toBe(1000)
  expect(board.value.jev?.todayUsd).toBe(1.25)
  expect(chat.value.posts.length).toBe(5)
  expect(chat.value.watchers).toBe(1)
  expect(chat.value.handles.length).toBe(2)
  const now = Date.parse(board.value.at) + 4_000
  const snap: PollSnapshot = { board: board.value, boardError: null, chat: chat.value, chatError: null, chatStatus: 200 }
  expect(summaryLine(snap, now)).toBe('age 4s · leads 2 · seats 2 · posts 5')
})

test('parser rejects a body that is not a board or a chat list', () => {
  expect(parseDashboard('not json').ok).toBe(false)
  expect(parseDashboard('{"version":"0.1.0"}').ok).toBe(false)
  expect(parseDashboard('{"leads":1}').ok).toBe(false)
  expect(parseChat('{"posts":[]}').ok).toBe(false)
  const missing = parseChat('{"posts":[],"handles":[]}')
  expect(missing.ok).toBe(false)
  if (!missing.ok) expect(missing.error).toBe('watchers is not a number')
})

test('a missing read is not drawn as zero', () => {
  expect(summaryLine(null, 0)).toBe('Reading orch...')
  expect(summaryLine({ board: null, boardError: 'HTTP 500', chat: null, chatError: null, chatStatus: 500 }, 0)).toBe('HTTP 500')
})
