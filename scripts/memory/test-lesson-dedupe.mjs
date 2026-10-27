import '../jev-test-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { candidates, readDenseThreshold, readLedger, record, run } from './lesson-dedupe.mjs';

const anchor = 'scripts/memory/store.mjs:rule';
function lesson(id, rule, links = {}, ts = 0) {
  return { id, title: `Rule ${rule}`, body: `- rule: ${rule}`, status: 'active', ts,
    linksObj: { anchor, domain: 'domain-harness', ...links } };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-dedupe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'ledger.jsonl');
}

const rule = 'Always inspect the exact changed path before applying a memory lesson';
const model = 'qwen3-embedding:0.6b';
const readModel = async () => model;
const denseResult = (neighbours = [], skippedMalformed = [], missingVectors = []) =>
  ({ neighbours, skippedMalformed, missingVectors });

test('CLI selects the served model fit and refuses unknown, invalid or changing models', async (t) => {
  const file = fixture(t);
  let models;
  let healthStatus = 200;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.statusCode = healthStatus;
      res.end(JSON.stringify({ embedder: { model: models.length > 1 ? models.shift() : models[0] } }));
    } else if (req.url?.startsWith('/api/memory/entries?')) {
      res.end(JSON.stringify([1, 2].map(id => ({
        id, title: `Lesson ${id}`, body: id === 1 ? '- rule: Apples' : '- rule: Oranges',
        kind: 'lesson', superseded_by: null, ts: Date.now(),
        links: JSON.stringify({ domain: 'domain-harness', anchor }),
      }))));
    } else res.end(JSON.stringify(denseResult([{ id: 1, cosine: 0.72 }])));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const scenario of [
    { models: ['qwen3-embedding:0.6b'], pairs: 0 },
    { models: ['bge-m3'], error: /dense threshold unavailable.*bge-m3/ },
    { models: ['unfitted-model'], error: /dense threshold unavailable.*unfitted-model/ },
    { models: [undefined], error: /invalid memoryd embedding model/ },
    { models: ['qwen3-embedding:0.6b'], status: 503, error: /health.*HTTP 503/ },
    { models: ['qwen3-embedding:0.6b', 'changed-model'], error: /embedding model changed/ },
  ]) {
    models = [...scenario.models];
    healthStatus = scenario.status ?? 200;
    const child = spawn(process.execPath, ['scripts/memory/lesson-dedupe.mjs', 'candidates', '--json'], {
      env: { ...process.env, MEMORYCTL_URL: `http://127.0.0.1:${server.address().port}`,
        MEMORYCTL_EMBED_MODEL: 'bge-m3', LESSON_DEDUPE_LEDGER: file },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, scenario.error ? 1 : 0, stderr);
    if (scenario.error) {
      assert.match(stderr, scenario.error);
      assert.equal(stdout, '');
    } else assert.equal(JSON.parse(stdout).pairs.length, scenario.pairs);
  }
});

