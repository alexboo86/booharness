import { expect, mock, test } from 'claude-code/testing'
import { svgBoard, svgChat } from './fixtures/svg'
import { chatSvg } from '../hooks/svg/chat'
import { familySvg } from '../hooks/svg/family'
import { finishedSvg } from '../hooks/svg/finished'
import { headerSvg } from '../hooks/svg/header'
import { leadsSvg } from '../hooks/svg/leads'
import { machinesSvg } from '../hooks/svg/machines'
import { seatsSvg } from '../hooks/svg/seats'
import { chip, measure, palette, truncate, wrap, boardStyle, Layout } from '../hooks/svg/kinora'
import { badges, badgeHues } from '../hooks/svg/badges'
import type { BadgeGroup, BadgeSource } from '../hooks/sections/leads-format'

const NOW = Date.parse(svgBoard.at) + 20_000
const PANE = { title: 'orch', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 24 }, view: {} }
// Inspect the rendered image's visible text, not developer comments or hidden title metadata.
const visible = (svg: string) => [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map(m => m[1]!.replace(/<title>[\s\S]*?<\/title>/g, '').replace(/<[^>]*>/g, '')).join(' ')

test('asked scouts render once as call-style text with a full escaped tooltip and live styling while any runs', () => {
  for (const status of ['running', 'queued', 'provisioning', 'closed']) {
    const board = { ...svgBoard, seats: [{ ...svgBoard.seats[0]!, active: true, scouts: [
      { id: 'scout-<a>', family: 'codex', status: 'closed' },
      { id: 'scout-b', family: 'grok', status },
    ] }] }
    const out = seatsSvg(board, 1165).svg
    expect((visible(out).match(/asked scout/g) || []).length).toBe(1)
    expect(visible(out)).toContain('asked scout 2')
    expect(out).toContain('<title>scout-&lt;a&gt; · codex · closed\nscout-b · grok · ' + status + '</title>')
    const count = out.match(/<text\b[^>]*>asked scout 2<\/text>/)![0]
    expect(count).toContain('font-size="13"')
    expect(count).toContain('fill="' + (status === 'closed' ? palette.muted : palette.teal) + '"')
  }
})

test('repeated finished family geometry is defined once in each independently renderable image', () => {
  const board = { ...svgBoard, seats: Array.from({ length: 36 }, (_, i) => ({
    ...svgBoard.seats[1]!, id: 'repeat-' + i, family: 'codex', title: 'repeated finished',
  })) }
  const out = finishedSvg(board, 600, NOW)
  const pages = [out, ...(out.pages ?? [])]
  expect(pages.length).toBeGreaterThan(1)
  let occurrences = 0
  for (const page of pages) {
    expect((page.svg.match(/d="M22\.2819/g) || []).length).toBe(1)
    expect((page.svg.match(/<symbol id="fam-codex"/g) || []).length).toBe(1)
    expect(page.svg).toMatch(/<defs><symbol id="fam-codex"[^>]*viewBox="0 0 24 24"[^>]*fill="currentColor"[^>]*>[\s\S]*?<\/symbol><\/defs>/)
    const uses = (page.svg.match(/<use href="#fam-codex"/g) || []).length
    expect(uses).toBeGreaterThan(1)
    expect(uses).toBe((page.svg.match(/>repeated finished<\/text>/g) || []).length)
    occurrences += uses
  }
  expect(occurrences).toBe(36)
})

// Decision 17708: marks centre on the text, not the baseline, without increasing row heights.
for (const surface of ['lead', 'seat', 'finished'] as const) test(surface + ' family mark is centred, larger than text and spaced within its line', () => {
  for (const width of [240, 800, 1165]) {
    const board = { ...svgBoard,
      leads: [{ ...svgBoard.leads[0]!, family: 'claude' as const }],
      seats: [{ ...svgBoard.seats[0]!, family: 'claude', active: surface === 'seat' }],
    }
    const render = (data: typeof board) => surface === 'lead' ? leadsSvg(data, width, NOW)
      : surface === 'seat' ? seatsSvg(data, width) : finishedSvg(data, width, NOW)
    const out = render(board)
    const marks = [...out.svg.matchAll(/<use href="#fam-[^"]+"[^>]*\/>/g)]
    expect(marks.length).toBe(1)
    const mark = marks[0]!
    const lettering = out.svg.slice(mark.index! + mark[0].length).match(/<text\b[^>]*>[\s\S]*?<\/text>/)![0]
    const attr = (node: string, key: string) => Number(node.match(new RegExp('\\b' + key + '="([^"]+)"'))![1])
    const size = attr(lettering, 'font-size')
    const side = attr(mark[0], 'height')
    const textCentre = attr(lettering, 'y') - 0.35 * size
    expect(Math.abs(attr(mark[0], 'y') + side / 2 - textCentre)).toBeLessThanOrEqual(1)
    expect(Math.abs(side / size - 1.4)).toBeLessThanOrEqual(0.05)
    expect(attr(mark[0], 'width')).toBe(side)
    const gap = attr(lettering.match(/<tspan\b[^>]*>/)![0], 'dx') - side
    expect(gap / size).toBeGreaterThanOrEqual(0.5)
    expect(gap / size).toBeLessThanOrEqual(0.65)
    expect(side).toBeLessThanOrEqual(size * 1.45)
    const plain = render({ ...board,
      leads: board.leads.map(lead => ({ ...lead, family: 'other' as never })),
      seats: board.seats.map(seat => ({ ...seat, family: 'other' })),
    })
    expect(out.height).toBe(plain.height)
  }
})

// Decision 17529: independent web-board CSS contract, not values derived from the renderer.
for (const [section, render] of [
  ['header', () => headerSvg(svgBoard, 800, NOW)],
  ['lead', () => leadsSvg(svgBoard, 800, NOW)],
  ['chat', () => chatSvg(svgChat, 800)],
  ['seat', () => seatsSvg(svgBoard, 800)],
  ['machine', () => machinesSvg(svgBoard, 800, NOW)],
  ['family', () => familySvg(svgBoard, 800, NOW)],
  ['finished', () => finishedSvg(svgBoard, 800, NOW)],
] as const) test(section + ' image carries the web-board light/dark palette and consumes its variables', () => {
  const svg = render().svg
  expect(svg).toContain('--bg: #f4f4f2')
  expect(svg).toContain('--raised: #ffffff')
  expect(svg).toContain('--accent: #465e80')
  expect(svg).toContain('@media (prefers-color-scheme: dark)')
  expect(svg).toContain('--bg: #121211')
  expect(svg).toContain('--raised: #1f1f1d')
  expect(svg).toContain('--accent: #aabbd5')
  // The pane draws the page: a page-filled image showed as a grey band narrower than the pane.
  expect(svg).not.toContain('fill="var(--bg)"')
  expect(svg).toContain('fill="var(--ink)"')
})

test('docked pictures use pane width, not the surrounding viewport, and keep intrinsic image height', async ($, on) => {
  const board = { ...svgBoard, seats: [
    { ...svgBoard.seats[0]!, title: 'synthetic active card' },
    ...Array.from({ length: 60 }, (_, i) => ({ ...svgBoard.seats[1]!, id: 'history-' + i, title: 'history card ' + i })),
  ] }
  mock.store(on, {})
  on('http.fetch', (_$, e) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(e.url.endsWith('/api/dashboard') ? board : svgChat) } }))
  for (const columns of [160, 300]) {
    const ui = await $.ui.mount({ plugin: 'orch-board', surface: 'desktop', component: 'Pane', requestId: 'orch-board',
      props: { ...PANE, bodyColumns: 134 }, viewport: { columns, rows: 60 } })
    await ui.post({ tick: true })
    const pictures = await ui.findAll({ type: 'Svg' })
    for (const picture of pictures) {
      // Decision 17589: each image is laid out at width / (14/13) and drawn back at width.
      const width = picture.props.alt === 'header-image' ? 1102 : 1192, inner = Math.floor(width * 13 / 14)
      expect(Math.abs(Number(picture.props.width) - width)).toBeLessThanOrEqual(1)
      expect(picture.props.isInteractive).toBeUndefined()
      expect(picture.props.height).toBe(Number(String(picture.props.source).match(/^<svg[^>]* height="([^"]+)"/)?.[1]))
      expect(String(picture.props.source)).toContain('viewBox="0 0 ' + inner + ' ')
    }
    const seats = pictures.find(p => p.props.alt === 'seats-image')!
    const source = String(seats.props.source)
    expect(visible(source)).toContain('synthetic active card')
    expect(visible(source)).not.toContain('history card')
    // Pult rows carry no page padding: the image ends just under the last badge row.
    // Compare in layout units: the rects sit in the viewBox, the height attribute is scaled by 14/13.
    const height = Number(source.match(/^<svg[^>]* viewBox="0 0 [^ ]+ ([^"]+)"/)?.[1])
    const bottom = Math.max(...[...source.matchAll(/<rect x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)"/g)].map(m => Number(m[1]) + Number(m[2])))
    expect(height - bottom).toBeGreaterThanOrEqual(0)
    expect(height - bottom).toBeLessThanOrEqual(24)
    for (const label of ['plan-before-code', 'rtk 7']) {
      const node = [...source.matchAll(/<text\b[^>]*>[\s\S]*?<\/text>/g)].find(m => visible(m[0]).includes(label))
      expect(node).toBeTruthy()
      expect(node![0]).toContain('font-size="11"')
    }
    await ui.unmount()
  }
})

test('header preserves full web wording and precision, wrapping its fixed-size stats with tooltip details', () => {
  const board = { ...svgBoard, draining: null, leads: [], pausedError: null,
    paused: ['claude paused synthetic reason until 16 Oct', 'codex paused another synthetic reason until 17 Oct'],
    seats: [{ ...svgBoard.seats[0]!, flags: [] },
      ...Array.from({ length: 51 }, (_, i) => ({ ...svgBoard.seats[1]!, id: 'compact-history-' + i }))],
    rtk: { saved: 398_140_000, pct: 69, commands: 226_000, histories: 2 },
    jev: { ...svgBoard.jev!, balance: { usd: 10, at: svgBoard.at }, remainingUsd: 7.76, days: 49.3 } }
  for (const width of [1000, 1165, 1600]) {
    const out = headerSvg(board, width, Date.parse(board.at) + 6000).svg
    const content = visible(out)
    for (const label of ['orch', 'v' + board.version, '1 working', '51 finished',
      '226k calls · 398.14M rtk saved · 69%', 'jev ≈$7.76 · ~49.3 d',
      'paused: ' + board.paused.map(p => p.split(' ')[0]).join(', ')]) expect(content).toContain(label)
    expect(out).toContain('226000 rtk calls')
    expect(out).toContain('estimate from the last 7 days of spend')
    // Header band (decision 17592): the band is the first shape and spans the image.
    expect(out).toMatch(new RegExp(`<style>[\\s\\S]*?</style><rect x="0" y="0" width="${width}" height="\\d+(\\.\\d+)?" rx="8" fill="${palette.raised.replace(/[()]/g, '\\$&')}"/>`))
    for (const node of out.matchAll(/<text x="([^"]+)"[^>]*>(?:<title>[\s\S]*?<\/title>)?([^<]*)<\/text>/g)) {
      expect(Number(node[1])).toBeGreaterThanOrEqual(0)
      expect(Number(node[1]) + measure(node[2]!.replace(/&amp;/g, '&'))).toBeLessThanOrEqual(width + 1)
    }
  }
})

test('paused families are an amber pill with names only, the reasons in its tip, above RTK and Jev', () => {
  const board = { ...svgBoard, draining: null, leads: [], pausedError: null, paused: ['claude paused 1h: operator pause'] }
  const out = headerSvg(board, 1165, NOW).svg
  expect(visible(out)).toContain('paused: claude')
  expect(visible(out)).not.toContain('operator pause')
  expect(out).toContain('<title>claude paused 1h: operator pause</title>')
  expect(out).toContain(`fill="${palette.amberSoft}"`)
  expect(visible(out).indexOf('paused:')).toBeLessThan(visible(out).indexOf('rtk saved'))
})

test('a lead past the limit is a red pill; no alert draws no pill row', () => {
  const over = { ...svgBoard, draining: null, paused: [], pausedError: null, seats: svgBoard.seats.map(s => ({ ...s, flags: [] })),
    leads: [{ ...svgBoard.leads[0]!, over: true }] }
  const alert = headerSvg(over, 1165, NOW).svg
  expect(visible(alert)).toContain('/next lead past the limit')
  expect(alert).toContain(`fill="${palette.redSoft}"`)
  const calm = headerSvg({ ...over, leads: [] }, 1165, NOW).svg
  expect(calm).not.toContain(palette.redSoft)
  expect(calm).not.toContain(palette.amberSoft)
})

test('machine bars and family meters use the web good, warning, serious and critical thresholds', () => {
  for (const [percent, color] of [[20, palette.green], [65, palette.amber], [85, palette.purple], [95, palette.red]] as const) {
    const machine = { ...svgBoard.machines[0]!, disk: null, load: { ok: true as const, load: { cpuBusyPct: percent, cpus: 2, totalMemGb: 100, freeMemGb: 100 - percent } } }
    const machineImage = machinesSvg({ ...svgBoard, machines: [machine] }, 1165, NOW).svg
    expect(machineImage).toContain(`rx="4" fill="${color}"`)
    const budget = { window: 'week', used: percent, resetsAt: null }
    const familyImage = familySvg({ ...svgBoard, limits: [{ ...svgBoard.limits[0]!, budget, readings: [budget] }] }, 1165, NOW).svg
    expect(familyImage).toContain(`rx="1.5" fill="${color}"`)
  }
})

test('header matches web finished, flagged and RTK visibility and million precision', () => {
  for (const flags of [[], ['active flag']]) {
    for (const saved of [null, -1, 0, 1, 398_140_000]) {
      const board = { ...svgBoard, draining: null, leads: [], paused: [], pausedError: null,
        seats: [{ ...svgBoard.seats[0]!, flags }, { ...svgBoard.seats[1]!, flags: ['historical flag'] }],
        rtk: saved === null ? null : { saved, pct: 69, commands: 226_000, histories: 2 } }
      const content = visible(headerSvg(board, 1165, NOW).svg)
      expect(content).toContain('1 working')
      expect(content).toContain('1 finished')
      expect(content).not.toContain(' done')
      if (flags.length) expect(content).toContain('1 flagged')
      else expect(content).not.toContain('flagged')
      if (saved === null || saved <= 0) expect(content).not.toContain('rtk')
      else expect(content).toContain(saved === 1 ? '1 rtk saved · 69%' : '398.14M rtk saved · 69%')
    }
  }
})

test('header omits zero flagged and keeps web Jev precision and full paused reasons', () => {
  for (const balance of [null, { usd: 10, at: svgBoard.at }]) {
    const board = { ...svgBoard, draining: null, paused: [], pausedError: null,
      leads: [], seats: svgBoard.seats.map(s => ({ ...s, flags: [] })),
      jev: { ...svgBoard.jev!, balance, remainingUsd: 7.773743204, todayUsd: 7.773743204 } }
    const out = headerSvg(board, 1165, NOW).svg
    const content = visible(out)
    for (const label of ['v' + board.version, '20s', '1 working', '1 finished', 'rtk', '$7.773743204']) expect(content).toContain(label)
    expect(content).not.toContain('flagged')
    for (const until of ['16 Oct', '16 October', '2026-10-16']) {
      const paused = headerSvg({ ...board, paused: ['claude paused 2h: quota exhausted until ' + until + '; do not retry'] }, 1165, NOW)
      expect(paused.svg).toContain('<title>claude paused 2h: quota exhausted until ' + until + '; do not retry</title>')
    }
  }
})

test('lead cards retain the web two-component worktree title and session row', () => {
  const session = 'b72c4a05-3081-45bf-87ab-abcdf1234567'
  for (const cwd of ['/repo/worktrees/context-polish-ffb72f', 'C:\\repo\\context-polish-ffb72f\\', null]) {
    const out = leadsSvg({ ...svgBoard, leads: [{ ...svgBoard.leads[0]!, session, cwd }] }, 1165, NOW).svg
    expect(visible(out).replace(/\s/g, '')).toContain(session)
    if (cwd) {
      expect(out).toContain('context-polish-ffb72f')
      expect(out).toContain('font-size="11.5" class="mono"')
    }
  }
})

test('all seven picture builders use web typography roles across states and widths', () => {
  const empty = { ...svgBoard, seats: [], leads: [], machines: [], limits: [] }
  for (const width of [240, 600, 1165]) {
    for (const board of [svgBoard, empty]) {
      const outputs = [headerSvg(board, width, NOW), headerSvg(null, width, NOW, 'offline'),
        leadsSvg(board, width, NOW), seatsSvg(board, width), machinesSvg(board, width, NOW),
        familySvg(board, width, NOW), finishedSvg(board, width, NOW),
        chatSvg(svgChat, width), chatSvg(null, width, 'offline')]
      for (const out of outputs) for (const page of [out, ...(out.pages ?? [])]) {
        for (const node of page.svg.matchAll(/<text\b[^>]*>/g)) {
          const size = node[0].match(/font-size="([^"]+)"/)?.[1]
          expect(size).toBeTruthy()
          expect([10, 11, 11.5, 12, 13, 16, 18, 22]).toContain(Number(size))
        }
      }
    }
  }
})

test('lead web thresholds color only the meter bar and show the critical next banner', () => {
  for (const [percent, color] of [[40, palette.green], [70, palette.amber], [85, palette.purple], [100, palette.red]] as const) {
    const out = leadsSvg({ ...svgBoard, leads: [{ ...svgBoard.leads[0]!, percent, over: percent >= 100 }] }, 1165, NOW).svg
    expect(out).toContain(`rx="1.5" fill="${color}"`)
    const number = [...out.matchAll(/<text\b[^>]*>[\s\S]*?<\/text>/g)].map(m => m[0]).find(s => s.includes(percent + '%'))
    expect(number).toContain(`fill="${palette.ink}"`)
    if (percent >= 100) expect(out).toContain('rx="6" fill="var(--critical)"')
  }
})

test('working rows carry no tool-call line (the badges count tools); finished rows keep web wording; both keep full capture paths', () => {
  for (const count of [0, 1, 2]) for (const captures of ['/private/captures/pane.png', 'C:\\captures\\pane.png', '/private/captures/pane.png/']) {
    const board = { ...svgBoard, seats: svgBoard.seats.map(s => ({ ...s, tools: count, kinds: { ...s.kinds, shell: 5 }, captures })) }
    for (const [out, wording] of [[seatsSvg(board, 1165), null], [finishedSvg(board, 1165, NOW), count + ' calls']] as const) {
      const content = visible(out.svg)
      if (wording) expect(content).toContain(wording)
      else for (const gone of ['tool calls', '5 shell']) expect(content).not.toContain(gone)
      expect(content).toContain('pane.png')
      expect(content).toContain(captures)
    }
  }
})

test('every web board display element reaches the desktop images and inline native header; forms remain native', async ($, on) => {
  mock.store(on, { 'section-open': { secLeads: true, secChat: true, secSeats: true, secMachines: true, secLimits: true, finishedBox: true } })
  on('http.fetch', (_$, e) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(e.url.endsWith('/api/dashboard') ? svgBoard : svgChat) } }))
  const ui = await $.ui.mount({ plugin: 'orch-board', surface: 'desktop', component: 'Pane', requestId: 'orch-board', props: PANE, viewport: { columns: 100, rows: 60 } })
  await ui.post({ tick: true })
  const sections = [
    ['header-image', ['orch', 'working', 'finished', 'flagged', '/next lead past the limit', 'DRAIN · 1', 'pause error: pause failed', '1k rtk saved', '$8']],
    ['leads-image', ['Codex', 'Claude', 'terminal', '100%', '100 / 100', 'window 10', 'active ', 'codegraph 2', 'Context past the limit: finish the step, write the handoff, run /next']],
    ['chat-image', ['Live handles: alpha, beta', '1 watching', '2 earlier posts', 'alpha', 'beta:', 'sample pending', 'beta · pending', 'beta · no watcher', '⚑', 'all:', 'operator', 'plain log &lt;tag&gt; &amp; &quot;quotes&quot;', 'second line']],
    ['seats-image', ['coder · alpha', 'mac', 'running', '+2 queued', 'working sample', 'for parent-sample', 'asked scout 1', 'sample-model · effort low', '5s', '3 files · +12 -2', 'capture-sample', 'SKILLS', 'plan-before-code', 'impeccable', 'no jev', 'knowledge 1', 'lessons 2 full 1 on demand', 'TOOLS', 'rtk 7 2 missed 1 pending', 'shell 3', 'read 2', 'MCP', 'codegraph 4', 'memoryctl 3', 'sample-server 2', 'PI', 'orch-guard', 'codex-edit 2', 'stand-arm', 'sample flag']],
    ['machines-image', ['mac', 'this Mac', '1 active seat', 'CPU', '10% · 2 cpus', 'MEM', '50% · 4.0 of 8.0 GB', 'DISK', '60% · 40.0 GB free', 'read ', 'unreachable: down', 'probing…', 'disk unreadable: denied']],
    ['family-image', ['alpha', '80%', 'budget week 80%', 'reset ', 'month 42%', 'beta', '?', 'unreadable', 'quota ran out', 'provider outage · back off 20 min', 'auth failure · ranked last 60 min', 'read 9 min ago', 'last good reading']],
    ['finished-image', ['finished sample', 'reviewer · beta', 'remote', 'APPROVE', '2 findings · 1 calls', 'finished-capture', 'for parent-finished', 'scouts kimi', 'sample-model', 'low', 'lessons 0', 'rtk 1']],
  ] as const
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(sections.length)
  for (const [key, labels] of sections) {
    const svg = (await ui.findAll({ type: 'Svg' })).find(s => s.props.alt === key)
    expect(svg).toBeTruthy()
    expect(svg!.props.width).toBe(key === 'header-image' ? 622 : 712)
    expect(svg!.props.height).toBe(Number(String(svg!.props.source).match(/^<svg[^>]* height="([^"]+)"/)?.[1]))
    expect(Number(String(svg!.props.source).match(/^<svg[^>]* height="([^"]+)"/)?.[1])).toBeGreaterThan(0)
    expect(svg!.props.isInteractive).toBeUndefined()
    const source = String(svg!.props.source)
    expect(source).toContain('preserveAspectRatio="xMinYMin meet"')
    expect(source.length).toBeLessThanOrEqual(131072)
    for (const label of labels) expect(visible(source)).toContain(label)
    if (key === 'header-image') {
      expect(source).toContain('3 rtk calls')
      expect(source).toContain('2 queued')
      expect(source).toContain('seat-a/turn-1')
    }
  }
  expect(await ui.find({ key: 'chatBody' })).toBeTruthy()
  expect(await ui.find({ key: 'chatReleaseHandle' })).toBeTruthy()
  // Task 2985: the Tasks link keeps its destination and its capitalised label.
  const tasks = await ui.find({ type: 'Link', text: 'Tasks' })
  expect(tasks?.props).toMatchObject({ label: 'Tasks', href: 'http://localhost:7760/tasks' })
  // Header band (decision 17592): a framed row holding the header image and, at the right of
  // line 1, the plain Tasks link with no chrome of its own (the bordered pill did not fit).
  const header = await ui.find({ key: 'header-band' })
  expect(header?.props.flexDirection).toBe('row')
  expect(header?.props.borderStyle).toBe('round')
  expect(header?.props.alignItems).toBe('flex-start')
  const link = await ui.find({ key: 'tasks-link' })
  expect(link?.props.borderStyle).toBeUndefined()
  expect(link?.props.paddingTop).toBe(1)
  expect(link?.props.paddingRight).toBe(2)
  expect(link?.children).toEqual([
    expect.objectContaining({
      type: 'Link',
      props: expect.objectContaining({ label: 'Tasks', href: 'http://localhost:7760/tasks' }),
    }),
  ])
  await ui.unmount()
})

test('pure builders retain empty, failed, stale, reset, and unknown states without inventing zeros', () => {
  const empty = { ...svgBoard, leads: [], seats: [], machines: [], limits: [], paused: [], pausedError: null }
  for (const [out, label] of [
    [leadsSvg(empty, 600, NOW), 'no lead active in the last 10 minutes'],
    [seatsSvg(empty, 600), 'no seat at work'],
    [machinesSvg(empty, 600, NOW), 'no machines'],
    [familySvg(empty, 600, NOW), 'no load readings'],
    [chatSvg({ ...svgChat, posts: [], handles: [], watchers: 0 }, 600), 'no posts'],
  ] as const) expect(visible(out.svg)).toContain(label)
  expect(visible(headerSvg(null, 600, NOW).svg)).toContain('loading…')
  expect(visible(headerSvg(null, 600, NOW, 'down').svg)).toContain('daemon unreachable: down')
  expect(visible(headerSvg(empty, 600, NOW).svg)).toContain('20s')
  expect(visible(chatSvg(svgChat, 600, 'down').svg)).toContain('Chat unavailable: down')
  expect(visible(familySvg(svgBoard, 600, Date.parse('2026-02-02T00:00:00Z')).svg)).toContain('reset passed, reading stale')
  expect(visible(headerSvg({ ...empty, paused: ['alpha paused sample'] }, 600, NOW).svg)).toContain('paused: alpha')
  expect(visible(finishedSvg(empty, 600, NOW).svg)).toBe('')
})

test('measured wrapping and truncation keep long and Unicode text within the allocated width', () => {
  expect(measure('WWW')).toBeGreaterThan(measure('iii'))
  const input = 'wide WWW words 😀 中文 & <tag>\n' + 'unbroken'.repeat(100)
  for (const width of [160, 400, 900]) {
    const short = truncate(input, width)
    expect(measure(short)).toBeLessThanOrEqual(width)
    const lines = wrap(input, width)
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(width)
    expect(lines.join('').replace(/\s/g, '')).toBe(input.replace(/\s/g, ''))
    const chat = chatSvg({ ...svgChat, posts: [{ ...svgChat.posts[0]!, body: input }] }, width + 40)
    expect(chat.height).toBeGreaterThan(100)
    expect(chat.svg).not.toContain('NaN')
  }
})

test('chat shows only the last four posts, with earlier count and whole-feed fold counts', async ($, on) => {
  const posts = Array.from({ length: 6 }, (_, i) => ({
    ...svgChat.posts[0]!, id: i + 1, body: 'body-' + (i + 1),
    delivered: [], confirmed: i < 2 ? [] : ['beta'], receipts: [],
  }))
  mock.store(on, { 'section-open': { secChat: true } })
  on('http.fetch', (_$, e) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(e.url.endsWith('/api/dashboard') ? svgBoard : { ...svgChat, posts }) } }))
  const ui = await $.ui.mount({ plugin: 'orch-board', surface: 'desktop', component: 'Pane', requestId: 'orch-board', props: PANE, viewport: { columns: 100, rows: 60 } })
  await ui.post({ tick: true })
  const picture = (await ui.findAll({ type: 'Svg' })).find(p => p.props.alt === 'chat-image')!
  const source = String(picture.props.source), content = visible(source)
  expect(content.match(/body-\d/g)).toEqual(['body-3', 'body-4', 'body-5', 'body-6'])
  expect(source).not.toContain('body-1')
  expect(source).not.toContain('body-2')
  expect(content.split('2 earlier posts').length - 1).toBe(1)
  expect(content.indexOf('2 earlier posts')).toBeLessThan(content.indexOf('body-3'))
  expect(source).toContain(`fill="${palette.muted}" font-size="13">2 earlier posts</text>`)
  expect((await ui.find({ key: 'secChat-fold' }))?.props.label).toBe('▼ CHAT · 6 · 2 UNREAD')
  await ui.unmount()
})

