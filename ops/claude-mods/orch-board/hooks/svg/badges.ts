import { badgeGroups, type BadgeGroup, type BadgeSource } from '../sections/leads-format'
import { Layout, text, type Hue } from './kinora'

/** Each row its own 2-3 related hues, so skills, tools, MCP and Pi stay apart; missing keeps red, unused stays muted. */
export const badgeHues: Record<BadgeGroup['label'], readonly Hue[]> = {
  skills: [{ soft: 'skill1Soft', ink: 'skill1Ink' }, { soft: 'skill2Soft', ink: 'skill2Ink' }, { soft: 'skill3Soft', ink: 'skill3Ink' }],
  tools: [{ soft: 'tool1Soft', ink: 'tool1Ink' }, { soft: 'tool2Soft', ink: 'tool2Ink' }, { soft: 'tool3Soft', ink: 'tool3Ink' }],
  mcp: [{ soft: 'mcp1Soft', ink: 'mcp1Ink' }, { soft: 'mcp2Soft', ink: 'mcp2Ink' }],
  pi: [{ soft: 'pi1Soft', ink: 'pi1Ink' }, { soft: 'pi2Soft', ink: 'pi2Ink' }],
}

/** FNV-1a over the row and name: a badge keeps one hue wherever and whenever it draws. */
function hueOf(row: BadgeGroup['label'], name: string): Hue {
  const hues = badgeHues[row]
  let hash = 0x811c9dc5
  for (const c of row + ':' + name) {
    hash = Math.imul(hash ^ c.codePointAt(0)!, 0x01000193) >>> 0
  }
  return hues[hash % hues.length]!
}

export function badges(layout: Layout, source: BadgeSource, instruments: readonly string[]): void {
  const groups = badgeGroups(source, instruments)
  if (groups.length) layout.y += 10
  for (const group of groups) {
    const top = layout.y
    layout.chips(group.badges.map(b => ({
      label: b.name, counts: b.counts, kind: b.tone,
      tone: b.tone === 'missing' ? 'red' as const : 'badge' as const, tip: b.detail,
      hue: b.tone === 'missing' || b.tone === 'unused' ? undefined : hueOf(group.label, b.name),
      cls: group.label === 'skills' && b.name !== 'knowledge' && b.name !== 'lessons' && b.name !== 'no jev' ? 'skill' : '',
    })), layout.pad + 45, 5, 24)
    layout.body += text(layout.pad, top + 13, group.label.toUpperCase(), 'badgeMuted', 10, undefined, false, 'sect-label')
  }
}
