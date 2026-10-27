#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { SCHEMA_VERSION, createMemory, rerankSearchPool } from './store.mjs';
import { entryTextSha } from './embed-recipe.mjs';
import { pathToFileUrl, storeModulePath, createTask, fixture, request, runStoreTests, test } from './store-test-helpers.mjs';

test('tasks are created with a normalized shape and reject invalid fields', () => {
  const fx = fixture();
  try {
    const created = createTask(fx);
    assert.equal(created.status, 200);
    assert.equal(created.json.priority, 'P1');
    assert.equal(created.json.status, 'open');
    assert.equal(created.json.claimed_by, null);
    assert.deepEqual(created.json.depends_on, []);
    assert.ok(Number.isSafeInteger(created.json.id) && created.json.id > 0);

    const read = request(fx.memory, 'GET', `/api/memory/task?id=${created.json.id}`);
    assert.equal(read.status, 200);
    assert.equal(read.json.title, 'Rate-limit the pending-cap warn');
    assert.equal(read.json.next_action, 'wire the throttle into the writer');

    assert.equal(createTask(fx, { priority: 'urgent' }).status, 400);
    assert.equal(createTask(fx, { title: '   ' }).status, 400);
    assert.equal(createTask(fx, { status: 'nearly' }).status, 400);
    // blocked without a reason is the shape that made 36 handoffs unreadable:
    // "blocked" with nothing to act on is not a state, it is a shrug.
    assert.equal(createTask(fx, { status: 'blocked' }).status, 400);
    assert.equal(request(fx.memory, 'POST', '/api/memory/task', { title: 'no token' }).status, 401);
  } finally {
    fx.close();
  }
});

test('a claim is atomic: the second claimant loses and says so', () => {
  const fx = fixture();
  try {
    const task = createTask(fx).json;
    const first = request(fx.memory, 'POST', '/api/memory/task/claim', {
      id: task.id, agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(first.status, 200);
    assert.equal(first.json.claimed_by, 'claude');
    assert.equal(first.json.status, 'in_progress');

    const second = request(fx.memory, 'POST', '/api/memory/task/claim', {
      id: task.id, agent: 'grok', session_id: 'session-b',
    }, fx.token);
    assert.equal(second.status, 409);
    assert.match(second.json.error, /claimed by claude/);

    // the same agent re-claiming its own task is idempotent, not a collision:
    // a resumed session must not have to release first.
    const again = request(fx.memory, 'POST', '/api/memory/task/claim', {
      id: task.id, agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(again.status, 200);

    const released = request(fx.memory, 'POST', '/api/memory/task/release', {
      id: task.id,
    }, fx.token);
    assert.equal(released.status, 200);
    assert.equal(released.json.claimed_by, null);
    assert.equal(released.json.status, 'open');
  } finally {
    fx.close();
  }
});

test('P2 and P3 cannot be written: work below P1 is not a task', () => {
  // Operator decision 2026-08-05, after a sweep of 86 open tasks closed 40 P2
  // and 6 P3 in one pass: a priority nobody will ever reach is a landfill with
  // a query interface. Refused at the SERVICE, so neither CLI nor MCP can write one.
  const fx = fixture();
  try {
    for (const priority of ['P2', 'P3']) {
      const refused = createTask(fx, { title: `${priority} tail`, priority });
      assert.equal(refused.status, 400, priority);
      assert.match(refused.json.error, /P0|P1/);
      // A deny that does not carry the ready command is noise.
      assert.match(refused.json.error, /memoryctl task create/);
    }
    const ok = createTask(fx, { title: 'real tail', priority: 'P1' });
    assert.equal(ok.status, 200);
    // Nor by the back door of an update.
    const downgraded = request(fx.memory, 'POST', '/api/memory/task/update', {
      id: ok.json.id, priority: 'P2',
    }, fx.token);
    assert.equal(downgraded.status, 400);
    assert.match(downgraded.json.error, /memoryctl task create/);
  } finally {
    fx.close();
  }
});

test('rows written before the retirement stay readable, listable and closable', () => {
  // The gate is on WRITES. 46 closed P2/P3 rows exist; a validator that also
  // judged reads would make the history unqueryable and the sort undefined.
  const fx = fixture();
  try {
    const kept = createTask(fx, { title: 'live tail', priority: 'P0' }).json;
    fx.db.exec(
      "insert into mem_tasks (uuid, created_ts, updated_ts, title, body, priority, status, next_action, session_id)"
      + " values ('11111111-1111-4111-8111-111111111111', 1, 1, 'legacy P2 tail', '', 'P2', 'open', 'step', 'legacy')",
    );
    const listed = request(fx.memory, 'GET', '/api/memory/tasks?status=open');
    assert.deepEqual(listed.json.tasks.map((t) => t.title), ['live tail', 'legacy P2 tail']);

    const filtered = request(fx.memory, 'GET', '/api/memory/tasks?priority=P2');
    assert.equal(filtered.status, 200, filtered.text);
    assert.deepEqual(filtered.json.tasks.map((t) => t.title), ['legacy P2 tail']);

    const legacyId = filtered.json.tasks[0].id;
    const closed = request(fx.memory, 'POST', '/api/memory/task/update', {
      id: legacyId, status: 'done', evidence: 'fixture: closed by this test',
    }, fx.token);
    assert.equal(closed.status, 200, closed.text);
    assert.equal(closed.json.priority, 'P2', 'closing must not rewrite the priority it inherited');
    assert.equal(kept.priority, 'P0');
  } finally {
    fx.close();
  }
});

test('ready excludes claimed, blocked, deferred, done, and dependency-blocked work', () => {
  const fx = fixture();
  try {
    // Same priority sorts by id, so `low` is simply the older P1.
    const low = createTask(fx, { title: 'older P1 tail', priority: 'P1' }).json;
    const high = createTask(fx, { title: 'P0 tail', priority: 'P0' }).json;
    const mid = createTask(fx, { title: 'newer P1 tail', priority: 'P1' }).json;
    const blocked = createTask(fx, {
      title: 'blocked tail', status: 'blocked', blocked_reason: 'waiting on host-a soak',
    }).json;
    const deferred = createTask(fx, { title: 'deferred tail', status: 'deferred' }).json;
    const dependant = createTask(fx, { title: 'depends on P0', depends_on: [high.id] }).json;
    const claimed = createTask(fx, { title: 'claimed tail' }).json;
    request(fx.memory, 'POST', '/api/memory/task/claim', { id: claimed.id, agent: 'kimi' }, fx.token);

    const ready = request(fx.memory, 'GET', '/api/memory/tasks/ready');
    assert.equal(ready.status, 200);
    const ids = ready.json.tasks.map((task) => task.id);
    assert.deepEqual(ids, [high.id, low.id, mid.id]);
    for (const excluded of [blocked.id, deferred.id, dependant.id, claimed.id]) {
      assert.equal(ids.includes(excluded), false);
    }

    // closing the dependency releases the dependant into the queue
    request(fx.memory, 'POST', '/api/memory/task/update', {
      id: high.id, status: 'done', evidence: 'fixture: closed by this test',
    }, fx.token);
    const after = request(fx.memory, 'GET', '/api/memory/tasks/ready');
    assert.equal(after.json.tasks.map((task) => task.id).includes(dependant.id), true);
    assert.equal(after.json.tasks.map((task) => task.id).includes(high.id), false);
  } finally {
    fx.close();
  }
});

test('update refuses states that cannot be acted on and stamps closure', () => {
  const fx = fixture();
  try {
    const task = createTask(fx).json;
    assert.equal(request(fx.memory, 'POST', '/api/memory/task/update', {
      id: task.id, status: 'blocked',
    }, fx.token).status, 400);

    const blocked = request(fx.memory, 'POST', '/api/memory/task/update', {
      id: task.id, status: 'blocked', blocked_reason: 'host-b image not verified',
    }, fx.token);
    assert.equal(blocked.status, 200);
    assert.equal(blocked.json.blocked_reason, 'host-b image not verified');
    assert.equal(blocked.json.closed_ts, null);

    const done = request(fx.memory, 'POST', '/api/memory/task/update', {
      id: task.id, status: 'done', evidence: 'fixture: closed by this test',
    }, fx.token);
    assert.equal(done.status, 200);
    assert.ok(Number.isSafeInteger(done.json.closed_ts) && done.json.closed_ts > 0);
    // closing clears the reason: a done task carrying "blocked because…" reads
    // as still blocked in every listing.
    assert.equal(done.json.blocked_reason, null);
    assert.equal(done.json.claimed_by, null);

    assert.equal(request(fx.memory, 'POST', '/api/memory/task/update', {
      id: 4242, status: 'done', evidence: 'fixture: closed by this test',
    }, fx.token).status, 404);
    assert.equal(request(fx.memory, 'POST', '/api/memory/task/update', {
      id: task.id,
    }, fx.token).status, 400);
  } finally {
    fx.close();
  }
});

test('an empty body in an update is "not passed", not "erase it"', () => {
  const fx = fixture();
  try {
    const task = createTask(fx, { body: 'the pending-cap warn floods at 1/tick' }).json;
    // this is exactly what the CLI sends for `task update --id N --status done`
    const updated = request(fx.memory, 'POST', '/api/memory/task/update', {
      id: task.id, body: '', status: 'deferred',
    }, fx.token);
    assert.equal(updated.status, 200);
    assert.equal(updated.json.body, 'the pending-cap warn floods at 1/tick');

    // and an empty body alone is still no field to change
    assert.equal(request(fx.memory, 'POST', '/api/memory/task/update', {
      id: task.id, body: '',
    }, fx.token).status, 400);
  } finally {
    fx.close();
  }
});

test('a task cannot depend on itself or on a task that does not exist', () => {
  const fx = fixture();
  try {
    const task = createTask(fx).json;
    assert.equal(createTask(fx, { depends_on: [9999] }).status, 400);
    const selfDep = request(fx.memory, 'POST', '/api/memory/task/update', {
      id: task.id, depends_on: [task.id],
    }, fx.token);
    assert.equal(selfDep.status, 400);
    assert.match(selfDep.json.error, /itself/);
  } finally {
    fx.close();
  }
});

test('the session-end gate refuses a handoff that declares neither a tail nor its absence', () => {
  const fx = fixture();
  try {
    const naked = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'did some things',
    }, fx.token);
    assert.equal(naked.status, 400);
    // a deny that does not carry the ready command is noise: the agent has to
    // be able to repeat one given form and move on.
    assert.match(naked.json.error, /--no-open-work/);
    assert.match(naked.json.error, /memoryctl task create/);

    // the same gate guards the documented `append --kind handoff` path, which is
    // what the project contract actually tells agents to run.
    assert.equal(request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'handoff', title: 'end of day', body: 'did some things',
    }, fx.token).status, 400);

    // other kinds are untouched — the gate is session-end, not every write
    assert.equal(request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'chose B', body: 'memoryctl grows a task entity',
    }, fx.token).status, 200);

    const denied = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'nothing left open', no_open_work: true,
    }, fx.token);
    assert.equal(denied.status, 200);
  } finally {
    fx.close();
  }
});

