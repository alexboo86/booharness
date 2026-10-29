import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

// No adjacent test exercises this credit/authorization subprocess boundary.
const wrapper = fileURLToPath(new URL('./hf.mjs', import.meta.url));
const job = '01234567-89ab-4cde-8fab-0123456789ab';
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'orch-hf-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = join(home, '.local/state/orch');
  mkdirSync(state, { recursive: true });
  const cli = join(home, 'higgsfield');
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const ledger = path.join(process.env.HOME, '..', 'higgsfield-ledger.jsonl');
const reservations = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '';
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, home: process.env.HOME, reservations }) + '\\n');
if (args[0] === 'generate' && args[1] === 'cost') {
  console.log(process.env.STUB_COST || '{"credits":2}');
  process.exit(Number(process.env.STUB_COST_EXIT || 0));
}
if (args[0] === 'generate' && args[1] === 'create') {
  if (process.env.STUB_BLOCK) {
    fs.writeSync(1, 'waiting\\n');
    fs.readSync(0, Buffer.alloc(1), 0, 1, null);
  }
  console.log(process.env.STUB_CREATE || '{"job_id":"${job}"}');
} else console.log('passthrough');
console.error('stub stderr');
process.exit(Number(process.env.STUB_EXIT || 0));
`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, ORCH_HIGGSFIELD_BIN: cli, STUB_LOG: join(home, 'calls.jsonl') };
  for (const key of Object.keys(env)) {
    if (key.startsWith('STUB_') && key !== 'STUB_LOG') delete env[key];
  }
  delete env.SEAT_POLICY_ROLE;
  delete env.ORCH_SEAT_ID;
  const run = (args, extra = {}) => spawnSync(process.execPath, [wrapper, ...args], {
    env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000,
  });
  const rows = file => existsSync(join(state, file))
    ? readFileSync(join(state, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { home, state, env, run, rows,
    calls: () => existsSync(env.STUB_LOG) ? readFileSync(env.STUB_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [],
    limit: credits => writeFileSync(join(state, 'higgsfield-ceilings.json'), JSON.stringify({ s1: credits })),
  };
}
const designer = { SEAT_POLICY_ROLE: 'designer', ORCH_SEAT_ID: 's1' };
const create = ['generate', 'create', 'model-a', '--prompt', 'a cat'];

// Authorization and spend controls protect operator money; no source-grep assertions.
test('either seat marker (even empty) denies unapproved or absent role', t => {
  const f = fixture(t);
  for (const env of [{ SEAT_POLICY_ROLE: 'coder' }, { ORCH_SEAT_ID: 's1' },
    { SEAT_POLICY_ROLE: '' }, { ORCH_SEAT_ID: '' }, { SEAT_POLICY_ROLE: 'lead' }]) {
    assert.equal(f.run(['account'], env).status, 1);
  }
  assert.deepEqual(f.calls(), []);
});

test('designer and motion allow exactly the specified verb families', t => {
  const f = fixture(t);
  const allowed = [['model', 'list'], ['model', 'get', 'x'], ['preset', 'list'], ['account'],
    ...['cost', 'get', 'wait', 'list'].map(verb => ['generate', verb, 'x'])];
  for (const role of ['designer', 'motion']) {
    for (const args of allowed) assert.equal(f.run(args, { ...designer, SEAT_POLICY_ROLE: role }).status, 0);
    for (const args of [['auth', 'login'], ['model', 'delete'], ['generate', 'workflow'], ['gen', 'create'],
      ['--json', 'generate', 'create'], ['--set-ceiling', 's1', '99'], []]) {
      assert.equal(f.run(args, { ...designer, SEAT_POLICY_ROLE: role }).status, 1);
    }
  }
  assert.equal(f.calls().length, allowed.length * 2);
});

test('lead passes every verb/argv, isolated HOME, stdout/stderr and exit status', t => {
  const f = fixture(t);
  for (const args of [['auth', 'login', '--odd=a b'], create, ['unknown', ';echo nope']]) {
    const result = f.run(args, { STUB_EXIT: '17' });
    assert.equal(result.status, 17);
    assert.match(result.stderr, /stub stderr/);
  }
  assert.deepEqual(f.calls().map(c => c.args), [['auth', 'login', '--odd=a b'], create, ['unknown', ';echo nope']]);
  assert.ok(f.calls().every(c => c.home === join(f.state, 'higgsfield-home')));
  assert.deepEqual(f.rows('higgsfield-ledger.jsonl'), []);
});

test('legacy credential warning does not read or alter credential contents', t => {
  const f = fixture(t);
  const legacy = join(f.home, '.config/higgsfield');
  mkdirSync(legacy, { recursive: true });
  // A directory in place of a file makes accidental reading fail with EISDIR.
  mkdirSync(join(legacy, 'credentials.json'));
  const result = f.run(['account'], designer);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /warning: legacy Higgsfield credentials exist/);
});

test('lead sets finite ceilings; seats cannot change them', t => {
  const f = fixture(t);
  assert.equal(f.run(['--set-ceiling', 's1', '4']).status, 0);
  assert.equal(f.run(['--set-ceiling', 's2', '0']).status, 0);
  assert.equal(f.run(['--set-ceiling', 's1', '99'], designer).status, 1);
  for (const credit of ['NaN', '-1', 'Infinity', '']) assert.equal(f.run(['--set-ceiling', 's1', credit]).status, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(f.state, 'higgsfield-ceilings.json'))), { s1: 4, s2: 0 });
  assert.deepEqual(f.calls(), []);
});

test('cost uses same model/options; durable reservation precedes create and job receipt follows', t => {
  const f = fixture(t);
  f.limit(4);
  const result = f.run(create, designer);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(job));
  assert.deepEqual(f.calls().map(c => c.args), [['generate', 'cost', ...create.slice(2), '--json'], create]);
  const [reserve, receipt] = f.rows('higgsfield-ledger.jsonl');
  assert.deepEqual({ seat: reserve.seat, role: reserve.role, model: reserve.model, cost: reserve.cost },
    { seat: 's1', role: 'designer', model: 'model-a', cost: 2 });
  assert.ok(Number.isFinite(Date.parse(reserve.ts)));
  assert.equal(JSON.parse(f.calls()[1].reservations.trim()).reservation, reserve.reservation);
  assert.equal(receipt.reservation, reserve.reservation);
  assert.deepEqual(receipt.jobIds, [job]);
  assert.equal(existsSync(join(f.state, 'higgsfield.lock')), false);
});

test('cumulative ceiling allows equality, rejects next spend and isolates seat totals', t => {
  const f = fixture(t);
  f.limit(4);
  assert.equal(f.run(create, designer).status, 0);
  assert.equal(f.run(create, { ...designer, SEAT_POLICY_ROLE: 'motion' }).status, 0);
  assert.equal(f.run(create, designer).status, 1);
  writeFileSync(join(f.state, 'higgsfield-ceilings.json'), JSON.stringify({ s1: 4, s2: 2 }));
  assert.equal(f.run(create, { ...designer, ORCH_SEAT_ID: 's2' }).status, 0);
  assert.equal(f.calls().filter(c => c.args[1] === 'create').length, 3);
});

test('missing ceiling or seat identity refuses without invoking CLI', t => {
  const f = fixture(t);
  assert.equal(f.run(create, designer).status, 1);
  f.limit(3);
  assert.equal(f.run(create, { SEAT_POLICY_ROLE: 'designer' }).status, 1);
  assert.equal(f.run(['generate', 'create', '--help'], designer).status, 1);
  assert.deepEqual(f.calls(), []);
});

test('non-numeric/negative/missing/failed estimates cannot reserve or create; zero is valid', t => {
  const f = fixture(t);
  f.limit(2);
  for (const cost of ['{}', '{"credits":"2"}', '{"credits":null}', '{"credits":-1}', '{"credits":1e999}', 'not json']) {
    assert.equal(f.run(create, { ...designer, STUB_COST: cost }).status, 1);
  }
  assert.equal(f.run(create, { ...designer, STUB_COST_EXIT: '9' }).status, 1);
  assert.deepEqual(f.rows('higgsfield-ledger.jsonl'), []);
  assert.equal(f.calls().filter(c => c.args[1] === 'create').length, 0);
  f.limit(0);
  assert.equal(f.run(create, { ...designer, STUB_COST: '{"credits":0}' }).status, 0);
});

test('failed create retains reservation and same exit code, preventing a second overspend', t => {
  const f = fixture(t);
  f.limit(2);
  assert.equal(f.run(create, { ...designer, STUB_EXIT: '7' }).status, 7);
  assert.equal(f.run(create, designer).status, 1);
  // The failed create leaves its receipt with the exit code; the receipt carries no cost.
  assert.deepEqual(f.rows('higgsfield-ledger.jsonl').map(r => [r.type, r.cost, r.exitCode]),
    [['reserve', 2, undefined], ['job', undefined, 7]]);
  assert.equal(f.calls().filter(c => c.args[1] === 'create').length, 1);
});

test('malformed ledger/ceilings and torn ledger fail closed', t => {
  const f = fixture(t);
  f.limit(5);
  for (const text of ['{"type":"reserve","seat":"s1","cost":2}', 'bad\n', '{"cost":2}\n',
    '{"type":"reserve","seat":"s1","cost":"2"}\n']) {
    writeFileSync(join(f.state, 'higgsfield-ledger.jsonl'), text);
    assert.equal(f.run(create, designer).status, 1);
  }
  writeFileSync(join(f.state, 'higgsfield-ledger.jsonl'), '');
  for (const text of ['null', '[]', '{"s1":"5"}', 'bad']) {
    writeFileSync(join(f.state, 'higgsfield-ceilings.json'), text);
    assert.equal(f.run(create, designer).status, 1);
  }
  assert.deepEqual(f.calls(), []);
});

test('busy/stale mkdir lock refuses both spending and ceiling updates without deleting lock', t => {
  const f = fixture(t);
  f.limit(4);
  mkdirSync(join(f.state, 'higgsfield.lock'));
  assert.equal(f.run(create, designer).status, 1);
  assert.equal(f.run(['--set-ceiling', 's1', '9']).status, 1);
  assert.equal(existsSync(join(f.state, 'higgsfield.lock')), true);
  assert.deepEqual(f.calls(), []);
});

test('concurrent create holds lock until job receipt; other creator cannot race budget', { timeout: 10000 }, async t => {
  const f = fixture(t);
  f.limit(2);
  const first = spawn(process.execPath, [wrapper, ...create], {
    env: { ...f.env, ...designer, STUB_BLOCK: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => first.kill());
  const closed = once(first, 'close');
  const [chunk] = await once(first.stdout, 'data');
  assert.match(chunk.toString(), /waiting/);
  assert.equal(f.run(create, designer).status, 1);
  assert.equal(f.run(['--set-ceiling', 's1', '9']).status, 1);
  first.stdin.end('x');
  assert.equal((await closed)[0], 0);
  assert.equal(f.rows('higgsfield-ledger.jsonl').length, 2);
});

test('human UUID output and multiple JSON job IDs recorded; unreadable success keeps charge', t => {
  const f = fixture(t);
  f.limit(6);
  assert.equal(f.run(create, { ...designer, STUB_CREATE: `Created job: ${job}` }).status, 0);
  assert.equal(f.run(create, { ...designer, STUB_CREATE: '{"job_ids":["a","b"]}' }).status, 0);
  const unreadable = f.run(create, { ...designer, STUB_CREATE: 'no id' });
  assert.equal(unreadable.status, 0);
  assert.match(unreadable.stderr, /no readable job ID; reservation retained/);
  assert.deepEqual(f.rows('higgsfield-ledger.jsonl').filter(r => r.type === 'job').map(r => r.jobIds), [[job], ['a', 'b'], []]);
  assert.equal(f.run(create, designer).status, 1);
});
