// Origin: coder-codex-0ce1c2 (S3a); adapted frozen gold/dropped assertions.
import '../jev-test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { activeGold, aggregate, appendDenseExtras, measure, retrieveCandidates, scoreCandidates, selectScored } from './eval-lesson-selection-s3a.mjs';

const row = (id, anchor, status = 'active') => ({ id, title: `lesson ${id}`, body: '- rule: test',
  anchor, trigger: '', rule: 'test', links: { anchor, status } });

test('stage 1 uses dense kind search, exact anchor union, dedupes and excludes inactive', async () => {
  const routes = [];
  const result = await retrieveCandidates('Task: fix "cache" OR race', ['src/a.ts'], [row(1, 'src/a.ts'), row(2, 'src/b.ts'), row(3, 'src/a.ts', 'retired')],
    async (route) => { routes.push(route); return [{ id: 2 }, { id: 3 }, { id: 1 }]; });
  assert.match(routes[0], /kind=lesson&limit=200&offset=0$/);
  assert.ok(!decodeURIComponent(routes[0]).includes('"cache" OR'));
  assert.deepEqual(result.map((r) => [r.id, r.denseRank, r.anchored]), [[2, 0, false], [1, 1, true]]);
});

test('inactive dense hits do not consume top-K active slots', async () => {
  const routes = [];
  const candidate = row(300, 'src/c.ts');
  const result = await retrieveCandidates('Task: cache', [], [candidate], async (route) => {
    routes.push(route);
    return routes.length === 1 ? Array.from({ length: 200 }, (_, id) => ({ id: id + 1 })) : [{ id: 300 }];
  });
  assert.equal(routes.length, 2);
  assert.match(routes[1], /offset=200$/);
  assert.deepEqual(result.map((item) => [item.id, item.denseRank]), [[300, 0]]);
});

test('Jev score threshold is inclusive, anchors survive K, byte budget excludes overflow', async () => {
  const candidates = [row(1, 'src/a.ts'), row(2, 'src/b.ts'), row(3, 'src/a.ts')]
    .map((r, i) => ({ ...r, denseRank: i, anchored: i === 2 }));
  let calls = 0;
  const { scores, calls: count } = await scoreCandidates(candidates, 'Task: test', async ({ questions }) => {
    calls++;
    assert.equal(Object.keys(questions).length, 3);
    return { answers: { lesson_0: { noul: 0.7 }, lesson_1: { noul: 0.5 }, lesson_2: { noul: 0.6 } } };
  });
  assert.equal(calls, count);
  assert.deepEqual(selectScored(candidates, scores, 1, 0.6).ids, [1, 3]);
  assert.deepEqual(selectScored(candidates, scores, 2, 0.5).ids, [1, 3, 2]);
  assert.deepEqual(selectScored(candidates, scores, 1, 0.7).ids, [1]);
  assert.deepEqual(selectScored(candidates, scores, 1, 0.5, 1).ids, []);
});

test('D keeps C in order, scores only dense extras, gates file matches, and fills only remaining bytes', async () => {
  const cIds = ['1'];
  const candidates = [
    { ...row(1, 'src/a.ts'), denseRank: 0, anchored: true },
    { ...row(2, 'src/b.ts'), denseRank: 1, anchored: false },
    { ...row(3, 'src/c.ts'), denseRank: 2, anchored: true },
    { ...row(4, 'src/d.ts'), denseRank: Infinity, anchored: true },
  ];
  const extras = candidates.filter((item) => item.denseRank < 3 && !cIds.includes(String(item.id)));
  assert.deepEqual(extras.map((item) => item.id), [2, 3]);
  const { scores, calls } = await scoreCandidates(extras, 'Task: test', async () => ({ answers: {
    lesson_0: { noul: 0.7 }, lesson_1: { noul: 0.59 },
  } }));
  assert.equal(calls, 1);
  const chosen = appendDenseExtras(cIds, candidates, scores, 3, 0.6, 1000);
  assert.deepEqual(chosen.ids, ['1', 2]);
  assert.deepEqual(chosen.addedIds, [2]);
  assert.ok(chosen.extraBytes > 0);
  assert.deepEqual(appendDenseExtras(cIds, candidates, scores, 3, 0.7, chosen.extraBytes - 1).ids, ['1']);
  assert.deepEqual(appendDenseExtras(cIds, candidates, scores, 1, 0.6, 1000).ids, ['1']);
});

test('D gain counts only new gold lineage roots, not duplicate versions or nongold extras', () => {
  const versions = new Map([[1, { root: 10 }], [2, { root: 10 }], [3, { root: 30 }], [4, { root: 40 }]]);
  const gold = [10, 30];
  const c = measure([1], gold, versions, 100, 0, 1);
  const d = measure([1, 2, 3, 4], gold, versions, 300, 1, 2);
  assert.equal(c.recall, 0.5);
  assert.equal(d.recall, 1);
  assert.equal(d.noise, 1 / 3);
  const cRoots = new Set([1].map((id) => versions.get(id).root));
  assert.deepEqual([...new Set([2, 3, 4].map((id) => versions.get(id).root))]
    .filter((root) => gold.includes(root) && !cRoots.has(root)), [30]);
});

test('frozen gold uses lineage roots and frozen dropped; recall and noise use mean case shares', () => {
  const { gold, excluded } = activeGold({ gold: [{ root: 10 }, { root: 10 }], dropped: [{ root: 30, status: 'retired' }] });
  assert.deepEqual(gold, [10]);
  assert.equal(excluded, 1);
  const versions = new Map([[11, { root: 10 }], [12, { root: 10 }], [20, { root: 20 }]]);
  const a = measure([11, 12, 20], gold, versions, 120, 2, 5);
  const b = measure([], [], versions, 0, 0, 3);
  assert.equal(a.recall, 1);
  assert.equal(a.noise, 0.5);
  assert.deepEqual(aggregate([a, b]), { cases: 2, goldCases: 1, goldRecall: 1, noiseShare: 0.5,
    precision: 0.5, noiseCount: 1, deliveredBytes: 60, jevCallsPerCase: 1,
    jevCallsTotal: 2, wallMs: 8 });
});

test('a broken Jev answer fails instead of silently selecting zero lessons', async () => {
  await assert.rejects(scoreCandidates([row(1, 'src/a.ts')], 'Task: test', async () => ({ error: 'timeout' })), /Jev unavailable/);
});