test('receipt-rich recent posts are paged with a frame below the SDK image ceiling without dropping their receipts', async ($, on) => {
  const handles = Array.from({ length: 100 }, (_, i) => ({ ...svgChat.handles[0]!, handle: 'recipient-' + i }))
  const posts = Array.from({ length: 50 }, (_, i) => ({
    ...svgChat.posts[0]!, id: i, body: 'post-' + i + ' ' + 'message '.repeat(70),
    to: 'all' as const, delivered: [], confirmed: [], receipts: [],
  }))
  mock.store(on, { 'section-open': { secChat: true } })
  on('http.fetch', (_$, e) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(e.url.endsWith('/api/dashboard') ? svgBoard : { handles, posts, watchers: handles.length }) } }))
  const ui = await $.ui.mount({ plugin: 'orch-board', surface: 'desktop', component: 'Pane', requestId: 'orch-board', props: PANE, viewport: { columns: 100, rows: 60 } })
  await ui.post({ tick: true })
  const pages = (await ui.findAll({ type: 'Svg' })).filter(p => String(p.props.alt).startsWith('chat-image'))
  expect(pages.length).toBeGreaterThan(1)
  for (const page of pages) {
    const source = String(page.props.source)
    expect(source.length).toBeLessThanOrEqual(131072)
    expect(Number(source.match(/^<svg[^>]* height="([^"]+)"/)?.[1])).toBeLessThanOrEqual(4096)
    const view = source.match(/viewBox="0 ([\d.]+) ([\d.]+) ([\d.]+)"/)!
    expect(source).toContain(`<rect x="0" y="${view[1]}" width="${view[2]}" height="${view[3]}" rx="12" fill="${palette.raised}" stroke="${palette.line}" class="card"/>`)
  }
  const content = pages.map(p => visible(String(p.props.source))).join(' ')
  expect(content.match(/post-\d+/g)).toEqual(['post-46', 'post-47', 'post-48', 'post-49'])
  expect(content).toContain('46 earlier posts')
  for (const handle of handles) {
    expect(content.split(handle.handle + ' · pending').length - 1).toBe(4)
  }
  await ui.unmount()
})

