#!/usr/bin/env node
// Fixture tests for eval-delivery-replay.mjs (task 1557 slice 1b).
//
// No memory service, no git: versions, rows and commits are fixtures, and the
// selection under test is the store's own `selectLessonsForPath` — the same
// function the route calls — so these fixtures pin the REPLAY's wiring
// (in-force filter, per-file union, root dedupe, gold comparison), not the
// matcher's internals, which test-store-lessons.mjs owns.
//
//   node --test scripts/memory/test-eval-delivery-replay.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  deliveredRootsForCommit,
  domainDrift,
  evaluateCommits,
  routingMapAt,
} from './eval-delivery-replay.mjs';
import { LESSONS_MAX_BYTES, selectLessonsForPath } from './store.mjs';
import { scrubbedGitEnv } from '../git-env.mjs';

const ROUTING = { order: [{ glob: '**', domain: 'domain-test', spec: 0 }] };
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function lessonVersion(id, { root = id, anchor, domain = 'domain-test', ts = T0, until = null }) {
  return {
    id,
    ts,
    supersedes: null,
    supersededBy: null,
    root,
    until,
    links: { status: 'active', domain, anchor },
  };
}

function rowsByIdFrom(versions) {
  return new Map(versions.map((v) => [v.id, {
    title: `lesson ${v.id}`,
    body: `- rule: rule ${v.id}\n- why: why\n- evidence: evidence`,
  }]));
}

test('an anchored gold lesson is delivered to its file', () => {
  const versions = [lessonVersion(10, { anchor: 'src/a.ts' })];
  const commit = {
    sha: 'c1',
    date: '2026-02-01T00:00:00.000Z',
    files: ['src/a.ts'],
    gold: [{ id: 10, root: 10, anchor: 'src/a.ts' }],
  };
  const delivered = deliveredRootsForCommit(commit, versions, rowsByIdFrom(versions), ROUTING);
  assert.deepEqual([...delivered], [10]);
  const result = evaluateCommits([commit], versions, rowsByIdFrom(versions), () => ROUTING);
  assert.equal(result.commits[0].recall, 1);
  assert.equal(result.aggregateRecall, 1);
});

test('one lesson reaching two files of a commit dedupes to one root', () => {
  // A bare-basename anchor reaches every file of that name, so BOTH files of
  // the commit receive lesson 11; the union must still count its root once.
  const versions = [lessonVersion(11, { anchor: 'dup.ts' })];
  const commit = {
    sha: 'c2',
    date: '2026-02-01T00:00:00.000Z',
    files: ['src/x/dup.ts', 'src/y/dup.ts'],
    gold: [{ id: 11, root: 11, anchor: 'dup.ts' }],
  };
  const delivered = deliveredRootsForCommit(commit, versions, rowsByIdFrom(versions), ROUTING);
  assert.deepEqual([...delivered], [11]);
  const result = evaluateCommits([commit], versions, rowsByIdFrom(versions), () => ROUTING);
  assert.equal(result.commits[0].gold, 1);
  assert.equal(result.commits[0].delivered, 1);
  assert.equal(result.commits[0].recall, 1);
});

test('empty-gold commits are excluded from the aggregate, and misses score zero', () => {
  const versions = [
    lessonVersion(10, { anchor: 'src/a.ts' }),
    // Gold for commit miss below, but routed to a domain the path does not
    // resolve to, so delivery correctly never hands it over.
    lessonVersion(20, { anchor: 'src/c.ts', domain: 'domain-other' }),
  ];
  const rowsById = rowsByIdFrom(versions);
  const hit = {
    sha: 'c-hit',
    date: '2026-02-01T00:00:00.000Z',
    files: ['src/a.ts'],
    gold: [{ id: 10, root: 10, anchor: 'src/a.ts' }],
  };
  const miss = {
    sha: 'c-miss',
    date: '2026-02-01T00:00:00.000Z',
    files: ['src/c.ts'],
    gold: [{ id: 20, root: 20, anchor: 'src/c.ts' }],
  };
  const empty = {
    sha: 'c-empty',
    date: '2026-02-01T00:00:00.000Z',
    files: ['src/unrelated.ts'],
    gold: [],
  };
  const result = evaluateCommits([hit, miss, empty], versions, rowsById, () => ROUTING);
  assert.equal(result.commits[0].recall, 1);
  assert.equal(result.commits[1].recall, 0);
  assert.equal(result.commits[2].recall, null);
  assert.equal(result.emptyGold, 1);
  assert.equal(result.scoredCommits, 2);
  assert.equal(result.aggregateRecall, 0.5);
});

test('a version not yet in force at commit time is not delivered', () => {
  const versions = [lessonVersion(30, { anchor: 'src/a.ts', ts: Date.parse('2026-03-01T00:00:00.000Z') })];
  const commit = {
    sha: 'c-early',
    date: '2026-02-01T00:00:00.000Z',
    files: ['src/a.ts'],
    gold: [],
  };
  const delivered = deliveredRootsForCommit(commit, versions, rowsByIdFrom(versions), ROUTING);
  assert.deepEqual([...delivered], []);
});

