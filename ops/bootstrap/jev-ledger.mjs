// Shared across Jev callers and the orch board. Prices: https://docs.typesafe.ai/models.md
// Read 2026-09-23: jev-latest (jev-1.13.0), $0.042/M input tokens, output free.
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const JEV_INPUT_USD_PER_MILLION = 0.042;
export const jevStateDir = (home = homedir()) => process.env.JEV_STATE_DIR || join(home, '.local', 'state', 'jev');
const ledgerPath = (dir, at) => join(dir, `usage-${at.slice(0, 7)}.jsonl`);
const balancePath = (dir) => join(dir, 'balance.json');
/** A Jev model id: the historical `jev-latest` alias or a pinned version such as `jev-1.13.0`. */
export const JEV_MODEL_ID = /^jev-[0-9A-Za-z._-]+$/;

// One O_APPEND write per complete JSON line; no read/modify/write race between processes.
// Callers deliberately do not await this: unavailable state must not delay or fail Jev.
// `model` is the model that answered (jev-client ask()), not the requested alias.
export async function recordJevUsage(inputTokens, caller, model, dir = jevStateDir(), at = new Date().toISOString()) {
  // A 200 without a safe non-negative integer is not spend. Do not write a
  // row: null is not zero, and a non-integer is a skipped row on the board.
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) return;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(ledgerPath(dir, at), JSON.stringify({ at, input_tokens: inputTokens, model, caller }) + '\n', { mode: 0o600 });
  } catch { /* Accounting failure cannot break the answer. */ }
}

// First body PER candidate status wins across processes; never classify a
// rate-limit, authentication, validation or server error as exhausted credit.
export const isCreditCandidate = (status) => Number.isInteger(status) && status >= 400 && status < 500 && ![401, 422, 429].includes(status);
export async function recordCreditError(body, status, caller, model, dir = jevStateDir(), at = new Date().toISOString()) {
  if (!isCreditCandidate(status) || typeof body !== 'string') return;
  const entry = JSON.stringify({ at, type: 'credit-error', status, model, caller, body });
  try {
    await fs.mkdir(dir, { recursive: true });
    const marker = await fs.open(join(dir, `first-credit-error-${status}.json`), 'wx', 0o600);
    try {
      await marker.writeFile(entry + '\n');
      await fs.appendFile(ledgerPath(dir, at), entry + '\n', { mode: 0o600 });
    } finally { await marker.close(); }
  } catch { /* A second process already recorded it, or accounting is unavailable. */ }
}

export async function setJevBalance(usd, dir = jevStateDir(), at = new Date().toISOString()) {
  if (!Number.isFinite(usd) || usd < 0 || !Number.isFinite(Date.parse(at))) throw new Error('balance must be a non-negative finite USD amount');
  await fs.mkdir(dir, { recursive: true });
  const temp = join(dir, `balance.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify({ usd, at }) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, balancePath(dir));
  } finally { await fs.rm(temp, { force: true }); }
  return { usd, at };
}

/** Read only months from the balance entry (or the last seven days). Legacy
 * usage.jsonl is included for continuity with callers running the old version.
 * Skipped rows are explicit: the resulting sums are lower bounds, not exact. */
export async function readJevEstimate(dir = jevStateDir(), now = Date.now()) {
  let balance = null;
  try {
    balance = JSON.parse(await fs.readFile(balancePath(dir), 'utf8'));
    if (!Number.isFinite(balance.usd) || balance.usd < 0 || !Number.isFinite(Date.parse(balance.at)) || Date.parse(balance.at) > now) return null;
  } catch (error) { if (error.code !== 'ENOENT') return null; }
  const weekStart = now - 7 * 86400_000;
  const start = balance ? Date.parse(balance.at) : weekStart;
  // Accept a writer that started just after this board poll captured `now`.
  const end = now + 10_000;
  let names;
  try { names = await fs.readdir(dir); }
  catch (error) { if (error.code !== 'ENOENT') return null; names = []; }
  const allLedgers = names.filter((name) => name === 'usage.jsonl' || /^usage-\d{4}-\d{2}\.jsonl$/.test(name));
  if (!allLedgers.length && !balance) return null;
  const fromMonth = new Date(start).toISOString().slice(0, 7);
  const toMonth = new Date(end).toISOString().slice(0, 7);
  const selected = allLedgers.filter((name) => name === 'usage.jsonl' || (name.slice(6, 13) >= fromMonth && name.slice(6, 13) <= toMonth));
  let texts;
  try { texts = await Promise.all(selected.map((name) => fs.readFile(join(dir, name), 'utf8'))); }
  catch { return null; } // An unreadable month is not an empty month.
  const today = new Date(now).toDateString(); // machine-local day, not UTC
  let todayTokens = 0; let sinceTokens = 0; let weekTokens = 0; let skippedRows = 0;
  for (const text of texts) for (const row of text.split('\n')) {
    if (!row) continue;
    let item;
    try { item = JSON.parse(row); } catch { skippedRows++; continue; }
    if (item?.type === 'credit-error') continue;
    const time = typeof item?.at === 'string' ? Date.parse(item.at) : NaN;
    if (!Number.isSafeInteger(item?.input_tokens) || item.input_tokens < 0 || !Number.isFinite(time)
      || time > end || typeof item.model !== 'string' || !JEV_MODEL_ID.test(item.model)) { skippedRows++; continue; }
    if (time < start) continue;
    if (new Date(time).toDateString() === today) todayTokens += item.input_tokens;
    if (balance) sinceTokens += item.input_tokens;
    if (time >= weekStart) weekTokens += item.input_tokens;
  }
  const price = (tokens) => tokens * JEV_INPUT_USD_PER_MILLION / 1_000_000;
  if (!balance) return { todayUsd: price(todayTokens), balance: null, remainingUsd: null, days: null, skippedRows };
  const remainingUsd = balance.usd - price(sinceTokens);
  const dailyUsd = price(weekTokens) / 7;
  return { todayUsd: price(todayTokens), balance, remainingUsd, days: dailyUsd > 0 ? Math.max(0, remainingUsd) / dailyUsd : null, skippedRows };
}

export function jevCache(read = readJevEstimate, ttlMs = 60_000) {
  let cache = null; let inFlight = null;
  return () => {
    if (cache && Date.now() - cache.at < ttlMs) return Promise.resolve(cache.value);
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(read).then((value) => { cache = { at: Date.now(), value }; inFlight = null; return value; }, () => { cache = { at: Date.now(), value: null }; inFlight = null; return null; });
    return inFlight;
  };
}
export const cachedJevEstimate = jevCache();