test('Pult rows reflow at narrow, 800 and 1600 pixels sharing row width without resizing meters, gauges or typography', () => {
  const board = { ...svgBoard,
    leads: Array.from({ length: 5 }, () => svgBoard.leads[0]!),
    seats: Array.from({ length: 5 }, () => svgBoard.seats[0]!),
    machines: Array.from({ length: 5 }, () => svgBoard.machines[0]!),
    limits: Array.from({ length: 11 }, () => svgBoard.limits[0]!),
  }
  // Minimum card widths 420 (lead, seat), 360 (machine) and 240 (family) with the web 10 px gap;
  // content sits 12 px inside each card frame.
  const expected = new Map<unknown, readonly number[]>([[leadsSvg, [1, 1, 3]], [seatsSvg, [1, 1, 3]], [machinesSvg, [1, 2, 4]], [familySvg, [1, 3, 6]]])
  for (const builder of [leadsSvg, seatsSvg, machinesSvg, familySvg]) {
    let sizes: string[] | undefined, meters: string[] | undefined
    for (const [index, width] of [350, 800, 1600].entries()) {
      const out = builder(board, width, NOW)
      const columns = expected.get(builder)![index]!, family = builder === familySvg
      const cells = Array.from(out.svg.matchAll(/<g transform="translate\(([\d.]+) ([\d.]+)\)">/g))
      expect(cells.length).toBe(family ? 11 : 5)
      const cellWidth = (width - (columns - 1) * 10) / columns
      expect(cells.filter(c => c[2] === '0').map(c => Number(c[1]))).toEqual(
        Array.from({ length: columns }, (_, i) => i * (cellWidth + 10) + 12))
      expect(Number(cells[columns]![1])).toBe(12)
      const cards = Array.from(out.svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" rx="12"/g))
      expect(cards.length).toBe(family ? 11 : 5)
      for (const card of cards) expect(Number(card[2])).toBe(cellWidth - 2)
      expect(Number(cells[columns]![2])).toBeGreaterThan(0)
      const fonts = [...new Set(Array.from(out.svg.matchAll(/font-size="([^"]+)"/g)).map(m => m[1]!))].sort()
      const bars = Array.from(out.svg.matchAll(/width="([^"]+)" height="3" rx="1.5" fill="var\(--track\)"/g)).map(m => m[1]!)
      if (sizes) { expect(fonts).toEqual(sizes); expect(bars).toEqual(meters) }
      sizes = fonts; meters = bars
      if (builder === machinesSvg) {
        const tracks = Array.from(out.svg.matchAll(/<rect[^>]* width="([^"]+)" height="8" rx="4" fill="([^"]+)"/g)).filter(m => m[2] === palette.track)
        expect(tracks.length).toBeGreaterThan(0)
        for (const track of tracks) expect(track[1]).toBe('120')
      }
    }
  }
})

test('changing pane bodyColumns redraws the grid without waiting for a poll', async ($, on) => {
  const board = { ...svgBoard, machines: Array.from({ length: 5 }, () => svgBoard.machines[0]!) }
  let fetches = 0
  mock.store(on, {})
  on('http.fetch', (_$, e) => {
    fetches++
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(e.url.endsWith('/api/dashboard') ? board : svgChat) } }
  })
  const ui = await $.ui.mount({ plugin: 'orch-board', surface: 'desktop', component: 'Pane', requestId: 'orch-board',
    props: { ...PANE, bodyColumns: 50 }, viewport: { columns: 250, rows: 60 } })
  await ui.post({ tick: true })
  const before = fetches
  for (const [bodyColumns, columns] of [[50, 1], [115, 2], [229, 5]] as const) {
    await ui.redraw({ ...PANE, bodyColumns })
    const picture = (await ui.findAll({ type: 'Svg' })).find(p => p.props.alt === 'machines-image')!
    // 2026-10-24 screenshot correction (desktop app 3.6556.2): 1353 px cards versus a 1519 px band;
    // 1519 / 1353 * 7.9 ≈ 8.87, so 8.9 px per body column, not a numeric Box width.
    expect(picture.props.width).toBe(Math.floor(bodyColumns! * 8.9))
    const row = Array.from(String(picture.props.source).matchAll(/<g transform="translate\(([\d.]+) 0\)">/g))
    expect(row.length).toBe(columns)
    expect(fetches).toBe(before)
  }
  await ui.unmount()
})

test('a minimum-width machine row keeps gauge labels and values inside the pane edge', () => {
  // Pult rows run edge to edge: the pane's own padding is the only margin.
  const out = machinesSvg({ ...svgBoard, machines: [svgBoard.machines[0]!] }, 200, NOW).svg
  for (const node of out.matchAll(/<text\b[^>]* x="([^"]+)"/g)) {
    expect(Number(node[1])).toBeGreaterThanOrEqual(0)
    expect(Number(node[1])).toBeLessThanOrEqual(200)
  }
  for (const bar of out.matchAll(/<rect x="([^"]+)"[^>]* width="([^"]+)" height="8"/g)) {
    expect(Number(bar[1]) + Number(bar[2])).toBeLessThanOrEqual(200)
  }
  expect(visible(out)).toContain('10% · 2 cpus')
  expect(visible(out)).toContain('40.0 GB free')
})

