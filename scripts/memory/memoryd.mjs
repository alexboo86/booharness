#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createMemory, createTextHashCache, isPlainSearch, listMissingOrStaleVectorIds, loadCurrentVectors, openMemoryDb, putVector, vectorBacklogStatus } from './store.mjs';
import { MODELS, chunks, embed, embedEntry, entryText, entryTextSha, vector as normalizeVector } from './embed-recipe.mjs';
import { createReranker } from './reranker.mjs';
import { HttpError } from './task-pure.mjs';

// Loopback on a workstation; a container sets MEMORYCTL_HOST=0.0.0.0 so the
// One writer on Mac loopback under launchd; win reaches it via ssh forwarding.
const host = process.env.MEMORYCTL_HOST || '127.0.0.1';
const port = Number(process.env.MEMORYCTL_PORT || 7717);
const stateDir = process.env.MEMORYCTL_STATE_DIR
  || path.join(os.homedir(), '.local', 'state', 'memoryctl');

// The Windows Scheduled Task discards stdout, so a crash used to leave NOTHING
// behind: the next session found the port dead and no way to learn why. Log to a
// file next to the database, and exit non-zero on a fatal so the task's
// restart-on-failure actually fires.
const logPath = path.join(stateDir, 'memoryd.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  process.stdout.write(entry);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    if (fs.statSync(logPath, { throwIfNoEntry: false })?.size > MAX_LOG_BYTES) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
    fs.appendFileSync(logPath, entry);
  } catch {
    // logging must never take the service down
  }
}

function fatal(reason, error) {
  log(`fatal ${reason}: ${error?.stack || error}`);
  process.exit(1);
}

process.on('uncaughtException', (error) => fatal('uncaughtException', error));
process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));

const db = openMemoryDb(stateDir);
const reranker = createReranker(process.env.MEMORYCTL_RERANK_PYTHON, stateDir, log);
process.once('exit', () => reranker.stop());
const embedUrl = process.env.MEMORYCTL_EMBED_URL || null;
const backlogUrl = process.env.MEMORYCTL_EMBED_BACKLOG_URL || null;
const embedModel = process.env.MEMORYCTL_EMBED_MODEL || 'bge-m3';
if (!Object.hasOwn(MODELS, embedModel)) {
  throw new Error(`unknown embedding model ${embedModel}; add its measured recipe to scripts/memory/embed-recipe.mjs MODELS`);
}
const prefix = MODELS[embedModel];
// The CLI stops waiting at 30 s. Leave time to send a meaningful 503 first.
const queryEmbedTimeoutMs = Number(process.env.MEMORYCTL_QUERY_EMBED_TIMEOUT_MS ?? 15_000);
if (!Number.isSafeInteger(queryEmbedTimeoutMs) || queryEmbedTimeoutMs < 1 || queryEmbedTimeoutMs > 25_000) {
  throw new Error('MEMORYCTL_QUERY_EMBED_TIMEOUT_MS must be an integer from 1 to 25000');
}
const textHashes = createTextHashCache(db);
const denseVectors = new Map(loadCurrentVectors(db, embedModel, textHashes).map((row) => [row.entryId, row]));
const memory = createMemory({ db, tokenPath: path.join(stateDir, 'memory.token'), denseVectors, textHashes });
const embedder = { url: embedUrl, backlogUrl, model: embedModel, queryPrefix: prefix.query, reachable: false,
  lastError: embedUrl ? null : 'disabled: MEMORYCTL_EMBED_URL is not set', lastOkAt: null,
  backlogFailure: null };
const getVectorRow = db.prepare('SELECT title, body FROM mem_entries WHERE id = ? AND superseded_by IS NULL AND kind != \'report\'');
const EMBED_BATCH_SIZE = 8;
const EMBED_POLL_MS = 30_000;
let embedTimer = null;
let embedding = false;
const retries = new Map(); // id -> independent backoff and last failure
let scanRetryMs = 1000; // unexpected scan errors remain service-wide
let stopping = false;
let pendingWake = false;
let pendingIds = []; // one backlog scan per drain, not a full text/hash scan per eight rows
let needsScan = true;

