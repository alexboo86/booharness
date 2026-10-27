import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import '../jev-test-state.mjs';
import { createMemory, openMemoryDb } from './store.mjs';
import { serviceUrl, dbArgument, requireServiceWrite, readContradictions, readDenseLessonNeighbours } from './service-client.mjs';
import { openExistingMemoryDb, REPO_ROOT } from './lesson-lib.mjs';
import { LESSON_GATE } from './store-test-helpers.mjs';
import { gateMovedLesson } from './capture-gate.mjs';

const JEV_STUB = pathToFileURL(path.join(REPO_ROOT, 'scripts/memory/jev-fetch-stub.mjs')).href;

// A lesson row from before the capture gate (no marker, any domain): the gate
// refuses such a NEW append, so it is written routed and then rewritten in place.
async function legacyLesson(fx, data, routed) {
  const row = await fx.write('append', { ...data, links: { ...data.links, domain: routed, gate: LESSON_GATE } });
  fx.db.prepare('UPDATE mem_entries SET links = ? WHERE id = ?').run(JSON.stringify(data.links), row.id);
  return row;
}

function run(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: REPO_ROOT, env: { ...process.env, ...env }, timeout: 30000,
    });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out }));
  });
}

async function fixture({ ignoreSearchOffset = false } = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-service-client-'));
  const db = openMemoryDb(state);
  const tokenPath = path.join(state, 'memory.token');
  const memory = createMemory({ db, tokenPath });
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, 'http://localhost');
    if (ignoreSearchOffset && url.pathname === '/api/memory/search') url.searchParams.delete('offset');
    if (!memory.handle(req, res, url, body)) {
      res.writeHead(404); res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const clientState = path.join(state, 'client');
  fs.mkdirSync(clientState);
  fs.writeFileSync(path.join(clientState, 'service.url'), `${url}\n`);
  const frozen = path.join(clientState, 'memory.db');
  fs.writeFileSync(frozen, 'frozen database must never be opened');
  const env = {
    MEMORYCTL_STATE_DIR: clientState, MEMORYCTL_URL: '', MEMORYCTL_TOKEN_FILE: tokenPath,
    MEMORY_DB: frozen, MEMORYCTL_DB: frozen,
    // Lesson moves run the capture gate, which asks Jev: answered locally.
    NODE_OPTIONS: `--import ${JEV_STUB}`, TYPESAFE_API_KEY: 'fixture-key', JEV_STATE_DIR: path.join(state, 'jev'),
  };
  return {
    state, db, url, env, frozen, requests,
    async write(resource, data) {
      const response = await fetch(`${url}/api/memory/${resource}`, {
        method: 'POST', headers: { 'x-memory-token': fs.readFileSync(tokenPath, 'utf8').trim() },
        body: JSON.stringify(data),
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
      db.close();
      fs.rmSync(state, { recursive: true, force: true });
    },
  };
}

test('dense client accepts reported unchecked ids, refuses a malformed response and carries route failures', async () => {
  let reply = { neighbours: [{ id: 2, cosine: 0.9 }], skippedMalformed: [3], missingVectors: [4] };
  let status = 200;
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/memory/nearest-lessons?id=1');
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const oldUrl = process.env.MEMORYCTL_URL;
  process.env.MEMORYCTL_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await readDenseLessonNeighbours(1), reply);
    reply = { neighbours: [], skippedMalformed: [], missingVectors: 'lost' };
    await assert.rejects(readDenseLessonNeighbours(1), /invalid memoryd dense neighbours response/);
    status = 503;
    reply = { error: 'dense query vector unavailable' };
    await assert.rejects(readDenseLessonNeighbours(1), /dense unavailable for lesson 1:.*HTTP 503.*dense query vector unavailable/);
  } finally {
    if (oldUrl === undefined) delete process.env.MEMORYCTL_URL;
    else process.env.MEMORYCTL_URL = oldUrl;
    await new Promise(resolve => server.close(resolve));
  }
});

