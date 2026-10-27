// node --test — the protocol contract of the memory MCP server.
//
// Two things are worth a test here and the rest is the memory service's own
// business: that the tool surface stays ONE tool (it is re-sent every turn of
// every session that enables this server), and that nothing the caller does
// can turn a memory problem into a broken session.
import '../jev-test-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { renderLessons } from './mcp-server.mjs';

const SERVER = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));

/// A minimal stdio client: spawn, speak JSON-RPC, collect answers by id.
function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'memory-mcp-home-'));
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...env, HOME: home, MEMORYCTL_STATE_DIR: home,
      MEMORYCTL_TOKEN_FILE: env.MEMORYCTL_TOKEN_FILE || join(home, 'memory.token') },
  });
  const answers = new Map();
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    answers.set(message.id, message);
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    }
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

test('handshake answers, and the surface stays exactly one tool', async () => {
  const mcp = client();
  try {
    const init = await mcp.ask('initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'contract-test', version: '0' },
      capabilities: {},
    });
    assert.equal(init.result.serverInfo.name, 'memoryctl');
    // The client's version is echoed: refusing a revision this server did not
    // anticipate would cost reach for nothing, since it speaks a shared subset.
    assert.equal(init.result.protocolVersion, '2025-06-18');

    const list = await mcp.ask('tools/list', {});
    assert.equal(list.result.tools.length, 1, 'one tool: a schema is paid on EVERY turn');
    const tool = list.result.tools[0];
    assert.equal(tool.name, 'memory');
    assert.ok(tool.inputSchema.properties.action.enum.includes('lessons'));
    assert.ok(tool.inputSchema.properties.action.enum.includes('handoff'));
    // A budget, not a style rule: eight separate tools would cost several times
    // this, permanently, in every session that enables the server.
    assert.ok(
      JSON.stringify(tool).length < 3000,
      `tool schema is ${JSON.stringify(tool).length} bytes — keep the surface small`,
    );
  } finally {
    mcp.close();
  }
});

test('a bad call is a TOOL error, never a protocol error', async () => {
  const mcp = client();
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });

    const unknown = await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'nope' } });
    assert.equal(unknown.error, undefined, 'must not fail the JSON-RPC call');
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.result.content[0].text, /unknown action/);

    const noPath = await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'lessons' } });
    assert.equal(noPath.result.isError, true);
    assert.match(noPath.result.content[0].text, /path/, 'the refusal must name what is missing');
  } finally {
    mcp.close();
  }
});

test('decision append posts directly: no candidate search, no Jev (#12433)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-mcp-'));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, 'test-token');
  const requests = [];
  const bodies = [];
  const service = await fakeService(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(raw);
    res.setHeader('content-type', 'application/json');
    res.end('{"id":99}');
  });
  const mcp = client({ MEMORYCTL_URL: service.url, MEMORYCTL_TOKEN_FILE: tokenFile });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    const answer = await mcp.ask('tools/call', {
      name: 'memory', arguments: { action: 'append', args: { kind: 'decision', title: 'New decision', body: 'Same topic', overturns: [42] } },
    });
    assert.equal(answer.result.isError, undefined);
    assert.doesNotMatch(answer.result.content[0].text, /Jev/);
    assert.deepEqual(requests, ['POST /api/memory/append']);
    assert.deepEqual(JSON.parse(bodies[0]).overturns, [42]);
  } finally { mcp.close(); await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('MCP new-lesson append refuses before contacting a memory service; supersede remains available', async () => {
  let requests = 0;
  const service = await fakeService((req, res) => { requests++; res.end('{}'); });
  const mcp = client({ MEMORYCTL_URL: service.url, TYPESAFE_API_KEY: '' });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    const body = '- trigger: When writing\n- rule: Refuse ungated writes\n- why: Prevents bad lessons\n- evidence: #12333';
    const answer = await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'append', args: { kind: 'lesson', title: 'X', body } } });
    assert.equal(answer.result.isError, true);
    assert.match(answer.result.content[0].text, /lesson append refused: use scripts\/memory\/capture-lesson\.mjs/);
    assert.equal(requests, 0);
  } finally { mcp.close(); await service.close(); }
});

