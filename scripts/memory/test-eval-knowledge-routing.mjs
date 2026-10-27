import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scrubbedGitEnv } from '../git-env.mjs';
import { createHash } from 'node:crypto';
import {
  extractAnchors, extractBareNames, resolveCitations, anchorOverlaps, sectionGold, pageSections, sectionText,
  sampleCases, reportOf, workedFilesOf, turnCommit, pageAtCommit, lsFilesAt, loadPage, isTopLevelDir, collectCase, paragraphReport,
} from './eval-knowledge-routing.mjs';

// --- anchor extraction from section text ------------------------------------
test('extractAnchors pulls repo paths and path:symbols, not prose or URLs', () => {
  const text = [
    '## Split duplicate evals by cluster, not by id',
    '- anchor: scripts/memory/eval-duplicate-check.mjs',
    '- rule: keep clusters together; see and/or reasoning, e.g. this line.',
    'Measured 2026-09-26 (memory #9838): ops/bootstrap/knowledge-page-lib.mjs:renderKnowledgePage',
    'was called from ops/orchestrator/src/context.ts:230 and from scripts/memory/ (a directory).',
    'A URL https://example.com/docs/agent/memory.md is not a repo path.',
    'Bare filenames like eval-knowledge-routing.mjs are not identifiable as repo paths.',
    'Cited again: scripts/memory/eval-duplicate-check.mjs and scripts/memory/eval-duplicate-check.mjs.',
  ].join('\n');
  assert.deepEqual(extractAnchors(text), [
    'scripts/memory/eval-duplicate-check.mjs',
    'ops/bootstrap/knowledge-page-lib.mjs',
    'ops/orchestrator/src/context.ts',
    'scripts/memory/',
  ]);
});

test('extractAnchors keeps dashed paths, drops connectives and host tails', () => {
  assert.deepEqual(extractAnchors('app-desktop/qml works; and/or does not; seat-roles/name has a dash.'),
    ['app-desktop/qml', 'seat-roles/name']);
  assert.deepEqual(extractAnchors('see http://x.test/a/b.md and a@b.test/c/d.md now'),
    ['a@b.test/c/d.md']);
  assert.deepEqual(extractAnchors('trailing stop: scripts/memory/eval.mjs.'), ['scripts/memory/eval.mjs']);
  // '-' joins the lookbehind: /tmp/orch-bh/ must not yield a 'bh/' anchor.
  assert.deepEqual(extractAnchors('logs under /tmp/orch-bh/ and /tmp/orch-bh/ end'), []);
});

// --- bare basenames and resolution -----------------------------------------
test('extractBareNames pulls filename citations, not path tails or prose', () => {
  assert.deepEqual(extractBareNames('five findings cite leads.ts:42 and Leads.ts; e.g. reasoning.'),
    ['leads.ts', 'Leads.ts']);
  assert.deepEqual(extractBareNames('ops/orchestrator/src/leads.ts:42 is a path tail, 1.5 is a number'), []);
});

test('resolveCitations places a bare basename only when unambiguous', () => {
  const files = ['ops/orchestrator/src/leads.ts'];
  const lsFiles = [...files, 'src/features/other/leads.ts', 'docs/readme.md'];
  assert.deepEqual(resolveCitations('evidence leads.ts:42 here', { files, lsFiles }).paths, ['ops/orchestrator/src/leads.ts']);
  assert.deepEqual(resolveCitations('evidence leads.ts here', { files: [], lsFiles }).paths, []);
  assert.deepEqual(resolveCitations('evidence leads.ts here', { files: [], lsFiles }).ambiguous, ['leads.ts']);
  assert.deepEqual(resolveCitations('evidence readme.md here', { files: [], lsFiles }),
    { paths: ['docs/readme.md'], unresolved: [], ambiguous: [] });
  assert.deepEqual(resolveCitations('evidence nope.ts here', { files: [], lsFiles }),
    { paths: [], unresolved: ['nope.ts'], ambiguous: [] });
  // The exists filter is real: every pushed path must pass it, slash anchors too.
  const exists = (file) => file === 'scripts/memory/eval-knowledge-routing.mjs';
  assert.deepEqual(resolveCitations('cite scripts/memory/eval-knowledge-routing.mjs and nowhere/invented.mjs and leads.ts',
    { files: ['ops/orchestrator/src/leads.ts'], lsFiles, exists }).paths, ['scripts/memory/eval-knowledge-routing.mjs']);
});

