#!/usr/bin/env node
// Stub Ollama /api/embed for bench parity (task 1551): answers each exact query
// text with its vector from an embed-memory.mjs cache (queries.json, queries.f32),
// and memoryd's import dimension probe with a unit vector of the cache dimension.
// Any other text fails the whole request with HTTP 500 and a stderr line, so a
// live search can never be ranked by a vector the dense arm did not use.
//   node scripts/memory/serve-query-cache.mjs --cache output/embed-memory/bge-m3 --port 11499
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; };
const cache = arg('--cache');
const port = Number(arg('--port'));
if (!cache || !Number.isInteger(port) || port < 1) throw new Error('usage: --cache <embed-memory dir> --port <n>');
const meta = JSON.parse(fs.readFileSync(path.join(cache, 'metadata.json'), 'utf8'));
const queries = JSON.parse(fs.readFileSync(path.join(cache, meta.queryIndexFile), 'utf8'));
const bytes = fs.readFileSync(path.join(cache, meta.queriesFile));
const dim = meta.dimension;
if (bytes.length !== queries.length * dim * 4) throw new Error(`${meta.queriesFile}: ${bytes.length} bytes for ${queries.length} x ${dim}`);
const vectors = new Map();
queries.forEach(({ query }, index) => {
  if (vectors.has(query)) return; // the bench reads the first vector of a repeated text
  vectors.set(query, Array.from({ length: dim }, (_, d) => bytes.readFloatLE((index * dim + d) * 4)));
});
const probe = Array.from({ length: dim }, (_, d) => (d === 0 ? 1 : 0));
const counts = { served: 0, probe: 0, unknown: 0 };

const server = http.createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  let input;
  let model;
  try { ({ input, model } = JSON.parse(Buffer.concat(parts).toString())); } catch { input = null; }
  const texts = Array.isArray(input) ? input : [input];
  const unknown = req.url !== '/api/embed' || model !== meta.model ? texts
    : texts.filter((text) => text !== 'dimension probe' && !vectors.has(text));
  if (unknown.length) {
    counts.unknown += unknown.length;
    process.stderr.write(`serve-query-cache: REFUSED ${req.url} model=${model} ${JSON.stringify(unknown).slice(0, 300)}\n`);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `no cached ${meta.model} vector for ${unknown.length} text(s)` }));
    return;
  }
  for (const text of texts) if (text === 'dimension probe') counts.probe++; else counts.served++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ model, embeddings: texts.map((text) => (text === 'dimension probe' ? probe : vectors.get(text))) }));
});
server.listen(port, '127.0.0.1', () => console.log(`serve-query-cache: ${vectors.size} ${meta.model} query vectors, dim ${dim}, on http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { console.log(`serve-query-cache: ${JSON.stringify(counts)}`); process.exit(counts.unknown ? 1 : 0); });