test('a delivered lesson outside gold counts as noise, with its share of delivered', () => {
  const versions = [
    lessonVersion(10, { anchor: 'src/a.ts' }),
    lessonVersion(50, { anchor: 'src/a.ts' }), // delivered, but never gold
  ];
  const commit = {
    sha: 'c-noise',
    date: '2026-02-01T00:00:00.000Z',
    files: ['src/a.ts'],
    gold: [{ id: 10, root: 10, anchor: 'src/a.ts' }],
  };
  const result = evaluateCommits([commit], versions, rowsByIdFrom(versions), () => ROUTING);
  const entry = result.commits[0];
  assert.equal(entry.deliveredTotal, 2);
  assert.equal(entry.delivered, 1);
  assert.equal(entry.recall, 1);
  assert.equal(entry.noise, 1);
  assert.equal(entry.noiseShare, 0.5);
  assert.equal(entry.stale, 0);
  assert.equal(result.aggregateNoiseShare, 0.5);
  assert.equal(result.totalNoise, 1);
});

test('a delivered lesson whose lineage was later retired counts as stale', () => {
  // v40 is in force at commit time (successor v41 written after it); v41 is
  // the lineage head TODAY and is retired, so root 40 is stale.
  const v40 = lessonVersion(40, { anchor: 'src/b.ts' });
  v40.supersededBy = 41;
  v40.until = Date.parse('2026-03-01T00:00:00.000Z');
  const v41 = lessonVersion(41, { anchor: 'src/b.ts', ts: Date.parse('2026-03-01T00:00:00.000Z') });
  v41.supersedes = 40;
  v41.root = 40;
  v41.links.status = 'retired';
  const versions = [v40, v41];
  const commit = {
    sha: 'c-stale',
    date: '2026-02-01T00:00:00.000Z',
    files: ['src/b.ts'],
    gold: [{ id: 40, root: 40, anchor: 'src/b.ts' }],
  };
  const delivered = deliveredRootsForCommit(commit, versions, rowsByIdFrom(versions), ROUTING);
  assert.deepEqual([...delivered], [40]);
  const result = evaluateCommits([commit], versions, rowsByIdFrom(versions), () => ROUTING);
  const entry = result.commits[0];
  assert.equal(entry.recall, 1);
  assert.equal(entry.noise, 0);
  assert.equal(entry.stale, 1);
  assert.equal(entry.staleShare, 1);
  assert.equal(result.aggregateStaleShare, 1);
  assert.equal(result.totalStale, 1);
});

test('commit bytes are the byte length of the answers the store renders for its files', () => {
  const versions = [
    lessonVersion(10, { anchor: 'src/a.ts' }),
    lessonVersion(11, { anchor: 'src/b.ts' }),
  ];
  const rowsById = rowsByIdFrom(versions);
  const commit = {
    sha: 'c-bytes',
    date: '2026-02-01T00:00:00.000Z',
    files: ['src/a.ts', 'src/b.ts'],
    gold: [{ id: 10, root: 10, anchor: 'src/a.ts' }],
  };
  // The rows the route would read, built here by hand so the expectation is
  // the rendered JSON's length, not the payload's self-reported `bytes`.
  const rows = versions.map((v) => ({
    id: v.id,
    uuid: `v${v.id}`,
    version: 1,
    title: rowsById.get(v.id).title,
    body: rowsById.get(v.id).body,
    links: JSON.stringify(v.links),
  }));
  const rendered = commit.files
    .map((file) => Buffer.byteLength(JSON.stringify(selectLessonsForPath(rows, file, ROUTING)), 'utf8'))
    .reduce((sum, n) => sum + n, 0);
  const result = evaluateCommits([commit], versions, rowsById, () => ROUTING);
  assert.ok(rendered > 0);
  assert.equal(result.commits[0].bytes, rendered);
  assert.equal(result.medianBytes, rendered);
  assert.equal(result.p90Bytes, rendered);
});

test('a gold miss says whether nothing matched it or the selection cut it', () => {
  const versions = [
    lessonVersion(60, { anchor: 'src/big.ts' }),
    lessonVersion(61, { anchor: 'src/elsewhere.ts' }),
  ];
  const rowsById = rowsByIdFrom(versions);
  // Lesson 60 matches src/big.ts, but its body alone exceeds the delivery
  // ceiling, so the selection drops it: a `cut`. Lesson 61 is anchored to a
  // file the commit never touched: `not-matched`.
  rowsById.set(60, { title: 'lesson 60', body: `- rule: ${'x'.repeat(LESSONS_MAX_BYTES + 1)}\n- why: why\n- evidence: e` });
  const commit = {
    sha: 'c-miss-reasons',
    date: '2026-02-01T00:00:00.000Z',
    files: ['src/big.ts'],
    gold: [
      { id: 60, root: 60, anchor: 'src/big.ts' },
      { id: 61, root: 61, anchor: 'src/elsewhere.ts' },
    ],
  };
  const result = evaluateCommits([commit], versions, rowsById, () => ROUTING);
  const entry = result.commits[0];
  assert.equal(entry.recall, 0);
  assert.deepEqual(entry.misses, [
    { root: 60, reason: 'cut' },
    { root: 61, reason: 'not-matched' },
  ]);
  assert.deepEqual(result.missReasons, { 'not-matched': 1, cut: 1 });
});

