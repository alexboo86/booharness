import type { Board } from '../../types'
import { tokenCount, leadTone, leadAge, leadFamily } from '../sections/leads-format'
import { badges } from './badges'
import { INSET, Layout, columnWidth, measure, meter, rows, text, thresholdTone, type Image } from './kinora'
import { familyText } from './family-label'

// Pult row (decisions 17558, 17561): percent meter on the left, title with tokens, one meta line, badge groups.
export function leadsSvg(data: Board, width: number, now: number): Image {
  if (!data.leads.length) {
    const l = new Layout(width)
    l.line('no lead active in the last 10 minutes', 'muted')
    return l.finish('Lead')
  }
  const cellWidth = columnWidth(width, 420)
  const cells = data.leads.map(lead => {
    const l = new Layout(cellWidth - 2 * INSET, 0)
    l.y = 10
    const top = l.y
    const tip = tokenCount(lead.tokens) + ' of the ' + tokenCount(lead.limit) + ' /next limit'
    l.body += meter(0, top, 50, lead.percent, thresholdTone(leadTone(lead.percent)), lead.percent + '%', tip)
    const x = 60, available = l.width - x
    const label = leadFamily(lead.family)
    const tokens = tokenCount(lead.tokens) + ' / ' + tokenCount(lead.limit)
    const tokensWidth = measure(tokens, 13, false, 600)
    const worktree = (lead.cwd || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/') || lead.session
    // The family draws plain, the seat way (familyText), not in a chip.
    l.body += familyText(x, top + 13, label, 'ink', 13, available, true)
    // familyText truncates the name to `available`; the worktree starts after the drawn width, not the full name.
    const familyWidth = Math.min(available, measure(label.prefix + label.name, 13, false, 600) + (label.mark ? 26 : 0))
    l.body += text(x + familyWidth + 8, top + 13, worktree, 'ink', 13, available - familyWidth - tokensWidth - 20, true)
    l.body += text(l.width - tokensWidth, top + 13, tokens, 'ink', 13, undefined, true)
    l.y = top + 22
    l.line([lead.model, lead.window ? 'window ' + tokenCount(lead.window) : '', 'active ' + leadAge(lead.updated, now)].filter(Boolean).join(' · '), 'muted', 12, x, available)
    l.line(lead.session, 'muted', 11.5, x, available, false, 'mono')
    l.y = Math.max(l.y, top + 30)
    badges(l, lead, data.instruments)
    if (lead.over) {
      l.y += 8
      const start = l.y
      const before = l.body
      l.body = ''
      l.y += 6
      l.line('Context past the limit: finish the step, write the handoff, run /next', 'onCritical', 13, 10, l.width - 20, true)
      l.y += 6
      l.body = before + `<rect x="0" y="${start}" width="${l.width}" height="${l.y - start}" rx="6" fill="var(--critical)"/>` + l.body
    }
    l.y += 10
    l.frame = lead.over
    return l
  })
  return rows(width, cells, cellWidth, 'Lead')
}