test('Pult cards of one row stretch to the tallest card, and the next row starts a 10 px gap under it', () => {
  // The lead past the limit carries the red banner, so it is taller than its neighbour.
  const calm = { ...svgBoard.leads[0]!, percent: 50, over: false }, over = { ...svgBoard.leads[0]!, percent: 110, over: true }
  const tallest = leadsSvg({ ...svgBoard, leads: [over] }, 900, NOW).height
  expect(tallest).toBeGreaterThan(leadsSvg({ ...svgBoard, leads: [calm] }, 900, NOW).height)
  const out = leadsSvg({ ...svgBoard, leads: [calm, over, calm] }, 900, NOW).svg
  const tops = Array.from(out.matchAll(/<g transform="translate\(([\d.]+) ([\d.]+)\)">/g)).map(m => Number(m[2]))
  expect(tops).toEqual([0, 0, tallest + 10])
  const frames = Array.from(out.matchAll(/<rect x="[\d.]+" y="1" width="[\d.]+" height="([\d.]+)" rx="12"[^>]* stroke="([^"]+)"/g))
  expect(frames.map(m => Number(m[1]))).toEqual([tallest - 2, tallest - 2])
  // Only the lead past the limit gets the red frame.
  expect(frames.map(m => m[2])).toEqual([palette.line, palette.red])
})

