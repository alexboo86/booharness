#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createTask, fixture, request, runStoreTests, test } from './store-test-helpers.mjs';

test('status-only supersede with identical body succeeds (v2 live-only dedup)', () => {
  const fx = fixture();
  try {
    const original = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson',
      title: 'Inbox lesson',
      body: 'same body before and after promotion',
      links: {
        domain: 'domain-harness',
      anchor: 'scripts/memory/store.mjs:createMemory',
        status: 'inbox',
      },
    }, fx.token).json;
    // promote: SAME title + SAME body, only links.status flips — v1 schema 409'd here
    const promoted = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: original.id,
      title: 'Inbox lesson',
      body: 'same body before and after promotion',
      links: {
        domain: 'domain-harness',
      anchor: 'scripts/memory/store.mjs:createMemory',
        status: 'active',
      },
    }, fx.token);
    assert.equal(promoted.status, 200);
    assert.equal(promoted.json.version, 2);
    // append-dedup still catches a live duplicate
    const dup = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson',
      title: 'Inbox lesson',
      body: 'same body before and after promotion',
      links: {
        domain: 'domain-harness',
      anchor: 'scripts/memory/store.mjs:createMemory',
        status: 'active',
      },
    }, fx.token).json;
    assert.equal(dup.dedup, true);
    assert.equal(dup.id, promoted.json.id);
  } finally {
    fx.close();
  }
});

test('supersede keeps one live chain and removes old versions from search', () => {
  const fx = fixture();
  try {
    const original = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson',
      title: 'Memory lifecycle',
      body: 'legacyneedle must disappear',
      links: {
        domain: 'domain-harness',
      anchor: 'scripts/memory/store.mjs:createMemory',
        status: 'active',
      },
    }, fx.token).json;
    const second = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: original.id,
      title: 'Memory lifecycle v2',
      body: 'middleneedle must disappear too',
    }, fx.token);
    assert.equal(second.status, 200);
    assert.equal(second.json.version, 2);

    const third = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: second.json.id,
      title: 'Memory lifecycle v3',
      body: 'durableneedle stays searchable',
    }, fx.token);
    assert.equal(third.status, 200);
    assert.equal(third.json.version, 3);

    const staleWrite = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: original.id,
      title: 'Stale branch',
      body: 'must not be inserted',
    }, fx.token);
    assert.equal(staleWrite.status, 409);

    assert.deepEqual(request(fx.memory, 'GET', '/api/memory/search?q=legacyneedle*').json, []);
    assert.deepEqual(request(fx.memory, 'GET', '/api/memory/search?q=middleneedle*').json, []);
    const live = request(fx.memory, 'GET', '/api/memory/search?q=durableneedle*');
    assert.equal(live.status, 200);
    assert.deepEqual(live.json.map((entry) => entry.id), [third.json.id]);

    const chain = [...fx.memory.dumpEntries()];
    assert.equal(chain.length, 3);
    assert.equal(Number(chain[0].superseded_by), second.json.id);
    assert.equal(Number(chain[1].supersedes), original.id);
    assert.equal(Number(chain[1].superseded_by), third.json.id);
    assert.equal(Number(chain[2].supersedes), second.json.id);
    assert.equal(chain[2].superseded_by, null);
    assert.deepEqual(fx.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(fx.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    fx.close();
  }
});

test('explicit FTS search pages deterministically and rejects invalid offsets', () => {
  const fx = fixture();
  try {
    const ids = [];
    for (let index = 0; index < 5; index += 1) {
      const result = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'decision', title: `paged marker ${index}`, body: `CONTRADICTS id ${index + 1}`,
      }, fx.token);
      assert.equal(result.status, 200);
      ids.push(result.json.id);
    }
    const q = 'q=body%3A%22CONTRADICTS%20id%22&limit=2';
    const pages = [0, 2, 4, 6].map(offset => request(fx.memory, 'GET', `/api/memory/search?${q}&offset=${offset}`));
    assert.ok(pages.every(page => page.status === 200));
    assert.deepEqual(pages.map(page => page.json.length), [2, 2, 1, 0]);
    assert.deepEqual(new Set(pages.flatMap(page => page.json.map(row => row.id))), new Set(ids));
    assert.equal(request(fx.memory, 'GET', `/api/memory/search?${q}&offset=-1`).status, 400);
    assert.equal(request(fx.memory, 'GET', '/api/memory/search?q=plain&offset=2').status, 503,
      'plain search without an embedder refuses, rather than reverting to FTS');
  } finally { fx.close(); }
});

