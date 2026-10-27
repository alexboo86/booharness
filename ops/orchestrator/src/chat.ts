// Task 2139 (plan 14640 D1-D3): lead chat identity, posts and receipts.
// A participant is a handle; `operator` is reserved. Join is the only way bindings change.
import { transaction, type Store } from './store.ts';

/** A binding row; `ended_at` is null exactly while it is the live one. */
export type ChatBinding = { handle: string; session: string; generation: number; bound_at: string; ended_at: string | null; desktop: string | null };

export const RESERVED_HANDLE = 'operator';
/** Handles the board and the daemon's own authors keep; a lead cannot join any of them. */
const RESERVED_HANDLES = new Set([RESERVED_HANDLE, 'all', 'git', 'table']);
const HANDLE = /^[A-Za-z0-9._-]{1,64}(?![\s\S])/; // absolute end, including a trailing newline

/** Without a receipt, a post this old with no held poll is shown as having no watcher. */
const NO_WATCHER_AFTER_MS = 2 * 60 * 1000;

function rowToBinding(row: Record<string, unknown>): ChatBinding {
  return {
    handle: row.handle as string,
    session: row.session as string,
    generation: row.generation as number,
    bound_at: row.bound_at as string,
    ended_at: (row.ended_at ?? null) as string | null,
    desktop: (row.desktop ?? null) as string | null,
  };
}

const liveOf = (db: Store['db'], where: string, ...args: (string | number)[]) =>
  db.prepare(`SELECT * FROM chat_bindings WHERE ${where} AND ended_at IS NULL`).get(...args) as Record<string, unknown> | undefined;

// Schema 7 records first-join eligibility by timestamp. Serialize joins and posts with a
// logical millisecond when the wall clock ties or goes backwards, so neither side of a
// first join is misclassified. Call only inside the write transaction.
function chatAt(db: Store['db']): string {
  const { at } = db.prepare(`SELECT MAX(at) AS at FROM (
    SELECT at FROM chat_posts WHERE id = (SELECT MAX(id) FROM chat_posts)
    UNION ALL SELECT MAX(bound_at) FROM chat_bindings
  )`).get() as { at: string | null };
  return new Date(Math.max(Date.now(), at === null ? 0 : Date.parse(at) + 1)).toISOString();
}

function validateHandle(handle: string): void {
  if (RESERVED_HANDLES.has(handle)) throw new Error(`handle '${handle}' is reserved`);
  if (typeof handle !== 'string' || !HANDLE.test(handle)) {
    throw new Error('handle must be 1-64 characters of letters, digits, dot, underscore or hyphen');
  }
}

/**
 * The same session updates only its desktop id. A previously superseded session cannot reclaim a handle
 * until the operator releases it on the board; other sessions supersede as before.
 * Joining another handle ends the session's first binding, without an operator release.
 */
