#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHEMA_VERSION, matchGlob, openMemoryDb, resolveDomain } from './store.mjs';
import { LESSON_GATE, createTask, fixture, lessonLinks, request, runStoreTests, seedLegacyLesson, test } from './store-test-helpers.mjs';

test('the glob dialect is the one the matcher is held to', () => {
  // The cases were shared with a second matcher on the Svod side, over the same
  // generated routing file, until 2026-08-10; that side derived a member's
  // domain skills from the subject and is gone, so this is now the only suite.
  // The statement stays anyway. Measured 2026-08-08, while both existed: the
  // two disagreed on four shapes — `?` crossed a separator here and not there,
  // `[!0-9]` negated there and was a literal set here — because each
  // side implemented what its author assumed. Nothing shipped used any of them,
  // so no route was wrong yet.
  const cases = JSON.parse(fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'glob-dialect.cases.json'), 'utf8'));
  assert.ok(cases.cases.length > 0, 'the dialect must be stated by cases');
  for (const { glob, path, matches } of cases.cases) {
    assert.equal(matchGlob(glob, path), matches,
      `${JSON.stringify(glob)} vs ${JSON.stringify(path)} must be ${matches}`);
  }
});

test('domain routing matches generated glob semantics and chooses the most-specific owner', () => {
  assert.equal(matchGlob('**', 'any/repo-relative/path.ts'), true);
  assert.equal(matchGlob('app/src/billing_v4/**', 'app/src/billing_v4/collector.rs'), true);
  assert.equal(matchGlob('app/src/billing_v4/**', 'app/src/billing_view/collector.rs'), false);
  assert.equal(matchGlob('app/src/news_*.rs', 'app/src/news_ingest.rs'), true);
  assert.equal(matchGlob('app/src/news_*.rs', 'app/src/news/ingest.rs'), false);
  assert.equal(matchGlob('src/**/*[Bb]illing*', 'src/utils/billingStore.ts'), true);
  assert.equal(matchGlob('src/**/*[Bb]illing*', 'src/components/BillingPane.tsx'), true);
  assert.equal(matchGlob('src/**/*[Bb]illing*', 'src/components/OtherPane.tsx'), false);
  assert.equal(matchGlob('src/stores/scheduleStore.ts', 'src/stores/scheduleStore.ts'), true);

  const routingMap = {
    order: [
      { glob: 'app/**', domain: 'domain-platform-shell', spec: 10 },
      { glob: 'app/src/billing_v4/**', domain: 'domain-billing', spec: 25 },
      { glob: 'src/**', domain: 'domain-platform-shell', spec: 4 },
      { glob: 'src/**/billing*/**', domain: 'domain-billing', spec: 4 },
    ],
  };
  assert.equal(resolveDomain('app/src/billing_v4/collector.rs', routingMap), 'domain-billing');
  assert.equal(resolveDomain('src/features/billing/index.ts', routingMap), 'domain-billing');
  assert.equal(resolveDomain('docs/agent/memory.md', routingMap), null);
});

