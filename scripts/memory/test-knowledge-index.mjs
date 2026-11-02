// The derived corpus has its own Git/file lifecycle; existing store tests only own memory.db.
import '../jev-test-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { rebuildKnowledgeIndex, knowledgeIndexCommit } from '../../ops/bootstrap/knowledge-page-lib.mjs';
import { openMemoryDb, createMemory, knowledgeResults } from './store.mjs';
import { scrubbedGitEnv } from '../git-env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const page = '.agents/domains/domain-fixture/knowledge.md';
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'knowledge-index-'));
  const resources = [];
  t.after(() => { for (const resource of resources) resource.close(); rmSync(directory, { recursive: true, force: true }); });
  const repoRoot = path.join(directory, 'repo');
  mkdirSync(repoRoot);
  const git = (...args) => execFileSync('git', ['-C', repoRoot, '-c', 'user.name=Knowledge test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${directory}/no-hooks`, ...args], { encoding: 'utf8', env: scrubbedGitEnv() }).trim();
  git('init', '-q', '-b', 'master');
  const write = (file, text) => { mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true }); writeFileSync(path.join(repoRoot, file), text); };
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const indexPath = path.join(directory, 'installed', 'scripts', 'memory', 'knowledge.sqlite');
  const rebuild = () => rebuildKnowledgeIndex({ repoRoot, indexPath });
  return { directory, repoRoot, indexPath, git, write, commit, rebuild, resources };
}

test('committed preambles and fenced sections split losslessly; dirty/seat pages never enter the index', (t) => {
  const f = fixture(t);
  const body = 'Workspace durable unicode 💾\n\n'.repeat(200);
  f.write(page, '# Fixture\n\nPreamble archivist.\n\n```md\n## Not a section\n```\n\n## Workspace\n\n' + body);
  const sha = f.commit();
  f.write(page, '# Dirty\n\n## Uncommitted\n\ncontamination\n');
  assert.equal(f.rebuild().ok, true);
  const db = new DatabaseSync(f.indexPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM knowledge ORDER BY rowid').all();
    assert.deepEqual([...new Set(rows.map((r) => r.heading))], ['Fixture', 'Workspace']);
    assert.equal(rows.filter((r) => r.heading === 'Workspace').map((r) => r.body).join(''), '## Workspace\n\n' + body);
    assert.ok(rows.every((r) => Buffer.byteLength(`${r.path}#${r.heading}\n${r.body}`) <= 1800 && r.source_commit === sha));
  } finally { db.close(); }
  const hits = knowledgeResults(f.indexPath, 'durable unicode');
  assert.equal(hits.length, 1, 'multiple passages must not occupy all three section slots');
  assert.equal(hits[0].title, `${page}#Workspace`);
  assert.equal(knowledgeResults(f.indexPath, 'archivist')[0].heading, 'Fixture');
  assert.deepEqual(knowledgeResults(f.indexPath, 'contamination'), []);
  const before = statSync(f.indexPath).mtimeMs;
  assert.equal(f.rebuild().changed, false);
  assert.equal(statSync(f.indexPath).mtimeMs, before);
  f.git('checkout', '-qb', 'seat');
  f.commit();
  assert.equal(f.rebuild().changed, false);
  assert.equal(knowledgeIndexCommit(f.indexPath), sha);
});

test('a master landing without domain content changes does not rebuild the index', (t) => {
  const f = fixture(t);
  f.write(page, '# Fixture\n\n## Stable\n\nunchangedcontent\n');
  const indexed = f.commit();
  assert.equal(f.rebuild().ok, true);
  const bytes = readFileSync(f.indexPath);
  const before = statSync(f.indexPath);
  f.write('unrelated.txt', 'a landing outside the domain tree\n');
  assert.notEqual(f.commit(), indexed);
  assert.equal(f.rebuild().changed, false);
  assert.deepEqual(readFileSync(f.indexPath), bytes);
  assert.equal(statSync(f.indexPath).mtimeMs, before.mtimeMs);
  assert.equal(knowledgeIndexCommit(f.indexPath), indexed);
  assert.equal(knowledgeResults(f.indexPath, 'unchangedcontent').length, 1);
});

