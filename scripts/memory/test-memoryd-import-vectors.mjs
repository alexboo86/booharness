import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { entryTextSha } from './embed-recipe.mjs';
import { openMemoryDb } from './store.mjs';

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
async function json(url, options) {
  const res = await fetch(url, options);
  return { status: res.status, body: await res.json() };
}
async function until(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('timed out waiting for memoryd');
}
function vec(values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
  return bytes;
}

// The query embedder answers only the dimension probe and the query: the backlog
// worker fails on every entry, so any vector search sees came from the import.
async function queryOnlyEmbedder() {
  return serve(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const { input } = JSON.parse(Buffer.concat(parts).toString());
    if (!input.every((text) => text === 'dimension probe' || text === 'semantic')) {
      res.writeHead(500); res.end('entries are not embedded here'); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ embeddings: input.map(() => [1, 0]) }));
  });
}

async function fixture(embedUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'memoryd-import-'));
  const holder = await serve((_req, res) => res.end());
  const port = new URL(holder.url).port;
  await holder.close();
  openMemoryDb(dir).close();
  const token = readFileSync(join(dir, 'memory.token'), 'utf8').trim();
  const child = spawn(process.execPath, ['scripts/memory/memoryd.mjs'], {
    env: { ...process.env, MEMORYCTL_STATE_DIR: dir, MEMORYCTL_PORT: port,
      MEMORYCTL_EMBED_URL: embedUrl, MEMORYCTL_EMBED_BACKLOG_URL: '', MEMORYCTL_EMBED_MODEL: 'bge-m3' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try { await until(async () => (await json(`${base}/health`)).body.ok); }
  catch (error) { child.kill(); throw new Error(`${error.message}; ${stderr}`); }
  const post = (route, payload, key = token) => json(`${base}/api/memory/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'x-memory-token': key }) },
    body: JSON.stringify(payload),
  });
  return {
    base, dir, token, post,
    search: (q) => json(`${base}/api/memory/search?q=${encodeURIComponent(q)}`),
    async close() {
      child.kill();
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000))]);
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

test('import route stores current vectors, rejects stale/model/dims/token, and search uses them', async () => {
  const remote = await queryOnlyEmbedder();
  let fx;
  try {
    fx = await fixture(remote.url);
    const add = async (title) => {
      const response = await fx.post('append', { kind: 'reference', title, body: `text for ${title}` });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return { id: response.body.id, sha: entryTextSha({ title, body: `text for ${title}` }) };
    };
    const alpha = await add('alpha');
    const beta = await add('beta');
    const gamma = await add('gamma');
    const item = (entry, values, extra = {}) => ({ entry_id: entry.id, model: 'bge-m3', text_sha: entry.sha, vec: vec(values).toString('base64'), ...extra });

    assert.equal((await fx.post('vectors/import', { vectors: [item(alpha, [1, 0])] }, null)).status, 401);
    assert.equal((await fx.post('vectors/import', { vectors: [item(alpha, [1, 0])] }, 'f'.repeat(64))).status, 401);
    assert.equal((await fx.post('vectors/import', { vectors: [] })).status, 400);

    const result = await fx.post('vectors/import', { vectors: [
      item(alpha, [0.6, 0.8]),
      item(beta, [1, 0]),
      item(gamma, [1, 0], { text_sha: entryTextSha({ title: 'gamma', body: 'yesterday' }) }),
      item(gamma, [1, 0], { model: 'qwen3-embedding:0.6b' }),
      item(gamma, [1, 0, 0]),
      item(gamma, [3, 4]),
      item({ id: 999999, sha: gamma.sha }, [1, 0]),
    ] });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.imported, 2);
    assert.deepEqual(result.body.rejected.map((row) => row.reason), ['stale', 'model', 'dims', 'invalid', 'missing']);

    const ranked = await fx.search('semantic');
    assert.equal(ranked.status, 200, JSON.stringify(ranked.body));
    assert.deepEqual(ranked.body.map((row) => row.id), [beta.id, alpha.id], 'gamma has no vector; beta outranks alpha');

    const health = (await json(`${fx.base}/health`)).body.vectors;
    assert.deepEqual(health, { total: 3, missing: 1, stale: 0 });
  } finally { if (fx) await fx.close(); await remote.close(); }
});

test('import-vectors.mjs posts a cache against its source snapshot and reports stale separately', async () => {
  const remote = await queryOnlyEmbedder();
  const work = mkdtempSync(join(tmpdir(), 'import-vectors-'));
  let fx;
  try {
    fx = await fixture(remote.url);
    const titles = ['one', 'two', 'three', 'four'];
    for (const title of titles) assert.equal((await fx.post('append', { kind: 'reference', title, body: `body ${title}` })).status, 200);
    // The cache snapshot predates an edit of "three"; "four" was superseded since.
    const four = await fx.search('four*');
    assert.equal((await fx.post('supersede', { id: four.body[0].id, title: 'four v2', body: 'new body' })).status, 200);
    const sourceDir = join(work, 'source');
    mkdirSync(sourceDir);
    const source = new DatabaseSync(join(sourceDir, 'memory.db'));
    source.exec('CREATE TABLE mem_entries(id INTEGER PRIMARY KEY, title TEXT, body TEXT, superseded_by INTEGER)');
    titles.forEach((title, i) => source.prepare('INSERT INTO mem_entries VALUES (?, ?, ?, NULL)')
      .run(i + 1, title, title === 'three' ? 'older body' : `body ${title}`));
    source.close();
    writeFileSync(join(sourceDir, 'source-manifest.json'), JSON.stringify({ snapshotAt: 'T0', counts: { mem_entries: 4 } }));
    const cache = join(work, 'cache');
    mkdirSync(cache);
    writeFileSync(join(cache, 'entries.f32'), Buffer.concat([[1, 0], [0.6, 0.8], [1, 0], [1, 0]].map(vec)));
    writeFileSync(join(cache, 'progress.json'), JSON.stringify({ ids: [1, 2, 3, 4] }));
    writeFileSync(join(cache, 'metadata.json'), JSON.stringify({ formatVersion: 3, model: 'bge-m3', documentPrefix: '',
      snapshotAt: 'T0', total: 4, live: 4, dimension: 2, entriesFile: 'entries.f32', idsFile: 'progress.json' }));
    const tokenFile = join(fx.dir, 'memory.token');
    const run = (sourceDb) => promisify(execFile)(process.execPath, ['scripts/memory/import-vectors.mjs',
      '--cache', cache, '--source', sourceDb, '--url', fx.base, '--token-file', tokenFile]);
    const { stdout } = await run(join(sourceDir, 'memory.db'));
    const stats = JSON.parse(stdout);
    assert.deepEqual({ imported: stats.imported, stale: stats.rejectedStale, other: stats.rejectedOther, reasons: stats.rejectedByReason },
      { imported: 2, stale: 1, other: 1, reasons: { stale: 1, missing: 1 } });
    assert.deepEqual((await fx.search('semantic')).body.map((row) => row.title), ['one', 'two']);

    writeFileSync(join(sourceDir, 'source-manifest.json'), JSON.stringify({ snapshotAt: 'T1', counts: { mem_entries: 4 } }));
    await assert.rejects(run(join(sourceDir, 'memory.db')), /source snapshot T1 is not cache snapshot T0/);
  } finally {
    if (fx) await fx.close();
    await remote.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test('a queued id made current by an import is skipped by the backlog worker, not re-embedded', async () => {
  const calls = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const remote = await serve(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const { input } = JSON.parse(Buffer.concat(parts).toString());
    calls.push(...input);
    // The worker's first entry stays in flight until the import below has landed.
    if (input.some((text) => text.startsWith('alpha'))) await held;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ embeddings: input.map(() => [1, 0]) }));
  });
  let fx;
  try {
    fx = await fixture(remote.url);
    const add = async (title) => {
      const response = await fx.post('append', { kind: 'reference', title, body: `text for ${title}` });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return { id: response.body.id, sha: entryTextSha({ title, body: `text for ${title}` }) };
    };
    await add('alpha');
    await until(() => calls.some((text) => text.startsWith('alpha')));
    const beta = await add('beta');
    const gamma = await add('gamma');
    const imported = await fx.post('vectors/import', { vectors: [beta, gamma].map((entry) => (
      { entry_id: entry.id, model: 'bge-m3', text_sha: entry.sha, vec: vec([0, 1]).toString('base64') })) });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.imported, 2);
    release();
    // Queue order is alpha, beta, gamma, delta: once delta is embedded, beta and gamma were dequeued.
    await add('delta');
    await until(() => calls.some((text) => text.startsWith('delta')));
    await until(async () => (await json(`${fx.base}/health`)).body.vectors.missing === 0);
    assert.deepEqual(calls.filter((text) => /^(beta|gamma)/.test(text)), [], 'imported entries were re-embedded');
    const ranked = await fx.search('semantic');
    assert.deepEqual(ranked.body.slice(-2).map((row) => row.id).sort(), [beta.id, gamma.id].sort(), 'imported vectors were not overwritten');
  } finally { release(); if (fx) await fx.close(); await remote.close(); }
});