test('migration runs twice harmlessly and token is private', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryctl-migration-'));
  try {
    const first = openMemoryDb(stateDir);
    assert.equal(first.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(first.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(first.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(first.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    first.close();

    const second = openMemoryDb(stateDir);
    assert.equal(second.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    second.close();

    // POSIX only: Windows has no owner/group/other bits, so statSync reports
    // 0o666 no matter how the file was created. Asserting 0o600 there failed
    // on every Windows run and aborted the WHOLE file, so none of the tests
    // below it ever executed on this machine.
    if (process.platform !== 'win32') {
      const tokenMode = fs.statSync(path.join(stateDir, 'memory.token')).mode & 0o777;
      assert.equal(tokenMode, 0o600);
    }
    assert.match(fs.readFileSync(path.join(stateDir, 'memory.token'), 'utf8').trim(), /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('new databases and SQLite sidecars are private regardless of umask; existing databases are preserved', () => {
  if (process.platform === 'win32') return; // POSIX permission contract.
  for (const mask of [0o022, 0o000, 0o777]) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryctl-db-mode-'));
    const dbPath = path.join(stateDir, 'memory.db');
    const previousMask = process.umask(mask);
    let db;
    try {
      db = openMemoryDb(stateDir);
      db.exec("CREATE TABLE permission_probe (value TEXT); INSERT INTO permission_probe VALUES ('keep me')");
      for (const suffix of ['', '-wal', '-shm']) {
        assert.equal(fs.statSync(`${dbPath}${suffix}`).mode & 0o777, 0o600,
          `memory.db${suffix} must be 0600 under umask ${mask.toString(8)}`);
      }
      assert.equal(process.umask(), mask, 'opening a store must not change the process umask');
      db.close();
      db = undefined;

      // An existing database must not be chmodded, truncated or replaced.
      fs.chmodSync(dbPath, 0o640);
      const before = fs.readFileSync(dbPath);
      const inode = fs.statSync(dbPath).ino;
      db = openMemoryDb(stateDir);
      assert.equal(db.prepare('SELECT value FROM permission_probe').get().value, 'keep me');
      assert.equal(fs.statSync(dbPath).mode & 0o777, 0o640);
      assert.equal(fs.statSync(dbPath).ino, inode);
      db.close();
      db = undefined;
      assert.deepEqual(fs.readFileSync(dbPath), before, 'reopening must preserve database bytes');
    } finally {
      process.umask(previousMask);
      db?.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
});

test('append is idempotent for the same kind, title, and body', () => {
  const fx = fixture();
  try {
    const entry = { kind: 'reference', title: 'SQLite rules', body: 'WAL is durable.' };
    const first = request(fx.memory, 'POST', '/api/memory/append', entry, fx.token);
    assert.equal(first.status, 200);
    assert.equal(first.json.dedup, false);

    const duplicate = request(fx.memory, 'POST', '/api/memory/append', entry, fx.token);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.id, first.json.id);
    assert.equal(duplicate.json.dedup, true);
  } finally {
    fx.close();
  }
});

for (const [location, mention] of [
  ['title', (id) => `Task ${id}`],
  ['body', (id) => `TASK #${id}`],
  ['body', (id) => `TaSkS 999999, ${id}`],
]) {
  test(`named open tasks: append recognises ${location} ${mention(1234)}`, () => {
    const fx = fixture();
    try {
      const task = createTask(fx).json;
      const entry = { kind: 'reference', title: 'Completion evidence', body: 'Work recorded.' };
      entry[location] = mention(task.id);
      const written = request(fx.memory, 'POST', '/api/memory/append', entry, fx.token);
      assert.equal(written.status, 200, JSON.stringify(written.json));
      assert.deepEqual(written.json.open_tasks_named, [{
        id: task.id, title: task.title,
        done: `memoryctl task done --id ${task.id} --evidence ${written.json.id}`,
      }]);
      const stillOpen = request(fx.memory, 'GET', `/api/memory/task?id=${task.id}`);
      assert.equal(stillOpen.json.status, 'open', 'a mention is a hint, never a closure');
      const retry = request(fx.memory, 'POST', '/api/memory/append', entry, fx.token);
      assert.equal(retry.json.dedup, true);
      assert.equal(Object.hasOwn(retry.json, 'open_tasks_named'), false);
    } finally {
      fx.close();
    }
  });
}

test('named open tasks: omit closed tasks, non-task numbers, bare IDs and repeated mentions', () => {
  const fx = fixture();
  try {
    const active = createTask(fx, { title: 'Active investigation' }).json;
    const done = createTask(fx, { title: 'Completed migration' }).json;
    const cancelled = createTask(fx, { title: 'Withdrawn experiment' }).json;
    const bare = createTask(fx, { title: 'Unmentioned backlog' }).json;
    for (const [task, status] of [[done, 'done'], [cancelled, 'cancelled']]) {
      const closed = request(fx.memory, 'POST', '/api/memory/task/update', {
        id: task.id, status, evidence: 'verified fixture outcome',
      }, fx.token);
      assert.equal(closed.status, 200, JSON.stringify(closed.json));
    }
    const input = {
      kind: 'reference', title: `Task ${active.id}`,
      body: `tasks ${done.id}, ${cancelled.id}, 999999, ${active.id}; bare ${bare.id}; task #${active.id}`,
    };
    const written = request(fx.memory, 'POST', '/api/memory/append', input, fx.token);
    assert.equal(written.status, 200, JSON.stringify(written.json));
    assert.deepEqual(written.json.open_tasks_named, [{
      id: active.id, title: active.title,
      done: `memoryctl task done --id ${active.id} --evidence ${written.json.id}`,
    }]);
    const empty = request(fx.memory, 'POST', '/api/memory/append', {
      ...input, title: 'No open tasks named', body: `task ${done.id}; task ${cancelled.id}; task 999999; ${bare.id}`,
    }, fx.token);
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.equal(Object.hasOwn(empty.json, 'open_tasks_named'), false);
  } finally {
    fx.close();
  }
});

for (const [route, kind] of [
  ['/api/memory/append', 'decision'],
  ['/api/memory/append', 'handoff'],
  ['/api/memory/handoff', 'handoff'],
]) {
  test(`named open tasks: ${route} ${kind} omits its own closes and carries remaining hints`, () => {
    const fx = fixture();
    try {
      const remaining = createTask(fx, { title: 'Remaining investigation' }).json;
      const finished = createTask(fx, { title: 'Finished rollout' }).json;
      const input = {
        kind, title: `Task #${finished.id} completed`, body: `tasks ${finished.id}, ${remaining.id}`,
        closes: [finished.id], agent: 'closure-writer',
        ...(kind === 'handoff' ? { tasks: [remaining.id] } : {}),
      };
      const written = request(fx.memory, 'POST', route, input, fx.token);
      assert.equal(written.status, 200, JSON.stringify(written.json));
      assert.deepEqual(written.json.open_tasks_named, [{
        id: remaining.id, title: remaining.title,
        done: `memoryctl task done --id ${remaining.id} --evidence ${written.json.id}`,
      }]);
      const closed = request(fx.memory, 'GET', `/api/memory/task?id=${finished.id}`);
      assert.equal(closed.json.status, kind === 'decision' ? 'cancelled' : 'done');
      if (kind === 'decision') assert.deepEqual(written.json.closed_tasks, [finished.id]);
      const retry = request(fx.memory, 'POST', route, input, fx.token);
      assert.equal(retry.status, 200, JSON.stringify(retry.json));
      assert.equal(retry.json.dedup, true);
      assert.equal(Object.hasOwn(retry.json, 'open_tasks_named'), false);
    } finally {
      fx.close();
    }
  });
}

test('named open tasks: cap the response at ten existing open tasks', () => {
  const fx = fixture();
  try {
    const tasks = Array.from({ length: 12 }, (_, i) => {
      const created = createTask(fx, { title: `Backlog item ${i}` });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      return created.json;
    });
    const written = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'reference', title: 'Bulk evidence',
      body: `tasks 999999, ${tasks.map((task) => task.id).join(', ')}`,
    }, fx.token);
    assert.equal(written.status, 200, JSON.stringify(written.json));
    assert.deepEqual(written.json.open_tasks_named, tasks.slice(0, 10).map((task) => ({
      id: task.id, title: task.title,
      done: `memoryctl task done --id ${task.id} --evidence ${written.json.id}`,
    })));
  } finally {
    fx.close();
  }
});

test('entry route returns the whole record by id and by uuid', () => {
  const fx = fixture();
  try {
    const created = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'handoff',
      title: 'Full body readable',
      // multi-line: search only ever returned a snippet, which is why callers
      // went to memory.db by hand to read a handoff
      body: 'line one\nline two\nline three\n',
      links: { track: 'svod-hardening', status: 'active' },
      no_open_work: true,
    }, fx.token);
    assert.equal(created.status, 200);

    const byId = request(fx.memory, 'GET', `/api/memory/entry?id=${created.json.id}`);
    assert.equal(byId.status, 200);
    assert.equal(byId.json.body, 'line one\nline two\nline three\n');
    assert.equal(byId.json.kind, 'handoff');
    assert.equal(byId.json.live, true);
    assert.equal(byId.json.links.track, 'svod-hardening');

    const byUuid = request(fx.memory, 'GET', `/api/memory/entry?uuid=${created.json.uuid}`);
    assert.equal(byUuid.status, 200);
    assert.equal(byUuid.json.id, created.json.id);

    assert.equal(request(fx.memory, 'GET', '/api/memory/entry?id=999999').status, 404);
    assert.equal(request(fx.memory, 'GET', '/api/memory/entry').status, 400);
    assert.equal(request(fx.memory, 'GET', '/api/memory/entry?id=0').status, 400);
    assert.equal(request(fx.memory, 'GET', '/api/memory/entry?id=abc').status, 400);
    assert.equal(request(fx.memory, 'GET', '/api/memory/entry?id=1&uuid=x').status, 400);
    assert.equal(
      request(fx.memory, 'POST', `/api/memory/entry?id=${created.json.id}`, {}, fx.token).status,
      405,
    );

    // a superseded row must still be readable, and must say so
    const replacement = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: created.json.id,
      title: 'Full body readable',
      body: 'replaced body\n',
      no_open_work: true,
    }, fx.token);
    assert.equal(replacement.status, 200);
    const old = request(fx.memory, 'GET', `/api/memory/entry?id=${created.json.id}`);
    assert.equal(old.status, 200);
    assert.equal(old.json.live, false);
    assert.equal(old.json.superseded_by, replacement.json.id);
    assert.equal(old.json.body, 'line one\nline two\nline three\n');
  } finally {
    fx.close();
  }
});

test('entry follows a supersession chain forward and hands back the whole lineage', () => {
  // An id written down anywhere — in a lesson's evidence, in a handoff, in a
  // Svod brief — points at the row that was live when it was written. Every
  // rewrite since then made that row a dead end: `entry?id=N` answered with the
  // stale body and `superseded_by`, and the caller had to walk the chain by hand,
  // one round trip per version. The chain existed; only the read did not.
  const fx = fixture();
  try {
    const v1 = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'reference',
      title: 'Chained fact',
      body: 'version one\n',
    }, fx.token);
    assert.equal(v1.status, 200);
    const v2 = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: v1.json.id, title: 'Chained fact', body: 'version two\n',
    }, fx.token);
    assert.equal(v2.status, 200);
    const v3 = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: v2.json.id, title: 'Chained fact', body: 'version three\n',
    }, fx.token);
    assert.equal(v3.status, 200);

    // asking the ROOT with follow=latest lands on the live head, two hops away
    const latest = request(fx.memory, 'GET', `/api/memory/entry?id=${v1.json.id}&follow=latest`);
    assert.equal(latest.status, 200);
    assert.equal(latest.json.id, v3.json.id);
    assert.equal(latest.json.body, 'version three\n');
    assert.equal(latest.json.live, true);
    // the redirect is stated, so a caller can tell "I asked for 12, you gave 40"
    assert.equal(latest.json.followed_from, v1.json.id);

    // the head follows to itself, and says it did not move
    const head = request(fx.memory, 'GET', `/api/memory/entry?id=${v3.json.id}&follow=latest`);
    assert.equal(head.json.id, v3.json.id);
    assert.equal(head.json.followed_from, null);

    // uuid is a legal way in as well — the ref shape must not change the answer
    const byUuid = request(fx.memory, 'GET', `/api/memory/entry?uuid=${v1.json.uuid}&follow=latest`);
    assert.equal(byUuid.json.id, v3.json.id);

    // full_history: root to leaf, the requested row still returned in full
    const history = request(fx.memory, 'GET', `/api/memory/entry?id=${v2.json.id}&follow=full_history`);
    assert.equal(history.status, 200);
    assert.equal(history.json.id, v2.json.id, 'the requested version is what is returned in full');
    assert.equal(history.json.body, 'version two\n');
    // an INDEX, not the bodies: a chain of ten handoffs is a chain of ten bodies,
    // and this route is read at session start where the budget is the point.
    assert.deepEqual(
      history.json.history.map((row) => [row.id, row.version, row.live]),
      [[v1.json.id, 1, false], [v2.json.id, 2, false], [v3.json.id, 3, true]],
    );
    assert.equal(history.json.history[0].body, undefined, 'lineage carries no bodies');
    assert.ok(history.json.history[2].title, 'lineage carries titles');

    // no follow = today's answer, byte for byte
    const raw = request(fx.memory, 'GET', `/api/memory/entry?id=${v1.json.id}`);
    assert.equal(raw.json.id, v1.json.id);
    assert.equal(raw.json.history, undefined);
    assert.equal(raw.json.followed_from, undefined);

    // an unknown mode is refused WITH the allowed set, not with a bare 400
    const bad = request(fx.memory, 'GET', `/api/memory/entry?id=${v1.json.id}&follow=active`);
    assert.equal(bad.status, 400);
    assert.match(bad.text, /latest/);
    assert.match(bad.text, /full_history/);
  } finally {
    fx.close();
  }
});

