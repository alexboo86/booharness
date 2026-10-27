// Read-only assign notice projection from the chat store (TASKS-BOARD.md, Read).
import { chatList, RESERVED_HANDLE, type ChatReceipt } from './chat.ts';
import type { Store } from './store.ts';
import { assignNoticePrefix } from './tasks-assign.ts';

export type AssignNotice = ChatReceipt & { post: number; at: string };

/** Find the newest assignment across the full log; chatList alone owns receipt state. */
export function assignNotice(store: Store, id: number, held: string[]): AssignNotice | null {
  const prefix = assignNoticePrefix(id);
  const row = store.db.prepare(`SELECT id FROM chat_posts
    WHERE author = ? AND substr(body, 1, length(?)) = ?
    ORDER BY id DESC LIMIT 1`).get(RESERVED_HANDLE, prefix, prefix);
  if (!row) return null;
  const post = chatList(store, { post: row.id as number, held }).posts[0];
  const handle = Array.isArray(post?.to) ? post.to[0] : undefined;
  const receipt = post?.receipts.find((entry) => entry.handle === handle);
  if (!post || !receipt) return null;
  return { post: post.id, at: post.at, ...receipt };
}