test('lesson supersede checks the old kind and refuses before POST', async () => {
  let posts = 0;
  const service = await fakeService((req, res) => {
    if (req.method === 'POST') posts++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 7, kind: 'lesson', title: 'Old', body: '- rule: old\n- why: old\n- evidence: old' }));
  });
  const mcp = client({ MEMORYCTL_URL: service.url, TYPESAFE_API_KEY: '' });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    const body = `## X\n- rule: ${'x'.repeat(301)}\n- why: Y\n- evidence: Z`;
    const answer = await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'supersede', args: { id: 7, title: 'X', body } } });
    assert.match(answer.result.content[0].text, /rule: 301 chars \/ 300; --long reason required/);
    assert.equal(posts, 0);
  } finally { mcp.close(); await service.close(); }
});

test('MCP lesson writes use shared trigger/evidence refusals before POST', async (t) => {
  let posts = 0;
  const tokenDir = mkdtempSync(join(tmpdir(), 'lesson-field-token-'));
  const tokenFile = join(tokenDir, 'token');
  writeFileSync(tokenFile, 'test-token');
  const legacy = '- rule: Old rule\n- why: Old reason\n- evidence: historical prose';
  const service = await fakeService((req, res) => {
    if (req.method === 'POST') posts++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 7, kind: 'lesson', title: 'Old', body: legacy }));
  });
  const mcp = client({ MEMORYCTL_URL: service.url, MEMORYCTL_TOKEN_FILE: tokenFile });
  try {
    for (const [trigger, evidence, message] of [
      ['', 'ABC1234', '--trigger is required'],
      ['?', 'ABC1234', '--trigger is required'],
      ['When writing', 'prose only', '--evidence carries none'],
      ['When writing', 'git, status', '--evidence carries none'],
      ['When writing', 'node;rm file', '--evidence carries none'],
      ['When writing', 'mentions node in prose', '--evidence carries none'],
      ['When writing', 'node', '--evidence carries none'],
    ]) {
      for (const action of ['append', 'supersede']) {
        await t.test(`${action}: ${JSON.stringify(trigger)} / ${evidence}`, async () => {
          const body = action === 'append'
            ? `- trigger: ${trigger}\n- rule: Check writes\n- why: Prevents bad lessons\n- evidence: ${evidence}`
            : trigger === '' || trigger === '?'
              ? `${legacy}\n- trigger: ${trigger || '?'}`
              : legacy.replace('historical prose', evidence);
          const answer = await mcp.ask('tools/call', { name: 'memory', arguments: { action,
            args: { id: 7, kind: 'lesson', title: 'Old', body } } });
          assert.equal(answer.result.isError, true);
          assert.ok(answer.result.content[0].text.includes(message), answer.result.content[0].text);
          assert.equal(posts, 0, 'invalid fields must refuse before POST');
        });
      }
    }
  } finally { mcp.close(); await service.close(); rmSync(tokenDir, { recursive: true, force: true }); }
});