test('the open-work gate refuses a handoff that declares neither a tail nor its absence', () => {
  const fx = fixture();
  try {
    const naked = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'did some things',
    }, fx.token);
    assert.equal(naked.status, 400);
    assert.match(naked.json.error, /--no-open-work/);
    assert.match(naked.json.error, /memoryctl task create/);
  } finally {
    fx.close();
  }
});

test('a handoff that names tails links them and refuses closed or unknown ones', () => {
  const fx = fixture();
  try {
    const tail = createTask(fx).json;
    const closed = createTask(fx, { title: 'already finished' }).json;
    request(fx.memory, 'POST', '/api/memory/task/update', { id: closed.id, status: 'done', evidence: 'fixture: closed by this test' }, fx.token);

    assert.equal(request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'body', tasks: [9999],
    }, fx.token).status, 400);

    // naming a finished task as this session's tail is a lie the gate can catch
    const stale = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'body', tasks: [closed.id],
    }, fx.token);
    assert.equal(stale.status, 400);
    assert.match(stale.json.error, /done/);

    const ok = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'body', tasks: [tail.id],
    }, fx.token);
    assert.equal(ok.status, 200);

    const read = request(fx.memory, 'GET', `/api/memory/task?id=${tail.id}`);
    assert.deepEqual(read.json.handoffs, [ok.json.id]);

    // declaring both a tail and its absence is a contradiction, not a belt-and-braces
    assert.equal(request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'body', tasks: [tail.id], no_open_work: true,
    }, fx.token).status, 400);
  } finally {
    fx.close();
  }
});