export function chatJoin(store: Store, { handle, session, desktop }: { handle: string; session: string; desktop?: string }): ChatBinding {
  validateHandle(handle);
  if (desktop !== undefined && (typeof desktop !== 'string' || !desktop || desktop.length > 80 || /\s/.test(desktop))) {
    throw new Error('desktop must be a non-empty string of at most 80 characters with no whitespace');
  }
  if (session === RESERVED_HANDLE) throw new Error(`session '${session}' is reserved`);
  return transaction(store.db, () => {
    const mine = liveOf(store.db, 'session = ?', session);
    if (mine?.handle === handle) {
      if (desktop === undefined) return rowToBinding(mine);
      store.db.prepare('UPDATE chat_bindings SET desktop = ? WHERE handle = ? AND session = ? AND ended_at IS NULL')
        .run(desktop, handle, session);
      return rowToBinding({ ...mine, desktop });
    }
    const { g: mineMax } = store.db
      .prepare('SELECT MAX(generation) AS g FROM chat_bindings WHERE handle = ? AND session = ?')
      .get(handle, session) as { g: number | null };
    const { g: otherMax } = store.db
      .prepare('SELECT MAX(generation) AS g FROM chat_bindings WHERE handle = ? AND session != ?')
      .get(handle, session) as { g: number | null };
    const { g: floor } = store.db
      .prepare('SELECT MAX(generation) AS g FROM chat_bindings WHERE handle = ? AND session = ? AND bound_at = ended_at')
      .get(handle, RESERVED_HANDLE) as { g: number | null };
    if (mineMax !== null && otherMax !== null && otherMax > Math.max(mineMax, floor ?? 0)) {
      throw new Error(`session '${session}' held handle '${handle}' and was superseded; it cannot rejoin; the operator can release the handle on the board`);
    }
    const now = chatAt(store.db);
    // Any other session's live binding of this handle is superseded; the joining session's
    // own live binding, if it holds a different handle, is released.
    store.db.prepare('UPDATE chat_bindings SET ended_at = ? WHERE handle = ? AND ended_at IS NULL').run(now, handle);
    if (mine) store.db.prepare('UPDATE chat_bindings SET ended_at = ? WHERE session = ? AND ended_at IS NULL').run(now, session);
    const { g: handleMax } = store.db
      .prepare('SELECT MAX(generation) AS g FROM chat_bindings WHERE handle = ?')
      .get(handle) as { g: number | null };
    const binding: ChatBinding = { handle, session, generation: (handleMax ?? 0) + 1, bound_at: now, ended_at: null, desktop: desktop ?? null };
    store.db.prepare('INSERT INTO chat_bindings (handle, session, generation, bound_at, desktop) VALUES (?, ?, ?, ?, ?)')
      .run(handle, session, binding.generation, now, binding.desktop);
    return binding;
  });
}

/** Board-only release: end the live holder and persist a join floor in the same transaction. */
export function chatRelease(store: Store, { handle }: { handle: string }): { handle: string; session: string | null; generation: number } {
  validateHandle(handle);
  return transaction(store.db, () => {
    const { g: max } = store.db.prepare('SELECT MAX(generation) AS g FROM chat_bindings WHERE handle = ?')
      .get(handle) as { g: number | null };
    if (max === null) throw new Error(`handle '${handle}' never had a binding`);
    const session = liveOf(store.db, 'handle = ?', handle)?.session as string | undefined;
    const now = chatAt(store.db);
    store.db.prepare('UPDATE chat_bindings SET ended_at = ? WHERE handle = ? AND ended_at IS NULL').run(now, handle);
    store.db.prepare('INSERT INTO chat_bindings (handle, session, generation, bound_at, ended_at) VALUES (?, ?, ?, ?, ?)')
      .run(handle, RESERVED_HANDLE, max + 1, now, now);
    return { handle, session: session ?? null, generation: max + 1 };
  });
}

export type ChatAddress = 'all' | string[];
const isBroadcast = (to: ChatAddress | null): boolean => to === 'all' || (Array.isArray(to) && to.includes('all'));
export type ChatPost = { id: number; at: string; author: string; body: string; to: ChatAddress | null; wake: boolean };
/** The board's per-addressee state: what the daemon last saw happen to the post (plan 14824). */
export type ChatReceiptState = 'read' | 'delivered' | 'pending' | 'no watcher';
export type ChatReceipt = { handle: string; state: ChatReceiptState; delivered_at?: string; confirmed_at?: string };
type PostInput = { body: string; to?: ChatAddress; wake?: boolean; class?: 'fyi' };
type Identity = { as: string; session: string };

function requireLive(db: Store['db'], { as, session }: Identity): void {
  if (typeof as === 'string' && RESERVED_HANDLES.has(as)) throw new Error(`handle '${as}' is reserved`);
  if (typeof as !== 'string' || typeof session !== 'string' || !liveOf(db, 'handle = ? AND session = ?', as, session)) {
    throw new Error(`session must hold the live binding of '${as}'; use chat_join to rejoin`);
  }
}

