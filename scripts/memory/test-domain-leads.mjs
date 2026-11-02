import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// No existing test exercises this CLI's persistence and session/generation boundary.
const cli = fileURLToPath(new URL('./domain-leads.mjs', import.meta.url));
const key = 'domain-native-leads-v1';
const native = { handle: 'lead-one', nativeClient: 'Native Workbench', evidence: 'operator observed native app', session: 'session-1', generation: 1 };

test('CLI preserves assignments, refuses unsafe writes and resolves exact bindings without chat mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'domain-leads-'));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, 'fixture-token');
  let version = 0;
  let body = null;
  let posts = 0;
  let mode = 'ok';
  let handles = [{ handle: native.handle, session: native.session, generation: 1,
    bound_at: '2026-01-01T00:00:00.000Z', ended_at: null, desktop: null }];
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === `/api/memory/registry?key=${key}`) {
      res.end(JSON.stringify({ key, version, body }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/chat?after=9007199254740991&limit=1') {
      if (mode === 'oversized') {
        res.write(JSON.stringify({ posts: [], handles, watchers: 0 }).slice(0, -1) + ',"padding":"');
        res.write('x'.repeat(1_000_001));
        res.end('"}');
        return;
      }
      res.end(JSON.stringify(mode === 'lan' ? { handles: [], readOnly: false, canRelease: false }
        : { posts: [], handles, watchers: 0 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/memory/registry') {
      posts++;
      assert.equal(req.headers['x-memory-token'], 'fixture-token');
      let source = '';
      for await (const chunk of req) source += chunk;
      const input = JSON.parse(source);
      assert.equal(input.key, key);
      if (mode === 'conflict' || input.expected_version !== version) {
        res.writeHead(409); res.end('{}'); return;
      }
      body = input.body;
      version++;
      if (mode === 'disconnect') { req.socket.destroy(); return; }
      res.end(JSON.stringify({ version }));
      return;
    }
    res.writeHead(500); res.end('{"error":"unexpected route"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  async function run(args, missingToken = false) {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, MEMORYCTL_URL: endpoint,
      MEMORYCTL_TOKEN_FILE: missingToken ? join(dir, 'absent') : tokenFile } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    const output = code === 0 ? stdout : stderr;
    const result = JSON.parse(output.slice(output.indexOf('{')));
    return { code, ...result };
  }
  const assign = (domain, expected = version) => ['assign', domain, '--handle', native.handle, '--native-client', native.nativeClient,
    '--evidence', native.evidence, '--session', native.session, '--generation', '1', '--orch-url', endpoint, '--expected-version', String(expected)];
  const resolve = domain => run(['resolve', domain, '--orch-url', endpoint]);
  try {
    assert.equal((await run(['list'], true)).version, 0);
    assert.equal((await resolve('domain-harness')).status, 'unassigned');
    assert.equal((await run(assign('domain-harness'), true)).status, 'refused');
    assert.equal(posts, 0);
    assert.equal((await run(assign('domain-harness'))).status, 'written');
    assert.equal((await run(assign('domain-charts'))).code, 1); // Unknown domains cannot be introduced.
    // A second active domain must preserve the first, across separate CLI processes.
    assert.equal((await run(assign('domain-screener'))).status, 'written');
    const saved = JSON.parse(body);
    assert.deepEqual(saved.assignments['domain-harness'], native);
    assert.deepEqual(saved.assignments['domain-screener'], native);
    assert.equal((await resolve('domain-harness')).status, 'bound');
    assert.equal((await resolve('domain-harness')).running, 'unknown');
    const safeBody = body;
    const safeVersion = version;
    const safePosts = posts;
    handles[0].desktop = 'Pi coding agent';
    assert.equal((await resolve('domain-harness')).status, 'stale');
    const piDesktop = await run(assign('domain-harness'));
    assert.equal(piDesktop.status, 'refused');
    assert.match(piDesktop.error, /binding is stale/);
    assert.equal(posts, safePosts);
    assert.equal(body, safeBody);
    assert.equal(version, safeVersion);
    handles[0].desktop = null;
    const nonlocal = assign('domain-harness');
    nonlocal[nonlocal.indexOf('--orch-url') + 1] = `http://example.invalid:${server.address().port}`;
    const beforeNonlocal = requests.length;
    const refusedUrl = await run(nonlocal);
    assert.equal(refusedUrl.status, 'refused');
    assert.match(refusedUrl.error, /only a local loopback HTTP origin/);
    assert.deepEqual(requests.slice(beforeNonlocal), [`GET /api/memory/registry?key=${key}`]);
    assert.equal(posts, safePosts);
    assert.equal(body, safeBody);
    body = safeBody + ' '.repeat(60_001); // Valid JSON: refusal must come from the byte cap.
    const oversizedBody = body;
    const beforeBodyCap = requests.length;
    const refusedBody = await run(assign('domain-harness'));
    assert.equal(refusedBody.status, 'refused');
    assert.match(refusedBody.error, /invalid registry body size/);
    assert.deepEqual(requests.slice(beforeBodyCap), [`GET /api/memory/registry?key=${key}`]);
    assert.equal(posts, safePosts);
    assert.equal(body, oversizedBody);
    assert.equal(version, safeVersion);
    body = safeBody;
    mode = 'oversized';
    const refusedStream = await run(assign('domain-harness'));
    assert.equal(refusedStream.status, 'refused');
    assert.match(refusedStream.error, /binding response too large/);
    assert.equal(posts, safePosts);
    assert.equal(body, safeBody);
    assert.equal(version, safeVersion);
    mode = 'ok';
    handles[0].generation = 2;
    assert.equal((await resolve('domain-harness')).status, 'stale');
    handles[0].generation = 1; handles[0].session = 'successor';
    assert.equal((await resolve('domain-harness')).status, 'stale');
    handles[0].session = native.session; handles[0].ended_at = '2026-01-01';
    assert.equal((await resolve('domain-harness')).status, 'offline');
    handles = [];
    assert.equal((await resolve('domain-harness')).status, 'offline');
    const before = posts;
    assert.equal((await run(assign('domain-harness'))).status, 'refused');
    assert.equal(posts, before);
    handles = [{ handle: native.handle, session: native.session, generation: 1, ended_at: null, desktop: 'Native Workbench' }];
    mode = 'lan';
    assert.equal((await resolve('domain-harness')).status, 'refused');
    assert.equal((await run(assign('domain-harness'))).status, 'refused');
    assert.equal(posts, before);
    mode = 'ok';
    const pi = assign('domain-harness'); pi[pi.indexOf('--native-client') + 1] = 'Pi coding agent';
    assert.equal((await run(pi)).status, 'refused');
    const noVersion = assign('domain-harness'); noVersion.splice(noVersion.indexOf('--expected-version'), 2);
    assert.equal((await run(noVersion)).status, 'refused');
    assert.equal((await run(assign('domain-harness', 0))).status, 'conflict');
    mode = 'conflict';
    assert.equal((await run(assign('domain-harness'))).status, 'conflict');
    assert.equal(posts, before + 1); // No automatic overwrite/retry on 409.
    mode = 'disconnect';
    assert.equal((await run(assign('domain-harness'))).status, 'unknown');
    assert.equal(posts, before + 2); // A committed write with a lost reply is not retried.
    mode = 'ok';
    const orphaned = JSON.parse(body);
    orphaned.assignments['domain-native-desktop'] = native;
    orphaned.assignments['domain-future-unknown'] = native;
    body = JSON.stringify(orphaned); version++;
    const listing = await run(['list'], true);
    assert.equal(listing.assignments.find(row => row.domain === 'domain-native-desktop').orphaned, true);
    assert.equal(listing.assignments.find(row => row.domain === 'domain-future-unknown').orphaned, true);
    assert.equal((await run(['unassign', 'domain-native-desktop', '--expected-version', String(version)])).status, 'written');
    assert.equal((await run(['unassign', 'domain-future-unknown', '--expected-version', String(version)])).status, 'written');
    assert.deepEqual(JSON.parse(body).assignments, saved.assignments);
    assert.equal((await run(['unassign', 'domain-harness', '--expected-version', String(version)])).status, 'written');
    assert.deepEqual(JSON.parse(body).assignments, { 'domain-screener': native });
    const intact = body;
    body = '{"schema":1,"assignments":{},"surprise":true}';
    assert.equal((await run(['list'])).status, 'refused');
    assert.equal((await run(assign('domain-harness'))).status, 'refused');
    assert.equal(body, '{"schema":1,"assignments":{},"surprise":true}');
    body = intact;
    assert.ok(requests.every(request => request.startsWith('GET /api/') || request === 'POST /api/memory/registry'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
