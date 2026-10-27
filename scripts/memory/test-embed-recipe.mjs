#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunks, embed, embedEntry, entryText, entryTextSha } from './embed-recipe.mjs';
import { SCHEMA_VERSION, listMissingOrStaleVectorIds, loadCurrentVectors, openMemoryDb, putVector } from './store.mjs';

test('shared model recipes preserve measured query and document prefix bytes', async () => {
  const { MODELS } = await import('./embed-recipe.mjs');
  assert.ok(MODELS, 'model recipes must be shared by the bench and daemon');
  for (const [model, query, document] of [
    ['nomic-embed-text', 'search_query: ', 'search_document: '],
    ['bge-m3', '', ''],
    ['qwen3-embedding:0.6b', 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ', ''],
  ]) {
    assert.deepEqual(MODELS[model], { query, document }, model);
  }
});

// Independent copy of the offline formula: split code points at 1800 bytes,
// Float32 accumulation and byte-weighted unit norm. Compare serialized bytes.
function oldRecipe(row, dim, prefix, stub) {
  const pieces = [];
  let part = '';
  let bytes = 0;
  for (const char of `${row.title}\n${row.body}`) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 1800) { pieces.push(part); part = ''; bytes = 0; }
    part += char;
    bytes += size;
  }
  if (part || !pieces.length) pieces.push(part);
  const sums = new Float32Array(dim);
  let weight = 0;
  for (const piece of pieces) {
    const w = Buffer.byteLength(piece);
    weight += w;
    const values = stub(prefix + piece);
    for (let i = 0; i < dim; i++) sums[i] += values[i] * w;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) { sums[i] /= weight; norm += sums[i] ** 2; }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) sums[i] /= norm;
  return { sums, pieces };
}

function bytes(values) {
  const result = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) result.writeFloatLE(values[i], i * 4);
  return result;
}

test('entry recipe preserves old offline bytes, chunk boundaries, prefix and batches', async () => {
  const stub = (text) => [1 + text.length % 7, -2 - Buffer.byteLength(text) % 11, 3.25];
  for (const row of [
    { title: 'small', body: 'hello' },
    { title: 'boundary 🐈', body: 'я'.repeat(1000) + 'xyz'.repeat(6500) },
  ]) {
    const old = oldRecipe(row, 3, 'search_document: ', stub);
    const batches = [];
    const result = await embedEntry(row, 'nomic-embed-text', 3, (model, texts) => {
      assert.equal(model, 'nomic-embed-text');
      batches.push(texts);
      return texts.map(stub);
    }, 'search_document: ');
    assert.deepEqual(bytes(result.vector), bytes(old.sums));
    assert.equal(result.chunks, old.pieces.length);
    assert.deepEqual(chunks(entryText(row)), old.pieces);
    assert.deepEqual(batches.flat(), old.pieces.map((piece) => 'search_document: ' + piece));
    assert.ok(batches.every((batch) => batch.length <= 16));
    assert.ok(old.pieces.every((piece) => Buffer.byteLength(piece) <= 1800));
  }
});

test('Ollama client preserves payload and rejects bad embedding counts', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'http://localhost:11435/api/embed');
      assert.deepEqual(JSON.parse(options.body), {
        model: 'bge-m3', input: ['a', 'b'], truncate: false, options: { num_ctx: 2048 },
      });
      assert.ok(options.signal);
      return { ok: true, json: async () => ({ embeddings: [[1], [2]] }) };
    };
    assert.deepEqual(await embed('http://localhost:11435', 'bge-m3', ['a', 'b']), [[1], [2]]);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ embeddings: [] }) });
    await assert.rejects(embed('http://localhost:11435', 'bge-m3', ['a']), /embedding count mismatch/);
  } finally { globalThis.fetch = previous; }
});

function tempStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-vector-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function insertEntry(db, id, title, body) {
  db.prepare(`INSERT INTO mem_entries(id, uuid, ts, kind, title, body, content_hash)
    VALUES (?, ?, ?, 'reference', ?, ?, ?)`).run(id, `uuid-${id}`, 1000 + id, title, body, `hash-${id}`);
}

test('v6 migration adds only the vector table, preserving every old row', () => tempStore((dir) => {
  let db = openMemoryDb(dir);
  insertEntry(db, 1, 'first', 'preserve this');
  insertEntry(db, 2, 'second', 'and this');
  const before = db.prepare('SELECT * FROM mem_entries ORDER BY id').all();
  const ftsBefore = db.prepare("SELECT rowid, title, body FROM mem_entries_fts ORDER BY rowid").all();
  db.exec('DROP TABLE mem_vectors; PRAGMA user_version=6');
  db.close();
  db = openMemoryDb(dir);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.deepEqual(db.prepare('SELECT * FROM mem_entries ORDER BY id').all(), before);
    assert.deepEqual(db.prepare('SELECT rowid, title, body FROM mem_entries_fts ORDER BY rowid').all(), ftsBefore);
    assert.equal(db.prepare('SELECT count(*) AS n FROM mem_vectors').get().n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
}));

test('put and load use little-endian floats; edited text and changed model need re-embedding', () => tempStore((dir) => {
  const db = openMemoryDb(dir);
  try {
    insertEntry(db, 1, 'first', 'body');
    insertEntry(db, 2, 'second', 'body');
    const row = db.prepare('SELECT title, body FROM mem_entries WHERE id = 1').get();
    const hash = entryTextSha(row);
    assert.deepEqual(listMissingOrStaleVectorIds(db, 'bge-m3'), [1, 2]);
    const vector = new Float32Array([0.5, -0.25]);
    putVector(db, { entryId: 1, model: 'bge-m3', vector, textSha: hash, ts: 2000 });
    assert.deepEqual(Buffer.from(db.prepare('SELECT vec FROM mem_vectors WHERE entry_id=1').get().vec), bytes(vector));
    assert.deepEqual(listMissingOrStaleVectorIds(db, 'bge-m3'), [2]);
    assert.deepEqual(loadCurrentVectors(db, 'bge-m3'), [
      { entryId: 1, model: 'bge-m3', vector, textSha: hash, ts: 2000 },
    ]);
    assert.deepEqual(listMissingOrStaleVectorIds(db, 'new-model'), [1, 2]);
    assert.deepEqual(loadCurrentVectors(db, 'new-model'), []);
    db.prepare('UPDATE mem_entries SET body = ? WHERE id = 1').run('changed body');
    assert.deepEqual(listMissingOrStaleVectorIds(db, 'bge-m3'), [1, 2]);
    assert.deepEqual(loadCurrentVectors(db, 'bge-m3'), []);
    assert.throws(() => putVector(db, { entryId: 1, model: 'bge-m3', vector, textSha: hash }), /stale entry text/);
    putVector(db, { entryId: 1, model: 'new-model', vector, textSha: entryTextSha({ title: 'first', body: 'changed body' }) });
    assert.deepEqual(listMissingOrStaleVectorIds(db, 'new-model'), [2]);
    assert.throws(() => putVector(db, { entryId: 99, model: 'bge-m3', vector, textSha: hash }), /missing entry/);
  } finally { db.close(); }
}));