test('invalid domain names and malformed pages do not prevent healthy pages being searched', (t) => {
  const f = fixture(t);
  f.write(page, '# Fixture\n\n## Healthy\n\nsearchablecontent\n');
  const invalid = '.agents/domains/domain--bad/knowledge.md';
  const malformed = '.agents/domains/domain-malformed/knowledge.md';
  const oversized = '.agents/domains/domain-oversized/knowledge.md';
  f.write(invalid, '# Invalid\n\ninvalidcontent\n');
  f.write(malformed, '# Malformed\n\n<!-- knowledge:toc -->\nnot a TOC entry\n');
  f.write(oversized, '# Oversized\n\n## First\n\npartialcontent\n\n## ' + 'x'.repeat(1800) + '\n\noversizedcontent\n');
  f.commit();
  const logs = [];
  const result = rebuildKnowledgeIndex({ repoRoot: f.repoRoot, indexPath: f.indexPath, log: (line) => logs.push(line) });
  assert.equal(result.ok, true);
  assert.equal(knowledgeResults(f.indexPath, 'searchablecontent').length, 1);
  for (const query of ['invalidcontent', 'partialcontent', 'oversizedcontent']) {
    assert.deepEqual(knowledgeResults(f.indexPath, query), []);
  }
  assert.equal(logs.length, 3);
  for (const file of [invalid, malformed, oversized]) {
    assert.equal(logs.filter((line) => line.includes(file) && !line.includes('\n')).length, 1);
  }
});

test('garbage index bytes heal on the next rebuild even when master has not changed', (t) => {
  const f = fixture(t);
  f.write(page, '# Fixture\n\n## Recovered\n\nrecoveredcontent\n');
  const sha = f.commit();
  assert.equal(f.rebuild().ok, true);
  writeFileSync(f.indexPath, 'not a SQLite database');
  const rebuilt = f.rebuild();
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.changed, true);
  assert.equal(knowledgeIndexCommit(f.indexPath), sha);
  assert.equal(knowledgeResults(f.indexPath, 'recoveredcontent')[0].source_commit, sha);
  assert.deepEqual(readdirSync(path.dirname(f.indexPath)), ['knowledge.sqlite']);
});

test('an index from other builder code or a legacy schema rebuilds even when master has not changed', (t) => {
  const f = fixture(t);
  f.write(page, '# Fixture\n\n## Builder\n\nbuildercontent\n');
  f.commit();
  assert.equal(f.rebuild().ok, true);
  assert.equal(f.rebuild().changed, false);
  const edit = (sql) => { const db = new DatabaseSync(f.indexPath); db.exec(sql); db.close(); };
  edit("UPDATE source SET builder = 'other builder code'");
  assert.equal(f.rebuild().changed, true);
  edit('ALTER TABLE source DROP COLUMN builder');
  assert.equal(f.rebuild().changed, true);
  assert.equal(f.rebuild().changed, false);
});

