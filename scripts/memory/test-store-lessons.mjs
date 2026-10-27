#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { LESSONS_MAX_BYTES, createMemory, deliveredLessonBytes } from './store.mjs';
import { entryTextSha } from './embed-recipe.mjs';
import { fixture, lessonLinks, request, runStoreTests, seedLegacyLesson, test } from './store-test-helpers.mjs';

test('nearest-lessons skips and reports malformed links and missing comparison vectors; query vector still fails', () => {
  const fx = fixture();
  try {
    const add = (title, links = {}) => {
      const response = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title, body: `- rule: ${title}`, links: lessonLinks(links),
      }, fx.token);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      return response.json.id;
    };
    const source = add('Source');
    const near = add('Near');
    const far = add('Far');
    const other = add('Other domain');
    const otherLinks = JSON.parse(fx.db.prepare('SELECT links FROM mem_entries WHERE id = ?').get(other).links);
    fx.db.prepare('UPDATE mem_entries SET links = ? WHERE id = ?').run(JSON.stringify({ ...otherLinks, domain: 'domain-other' }), other);
    const retired = add('Retired', { status: 'retired' });
    const malformed = add('Malformed');
    fx.db.prepare('UPDATE mem_entries SET links = ? WHERE id = ?').run('[]', malformed);
    const vectors = new Map([source, near, far, other, retired].map((id, index) => {
      const row = fx.db.prepare('SELECT title, body FROM mem_entries WHERE id = ?').get(id);
      return [id, { textSha: entryTextSha(row), vector: index === 0 ? new Float32Array([1, 0])
        : index === 1 ? new Float32Array([0.8, 0.6]) : new Float32Array([0, 1]) }];
    }));
    const dense = createMemory({ db: fx.db, tokenPath: fx.tokenPath, denseVectors: vectors });
    const url = `/api/memory/nearest-lessons?id=${source}`;
    const response = request(dense, 'GET', url);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.deepEqual(response.json.neighbours.map(row => row.id), [near, far]);
    assert.ok(response.json.neighbours[0].cosine > response.json.neighbours[1].cosine);
    assert.deepEqual(response.json.skippedMalformed, [malformed]);
    assert.deepEqual(response.json.missingVectors, []);
    const malformedQuery = request(dense, 'GET', `/api/memory/nearest-lessons?id=${malformed}`);
    assert.equal(malformedQuery.status, 200);
    assert.deepEqual(malformedQuery.json, { neighbours: [], skippedMalformed: [malformed], missingVectors: [] });
    vectors.delete(near);
    const missing = request(dense, 'GET', url);
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.json.neighbours.map(row => row.id), [far]);
    assert.deepEqual(missing.json.missingVectors, [near]);
    assert.deepEqual(missing.json.skippedMalformed, [malformed]);
    const queryMissing = request(dense, 'GET', `/api/memory/nearest-lessons?id=${near}`);
    assert.equal(queryMissing.status, 503);
    assert.match(queryMissing.text, /dense query vector unavailable/);
    const old = vectors.get(far);
    vectors.set(far, { ...old, textSha: 'stale' });
    const stale = request(dense, 'GET', url);
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.json.missingVectors, [near, far]);
  } finally { fx.close(); }
});

