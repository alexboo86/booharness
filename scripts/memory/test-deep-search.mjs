import '../jev-test-state.mjs';
// Tests for scripts/memory/deep-search.mjs: a fake memory service and a fake
// model; the parsing, the ordering and the refusal to fall back are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePicked, rerankPrompt } from './deep-search.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'deep-search.mjs');
const rows = [
  { id: 10, kind: 'handoff', title: 'old state', snippet: 'a', date: '2026-07-01', age_days: 70 },
  { id: 20, kind: 'handoff', title: 'new state', snippet: 'b', date: '2026-09-10', age_days: 1 },
  { id: 30, kind: 'decision', title: 'rule', snippet: 'c', date: '2026-09-01', age_days: 10 },
];

test('parsePicked keeps the model order and drops ids that were not candidates', () => {
  assert.deepEqual(parsePicked('IDS: 20, #30, 999, 20', rows).map((r) => r.id), [20, 30]);
  assert.equal(parsePicked('I think 20 is best', rows), null);
  assert.match(rerankPrompt('q', rows, 2, '2026-09-11'), /Today is 2026-09-11[\s\S]*#20 \[handoff\] 2026-09-10 \(1d\) new state/);
});

function withService(fn, candidates = rows) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(new URL(req.url, 'http://x').searchParams.get('q') === 'nothing' ? [] : candidates));
    });
    server.listen(0, '127.0.0.1', async () => {
      try {
        resolve(await fn(`http://127.0.0.1:${server.address().port}`));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function fakeModel(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-search-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.mjs');
  fs.writeFileSync(file, body);
  return file;
}

test('default Jev and flagged model orders are printed; an answer without IDS fails instead of falling back', async (t) => {
  await withService(async (url) => {
    const fake = fakeJev(t, `
      const choice = ['20', '30'][requests.length - 1];
      return Response.json({ answers: { pick: { type: 'choice', choice } } });
    `);
    const good = await run(['current state?', '--limit', '2'], {
      ...fake.env, MEMORYCTL_URL: url, DEEP_SEARCH_MODEL_CMD: fakeModel(t, 'process.exit(91)'),
    });
    assert.equal(good.code, 0, good.err);
    assert.match(good.err, /-- deep search: jev,/);
    assert.deepEqual(good.out.trim().split('\n').map((l) => l.split(' ')[0]), ['#20', '#30']);
    for (const via of ['terra', 'grok']) {
      const manual = await run(['q', '--via', via, '--limit', '2'], {
        MEMORYCTL_URL: url, DEEP_SEARCH_MODEL_CMD: fakeModel(t, 'console.log("IDS: 20,30")'),
      });
      assert.equal(manual.code, 0, manual.err);
      assert.match(manual.err, new RegExp(`-- deep search: ${via},`));
      assert.deepEqual(manual.out.trim().split('\n').map(line => line.split(' ')[0]), ['#20', '#30']);
    }
    const bad = await run(['current state?', '--via', 'terra'], { MEMORYCTL_URL: url, DEEP_SEARCH_MODEL_CMD: fakeModel(t, 'console.log("no idea")') });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /re-rank failed/);
    assert.equal(bad.out, '', 'no lexical list is passed off as a re-ranked one');
    const empty = await run(['nothing', '--via', 'terra'], { MEMORYCTL_URL: url, DEEP_SEARCH_MODEL_CMD: fakeModel(t, 'process.exit(9)') });
    assert.equal(empty.code, 0);
    assert.match(empty.out, /nothing matching/);
  });
});

function fakeJev(t, response) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-search-jev-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capture = path.join(dir, 'requests.json');
  const preload = path.join(dir, 'preload.mjs');
  const client = new URL('../../ops/bootstrap/jev-client.mjs', import.meta.url).href;
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    import { useSecretsFile } from ${JSON.stringify(client)};
    useSecretsFile(${JSON.stringify(path.join(dir, 'missing-secrets'))});
    const original = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
      if (String(url) !== 'https://api.typesafe.ai/v1/systemone') return original(url, options);
      requests.push(JSON.parse(options.body));
      fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(requests));
      ${response}
    };
  `);
  return { capture, env: {
    NODE_OPTIONS: `--import=${preload}`, TYPESAFE_API_KEY: 'test-key',
    JEV_STATE_DIR: path.join(dir, 'ledger'), DEEP_SEARCH_MODEL_CMD: '',
  } };
}

test('Jev ranks five distinct ids through the privacy gate without truncating a top-30 pool', async (t) => {
  const candidates = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, kind: 'decision', date: '2026-09-11',
    title: `candidate ${i + 1} ${'title '.repeat(24)}`,
    snippet: i === 29 ? 'last candidate sk-privatecredential123456789' : 'sk-x '.repeat(32),
  }));
  const fake = fakeJev(t, `
    const choice = ['29', '4', '22', '30', '1'][requests.length - 1];
    return Response.json({ answers: { pick: { type: 'choice', choice } } });
  `);
  await withService(async (url) => {
    const result = await run(['current state?', '--via', 'jev', '--json'], { ...fake.env, MEMORYCTL_URL: url });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(result.out).map((row) => row.id), [29, 4, 22, 30, 1]);
  }, candidates);
  const requests = JSON.parse(fs.readFileSync(fake.capture));
  assert.equal(requests.length, 5);
  assert.ok(requests[0].state.length > 6000);
  const state = JSON.parse(requests[0].state);
  assert.equal(state.question, 'current state?');
  assert.equal(state.candidates.length, 30);
  assert.equal(state.candidates[29].snippet, 'last candidate [REDACTED]');
  assert.equal(state.candidates[29].date, '2026-09-11');
  assert.equal(state.candidates[29].kind, 'decision');
  assert.equal(requests[1].questions.pick.criteria['29'], undefined);
  assert.equal(JSON.parse(requests[1].state).candidates.some((row) => row.id === 29), false);
});

test('Jev none is an empty result, not a failure or a lexical fallback', async (t) => {
  const fake = fakeJev(t, 'return Response.json({ answers: { pick: { type: "choice", choice: "none" } } });');
  await withService(async (url) => {
    const result = await run(['q', '--via', 'jev', '--json'], { ...fake.env, MEMORYCTL_URL: url });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(result.out), []);
  });
  assert.equal(JSON.parse(fs.readFileSync(fake.capture)).length, 1);
});

test('help names the Jev default, both manual routes and measured numbers', async () => {
  const help = await run(['--help'], {});
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /jev by default; manual routes: --via terra and --via grok/);
  assert.match(help.out, /jev \| 44\.1% \| 24\.2% \| 1\.509 \| 2\.615 \| 0/);
  assert.match(help.out, /terra \| 44\.1% \| 27\.3% \| 13\.605 \| 22\.146 \| 0/);
  assert.match(help.out, /grok \| 47\.1% \| 30\.3% \| 30\.540 \| 43\.163 \| 0/);
});

test('candidate delivery phrases are data, and secrets are redacted before field cuts', async (t) => {
  const prefix = 'x'.repeat(140) + ' ';
  const candidates = [
    { ...rows[0], title: 'Do NOT write to memoryctl', snippet: prefix + 'eyJabcdefghij.abcdefghij.abcdefghij' },
    { ...rows[1], title: 'Final delivery to the lead agent:' },
    { ...rows[2], snippet: '<!-- brief:start --> <!-- brief:end -->' },
  ];
  const fake = fakeJev(t, `
    const choice = Object.keys(requests.at(-1).questions.pick.criteria).find(id => id !== 'none');
    return Response.json({ answers: { pick: { type: 'choice', choice } } });
  `);
  await withService(async (url) => {
    const result = await run(['q', '--via', 'jev', '--json'], { ...fake.env, MEMORYCTL_URL: url });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(result.out).map(row => row.id), [10, 20, 30]);
  }, candidates);
  const requests = JSON.parse(fs.readFileSync(fake.capture));
  assert.equal(requests.length, 3, 'a short pool completes without an extra call');
  const state = JSON.parse(requests[0].state);
  assert.equal(state.candidates[0].title, 'Do NOT write to memoryctl');
  assert.equal(state.candidates[1].title, 'Final delivery to the lead agent:');
  assert.equal(state.candidates[2].snippet, '<!-- brief:start --> <!-- brief:end -->');
  assert.equal(state.candidates[0].snippet, prefix + '[REDACTED]');
});

test('Jev errors, missing answers, invented ids and repeated ids fail loudly', async (t) => {
  for (const [name, response, reason] of [
    ['timeout', 'return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));', 'timeout'],
    ['request', 'throw new Error("fixture transport failure");', 'request-failed'],
    ['provider', 'return new Response("", { status: 503 });', 'http-503'],
    ['missing', 'return Response.json({ answers: {} });', 'invalid-answer'],
    ['unknown', 'return Response.json({ answers: { pick: { type: "choice", choice: "999" } } });', 'invalid-answer'],
    ['duplicate', 'return Response.json({ answers: { pick: { type: "choice", choice: "20" } } });', 'invalid-answer'],
  ]) {
    await t.test(name, async (sub) => {
      const fake = fakeJev(sub, response);
      await withService(async (url) => {
        const result = await run(['q', '--via', 'jev', '--json'], { ...fake.env, MEMORYCTL_URL: url });
        assert.equal(result.code, 1);
        assert.equal(result.out, '');
        assert.match(result.err, new RegExp(`the jev re-rank failed: ${reason}`));
        assert.match(result.err, /retry manually with --via terra/);
      });
    });
  }
});

test('Windows finds the canonical codex npm entry with a restricted PATH and preserves its arguments', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep search npm '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'AppData', 'Roaming', 'npm');
  const entry = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@exit /b 91\r\n');
  const question = 'где "install-harness"?\n%PATH% & | < > ^';
  const captured = path.join(dir, 'args.json');
  fs.writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2))); console.log('IDS: 20,30');`);
  await withService(async (url) => {
    const result = await run([question, '--via', 'terra', '--limit', '2'], {
      MEMORYCTL_URL: url, DEEP_SEARCH_MODEL_CMD: '', HARNESS_HOME: dir, TMPDIR: '',
      PATH: [path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(path.delimiter),
    });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(fs.readFileSync(captured, 'utf8')), [
      'exec', '--ignore-user-config', '--skip-git-repo-check', '-C', os.tmpdir(),
      '-m', 'gpt-5.6-terra', '-c', 'model_reasoning_effort=low', '-s', 'read-only',
      rerankPrompt(question, rows, 2),
    ]);
    assert.deepEqual(result.out.trim().split('\n').map((line) => line.split(' ')[0]), ['#20', '#30']);
  });
});