test('bold chip text and bold counts are measured at the weight they draw in', () => {
  // Measured at the regular weight, the semibold label and its 700 counts overflowed the pill.
  const plain = chip(0, 20, 'request_user_input_async', 'badge', '', Infinity, false, 'used', '', [2])
  expect(plain.width).toBeGreaterThanOrEqual(measure('request_user_input_async', 11) + measure(' 2', 11, false, 700) + 16)
  const bold = chip(0, 20, 'Developer', 'teal')
  expect(bold.width).toBeGreaterThan(measure('Developer', 11) + 16)
  expect(bold.width).toBe(measure('Developer', 11, false, 600) + 16)
})

test('badge labels and counts preserve literal replacement tokens without stray text close tags', () => {
  const out = chip(0, 20, '$& $$ $\'', 'badge', '', Infinity, false, 'used', '', ['$&'])
  expect(visible(out.svg)).toBe('$&amp; $$ $&apos; $&amp;')
  expect(out.svg.match(/<\/text>/g)?.length).toBe(1)
})

// One pill per badge: its rect fill and text fill, with the label the pill shows.
const pills = (body: string) => [...body.matchAll(/<g><title>[\s\S]*?<\/title><rect[^>]*\bfill="([^"]+)"[^>]*\/><text\b[^>]*\bfill="([^"]+)"[^>]*>([\s\S]*?)<\/text><\/g>/g)]
  .map(m => ({ fill: m[1]!, ink: m[2]!, label: m[3]!.replace(/<[^>]*>/g, '') }))

