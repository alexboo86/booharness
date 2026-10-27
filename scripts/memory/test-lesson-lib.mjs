// Pure-unit tests for lesson-lib + import planning (tmp DB with inline schema v1).
import '../jev-test-state.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  sha256,
  isGlobAnchor,
  buildLessonLinks,
  lessonDedupKey,
  fieldOf,
  titleOfBlock,
  anchorOfBlock,
  splitLessonFile,
  matchGlob,
  globResolves,
  classifyAnchor,
  insertLessonEntry,
  listLiveLessons,
  parseLinks,
  LESSON_PAYLOAD_BUDGET_PER_FILE,
} from './lesson-lib.mjs';
import * as lessonLib from './lesson-lib.mjs';
import { planLessons, parityAgainstSources, runImportLessons } from './import-lessons.mjs';
import { decidePromote, buildActiveIndex } from './promote-lesson.mjs';
import { renderLesson, validateCaptureArgs, normalizeDomain } from './capture-lesson.mjs';

test('fallback discovery scans configured source roots, never an inferred project layout', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-roots-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, 'packages/api'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'packages/api/main.ts'), 'export const api = true;\n');
  fs.writeFileSync(path.join(repoRoot, 'src/unselected.ts'), 'not selected\n');
  assert.deepEqual(lessonLib.listRepoPaths(repoRoot), []);
  fs.mkdirSync(path.join(repoRoot, 'ops/bootstrap'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'ops/bootstrap/harness.config.json'), JSON.stringify({
    names: { prefix: 'example' }, memory: { embed: { model: 'example' } },
    project: { anchorRoots: ['packages'] },
  }));
  assert.deepEqual(lessonLib.listRepoPaths(repoRoot), ['packages/api/main.ts']);
});

// ---------------------------------------------------------------------------
// Inline schema v1 (TEST ONLY — mirrors chunk A)
// ---------------------------------------------------------------------------

function createSchemaV1(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE mem_entries(
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  session_id TEXT,
  agent TEXT,
  kind TEXT NOT NULL CHECK(kind IN (
    'handoff', 'registry', 'chip', 'lesson', 'reference',
    'feedback', 'project', 'decision', 'archive'
  )),
  key TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  links TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(links)),
  sha_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sha_refs)),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
  content_hash TEXT NOT NULL,
  source_path TEXT,
  supersedes INTEGER REFERENCES mem_entries(id),
  superseded_by INTEGER REFERENCES mem_entries(id),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(kind, title, content_hash)
);
CREATE UNIQUE INDEX idx_mem_entries_live_key
  ON mem_entries(key) WHERE superseded_by IS NULL;
CREATE INDEX idx_mem_entries_kind_ts ON mem_entries(kind, ts DESC);
CREATE VIRTUAL TABLE mem_entries_fts USING fts5(
  title, body, content='mem_entries', content_rowid='id'
);
CREATE TRIGGER mem_entries_fts_insert AFTER INSERT ON mem_entries
WHEN new.superseded_by IS NULL
BEGIN
  INSERT INTO mem_entries_fts(rowid, title, body)
  VALUES (new.id, new.title, new.body);
END;
PRAGMA user_version=1;
`);
  return db;
}

// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------

test('splitLessonFile preserves every byte (preamble + ## sections)', () => {
  const text = `# Header\n\n## One\n- anchor: a.ts:foo\n\n## Two\n- anchor: b.ts\n`;
  const { preamble, sections } = splitLessonFile(text);
  assert.equal(preamble + sections.map((s) => s.body).join(''), text);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, 'One');
  assert.equal(sections[1].title, 'Two');
});

test('splitLessonFile handles empty / no ## / ### guard', () => {
  assert.deepEqual(splitLessonFile(''), { preamble: '', sections: [] });
  const onlyPreamble = '# just h1\n\ntext\n';
  const r = splitLessonFile(onlyPreamble);
  assert.equal(r.preamble, onlyPreamble);
  assert.equal(r.sections.length, 0);
  // ### must not start a section
  const withH3 = '## Real\nbody\n### Nested\nmore\n';
  const r2 = splitLessonFile(withH3);
  assert.equal(r2.sections.length, 1);
  assert.ok(r2.sections[0].body.includes('### Nested'));
});

test('titleOfBlock / anchorOfBlock / fieldOf', () => {
  const b = '## My Title\n- anchor: x.rs:sym\n- trigger: when Z\n- rule: do it\n';
  assert.equal(titleOfBlock(b), 'My Title');
  assert.equal(anchorOfBlock(b), 'x.rs:sym');
  assert.equal(fieldOf(b, 'rule'), 'do it');
  assert.equal(fieldOf(b, 'missing'), null);
});

// ---------------------------------------------------------------------------
// Links + dedup
// ---------------------------------------------------------------------------