test('MCP supersede preserves legacy length and stores --long on a changed field', async () => {
  const tokenDir = mkdtempSync(join(tmpdir(), 'lesson-mcp-token-'));
  const tokenFile = join(tokenDir, 'token');
  writeFileSync(tokenFile, 'test-token');
  const legacy = '- rule: ' + 'R'.repeat(520) + '\n- why: Y\n- evidence: Z';
  const sent = [];
  const service = await fakeService(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify({ id: 7, kind: 'lesson', title: 'X', body: legacy }));
    const chunks = [];
    for await (const part of req) chunks.push(part);
    sent.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.end(JSON.stringify({ id: 8 }));
  });
  const mcp = client({ MEMORYCTL_URL: service.url, MEMORYCTL_TOKEN_FILE: tokenFile, TYPESAFE_API_KEY: '' });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    const invoke = args => mcp.ask('tools/call', { name: 'memory', arguments: { action: 'supersede', args: { id: 7, title: 'X', ...args } } });
    const unchanged = await invoke({ body: legacy, links: { status: 'active' }, long: 'not needed' });
    assert.equal(unchanged.result.isError, undefined);
    assert.equal(sent[0].body, legacy);
    const changed = await invoke({ body: legacy.replace('- why: Y', '- why: Revised'), links: { status: 'active' }, long: 'Why detail is necessary' });
    assert.equal(changed.result.isError, undefined);
    assert.equal(sent.length, 2);
    assert.match(sent[1].body, /- long: "Why detail is necessary"/);
    assert.match(sent[1].body, /- rule: R{520}/);
    const retired = await invoke({ title: 'RETIRED: obsolete — X', body: `${legacy}\n- retired: obsolete`, links: { status: 'retired' } });
    assert.equal(retired.result.isError, undefined);
    assert.equal(sent.length, 3);
    const duplicate = await invoke({ title: 'RETIRED: obsolete — X', body: `${legacy}\n- rule: ${'S'.repeat(900)}`, links: { status: 'retired' } });
    assert.equal(duplicate.result.isError, true);
    assert.match(duplicate.result.content[0].text, /rule is duplicated/);
    const changedRule = await invoke({ title: 'RETIRED: obsolete — X', body: legacy.replace('R'.repeat(520), 'S'.repeat(900)), links: { status: 'retired' } });
    assert.equal(changedRule.result.isError, true);
    assert.match(changedRule.result.content[0].text, /rule: 900 chars \/ 300/);
    assert.equal(sent.length, 3);
  } finally { mcp.close(); await service.close(); rmSync(tokenDir, { recursive: true, force: true }); }
});

test('a dead memory service degrades to an error string, never a hang or a crash', async () => {
  // Memory must never block the actual work. Port 1 has nothing listening.
  const mcp = client({ MEMORYCTL_URL: 'http://127.0.0.1:1' });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    const answer = await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'hot' } });
    assert.equal(answer.error, undefined);
    assert.equal(answer.result.isError, true);
    assert.ok(answer.result.content[0].text.length > 0, 'the failure must say something');

    // ...and the server is still alive for the next call.
    const list = await mcp.ask('tools/list', {});
    assert.equal(list.result.tools.length, 1);
  } finally {
    mcp.close();
  }
});

/// A stand-in memory service, so the tests can produce the failures a real one
/// only produces on a bad day. Every reviewer that found a hole here used a
/// probe like this; the suite that missed them used none.
async function fakeService(handler) {
  const { createServer } = await import('node:http');
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('a service that accepts and then goes quiet times out instead of hanging the session', async () => {
  // The failure three reviewers reproduced: single-writer SQLite gets stuck, the
  // socket stays open, `fetch` waits forever, and because this server is SERIAL
  // every later call waits behind it. ECONNREFUSED never exercised this path.
  const service = await fakeService(() => { /* accept, answer never */ });
  const mcp = client({ MEMORYCTL_URL: service.url, MEMORYCTL_TIMEOUT_MS: '700' });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    const stuck = await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'hot' } });
    assert.equal(stuck.result.isError, true);
    assert.match(stuck.result.content[0].text, /stuck|did not answer/i);
    assert.match(stuck.result.content[0].text, /nothing was written/, 'say what did NOT happen');

    // Head-of-line: the NEXT call must still be served.
    const after = await mcp.ask('tools/list', {});
    assert.equal(after.result.tools.length, 1);
  } finally {
    mcp.close();
    await service.close();
  }
});

test('task_list sends no status filter unless asked, matching the CLI', async () => {
  const seen = [];
  const service = await fakeService((request, response) => {
    seen.push(request.url);
    response.setHeader('content-type', 'application/json');
    response.end('{"tasks":[]}');
  });
  const mcp = client({ MEMORYCTL_URL: service.url });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'task_list' } });
    assert.ok(!seen[0].includes('status='), `default must not filter, got ${seen[0]}`);

    await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'task_list', args: { status: 'open' } } });
    assert.ok(seen[1].includes('status=open'), `explicit status must pass through, got ${seen[1]}`);
  } finally {
    mcp.close();
    await service.close();
  }
});