// --- gold overlap: coder ----------------------------------------------------
test('coder gold: a section is gold when a cited anchor overlaps changedFiles', () => {
  const changed = ['scripts/memory/eval-knowledge-routing.mjs', 'ops/bootstrap/knowledge-page-lib.mjs'];
  const gold = sectionGold(
    '## Anchor extraction\n\nCited: scripts/memory/eval-knowledge-routing.mjs:extractAnchors and scripts/memory/.',
    changed);
  assert.equal(gold.gold, true);
  assert.deepEqual(gold.goldAnchors, ['scripts/memory/eval-knowledge-routing.mjs', 'scripts/memory/']);
  const miss = sectionGold('## Chart pixels\n\nsrc/chart-engine/renderers/DomCrosshairLayer.ts draws sweeps.', changed);
  assert.equal(miss.gold, false);
  assert.deepEqual(miss.goldAnchors, []);
});

test('coder gold: a directory anchor overlaps the files it holds, never a sibling', () => {
  assert.equal(anchorOverlaps('scripts/memory/', 'scripts/memory/eval.mjs'), true);
  assert.equal(anchorOverlaps('scripts/memory', 'scripts/memory/eval.mjs'), false);
  assert.equal(anchorOverlaps('ops/bootstrap/knowledge-page-lib.mjs', 'ops/bootstrap/knowledge-page-lib.mjs'), true);
  assert.equal(sectionGold('section citing scripts/memory/', ['scripts/memory/eval.mjs']).gold, true);
  assert.equal(sectionGold('section citing scripts/memory/', ['scripts/memory-x/eval.mjs']).gold, false);
});

test('gold overlap drops top-level directory anchors, keeps depth >= 2', () => {
  assert.equal(isTopLevelDir('src/'), true);
  assert.equal(isTopLevelDir('app-desktop/'), true);
  assert.equal(isTopLevelDir('scripts/memory/'), false);
  assert.equal(isTopLevelDir('scripts/memory/eval.mjs'), false);
  assert.equal(sectionGold('section citing src/', ['src/foo.ts']).gold, false);
  assert.equal(sectionGold('section citing src/features/', ['src/features/foo.ts']).gold, true);
  assert.equal(sectionGold('section citing app/ and src/features/x.ts', ['src/features/x.ts']).gold, true);
});

// --- gold overlap: reviewer -------------------------------------------------
test('reviewer gold: worked files come from finding evidence and drive overlap', () => {
  const report = {
    findings: [
      { claim: 'x', evidence: 'ops/orchestrator/src/context.ts:221 reads docs/agent/domain-routing.generated.json' },
      { claim: 'y', evidence: ['repro: `npm run check:commit` failed on scripts/memory/eval-knowledge-routing.mjs'] },
      { claim: 'z', evidence: 'no path here at all' },
    ],
  };
  const worked = workedFilesOf('reviewer', report);
  assert.equal(worked.report, true);
  assert.deepEqual(worked.files, [
    'ops/orchestrator/src/context.ts',
    'docs/agent/domain-routing.generated.json',
    'scripts/memory/eval-knowledge-routing.mjs',
  ]);
  assert.deepEqual(worked.unresolved, []);
  assert.equal(sectionGold('## Routing map\ndocs/agent/domain-routing.generated.json is the source.', worked.files).gold, true);
  assert.equal(sectionGold('## Unrelated\nsrc/types/settingsSections.ts is a registry.', worked.files).gold, false);
});

test('workedFilesOf: coder reads changedFiles, a missing report is empty and marked', () => {
  const report = reportOf('```json\n{\n  "role": "coder",\n  "changedFiles": ["a/b.mjs", "c/d.ts"]\n}\n```');
  assert.deepEqual(workedFilesOf('coder', report),
    { files: ['a/b.mjs', 'c/d.ts'], source: 'report.changedFiles', report: true, unresolved: [], ambiguous: [] });
  assert.deepEqual(workedFilesOf('coder', reportOf('no report at all')),
    { files: [], source: 'report.changedFiles', report: false, unresolved: [], ambiguous: [] });
  assert.equal(workedFilesOf('reviewer', null).report, false);
});

test('reviewer gold: a basename citation in evidence reaches a section naming the full path', () => {
  const ctx = { files: [], lsFiles: ['ops/orchestrator/src/leads.ts', 'src/features/other/leads.ts'] };
  const report = { findings: [{ claim: 'x', evidence: 'leads.ts:42 renders the leads table' }] };
  // Ambiguous in the tree: prefer the case file when the case names one.
  const resolved = workedFilesOf('reviewer', report, { ...ctx, files: ['ops/orchestrator/src/leads.ts'] });
  assert.deepEqual(resolved.files, ['ops/orchestrator/src/leads.ts']);
  assert.equal(sectionGold('## Leads grid\nops/orchestrator/src/leads.ts builds the rows.', resolved.files).gold, true);
  const unresolved = workedFilesOf('reviewer', report, ctx);
  assert.deepEqual(unresolved.files, []);
  assert.deepEqual(unresolved.ambiguous, ['leads.ts']);
});

