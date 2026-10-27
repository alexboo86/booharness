import type { Board } from '../../types'
import { finishedMeta, finishedSeats, seatFamily, verdictColor, verdictLabel } from '../sections/seats-format'
import { Layout, palette, measure, text, tone, type Image } from './kinora'
import { familyLine } from './family-label'
import { badges } from './badges'

export function finishedSvg(data: Board, width: number, now: number): Image {
  const l = new Layout(width)
  l.y = 0
  for (const seat of finishedSeats(data.seats)) {
    const top = l.y, before = l.body
    const verdict = verdictLabel(seat.verdict, seat.turnStatus, seat.status)
    const calls = (seat.findings != null ? seat.findings + ' findings · ' : '') + seat.tools + ' calls'
    const wide = width > 640
    const verdictWidth = measure(verdict, 11, false, 700) + 8, callsWidth = measure(calls) + 8
    const remaining = Math.max(100, width - verdictWidth - callsWidth - 36)
    const nameWidth = wide ? remaining * 2 / 5 : width
    const name = new Layout(nameWidth)
    name.y = 8
    name.body += text(2, name.y + 13, seat.title, 'ink', 13, nameWidth - 4, true)
    name.y += 20.85
    familyLine(name, seatFamily(seat.role, seat.family), '', 'muted', 13, 2, nameWidth - 4)
    if (seat.host) name.chips([{ label: seat.host, kind: seat.host === 'mac' ? 'host' : 'remote', tip: 'runs on ' + seat.host }], 2)
    if (seat.captures) name.line(seat.captures, 'secondary', 11.5, 2, nameWidth - 4, false, 'mono')
    name.line(finishedMeta(seat, now), 'muted', 13, 2, nameWidth - 4)
    const result = new Layout(wide ? verdictWidth : width)
    result.y = wide ? 8 : name.y + 4
    result.line(verdict, tone(verdictColor(seat.verdict)), 11, 0, result.width, true, 'verdict')
    const count = new Layout(wide ? callsWidth : width)
    count.y = wide ? 8 : result.y + 4
    count.line(calls, 'muted', 13, 0, count.width)
    const instruments = new Layout(wide ? remaining * 3 / 5 : width)
    instruments.y = wide ? 0 : count.y
    badges(instruments, seat, data.instruments)
    const parts = [
      { layout: name, x: 0 },
      { layout: result, x: wide ? nameWidth + 12 : 2 },
      { layout: count, x: wide ? nameWidth + verdictWidth + 24 : 2 },
      { layout: instruments, x: wide ? nameWidth + verdictWidth + callsWidth + 36 : 0 },
    ]
    for (const part of parts) l.body += `<g transform="translate(${part.x} ${top})">${part.layout.body}</g>`
    l.y += Math.max(...parts.map(p => p.layout.y)) + 8
    l.body += `<path d="M2 ${l.y}H${width - 2}" stroke="${palette.line}"/>`
    l.page(before, top)
  }
  return l.finish('Finished')
}