function validatePostInput({ body, to, wake, class: cls }: PostInput): void {
  // A code point is at most two UTF-16 units; reject large input before allocating.
  if (typeof body !== 'string' || body.length < 1 || body.length > 1200 || Array.from(body).length > 600) {
    throw new Error('body must be 1-600 characters; longer posts are refused');
  }
  if (to !== undefined && to !== 'all' && !(Array.isArray(to) && to.length > 0 &&
    Array.from(to).every((handle) => typeof handle === 'string' && HANDLE.test(handle)))) {
    throw new Error("to must be omitted, 'all', or a non-empty array of valid handles");
  }
  if (wake !== undefined && typeof wake !== 'boolean') throw new Error('wake must be a boolean');
  if (cls !== undefined && cls !== 'fyi') throw new Error("class must be 'fyi' when present");
  if (cls === 'fyi' && wake === true) throw new Error("class 'fyi' cannot wake: a FYI post reaches its addressee at their next own turn");
}

function insertPost(db: Store['db'], author: string, input: PostInput): { id: number; at: string } {
  validatePostInput(input);
  const { body, to, wake } = input;
  const at = chatAt(db);
  const { lastInsertRowid } = db.prepare('INSERT INTO chat_posts (at, author, body, to_json, wake) VALUES (?, ?, ?, ?, ?)')
    .run(at, author, body, to === undefined ? null : JSON.stringify(to), wake === true ? 1 : 0);
  return { id: Number(lastInsertRowid), at };
}

/** A lead waiting on its wake post sits idle until the answer arrives, and a reply without wake reached it
 * only at its next own turn (task 2642, chat 1273/1274). The first post of an addressee back to a lead whose
 * wake post (by name or to all) reached it in the last 24 h wakes that lead; later posts do not. A reply that
 * also goes to all is not promoted (it would wake every lead), and a wake post older than the replier's first
 * join never reached it (the unreadWhere floor). */
const REPLY_WAKE_MS = 24 * 3600_000;

function repliedWake(db: Store['db'], author: string, to: PostInput['to']): number | null {
  if (!Array.isArray(to) || to.includes('all')) return null;
  const since = new Date(Date.now() - REPLY_WAKE_MS).toISOString();
  // The last answer is read once per asker, not once per candidate wake post (review of task 2642).
  const pick = db.prepare(`SELECT p.id FROM chat_posts p WHERE p.author = ? AND p.wake = 1 AND p.at >= ?
    AND p.at > (SELECT MIN(bound_at) FROM chat_bindings WHERE handle = ?)
    AND EXISTS (SELECT 1 FROM json_each(p.to_json) WHERE value IN (?, 'all'))
    AND p.id > COALESCE((SELECT MAX(q.id) FROM chat_posts q WHERE q.author = ?
      AND EXISTS (SELECT 1 FROM json_each(q.to_json) WHERE value IN (?, 'all'))), 0)
    ORDER BY p.id DESC LIMIT 1`);
  for (const asker of new Set(to)) {
    if (asker === author) continue;
    const row = pick.get(asker, since, author, author, author, asker) as { id: number } | undefined;
    if (row) return row.id;
  }
  return null;
}

/** A lead may post only under its live handle; an omitted address is a log line. */
export function chatPost(store: Store, input: Identity & PostInput): { id: number; at: string; notLive?: string[]; replyWake?: number } {
  return transaction(store.db, () => {
    requireLive(store.db, input);
    validatePostInput(input);
    const unknown: string[] = [];
    const notLive: string[] = [];
    if (Array.isArray(input.to)) {
      const known = store.db.prepare('SELECT MAX(ended_at IS NULL) AS live FROM chat_bindings WHERE handle = ?');
      for (const handle of new Set(input.to)) {
        if (handle === 'all') continue;
        const { live } = known.get(handle) as { live: number | null };
        if (live === null) unknown.push(handle);
        else if (!live) notLive.push(handle);
      }
    }
    if (unknown.length) {
      const live = store.db.prepare('SELECT handle FROM chat_bindings WHERE ended_at IS NULL ORDER BY handle').all();
      throw new Error(`unknown handles: ${unknown.join(', ')}; live handles: ${live.map((row) => row.handle).join(', ')}`);
    }
    const replyWake = input.wake === true || input.class === 'fyi' ? null : repliedWake(store.db, input.as, input.to);
    const posted = insertPost(store.db, input.as, replyWake === null ? input : { ...input, wake: true });
    return { ...posted, ...(notLive.length ? { notLive } : {}), ...(replyWake === null ? {} : { replyWake }) };
  });
}

