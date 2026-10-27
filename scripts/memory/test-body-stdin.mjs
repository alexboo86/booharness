#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './lesson-lib.mjs';

const body = '- rule: private body 😀\n  second line\n- why: Preserve transport bytes.\n- evidence: scripts/memory/lesson-lib.mjs\n';
const row = { id: 10, kind: 'lesson', superseded_by: null, title: 'Transport lesson', body,
  links: JSON.stringify({ domain: 'domain-harness', anchor: 'scripts/memory/lesson-lib.mjs', status: 'inbox' }) };
const capture = { domain: 'harness', title: row.title, anchor: 'scripts/memory/lesson-lib.mjs',
  trigger: 'writing a lesson', rule: 'Preserve body bytes.', why: 'Avoid filesystem handoffs.',
  evidence: 'scripts/memory/lesson-lib.mjs', date: '2026-10-23' };
const url = name => pathToFileURL(path.join(REPO_ROOT, 'scripts/memory', name)).href;

// Child processes isolate argv, PATH and temp variables, and let the fake HTTP
// service answer while a production runner blocks on memoryctl or the move gate.
async function runWriter(action, { plant = false, fail = null, row: rowOverride = null } = {}) {
  const effectiveRow = rowOverride ?? row;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'body-stdin-test-'));
  const log = path.join(dir, 'record.json');
  const target = path.join(dir, 'target');
  const fakeMain = path.join(dir, 'fake-memoryctl.mjs');
  fs.writeFileSync(target, 'untouched');
  // A failing memoryctl still records what it was given, then refuses on stderr
  // with exit 3: the writers must propagate both, not just the success path.
  // The refusal lives in the shared Node fake so both shims below carry it.
  const failTail = fail ? `process.stderr.write(${JSON.stringify(fail)});\nprocess.exit(3);\n` : '';
  fs.writeFileSync(fakeMain, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8')}));\n${failTail}`);
  const sq = value => `'${value.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(
    path.join(dir, 'memoryctl'),
    `#!/usr/bin/env bash\nexec ${sq(process.execPath)} ${sq(fakeMain)} "$@"\n`,
    { mode: 0o755 },
  );
  // reanchor's existing Windows runner invokes this shim through cmd.exe.
  fs.writeFileSync(path.join(dir, 'memoryctl.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-memoryctl.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET', 'no real or fake store writes are permitted');
    if (req.url.startsWith('/api/memory/entries')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([effectiveRow]));
    } else { res.writeHead(404); res.end(); }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const runner = path.join(dir, 'run.mjs');
    fs.writeFileSync(runner, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
assert.equal(fs.realpathSync(os.tmpdir()), fs.realpathSync(${JSON.stringify(dir)}));
const { resolveMemoryctl, REPO_ROOT } = await import(${JSON.stringify(url('lesson-lib.mjs'))});
assert.equal(resolveMemoryctl(REPO_ROOT), ${JSON.stringify(path.join(dir, 'memoryctl'))});
if (${plant}) {
  // Cover every millisecond in a bounded window, without replacing Date.now().
  const start = Date.now();
  try {
    for (let time = start; time <= start + 5000; time++) {
      fs.symlinkSync(${JSON.stringify(target)}, path.join(os.tmpdir(), 'capture-lesson-' + process.pid + '-' + time + '.md'));
    }
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      console.log('SYMLINK_PRIVILEGE_REQUIRED'); process.exit(0);
    }
    throw error;
  }
  assert.ok(Date.now() < start + 5000, 'symlink planting must leave time in the covered window');
}
if (${JSON.stringify(action)} === 'capture') {
  const { captureLesson } = await import(${JSON.stringify(url('capture-lesson.mjs'))});
  await captureLesson(${JSON.stringify(capture)});
} else if (${JSON.stringify(action)} === 'drain') {
  const { supersedeAccepted } = await import(${JSON.stringify(url('drain-inbox.mjs'))});
  supersedeAccepted(${JSON.stringify(effectiveRow)}, { ...JSON.parse(${JSON.stringify(effectiveRow.links)}), status: 'active' });
} else if (${JSON.stringify(action)} === 'promote') {
  const { promoteLessons } = await import(${JSON.stringify(url('promote-lesson.mjs'))});
  await promoteLessons({ arg: 'harness' });
} else {
  process.argv = [process.execPath, ${JSON.stringify(path.join(REPO_ROOT, 'scripts/memory/reanchor-lesson.mjs'))}, '--id', ${JSON.stringify(String(effectiveRow.id))}, '--to', 'scripts/memory/capture-lesson.mjs'];
  await import(${JSON.stringify(url('reanchor-lesson.mjs'))});
}
`);
    const child = spawn(process.execPath, [runner], { cwd: REPO_ROOT, env: { ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: dir, TEMP: dir, TMP: dir,
      MEMORYCTL_URL: `http://127.0.0.1:${server.address().port}` }, timeout: 60000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    return { dir, target, stdout, stderr, code, recorded: fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : null };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally { await new Promise(resolve => server.close(resolve)); }
}