test('master landing replaces removed sections; failed rebuild logs once and retains the old single file', (t) => {
  const f = fixture(t);
  for (const file of ['ops/bootstrap/install-memory.mjs', 'ops/backup-memory.mjs', 'scripts/git-env.mjs', 'scripts/lib/harness-config.mjs', 'scripts/lib/memory-forward.mjs', 'scripts/lib/memory-installer.mjs', 'ops/bootstrap/harness.config.json', 'ops/bootstrap/knowledge-page-lib.mjs', 'scripts/lib/domain-of.mjs']) {
    mkdirSync(path.dirname(path.join(f.repoRoot, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(f.repoRoot, file));
  }
  f.write('docs/agent/domain-routing.generated.json', '{}\n');
  f.write(page, '# Fixture\n\n## Removed\n\nobsoletecontent\n');
  f.commit();
  const env = { ...scrubbedGitEnv(), MEMORYCTL_HOME: path.join(f.directory, 'home'), MEMORYCTL_STATE_DIR: path.join(f.directory, 'state'), MEMORYCTL_SERVICE_DIR: path.dirname(f.indexPath) };
  const hook = () => spawnSync(process.execPath, [path.join(f.repoRoot, 'ops/bootstrap/install-memory.mjs'), '--landed-map'], { encoding: 'utf8', env });
  assert.equal(hook().status, 0);
  assert.equal(knowledgeResults(f.indexPath, 'obsoletecontent').length, 1);
  f.write(page, '# Fixture\n\n## Current\n\nreplacementcontent\n');
  const sha = f.commit();
  const second = hook();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(knowledgeIndexCommit(f.indexPath), sha);
  assert.deepEqual(knowledgeResults(f.indexPath, 'obsoletecontent'), []);
  assert.equal(knowledgeResults(f.indexPath, 'replacementcontent')[0].source_commit, sha);
  const bytes = readFileSync(f.indexPath);
  // Malformed pages are now isolated, not whole-rebuild failures. An unavailable
  // source repository still exercises global failure retention at the builder.
  const logs = [];
  const failed = rebuildKnowledgeIndex({ repoRoot: path.join(f.directory, 'missing-repo'), indexPath: f.indexPath, log: (line) => logs.push(line) });
  assert.equal(failed.ok, false);
  assert.equal(logs.filter((line) => line.startsWith('knowledge index rebuild failed:')).length, 1);
  assert.deepEqual(readFileSync(f.indexPath), bytes);
  assert.deepEqual(readdirSync(path.dirname(f.indexPath)), ['knowledge.sqlite']);
  // A directory at the index path makes the publish rename fail inside the hook.
  rmSync(f.indexPath);
  mkdirSync(f.indexPath);
  f.write(page, '# Fixture\n\n## Later\n\nlatercontent\n');
  f.commit();
  const landed = hook();
  assert.equal(landed.status, 0, 'a failed knowledge rebuild cannot fail the landing');
  assert.equal(landed.stderr.split('\n').filter((line) => line.includes('knowledge index rebuild failed')).length, 1, landed.stderr);
});

test('knowledge envelope leaves entry JSON, ids, ranking and memory.db schema unchanged', async (t) => {
  const f = fixture(t);
  f.write(page, '# Fixture\n\n## Workspace\n\nworkspace fact knowledgeonly\n');
  f.commit();
  assert.equal(f.rebuild().ok, true);
  const previous = process.env.MEMORYCTL_KNOWLEDGE_INDEX;
  process.env.MEMORYCTL_KNOWLEDGE_INDEX = f.indexPath;
  t.after(() => { if (previous === undefined) delete process.env.MEMORYCTL_KNOWLEDGE_INDEX; else process.env.MEMORYCTL_KNOWLEDGE_INDEX = previous; });
  const state = path.join(f.directory, 'memory');
  const db = openMemoryDb(state);
  f.resources.push(db);
  const tokenPath = path.join(state, 'memory.token');
  const memory = createMemory({ db, tokenPath });
  const request = (route, body) => {
    let text, status;
    const res = { writeHead(code) { status = code; }, end(value) { text = value; } };
    memory.handle({ method: body ? 'POST' : 'GET', headers: { 'x-memory-token': readFileSync(tokenPath, 'utf8').trim() } }, res, new URL(route, 'http://fixture'), JSON.stringify(body ?? {}));
    assert.equal(status, 200, text);
    return text;
  };
  request('/api/memory/append', { kind: 'reference', title: 'workspace alpha', body: 'workspace fixture' });
  request('/api/memory/append', { kind: 'reference', title: 'workspace beta', body: 'workspace fixture extra' });
  const query = '/api/memory/search?q=%22workspace%22';
  const before = request(query);
  const answer = JSON.parse(request(query + '&knowledge=1'));
  assert.equal(JSON.stringify(answer.results), before);
  assert.equal(answer.knowledge[0].title, `${page}#Workspace`);
  assert.equal(request(query), before);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'knowledge%'").get().n, 0);
  const server = createServer((req, res) => memory.handle(req, res, new URL(req.url, 'http://fixture'), ''));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, MEMORYCTL_URL: `http://127.0.0.1:${server.address().port}` };
  const run = (file, args, input = '', command = process.execPath) => new Promise((resolve, reject) => {
    const child = execFile(command, [path.join(root, file), ...args], { env }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(input);
  });
  try {
    const cli = JSON.parse(await run('.claude/scripts/memoryctl', ['search', '"knowledgeonly"'], '', 'bash'));
    assert.deepEqual(cli.results, []);
    assert.equal(cli.knowledge[0].title, `${page}#Workspace`);
    // Empty entry pool deliberately exercises deep-search without calling a model.
    const deep = JSON.parse(await run('scripts/memory/deep-search.mjs', ['"knowledgeonly"', '--json']));
    assert.deepEqual(deep.results, []);
    assert.equal(deep.knowledge[0].title, `${page}#Workspace`);
    const wire = await run('scripts/memory/mcp-server.mjs', [], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory', arguments: { action: 'search', args: { query: '"knowledgeonly"' } } } }) + '\n');
    const mcp = JSON.parse(JSON.parse(wire).result.content[0].text);
    assert.deepEqual(mcp.results, []);
    assert.equal(mcp.knowledge[0].title, `${page}#Workspace`);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
