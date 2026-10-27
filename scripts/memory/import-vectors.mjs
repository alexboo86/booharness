#!/usr/bin/env node
// Seed a memoryd's vectors from an embed-memory.mjs cache (task 1551): the cache
// holds one float32 vector per live entry of a snapshot, and the snapshot copy
// it was built from gives each vector's text_sha as of cache time. memoryd keeps
// only vectors whose text_sha still matches the entry's current text; the rest
// stay in its backlog and are re-embedded there.
//
//   node scripts/memory/import-vectors.mjs --cache output/embed-memory/bge-m3 \
//     --source output/memory-bench/memory.db --url http://127.0.0.1:7718 --token-file <memory.token>
import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { entryTextSha } from './embed-recipe.mjs';

const ROUTE = '/api/memory/vectors/import';
// memoryd destroys a request body above 300 KiB; stay well under it.
const MAX_BATCH_BYTES = 240 * 1024;
const MAX_BATCH_ITEMS = 256;

function options(argv) {
  const value = { cache: null, source: null, url: null, 'token-file': null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !Object.hasOwn(value, key) || !argv[i + 1]) throw new Error(`invalid option ${argv[i]}`);
    value[key] = argv[i + 1];
  }
  const missing = Object.keys(value).filter((key) => !value[key]);
  if (missing.length) throw new Error(`required: ${missing.map((key) => `--${key}`).join(' ')}`);
  return value;
}

// The cache and the source copy must describe the same snapshot, entry for entry:
// a text_sha taken from any other copy would mislabel a vector as current.
function readCache(cacheDir, sourcePath) {
  const meta = JSON.parse(readFileSync(join(cacheDir, 'metadata.json'), 'utf8'));
  if (meta.formatVersion !== 3 || typeof meta.model !== 'string' || !Number.isSafeInteger(meta.dimension) || meta.dimension < 1) {
    throw new Error(`unsupported cache metadata in ${cacheDir}`);
  }
  if (meta.documentPrefix) throw new Error(`cache uses document prefix ${JSON.stringify(meta.documentPrefix)}; memoryd embeds without one`);
  const { ids } = JSON.parse(readFileSync(join(cacheDir, meta.idsFile), 'utf8'));
  if (!Array.isArray(ids) || ids.length !== meta.live) throw new Error(`cache holds ${ids?.length} ids, metadata says ${meta.live}: incomplete cache`);
  const entriesPath = join(cacheDir, meta.entriesFile);
  if (statSync(entriesPath).size !== ids.length * meta.dimension * 4) throw new Error(`${entriesPath} size does not match ${ids.length} x ${meta.dimension} float32`);
  const manifest = JSON.parse(readFileSync(join(dirname(sourcePath), 'source-manifest.json'), 'utf8'));
  if (manifest.snapshotAt !== meta.snapshotAt) throw new Error(`source snapshot ${manifest.snapshotAt} is not cache snapshot ${meta.snapshotAt}`);
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const total = db.prepare('SELECT count(*) AS n FROM mem_entries').get().n;
    if (total !== meta.total || total !== manifest.counts?.mem_entries) throw new Error(`source holds ${total} entries, cache ${meta.total}, manifest ${manifest.counts?.mem_entries}`);
    const rows = db.prepare('SELECT id, title, body FROM mem_entries WHERE superseded_by IS NULL ORDER BY id').all();
    if (rows.length !== ids.length || rows.some((row, index) => Number(row.id) !== ids[index])) throw new Error('source live ids differ from cache ids');
    return { meta, entriesPath, items: rows.map((row) => ({ entryId: Number(row.id), textSha: entryTextSha(row) })) };
  } finally { db.close(); }
}

async function post(url, token, vectors) {
  const response = await fetch(new URL(ROUTE, url), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-memory-token': token },
    body: JSON.stringify({ vectors }), signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`import HTTP ${response.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function main() {
  const opt = options(process.argv.slice(2));
  const token = readFileSync(opt['token-file'], 'utf8').trim();
  const { meta, entriesPath, items } = readCache(opt.cache, opt.source);
  const stats = { model: meta.model, dims: meta.dimension, snapshotAt: meta.snapshotAt, cached: items.length,
    imported: 0, rejectedStale: 0, rejectedOther: 0, rejectedByReason: {} };
  const rowBytes = meta.dimension * 4;
  const fd = openSync(entriesPath, 'r');
  try {
    let batch = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const result = await post(opt.url, token, batch);
      if (result.imported + result.rejected.length !== batch.length) throw new Error(`server accounted ${result.imported + result.rejected.length} of ${batch.length} vectors`);
      stats.imported += result.imported;
      for (const { reason } of result.rejected) {
        if (reason === 'stale') stats.rejectedStale++;
        else stats.rejectedOther++;
        stats.rejectedByReason[reason] = (stats.rejectedByReason[reason] ?? 0) + 1;
      }
      batch = [];
      batchBytes = 0;
    };
    const bytes = Buffer.alloc(rowBytes);
    for (let i = 0; i < items.length; i++) {
      if (readSync(fd, bytes, 0, rowBytes, i * rowBytes) !== rowBytes) throw new Error(`short read at vector ${i}`);
      const item = { entry_id: items[i].entryId, model: meta.model, text_sha: items[i].textSha, vec: bytes.toString('base64') };
      const size = JSON.stringify(item).length + 1;
      if (batch.length && (batchBytes + size > MAX_BATCH_BYTES || batch.length >= MAX_BATCH_ITEMS)) await flush();
      batch.push(item);
      batchBytes += size;
    }
    await flush();
  } finally { closeSync(fd); }
  console.log(JSON.stringify(stats));
}

main().catch((error) => { console.error(error?.message || error); process.exitCode = 1; });
