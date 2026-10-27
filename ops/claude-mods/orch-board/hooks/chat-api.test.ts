import { expect, test } from 'claude-code/testing'

import { BASE, INITIAL_CHAT_FORM_STATE, createChatForms, messageCount, releaseQuestion } from './chat-api'
import type { ChatFetch } from './chat-api'

type Call = { method: string; path: string; headers: Record<string, string>; body: unknown }

function formsFor(reply: (call: Call) => Promise<{ status?: number; body: unknown; raw?: boolean }> | { status?: number; body: unknown; raw?: boolean }) {
  const calls: Call[] = []
  let state = { ...INITIAL_CHAT_FORM_STATE }
  let writable = true
  let refreshes = 0
  const fetch: ChatFetch = async (url, init) => {
    expect(new URL(url).origin).toBe(BASE)
    const call: Call = {
      method: init?.method ?? 'GET',
      path: new URL(url).pathname,
      headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
      body: init?.body ? JSON.parse(init.body) : null,
    }
    calls.push(call)
    const answer = await reply(call)
    const text = answer.raw ? String(answer.body) : JSON.stringify(answer.body)
    const status = answer.status ?? 200
    return { status, ok: status >= 200 && status < 300, text }
  }
  const actions = createChatForms({
    fetch,
    getState: () => state,
    patchState: (patch) => { state = { ...state, ...patch } },
    canWrite: () => writable,
    refresh: () => { refreshes += 1 },
  })
  return {
    actions,
    calls,
    state: () => state,
    refreshes: () => refreshes,
    readOnly: () => { writable = false },
  }
}

function expectPost(call: Call | undefined): void {
  expect(call?.method).toBe('POST')
  expect(call?.headers.origin).toBe('http://127.0.0.1:7760')
  expect(call?.headers['x-orch-chat']).toBe('1')
  expect(call?.headers['content-type']).toBe('application/json')
}

test('message input caps Unicode code points and sends blank recipients to all with guard headers', async () => {
  const f = formsFor(() => ({ body: { id: 1 } }))
  await f.actions.send()
  expect(f.calls).toHaveLength(0)
  await f.actions.setBody('😀'.repeat(601))
  expect(f.state().body).toBe('😀'.repeat(600))
  expect(messageCount(f.state().body)).toBe('600 / 600')
  await f.actions.send()
  expectPost(f.calls[0])
  expect(f.calls[0]?.body).toEqual({ body: '😀'.repeat(600), to: 'all', wake: false })
  expect(f.state().body).toBe('')
  expect(messageCount(f.state().body)).toBe('0 / 600')
  expect(f.state().sendStatus).toBe('Sent')
  expect(f.refreshes()).toBe(1)
})

test('explicit recipients retain order and invalid empty entries for the daemon to judge; wake is opt-in', async () => {
  const f = formsFor(() => ({ body: { id: 2 } }))
  await f.actions.setBody('act now')
  await f.actions.setTo(' one, two, ,one ')
  await f.actions.toggleWake()
  await f.actions.send()
  expect(f.calls[0]?.body).toEqual({ body: 'act now', to: ['one', 'two', '', 'one'], wake: true })
})

test('release checks fresh binding and needs a separate second click before posting', async () => {
  const f = formsFor((call) => {
    if (call.path === '/api/chat') return { body: { handles: [{ handle: 'lead', session: 'fresh-session' }] } }
    return { body: { handle: 'lead' } }
  })
  await f.actions.setHandle(' lead ')
  await f.actions.release()
  expect(f.calls.map((call) => [call.method, call.path])).toEqual([['GET', '/api/chat']])
  expect(f.calls[0]?.headers['cache-control']).toBe('no-cache')
  expect(releaseQuestion(f.state().confirmation!)).toBe('Release handle "lead" (live session: fresh-session)?')
  await f.actions.release()
  expect(f.calls.map((call) => call.path)).toEqual(['/api/chat', '/chat/release'])
  expectPost(f.calls[1])
  expect(f.calls[1]?.body).toEqual({ handle: 'lead' })
  expect(f.state().handle).toBe('')
  expect(f.state().releaseStatus).toBe('Released lead')
  expect(f.refreshes()).toBe(1)
})