test('a handoff closes the work it finished, in the same transaction', () => {
  const fx = fixture();
  try {
    const finished = createTask(fx, { title: 'landed and pushed' }).json;
    const tail = createTask(fx, { title: 'still open' }).json;

    // A task cannot be both what is left and what is done.
    const both = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'body', tasks: [tail.id], closes: [tail.id],
    }, fx.token);
    assert.equal(both.status, 400);
    assert.match(both.json.error, /both leaves and closes/);

    assert.equal(request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'body', closes: [9999], no_open_work: true,
    }, fx.token).status, 400);

    const ok = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'closed one, left one', tasks: [tail.id], closes: [finished.id],
      agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(ok.status, 200);

    const closed = request(fx.memory, 'GET', `/api/memory/task?id=${finished.id}`).json;
    assert.equal(closed.status, 'done');
    assert.ok(closed.closed_ts > 0);
    assert.equal(closed.claimed_by, null);
    // The handoff that closed it IS the evidence, so it is linked from the task.
    assert.deepEqual(closed.handoffs, [ok.json.id]);

    // The tail stays open and keeps its own link.
    const left = request(fx.memory, 'GET', `/api/memory/task?id=${tail.id}`).json;
    assert.equal(left.status, 'open');
    assert.deepEqual(left.handoffs, [ok.json.id]);

    // Re-sending the same handoff is an idempotent retry, not a second closure.
    const retry = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'closed one, left one', tasks: [tail.id], closes: [finished.id],
      agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.dedup, true);
    assert.equal(
      request(fx.memory, 'GET', `/api/memory/task?id=${finished.id}`).json.closed_ts,
      closed.closed_ts,
    );

    // Closing everything and leaving nothing is a legal, and honest, session end.
    const swept = createTask(fx, { title: 'also finished' }).json;
    const clean = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'sweep', body: 'closed the last one', closes: [swept.id], no_open_work: true,
      agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(clean.status, 200);
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${swept.id}`).json.status, 'done');
  } finally {
    fx.close();
  }
});

test('a role-swapped handoff is not a retry, however identical the prose', () => {
  const fx = fixture();
  try {
    // The shape three reviewers measured: the union of tails and closes is the
    // same across both writes, so a link-set comparison alone calls them equal.
    const five = createTask(fx, { title: 'five' }).json;
    const six = createTask(fx, { title: 'six' }).json;
    const seven = createTask(fx, { title: 'seven' }).json;

    const first = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'same prose', tasks: [five.id, six.id], closes: [seven.id],
      agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(first.status, 200);
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${six.id}`).json.status, 'open');

    const swapped = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'same prose', tasks: [five.id], closes: [six.id, seven.id],
      agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(swapped.status, 409);
    assert.match(swapped.json.error, /still open/);
    // The whole point: task six survives the second write untouched.
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${six.id}`).json.status, 'open');

    // A true retry — same prose, same roles — still passes.
    const retry = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'same prose', tasks: [five.id, six.id], closes: [seven.id],
      agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.dedup, true);
  } finally {
    fx.close();
  }
});

test('a handoff cannot close work another session is holding', () => {
  const fx = fixture();
  try {
    const held = createTask(fx, { title: 'someone else is on it' }).json;
    assert.equal(request(fx.memory, 'POST', '/api/memory/task/claim', {
      id: held.id, agent: 'other-agent', session_id: 'other-session',
    }, fx.token).status, 200);

    // Closing across a live claim also CLEARS it, so the owner's next write
    // would land on a task the store already calls finished.
    const stolen = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'closing someone else\'s work', closes: [held.id], no_open_work: true,
      agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(stolen.status, 409);
    assert.match(stolen.json.error, /claimed by other-agent/);

    const after = request(fx.memory, 'GET', `/api/memory/task?id=${held.id}`).json;
    assert.equal(after.status, 'in_progress');
    assert.equal(after.claimed_by, 'other-agent');

    // The holder closing its own claimed task is ordinary, not theft.
    const own = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'own end of day', body: 'finished my own', closes: [held.id], no_open_work: true,
      agent: 'other-agent', session_id: 'other-session',
    }, fx.token);
    assert.equal(own.status, 200);
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${held.id}`).json.status, 'done');
  } finally {
    fx.close();
  }
});

test('the prerequisite rule holds on every route that closes, not just the handoff', () => {
  const fx = fixture();
  try {
    const prerequisite = createTask(fx, { title: 'must land first' }).json;
    const dependent = createTask(fx, {
      title: 'waits on it', depends_on: [prerequisite.id],
    }).json;

    // The hole a reviewer found: the handoff path refused, and one `task update`
    // walked around it.
    const direct = request(fx.memory, 'POST', '/api/memory/task/update', {
      id: dependent.id, status: 'done', evidence: 'fixture: closed by this test',
    }, fx.token);
    assert.equal(direct.status, 409);
    assert.match(direct.json.error, new RegExp(`depends on ${prerequisite.id}`));
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${dependent.id}`).json.status, 'open');

    // Being born closed is still closing.
    const bornClosed = request(fx.memory, 'POST', '/api/memory/task', {
      title: 'done on arrival', priority: 'P1', status: 'done', evidence: 'fixture: closed by this test',
      depends_on: [prerequisite.id],
    }, fx.token);
    assert.equal(bornClosed.status, 409);

    // Dropping a dependency that no longer holds, and closing, is one legal call:
    // the rule reads what the update LEAVES behind, not what was there before.
    const dropped = request(fx.memory, 'POST', '/api/memory/task/update', {
      id: dependent.id, status: 'done', evidence: 'fixture: closed by this test', depends_on: [],
    }, fx.token);
    assert.equal(dropped.status, 200);
    assert.equal(dropped.json.status, 'done');

    // And in order, the ordinary way.
    const second = createTask(fx, { title: 'also waits', depends_on: [prerequisite.id] }).json;
    request(fx.memory, 'POST', '/api/memory/task/update', { id: prerequisite.id, status: 'done', evidence: 'fixture: closed by this test' }, fx.token);
    assert.equal(request(fx.memory, 'POST', '/api/memory/task/update', {
      id: second.id, status: 'done', evidence: 'fixture: closed by this test',
    }, fx.token).status, 200);
  } finally {
    fx.close();
  }
});

test('a blank agent is anonymity that passed a truthiness check', () => {
  const fx = fixture();
  try {
    // `optionalString` does not trim, so ' ' and '\t' reached the accountability
    // check as agents and closed unclaimed work: measured as 200, task done.
    // The titles carry an ordinal because the duplicate gate compares WORDS: a
    // space, a tab and three spaces are the same title to it, which is the
    // gate working rather than a case this test is about.
    for (const [ordinal, blank] of [' ', '\t', '   '].entries()) {
      const task = createTask(fx, { title: `blank agent ${ordinal} ${JSON.stringify(blank)}` }).json;
      const closed = request(fx.memory, 'POST', '/api/memory/handoff', {
        title: `blank ${JSON.stringify(blank)}`, body: 'whitespace is not identity',
        closes: [task.id], no_open_work: true, agent: blank,
      }, fx.token);
      assert.equal(closed.status, 400);
      assert.match(closed.json.error, /requires an agent/);
      assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${task.id}`).json.status, 'open');
    }
  } finally {
    fx.close();
  }
});

