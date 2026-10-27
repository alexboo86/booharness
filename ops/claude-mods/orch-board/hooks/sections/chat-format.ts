import type { ThemeKey } from 'claude-code';

export type ChatFeedPost = {
  id: number;
  at: string;
  author: string;
  body: string;
  to: 'all' | string[] | null;
  wake: boolean;
  delivered: string[];
  confirmed: string[];
  receipts?: {
    handle: string;
    state: string;
    delivered_at?: string;
    confirmed_at?: string;
  }[];
};

export function chatTime(iso: string): string {
  const at = new Date(iso);
  return String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
}

/** The web board's unsigned UTF-16 hash, mapped to the host's theme keys. */
export function nickColor(handle: string): ThemeKey {
  if (handle === 'operator') return 'claude';
  let tone = 0;
  for (let index = 0; index < handle.length; index++) {
    tone = (tone * 31 + handle.charCodeAt(index)) >>> 0;
  }
  const tones = ['success', 'warning', 'error', 'permission', 'subtle'] as const;
  return tones[tone % 5]!;
}

export function liveHandlesText(handles: readonly string[], watchers?: number): string {
  return 'Live handles: ' + (handles.join(', ') || 'none')
    + (typeof watchers === 'number' ? ' · ' + watchers + ' watching' : '');
}

function isBroadcast(to: ChatFeedPost['to']): boolean {
  return to === 'all' || (Array.isArray(to) && to.includes('all'));
}

export function postAddress(to: ChatFeedPost['to']): string | null {
  if (to === null) return null;
  return (to === 'all' || to.includes('all') ? 'all' : to.join(', ')) + ':';
}

export function postReceipts(post: ChatFeedPost, handles: readonly string[]) {
  if (post.to === null) return [];
  const detail = new Map(post.receipts?.map((receipt) => [receipt.handle, receipt]));
  const recipients = isBroadcast(post.to)
    ? [...new Set([
      ...handles.filter((handle) => handle !== post.author),
      ...post.delivered,
      ...post.confirmed,
      ...detail.keys(),
    ])]
    : post.to as string[];
  return recipients.map((handle) => {
    const receipt = detail.get(handle);
    const state = receipt?.state || (post.confirmed.includes(handle) ? 'read'
      : post.delivered.includes(handle) ? 'delivered' : 'pending');
    const tooltip = [handle + ': ' + state];
    if (receipt?.delivered_at && Number.isFinite(Date.parse(receipt.delivered_at))) {
      tooltip.push('delivered ' + chatTime(receipt.delivered_at));
    }
    if (receipt?.confirmed_at && Number.isFinite(Date.parse(receipt.confirmed_at))) {
      tooltip.push('confirmed ' + chatTime(receipt.confirmed_at));
    }
    return { handle, state, tooltip: tooltip.join(' · ') };
  });
}

/** Addressed posts that are not fully read. A log line (`to` null) is never unread. */
export function unreadCount(posts: readonly ChatFeedPost[], handles: readonly string[]): number {
  return posts.filter((post) => {
    if (post.to === null) return false;
    const receipts = postReceipts(post, handles);
    if (receipts.length === 0) return true;
    return receipts.some((receipt) => receipt.state !== 'read');
  }).length;
}

/** Counts appear only after the feed has loaded. A missing feed is not zero posts. */
export function chatFoldTitle(posts: number | null, unread: number | null): string {
  if (posts == null || unread == null) return 'Chat';
  return 'Chat · ' + posts + ' · ' + unread + ' unread';
}
