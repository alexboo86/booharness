// Unit tests for the near-duplicate lesson scorer. Pure functions only;
// the live-service path is exercised by running the script itself.
// Run: node --test scripts/memory/test-lesson-duplicates.mjs
import '../jev-test-state.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_THRESHOLD,
  anchorFile,
  candidatePair,
  findConflicts,
  findDuplicatePairs,
  jaccardSimilarity,
  normalizeWordSet,
} from './lesson-duplicates.mjs';

// The calibration pair from the task brief: two wordings of the same
// zoom/relayout rule. Must score at or above the 0.5 default threshold.
const ZOOM_A_TITLE = 'Zoom must re-lay-out snapped candles, not rescale them';
const ZOOM_A_RULE = 'On pan or zoom, rebuild price and cluster geometry from the current view; never matrix-rescale geometry snapped for an older view.';
const ZOOM_B_TITLE = 'Zoom: re-lay out chart geometry, never rescale it';
const ZOOM_B_RULE = 'Rebuild candle and cluster geometry from the current view on each view change.';

const zoomA = `${ZOOM_A_TITLE}\n${ZOOM_A_RULE}`;
const zoomB = `${ZOOM_B_TITLE}\n${ZOOM_B_RULE}`;

const OTHER_TITLE = 'Commits require explicit pathspecs';
const OTHER_RULE = 'Never use git add -A or a bare commit; stage named paths and inspect the diff.';

function lesson(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status || 'active',
    body: `- rule: ${row.rule}`,
    linksObj: { anchor: row.anchor ?? 'src/chart.ts:foo', status: row.status || 'active' },
  };
}

test('calibration pair: same rule, two wordings -> >= 0.5', () => {
  const score = jaccardSimilarity(zoomA, zoomB);
  assert.ok(score >= 0.5, `expected >= 0.5, got ${score}`);
});

// Regression fixture: lessons #11804 and #11824 (2026-09-25, found by hand;
// 11824 was merged into 11804 — both now superseded, so live runs cannot see
// them). Original title+rule verbatim, read raw via `memoryctl get` (no
// --follow). The DEFAULT threshold must flag this pair.
const REGRESSION_11804 = {
  id: 11804,
  title: 'Zoom must re-lay-out snapped candles, not rescale them',
  rule: 'On pan or zoom, rebuild price and cluster geometry from the current view; never matrix-rescale geometry snapped for an older view.',
  anchor: 'app/desktop/src/chart_item.cpp:updatePaintNode',
  status: 'inbox',
};
const REGRESSION_11824 = {
  id: 11824,
  title: 'Zoom: re-lay out chart geometry, never rescale it',
  rule: 'Rebuild candle and cluster geometry from the current view on each view change.',
  anchor: 'app/desktop/src/chart_item.cpp:updatePaintNode',
  status: 'inbox',
};

test('regression #11804/#11824 is flagged at the DEFAULT threshold', () => {
  const pairs = findDuplicatePairs(
    [lesson(REGRESSION_11804), lesson(REGRESSION_11824)],
    DEFAULT_THRESHOLD,
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].idA, 11804);
  assert.equal(pairs[0].idB, 11824);
  assert.equal(pairs[0].anchorFile, 'app/desktop/src/chart_item.cpp');
  assert.ok(pairs[0].similarity >= DEFAULT_THRESHOLD);
});

test('agreement is not a conflict: the #11804/#11824 rules are not a candidate', () => {
  const pairs = findConflicts([lesson(REGRESSION_11804), lesson(REGRESSION_11824)]);
  assert.equal(pairs.length, 0); // rule-word overlap 0.33 < 0.4: not even a candidate
});

// Reviewer-grok-cdaa79.1 round-three examples: the lexical stage SELECTS
// CANDIDATES for the curator; nothing says "contradict". Tests below assert
// candidates, never conflicts.
const QUALIFIER_A = 'Do not port JS Math.round with f64::round in Rust.';
const QUALIFIER_B = 'Port JS Math.round with floor in Rust.';
const NOT_THE_CACHE_A = 'Always rebuild the price ladder from the current view, not the cache.';
const NOT_THE_CACHE_B = 'Rebuild the price ladder from the current view on each zoom.';
const NOOP_A = 'The transform is a no-op for cached rows.';
const NOOP_B = 'Retry the transform with backoff.';

test('candidates: qualifier after a colon, trailing negation, shared imperative', () => {
  assert.ok(candidatePair(QUALIFIER_A, QUALIFIER_B), 'qualifier pair must be a candidate');
  assert.ok(candidatePair(NOT_THE_CACHE_A, NOT_THE_CACHE_B), 'trailing-negation pair must be a candidate');
  assert.ok(candidatePair(
    'Never rebuild candle geometry from the current view on each view change.',
    'Always rebuild candle geometry from the current view on each view change.',
  ), 'a true contradiction must be a candidate');
});

