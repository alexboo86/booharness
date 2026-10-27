import type { Board } from '../../types'
import { compactCount, drainBanner, formatUsd, headerView } from '../sections/header-format'
import { Layout, esc, image, measure, palette, text, type Image, type Tone } from './kinora'

// Header band (decisions 17588, 17592): status and the working count stand out, alerts are
// pills on a soft tint, version, clock, finished, rtk and jev are muted.
type Pill = { value: string; tone: Tone; fill: Tone; tip?: string }
const META = 11.5, PILL_H = 22, PILL_PAD = 8, PILL_GAP = 6

/** Lay pills left to right, wrapping a whole pill to the next row. */
function pills(l: Layout, items: readonly Pill[]): void {
  if (!items.length) return
  const limit = l.width - 2 * l.pad
  let x = l.pad
  for (const pill of items) {
    const width = Math.min(limit, measure(pill.value, META, false, 600) + 2 * PILL_PAD)
    if (x > l.pad && x + width > l.pad + limit + .5) { x = l.pad; l.y += PILL_H + PILL_GAP }
    const node = `<rect x="${x}" y="${l.y}" width="${width}" height="${PILL_H}" rx="6" fill="${palette[pill.fill]}"/>`
      + text(x + PILL_PAD, l.y + 15, pill.value, pill.tone, META, width - 2 * PILL_PAD, true)
    l.body += pill.tip ? `<g><title>${esc(pill.tip)}</title>${node}</g>` : node
    x += width + PILL_GAP
  }
  l.y += PILL_H + 8
}

export function headerSvg(data: Board | null, width: number, now: number, error: string | null = null): Image {
  const l = new Layout(width, 12)
  l.y = 10
  const view = headerView(data, error, now)
  // Line 1: status dot, name, version and clock.
  const age = data ? now - Date.parse(data.at) : 0
  const meta = error != null ? view.version : data ? 'v' + data.version + ' · ' + new Date(data.at).toLocaleTimeString()
    + (age > 15000 ? ' · board ' + Math.floor(age / 1000) + 's old' : '') : 'loading…'
  const nameX = l.pad + 16
  l.body += `<circle cx="${l.pad + 5}" cy="${l.y + 10}" r="5" fill="${palette[error != null ? 'red' : 'green']}"/>`
    + text(nameX, l.y + 15, 'orch', 'ink', 16, undefined, true)
  const metaX = nameX + measure('orch', 16, false, 600) + 10
  l.body += text(metaX, l.y + 15, meta, error != null ? 'red' : 'muted', META, l.width - l.pad - metaX)
  l.y += 26
  if (data) {
    // Line 2: the working count large, finished muted.
    const working = view.chips.find(c => c.key === 'working')!, finished = view.chips.find(c => c.key === 'finished')!
    l.body += text(l.pad, l.y + 22, working.bold, 'ink', 22, undefined, true, 'big')
    const restX = l.pad + measure(working.bold, 22, false, 700) + 6
    l.body += text(restX, l.y + 22, working.rest.trim(), 'ink', 13)
    const doneX = restX + measure(working.rest.trim(), 13) + 14
    l.body += text(doneX, l.y + 22, finished.bold + finished.rest, 'muted', META, l.width - l.pad - doneX)
    l.y += 34
    // Line 3: alerts.
    const alerts: Pill[] = []
    const drain = drainBanner(data.draining ?? null)
    if (drain) alerts.push({ value: drain.badge, tone: 'ink', fill: 'amberSoft', tip: drain.detail })
    if (data.leads.some(lead => lead.over)) alerts.push({ value: '/next lead past the limit', tone: 'red', fill: 'redSoft' })
    const flagged = view.chips.find(c => c.key === 'flagged')
    if (flagged) alerts.push({ value: flagged.bold + flagged.rest, tone: 'red', fill: 'redSoft' })
    if (data.pausedError) alerts.push({ value: 'pause error: ' + data.pausedError, tone: 'red', fill: 'redSoft' })
    else if (data.paused.length) alerts.push({ value: 'paused: ' + data.paused.map(p => p.split(' ')[0]).join(', '), tone: 'ink', fill: 'amberSoft', tip: data.paused.join('\n') })
    pills(l, alerts)
    // Line 4: rtk, jev and Bright Data, muted.
    const metrics: { value: string; tone: Tone; tip?: string }[] = []
    if (view.rtk && data.rtk) metrics.push({ value: compactCount(data.rtk.commands) + ' calls · ' + compactCount(data.rtk.saved) + ' rtk saved · ' + Math.round(data.rtk.pct) + '%', tone: 'muted', tip: view.rtk.title })
    if (view.jev && data.jev) {
      const j = data.jev, over = j.balance != null && j.remainingUsd != null && j.remainingUsd < 0
      const amount = j.balance ? j.remainingUsd : j.todayUsd
      const label = amount == null ? 'jev balance unknown' : 'jev ' + (over ? 'overspent ≈' + formatUsd(-amount) : j.balance ? '≈' + formatUsd(amount) : formatUsd(amount) + ' today')
      metrics.push({ value: label + view.jev.rest, tone: view.jev.alert ? 'red' : 'muted', tip: view.jev.title })
    }
    if (view.brightdata) metrics.push({ value: view.brightdata.label, tone: 'muted', tip: view.brightdata.title })
    let x = l.pad
    for (const [i, m] of metrics.entries()) {
      const w = measure(m.value, META)
      if (i && x + 14 + w > l.width - l.pad) { x = l.pad; l.y += 18 } else if (i) { l.body += text(x + 4, l.y + 13, '·', 'muted', META); x += 14 }
      const node = text(x, l.y + 13, m.value, m.tone, META, l.width - l.pad - x, m.tone === 'red')
      l.body += m.tip ? `<g><title>${esc(m.tip)}</title>${node}</g>` : node
      x += w
    }
    if (metrics.length) l.y += 20
  }
  l.y += 4
  const band = `<rect x="0" y="0" width="${width}" height="${l.y}" rx="8" fill="${palette.raised}"/>`
  return image(width, l.y, band + l.body, 'orch status')
}