test('task_create passes a domain through to the store, and omits it when the caller gives none', async () => {
  // The board files a task under a routing id through this action. The store
  // judges the id, so the contract here is delivery: set, clear, and absent
  // must reach the wire as three different things.
  const bodies = [];
  const service = await fakeService(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    bodies.push(JSON.parse(raw || '{}'));
    response.setHeader('content-type', 'application/json');
    response.end('{"id":1}');
  });
  const tokenDir = mkdtempSync(join(tmpdir(), 'task-mcp-token-'));
  const tokenFile = join(tokenDir, 'token');
  writeFileSync(tokenFile, 'test-token');
  const mcp = client({ MEMORYCTL_URL: service.url, MEMORYCTL_TOKEN_FILE: tokenFile });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'task_create', args: { title: 'filed tail', priority: 'P1', domain: 'domain-harness' } } });
    assert.equal(bodies[0].domain, 'domain-harness');
    await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'task_create', args: { title: 'cleared tail', priority: 'P1', domain: null } } });
    assert.equal(bodies[1].domain, null);
    await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'task_create', args: { title: 'plain tail', priority: 'P1' } } });
    assert.equal('domain' in bodies[2], false, 'no domain must reach the wire as absent, never as a clear');
  } finally {
    mcp.close();
    await service.close();
    rmSync(tokenDir, { recursive: true, force: true });
  }
});
test('a malformed lessons envelope is an error, not lessons', async () => {
  // Returning the corrupt body as a SUCCESSFUL result was the worse half: the
  // caller would have read it as lessons and acted on it. The CLI exits 1.
  const service = await fakeService((_request, response) => response.end('{not-json'));
  const mcp = client({ MEMORYCTL_URL: service.url });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    const answer = await mcp.ask('tools/call', {
      name: 'memory',
      arguments: { action: 'lessons', args: { path: 'scripts/memory/store.mjs' } },
    });
    assert.equal(answer.result.isError, true);
    assert.match(answer.result.content[0].text, /invalid lessons JSON/);
  } finally {
    mcp.close();
    await service.close();
  }
});

test('get reaches a whole entry, and follow rides along', async () => {
  // Until this action existed, an MCP-only runtime could not read one entry.
  // `search` answers with a 24-token snippet and `hot` with a line apiece, so
  // "read handoff 90" — the thing a member is told to do at session start — had
  // no answer on the route that is the ONLY memory route grok and glm have.
  const seen = [];
  const service = await fakeService((request, response) => {
    seen.push(request.url);
    response.setHeader('content-type', 'application/json');
    response.end('{"id":40,"body":"the whole thing"}');
  });
  const mcp = client({ MEMORYCTL_URL: service.url });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });

    const plain = await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'get', args: { id: 40 } } });
    assert.equal(plain.result.isError, undefined);
    assert.equal(seen[0], '/api/memory/entry?id=40', 'no follow unless asked');
    assert.match(plain.result.content[0].text, /the whole thing/);

    await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'get', args: { id: 12, follow: 'latest' } } });
    assert.equal(seen[1], '/api/memory/entry?id=12&follow=latest');

    // a uuid is the other legal ref, and must not be sent as an id
    await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'get', args: { uuid: 'abc-1' } } });
    assert.equal(seen[2], '/api/memory/entry?uuid=abc-1');

    const empty = await mcp.ask('tools/call', { name: 'memory', arguments: { action: 'get' } });
    assert.equal(empty.result.isError, true);
    assert.match(empty.result.content[0].text, /id/, 'the refusal must name what is missing');
  } finally {
    mcp.close();
    await service.close();
  }
});