test('registry uses version-zero creation and rejects stale CAS updates', () => {
  const fx = fixture();
  try {
    const created = request(fx.memory, 'POST', '/api/memory/registry', {
      body: 'registry generation one',
      expected_version: 0,
      session_id: 'head-a',
      agent: 'claude',
    }, fx.token);
    assert.equal(created.status, 200);
    assert.equal(created.json.version, 1);

    const appendBypass = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'registry',
      key: 'bypass-registry',
      title: 'No CAS',
      body: 'must be rejected',
    }, fx.token);
    assert.equal(appendBypass.status, 400);
    assert.match(appendBypass.json.error, /CAS registry route/);

    const supersedeBypass = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: created.json.id,
      title: 'No CAS either',
      body: 'must also be rejected',
    }, fx.token);
    assert.equal(supersedeBypass.status, 400);
    assert.match(supersedeBypass.json.error, /CAS registry route/);

    const stale = request(fx.memory, 'POST', '/api/memory/registry', {
      body: 'stale writer must lose loudly',
      expected_version: 0,
      session_id: 'head-b',
      agent: 'codex',
    }, fx.token);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.current_version, 1);
    assert.equal(stale.json.current_body, 'registry generation one');

    const updated = request(fx.memory, 'POST', '/api/memory/registry', {
      body: 'registry generation two',
      expected_version: 1,
      session_id: 'head-b',
      agent: 'codex',
    }, fx.token);
    assert.equal(updated.status, 200);
    assert.equal(updated.json.version, 2);

    const current = request(fx.memory, 'GET', '/api/memory/registry');
    assert.equal(current.status, 200);
    assert.equal(current.json.version, 2);
    assert.equal(current.json.body, 'registry generation two');
  } finally {
    fx.close();
  }
});


test('the digest leads with open work, and old handoffs may not crowd it out', () => {
  // Measured 2026-08-05 on the live store: of 6 KB, handoff titles took 5260
  // bytes (88%) and the open-task block got 82 — the count line plus a note
  // saying the task lines had been CUT. The digest exists to say what is
  // unfinished; sixteen titles of finished narrative were eating that.
  const fx = fixture();
  try {
    for (let i = 0; i < 12; i += 1) {
      request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'handoff',
        title: `handoff number ${i} with a title long enough to cost real bytes`,
        body: `narrative ${'h'.repeat(200)}`,
        no_open_work: true,
      }, fx.token);
    }
    for (let i = 0; i < 4; i += 1) {
      createTask(fx, { title: `open tail ${i}`, priority: 'P1', next_action: `step ${i}` });
    }

    const digest = fx.memory.renderHot(6);
    const handoffLines = digest.split(/\r?\n/).filter((line) => line.startsWith('- [handoff]'));
    assert.equal(handoffLines.length, 3, `the three newest handoffs, no more, belong in the digest: ${digest}`);
    assert.match(digest, /older handoff\(s\): memoryctl search --kind handoff/);
    // And what the digest is FOR survives: every open tail is on the page.
    for (let i = 0; i < 4; i += 1) {
      assert.match(digest, new RegExp(`open tail ${i}`), `task ${i} was crowded out: ${digest}`);
    }
    assert.doesNotMatch(digest, /task line\(s\) cut by budget/);
  } finally {
    fx.close();
  }
});

test('HOT shows the newest handoff of each track, dates every line, and counts hidden handoffs as omitted', () => {
  // 2026-09-11: with one handoff slot the digest showed whichever track wrote
  // last, so a same-day deploy handoff was invisible behind a news-screener one
  // and the lead answered server questions from older state. And because the
  // cap was applied at RENDER time, every hidden handoff still counted as
  // included: `omitted` under-reported by the whole handoff history.
  const fx = fixture();
  try {
    const append = (title, body) => request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'handoff', title, body, no_open_work: true,
    }, fx.token);
    append('deploy wal older', '<!-- track: raw-trades | status: active | next: x -->\nold deploy state');
    append('deploy wal newest', '<!-- track: raw-trades | status: active | next: y -->\nnew deploy state');
    append('news screener newest', '<!-- track: news-screener | status: paused | next: z -->\nnews');

    const digest = fx.memory.renderHot(12);
    const handoffLines = digest.split(/\r?\n/).filter((line) => line.startsWith('- [handoff]'));
    assert.equal(handoffLines.length, 2, `one line per track: ${digest}`);
    assert.match(digest, /deploy wal newest/);
    assert.match(digest, /news screener newest/);
    assert.doesNotMatch(digest, /deploy wal older/, 'an older handoff of an already shown track is hidden');
    request(fx.memory, 'POST', '/api/memory/append', { kind: 'decision', title: 'RETIRED: stray probe entry', body: 'x' }, fx.token);
    assert.doesNotMatch(fx.memory.renderHot(12), /stray probe entry/, 'an entry titled as history stays out of the digest');
    assert.match(digest, /1 older handoff\(s\): memoryctl search --kind handoff/);
    assert.match(digest, /<!-- omitted: 1 entries -->/, `the hidden handoff is omitted, not included: ${digest}`);
    for (const line of handoffLines) {
      assert.match(line, / · \d{4}-\d{2}-\d{2} — /, `every entry line says the day it was written: ${line}`);
    }
  } finally {
    fx.close();
  }
});

