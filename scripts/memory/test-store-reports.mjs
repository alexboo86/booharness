#!/usr/bin/env node

import assert from 'node:assert/strict';

import { SESSION_SCOPE_SQL } from './store.mjs';
import { createTask, fixture, lessonLinks, request, runStoreTests, test } from './store-test-helpers.mjs';

test('a report is delivered by session and comes back whole, body and all', () => {
  const fx = fixture();
  try {
    const mine = 'attempt-0198';
    const theirs = 'attempt-0199';
    for (const [session, agent, verdict] of [
      [mine, 'kimi-reviewer', 'REQUEST_CHANGES'],
      [theirs, 'grok-reviewer', 'APPROVE'],
    ]) {
      request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'report',
        title: `review ${agent}`,
        body: JSON.stringify({ verdict }),
        session_id: session,
        agent,
      }, fx.token);
    }

    const mineOnly = request(
      fx.memory, 'GET', `/api/memory/search?session=${mine}&kind=report`,
    ).json;
    assert.equal(mineOnly.length, 1, 'one attempt, one report');
    assert.equal(mineOnly[0].agent, 'kimi-reviewer');
    // The BODY, not a snippet: an excerpt of a report is not a report.
    assert.equal(JSON.parse(mineOnly[0].body).verdict, 'REQUEST_CHANGES');

    // Handing one member's verdict to another is the worst failure this channel
    // exists to prevent, so the lookup is by identity and never by wording.
    const theirsOnly = request(
      fx.memory, 'GET', `/api/memory/search?session=${theirs}&kind=report`,
    ).json;
    assert.equal(theirsOnly.length, 1);
    assert.equal(JSON.parse(theirsOnly[0].body).verdict, 'APPROVE');
  } finally {
    fx.close();
  }
});

test('two attempts filing the SAME report body each keep their own row', () => {
  // The shape that was losing complete reviews. The completion contract asks
  // every member for the constant title `review`, so two seats that agree - or
  // one seat re-attempted after a technical failure - deliver byte-identical
  // bodies under the same title. Keyed without the session, the second was
  // answered `200 dedup:true` against the first attempt's row and read back
  // EMPTY under its own session: a delivered report discarded, its author told
  // the delivery had succeeded.
  const fx = fixture();
  try {
    const body = JSON.stringify({ verdict: 'APPROVE' });
    const first = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'report', title: 'review', body, session_id: 'attempt-A', agent: 'grok-reviewer',
    }, fx.token);
    const second = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'report', title: 'review', body, session_id: 'attempt-B', agent: 'kimi-reviewer',
    }, fx.token);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.json.dedup, false);
    assert.equal(second.json.dedup, false, 'a second attempt is a second delivery');
    assert.notEqual(second.json.id, first.json.id);

    // Read back exactly the way Svod reads it: by the identity it put in the
    // member's environment. Both must answer, and each with its own author.
    for (const [session, agent] of [['attempt-A', 'grok-reviewer'], ['attempt-B', 'kimi-reviewer']]) {
      const found = request(fx.memory, 'GET', `/api/memory/search?session=${session}&kind=report`).json;
      assert.equal(found.length, 1, `${session} reads back its own report`);
      assert.equal(found[0].agent, agent);
      assert.equal(found[0].body, body);
    }
  } finally {
    fx.close();
  }
});

test('one attempt filing the same report twice is still one delivery', () => {
  // The other half of the same rule: widening the key must not turn an
  // idempotent retry into a duplicate row. Same session, same bytes, one row.
  const fx = fixture();
  try {
    const entry = {
      kind: 'report', title: 'review', body: JSON.stringify({ verdict: 'APPROVE' }),
      session_id: 'attempt-A', agent: 'grok-reviewer',
    };
    const first = request(fx.memory, 'POST', '/api/memory/append', entry, fx.token);
    const retry = request(fx.memory, 'POST', '/api/memory/append', entry, fx.token);
    assert.equal(retry.json.dedup, true);
    assert.equal(retry.json.id, first.json.id);
    assert.equal(
      request(fx.memory, 'GET', '/api/memory/search?session=attempt-A&kind=report').json.length,
      1,
    );
  } finally {
    fx.close();
  }
});

