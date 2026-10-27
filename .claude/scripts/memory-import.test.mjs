#!/usr/bin/env node
// Unit tests for memory-import pure functions + idempotent re-run against inline schema v1.
// Schema is created ONLY inside this test (importer never creates schema).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  kindFromFilename,
  extractTitle,
  extractSectionTitle,
  splitByHeadings,
  hardSplitBytes,
  expandOversizedSection,
  splitArchiveDocument,
  splitMemoryHotSections,
  preambleTitle,
  sha256,
  MAX_SECTION_BYTES,
  runImport,
  insertEntry,
  openExistingMemoryDb,
  validateMemEntriesSchema,
  EXPECTED_MEM_ENTRIES_COLUMNS,
  readSourceFile,
  runParity,
  planFile,
} from './memory-import.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------
// Inline schema v1 (mirrors chunk A memory.mjs — TEST ONLY)
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
  handoff_declaration TEXT
    CHECK(handoff_declaration IS NULL OR handoff_declaration IN ('none', 'tails')),
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
// Tests
// ---------------------------------------------------------------------------

test('kindFromFilename maps prefixes and unknown→archive', () => {
  assert.equal(kindFromFilename('handoff_2026-07-18_x.md'), 'handoff');
  assert.equal(kindFromFilename('feedback_no_mvp.md'), 'feedback');
  assert.equal(kindFromFilename('project_foo.md'), 'project');
  assert.equal(kindFromFilename('reference_bar.md'), 'reference');
  assert.equal(kindFromFilename('decision_2026-07-01_x.md'), 'decision');
  assert.equal(kindFromFilename('brief_something.md'), 'archive');
  assert.equal(kindFromFilename('USER.md'), 'archive');
  assert.equal(kindFromFilename('bug_orphan.md'), 'archive');
  assert.equal(kindFromFilename('_archive/handoff/handoff_x.md'), 'handoff');
});

test('extractTitle uses first H1 else fallback', () => {
  assert.equal(extractTitle('# Hello World\n\nbody', 'fb.md'), 'Hello World');
  assert.equal(extractTitle('## Not H1\nbody', 'fb.md'), 'fb.md');
  assert.equal(extractTitle('no heading', 'x.md'), 'x.md');
  assert.equal(extractTitle('#   spaced  \n', 'x'), 'spaced');
});

test('extractSectionTitle reads ## / ### first line', () => {
  assert.equal(extractSectionTitle('## Foo bar\nrest', 'fb', 2), 'Foo bar');
  assert.equal(extractSectionTitle('### Nested\n', 'fb', 3), 'Nested');
  assert.equal(extractSectionTitle('preamble only', '(preamble)', 2), '(preamble)');
});

test('preambleTitle prefers H1 then basename preamble', () => {
  assert.equal(preambleTitle('# HOT index\n\nintro\n', 'MEMORY.md'), 'HOT index');
  assert.equal(preambleTitle('no heading here\n', 'MEMORY.md'), 'MEMORY.md preamble');
  assert.equal(preambleTitle('# Full\n', 'MEMORY-FULL.md'), 'Full');
  assert.equal(preambleTitle('plain\n', 'MEMORY-ARCHIVE.md'), 'MEMORY-ARCHIVE.md preamble');
});

test('splitByHeadings preserves every byte on join', () => {
  const text = '# Doc\n\nintro\n\n## One\nAAA\n\n## Two\nBBB\n';
  const sections = splitByHeadings(text, 2);
  assert.equal(sections.map((s) => s.body).join(''), text);
  assert.ok(sections.length >= 2);
  const withH2 = sections.filter((s) => s.body.startsWith('## '));
  assert.equal(withH2.length, 2);
  assert.equal(withH2[0].title, 'One');
  assert.equal(withH2[1].title, 'Two');
});