test('HOT rendering is deterministic, priority-bounded, and loud on pinned overflow', () => {
  const budgetFx = fixture();
  try {
    request(budgetFx.memory, 'POST', '/api/memory/append', {
      kind: 'archive',
      title: 'low-priority archive',
      body: `archive-only ${'a'.repeat(300)}`,
    }, budgetFx.token);
    request(budgetFx.memory, 'POST', '/api/memory/append', {
      kind: 'decision',
      title: 'high-priority decision',
      body: `decision-first ${'d'.repeat(300)}`,
    }, budgetFx.token);

    const first = budgetFx.memory.renderHot(0.45);
    const second = budgetFx.memory.renderHot(0.45);
    assert.equal(first, second);
    assert.match(first, /^<!-- hot-digest algo=v2 inputs=[a-f0-9]{64} generated-from=memory\.db -->/);
    const overHttp = request(budgetFx.memory, 'GET', '/api/memory/hot?budget_kb=0.45');
    assert.equal(overHttp.status, 200);
    assert.equal(overHttp.headers['Content-Type'], 'text/markdown; charset=utf-8');
    assert.equal(overHttp.text, first);
    assert.ok(Buffer.byteLength(first, 'utf8') <= Math.floor(0.45 * 1024));
    assert.match(first, /high-priority decision/);
    assert.doesNotMatch(first, /low-priority archive/);
    assert.match(first, /<!-- omitted: 1 entries -->/);
  } finally {
    budgetFx.close();
  }

  const pinnedFx = fixture();
  try {
    request(pinnedFx.memory, 'POST', '/api/memory/append', {
      kind: 'reference',
      title: `pinned-${'p'.repeat(300)}`,
      body: `must-survive ${'x'.repeat(300)}`,
      pinned: true,
    }, pinnedFx.token);
    const overflow = pinnedFx.memory.renderHot(0.1);
    assert.match(overflow, /<!-- PINNED OVERFLOW -->/);
    assert.match(overflow, /pinned-/);
  } finally {
    pinnedFx.close();
  }
});

test('HOT budget owns the open-task block: task lines are cut first, the count stays', () => {
  // The regression this guards, measured 2026-07-31: `memoryctl hot` returned
  // 8593 bytes at both --budget-kb 2 and --budget-kb 6, because the open-task
  // block never entered the budget - only the digest entries did.
  const fx = fixture();
  try {
    for (let index = 0; index < 25; index += 1) {
      const created = createTask(fx, { title: `open tail ${index} ${'t'.repeat(80)}` });
      assert.equal(created.status, 200);
    }
    request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'feedback',
      title: 'keep-the-feedback-section',
      body: 'feedback body',
    }, fx.token);

    const hot = fx.memory.renderHot(1);
    const bytes = Buffer.byteLength(hot, 'utf8');
    assert.ok(bytes <= 1024, `hot with budget_kb 1 must fit 1 KB, got ${bytes}`);
    // The count line survives even when every task line is cut - it is the
    // fixed-price form of the same fact.
    assert.match(hot, /## tasks \(25 open\)/);
    assert.match(hot, /\d+ task line\(s\) cut by budget: memoryctl task list/);
    const shownTaskLines = (hot.match(/open tail /g) || []).length;
    assert.ok(shownTaskLines < 25, `most task lines must be cut, ${shownTaskLines} survived`);
    // The entry sections (feedback included) and the omitted marker are not
    // what the budget eats first.
    assert.match(hot, /keep-the-feedback-section/);
    assert.match(hot, /<!-- omitted: /);
  } finally {
    fx.close();
  }
});

