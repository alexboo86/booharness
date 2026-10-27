// B1 archiver tests: the predicate both consumers share (scan.mjs suggests
// exactly what archive-handoff.mjs would write) and the write path with the
// CLI runner stubbed or real against an isolated store — never live memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { archiveOne, parseArgv, planArchive } from './archive-handoff.mjs';
import { B1_ARCHIVE_DAYS, classifyB1, latestLiveByTrack, REFUSED_TRACK_STATUSES } from './b1-handoff.mjs';
import { createMemory, openMemoryDb } from './store.mjs';
import { REPO_ROOT } from './lesson-lib.mjs';

const DAY = 86400000;
const NOW = 1_800_000_000_000;

const handoff = (over = {}) => ({
  id: 10, ts: NOW - 20 * DAY, title: 'Сводка сессии', body: '', links: '[]', pinned: 0, ...over,
});
const task = (over = {}) => ({ id: 1, status: 'done', handoffs: [10], ...over });
const trackLinks = (slug, status) => JSON.stringify(status ? { track: slug, status } : { track: slug });
// The standard pair: an older covered handoff and the fresh one continuing its track.
const pair = (older = {}, newer = {}) => [
  handoff({ links: trackLinks('svod-windows'), ...older }),
  handoff({ id: 11, ts: NOW - 2 * DAY, links: trackLinks('svod-windows'), ...newer }),
];
const classify = (rows, tasks = []) => classifyB1({ handoff: rows[0], handoffs: rows, tasks, now: NOW });

test('classifyB1 passes a covered handoff with closed tails and names the current track status', () => {
  const ok = classify(pair(), [task({ status: 'cancelled' })]);
  assert.equal(ok.verdict, 'candidate');
  assert.equal(ok.track, 'svod-windows');
  assert.equal(ok.trackStatus, 'active'); // unset on the newest live handoff reads as active
  assert.equal(ok.latestId, 11);
  assert.equal(ok.ageDays, 20);
  assert.equal(B1_ARCHIVE_DAYS, 14);
});

test('classifyB1 refuses pinned, open tails, young and blocked tracks', () => {
  assert.equal(classify(pair({ pinned: 1 })).reason, 'pinned');
  const tails = classify(pair(), [task({ status: 'open' })]);
  assert.equal(tails.reason, 'open-tails');
  assert.equal(tails.openTails, 1);
  assert.equal(classify(pair({ ts: NOW - 5 * DAY })).reason, 'young');
  const blocked = classify(pair({}, { links: trackLinks('svod-windows', 'blocked') }));
  assert.equal(blocked.verdict, 'refused');
  assert.equal(blocked.reason, 'track-status');
  assert.equal(blocked.trackStatus, 'blocked');
  assert.deepEqual([...REFUSED_TRACK_STATUSES], ['blocked']);
});

test('classifyB1 requires fourteen full elapsed days', () => {
  for (const age of [13.5 * DAY, 14 * DAY - 1, 14 * DAY]) {
    const result = classify(pair({ ts: NOW - age }));
    assert.equal(result.verdict, age < 14 * DAY ? 'refused' : 'candidate', `age ${age} ms`);
    assert.equal(result.reason, age < 14 * DAY ? 'young' : '');
  }
});

test('classifyB1 skips what is not B1 business: archived links, dead title, no track, newest live', () => {
  const archived = classify([
    handoff({ links: trackLinks('x', 'archived') }),
    handoff({ id: 11, ts: NOW - DAY, links: trackLinks('x') }),
  ]);
  assert.deepEqual([archived.verdict, archived.reason], ['skip', 'archived']);
  const dead = classify(pair({ title: 'ARCHIVED: было' }));
  assert.deepEqual([dead.verdict, dead.reason], ['skip', 'dead-title']);
  const noTrack = classify([handoff()]);
  assert.deepEqual([noTrack.verdict, noTrack.reason], ['skip', 'no-track']);
  const newest = classify([handoff({ links: trackLinks('solo') })]);
  assert.deepEqual([newest.verdict, newest.reason], ['skip', 'newest-live']);
});

test('a history-titled or already-archived successor is not the track present', () => {
  // The older handoff stays the newest LIVE one, so it is protected, not a candidate.
  const deadTitle = classify([
    handoff({ links: trackLinks('svod-windows') }),
    handoff({ id: 11, ts: NOW - DAY, title: 'ARCHIVED: старое', links: trackLinks('svod-windows') }),
  ]);
  assert.deepEqual([deadTitle.verdict, deadTitle.reason], ['skip', 'newest-live']);
  const archivedLinks = classify([
    handoff({ links: trackLinks('svod-windows') }),
    handoff({ id: 11, ts: NOW - DAY, links: trackLinks('svod-windows', 'archived') }),
  ]);
  assert.deepEqual([archivedLinks.verdict, archivedLinks.reason], ['skip', 'newest-live']);
});