export type ChatAddressee = { handle: string; state: 'watcher' | 'in turn' | 'no watcher'; lastSeen: string | null; desktop: string | null };

/** Shared lastSeen: the latest live join, handle receipt or request from this binding's session. */
function liveBindingsSeen(db: Store['db'], requests: ReadonlyMap<string, number>): (ChatBinding & { lastSeen: string })[] {
  const bindings = db.prepare(`SELECT b.*, (
    SELECT MAX(at) FROM (
      SELECT delivered_at AS at FROM chat_receipts WHERE handle = b.handle
      UNION ALL SELECT confirmed_at AS at FROM chat_receipts WHERE handle = b.handle
    )
  ) AS receipt_at FROM chat_bindings b WHERE b.ended_at IS NULL ORDER BY b.handle`).all();
  return bindings.map((binding) => {
    const request = requests.get(binding.session as string);
    const seen = [binding.bound_at as string, binding.receipt_at as string | null, request === undefined ? null : new Date(request).toISOString()]
      .filter((at): at is string => at !== null).sort();
    return { ...rowToBinding(binding), lastSeen: seen.at(-1)! };
  });
}

/** Snapshot for the poster only; never changes delivery eligibility or writes a receipt. */
export function chatAddressees(store: Store, post: number, requests: ReadonlyMap<string, number>, held: readonly string[]): ChatAddressee[] {
  const row = store.db.prepare('SELECT author, to_json FROM chat_posts WHERE id = ?').get(post) as { author: string; to_json: string | null };
  if (row.to_json === null) return [];
  const to = JSON.parse(row.to_json) as ChatAddress;
  const now = Date.now();
  return liveBindingsSeen(store.db, requests)
    .filter((binding) => binding.handle !== row.author && (isBroadcast(to) || to.includes(binding.handle)))
    .map(({ handle, session, lastSeen, desktop }) => {
      const request = requests.get(session);
      return {
        handle,
        state: held.includes(session) ? 'watcher' : request !== undefined && now - request < 3 * 60 * 1000 ? 'in turn' : 'no watcher',
        lastSeen, desktop,
      };
    });
}

/** The board's operator route needs no lead binding, but shares all post validation. */
export function chatPostOperator(store: Store, input: PostInput): { id: number; at: string } {
  return transaction(store.db, () => insertPost(store.db, RESERVED_HANDLE, input));
}

/** A skipped commit check is a broadcast hint, never a lead wake. */
export function chatPostCommitMiss(store: Store, body: string): { id: number; at: string } {
  return transaction(store.db, () => insertPost(store.db, 'git', { body, to: 'all', wake: false }));
}

/** One non-waking docs-owner hint; preserve the supplied range even when notes are cut. */
export function chatPostDocsNote(store: Store, owner: string, lines: string[]): { id: number; at: string } {
  if (owner === 'all') throw new Error('owner must be one handle, not all');
  const full = lines.at(-1)!;
  if (!/^full: git log --grep '\^Docs:' [a-fA-F0-9]{40,64}\.\.[a-fA-F0-9]{40,64}(?![\s\S])/.test(full)) {
    throw new Error('last line must contain the full git log range');
  }
  const notes = Array.from(lines.slice(0, -1).join('\n'));
  const budget = 600 - Array.from(full).length - 1;
  const body = `${notes.slice(0, budget).join('')}\n${full}`;
  return transaction(store.db, () => insertPost(store.db, 'git', { body, to: [owner], wake: false, class: 'fyi' }));
}

/** The live handle a session currently holds, or null when none. */
export function chatLiveHandle(store: Store, session?: string): string | null {
  if (typeof session !== 'string' || !session) return null;
  return sessionHandle(store.db, session) ?? null;
}

/**
 * The round table's ONE daemon post (operator #19423): author `table`, no binding, to every
 * distinct member lead handle with wake, or a log line (no `to`) when none is set — never `all`
 * with wake. The check-and-set of `data.tablePosted` on the first member and the post insert share
 * one transaction, so two members settling together cannot double-post.
 */