function scheduleEmbeddings(delay = 0) {
  if (!embedUrl || embedding || stopping) return;
  if (embedTimer) clearTimeout(embedTimer);
  embedTimer = setTimeout(() => {
    embedTimer = null;
    // A timer is the only entry point into asynchronous embedding; HTTP writes
    // commit and finish their response without awaiting the remote embedder.
    void drainEmbeddings();
  }, delay);
}

async function drainEmbeddings() {
  if (embedding || stopping) return;
  embedding = true;
  try {
    if (needsScan || !pendingIds.length) {
      pendingIds = [...new Set([...pendingIds, ...listMissingOrStaleVectorIds(db, embedModel, textHashes)])];
      needsScan = false;
    }
    const count = Math.min(pendingIds.length, EMBED_BATCH_SIZE);
    for (let i = 0; i < count; i++) {
      const id = pendingIds.shift();
      const row = getVectorRow.get(id);
      if (!row) { clearRetry(id); continue; } // replaced while a vector was in flight
      const textSha = entryTextSha(row);
      // An imported vector made this entry current after it was queued.
      if (denseVectors.get(id)?.textSha === textSha) { clearRetry(id); continue; }
      if ((retries.get(id)?.retryAt ?? 0) > Date.now()) { pendingIds.push(id); continue; }
      try {
        const url = backlogUrl || embedUrl;
        // Learn dimensions from Ollama instead of assuming that every configured
        // model has bge-m3's dimensionality. Reuse the first batch in the recipe.
        const firstTexts = chunks(entryText(row)).slice(0, 16).map((piece) => prefix.document + piece);
        const first = await embed(url, embedModel, firstTexts);
        let firstCall = true;
        const { vector } = await embedEntry(row, embedModel, first[0]?.length, (model, texts) => {
          if (firstCall) { firstCall = false; return first; }
          return embed(url, model, texts);
        }, prefix.document);
        if (getVectorRow.get(id)) {
          putVector(db, { entryId: id, model: embedModel, vector, textSha });
          denseVectors.set(id, { vector, textSha });
        }
        clearRetry(id);
        embedder.reachable = true;
        embedder.lastError = null;
        embedder.lastOkAt = new Date().toISOString();
      } catch (error) {
        const message = String(error?.message || error);
        const delayMs = Math.min((retries.get(id)?.delayMs ?? 500) * 2, 60_000);
        const failure = { id, message, retryAt: Date.now() + delayMs, delayMs };
        retries.delete(id);
        retries.set(id, failure);
        embedder.backlogFailure = { id, message, retryAt: new Date(failure.retryAt).toISOString() };
        embedder.reachable = false;
        embedder.lastError = message;
        log(`embedder entry ${id} error: ${error?.stack || error}`);
        pendingIds.push(id);
      }
    }
    const ready = pendingIds.some((id) => (retries.get(id)?.retryAt ?? 0) <= Date.now());
    nextEmbedDelay = ready || pendingWake ? 0 : pendingIds.length
      ? Math.max(0, pendingIds.reduce((soonest, id) => Math.min(soonest, retries.get(id).retryAt), Infinity) - Date.now())
      : EMBED_POLL_MS;
    scanRetryMs = 1000;
  } catch (error) {
    embedder.reachable = false;
    embedder.lastError = String(error?.stack || error);
    log(`embedder scan error: ${embedder.lastError}`);
    nextEmbedDelay = scanRetryMs;
    scanRetryMs = Math.min(scanRetryMs * 2, 60_000);
  } finally {
    embedding = false;
    pendingWake = false;
    if (!stopping && embedUrl) scheduleEmbeddings(nextEmbedDelay);
  }
}

function clearRetry(id) {
  if (!retries.delete(id)) return;
  const latest = [...retries.values()].at(-1);
  embedder.backlogFailure = latest
    ? { id: latest.id, message: latest.message, retryAt: new Date(latest.retryAt).toISOString() }
    : null;
}

let nextEmbedDelay = EMBED_POLL_MS;
memory.onWrite((event) => {
  if (event.id && event.type !== 'task') clearRetry(event.id);
  if (event.supersedes) clearRetry(event.supersedes);
  if (event.type !== 'task') textHashes.refresh(event.id, event.supersedes);
  if (event.supersedes) denseVectors.delete(event.supersedes);
  if (event.type === 'append' || event.type === 'supersede' || event.type === 'handoff' || event.type === 'registry') {
    if (event.id && !pendingIds.includes(event.id)) pendingIds.push(event.id);
    needsScan = true; // also picks up stale text from imports or out-of-band edits
    if (embedding) pendingWake = true;
    else scheduleEmbeddings(0);
  }
});
if (embedUrl) scheduleEmbeddings(0);
else log('embedder disabled: MEMORYCTL_EMBED_URL is not set');