test('splitByHeadings does not treat ### as ##', () => {
  const text = '## Parent\nxxx\n### Child\nyyy\n';
  const sections = splitByHeadings(text, 2);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, 'Parent');
  assert.ok(sections[0].body.includes('### Child'));
  assert.equal(sections.map((s) => s.body).join(''), text);
});

test('hardSplitBytes: line-boundary cuts reconstruct + stay under budget when newlines exist', () => {
  // Many short lines so we can cut at \n within budget
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(`line-${i}-` + 'α'.repeat(20));
  const payload = lines.join('\n') + '\n';
  const max = 1000;
  const parts = hardSplitBytes(payload, max);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), payload);
  for (const p of parts) {
    assert.ok(
      Buffer.byteLength(p, 'utf8') <= max,
      `part ${Buffer.byteLength(p, 'utf8')} exceeds ${max}`,
    );
  }
  // Each non-last part should end with newline (line-boundary policy)
  for (let i = 0; i < parts.length - 1; i++) {
    assert.ok(parts[i].endsWith('\n'), `part ${i} should end with newline`);
  }
});

test('hardSplitBytes: single long line may exceed budget but reconstructs', () => {
  const payload = 'α'.repeat(1000) + 'b'.repeat(5000); // no newlines
  const max = 1000;
  const parts = hardSplitBytes(payload, max);
  assert.equal(parts.join(''), payload);
  // Policy: intact emission when no newline fits — may be one oversized part
  assert.ok(parts.length >= 1);
  assert.ok(parts.some((p) => Buffer.byteLength(p, 'utf8') > max) || parts.length === 1);
});

test('expandOversizedSection: hard-split when no ### and >64KB (line-boundary)', () => {
  // Multi-line filler so line-boundary split can stay within budget
  const line = 'x'.repeat(200) + '\n';
  const body = '## Big\n' + line.repeat(Math.ceil((MAX_SECTION_BYTES + 2000) / line.length));
  assert.ok(Buffer.byteLength(body, 'utf8') > MAX_SECTION_BYTES);
  const parts = expandOversizedSection(body, 'Big', MAX_SECTION_BYTES);
  assert.ok(parts.length >= 2);
  assert.equal(parts.map((p) => p.body).join(''), body);
  assert.match(parts[0].title, /\(part 1\)$/);
  assert.match(parts[1].title, /\(part 2\)$/);
  for (const p of parts) {
    assert.ok(Buffer.byteLength(p.body, 'utf8') <= MAX_SECTION_BYTES);
  }
});

test('expandOversizedSection: ### split preferred over hard-split', () => {
  const half = Math.floor(MAX_SECTION_BYTES / 2) + 100;
  const body =
    '## Parent\n' +
    '### A\n' +
    'a'.repeat(half) +
    '\n### B\n' +
    'b'.repeat(half);
  assert.ok(Buffer.byteLength(body, 'utf8') > MAX_SECTION_BYTES);
  const parts = expandOversizedSection(body, 'Parent', MAX_SECTION_BYTES);
  assert.ok(parts.length >= 2);
  assert.equal(parts.map((p) => p.body).join(''), body);
  assert.ok(
    parts.every(
      (p) =>
        p.title.includes('A') ||
        p.title.includes('B') ||
        p.title.includes('Parent') ||
        p.title.includes('preamble'),
    ),
  );
});

test('splitArchiveDocument: preamble kept as archive entry + reconstruct', () => {
  const text = '# Full Doc\n\nintro bytes\n\n## Alpha\none\n\n## Beta\ntwo\n';
  const entries = splitArchiveDocument(text, 'MEMORY-ARCHIVE.md');
  assert.equal(entries.map((e) => e.body).join(''), text, 'zero-byte-loss');
  assert.ok(entries.some((e) => e.source_path === 'MEMORY-ARCHIVE.md#0'));
  const pre = entries.find((e) => e.isPreamble);
  assert.ok(pre, 'preamble entry present');
  assert.equal(pre.title, 'Full Doc');
  assert.ok(pre.body.includes('intro bytes'));
  assert.ok(entries.some((e) => e.title === 'Alpha'));
  assert.ok(entries.some((e) => e.title === 'Beta'));
});

