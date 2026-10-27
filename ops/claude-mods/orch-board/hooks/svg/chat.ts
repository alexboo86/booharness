import type { ChatList } from '../../types'
import { chatTime, liveHandlesText, postAddress, postReceipts } from '../sections/chat-format'
import { Layout, measure, palette, text, wrap, type Tone, type Image } from './kinora'

export function chatSvg(data: ChatList | null, width: number, error: string | null = null): Image {
  const l = new Layout(width)
  if (error != null) l.line('Chat unavailable: ' + error, 'red')
  if (!data) {
    if (error == null) l.line('Reading chat...', 'muted')
    return l.finish('Chat')
  }
  const handles = data.handles.map(h => h.handle)
  l.line(liveHandlesText(handles, data.watchers), 'muted', 13)
  if (!data.posts.length) l.line('no posts', 'muted')
  const posts = data.posts.slice(-4)
  const earlier = data.posts.length - posts.length
  if (earlier) l.line(earlier + ' earlier posts', 'muted')
  for (const post of posts) {
    const top = l.y, before = l.body
    l.y += 16
    let hash = 0
    for (let i = 0; i < post.author.length; i++) hash = (hash * 31 + post.author.charCodeAt(i)) >>> 0
    const color: Tone = post.author === 'operator' ? 'teal' : (['green', 'purple', 'red', 'badge', 'secondary'] as const)[hash % 5]!
    const time = chatTime(post.at), x = l.pad + measure(time, 11.5, true) + 8
    l.body += text(l.pad, l.y + 13, time, 'secondary', 11.5, undefined, false, 'mono')
    l.body += text(x, l.y + 13, post.author, color, 13, width - x - l.pad - (post.wake ? 24 : 0), true)
    if (post.wake) l.body += `<g><title>wake</title>${text(width - l.pad - 14, l.y + 13, '⚑', 'purple')}</g>`
    l.y += 26.85
    const address = postAddress(post.to)
    if (address) { l.line(address, 'secondary', 11.5, l.pad, undefined, false, 'mono'); l.y += 4 }
    for (const part of wrap(post.body, width - 2 * l.pad)) {
      l.body += text(l.pad, l.y + 13, part)
      l.y += 19.5
    }
    const receipts = postReceipts(post, handles)
    if (receipts.length) l.y += 12
    l.chips(receipts.map(r => ({ label: r.handle + ' · ' + r.state, kind: 'receipt', cls: 'mono', tip: r.tooltip })), l.pad, 8, 32)
    l.y += 16
    if (post !== posts[posts.length - 1]) l.body += `<path d="M${l.pad} ${l.y}H${width - l.pad}" stroke="${palette.line}"/>`
    l.page(before, top)
  }
  return l.finish('Chat', true)
}