test('a supersession chain that points at itself is read, not looped on', () => {
  // The supersede path closes the old row by pointing it at ITSELF and then
  // re-points it at the successor (store.mjs: the two-step close). Both steps
  // are one transaction today, but a row imported by hand — or written by a
  // future path that crashes between the hops — leaves `superseded_by = id`
  // live in the table. A walker that trusts the pointer hangs the single-writer
  // service for every later caller, which is the one failure memory must never
  // cause.
  const fx = fixture();
  try {
    const created = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'reference', title: 'Self pointer', body: 'stuck\n',
    }, fx.token);
    fx.db.prepare('UPDATE mem_entries SET superseded_by = id WHERE id = ?').run(created.json.id);

    const latest = request(fx.memory, 'GET', `/api/memory/entry?id=${created.json.id}&follow=latest`);
    assert.equal(latest.status, 200);
    assert.equal(latest.json.id, created.json.id, 'a self-pointer resolves to itself');

    const history = request(fx.memory, 'GET', `/api/memory/entry?id=${created.json.id}&follow=full_history`);
    assert.equal(history.status, 200);
    assert.deepEqual(history.json.history.map((row) => row.id), [created.json.id]);
  } finally {
    fx.close();
  }
});

/// Hand-build a lineage straight in SQLite. The service cannot produce the states
/// these tests need — that is the point of them: a row imported by hand, or one
/// left by a path that died mid-write, is exactly what the walker must survive.
function chainRows(fx, count) {
  const insert = fx.db.prepare(`
INSERT INTO mem_entries(uuid, ts, session_id, agent, kind, key, title, body, links,
  sha_refs, pinned, content_hash, source_path, supersedes, superseded_by, version)
VALUES (?, ?, NULL, NULL, 'reference', NULL, ?, ?, '[]', '[]', 0, ?, NULL, ?, NULL, ?)`);
  const close = fx.db.prepare('UPDATE mem_entries SET superseded_by = ? WHERE id = ?');
  const ids = [];
  for (let version = 1; version <= count; version += 1) {
    const previous = ids.length ? ids[ids.length - 1] : null;
    const info = insert.run(
      `uuid-${version}`, Date.now() + version, 'Long lineage', `body ${version}`,
      `hash-${version}`, previous, version,
    );
    const id = Number(info.lastInsertRowid);
    if (previous !== null) close.run(id, previous);
    ids.push(id);
  }
  return ids;
}

