import '../jev-test-state.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, '../..');
const longBody = `## Historical lesson\n- anchor: scripts/memory/lesson-quality.mjs\n- rule: ${'R'.repeat(520)}\n- why: Y\n- evidence: Z\n- date: 2026-09-23\n`;

// A live-memory-shaped GET endpoint, but no mutation of the NAS. Every tool
// below runs unchanged and calls the real source CLI through PATH.
test('maintenance, retirement and capture honor the lesson write gate', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-maintenance-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const client = join(repo, '.claude/scripts/memoryctl');
  const shim = join(bin, 'memoryctl');
  writeFileSync(shim, `#!/bin/sh\nexec bash "${client}" "$@"\n`, { mode: 0o755 });
  const token = join(dir, 'memory.token');
  writeFileSync(token, 'test-token\n');
  let row;
  const posts = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/api/memory/entries')) return res.end(JSON.stringify([row]));
    if (req.url?.startsWith('/api/memory/entry?')) return res.end(JSON.stringify(row));
    if (req.method === 'POST' && ['/api/memory/supersede', '/api/memory/append'].includes(req.url)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return res.end(JSON.stringify({ id: 100, version: 2 }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, HOME: dir, MEMORYCTL_URL: `http://127.0.0.1:${server.address().port}`,
    MEMORYCTL_TOKEN_FILE: token, MEMORYCTL_AUTOSTART: '0', TYPESAFE_API_KEY: '', PATH: `${bin}:${process.env.PATH}` };
  try {
    const cases = [
      ['promote', 'domain-harness', '--id', '99'],
      ['reanchor', '--id', '99', '--to', 'scripts/memory/test-capture-lesson.mjs'],
      ['normalize'],
      ['retire', '--id', '99', '--reason', 'obsolete'],
    ];
    for (const [name, ...args] of cases) {
      const status = name === 'promote' ? 'inbox' : 'active';
      const domain = name === 'normalize' ? 'harness' : 'domain-harness';
      const links = { domain, status, anchor: 'scripts/memory/lesson-quality.mjs', globs: [] };
      row = { id: 99, uuid: 'legacy-lesson', version: 1, ts: Date.now(), kind: 'lesson',
        title: 'Historical lesson', body: longBody, links: JSON.stringify(links), superseded_by: null,
        content_hash: createHash('sha256').update(longBody).digest('hex') };
      posts.length = 0;
      const script = name === 'normalize' ? 'normalize-lesson-domains.mjs' : `${name}-lesson.mjs`;
      let output;
      // A move (reanchor, normalize) runs the capture gate, whose Jev duplicate
      // question is answered locally; the other tools still run with no Jev at all.
      const moves = name === 'reanchor' || name === 'normalize';
      const caseEnv = moves ? { ...env, TYPESAFE_API_KEY: 'fixture-key',
        NODE_OPTIONS: `--import ${pathToFileURL(join(repo, 'scripts/memory/jev-fetch-stub.mjs')).href}` } : env;
      try { output = await run(process.execPath, [join(repo, 'scripts/memory', script), ...args], { cwd: repo, env: caseEnv, timeout: 15000 }); }
      catch (error) { assert.fail(`${name}: ${error.stdout || ''} ${error.stderr || error.message}`); }
      assert.equal(posts.length, 1, `${name}: expected one supersede; stdout=${output.stdout} stderr=${output.stderr}`);
      assert.match(posts[0].body, /- rule: R{520}/);
      if (moves) assert.equal(posts[0].links.gate.v, 1, `${name}: the move carries a fresh gate marker`);
    }

    const supersede = (title, body, links, extra = []) => run(join(bin, 'memoryctl'), [
      'supersede', '--id', '99', '--title', title, '--body', body,
      '--links', JSON.stringify(links), ...extra,
    ], { cwd: repo, env, timeout: 15000 });
    const retiredLinks = { ...JSON.parse(row.links), status: 'retired' };
    const retiredTitle = 'RETIRED: obsolete — Historical lesson';
    posts.length = 0;
    await assert.rejects(supersede(retiredTitle, `${longBody}\n- rule: ${'S'.repeat(900)}`, retiredLinks), /rule is duplicated/);
    assert.equal(posts.length, 0, 'retirement must refuse a newly duplicated field before POST');
    await assert.rejects(supersede(retiredTitle,
      longBody.replace('R'.repeat(520), 'S'.repeat(900)), retiredLinks), /rule: 900 chars \/ 300/);
    assert.equal(posts.length, 0, 'retirement must judge the changed body before POST');

    const unchanged = await supersede('Historical lesson', longBody, JSON.parse(row.links), ['--long', 'not needed']);
    assert.match(unchanged.stderr, /--long ignored; no lesson field changed/);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body, longBody, 'no --long marker when no field changed');

    const links = { domain: 'domain-harness', anchor: 'scripts/memory/lesson-quality.mjs', status: 'active', globs: [] };
    for (const [trigger, evidence, message] of [
      ['', 'ABC1234', '--trigger is required'],
      ['?', 'ABC1234', '--trigger is required'],
      ['When capturing', 'prose only', '--evidence carries none'],
      ['When capturing', 'git, status', '--evidence carries none'],
      ['When capturing', 'node;rm file', '--evidence carries none'],
      ['When capturing', 'mentions node in prose', '--evidence carries none'],
      ['When capturing', 'node', '--evidence carries none'],
    ]) {
      const body = `- trigger: ${trigger}\n- rule: Check writes\n- why: Prevents bad lessons\n- evidence: ${evidence}`;
      for (const [command, args] of [
        [join(bin, 'memoryctl'), ['append', '--kind', 'lesson', '--title', 'Refuse invalid', '--body', body, '--links', JSON.stringify(links)]],
        [process.execPath, [join(repo, 'scripts/memory/capture-lesson.mjs'), 'harness', 'Refuse invalid',
          '--anchor', links.anchor, '--trigger', trigger, '--rule', 'Check writes', '--why', 'Prevents bad lessons', '--evidence', evidence]],
      ]) {
        await t.test(`${command}: ${JSON.stringify(trigger)} / ${evidence}`, async () => {
          posts.length = 0;
          await assert.rejects(run(command, args, { cwd: repo, env, timeout: 15000 }),
            error => error.stderr.includes(message));
          assert.equal(posts.length, 0, `${command}: invalid lesson must never POST`);
        });
      }
    }
    for (const body of [
      longBody + '- trigger: ?\n',
      longBody.replace('- evidence: Z', '- evidence: prose only'),
    ]) {
      await t.test(`supersede: ${body}`, async () => {
        posts.length = 0;
        await assert.rejects(supersede('Historical lesson', body, links), /--trigger is required|--evidence carries none/);
        assert.equal(posts.length, 0, 'newly authored invalid fields must never POST');
      });
    }
    posts.length = 0;
    await run(join(bin, 'memoryctl'), ['append', '--kind', 'lesson', '--title', 'Uppercase SHA',
      '--body', '- trigger: When capturing\n- rule: Check writes\n- why: Prevents bad lessons\n- evidence: ABC1234',
      '--links', JSON.stringify(links)], { cwd: repo, env, timeout: 15000 });
    assert.equal(posts.length, 1, 'uppercase SHA is reproducible evidence');
    posts.length = 0;
    await run(process.execPath, [join(repo, 'scripts/memory/capture-lesson.mjs'), 'harness', 'Uppercase SHA',
      '--anchor', links.anchor, '--trigger', 'When writing', '--rule', 'Check writes',
      '--why', 'Prevents bad lessons', '--evidence', 'ABC1234'], { cwd: repo, env, timeout: 15000 });
    assert.equal(posts.length, 1, 'capture accepts uppercase SHA evidence');

    // Capture gates enforce brevity ceilings before POST; duplicates are the weekly routine's job.
    // The CLI retains its own brevity check. The accepted --long reason survives.
    const countFile = join(dir, 'jev-calls');
    const stub = join(dir, 'jev-stub.mjs');
    writeFileSync(stub, `import { appendFileSync } from 'node:fs';\nconst original = globalThis.fetch;\nglobalThis.fetch = (url, options) => {\n  if (!String(url).includes('api.typesafe.ai')) return original(url, options);\n  appendFileSync(${JSON.stringify(countFile)}, 'call\\n');\n  const questions = JSON.parse(options.body).questions;\n  return Promise.resolve(new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map(k => [k, { noul: k === 'duplicate' ? 0.1 : 0.9 }])) }), { status: 200 }));\n};\n`);
    posts.length = 0;
    const captured = await run(process.execPath, [join(repo, 'scripts/memory/capture-lesson.mjs'),
      'harness', 'One short rule', '--anchor', 'scripts/memory/lesson-quality.mjs',
      '--trigger', 'When a lesson is captured', '--rule', 'R'.repeat(150), '--why', 'Prevents Y',
      '--evidence', 'scripts/memory/lesson-quality.mjs', '--long', 'Why this detail is useful'],
    { cwd: repo, env: { ...env, TYPESAFE_API_KEY: 'test-key', NODE_OPTIONS: `--import=${stub}` }, timeout: 15000 });
    assert.match(captured.stdout, /captured/);
    // No Jev question remains at capture: brevity is deterministic and the duplicate question is gone (#12433).
    assert.equal(existsSync(countFile), false);
    assert.equal(posts.length, 1);
    assert.match(posts[0].body, /- long: "Why this detail is useful"/);
    assert.equal(posts[0].links.status, 'active');

    posts.length = 0;
    const corrected = await run(process.execPath, [join(repo, 'scripts/memory/capture-lesson.mjs'),
      'platform-shell', 'Bad route', '--anchor', 'scripts/memory/lesson-quality.mjs',
      '--trigger', 'When a lesson is captured', '--rule', 'Reject a bad route', '--why', 'Wrong domain',
      '--evidence', 'scripts/memory/lesson-quality.mjs'],
    { cwd: repo, env: { ...env, TYPESAFE_API_KEY: 'test-key', NODE_OPTIONS: `--import=${stub}` }, timeout: 15000 });
    assert.match(corrected.stdout, /domain platform-shell -> domain-harness: routed for scripts\/memory\/lesson-quality\.mjs/);
    assert.equal(posts.length, 1, 'new capture posts after routing correction');
    assert.equal(posts[0].links.domain, 'domain-harness');

    // A direct CLI append uses the same new-capture mode, never bypassing routing.
    posts.length = 0;
    const direct = await run(join(bin, 'memoryctl'), ['append', '--kind', 'lesson', '--title', 'Direct bypass',
      '--body', '- trigger: When writing\n- rule: Reject unverified writes\n- why: Prevents lost knowledge\n- evidence: #12333',
      '--links', JSON.stringify({ domain: 'domain-platform-shell', anchor: 'scripts/memory/lesson-quality.mjs', status: 'active', globs: [] })],
    { cwd: repo, env: { ...env, TYPESAFE_API_KEY: 'test-key', NODE_OPTIONS: `--import=${stub}` }, timeout: 15000 });
    assert.match(direct.stderr, /domain domain-platform-shell -> domain-harness: routed for scripts\/memory\/lesson-quality\.mjs/);
    assert.equal(posts.length, 1, 'direct CLI posts only the routed lesson');
    assert.equal(posts[0].links.domain, 'domain-harness');
  } finally { await new Promise(done => server.close(done)); rmSync(dir, { recursive: true, force: true }); }
});
