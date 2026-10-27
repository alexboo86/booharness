import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { RenderSurface, UiPane } from 'claude-code'

function stub(on: Parameters<TestBody>[1], surfaces: RenderSurface[]) {
  const panes: UiPane[] = []
  const opened: string[] = []
  on('command.register', async (_$, event) => ({ value: { command: event.name } }))
  on('session.start', async (_$, event) => ({ cwd: event.cwd }))
  on('session.surfaces', async () => ({ value: surfaces }))
  on('session.attach', async (_$, event) => ({ clientId: event.clientId }))
  on('ui.panes', async () => ({ value: panes }))
  on('ui.open', async (_$, event) => {
    opened.push(event.id)
    panes.push({ id: event.id, title: event.title ?? '', isShown: true, isFocused: false, isPlaced: true })
    return { value: { isPlaced: true as const } }
  })
  return opened
}

// Decision 17619: the pane opens at session start without /orch-board, and a second start
// (a module reload raises one) does not open it again.
test('session start opens the orch pane once', async ($, on) => {
  const opened = stub(on, ['desktop'])
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: false })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: false })
  expect(opened).toEqual(['orch-board'])
})

// Test-audit: with no surface attached ui.open rejects with no-surface and the engine
// prints that error at every session start (operator report 2026-10-17); the pane must
// wait for the first attach instead. open-once above does not cover an empty roster.
test('no surface at start: the pane opens at the first attach, not before', async ($, on) => {
  const surfaces: RenderSurface[] = []
  const opened = stub(on, surfaces)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  expect(opened).toEqual([])
  surfaces.push('desktop')
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(opened).toEqual(['orch-board'])
})
