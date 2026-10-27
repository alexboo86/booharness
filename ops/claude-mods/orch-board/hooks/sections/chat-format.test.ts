import { expect, test } from 'claude-code/testing'

const assert = {
  equal(actual: unknown, expected: unknown): void { expect(actual).toBe(expected) },
  deepEqual(actual: unknown, expected: unknown): void { expect(actual).toEqual(expected) },
  ok(actual: unknown): void { expect(actual).toBeTruthy() },
  match(actual: string, expected: RegExp): void { expect(actual).toMatch(expected) },
  doesNotMatch(actual: string, expected: RegExp): void { expect(actual).not.toMatch(expected) },
}

import { chatFoldTitle, chatTime, liveHandlesText, nickColor, postAddress, postReceipts, unreadCount } from './chat-format';
import type { ChatFeedPost } from './chat-format';

function post(overrides: Partial<ChatFeedPost> = {}): ChatFeedPost {
  return {
    id: 1, at: '2026-10-14T09:05:00Z', author: 'lead', body: 'line one\nline two',
    to: ['coder'], wake: false, delivered: [], confirmed: [], ...overrides,
  };
}

test('chat timestamps are zero-padded local HH:MM, including midnight', () => {
  assert.equal(chatTime(new Date(2026, 9, 14, 9, 5).toISOString()), '09:05');
  assert.equal(chatTime(new Date(2026, 9, 14, 0, 0).toISOString()), '00:00');
});

test('nicknames retain five stable tones, unsigned overflow and the operator accent', () => {
  for (const [handle, color] of [
    ['d', 'success'], ['e', 'warning'], ['a', 'error'],
    ['b', 'permission'], ['c', 'subtle'], ['operator', 'claude'],
    // The web hash (dashboard.ts:424) is 841118258, class c3.
    ['coder-codex-e19b0c', 'permission'],
  ] as const) assert.equal(nickColor(handle), color);
});

test('live handles keep daemon order and distinguish an absent watcher count from zero', () => {
  assert.equal(liveHandlesText(['z', 'a'], 3), 'Live handles: z, a · 3 watching');
  assert.equal(liveHandlesText([], 0), 'Live handles: none · 0 watching');
  assert.equal(liveHandlesText([]), 'Live handles: none');
});

test('addresses distinguish unaddressed posts, explicit recipients and both broadcasts', () => {
  assert.equal(postAddress(null), null);
  assert.equal(postAddress(['z', 'a']), 'z, a:');
  assert.equal(postAddress('all'), 'all:');
  assert.equal(postAddress(['coder', 'all']), 'all:');
  assert.equal(postAddress([]), ':');
});

test('explicit receipt states override derived delivery/read, without reordering addressees', () => {
  assert.deepEqual(postReceipts(post({
    to: ['sleeping', 'read', 'delivered', 'pending', 'queued'],
    confirmed: ['sleeping', 'read'],
    delivered: ['sleeping', 'read', 'delivered', 'queued'],
    receipts: [{ handle: 'sleeping', state: 'no watcher' }, { handle: 'queued', state: 'queued' }],
  }), ['unrelated']), [
    { handle: 'sleeping', state: 'no watcher', tooltip: 'sleeping: no watcher' },
    { handle: 'read', state: 'read', tooltip: 'read: read' },
    { handle: 'delivered', state: 'delivered', tooltip: 'delivered: delivered' },
    { handle: 'pending', state: 'pending', tooltip: 'pending: pending' },
    { handle: 'queued', state: 'queued', tooltip: 'queued: queued' },
  ]);
});

test('broadcast receipts include live and historical recipients once, in first-seen order', () => {
  for (const to of ['all', ['all']] as const) {
    assert.deepEqual(postReceipts(post({
      to: to === 'all' ? to : [...to],
      delivered: ['left', 'coder'], confirmed: ['read', 'left'],
      receipts: [{ handle: 'sleeping', state: 'no watcher' }, { handle: 'coder', state: 'delivered' }],
    }), ['lead', 'coder', 'other', 'coder']), [
      { handle: 'coder', state: 'delivered', tooltip: 'coder: delivered' },
      { handle: 'other', state: 'pending', tooltip: 'other: pending' },
      { handle: 'left', state: 'read', tooltip: 'left: read' },
      { handle: 'read', state: 'read', tooltip: 'read: read' },
      { handle: 'sleeping', state: 'no watcher', tooltip: 'sleeping: no watcher' },
    ]);
  }
});

test('receipt tooltips keep valid delivery times and omit invalid timestamps', () => {
  const delivered = new Date(2026, 9, 14, 9, 5).toISOString();
  const confirmed = new Date(2026, 9, 14, 10, 7).toISOString();
  assert.deepEqual(postReceipts(post({
    to: ['coder', 'invalid'],
    delivered: ['invalid'],
    receipts: [
      { handle: 'coder', state: 'read', delivered_at: delivered, confirmed_at: confirmed },
      { handle: 'invalid', state: '', delivered_at: 'invalid', confirmed_at: 'invalid' },
    ],
  }), []), [
    { handle: 'coder', state: 'read', tooltip: 'coder: read · delivered 09:05 · confirmed 10:07' },
    { handle: 'invalid', state: 'delivered', tooltip: 'invalid: delivered' },
  ]);
});

test('unaddressed posts have no receipt footer even when delivery details exist', () => {
  assert.deepEqual(postReceipts(post({ to: null, delivered: ['coder'] }), ['coder']), []);
});

test('unread counts addressed posts that are not fully read, and ignores log lines', () => {
  assert.equal(unreadCount([
    post({ to: ['coder'], confirmed: ['coder'], receipts: [{ handle: 'coder', state: 'read' }] }),
    post({ id: 2, to: ['coder'], receipts: [{ handle: 'coder', state: 'delivered' }] }),
    post({ id: 3, to: null }),
  ], ['coder']), 1);
});

test('chat title carries counts only after the feed has loaded', () => {
  assert.equal(chatFoldTitle(null, null), 'Chat');
  assert.equal(chatFoldTitle(5, 4), 'Chat · 5 · 4 unread');
  assert.equal(chatFoldTitle(0, 0), 'Chat · 0 · 0 unread');
});
