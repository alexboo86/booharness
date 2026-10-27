// Live baseline usage metrics for the A/B stand (decision #12807): cache hit share and
// tokens per turn, per seat family and role, from the orch store. Read-only.
// Usage: node ops/ab-stand/metrics.mjs --since 7d [--json] [--db path]
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hitShare, median } from './report.mjs';
import { usageParts } from '../orchestrator/src/pick-stats.ts';
import { openReadOnlyStore } from '../orchestrator/src/store.ts';

const DEFAULT_DB = path.join(os.homedir(), '.local', 'state', 'orch', 'orch.sqlite');

/** Same <n>d shape as `main.ts pick-stats --since`; returns an inclusive ISO cutoff. */
export function parseSinceDays(value, now = Date.now()) {
  if (!/^[1-9]\d*d$/.test(value)) throw new Error('--since needs a positive number of days, e.g. 7d');
  const ms = Number(value.slice(0, -1)) * 86_400_000;
  if (!Number.isSafeInteger(ms)) throw new Error('--since is too large');
  return new Date(now - ms).toISOString();
}

/** Nearest-rank p90: the smallest value at least 90% of the sample is at or below. */
const p90 = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
};

/**
 * One row per family+role. `no usage` counts turns whose usage is missing or invalid — never 0.
 * Hit share is pooled: hitShare over the summed components (report.mjs:85-90 definition).
 * Token totals are per turn: input+output+cacheRead+cacheWrite (pick-stats usageParts).
 */
export function usageMetrics(db, since) {
  const rows = db.prepare(`SELECT s.family, s.role, t.id, t.usage FROM turns t JOIN seats s ON s.id = t.seat_id
    WHERE (? IS NULL OR t.created_at >= ?) ORDER BY s.family, s.role`).all(since ?? null, since ?? null);
  const cells = new Map();
  for (const row of rows) {
    const key = `${row.family}${row.role}`;
    if (!cells.has(key)) cells.set(key, { family: row.family, role: row.role, turns: 0, noUsage: 0, noUsageTurns: [],
      sums: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokens: [] });
    const cell = cells.get(key);
    cell.turns += 1;
    const parts = usageParts(row.usage);
    if (!parts) { cell.noUsage += 1; cell.noUsageTurns.push(row.id); continue; }
    for (const field of Object.keys(cell.sums)) cell.sums[field] += parts[field];
    cell.tokens.push(parts.input + parts.output + parts.cacheRead + parts.cacheWrite);
  }
  return [...cells.values()].map((cell) => ({
    family: cell.family, role: cell.role, turns: cell.turns, noUsage: cell.noUsage, noUsageTurns: cell.noUsageTurns,
    hitShare: hitShare(cell.sums.input, cell.sums.cacheRead, cell.sums.cacheWrite),
    tokens: { n: cell.tokens.length, median: median(cell.tokens), p90: p90(cell.tokens) },
  }));
}

export function readUsageMetrics(file = DEFAULT_DB, since) {
  const db = openReadOnlyStore(file);
  try { return usageMetrics(db, since); }
  finally { db.close(); }
}

const show = (value, places) => value === null || value === undefined ? 'n/a'
  : places === undefined ? String(value) : String(Number(value.toFixed(places)));

export function formatUsageMetrics(rows, since) {
  const header = ['family', 'role', 'turns', 'no usage', 'hit share', 'tokens n', 'median', 'p90'];
  const lines = rows.map((row) => [row.family, row.role, row.turns, row.noUsage,
    show(row.hitShare, 4), row.tokens.n, show(row.tokens.median), show(row.tokens.p90)]);
  const table = lines.map((line) => line.map(String));
  const widths = header.map((name, i) => Math.max(name.length, ...table.map((line) => line[i].length)));
  const body = [header, ...table].map((line) => line.map((value, i) => value.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
  const named = rows.filter((row) => row.noUsageTurns.length)
    .map((row) => `  ${row.family}/${row.role}: ${row.noUsageTurns.slice(0, 3).join(', ')}${row.noUsageTurns.length > 3 ? ` (+${row.noUsageTurns.length - 3} more)` : ''}`);
  const footer = named.length ? `turns without usage (full list in --json):\n${named.join('\n')}\n` : '';
  return `usage metrics since ${since ?? 'the beginning'}; hit share = cacheRead / (input + cacheRead + cacheWrite), pooled per cell\n${body}\n${footer}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  let since, json = false, db = DEFAULT_DB;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--since' && since === undefined && args[i + 1]) since = parseSinceDays(args[++i]);
    else if (args[i] === '--db' && args[i + 1]) db = args[++i];
    else throw new Error('usage: metrics.mjs --since 7d [--json] [--db path]');
  }
  const rows = readUsageMetrics(db, since);
  process.stdout.write(json ? `${JSON.stringify({ since: since ?? null, rows }, null, 2)}\n` : formatUsageMetrics(rows, since));
}
