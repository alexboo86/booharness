import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import { BASE, createChatForms, INITIAL_CHAT_FORM_STATE } from './chat-api'
import type { ChatFormActions, ChatFormState } from './chat-api'
import { httpError, parseChat, parseDashboard, summaryLine } from './parse'
import { startWakeHold } from './wake'
import type { WakeHold } from './wake'
import { ChatFormsSection } from './sections/chat-forms'
import { chatFoldTitle, unreadCount } from './sections/chat-format'
import { finishedIsHidden, finishedSeats, finishedTitle, sectionOpen } from './sections/seats-format'
import { chatSvg } from './svg/chat'
import { familySvg } from './svg/family'
import { finishedSvg } from './svg/finished'
import { headerSvg } from './svg/header'
import { leadsSvg } from './svg/leads'
import { machinesSvg } from './svg/machines'
import { seatsSvg } from './svg/seats'
import type { Image } from './svg/kinora'
import type { PollSnapshot } from '../types'

const PANE = 'orch-board'
const DASHBOARD = `${BASE}/api/dashboard`
const CHAT = `${BASE}/api/chat`
const FOLD_KEY = 'section-open'

const snapshot = atom({ plugin: 'orch-board', key: 'snapshot' } as const, null)
const chatForm = atom({ plugin: 'orch-board', key: 'chatForm' } as const, null)

const EMPTY: PollSnapshot = { board: null, boardError: null, chat: null, chatError: null, chatStatus: null }

type SectionId = 'secLeads' | 'secChat' | 'secSeats' | 'secMachines' | 'secLimits' | 'finishedBox'

const DEFAULT_FOLDS: Record<SectionId, boolean> = {
  secLeads: true,
  secChat: false,
  secSeats: sectionOpen('seats', undefined),
  secMachines: true,
  secLimits: true,
  finishedBox: sectionOpen('finished', undefined),
}

// One request in flight per route. A tick skips a route whose previous request has not ended.
// A refresh queues one more chat poll. No abort: HttpInit has no signal (plan 17498).
const inflight = { dashboard: false, chat: false }
let chatStopped = false
let chatQueued = false
let chatWritable = false
let foldsCache: Record<SectionId, boolean> | null = null
let forms: ChatFormActions | null = null
let wake: WakeHold | null = null

function resetPoll(): void {
  chatStopped = false
  chatQueued = false
  chatWritable = false
  // Requests outlive a Client unmount. Only their finally blocks release these locks.
  foldsCache = null
  forms = null
}

function noteChat(status: number | null, readOnly: boolean | undefined, error: string | null, loaded: boolean): void {
  chatWritable = status !== 404 && loaded && readOnly !== true && error == null
}

function mergeFolds(raw: unknown): Record<SectionId, boolean> {
  const saved = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const next = { ...DEFAULT_FOLDS }
  for (const id of Object.keys(DEFAULT_FOLDS) as SectionId[]) {
    if (typeof saved[id] === 'boolean') next[id] = saved[id]
  }
  return next
}

async function foldsOf($: EngineInterface): Promise<Record<SectionId, boolean>> {
  if (foldsCache) return foldsCache
  try {
    foldsCache = mergeFolds(await $.store.get(FOLD_KEY))
  } catch {
    foldsCache = { ...DEFAULT_FOLDS }
  }
  return foldsCache
}

function toggleFold($: EngineInterface, id: SectionId): void {
  const current = foldsCache ?? { ...DEFAULT_FOLDS }
  const next = { ...current, [id]: !current[id] }
  foldsCache = next
  void $.store.set(FOLD_KEY, next).then(
    () => { $.ui.invalidate('ui.render') },
    () => { $.ui.invalidate('ui.render') },
  )
}

async function pollRoute($: EngineInterface, route: 'dashboard' | 'chat', url: string, queue = false): Promise<void> {
  if (route === 'chat' && chatStopped) return
  if (inflight[route]) {
    if (route === 'chat' && queue) chatQueued = true
    return
  }
  inflight[route] = true
  try {
    const res = await $.http.fetch(url)
    if (route === 'chat' && res.status === 404) {
      chatStopped = true
      chatWritable = false
      await update($, snapshot, (prev) => ({ ...(prev ?? EMPTY), chat: null, chatError: null, chatStatus: 404 }))
      return
    }
    if (!res.ok) {
      const error = httpError(res.status, res.text)
      if (route === 'chat') noteChat(res.status, undefined, error, false)
      await update($, snapshot, (prev) => ({
        ...(prev ?? EMPTY),
        ...(route === 'dashboard' ? { boardError: error } : { chatError: error, chatStatus: res.status }),
      }))
      return
    }
    if (route === 'dashboard') {
      const parsed = parseDashboard(res.text)
      await update($, snapshot, (prev) => ({
        ...(prev ?? EMPTY),
        board: parsed.ok ? parsed.value : prev?.board ?? null,
        boardError: parsed.ok ? null : parsed.error,
      }))
      return
    }
    const parsed = parseChat(res.text)
    if (parsed.ok) noteChat(200, parsed.value.readOnly, null, true)
    else noteChat(200, undefined, parsed.error, false)
    await update($, snapshot, (prev) => ({
      ...(prev ?? EMPTY),
      chat: parsed.ok ? parsed.value : prev?.chat ?? null,
      chatError: parsed.ok ? null : parsed.error,
      chatStatus: parsed.ok ? 200 : prev?.chatStatus ?? null,
    }))
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 200)
    if (route === 'chat') noteChat(null, undefined, message, false)
    await update($, snapshot, (prev) => ({
      ...(prev ?? EMPTY),
      ...(route === 'dashboard' ? { boardError: message } : { chatError: message }),
    }))
  } finally {
    inflight[route] = false
    if (route === 'chat' && chatQueued && !chatStopped) {
      chatQueued = false
      void pollRoute($, 'chat', url)
    }
  }
}