test('lessons endpoint resolves a domain and returns its ranked active corpus deterministically', () => {
  const fx = fixture();
  try {
    const exact = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson',
      title: 'Exact collector lesson',
      body: [
        '## Exact collector lesson',
        '- anchor: stale body anchor is not authoritative',
        '- trigger: collecting billing frames',
        '- rule: preserve every frame',
        '- why: missing frames violate integrity',
        '- evidence: commit abc123',
        '- date: 2026-07-18',
      ].join('\n'),
      links: lessonLinks({ trigger: 'collecting billing frames' }),
    }, fx.token);
    assert.equal(exact.status, 200);

    // Three legacy rows: routed elsewhere or by basename, from before the capture gate.
    const deliveryGlob = seedLegacyLesson(fx, {
      kind: 'lesson',
      title: 'Invoice delivery glob',
      body: '## Invoice delivery glob\n- rule: inject for every V4 file\n- why: shared invariant',
      links: lessonLinks({
        anchor: 'docs/billing-design.md',
        globs: ['app/src/billing_v4/**'],
      }),
    });
    assert.equal(deliveryGlob.status, 200);

    const basenameOnly = seedLegacyLesson(fx, {
      kind: 'lesson',
      title: 'Basename collector lesson',
      body: '## Basename collector lesson\n- rule: basename anchors stay relevant',
      links: lessonLinks({ anchor: 'collector.rs:collectByBasename' }),
    });
    assert.equal(basenameOnly.status, 200);

    // Same domain, ANOTHER file. Until 2026-08-11 this rode along as a
    // `title-index` item - a title with no rule, no why, no evidence - and the
    // whole domain did the same, which is what actually filled the budget.
    const otherFile = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson',
      title: 'Client cache lesson about a different file',
      body: '## Client cache lesson about a different file\n- rule: this must not reach the collector',
      links: lessonLinks({ anchor: 'src/utils/billingStore.ts:setRetentionFloor' }),
    }, fx.token);
    assert.equal(otherFile.status, 200);

    request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson',
      title: 'Inbox must stay quarantined',
      body: '## Inbox must stay quarantined\n- rule: never inject this draft',
      links: lessonLinks({ status: 'inbox' }),
    }, fx.token);
    seedLegacyLesson(fx, {
      kind: 'lesson',
      title: 'Foreign domain lesson',
      body: '## Foreign domain lesson\n- rule: belongs elsewhere',
      links: lessonLinks({ domain: 'domain-shipping' }),
    });

    const old = request(fx.memory, 'POST', '/api/memory/append', {
      kind: 'lesson',
      title: 'Superseded collector rule',
      body: '## Superseded collector rule\n- rule: obsolete rule marker',
      links: lessonLinks(),
    }, fx.token);
    const replacement = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: old.json.id,
      title: 'Current collector rule',
      body: '## Current collector rule\n- rule: current rule marker',
    }, fx.token);
    assert.equal(replacement.status, 200);

    const first = request(
      fx.memory,
      'GET',
      '/api/memory/lessons?path=app%2Fsrc%2Fbilling_v4%2Fcollector.rs',
    );
    const second = request(
      fx.memory,
      'GET',
      '/api/memory/lessons?path=app%2Fsrc%2Fbilling_v4%2Fcollector.rs',
    );
    assert.equal(first.status, 200);
    assert.equal(first.text, second.text);
    assert.equal(first.json.domain, 'domain-billing');
    assert.equal(first.json.algo, 'lessons-v1');
    assert.match(first.json.inputs_hash, /^[a-f0-9]{64}$/);
    assert.equal(first.json.bytes, Buffer.byteLength(first.text, 'utf8'));
    assert.equal(first.json.omitted, 0);
    assert.equal(first.json.items.length, 4);
    assert.deepEqual(first.json.items.map((item) => item.rank), [1, 2, 3, 4]);
    // One of the four arrives through `globs`, and it says so: `class` is a rule
    // about a class this path belongs to, `anchor` is a rule about this path.
    // The two were one label until round `harness-memory-r1`, where the banner
    // ("no lesson NAMES this path") and the items ("match: anchor") were found
    // contradicting each other in the same answer.
    assert.deepEqual(first.json.items.map((item) => item.match), [
      'anchor',
      'anchor',
      'anchor',
      'class',
    ]);
    const versionById = new Map([
      [exact.json.id, 1],
      [deliveryGlob.json.id, 1],
      [basenameOnly.json.id, 1],
      [replacement.json.id, 2],
    ]);
    const expectedInputsHash = crypto.createHash('sha256')
      .update(JSON.stringify(first.json.items.map((item) => [item.uuid, versionById.get(item.id)])))
      .digest('hex');
    assert.equal(first.json.inputs_hash, expectedInputsHash);
    assert.ok(first.json.items.some((item) => item.id === replacement.json.id));
    assert.ok(!first.json.items.some((item) => item.id === old.json.id));
    assert.ok(!first.json.items.some((item) => item.title === 'Inbox must stay quarantined'));
    assert.ok(!first.json.items.some((item) => item.title === 'Foreign domain lesson'));

    const exactItem = first.json.items.find((item) => item.id === exact.json.id);
    assert.deepEqual(exactItem, {
      uuid: exact.json.uuid,
      id: exact.json.id,
      title: 'Exact collector lesson',
      anchor: 'app/src/billing_v4/collector.rs:collect',
      trigger: 'collecting billing frames',
      rule: 'preserve every frame',
      why: 'missing frames violate integrity',
      evidence: 'commit abc123',
      date: '2026-07-18',
      rank: exactItem.rank,
      match: 'anchor',
    });
    // A lesson of the SAME domain anchored at ANOTHER file does not ride along.
    // Measured 2026-08-11 before this rule: `src/features/chart/ChartPane.tsx`
    // was answered with 65 lesson titles of which 0 matched the path (15 124 B),
    // and `svod/src/adapter/mod.rs` with 62 of which 0 matched. A near-miss
    // delivered beside the right answer is worse than no answer at all, and here
    // there was no right answer to sit beside.
    assert.ok(
      !first.json.items.some((item) => item.id === otherFile.json.id),
      JSON.stringify(first.json.items.map((item) => item.title)),
    );
  } finally {
    fx.close();
  }
});

