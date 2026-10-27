// A decision append posts straight to memoryd: no client-side same-topic judge
// and no candidate search (decision #12433). --overturns still reaches the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../jev-test-state.mjs';

test('CLI decision append posts once with overturns; --same-topic-ok is no longer a flag', async () => {
  const home = mkdtempSync(join(tmpdir(), 'decision-cli-'));
  writeFileSync(join(home, 'token'), 'test-token');
  const seen = [];
  const bodies = [];
  const server = createServer(async (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(raw);
    res.end('{"id":99}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cli = fileURLToPath(new URL('../../.claude/scripts/memoryctl', import.meta.url));
  const env = { ...process.env, MEMORYCTL_URL: `http://127.0.0.1:${server.address().port}`,
    MEMORYCTL_TOKEN_FILE: join(home, 'token'), MEMORYCTL_AUTOSTART: '0' };
  const run = args => new Promise(resolve => {
    const child = spawn('bash', [cli, 'append', '--kind', 'decision', '--title', 'Backups', '--body', 'new policy', ...args], { env });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('close', code => resolve({ code, out, err }));
  });
  try {
    const removed = await run(['--same-topic-ok', 'Backup scope differs']);
    assert.notEqual(removed.code, 0);
    assert.equal(seen.length, 0);
    const allowed = await run(['--overturns', '42']);
    assert.equal(allowed.code, 0, allowed.err);
    assert.deepEqual(seen, ['POST /api/memory/append']);
    const payload = JSON.parse(bodies[0]);
    assert.equal(payload.kind, 'decision');
    assert.deepEqual(payload.overturns, [42]);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
