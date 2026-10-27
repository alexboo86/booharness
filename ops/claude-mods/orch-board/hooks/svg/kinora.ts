// Web-board presentation, copied from dashboard.ts (decision 17529).
// Keep this filename for existing imports; no Kinora styling remains.
import { FAMILY_LOGOS } from '../generated/family-logos'

export const boardStyle = `
:root {
  --bg: #f4f4f2; --surface: #fcfcfb; --raised: #ffffff; --ink: #1c1c1a; --ink-2: #4a4a45; --muted: #85847d;
  --line: #e4e3de; --track: #ebeae5; --accent: #465e80; --accent-soft: #e9edf3; --badge-ink: #304760; --badge-muted: #67665f;
  --skill-1-soft: #e2efe2; --skill-1-ink: #2c5b33; --skill-2-soft: #e6efda; --skill-2-ink: #495217; --skill-3-soft: #dbeee4; --skill-3-ink: #175247;
  --tool-1-soft: #f6ecd3; --tool-1-ink: #644a04; --tool-2-soft: #f8e7d6; --tool-2-ink: #70380b; --tool-3-soft: #f3eedd; --tool-3-ink: #59491a;
  --pi-1-soft: #e9e3f3; --pi-1-ink: #48367a; --pi-2-soft: #f1e3f4; --pi-2-ink: #6a2b79;
  --mcp-1-soft: #dbeff0; --mcp-1-ink: #0f5052; --mcp-2-soft: #dfeef6; --mcp-2-ink: #18496a;
  --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #bc3030; --critical-soft: #fbeaea; --on-critical: #ffffff; --warning-soft: #fdf4e1;
  --shadow: 0 1px 2px rgba(0,0,0,.05);
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #121211; --surface: #1a1a19; --raised: #1f1f1d; --ink: #edece7; --ink-2: #c3c2bb; --muted: #8d8c85;
    --line: #2d2c29; --track: #2a2926; --accent: #aabbd5; --accent-soft: #28313d; --badge-ink: #d9e3f1; --badge-muted: #aaa9a0; --critical: #ec8c8c; --critical-soft: #3a1f1f; --on-critical: #121211; --warning-soft: #3a3120;
    --skill-1-soft: #20321f; --skill-1-ink: #b7e2bb; --skill-2-soft: #2f3421; --skill-2-ink: #d2e2a2; --skill-3-soft: #1d332b; --skill-3-ink: #abe1cf;
    --tool-1-soft: #38321c; --tool-1-ink: #ecd9a0; --tool-2-soft: #3a2c1d; --tool-2-ink: #f0cfae; --tool-3-soft: #36331f; --tool-3-ink: #e4dcae;
    --pi-1-soft: #2c2740; --pi-1-ink: #cfc4f0; --pi-2-soft: #38203c; --pi-2-ink: #e6bdf0;
    --mcp-1-soft: #1c3638; --mcp-1-ink: #abdfe2; --mcp-2-soft: #1e3240; --mcp-2-ink: #b3d8ec;
    --shadow: none; }
}
text { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.brand, .big { font-weight: 700; letter-spacing: -.01em; }
.host { font-weight: 700; }
.section { font-weight: 600; letter-spacing: .08em; }
.sect-label { letter-spacing: .05em; }
.skill { font-style: italic; }
.verdict { font-weight: 700; letter-spacing: .03em; }
.card { filter: drop-shadow(var(--shadow)); }
@media (prefers-color-scheme: dark) { .card { filter: none; } }
`
export const palette = {
  page: 'var(--bg)', surface: 'var(--surface)', raised: 'var(--raised)', ink: 'var(--ink)', secondary: 'var(--ink-2)',
  muted: 'var(--muted)', line: 'var(--line)', track: 'var(--track)', badge: 'var(--badge-ink)', badgeMuted: 'var(--badge-muted)',
  teal: 'var(--accent)', blue: 'var(--badge-ink)', purple: 'var(--serious)', green: 'var(--good)',
  amber: 'var(--warning)', amberMark: 'var(--warning)', red: 'var(--critical)', onCritical: 'var(--on-critical)',
  redSoft: 'var(--critical-soft)', amberSoft: 'var(--warning-soft)',
  skill1Soft: 'var(--skill-1-soft)', skill1Ink: 'var(--skill-1-ink)', skill2Soft: 'var(--skill-2-soft)', skill2Ink: 'var(--skill-2-ink)',
  skill3Soft: 'var(--skill-3-soft)', skill3Ink: 'var(--skill-3-ink)',
  tool1Soft: 'var(--tool-1-soft)', tool1Ink: 'var(--tool-1-ink)', tool2Soft: 'var(--tool-2-soft)', tool2Ink: 'var(--tool-2-ink)',
  tool3Soft: 'var(--tool-3-soft)', tool3Ink: 'var(--tool-3-ink)',
  pi1Soft: 'var(--pi-1-soft)', pi1Ink: 'var(--pi-1-ink)', pi2Soft: 'var(--pi-2-soft)', pi2Ink: 'var(--pi-2-ink)',
  mcp1Soft: 'var(--mcp-1-soft)', mcp1Ink: 'var(--mcp-1-ink)', mcp2Soft: 'var(--mcp-2-soft)', mcp2Ink: 'var(--mcp-2-ink)',
} as const
export type Tone = keyof typeof palette
export const fonts = { body: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', mono: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
export const scale = { caption: 11, body: 13, heading: 13, value: 22, brand: 16, pad: 14, line: 18.85 }
export type Image = { svg: string; height: number; pages?: Image[] }
export const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)