test('every other kind dedups across sessions exactly as before', () => {
  // The session was added to the identity of a DELIVERY, not of a fact. Two
  // sessions arriving at the same reference hold one reference between them,
  // and widening the key for everything would have quietly retired dedup.
  const fx = fixture();
  try {
    const entry = { kind: 'reference', title: 'SQLite rules', body: 'WAL is durable.' };
    const first = request(fx.memory, 'POST', '/api/memory/append', {
      ...entry, session_id: 'session-A',
    }, fx.token);
    const second = request(fx.memory, 'POST', '/api/memory/append', {
      ...entry, session_id: 'session-B',
    }, fx.token);
    assert.equal(second.json.dedup, true);
    assert.equal(second.json.id, first.json.id);
  } finally {
    fx.close();
  }
});

test('a report body that is not JSON is refused at the door', () => {
  // The junk row must never exist, because the read-back is newest-first and a
  // junk newest is a refusal that vetoes an earlier valid delivery. Refusing
  // here costs the member one line while it still has the context to fix it.
  const fx = fixture();
  try {
    const prose = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'report', title: 'review', body: 'I delivered too early, see my message',
      session_id: 'attempt-A', agent: 'grok-reviewer',
    }, fx.token);
    assert.equal(prose.status, 400);
    assert.match(prose.text, /JSON object itself/);
    assert.equal(
      request(fx.memory, 'GET', '/api/memory/search?session=attempt-A&kind=report').json.length,
      0,
      'a refused delivery leaves no row behind',
    );

    // Any JSON passes: what SHAPE a report must take belongs to the profile that
    // asked for it, and the store does not get to have an opinion about it.
    const criteria = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'report', title: 'review', body: JSON.stringify({ criteria: [] }),
      session_id: 'attempt-A', agent: 'grok-reviewer',
    }, fx.token);
    assert.equal(criteria.status, 200);

    // And the gate is the KIND's, not everyone's: prose is what most kinds are.
    assert.equal(
      request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'reference', title: 'prose is fine here', body: 'WAL is durable.',
      }, fx.token).status,
      200,
    );
  } finally {
    fx.close();
  }
});

test('the live dedup index carries the same scope the queries compare', () => {
  // A unique index the queries do not match is not dedup: the lookup misses,
  // the INSERT hits the constraint, and the write is lost behind a 500 instead
  // of returning the row it duplicates. The migration spells the expression out
  // as frozen history, so THIS is what fails when `SESSION_SCOPED_KINDS` gains
  // a kind and nobody writes the migration that teaches the index about it.
  const fx = fixture();
  try {
    const ddl = fx.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_mem_entries_live_dedup'`,
    ).get().sql;
    const normalise = (value) => value.replace(/\s+/g, ' ').trim();
    assert.ok(
      normalise(ddl).includes(normalise(SESSION_SCOPE_SQL)),
      `index DDL does not carry the scope the code compares:\n  index: ${normalise(ddl)}\n  code:  ${normalise(SESSION_SCOPE_SQL)}`,
    );
  } finally {
    fx.close();
  }
});

test('reports are admitted to the store and kept out of the hot digest', () => {
  const fx = fixture();
  try {
    request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'report',
      title: 'review kimi-reviewer',
      body: JSON.stringify({ verdict: 'APPROVE' }),
      session_id: 'attempt-0198',
      agent: 'kimi-reviewer',
    }, fx.token);
    request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'yesterday', body: 'prose', no_open_work: true,
    }, fx.token);

    const hot = fx.memory.renderHot(12);
    assert.ok(!hot.includes('review kimi-reviewer'), `a report must not ride the digest:\n${hot}`);
    assert.match(hot, /yesterday/, 'while durable memory still does');

    // Asked for BY NAME it still answers - admitted to the store, absent from
    // the default digest, which is the whole difference between the two lists.
    assert.match(fx.memory.renderHot(12, 'report'), /review kimi-reviewer/);
  } finally {
    fx.close();
  }
});

