import type { Board } from '../../types'
import { dur, lineageOf, modelEffort, queuedText, seatFamily, statusColor, stateLabel, worktreeText, workingSeats } from '../sections/seats-format'
import { INSET, Layout, chip, columnWidth, esc, measure, rows, text, tone, type Image } from './kinora'
import { familyLine } from './family-label'
import { badges } from './badges'

// Pult row (decisions 17558, 17561): state and time on the left, title with host, meta lines, badge groups.
export function seatsSvg(data: Board, width: number): Image {
  const seats = workingSeats(data.seats)
  if (!seats.length) {
    const l = new Layout(width)
    l.line('no seat at work', 'muted')
    return l.finish('Seats at work')
  }
  const cellWidth = columnWidth(width, 420)
  const cells = seats.map(seat => {
    const l = new Layout(cellWidth - 2 * INSET, 0)
    l.y = 10
    const top = l.y
    const state = stateLabel(seat.turnStatus, seat.status)
    l.body += chip(0, top + 13, state, tone(statusColor(state)), '', 70, false, 'state').svg
    l.body += text(0, top + 32, dur(seat.seconds), 'muted', 12, 70)
    const x = 80, available = l.width - x
    let hostWidth = 0
    if (seat.host) {
      const kind = seat.host === 'mac' ? 'host' as const : 'remote' as const
      hostWidth = chip(0, 0, seat.host, 'teal', '', available, false, kind).width
      l.body += chip(l.width - hostWidth, top + 13, seat.host, 'teal', 'runs on ' + seat.host, available, false, kind).svg
    }
    l.body += text(x, top + 13, seat.title, 'ink', 13, available - hostWidth - (hostWidth ? 8 : 0), true)
    l.y = top + 22
    familyLine(l, seatFamily(seat.role, seat.family), ' · ' + modelEffort(seat.model, seat.effort), 'secondary', 12, x, available)
    if (queuedText(seat.queued)) l.line(queuedText(seat.queued)!, 'muted', 12, x, available)
    for (const value of [worktreeText(seat.worktree), seat.captures]) if (value) l.line(value, 'secondary', 11.5, x, available, false, 'mono')
    const lineage = lineageOf(seat)
    if (lineage) {
      l.y += 2
      const lineY = l.y
      if (lineage.parentLabel) l.chips([
        { label: lineage.parentLabel, kind: 'used', cls: 'mono', tip: 'the seat that asked for this scout' },
      ], x, 5, 24)
      if (lineage.scoutCount) {
        const count = lineage.scoutCount
        const parentWidth = lineage.parentLabel ? chip(0, 0, lineage.parentLabel, 'teal', '', available, false, 'used', 'mono').width + 5 : 0
        const alongside = parentWidth + measure(count.label) <= available
        const offset = alongside ? parentWidth : 0
        const y = lineage.parentLabel && alongside ? lineY : l.y
        l.body += '<g><title>' + esc(count.tooltip) + '</title>' + text(x + offset, y + 13, count.label, count.live ? tone('claude') : 'muted', 13, available - offset) + '</g>'
        if (!lineage.parentLabel || !alongside) l.y += 24
      }
    }
    l.y = Math.max(l.y, top + 40)
    badges(l, seat, data.instruments)
    if (seat.flags.length) {
      l.y += 8
      const start = l.y, before = l.body
      l.body = ''
      l.y += 6
      for (const flag of seat.flags) { l.line('• ' + flag, 'ink', 13, 10, l.width - 20); l.y += 2 }
      l.y += 6
      l.body = before + `<rect x="0" y="${start}" width="${l.width}" height="${l.y - start}" rx="6" fill="var(--warning-soft)"/>` + l.body
    }
    l.y += 10
    l.frame = null
    return l
  })
  return rows(width, cells, cellWidth, 'Seats at work')
}