function refreshChat($: EngineInterface): void {
  void pollRoute($, 'chat', CHAT, true)
}

function pollBoard($: EngineInterface): Promise<void> {
  return Promise.all([pollRoute($, 'dashboard', DASHBOARD), pollRoute($, 'chat', CHAT)]).then(() => undefined)
}

function formsFor($: EngineInterface): ChatFormActions {
  if (forms) return forms
  forms = createChatForms({
    fetch: async (url, init) => {
      const res = await $.http.fetch(url, init)
      return { status: res.status, ok: res.ok, text: res.text }
    },
    getState: async () => (await read($, chatForm)) ?? INITIAL_CHAT_FORM_STATE,
    patchState: async (patch) => { await update($, chatForm, (prev) => ({ ...(prev ?? INITIAL_CHAT_FORM_STATE), ...patch })) },
    canWrite: () => chatWritable,
    refresh: () => { refreshChat($) },
  })
  return forms
}

function titled(
  el: Elements['desktop'],
  id: string,
  title: string,
  open: boolean,
  onToggle: () => void,
  body: JSX.Element | null,
): JSX.Element {
  const { Box, Button } = el
  return (
    <Box key={id} flexDirection="column" gap={1} marginTop={1} width="100%">
      <Button key={id + '-fold'} plain dimColor label={(open ? '▼ ' : '▶ ') + title.toUpperCase()} onPress={onToggle} />
      {open ? body : null}
    </Box>
  )
}

// Pane text a little larger (decision 17589): every image is laid out at width / ZOOM and drawn
// at width, so 13 px text shows at 14 and 11.5 px meta at about 12.4; wrap follows the narrower layout.
const ZOOM = 14 / 13
const inner = (width: number) => Math.floor(width / ZOOM)

/** Draw an image laid out at inner(width), scaled up to width. */
function drawn(el: Elements['desktop'], key: string, image: Image, width: number): JSX.Element {
  const { Box, Svg } = el
  const one = (page: Image, k: string, alt: string) => {
    const w = width, tall = Math.round(page.height * ZOOM)
    const svg = page.svg.replace(/^<svg([^>]*?) width="[^"]*" height="[^"]*"/, `<svg$1 width="${w}" height="${tall}"`)
    return <Svg key={k} source={svg} alt={alt} width={w} height={tall} />
  }
  if (image.pages) return (
    <Box key={key} flexDirection="column" width="100%" alignItems="flex-start">
      {[image, ...image.pages].map((page, i) => one(page, key + '-' + i, key + ' · page ' + (i + 1)))}
    </Box>
  )
  return one(image, key, key)
}

// The operator wants the pane in every session without typing the command (decision 17619).
// With no surface attached (a -p run, the desktop before it attaches) ui.open rejects
// with no-surface, so the pane opens at start or at the first attach, whichever has one.
async function openPaneOnce($: EngineInterface): Promise<void> {
  if ((await $.session.surfaces()).length === 0) return
  if (!(await $.ui.panes()).some(pane => pane.id === PANE)) await $.ui.open({ id: PANE, title: 'orch' })
}