test('a lineage is walked to its end however long it is — no arbitrary cap', () => {
  // A fixed cap does not make the walk terminate; the visited set does. Rows are
  // finite and none is visited twice, so the walk ends on its own. What a cap
  // adds is a WRONG answer: `follow=latest` would hand back a superseded row
  // while calling it the live head. Measured by codex in review round
  // 019fe627 with a 1001-row chain: latest returned version 1000, live:false.
  const fx = fixture();
  try {
    const ids = chainRows(fx, 1200);
    const head = ids[ids.length - 1];

    const latest = request(fx.memory, 'GET', `/api/memory/entry?id=${ids[0]}&follow=latest`);
    assert.equal(latest.status, 200);
    assert.equal(latest.json.id, head, 'the live head, not the row a cap stopped on');
    assert.equal(latest.json.live, true);

    const history = request(fx.memory, 'GET', `/api/memory/entry?id=${head}&follow=full_history`);
    assert.equal(history.json.history.length, 1200);
    assert.equal(history.json.history[0].id, ids[0]);
  } finally {
    fx.close();
  }
});

test('a lineage lists every version once, even when the pointers disagree', () => {
  // The backward and forward walks each terminate correctly on their own, and
  // the two were concatenated: a row whose `supersedes` and `superseded_by` name
  // the SAME other row put that row in both halves, so the timeline listed it
  // twice. Found by codex in review round 019fe627 ([2,1,2]) and by kimi
  // ([1,2,1]). Only a hand-edited table reaches it — supersede is one
  // transaction — and a duplicated version is still a false timeline.
  const fx = fixture();
  try {
    const first = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'reference', title: 'Disagreeing pointers', body: 'one\n',
    }, fx.token);
    const second = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: first.json.id, title: 'Disagreeing pointers', body: 'two\n',
    }, fx.token);
    // the corruption: the successor points BACK at the row it replaced
    fx.db.prepare('UPDATE mem_entries SET superseded_by = ? WHERE id = ?')
      .run(first.json.id, second.json.id);

    for (const id of [first.json.id, second.json.id]) {
      const history = request(fx.memory, 'GET', `/api/memory/entry?id=${id}&follow=full_history`);
      assert.equal(history.status, 200);
      const listed = history.json.history.map((row) => row.id);
      assert.deepEqual([...new Set(listed)], listed, `version listed twice from ${id}: ${listed}`);
    }
  } finally {
    fx.close();
  }
});