test('lessons endpoint enforces its UTF-8 budget and rejects unsafe paths', () => {
  const fx = fixture();
  try {
    for (let index = 0; index < 5; index += 1) {
      const inserted = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson',
        title: `Large collector lesson ${index}`,
        body: `## Large collector lesson ${index}\n- rule: ${'я'.repeat(5_000)}`,
        links: lessonLinks(),
      }, fx.token);
      assert.equal(inserted.status, 200);
    }

    const capped = request(
      fx.memory,
      'GET',
      '/api/memory/lessons?path=app%2Fsrc%2Fbilling_v4%2Fcollector.rs',
    );
    assert.equal(capped.status, 200);
    assert.equal(capped.json.bytes, Buffer.byteLength(capped.text, 'utf8'));
    assert.ok(capped.json.bytes <= LESSONS_MAX_BYTES);
    assert.ok(capped.json.items.length > 0);
    assert.ok(capped.json.omitted > 0);
    assert.equal(capped.json.items.length + capped.json.omitted, 5);

    for (const pathname of [
      '/api/memory/lessons',
      '/api/memory/lessons?path=%2Fetc%2Fpasswd',
      '/api/memory/lessons?path=src%2F..%2Fsecrets.ts',
      '/api/memory/lessons?path=src%5Cutils%5Cfile.ts',
    ]) {
      const invalid = request(fx.memory, 'GET', pathname);
      assert.equal(invalid.status, 400, pathname);
      assert.match(invalid.json.error, /lesson path/, pathname);
    }

    // A path no PROFILE domain claims lands on the floor, not on nothing.
    //
    // This case asserted `domain: null` until 2026-08-13, and it had been red
    // since `9b4a0a88f` ("route every tracked repository path") made
    // `domain-platform-shell` a `**` catch-all of spec 0: no tracked path is
    // unowned any more, so the assertion described a state the routing map can
    // no longer produce. What still has to hold - and is what this case is
    // about - is that the floor answers with ITS domain and delivers only
    // lessons that match the path, never the domain's whole corpus.
    const floor = request(fx.memory, 'GET', '/api/memory/lessons?path=docs%2Fui-canon.md');
    assert.equal(floor.status, 200);
    assert.equal(floor.json.domain, 'domain-platform-shell');
    assert.deepEqual(floor.json.items, []);
    assert.equal(floor.json.omitted, 0);

    const wrongMethod = request(fx.memory, 'POST', '/api/memory/lessons?path=src%2Fmain.tsx', {});
    assert.equal(wrongMethod.status, 405);
    assert.deepEqual(wrongMethod.json.allowed, ['GET']);
  } finally {
    fx.close();
  }
});

test('an unmatched path is offered the NEAREST lessons, labelled, and never beside a real match', () => {
  const fx = fixture();
  try {
    const seed = (anchor, title) => {
      const res = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson',
        title,
        body: `- rule: ${title}\n- why: because\n`,
        links: { domain: 'domain-platform-shell', anchor, status: 'active' },
      }, fx.token);
      assert.equal(res.status, 200, JSON.stringify(res.json));
    };
    seed('src/services/alpha.ts:one', 'the neighbour rule');
    seed('src/services/beta.ts:two', 'the other neighbour rule');
    seed('src/services/gamma.ts:three', 'the third neighbour rule');
    seed('web/apps/app/lib/faraway.ts:four', 'a rule from another tree');

    // A sibling nobody anchored anything to: 492 of 683 real lessons are
    // anchored `file:SYMBOL`, so this is the ordinary case, not the odd one.
    const near = request(fx.memory, 'GET', '/api/memory/lessons?path=src%2Fservices%2Fdelta.ts');
    assert.equal(near.status, 200);
    assert.ok(near.json.items.length > 0, 'the nearest lessons are offered');
    assert.ok(near.json.items.length <= 3, 'and capped at three');
    for (const item of near.json.items) {
      assert.equal(item.match, 'nearby', 'every offer says it is not about this file');
      assert.ok(
        item.anchor.startsWith('src/services/'),
        `nearest means the DIRECTORY, not the domain: ${item.anchor}`,
      );
    }
    assert.equal(near.json.nearby, near.json.items.length);

    // A path with a REAL match is never diluted - the whole reason the removed
    // title-index was a distractor is that it rode beside the right answer.
    const exact = request(fx.memory, 'GET', '/api/memory/lessons?path=src%2Fservices%2Falpha.ts');
    assert.equal(exact.status, 200);
    assert.ok(exact.json.items.length > 0);
    for (const item of exact.json.items) {
      assert.equal(item.match, 'anchor', 'an exact answer carries no nearby offers');
    }
    assert.ok(!exact.json.nearby, 'and is not marked as one');

    // Nothing near at all: no items, and the answer says how many the domain
    // holds so "not anchored here" cannot read as "nothing is known".
    const far = request(fx.memory, 'GET', '/api/memory/lessons?path=app%2Fsrc%2Fdeep%2Fnested%2Ffile.rs');
    assert.equal(far.status, 200);
    assert.deepEqual(far.json.items, []);
    assert.ok(far.json.domain_active >= 4, 'the answer names what the domain holds');
  } finally {
    fx.close();
  }
});

