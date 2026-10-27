// memoryd HTTP client. Env -> service.url (win forward) -> Mac loopback,
// matching the memoryctl CLI; the Mac writer has no service.url.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { filterLessons, openExistingMemoryDb } from './lesson-lib.mjs';

export function serviceUrl(env = process.env) {
  if (env.MEMORYCTL_URL) return env.MEMORYCTL_URL;
  const state = env.MEMORYCTL_STATE_DIR || join(env.HOME || homedir(), '.local/state/memoryctl');
  try {
    const url = readFileSync(join(state, 'service.url'), 'utf8').replace(/\s/g, '');
    if (url) return url;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return 'http://127.0.0.1:7717';
}

export async function readMemory(resource) {
  return readService(`/api/memory/${resource}`);
}

async function readService(resource) {
  const url = new URL(resource, serviceUrl());
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  } catch (error) {
    throw new Error(`memoryd unavailable (${url.origin}): ${error.message}; no local DB fallback`);
  }
  if (!response.ok) {
    // Carry the refusal body: a 503 from search names the dead query embedder,
    // and "HTTP 503" alone reads like a transient to the caller.
    const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
    throw new Error(`memoryd GET ${url.pathname}: HTTP ${response.status}`
      + (response.status === 404 ? ` — deploy memoryd with GET ${url.pathname} on the Mac` : '')
      + (detail ? `: ${detail}` : '')
      + '; no local DB fallback');
  }
  const rerank = response.headers.get('x-memory-rerank');
  if (rerank?.startsWith('unavailable:')) console.error(`[memoryctl] rerank ${rerank}`);
  return response.json();
}

// memoryd loads nearest-lessons vectors with the same embedModel exposed here.
export async function readDenseModel() {
  const result = await readService('/health');
  const model = result?.embedder?.model;
  if (typeof model !== 'string' || !model.trim()) throw new Error('invalid memoryd embedding model');
  return model;
}

export function dbArgument(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--db');
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--db requires a path');
  return value;
}

// A local row ID must never be sent to the live service for mutation.
export function requireServiceWrite(dbPath, dry) {
  if (dbPath !== undefined && !dry) {
    throw new Error('REFUSED --db without --dry: memoryctl writes the LIVE store; '
      + 'an id from a local copy must not be applied to live memory');
  }
}

export async function readEntries(kind, { dbPath } = {}) {
  if (!['lesson', 'handoff'].includes(kind)) throw new Error(`unsupported entry kind: ${kind}`);
  if (dbPath !== undefined) {
    const db = openExistingMemoryDb(dbPath, { readOnly: true });
    try {
      return db.prepare('SELECT * FROM mem_entries WHERE kind = ? AND superseded_by IS NULL ORDER BY id').all(kind);
    } finally { db.close(); }
  }
  const rows = await readMemory(`entries?kind=${kind}`);
  if (!Array.isArray(rows) || rows.some(row => !row || row.kind !== kind || row.superseded_by !== null)) {
    throw new Error('invalid memoryd entries response');
  }
  return rows;
}

export async function readLessons(options = {}, filter = {}) {
  return filterLessons(await readEntries('lesson', options), filter);
}

export async function readDenseLessonNeighbours(id) {
  let result;
  try { result = await readMemory(`nearest-lessons?id=${encodeURIComponent(id)}`); }
  catch (error) { throw new Error(`dense unavailable for lesson ${id}: ${error.message}`); }
  const idsValid = (ids) => Array.isArray(ids) && ids.every(value => Number.isSafeInteger(value) && value > 0);
  if (!result || !Array.isArray(result.neighbours) || !idsValid(result.skippedMalformed)
    || !idsValid(result.missingVectors) || result.neighbours.some(row => !Number.isSafeInteger(row?.id) || row.id <= 0
      || typeof row.cosine !== 'number' || !Number.isFinite(row.cosine) || row.cosine < -1 || row.cosine > 1)) {
    throw new Error('invalid memoryd dense neighbours response');
  }
  return result;
}

// Only the sweep uses this write; CAS refuses a stale report rather than overwriting it.
export async function updateRegistry(key, expectedVersion, body) {
  const url = new URL('/api/memory/registry', serviceUrl());
  const state = process.env.MEMORYCTL_STATE_DIR || join(process.env.HOME || homedir(), '.local/state/memoryctl');
  const tokenPath = process.env.MEMORYCTL_TOKEN_FILE || join(state, 'memory.token');
  let token;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch (error) {
    throw new Error(`memoryd registry token unavailable (${tokenPath}): ${error.message}; no local DB fallback`);
  }
  let response;
  try {
    response = await fetch(url, {
      method: 'POST', headers: { 'x-memory-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ key, expected_version: expectedVersion, body }),
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
  } catch (error) {
    throw new Error(`memoryd unavailable (${url.origin}): ${error.message}`);
  }
  if (response.status === 409) return false;
  if (!response.ok) throw new Error(`memoryd POST ${url.pathname}: HTTP ${response.status}`);
  return true;
}

export async function readTasks() {
  const result = await readMemory('tasks');
  if (!result || !Array.isArray(result.tasks)) throw new Error('invalid memoryd tasks response');
  return result.tasks;
}

// Search identifies candidates, never supplies the verdict: its body is a snippet.
// A glued prefixCONTRADICTS is not a real "CONTRADICTS id" marker.
export async function readContradictions() {
  const pageSize = 200;
  const cap = 10000;
  const query = encodeURIComponent('body:"CONTRADICTS id"');
  const hits = [];
  for (const kind of ['', 'report']) {
    const seen = new Set();
    for (let offset = 0; ; offset += pageSize) {
      const page = await readMemory(`search?q=${query}&limit=${pageSize}&offset=${offset}${kind ? `&kind=${kind}` : ''}`);
      if (!Array.isArray(page) || page.length > pageSize || page.some(row => !Number.isSafeInteger(row?.id))) {
        throw new Error('invalid memoryd contradiction search response');
      }
      if (!page.length) break;
      if (offset + page.length > cap) throw new Error(`memoryd contradiction search exceeds ${cap} hits per kind`);
      for (const row of page) {
        if (seen.has(row.id)) throw new Error('memoryd contradiction search repeated a page (offset unsupported)');
        seen.add(row.id);
        hits.push(row);
      }
      // A short page is complete; only a full page needs another offset probe.
      if (page.length < pageSize) break;
    }
  }
  const entries = [];
  for (let index = 0; index < hits.length; index += 20) {
    entries.push(...await Promise.all(hits.slice(index, index + 20)
      .map(hit => readMemory(`entry?id=${hit.id}`))));
  }
  return entries.filter(row => row?.superseded_by === null && /CONTRADICTS id/i.test(row.body));
}
