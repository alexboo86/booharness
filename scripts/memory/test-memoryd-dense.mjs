import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from './store.mjs';
import { createReranker } from './reranker.mjs';
import { setImmediate as turn } from 'node:timers/promises';

async function spin(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await turn();
  }
  throw new Error('timed out waiting for worker event');
}

test('reranker request timeout preserves the resident PID and drops late request IDs', {
  skip: process.platform === 'win32',
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rerank-late-'));
  const stub = join(dir, 'python');
  writeFileSync(stub, `#!${process.execPath}
const readline = require('node:readline');
console.log(JSON.stringify({ready:true}));
readline.createInterface({input:process.stdin}).on('line', line => {
  const req = JSON.parse(line);
  setTimeout(() => {
    const result = {id:req.id,scores:[req.query === 'late' ? 111 : 222]};
    console.log(JSON.stringify(result));
    if (req.query === 'late') console.log(JSON.stringify(result));
  }, req.query === 'late' ? 150 : 20);
});
`, { mode: 0o755 });
  const reranker = createReranker(stub, dir, () => {});
  t.after(() => { reranker.stop(); rmSync(dir, { recursive: true, force: true }); });
  await spin(() => reranker.health().status === 'ready');
  const pid = reranker.health().pid;
  assert.match((await reranker.rerank('late', ['doc'], 30)).header, /timeout/);
  assert.equal(reranker.health().status, 'ready', 'request timeout must not unload the model');
  assert.equal(reranker.health().pid, pid);
  const next = await reranker.rerank('next', ['doc'], 1000);
  assert.deepEqual(next, { header: 'ok', scores: [222] }, 'late and duplicate IDs cannot score the next query');
  assert.equal(reranker.health().pid, pid);
});

