import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createMemory, openMemoryDb, resolveDomain } from './store.mjs';

export const storeModulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'store.mjs');
export const pathToFileUrl = (value) => pathToFileURL(value).href;

export const tests = [];
export const test = (name, fn) => tests.push({ name, fn });

// Synthetic routes keep storage contracts independent of the donor's domains.
export const fixtureRouting = () => ({
  order: [
    { glob: 'app/src/billing_v4/**', domain: 'domain-billing', spec: 25 },
    { glob: 'src/billing/**', domain: 'domain-billing', spec: 25 },
    { glob: 'src/**/*[Bb]illing*', domain: 'domain-billing', spec: 20 },
    { glob: 'scripts/memory/**', domain: 'domain-harness', spec: 10 },
    { glob: 'ops/bootstrap/**', domain: 'domain-harness', spec: 10 },
    { glob: '**', domain: 'domain-platform-shell', spec: 0 },
  ],
});

// The read endpoint loads its map from disk rather than createMemory's routing
// option. Supply the same fixture data there, without changing the donor file.
const routingPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/agent/domain-routing.generated.json');
let routingMock;
function useFixtureRouting() {
  if (routingMock) return;
  const readFileSync = fs.readFileSync;
  routingMock = mock.method(fs, 'readFileSync', (file, options) => {
    if (file !== routingPath) return readFileSync(file, options);
    const bytes = Buffer.from(JSON.stringify(fixtureRouting()));
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? bytes.toString(encoding) : bytes;
  });
}

export function fixture() {
  useFixtureRouting();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryctl-test-'));
  const tokenPath = path.join(stateDir, 'memory.token');
  const db = openMemoryDb(stateDir);
  return {
    stateDir,
    tokenPath,
    token: fs.readFileSync(tokenPath, 'utf8').trim(),
    db,
    memory: createMemory({ db, tokenPath, routing: fixtureRouting }),
    close() {
      db.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

export function request(memory, method, pathname, body, token) {
  // A test that appends a lesson stands in for a client that ran capture-gate.mjs,
  // so the marker is stamped unless the test sets `gate` itself (even to undefined).
  if (pathname === '/api/memory/append' && body?.kind === 'lesson'
    && body.links && typeof body.links === 'object' && !Array.isArray(body.links) && !('gate' in body.links)) {
    body = { ...body, links: { ...body.links, gate: LESSON_GATE } };
  }
  const response = { status: null, headers: null, text: '' };
  const req = { method, headers: token ? { 'x-memory-token': token } : {} };
  const res = {
    writeHead(status, headers) {
      response.status = status;
      response.headers = headers;
    },
    end(chunk = '') {
      response.text = String(chunk);
    },
  };
  const url = new URL(pathname, 'http://127.0.0.1:7717');
  assert.equal(memory.handle(req, res, url, body === undefined ? '' : JSON.stringify(body)), true);
  const contentType = response.headers?.['Content-Type'] || '';
  response.json = response.text && contentType.startsWith('application/json')
    ? JSON.parse(response.text)
    : null;
  return response;
}

// The marker capture-gate.mjs stamps; memoryd refuses a new lesson without it.
export const LESSON_GATE = Object.freeze({ v: 1, at: '2026-09-26T00:00:00.000Z' });

// A lesson row that predates the capture gate (no marker, any domain). The gate
// refuses such a NEW append, so it is written routed and then rewritten in place.
export function seedLegacyLesson(fx, input) {
  const { gate, ...links } = input.links;
  const file = links.anchor.includes(':') ? links.anchor.slice(0, links.anchor.indexOf(':')) : links.anchor;
  const res = request(fx.memory, 'POST', '/api/memory/append', {
    ...input, links: { ...links, domain: resolveDomain(file, fixtureRouting()) },
  }, fx.token);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  fx.db.prepare('UPDATE mem_entries SET links = ? WHERE id = ?').run(JSON.stringify(links), res.json.id);
  return res;
}

export function lessonLinks(overrides = {}) {
  return {
    domain: 'domain-billing',
    anchor: 'app/src/billing_v4/collector.rs:collect',
    status: 'active',
    gate: LESSON_GATE,
    ...overrides,
  };
}

export function createTask(fx, overrides = {}) {
  return request(fx.memory, 'POST', '/api/memory/task', {
    title: 'Rate-limit the pending-cap warn',
    priority: 'P1',
    next_action: 'wire the throttle into the writer',
    ...overrides,
  }, fx.token);
}

export async function runStoreTests() {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`ok - ${name}`);
  }
  console.log(`memory tests passed: ${tests.length}`);
}