// Two maps for the same tree: at commit time `svod/**` belonged to
// domain-harness, today it belongs to domain-platform-shell (the move the
// reviewer reproduced on commit e1452315, gold root 112).
const MAP_THEN = { order: [
  { glob: '**', domain: 'domain-test', spec: 0 },
  { glob: 'svod/**', domain: 'domain-harness', spec: 5 },
] };
const MAP_TODAY = { order: [
  { glob: '**', domain: 'domain-test', spec: 0 },
  { glob: 'svod/**', domain: 'domain-platform-shell', spec: 5 },
] };

test('a commit is replayed under the routing map of its own time', () => {
  const versions = [lessonVersion(112, { anchor: 'svod/src/driver.rs', domain: 'domain-harness' })];
  const rowsById = rowsByIdFrom(versions);
  const commit = {
    sha: 'e1452315',
    date: '2026-02-01T00:00:00.000Z',
    files: ['svod/src/driver.rs'],
    gold: [{ id: 112, root: 112, anchor: 'svod/src/driver.rs' }],
  };
  const then = evaluateCommits([commit], versions, rowsById, () => MAP_THEN);
  assert.equal(then.commits[0].delivered, 1);
  assert.equal(then.aggregateRecall, 1);
  assert.equal(then.noMap, 0);
  // The same commit under today's map is exactly the defect: nothing matches.
  const today = evaluateCommits([commit], versions, rowsById, () => MAP_TODAY);
  assert.equal(today.aggregateRecall, 0);
  assert.deepEqual(today.commits[0].misses, [{ root: 112, reason: 'not-matched' }]);
});

test('a commit without a routing map is counted noMap and enters no figure', () => {
  const versions = [lessonVersion(10, { anchor: 'src/a.ts' })];
  const rowsById = rowsByIdFrom(versions);
  const scored = {
    sha: 'c-map', date: '2026-02-01T00:00:00.000Z', files: ['src/a.ts'],
    gold: [{ id: 10, root: 10, anchor: 'src/a.ts' }],
  };
  const unmapped = {
    sha: 'c-nomap', date: '2026-02-01T00:00:00.000Z', files: ['src/a.ts'],
    gold: [{ id: 10, root: 10, anchor: 'src/a.ts' }],
  };
  const result = evaluateCommits([scored, unmapped], versions, rowsById,
    (commit) => (commit.sha === 'c-nomap' ? null : ROUTING));
  assert.equal(result.noMap, 1);
  assert.deepEqual(result.noMapCommits, ['c-nomap']);
  assert.deepEqual(result.commits.map((entry) => entry.sha), ['c-map']);
  assert.equal(result.scoredCommits, 1);
  assert.equal(result.emptyGold, 0);
});

test('routingMapAt reads the committed map and answers null where the tree has none', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-map-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env: scrubbedGitEnv(), encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 't');
    git('config', 'core.hooksPath', '/dev/null');
    fs.writeFileSync(path.join(repo, 'README'), 'x');
    git('add', 'README');
    git('commit', '-q', '-m', 'no map');
    const before = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.join(repo, 'docs/agent'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs/agent/domain-routing.generated.json'), JSON.stringify(MAP_THEN));
    git('add', 'docs/agent/domain-routing.generated.json');
    git('commit', '-q', '-m', 'map');
    const after = git('rev-parse', 'HEAD');
    assert.equal(routingMapAt(repo, before), null);
    assert.deepEqual(routingMapAt(repo, after), MAP_THEN);
    assert.throws(() => routingMapAt(repo, '0'.repeat(40)), /is not in/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('domainDrift names an active gold lesson that today routes to another domain', () => {
  const versions = [
    lessonVersion(112, { anchor: 'svod/src/driver.rs:run', domain: 'domain-harness' }),
    lessonVersion(10, { anchor: 'src/a.ts' }), // routes to its own domain today
  ];
  const commit = {
    sha: 'e1452315', date: '2026-02-01T00:00:00.000Z', files: ['svod/src/driver.rs', 'src/a.ts'],
    gold: [
      { id: 112, root: 112, anchor: 'svod/src/driver.rs:run' },
      { id: 10, root: 10, anchor: 'src/a.ts' },
    ],
  };
  assert.deepEqual(domainDrift([commit], versions, MAP_TODAY), {
    count: 1,
    examples: [{
      id: 112, anchor: 'svod/src/driver.rs:run', lessonDomain: 'domain-harness', todayDomain: 'domain-platform-shell',
    }],
  });
  assert.equal(domainDrift([commit], versions, MAP_THEN).count, 0);
});