test('an exact lesson too big for the budget is never replaced by a neighbour', () => {
  const fx = fixture();
  try {
    const seed = (anchor, title, body) => {
      const res = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title, body,
        links: { domain: 'domain-platform-shell', anchor, status: 'active' },
      }, fx.token);
      assert.equal(res.status, 200, JSON.stringify(res.json));
    };
    seed('src/services/neighbour.ts:one', 'a neighbour rule', '- rule: near\n');
    // Anchored to the asked path and ALONE bigger than the payload ceiling.
    seed(
      'src/services/huge.ts:two',
      'the rule that does not fit',
      `- rule: ${'x'.repeat(LESSONS_MAX_BYTES + 1000)}\n`,
    );

    const res = request(fx.memory, 'GET', '/api/memory/lessons?path=src%2Fservices%2Fhuge.ts');
    assert.equal(res.status, 200);
    // It may deliver nothing - the lesson genuinely does not fit - but it must
    // NOT say nothing is anchored here and hand over a stranger instead.
    for (const item of res.json.items) {
      assert.notEqual(item.match, 'nearby', `a path WITH a lesson got a neighbour: ${item.anchor}`);
    }
    assert.ok(!res.json.nearby, 'and is not announced as a nearby answer');
    assert.ok(res.json.omitted > 0, 'the loss is stated, never erased with omitted: 0');
  } finally {
    fx.close();
  }
});

test('a rule too big for the payload does not swallow the rules sorted behind it', () => {
  const fx = fixture();
  try {
    const seed = (anchor, title, body) => {
      const res = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title, body,
        links: { domain: 'domain-platform-shell', anchor, status: 'active' },
      }, fx.token);
      assert.equal(res.status, 200, JSON.stringify(res.json));
    };
    // Items are admitted in TITLE order, so the oversized one is tried first.
    seed(
      'src/services/huge.ts:one',
      'AAA a rule nobody can carry',
      `- rule: ${'x'.repeat(LESSONS_MAX_BYTES + 1000)}\n`,
    );
    seed('src/services/huge.ts:two', 'zzz a rule that fits easily', '- rule: small and true\n');

    const res = request(fx.memory, 'GET', '/api/memory/lessons?path=src%2Fservices%2Fhuge.ts');
    assert.equal(res.status, 200);
    assert.ok(
      res.json.items.some((item) => item.title === 'zzz a rule that fits easily'),
      `the rule that fits is delivered: ${JSON.stringify(res.json.items.map((i) => i.title))}`,
    );
    assert.equal(res.json.omitted, 1, 'and the one that does not fit is still counted as lost');
    assert.ok(res.json.bytes <= LESSONS_MAX_BYTES, `inside the ceiling: ${res.json.bytes}`);
  } finally {
    fx.close();
  }
});