test('buildLessonLinks sets status, globs for glob-anchors', () => {
  const L = buildLessonLinks({
    domain: 'domain-example',
    anchor: 'src/**/exampleRuntime.ts',
    status: 'active',
    trigger: 'when X',
  });
  assert.equal(L.domain, 'domain-example');
  assert.equal(L.status, 'active');
  assert.deepEqual(L.globs, ['src/**/exampleRuntime.ts']);
  assert.equal(L.trigger, 'when X');

  const inbox = buildLessonLinks({ domain: 'domain-x', anchor: 'a.rs:f', status: 'inbox' });
  assert.equal(inbox.status, 'inbox');
  assert.deepEqual(inbox.globs, []);
});

test('lessonDedupKey normalizes domain+title case', () => {
  const a = lessonDedupKey({ domain: 'Domain-Example', anchor: 'a:b', title: 'Hello' });
  const b = lessonDedupKey({ domain: 'domain-example', anchor: 'a:b', title: 'hello' });
  assert.equal(a, b);
  const c = lessonDedupKey({ domain: 'domain-example', anchor: 'a:c', title: 'hello' });
  assert.notEqual(a, c);
});

test('isGlobAnchor detects * and path-?; lone ? is placeholder', () => {
  assert.equal(isGlobAnchor('src/**/x.ts'), true);
  assert.equal(isGlobAnchor('a?.ts'), true);
  assert.equal(isGlobAnchor('a.ts:foo'), false);
  assert.equal(isGlobAnchor('?'), false);
  assert.equal(isGlobAnchor(''), false);
});

// ---------------------------------------------------------------------------
// matchGlob + classifyAnchor
// ---------------------------------------------------------------------------

test('matchGlob doublestar', () => {
  assert.equal(matchGlob('src/**/exampleRuntime.ts', 'src/utils/exampleRuntime.ts'), true);
  assert.equal(matchGlob('src/**/exampleRuntime.ts', 'src/a/b/exampleRuntime.ts'), true);
  assert.equal(matchGlob('src/*.ts', 'src/a/b.ts'), false);
  assert.equal(matchGlob('src/*.ts', 'src/a.ts'), true);
  assert.equal(globResolves('src/**/*.rs', ['src/x/y.rs', 'other']), true);
  assert.equal(globResolves('nope/**', ['src/x']), false);
});

test('classifyAnchor: file/symbol/line/glob/gone', () => {
  const reader = (f) => {
    if (f === 'a.rs') return 'fn foo() {}\nline2\nline3\n';
    return null;
  };
  assert.equal(classifyAnchor('nope/x.rs:foo', reader), 'gone');
  assert.equal(classifyAnchor('a.rs:foo', reader), 'keep');
  assert.equal(classifyAnchor('a.rs:bar', reader), 'drift');
  assert.equal(classifyAnchor('a.rs', reader), 'keep');
  assert.equal(classifyAnchor('a.rs:3', reader), 'keep');
  assert.equal(classifyAnchor('a.rs:99', reader), 'drift');
  assert.equal(classifyAnchor('?', reader), 'drift');
  assert.equal(classifyAnchor('', reader), 'drift');
  // glob without paths → gone (not auto-keep)
  assert.equal(classifyAnchor('src/**/*.ts', reader), 'gone');
  assert.equal(
    classifyAnchor('src/**/*.ts', reader, { repoPaths: ['src/utils/x.ts'] }),
    'keep',
  );
  assert.equal(
    classifyAnchor('src/**/*.ts', reader, { repoPaths: ['lib/x.ts'] }),
    'gone',
  );
});

// ---------------------------------------------------------------------------
// capture render + validation
// ---------------------------------------------------------------------------

