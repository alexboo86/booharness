// Maintenance-only, read-only measurement. Threshold 0.75 is the task 2666
// operating-point decision, not a fitted optimum or a held-out quality estimate.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isMain } from '../lib/is-main.mjs';
import { requireDbPath } from './lesson-lib.mjs';
import { DENSE_FITS, ledgerPath, readLedger } from './lesson-dedupe.mjs';

const HELP = `Usage: node scripts/memory/fit-lesson-dedupe.mjs --model <name> --db <memory.db>
       [--ledger <ledger.jsonl>] [--output <fit.json>]
Reads a SQLite snapshot and the adjudication ledger without changing either.
Scores only pairs whose two stored vectors have the requested model. Prints
in-sample counts at 0.697, 0.75 and 0.80; stores the chosen 0.75 operating point.
Defaults: LESSON_DEDUPE_LEDGER (or the local ledger), scripts/memory/lesson-dedupe-fit.json.`;

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--model', '--db', '--ledger', '--output'].includes(key) || Object.hasOwn(result, key.slice(2))) {
      throw new Error(`unknown or repeated option: ${key}`);
    }
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${key} needs a value`);
    result[key.slice(2)] = argv[++i];
  }
  if (!result.model?.trim()) throw new Error('--model is required; no mixed-model fit');
  requireDbPath(result.db);
  return { ...result, ledger: result.ledger || ledgerPath(), output: result.output || DENSE_FITS };
}

function cosine(a, b) {
  if (a.dims !== b.dims || !Number.isSafeInteger(a.dims) || a.dims <= 0
    || a.vec.length !== a.dims * 4 || b.vec.length !== b.dims * 4) throw new Error('invalid vector dimensions');
  const av = new DataView(a.vec.buffer, a.vec.byteOffset, a.vec.byteLength);
  const bv = new DataView(b.vec.buffer, b.vec.byteOffset, b.vec.byteLength);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.dims; i++) {
    const x = av.getFloat32(i * 4, true);
    const y = bv.getFloat32(i * 4, true);
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const score = dot / Math.sqrt(normA * normB);
  if (!Number.isFinite(score)) throw new Error('invalid vector values or zero norm');
  return score;
}

function fit({ model, db: dbPath, ledger, output }) {
  // Never let an output alias overwrite an input, including through a symlink.
  const identity = file => fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
  if (!output.endsWith('.json') || [dbPath, ledger].some(file => identity(file) === identity(output))) {
    throw new Error('fit output must be a .json file distinct from DB and ledger');
  }
  const ledgerBytes = fs.readFileSync(ledger);
  const rows = readLedger(ledger).filter(row => row.type !== 'run-done');
  if (!ledgerBytes.equals(fs.readFileSync(ledger))) throw new Error('ledger changed while reading; rerun fit');
  const counts = { ledgerPairs: rows.length, scored: 0, missingVectors: 0, otherModel: 0, duplicate: 0, distinct: 0 };
  const seen = new Set();
  const scored = [];
  const db = new DatabaseSync(path.resolve(requireDbPath(dbPath)), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;');
    const get = db.prepare('SELECT model, dims, vec FROM mem_vectors WHERE entry_id = ?');
    for (const row of rows) {
      const key = `${row.newer}:${row.older}`;
      if (seen.has(key)) throw new Error(`repeated adjudication ${key}`);
      seen.add(key);
      const a = get.get(row.newer);
      const b = get.get(row.older);
      if (!a || !b) { counts.missingVectors++; continue; }
      if (a.model !== model || b.model !== model) { counts.otherModel++; continue; }
      let score;
      try { score = cosine(a, b); }
      catch (error) { throw new Error(`pair ${key}: ${error.message}`); }
      scored.push({ score, verdict: row.verdict });
      counts.scored++;
      counts[row.verdict]++;
    }
  } finally { db.close(); }
  if (!counts.duplicate || !counts.distinct) throw new Error(`fit for ${model} needs both duplicate and distinct same-model pairs`);
  const table = [0.697, 0.75, 0.8].map(threshold => ({ threshold,
    duplicatesKept: scored.filter(row => row.verdict === 'duplicate' && row.score >= threshold).length,
    distinctPassing: scored.filter(row => row.verdict === 'distinct' && row.score >= threshold).length }));
  console.log(JSON.stringify({ model, ...counts }));
  for (const row of table) console.log(`t=${row.threshold}: keeps dups ${row.duplicatesKept}/${counts.duplicate}, distinct passing ${row.distinctPassing}/${counts.distinct}`);
  const fits = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { models: {} };
  if (!fits.models || typeof fits.models !== 'object' || Array.isArray(fits.models)) throw new Error('invalid model fit file');
  Object.defineProperty(fits.models, model, { value: { threshold: 0.75, date: new Date().toISOString(),
    counts, table, ledgerSha256: createHash('sha256').update(ledgerBytes).digest('hex'),
    selection: 'task 2666 operating point; in-sample ledger measurement' }, enumerable: true, configurable: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(fits, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, output);
  } finally { fs.rmSync(temporary, { force: true }); }
  console.log(`fit written: ${output} (${model}, threshold=0.75)`);
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') console.log(HELP);
    else fit(options(process.argv.slice(2)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