// THE INVARIANT THE SENSOR EXISTS FOR: it may warn early, never late.
//
// `deliveredLessonBytes` is what `check-domain-routing.mjs` compares against the
// ceiling, and it must never report FEWER bytes than the answer the service will
// actually send - otherwise a file whose delivery is about to start dropping
// lessons passes the check in silence. Round `lessons-wire-r1` measured exactly
// that, three seats independently: the first version hard-coded
// `domain_active: 0` while the live nearby branch writes the domain's real
// count, so at three digits the sensor read 49 152 and the wire came to 49 153.
// The sweep below walks the boundary rather than testing one size, because the
// window that defect lived in was ONE byte wide.
test('the delivery sensor is never lighter than the answer it is guarding', () => {
  const fx = fixture();
  try {
    const seed = (links, title, body) => {
      const res = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title, body,
        links: { domain: 'domain-platform-shell', status: 'active', ...links },
      }, fx.token);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      return res.json.id;
    };
    // Enough far lessons that the domain's active count is THREE digits, which
    // is what makes the envelope field wider than a hard-coded zero.
    for (let index = 0; index < 100; index += 1) {
      seed({ anchor: `src/far/file${index}.ts:one` }, `far lesson ${index}`, '- rule: far\n');
    }
    let id = seed(
      { anchor: 'src/services/klass.ts:one', globs: ['src/services/*.ts'] },
      'the class rule',
      '- rule: seed\n',
    );
    // ONE unreadable row, because a domain that has one makes every live answer
    // carry `invalid: 1` - twelve bytes the sensor missed for a whole round.
    // Valid JSON of the wrong shape is how such a row really arrives: the column
    // carries a `json_valid` check and the API rejects worse.
    const broken = seed({ anchor: 'src/far/broken.ts:one' }, 'a row nobody can read', '- rule: x\n');
    fx.db.prepare('UPDATE mem_entries SET links = ? WHERE id = ?').run('[]', broken);

    const rowsFor = () => fx.db
      .prepare("SELECT id, uuid, title, body, links, version FROM mem_entries WHERE superseded_by IS NULL AND kind = 'lesson' AND title = 'the class rule'")
      .all();
    const domainActive = () => Number(
      fx.db
        .prepare("SELECT COUNT(*) AS n FROM mem_entries WHERE superseded_by IS NULL AND kind = 'lesson'")
        .get().n,
    );

    let late = 0;
    for (let slack = 0; slack <= 60; slack += 1) {
      const grown = request(fx.memory, 'POST', '/api/memory/supersede', {
        id,
        title: 'the class rule',
        body: `- rule: ${'x'.repeat(LESSONS_MAX_BYTES - 430 + slack)}\n`,
        links: {
          domain: 'domain-platform-shell', status: 'active',
          anchor: 'src/services/klass.ts:one', globs: ['src/services/*.ts'],
        },
      }, fx.token);
      assert.equal(grown.status, 200, JSON.stringify(grown.json));
      id = grown.json.id;

      const live = request(fx.memory, 'GET', '/api/memory/lessons?path=src%2Fservices%2Fdelta.ts');
      assert.equal(live.status, 200);
      const sensor = deliveredLessonBytes(
        'domain-platform-shell',
        rowsFor(),
        domainActive(),
        1,
      );
      assert.ok(
        live.json.invalid === 1,
        `the fixture has to reach the branch that carries invalid: ${JSON.stringify(live.json.invalid)}`,
      );
      const delivered = live.json.items.some((item) => item.title === 'the class rule');
      if (!delivered && sensor <= LESSONS_MAX_BYTES) late += 1;
      if (delivered) {
        assert.ok(
          sensor >= live.json.bytes,
          `slack ${slack}: the sensor reads ${sensor} for an answer of ${live.json.bytes}`,
        );
      }
    }
    assert.equal(
      late, 0,
      'every size at which delivery drops the rule must already be over the ceiling in the sensor',
    );
  } finally {
    fx.close();
  }
});