test('FTS candidates rerank without reports or dead titles and decay recency by age', () => {
  // Measured 2026-09-11 (bench-search.mjs): reports were 34% of the top five,
  // a MERGED-INTO lesson and an ОТМЕНЕНО feedback were first hits for the rules
  // that replaced them, "серверы" and "сервер" returned disjoint results, and a
  // question about the CURRENT state of a server ranked six-week-old handoffs
  // first.
  const fx = fixture();
  try {
    const add = (kind, title, body, extra = {}) => request(fx.memory, 'POST', '/api/memory/append', {
      kind, title, body, no_open_work: kind === 'handoff' ? true : undefined, ...extra,
    }, fx.token).json;
    const report = add('report', 'review', JSON.stringify({ verdict: 'APPROVE', note: 'ростер кими эффорт low обсуждался в ревью' }), {
      session_id: 'attempt-1', agent: 'kimi-reviewer',
    });
    assert.ok(report.id, `the report fixture was stored: ${JSON.stringify(report)}`);
    const dead = add('feedback', 'ОТМЕНЕНО: кими эффорт high в ростере', 'старое указание про ростер');
    const merged = add('lesson', 'MERGED-INTO #1: кими эффорт в ростере', 'слито', {
      links: { domain: 'domain-harness', anchor: 'scripts/memory/store.mjs', globs: [], status: 'active' },
    });
    const cancelled = add('feedback', 'ОТМЕНЕНО (дубль #518): кими эффорт ростер', 'дубль');
    const live = add('decision', 'Кими в ростере на эффорте low', 'ростер решает');
    const fts = request(fx.memory, 'GET', '/api/memory/search?q=' + encodeURIComponent('кими OR эффорт OR ростер*'));
    assert.equal(fts.status, 200);
    const hits = rerankSearchPool(fts.json.map((row) => ({ ...row, rank: row.id === live.id ? -2 : -1 })),
      { query: 'кими эффорт ростерах', now: Date.now(), limit: 20 });
    const ids = hits.map((row) => row.id);
    assert.equal(ids[0], live.id, `the live decision comes first: ${JSON.stringify(hits)}`);
    assert.ok(!ids.includes(report.id), 'a report stays out of the candidate pool');
    assert.ok(!ids.includes(dead.id), 'a cancelled entry stays out of the default rerank');
    assert.ok(!ids.includes(merged.id) && !ids.includes(cancelled.id), 'so does every spelling of the marker');
    assert.match(hits[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(hits[0].age_days, 0);
    const reports = request(fx.memory, 'GET', '/api/memory/search?kind=report&q=' + encodeURIComponent('ростер*')).json;
    assert.deepEqual(reports.map((row) => row.id), [report.id], 'an explicit --kind report still answers');

    // Recency: two handoffs with the same words, the older one richer in them.
    const old = add('handoff', 'host-a deploy WAL state', 'host-a deploy WAL deploy WAL deploy WAL');
    const fresh = add('handoff', 'host-a deploy WAL state', 'host-a deploy WAL');
    fx.db.prepare('UPDATE mem_entries SET ts = ? WHERE id = ?').run(Date.now() - 40 * 24 * 3600 * 1000, old.id);
    const latest = rerankSearchPool([
      { id: old.id, kind: 'handoff', title: 'host-a deploy WAL state', rank: -2, ts: Date.now() - 40 * 24 * 3600 * 1000 },
      { id: fresh.id, kind: 'handoff', title: 'host-a deploy WAL state', rank: -1, ts: Date.now() },
    ], { query: 'latest host-a deploy WAL', now: Date.now(), limit: 2 });
    assert.equal(latest[0].id, fresh.id, `recency decay beats the old snapshot's stronger lexical match: ${JSON.stringify(latest)}`);
  } finally {
    fx.close();
  }
});

test('a rule overturns another rule of any kind, and writing a rule names the live rules that look like it', () => {
  // 2026-09-11: "kimi at effort low" (#5361, a decision) never closed "kimi at
  // effort high" (#1147, a pinned feedback). supersede needs a same-kind
  // successor, and nothing told the writer the older rule existed, so the hot
  // digest kept serving the dead rule for two weeks.
  const fx = fixture();
  try {
    const post = (body) => request(fx.memory, 'POST', '/api/memory/append', body, fx.token);
    const old = post({ kind: 'feedback', title: 'Кими в ревью ростере на эффорте high', body: 'указание', pinned: true }).json;

    const next = post({ kind: 'decision', title: 'Кими в ревью ростере на эффорте low', body: 'ростер решает' });
    assert.equal(next.status, 200);
    assert.deepEqual(next.json.related?.map((row) => row.id), [old.id], `the older rule is named on write: ${JSON.stringify(next.json)}`);
    assert.match(next.json.related_hint, /--overturns/);

    const closing = post({ kind: 'decision', title: 'Кими: эффорт из ростера', body: 'ростер решает всегда', overturns: [old.id] });
    assert.equal(closing.status, 200);
    assert.deepEqual(closing.json.overturned, [old.id]);
    assert.equal(request(fx.memory, 'GET', `/api/memory/entry?id=${closing.json.id}`).json.supersedes, old.id,
      'the new rule links back to the one it replaced');
    const dead = request(fx.memory, 'GET', `/api/memory/entry?id=${old.id}&follow=latest`).json;
    assert.equal(dead.id, closing.json.id, `the overturned rule leads to the rule that replaced it: ${JSON.stringify(dead)}`);
    assert.doesNotMatch(fx.memory.renderHot(12), /эффорте high/, 'the dead rule leaves the hot digest');
    const hits = request(fx.memory, 'GET', '/api/memory/search?q=' + encodeURIComponent('кими OR эффорт OR high')).json;
    assert.ok(!hits.some((row) => row.id === old.id), 'and the search');

    const refused = post({ kind: 'decision', title: 'x', body: 'y', overturns: [999999, 'abc'] });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /does not exist/);
    assert.match(refused.json.error, /not an entry id/);
    const closed = post({ kind: 'decision', title: 'x', body: 'y', overturns: [old.id] });
    assert.equal(closed.status, 400);
    assert.match(closed.json.error, /already superseded/);
    const handoff = post({ kind: 'handoff', title: 'h', body: 'b', no_open_work: true, overturns: [next.json.id] });
    assert.equal(handoff.status, 400, 'a handoff is a snapshot, not a rule: it overturns nothing');
  } finally {
    fx.close();
  }
});

test('overturns takes only ids, is idempotent on retry, and reports what it closed on every rule kind (review r1)', () => {
  const fx = fixture();
  try {
    const post = (body) => request(fx.memory, 'POST', '/api/memory/append', body, fx.token);
    const first = post({ kind: 'feedback', title: 'first rule', body: 'a', pinned: true }).json;
    const bool = post({ kind: 'decision', title: 'boolean overturn', body: 'b', overturns: true });
    assert.equal(bool.status, 400, `a boolean is not an id: ${JSON.stringify(bool.json)}`);
    assert.equal(request(fx.memory, 'GET', `/api/memory/entry?id=${first.id}`).json.superseded_by, null, 'entry #1 is untouched');

    const payload = { kind: 'decision', title: 'replaces first', body: 'c', overturns: [String(first.id)] };
    const once = post(payload);
    assert.equal(once.status, 200);
    assert.deepEqual(once.json.overturned, [first.id], 'a decimal string id is accepted');
    const again = post(payload);
    assert.equal(again.status, 200, `a retry of the same write is a dedup, not a refusal: ${JSON.stringify(again.json)}`);
    assert.equal(again.json.id, once.json.id);
    assert.equal(again.json.dedup, true);

    const stale = post({ kind: 'decision', title: 'another', body: 'd', overturns: [first.id] });
    assert.equal(stale.status, 400, 'a row closed by a different entry is a stale id');
    assert.equal(request(fx.memory, 'GET', '/api/memory/search?q=another*').json.length, 0, 'the refused write left nothing behind');

    const links = { domain: 'domain-harness', anchor: 'scripts/memory/store.mjs', globs: [], status: 'active' };
    const rule = post({ kind: 'lesson', title: 'lesson rule', body: 'e', links });
    assert.equal(rule.status, 200, JSON.stringify(rule.json));
    const lesson = post({ kind: 'lesson', title: 'lesson that replaces', body: 'f', links, overturns: [rule.json.id] });
    assert.deepEqual(lesson.json.overturned, [rule.json.id], `a lesson overturn says what it closed: ${JSON.stringify(lesson.json)}`);

    const lone = request(fx.memory, 'GET', '/api/memory/search?q=' + encodeURIComponent('"'));
    assert.equal(lone.status, 200, 'a query of syntax alone matches nothing, it is not invalid');
    assert.deepEqual(lone.json, []);
  } finally {
    fx.close();
  }
});

test('a question finds its answer, and a literal query keeps its precision', () => {
  const fx = fixture();
  try {
    const answer = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision',
      title: 'Deny-гейт стоит лишний ход: enforcement warn-only, не блокировка',
      body: 'Замер показал, что блокировка обходится дороже счётчика.',
    }, fx.token);
    assert.equal(answer.status, 200);
    const other = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'unrelated deny note', body: 'deny appears here too, alone',
    }, fx.token);
    assert.equal(other.status, 200);
    const vectors = new Map([answer.json.id, other.json.id].map((id, index) => {
      const row = fx.db.prepare('SELECT title, body FROM mem_entries WHERE id = ?').get(id);
      return [id, { textSha: entryTextSha(row), vector: index === 0
        ? new Float32Array([1, 0]) : new Float32Array([0, 1]) }];
    }));
    const dense = createMemory({ db: fx.db, tokenPath: fx.tokenPath, denseVectors: vectors });
    const queryStub = { handle: (req, res, url, body) => dense.handle(req, res, url, body,
      { queryVector: new Float32Array([1, 0]) }) };

    // A deterministic query embedding reaches the answer despite question words not in the entry.
    const asked = request(queryStub, 'GET', '/api/memory/search?q=' + encodeURIComponent('почему отказались от deny в гейте'));
    assert.equal(asked.status, 200);
    assert.ok(
      asked.json.some((row) => row.id === answer.json.id),
      'a question phrased as a question must reach the entry that answers it',
    );

    // The explicit FTS OR path still puts the entry with BOTH terms first;
    // the other row remains in the result, unlike a strict AND query.
    const literal = request(fx.memory, 'GET', '/api/memory/search?q=' + encodeURIComponent('deny OR enforcement'));
    assert.equal(literal.status, 200);
    assert.equal(literal.json[0]?.id, answer.json.id, 'the entry carrying both words ranks first');

    // Explicit FTS5 syntax is still run as written: a quoted phrase is a phrase.
    const phrase = request(fx.memory, 'GET', '/api/memory/search?q=' + encodeURIComponent('"deny appears here"'));
    assert.equal(phrase.status, 200);
    assert.equal(phrase.json.length, 1);
    assert.notEqual(phrase.json[0].id, answer.json.id);
  } finally {
    fx.close();
  }
});