test('no holder remains releasable, but cancellation and handle edits invalidate confirmation', async () => {
  const f = formsFor(() => ({ body: { handles: [] } }))
  await f.actions.setHandle('orphan')
  await f.actions.release()
  expect(releaseQuestion(f.state().confirmation!)).toBe('Release handle "orphan" (no live session)?')
  await f.actions.cancelRelease()
  expect(f.state().confirmation).toBeNull()
  await f.actions.release()
  await f.actions.setHandle('other')
  expect(f.state().confirmation).toBeNull()
  await f.actions.release()
  expect(f.state().confirmation?.handle).toBe('other')
  expect(f.calls.every((call) => call.method === 'GET')).toBe(true)
})

test('daemon JSON and plain-text refusals remain visible without retry or losing message', async () => {
  for (const reply of [
    { status: 400, body: { error: "chat post takes no 'extra'" }, expected: "chat post takes no 'extra'" },
    { status: 503, body: 'daemon is unavailable', raw: true, expected: 'daemon is unavailable' },
  ]) {
    const f = formsFor(() => reply)
    await f.actions.setBody('keep my text')
    await f.actions.send()
    expect(f.state().sendStatus).toBe(reply.expected)
    expect(f.state().body).toBe('keep my text')
    expect(f.state().sending).toBe(false)
    expect(f.calls).toHaveLength(1)
    expect(f.refreshes()).toBe(0)
  }
})

test('failed fresh check and failed release show the daemon text and clear approval', async () => {
  const f = formsFor((call) => call.path === '/api/chat'
    ? { body: { handles: [] } }
    : { status: 403, body: { error: 'release refused' } })
  await f.actions.setHandle('lead')
  await f.actions.release()
  await f.actions.release()
  expect(f.state().releaseStatus).toBe('release refused')
  expect(f.state().confirmation).toBeNull()
  expect(f.state().handle).toBe('lead')
  expect(f.calls).toHaveLength(2)
  expect(f.refreshes()).toBe(0)
  const down = formsFor(() => ({ status: 500, body: { error: 'check refused' } }))
  await down.actions.setHandle('lead')
  await down.actions.release()
  expect(down.state().releaseStatus).toBe('check refused')
  expect(down.state().confirmation).toBeNull()
  expect(down.calls).toHaveLength(1)
})

test('read-only state blocks writes, including a new read-only snapshot during confirmation', async () => {
  const f = formsFor(() => ({ body: { handles: [], readOnly: true } }))
  await f.actions.setHandle('lead')
  await f.actions.release()
  expect(f.state().confirmation).toBeNull()
  expect(f.state().releaseStatus).toBe('Chat is read-only.')
  f.readOnly()
  await f.actions.setBody('not sent')
  await f.actions.send()
  await f.actions.release()
  expect(f.calls).toHaveLength(1)
})

test('overlapping clicks cannot duplicate a send or turn a pending fresh check into release', async () => {
  let unblock: () => void = () => undefined
  let arrived: () => void = () => undefined
  const arrival = new Promise<void>((resolve) => { arrived = resolve })
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  const f = formsFor(async (call) => {
    arrived()
    await gate
    return { body: call.path === '/api/chat' ? { handles: [] } : { id: 1 } }
  })
  await f.actions.setBody('once')
  const pending = f.actions.send()
  await arrival
  await f.actions.send()
  await f.actions.setBody('must not replace an in-flight message')
  unblock()
  await pending
  expect(f.calls).toHaveLength(1)
  expect(f.refreshes()).toBe(1)
  await f.actions.setHandle('lead')
  await Promise.all([f.actions.release(), f.actions.release()])
  expect(f.calls.map((call) => call.path)).toEqual(['/chat/post', '/api/chat'])
  expect(f.state().confirmation).toBeTruthy()
})

test('malformed fresh snapshots never authorize release', async () => {
  const f = formsFor(() => ({ body: { handles: [{ handle: 'lead', session: 9 }] } }))
  await f.actions.setHandle('lead')
  await f.actions.release()
  expect(f.state().releaseStatus).toBe('Invalid chat response')
  expect(f.state().confirmation).toBeNull()
  expect(f.calls).toHaveLength(1)
})