test('splitMemoryHotSections: preamble-as-entry (pinned reference) + reconstruct', () => {
  const text = '# HOT\n\nintro keep me\n\n## First\nA\n\n## Second\nB\n';
  const secs = splitMemoryHotSections(text, 'MEMORY.md');
  // preamble + 2 sections
  assert.equal(secs.length, 3);
  assert.equal(secs.map((s) => s.body).join(''), text, 'zero-byte-loss');
  const pre = secs.find((s) => s.isPreamble);
  assert.ok(pre);
  assert.equal(pre.title, 'HOT');
  assert.equal(pre.kind, 'reference');
  assert.equal(pre.pinned, 1);
  assert.ok(pre.body.includes('intro keep me'));
  assert.equal(secs[1].title, 'First');
  assert.equal(secs[2].title, 'Second');
  assert.ok(secs[1].body.startsWith('## First'));
});

test('splitMemoryHotSections: no-H1 preamble uses basename fallback title', () => {
  const text = 'plain intro\n\n## Sec\nbody\n';
  const secs = splitMemoryHotSections(text, 'MEMORY.md');
  assert.equal(secs.length, 2);
  assert.equal(secs[0].title, 'MEMORY.md preamble');
  assert.equal(secs.map((s) => s.body).join(''), text);
});