test('hot surfaces the ready queue and the open-tail count above the prose', () => {
  const fx = fixture();
  try {
    createTask(fx, { title: 'P0 tail', priority: 'P0' });
    const blocked = createTask(fx, {
      title: 'blocked tail', status: 'blocked', blocked_reason: 'waiting on operator',
    }).json;
    request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'yesterday', body: 'prose', no_open_work: true,
    }, fx.token);

    const hot = fx.memory.renderHot(12);
    assert.match(hot, /## tasks/);
    assert.match(hot, /P0 tail/);
    assert.match(hot, /blocked tail/);
    assert.match(hot, /waiting on operator/);
    // the digest must state the ready queue before the narrative, so a session
    // that reads only the top of hot still sees what is open.
    assert.ok(hot.indexOf('## tasks') < hot.indexOf('## handoff'));

    request(fx.memory, 'POST', '/api/memory/task/update', {
      id: blocked.id, status: 'done', evidence: 'fixture: closed by this test',
    }, fx.token);
    assert.equal(/blocked tail/.test(fx.memory.renderHot(12)), false);
  } finally {
    fx.close();
  }
});

test('a decision closes the tasks it withdraws, cancelled, with itself as the evidence', () => {
  const fx = fixture();
  try {
    const parity = createTask(fx, { title: 'server elements parity on both nodes' }).json;
    const cache = createTask(fx, { title: 'server elements window cache' }).json;
    const unrelated = createTask(fx, { title: 'billing gap on host-b' }).json;
    const decision = {
      kind: 'decision', title: 'server elements stopped', body: 'the subject of both tasks is gone',
      closes: [parity.id, cache.id], agent: 'claude', session_id: 'session-a',
    };
    const decided = request(fx.memory, 'POST', '/api/memory/append', decision, fx.token);
    assert.equal(decided.status, 200);
    assert.deepEqual(decided.json.closed_tasks, [parity.id, cache.id]);
    for (const id of [parity.id, cache.id]) {
      const row = request(fx.memory, 'GET', `/api/memory/task?id=${id}`).json;
      assert.equal(row.status, 'cancelled');
      assert.ok(row.closed_ts > 0);
      assert.deepEqual(row.handoffs, [decided.json.id]);
      assert.equal(row.links.closed_evidence, `memory#${decided.json.id}`);
    }
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${unrelated.id}`).json.status, 'open');

    // A retry of the same decision is the same fact: 200, nothing reopened.
    const retry = request(fx.memory, 'POST', '/api/memory/append', decision, fx.token);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.dedup, true);

    const unknown = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'withdraws a task that does not exist', body: 'b', closes: [9999], agent: 'claude',
    }, fx.token);
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error, /decision closes unknown task 9999/);

    // Every other kind refuses the list instead of dropping it (it was a silent 200).
    const stray = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'feedback', title: 'not a decision', body: 'b', closes: [unrelated.id], agent: 'claude',
    }, fx.token);
    assert.equal(stray.status, 400);
    assert.match(stray.json.error, /a feedback closes no task/);
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${unrelated.id}`).json.status, 'open');
  } finally {
    fx.close();
  }
});

