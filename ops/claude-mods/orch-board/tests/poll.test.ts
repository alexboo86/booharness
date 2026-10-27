import { expect, mock, test } from 'claude-code/testing'

import { chatText, dashboardText } from './fixtures/payloads'

const DASH = 'http://127.0.0.1:7760/api/dashboard'
const CHAT = 'http://127.0.0.1:7760/api/chat'

const PANE = {
  title: 'orch',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 24 },
  view: {},
}

test('a drawn pane polls both routes and does not start a second request for one still in flight', async ($, on) => {
  const clock = mock.clock(on)
  const calls: string[] = []
  let holdDashboard = false
  on('http.fetch', async (_$, event) => {
    calls.push(event.url)
    if (holdDashboard && event.url === DASH) await clock.sleep(30_000)
    if (event.url === DASH) return { value: { status: 200, ok: true, headers: {}, text: dashboardText } }
    if (event.url === CHAT) return { value: { status: 200, ok: true, headers: {}, text: chatText } }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  const ui = await $.ui.mount({
    plugin: 'orch-board',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'orch-board',
    props: PANE,
  })
  await ui.post({ tick: true })
  expect(await ui.find({ type: 'Text', in: 'poll' })).toBeUndefined()
  const poll = await ui.find({ type: 'Client' })
  expect(poll?.props.height).toBe(0)

  const before = calls.filter((url) => url === DASH).length
  holdDashboard = true
  const pending = ui.post({ tick: true })
  await clock.settle()
  const held = calls.filter((url) => url === DASH).length
  expect(held).toBe(before + 1)
  const chatHeld = calls.filter((url) => url === CHAT).length
  await ui.advance(3_000)
  expect(calls.filter((url) => url === DASH).length).toBe(held)
  expect(calls.filter((url) => url === CHAT).length).toBe(chatHeld + 1)
  await clock.advance(30_000)
  await pending
  await ui.unmount()
})

test('close and reopen during pending polls keeps one request per route and one live loop', async ($, on) => {
  const clock = mock.clock(on)
  const calls: string[] = []
  const active = { [DASH]: 0, [CHAT]: 0 }
  const peak = { [DASH]: 0, [CHAT]: 0 }
  let hold = false
  on('http.fetch', async (_$, event) => {
    const url = event.url
    if (url !== DASH && url !== CHAT) throw new Error('unexpected poll URL: ' + url)
    calls.push(url)
    active[url] += 1
    peak[url] = Math.max(peak[url], active[url])
    try {
      if (hold) await clock.sleep(30_000)
      return { value: { status: 200, ok: true, headers: {}, text: url === DASH ? dashboardText : chatText } }
    } finally {
      active[url] -= 1
    }
  })
  const first = await $.ui.mount({ plugin: 'orch-board', surface: 'desktop', component: 'Pane', requestId: 'orch-board', props: PANE })
  await first.post({ tick: true })
  hold = true
  const pending = first.post({ tick: true })
  await clock.settle()
  expect(active[DASH]).toBe(1)
  expect(active[CHAT]).toBe(1)
  await first.unmount()
  const second = await $.ui.mount({ plugin: 'orch-board', surface: 'desktop', component: 'Pane', requestId: 'orch-board', props: PANE })
  try {
    await clock.settle()
    await second.advance(3_000)
    expect(peak[DASH]).toBe(1)
    expect(peak[CHAT]).toBe(1)
    hold = false
    await clock.advance(30_000)
    await pending
    await clock.settle()
    const before = calls.length
    await second.advance(3_000)
    expect(calls.length).toBe(before + 2)
    expect(await second.find({ type: 'Svg' })).toBeTruthy()
  } finally {
    hold = false
    await clock.advance(30_000)
    await pending
    await second.unmount()
  }
  const closed = calls.length
  await clock.advance(9_000)
  expect(calls.length).toBe(closed)
})

test('a surface without Client draws the waiting line and does not fetch', async ($, on) => {
  const calls: string[] = []
  on('http.fetch', () => {
    calls.push('fetch')
    return { value: { status: 500, ok: false, headers: {}, text: '' } }
  })
  const ui = await $.ui.mount({
    plugin: 'orch-board',
    surface: 'mobile',
    component: 'Pane',
    requestId: 'orch-board',
    props: PANE,
  })
  const line = await ui.find({ type: 'Text' })
  expect(line?.text).toBe('Reading orch...')
  expect(calls.length).toBe(0)
  await ui.unmount()
})

test('a 404 from /api/chat stops that poll and hides chat', async ($, on) => {
  const calls: string[] = []
  on('http.fetch', (_$, event) => {
    calls.push(event.url)
    if (event.url === DASH) return { value: { status: 200, ok: true, headers: {}, text: dashboardText } }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  const ui = await $.ui.mount({
    plugin: 'orch-board',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'orch-board',
    props: PANE,
  })
  await ui.post({ tick: true })
  for (let i = 0; i < 4 && await ui.find({ key: 'secChat-fold' }); i += 1) {
    await ui.post({ tick: true })
  }
  expect(await ui.find({ key: 'secChat-fold' })).toBeUndefined()
  const stopped = calls.filter((url) => url === CHAT).length
  expect(stopped).toBeGreaterThan(0)
  await ui.post({ tick: true })
  await ui.advance(3_000)
  expect(calls.filter((url) => url === CHAT).length).toBe(stopped)
  expect(calls.filter((url) => url === DASH).length).toBeGreaterThan(stopped)
  await ui.unmount()
})

test('the pane draws the web section order and folds SVG images while keeping chat forms native', async ($, on) => {
  mock.store(on, {})
  on('http.fetch', (_$, event) => {
    if (event.url === DASH) return { value: { status: 200, ok: true, headers: {}, text: dashboardText } }
    if (event.url === CHAT) return { value: { status: 200, ok: true, headers: {}, text: chatText } }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  const ui = await $.ui.mount({
    plugin: 'orch-board',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'orch-board',
    props: PANE,
  })
  await ui.post({ tick: true })
  const titles = (await ui.findAll({ type: 'Button' })).filter((button) => String(button.key).endsWith('-fold')).map((button) => button.text)
  expect(titles).toEqual([
    '▼ LEAD', '▶ CHAT · 5 · 4 UNREAD', '▼ SEATS AT WORK', '▼ MACHINES', '▼ FAMILY LOAD · WEEK AND MONTH', '▶ FINISHED · 1',
  ])
  const images = async () => (await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt)
  // rtk and jev are the muted last line of the header band (decision 17592); no footer image.
  expect(await images()).toEqual(['header-image', 'leads-image', 'seats-image', 'machines-image', 'family-image'])
  expect(await ui.find({ type: 'Text', text: '█' })).toBeUndefined()
  expect(await ui.find({ key: 'chatBody' })).toBeUndefined()
  await ui.press({ key: 'secChat-fold' })
  expect((await ui.find({ key: 'secChat-fold' }))?.text).toBe('▼ CHAT · 5 · 4 UNREAD')
  expect(await ui.find({ key: 'chatBody' })).toBeTruthy()
  expect(await images()).toContain('chat-image')
  expect(await images()).not.toContain('finished-image')
  await ui.press({ key: 'finishedBox-fold' })
  expect(await images()).toContain('finished-image')
  await ui.press({ key: 'secLeads-fold' })
  expect((await ui.find({ key: 'secLeads-fold' }))?.text).toBe('▶ LEAD')
  expect(await images()).not.toContain('leads-image')
  await ui.unmount()
})