test('each badge row draws only its own hue set, one stable hue per name; missing stays red and unused muted', () => {
  const source: BadgeSource = {
    kinds: { rtk: 7, codegraph: 4, memoryctl: 3, 'mcp:sample-server': 2, knowledge: 1, 'skill:impeccable': 1, 'tool:read': 2, edit: 2 },
    skills: { required: ['plan-before-code'], listed: ['impeccable', 'surgical-patch'], router: { skills: 'map', lessons: 'ok', skillReason: 'sample' } },
    extensions: ['codex-edit', 'stand-arm'],
  }
  const rowOf: Record<string, BadgeGroup['label']> = {
    'no jev': 'skills', 'plan-before-code': 'skills', impeccable: 'skills', 'surgical-patch': 'skills', knowledge: 'skills',
    rtk: 'tools', read: 'tools', codegraph: 'mcp', memoryctl: 'mcp', 'sample-server': 'mcp', 'codex-edit': 'pi', 'stand-arm': 'pi',
  }
  const draw = () => { const l = new Layout(420); badges(l, source, ['rtk', 'codegraph', 'memoryctl']); return l.body }
  const drawn = pills(draw())
  const sets = Object.values(badgeHues).map(hues => hues.map(hue => [palette[hue.soft], palette[hue.ink]] as const))
  // The four rows carry disjoint colour sets.
  for (const [i, set] of sets.entries()) for (const [j, other] of sets.entries()) if (i < j) {
    expect(set.filter(([soft, ink]) => other.some(([s, k]) => s === soft || k === ink))).toEqual([])
  }
  const huesPerRow = new Map<BadgeGroup['label'], Set<string>>()
  const pillOf = (name: string) => drawn.find(p => p.label === name || p.label.startsWith(name + ' '))
  for (const [name, row] of Object.entries(rowOf)) {
    const pill = pillOf(name)
    expect(pill).toBeTruthy()
    if (name === 'no jev') {
      expect(pill!.fill).toBe(palette.redSoft)
      expect(pill!.ink).toBe(palette.red)
    } else if (name === 'surgical-patch') {
      expect(pill!.fill).toBe('none')
      expect(pill!.ink).toBe(palette.badgeMuted)
    } else {
      expect(sets[{ skills: 0, tools: 1, mcp: 2, pi: 3 }[row]!]).toContainEqual([pill!.fill, pill!.ink])
      const seen = huesPerRow.get(row) ?? new Set<string>(); seen.add(pill!.fill); huesPerRow.set(row, seen)
    }
  }
  // The name hash spreads: every row shows more than one of its hues.
  for (const row of ['skills', 'tools', 'mcp', 'pi'] as const) expect(huesPerRow.get(row)!.size).toBeGreaterThan(1)
  // Stability at the rendered boundary: the same name keeps its hue on lead and seat cards.
  const hueIn = (svg: string, name: string) => pills(svg).find(p => p.label === name || p.label.startsWith(name + ' '))?.fill
  expect(hueIn(seatsSvg(svgBoard, 1165).svg, 'codegraph')).toBe(hueIn(leadsSvg(svgBoard, 1165, NOW).svg, 'codegraph'))
})

test('badge hue inks keep at least 4.5:1 contrast on their soft fills in both themes', () => {
  const channel = (hex: string) => [...hex.slice(1).matchAll(/../g)].map(m => parseInt(m[0], 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const ratio = (soft: string, ink: string) => {
    const lums = [channel(soft), channel(ink)].map(rgb => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!).sort((a, b) => b - a)
    return (lums[0]! + 0.05) / (lums[1]! + 0.05)
  }
  const themes = boardStyle.split('@media (prefers-color-scheme: dark)').slice(0, 2)
    .map(block => new Map([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map(m => [m[1]!, m[2]!])))
  for (const hues of Object.values(badgeHues)) for (const hue of hues) for (const theme of themes) {
    const soft = theme.get(palette[hue.soft].slice(6, -1))!, ink = theme.get(palette[hue.ink].slice(6, -1))!
    expect(soft).toBeTruthy()
    expect(ratio(soft, ink)).toBeGreaterThanOrEqual(4.5)
  }
})