test('closing a task by hand needs its evidence, and the evidence is kept', () => {
  const fx = fixture();
  try {
    const task = createTask(fx, { title: 'close me with proof' }).json;
    const bare = request(fx.memory, 'POST', '/api/memory/task/update', { id: task.id, status: 'done' }, fx.token);
    assert.equal(bare.status, 400);
    assert.match(bare.json.error, new RegExp(`memoryctl task done --id ${task.id} --evidence`));
    const bareCancel = request(fx.memory, 'POST', '/api/memory/task/update', { id: task.id, status: 'cancelled' }, fx.token);
    assert.equal(bareCancel.status, 400);
    assert.match(bareCancel.json.error, new RegExp(`memoryctl task update --id ${task.id} --status cancelled --evidence`));
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${task.id}`).json.status, 'open');

    const notClosing = request(fx.memory, 'POST', '/api/memory/task/update', { id: task.id, next_action: 'x', evidence: 'a1b2c3d' }, fx.token);
    assert.equal(notClosing.status, 400);
    assert.match(notClosing.json.error, /not being closed/);

    const ok = request(fx.memory, 'POST', '/api/memory/task/update', { id: task.id, status: 'done', evidence: 'commit a1b2c3d4e' }, fx.token);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, 'done');
    assert.equal(ok.json.links.closed_evidence, 'commit a1b2c3d4e');
    // Re-labelling a task that is already closed needs no new proof.
    assert.equal(request(fx.memory, 'POST', '/api/memory/task/update', { id: task.id, status: 'cancelled' }, fx.token).status, 200);

    assert.equal(createTask(fx, { title: 'born finished without any proof', status: 'done' }).status, 400);
    const born = createTask(fx, { title: 'born finished with its proof', status: 'done', evidence: 'memory#1' });
    assert.equal(born.status, 200);
    assert.equal(born.json.links.closed_evidence, 'memory#1');

    const tail = createTask(fx, { title: 'finished inside a session' }).json;
    const handoff = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'closed it', closes: [tail.id], no_open_work: true, agent: 'claude', session_id: 'session-b',
    }, fx.token);
    assert.equal(handoff.status, 200);
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${tail.id}`).json.links.closed_evidence, `memory#${handoff.json.id}`);
  } finally {
    fx.close();
  }
});

test('hot shows how many entries carried an open task, and carrying it is never refused', () => {
  const fx = fixture();
  try {
    const carried = createTask(fx, { title: 'carried from session to session' }).json;
    for (const day of [1, 2, 3]) {
      const handoff = request(fx.memory, 'POST', '/api/memory/handoff', {
        title: `day ${day}`, body: `prose of day ${day}`, tasks: [carried.id],
      }, fx.token);
      assert.equal(handoff.status, 200);
    }
    const fresh = createTask(fx, { title: 'written a minute ago' }).json;
    const hot = fx.memory.renderHot(12);
    assert.match(hot, new RegExp(`#${carried.id} open ×3 `));
    assert.doesNotMatch(hot, new RegExp(`#${fresh.id} open ×`));
  } finally {
    fx.close();
  }
});

test('entries lists complete live lesson/handoff rows without search or delivery limits', () => {
  const fx = fixture();
  try {
    assert.deepEqual(request(fx.memory, 'GET', '/api/memory/entries?kind=lesson').json, []);
    const ids = [];
    for (let i = 0; i < 205; i++) {
      const r = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title: `enumeration ${i}`, body: `full body ${i}`,
        links: lessonLinks({ status: i === 1 ? 'inbox' : 'active' }),
      }, fx.token);
      assert.equal(r.status, 200);
      ids.push(r.json.id);
    }
    const replaced = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: ids[0], title: 'retired enumeration', body: 'retired body',
      links: lessonLinks({ status: 'retired' }),
    }, fx.token);
    assert.equal(replaced.status, 200);
    const handoff = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'enumeration handoff', body: 'full handoff body', no_open_work: true,
      links: { track: 'memory-service', status: 'active', next: 'verify' },
    }, fx.token);
    assert.equal(handoff.status, 200);
    const rows = request(fx.memory, 'GET', '/api/memory/entries?kind=lesson').json;
    assert.equal(rows.length, 205);
    assert.ok(rows.every(row => row.superseded_by === null && row.kind === 'lesson'));
    assert.ok(!rows.some(row => row.id === ids[0]));
    assert.deepEqual(rows.map(row => row.id), [...rows.map(row => row.id)].sort((a, b) => a - b));
    assert.equal(rows.find(row => row.id === ids[204]).body, 'full body 204');
    assert.equal(JSON.parse(rows.find(row => row.id === ids[1]).links).status, 'inbox');
    assert.equal(JSON.parse(rows.find(row => row.id === replaced.json.id).links).status, 'retired');
    assert.equal(request(fx.memory, 'GET', '/api/memory/entries?kind=handoff').json[0].id, handoff.json.id);
    for (const query of ['', '?kind=unknown', '?kind=report']) {
      assert.equal(request(fx.memory, 'GET', `/api/memory/entries${query}`).status, 400);
    }
    assert.equal(request(fx.memory, 'POST', '/api/memory/entries?kind=lesson').status, 405);
  } finally { fx.close(); }
});

await runStoreTests();