test('a links refusal names EVERY problem and the shape, not one field per turn', () => {
  // Until 2026-08-02 the check returned the FIRST problem only, so a caller
  // rediscovered the contract one field per round trip. Measured in the session
  // transcripts: three consecutive 400s on one append — "must be a JSON object",
  // then "domain must be...", then "anchor must be...". One refusal now carries
  // all of them plus the shape, so one round trip is enough.
  const fx = fixture();
  try {
    const invalid = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson',
      title: 'Everything wrong at once',
      body: 'must not land',
      links: { status: 'draft', globs: 'src/**', trigger: '' },
    }, fx.token);
    assert.equal(invalid.status, 400);
    const error = invalid.json.error;
    for (const expected of [/domain must be/, /anchor must be/, /status must be/, /globs must be/, /trigger must be/]) {
      assert.match(error, expected, `refusal must mention ${expected}`);
    }
    assert.match(error, /required shape:/, 'refusal must state the shape');

    // A non-object is TERMINAL on every shape a caller can send. Four Svod
    // reviewers measured the first cut of this refusal turning `links: null`
    // into HTTP 500 (`Cannot read properties of null (reading 'anchor')`) —
    // valid JSON crashing a public write route — and the array/number cases
    // into a 400 carrying a nonsense `anchor "undefined"` sentence.
    for (const links of [null, ['domain-harness'], 42]) {
      const notAnObject = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson',
        title: `Links are ${JSON.stringify(links)}`,
        body: 'must not land',
        links,
      }, fx.token);
      const shown = JSON.stringify(links);
      assert.equal(notAnObject.status, 400, `${shown} must refuse, never crash`);
      assert.match(notAnObject.json.error, /must be a JSON object/, shown);
      assert.doesNotMatch(notAnObject.json.error, /domain must be/, shown);
      assert.match(notAnObject.json.error, /required shape:/, shown);
      // The shape that follows legitimately names anchor; the PROBLEMS section
      // must not, because there was no object to read an anchor from.
      const listed = notAnObject.json.error.split(' — required shape:')[0];
      assert.doesNotMatch(listed, /anchor/, `${shown}: no derived anchor noise`);
    }

    // A missing anchor is reported once, not twice: the shape check on an empty
    // anchor would otherwise pile a second sentence onto the same fact.
    const noAnchor = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson',
      title: 'No anchor',
      body: 'must not land',
      links: { domain: 'domain-harness', status: 'active' },
    }, fx.token);
    assert.equal(noAnchor.status, 400);
    // Count in the PROBLEMS section only — the shape that follows legitimately
    // names every field, anchor included.
    const listedProblems = noAnchor.json.error.split(' — required shape:')[0];
    assert.equal(listedProblems.match(/anchor/g).length, 1, 'anchor named exactly once');
  } finally {
    fx.close();
  }
});

test('lesson append and supersede require structured domain links', () => {
  const fx = fixture();
  try {
    const missing = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson',
      title: 'Missing lesson links',
      body: 'must not land',
    }, fx.token);
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /lesson links/);

    for (const [title, links] of [
      ['Bad lesson status', { domain: 'domain-billing', anchor: 'src/a.ts:symbol', status: 'draft' }],
      ['Missing lesson domain', { anchor: 'src/a.ts:symbol', status: 'active' }],
      ['Missing lesson anchor', { domain: 'domain-billing', status: 'active' }],
      ['Bad lesson globs', { domain: 'domain-billing', anchor: 'src/a.ts:symbol', status: 'active', globs: 'src/**' }],
      // Anchors with no file part at all. Both of these really landed in the
      // DB and only surfaced later as a red check-domain-routing.
      ['Bare symbol anchor', { domain: 'svod', anchor: 'fn parse_review_decision', status: 'active' }],
      ['Heading anchor', { domain: 'platform-shell', anchor: '## Оболочка на Windows', status: 'active' }],
      ['Whitespace anchor', { domain: 'svod', anchor: 'some words here', status: 'active' }],
      ['Absolute anchor', { domain: 'svod', anchor: '/etc/passwd:symbol', status: 'active' }],
      ['Windows path anchor', { domain: 'svod', anchor: 'D:\\repo\\a.rs:symbol', status: 'active' }],
    ]) {
      const invalid = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson',
        title,
        body: 'must not land',
        links,
      }, fx.token);
      assert.equal(invalid.status, 400, title);
      assert.match(invalid.json.error, /lesson links/, title);
    }

    const active = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson',
      title: 'Valid active lesson',
      body: 'active body',
      links: {
        domain: 'domain-billing',
        anchor: 'src/utils/billingStore.ts:setRetentionFloor',
        status: 'active',
        globs: ['src/**/billing*/**'],
        trigger: 'editing billing retention',
      },
    }, fx.token);
    assert.equal(active.status, 200);

    const inbox = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson',
      title: 'Valid inbox lesson',
      body: 'inbox body',
      links: JSON.stringify({
        domain: 'domain-billing',
        anchor: 'src/utils/billingStore.ts:nextLesson',
        status: 'inbox',
        gate: LESSON_GATE,
      }),
    }, fx.token);
    assert.equal(inbox.status, 200);

    const badReplacement = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: active.json.id,
      title: 'Invalid replacement',
      body: 'must not replace active lesson',
      links: { domain: 'domain-billing', anchor: '', status: 'active' },
    }, fx.token);
    assert.equal(badReplacement.status, 400);
    assert.match(badReplacement.json.error, /lesson links/);
  } finally {
    fx.close();
  }
});