// --- section shapes ---------------------------------------------------------
test('pageSections mirrors the router split and heading/body split', () => {
  const body = 'preamble line\n## First section\n\nbody one\n## Second section\nbody two';
  const sections = pageSections(body);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map((section) => section.heading), ['## First section', '## Second section']);
  assert.equal(sections[0].body, 'body one');
  assert.equal(sectionText(sections[1]), '## Second section\nbody two');
});

// --- historical pages ------------------------------------------------------
test('historical pages: the page is taken at the turn commit, never today\'s', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ekr-fixture-'));
  const run = (args, env = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: scrubbedGitEnv({ ...process.env, ...env }) });
  run(['init', '-q', '-b', 'master']);
  run(['config', 'user.email', 'fixture@test']);
  run(['config', 'user.name', 'fixture']);
  const page = '.agents/domains/domain-fixture/knowledge.md';
  fs.mkdirSync(path.dirname(path.join(repo, page)), { recursive: true });
  const v1 = 'preamble v1\n## Old section\n\nbody one\n## Second\nshared';
  const v2 = 'preamble v2\n## New A\n\na\n## New B\n\nb\n## New C\n\nc';
  fs.writeFileSync(path.join(repo, page), v1);
  run(['add', '.']);
  run(['commit', '-q', '-m', 'v1'], { GIT_AUTHOR_DATE: '2026-09-20T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-20T00:00:00Z' });
  fs.writeFileSync(path.join(repo, page), v2);
  run(['add', '.']);
  run(['commit', '-q', '-m', 'v2'], { GIT_AUTHOR_DATE: '2026-09-22T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-22T00:00:00Z' });
  const sha1 = turnCommit(repo, '2026-09-21T00:00:00Z');
  assert.equal(pageAtCommit(repo, sha1, page), v1);
  assert.equal(pageSections(pageAtCommit(repo, sha1, page)).length, 2);
  const sha2 = turnCommit(repo, '2026-09-23T00:00:00Z');
  assert.equal(pageAtCommit(repo, sha2, page), v2);
  assert.equal(pageSections(pageAtCommit(repo, sha2, page)).length, 3);
  assert.equal(pageAtCommit(repo, sha2, '.agents/domains/domain-elsewhere/knowledge.md'), null);
  // The other missing-page shape: present on disk, absent at the commit.
  fs.mkdirSync(path.dirname(path.join(repo, '.agents/domains/domain-later/knowledge.md')), { recursive: true });
  fs.writeFileSync(path.join(repo, '.agents/domains/domain-later/knowledge.md'), 'today only');
  assert.equal(pageAtCommit(repo, sha2, '.agents/domains/domain-later/knowledge.md'), null);
  assert.deepEqual(lsFilesAt(repo, sha2), [page]);
  // The loader: bodies come from git and must verify against the frozen hash.
  const entry = { commit: sha2, path: page, pageHash: createHash('sha256').update(v2).digest('hex') };
  assert.deepEqual(loadPage(entry, repo), pageSections(v2));
  assert.throws(() => loadPage({ ...entry, pageHash: 'not-the-hash' }, repo), /hash mismatch/);
  assert.throws(() => loadPage({ ...entry, path: '.agents/domains/domain-elsewhere/knowledge.md' }, repo), /absent/);
});