test('the claim owner is the pair, not the name — same model, second session', () => {
  const fx = fixture();
  try {
    // Same-model-twice is the ordinary case on a Svod roster, so comparing the
    // agent name alone let session B close session A's live work.
    const held = createTask(fx, { title: 'session A is on it' }).json;
    assert.equal(request(fx.memory, 'POST', '/api/memory/task/claim', {
      id: held.id, agent: 'claude', session_id: 'session-a',
    }, fx.token).status, 200);

    const otherSession = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'B closing A\'s work', closes: [held.id], no_open_work: true,
      agent: 'claude', session_id: 'session-b',
    }, fx.token);
    assert.equal(otherSession.status, 409);
    assert.match(otherSession.json.error, /session session-a/);

    const after = request(fx.memory, 'GET', `/api/memory/task?id=${held.id}`).json;
    assert.equal(after.status, 'in_progress');
    assert.equal(after.claimed_by, 'claude');

    // The session that actually holds it closes it.
    assert.equal(request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'A closing its own', closes: [held.id], no_open_work: true,
      agent: 'claude', session_id: 'session-a',
    }, fx.token).status, 200);
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${held.id}`).json.status, 'done');
  } finally {
    fx.close();
  }
});

test('an anonymous handoff may leave tails but may not close them', () => {
  const fx = fixture();
  try {
    const task = createTask(fx, { title: 'unclaimed and open' }).json;

    const anonymous = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'nobody in particular', closes: [task.id], no_open_work: true,
    }, fx.token);
    assert.equal(anonymous.status, 400);
    assert.match(anonymous.json.error, /requires an agent/);
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${task.id}`).json.status, 'open');

    // Declaring it as a tail needs no agent: naming open work accuses nobody.
    assert.equal(request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'nobody in particular, leaving it open', tasks: [task.id],
    }, fx.token).status, 200);
  } finally {
    fx.close();
  }
});