// Seed vectors computed elsewhere (scripts/memory/import-vectors.mjs reading an
// embed-memory.mjs cache). Each item is accepted only for the served model, the
// dimension the query embedder produces, a unit vector, and the recipe hash of
// the entry's CURRENT text; anything else is rejected per item and left to the
// backlog worker, never stored as current.
const VECTOR_IMPORT_PATH = '/api/memory/vectors/import';
const MAX_IMPORT_ITEMS = 256;
let importDims = null;

async function queryDims() {
  if (importDims) return importDims;
  const [probe] = await embed(embedUrl, embedModel, ['dimension probe']);
  if (!Array.isArray(probe) || !probe.length) throw new Error('embedder returned no probe vector');
  importDims = probe.length;
  return importDims;
}

function importVector(item, dims) {
  const id = item?.entry_id;
  if (!Number.isSafeInteger(id) || id < 1) return { reason: 'invalid', detail: 'entry_id must be a positive integer' };
  if (item.model !== embedModel) return { reason: 'model', detail: `model ${item.model} is not served model ${embedModel}` };
  if (typeof item.vec !== 'string' || typeof item.text_sha !== 'string') {
    return { reason: 'invalid', detail: 'vec (base64 float32 LE) and text_sha are required strings' };
  }
  const bytes = Buffer.from(item.vec, 'base64');
  if (bytes.length !== dims * 4) return { reason: 'dims', detail: `got ${bytes.length / 4} dims, served ${dims}` };
  const vector = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) { vector[i] = bytes.readFloatLE(i * 4); norm += vector[i] ** 2; }
  if (!Number.isFinite(norm) || Math.abs(Math.sqrt(norm) - 1) > 1e-3) return { reason: 'invalid', detail: 'not a finite unit vector' };
  const row = getVectorRow.get(id);
  if (!row) return { reason: 'missing', detail: 'no live non-report entry' };
  if (entryTextSha(row) !== item.text_sha) return { reason: 'stale', detail: 'text_sha differs from current entry text' };
  putVector(db, { entryId: id, model: embedModel, vector, textSha: item.text_sha });
  denseVectors.set(id, { vector, textSha: item.text_sha });
  clearRetry(id);
  return null;
}

async function importVectors(req, res, body) {
  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (req.method !== 'POST') return send(405, { error: 'method not allowed', allowed: ['POST'] });
  if (!memory.authorized(req)) return send(401, { error: 'invalid memory mutation token' });
  let input;
  try { input = JSON.parse(body); } catch { return send(400, { error: 'body must be JSON {vectors:[{entry_id, model, text_sha, vec}]}' }); }
  const items = input?.vectors;
  if (!Array.isArray(items) || !items.length || items.length > MAX_IMPORT_ITEMS) {
    return send(400, { error: `vectors must be a non-empty array of at most ${MAX_IMPORT_ITEMS} items` });
  }
  if (!embedUrl) return send(503, { error: `import needs the query embedder for ${embedModel} dimensions: MEMORYCTL_EMBED_URL is not set` });
  let dims;
  try { dims = await queryDims(); } catch (error) {
    return send(503, { error: `query embedder ${embedModel} at ${embedUrl} failed: ${error?.message || error}` });
  }
  let imported = 0;
  const rejected = [];
  for (const item of items) {
    const refusal = importVector(item, dims);
    if (refusal) rejected.push({ entry_id: item?.entry_id ?? null, ...refusal });
    else imported++;
  }
  send(200, { imported, rejected, dims, model: embedModel });
}

memory.setExportStatusFn(() => ({
  service: 'memoryctl',
  durable: true,
  projection_enabled: false,
  pending: false,
  last_error: null,
}));