// SF Pro advances (macOS system-ui, tabular digits as the board CSS sets), measured with CoreText
// at 13 px (text optical size) and 22 px (display), in 1000 units per em. Bold text is wider:
// weights 400, 600 and 700 are measured apart.
const glyphs = [32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,8230,183,8776,9660,9654,8212,8211,8594,215,9679,8593,8595,8805,8804]
const advances: Record<string, readonly number[]> = {
  text400: [276,306,472,625,625,920,706,292,376,376,466,625,292,466,292,299,625,625,625,625,625,625,625,625,625,625,292,292,625,625,625,507,913,668,652,710,721,590,567,741,737,262,533,653,563,869,737,766,630,766,648,632,628,732,668,962,673,650,656,376,299,376,625,578,495,546,609,554,609,566,356,604,583,242,241,538,248,865,578,585,605,604,375,518,358,578,537,769,519,538,534,376,253,376,625,799,292,625,762,796,869,578,900,625,920,776,776,625,625],
  text600: [261,334,530,651,651,990,727,324,406,406,474,651,324,474,324,318,651,651,651,651,651,651,651,651,651,651,324,324,651,651,651,535,918,706,675,727,734,607,583,750,763,294,573,685,580,889,753,776,654,776,674,656,645,746,698,989,706,683,665,406,318,406,651,606,495,570,632,572,632,585,386,627,611,267,267,575,274,904,606,604,628,628,410,545,389,606,562,815,555,572,551,406,279,406,651,894,324,651,769,805,889,606,924,651,936,797,797,651,651],
  text700: [252,351,563,666,666,1030,739,342,423,423,479,666,342,479,342,329,666,666,666,666,666,666,666,666,666,666,342,342,666,666,666,552,922,727,688,736,742,616,592,755,778,313,596,704,589,901,763,781,668,781,689,670,655,755,716,1004,724,703,670,423,329,423,666,622,495,584,646,582,646,595,403,640,627,282,282,596,290,927,622,614,642,642,430,561,407,622,577,842,575,592,561,423,294,423,666,949,342,666,773,810,901,622,938,666,946,810,810,666,666],
  display400: [230,276,427,605,605,852,678,263,339,339,423,605,242,438,242,280,605,605,605,605,605,605,605,605,605,605,242,242,605,605,605,489,884,642,618,689,690,562,538,714,708,234,504,617,534,840,708,739,594,739,614,603,595,704,640,933,644,621,627,339,280,339,605,542,489,514,571,517,571,529,320,566,551,214,213,501,216,824,542,548,567,566,331,482,319,542,500,732,484,502,490,339,225,339,605,681,242,605,756,790,840,542,895,605,914,770,770,605,605],
  display600: [220,306,472,629,632,913,699,284,373,373,443,632,266,446,266,297,632,632,632,632,632,632,632,632,632,632,266,266,632,632,632,517,891,679,641,705,703,576,552,725,731,262,544,649,548,860,721,751,618,751,639,627,610,715,670,960,676,655,636,373,297,373,632,572,489,541,597,540,596,552,351,592,579,238,237,536,241,862,572,571,593,592,366,511,352,572,527,779,520,536,511,373,246,373,632,756,266,632,763,799,860,572,918,632,930,792,792,632,632],
  display700: [215,324,498,643,647,948,711,296,393,393,455,647,280,450,280,307,647,647,647,647,647,647,647,647,647,647,280,280,647,647,647,534,895,700,654,715,711,585,560,731,744,279,567,668,556,871,729,757,633,757,655,641,618,721,687,975,695,674,641,393,307,393,647,589,489,556,611,554,611,565,369,606,596,251,251,557,256,885,589,584,607,607,386,528,371,589,543,806,541,555,523,393,258,393,647,799,280,647,768,804,871,589,932,647,940,804,804,647,647],
}
export type Weight = 400 | 600 | 700
/** One badge hue: a soft fill tone and its ink tone; contrast is pinned by tests/svg.test.ts. */
export type Hue = { soft: Tone; ink: Tone }
const lookup = new Map(glyphs.map((n, i) => [n, i]))
export function measure(value: string, size = scale.body, mono = false, weight: Weight = 400): number {
  const row = advances[(size >= 20 ? "display" : "text") + weight]!
  return Array.from(value).reduce((sum, c) => {
    const n = c.codePointAt(0)!, i = lookup.get(n)
    return sum + (/\p{Mark}/u.test(c) ? 0 : mono ? 600 : i == null ? 1000 : row[i]!) * size / 1000
  }, 0)
}
/** The weight a text run draws in: bold attributes draw 600, the bold classes 700. */
export function weightOf(bold: boolean, cls = ""): Weight {
  return /\b(big|brand|host|verdict)\b/.test(cls) ? 700 : bold ? 600 : 400
}
export function truncate(value: string, width: number, size = scale.body, mono = false, weight: Weight = 400): string {
  if (measure(value, size, mono, weight) <= width + 1e-9) return value
  if (width < measure('…', size, mono, weight)) return ''
  let out = ''
  for (const c of value) {
    if (measure(out + c + '…', size, mono, weight) > width) break
    out += c
  }
  return out + '…'
}
export function wrap(value: string, width: number, size = scale.body, mono = false, weight: Weight = 400): string[] {
  const lines: string[] = []
  for (const paragraph of value.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/(\s+)/)) {
      if (measure(line + word, size, mono, weight) <= width) { line += word; continue }
      if (line) { lines.push(line.trimEnd()); line = '' }
      for (const c of word) {
        if (line && measure(line + c, size, mono, weight) > width) { lines.push(line); line = '' }
        line += c
      }
    }
    lines.push(line.trimEnd())
  }
  return lines
}
export function text(x: number, y: number, value: string, tone: Tone = 'ink', size = scale.body, width?: number, bold = false, cls = ''): string {
  const shown = width == null ? value : truncate(value, width, size, cls === 'mono', weightOf(bold, cls))
  return `<text x="${x}" y="${y}" fill="${palette[tone]}" font-size="${size}"${bold ? ' font-weight="600"' : ''}${cls ? ` class="${cls}"` : ''}>${shown !== value ? `<title>${esc(value)}</title>` : ''}${esc(shown)}</text>`
}
export function card(x: number, y: number, width: number, height: number, alert = false): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="${palette.raised}" stroke="${palette[alert ? 'red' : 'line']}" class="card"${alert ? ' stroke-width="2"' : ''}/>`
}
export function bar(x: number, y: number, width: number, percent: number | null, tone: Tone): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="8" rx="4" fill="${palette.track}"/>`
    + (percent == null ? '' : `<rect x="${x}" y="${y}" width="${width * Math.max(0, Math.min(100, percent)) / 100}" height="8" rx="4" fill="${palette[tone]}"/>`)
}
/** Pult meter: a bold percent over a 3 px bar; colour lives in the bar only. */
export function meter(x: number, y: number, width: number, percent: number | null, tone: Tone, label: string, tip: string): string {
  return `<g><title>${esc(tip)}</title>` + text(x, y + 15, label, 'ink', 16, width, false, 'big')
    + `<rect x="${x}" y="${y + 22}" width="${width}" height="3" rx="1.5" fill="${palette.track}"/>`
    + (percent == null ? '' : `<rect x="${x}" y="${y + 22}" width="${width * Math.max(0, Math.min(100, percent)) / 100}" height="3" rx="1.5" fill="${palette[tone]}"/>`)
    + '</g>'
}
export function ring(x: number, y: number, size: number, percent: number | null, tone: Tone, label: string, tip: string): string {
  const stroke = Math.max(5, Math.round(size / 9)), r = (size - stroke) / 2, c = 2 * Math.PI * r
  return `<g transform="translate(${x} ${y})"><title>${esc(tip)}</title><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${palette.track}" stroke-width="${stroke}"/>`
    + (percent == null ? '' : `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${palette[tone]}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c * Math.max(0, Math.min(100, percent)) / 100} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`)
    + `<text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" fill="${palette.ink}" font-size="${size >= 80 ? 18 : 13}" font-weight="700">${esc(label)}</text></g>`
}
export function gauge(x: number, y: number, width: number, label: string, percent: number | null, value: string, tone: Tone): string {
  const track = 120
  const stacked = width < 254, valueX = stacked ? 46 : 54 + track
  return text(x, y, label, 'muted', scale.caption, undefined, true) + bar(x + 46, y - 8, track, percent, tone)
    + wrap(value, width - valueX, 11.5).map((line, i) => text(x + valueX, y + (i + (stacked ? 1 : 0)) * 16.675, line, 'secondary', 11.5)).join('')
}
export type ChipKind = 'chip' | 'host' | 'remote' | 'stat' | 'alert' | 'drain' | 'receipt' | 'used' | 'unused' | 'missing' | 'other' | 'mcp' | 'state'
/** SF Pro ascent .9668 em and descent .2109 em: a line box of height L puts the baseline at L/2 + .378 em. */
export function baseline(lineHeight: number, size: number): number {
  return lineHeight / 2 + 0.378 * size
}
/** The web board CSS box of each pill: font size, line height, vertical and side padding, border, weight. */
const boxes: Record<ChipKind, { size: number; line: number; padY: number; padX: number; border: number; weight: Weight }> = {
  chip: { size: 11, line: 18, padY: 0, padX: 8, border: 0, weight: 600 },
  host: { size: 11, line: 16, padY: 0, padX: 7, border: 1, weight: 700 },
  remote: { size: 11, line: 16, padY: 0, padX: 7, border: 1, weight: 700 },
  stat: { size: 13, line: 18.85, padY: 2, padX: 10, border: 1, weight: 400 },
  alert: { size: 13, line: 18.85, padY: 2, padX: 10, border: 1, weight: 400 },
  drain: { size: 13, line: 18.85, padY: 2, padX: 10, border: 1, weight: 400 },
  receipt: { size: 11.5, line: 16.675, padY: 5, padX: 8, border: 1, weight: 400 },
  used: { size: 11, line: 20, padY: 0, padX: 8, border: 1, weight: 400 },
  unused: { size: 11, line: 20, padY: 0, padX: 8, border: 1, weight: 400 },
  missing: { size: 11, line: 20, padY: 0, padX: 8, border: 1, weight: 400 },
  other: { size: 11, line: 20, padY: 0, padX: 8, border: 1, weight: 400 },
  mcp: { size: 11, line: 20, padY: 0, padX: 8, border: 1, weight: 400 },
  state: { size: 12, line: 17.4, padY: 0, padX: 0, border: 0, weight: 400 },
}
/** Box height of a pill kind, border included. */
export function chipHeight(kind: ChipKind): number {
  const box = boxes[kind]
  return box.line + 2 * (box.padY + box.border)
}
/**
 * A pill drawn as its web CSS box. `y` is the box top plus 13. Counts are the web <b> children:
 * weight 700, 5 px left margin each.
 */
