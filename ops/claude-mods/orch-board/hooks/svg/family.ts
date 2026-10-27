import type { Board } from '../../types'
import { familyText } from './family-label'
import { familyPresentation } from '../sections/meters-format'
import { INSET, Layout, columnWidth, meter, rows, esc, thresholdTone, type Image } from './kinora'

// Pult row (decision 17558): percent meter on the left, family and its reading lines on the right.
export function familySvg(data: Board, width: number, now: number): Image {
  if (!data.limits.length) {
    const l = new Layout(width)
    l.line('no load readings', 'muted')
    return l.finish('Family load')
  }
  const cellWidth = columnWidth(width, 240)
  const cells = data.limits.map(load => {
    const l = new Layout(cellWidth - 2 * INSET, 0)
    l.y = 10
    const top = l.y
    const view = familyPresentation(load, now)
    l.body += meter(0, top, 50, view.percent, thresholdTone(view.tone), view.label, view.tip)
    const x = 60, available = l.width - x
    l.body += familyText(x, top + 13, { ...view.family, mark: '' }, 'ink', 13, available, true)
    l.y = top + 22
    if (view.resets) {
      const before = l.body
      l.body = ''
      l.line(view.resets, 'muted', 12, x, available, false, load.resets === null ? '' : 'mono')
      l.body = before + `<g><title>${esc(view.resetsTip)}</title>${l.body}</g>`
    }
    if (view.windows) l.line(view.windows, 'muted', 12, x, available)
    for (const warning of view.warnings) l.line(warning, 'red', 12, x, available, true)
    if (view.age) l.line(view.age, 'muted', 12, x, available)
    if (view.stale) l.line(view.stale, 'muted', 12, x, available)
    l.y = Math.max(l.y, top + 30) + 8
    l.frame = null
    return l
  })
  return rows(width, cells, cellWidth, 'Family load · week and month')
}