test('search client reports unavailable reranking once on stderr without changing the array body', async () => {
  let header = 'unavailable: worker timeout';
  const rows = [{ id: 7, title: 'dense result' }];
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Memory-Rerank': header });
    res.end(JSON.stringify(rows));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const env = { MEMORYCTL_URL: `http://127.0.0.1:${server.address().port}` };
    const script = pathToFileURL(path.join(REPO_ROOT, 'scripts/memory/service-client.mjs')).href;
    const call = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        `import {readMemory} from ${JSON.stringify(script)}; console.log(JSON.stringify(await readMemory('search?q=memory')));`],
      { env: { ...process.env, ...env } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => stdout += chunk);
      child.stderr.on('data', chunk => stderr += chunk);
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    const degraded = await call();
    assert.equal(degraded.code, 0, degraded.stderr);
    assert.deepEqual(JSON.parse(degraded.stdout), rows);
    assert.deepEqual(degraded.stderr.trim().split('\n'), ['[memoryctl] rerank unavailable: worker timeout']);
    header = 'ok';
    const ready = await call();
    assert.equal(ready.code, 0, ready.stderr);
    assert.deepEqual(JSON.parse(ready.stdout), rows);
    assert.equal(ready.stderr, '');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Bash search surfaces unavailable reranking on stderr and preserves JSON', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bash-header-'));
  let header = 'unavailable: worker timeout';
  const rows = [{ id: 7, title: 'dense result' }];
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Memory-Rerank': header });
    res.end(JSON.stringify(rows));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const call = () => new Promise((resolve, reject) => {
      const child = spawn('bash', [path.join(REPO_ROOT, '.claude/scripts/memoryctl'), 'search', 'memory'], {
        env: { ...process.env, MEMORYCTL_STATE_DIR: dir, MEMORYCTL_AUTOSTART: '0',
          MEMORYCTL_URL: `http://127.0.0.1:${server.address().port}` },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => stdout += chunk);
      child.stderr.on('data', chunk => stderr += chunk);
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    const unavailable = await call();
    assert.equal(unavailable.code, 0, unavailable.stderr);
    assert.deepEqual(JSON.parse(unavailable.stdout), rows);
    assert.match(unavailable.stderr.trim(), /^(?:\[memoryctl\]|memoryctl:) rerank unavailable: worker timeout$/);
    header = 'ok';
    const ready = await call();
    assert.equal(ready.code, 0, ready.stderr);
    assert.deepEqual(JSON.parse(ready.stdout), rows);
    assert.equal(ready.stderr, '');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery follows memoryctl; SQLite and mixed-store writes require explicit intent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-discovery-'));
  try {
    assert.equal(serviceUrl({ MEMORYCTL_STATE_DIR: dir }), 'http://127.0.0.1:7717');
    fs.writeFileSync(path.join(dir, 'service.url'), ' http://192.0.2.1:7717\n');
    assert.equal(serviceUrl({ MEMORYCTL_STATE_DIR: dir }), 'http://192.0.2.1:7717');
    assert.equal(serviceUrl({ MEMORYCTL_STATE_DIR: dir, MEMORYCTL_URL: 'http://192.0.2.2' }), 'http://192.0.2.2');
    assert.throws(() => openExistingMemoryDb(), /explicit --db/);
    assert.throws(() => dbArgument(['--db']), /requires a path/);
    assert.throws(() => dbArgument(['--db', '--dry']), /requires a path/);
    assert.throws(() => requireServiceWrite('/copy.db', false), /LIVE store/);
    assert.doesNotThrow(() => requireServiceWrite('/copy.db', true));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gates and tracks read the service, ignore frozen DB env, and fail on unavailable API', async () => {
  const fx = await fixture();
  try {
    const old = await legacyLesson(fx, {
      kind: 'lesson', title: 'gone anchor before NAS retirement', body: 'old',
      links: { domain: 'domain-harness', anchor: 'scripts/no-such-memory-file.mjs', status: 'active' },
    }, 'domain-platform-shell');
    await fx.write('supersede', {
      id: old.id, title: 'retired gone anchor', body: 'retired',
      links: { domain: 'domain-harness', anchor: 'scripts/no-such-memory-file.mjs', status: 'retired' },
    });
    await fx.write('append', {
      kind: 'lesson', title: 'live capture evidence', body: 'read service',
      links: { domain: 'domain-harness', anchor: 'scripts/memory/lesson-lib.mjs', status: 'inbox', gate: LESSON_GATE },
    });
    await fx.write('handoff', {
      title: 'service tracks fixture', body: 'full body', no_open_work: true,
      links: { track: 'memory-service', status: 'active', next: 'verify service' },
    });
    await fx.write('task', { title: 'fixture pending memory work', priority: 'P1', next: 'verify tracks' });
    fx.requests.length = 0;
    for (const [script, args, expected] of [
      ['scripts/check-domain-routing.mjs', [], /check-domain-routing: OK/],
      ['scripts/memory/sweep-anchors.mjs', ['--no-report'], /keep/],
      ['scripts/memory/sweep-probes.mjs', [], /swept 1 live lessons/],
      ['scripts/gen-tracks.mjs', ['--out', path.join(fx.state, 'TRACKS.md')], /1 open tail\(s\), 1 open track\(s\)/],
    ]) {
      const result = await run(script, args, fx.env);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, expected);
    }
    const tracks = fs.readFileSync(path.join(fx.state, 'TRACKS.md'), 'utf8');
    assert.match(tracks, /memory-service/);
    assert.match(tracks, /fixture pending memory work/);
    assert.ok(fx.requests.every(request => request.startsWith('GET ')), fx.requests.join('\n'));
    assert.equal(fs.readFileSync(fx.frozen, 'utf8'), 'frozen database must never be opened');

    // A service without the new route must not yield an empty, successful gate.
    const legacy = createServer((_req, res) => { res.writeHead(404); res.end('{}'); });
    legacy.listen(0, '127.0.0.1');
    await once(legacy, 'listening');
    const url = `http://127.0.0.1:${legacy.address().port}`;
    for (const script of ['scripts/check-domain-routing.mjs', 'scripts/gen-tracks.mjs']) {
      const result = await run(script, ['scripts/memory/lesson-lib.mjs'], { ...fx.env, MEMORYCTL_URL: url });
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /HTTP 404.*deploy memoryd/);
    }
    await new Promise(resolve => legacy.close(resolve));
    const down = await run('scripts/check-domain-routing.mjs', [], { ...fx.env, MEMORYCTL_URL: url });
    assert.equal(down.code, 1, down.out);
    assert.match(down.out, /memoryd unavailable.*no local DB fallback/);
  } finally { await fx.close(); }
});