export function chip(x: number, y: number, value: string, tone: Tone = 'teal', tip = '', maxWidth = Infinity, bold = false, kind: ChipKind = 'chip', cls = '', counts: readonly (number | string)[] = [], mark = '', hue?: Hue): { svg: string; width: number } {
  const box = boxes[kind], state = kind === 'state', mono = cls === 'mono', size = box.size
  // A badge hue tints the neutral badge kinds only; missing keeps red and unused stays muted.
  const tint = hue != null && (kind === 'used' || kind === 'mcp' || kind === 'other') ? hue : null
  const weight: Weight = bold && box.weight === 400 ? 600 : box.weight
  const labelCls = kind === 'host' || kind === 'remote' ? 'host' : cls
  const top = y - 13, height = chipHeight(kind), inset = box.border + box.padX + (state ? 13 : 0)
  const full = [value, ...counts].join(' ')
  const markSize = size * 1.4
  const markWidth = mark ? markSize + size * 0.6 : 0
  const whole = markWidth + measure(value, size, mono, weight) + counts.reduce<number>((sum, count) => sum + 5 + measure(String(count), size, mono, 700), 0)
  const fits = whole <= maxWidth - 2 * inset + (state ? 13 : 0)
  const label = fits ? value : truncate(full, maxWidth - 2 * inset - markWidth, size, mono, weight)
  const width = Math.min(maxWidth, (fits ? whole : markWidth + measure(label, size, mono, weight)) + 2 * inset - (state ? 13 : 0))
  const fill = kind === 'alert' || kind === 'missing' ? 'var(--critical-soft)' : kind === 'remote' || kind === 'drain' ? 'var(--warning-soft)' : kind === 'stat' || kind === 'host' ? palette.raised : kind === 'receipt' ? palette.surface : kind === 'unused' || state ? 'none' : tint ? palette[tint.soft] : kind === 'other' ? palette.track : 'var(--accent-soft)'
  const stroke = kind === 'alert' || kind === 'missing' ? palette.red : kind === 'host' ? palette.teal : kind === 'remote' || kind === 'drain' ? palette.amber : kind === 'stat' || kind === 'receipt' || kind === 'unused' ? palette.line : 'none'
  const ink = kind === 'remote' || kind === 'drain' ? 'ink' : kind === 'alert' || kind === 'missing' ? 'red' : kind === 'unused' ? 'badgeMuted' : tint ? tint.ink : kind === 'used' || kind === 'mcp' ? 'badge' : kind === 'stat' || kind === 'other' || kind === 'receipt' || state ? 'secondary' : tone
  const radius = kind === 'receipt' ? 4 : ['used', 'unused', 'missing', 'other', 'mcp'].includes(kind) ? 6 : height / 2
  const base = top + box.border + box.padY + baseline(box.line, size)
  let lettering = (mark ? `<g color="${palette[ink]}"><use href="#fam-${esc(mark)}" x="${x + inset}" y="${base - size * 0.35 - markSize / 2}" width="${markSize}" height="${markSize}"/></g>` : '')
    + text(x + inset + markWidth, base, label, ink, size, undefined, weight !== 400 && labelCls !== 'host', labelCls)
  // A real space keeps "rtk 7" readable as text; dx tops it up to the web 5 px margin.
  const space = measure(' ', size, mono, 700)
  if (fits && counts.length) lettering = lettering.replace(esc(value) + '</text>', () => esc(value) + counts.map(count => `<tspan dx="${+(5 - space).toFixed(3)}" font-weight="700"> ${esc(String(count))}</tspan>`).join('') + '</text>')
  const title = [tip, ...(fits ? [] : [full])].filter(Boolean).join(' · ')
  const half = box.border / 2
  const frame = state
    ? `<circle cx="${x + 3.5}" cy="${top + height / 2}" r="3.5" fill="${palette[tone]}"/>`
    : `<rect x="${x + half}" y="${top + half}" width="${width - box.border}" height="${height - box.border}" rx="${radius}" fill="${fill}" stroke="${stroke}"${box.border ? '' : ' stroke-width="0"'}${kind === 'unused' ? ' stroke-dasharray="3 2"' : ''}/>`
  return { width, svg: `<g>${title ? `<title>${esc(title)}</title>` : ''}${frame}${lettering}</g>` }
}
export function image(width: number, height: number, body: string, label: string, top = 0): Image {
  // Each page is a separate image, so include only its referenced, trusted registry symbols.
  const definitions = Object.entries(FAMILY_LOGOS)
    .filter(([key]) => body.includes(`<use href="#fam-${key}"`))
    .map(([key, svg]) => svg.replace('<svg ', `<symbol id="fam-${key}" `).replace('</svg>', '</symbol>'))
    .join('')
  return { height, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 ${top} ${width} ${height}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="${esc(label)}"><style>${boardStyle}</style>${definitions ? `<defs>${definitions}</defs>` : ''}${body}</svg>` }
}
export function tone(key: string): Tone {
  return ({ subtle: 'muted', text: 'ink', claude: 'teal', success: 'green', warning: 'amber', permission: 'purple', error: 'red' } as Record<string, Tone>)[key] ?? 'muted'
}
export function thresholdTone(key: string): Tone {
  return tone(key)
}
export class Layout {
  y = scale.pad
  body = ''
  /** A grid cell with a card frame: false plain, true alert. grid draws it at the row height. */
  frame: boolean | null = null
  private pageTop = 0
  private pages: { body: string; top: number; height: number }[] = []
  constructor(readonly width: number, readonly pad: number = scale.pad) {}
  line(value: string, color: Tone = 'ink', size = scale.body, x = this.pad, available = this.width - x - this.pad, bold = false, cls = ''): void {
    for (const part of wrap(value, available, size, cls === 'mono', weightOf(bold, cls))) {
      this.body += text(x, this.y + size, part, color, size, undefined, bold, cls)
      this.y += size * 1.45
    }
  }
  chips(values: readonly { label: string; tone?: Tone; tip?: string; bold?: boolean; kind?: ChipKind; cls?: string; counts?: readonly (number | string)[]; hue?: Hue }[], x = this.pad, gap = 8, rowHeight = 22): void {
    let left = x
    for (const value of values) {
      let entry = chip(left, this.y + 13, value.label, value.tone, value.tip, this.width - x - this.pad, value.bold, value.kind, value.cls, value.counts, '', value.hue)
      if (left > x && left + entry.width > this.width - this.pad) {
        this.y += rowHeight; left = x
        entry = chip(left, this.y + 13, value.label, value.tone, value.tip, this.width - x - this.pad, value.bold, value.kind, value.cls, value.counts, '', value.hue)
      }
      this.body += entry.svg
      left += entry.width + gap
    }
    if (values.length) this.y += rowHeight
  }
  /** SvgProps caps source at 131072 characters and either dimension at 4096; a page stays at 3700 so the 14/13 pane zoom stays under it. */
  page(before: string, top: number): void {
    if ((this.body.length <= 115000 && this.y + this.pad - this.pageTop <= 3700) || !before) return
    const cut = Math.max(this.pageTop + 1, top - 8)
    this.pages.push({ body: before, top: this.pageTop, height: cut - this.pageTop })
    this.body = this.body.slice(before.length)
    this.pageTop = cut
  }
  finish(label: string, framed = false): Image {
    const pages = [...this.pages, { body: this.body, top: this.pageTop, height: this.y + this.pad - this.pageTop }]
      .map(p => image(this.width, p.height, (framed ? card(0, p.top, this.width, p.height) : '') + p.body, label, p.top))
    const first = pages[0]!
    return pages.length === 1 ? first : { ...first, pages: pages.slice(1) }
  }
}

/** Web minmax columns share the row; content is laid out, never scaled. */
export function cardWidth(width: number, minimum = 340): number {
  const gap = 10, columns = Math.max(1, Math.floor((width + gap) / (minimum + gap)))
  return (width - (columns - 1) * gap) / columns
}

/** Space between a Pult card frame and its content. */
export const INSET = 12

/** Pult cards: columns of at least `minimum` px with the web 10 px gap; content keeps its size. */
export function columnWidth(width: number, minimum: number, gap = 10): number {
  const columns = Math.max(1, Math.floor((width + gap) / (minimum + gap)))
  return (width - (columns - 1) * gap) / columns
}

/**
 * Pult list: each cell is a web card frame (decision 17561 follow-up: «обводки карточки как в веб»),
 * its content laid out INSET px inside at `cellWidth - 2 * INSET`. A row is as tall as its tallest
 * card; an alert cell (frame true) gets the red frame.
 */
export function rows(width: number, cells: Layout[], cellWidth: number, label: string, gap = 10): Image {
  const l = new Layout(width, 0)
  l.y = 0
  const columns = Math.max(1, Math.round((width + gap) / (cellWidth + gap)))
  for (let i = 0; i < cells.length; i += columns) {
    if (i) l.y += gap
    const row = cells.slice(i, i + columns), before = l.body, top = l.y
    const height = Math.ceil(Math.max(...row.map(cell => cell.y)))
    row.forEach((cell, column) => {
      const left = column * (cellWidth + gap)
      l.body += card(left + 1, top + 1, cellWidth - 2, height - 2, cell.frame === true)
      l.body += `<g transform="translate(${left + INSET} ${top})">${cell.body}</g>`
    })
    l.y += height
    l.page(before, top)
  }
  return l.finish(label)
}

export function grid(width: number, cells: Layout[], cellWidth: number, label: string): Image {
  const l = new Layout(width)
  l.y = 0
  const gap = 10, columns = Math.max(1, Math.floor((width + gap) / (cellWidth + gap)))
  for (let i = 0; i < cells.length; i += columns) {
    const row = cells.slice(i, i + columns), before = l.body, top = l.y
    // Web grid rows stretch: every card of a row is as tall as the tallest one.
    const height = Math.ceil(Math.max(...row.map(cell => cell.y)))
    row.forEach((cell, column) => {
      const frame = cell.frame == null ? '' : card(1, 1, cellWidth - 2, height - 2, cell.frame)
      l.body += `<g transform="translate(${column * (cellWidth + gap)} ${top})">${frame}${cell.body}</g>`
    })
    l.y += height + gap
    l.page(before, top)
  }
  return l.finish(label)
}