test('reranker warm deadline is 180 seconds and three failed loads stop spawning', {
  skip: process.platform === 'win32',
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rerank-load-'));
  const stub = join(dir, 'python');
  const loads = join(dir, 'loads');
  writeFileSync(stub, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(loads)}, 'load\\n');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reranker = createReranker(stub, dir, () => {});
  t.after(() => { reranker.stop(); t.mock.timers.reset(); rmSync(dir, { recursive: true, force: true }); });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await spin(() => {
      try { return readFileSync(loads, 'utf8').trim().split('\n').length === attempt; } catch { return false; }
    });
    t.mock.timers.tick(60_001);
    assert.equal(reranker.health().status, 'warming', 'a slow load is allowed beyond 60 seconds');
    t.mock.timers.tick(119_998);
    assert.equal(reranker.health().status, 'warming');
    t.mock.timers.tick(1);
    assert.equal(reranker.health().status, 'down');
    assert.match(reranker.health().lastError, /180/);
    await spin(() => reranker.health().pid === null);
    if (attempt < 3) t.mock.timers.tick(attempt === 1 ? 1000 : 2000);
  }
  t.mock.timers.tick(30 * 60_000);
  await turn();
  assert.equal(readFileSync(loads, 'utf8').trim().split('\n').length, 3);
  assert.equal(reranker.health().status, 'down');
  assert.equal(reranker.health().pid, null, 'no fourth load may be scheduled');
  assert.match(reranker.health().lastError, /3.*failed loads/);
});

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}
async function json(url, options) {
  const res = await fetch(url, options);
  return { status: res.status, body: await res.json(), rerank: res.headers.get('x-memory-rerank') };
}
async function until(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('timed out waiting for memoryd');
}
async function fixture(embedUrl, rerankPython = '', queryEmbedTimeoutMs = '15000', extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'memoryd-dense-'));
  const portHolder = await serve((_req, res) => res.end());
  const port = new URL(portHolder.url).port;
  await portHolder.close();
  const db = openMemoryDb(dir);
  db.close();
  const token = readFileSync(join(dir, 'memory.token'), 'utf8').trim();
  const child = spawn(process.execPath, ['scripts/memory/memoryd.mjs'], {
    env: { ...process.env, MEMORYCTL_STATE_DIR: dir, MEMORYCTL_PORT: port,
      MEMORYCTL_EMBED_URL: embedUrl || '', MEMORYCTL_EMBED_BACKLOG_URL: '', MEMORYCTL_EMBED_MODEL: 'bge-m3',
      MEMORYCTL_RERANK_PYTHON: rerankPython, MEMORYCTL_QUERY_EMBED_TIMEOUT_MS: queryEmbedTimeoutMs, ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try { await until(async () => (await json(`${base}/health`)).body.ok); }
  catch (error) { child.kill(); throw new Error(`${error.message}; ${stderr}`); }
  return {
    base, dir,
    search: (q, suffix = '') => json(`${base}/api/memory/search?q=${encodeURIComponent(q)}${suffix}`),
    write: (route, entry) => json(`${base}/api/memory/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-memory-token': token },
      body: JSON.stringify(entry),
    }),
    settled: async () => until(async () => {
      const { body } = await json(`${base}/health`);
      return body.vectors.missing === 0 && body.vectors.stale === 0 ? body : null;
    }),
    async close() {
      child.kill();
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000))]);
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

test('cosine ranks current eligible vectors, paginates before shaping, preserves FTS syntax', async () => {
  const calls = [];
  const remote = await serve(async (req, res) => {
    assert.equal(req.url, '/api/embed');
    const parts = [];
    for await (const part of req) parts.push(part);
    const { model, input } = JSON.parse(Buffer.concat(parts).toString());
    assert.equal(model, 'bge-m3');
    calls.push(...input);
    const embeddings = input.map((text) => {
      if (text === 'semantic') return [1, 0];
      if (text.startsWith('alpha') || text.startsWith('ARCHIVED') || text.startsWith('retired')) return [1, 0];
      if (text.startsWith('beta')) return [0.8, 0.6];
      return [0, 1];
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ embeddings }));
  });
  let fx;
  try {
    fx = await fixture(remote.url);
    async function add(kind, title) {
      const response = await fx.write('append', { kind, title, body: `text for ${title}` });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.id;
    }
    const alpha = await add('reference', 'alpha');
    const beta = await add('reference', 'beta');
    const gamma = await add('feedback', 'gamma');
    const dead = await add('reference', 'ARCHIVED old');
    const old = await add('reference', 'retired predecessor');
    const replaced = await fx.write('supersede', { id: old, title: 'successor', body: 'other content' });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    const report = await fx.write('append', { kind: 'report', title: 'alpha report', body: '{"role":"scout"}', session_id: 'test-attempt' });
    assert.equal(report.status, 200, JSON.stringify(report.body));
    await fx.settled();
    const ranked = await fx.search('semantic');
    assert.equal(ranked.status, 200);
    assert.deepEqual(ranked.body.map((row) => row.id), [alpha, beta, replaced.body.id, gamma]);
    assert.deepEqual(Object.keys(ranked.body[0]).sort(), ['age_days', 'date', 'id', 'kind', 'pinned', 'snippet', 'title', 'ts', 'uuid']);
    assert.deepEqual((await fx.search('semantic', '&offset=1&limit=2')).body.map((row) => row.id), [beta, replaced.body.id]);
    assert.deepEqual((await fx.search('semantic', '&kind=reference')).body.map((row) => row.id), [dead, alpha, beta, replaced.body.id]);
    assert.deepEqual((await fx.search('semantic', '&kind=feedback')).body.map((row) => row.id), [gamma]);
    const before = calls.length;
    const fts = await fx.search('alpha*');
    assert.equal(fts.status, 200);
    assert.deepEqual(fts.body.map((row) => row.id), [alpha]);
    assert.equal(calls.length, before, 'explicit FTS never calls the embedder');
    assert.equal((await fx.search('semantic', '&offset=-1')).status, 400);
  } finally { if (fx) await fx.close(); await remote.close(); }
});

test('cached text hashes invalidate on in-place edit and supersede', async () => {
  const remote = await serve(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ embeddings: [[1, 0]] }));
  });
  let fx;
  try {
    fx = await fixture(remote.url);
    const first = await fx.write('append', { kind: 'reference', title: 'alpha', body: 'original' });
    assert.equal(first.status, 200);
    await fx.settled();
    assert.deepEqual((await fx.search('semantic')).body.map((row) => row.id), [first.body.id]);
    const db = openMemoryDb(fx.dir);
    try { db.prepare('UPDATE mem_entries SET body = ? WHERE id = ?').run('edited', first.body.id); }
    finally { db.close(); }
    assert.equal((await json(`${fx.base}/health`)).body.vectors.stale, 1);
    assert.deepEqual((await fx.search('semantic')).body, [], 'old vector must not rank edited text');
    const replacement = await fx.write('supersede', { id: first.body.id, title: 'next', body: 'replacement' });
    assert.equal(replacement.status, 200);
    await fx.settled();
    assert.deepEqual((await fx.search('semantic')).body.map((row) => row.id), [replacement.body.id]);
    assert.deepEqual((await json(`${fx.base}/health`)).body.vectors, { total: 1, missing: 0, stale: 0 });
  } finally { if (fx) await fx.close(); await remote.close(); }
});

// The stub is the configured interpreter, not a replacement daemon. It only
// assigns independent per-document scores; ordering, paging and recovery belong
// to the real HTTP service. No model download is needed for protocol failures.
test('reranker HTTP contract: head only, identity precedence, stable paging and lifecycle', {
  skip: process.platform === 'win32' ? 'resident reranker installation is Mac-only' : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-rerank-stub-'));
  const stub = join(dir, 'python');
  const pidFile = join(dir, 'pid');
  const requests = join(dir, 'requests');
  const readyFile = join(dir, 'ready');
  writeFileSync(readyFile, 'go');
  writeFileSync(stub, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const warming = setInterval(() => {
  if (fs.readFileSync(${JSON.stringify(readyFile)}, 'utf8') !== 'go') return;
  clearInterval(warming);
  console.log(JSON.stringify({ready:true}));
}, 20);
let busy = false;
readline.createInterface({input:process.stdin}).on('line', line => {
  if (busy) process.exit(12);
  busy = true;
  const req = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(requests)}, line+'\\n');
  setTimeout(() => {
    console.log(JSON.stringify({id:req.id,scores:req.docs.map(doc => Number(/Rank: (\\d+)/.exec(doc)[1]))}));
    busy = false;
  }, req.query === 'timeout' ? 5500 : req.query === 'budget' ? 4500 : req.query === 'slow' ? 150 : 0);
});
`, { mode: 0o755 });
  let budgetEmbeddedAt;
  const remote = await serve(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { input } = JSON.parse(body);
    if (input[0] === 'budget') {
      await new Promise(resolve => setTimeout(resolve, 24_000));
      budgetEmbeddedAt = Date.now();
    }
    const embeddings = input.map(text => {
      const match = /^entry-(\d+)\n/.exec(text);
      return match ? [1, Number(match[1]) / 100] : [1, 0];
    });
    res.end(JSON.stringify({ embeddings }));
  });
  let fx;
  try {
    fx = await fixture(remote.url, stub, '25000');
    await until(async () => (await json(`${fx.base}/health`)).body.reranker?.status === 'ready');
    const empty = await fx.search('semantic');
    assert.equal(empty.rerank, 'ok');
    assert.deepEqual(empty.body, []);
    const ids = [];
    for (let index = 0; index < 35; index++) {
      const added = await fx.write('append', { kind: 'reference', title: `entry-${index}`,
        body: `Rank: ${index}${index === 32 || index === 33 ? ' task 2694' : ''}` });
      assert.equal(added.status, 200, JSON.stringify(added.body));
      ids.push(added.body.id);
    }
    await fx.settled();
    await until(async () => (await json(`${fx.base}/health`)).body.reranker?.status === 'ready');
    const ranked = await fx.search('semantic', '&limit=200');
    assert.equal(ranked.rerank, 'ok');
    const expected = [...ids.slice(0, 30).reverse(), ...ids.slice(30)];
    assert.deepEqual(ranked.body.map(row => row.id), expected);
    assert.deepEqual(Object.keys(ranked.body[0]).sort(), ['age_days', 'date', 'id', 'kind', 'pinned', 'snippet', 'title', 'ts', 'uuid']);
    for (const [offset, limit] of [[0, 1], [0, 20], [20, 20], [28, 5], [35, 200]]) {
      const page = await fx.search('semantic', `&offset=${offset}&limit=${limit}`);
      assert.deepEqual(page.body.map(row => row.id), expected.slice(offset, offset + limit));
    }
    const identity = await fx.search('semantic task 2694', '&limit=200');
    assert.deepEqual(identity.body.map(row => row.id),
      [ids[32], ids[33], ...ids.slice(0, 28).reverse(), ...ids.slice(28, 32), ids[34]]);
    const recorded = readFileSync(requests, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(recorded.every(req => req.docs.length === 30));
    assert.equal(recorded[0].docs[0], 'entry-0\nRank: 0', 'same text recipe as embeddings');
    const before = recorded.length;
    assert.equal((await fx.search('entry*')).rerank, null);
    assert.equal((await fx.search('semantic', '&kind=reference&limit=200')).rerank, null);
    assert.equal((await json(`${fx.base}/api/memory/search?session=absent`)).rerank, null);
    assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, before);
    const concurrent = await Promise.all([fx.search('slow'), fx.search('slow')]);
    assert.ok(concurrent.every(result => result.rerank === 'ok'), 'only one JSONL request in flight');

    const oldPid = Number(readFileSync(pidFile, 'utf8'));
    writeFileSync(readyFile, 'hold');
    process.kill(oldPid, 'SIGKILL');
    const down = await until(async () => {
      const health = (await json(`${fx.base}/health`)).body.reranker;
      return health?.status === 'down' && health;
    });
    assert.match(down.lastError, /exit|SIGKILL/);
    const degraded = await fx.search('semantic', '&limit=200');
    assert.match(degraded.rerank, /^unavailable: /);
    assert.deepEqual(degraded.body.map(row => row.id), ids);
    await until(async () => Number(readFileSync(pidFile, 'utf8')) !== oldPid);
    assert.equal((await json(`${fx.base}/health`)).body.reranker.status, 'warming');
    assert.match((await fx.search('semantic')).rerank, /^unavailable: warming/);
    writeFileSync(readyFile, 'go');
    await until(async () => (await json(`${fx.base}/health`)).body.reranker.status === 'ready');

    const started = Date.now();
    const timeoutPid = Number(readFileSync(pidFile, 'utf8'));
    const timeout = await fx.search('timeout', '&limit=200');
    assert.match(timeout.rerank, /^unavailable: .*timeout/);
    assert.deepEqual(timeout.body.map(row => row.id), ids);
    assert.ok(Date.now() - started < 7000, '5 s worker budget, not the 30 s CLI abort');
    assert.equal((await json(`${fx.base}/health`)).body.reranker.status, 'ready');
    assert.equal(Number(readFileSync(pidFile, 'utf8')), timeoutPid);
    assert.equal((await fx.search('semantic')).rerank, 'ok', 'late answer drains without a reload');
    const budget = await fx.search('budget', '&limit=200');
    assert.match(budget.rerank, /^unavailable: .*timeout/);
    assert.deepEqual(budget.body.map(row => row.id), ids);
    assert.ok(Date.now() - budgetEmbeddedAt < 4500, 'embedding time is deducted from the 28 s budget');
    assert.equal(Number(readFileSync(pidFile, 'utf8')), timeoutPid);
    await until(async () => (await json(`${fx.base}/health`)).body.reranker.status === 'ready');
    const lastPid = Number(readFileSync(pidFile, 'utf8'));
    await fx.close();
    fx = null;
    await until(() => {
      try { process.kill(lastPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
    });
  } finally {
    if (fx) await fx.close();
    await remote.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unconfigured query embedder and outage return 503; explicit FTS remains available', async () => {
  const offline = await serve((_req, res) => { res.writeHead(503); res.end('offline'); });
  let disabled;
  let down;
  try {
    disabled = await fixture('');
    const noUrl = await disabled.search('semantic');
    assert.equal(noUrl.status, 503);
    assert.match(noUrl.body.error, /bge-m3.*MEMORYCTL_EMBED_URL/);
    assert.equal((await disabled.search('alpha*')).status, 200);
    down = await fixture(offline.url);
    const failure = await down.search('semantic');
    assert.equal(failure.status, 503);
    assert.match(failure.body.error, /bge-m3.*embed HTTP 503/);
  } finally { if (disabled) await disabled.close(); if (down) await down.close(); await offline.close(); }
});

test('MEMORYCTL_RERANK=off omits the header and health says off; missing python stays unavailable', async () => {
  const remote = await serve(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ embeddings: [[1, 0]] }));
  });
  let off;
  let missing;
  try {
    off = await fixture(remote.url, '', '15000', { MEMORYCTL_RERANK: 'off' });
    const health = await json(`${off.base}/health`);
    assert.equal(health.body.reranker.status, 'off');
    assert.equal(health.body.reranker.lastError, null);
    assert.equal(health.body.reranker.pid, null);
    const added = await off.write('append', { kind: 'reference', title: 'alpha', body: 'text for alpha' });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    await off.settled();
    const searched = await off.search('semantic');
    assert.equal(searched.status, 200);
    assert.equal(searched.rerank, null, 'off must not send X-Memory-Rerank');
    assert.deepEqual(searched.body.map((row) => row.id), [added.body.id]);

    missing = await fixture(remote.url);
    const down = await json(`${missing.base}/health`);
    assert.notEqual(down.body.reranker.status, 'off');
    assert.match(down.body.reranker.lastError, /MEMORYCTL_RERANK_PYTHON is not set/);
    const row = await missing.write('append', { kind: 'reference', title: 'beta', body: 'text for beta' });
    assert.equal(row.status, 200, JSON.stringify(row.body));
    await missing.settled();
    const degraded = await missing.search('semantic');
    assert.match(degraded.rerank, /^unavailable: .*MEMORYCTL_RERANK_PYTHON/);
    assert.deepEqual(degraded.body.map((entry) => entry.id), [row.body.id]);
  } finally {
    if (off) await off.close();
    if (missing) await missing.close();
    await remote.close();
  }
});
