// node --test — no caller may read memoryd's 503 "query embedder unavailable"
// as "no results" (build slice B2c, decision #12123). With dense ranking a
// plain-text search has no fallback: the CLI must exit non-zero with the
// embedder error on stderr, the MCP tool must answer an error result carrying
// the 503 text, and update-tools' search step must abort before any write.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openMemoryDb } from './store.mjs';
import { findLiveEntryId } from '../../ops/update-tools.mjs';

const CLI = fileURLToPath(new URL('../../.claude/scripts/memoryctl', import.meta.url));
const MCP_SERVER = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}
async function until(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('timed out waiting for memoryd');
}

/// memoryd with NO query embedder configured: plain search is a 503.
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'memoryd-no-embedder-'));
  const portHolder = await serve((_req, res) => res.end());
  const port = new URL(portHolder.url).port;
  await portHolder.close();
  const db = openMemoryDb(dir);
  db.close();
  const child = spawn(process.execPath, ['scripts/memory/memoryd.mjs'], {
    env: { ...process.env, MEMORYCTL_STATE_DIR: dir, MEMORYCTL_PORT: port,
      MEMORYCTL_EMBED_URL: '', MEMORYCTL_EMBED_BACKLOG_URL: '', MEMORYCTL_EMBED_MODEL: 'bge-m3' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try { await until(async () => (await (await fetch(`${base}/health`)).json()).ok); }
  catch (error) { child.kill(); throw new Error(`${error.message}; ${stderr}`); }
  return {
    base,
    async close() {
      child.kill();
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000))]);
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

/// Minimal stdio MCP client, same shape as mcp-server.test.mjs.
function mcpClient(env) {
  const home = mkdtempSync(join(tmpdir(), 'memory-mcp-noembed-'));
  const child = spawn(process.execPath, [MCP_SERVER], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...env, HOME: home, MEMORYCTL_STATE_DIR: home,
      MEMORYCTL_TOKEN_FILE: join(home, 'memory.token') },
  });
  const answers = new Map();
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    answers.set(message.id, message);
    const resolve = waiting.get(message.id);
    if (resolve) { waiting.delete(message.id); resolve(message); }
  });
  let nextId = 1;
  return {
    ask(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      if (answers.has(id)) return Promise.resolve(answers.get(id));
      return new Promise((resolve, reject) => {
        waiting.set(id, resolve);
        setTimeout(() => reject(new Error(`timeout on ${method}`)), 15000).unref();
      });
    },
    close() {
      child.stdin.end();
      child.kill();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('a 503 from the embedder-less search is an error on every caller route', async (t) => {
  const fx = await fixture();
  const previousUrl = process.env.MEMORYCTL_URL;
  process.env.MEMORYCTL_URL = fx.base;
  try {
    // The service itself answers 503 and names the embedder.
    const direct = await fetch(`${fx.base}/api/memory/search?q=${encodeURIComponent('semantic')}`);
    assert.equal(direct.status, 503);
    const directBody = await direct.json();
    assert.match(directBody.error, /query embedder bge-m3 unavailable: MEMORYCTL_EMBED_URL/);

    await t.test('memoryctl CLI search exits non-zero with the embedder error, never an empty list', () => {
      const r = spawnSync('bash', [CLI, 'search', 'semantic'], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, MEMORYCTL_URL: fx.base },
      });
      assert.notEqual(r.status, 0, `expected non-zero exit, got ${r.status}; stdout=${r.stdout}`);
      assert.match(r.stderr, /query embedder bge-m3 unavailable: MEMORYCTL_EMBED_URL/);
      assert.match(r.stderr, /HTTP 503/);
      assert.equal(r.stdout.trim(), '', 'stdout must not carry a result list');
    });

    await t.test('MCP search is an error result carrying the 503 text', async () => {
      const mcp = mcpClient({ MEMORYCTL_URL: fx.base });
      try {
        await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0' } });
        const answer = await mcp.ask('tools/call', {
          name: 'memory', arguments: { action: 'search', args: { query: 'semantic' } },
        });
        const result = answer.result;
        assert.equal(result.isError, true, JSON.stringify(result));
        assert.match(result.content[0].text, /HTTP 503/);
        assert.match(result.content[0].text, /query embedder bge-m3 unavailable: MEMORYCTL_EMBED_URL/);
      } finally { mcp.close(); }
    });

    await t.test('update-tools search step aborts loudly before any write', () => {
      assert.throws(() => findLiveEntryId(), /refusing to write on an unknown store state/);
      assert.throws(() => findLiveEntryId(), /query embedder bge-m3 unavailable: MEMORYCTL_EMBED_URL/);
    });
  } finally {
    if (previousUrl === undefined) delete process.env.MEMORYCTL_URL;
    else process.env.MEMORYCTL_URL = previousUrl;
    await fx.close();
  }
});