test('a track declaration must be a slug — in links and in the body marker', () => {
  // The live defect this gates: handoffs #8119/#8212 carried the WHOLE links
  // JSON as the track (double-encoded), and gen-tracks exiting 1 on them broke
  // `npm run tracks` for every later session until the rows were repaired.
  const fx = fixture();
  try {
    const accepted = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'tracked handoff',
      body: 'state',
      no_open_work: true,
      links: { track: 'server-arch', status: 'active', next: 'verify' },
    }, fx.token);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));

    const doubleEncoded = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'double-encoded track',
      body: 'must not land',
      no_open_work: true,
      links: { track: JSON.stringify({ track: 'server-arch', status: 'active', next: 'verify' }) },
    }, fx.token);
    assert.equal(doubleEncoded.status, 400);
    assert.match(doubleEncoded.json.error, /links track slug .* is not \[a-z0-9\]\[a-z0-9-\]\*/);
    assert.match(doubleEncoded.json.error, /required shape:/);

    const objectTrack = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'handoff',
      title: 'object track',
      body: 'must not land',
      no_open_work: true,
      links: { track: { track: 'server-arch' } },
    }, fx.token);
    assert.equal(objectTrack.status, 400);
    assert.match(objectTrack.json.error, /not a string/);

    // The body marker is the second declaration of the same fact, and the live
    // rows held the double encoding THERE — the door that judges links judges
    // the marker too.
    const badMarker = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'bad marker',
      body: '<!-- track: {"track":"server-arch","status":"active","next":"x"} -->\nmust not land',
      no_open_work: true,
    }, fx.token);
    assert.equal(badMarker.status, 400);
    assert.match(badMarker.json.error, /body marker track slug/);

    const goodMarker = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'good marker',
      body: '<!-- track: server-arch | status: active | next: verify -->\nstate',
      no_open_work: true,
    }, fx.token);
    assert.equal(goodMarker.status, 200, JSON.stringify(goodMarker.json));

    // Supersede passes through the same door, whether links come from the
    // request or are carried forward from the row being replaced.
    const badReplacement = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: accepted.json.id,
      title: 'tracked handoff v2',
      body: 'state v2',
      no_open_work: true,
      links: { track: '{"track":"server-arch"}' },
    }, fx.token);
    assert.equal(badReplacement.status, 400);
    assert.match(badReplacement.json.error, /required shape:/);
  } finally {
    fx.close();
  }
});

test('a handoff titled as history may carry status archived; a live one may not', () => {
  // consolidate-memory B1 retires a superseded handoff EXACTLY as title prefix
  // `ARCHIVED:` + links.status "archived" — refusing that shape would break the
  // daily consolidation, while the same status on a LIVE handoff breaks
  // gen-tracks. The history predicate runs before the status check.
  const fx = fixture();
  try {
    const live = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'live tracked handoff',
      body: 'state',
      no_open_work: true,
      links: { track: 'server-arch', status: 'active', next: 'verify' },
    }, fx.token);
    assert.equal(live.status, 200, JSON.stringify(live.json));

    const archived = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: live.json.id,
      title: 'ARCHIVED: live tracked handoff',
      body: 'state',
      no_open_work: true,
      links: { track: 'server-arch', status: 'archived' },
    }, fx.token);
    assert.equal(archived.status, 200, JSON.stringify(archived.json));

    const badStatus = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'live handoff with a dead status',
      body: 'must not land',
      no_open_work: true,
      links: { track: 'server-arch', status: 'archived' },
    }, fx.token);
    assert.equal(badStatus.status, 400);
    assert.match(badStatus.json.error, /status "archived" not in active\|paused\|blocked\|done/);
    assert.match(badStatus.json.error, /required shape:/);

    const badMarkerStatus = request(fx.memory, 'POST', '/api/memory/handoff', {
      title: 'live handoff, bad marker status',
      body: '<!-- track: server-arch | status: archived | next: x -->\nmust not land',
      no_open_work: true,
    }, fx.token);
    assert.equal(badMarkerStatus.status, 400);
    assert.match(badMarkerStatus.json.error, /body marker status "archived"/);
  } finally {
    fx.close();
  }
});

test('a new lesson needs the capture-gate marker and its anchor route; supersede and legacy rows do not', () => {
  const fx = fixture();
  try {
    const links = { domain: 'domain-harness', anchor: 'scripts/memory/store.mjs:createMemory', status: 'active' };
    const post = (title, extra) => request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson', title, body: `- rule: ${title}`, links: { ...links, ...extra },
    }, fx.token);

    for (const [title, gate] of [
      ['no marker', undefined],
      ['wrong version', { v: 2, at: LESSON_GATE.at }],
      ['not a timestamp', { v: 1, at: 'yesterday' }],
      ['array marker', [1]],
    ]) {
      const refused = post(title, { gate });
      assert.equal(refused.status, 400, title);
      assert.match(refused.json.error, /no capture-gate marker; capture new lessons with scripts\/memory\/capture-lesson\.mjs/, title);
    }

    const misrouted = post('misrouted', { gate: LESSON_GATE, domain: 'domain-platform-shell' });
    assert.equal(misrouted.status, 400);
    assert.match(misrouted.json.error, /routes to domain-harness, not domain-platform-shell; capture new lessons with scripts\/memory\/capture-lesson\.mjs/);
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM mem_entries WHERE kind = 'lesson'").get().n, 0);

    const gated = post('gated', { gate: LESSON_GATE, possibleDuplicateOf: [7, 42], duplicateCheck: 'incomplete' });
    assert.equal(gated.status, 200, JSON.stringify(gated.json));
    const savedLinks = JSON.parse(fx.db.prepare('SELECT links FROM mem_entries WHERE id = ?').get(gated.json.id).links);
    assert.deepEqual(savedLinks.gate, LESSON_GATE);
    assert.deepEqual(savedLinks.possibleDuplicateOf, [7, 42]);
    assert.equal(savedLinks.duplicateCheck, 'incomplete');
    for (const [key, invalidValues] of [
      ['possibleDuplicateOf', [null, 42, [0], [-1], [1.5], ['42'], [Number.MAX_SAFE_INTEGER + 1]]],
      ['duplicateCheck', [null, 'complete', 0, ['incomplete']]],
    ]) {
      for (const value of invalidValues) {
        const refused = post(`invalid ${key} ${JSON.stringify(value)}`, { gate: LESSON_GATE, [key]: value });
        assert.equal(refused.status, 400, JSON.stringify(refused.json));
        assert.match(refused.json.error, new RegExp(key));
      }
    }

    // A legacy row: no marker and another domain. Supersede is not the capture door.
    const legacy = seedLegacyLesson(fx, { kind: 'lesson', title: 'legacy', body: '- rule: legacy', links: { ...links, domain: 'domain-platform-shell' } });
    const rewritten = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: legacy.json.id, title: 'legacy v2', body: '- rule: legacy v2',
    }, fx.token);
    assert.equal(rewritten.status, 200, JSON.stringify(rewritten.json));
    const relinked = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: rewritten.json.id, title: 'legacy v3', body: '- rule: legacy v3', links: { ...links, status: 'retired' },
    }, fx.token);
    assert.equal(relinked.status, 200, JSON.stringify(relinked.json));
  } finally {
    fx.close();
  }
});