test('not candidates: negation inside a compound, disjoint objects, same polarity', () => {
  // 'no-op' flips polarity lexically, but the word overlap is far too low
  assert.equal(candidatePair(NOOP_A, NOOP_B), null);
  assert.equal(candidatePair(
    'Always rebuild candle geometry from the current view on each view change.',
    'Never store raw trades in Database without validation.',
  ), null);
  assert.equal(candidatePair('Never matrix-rescale geometry snapped for an older view.', 'never rescale it'), null);
});

// Regression (reviewer-codex-29cbbf.1, reproduced live 2026-09-25): rule
// texts from memoryd, with provider/host/path identifiers neutralized. The lexical stage decides which pairs the
// curator reads; none is reported as a conflict.
const REGRESSION_11908_RULE = 'Do not port JS Math.round with f64::round. Half-values differ for negatives: Math.round(-0.5) is -0 (equals 0); Rust rounds to -1.';
const REGRESSION_11918_RULE = 'Port Math.round as f=floor(x); x-f>=0.5 ? f+1 : f. Both f64::round and (x+0.5).floor() differ from JS.';
const REGRESSION_3892_RULE = 'Do not flush large_prints_v1 every 5s. Hold until 1000 rows or 60s. Live UI/alerts use overlay_fresh_prints on fresh_tail (6h RAM); structure_driver load_ltz_filtered_prints is a multi-day historical CH read.';
const REGRESSION_11638_RULE = 'Читай только с FINAL; глубина provider ~5 мес с 2026-04, «с 2024» — один импортированный месяц на host-a.';

const FALSE_PAIR_ROWS = [
  lesson({ id: 11908, title: 'f64::round is not JS Math.round on negative halves', rule: REGRESSION_11908_RULE, anchor: 'app/desktop/core/src/dom_ladder.rs:round' }),
  lesson({ id: 11918, title: 'Emulate JS Math.round from floor, not x+0.5', rule: REGRESSION_11918_RULE, anchor: 'app/desktop/core/src/dom_ladder.rs:js_round' }),
  lesson({ id: 3892, title: 'large_prints live readers overlay the RAM tail', rule: REGRESSION_3892_RULE, anchor: 'app/src/large_prints.rs:should_flush_pending' }),
  lesson({ id: 11638, title: 'large_prints_v1: без FINAL дублируется', rule: REGRESSION_11638_RULE, anchor: 'app/src/large_prints.rs' }),
  lesson({ id: 9001, title: 'Qualifiers', rule: QUALIFIER_A, anchor: 'app/desktop/core/src/dom_ladder.rs:q1' }),
  lesson({ id: 9002, title: 'Qualifiers 2', rule: QUALIFIER_B, anchor: 'app/desktop/core/src/dom_ladder.rs:q2' }),
  lesson({ id: 9003, title: 'Cache', rule: NOT_THE_CACHE_A, anchor: 'src/ladder.ts:c1' }),
  lesson({ id: 9004, title: 'Cache 2', rule: NOT_THE_CACHE_B, anchor: 'src/ladder.ts:c2' }),
  lesson({ id: 9005, title: 'Noop', rule: NOOP_A, anchor: 'src/transform.ts:n1' }),
  lesson({ id: 9006, title: 'Retry', rule: NOOP_B, anchor: 'src/transform.ts:n2' }),
  // same polarity, high overlap: must NEVER be a candidate
  lesson({ id: 9007, title: 'Never A', rule: 'Never flush candle geometry on zoom.', anchor: 'src/never.ts:a' }),
  lesson({ id: 9008, title: 'Never B', rule: 'Never compact candle geometry on zoom.', anchor: 'src/never.ts:b' }),
];

test('the lexical stage decides which of the five false pairs are candidates', () => {
  const pairs = findConflicts(FALSE_PAIR_ROWS);
  const byId = new Map(FALSE_PAIR_ROWS.map((row) => [row.id, row]));
  // Candidates: #11908/#11918 (rule Jaccard 0.5) and the reviewer's
  // qualifier and trailing-negation pairs; NOT candidates: #3892/#11638
  // (cross-language, ~zero word overlap) and no-op vs retry ('no-op' flips
  // polarity lexically but the overlap is far too low).
  const ids = pairs.map((pair) => `${pair.idA}/${pair.idB}`).sort();
  assert.deepEqual(ids, ['11908/11918', '9001/9002', '9003/9004']);
  for (const pair of pairs) {
    assert.equal('verdict' in pair, false, 'a candidate carries no verdict');
    assert.equal(pair.titleA, byId.get(pair.idA).title);
  }
});

