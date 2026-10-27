import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from './store.mjs';

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}
async function json(url, options) {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json() };
}
async function until(check, label) {
  const deadline = Date.now() + 7000;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (error) { last = String(error); }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}
async function fixture(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'memoryd-embed-'));
  const gate = await serve((_req, res) => { res.writeHead(404); res.end(); });
  const port = new URL(gate.url).port;
  await gate.close();
  const db = openMemoryDb(dir);
  db.close();
  const token = readFileSync(join(dir, 'memory.token'), 'utf8').trim();
  const child = spawn(process.execPath, ['scripts/memory/memoryd.mjs'], {
    env: { ...process.env, MEMORYCTL_STATE_DIR: dir, MEMORYCTL_PORT: port,
      MEMORYCTL_EMBED_URL: config.url || '', MEMORYCTL_EMBED_BACKLOG_URL: config.backlogUrl || '',
      MEMORYCTL_EMBED_MODEL: config.model ?? 'bge-m3',
      MEMORYCTL_QUERY_EMBED_TIMEOUT_MS: config.queryTimeoutMs ?? 15_000 }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const base = `http://127.0.0.1:${port}`;
  await until(async () => (await json(`${base}/health`)).body.ok, 'memoryd health');
  return {
    dir, base, stderr: () => stderr,
    health: async () => (await json(`${base}/health`)).body,
    write: (route, data) => json(`${base}/api/memory/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-memory-token': token },
      body: JSON.stringify(data),
    }),
    async close() {
      child.kill();
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000))]);
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

function ollama(state) {
  return serve(async (req, res) => {
    assert.equal(req.url, '/api/embed');
    const pieces = [];
    for await (const piece of req) pieces.push(piece);
    const input = JSON.parse(Buffer.concat(pieces).toString());
    state.calls.push(input);
    if (state.down) { res.writeHead(503); res.end('offline'); return; }
    if (state.hold) await state.hold;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ embeddings: input.input.map((text) => [text.length + 1, 2, 3]) }));
  });
}

test('configured model recipe reaches query and document requests and is visible in health', async () => {
  for (const [model, queryPrefix, documentPrefix] of [
    ['qwen3-embedding:0.6b', 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ', ''],
    ['bge-m3', '', ''],
    ['nomic-embed-text', 'search_query: ', 'search_document: '],
  ]) {
    const state = { calls: [], down: false };
    const remote = await ollama(state);
    let fx;
    try {
      fx = await fixture({ url: remote.url, model });
      const query = 'where is the passage?';
      assert.equal((await json(`${fx.base}/api/memory/search?q=${encodeURIComponent(query)}`)).status, 200);
      assert.deepEqual(state.calls, [{
        model, input: [queryPrefix + query], truncate: false, options: { num_ctx: 2048 },
      }]);
      assert.equal((await fx.health()).embedder.queryPrefix, queryPrefix);
      state.calls.length = 0;
      const title = 'recipe';
      const body = 'x'.repeat(1800 * 17);
      assert.equal((await fx.write('append', { kind: 'reference', title, body })).status, 200);
      await until(async () => (await fx.health()).vectors.missing === 0, `${model} document vector`);
      assert.ok(state.calls.length > 1, 'document exercises the first and subsequent batches');
      const documentTexts = state.calls.flatMap((call) => {
        assert.equal(call.model, model);
        return call.input;
      });
      assert.ok(documentTexts.every((text) => text.startsWith(documentPrefix)));
      assert.equal(documentTexts.map((text) => text.slice(documentPrefix.length)).join(''), `${title}\n${body}`);
    } finally { if (fx) await fx.close(); await remote.close(); }
  }
});

test('unknown embedding model refuses startup and names the shared recipe table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memoryd-unknown-model-'));
  const child = spawn(process.execPath, ['scripts/memory/memoryd.mjs'], {
    env: { ...process.env, MEMORYCTL_STATE_DIR: dir, MEMORYCTL_HOST: '127.0.0.1',
      MEMORYCTL_PORT: '0', MEMORYCTL_EMBED_MODEL: 'unmeasured-model',
      MEMORYCTL_EMBED_URL: '', MEMORYCTL_EMBED_BACKLOG_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  let timer;
  try {
    const code = await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3000); }),
    ]);
    assert.equal(code, 1, 'unmeasured model must exit nonzero instead of serving');
    assert.match(output, /unmeasured-model/);
    assert.match(output, /embed-recipe\.mjs/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('close', resolve));
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('append and supersede commit before embedding; replacement gets its own current vector', async () => {
  const state = { calls: [], down: false };
  let release;
  state.hold = new Promise((resolve) => { release = resolve; });
  const remote = await ollama(state);
  let fx;
  try {
    fx = await fixture({ url: remote.url });
    const first = await fx.write('append', { kind: 'reference', title: 'first', body: 'one' });
    assert.equal(first.status, 200);
    await until(async () => state.calls.length > 0, 'blocked embed request');
    assert.equal((await fx.health()).vectors.missing, 1);
    release();
    state.hold = null;
    await until(async () => (await fx.health()).vectors.missing === 0, 'first vector');
    const next = await fx.write('supersede', { id: first.body.id, title: 'first changed', body: 'two' });
    assert.equal(next.status, 200);
    await until(async () => (await fx.health()).vectors.missing === 0 && state.calls.length >= 2, 'replacement vector');
    const db = openMemoryDb(fx.dir);
    try {
      const rows = db.prepare('SELECT entry_id, text_sha FROM mem_vectors ORDER BY entry_id').all();
      assert.deepEqual(rows.map((row) => Number(row.entry_id)), [first.body.id, next.body.id]);
      assert.notEqual(rows[0].text_sha, rows[1].text_sha);
    } finally { db.close(); }
    const health = await fx.health();
    assert.equal(health.service, 'memoryctl');
    assert.equal(health.embedder.reachable, true);
    assert.equal(health.vectors.total, 1);
    assert.deepEqual([health.vectors.missing, health.vectors.stale], [0, 0]);
  } finally { release(); if (fx) await fx.close(); await remote.close(); }
});

test('embed outage does not fail append; health exposes error and recovery drains backlog', async () => {
  const state = { calls: [], down: true };
  const remote = await ollama(state);
  let fx;
  try {
    fx = await fixture({ url: remote.url });
    const response = await fx.write('append', { kind: 'reference', title: 'offline', body: 'durable' });
    assert.equal(response.status, 200);
    const failed = await until(async () => {
      const health = await fx.health();
      return health.embedder.lastError && health.vectors.missing === 1 ? health : null;
    }, 'recorded embed outage');
    assert.equal(failed.embedder.reachable, false);
    assert.match(failed.embedder.lastError, /503/);
    state.down = false;
    const recovered = await until(async () => {
      const health = await fx.health();
      return health.vectors.missing === 0 && health.embedder.reachable ? health : null;
    }, 'retry after outage');
    assert.ok(recovered.embedder.lastOkAt);
    assert.equal(recovered.embedder.lastError, null);
    // An in-place text edit (for example from a transferred old database)
    // must be counted as stale, then re-embedded on the next write wakeup.
    const db = openMemoryDb(fx.dir);
    try { db.prepare('UPDATE mem_entries SET body = ? WHERE id = ?').run('edited', response.body.id); }
    finally { db.close(); }
    assert.equal((await fx.health()).vectors.stale, 1);
    assert.equal((await fx.write('append', { kind: 'reference', title: 'wake', body: 'worker' })).status, 200);
    await until(async () => {
      const health = await fx.health();
      return health.vectors.missing === 0 && health.vectors.stale === 0;
    }, 'stale text re-embedded');
  } finally { if (fx) await fx.close(); await remote.close(); }
});

test('one permanently failing id backs off while later entries get vectors; health retains its error', async () => {
  const calls = [];
  const remote = await serve(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const { input } = JSON.parse(Buffer.concat(parts).toString());
    calls.push(...input);
    if (input.some((text) => text.startsWith('broken'))) {
      res.writeHead(503); res.end('broken entry'); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ embeddings: input.map(() => [1, 0]) }));
  });
  let fx;
  try {
    fx = await fixture({ url: remote.url });
    const bad = await fx.write('append', { kind: 'reference', title: 'broken', body: 'will not embed' });
    assert.equal(bad.status, 200);
    const failed = await until(async () => (await fx.health()).embedder.backlogFailure, 'failing id recorded');
    assert.equal(failed.id, bad.body.id);
    assert.match(failed.message, /503/);
    assert.ok(Date.parse(failed.retryAt) > Date.now() - 1000, 'individual retry is delayed');
    const good = await fx.write('append', { kind: 'reference', title: 'healthy', body: 'must embed' });
    assert.equal(good.status, 200);
    const health = await until(async () => {
      const result = await fx.health();
      return result.vectors.total === 2 && result.vectors.missing === 1 && result.embedder.reachable
        ? result : null;
    }, 'healthy id embedded after failed id');
    assert.equal(health.embedder.backlogFailure.id, bad.body.id);
    assert.match(health.embedder.backlogFailure.message, /503/);
    assert.equal(health.embedder.lastError, null, 'global last success remains visible separately');
    assert.ok(calls.some((text) => text.startsWith('healthy')));
    const db = openMemoryDb(fx.dir);
    try { assert.deepEqual(db.prepare('SELECT entry_id FROM mem_vectors').all().map((r) => Number(r.entry_id)), [good.body.id]); }
    finally { db.close(); }
  } finally { if (fx) await fx.close(); await remote.close(); }
});

test('a slow query embed returns 503 before the CLI 30-second deadline', async () => {
  const remote = await serve(async (req, res) => {
    for await (const _part of req) { /* consume request */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ embeddings: [[1, 0]] }));
  });
  let fx;
  try {
    fx = await fixture({ url: remote.url, queryTimeoutMs: 100 });
    const started = Date.now();
    const result = await json(`${fx.base}/api/memory/search?q=slow`);
    const elapsed = Date.now() - started;
    assert.equal(result.status, 503);
    assert.match(result.body.error, /timeout|abort/i);
    assert.ok(elapsed < 2500, `query should time out promptly; elapsed=${elapsed}ms`);
  } finally { if (fx) await fx.close(); await remote.close(); }
});

test('backlog uses its dedicated URL, not the query embed URL', async () => {
  const state = { calls: [], down: false };
  const gpu = await ollama(state);
  let fx;
  try {
    fx = await fixture({ url: 'http://127.0.0.1:1', backlogUrl: gpu.url });
    assert.equal((await fx.write('append', { kind: 'reference', title: 'gpu', body: 'batch' })).status, 200);
    await until(async () => (await fx.health()).vectors.missing === 0, 'backlog URL vector');
    assert.ok(state.calls.length > 0);
    assert.equal((await fx.health()).embedder.backlogUrl, gpu.url);
  } finally { if (fx) await fx.close(); await gpu.close(); }
});

test('without embed URL service says disabled and retains an honest missing count', async () => {
  const fx = await fixture();
  try {
    assert.equal((await fx.write('append', { kind: 'reference', title: 'off', body: 'still stored' })).status, 200);
    const health = await fx.health();
    assert.equal(health.embedder.reachable, false);
    assert.match(health.embedder.lastError, /disabled/);
    assert.deepEqual(health.vectors, { total: 1, missing: 1, stale: 0 });
  } finally { await fx.close(); }
});