test('a prerequisite that vanished is unmet, not satisfied', () => {
  const fx = fixture();
  try {
    const prerequisite = createTask(fx, { title: 'will be removed' }).json;
    const dependent = createTask(fx, {
      title: 'depends on it', depends_on: [prerequisite.id],
    }).json;

    // Dependencies are validated at creation, so a row that is gone later is not
    // a satisfied prerequisite — it is one whose fate cannot be read at all.
    fx.db.prepare('DELETE FROM mem_tasks WHERE id = ?').run(prerequisite.id);

    const orphaned = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'closing over a hole', closes: [dependent.id], no_open_work: true,
      agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(orphaned.status, 409);
    assert.match(orphaned.json.error, new RegExp(`depends on ${prerequisite.id}`));
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${dependent.id}`).json.status, 'open');
  } finally {
    fx.close();
  }
});

test('a handoff cannot close a task whose prerequisite is still open', () => {
  const fx = fixture();
  try {
    const prerequisite = createTask(fx, { title: 'must land first' }).json;
    const dependent = createTask(fx, {
      title: 'waits on the first', depends_on: [prerequisite.id],
    }).json;

    const early = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'out of order', closes: [dependent.id], no_open_work: true,
      agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(early.status, 409);
    assert.match(early.json.error, new RegExp(`depends on ${prerequisite.id}`));
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${dependent.id}`).json.status, 'open');

    // In order, both close in one handoff.
    const ordered = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'in order', closes: [prerequisite.id, dependent.id], no_open_work: true,
      agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(ordered.status, 200);
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${dependent.id}`).json.status, 'done');
  } finally {
    fx.close();
  }
});

test('a blocked task closes and stops saying why it was blocked', () => {
  const fx = fixture();
  try {
    const stuck = createTask(fx, { title: 'was blocked' }).json;
    assert.equal(request(fx.memory, 'POST', '/api/memory/task/update', {
      id: stuck.id, status: 'blocked', blocked_reason: 'host-b was unverified',
    }, fx.token).status, 200);

    assert.equal(request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'end of day', body: 'unblocked and finished', closes: [stuck.id], no_open_work: true,
      agent: 'claude', session_id: 'session-a',
    }, fx.token).status, 200);

    const closed = request(fx.memory, 'GET', `/api/memory/task?id=${stuck.id}`).json;
    assert.equal(closed.status, 'done');
    // Done "because host-b was unverified" is a lie, so the reason goes.
    assert.equal(closed.blocked_reason, null);
  } finally {
    fx.close();
  }
});

test('a refused closure takes the handoff down with it, on both routes', () => {
  const fx = fixture();
  try {
    const closable = createTask(fx, { title: 'genuinely finished' }).json;
    const held = createTask(fx, { title: 'held elsewhere' }).json;
    request(fx.memory, 'POST', '/api/memory/task/claim', {
      id: held.id, agent: 'other-agent', session_id: 'other-session',
    }, fx.token);

    // append: the entry and its closures are ONE fact
    const refused = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'partial', body: 'one closable, one held', closes: [closable.id, held.id], no_open_work: true,
      agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(refused.status, 409);
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${closable.id}`).json.status, 'open');
    assert.deepEqual(
      request(fx.memory, 'GET', '/api/memory/search?q=partial*&kind=handoff').json,
      [],
      'a refused closure must not leave its handoff behind',
    );

    // supersede: the rewrite path carries the same rule
    const live = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'day one', body: 'prose', no_open_work: true,
    }, fx.token);
    assert.equal(live.status, 200);
    const rewritten = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: live.json.id, title: 'day one', body: 'rewritten prose',
      closes: [held.id], no_open_work: true, agent: 'claude', session_id: 'session-a',
    }, fx.token);
    assert.equal(rewritten.status, 409);
    assert.equal(request(fx.memory, 'GET', `/api/memory/task?id=${held.id}`).json.status, 'in_progress');
    // the original is still the live entry — the rewrite did not happen
    assert.equal(request(fx.memory, 'GET', `/api/memory/entry?id=${live.json.id}`).json.superseded_by, null);
  } finally {
    fx.close();
  }
});

test('superseding a handoff is gated too — the bypass a reviewer measured', () => {
  const fx = fixture();
  try {
    const tail = createTask(fx).json;
    const handoff = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'day one', body: 'prose', tasks: [tail.id],
    }, fx.token);
    assert.equal(handoff.status, 200);

    // Before the fix this returned 200 and produced a LIVE handoff with no
    // declaration — the gate held on two routes out of three.
    const naked = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: handoff.json.id, title: 'day one', body: 'rewritten prose',
    }, fx.token);
    assert.equal(naked.status, 400);
    assert.match(naked.json.error, /--no-open-work/);

    const declared = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: handoff.json.id, title: 'day one', body: 'rewritten prose', no_open_work: true,
    }, fx.token);
    assert.equal(declared.status, 200);

    // a non-handoff kind stays ungated on this route as well
    const note = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'chose B', body: 'first',
    }, fx.token);
    assert.equal(request(fx.memory, 'POST', '/api/memory/supersede', {
      id: note.json.id, title: 'chose B', body: 'second',
    }, fx.token).status, 200);
  } finally {
    fx.close();
  }
});

test('a handoff and its tail links land together or not at all', () => {
  const fx = fixture();
  try {
    const tail = createTask(fx).json;
    // Reject every link write: before the fix the entry committed anyway and the
    // handoff survived with zero links — the audit trail the gate exists for.
    fx.db.exec(`
CREATE TRIGGER reject_links BEFORE INSERT ON mem_task_handoffs
BEGIN SELECT RAISE(ABORT, 'no links today'); END`);
    const failed = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'day one', body: 'prose', tasks: [tail.id],
    }, fx.token);
    assert.equal(failed.status, 500);
    assert.equal(fx.db.prepare("SELECT count(*) c FROM mem_entries WHERE kind='handoff'").get().c, 0);

    fx.db.exec('DROP TRIGGER reject_links');
    const ok = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'day one', body: 'prose', tasks: [tail.id],
    }, fx.token);
    assert.equal(ok.status, 200);
    assert.deepEqual(
      request(fx.memory, 'GET', `/api/memory/task?id=${tail.id}`).json.handoffs,
      [ok.json.id],
    );
  } finally {
    fx.close();
  }
});

test('dedup may not silently merge two different declarations', () => {
  const fx = fixture();
  try {
    // Two tails a person could tell apart: the duplicate gate compares the
    // WORDS of a title, and "tail one" against "tail two" shares its only
    // long word.
    const first = createTask(fx, { title: 'the pending-cap warn still floods' }).json;
    const second = createTask(fx, { title: 'the coverage ledger disagrees with the rows' }).json;
    const body = { title: 'end of day', body: 'identical prose' };

    const one = request(fx.memory, 'POST', '/api/memory/handoff', { ...body, tasks: [first.id] }, fx.token);
    assert.equal(one.status, 200);

    // resending the SAME declaration is an idempotent retry
    const retry = request(fx.memory, 'POST', '/api/memory/handoff', { ...body, tasks: [first.id] }, fx.token);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.dedup, true);
    assert.equal(retry.json.id, one.json.id);

    // a DIFFERENT declaration under the same prose used to be folded in silently,
    // so one entry ended up owning two sessions' tails
    const conflicting = request(fx.memory, 'POST', '/api/memory/handoff', { ...body, tasks: [second.id] }, fx.token);
    assert.equal(conflicting.status, 409);
    assert.match(conflicting.json.error, /declared/);
    assert.deepEqual(
      request(fx.memory, 'GET', `/api/memory/task?id=${second.id}`).json.handoffs,
      [],
    );
  } finally {
    fx.close();
  }
});

test('"nothing is open" and "these are open" are different declarations, both ways', () => {
  const fx = fixture();
  try {
    const tail = createTask(fx).json;
    const body = { title: 'end of day', body: 'identical prose' };

    // The first fix only compared NON-EMPTY sets, so a handoff that declared
    // nothing quietly acquired tails from a later one: measured by two
    // reviewers as 200/dedup with the link attached.
    assert.equal(request(fx.memory, 'POST', '/api/memory/handoff', { ...body, no_open_work: true }, fx.token).status, 200);
    const upgraded = request(fx.memory, 'POST', '/api/memory/handoff', { ...body, tasks: [tail.id] }, fx.token);
    assert.equal(upgraded.status, 409);
    assert.deepEqual(request(fx.memory, 'GET', `/api/memory/task?id=${tail.id}`).json.handoffs, []);

    // and the reverse: an entry that declared a tail cannot be re-read as "none"
    const other = fixture();
    try {
      const otherTail = createTask(other).json;
      assert.equal(request(other.memory, 'POST', '/api/memory/handoff', { ...body, tasks: [otherTail.id] }, other.token).status, 200);
      assert.equal(request(other.memory, 'POST', '/api/memory/handoff', { ...body, no_open_work: true }, other.token).status, 409);
    } finally {
      other.close();
    }

    // repeating "nothing is open" stays an idempotent retry
    assert.equal(request(fx.memory, 'POST', '/api/memory/handoff', { ...body, no_open_work: true }, fx.token).json.dedup, true);
  } finally {
    fx.close();
  }
});