test('fit CLI scores only selected same-model pairs and leaves DB and ledger unchanged', (t) => {
  const ledger = fixture(t);
  const dbPath = path.join(path.dirname(ledger), 'vectors.db');
  const output = path.join(path.dirname(ledger), 'fit.json');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE mem_vectors(entry_id INTEGER PRIMARY KEY, model TEXT, dims INTEGER, vec BLOB)');
  const insert = db.prepare('INSERT INTO mem_vectors VALUES (?, ?, 2, ?)');
  for (const [id, model, vector] of [
    [1, 'qwen3-embedding:0.6b', [1, 0]], [2, 'qwen3-embedding:0.6b', [4, 3]],
    [3, 'qwen3-embedding:0.6b', [0, 1]], [4, 'bge-m3', [1, 0]], [5, 'bge-m3', [1, 0]],
  ]) {
    const bytes = Buffer.alloc(8);
    vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
    insert.run(id, model, bytes);
  }
  db.close();
  for (const [newer, older, verdict] of [[2, 1, 'duplicate'], [3, 1, 'distinct'],
    [4, 1, 'distinct'], [5, 4, 'duplicate'], [6, 1, 'distinct']]) record({ newer, older, verdict }, ledger);
  const beforeDb = fs.readFileSync(dbPath);
  const beforeLedger = fs.readFileSync(ledger);
  const result = spawnSync(process.execPath, ['scripts/memory/fit-lesson-dedupe.mjs',
    '--model', 'qwen3-embedding:0.6b', '--db', dbPath, '--ledger', ledger, '--output', output],
  { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const fit = JSON.parse(fs.readFileSync(output, 'utf8')).models['qwen3-embedding:0.6b'];
  assert.equal(fit.threshold, 0.75);
  assert.deepEqual(fit.counts, { ledgerPairs: 5, scored: 2, missingVectors: 1, otherModel: 2,
    duplicate: 1, distinct: 1 });
  assert.deepEqual(fit.table.map(row => [row.threshold, row.duplicatesKept, row.distinctPassing]),
    [[0.697, 1, 0], [0.75, 1, 0], [0.8, 1, 0]]);
  assert.match(fit.date, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(fs.readFileSync(dbPath), beforeDb);
  assert.deepEqual(fs.readFileSync(ledger), beforeLedger);
});

test('link candidates include ids, titles, anchors, domains and source', () => {
  const pairs = candidates([lesson(1, rule), lesson(2, 'Different rule', { possibleDuplicateOf: [1] })]);
  assert.deepEqual(pairs.map(p => [p.newer, p.older, p.sources]), [[2, 1, ['possibleDuplicateOf']]]);
  assert.equal(pairs[0].olderAnchor, anchor);
  assert.equal(pairs[0].newerDomain, 'domain-harness');
  assert.equal(pairs[0].olderTitle, `Rule ${rule}`);
});

test('link and lexical match make one pair with both sources; lexical orientation follows ids', () => {
  const rows = [lesson(9, rule, { possibleDuplicateOf: [2] }), lesson(2, rule)];
  assert.deepEqual(candidates(rows).map(p => [p.newer, p.older, p.sources]),
    [[9, 2, ['possibleDuplicateOf', 'lexical']]]);
  assert.deepEqual(candidates([lesson(2, rule), lesson(9, rule)])[0].sources, ['lexical']);
});

test('self-link is noted and skipped; forward active links orient by ID without losing other pairs', () => {
  const notes = [];
  const rows = [
    lesson(2, 'Unique rule for lesson two', { possibleDuplicateOf: [2, 9, 999, 'not-an-id'] }),
    lesson(9, 'Different rule for lesson nine'),
    lesson(11, 'Another unrelated rule', { possibleDuplicateOf: [9] }),
  ];
  const pairs = candidates(rows, [], note => notes.push(note));
  assert.deepEqual(pairs.map(p => [p.newer, p.older, p.sources]), [
    [9, 2, ['possibleDuplicateOf']],
    [11, 9, ['possibleDuplicateOf']],
  ]);
  assert.deepEqual(notes, ['lesson-dedupe: skipping self-link for lesson 2']);
});

test('malformed link array is skipped without hiding unrelated candidates', () => {
  const notes = [];
  const rows = [lesson(2, 'First unrelated rule', { possibleDuplicateOf: 'broken' }),
    lesson(9, 'Second unrelated rule', { possibleDuplicateOf: [2] })];
  assert.deepEqual(candidates(rows, [], note => notes.push(note)).map(p => [p.newer, p.older]), [[9, 2]]);
  assert.deepEqual(notes, ['lesson-dedupe: skipping malformed possibleDuplicateOf on lesson 2']);
});

test('ledger hides adjudicated pairs; retired and missing links are excluded', (t) => {
  const file = fixture(t);
  record({ newer: 9, older: 2, verdict: 'distinct', note: 'Different scope' }, file);
  const active = [lesson(2, rule), lesson(9, rule, { possibleDuplicateOf: [2, 1] })];
  assert.deepEqual(candidates(active, readLedger(file)), []);
  assert.deepEqual(candidates([lesson(9, rule, { possibleDuplicateOf: [2] })]), []);
  const retired = { ...lesson(2, rule), status: 'retired' };
  assert.deepEqual(candidates([retired, lesson(9, rule, { possibleDuplicateOf: [2] })]), []);
  assert.deepEqual(candidates([lesson(2, rule), { ...lesson(9, rule, { possibleDuplicateOf: [2] }), status: 'retired' }]), []);
});

test('read failure rejects run; CLI memoryd outage exits nonzero and names reason', async (t) => {
  const file = fixture(t);
  await assert.rejects(run(['candidates'], { file, read: async () => { throw new Error('memoryd unavailable: test outage'); } }), /memoryd unavailable: test outage/);
  const result = spawnSync(process.execPath, ['scripts/memory/lesson-dedupe.mjs', 'candidates', '--json'], {
    env: { ...process.env, MEMORYCTL_URL: 'http://127.0.0.1:1', LESSON_DEDUPE_LEDGER: file }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /memoryd unavailable/);
  assert.doesNotMatch(result.stdout, /\[\]/);
});

test('record validates ids, orientation and verdict, appends JSONL, refuses repeated pairs', (t) => {
  const file = fixture(t);
  for (const row of [
    { newer: 'x', older: 1, verdict: 'duplicate' },
    { newer: 2, older: 0, verdict: 'duplicate' },
    { newer: 1, older: 2, verdict: 'duplicate' },
    { newer: 2, older: 1, verdict: 'unknown' },
  ]) assert.throws(() => record(row, file));
  assert.equal(fs.existsSync(file), false);
  record({ newer: 2, older: 1, verdict: 'duplicate' }, file);
  assert.equal(readLedger(file)[0].verdict, 'duplicate');
  assert.throws(() => record({ newer: 2, older: 1, verdict: 'distinct' }, file), /already recorded/);
  assert.equal(readLedger(file).length, 1);
});

test('CLI options emit JSON candidates and append a record via override', async (t) => {
  const file = fixture(t);
  const output = [];
  await run(['candidates', '--json'], {
    file, read: async () => [lesson(1, rule), lesson(2, rule, { possibleDuplicateOf: [1] })],
    output: line => output.push(line),
  });
  assert.deepEqual(JSON.parse(output[0]).pairs[0].sources, ['possibleDuplicateOf', 'lexical']);
  assert.deepEqual(JSON.parse(output[0]).unchecked, { skippedMalformed: [], missingVectors: [] });
  await run(['record', '--newer', '2', '--older', '1', '--verdict', 'duplicate', '--note', 'merged'], { file, output: () => {} });
  assert.equal(readLedger(file)[0].note, 'merged');
  await assert.rejects(run(['record', '--newer', '2', '--older', '1', '--verdict', 'distinct'], { file }), /already recorded/);
});

test('dense includes incomplete and recent lessons, honors measured threshold and domain, merges source tags', async (t) => {
  const file = fixture(t);
  const now = Date.parse('2026-09-26T12:00:00Z');
  const rows = [lesson(1, 'First unique rule'), lesson(2, 'Second unique rule', { duplicateCheck: 'incomplete' }),
    lesson(3, 'Third unique rule', {}, now - 1000),
    lesson(4, 'Fourth unique rule', { domain: 'domain-other' }),
    lesson(5, 'Fifth unique rule')];
  const calls = [];
  const threshold = readDenseThreshold(model);
  const neighbours = async id => {
    calls.push(id);
    return denseResult(id === 2 ? [{ id: 1, cosine: threshold }, { id: 4, cosine: 1 },
      { id: 5, cosine: threshold - 0.0001 }] : [{ id: 1, cosine: threshold + 0.01 }]);
  };
  const pairs = await run(['candidates', '--since', '2026-09-25'], { file, read: async () => rows,
    neighbours, readModel, now: () => now, output: () => {} });
  assert.deepEqual(calls, [2, 3]);
  assert.deepEqual(pairs.filter(p => p.sources.includes('dense')).map(p => [p.newer, p.older]), [[2, 1], [3, 1]]);
  assert.ok(pairs.every(p => p.newer !== 4 || !p.sources.includes('dense')));
  assert.ok(pairs.every(p => p.newer !== 5 || !p.sources.includes('dense')));
  rows[1].linksObj.possibleDuplicateOf = [1];
  assert.deepEqual((await run(['candidates', '--json'], { file, read: async () => rows, neighbours, readModel,
    now: () => now, output: () => {} }))[0].sources, ['possibleDuplicateOf', 'lexical', 'dense']);
  record({ newer: 2, older: 1, verdict: 'distinct' }, file);
  assert.deepEqual((await run(['candidates', '--since', '2026-09-25'], { file, read: async () => rows,
    neighbours, readModel, now: () => now, output: () => {} })).filter(p => p.sources.includes('dense')).map(p => p.newer), [3]);
});

test('dense route failure rejects instead of returning a partial candidate queue', async (t) => {
  const file = fixture(t);
  await assert.rejects(run(['candidates'], { file, readModel, read: async () => [lesson(2, rule, { duplicateCheck: 'incomplete' })],
    neighbours: async () => { throw new Error('dense unavailable: HTTP 503'); } }), /dense unavailable: HTTP 503/);
  const result = spawnSync(process.execPath, ['scripts/memory/lesson-dedupe.mjs', 'candidates', '--since', '2026-09-01'], {
    env: { ...process.env, MEMORYCTL_URL: 'http://127.0.0.1:1', LESSON_DEDUPE_LEDGER: file }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /memoryd unavailable/);
});

test('CLI names dense HTTP failure and exits nonzero without a partial JSON queue', async (t) => {
  const file = fixture(t);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({ embedder: { model } })); return; }
    if (req.url?.startsWith('/api/memory/entries?')) res.end(JSON.stringify([{
      id: 42, title: 'Fresh', body: '- rule: Fresh', kind: 'lesson', superseded_by: null,
      ts: Date.now(), links: JSON.stringify({ domain: 'domain-harness', anchor }),
    }]));
    else { res.statusCode = 503; res.end(JSON.stringify({ error: 'dense unavailable: test failure' })); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const child = spawn(process.execPath, ['scripts/memory/lesson-dedupe.mjs', 'candidates', '--json'], {
      env: { ...process.env, MEMORYCTL_URL: `http://127.0.0.1:${server.address().port}`,
        LESSON_DEDUPE_LEDGER: file },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 1, stderr);
    assert.match(stderr, /nearest-lessons.*HTTP 503.*dense unavailable/);
    assert.equal(stdout, '');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('CLI skips superseded lesson reads but preserves other failures', async (t) => {
  const file = fixture(t);
  let scenario;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.statusCode = scenario.healthStatus ?? 200;
      res.end(JSON.stringify({ embedder: { model } }));
    } else if (req.url?.startsWith('/api/memory/entries?')) {
      res.statusCode = scenario.entriesStatus ?? 200;
      res.end(JSON.stringify([1, 2, 3].map(id => ({
        id, title: `Lesson ${id}`, body: `- rule: ${['Apples', 'Oranges', 'Pears'][id - 1]}`,
        kind: 'lesson', superseded_by: null, ts: id === 1 ? 0 : Date.now(),
        links: JSON.stringify({ domain: 'domain-harness', anchor, ...(id === 3 ? { possibleDuplicateOf: [1] } : {}) }),
      }))));
    } else if (req.url === '/api/memory/nearest-lessons?id=3') {
      res.statusCode = scenario.lessonStatus ?? 404;
      res.end(scenario.badJson ? '{' : JSON.stringify({ error: scenario.routeMissing
        ? 'route not found' : 'active lesson 3 not found' }));
    } else res.end(JSON.stringify(denseResult([{ id: 1, cosine: 1 }, { id: 3, cosine: 1 }])));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const entry of [
    { name: 'lesson 404 keeps other candidates', json: true },
    { name: 'lesson 404 is named in text', json: false },
    { name: 'lesson 500 remains fatal', lessonStatus: 500, error: /nearest-lessons.*HTTP 500/ },
    { name: 'health 404 remains fatal', healthStatus: 404, error: /health.*HTTP 404/ },
    { name: 'entries 404 remains fatal', entriesStatus: 404, error: /entries.*HTTP 404/ },
    { name: 'missing dense route remains fatal', routeMissing: true, error: /nearest-lessons.*HTTP 404/ },
    { name: 'bad dense JSON remains fatal', lessonStatus: 200, badJson: true, error: /dense unavailable for lesson 3/ },
  ]) {
    await t.test(entry.name, async () => {
      scenario = entry;
      const child = spawn(process.execPath, ['scripts/memory/lesson-dedupe.mjs', 'candidates',
        ...(entry.json === false ? [] : ['--json'])], {
        env: { ...process.env, MEMORYCTL_URL: `http://127.0.0.1:${server.address().port}`,
          LESSON_DEDUPE_LEDGER: file },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const [code] = await once(child, 'close');
      assert.equal(code, entry.error ? 1 : 0, stderr);
      if (entry.error) {
        assert.match(stderr, entry.error);
        assert.equal(stdout, '');
      } else if (entry.json) {
        const result = JSON.parse(stdout);
        assert.deepEqual(result.pairs.map(pair => [pair.newer, pair.older, pair.sources]), [[2, 1, ['dense']]]);
        assert.deepEqual(result.unchecked, { skippedMalformed: [], missingVectors: [], supersededDuringRun: [3] });
      } else {
        assert.match(stdout, /1 candidate pairs/);
        assert.match(stdout, /unchecked:.*supersededDuringRun=\[3\]/);
      }
      assert.equal(fs.existsSync(file), false, 'candidate reads must not write the ledger');
    });
  }
});

test('CLI exits zero when dense route answers with unchecked rows', async (t) => {
  const file = fixture(t);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') { res.end(JSON.stringify({ embedder: { model } })); return; }
    if (req.url?.startsWith('/api/memory/entries?')) res.end(JSON.stringify([{
      id: 42, title: 'Fresh', body: '- rule: Fresh', kind: 'lesson', superseded_by: null,
      ts: Date.now(), links: JSON.stringify({ domain: 'domain-harness', anchor }),
    }]));
    else res.end(JSON.stringify(denseResult([], [6], [7])));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const child = spawn(process.execPath, ['scripts/memory/lesson-dedupe.mjs', 'candidates', '--json'], {
      env: { ...process.env, MEMORYCTL_URL: `http://127.0.0.1:${server.address().port}`,
        LESSON_DEDUPE_LEDGER: file },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).unchecked, { skippedMalformed: [6], missingVectors: [7] });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('run-done advances the next window; explicit since backfills', async (t) => {
  const file = fixture(t);
  const now = Date.parse('2026-09-26T12:00:00Z');
  const rows = [lesson(1, 'First unrelated rule'), lesson(2, 'Second unrelated rule', {}, now - 6 * 86400000)];
  const calls = [];
  const opts = { file, readModel, read: async () => rows, neighbours: async id => { calls.push(id); return denseResult(); },
    now: () => now, output: () => {} };
  await run(['candidates'], opts);
  assert.deepEqual(calls, [2]);
  await run(['run-done'], opts);
  assert.equal(readLedger(file)[0].type, 'run-done');
  calls.length = 0;
  await run(['candidates'], opts);
  assert.deepEqual(calls, []);
  await run(['candidates', '--since', '2026-09-01'], opts);
  assert.deepEqual(calls, [2]);
  await assert.rejects(run(['candidates', '--since', 'invalid'], opts), /since must be/);
});

test('answered dense route lists unchecked ids once in text and JSON without hiding valid pairs', async (t) => {
  const file = fixture(t);
  const rows = [lesson(1, 'First distinct rule'), lesson(2, 'Second distinct rule', { duplicateCheck: 'incomplete' }),
    lesson(3, 'Third distinct rule', {}, Date.now()),
    lesson(7, 'Malformed rule', { possibleDuplicateOf: [1] })];
  const neighbours = async () => denseResult([{ id: 1, cosine: 1 }], [8, 7, 8], [9, 9]);
  const json = [];
  const pairs = await run(['candidates', '--json'], { file, readModel, read: async () => rows, neighbours, output: line => json.push(line) });
  assert.deepEqual(pairs.filter(pair => pair.sources.includes('dense')).map(pair => pair.newer), [2, 3]);
  assert.ok(pairs.every(pair => pair.newer !== 7 && pair.older !== 7), 'malformed lesson is not a candidate');
  assert.deepEqual(JSON.parse(json[0]).unchecked, { skippedMalformed: [7, 8], missingVectors: [9] });
  assert.equal(JSON.parse(json[0]).pairs.length, pairs.length);
  const text = [];
  await run(['candidates'], { file, readModel, read: async () => rows, neighbours, output: line => text.push(line) });
  assert.match(text.at(-1), /skippedMalformed=\[7,8\] missingVectors=\[9\]/);
});

test('record and run-done do not require a fit, but dense path diagnoses its file and model key', async (t) => {
  const file = fixture(t);
  assert.throws(() => readDenseThreshold(model, path.join(path.dirname(file), 'missing-results.json')),
    /missing-results\.json models\["qwen3-embedding:0.6b"\]\.threshold/);
  const copy = path.join(path.dirname(file), 'bad-results.json');
  for (const threshold of [undefined, null, '0.75', -1.1, 1.1]) {
    fs.writeFileSync(copy, JSON.stringify({ models: { [model]: { threshold } } }));
    assert.throws(() => readDenseThreshold(model, copy), /bad-results\.json models\["qwen3-embedding:0.6b"\]\.threshold is missing or invalid/);
  }
  fs.writeFileSync(copy, JSON.stringify({ models: { [model]: { threshold: 0.75 }, 'bge-m3': { threshold: 0.697 } } }));
  assert.equal(readDenseThreshold(model, copy), 0.75);
  assert.equal(readDenseThreshold('bge-m3', copy), 0.697);
  assert.throws(() => readDenseThreshold('another-model', copy), /another-model.*missing or invalid/);
  assert.throws(() => readDenseThreshold(undefined, copy), /embedding model is required/);
  const script = `import fs from 'node:fs'; import { run } from './scripts/memory/lesson-dedupe.mjs';
    const orig = fs.readFileSync; fs.readFileSync = function(path, ...args) {
      if (String(path).endsWith('/lesson-dedupe-fit.json')) throw new Error('test unavailable');
      return orig.call(this, path, ...args);
    };
    await run(['run-done'], { file: process.env.LESSON_DEDUPE_LEDGER, output: () => {} });
    await run(['record', '--newer', '2', '--older', '1', '--verdict', 'distinct'],
      { file: process.env.LESSON_DEDUPE_LEDGER, output: () => {} });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, LESSON_DEDUPE_LEDGER: file }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readLedger(file).map(row => row.type ?? row.verdict), ['run-done', 'distinct']);
});

test('invalid ledger never silently resets adjudication', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, 'not-json\n');
  assert.throws(() => readLedger(file), /invalid ledger JSON at line 1/);
});