test('candidates are ranked by rule overlap, highest first', () => {
  const rows = [
    lesson({ id: 1, title: 'Flush', rule: 'Always flush candle geometry on zoom.', anchor: 'a.ts:1' }),
    lesson({ id: 2, title: 'No flush', rule: 'Never flush candle geometry on zoom.', anchor: 'a.ts:2' }),
    lesson({ id: 3, title: 'Close', rule: 'Close the websocket after each error and reconnect.', anchor: 'a.ts:3' }),
    lesson({ id: 4, title: 'No close', rule: 'Never close the websocket after each error.', anchor: 'a.ts:4' }),
  ];
  const pairs = findConflicts(rows);
  assert.deepEqual(pairs.map((pair) => [pair.idA, pair.idB]), [[1, 2], [3, 4]]);
  assert.ok(pairs[0].similarity > pairs[1].similarity);
});

test('unrelated pair -> below the default threshold', () => {
  const score = jaccardSimilarity(zoomA, `${OTHER_TITLE}\n${OTHER_RULE}`);
  assert.ok(score < DEFAULT_THRESHOLD, `expected < ${DEFAULT_THRESHOLD}, got ${score}`);
});

test('live near-duplicate #11908/#11918 is flagged at the DEFAULT threshold', () => {
  // The only live pair on 2026-09-25 scored 0.43; a 0.5 default hid it.
  const pairs = findDuplicatePairs(FALSE_PAIR_ROWS.slice(0, 2), DEFAULT_THRESHOLD);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].idA, pairs[0].idB], [11908, 11918]);
});

test('identical texts -> 1, empty -> 0', () => {
  assert.equal(jaccardSimilarity(zoomA, zoomA), 1);
  assert.equal(jaccardSimilarity('', zoomA), 0);
  assert.equal(jaccardSimilarity('the a an of', zoomA), 0); // stop-words only
});

test('normalization: lowercase, punctuation splits, stop-words drop', () => {
  assert.deepEqual(
    [...normalizeWordSet('Re-lay-OUT the candles; the a not!')],
    ['re', 'lay', 'out', 'candles'], // "out" stays a content word
  );
});

test('anchorFile: part before first colon, whole when bare, group when empty', () => {
  assert.equal(anchorFile('src/chart.ts:renderCandles'), 'src/chart.ts');
  assert.equal(anchorFile('src/chart.ts'), 'src/chart.ts');
  assert.equal(anchorFile('src/**/*.ts'), 'src/**/*.ts');
  assert.equal(anchorFile(''), '(no anchor)');
});

test('findDuplicatePairs: pairs only within one anchor file, sorted desc', () => {
  const rows = [
    lesson({ id: 1, title: ZOOM_A_TITLE, rule: ZOOM_A_RULE, anchor: 'src/chart.ts:zoom' }),
    lesson({ id: 2, title: ZOOM_B_TITLE, rule: ZOOM_B_RULE, anchor: 'src/chart.ts:pan' }),
    lesson({ id: 3, title: ZOOM_A_TITLE, rule: ZOOM_A_RULE, anchor: 'src/other.ts:zoom' }),
    lesson({ id: 4, title: OTHER_TITLE, rule: OTHER_RULE, anchor: 'src/chart.ts:commit' }),
  ];
  const pairs = findDuplicatePairs(rows, 0.5);
  // id1/id2 share an anchor file and the rule wording; id3 lives in another
  // file (excluded even though its text matches id1 exactly); id4 shares the
  // file but not the words (excluded by the threshold).
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].idA, 1);
  assert.equal(pairs[0].idB, 2);
  assert.equal(pairs[0].anchorFile, 'src/chart.ts');
  assert.ok(pairs[0].similarity >= 0.5);
});

test('findDuplicatePairs: rule text comes from the body, not just the title', () => {
  const rules = 'Rebuild candle and cluster geometry from the current view on each view change.';
  const rows = [
    lesson({ id: 10, title: 'Alpha one', rule: rules, anchor: 'a.ts:x' }),
    lesson({ id: 11, title: 'Beta two', rule: rules, anchor: 'a.ts:y' }),
  ];
  const pairs = findDuplicatePairs(rows, 0.5);
  assert.equal(pairs.length, 1); // titles share nothing; the identical rules carry the match
});

test('findDuplicatePairs: distinct titles dilute an otherwise matching pair below 0.5', () => {
  const rows = [
    lesson({ id: 10, title: 'Alpha one', rule: 'Rebuild candle and cluster geometry from the current view on each view change.', anchor: 'a.ts:x' }),
    lesson({ id: 11, title: 'Beta two', rule: 'On pan or zoom, rebuild price and cluster geometry from the current view; never matrix-rescale geometry snapped for an older view.', anchor: 'a.ts:y' }),
  ];
  assert.equal(findDuplicatePairs(rows, 0.5).length, 0); // rules-only ≈ 0.26 with disjoint titles
});
