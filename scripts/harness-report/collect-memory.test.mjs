import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { collect } from './collect-memory.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function metric(section, label) {
  return section.metrics.find((item) => item.label === label)?.value;
}

function health(section, label) {
  return section.health.find((item) => item.label === label);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const homeDir = path.join(root, 'home');
  const repoRoot = path.join(root, 'repo');
  const repositoryStorePath = path.join(repoRoot, 'scripts', 'memory', 'store.mjs');
  const installedStorePath = path.join(
    homeDir,
    '.local',
    'share',
    'acme',
    'scripts',
    'memory',
    'store.mjs',
  );
  const databasePath = path.join(homeDir, '.local', 'state', 'memoryctl', 'memory.db');

  await Promise.all([
    mkdir(path.dirname(repositoryStorePath), { recursive: true }),
    mkdir(path.dirname(installedStorePath), { recursive: true }),
    mkdir(path.dirname(databasePath), { recursive: true }),
    mkdir(path.join(repoRoot, 'src'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(repositoryStorePath, 'installed source\n'),
    writeFile(installedStorePath, 'installed source\n'),
    writeFile(path.join(repoRoot, 'src', 'live.mjs'), 'export {};\n'),
  ]);

  return { root, homeDir, repoRoot, repositoryStorePath, installedStorePath, databasePath };
}

function createDatabase(databasePath, now) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE mem_entries (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      superseded_by INTEGER,
      links TEXT NOT NULL
    );
    CREATE TABLE mem_tasks (
      id INTEGER PRIMARY KEY,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      claimed_by TEXT,
      depends_on TEXT NOT NULL
    );
    CREATE TABLE mem_task_handoffs (
      task_id INTEGER NOT NULL,
      entry_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (task_id, entry_id)
    );
  `);

  const insertEntry = db.prepare(
    'INSERT INTO mem_entries(id, ts, kind, superseded_by, links) VALUES (?, ?, ?, NULL, ?)',
  );
  const active = (domain, anchor) => JSON.stringify({ domain, anchor, globs: [], status: 'active' });
  insertEntry.run(1, now - DAY_MS, 'handoff', '{}');
  insertEntry.run(2, now - DAY_MS, 'feedback', '{}');
  insertEntry.run(3, now - DAY_MS, 'decision', '{}');
  insertEntry.run(4, now - DAY_MS, 'lesson', active('domain-a', 'src/live.mjs:export'));
  insertEntry.run(5, now - DAY_MS, 'lesson', active('domain-a', 'src/gone.mjs:export'));
  insertEntry.run(6, now - DAY_MS, 'lesson', active('domain-b', 'src/*.mjs'));
  insertEntry.run(7, now - DAY_MS, 'lesson', JSON.stringify({
    domain: 'domain-a',
    anchor: 'src/live.mjs',
    globs: [],
    status: 'inbox',
  }));
  insertEntry.run(8, now - (10 * DAY_MS), 'handoff', '{}');

  const insertTask = db.prepare(
    'INSERT INTO mem_tasks(id, priority, status, claimed_by, depends_on) VALUES (?, ?, ?, ?, ?)',
  );
  insertTask.run(1, 'P0', 'open', null, '[]');
  insertTask.run(2, 'P0', 'in_progress', null, '[]');
  insertTask.run(3, 'P1', 'open', 'member', '[]');
  insertTask.run(4, 'P2', 'open', null, '[1]');
  insertTask.run(5, 'P3', 'deferred', null, '[]');
  insertTask.run(6, 'P2', 'open', null, '[999]');
  insertTask.run(7, 'P1', 'done', null, '[]');
  db.close();
}

async function withHealthServer(fn) {
  const server = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'memoryctl' }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('returns a loud Section when every memory source is absent', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-memory-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const section = await collect({
    homeDir: root,
    repoRoot: root,
    serviceUrl: 'http://127.0.0.1:1',
    healthTimeoutMs: 100,
  });

  assert.deepEqual(Object.keys(section), ['id', 'title', 'health', 'metrics', 'rows', 'errors']);
  assert.equal(section.id, 'memory');
  assert.ok(section.errors.length >= 3);
  assert.equal(health(section, 'Memory service')?.status, 'fail');
  assert.equal(health(section, 'Installed service copy')?.status, 'fail');
  assert.equal(health(section, 'Memory database')?.status, 'fail');
});

test('collects windowed entries, canonical task readiness, and active lesson orphans', async (t) => {
  const paths = await fixture(t);
  const now = Date.UTC(2026, 7, 2, 12);
  createDatabase(paths.databasePath, now);
  const before = createHash('sha256').update(fs.readFileSync(paths.databasePath)).digest('hex');

  const section = await withHealthServer((serviceUrl) => collect({
    ...paths,
    serviceUrl,
    now,
    days: 7,
  }));

  assert.deepEqual(section.errors, []);
  assert.deepEqual(section.health.map(({ status }) => status), ['ok', 'ok', 'ok']);
  assert.equal(metric(section, 'Entries: handoff'), 1);
  assert.equal(metric(section, 'Entries: lesson'), 4);
  assert.equal(metric(section, 'Entries: feedback'), 1);
  assert.equal(metric(section, 'Entries: other'), 1);
  assert.equal(metric(section, 'Open tasks: P0'), 2);
  assert.equal(metric(section, 'Ready tasks: P0'), 1);
  assert.equal(metric(section, 'Open tasks: P1'), 1);
  assert.equal(metric(section, 'Ready tasks: P1'), 0);
  assert.equal(metric(section, 'Open tasks: P2'), 2);
  assert.equal(metric(section, 'Ready tasks: P2'), 1);
  assert.equal(metric(section, 'Open tasks: P3'), 1);
  assert.equal(metric(section, 'Ready tasks: P3'), 0);
  assert.equal(metric(section, 'Active lessons'), 3);
  assert.equal(metric(section, 'Active lessons: domain-a'), 2);
  assert.equal(metric(section, 'Active lessons: domain-b'), 1);
  assert.equal(metric(section, 'Orphan lesson anchors'), 1);
  assert.deepEqual(section.rows, [{
    columns: ['Domain', 'Active lessons', 'Orphans'],
    values: [
      ['domain-a', '2', '1'],
      ['domain-b', '1', '0'],
    ],
  }]);

  const after = createHash('sha256').update(fs.readFileSync(paths.databasePath)).digest('hex');
  assert.equal(after, before);
  assert.equal(fs.existsSync(`${paths.databasePath}-wal`), false);
  assert.equal(fs.existsSync(`${paths.databasePath}-shm`), false);
});

test('resolves the installed store from the checkout name prefix', async (t) => {
  for (const prefix of ['acme', 'other-2']) {
    await t.test(prefix, async (t) => {
      const paths = await fixture(t);
      const configDir = path.join(paths.repoRoot, 'ops', 'bootstrap');
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, 'harness.config.json'), JSON.stringify({
        names: { prefix }, memory: { embed: { model: 'qwen3-embedding:0.6b' } },
      }));
      const installed = path.join(paths.homeDir, '.local', 'share', prefix, 'scripts', 'memory', 'store.mjs');
      await mkdir(path.dirname(installed), { recursive: true });
      await writeFile(installed, 'installed source\n');
      const { installedStorePath, ...options } = paths;
      // No explicit installed path: exercise the production lookup, not the fixture override.
      const section = await collect({ ...options, serviceUrl: 'http://127.0.0.1:1', healthTimeoutMs: 100 });
      assert.equal(health(section, 'Installed service copy')?.status, 'ok');
      assert.equal(
        health(section, 'Installed service copy')?.detail,
        `matches ${path.relative(path.dirname(paths.repositoryStorePath), installed)}`,
      );
    });
  }
});

test('reports installed source drift as the prescribed warning', async (t) => {
  const paths = await fixture(t);
  createDatabase(paths.databasePath, Date.now());
  await writeFile(paths.installedStorePath, 'stale installed source\n');

  const section = await withHealthServer((serviceUrl) => collect({ ...paths, serviceUrl }));
  const drift = health(section, 'Installed service copy');

  assert.equal(drift?.status, 'warn');
  assert.match(
    drift?.detail ?? '',
    /правка в репозитории не доехала до сервиса, нужен npm run install:memory \+ рестарт/,
  );
  assert.equal(section.errors.some((error) => error.includes('Installed service copy')), false);
});

test('reports a corrupt database without throwing', async (t) => {
  const paths = await fixture(t);
  await writeFile(paths.databasePath, 'not sqlite');

  const section = await collect({
    ...paths,
    serviceUrl: 'http://127.0.0.1:1',
    healthTimeoutMs: 100,
  });

  assert.equal(health(section, 'Memory database')?.status, 'fail');
  assert.ok(section.errors.some((error) => error.includes('Memory database')));
});