test('a lesson supersede that moves the anchor or domain passes the same route and marker checks', () => {
  const fx = fixture();
  try {
    const billing = { domain: 'domain-billing', anchor: 'app/src/billing_v4/collector.rs:collect', status: 'active', gate: LESSON_GATE };
    const seeded = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson', title: 'collector rule', body: '- rule: v1', links: billing,
    }, fx.token);
    assert.equal(seeded.status, 200, JSON.stringify(seeded.json));
    const supersede = (body, links) => request(fx.memory, 'POST', '/api/memory/supersede', {
      id: seeded.json.id, title: 'collector rule', body, ...(links ? { links } : {}),
    }, fx.token);

    // Reviewer repro: a re-domained supersede returned 200 and left delivery.
    const redomained = supersede('- rule: v2', { ...billing, domain: 'domain-harness' });
    assert.equal(redomained.status, 400);
    assert.match(redomained.json.error, /routes to domain-billing, not domain-harness/);

    const harnessAnchor = 'scripts/memory/store.mjs:createMemory';
    // The old stamp with an extra key is still the old stamp (review reviewer-grok-c17553.1).
    for (const [label, gate] of [['no marker', undefined], ['the old marker', LESSON_GATE], ['the old marker plus a key', { ...LESSON_GATE, extra: 1 }]]) {
      const moved = supersede('- rule: v2', { ...billing, domain: 'domain-harness', anchor: harnessAnchor, gate });
      assert.equal(moved.status, 400, label);
      assert.match(moved.json.error, /moved anchor needs a fresh capture-gate marker/, label);
    }
    const fresh = { v: 1, at: '2026-09-27T00:00:00.000Z' };
    const misrouted = supersede('- rule: v2', { ...billing, anchor: harnessAnchor, gate: fresh });
    assert.equal(misrouted.status, 400);
    assert.match(misrouted.json.error, /routes to domain-harness, not domain-billing/);
    assert.equal(fx.db.prepare('SELECT superseded_by FROM mem_entries WHERE id = ?').get(seeded.json.id).superseded_by, null);

    const bodyOnly = supersede('- rule: v2');
    assert.equal(bodyOnly.status, 200, JSON.stringify(bodyOnly.json));
    const retired = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: bodyOnly.json.id, title: 'collector rule', body: '- rule: v3', links: { ...billing, status: 'retired' },
    }, fx.token);
    assert.equal(retired.status, 200, JSON.stringify(retired.json));
    const moved = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: retired.json.id, title: 'collector rule', body: '- rule: v4',
      links: { ...billing, domain: 'domain-harness', anchor: harnessAnchor, gate: fresh },
    }, fx.token);
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
  } finally {
    fx.close();
  }
});

test('an exact re-append of a closed claim is refused and names the chain', () => {
  // Task 2800: the live-only dedup index let a claim already retired as wrong
  // come back as a fresh live row, because its old row had stopped being live.
  // The refusal must name the closed row, its closer, the head and the way
  // through — and a near-duplicate must sail past it.
  const fx = fixture();
  try {
    const wrong = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'Run kimi at effort high', body: 'effort high is the default',
    }, fx.token);
    assert.equal(wrong.status, 200, JSON.stringify(wrong.json));
    const replacement = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'Run kimi at effort low', body: 'effort low replaced high',
      overturns: [wrong.json.id],
    }, fx.token);
    assert.equal(replacement.status, 200, JSON.stringify(replacement.json));

    const again = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'Run kimi at effort high', body: 'effort high is the default',
    }, fx.token);
    assert.equal(again.status, 409, JSON.stringify(again.json));
    assert.match(again.json.error, new RegExp(`entry ${wrong.json.id} .*closed by entry ${replacement.json.id}`));
    assert.match(again.json.error, /overturned/);
    assert.match(again.json.error, new RegExp(`--overturns ${replacement.json.id}`));
    assert.equal(again.json.existing_id, wrong.json.id);
    assert.equal(again.json.head_id, replacement.json.id);
    // Refused before any write: the store still holds exactly the two rows.
    assert.equal(fx.db.prepare("SELECT count(*) c FROM mem_entries WHERE kind = 'decision'").get().c, 2);

    // The named way through: one write that overturns the chain's live head.
    const reasserted = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'Run kimi at effort high', body: 'effort high is the default',
      overturns: [replacement.json.id],
    }, fx.token);
    assert.equal(reasserted.status, 200, JSON.stringify(reasserted.json));
    assert.deepEqual(reasserted.json.overturned, [replacement.json.id]);
    assert.equal(
      fx.db.prepare('SELECT superseded_by FROM mem_entries WHERE id = ?').get(replacement.json.id).superseded_by,
      reasserted.json.id,
    );

    // A near-duplicate — one changed word, a different content hash — is a
    // different claim and must not be refused.
    const near = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'Run kimi at effort high', body: 'effort high is the refreshed default',
    }, fx.token);
    assert.equal(near.status, 200, JSON.stringify(near.json));
    assert.equal(near.json.dedup, false);

    // Rewritten, not overturned: the OLD version of a superseded rule must not
    // come back either.
    const deploy = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'Deploy on Fridays', body: 'deploys are allowed on Fridays',
    }, fx.token);
    assert.equal(deploy.status, 200, JSON.stringify(deploy.json));
    const rewrite = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: deploy.json.id, title: 'Deploy on Fridays', body: 'deploys are frozen on Fridays',
    }, fx.token);
    assert.equal(rewrite.status, 200, JSON.stringify(rewrite.json));
    const oldVersion = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'Deploy on Fridays', body: 'deploys are allowed on Fridays',
    }, fx.token);
    assert.equal(oldVersion.status, 409, JSON.stringify(oldVersion.json));
    assert.match(oldVersion.json.error, /rewritten/);
    assert.match(oldVersion.json.error, new RegExp(`--overturns ${rewrite.json.id}`));

    // A LIVE duplicate keeps today's behaviour: 200 dedup against itself.
    const live = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'Note the deploy freeze', body: 'one body',
    }, fx.token);
    const liveAgain = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'Note the deploy freeze', body: 'one body',
    }, fx.token);
    assert.equal(liveAgain.status, 200, JSON.stringify(liveAgain.json));
    assert.equal(liveAgain.json.dedup, true);
    assert.equal(liveAgain.json.id, live.json.id);
  } finally {
    fx.close();
  }
});