test('mutations reject missing tokens, oversized bodies, and invalid JSON fields', () => {
  const fx = fixture();
  try {
    const unauthorized = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'reference',
      title: 'Unauthorized',
      body: 'must not land',
    });
    assert.equal(unauthorized.status, 401);

    const oversized = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'reference',
      title: 'Too large',
      body: 'x'.repeat(256 * 1024 + 1),
    }, fx.token);
    assert.equal(oversized.status, 400);
    assert.match(oversized.json.error, /body exceeds 262144 bytes/);

    const invalidLinks = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'reference',
      title: 'Bad links',
      body: 'must not land either',
      links: '{broken',
    }, fx.token);
    assert.equal(invalidLinks.status, 400);
    assert.match(invalidLinks.json.error, /invalid JSON in links/);

    const unknownKind = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'hot',
      title: 'Digest is a projection',
      body: 'must not become a row',
    }, fx.token);
    assert.equal(unknownKind.status, 400);
    assert.match(unknownKind.json.error, /unknown kind: hot/);

    const missingBody = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'reference',
      title: 'No body',
    }, fx.token);
    assert.equal(missingBody.status, 400);
    assert.match(missingBody.json.error, /missing body/);

    const longTitle = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'reference',
      title: 't'.repeat(501),
      body: 'must not land',
    }, fx.token);
    assert.equal(longTitle.status, 400);
    assert.match(longTitle.json.error, /title exceeds 500 characters/);

    const rotatedToken = 'b'.repeat(64);
    fs.writeFileSync(fx.tokenPath, `${rotatedToken}\n`, { mode: 0o600 });
    const rotatedWrite = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'reference',
      title: 'Rotated token',
      body: 'lands after token re-read',
    }, rotatedToken);
    assert.equal(rotatedWrite.status, 200);
    const staleToken = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'reference',
      title: 'Stale token',
      body: 'must not land after rotation is observed',
    }, fx.token);
    assert.equal(staleToken.status, 401);
  } finally {
    fx.close();
  }
});

test('ten concurrent appends all land', async () => {
  const fx = fixture();
  try {
    const writes = await Promise.all(Array.from({ length: 10 }, (_, index) => Promise.resolve().then(() => (
      request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'chip',
        title: `Concurrent writer ${index}`,
        body: `concurrentneedle payload ${index}`,
        session_id: `session-${index}`,
        agent: 'codex',
      }, fx.token)
    ))));
    assert.ok(writes.every((write) => write.status === 200 && write.json.dedup === false));

    const found = request(fx.memory, 'GET', '/api/memory/search?q=concurrentneedle*&limit=200');
    assert.equal(found.status, 200);
    assert.equal(found.json.length, 10);
  } finally {
    fx.close();
  }
});

test('handoff, registry rendering, write notifications, dump, and export status integrate', () => {
  const fx = fixture();
  try {
    const writes = [];
    const unsubscribe = fx.memory.onWrite((event) => writes.push(event));
    const callbackErrors = [];
    const originalConsoleError = console.error;
    const stopFailingCallback = fx.memory.onWrite(() => {
      throw new Error('exporter unavailable');
    });

    let handoff;
    try {
      console.error = (...args) => callbackErrors.push(args.join(' '));
      handoff = request(fx.memory, 'POST', '/api/memory/handoff', {
        title: 'Session handoff',
        body: 'Exact handoff body',
        session_id: 'session-final',
        agent: 'codex',
        source_path: 'handoff_2026-07-18.md',
        no_open_work: true,
      }, fx.token);
    } finally {
      stopFailingCallback();
      console.error = originalConsoleError;
    }
    assert.equal(handoff.status, 200);
    assert.equal(callbackErrors.length, 1);
    assert.match(callbackErrors[0], /onWrite callback failed.*exporter unavailable/s);
    const listed = fx.memory.listHandoffs();
    assert.equal(listed.length, 1);
    assert.ok(Number.isSafeInteger(listed[0].ts) && listed[0].ts > 0);
    assert.deepEqual({ ...listed[0], ts: '<timestamp>' }, {
      id: handoff.json.id,
      title: 'Session handoff',
      ts: '<timestamp>',
      body: 'Exact handoff body',
      source_path: 'handoff_2026-07-18.md',
    });

    request(fx.memory, 'POST', '/api/memory/registry', {
      body: '# Live registry\nregistry body stays byte-exact\n',
      expected_version: 0,
      session_id: 'head',
      agent: 'claude',
    }, fx.token);
    assert.equal(
      fx.memory.renderRegistry(),
      '<!-- generated — write via memoryctl/MCP, manual edits will be overwritten -->\n# Live registry\nregistry body stays byte-exact\n',
    );

    unsubscribe();
    assert.deepEqual(writes.map((event) => event.kind), ['handoff', 'registry']);
    assert.equal([...fx.memory.dumpEntries()].length, 2);

    const unavailable = request(fx.memory, 'GET', '/api/memory/export_status');
    assert.equal(unavailable.status, 503);
    fx.memory.setExportStatusFn(() => ({ pending: true, last_error: null }));
    const available = request(fx.memory, 'GET', '/api/memory/export_status');
    assert.equal(available.status, 200);
    assert.deepEqual(available.json, { pending: true, last_error: null });
  } finally {
    fx.close();
  }
});

await runStoreTests();
