#!/usr/bin/env node
// Is the memory service on this machine the operator's memory, or an empty
// database wearing its health check?
//
// `/health` answers `{ok:true}` without touching the database, which is why it
// stayed green through every version of the failure this round is closing: a
// fresh empty database created by a wrong installer is healthy, and a store
// too old for the database refuses to open it and dies - the health check
// cannot tell a service from a corpse either way. This probe asks the service
// CONTENT questions whose answers are pinned in the transfer manifest:
//
//   - the open tasks the donor recorded must exist here;
//   - the donor's sample entry must be readable, with its title;
//   - lessons for a probe path the donor measured must still be delivered
//     (zero here with a non-zero donor count is the missing routing-map
//     signature - the database is fine and the service cannot read its map).
//
//   node scripts/probe-memory-service.mjs --manifest <manifest.json> \
//        [--url http://127.0.0.1:7717]
//
// Exit 0 = the live service holds the transferred memory. Exit 1 = it does
// not, with every difference named.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessPaths, readHarnessConfig } from './lib/harness-config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const manifestPath = args.get('manifest');
const baseUrl = (args.get('url') ?? 'http://127.0.0.1:7717').replace(/\/$/, '');
if (!manifestPath) {
  console.error('probe-memory-service: --manifest <manifest.json> is required');
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
let routingMapHint;
try {
  const prefix = readHarnessConfig({ repoRoot: REPO }).names.prefix;
  routingMapHint = path.join(
    harnessPaths({ prefix, home: '~' }).shareDir,
    'docs', 'agent', 'domain-routing.generated.json',
  );
} catch (error) {
  console.error(`probe-memory-service: ${error.message}`);
  process.exit(1);
}
function get(urlPath) {
  return new Promise((resolve) => {
    const request = http.get(`${baseUrl}${urlPath}`, { timeout: 3000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, json: JSON.parse(body) });
        } catch {
          resolve({ status: response.statusCode, json: null, body });
        }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve({ status: 0, error: 'timeout' }); });
    request.on('error', (error) => resolve({ status: 0, error: error.message }));
  });
}

const rows = [];
let failed = 0;
const check = (name, ok, detail) => {
  rows.push({ check: name, ok, detail });
  if (!ok) failed += 1;
};

const health = await get('/health');
check('health answers ok', health.status === 200 && health.json?.ok === true,
  health.status === 0
    ? `no service at ${baseUrl} (${health.error}) - if the daemon log says "schema vN is newer than supported", the installed store is older than the database: npm run install:memory`
    : `status ${health.status}`);

if (health.status === 200) {
  // 1. The tasks the donor recorded. Tasks may legitimately CLOSE after the
  // move; what they may not do is VANISH - a closed task keeps its row.
  const tasks = await get('/api/memory/tasks');
  const known = new Map(
    (tasks.json?.tasks ?? []).map((task) => [Number(task.id), task.status]),
  );
  const wanted = manifest.open_task_ids ?? [];
  if (wanted.length === 0) {
    rows.push({ check: 'open tasks', ok: true, detail: 'donor recorded none - nothing to require' });
  } else {
    const missing = wanted.filter((id) => !known.has(id));
    const stillOpen = wanted.filter((id) => known.get(id) === 'open' || known.get(id) === 'in_progress');
    check('donor tasks exist',
      missing.length === 0,
      missing.length
        ? `${missing.length} of ${wanted.length} donor task ids are absent: [${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}] - an empty database looks exactly like this while /health says ok`
        : `${wanted.length} donor tasks present, ${stillOpen.length} still open`);
  }

  // 2. A concrete row, read whole.
  if (manifest.sample_entry) {
    const entry = await get(`/api/memory/entry?id=${manifest.sample_entry.id}`);
    const title = entry.json?.title;
    check('sample entry reads back',
      entry.status === 200 && title === manifest.sample_entry.title,
      entry.status === 200
        ? `title is ${JSON.stringify(title)}, donor recorded ${JSON.stringify(manifest.sample_entry.title)}`
        : `entry #${manifest.sample_entry.id} answered ${entry.status}`);
  }

  // 3. Lesson delivery for the path the donor measured.
  const probe = manifest.lessons_probe ?? { path: 'scripts/memory/store.mjs', count: 0 };
  const lessons = await get(`/api/memory/lessons?path=${encodeURIComponent(probe.path)}`);
  const delivered = lessons.json?.items?.length ?? 0;
  if (probe.count > 0) {
    check(`lessons still deliver for ${probe.path}`,
      delivered > 0,
      delivered === 0
        ? `donor delivered ${probe.count} and this service delivers 0 with the database present - that is the missing routing map: ${routingMapHint} (npm run install:memory installs it)`
        : `${delivered} delivered (donor: ${probe.count})`);
  } else {
    rows.push({ check: `lessons for ${probe.path}`, ok: true, detail: 'donor recorded none - nothing to require' });
  }

  // 4. Plain search: the dense path. /health stays green while every plain
  // search answers 503 (dead or unconfigured embedder), and a 200 with an
  // empty result means the service was never seeded - all are deploy-time
  // failures this check exists to name. Skipped only when /health carries no
  // embedder field AT ALL (a pre-dense-search server); a dense server with a
  // null url or reachable:false IS the blocker scenario and must go red.
  const embedder = health.json?.embedder;
  if (!embedder || typeof embedder !== 'object') {
    rows.push({ check: 'plain search answers', ok: true, detail: 'pre-dense-search server (no embedder in /health) - nothing to require' });
  } else if (!embedder.url) {
    check('plain search answers', false,
      `embedder not configured: ${embedder.lastError ?? 'MEMORYCTL_EMBED_URL is not set'} - a dense-search memoryd without MEMORYCTL_EMBED_URL answers every plain search with 503 while /health stays green`);
  } else if (embedder.reachable !== true) {
    check('plain search answers', false,
      `query embedder ${embedder.model ?? ''} at ${embedder.url} is not reachable: ${embedder.lastError ?? 'has never answered'} - /health stays green while every plain search 503s`);
  } else {
    const query = manifest.search_probe?.q ?? manifest.sample_entry?.title ?? 'memory';
    const found = await get(`/api/memory/search?q=${encodeURIComponent(query)}`);
    if (found.status !== 200) {
      check('plain search answers', false,
        `status ${found.status}: ${found.json?.error ?? found.body ?? found.error ?? 'no body'} - /health can be green while every plain search looks like this`);
    } else {
      const hits = Array.isArray(found.json) ? found.json.length : 0;
      check('plain search answers', hits > 0,
        hits > 0
          ? `${hits} result(s) for ${JSON.stringify(query)}`
          : `200 with 0 results for ${JSON.stringify(query)} - vectors were never seeded: scripts/memory/import-vectors.mjs, then watch /health vectors.missing reach 0`);
    }
  }
}

const width = Math.max(...rows.map((row) => row.check.length));
for (const row of rows) {
  console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.check.padEnd(width)}  ${row.detail}`);
}
if (failed) {
  console.error(`\nprobe-memory-service: ${failed} check(s) failed - the service at ${baseUrl} is NOT holding the transferred memory.`);
  process.exit(1);
}
console.log(`\nprobe-memory-service: the service at ${baseUrl} holds the transferred memory.`);