test('a handoff written before the gate existed has an UNKNOWN declaration, not an empty one', () => {
  const fx = fixture();
  try {
    // Every row in the live database predates v3: 322 of them. They carry no
    // link rows because there was nothing to link with, NOT because someone
    // declared "nothing is open" - and a reviewer measured the difference being
    // erased: legacy_v2_dedup status=200 dedup=true persisted_declaration_rows=0.
    const legacy = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'yesterday', body: 'prose from before the gate', no_open_work: true,
    }, fx.token);
    assert.equal(legacy.status, 200);
    // strip the declaration to reproduce exactly what migration leaves behind
    fx.db.exec(`UPDATE mem_entries SET handoff_declaration = NULL WHERE id = ${legacy.json.id}`);

    const retry = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'yesterday', body: 'prose from before the gate', no_open_work: true,
    }, fx.token);
    assert.equal(retry.status, 409);
    assert.match(retry.json.error, /predates|unknown/i);

    // naming a tail against a legacy row is refused for the same reason
    const tail = createTask(fx).json;
    assert.equal(request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'yesterday', body: 'prose from before the gate', tasks: [tail.id],
    }, fx.token).status, 409);
    assert.deepEqual(request(fx.memory, 'GET', `/api/memory/task?id=${tail.id}`).json.handoffs, []);
  } finally {
    fx.close();
  }
});

test('a declaration is stored as a fact, both kinds', () => {
  const fx = fixture();
  try {
    const tail = createTask(fx).json;
    const none = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'a', body: 'a', no_open_work: true,
    }, fx.token);
    const tails = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'b', body: 'b', tasks: [tail.id],
    }, fx.token);
    const read = (id) => fx.db.prepare('SELECT handoff_declaration d FROM mem_entries WHERE id = ?').get(id).d;
    assert.equal(read(none.json.id), 'none');
    assert.equal(read(tails.json.id), 'tails');

    // a superseding handoff records its own declaration, not the old one
    const rewritten = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: tails.json.id, title: 'b', body: 'b rewritten', no_open_work: true,
    }, fx.token);
    assert.equal(rewritten.status, 200);
    assert.equal(read(rewritten.json.id), 'none');

    // non-handoff kinds carry no declaration at all
    const note = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'c', body: 'c',
    }, fx.token);
    assert.equal(read(note.json.id), null);
  } finally {
    fx.close();
  }
});

