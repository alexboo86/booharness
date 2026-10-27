// Shared document recipe for the offline bench and the memory vector backlog.
import { createHash } from 'node:crypto';

// Task prefixes each model's card requires. Unlisted models are refused, not guessed.
export const MODELS = {
  'nomic-embed-text': { query: 'search_query: ', document: 'search_document: ' },
  'bge-m3': { query: '', document: '' },
  'qwen3-embedding:0.6b': {
    query: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ',
    document: '',
  },
};

export function entryText(row) {
  return `${row.title}\n${row.body}`;
}

export function entryTextSha(row) {
  return createHash('sha256').update(entryText(row)).digest('hex');
}

export function chunks(text) {
  // Byte-bounded without splitting UTF-8 code points. Every byte contributes to the mean.
  const parts = [];
  let part = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 1800) { parts.push(part); part = ''; bytes = 0; }
    part += char;
    bytes += size;
  }
  if (part || !parts.length) parts.push(part);
  return parts;
}

export async function embed(url, model, texts, timeoutMs = 180_000) {
  const response = await fetch(new URL('/api/embed', url), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: texts, truncate: false, options: { num_ctx: 2048 } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`embed HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
  const data = await response.json();
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new Error('embedding count mismatch');
  return data.embeddings;
}

export function vector(parts, dim, weights = parts.map(() => 1)) {
  const sum = new Float32Array(dim);
  let totalWeight = 0;
  for (let j = 0; j < parts.length; j++) {
    const row = parts[j];
    if (!Array.isArray(row) || row.length !== dim || row.some((x) => !Number.isFinite(x))) throw new Error('invalid vector/dimension');
    totalWeight += weights[j];
    for (let i = 0; i < dim; i++) sum[i] += row[i] * weights[j];
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) { sum[i] /= totalWeight; norm += sum[i] ** 2; }
  if (!(norm > 0)) throw new Error('zero vector');
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) sum[i] /= norm;
  return sum;
}

export async function embedEntry(row, model, dim, embedder, documentPrefix = '') {
  const pieces = chunks(entryText(row));
  const vectors = [];
  for (let j = 0; j < pieces.length; j += 16) {
    vectors.push(...await embedder(model, pieces.slice(j, j + 16).map((piece) => documentPrefix + piece)));
  }
  return { vector: vector(vectors, dim, pieces.map((piece) => Buffer.byteLength(piece))), chunks: pieces.length };
}