test('a class answer is weighed with the envelope it will actually be sent with', () => {
  const fx = fixture();
  try {
    const seed = (links, title, body) => {
      const res = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title, body,
        links: { domain: 'domain-platform-shell', status: 'active', ...links },
      }, fx.token);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      return res.json.id;
    };
    // Reached by GLOB, so this answer carries `domain_active` and `nearby` on
    // top of its items - the fields the class-admission loop did not weigh.
    let id = seed(
      { anchor: 'src/services/klass.ts:one', globs: ['src/services/*.ts'] },
      'the class rule',
      '- rule: seed\n',
    );

    // Walk a window across the ceiling rather than guessing the one size that
    // exposes it: the gap between "items alone" and "items plus envelope" is a
    // few dozen bytes, and stepping through 200 of them lands inside it.
    for (let slack = 0; slack <= 200; slack += 20) {
      const grown = request(fx.memory, 'POST', '/api/memory/supersede', {
        id,
        title: 'the class rule',
        body: `- rule: ${'x'.repeat(LESSONS_MAX_BYTES - 400 + slack)}\n`,
        links: {
          domain: 'domain-platform-shell', status: 'active',
          anchor: 'src/services/klass.ts:one', globs: ['src/services/*.ts'],
        },
      }, fx.token);
      assert.equal(grown.status, 200, JSON.stringify(grown.json));
      // Each supersede mints a NEW id; superseding the old one again is a 409.
      id = grown.json.id;

      const res = request(fx.memory, 'GET', '/api/memory/lessons?path=src%2Fservices%2Fdelta.ts');
      assert.equal(res.status, 200);
      assert.ok(
        res.json.bytes <= LESSONS_MAX_BYTES,
        `slack ${slack}: the answer crossed the ceiling at ${res.json.bytes}`,
      );
      assert.equal(
        res.json.bytes,
        Buffer.byteLength(JSON.stringify(res.json), 'utf8'),
        `slack ${slack}: the number it reports is the number it weighs`,
      );
    }
  } finally {
    fx.close();
  }
});

test('an anchored answer counts its own invalid marker in the size it reports', () => {
  const fx = fixture();
  try {
    const seed = (anchor, title, body) => {
      const res = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title, body,
        links: { domain: 'domain-platform-shell', anchor, status: 'active' },
      }, fx.token);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      return res.json.id;
    };
    seed('src/services/alpha.ts:one', 'the anchored rule', '- rule: small and true\n');
    const broken = seed('src/services/beta.ts:two', 'a row nobody can read', '- rule: x\n');
    // A direct-SQLite import bypasses endpoint validation, which is the whole
    // reason `invalid` exists. Valid JSON of the WRONG SHAPE is how such a row
    // really arrives - the column carries a `json_valid` check, so unparseable
    // bytes cannot be written even by hand.
    fx.db.prepare('UPDATE mem_entries SET links = ? WHERE id = ?').run('[]', broken);

    const res = request(fx.memory, 'GET', '/api/memory/lessons?path=src%2Fservices%2Falpha.ts');
    assert.equal(res.status, 200);
    assert.ok(res.json.invalid > 0, 'the unreadable row is counted, loudly');
    assert.equal(
      res.json.bytes,
      Buffer.byteLength(JSON.stringify(res.json), 'utf8'),
      'and the marker is inside the size, not appended after it was settled',
    );
  } finally {
    fx.close();
  }
});

test('a neighbour too big to send does not empty the offer behind it', () => {
  const fx = fixture();
  try {
    const seed = (anchor, title, body) => {
      const res = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title, body,
        links: { domain: 'domain-platform-shell', anchor, status: 'active' },
      }, fx.token);
      assert.equal(res.status, 200, JSON.stringify(res.json));
    };
    // Neighbours sort by depth, then by id DESCENDING - so the one seeded LAST
    // among siblings is tried first. The huge one goes last on purpose.
    seed('src/services/deep/small.ts:one', 'a neighbour that fits', '- rule: small and true\n');
    seed(
      'src/services/deep/huge.ts:two',
      'a neighbour nobody can carry',
      `- rule: ${'x'.repeat(LESSONS_MAX_BYTES + 1000)}\n`,
    );

    const res = request(
      fx.memory,
      'GET',
      '/api/memory/lessons?path=src%2Fservices%2Fdeep%2Ftarget.ts',
    );
    assert.equal(res.status, 200);
    assert.ok(
      res.json.items.some((item) => item.title === 'a neighbour that fits'),
      `the neighbour that fits is still offered: ${JSON.stringify(res.json.items.map((i) => i.title))}`,
    );
  } finally {
    fx.close();
  }
});