export const register: Register = (on) => {
  on('session.start', async ($, event, next) => {
    await $.command.register({ name: 'orch-board', description: 'Show the orch board in a pane' })
    // Task 2589: the wake hold needs no surface, so it starts before the pane's
    // surface check; its timers run until this module reloads.
    wake = startWakeHold($)
    // A /clear raises no session.start; the pane stays open through it.
    await openPaneOnce($)
    return next(event)
  })

  // The hold polls only while the session is idle (task 2589): a running turn
  // pauses it, its end resumes it.
  on('turn.start', async (_$, _event, next) => {
    wake?.turnStarted()
    return next(_event)
  })

  on('turn.complete', async (_$, _event, next) => {
    wake?.turnEnded()
    return next(_event)
  })

  on('session.attach', async ($, event, next) => {
    const result = await next(event)
    await openPaneOnce($)
    return result
  })

  on('command.run', { command: 'orch-board' }, async ($) => {
    const opened = await $.ui.open({ id: PANE, title: 'orch' })
    return { text: opened.isPlaced ? 'orch pane opened.' : `orch pane not placed: ${JSON.stringify(opened)}` }
  })

  on('ui.message', async ($, event) => {
    if (event.requestId !== PANE || event.element !== 'poll') return {}
    const data = event.data
    if (!data || typeof data !== 'object' || !('tick' in data)) return {}
    if ('reset' in data) resetPoll()
    await pollBoard($)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, event) => {
    const snap = await read($, snapshot)
    const now = Date.now()
    const line = summaryLine(snap, now)
    if (event.surface !== 'desktop') {
      if (event.surface === 'terminal') {
        const { Client } = $.ui.resolve(event)
        return <Client key="poll" module="./poll.tsx" props={{ line }} />
      }
      const { Text } = $.ui.resolve(event)
      return <Text>{line}</Text>
    }
    const el = $.ui.resolve(event)
    const { Box, Client, Link } = el
    // Pane props expose cells, not pixels. Earlier measurements ranged from 7.6 to 7.9 px per column.
    // The 2026-10-17 screenshot has 1421 px cards against a 1478 px band: 1478 / 1421 * 7.6 ≈ 7.9.
    // The desktop app 3.6556.2 (installed 2026-10-24) widened a column: its screenshot has 1353 px
    // cards against a 1519 px band, 1519 / 1353 * 7.9 ≈ 8.87, so 8.9 (an image a little too wide is
    // fitted down by the host; a narrow one leaves a gap). Re-measure after a desktop app update.
    // This is recomputed on every ui.render (including bodyColumns changes), not a poll.
    const width = Math.min(4096, Math.max(200, Math.floor(event.props.bodyColumns * 8.9)))
    const folds = await foldsOf($)
    const board = snap?.board ?? null
    const chatHidden = snap?.chatStatus === 404
    const formState: ChatFormState = (await read($, chatForm)) ?? INITIAL_CHAT_FORM_STATE
    const actions = formsFor($)
    // The band leaves room for its frame and the Tasks link at the right of line 1 (mock 17592).
    // A bordered pill there did not fit and broke the pane's look (operator 2026-10-25); the link's
    // right padding keeps it off the frame (the 15:15Z capture had it touching the border).
    const bandWidth = Math.max(100, width - 90)
    return (
      <Box key="board" flexDirection="column" gap={1} width="100%" alignItems="flex-start" justifyContent="flex-start">
        <Client key="poll" module="./poll.tsx" height={0} props={{ line: '' }} />
        <Box key="header-band" flexDirection="row" alignItems="flex-start" width="100%" gap={1}
          borderStyle="round" borderColor={snap?.boardError ? 'error' : 'promptBorder'}>
          {drawn(el, 'header-image', headerSvg(board, inner(bandWidth), now, snap?.boardError), bandWidth)}
          <Box key="tasks-link" paddingTop={1} paddingRight={2}>
            <Link key="tasks" href="http://localhost:7760/tasks" label="Tasks" />
          </Box>
        </Box>
        {titled(el, 'secLeads', 'Lead', folds.secLeads, () => toggleFold($, 'secLeads'),
          board && folds.secLeads ? drawn(el, 'leads-image', leadsSvg(board, inner(width), now), width) : null)}
        {chatHidden ? null : titled(el, 'secChat', chatFoldTitle(snap?.chat?.posts.length ?? null,
          snap?.chat ? unreadCount(snap.chat.posts, snap.chat.handles.map(h => h.handle)) : null), folds.secChat, () => toggleFold($, 'secChat'),
          <Box key="chat-body" flexDirection="column" gap={1}>
            {folds.secChat ? drawn(el, 'chat-image', chatSvg(snap?.chat ?? null, inner(width), snap?.chatError), width) : null}
            {ChatFormsSection(el, snap?.chat ?? {}, formState, actions)}
          </Box>)}
        {titled(el, 'secSeats', 'Seats at work', folds.secSeats, () => toggleFold($, 'secSeats'),
          board && folds.secSeats ? drawn(el, 'seats-image', seatsSvg(board, inner(width)), width) : null)}
        {titled(el, 'secMachines', 'Machines', folds.secMachines, () => toggleFold($, 'secMachines'),
          board && folds.secMachines ? drawn(el, 'machines-image', machinesSvg(board, inner(width), now), width) : null)}
        {titled(el, 'secLimits', 'Family load · week and month', folds.secLimits, () => toggleFold($, 'secLimits'),
          board && folds.secLimits ? drawn(el, 'family-image', familySvg(board, inner(width), now), width) : null)}
        {board && !finishedIsHidden(finishedSeats(board.seats).length)
          ? titled(el, 'finishedBox', finishedTitle(finishedSeats(board.seats).length), folds.finishedBox, () => toggleFold($, 'finishedBox'),
            folds.finishedBox ? drawn(el, 'finished-image', finishedSvg(board, inner(width), now), width) : null)
          : null}
      </Box>
    )
  })
}