export function chatPostTable(store: Store, input: { firstId: string; leadHandles: string[]; body: string }): { id: number; at: string } | null {
  return transaction(store.db, () => {
    const row = store.db.prepare('SELECT data FROM seats WHERE id = ?').get(input.firstId) as { data: string } | undefined;
    if (!row) throw new Error(`no seat '${input.firstId}'`);
    const data = JSON.parse(row.data) as Record<string, unknown>;
    if (data.tablePosted === true) return null;
    const to = input.leadHandles.length ? input.leadHandles : undefined;
    const post = insertPost(store.db, 'table', { body: input.body, to, wake: input.leadHandles.length > 0 });
    store.db.prepare('UPDATE seats SET data = ? WHERE id = ?').run(JSON.stringify({ ...data, tablePosted: true }), input.firstId);
    return post;
  });
}

function rowToPost(row: Record<string, unknown>): ChatPost {
  return {
    id: row.id as number, at: row.at as string, author: row.author as string, body: row.body as string,
    to: row.to_json === null ? null : JSON.parse(row.to_json as string) as ChatAddress,
    wake: row.wake === 1,
  };
}

/** The loopback board's read-only log: newest window, displayed oldest first; post selects one id instead. */
export function chatList(store: Store, { after = 0, limit = 50, held = [], post, requests = new Map() }: {
  after?: number; limit?: number; held?: string[]; post?: number; requests?: ReadonlyMap<string, number>;
} = {}): {
  posts: (ChatPost & { delivered: string[]; confirmed: string[]; receipts: ChatReceipt[] })[];
  handles: ChatBinding[];
  watchers: number;
} {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a non-negative safe integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1-200');
  if (!Array.isArray(held) || !held.every((session) => typeof session === 'string')) {
    throw new Error('held must be an array of session ids');
  }
  if (post !== undefined && (!Number.isSafeInteger(post) || post <= 0)) throw new Error('post must be a positive safe integer');
  const bindings = liveBindingsSeen(store.db, requests);
  const handles = bindings.map(rowToBinding);
  // The daemon's only liveness fact: which handles a held /chat/wake poll answers for right now.
  const heldHandles = new Map<string, number>();
  for (const session of held) {
    const handle = liveOf(store.db, 'session = ?', session)?.handle as string | undefined;
    if (handle !== undefined) heldHandles.set(handle, (heldHandles.get(handle) ?? 0) + 1);
  }
  const rows = post === undefined
    ? store.db.prepare('SELECT * FROM chat_posts WHERE id > ? ORDER BY id DESC LIMIT ?').all(after, limit).reverse()
    : store.db.prepare('SELECT * FROM chat_posts WHERE id = ?').all(post);
  const posts = rows.map((row) => ({ ...rowToPost(row), delivered: [] as string[], confirmed: [] as string[], receipts: [] as ChatReceipt[] }));
  if (posts.length) {
    const byId = new Map(posts.map((post) => [post.id, post]));
    const receiptRows = store.db.prepare(`SELECT post, handle, delivered_at, confirmed_at FROM chat_receipts
      WHERE post IN (${posts.map(() => '?').join(',')}) ORDER BY handle`).all(...byId.keys());
    const byPost = new Map<number, Map<string, { delivered_at: string | null; confirmed_at: string | null }>>();
    for (const receipt of receiptRows) {
      const row = { delivered_at: (receipt.delivered_at ?? null) as string | null, confirmed_at: (receipt.confirmed_at ?? null) as string | null };
      const mine = byPost.get(receipt.post as number) ?? new Map();
      mine.set(receipt.handle as string, row);
      byPost.set(receipt.post as number, mine);
      const post = byId.get(receipt.post as number)!;
      if (row.delivered_at !== null) post.delivered.push(receipt.handle as string);
      if (row.confirmed_at !== null) post.confirmed.push(receipt.handle as string);
    }
    const now = Date.now();
    for (const post of posts) {
      const stored = byPost.get(post.id) ?? new Map();
      // Hide silent broadcast-only rows after 24h; named handles and stored receipts stay
      // listed. This display filter never changes unread eligibility or the wake snapshot.
      const broadcast = isBroadcast(post.to);
      const named = Array.isArray(post.to) ? post.to : [];
      const addressees = new Set<string>([
        ...(broadcast ? bindings.filter((binding) => binding.handle !== post.author && now - Date.parse(binding.lastSeen) <= 24 * 60 * 60 * 1000)
          .map((binding) => binding.handle) : []),
        ...named.filter((handle) => handle !== post.author && handle !== 'all'),
        ...stored.keys(),
      ]);
      for (const handle of [...addressees].sort()) {
        const row = stored.get(handle);
        const state: ChatReceiptState = row?.confirmed_at !== null && row?.confirmed_at !== undefined ? 'read'
          : row?.delivered_at ? 'delivered'
            : heldHandles.has(handle) || now - Date.parse(post.at) < NO_WATCHER_AFTER_MS ? 'pending' : 'no watcher';
        post.receipts.push({ handle, state, ...(row?.delivered_at ? { delivered_at: row.delivered_at } : {}), ...(row?.confirmed_at ? { confirmed_at: row.confirmed_at } : {}) });
      }
    }
  }
  return { posts, handles, watchers: [...heldHandles.values()].reduce((total, count) => total + count, 0) };
}