test('an exact re-append of a retired lesson is refused naming the retirement reason', () => {
  const fx = fixture();
  try {
    const links = lessonLinks();
    const seeded = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson', title: 'Cache the pane list', body: '- rule: cache the pane list', links,
    }, fx.token);
    assert.equal(seeded.status, 200, JSON.stringify(seeded.json));
    // Retire it the way scripts/memory/retire-lesson.mjs does: RETIRED title
    // prefix, a `- retired:` body line, links.status retired, same anchor.
    const retired = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: seeded.json.id,
      title: 'RETIRED: wrong, the pane list is not cached — Cache the pane list',
      body: '- rule: cache the pane list\n- retired: wrong, the pane list is not cached (2026-10-22)',
      links: { ...links, status: 'retired' },
    }, fx.token);
    assert.equal(retired.status, 200, JSON.stringify(retired.json));

    const again = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson', title: 'Cache the pane list', body: '- rule: cache the pane list', links,
    }, fx.token);
    assert.equal(again.status, 409, JSON.stringify(again.json));
    assert.match(again.json.error, new RegExp(`entry ${seeded.json.id} .*closed by entry ${retired.json.id}`));
    assert.match(again.json.error, /retired/);
    assert.match(again.json.error, /wrong, the pane list is not cached/);
    assert.match(again.json.error, new RegExp(`--overturns ${retired.json.id}`));

    const reasserted = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson', title: 'Cache the pane list', body: '- rule: cache the pane list', links,
      overturns: [retired.json.id],
    }, fx.token);
    assert.equal(reasserted.status, 200, JSON.stringify(reasserted.json));
    assert.deepEqual(reasserted.json.overturned, [retired.json.id]);
  } finally {
    fx.close();
  }
});

test('a chain longer than any step cap resolves its live head, and overturning that head passes', () => {
  const fx = fixture();
  try {
    const first = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'Long chain rule', body: 'chain v1',
    }, fx.token);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    let current = first.json.id;
    for (let version = 2; version <= 67; version += 1) {
      const next = request(fx.memory, 'POST', '/api/memory/supersede', {
        id: current, title: 'Long chain rule', body: `chain v${version}`,
      }, fx.token);
      assert.equal(next.status, 200, `supersede v${version}: ${JSON.stringify(next.json)}`);
      current = next.json.id;
    }
    const again = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'Long chain rule', body: 'chain v1',
    }, fx.token);
    assert.equal(again.status, 409, JSON.stringify(again.json));
    assert.equal(again.json.head_id, current, 'the live head of a 67-row chain, never null');
    assert.match(again.json.error, new RegExp(`--overturns ${current}`));
    const reasserted = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'decision', title: 'Long chain rule', body: 'chain v1',
      overturns: [current],
    }, fx.token);
    assert.equal(reasserted.status, 200, JSON.stringify(reasserted.json));
    assert.deepEqual(reasserted.json.overturned, [current]);
  } finally {
    fx.close();
  }
});

test('a v7 database opens, gains the closed-dedup index and stays schema v7', () => {
  // A schema bump would make every older opener refuse the migrated file —
  // the NAS rollback copy and verify-memory-transfer among them — so the
  // index is created at open, and user_version must stay 7.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryctl-v7-'));
  try {
    const db = openMemoryDb(stateDir);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(db.prepare("SELECT count(*) c FROM sqlite_master WHERE type = 'index' AND name = 'idx_mem_entries_closed_dedup'").get().c, 1, 'created at open');
    db.exec('DROP INDEX idx_mem_entries_closed_dedup');
    db.close();
    const reopened = openMemoryDb(stateDir);
    try {
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 7, 'still v7 after re-open');
      assert.equal(reopened.prepare("SELECT count(*) c FROM sqlite_master WHERE type = 'index' AND name = 'idx_mem_entries_closed_dedup'").get().c, 1, 'IF NOT EXISTS re-creates it');
    } finally { reopened.close(); }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

await runStoreTests();