test('consolidation scan and anchor sweep read only the service, preserve counts, and fail closed', async () => {
  const fx = await fixture();
  try {
    const task = await fx.write('task', { title: 'consolidation fixture tail', priority: 'P1', next: 'check scan' });
    const handoff = await fx.write('handoff', {
      title: 'consolidation fixture handoff', body: 'handoff body', tasks: [task.id],
    });
    assert.deepEqual((await (await fetch(`${fx.url}/api/memory/tasks`)).json()).tasks[0].handoffs, [handoff.id]);
    await fx.write('append', {
      kind: 'lesson', title: 'consolidation fixture lesson', body: 'lesson body',
      links: { domain: 'domain-harness', anchor: 'scripts/memory/service-client.mjs', status: 'active', gate: LESSON_GATE },
    });
    await fx.write('append', { kind: 'decision', title: 'fixture contradiction', body: 'CONTRADICTS id 123' });
    fx.requests.length = 0;
    const scan = await run('.agents/skills/consolidate-memory/scan.mjs', [], fx.env);
    assert.equal(scan.code, 0, scan.out);
    assert.match(scan.out, /tasks: 1 \(open-ish 1, closed 0\) · handoffs live: 1 · lessons live: 1/);
    assert.match(scan.out, /fixture contradiction/);
    const sweep = await run('scripts/memory/sweep-anchors.mjs', ['--no-report'], fx.env);
    assert.equal(sweep.code, 0, sweep.out);
    assert.match(sweep.out, /keep=1 drift=0 branch=0 gone=0 error=0/);
    assert.ok(fx.requests.length > 0 && fx.requests.every(req => req.startsWith('GET ')), fx.requests.join('\n'));
    assert.equal(fs.readFileSync(fx.frozen, 'utf8'), 'frozen database must never be opened');
    for (const script of ['.agents/skills/consolidate-memory/scan.mjs', 'scripts/memory/sweep-anchors.mjs']) {
      const refusal = await run(script, ['--db', fx.frozen], fx.env);
      assert.equal(refusal.code, 1, refusal.out);
      assert.match(refusal.out, /REFUSED --db/);
      const unavailable = await run(script, [], { ...fx.env, MEMORYCTL_URL: 'http://127.0.0.1:1' });
      assert.equal(unavailable.code, 1, unavailable.out);
      assert.match(unavailable.out, /memoryd unavailable.*no local DB fallback/);
    }
  } finally { await fx.close(); }
});