/** Shared handle-scoped eligibility; hook retries stop at two, explicit reads do not. */
function unreadWhere(db: Store['db'], handle: string, hook: boolean): { where: string; args: string[] } {
  const { first } = db.prepare('SELECT MIN(bound_at) AS first FROM chat_bindings WHERE handle = ?')
    .get(handle) as { first: string };
  return {
    where: `p.author != ? AND p.at > ? AND (
      p.to_json = '"all"' OR (json_type(p.to_json) = 'array' AND
        EXISTS (SELECT 1 FROM json_each(p.to_json) WHERE value IN (?, 'all')))
    ) AND NOT EXISTS (SELECT 1 FROM chat_receipts r WHERE r.post = p.id AND r.handle = ?
      AND (r.confirmed_at IS NOT NULL${hook ? ' OR r.tries >= 2' : ''}))`,
    args: [handle, first, handle, handle],
  };
}

function sessionHandle(db: Store['db'], session: string): string | undefined {
  if (typeof session !== 'string' || !session) throw new Error('session must be a non-empty string');
  return liveOf(db, 'session = ?', session)?.handle as string | undefined;
}

/** The hook's oldest pending window. Offering posts never writes a receipt. */
export function chatPending(store: Store, { session, limit = 20 }: { session: string; limit?: number }): { posts: ChatPost[]; more: number } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1-200');
  const handle = sessionHandle(store.db, session);
  if (!handle) return { posts: [], more: 0 };
  const { where, args } = unreadWhere(store.db, handle, true);
  const rows = store.db.prepare(`SELECT p.* FROM chat_posts p WHERE ${where} ORDER BY p.id LIMIT ?`).all(...args, limit);
  const { n } = store.db.prepare(`SELECT COUNT(*) AS n FROM chat_posts p WHERE ${where}`).get(...args) as { n: number };
  return { posts: rows.map(rowToPost), more: n - rows.length };
}

/**
 * Release a held poll only for a never-delivered unread post with `wake`, from any
 * author (operator decision 15057). `since` stays accepted because sessions that
 * started before the restart still send it; the daemon no longer reads it. A
 * delivered wake post does not release again. A log line never qualifies (unread
 * is addressed by definition) and retries alone must not start another turn.
 */
export function chatWakePending(store: Store, session: string, since?: string): ReturnType<typeof chatPending> | null {
  const handle = sessionHandle(store.db, session);
  if (!handle) throw new Error('session must hold a live binding');
  void since;
  const { where, args } = unreadWhere(store.db, handle, true);
  const wake = store.db.prepare(`SELECT 1 FROM chat_posts p WHERE ${where}
    AND NOT EXISTS (SELECT 1 FROM chat_receipts r WHERE r.post = p.id AND r.handle = ?
      AND r.delivered_at IS NOT NULL)
    AND p.wake = 1 LIMIT 1`)
    .get(...args, handle);
  return wake ? chatPending(store, { session }) : null;
}