for (const action of ['capture', 'drain', 'promote', 'reanchor']) {
  test(`${action} sends the complete body through memoryctl stdin`, async () => {
    const result = await runWriter(action);
    try {
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      const { argv, stdin } = result.recorded;
      assert.equal(argv[argv.indexOf('--body-file') + 1], '-');
      if (action === 'capture') {
        assert.equal(stdin, `## ${capture.title}\n- anchor: ${capture.anchor}\n- trigger: ${capture.trigger}\n- rule: ${capture.rule}\n- why: ${capture.why}\n- evidence: ${capture.evidence}\n- date: ${capture.date}\n\n`);
      } else if (action === 'reanchor') assert.equal(stdin, body);
      else {
        assert.ok(stdin.startsWith(body));
        assert.match(stdin.slice(body.length), /^- promoted: \d{4}-\d\d-\d\dT[^\n]+\n$/);
      }
    } finally { fs.rmSync(result.dir, { recursive: true, force: true }); }
  });
}

// A refused write must not look like a success: each writer exits non-zero and
// prints the refusal memoryctl printed (the store is the money path).
const REFUSAL = 'memoryctl refused: curator rejected this write';

for (const action of ['capture', 'drain', 'promote', 'reanchor']) {
  test(`${action} exits non-zero and prints the memoryctl refusal`, async () => {
    const result = await runWriter(action, { fail: REFUSAL });
    try {
      assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.ok(`${result.stdout}\n${result.stderr}`.includes(REFUSAL), `${result.stdout}\n${result.stderr}`);
    } finally { fs.rmSync(result.dir, { recursive: true, force: true }); }
  });
}

// Byte fidelity of a stored body is the pass-through writers' contract
// (capture composes its body from fields with hard size ceilings instead).
const crlfBody = '- rule: a body whose lines end with CR LF\r\n- why: the CR bytes must survive the pipe.\r\n- evidence: scripts/memory/lesson-lib.mjs\r\n';
const bigBody = `- rule: oversize ${'ф'.repeat(70_000)}\n- why: one body over 64 KiB, multibyte throughout.\n- evidence: scripts/memory/lesson-lib.mjs\n`;
assert.ok(Buffer.byteLength(bigBody) > 65536, 'the oversize body must actually exceed 64 KiB');

for (const [name, body] of [['CRLF line ends', crlfBody], ['over-64KiB body', bigBody]]) {
  for (const action of ['drain', 'promote', 'reanchor']) {
    test(`${action} transports a body with ${name} byte for byte`, async () => {
      const result = await runWriter(action, { row: { ...row, body } });
      try {
        assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
        const { stdin } = result.recorded;
        if (action === 'reanchor') assert.equal(stdin, body);
        else {
          assert.ok(stdin.startsWith(body));
          assert.match(stdin.slice(body.length), /^- promoted: \d{4}-\d\d-\d\dT[^\n]+\n$/);
        }
      } finally { fs.rmSync(result.dir, { recursive: true, force: true }); }
    });
  }
}

test('capture does not overwrite a target behind predictable temp-name symlinks', async t => {
  const result = await runWriter('capture', { plant: true });
  try {
    if (result.stdout.includes('SYMLINK_PRIVILEGE_REQUIRED')) {
      t.skip('win32 symlink creation requires privileges'); return;
    }
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.readFileSync(result.target, 'utf8'), 'untouched', 'capture followed a planted symlink');
    assert.equal(result.recorded.argv[result.recorded.argv.indexOf('--body-file') + 1], '-');
  } finally { fs.rmSync(result.dir, { recursive: true, force: true }); }
});