test('scan does not offer the latest live handoff for B1 archival when an archived copy is newer', async () => {
  const fx = await fixture();
  try {
    const live = await fx.write('handoff', {
      title: 'latest live track state', body: '<!-- track: archived-copy-regression -->', no_open_work: true,
    });
    const archived = await fx.write('handoff', {
      title: 'newer archived track copy', body: '<!-- track: archived-copy-regression -->', no_open_work: true,
    });
    const day = 86400000;
    const now = Date.now();
    fx.db.prepare('UPDATE mem_entries SET ts = ? WHERE id = ?').run(now - 30 * day, live.id);
    fx.db.prepare('UPDATE mem_entries SET ts = ?, links = ? WHERE id = ?')
      .run(now - 20 * day, JSON.stringify({ status: 'archived' }), archived.id);

    const scan = await run('.agents/skills/consolidate-memory/scan.mjs', [], fx.env);
    assert.equal(scan.code, 0, scan.out);
    const b1 = scan.out.match(/^## B1[^\n]*\n([\s\S]*?)(?=^## B2)/m)?.[1];
    assert.ok(b1, scan.out);
    assert.doesNotMatch(b1, new RegExp(`^- #${live.id}\\b`, 'm'), scan.out);
  } finally { await fx.close(); }
});

test('scan A3 lists an open task when the done-track marker contains an arrow', async () => {
  const fx = await fixture();
  try {
    const task = await fx.write('task', {
      title: 'arrow track still open', priority: 'P1', track: 'x', next: 'prove the marker',
    });
    const handoff = await fx.write('handoff', {
      title: 'arrow track declared done',
      body: '<!-- track: x | status: done | next: a -> b -->',
      no_open_work: true,
    });
    const scan = await run('.agents/skills/consolidate-memory/scan.mjs', [], fx.env);
    assert.equal(scan.code, 0, scan.out);
    const a3 = scan.out.match(/^## A3[^\n]*\n([\s\S]*?)(?=^## A4)/m)?.[1] ?? '';
    assert.match(
      a3,
      new RegExp(`^- #${task.id} трек x объявлен done в handoff #${handoff.id}\\b`, 'm'),
      scan.out,
    );
  } finally { await fx.close(); }
});

test('scan B1 age is the archiver constant and ignores --archive-days', async () => {
  const fx = await fixture();
  try {
    const day = 86400000;
    const now = Date.now();
    const covered = await fx.write('handoff', {
      title: 'covered handoff whose age the flag must not move',
      body: '<!-- track: age-fixed -->',
      no_open_work: true,
    });
    const fresh = await fx.write('handoff', {
      title: 'fresh continuation of age-fixed',
      body: '<!-- track: age-fixed -->',
      no_open_work: true,
    });
    fx.db.prepare('UPDATE mem_entries SET ts = ? WHERE id = ?').run(now - 10 * day, covered.id);
    fx.db.prepare('UPDATE mem_entries SET ts = ? WHERE id = ?').run(now - day, fresh.id);

    const loose = await run('.agents/skills/consolidate-memory/scan.mjs', ['--archive-days', '1'], fx.env);
    assert.equal(loose.code, 0, loose.out);
    assert.match(loose.out, /возраст ≥ 14 д/);
    const looseB1 = loose.out.match(/^## B1[^\n]*\n([\s\S]*?)(?=^## B2)/m)?.[1] ?? '';
    assert.doesNotMatch(looseB1, new RegExp(`^- #${covered.id}\\b`, 'm'), loose.out);
    assert.match(looseB1, new RegExp(`моложе 14 д[\\s\\S]*#${covered.id}\\b`), loose.out);

    fx.db.prepare('UPDATE mem_entries SET ts = ? WHERE id = ?').run(now - 20 * day, covered.id);
    const tight = await run('.agents/skills/consolidate-memory/scan.mjs', ['--archive-days', '30'], fx.env);
    assert.equal(tight.code, 0, tight.out);
    assert.match(tight.out, /возраст ≥ 14 д/);
    const tightB1 = tight.out.match(/^## B1[^\n]*\n([\s\S]*?)(?=^## B2)/m)?.[1] ?? '';
    assert.match(tightB1, new RegExp(`^- #${covered.id} \\[age-fixed · active\\]`, 'm'), tight.out);
  } finally { await fx.close(); }
});

test('scan keeps five D markers when service honours limit but ignores offset', async () => {
  const fx = await fixture({ ignoreSearchOffset: true });
  try {
    for (let index = 0; index < 5; index += 1) {
      await fx.write('append', {
        kind: 'decision', title: `short-page marker ${index}`, body: `CONTRADICTS id ${index + 1}`,
      });
    }
    fx.requests.length = 0;
    const scan = await run('.agents/skills/consolidate-memory/scan.mjs', [], fx.env);
    assert.equal(scan.code, 0, scan.out);
    assert.equal((scan.out.match(/^- #\d+ \[decision\] short-page marker \d$/gm) || []).length, 5, scan.out);
    assert.ok(fx.requests.some(req => req.includes('limit=200&offset=0')));
    assert.ok(fx.requests.every(req => !req.includes('offset=200')), fx.requests.join('\n'));
    assert.ok(fx.requests.every(req => req.startsWith('GET ')), fx.requests.join('\n'));
  } finally { await fx.close(); }
});

test('contradiction search pages exact markers across 200-hit boundary', async () => {
  const fx = await fixture();
  try {
    for (let index = 0; index < 202; index += 1) {
      await fx.write('append', {
        kind: 'decision', title: `fixture marker ${index}`, body: `CONTRADICTS id ${index + 1} unique ${index}`,
      });
    }
    await fx.write('append', {
      kind: 'decision', title: 'glued non-marker', body: 'prefixCONTRADICTS id 9999',
    });
    const previous = process.env.MEMORYCTL_URL;
    process.env.MEMORYCTL_URL = fx.url;
    try {
      fx.requests.length = 0;
      const rows = await readContradictions();
      assert.equal(rows.length, 202);
      assert.ok(rows.every(row => row.title !== 'glued non-marker'));
      assert.ok(fx.requests.some(req => req.includes('offset=200')));
      assert.ok(fx.requests.every(req => !req.includes('offset=400')), 'short second page needs no third request');
      assert.ok(fx.requests.every(req => req.startsWith('GET ')), fx.requests.join('\n'));
    } finally {
      if (previous === undefined) delete process.env.MEMORYCTL_URL;
      else process.env.MEMORYCTL_URL = previous;
    }
  } finally { await fx.close(); }
});

test('anchor sweep publishes the same shaped CAS registry entry through the fixture service', async () => {
  const fx = await fixture();
  try {
    await fx.write('append', {
      kind: 'lesson', title: 'fixture anchor', body: 'fixture body',
      links: { domain: 'domain-harness', anchor: 'scripts/memory/service-client.mjs', status: 'active', gate: LESSON_GATE },
    });
    fx.requests.length = 0;
    for (const version of [1, 2]) {
      const result = await run('scripts/memory/sweep-anchors.mjs', [], fx.env);
      assert.equal(result.code, 0, result.out);
      const response = await fetch(`${fx.url}/api/memory/registry?key=anchor-sweep-latest`);
      const registry = await response.json();
      assert.equal(registry.version, version);
      assert.match(registry.body, /^# anchor-sweep-latest\n\n- ts: .*\n- keep: 1\n- drift: 0\n- branch: 0\n- gone: 0\n- error: 0\n$/);
    }
    assert.deepEqual(fx.requests.filter(req => req.startsWith('POST ')), [
      'POST /api/memory/registry', 'POST /api/memory/registry',
    ]);
    const missing = await run('scripts/memory/sweep-anchors.mjs', [], {
      ...fx.env, MEMORYCTL_TOKEN_FILE: path.join(fx.state, 'missing.token'),
    });
    assert.equal(missing.code, 1, missing.out);
    assert.match(missing.out, /memoryd registry token unavailable.*ENOENT.*no local DB fallback/);
    assert.equal(fx.requests.filter(req => req.startsWith('POST ')).length, 2);
  } finally { await fx.close(); }
});

test('domain migration dry-run leaves the fixture intact and --apply supersedes via the fixture service', async () => {
  const fx = await fixture();
  try {
    const links = {
      domain: 'domain-platform-shell', anchor: 'scripts/test-lessons-compaction.mjs:withHook',
      status: 'active', globs: ['scripts/test-domain-lessons-hook.mjs'], trigger: 'fixture trigger',
    };
    const original = await legacyLesson(fx, {
      kind: 'lesson', title: 'migration fixture', body: '- rule: body kept exactly\n- why: fixture\n- evidence: fixture', links,
    }, 'domain-harness');
    const dry = await run('scripts/memory/migrate-lesson-domains.mjs', [], fx.env);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /1 lesson\(s\) would move \(dry-run\)/);
    assert.equal(fx.db.prepare('SELECT superseded_by FROM mem_entries WHERE id = ?').get(original.id).superseded_by, null);
    const apply = await run('scripts/memory/migrate-lesson-domains.mjs', ['--apply'], fx.env);
    assert.equal(apply.code, 0, apply.out);
    assert.match(apply.out, /1 moved, 0 failed of 1 candidate/);
    const nextId = fx.db.prepare('SELECT superseded_by FROM mem_entries WHERE id = ?').get(original.id).superseded_by;
    assert.ok(nextId);
    const next = fx.db.prepare('SELECT title, body, links FROM mem_entries WHERE id = ?').get(nextId);
    assert.equal(next.title, 'migration fixture');
    assert.equal(next.body, '- rule: body kept exactly\n- why: fixture\n- evidence: fixture');
    const { gate, ...moved } = JSON.parse(next.links);
    assert.deepEqual(moved, { ...links, domain: 'domain-harness' });
    assert.equal(gate.v, 1, 'the domain move went through the capture gate');
    const again = await run('scripts/memory/migrate-lesson-domains.mjs', [], fx.env);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /0 lesson\(s\) would move/);
  } finally { await fx.close(); }
});

test('a re-anchor onto a misrouted file is refused and the lesson stays where it is', async () => {
  const fx = await fixture();
  try {
    const links = { domain: 'domain-platform-shell', anchor: 'README.md', status: 'active', gate: LESSON_GATE };
    const row = await fx.write('append', {
      kind: 'lesson', title: 'misroute fixture', body: '- rule: misroute fixture rule\n- why: fixture\n- evidence: fixture', links,
    });
    const target = 'scripts/memory/lesson-lib.mjs';
    const cli = await run('scripts/memory/reanchor-lesson.mjs', ['--id', String(row.id), '--to', target], fx.env);
    assert.equal(cli.code, 1, cli.out);
    assert.match(cli.out, /routes to domain-harness but the lesson is filed under domain-platform-shell/);
    // The capture gate itself refuses the same move, before any write.
    assert.throws(() => gateMovedLesson({ id: row.id, title: 'misroute fixture', body: '- rule: r\n- why: w\n- evidence: e' },
      { ...links, anchor: target }), /anchor routes to domain-harness; use that domain instead of domain-platform-shell/);
    assert.equal(fx.db.prepare('SELECT superseded_by FROM mem_entries WHERE id = ?').get(row.id).superseded_by, null);
  } finally { await fx.close(); }
});

test('lesson mutation CLIs read and write the same fixture service; --db refuses before HTTP', async () => {
  const fx = await fixture();
  try {
    const lesson = async (title, links = {}) => fx.write('append', {
      kind: 'lesson', title, body: `- rule: ${title} rule\n- why: fixture\n- evidence: fixture`,
      links: { domain: 'domain-harness', anchor: 'scripts/memory/lesson-lib.mjs', status: 'inbox', gate: LESSON_GATE, ...links },
    });
    const retired = await lesson('retire fixture');
    const promoted = await lesson('promote fixture');
    const moved = await lesson('reanchor fixture');
    const normalized = await legacyLesson(fx, {
      kind: 'lesson', title: 'normalize fixture', body: '- rule: normalize fixture rule\n- why: fixture\n- evidence: fixture',
      links: { domain: 'harness', anchor: 'scripts/memory/lesson-lib.mjs', status: 'inbox' },
    }, 'domain-harness');
    for (const [script, args, expected] of [
      ['retire-lesson', ['--id', String(retired.id), '--reason', 'fixture'], /retire: 1 of 1/],
      ['promote-lesson', ['--id', String(promoted.id)], /promoted/],
      ['reanchor-lesson', ['--id', String(moved.id), '--to', 'scripts/memory/service-client.mjs'], /reanchor: 1 moved/],
      ['normalize-lesson-domains', [], /moved/],
      ['sweep-anchors', [], /keep/],
    ]) {
      const result = await run(`scripts/memory/${script}.mjs`, args, fx.env);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, expected);
    }
    for (const id of [retired.id, promoted.id, moved.id, normalized.id]) {
      assert.ok(fx.db.prepare('SELECT superseded_by FROM mem_entries WHERE id = ?').get(id).superseded_by);
    }
    // Both moves went through the capture gate: fresh marker, status kept.
    for (const [id, anchor, domain] of [[moved.id, 'scripts/memory/service-client.mjs', 'domain-harness'], [normalized.id, 'scripts/memory/lesson-lib.mjs', 'domain-harness']]) {
      const next = JSON.parse(fx.db.prepare('SELECT links FROM mem_entries WHERE id = (SELECT superseded_by FROM mem_entries WHERE id = ?)').get(id).links);
      assert.equal(next.anchor, anchor);
      assert.equal(next.domain, domain);
      assert.equal(next.status, 'inbox');
      assert.equal(next.gate.v, 1);
      assert.notEqual(next.gate.at, LESSON_GATE.at);
    }
    const before = fx.requests.length;
    for (const [script, args] of [
      ['retire-lesson', ['--id', '1', '--reason', 'fixture']],
      ['promote-lesson', ['--all']],
      ['reanchor-lesson', ['--id', '1', '--to', 'scripts/memory/lesson-lib.mjs']],
      ['normalize-lesson-domains', []], ['sweep-anchors', []],
    ]) {
      const result = await run(`scripts/memory/${script}.mjs`, [...args, '--db', fx.frozen], fx.env);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /REFUSED --db/);
    }
    const importer = await run('scripts/memory/import-lessons.mjs', [], fx.env);
    assert.equal(importer.code, 1, importer.out);
    assert.match(importer.out, /explicit --db/);
    assert.equal(fx.requests.length, before, 'refusal must precede all service requests');
    assert.equal(fs.readFileSync(fx.frozen, 'utf8'), 'frozen database must never be opened');
  } finally { await fx.close(); }
});