type ReceiptInput = { session: string; posts: number[] };

function receiptPosts(posts: number[]): number[] {
  if (!Array.isArray(posts) || posts.length > 200 ||
    !Array.from(posts).every((post) => Number.isSafeInteger(post) && post > 0)) {
    throw new Error('posts must be an array of at most 200 positive safe integer ids');
  }
  return [...new Set(posts)];
}

/** Called only after hook output is flushed; duplicate ids count once per request. */
export function chatDelivered(store: Store, { session, posts }: ReceiptInput): { delivered: number } {
  const ids = receiptPosts(posts);
  return transaction(store.db, () => {
    const handle = sessionHandle(store.db, session);
    if (!handle || !ids.length) return { delivered: 0 };
    const { where, args } = unreadWhere(store.db, handle, true);
    const rows = store.db.prepare(`SELECT p.id FROM chat_posts p WHERE ${where}
      AND p.id IN (${ids.map(() => '?').join(',')}) ORDER BY p.id`).all(...args, ...ids);
    if (!rows.length) return { delivered: 0 };
    const at = chatAt(store.db);
    const receipt = store.db.prepare(`INSERT INTO chat_receipts (post, handle, delivered_at, tries) VALUES (?, ?, ?, 1)
      ON CONFLICT (post, handle) DO UPDATE SET
        delivered_at = COALESCE(chat_receipts.delivered_at, excluded.delivered_at), tries = chat_receipts.tries + 1`);
    for (const row of rows) receipt.run(row.id as number, handle, at);
    return { delivered: rows.length };
  });
}

/** Transcript confirmation cannot manufacture delivery or change another handle's receipts. */
export function chatConfirmed(store: Store, { session, posts }: ReceiptInput): { confirmed: number } {
  const ids = receiptPosts(posts);
  return transaction(store.db, () => {
    const handle = sessionHandle(store.db, session);
    if (!handle || !ids.length) return { confirmed: 0 };
    const { changes } = store.db.prepare(`UPDATE chat_receipts SET confirmed_at = ?
      WHERE handle = ? AND delivered_at IS NOT NULL AND confirmed_at IS NULL
      AND post IN (${ids.map(() => '?').join(',')})`).run(chatAt(store.db), handle, ...ids);
    return { confirmed: Number(changes) };
  });
}

/**
 * Unread is handle-scoped, including a predecessor's unconfirmed posts. Explicit reads
 * atomically deliver and confirm only the returned posts; all mode is a read-only log.
 */
export function chatRead(store: Store, input: Identity & { all?: boolean; limit?: number }): { posts: ChatPost[]; more: number } {
  return transaction(store.db, () => {
    requireLive(store.db, input);
    const { as, all = false, limit = 50 } = input;
    if (typeof all !== 'boolean') throw new Error('all must be a boolean');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1-200');
    let rows: Record<string, unknown>[];
    let count: number;
    if (all) {
      rows = store.db.prepare('SELECT * FROM chat_posts ORDER BY id DESC LIMIT ?').all(limit).reverse();
      count = (store.db.prepare('SELECT COUNT(*) AS n FROM chat_posts').get() as { n: number }).n;
    } else {
      const { where, args } = unreadWhere(store.db, as, false);
      rows = store.db.prepare(`SELECT p.* FROM chat_posts p WHERE ${where} ORDER BY p.id LIMIT ?`).all(...args, limit);
      count = (store.db.prepare(`SELECT COUNT(*) AS n FROM chat_posts p WHERE ${where}`).get(...args) as { n: number }).n;
      if (rows.length) {
        const at = chatAt(store.db);
        const receipt = store.db.prepare(`INSERT INTO chat_receipts (post, handle, delivered_at, confirmed_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (post, handle) DO UPDATE SET
            delivered_at = COALESCE(chat_receipts.delivered_at, excluded.delivered_at), confirmed_at = excluded.confirmed_at`);
        for (const row of rows) receipt.run(row.id as number, as, at, at);
      }
    }
    return { posts: rows.map(rowToPost), more: count - rows.length };
  });
}