test('sha256 stable', () => {
  assert.equal(sha256('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
});

test('readSourceFile: non-UTF8 fails LOUD (named path, no latin1)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memimport-utf8-'));
  const bad = path.join(tmp, 'bad.md');
  // Invalid UTF-8: lone continuation byte 0x80
  fs.writeFileSync(bad, Buffer.from([0x23, 0x20, 0x48, 0x69, 0x0a, 0x80, 0x0a]));
  assert.throws(
    () => readSourceFile(bad),
    (err) => {
      assert.match(String(err.message), /non-UTF8/i);
      assert.ok(String(err.message).includes(bad) || String(err.message).includes('bad.md'));
      return true;
    },
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('validateMemEntriesSchema: missing columns → SchemaError', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memimport-schema-'));
  const dbPath = path.join(tmp, 'bad.db');
  const db = new DatabaseSync(dbPath);
  // Incomplete table — missing most v1 columns
  db.exec(`CREATE TABLE mem_entries(id INTEGER PRIMARY KEY, title TEXT, body TEXT);`);
  assert.throws(
    () => validateMemEntriesSchema(db, dbPath),
    (err) => {
      assert.match(String(err.message), /SchemaError/);
      assert.match(String(err.message), /missing columns/);
      return true;
    },
  );
  db.close();

  // Missing table entirely
  const emptyPath = path.join(tmp, 'empty.db');
  const empty = new DatabaseSync(emptyPath);
  assert.throws(
    () => validateMemEntriesSchema(empty, emptyPath),
    /SchemaError.*MISSING|mem_entries/i,
  );
  empty.close();

  // openExistingMemoryDb also loud
  assert.throws(() => openExistingMemoryDb(dbPath), /SchemaError|missing columns/i);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('validateMemEntriesSchema: full v1 columns pass', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memimport-schema-ok-'));
  const dbPath = path.join(tmp, 'ok.db');
  const db = createSchemaV1(dbPath);
  validateMemEntriesSchema(db, dbPath); // must not throw
  assert.equal(EXPECTED_MEM_ENTRIES_COLUMNS.length, 18);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('whole-file byte-parity catches deliberately dropped preamble (regression)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memimport-parity-'));
  const dbPath = path.join(tmp, 'memory.db');
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  const text = '# HOT\n\nPREAMBLE_MUST_STAY\n\n## Chip A\nchip body\n';
  fs.writeFileSync(path.join(src, 'MEMORY.md'), text);

  const db = createSchemaV1(dbPath);
  // Simulate OLD buggy planner: only ## sections (drop preamble)
  const buggy = splitByHeadings(text, 2)
    .filter((s) => s.body.startsWith('## '))
    .map((s) => ({
      kind: 'reference',
      key: null,
      title: s.title,
      body: s.body,
      pinned: 1,
      source_path: `MEMORY.md#${s.index}`,
      ts: Date.now(),
      content_hash: sha256(s.body),
      verbatim: false,
      split: true,
      origin_file: 'MEMORY.md',
    }));
  assert.ok(buggy.length >= 1);
  assert.ok(!buggy.some((e) => e.body.includes('PREAMBLE_MUST_STAY')));

  for (const e of buggy) {
    assert.equal(insertEntry(db, e), 'inserted');
  }

  // Planned set that matches what was stored (buggy) — parity must still FAIL
  // because whole-file reconstruction from re-split expected includes preamble
  // and planned concat ≠ source.
  const parity = runParity(db, src, buggy);
  assert.equal(parity.ok, false, 'parity must FAIL when preamble was dropped');
  const fails = parity.results.filter((r) => r.status === 'FAIL');
  assert.ok(fails.length > 0);
  assert.ok(
    fails.some(
      (f) =>
        /whole-file|preamble|reconstruct|planned/i.test(f.detail || '') ||
        /MEMORY\.md/.test(f.path),
    ),
    `expected preamble-related FAIL, got: ${JSON.stringify(fails)}`,
  );
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('idempotent re-run inserts 0 new rows (tmp DB with v1 schema)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memimport-test-'));
  const dbPath = path.join(tmp, 'memory.db');
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  fs.mkdirSync(path.join(src, '_archive'));

  fs.writeFileSync(
    path.join(src, 'handoff_2026-07-18_test.md'),
    '# Handoff Test\n\nBody verbatim α.\n',
  );
  fs.writeFileSync(
    path.join(src, 'feedback_sample.md'),
    '# Feedback\n\nDo not MVP.\n',
  );
  fs.writeFileSync(
    path.join(src, 'SESSION-REGISTRY.md'),
    '# SESSION REGISTRY\n\n| session | status |\n',
  );
  fs.writeFileSync(
    path.join(src, 'MEMORY.md'),
    '# HOT\n\n## Chip A\nchip body\n\n## Chip B\nchip2\n',
  );
  // Small archive split with preamble
  fs.writeFileSync(
    path.join(src, 'MEMORY-FULL.md'),
    '# Full\n\npreamble line\n\n## Sec1\nhello\n\n## Sec2\nworld\n',
  );
  // Oversized multi-line section for hard-split coverage
  const line = 'z'.repeat(100) + '\n';
  const big =
    '## Mega\n' + line.repeat(Math.ceil((MAX_SECTION_BYTES + 200) / line.length));
  fs.writeFileSync(path.join(src, 'MEMORY-ARCHIVE.md'), big);
  // unknown prefix
  fs.writeFileSync(path.join(src, 'brief_x.md'), '# Brief\nok\n');
  // _archive handoff
  fs.writeFileSync(
    path.join(src, '_archive', 'handoff_old.md'),
    '# Old handoff\narchive\n',
  );
  // non-md skip
  fs.writeFileSync(path.join(src, 'notes.txt'), 'skip me');

  const db = createSchemaV1(dbPath);
  db.close();

  const first = runImport({ src, dbPath, dryRun: false });
  assert.ok(first.report.imported > 0, 'first run imports rows');

  // MEMORY.md preamble + 2 sections = at least 3 reference rows from MEMORY.md
  {
    const d = openExistingMemoryDb(dbPath);
    const memRows = d
      .prepare(`SELECT title, body FROM mem_entries WHERE source_path LIKE 'MEMORY.md#%' ORDER BY source_path`)
      .all();
    assert.ok(memRows.length >= 3, `expected ≥3 MEMORY.md entries, got ${memRows.length}`);
    assert.ok(
      memRows.some((r) => r.body.includes('# HOT') || r.title === 'HOT'),
      'preamble entry must be stored',
    );
    // FULL preamble stored as archive
    const fullPre = d
      .prepare(`SELECT title, body, pinned, kind FROM mem_entries WHERE source_path = 'MEMORY-FULL.md#0'`)
      .get();
    assert.ok(fullPre, 'MEMORY-FULL preamble entry');
    assert.equal(fullPre.kind, 'archive');
    assert.equal(Number(fullPre.pinned), 0);
    assert.ok(fullPre.body.includes('preamble line'));
    d.close();
  }

  const count1 = (() => {
    const d = openExistingMemoryDb(dbPath);
    const c = d.prepare('SELECT COUNT(*) AS c FROM mem_entries').get().c;
    d.close();
    return Number(c);
  })();

  const second = runImport({ src, dbPath, dryRun: false });
  assert.equal(second.report.imported, 0, 'second run imports 0');
  assert.ok(second.report.deduped_skipped + second.report.registry_skipped > 0);

  const d2 = openExistingMemoryDb(dbPath);
  const count2 = d2.prepare('SELECT COUNT(*) AS c FROM mem_entries').get().c;
  assert.equal(Number(count2), Number(count1), 'row count unchanged');

  // parity (whole-file)
  const parity = runImport({ src, dbPath, dryRun: true, doParity: true });
  assert.ok(parity.report.parity, 'parity object present');
  assert.equal(
    parity.report.parity.ok,
    true,
    `parity fails: ${JSON.stringify(parity.report.parity.results.filter((r) => r.status === 'FAIL'))}`,
  );
  d2.close();

  // openExistingMemoryDb fails loud without schema
  const emptyDb = path.join(tmp, 'empty.db');
  new DatabaseSync(emptyDb).close();
  assert.throws(() => openExistingMemoryDb(emptyDb), /mem_entries|SchemaError/);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('insertEntry skips live registry seed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memimport-reg-'));
  const dbPath = path.join(tmp, 'memory.db');
  const db = createSchemaV1(dbPath);
  const liveBody = 'live registry body';
  db.prepare(
    `INSERT INTO mem_entries(uuid,ts,session_id,agent,kind,key,title,body,links,sha_refs,pinned,content_hash,source_path,version)
     VALUES (?,?,?,?,?,?,?,?,'[]','[]',0,?,?,1)`,
  ).run(
    crypto.randomUUID(),
    Date.now(),
    's',
    'a',
    'registry',
    'session-registry',
    'SESSION REGISTRY',
    liveBody,
    sha256(liveBody),
    'SESSION-REGISTRY.md',
  );

  const seed = {
    kind: 'registry',
    key: 'session-registry',
    title: 'SESSION REGISTRY',
    body: 'seed from file different',
    pinned: 0,
    source_path: 'SESSION-REGISTRY.md',
    ts: Date.now(),
    content_hash: sha256('seed from file different'),
    verbatim: true,
    split: false,
    origin_file: 'SESSION-REGISTRY.md',
  };
  assert.equal(insertEntry(db, seed), 'registry_skipped');
  const c = db.prepare('SELECT COUNT(*) AS c FROM mem_entries').get().c;
  assert.equal(Number(c), 1);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('planFile MEMORY.md includes preamble entry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memimport-plan-'));
  const abs = path.join(tmp, 'MEMORY.md');
  fs.writeFileSync(abs, '# Title\n\nkeep\n\n## A\nx\n');
  const { planned } = planFile({ abs, rel: 'MEMORY.md', basename: 'MEMORY.md' });
  assert.ok(planned.length >= 2);
  assert.equal(planned.map((p) => p.body).join(''), fs.readFileSync(abs, 'utf8'));
  assert.ok(planned[0].pinned === 1);
  assert.ok(planned[0].body.includes('keep'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok  - ${t.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${t.name}`);
      console.error(err);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exitCode = 1;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