// Test-audit: the revision loader must hash/render the assembled page, not its
// TOC or today's parts. Existing historical tests exercise only one-file pages.
// Real commits distinguish revisions; the expected bytes are a fixed contract.
test('historical split pages assemble only the parts of that revision', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ekr-split-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { env: scrubbedGitEnv(), cwd: repo, encoding: 'utf8' });
  run('init', '-q');
  run('config', 'user.email', 'fixture@test');
  run('config', 'user.name', 'fixture');
  const page = '.agents/domains/domain-fixture/knowledge.md';
  const part = '.agents/domains/domain-fixture/knowledge/part.md';
  fs.mkdirSync(path.dirname(path.join(repo, part)), { recursive: true });
  const original = '# Page\n\n## Part\noriginal `scripts/reader.mjs:1` sentence\n';
  fs.writeFileSync(path.join(repo, page), original);
  run('add', '.');
  run('commit', '-qm', 'one file');
  const oneFile = run('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(repo, page), '# Page\n\n<!-- knowledge:toc -->\n- [Part](knowledge/part.md): table text is not body\n');
  fs.writeFileSync(path.join(repo, part), '## Part\noriginal `scripts/reader.mjs:1` sentence\n');
  run('add', '.');
  run('commit', '-qm', 'split');
  const split = run('rev-parse', 'HEAD').trim();
  const paragraphs = paragraphReport({ repo });
  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].bytes, Buffer.byteLength(original), 'paragraph reporting sizes assembled content, not the table');
  const rawGit = {
    lsFiles: (commit) => lsFilesAt(repo, commit),
    pageAt: (commit, file) => {
      try { return run('show', `${commit}:${file}`); } catch { return null; }
    },
  };
  for (const commit of [oneFile, split]) {
    const entry = collectCase({ id: 'c1', role: 'coder', commit, taskFiles: ['scripts/reader.mjs'],
      report: { changedFiles: ['scripts/reader.mjs'] } }, {
      routing: { order: [{ glob: 'scripts/**', domain: 'domain-fixture' }] }, git: rawGit, exists: () => true,
    });
    assert.equal(entry.gold.sections.length, 1, 'freeze collection finds citations in the assembled body');
    assert.equal(entry.gold.sections[0].at, 0);
    assert.deepEqual(entry.pageMissing, []);
  }
  fs.writeFileSync(path.join(repo, part), '## Part\ntoday only\n');
  const entry = { path: page, pageHash: createHash('sha256').update(original).digest('hex') };
  for (const commit of [oneFile, split]) {
    assert.equal(pageAtCommit(repo, commit, page), original);
    assert.deepEqual(loadPage({ ...entry, commit }, repo), pageSections(original));
  }
  fs.writeFileSync(path.join(repo, 'map.json'), '{"map":"raw"}\n');
  run('add', '.');
  run('commit', '-qm', 'changed part');
  const changed = run('rev-parse', 'HEAD').trim();
  assert.throws(() => loadPage({ ...entry, commit: changed }, repo), /hash mismatch/);
  assert.equal(pageAtCommit(repo, changed, 'map.json'), '{"map":"raw"}\n', 'non-page data is not assembled');
  fs.unlinkSync(path.join(repo, part));
  run('add', '.');
  run('commit', '-qm', 'missing part');
  assert.throws(() => pageAtCommit(repo, 'HEAD', page), /missing part/);
});