test('the byte gate weighs the WHOLE answer, envelope fields included', () => {
  const fx = fixture();
  try {
    const seed = (anchor, title, body) => {
      const res = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title, body,
        links: { domain: 'domain-platform-shell', anchor, status: 'active' },
      }, fx.token);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      return res.json.id;
    };
    const ask = () => {
      const res = request(fx.memory, 'GET', '/api/memory/lessons?path=src%2Fservices%2Fdelta.ts');
      assert.equal(res.status, 200);
      return res.json;
    };
    const CEILING = LESSONS_MAX_BYTES;

    seed('src/services/one.ts:a', 'neighbour one', `- rule: ${'a'.repeat(4000)}\n`);
    const alone = ask();
    assert.equal(alone.nearby, 1, 'one neighbour rides');

    // Size the SECOND so the whole answer lands just past the ceiling. The gate
    // that weighed only the items admitted it - `domain_active`, `nearby` and
    // `invalid` are attached afterwards - and the caller received a body over
    // the contract it is measured against.
    const probe = 2000;
    const two = seed('src/services/two.ts:b', 'neighbour two', `- rule: ${'b'.repeat(probe)}\n`);
    const withTwo = ask();
    assert.equal(withTwo.nearby, 2, 'and the second fits while it is small');
    const overhead = (withTwo.bytes - alone.bytes) - probe;

    const wanted = CEILING + 20 - alone.bytes - overhead;
    const grown = request(fx.memory, 'POST', '/api/memory/supersede', {
      id: two,
      title: 'neighbour two',
      body: `- rule: ${'b'.repeat(wanted)}\n`,
      links: { domain: 'domain-platform-shell', anchor: 'src/services/two.ts:b', status: 'active' },
    }, fx.token);
    assert.equal(grown.status, 200, JSON.stringify(grown.json));

    const answer = ask();
    assert.ok(
      answer.bytes <= CEILING,
      `the delivered answer stays inside the ceiling: ${answer.bytes} (nearby ${answer.nearby})`,
    );
    assert.equal(
      answer.bytes,
      Buffer.byteLength(JSON.stringify(answer), 'utf8'),
      'and the number it reports is the number it weighs',
    );
  } finally {
    fx.close();
  }
});

test('a file whose NAME carries a glob metacharacter still matches its own anchor', () => {
  const fx = fixture();
  try {
    const seed = (links, title) => {
      const res = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title, body: `- rule: ${title}\n`,
        links: { domain: 'domain-platform-shell', status: 'active', ...links },
      }, fx.token);
      assert.equal(res.status, 200, JSON.stringify(res.json));
    };
    // A real tracked path in this repository's shape: 78 Next.js dynamic routes
    // are spelled `[id]`, and `[id]` read as a glob is a character class that
    // matches ONE of `i`/`d` - so the anchor never matched its own file.
    seed({ anchor: 'web/app/workspaces/[id]/route.ts:MAX' }, 'the rule about this very route');
    seed({ anchor: 'web/app/workspaces/other.ts:one' }, 'a neighbour rule');
    // The BASENAME route carries the same asymmetry: an anchor that is a bare
    // file name follows the file wherever it moves, and a bracketed name must
    // follow it too.
    seed({ anchor: '[slug].tsx:render' }, 'the rule that follows the file by name');

    const res = request(
      fx.memory,
      'GET',
      `/api/memory/lessons?path=${encodeURIComponent('web/app/workspaces/[id]/route.ts')}`,
    );
    assert.equal(res.status, 200);
    const own = res.json.items.find((item) => item.title === 'the rule about this very route');
    assert.ok(own, `its own lesson is delivered: ${JSON.stringify(res.json.items.map((i) => i.title))}`);
    assert.equal(own.match, 'anchor', 'and it is named as anchored, not offered as a neighbour');
    assert.ok(!res.json.nearby, 'a named path opens no neighbour channel');

    const moved = request(
      fx.memory,
      'GET',
      `/api/memory/lessons?path=${encodeURIComponent('web/app/pages/[slug].tsx')}`,
    );
    assert.equal(moved.status, 200);
    const byName = moved.json.items.find((item) => item.title === 'the rule that follows the file by name');
    assert.ok(byName, `a bare basename anchor reaches its bracketed file: ${JSON.stringify(moved.json.items.map((i) => i.title))}`);
    assert.equal(byName.match, 'anchor', 'by name is still by anchor');
  } finally {
    fx.close();
  }
});

