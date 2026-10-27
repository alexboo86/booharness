import type { familyLabel } from '../sections/family-format'
import { Layout, palette, text, measure, esc, truncate, type Tone } from './kinora'

type Label = ReturnType<typeof familyLabel>

/** Geometry comes only from the registry; every dynamic name goes through text(). */
export function familyText(x: number, y: number, label: Label, color: Tone, size: number, width: number, bold = false) {
  const prefixWidth = measure(label.prefix, size, false, bold ? 600 : 400)
  // A 1.4em mark plus .6em gap matches the web slot; centre .35em above the baseline.
  const markSize = size * 1.4
  const markWidth = label.mark ? markSize + size * 0.6 : 0
  const shown = truncate(label.name, width - prefixWidth - markWidth, size, false, bold ? 600 : 400)
  const lettering = text(x, y, label.prefix, color, size, undefined, bold).replace('</text>',
    () => `<tspan dx="${markWidth}">${esc(shown)}</tspan></text>`)
  return (label.mark ? `<g color="${palette[color]}"><use href="#fam-${esc(label.mark)}" x="${x + prefixWidth}" y="${y - size * 0.35 - markSize / 2}" width="${markSize}" height="${markSize}"/></g>` : '')
    + (shown !== label.name ? `<g><title>${esc(label.prefix + label.name)}</title>${lettering}</g>` : lettering)
}

export function familyLine(l: Layout, label: Label, suffix: string, color: Tone, size: number, x: number, width: number) {
  const used = measure(label.prefix + label.name, size) + (label.mark ? size * 2 : 0)
  // Keep the model metadata on its existing line when it fits, otherwise wrap it below.
  if (suffix && used + measure(suffix, size) <= width) {
    l.body += familyText(x, l.y + size, { ...label, name: label.name + suffix }, color, size, width)
    l.y += size * 1.45
  } else {
    l.body += familyText(x, l.y + size, label, color, size, width)
    l.y += size * 1.45
    if (suffix) l.line(suffix.replace(/^ · /, ''), color, size, x, width)
  }
}
