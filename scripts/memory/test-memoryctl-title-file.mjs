import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../jev-test-state.mjs';

const cli = fileURLToPath(new URL('../../.claude/scripts/memoryctl', import.meta.url));

test('memoryctl title-file preserves multiline titles through append and supersede, including trailing LF', async () => {
  const home = mkdtempSync(join(tmpdir(), 'memoryctl-title-'));
  const titleFile = join(home, 'title.txt');
  const title = '--Title\nsecond line\n';
  writeFileSync(titleFile, title);
  writeFileSync(join(home, 'token'), 'test-token');
  const posts = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(req.url.startsWith('/api/memory/search') ? '[]' : JSON.stringify({ kind: 'lesson', title: 'Before', body: '- rule: old\n- why: old\n- evidence: old', links: { domain: 'domain-harness', anchor: '.claude/scripts/memoryctl:usage', status: 'active' } }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    posts.push(JSON.parse(body));
    res.end('{"id":99}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, MEMORYCTL_URL: `http://127.0.0.1:${server.address().port}`,
    MEMORYCTL_TOKEN_FILE: join(home, 'token'), MEMORYCTL_AUTOSTART: '0' };
  const run = args => new Promise(resolve => {
    const child = spawn('bash', [cli, ...args], { env });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stderr }));
  });
  try {
    for (const args of [
      ['append', '--kind', 'project', '--title-file', titleFile, '--body', 'project body'],
      ['append', '--kind', 'decision', '--title-file', titleFile, '--body', 'decision body'],
      ['supersede', '--id', '99', '--title-file', titleFile, '--body', '- rule: new\n- why: new\n- evidence: new', '--links', JSON.stringify({ domain: 'domain-harness', anchor: '.claude/scripts/memoryctl:usage', status: 'active' })],
    ]) {
      const result = await run(args);
      assert.equal(result.code, 0, result.stderr);
    }
    assert.deepEqual(posts.map(post => post.title), [title, title, title]);
    assert.deepEqual(posts.map(post => post.body), ['project body', 'decision body', '- rule: new\n- why: new\n- evidence: new']);
    writeFileSync(titleFile, Buffer.from([65, 0, 66]));
    const invalid = await run(['append', '--kind', 'project', '--title-file', titleFile, '--body', 'x']);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /NUL bytes/);
    assert.equal(posts.length, 3, 'invalid title cannot write');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