test('a report over an UNBOUND MCP route is refused before anything is written', async () => {
  // Task 396, measured in the store 2026-08-12: six codex-seat reports sit under
  // `mcp-<pid>` sessions (ids 2149, 2152, 2365, 2404, 2419, 2437) because the
  // runtime did not pass MEMORYCTL_SESSION_ID to this server - each one filed,
  // answered with an id, and invisible to the attempt read-back that is the
  // whole point of the report channel. An invisible success is worse than a
  // refusal: the refusal reaches the member while it still has the context to
  // take the CLI route, so the refusal must name that route verbatim.
  let requests = 0;
  const service = await fakeService((_request, response) => {
    requests += 1;
    response.end('{"id":1,"uuid":"u","dedup":false}');
  });
  // Blank both session sources explicitly: under a Svod member this test
  // process INHERITS MEMORYCTL_SESSION_ID, which is exactly the binding the
  // unbound case must not have.
  const mcp = client({ MEMORYCTL_URL: service.url, MEMORYCTL_SESSION_ID: '', CLAUDE_SESSION_ID: '' });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    const answer = await mcp.ask('tools/call', {
      name: 'memory',
      arguments: { action: 'append', args: { kind: 'report', title: 'review', body: '{"verdict":"APPROVE"}' } },
    });
    assert.equal(answer.error, undefined, 'a refusal is a TOOL error, never a protocol error');
    assert.equal(answer.result.isError, true, 'an unbound report must not succeed silently');
    const text = answer.result.content[0].text;
    assert.match(text, /MEMORYCTL_SESSION_ID/, 'the refusal must name the missing binding');
    assert.match(text, /memoryctl append --kind report/, 'and the CLI route that DOES carry it');
    assert.equal(requests, 0, 'refused before the store saw anything - no orphan row');
  } finally {
    mcp.close();
    await service.close();
  }
});

test('a BOUND report delivery answers by naming the delivery, so no second route is sought', async () => {
  // Task 396, measured 2026-08-10: a glm member filed through this tool
  // (success, id returned), read its contract's "do not substitute an MCP" as
  // "that did not count", and spent nine more calls pushing the identical
  // report through the CLI. The id was in the answer; what was missing was the
  // sentence saying the delivery is DONE and a repeat is a second report.
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tokenFile = join(mkdtempSync(join(tmpdir(), 'mcp-token-')), 'memory.token');
  writeFileSync(tokenFile, 'test-token');

  const bodies = [];
  let answerId = 0;
  const service = await fakeService((request, response) => {
    let data = '';
    request.on('data', (chunk) => (data += chunk));
    request.on('end', () => {
      bodies.push(JSON.parse(data));
      answerId += 1;
      // First delivery is new, the repeat of the same bytes is a dedup - the
      // two answers the real service gives, and each must SAY what happened.
      response.setHeader('content-type', 'application/json');
      response.end(answerId === 1
        ? '{"id":77,"uuid":"u","dedup":false}'
        : '{"id":77,"uuid":"u","dedup":true}');
    });
  });
  const mcp = client({
    MEMORYCTL_URL: service.url,
    MEMORYCTL_SESSION_ID: 'attempt-1',
    MEMORYCTL_AGENT_ID: 'run-1',
    MEMORYCTL_TOKEN_FILE: tokenFile,
  });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    const call = () => mcp.ask('tools/call', {
      name: 'memory',
      arguments: { action: 'append', args: { kind: 'report', title: 'review', body: '{"verdict":"APPROVE"}' } },
    });
    const delivered = await call();
    assert.equal(delivered.result.isError, undefined, `bound delivery must succeed: ${delivered.result.content[0].text}`);
    assert.match(delivered.result.content[0].text, /IS the delivery/, 'success must NAME the delivery');
    assert.match(delivered.result.content[0].text, /77/, 'and carry the id the contract tells the member to keep');
    assert.match(delivered.result.content[0].text, /do NOT re-deliver/i, 'and forbid the second route outright');
    assert.equal(bodies[0].session_id, 'attempt-1', 'filed under the attempt Svod reads back');

    const repeat = await call();
    assert.equal(repeat.result.isError, undefined);
    assert.match(repeat.result.content[0].text, /ALREADY DELIVERED/, 'a dedup must read as "already counted", not as a new success');
  } finally {
    mcp.close();
    await service.close();
  }
});

test('an unbound NON-report append is not gated', async () => {
  // The gate exists because a REPORT is read back by attempt session; a
  // decision or a handoff has no such reader, and gating it would break the
  // operator's own MCP sessions, which run unbound by design.
  const requests = [];
  const service = await fakeService((request, response) => {
    requests.push(request.method);
    response.setHeader('content-type', 'application/json');
    response.end('{"id":5,"uuid":"u","dedup":false}');
  });
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tokenFile = join(mkdtempSync(join(tmpdir(), 'mcp-token-')), 'memory.token');
  writeFileSync(tokenFile, 'test-token');
  const mcp = client({
    MEMORYCTL_URL: service.url,
    MEMORYCTL_SESSION_ID: '',
    CLAUDE_SESSION_ID: '',
    MEMORYCTL_TOKEN_FILE: tokenFile,
  });
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    const answer = await mcp.ask('tools/call', {
      name: 'memory',
      arguments: { action: 'append', args: { kind: 'decision', title: 't', body: 'b' } },
    });
    assert.equal(answer.result.isError, undefined, `non-report kinds must pass through: ${answer.result.content[0].text}`);
    assert.deepEqual(requests, ['POST']);
  } finally {
    mcp.close();
    await service.close();
  }
});