// --- stride sampling determinism -------------------------------------------
test('sampleCases is deterministic and chronological regardless of input order', () => {
  const rows = Array.from({ length: 23 }, (_, at) => ({
    id: `seat-${String(at).padStart(2, '0')}.1`,
    createdAt: `2026-09-${String((at % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
  }));
  const shuffled = [...rows].sort((a, b) => (a.id < b.id ? 1 : -1));
  const first = sampleCases(rows, 7).map((row) => row.id);
  const second = sampleCases(shuffled, 7).map((row) => row.id);
  assert.deepEqual(first, second);
  assert.equal(first.length, 7);
  // An even stride over the chronological list, both ends included.
  const sorted = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1
    : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  assert.equal(first[0], sorted[0].id);
  assert.equal(first[first.length - 1], sorted[sorted.length - 1].id);
  // Fewer rows than the target: every row, chronological.
  assert.deepEqual(sampleCases(rows, 100).map((row) => row.id), sorted.map((row) => row.id));
});

// --- slice 2: scoring -------------------------------------------------------
import { score, scoreTable, classifyDelivery } from './eval-knowledge-routing.mjs';

const SCORE_ROUTING = { order: [{ glob: 'scripts/memory/**', domain: 'domain-memory' }] };
const SCORE_PAGE = 'preamble\n## Alpha section\ncites scripts/memory/eval.mjs here\n## Beta section\nunrelated prose';
const scoreFixture = (extraCases = []) => ({
  source: {},
  pageStore: { 'domain-memory@abc': { domain: 'domain-memory', path: '.agents/domains/domain-memory/knowledge.md', commit: 'abc', pageHash: '', body: SCORE_PAGE } },
  cases: [
    { id: 'c1', role: 'coder', brief: 'Fix scripts/memory/eval.mjs scoring', files: ['scripts/memory/eval.mjs'],
      routedDomains: ['domain-memory'], pages: [{ domain: 'domain-memory', pageRef: 'domain-memory@abc' }],
      gold: { sections: [{ pageRef: 'domain-memory@abc', at: 0 }], empty: false } },
    { id: 'c2', role: 'coder', brief: 'Fix scripts/memory/eval.mjs again', files: ['scripts/memory/eval.mjs'],
      routedDomains: ['domain-memory'], pages: [{ domain: 'domain-memory', pageRef: 'domain-memory@abc' }],
      gold: { sections: [], empty: true } },
    ...extraCases,
  ],
});
const loadInline = (entry) => entry.body;

test('classifyDelivery: full, clipped and index-only from the real render', () => {
  const big = 'x'.repeat(500);
  const body = `head\n## Small\nfits easily\n## Huge\n${big}\n## Later\nalso prose`;
  // V6 admits ranked parts sequentially and pays for each passage label.
  assert.deepEqual(classifyDelivery({ domain: 'domain-memory', body: 'head\n## Only\nshort', files: [], budget: 4096 }).classes, ['full']);
  const cut = classifyDelivery({ domain: 'domain-memory', body, files: [], budget: 450, selected: [0, 1, 2] });
  assert.deepEqual(cut.classes, ['full', 'clipped', 'index']);
  const clipped = classifyDelivery({ domain: 'domain-memory', body, files: [], budget: 200, selected: [1] });
  assert.deepEqual(clipped.classes, ['index', 'clipped', 'index']);
  // selected null reproduces the map render: under budget the whole page rides;
  // over budget the rank filter drops a score-0 section to the index.
  const small = classifyDelivery({ domain: 'domain-memory', body: 'head\n## Cited\nscripts/memory/eval.mjs\n## Quiet\nno path', files: ['scripts/memory/eval.mjs'], budget: 4096 });
  assert.deepEqual(small.classes, ['full', 'full']);
  const map = classifyDelivery({ domain: 'domain-memory', body: 'head\n## Cited\nscripts/memory/eval.mjs\n## Quiet\n' + 'no path '.repeat(100), files: ['scripts/memory/eval.mjs'], budget: 220 });
  assert.deepEqual(map.classes, ['full', 'index']);
});

test('score: the map arm scores the delivered render, with full-only levels; no jev arm', () => {
  const results = score({ frozen: scoreFixture(), routing: SCORE_ROUTING, loadBody: loadInline });
  const [c1, c2] = results.cases;
  assert.deepEqual(Object.keys(c1.arms), ['map']);
  assert.deepEqual(Object.keys(results.arms), ['map']);
  assert.equal(results.paired, undefined);
  // The small page fits the budget, so both sections ride full.
  assert.equal(c1.arms.map.source, 'map');
  assert.deepEqual(c1.arms.map.classes, { 'domain-memory@abc:0': 'full', 'domain-memory@abc:1': 'full' });
  assert.equal(c1.arms.map.recall, 1);
  assert.equal(c1.arms.map.recallFull, 1);
  assert.equal(c1.arms.map.precision, 0.5);
  assert.equal(c1.arms.map.delivered.full, 2);
  assert.equal(c1.arms.map.delivered.index, 0);
  assert.equal(c1.arms.map.preBudget, 2);
  // The empty-gold case is counted and carries bytes, never recall.
  assert.equal(c2.arms.map.recall, undefined);
  assert.ok(c2.arms.map.bytes > 0);
  assert.equal(results.arms.map.coder.scored, 1);
  assert.equal(results.arms.map.coder.recall, 1);
  assert.equal(results.arms.map.all.cases, 2);
  assert.match(scoreTable(results), /^map {3}all {6}\s+2\s+1 /m);
  assert.doesNotMatch(scoreTable(results), /jev|paired/);
});

test('score: the budget cuts the map arm where louder sections outrank gold', () => {
  // Gold names the file once; two louder sections outrank it and eat the budget.
  const pad = 'y'.repeat(220);
  const page = [
    'head',
    '## Loud one\nscripts/memory/eval.mjs scripts/memory/eval.mjs ' + pad,
    '## Loud two\nscripts/memory/eval.mjs scripts/memory/eval.mjs ' + pad,
    '## Quiet gold\nmentions scripts/memory/eval.mjs once',
  ].join('\n');
  const fixture = {
    source: {},
    pageStore: { 'domain-memory@cut': { domain: 'domain-memory', path: 'p', commit: 'abc', pageHash: '', body: page } },
    cases: [{ id: 'c1', role: 'coder', brief: 'Fix scripts/memory/eval.mjs', files: ['scripts/memory/eval.mjs'],
      routedDomains: ['domain-memory'], pages: [{ domain: 'domain-memory', pageRef: 'domain-memory@cut' }],
      gold: { sections: [{ pageRef: 'domain-memory@cut', at: 2 }], empty: false } }],
  };
  const results = score({ frozen: fixture, routing: SCORE_ROUTING, loadBody: loadInline, budget: 300 });
  const [c1] = results.cases;
  // The two loud sections fill the 300-byte budget, gold is index-only.
  assert.equal(c1.arms.map.classes['domain-memory@cut:2'], 'index');
  assert.equal(c1.arms.map.recall, 0);
  assert.equal(c1.arms.map.recallFull, 0);
});

test('score: a case whose domain has no page is routed as none and delivers nothing', () => {
  const results = score({ frozen: scoreFixture([{ id: 'c3', role: 'reviewer', brief: 'b', files: ['scripts/memory/eval.mjs'],
    routedDomains: ['domain-memory'], pages: [], gold: { sections: [], empty: true } }]), routing: SCORE_ROUTING, loadBody: loadInline });
  const c3 = results.cases.find((entry) => entry.id === 'c3');
  assert.equal(c3.arms.map.source, 'none');
  assert.deepEqual(c3.arms.map.delivered, { full: 0, clipped: 0, index: 0 });
  assert.equal(results.arms.map.reviewer.cases, 1);
  assert.equal(results.arms.map.reviewer.scored, 0);
});

// --- task 2398 slice E: line-level delivery, bytes per domain, paragraph sizes ---
import { domainTable, paragraphStats } from './eval-knowledge-routing.mjs';

test('score: a gold line in the clipped part counts, one behind the cut does not', () => {
  // The gold section alone overflows 450 bytes including the v6 labels: it keeps its
  // opening lines and cuts at the long line. Two gold lines stand before the cut
  // (one cites the path, one the bare filename), one behind it.
  const clippedPage = [
    'head',
    '## Gold clipped',
    'first cites scripts/memory/eval.mjs early',
    'second cites eval.mjs:42 by name',
    'y'.repeat(300),
    'last cites scripts/memory/eval.mjs behind the cut',
    '## Other',
    'cites scripts/memory/eval.mjs too, in a section that is not gold',
  ].join('\n');
  const fixture = {
    source: {},
    pageStore: {
      'domain-memory@clip': { domain: 'domain-memory', path: 'p', commit: 'abc', pageHash: '', body: clippedPage },
      'domain-other@whole': { domain: 'domain-other', path: 'q', commit: 'abc', pageHash: '', body: 'head\n## Solo\ncites tools/x.mjs here' },
    },
    cases: [
      { id: 'c1', role: 'coder', files: ['scripts/memory/eval.mjs'],
        pages: [{ domain: 'domain-memory', pageRef: 'domain-memory@clip' }],
        gold: { sections: [{ pageRef: 'domain-memory@clip', at: 0, goldAnchors: ['scripts/memory/eval.mjs'] }] } },
      { id: 'c2', role: 'coder', files: ['tools/x.mjs'],
        pages: [{ domain: 'domain-other', pageRef: 'domain-other@whole' }],
        gold: { sections: [{ pageRef: 'domain-other@whole', at: 0, goldAnchors: ['tools/x.mjs'] }] } },
    ],
  };
  const routing = { order: [{ glob: 'scripts/memory/**', domain: 'domain-memory' }, { glob: 'tools/**', domain: 'domain-other' }] };
  const results = score({ frozen: fixture, routing, loadBody: loadInline, budget: 450 });
  const [c1, c2] = results.cases;
  assert.equal(c1.arms.map.classes['domain-memory@clip:0'], 'clipped');
  assert.deepEqual(c1.arms.map.lines, { gold: 3, delivered: 2 });
  // The small page rides whole, so its one gold line does too.
  assert.deepEqual(c2.arms.map.lines, { gold: 1, delivered: 1 });
  // Per domain and in total: pooled share, and the mean of the cases' shares.
  const { all, 'domain-memory': memory, 'domain-other': other } = results.domains.map;
  assert.deepEqual(memory.lines, { cases: 1, gold: 3, delivered: 2, share: 2 / 3, shareByCase: 2 / 3 });
  assert.deepEqual(other.lines, { cases: 1, gold: 1, delivered: 1, share: 1, shareByCase: 1 });
  assert.deepEqual(all.lines, { cases: 2, gold: 4, delivered: 3, share: 0.75, shareByCase: (2 / 3 + 1) / 2 });
  // Rendered bytes: each domain holds its own render, the total holds both.
  const [big, small] = [c1.arms.map.bytes, c2.arms.map.bytes];
  assert.ok(big > small);
  assert.deepEqual(memory.bytes, { mean: big, max: big });
  assert.deepEqual(other.bytes, { mean: small, max: small });
  assert.deepEqual(all.bytes, { mean: (big + small) / 2, max: big });
  assert.equal(all.renders, 2);
  assert.match(domainTable(results), /^map {3}domain-memory\s+1\s+1\s+\d+\s+\d+\s+3\s+2\s+66\.7\s+66\.7$/m);
});

test('paragraphStats: blocks between blank lines, sized in bytes, nearest-rank levels', () => {
  // Four paragraphs of 7, 2, 3000 and 6 bytes ('ééé' is three characters);
  // a line of spaces is a blank line.
  const body = `aaaa\nbb\n\n\ncc\n   \n${'d'.repeat(3000)}\n\nééé\n`;
  assert.deepEqual(paragraphStats(body), { count: 4, median: 6, p90: 3000, max: 3000, large: 1 });
  assert.deepEqual(paragraphStats(''), { count: 0, median: null, p90: null, max: null, large: 0 });
});

test('score --routing-commit: the map of a matching commit passes, another commit\'s map is refused', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ekr-routing-'));
  const run = (args) => execFileSync('git', args, { env: scrubbedGitEnv(), cwd: repo, encoding: 'utf8' }).trim();
  run(['init', '-q', '-b', 'master']);
  run(['config', 'user.email', 'fixture@test']);
  run(['config', 'user.name', 'fixture']);
  const file = 'docs/agent/domain-routing.generated.json';
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  const commitMap = (map, message) => {
    fs.writeFileSync(path.join(repo, file), map);
    run(['add', '.']);
    run(['commit', '-q', '-m', message]);
    return run(['rev-parse', 'HEAD']);
  };
  // The freeze-time map routes the case's file to the page's domain; the later one moved the glob away.
  const frozenMap = JSON.stringify(SCORE_ROUTING);
  const atFreeze = commitMap(frozenMap, 'freeze-time map');
  const later = commitMap(JSON.stringify({ order: [{ glob: 'scripts/memory/**', domain: 'domain-elsewhere' }] }), 'later map');
  const frozen = { ...scoreFixture(), source: { routingHash: createHash('sha256').update(frozenMap).digest('hex') } };
  const results = score({ frozen, repo, routingCommit: atFreeze, loadBody: loadInline });
  // Scored with the commit's map: the file routes to domain-memory and its page renders.
  assert.equal(results.cases[0].arms.map.source, 'map');
  assert.equal(results.cases[0].arms.map.recall, 1);
  assert.throws(() => score({ frozen, repo, routingCommit: later, loadBody: loadInline }),
    new RegExp(`routing map drifted since freeze: .* at commit ${later} does not match`));
  // A commit that holds no map is refused too, never replaced by the tree's map.
  run(['rm', '-q', file]);
  run(['commit', '-q', '-m', 'no map']);
  assert.throws(() => score({ frozen, repo, routingCommit: run(['rev-parse', 'HEAD']), loadBody: loadInline }),
    /no routing map at commit/);
  // With no flag the working tree's map is judged as before, and the refusal names the flag.
  assert.throws(() => score({ frozen: { ...frozen, source: { routingHash: 'not-the-hash' } }, loadBody: loadInline }),
    /routing map drifted since freeze: .*--routing-commit <sha>/);
});

// --- task 2398 slice E2: occurrence-level delivery, fair to a cut inside a line ---
import { goldLineDelivery, goldOccurrenceDelivery, occurrenceTable } from './eval-knowledge-routing.mjs';
import { compareScores, comparisonTable } from './eval-knowledge-routing.mjs';

test('goldLineDelivery: the inclusive short-line ceiling is UTF-8 bytes', () => {
  const anchor = 'tools/x.mjs';
  const short = `${'界'.repeat(337)} ${anchor} `;
  assert.equal(Buffer.byteLength(short), 1024);
  const body = `head\n## Gold\n${short}\n${short}x`;
  const marks = [{ at: 0, goldAnchors: [anchor] }];
  assert.deepEqual(goldLineDelivery({ body, render: body, marks }), { gold: 2, delivered: 2 });
  assert.deepEqual(goldLineDelivery({ body, render: body, marks, maxBytes: 1024 }), { gold: 1, delivered: 1 });
});

test('score comparison: reports all three metrics and rejects per-domain regressions, caps and incompatible gold', () => {
  const frozen = scoreFixture();
  frozen.cases[0].gold.sections[0].goldAnchors = ['scripts/memory/eval.mjs'];
  const run = (budget) => score({ frozen, routing: SCORE_ROUTING, loadBody: loadInline, budget });
  const before = run(30);
  const after = run(6144);
  const comparison = compareScores(before, after);
  assert.deepEqual(comparison.failures, []);
  assert.deepEqual(after.domains.map['domain-memory'].shortLines,
    { cases: 1, gold: 1, delivered: 1, share: 1, shareByCase: 1 });
  assert.match(comparisonTable(comparison), /^domain-memory\s+0->1 0->1 0->1 \d+->\d+ \d+->\d+$/m);
  assert.match(comparisonTable(comparison), /^all\s+0->1 0->1 0->1 \d+->\d+ \d+->\d+$/m);
  const regression = compareScores(after, before);
  assert.ok(regression.failures.includes('domain-memory: occurrence delivery must not fall'));
  assert.ok(regression.failures.includes('domain-memory: short whole-line delivery fell'));
  const oversize = structuredClone(after);
  oversize.domains.map['domain-memory'].bytes.max = 7681;
  assert.ok(compareScores(before, oversize).failures.includes('domain-memory: render exceeds byte cap'));
  const mismatched = structuredClone(after);
  mismatched.domains.map['domain-memory'].shortLines.gold++;
  assert.throws(() => compareScores(before, mismatched), /matching gold counts/);
  mismatched.cases.pop();
  assert.throws(() => compareScores(before, mismatched), /same frozen cases/);

  // A domain required to rise cannot pass just because it did not fall.
  frozen.cases.forEach((entry) => { entry.pages[0].domain = 'domain-harness'; });
  const routing = { order: [{ glob: 'scripts/memory/**', domain: 'domain-harness' }] };
  const prior = score({ frozen, routing, loadBody: loadInline, budget: 4096 });
  const next = score({ frozen, routing, loadBody: loadInline, budget: 6144 });
  assert.ok(compareScores(prior, next).failures.includes('domain-harness: occurrence delivery must rise'));
});

test('goldOccurrenceDelivery: an occurrence before a cut inside its line counts, one behind it does not', () => {
  // One long line cites the gold file three times: by path, by bare filename, and
  // by path again 100 characters later. The other section is not gold.
  const anchor = 'scripts/memory/eval.mjs';
  const line = `${'a'.repeat(60)} first ${anchor} then eval.mjs:42 ${'b'.repeat(100)} last ${anchor} ${'c'.repeat(60)}`;
  const body = `head\n## Gold\n${line}\n## Other\ncites ${anchor} outside the gold section`;
  const marks = [{ at: 0, goldAnchors: [anchor] }];
  const cutAfter = (count) => `head\n\n## Gold\n${line.slice(0, count)}\n[section cut]`;
  const second = line.indexOf('eval.mjs:42') + 'eval.mjs'.length;
  // The cut leaves 40 characters after the second citation: two of three ride,
  // and the whole line, which the line-level number asks for, does not.
  assert.deepEqual(goldOccurrenceDelivery({ body, render: cutAfter(second + 40), marks }), { gold: 3, delivered: 2 });
  assert.deepEqual(goldLineDelivery({ body, render: cutAfter(second + 40), marks }), { gold: 1, delivered: 0 });
  // One character less: the second anchor is shown, its passage is not.
  assert.deepEqual(goldOccurrenceDelivery({ body, render: cutAfter(second + 39), marks }), { gold: 3, delivered: 1 });
  assert.deepEqual(goldOccurrenceDelivery({ body, render: body, marks }), { gold: 3, delivered: 3 });
});

test('score: two occurrences in one line are two, reported per domain and in total beside the lines', () => {
  // The gold section overflows 400 bytes including the v6 labels and is cut at its long line:
  // the line before the cut cites the file twice, the line behind it once.
  const clippedPage = [
    'head',
    '## Gold clipped',
    'twice: scripts/memory/eval.mjs then scripts/memory/eval.mjs again',
    'y'.repeat(300),
    'last cites scripts/memory/eval.mjs behind the cut',
  ].join('\n');
  const fixture = {
    source: {},
    pageStore: {
      'domain-memory@clip': { domain: 'domain-memory', path: 'p', commit: 'abc', pageHash: '', body: clippedPage },
      'domain-other@whole': { domain: 'domain-other', path: 'q', commit: 'abc', pageHash: '', body: 'head\n## Solo\ncites tools/x.mjs here' },
    },
    cases: [
      { id: 'c1', role: 'coder', files: ['scripts/memory/eval.mjs'],
        pages: [{ domain: 'domain-memory', pageRef: 'domain-memory@clip' }],
        gold: { sections: [{ pageRef: 'domain-memory@clip', at: 0, goldAnchors: ['scripts/memory/eval.mjs'] }] } },
      { id: 'c2', role: 'coder', files: ['tools/x.mjs'],
        pages: [{ domain: 'domain-other', pageRef: 'domain-other@whole' }],
        gold: { sections: [{ pageRef: 'domain-other@whole', at: 0, goldAnchors: ['tools/x.mjs'] }] } },
    ],
  };
  const routing = { order: [{ glob: 'scripts/memory/**', domain: 'domain-memory' }, { glob: 'tools/**', domain: 'domain-other' }] };
  const results = score({ frozen: fixture, routing, loadBody: loadInline, budget: 400 });
  const [c1, c2] = results.cases;
  assert.deepEqual(c1.arms.map.lines, { gold: 2, delivered: 1 });
  assert.deepEqual(c1.arms.map.occurrences, { gold: 3, delivered: 2 });
  assert.deepEqual(c2.arms.map.occurrences, { gold: 1, delivered: 1 });
  const { all, 'domain-memory': memory, 'domain-other': other } = results.domains.map;
  assert.deepEqual(memory.occurrences, { cases: 1, gold: 3, delivered: 2, share: 2 / 3, shareByCase: 2 / 3 });
  assert.deepEqual(other.occurrences, { cases: 1, gold: 1, delivered: 1, share: 1, shareByCase: 1 });
  assert.deepEqual(all.occurrences, { cases: 2, gold: 4, delivered: 3, share: 0.75, shareByCase: (2 / 3 + 1) / 2 });
  // The table holds the whole-line number and the occurrence number side by side.
  assert.match(occurrenceTable(results), /^map {3}domain-memory\s+2\s+1\s+50\.0\s+3\s+2\s+66\.7\s+66\.7$/m);
  assert.match(occurrenceTable(results), /^map {3}all\s+3\s+2\s+66\.7\s+4\s+3\s+75\.0\s+83\.3$/m);
});