test('renderLesson emits anchored schema; omits empty trigger', () => {
  const out = renderLesson({
    title: 'X',
    anchor: 'a.rs:f',
    rule: 'do Y',
    why: 'because',
    evidence: 'commit abc',
    date: '2026-06-27',
  });
  assert.match(out, /## X/);
  assert.match(out, /anchor: a\.rs:f/);
  assert.ok(!out.includes('trigger:'));

  const withT = renderLesson({
    title: 'X',
    anchor: 'a',
    trigger: 'when Z',
    rule: 'r',
    why: 'w',
    evidence: 'e',
    date: 'd',
  });
  assert.match(withT, /trigger: when Z/);
});

test('validateCaptureArgs + normalizeDomain', () => {
  assert.equal(normalizeDomain('example'), 'domain-example');
  assert.equal(normalizeDomain('domain-example'), 'domain-example');
  assert.throws(() => validateCaptureArgs({ domain: null, title: 't', anchor: 'a', rule: 'r', why: 'w', evidence: 'e' }));
  assert.throws(() => validateCaptureArgs({ domain: 'domain-x', title: 't', anchor: '?', rule: 'r', why: 'w', evidence: 'e' }));
  validateCaptureArgs({ domain: 'domain-x', title: 't', anchor: 'a', trigger: 'when x', rule: 'r', why: 'w', evidence: '#1' });
});

// ---------------------------------------------------------------------------
// promote decide
// ---------------------------------------------------------------------------

test('decidePromote: promote / dedupe-hash / dedupe-key', () => {
  const active = [
    {
      id: 1,
      title: 'Same Title',
      content_hash: 'aaa',
      body: 'body-a',
      linksObj: { domain: 'domain-x', anchor: 'f:s', status: 'active' },
    },
  ];
  const index = buildActiveIndex(active);
  assert.equal(
    decidePromote(
      { title: 'New', content_hash: 'bbb', body: 'x', linksObj: { domain: 'domain-x', anchor: 'other', status: 'inbox' } },
      index,
    ),
    'promote',
  );
  assert.equal(
    decidePromote(
      { title: 'Same Title', content_hash: 'aaa', body: 'body-a', linksObj: { domain: 'domain-x', anchor: 'f:s', status: 'inbox' } },
      index,
    ),
    'dedupe-hash',
  );
  assert.equal(
    decidePromote(
      { title: 'Same Title', content_hash: 'ccc', body: 'new-ev', linksObj: { domain: 'domain-x', anchor: 'f:s', status: 'inbox' } },
      index,
    ),
    'dedupe-key',
  );
});

// ---------------------------------------------------------------------------
// import plan + insert idempotency on tmp DB
// ---------------------------------------------------------------------------

test('planLessons + insertLessonEntry idempotent on tmp skills tree', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-import-'));
  const domainDir = path.join(tmp, 'domain-test');
  fs.mkdirSync(domainDir);
  const lessons = `# Test domain\n\n## First gotcha\n- anchor: a.rs:foo\n- rule: do X\n- why: because\n- evidence: t\n- date: 2026-07-18\n\n## Second\n- anchor: src/**/*.ts\n- rule: glob\n- why: w\n- evidence: e\n- date: 2026-07-18\n`;
  fs.writeFileSync(path.join(domainDir, 'lessons.md'), lessons);
  fs.writeFileSync(
    path.join(domainDir, '_inbox.md'),
    `# inbox\n<!-- header -->\n\n## Inbox item\n- anchor: b.rs:bar\n- rule: r\n- why: w\n- evidence: e\n- date: 2026-07-18\n`,
  );

  const { planned, perDomain } = planLessons(tmp);
  assert.equal(planned.length, 3);
  assert.equal(perDomain['domain-test'].active, 2);
  assert.equal(perDomain['domain-test'].inbox, 1);
  assert.equal(planned.filter((p) => p.status === 'inbox').length, 1);
  assert.equal(planned[1].links.globs[0], 'src/**/*.ts');

  const parity = parityAgainstSources(tmp, planned);
  assert.equal(parity.ok, true);

  const dbPath = path.join(tmp, 'memory.db');
  const db = createSchemaV1(dbPath);
  let inserted = 0;
  let deduped = 0;
  for (const p of planned) {
    const r = insertLessonEntry(db, p);
    if (r === 'inserted') inserted++;
    else deduped++;
  }
  assert.equal(inserted, 3);
  assert.equal(deduped, 0);
  // re-run → all deduped
  for (const p of planned) {
    const r = insertLessonEntry(db, p);
    assert.equal(r, 'deduped');
  }
  const live = listLiveLessons(db);
  assert.equal(live.length, 3);
  assert.equal(listLiveLessons(db, { status: 'active' }).length, 2);
  assert.equal(listLiveLessons(db, { status: 'inbox' }).length, 1);
  db.close();

  const refusedDbPath = path.join(tmp, 'refused.db');
  createSchemaV1(refusedDbPath).close();
  assert.throws(() => runImportLessons({ skills: tmp, dbPath: refusedDbPath }), /lesson import refused: use scripts\/memory\/capture-lesson\.mjs/);
  const refusedDb = new DatabaseSync(refusedDbPath);
  assert.equal(refusedDb.prepare('SELECT count(*) AS n FROM mem_entries').get().n, 0);
  refusedDb.close();
  assert.equal(runImportLessons({ skills: tmp, dryRun: true }).dry_run, true);

  // ONE budget, on the axis a context actually pays: what one FILE's delivery
  // costs. The per-domain count guard was removed 2026-08-11 — a domain has not
  // entered a context as a unit since delivery went per-file, and it refused 77
  // captured lessons to protect a number nobody reads (task 367).
  assert.equal(LESSON_PAYLOAD_BUDGET_PER_FILE, 49152);
  assert.ok(
    !('LESSON_BUDGET_PER_DOMAIN' in lessonLib),
    'the per-domain count guard must stay gone: it measured the store, not a delivery',
  );
  assert.equal(parseLinks('{"domain":"x"}').domain, 'x');
  assert.equal(sha256('abc').length, 64);

  fs.rmSync(tmp, { recursive: true, force: true });
});