test('equal timestamps: the higher id is the track present, in either input order', () => {
  // gen-tracks.mjs buildTracks breaks the same tie; a flip would archive the present.
  const ts = NOW - 20 * DAY;
  const lower = handoff({ id: 10, ts, links: trackLinks('svod-windows') });
  const higher = handoff({ id: 11, ts, links: trackLinks('svod-windows') });
  for (const rows of [[lower, higher], [higher, lower]]) {
    assert.equal(latestLiveByTrack(rows).get('svod-windows').id, 11);
    const older = classifyB1({ handoff: lower, handoffs: rows, tasks: [], now: NOW });
    assert.deepEqual([older.verdict, older.latestId], ['candidate', 11]);
    const present = classifyB1({ handoff: higher, handoffs: rows, tasks: [], now: NOW });
    assert.deepEqual([present.verdict, present.reason], ['skip', 'newest-live']);
  }
});

test('latestLiveByTrack reads the store marker, not a private regex', () => {
  // A `->` inside a field value is a `>` the old scan-side copy could not cross.
  const rows = [
    handoff({ id: 10, links: '[]', body: '<!-- track: feed-lag | status: active | next: насос -> перезапуск -->' }),
    handoff({ id: 11, ts: NOW - DAY, links: '[]', body: 'итог\n<!-- track: feed-lag | next: закрыто -->' }),
  ];
  const latest = latestLiveByTrack(rows).get('feed-lag');
  assert.equal(latest.id, 11);
  const verdict = classify(rows);
  assert.equal(verdict.verdict, 'candidate');
  assert.equal(verdict.latestId, 11);
});

test('parseArgv collects repeatable ids, dedupes and refuses everything else', () => {
  assert.deepEqual(parseArgv(['--id', '5', '--id', '7', '--id', '5', '--dry-run']), { ids: [5, 7], dryRun: true, error: '' });
  assert.match(parseArgv([]).error, /no --id given/);
  assert.match(parseArgv(['--id', 'x']).error, /invalid --id value/);
  assert.match(parseArgv(['--id', '5', '--batch']).error, /unknown argument/);
});

test('planArchive prefixes the title, keeps every link field and the body byte for byte', () => {
  const plan = planArchive(handoff({
    title: 'Сводка',
    body: 'итог\n',
    links: JSON.stringify({ track: 'svod-windows', next: 'шаг' }),
  }));
  assert.equal(plan.title, 'ARCHIVED: Сводка');
  assert.deepEqual(plan.links, { track: 'svod-windows', next: 'шаг', status: 'archived' });
  assert.equal(plan.body, 'итог\n');
});

test('planArchive truncates titles without splitting a Unicode code point', () => {
  const plan = planArchive(handoff({ title: `${'a'.repeat(469)}😀tail` }));
  assert.equal(plan.title, `ARCHIVED: ${'a'.repeat(469)}😀`);
  assert.equal(Buffer.from(plan.title).toString('utf8'), plan.title);
});