test('a second process opening the database concurrently does not corrupt the migration', async () => {
  // Measured by a reviewer: 10 rounds / 20 opens produced 11 failures
  // ("database is locked", "table mem_entries already exists") because
  // user_version was read before the write lock and busy_timeout was set after
  // the conflicting PRAGMAs.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryctl-race-'));
  const child = `
    const { openMemoryDb } = await import(${JSON.stringify(pathToFileUrl(storeModulePath))});
    const db = openMemoryDb(${JSON.stringify(stateDir)});
    const version = db.prepare('PRAGMA user_version').get().user_version;
    db.close();
    process.stdout.write(String(version));
  `;
  try {
    const results = await Promise.all([0, 1].map(() => new Promise((resolve) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', child], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      proc.stdout.on('data', (chunk) => { out += chunk; });
      proc.stderr.on('data', (chunk) => { err += chunk; });
      proc.on('close', (code) => resolve({ code, out, err }));
    })));
    for (const result of results) {
      assert.equal(result.code, 0, `concurrent open failed: ${result.err.split('\n')[0]}`);
      assert.equal(result.out, String(SCHEMA_VERSION));
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('leaving blocked clears the reason, and a whitespace body is not a body', () => {
  const fx = fixture();
  try {
    const task = createTask(fx, {
      body: 'keep me', status: 'blocked', blocked_reason: 'waiting on host-b',
    }).json;
    const unblocked = request(fx.memory, 'POST', '/api/memory/task/update', {
      id: task.id, status: 'open',
    }, fx.token);
    assert.equal(unblocked.status, 200);
    // a stale "blocked because…" on an open task reads as still blocked
    assert.equal(unblocked.json.blocked_reason, null);

    const spaces = request(fx.memory, 'POST', '/api/memory/task/update', {
      id: task.id, body: '   ', status: 'deferred',
    }, fx.token);
    assert.equal(spaces.json.body, 'keep me');
  } finally {
    fx.close();
  }
});

test('a task that repeats an existing one is refused by number, and --again is the way past', () => {
  const fx = fixture();
  try {
    const first = createTask(fx, {
      title: 'Вынести фьюч-элементы в отдельный elements-контейнер, вернуть LIVE_ELEMENTS',
    });
    assert.equal(first.status, 200);

    // The same job, said again with one word changed - the exact shape of
    // #21/#25 in the live store.
    const twin = createTask(fx, {
      title: 'Фьюч-элементы в отдельный elements-контейнер, вернуть LIVE_ELEMENTS',
    });
    assert.equal(twin.status, 400);
    assert.match(twin.json.error, new RegExp(`#${first.json.id}\\b`));
    assert.match(twin.json.error, /Work in that one/);
    // The refusal names the twin in its BODY too: a client acts on the id, and
    // quoting one back out of the prose is how the wrong task gets opened.
    assert.equal(twin.json.duplicate_of, first.json.id);
    // Closing the first one does NOT make the second one free: reopening what
    // was already finished is the duplicate this store actually has - four
    // pairs of them, and none between two OPEN tasks.
    assert.equal(
      request(fx.memory, 'POST', '/api/memory/task/update',
        { id: first.json.id, status: 'done', evidence: 'fixture: closed by this test' }, fx.token).status,
      200,
    );
    const afterClose = createTask(fx, {
      title: 'Фьюч-элементы в отдельный elements-контейнер, вернуть LIVE_ELEMENTS',
    });
    assert.equal(afterClose.status, 400);
    assert.match(afterClose.json.error, /already done/);
    assert.match(afterClose.json.error, /--again/);
    assert.equal(afterClose.json.duplicate_of, first.json.id);

    // And the one word that says the work genuinely came back.
    const again = createTask(fx, {
      title: 'Фьюч-элементы в отдельный elements-контейнер, вернуть LIVE_ELEMENTS',
      again: true,
    });
    assert.equal(again.status, 200);
    assert.notEqual(again.json.id, first.json.id);

    // A different job that happens to share a word is not a duplicate.
    assert.equal(
      createTask(fx, { title: 'Контейнер элементов на проде не переживает рестарт' }).status,
      200,
    );
  } finally {
    fx.close();
  }
});

test('tasks list filters by status, priority, and track', () => {
  const fx = fixture();
  try {
    createTask(fx, { title: 'harness tail', track: 'harness-hardening', priority: 'P0' });
    createTask(fx, { title: 'svod tail', track: 'svod-hardening', priority: 'P1' });
    const done = createTask(fx, { title: 'closed tail', track: 'svod-hardening' }).json;
    request(fx.memory, 'POST', '/api/memory/task/update', { id: done.id, status: 'done', evidence: 'fixture: closed by this test' }, fx.token);

    const byTrack = request(fx.memory, 'GET', '/api/memory/tasks?track=svod-hardening');
    assert.deepEqual(byTrack.json.tasks.map((task) => task.title), ['svod tail', 'closed tail']);

    const open = request(fx.memory, 'GET', '/api/memory/tasks?status=open');
    assert.deepEqual(open.json.tasks.map((task) => task.title), ['harness tail', 'svod tail']);

    const p0 = request(fx.memory, 'GET', '/api/memory/tasks?priority=P0');
    assert.deepEqual(p0.json.tasks.map((task) => task.title), ['harness tail']);

    assert.equal(request(fx.memory, 'GET', '/api/memory/tasks?status=whatever').status, 400);
  } finally {
    fx.close();
  }
});

test('a task carries a domain: set, clear, refuse an unknown id with the list, keep the other links keys', () => {
  const fx = fixture();
  try {
    const created = createTask(fx, { title: 'filed tail', domain: 'domain-harness', links: { team: 'core' } });
    assert.equal(created.status, 200);
    assert.equal(created.json.domain, 'domain-harness');
    assert.deepEqual(created.json.links, { team: 'core', domain: 'domain-harness' });

    const cleared = request(fx.memory, 'POST', '/api/memory/task/update', { id: created.json.id, domain: null }, fx.token);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.domain, null);
    assert.deepEqual(cleared.json.links, { team: 'core' });

    // An unknown routing id is refused WITH THE LIST, on both routes.
    const unknown = request(fx.memory, 'POST', '/api/memory/task/update', { id: created.json.id, domain: 'domain-nope' }, fx.token);
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error, /domain-nope/);
    assert.match(unknown.json.error, /domain-harness/);
    const born = createTask(fx, { title: 'misfiled tail', domain: 'domain-nope' });
    assert.equal(born.status, 400);
    assert.match(born.json.error, /domain-nope/);
    assert.match(born.json.error, /domain-harness/);

    // `closed_evidence` is a links key like any other: filing under a domain
    // must not drop what the closure recorded.
    const closed = createTask(fx, { title: 'evidence-bearing tail' }).json;
    request(fx.memory, 'POST', '/api/memory/task/update', { id: closed.id, status: 'done', evidence: 'fixture: proven' }, fx.token);
    const filed = request(fx.memory, 'POST', '/api/memory/task/update', { id: closed.id, domain: 'domain-harness' }, fx.token);
    assert.equal(filed.status, 200);
    assert.equal(filed.json.links.closed_evidence, 'fixture: proven');
    assert.equal(filed.json.domain, 'domain-harness');
  } finally {
    fx.close();
  }
});

test('a wholesale links write keeps the stored domain, and a domain-only update leaves updated_ts', async () => {
  const fx = fixture();
  try {
    const created = createTask(fx, { title: 'filing target', domain: 'domain-harness', links: { team: 'core' } }).json;

    const wholesale = request(fx.memory, 'POST', '/api/memory/task/update', { id: created.id, links: { team: 'ops' } }, fx.token);
    assert.equal(wholesale.status, 200);
    assert.deepEqual(wholesale.json.links, { team: 'ops', domain: 'domain-harness' });
    assert.equal(wholesale.json.domain, 'domain-harness');

    await new Promise((resolve) => setTimeout(resolve, 5));
    const before = request(fx.memory, 'GET', `/api/memory/task?id=${created.id}`).json;
    const moved = request(fx.memory, 'POST', '/api/memory/task/update', { id: created.id, domain: 'domain-billing' }, fx.token);
    assert.equal(moved.status, 200);
    assert.equal(moved.json.domain, 'domain-billing');
    // Filing under a domain is not progress on the task.
    assert.equal(moved.json.updated_ts, before.updated_ts);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const progressed = request(fx.memory, 'POST', '/api/memory/task/update', { id: created.id, title: 'filing target renamed' }, fx.token);
    assert.equal(progressed.status, 200);
    assert.ok(progressed.json.updated_ts > before.updated_ts);
  } finally {
    fx.close();
  }
});

test('list filters closed_since, fields=compact and domain, and the answer names the filters it applied', () => {
  const fx = fixture();
  try {
    createTask(fx, { title: 'filed tail', domain: 'domain-harness' });
    createTask(fx, { title: 'plain tail' });
    const gone = createTask(fx, { title: 'gone tail', domain: 'domain-harness' }).json;
    request(fx.memory, 'POST', '/api/memory/task/update', { id: gone.id, status: 'done', evidence: 'fixture: closed by this test' }, fx.token);

    // A closed task is listed only when it closed inside the window; the
    // others are unaffected.
    const ahead = request(fx.memory, 'GET', `/api/memory/tasks?closed_since=${Date.now() + 60_000}`);
    assert.deepEqual(ahead.json.tasks.map((task) => task.title), ['filed tail', 'plain tail']);
    const all = request(fx.memory, 'GET', '/api/memory/tasks?closed_since=0');
    assert.deepEqual(all.json.tasks.map((task) => task.title), ['filed tail', 'plain tail', 'gone tail']);

    const byDomain = request(fx.memory, 'GET', '/api/memory/tasks?domain=domain-harness');
    assert.deepEqual(byDomain.json.tasks.map((task) => task.title), ['filed tail', 'gone tail']);
    const undomained = request(fx.memory, 'GET', '/api/memory/tasks?domain=none');
    assert.deepEqual(undomained.json.tasks.map((task) => task.title), ['plain tail']);

    const compact = request(fx.memory, 'GET', '/api/memory/tasks?fields=compact');
    assert.equal(compact.json.tasks.length, 3);
    for (const task of compact.json.tasks) {
      assert.equal('body' in task, false);
      assert.equal('handoffs' in task, false);
      assert.equal('domain' in task, true);
    }

    assert.deepEqual(compact.json.applied, ['fields']);
    assert.deepEqual(all.json.applied, ['closed_since']);
    assert.deepEqual(byDomain.json.applied, ['domain']);
    assert.deepEqual(ahead.json.applied, ['closed_since']);
    assert.deepEqual(request(fx.memory, 'GET', '/api/memory/tasks').json.applied, []);

    assert.equal(request(fx.memory, 'GET', '/api/memory/tasks?closed_since=yesterday').status, 400);
    assert.equal(request(fx.memory, 'GET', '/api/memory/tasks?fields=full').status, 400);
    assert.equal(request(fx.memory, 'GET', '/api/memory/tasks?domain=domain-nope').status, 400);
  } finally {
    fx.close();
  }
});

// The Svod report channel. A member no longer buries its answer in prose for the

await runStoreTests();