test('a path matched only by a GLOB keeps its neighbours - a class rule is not an anchor', () => {
  const fx = fixture();
  try {
    const seed = (links, title) => {
      const res = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title, body: `- rule: ${title}\n`,
        links: { domain: 'domain-platform-shell', status: 'active', ...links },
      }, fx.token);
      assert.equal(res.status, 200, JSON.stringify(res.json));
    };
    seed({ anchor: 'src/services/alpha.ts:one' }, 'the neighbour rule');
    seed({ anchor: 'src/services/beta.ts:two' }, 'the other neighbour rule');
    seed({ anchor: 'src/services/gamma.ts:three' }, 'the third neighbour rule');
    // A rule about the CLASS: it reaches every file of the directory by glob,
    // and names none of them.
    seed(
      { anchor: 'src/services/klass.ts:four', globs: ['src/services/*.ts'] },
      'the class rule',
    );

    // Measured 2026-08-21 before this gate existed: the class rule alone was
    // delivered here and the three neighbours were dropped, because a glob match
    // counted as "something is anchored to this path". Over the real tree that
    // cost 279 files their nearby channel, 212 of them for a rule that was
    // already their first neighbour.
    const near = request(fx.memory, 'GET', '/api/memory/lessons?path=src%2Fservices%2Fdelta.ts');
    assert.equal(near.status, 200);
    const kinds = near.json.items.map((item) => item.match);
    assert.ok(kinds.includes('class'), `the class rule is delivered and says so: ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes('nearby'), `and the neighbours still ride: ${JSON.stringify(kinds)}`);
    assert.equal(
      near.json.items.filter((item) => item.title === 'the class rule').length,
      1,
      'the class rule is offered once, not once as a match and once as a neighbour',
    );
    assert.equal(
      near.json.nearby,
      near.json.items.filter((item) => item.match === 'nearby').length,
      'the count says how many of the items are neighbours',
    );

    // A path the lesson NAMES is still never diluted.
    const exact = request(fx.memory, 'GET', '/api/memory/lessons?path=src%2Fservices%2Falpha.ts');
    assert.equal(exact.status, 200);
    for (const item of exact.json.items) {
      assert.notEqual(item.match, 'nearby', 'a named path carries no neighbours');
    }
    assert.ok(
      exact.json.items.some((item) => item.match === 'anchor'),
      'and the rule that names it is delivered as an anchor',
    );
    assert.ok(!exact.json.nearby, 'and is not marked as a nearby answer');
  } finally {
    fx.close();
  }
});

test('a class rule that matched is never dropped to make room for a neighbour', () => {
  const fx = fixture();
  try {
    const seed = (links, title, body) => {
      const res = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title, body,
        links: { domain: 'domain-platform-shell', status: 'active', ...links },
      }, fx.token);
      assert.equal(res.status, 200, JSON.stringify(res.json));
    };
    // Sized so that the class rule fits ALONE and the two together do not: the
    // neighbour is what has to give way, and a budget check that weighs only the
    // neighbours cannot see that.
    seed(
      { anchor: 'src/services/neighbour.ts:one' },
      'a neighbour rule',
      `- rule: ${'n'.repeat(2000)}\n`,
    );
    seed(
      { anchor: 'src/services/klass.ts:two', globs: ['src/services/*.ts'] },
      'the class rule that fills the payload',
      // Just under the ceiling, so it fits ALONE and the pair does not.
      `- rule: ${'x'.repeat(LESSONS_MAX_BYTES - 1500)}\n`,
    );

    const res = request(fx.memory, 'GET', '/api/memory/lessons?path=src%2Fservices%2Fdelta.ts');
    assert.equal(res.status, 200);
    assert.ok(
      res.json.items.some((item) => item.title === 'the class rule that fills the payload'),
      'the rule that matched is delivered',
    );
    assert.ok(res.json.bytes <= LESSONS_MAX_BYTES, `the payload stays inside the ceiling: ${res.json.bytes}`);
    assert.equal(res.json.nearby, 0, 'the neighbour that did not fit is not counted as delivered');
  } finally {
    fx.close();
  }
});

test('a file directly under a top-level directory is not offered the whole domain', () => {
  const fx = fixture();
  try {
    const seed = (anchor, title) => {
      const res = request(fx.memory, 'POST', '/api/memory/append', {
        kind: 'lesson', title, body: `- rule: ${title}\n`,
        links: { domain: 'domain-platform-shell', anchor, status: 'active' },
      }, fx.token);
      assert.equal(res.status, 200, JSON.stringify(res.json));
    };
    seed('scripts/sibling.mjs:one', 'a rule in the same directory');
    seed('web/apps/app/lib/faraway.ts:two', 'a rule from another tree entirely');

    // `own` is one segment here, so the parent floor used to be ZERO and every
    // lesson of the domain qualified - the domain dump under a nearby label.
    const res = request(fx.memory, 'GET', '/api/memory/lessons?path=scripts%2Funanchored.mjs');
    assert.equal(res.status, 200);
    assert.ok(res.json.items.length > 0, 'the true sibling is still offered');
    for (const item of res.json.items) {
      assert.ok(
        item.anchor.startsWith('scripts/'),
        `a shallow path demands its OWN directory: ${item.anchor}`,
      );
    }
  } finally {
    fx.close();
  }
});

await runStoreTests();