test('archiveOne preserves BOM and whitespace bodies through list, real CLI and isolated store', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-handoff-test-'));
  const db = openMemoryDb(state);
  const tokenPath = path.join(state, 'memory.token');
  const memory = createMemory({ db, tokenPath });
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (!memory.handle(req, res, new URL(req.url, 'http://localhost'), body)) {
      res.writeHead(404); res.end();
    }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const env = {
      ...process.env, MEMORYCTL_URL: url, MEMORYCTL_STATE_DIR: state,
      MEMORYCTL_TOKEN_FILE: tokenPath,
      PATH: `${path.join(REPO_ROOT, '.claude/scripts')}${path.delimiter}${process.env.PATH}`,
    };
    const runChild = (args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, timeout: 30000 });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
      child.stdin.end();
    });
    for (const body of ['\uFEFForiginal\n😀\n', '\n']) {
      const response = await fetch(`${url}/api/memory/append`, {
        method: 'POST',
        headers: { 'x-memory-token': fs.readFileSync(tokenPath, 'utf8').trim() },
        body: JSON.stringify({ kind: 'handoff', title: 'Original', body, no_open_work: true }),
      });
      const seeded = await response.json();
      assert.equal(response.status, 200, JSON.stringify(seeded));
      const result = await runChild(['--input-type=module', '-e', `
        import { archiveOne } from './scripts/memory/archive-handoff.mjs';
        import { readEntries, readMemory } from './scripts/memory/service-client.mjs';
        import { runMemoryctl } from './scripts/memory/lesson-lib.mjs';
        const row = (await readEntries('handoff')).find(row => row.id === ${seeded.id});
        await archiveOne({
          row, run: runMemoryctl,
          readEntry: id => readMemory('entry?id=' + id),
        });
      `]);
      assert.equal(result.code, 0, result.output);
      const original = db.prepare('SELECT * FROM mem_entries WHERE id = ?').get(seeded.id);
      assert.ok(original.superseded_by);
      const fresh = db.prepare('SELECT * FROM mem_entries WHERE id = ?').get(original.superseded_by);
      assert.deepEqual(Buffer.from(fresh.body), Buffer.from(body));
      assert.equal(fresh.title, 'ARCHIVED: Original');
      assert.equal(JSON.parse(fresh.links).status, 'archived');
      assert.equal(fresh.superseded_by, null);
    }
    // The title-file decoder shares the same byte-preservation contract.
    const title = '\uFEFFTitle 😀';
    const titleFile = path.join(state, 'title.txt');
    fs.writeFileSync(titleFile, title);
    const result = await runChild(['--input-type=module', '-e', `
      import { runMemoryctl } from './scripts/memory/lesson-lib.mjs';
      runMemoryctl(['append', '--kind', 'reference', '--title-file', ${JSON.stringify(titleFile)},
        '--body-file', '-'], { input: 'body\\n' });
    `]);
    assert.equal(result.code, 0, result.output);
    assert.equal(db.prepare("SELECT title FROM mem_entries WHERE kind = 'reference'").get().title, title);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('archiveOne runs supersede with the exact body bytes and archived links', async () => {
  const body = 'итог сессии\n- хвост #1 закрыт\n';
  const row = handoff({ id: 10, title: 'Сводка', body, links: trackLinks('svod-windows') });
  const seen = { args: null, bytes: '' };
  const run = (args, options) => {
    seen.args = args;
    seen.bytes = options?.input;
  };
  const readEntry = async (id) => (id === 10 ? { superseded_by: 99 } : { body });
  const result = await archiveOne({ row, run, readEntry });
  assert.equal(result.newId, 99);
  const args = seen.args;
  assert.deepEqual(args, [
    'supersede', '--id', '10', '--title', 'ARCHIVED: Сводка',
    '--body-file', '-',
    '--links', JSON.stringify({ track: 'svod-windows', status: 'archived' }),
    '--no-open-work',
    '--session', process.env.MEMORYCTL_SESSION_ID || 'archive-handoff',
    '--agent', process.env.MEMORYCTL_AGENT_ID || 'archive-handoff',
  ]);
  assert.equal(seen.bytes, body); // byte for byte, trailing newline kept
});

test('archiveOne never follows a symlink at the former predictable temp path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-handoff-symlink-'));
  const target = path.join(dir, 'untouched');
  const row = handoff({ id: 987654321, body: 'private archive body\n' });
  const formerPath = path.join(os.tmpdir(), `archive-handoff-${process.pid}-${row.id}.md`);
  fs.writeFileSync(target, 'untouched');
  fs.symlinkSync(target, formerPath);
  try {
    await archiveOne({
      row, run: () => {},
      readEntry: async id => id === row.id ? { superseded_by: 99 } : { body: row.body },
    });
    assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
    assert.ok(fs.lstatSync(formerPath).isSymbolicLink());
  } finally {
    fs.rmSync(formerPath, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveOne fails loud when the readback body differs', async () => {
  const row = handoff({ body: 'оригинал\n' });
  const readEntry = async (id) => (id === 10 ? { superseded_by: 99 } : { body: 'переписано\n' });
  await assert.rejects(archiveOne({ row, run: () => {}, readEntry }), /SHA-256 mismatch/);
});

test('archiveOne fails when supersede left no successor', async () => {
  const readEntry = async () => ({ superseded_by: null });
  await assert.rejects(archiveOne({ row: handoff(), run: () => {}, readEntry }), /no successor/);
});

test('dry-run runs nothing and reads nothing', async () => {
  let ran = 0;
  const result = await archiveOne({
    row: handoff(),
    dryRun: true,
    run: () => { ran += 1; },
    readEntry: async () => { throw new Error('dry-run must not read the service'); },
  });
  assert.equal(ran, 0);
  assert.equal(result.dryRun, true);
});
