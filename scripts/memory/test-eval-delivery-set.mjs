// Fixture tests for eval-delivery-set.mjs: a real store (append/supersede through
// its own routes) and a tiny git repo with dated commits.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scrubbedGitEnv } from '../git-env.mjs';

import {
  buildDeliverySet, goldMappings, loadLessonVersions, loadLiveHeads, manifestPath, readCommits, scoringCases,
  strideSample, summarize,
} from './eval-delivery-set.mjs';
import { LESSON_GATE, fixture, request, seedLegacyLesson } from './store-test-helpers.mjs';
import { loadRoutingMap, resolveDomain } from './store.mjs';

const BASE = 1_700_000_000; // seconds
const ms = (offset) => (BASE + offset) * 1000;

function makeStore() {
  const fx = fixture();
  const setTs = (id, offset) => fx.db.prepare('UPDATE mem_entries SET ts = ? WHERE id = ?').run(ms(offset), id);
  // Fixture anchors (a.txt, ...) route to no fixture domain: seed them as stored rows.
  const append = (title, links, offset) => {
    const response = seedLegacyLesson(fx, {
      kind: 'lesson',
      title,
      body: `## ${title}\n- rule: ${title} rule\n- why: fixture\n- evidence: fixture`,
      links: { domain: 'domain-harness', status: 'active', ...links },
    });
    setTs(response.json.id, offset);
    return response.json.id;
  };
  // A moved anchor passes the store's route and marker checks, then the stored
  // row gets the fixture shape back, as append does above.
  const supersede = (id, title, links, offset) => {
    const stored = { domain: 'domain-harness', ...links };
    const response = request(fx.memory, 'POST', '/api/memory/supersede', {
      id,
      title,
      body: `## ${title}\n- rule: ${title} rule\n- why: fixture\n- evidence: fixture`,
      links: { ...stored, domain: resolveDomain(links.anchor.split(':')[0], loadRoutingMap()), gate: LESSON_GATE },
    }, fx.token);
    assert.equal(response.status, 200, response.text);
    fx.db.prepare('UPDATE mem_entries SET links = ? WHERE id = ?').run(JSON.stringify(stored), response.json.id);
    setTs(response.json.id, offset);
    return response.json.id;
  };
  const read = async (resource) => {
    const response = request(fx.memory, 'GET', `/api/memory/${resource}`);
    assert.equal(response.status, 200, response.text);
    return response.json;
  };
  return { fx, append, supersede, read };
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-delivery-set-'));
  const git = (args, offset, authorOffset = offset) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...scrubbedGitEnv(),
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      ...(offset === undefined ? {} : {
        GIT_AUTHOR_DATE: `@${BASE + authorOffset} +0000`, GIT_COMMITTER_DATE: `@${BASE + offset} +0000`,
      }),
    },
  }).trim();
  git(['init', '-q', '-b', 'master']);
  git(['config', 'commit.gpgsign', 'false']);
  const commit = (files, offset, message, authorOffset = offset) => {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.appendFileSync(path.join(repo, file), `${message}\n`);
    }
    git(['add', '--', ...files]);
    git(['commit', '-q', '-m', message], offset, authorOffset);
    return git(['rev-parse', 'HEAD']);
  };
  return { repo, git, commit };
}

