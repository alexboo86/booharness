// retire-lesson transport safety: the retire write must reach memoryctl over
// stdin (--body-file -) — never through a predictable temp file that a planted
// symlink could redirect — and the capped title must never split a Unicode
// code point. The script has no exports by design; these tests drive it
// in-process (query-busted import, so each run executes) against a fake
// memoryd (MEMORYCTL_URL) and a fake memoryctl first on PATH. The live memory
// service is never touched, and a pre-check that the fake binary wins PATH
// resolution keeps a failed run from reaching process.exit in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { REPO_ROOT, resolveMemoryctl } from './lesson-lib.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'retire-lesson.mjs');

const lesson = (over = {}) => ({
  id: 10,
  kind: 'lesson',
  superseded_by: null,
  title: 'dup of #469',
  body: 'private retire body\n',
  links: JSON.stringify({ domain: 'domain-harness', anchor: 'scripts/memory/lesson-lib.mjs', status: 'active' }),
  ...over,
});

/** Run one retire exactly as the CLI does: fake service, fake memoryctl, swapped argv. */
let importCount = 0;
async function runRetire({ args, row, plant }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-lesson-test-'));
  const fakeBin = path.join(dir, 'memoryctl');
  const fakeMain = path.join(dir, 'fake-memoryctl.mjs');
  const log = path.join(dir, 'memoryctl.json');
  fs.writeFileSync(fakeMain, `import fs from 'node:fs';
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* empty pipe */ }
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
`);
  // A bash wrapper, like the real memoryctl: on win32 lesson-lib starts every
  // `#!` script through Git bash, which would read a node shebang file as bash.
  const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(fakeBin, `#!/usr/bin/env bash\nexec ${sq(process.execPath)} ${sq(fakeMain)} "$@"\n`);
  fs.chmodSync(fakeBin, 0o755);
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/memory/entries')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([row]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const saved = {
    argv: process.argv,
    path: process.env.PATH,
    tmp: { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP },
    url: process.env.MEMORYCTL_URL,
    log: process.env.FAKE_MEMORYCTL_LOG,
  };
  const logs = [];
  const wasLog = console.log;
  const wasErr = console.error;
  console.log = (line) => logs.push(line);
  console.error = (line) => logs.push(line);
  let result;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    process.env.MEMORYCTL_URL = `http://127.0.0.1:${server.address().port}`;
    // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on win32.
    for (const key of Object.keys(saved.tmp)) process.env[key] = dir;
    assert.equal(fs.realpathSync(os.tmpdir()), fs.realpathSync(dir), 'os.tmpdir() must point at the scratch dir');
    process.env.PATH = `${dir}${path.delimiter}${saved.path ?? ''}`;
    process.env.FAKE_MEMORYCTL_LOG = log;
    process.argv = [saved.argv[0], SCRIPT, ...args];
    assert.equal(resolveMemoryctl(REPO_ROOT), fakeBin, 'fake memoryctl must win PATH resolution');
    if (plant) plant(dir);
    importCount += 1;
    await import(`${pathToFileURL(SCRIPT).href}?run=${importCount}`);
    result = { recorded: JSON.parse(fs.readFileSync(log, 'utf8')), logs, dir };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    console.log = wasLog;
    console.error = wasErr;
    process.argv = saved.argv;
    process.env.PATH = saved.path;
    for (const [key, value] of Object.entries(saved.tmp)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (saved.url === undefined) delete process.env.MEMORYCTL_URL; else process.env.MEMORYCTL_URL = saved.url;
    if (saved.log === undefined) delete process.env.FAKE_MEMORYCTL_LOG; else process.env.FAKE_MEMORYCTL_LOG = saved.log;
    await new Promise((resolve) => server.close(resolve));
  }
  return result;
}

test('a planted symlink at the former predictable temp name is not followed', async () => {
  const planted = {};
  const { recorded, logs, dir } = await runRetire({
    args: ['--id', '10', '--reason', 'dup'],
    row: lesson(),
    plant: (scratch) => {
      const target = path.join(scratch, 'untouched');
      fs.writeFileSync(target, 'untouched');
      const name = path.join(scratch, `retire-lesson-${process.pid}-10.md`);
      fs.symlinkSync(target, name);
      planted.target = target;
      planted.name = name;
    },
  });
  try {
    assert.match(logs.join('\n'), /retire: 1 of 1/);
    const target = fs.readFileSync(planted.target, 'utf8');
    assert.equal(target, 'untouched', `the symlink was followed and wrote: ${JSON.stringify(target.slice(0, 80))}`);
    assert.ok(fs.lstatSync(planted.name).isSymbolicLink(), 'the planted symlink must survive untouched');
    // The retire still happened, through memoryctl stdin, not a temp file.
    const bodyFile = recorded.argv[recorded.argv.indexOf('--body-file') + 1];
    assert.equal(bodyFile, '-');
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(recorded.stdin, `private retire body\n- retired: dup (${day})\n`);
    assert.equal(JSON.parse(recorded.argv[recorded.argv.indexOf('--links') + 1]).status, 'retired');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a title whose 480-unit cut point lands inside an emoji keeps it whole', async () => {
  const head = 'RETIRED: dup — '; // the exact head retire-lesson builds for --reason dup
  const row = lesson({ id: 11, title: `${'a'.repeat(479 - head.length)}😀tail` });
  const { recorded, logs, dir } = await runRetire({ args: ['--id', '11', '--reason', 'dup'], row });
  try {
    assert.match(logs.join('\n'), /retire: 1 of 1/);
    const capped = recorded.argv[recorded.argv.indexOf('--title') + 1];
    assert.ok(typeof capped === 'string' && capped.length > 0, 'supersede received a title');
    assert.ok(capped.endsWith('😀'), `title tail is split: ${JSON.stringify(capped.slice(-6))}`);
    assert.ok(!capped.includes('\uFFFD'), 'a split surrogate reached the CLI as U+FFFD');
    assert.equal(Buffer.from(capped, 'utf8').toString('utf8'), capped, 'a lone surrogate does not survive UTF-8');
    assert.ok([...capped].length <= 480, 'the cap still holds');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