test('an unknown tool name is refused without taking the server down', async () => {
  const mcp = client();
  try {
    await mcp.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't' }, capabilities: {} });
    const answer = await mcp.ask('tools/call', { name: 'not-ours', arguments: {} });
    assert.ok(answer.error, 'an unknown TOOL is a protocol-level argument error');
    const list = await mcp.ask('tools/list', {});
    assert.equal(list.result.tools.length, 1);
  } finally {
    mcp.close();
  }
});

// ---------------------------------------------------------------------------
// The renderer decides WHICH emptiness a reader is told about, and there are
// three of them. The third one used to be silent: the marker that states a loss
// was pushed only inside the non-empty branch, so a caller whose every matching
// rule was too big to send read "no lessons" - "nothing is known" - while the
// JSON it was rendering carried `omitted > 0`, which means "known, did not fit".
// Found by the glm seat of round harness-memory-r2, in BOTH renderers.
test('the renderer tells the three emptinesses apart', () => {
  const nothingKnown = renderLessons(JSON.stringify({
    domain: 'domain-harness', items: [], omitted: 0, domain_active: 0,
  }));
  assert.match(nothingKnown, /no lessons for domain domain-harness/);
  assert.doesNotMatch(nothingKnown, /omitted/);

  const nothingAnchored = renderLessons(JSON.stringify({
    domain: 'domain-harness', items: [], omitted: 0, domain_active: 145,
  }));
  assert.match(nothingAnchored, /no lesson is anchored to this path/);
  assert.match(nothingAnchored, /holds 145 active lesson\(s\)/);

  const knownButTooBig = renderLessons(JSON.stringify({
    domain: 'domain-harness', items: [], omitted: 3, domain_active: 145,
  }));
  assert.match(knownButTooBig, /3 lesson\(s\) match this path/);
  assert.match(knownButTooBig, /did not fit/);
  assert.match(
    knownButTooBig, /<!-- omitted: 3 -->/,
    'and the machine-readable marker rides along, exactly as it does when items are delivered',
  );
  assert.doesNotMatch(
    knownButTooBig, /no lessons/,
    'never the sentence that means nothing is known',
  );
});

test('a delivered answer still carries its omitted marker', () => {
  const rendered = renderLessons(JSON.stringify({
    domain: 'domain-harness',
    items: [{ title: 'one', anchor: 'a.rs:x', rule: 'r', match: 'anchor' }],
    omitted: 2,
  }));
  assert.match(rendered, /## one/);
  assert.match(rendered, /<!-- omitted: 2 -->/);
});

// A server launched through a SYMLINK must still be the program.
//
// The guard that keeps `import` from starting the read loop compares
// `process.argv[1]` with `import.meta.url`, and only one of those is resolved
// through symlinks. Compared unresolved, a symlinked launch made the two differ:
// the process started, printed nothing and waited on a stdin it never read - a
// silent MCP server, which a client cannot tell from a slow one. Named by the
// glm seat of round `harness-tails-r1`; nothing spawns it that way today, which
// is why this is written before it is needed.
test('a server spawned through a symlink still answers', async () => {
  const { mkdtempSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mcp-symlink-'));
  const link = join(dir, 'linked-server.mjs');
  try {
    symlinkSync(SERVER, link);
    const child = spawn(process.execPath, [link], { stdio: ['pipe', 'pipe', 'ignore'] });
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('a symlinked launch answered nothing')), 15000);
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.trim()) return;
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    const reply = await answered;
    assert.equal(reply.id, 1);
    assert.ok(reply.result && reply.result.serverInfo, JSON.stringify(reply));
    child.kill();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