// A refusal is a CONTRACT message, and until now it was said once and forgotten.
//
// Every 4xx this service returns names the exact missing piece - that is the
// whole design of the gate. None of it was recorded anywhere: measured
// 2026-08-06, `memoryd.log` held 49 lines and all forty-nine were "service
// listening". So "which refusals repeat, and does the contract need rewording"
// was unanswerable, while the same gate was demonstrably being hit again and
// again (a handoff written twice while its author fumbled the tails flag).
//
// Recorded at the RESPONSE rather than at each refusal site: there is one place
// where a status is written and a dozen where one is decided, and a record that
// depends on remembering to call it is the record that goes missing.
const refusalLog = path.join(stateDir, 'refusals.jsonl');
function recordRefusal(url, status, payload, request) {
  try {
    let reason = '';
    try {
      const parsed = JSON.parse(payload);
      reason = String(parsed.error || parsed.message || '').slice(0, 400);
    } catch {
      reason = String(payload || '').slice(0, 400);
    }
    let agent = null;
    let session = null;
    try {
      const sent = JSON.parse(request || '{}');
      agent = sent.agent ?? null;
      session = sent.session ?? null;
    } catch {
      /* a refusal for unparseable input still deserves its line */
    }
    fs.appendFileSync(
      refusalLog,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        path: url.pathname,
        status,
        reason,
        agent,
        session,
      })}\n`,
    );
  } catch {
    /* best effort: a logging failure must never turn a refusal into a crash */
  }
}

/// Watch one response for a refusal without changing what it sends.
function observeRefusals(res, url, requestBody) {
  let status = 200;
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (code, ...rest) => {
    status = code;
    return writeHead(code, ...rest);
  };
  const end = res.end.bind(res);
  res.end = (chunk, ...rest) => {
    if (status >= 400) {
      recordRefusal(url, status, typeof chunk === 'string' ? chunk : '', requestBody());
    }
    return end(chunk, ...rest);
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${host}:${port}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'memoryctl', embedder, reranker: reranker.health(),
      vectors: vectorBacklogStatus(db, embedModel, textHashes) }));
    return;
  }
  if (!url.pathname.startsWith('/api/memory/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let body = '';
  observeRefusals(res, url, () => body);
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > 300 * 1024) req.destroy();
  });
  req.on('end', () => {
    void (async () => {
      if (url.pathname === VECTOR_IMPORT_PATH) {
        await importVectors(req, res, body);
        return;
      }
      let queryVector;
      let searchResult;
      let rerankScores;
      const queryStarted = performance.now();
      if (req.method === 'GET' && isPlainSearch(url)) {
        if (!embedUrl) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `query embedder ${embedModel} unavailable: MEMORYCTL_EMBED_URL is not set` }));
          return;
        }
        try {
          const [embedding] = await embed(embedUrl, embedModel, [prefix.query + url.searchParams.get('q')], queryEmbedTimeoutMs);
          queryVector = normalizeVector([embedding], embedding.length);
          embedder.reachable = true;
          embedder.lastError = null;
          embedder.lastOkAt = new Date().toISOString();
        } catch (error) {
          embedder.reachable = false;
          embedder.lastError = String(error?.message || error);
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `query embedder ${embedModel} at ${embedUrl} failed: ${embedder.lastError}` }));
          return;
        }
      }
      if (queryVector) {
        searchResult = memory.search(url, queryVector);
        if (searchResult.rerank && reranker.health().status !== 'off') {
          const budget = Math.max(0, Math.min(5000, 28_000 - (performance.now() - queryStarted)));
          const result = await reranker.rerank(url.searchParams.get('q'), searchResult.docs, budget);
          res.setHeader('X-Memory-Rerank', result.header);
          rerankScores = result.scores;
        }
      }
      if (!memory.handle(req, res, url, body, { queryVector, searchResult, rerankScores })) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    })().catch((error) => {
      log(`request error: ${error?.stack || error}`);
      if (!res.headersSent) res.writeHead(error instanceof HttpError ? error.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    });
  });
});

function shutdown(signal) {
  stopping = true;
  reranker.stop();
  if (embedTimer) clearTimeout(embedTimer);
  log(`shutdown on ${signal}`);
  server.close(() => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Node's 5 s keep-alive default can destroy an idle pooled socket before a
// pending request is read when the loop stalls: the client sees ECONNRESET
// (orch task 1512, same server shape). Headers must outlast keep-alive.
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
server.on('error', (error) => fatal('server error', error));
server.listen(port, host, () => {
  log(`memory service listening on http://${host}:${port} pid=${process.pid} state=${stateDir}`);
});