async function scenario() {
  const store = makeStore();
  const ids = {};
  ids.a = store.append('anchored at a', { anchor: 'a.txt:fn' }, 100);
  ids.r1 = store.append('retired later', { anchor: 'a.txt' }, 100);
  ids.r2 = store.supersede(ids.r1, 'retired later', { anchor: 'a.txt', status: 'retired' }, 300);
  ids.m1 = store.append('moved anchor', { anchor: 'b/old.txt' }, 100);
  ids.m2 = store.supersede(ids.m1, 'moved anchor', { anchor: 'c.txt', status: 'active' }, 300);
  ids.future = store.append('written after', { anchor: 'a.txt' }, 500);
  ids.inbox = store.append('inbox only', { anchor: 'a.txt', status: 'inbox' }, 100);
  ids.klass = store.append('class only', { anchor: 'z/other.txt', globs: ['a.txt'] }, 100);
  ids.base = store.append('bare basename', { anchor: 'd.txt' }, 100);
  ids.elsewhere = store.append('other file', { anchor: 'e.txt' }, 100);
  // successor written in the very second of commit c3
  ids.f1 = store.append('replaced at commit time', { anchor: 'f.txt' }, 100);
  ids.f2 = store.supersede(ids.f1, 'replaced at commit time', { anchor: 'f.txt', status: 'active' }, 800);
  // written after c4 was authored and before it was committed (rebase)
  ids.g = store.append('between author and committer date', { anchor: 'g.txt' }, 850);

  const { repo, git, commit } = makeRepo();
  const shas = {};
  shas.early = commit(['a.txt'], 50, 'before any lesson');
  shas.c0 = commit(['a.txt', 'b/old.txt'], 200, 'c0');
  shas.c1 = commit(['a.txt', 'c.txt', 'sub/d.txt'], 400, 'c1');
  shas.c2 = commit(['a.txt'], 600, 'c2');
  shas.unrelated = commit(['unrelated.txt'], 650, 'unrelated');
  git(['checkout', '-q', '-b', 'side', shas.c0]);
  shas.side = commit(['e.txt'], 680, 'side');
  git(['checkout', '-q', 'master']);
  git(['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], 700);
  shas.merge = git(['rev-parse', 'HEAD']);
  shas.c3 = commit(['f.txt'], 800, 'c3');
  shas.c4 = commit(['g.txt'], 900, 'c4', 50);

  const versions = await loadLessonVersions(store.read);
  const heads = await loadLiveHeads(store.read, versions.map((v) => v.root));
  const commits = readCommits(repo, 'master');
  const cleanup = () => {
    store.fx.close();
    fs.rmSync(repo, { recursive: true, force: true });
  };
  return { ids, shas, versions, heads, commits, cleanup };
}

// the versions in force at commit time, whether their lineage is live-active today or not
const goldIds = (entry) => [...entry.gold, ...entry.dropped].map((item) => item.inForce).sort((a, b) => a - b);
const liveIds = (entry) => entry.gold.map((item) => item.id).sort((a, b) => a - b);
const sorted = (...values) => values.sort((a, b) => a - b);

test('versions include every superseded row, each with its lineage root', async () => {
  const { ids, versions, cleanup } = await scenario();
  try {
    const byId = new Map(versions.map((v) => [v.id, v]));
    for (const id of Object.values(ids)) assert.ok(byId.has(id), `version ${id} loaded`);
    assert.equal(byId.get(ids.m2).root, ids.m1);
    assert.equal(byId.get(ids.m1).until, ms(300));
    assert.equal(byId.get(ids.m2).until, null);
  } finally {
    cleanup();
  }
});

test('a lesson written after the commit never enters its gold', async () => {
  const { ids, shas, versions, heads, commits, cleanup } = await scenario();
  try {
    const set = buildDeliverySet({ versions, commits, n: 80, heads }).commits;
    const at = (sha) => set.find((entry) => entry.sha === sha);
    assert.ok(!goldIds(at(shas.c0)).includes(ids.future));
    assert.ok(!goldIds(at(shas.c1)).includes(ids.future));
    assert.ok(goldIds(at(shas.c2)).includes(ids.future));
  } finally {
    cleanup();
  }
});

test('a lesson retired or re-anchored before the commit is excluded', async () => {
  const { ids, shas, versions, heads, commits, cleanup } = await scenario();
  try {
    const set = buildDeliverySet({ versions, commits, n: 80, heads }).commits;
    const at = (sha) => set.find((entry) => entry.sha === sha);
    // c0 predates the retirement and the re-anchor: the old versions are in force
    assert.deepEqual(goldIds(at(shas.c0)), sorted(ids.a, ids.r1, ids.m1));
    // c1 comes after both: retired is gone, the moved lesson follows its new anchor
    assert.ok(!goldIds(at(shas.c1)).includes(ids.r1));
    assert.ok(!goldIds(at(shas.c1)).includes(ids.r2));
    assert.ok(goldIds(at(shas.c1)).includes(ids.m2));
    assert.equal(at(shas.c1).gold.find((item) => item.id === ids.m2).root, ids.m1);
  } finally {
    cleanup();
  }
});

test('gold is exactly the in-force anchors among the commit files', async () => {
  const { ids, shas, versions, heads, commits, cleanup } = await scenario();
  try {
    const set = buildDeliverySet({ versions, commits, n: 80, heads }).commits;
    const at = (sha) => set.find((entry) => entry.sha === sha);
    // symbol anchor, re-anchored lesson, bare basename; not inbox, not class-only
    assert.deepEqual(goldIds(at(shas.c1)), sorted(ids.a, ids.m2, ids.base));
    assert.deepEqual(goldIds(at(shas.c2)), sorted(ids.a, ids.future));
    assert.deepEqual(goldIds(at(shas.side)), [ids.elsewhere]);
    assert.deepEqual(at(shas.c1).files, ['a.txt', 'c.txt', 'sub/d.txt']);
  } finally {
    cleanup();
  }
});

test('sample: merges, unanchored and pre-lesson commits are not eligible; N taken by an even stride', async () => {
  const { shas, versions, heads, commits, cleanup } = await scenario();
  try {
    const all = buildDeliverySet({ versions, commits, n: 80, heads });
    const eligible = [shas.c0, shas.c1, shas.c2, shas.side, shas.c3, shas.c4];
    assert.deepEqual(all.commits.map((entry) => entry.sha), eligible);
    assert.equal(all.sampling.eligibleCount, 6);
    // stride 2.5 over six: indices 0, 3, 5 - both ends kept, not the last three
    const strided = buildDeliverySet({ versions, commits, n: 3, heads });
    assert.deepEqual(strided.commits.map((entry) => entry.sha), [shas.c0, shas.side, shas.c4]);
    assert.deepEqual(strided.sampling, {
      method: 'stride',
      n: 3,
      minScoring: 0,
      eligibleCount: 6,
      firstLessonAt: new Date(ms(100)).toISOString(),
      firstCommitDate: new Date(ms(200)).toISOString(),
      lastCommitDate: new Date(ms(900)).toISOString(),
    });
    assert.deepEqual(summarize(all.commits), {
      // c0's r1 is dropped (its head is retired): 11 in force, 10 live
      commits: 6, withGold: 6, goldTotal: 10, droppedTotal: 1, goldMedian: 2, goldMax: 3, distribution: { 1: 3, 2: 2, 3: 1 },
    });
  } finally {
    cleanup();
  }
});

test('strideSample spreads over the whole list and is deterministic', () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  assert.deepEqual(strideSample(items, 5), [0, 25, 50, 74, 99]);
  assert.deepEqual(strideSample(items, 5), strideSample(items, 5));
  assert.equal(new Set(strideSample(items, 99)).size, 99);
  assert.deepEqual(strideSample([1, 2], 5), [1, 2]);
  assert.deepEqual(strideSample(items, 1), [99]);
});

test('boundary: a successor written at exactly the commit time is in force, its predecessor is not', async () => {
  const { ids, shas, versions, heads, commits, cleanup } = await scenario();
  try {
    const set = buildDeliverySet({ versions, commits, n: 80, heads }).commits;
    assert.deepEqual(goldIds(set.find((entry) => entry.sha === shas.c3)), [ids.f2]);
  } finally {
    cleanup();
  }
});

test('boundary: the clock is the committer date, not the author date', async () => {
  const { ids, shas, versions, heads, commits, cleanup } = await scenario();
  try {
    const c4 = commits.find((commit) => commit.sha === shas.c4);
    assert.equal(c4.ts, ms(900));
    const set = buildDeliverySet({ versions, commits, n: 80, heads }).commits;
    // authored at +50, before the lesson; committed (rebased) at +900, after it
    assert.deepEqual(goldIds(set.find((entry) => entry.sha === shas.c4)), [ids.g]);
  } finally {
    cleanup();
  }
});

test('live gold: a retired head is dropped, a superseded id is remapped to its head, each mapping recorded', async () => {
  const { ids, shas, versions, heads, commits, cleanup } = await scenario();
  try {
    const set = buildDeliverySet({ versions, commits, n: 80, heads }).commits;
    const c0 = set.find((entry) => entry.sha === shas.c0);
    // in force at c0: a, r1, m1. r1's lineage ends retired (r2); m1's ends active (m2)
    assert.deepEqual(liveIds(c0), sorted(ids.a, ids.m2));
    assert.deepEqual(c0.gold.find((item) => item.id === ids.m2), {
      id: ids.m2, root: ids.m1, anchor: 'b/old.txt', inForce: ids.m1,
    });
    assert.deepEqual(c0.dropped, [
      { inForce: ids.r1, root: ids.r1, anchor: 'a.txt', head: ids.r2, status: 'retired' },
    ]);
    // the head is what `get --follow latest` answers, from the root or any later version
    assert.deepEqual(heads.get(ids.r1), { id: ids.r2, status: 'retired' });
    assert.deepEqual(heads.get(ids.m1), { id: ids.m2, status: 'active' });
    // c3 saw f2 itself: kept, not a remap
    assert.deepEqual(set.find((entry) => entry.sha === shas.c3).gold, [
      { id: ids.f2, root: ids.f1, anchor: 'f.txt', inForce: ids.f2 },
    ]);
    const { remapped, dropped } = goldMappings(set);
    assert.deepEqual(remapped, [{ from: ids.m1, to: ids.m2, root: ids.m1, cases: 1 }]);
    assert.deepEqual(dropped, [{ id: ids.r1, root: ids.r1, head: ids.r2, status: 'retired', cases: 1 }]);
  } finally {
    cleanup();
  }
});

test('live gold: a gold lineage without a loaded head is an error, not a silent drop', async () => {
  const { ids, versions, heads, commits, cleanup } = await scenario();
  try {
    const partial = new Map(heads);
    partial.delete(ids.a);
    assert.throws(() => buildDeliverySet({ versions, commits, n: 80, heads: partial }), /no live head loaded for lineage root/);
  } finally {
    cleanup();
  }
});

test('--min-scoring grows the stride until enough cases have live gold, and stops at the eligible count', async () => {
  const { ids, shas, versions, heads, commits, cleanup } = await scenario();
  try {
    // retire g's lineage: c4 keeps an empty live gold and no longer scores
    const noG = new Map(heads);
    noG.set(ids.g, { id: ids.g, status: 'retired' });
    const one = buildDeliverySet({ versions, commits, n: 2, heads: noG });
    assert.deepEqual(one.commits.map((entry) => entry.sha), [shas.c0, shas.c4]);
    assert.equal(one.commits.filter((entry) => entry.gold.length > 0).length, 1);
    // n=3 takes c0, side, c4: two scoring
    const grown = buildDeliverySet({ versions, commits, n: 2, heads: noG, minScoring: 2 });
    assert.equal(grown.sampling.n, 3);
    assert.equal(grown.sampling.minScoring, 2);
    assert.deepEqual(grown.commits.map((entry) => entry.sha), [shas.c0, shas.side, shas.c4]);
    // five of six eligible score; asking for six takes them all and stops
    const all = buildDeliverySet({ versions, commits, n: 2, heads: noG, minScoring: 6 });
    assert.equal(all.sampling.n, 6);
    assert.equal(all.commits.filter((entry) => entry.gold.length > 0).length, 5);
  } finally {
    cleanup();
  }
});

test('scoringCases counts an older set by its lineages live today; the manifest sits beside the set', () => {
  const heads = new Map([[1, { id: 3, status: 'retired' }], [2, { id: 4, status: 'active' }]]);
  const old = [
    { gold: [{ id: 1, root: 1 }] },
    { gold: [{ id: 1, root: 1 }, { id: 2, root: 2 }] },
    { gold: [] },
  ];
  assert.equal(scoringCases(old, heads), 1);
  assert.equal(manifestPath('/x/eval-delivery-set.frozen.json'), '/x/eval-delivery-set.manifest.json');
  assert.equal(manifestPath('/x/set.json'), '/x/set.json.manifest.json');
});
