#!/usr/bin/env node
// What each provider family has already spent of its window, for the lead that
// is about to seat a coder or a reviewer.
//
// The usage-monitor Paseo plugin draws these numbers on the dashboard, and the
// operator asked that seats be chosen by load rather than by habit. The plugin
// answers only its own in-process RPC (`usage.limits.read`), so a lead in a
// terminal cannot read it; this script talks to the same endpoints with the same
// credentials the plugin resolves, and prints one line per family.
//
// Credentials are READ, never copied and never refreshed here — a refresh rotates
// the grant that owns the session (decision 10650). A stale token is reported
// as stale. Codex and grok also read Pi's ~/.pi/agent/auth.json; every other
// family still reads the file its own CLI maintains.
//
// Usage:
//   node ops/usage-snapshot.mjs            # table, least-loaded first
//   node ops/usage-snapshot.mjs --json     # machine-readable
//
// The orch daemon imports takeSnapshot() to tell a lead the load of the family
// it is about to seat (ops/orchestrator/src/limits.ts).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCache } from './usage-cache.mjs';
import { chromeCookieHeader } from './chrome-cookies.mjs';
import { MIMO_PLAN_START_UTC, stateDirFor } from './orchestrator/src/config.ts';

const HOME = homedir();
const TIMEOUT_MS = 15_000;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Kimi 2.1.1 stores non-default OAuth hosts in kimi-code-env-<host hash>.json.
// Read both formats; a stale legacy slot must not hide the fresher CLI session.
function kimiCliCredential(home) {
  const dir = path.join(home, '.kimi-code', 'credentials');
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  let latest = null;
  let expiry = -Infinity;
  for (const name of names) {
    if (name !== 'kimi-code.json' && !/^kimi-code-env-[a-f0-9]+\.json$/.test(name)) continue;
    const entry = readJson(path.join(dir, name));
    if (typeof entry?.access_token !== 'string' || !entry.access_token) continue;
    const at = Number(entry.expires_at);
    const timestamp = entry.expires_at == null || !Number.isFinite(at) ? -Infinity : at;
    if (latest === null || timestamp > expiry) { latest = entry; expiry = timestamp; }
  }
  return latest;
}

function at(document, segments) {
  let current = document;
  for (const key of segments) {
    if (current === null || typeof current !== 'object') return null;
    current = current[key];
    if (current === undefined) return null;
  }
  return current ?? null;
}

async function getJson(url, headers, options = {}) {
  const response = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  return JSON.parse(text);
}

// Reset failures are independent of usage, and raw redemption handles never
// enter a snapshot. Only our own parser reasons and transport status classes
// are safe to report; a response body may quote secrets, so it never reaches
// the row.
async function withResets(readings, read) {
  try { return { readings, resets: await read(), resetsError: null }; }
  catch (error) {
    const status = /^HTTP (\d+)/.exec(String(error?.message ?? ''));
    return { readings, resets: null, resetsError: error.inventoryReason ?? (status ? `reset request failed: HTTP ${status[1]}` : 'reset inventory read failed') };
  }
}

function inventoryFailure(reason) {
  throw Object.assign(new Error(reason), { inventoryReason: reason });
}

function resetCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) inventoryFailure('reset count missing or malformed');
  return value;
}

function resetList(value) {
  if (!Array.isArray(value)) inventoryFailure('reset list missing or malformed');
  return value;
}

function resetExpiry(value, allowUnzoned = false) {
  if (value == null) return null;
  // GLM's unzoned expireTime is not an instant; do not guess its timezone.
  if (allowUnzoned && typeof value === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d$/.test(value)) return null;
  const timestamp = typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) inventoryFailure('reset expiry malformed');
  return new Date(timestamp).toISOString();
}

function groupResets(entries, scope) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = `${entry.scope}:${entry.expiresAt}`;
    const previous = grouped.get(key);
    if (previous) previous.available = resetCount(previous.available + entry.available);
    else grouped.set(key, { ...entry });
  }
  return grouped.size ? [...grouped.values()] : scope ? [{ scope, available: 0, expiresAt: null }] : [];
}

function claudeResets(data, now) {
  const status = data.cedar_ember;
  if (status?.eligible !== true) inventoryFailure(status?.ineligible_reason === 'surface'
    ? 'reset inventory unavailable on this surface' : 'reset eligibility missing or unavailable');
  const entries = [];
  for (const grant of resetList(status.grants)) {
    const available = resetCount(grant?.resets_left);
    if (grant.resets_total != null && resetCount(grant.resets_total) < available) inventoryFailure('reset count exceeds grant total');
    if (typeof grant.paused !== 'boolean') inventoryFailure('reset pause state missing');
    const expiresAt = resetExpiry(grant.ends_at);
    const startsAt = resetExpiry(grant.starts_at);
    if (grant.paused || available === 0 || (expiresAt && Date.parse(expiresAt) <= now)
      || (startsAt && Date.parse(startsAt) > now)) continue;
    const clears = resetList(grant.clears);
    if (clears.some((key) => key !== 'five_hour' && key !== 'seven_day')) inventoryFailure('reset scope unknown');
    const five = clears.includes('five_hour'), week = clears.includes('seven_day');
    if (!five && !week) inventoryFailure('reset scope missing');
    entries.push({ scope: five && week ? 'both' : five ? '5h' : 'week', available, expiresAt });
  }
  return groupResets(entries);
}

function glmResets(data) {
  if (data?.success === false || (data?.code != null && data.code !== 200)) inventoryFailure('glm reset inventory refused');
  return [['fiveHourResets', '5h'], ['weekResets', 'week']].flatMap(([key, scope]) => {
    const entries = resetList(data?.data?.[key]);
    if (entries.some((entry) => typeof entry?.available !== 'boolean')) inventoryFailure('glm reset availability missing');
    return groupResets(entries.filter((entry) => entry.available === true)
      .map((entry) => ({ scope, available: 1, expiresAt: resetExpiry(entry.expireTime, true) })), scope);
  });
}

function readVarint(bytes, offset) {
  let value = 0;
  let scale = 1;
  while (offset < bytes.length && scale <= 2 ** 42) {
    const byte = bytes[offset++];
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value, offset };
    scale *= 128;
  }
  return null; // truncated, or wider than the 48 bits any reset field needs
}

// One level of protobuf wire fields: [{field, wire, varint? | bytes?}]. Null
// when a field is truncated or uses a wire type the reset answer never has
// (groups, fixed32/64); the caller then reports the answer as not understood.
function protoFields(bytes) {
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    if (!key) return null;
    offset = key.offset;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (wire === 0) {
      const value = readVarint(bytes, offset);
      if (!value) return null;
      offset = value.offset;
      fields.push({ field, wire, varint: value.value });
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      if (!length) return null;
      offset = length.offset;
      if (offset + length.value > bytes.length) return null;
      fields.push({ field, wire, bytes: bytes.subarray(offset, offset + length.value) });
      offset += length.value;
    } else return null;
  }
  return fields;
}

// grok's GetRemainingResets is a gRPC-web method, not Connect JSON: a JSON body
// is answered HTTP 200 `application/grpc`, empty, `grpc-status: 13` "Unexpected
// EOF decoding stream." (live 2026-10-15). Unary gRPC-web is a 5-byte frame
// header (flag 0, big-endian length) around the empty request message; the
// answer is frames — flag 0x00 messages, flag 0x80 trailers carrying
// `grpc-status` — or, on refusal, trailers-only in the response headers.
const GRPC_WEB_EMPTY = new Uint8Array(5);

async function getGrpcWeb(url, headers, fetchImpl = fetch) {
  const response = await fetchImpl(url, { method: 'POST', headers, body: GRPC_WEB_EMPTY, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) inventoryFailure(`grok reset inventory refused: HTTP ${response.status}`);
  // Number(null) is 0: an absent header status is not a success status.
  const rawStatus = response.headers.get('grpc-status');
  const headerStatus = rawStatus && Number.isFinite(Number(rawStatus)) ? Number(rawStatus) : null;
  if (headerStatus !== null && headerStatus !== 0) {
    let message = String(response.headers.get('grpc-message') ?? '');
    try { message = decodeURIComponent(message); } catch { /* keep the raw server text */ }
    const note = message.replace(/\s+/g, ' ').slice(0, 120);
    inventoryFailure(`grok reset inventory refused: grpc ${headerStatus}${note ? `: ${note}` : ''}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (headerStatus === 0 && bytes.length === 0) return new Uint8Array(0); // trailers-only success carries no message
  const parts = [];
  let status = null;
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 5 > bytes.length) inventoryFailure('grok reset answer truncated');
    const flag = bytes[offset];
    const length = ((bytes[offset + 1] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 8) | bytes[offset + 4]) >>> 0;
    offset += 5;
    if (offset + length > bytes.length) inventoryFailure('grok reset answer truncated');
    const payload = bytes.subarray(offset, offset + length);
    offset += length;
    if (flag === 0x80) {
      const found = /grpc-status:\s*(-?\d+)/.exec(new TextDecoder().decode(payload));
      if (found) status = Number(found[1]);
    } else if (flag <= 1) parts.push(payload);
    else inventoryFailure('grok reset answer frame unknown');
  }
  if (status !== null && status !== 0) inventoryFailure(`grok reset inventory refused: grpc ${status}`);
  if (status === null) inventoryFailure('grok reset answer carried no grpc status');
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

// The answer's protobuf schema is not published. A token is a message holding
// a printable id string and a nested timestamp in unix seconds (2020..2100).
// Every length-delimited entry must be such a token; anything else reads
// unknown, never a guessed or partial count. An empty message is no tokens.
function grokResetTokens(message) {
  if (message.length === 0) return [];
  const top = protoFields(message);
  if (!top) inventoryFailure('grok reset answer malformed');
  const decoder = new TextDecoder();
  const tokens = [];
  let entries = 0;
  for (const entry of top) {
    if (entry.wire !== 2) continue;
    entries += 1;
    const fields = protoFields(entry.bytes);
    if (!fields) continue;
    let tokenId = null;
    let seconds = null;
    for (const field of fields) {
      if (field.wire !== 2) continue;
      const text = decoder.decode(field.bytes);
      if (tokenId === null && /^[\x20-\x7e]{1,128}$/.test(text)) { tokenId = text; continue; }
      if (seconds === null) {
        const inner = protoFields(field.bytes);
        if (inner) for (const item of inner) {
          if (item.wire === 0 && item.varint >= 1_600_000_000 && item.varint <= 4_102_444_800) { seconds = item.varint; break; }
        }
      }
    }
    if (tokenId !== null && seconds !== null) tokens.push({ tokenId, validityEnd: { seconds } });
  }
  if (entries === 0 || tokens.length !== entries) inventoryFailure('grok reset answer not understood');
  return tokens;
}

// Families whose subscriptions bank resets. Their empty resets row is a confirmed
// zero — a reading that ages with the snapshot; every other family's [] row means
// "no reset program" and never ages (read again by limits.ts inventory()).
export const RESET_PROGRAM_FAMILIES = ['claude', 'astra', 'grok', 'glm'];

function grokResets(tokens, now) {
  // ConsumerUiSvc tokens clear weekly usage (Grok Quota Display Pro's reset UI).
  const seen = new Set();
  const entries = [];
  for (const token of resetList(tokens)) {
    const id = token?.tokenId;
    if (typeof id !== 'string' || !id || seen.has(id)) inventoryFailure('grok reset token missing or duplicated');
    seen.add(id);
    const seconds = token?.validityEnd?.seconds;
    if (!Number.isFinite(seconds)) inventoryFailure('grok reset validity missing');
    const expiresAt = resetExpiry(new Date(seconds * 1000).toISOString());
    if (Date.parse(expiresAt) > now) entries.push({ scope: 'week', available: 1, expiresAt });
  }
  // No scope fallback: an account with no remaining tokens is an empty list.
  return groupResets(entries);
}

function secondsToWindow(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const hours = seconds / 3600;
  return hours >= 24 ? `${Math.round(hours / 24)}d` : `${Math.round(hours)}h`;
}

// Anthropic hands the OAuth token to Claude Code, which keeps it in a file on
// Linux and Windows and in the login Keychain on macOS (`Claude Code-credentials`,
// the item agtop reads; `security` answers without a dialog, checked 2026-09-22).
// Read only: a refresh rotates the refresh token and would have to be written
// back, and Claude Code refreshes it itself on its next run.
// Async: the orch daemon takes snapshots in-process, and a blocking call would
// stall its HTTP server for up to TIMEOUT_MS (review 2026-09-22). Of the file and
// the Keychain item, the token that expires last wins: a stale file must not
// hide the live Keychain token.
export async function claudeCredentials({ lookup = promisify(execFile), home = HOME } = {}) {
  const found = [at(readJson(path.join(home, '.claude', '.credentials.json')), ['claudeAiOauth'])];
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await lookup('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: TIMEOUT_MS });
      found.push(JSON.parse(stdout.trim())?.claudeAiOauth);
    } catch (error) {
      // Never log the secret or retry with writes; report the actual Keychain error separately.
      console.error(`Claude Keychain read failed: ${error.code ?? 'unknown'} ${String(error.stderr ?? '').trim().slice(0, 160)}`);
    }
  }
  const expiry = (entry) => (Number.isFinite(Number(entry.expiresAt)) ? Number(entry.expiresAt) : 0);
  return found.filter((entry) => entry?.accessToken).sort((a, b) => expiry(b) - expiry(a))[0] ?? null;
}

export async function claude({ credentials, request = getJson, now = Date.now, details = false } = {}) {
  credentials ??= await claudeCredentials();
  if (credentials?.accessToken) {
    const expiresAt = Number(credentials.expiresAt);
    // 0 or absent means the source did not say (as agtop reads it), not that the token expired in 1970.
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()) {
      const minutes = Math.round((Date.now() - expiresAt) / 60_000);
      throw new Error(`token expired ${minutes} min ago — Claude Code refreshes it on its next run`);
    }
    // The endpoint rate-limits hard: HTTP 429 on 2026-09-22 while agtop polled it every 15 s.
    // orch asks every 5 minutes and keeps the last good reading through a failed one.
    const data = await request('https://api.anthropic.com/api/oauth/usage' + (details ? '?cedar_ember=1' : ''), {
      Authorization: `Bearer ${credentials.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    });
    // `limits[]` carries the per-model weekly bucket too (`weekly_scoped`, the
    // one Paseo labels "Weekly · Fable"), which the flat five_hour/seven_day
    // pair does not. A family can be fine on its overall week and still be one
    // model away from its wall.
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const readings = limits.length > 0
      ? limits.map((limit) => ({
        window: limit.scope?.model?.display_name
          ? `${limit.kind === 'session' ? '5h' : '7d'}·${limit.scope.model.display_name}`
          : limit.kind === 'session'
            ? '5h'
            : '7d',
        used: limit.percent,
        resetsAt: limit.resets_at,
        resolution: 'integer',
      }))
      : [
        { window: '5h', used: at(data, ['five_hour', 'utilization']), resetsAt: at(data, ['five_hour', 'resets_at']) },
        { window: '7d', used: at(data, ['seven_day', 'utilization']), resetsAt: at(data, ['seven_day', 'resets_at']) },
      ];
    return details ? withResets(readings, () => claudeResets(data, now())) : readings;
  }
  throw new Error(process.platform === 'darwin'
    ? 'no Claude Code access token in the Keychain (`Claude Code-credentials`) or ~/.claude/.credentials.json — sign in to Claude Code again'
    : 'no token in ~/.claude/.credentials.json — sign in to Claude Code again');
}

function piEntry(home, name) {
  return at(readJson(path.join(home, '.pi', 'agent', 'auth.json')), [name]);
}

function httpAuthRefusal(error) {
  return /\bHTTP 40[13]\b/.test(String(error?.message ?? ''));
}

// Pi is listed first, so an equal expiry keeps that login. A missing expiry
// sorts last and is not treated as a date.
function byLaterExpiry(left, right) {
  return (right.expires ?? -Infinity) - (left.expires ?? -Infinity);
}

function scrubBearer(error, stores) {
  const secrets = [];
  for (const store of stores ?? []) {
    if (typeof store?.token === 'string' && store.token.length >= 8) secrets.push(store.token);
  }
  const original = String(error?.message ?? error);
  let message = original;
  for (const secret of secrets) {
    if (message.includes(secret)) message = message.split(secret).join('[redacted]');
  }
  if (message === original && error instanceof Error) return error;
  return new Error(message);
}

// Freshness is decided again immediately before each send. A store that expired
// during the previous attempt is skipped and never given to the request.
async function readFreshStore(assess, call, now) {
  const startedFresh = new Set(assess(now()).filter((store) => store.fresh).map((store) => store.name));
  const seen = new Set();
  let expiredSkip = false;
  let authError = null;
  while (seen.size < 2) {
    const selected = assess(now());
    const pick = selected.filter((store) => store.fresh && !seen.has(store.name)).sort(byLaterExpiry)[0];
    if (!pick) {
      const skipped = selected.some((store) => startedFresh.has(store.name) && !seen.has(store.name) && store.expired);
      if (skipped) expiredSkip = true;
      break;
    }
    seen.add(pick.name);
    const live = assess(now()).find((store) => store.name === pick.name);
    if (!live?.fresh) {
      expiredSkip = true;
      continue;
    }
    try {
      return { store: live, data: await call(live) };
    } catch (error) {
      const safe = scrubBearer(error, assess(now()));
      if (!httpAuthRefusal(error)) throw safe;
      authError = safe;
    }
  }
  if (expiredSkip) throw new Error('token expired');
  if (authError) throw authError;
  return null;
}

function piOauth(entry, now) {
  const access = typeof entry?.access === 'string' ? entry.access : '';
  const expires = Number(entry?.expires);
  const dated = Number.isFinite(expires) && expires > 0;
  return {
    name: 'pi',
    token: access,
    expires: dated ? expires : null,
    present: entry?.type === 'oauth' && access.length > 0,
    freshClock: dated && expires > now,
    expired: dated && expires <= now,
  };
}

function codexCliStore(auth, now) {
  const token = at(auth, ['tokens', 'access_token']);
  const accountId = at(auth, ['tokens', 'account_id']);
  const access = typeof token === 'string' ? token : '';
  const account = typeof accountId === 'string' ? accountId : '';
  let expiresAt;
  if (access) {
    // A token whose exp or account cannot be parsed is not usable. Do not treat
    // a malformed payload as fresh: that would refuse a valid Pi login as mixed.
    try {
      const payload = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8'));
      const exp = Number(payload?.exp);
      if (Number.isFinite(exp) && exp > 0) expiresAt = exp * 1000;
    } catch { /* not a parseable JWT */ }
  }
  const known = Number.isFinite(expiresAt) && expiresAt > 0;
  const expired = known && expiresAt <= now;
  return {
    name: 'codex-cli',
    token: access,
    accountId: account,
    expires: known ? expiresAt : null,
    present: access.length > 0,
    expired,
    fresh: known && account.length > 0 && !expired,
    missingAccount: access.length > 0 && account.length === 0,
}
}

function codexPiStore(entry, now) {
  const base = piOauth(entry, now);
  const accountId = typeof entry?.accountId === 'string' ? entry.accountId : '';
  return {
    ...base,
    accountId,
    fresh: base.present && base.freshClock && accountId.length > 0,
    missingAccount: base.present && accountId.length === 0,
  };
}

function codexMissing(piStore, cliStore) {
  if (!piStore.present && cliStore.expired) throw new Error('token expired — run `node ops/bootstrap/harness-login.mjs codex`');
  if (!piStore.present && cliStore.missingAccount) throw new Error('no tokens.account_id in ~/.codex/auth.json — run `node ops/bootstrap/harness-login.mjs codex`');
  if (!piStore.present && !cliStore.present) throw new Error('no tokens.access_token in ~/.codex/auth.json — run `node ops/bootstrap/harness-login.mjs codex`');
  if (piStore.expired && cliStore.expired) throw new Error('token expired in both Pi and codex CLI — run `node ops/bootstrap/harness-login.mjs codex`');
  if (piStore.missingAccount && !cliStore.fresh) throw new Error('openai-codex Pi entry has no accountId — refusing another store\'s ChatGPT account');
  if (piStore.expired && !cliStore.fresh) throw new Error('token expired in Pi — run `node ops/bootstrap/harness-login.mjs codex`');
  if (cliStore.expired && !piStore.fresh) throw new Error('token expired — run `node ops/bootstrap/harness-login.mjs codex`');
  throw new Error('no codex credential — run `node ops/bootstrap/harness-login.mjs codex`');
}

// Pi openai-codex (access + its own accountId) or the CLI JWT. Never pair one
// store's access with the other store's account id: without the matching
// ChatGPT-Account-Id the endpoint answers a different scope (72% used where the
// codex app-server and GUI said 36%, measured 2026-09-29). The fresh store with
// the later expiry goes first; HTTP 401 or 403 tries the other fresh store once.
export async function codex({
  home = HOME,
  pi = piEntry(home, 'openai-codex'),
  auth = readJson(path.join(home, '.codex', 'auth.json')),
  request = getJson,
  now = Date.now,
  details = false,
} = {}) {
  const assess = (at) => [codexPiStore(pi, at), codexCliStore(auth, at)];
  const opened = assess(now());
  if (opened[0].fresh && opened[1].fresh && opened[0].accountId !== opened[1].accountId) {
    throw new Error('refusing mixed ChatGPT accounts — Pi openai-codex and codex CLI are different accounts');
  }
  const answer = await readFreshStore(assess, (store) => request('https://chatgpt.com/backend-api/wham/usage', {
    Authorization: `Bearer ${store.token}`,
    'ChatGPT-Account-Id': store.accountId,
  }), now);
  if (!answer) {
    const [piStore, cliStore] = assess(now());
    codexMissing(piStore, cliStore);
  }
  const windows = [
    ['primary_window', at(answer.data, ['rate_limit', 'primary_window'])],
    ['secondary_window', at(answer.data, ['rate_limit', 'secondary_window'])],
  ];
  const readings = windows
    .filter(([, value]) => value)
    .map(([, value]) => ({
      window: secondsToWindow(value.limit_window_seconds) ?? 'window',
      used: value.used_percent,
      resetsAt: value.reset_at ? new Date(value.reset_at * 1000).toISOString() : null,
      source: answer.store.name,
    }));
  return details ? withResets(readings, () => [{
    scope: 'both', available: resetCount(answer.data?.rate_limit_reset_credits?.available_count), expiresAt: null,
  }]) : readings;
}

// grok 1.0.x keys auth.json by account URL and keeps the bearer in `key`.
// Pi's xai entry keeps it in `access`. Probed 2026-10-15: billing?format=credits
// accepted that Pi token with the same X-XAI-Token-Auth header (HTTP 200).
//
// The query parameter is the whole trick: bare `/v1/billing` answers with the
// PREPAID ledger, which a flat subscription never touches — monthlyLimit 0 and
// used 0, measured 2026-09-17 on a working account, and every other path on that
// host is a 404. `?format=credits` answers with the subscription's own window:
// `creditUsagePercent` against `currentPeriod`. agtop reads the same URL
// (~/Developer/agtop/src/collector/grok.rs:36), which is how it was found.
function grokCliStore(document, now) {
  const entry = document && typeof document === 'object' ? Object.values(document)[0] : null;
  const token = typeof entry?.key === 'string' ? entry.key : '';
  const expiresAt = Date.parse(entry?.expires_at ?? '');
  const known = Number.isFinite(expiresAt);
  // Past expires_at the billing call is a 401 until grok's own next run refreshes it.
  const expired = known && expiresAt < now;
  return {
    name: 'grok-cli',
    token,
    expires: known ? expiresAt : null,
    present: token.length > 0,
    expired,
    fresh: token.length > 0 && !expired,
  };
}

function grokMissing(piStore, cliStore, now) {
  const hours = () => Math.round((now - cliStore.expires) / 3_600_000);
  if (!piStore.present && !cliStore.present) throw new Error('no account entry with a `key` in ~/.grok/auth.json — run `node ops/bootstrap/harness-login.mjs grok`');
  if (!piStore.present && cliStore.expired) throw new Error(`token expired ${hours()}h ago — run \`node ops/bootstrap/harness-login.mjs grok\``);
  if (piStore.expired && cliStore.expired) throw new Error('token expired in both Pi and grok CLI — run `node ops/bootstrap/harness-login.mjs grok`');
  if (piStore.expired && !cliStore.fresh) throw new Error('token expired in Pi — run `node ops/bootstrap/harness-login.mjs grok`');
  if (cliStore.expired && !piStore.fresh) throw new Error(`token expired ${hours()}h ago — run \`node ops/bootstrap/harness-login.mjs grok\``);
  throw new Error('no grok credential — run `node ops/bootstrap/harness-login.mjs grok`');
}

export async function grok({
  home = HOME,
  pi = piEntry(home, 'xai'),
  auth = readJson(path.join(home, '.grok', 'auth.json')),
  request = getJson,
  resetFetch = fetch,
  now = Date.now,
  details = false,
} = {}) {
  const assess = (at) => {
    const base = piOauth(pi, at);
    return [{ ...base, fresh: base.present && base.freshClock }, grokCliStore(auth, at)];
  };
  const answer = await readFreshStore(assess, (store) => request('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
    Authorization: `Bearer ${store.token}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
  }), now);
  if (!answer) {
    const [piStore, cliStore] = assess(now());
    grokMissing(piStore, cliStore, now());
  }
  // Number(null) is 0. Only a number or a non-blank numeric string is a share.
  const raw = at(answer.data, ['config', 'creditUsagePercent']);
  // The answer is protobuf JSON (USAGE_PERIOD_TYPE_* enums, {val} wrappers), which
  // omits a scalar at its default. From the weekly reset of 2026-10-21T19:48Z the key
  // was absent while currentPeriod named the new week. So an ABSENT key beside a whole
  // currentPeriod is 0%; null, blank, text, or no such period is still a failed read.
  const config = at(answer.data, ['config']);
  const current = at(answer.data, ['config', 'currentPeriod']);
  const omittedZero = config !== null && typeof config === 'object' && !Object.hasOwn(config, 'creditUsagePercent')
    && typeof current?.type === 'string' && current.type !== ''
    && Number.isFinite(Date.parse(current.start ?? '')) && Number.isFinite(Date.parse(current.end ?? ''));
  const percent = omittedZero ? 0 : typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(percent)) throw new Error('config.creditUsagePercent missing from the grok answer');
  const period = String(at(answer.data, ['config', 'currentPeriod', 'type']) ?? '');
  const readings = [{
    window: period.endsWith('WEEKLY') ? '7d' : period.endsWith('MONTHLY') ? 'month' : 'period',
    used: Number(percent),
    resetsAt: at(answer.data, ['config', 'currentPeriod', 'end']),
    source: answer.store.name,
  }];
  if (!details) return readings;
  return withResets(readings, async () => {
    const inventory = await readFreshStore(assess, (store) => getGrpcWeb('https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets', {
      Authorization: `Bearer ${store.token}`, 'X-XAI-Token-Auth': 'xai-grok-cli',
      'Content-Type': 'application/grpc-web',
    }, resetFetch), now);
    if (!inventory) inventoryFailure('grok reset credential unavailable');
    return grokResets(grokResetTokens(inventory.data), now());
  });
}

// qwen's Token Plan (Qwen Cloud, individual) has no usage API its sk-sp- plan
// key can reach (memory #10506). The console session of the official Model
// Studio CLI can: `bl auth login --console --console-site international` stores
// it in ~/.bailian/config.json, and this reads the same console gateway that
// `bl usage token-plan` calls. bl 2.0.1 prints `{}` for a Pro plan because it
// looks for other fields; the gateway answers per1MonthPercentage as a fraction
// (0.0031 = 0.31% of Pro's 180000 monthly credits, checked 2026-09-22). The
// session has no refresh token: when it lapses, say how to sign in again.
// Region x site -> console gateway, as bailian-cli-core 2.0.1 maps them.
const QWEN_GATEWAY = {
  'cn-beijing': { domestic: ['bailian-cs.console.aliyun.com', 'BroadScopeAspnGateway'], international: ['bailian-cs.console.alibabacloud.com', 'BroadScopeAspnGateway'] },
  'ap-southeast-1': { domestic: ['modelstudio-cs.console.aliyun.com', 'IntlBroadScopeAspnGateway'], international: ['bailian-singapore-cs.alibabacloud.com', 'IntlBroadScopeAspnGateway'] },
};
const QWEN_WINDOW = { Hour: 'h', Week: 'w', Month: 'month' };

export async function qwen({ config = readJson(path.join(HOME, '.bailian', 'config.json')), request = fetch } = {}) {
  if (!config?.access_token) throw new Error('no Model Studio console session — run `bl auth login --console --console-site international`');
  const region = config.console_region ?? 'ap-southeast-1';
  const site = config.console_site ?? 'international';
  const gateway = QWEN_GATEWAY[region]?.[site];
  if (!gateway) throw new Error(`no console gateway known for ${region} ${site}`);
  const [host, action] = gateway;
  const api = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage';
  const params = JSON.stringify({ Api: api, V: '1.0', Data: { cornerstoneParam: { protocol: 'V2', console: 'ONE_CONSOLE', productCode: 'p_efm', switchUserType: 3, consoleSite: 'BAILIAN_ALIYUN', ...(config.console_switch_agent ? { switchAgent: config.console_switch_agent } : {}) } } });
  const response = await request(`https://${host}/cli/api.json?action=${action}&product=sfm_bailian&api=${encodeURIComponent(api)}`, {
    method: 'POST',
    headers: { Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${config.access_token}` },
    body: new URLSearchParams({ params, region }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  const body = JSON.parse(text);
  const raw = at(body, ['data', 'errorCode']) ?? at(body, ['code']) ?? '';
  const code = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (/NotLogin/i.test(code)) throw new Error(`console session expired — sign in again with \`bl auth login --console --console-site ${site}\``);
  const data = at(body, ['data', 'DataV2', 'data', 'data']);
  if (!data || typeof data !== 'object') throw new Error(`no usage in the console answer (${code || 'no code'})`);
  // The monthly share drives the Token Plan; an answer with only hourly/weekly
  // readings (e.g. fresh windows at 0 while the month is absent or string-typed)
  // is a failed read — unknown, never an idle 0% that limits.ts would keep as
  // last-good (task 1479: the picker flapped 0% <-> ~10%; this shape is the code
  // path that could produce it, the live 0% answer was not captured).
  let hasMonth = false;
  const readings = Object.entries(data).flatMap(([key, value]) => {
    const match = /^per(\d+)(Hour|Week|Month)Percentage$/.exec(key);
    // A share sent as a decimal string is coerced so a string month is not
    // dropped. Null, empty, boolean or non-decimal text ('0x1') stays no reading,
    // never a 0% (Number(null), Number('') and Number(false) are all 0).
    const share = match && (typeof value === 'number' || (typeof value === 'string' && /^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(value))) ? Number(value) : NaN;
    if (!match || !Number.isFinite(share)) return [];
    if (match[2] === 'Month') hasMonth = true;
    const reset = Number(data[`per${match[1]}${match[2]}ResetTime`]);
    const unit = QWEN_WINDOW[match[2]];
    const window = unit === 'month' ? (match[1] === '1' ? 'month' : `${match[1]}month`) : unit === 'w' ? `${Number(match[1]) * 7}d` : `${match[1]}${unit}`;
    return [{ window, used: share * 100, resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null, resolution: 'fractional' }];
  });
  if (!readings.length) throw new Error('the console answer has no usage window');
  if (!hasMonth) throw new Error('the console answer has no monthly usage share — a qwen read without the plan-driving month is unknown, never 0');
  return readings;
}

// MiMo's console Cookie comes from the operator's Chrome session on each read
// (operator decision #12040). Never include a response body, fetch exception,
// or the Cookie in an error shown on the board; chromeCookieHeader's errors are
// labels only and pass through as the reason.
// Every host_key Chrome sends to platform.xiaomimimo.com; the session
// (api-platform_serviceToken) lives on .platform.xiaomimimo.com.
const MIMO_COOKIE_HOSTS = ['platform.xiaomimimo.com', '.platform.xiaomimimo.com', '.xiaomimimo.com'];
const MIMO_USAGE_URL = new URL('https://platform.xiaomimimo.com/api/v1/tokenPlan/usage');

export async function mimo({ cookieHeader = () => chromeCookieHeader({ hosts: MIMO_COOKIE_HOSTS, requestPath: MIMO_USAGE_URL.pathname }),
  request = fetch, now = Date.now } = {}) {
  const cookie = await cookieHeader();
  let response;
  try {
    response = await request(MIMO_USAGE_URL.href, {
      headers: { Cookie: cookie, Accept: 'application/json', 'Content-Type': 'application/json', 'x-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { throw new Error('mimo usage request failed'); }
  // A rejected Cookie means the Chrome session lapsed: log in again in Chrome.
  if (response.status === 401 || response.status === 403) throw new Error('mimo cookie expired or rejected');
  if (!response.ok) throw new Error('mimo usage request failed');
  let body;
  try { body = await response.json(); } catch { throw new Error('mimo usage answer malformed'); }
  if (body?.code !== 0) throw new Error('mimo cookie expired or rejected');
  const items = body.data?.usage?.items;
  const item = Array.isArray(items) ? items.find((entry) => entry?.name === 'plan_total_token') : null;
  if (typeof item?.used !== 'number' || !Number.isFinite(item.used)
    || item.used < 0 || typeof item.limit !== 'number' || !Number.isFinite(item.limit) || item.limit <= 0) {
    throw new Error('mimo plan_total_token missing or malformed');
  }
  // Prefer a vendor expiry when present; otherwise roll the operator's purchase
  // date forward by calendar months, not by a fixed number of days.
  const expiry = item.expiresAt ?? item.expireTime ?? body.data.usage.expiresAt ?? body.data.usage.expireTime
    ?? body.data.expiresAt ?? body.data.expireTime;
  let resetsAt;
  if (expiry != null) {
    const timestamp = typeof expiry === 'number' ? (expiry < 1e11 ? expiry * 1000 : expiry) : Date.parse(expiry);
    if (!Number.isFinite(timestamp)) throw new Error('mimo plan expiry malformed');
    resetsAt = new Date(timestamp).toISOString();
  } else {
    const [year, month, day] = MIMO_PLAN_START_UTC.split('-').map(Number);
    const current = now();
    let months = 1;
    let end = Date.UTC(year, month - 1 + months, day, 23, 59, 59);
    while (end <= current) end = Date.UTC(year, month - 1 + ++months, day, 23, 59, 59);
    resetsAt = new Date(end).toISOString();
  }
  return [{ window: 'month', used: item.used / item.limit * 100, creditsUsed: item.used, creditsLimit: item.limit, resetsAt, resolution: 'fractional' }];
}

export async function kimi({ pi = at(readJson(path.join(HOME, '.pi', 'agent', 'auth.json')), ['kimi-coding']),
  home = HOME, cli = kimiCliCredential(home), request = getJson, now = Date.now } = {}) {
  // Pi's session is separate from the kimi CLI's 900-second token; read both, write neither.
  const source = typeof pi?.access === 'string' && pi.access && Number.isFinite(Number(pi.expires)) && Number(pi.expires) > now()
    ? { token: pi.access, name: 'pi' }
    : typeof cli?.access_token === 'string' && cli.access_token && Number.isFinite(Number(cli.expires_at)) && Number(cli.expires_at) * 1000 > now()
      ? { token: cli.access_token, name: 'kimi-cli' }
      : null;
  if (!source) {
    if (!cli?.access_token) throw new Error('no kimi CLI access token — run `node ops/bootstrap/harness-login.mjs kimi`');
    if (pi?.access) throw new Error('token expired in both Pi and kimi CLI — run `node ops/bootstrap/harness-login.mjs kimi`');
    throw new Error('token expired in kimi CLI — run `node ops/bootstrap/harness-login.mjs kimi`');
  }
  const data = await request('https://api.kimi.com/coding/v1/usages', { Authorization: `Bearer ${source.token}` });
  // The answer carries the plan TWICE and only one copy has numbers in it.
  // `usage` (7d) and `limits[].detail` (a 300-minute window) are out of 100 and
  // move; the `usages.limit_5h|limit_7d.used_ratio` pair that arrived with kimi
  // 2.0 is hardcoded 0 and has never moved. Do not read it, and do not take the
  // kimi CLI panel or the web cabinet as ground truth either — they read that
  // same empty block, which is why all three agreed on a lie.
  //
  // Measured 2026-09-18: the operator's own account page said 69% for the week
  // while `used_ratio` said 0; the raw answer at that moment was
  // `usage.used: "69"` and `limits[0].detail.used: "53"`. The reset times match
  // across both blocks because they describe the same two windows — matching
  // reset times are NOT evidence that the numbers beside them are live.
  // An absent field is a failed read, never 0% (Number(null) is 0). The plan
  // bought 2026-09-28 omits `used` from limits[].detail while it is zero but
  // always sends `remaining` (live 18:07: limit "100", remaining "100", no
  // used), so `used` falls back to limit - remaining, never to a bare 0.
  const num = (value) => (value === null || value === '' ? NaN : Number(value));
  const readings = [];
  const week = num(at(data, ['usage', 'used']));
  const weekLimit = num(at(data, ['usage', 'limit']));
  if (Number.isFinite(week) && Number.isFinite(weekLimit) && weekLimit > 0) {
    readings.push({ window: '7d', used: Math.round((week / weekLimit) * 100), resetsAt: at(data, ['usage', 'resetTime']), source: source.name, resolution: 'integer' });
  }
  // Number(' '), Number(false) and Number([]) are 0: in this window only a number or a non-blank
  // numeric string counts, so nothing else can become 0 or 100%.
  const strict = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN);
  for (const entry of at(data, ['limits']) ?? []) {
    const limit = strict(at(entry, ['detail', 'limit']));
    const reported = strict(at(entry, ['detail', 'used']));
    const remaining = strict(at(entry, ['detail', 'remaining']));
    // A remaining outside [0, limit] would derive a negative or over-100 share: a failed read.
    const used = Number.isFinite(reported) ? reported
      : remaining >= 0 && remaining <= limit ? limit - remaining : NaN;
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) continue;
    const minutes = Number(at(entry, ['window', 'duration']));
    const label = at(entry, ['window', 'timeUnit']) === 'TIME_UNIT_MINUTE' && Number.isFinite(minutes)
      ? (minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`)
      : 'window';
    readings.push({ window: label, used: Math.round((used / limit) * 100), resetsAt: at(entry, ['detail', 'resetTime']), source: source.name, resolution: 'integer' });
  }
  // The plan bought 2026-09-28 has no `usage` week: its long window is a month
  // that only `usages.limit_month_total` carries. Unlike limit_5h beside it,
  // that ratio moves (0.0011 while limits[0] said 4% of 5h, same answer), so it
  // is the budget window the picker paces against.
  const month = num(at(data, ['usages', 'limit_month_total', 'used_ratio']));
  if (at(data, ['usage']) === null && Number.isFinite(month)) {
    readings.push({ window: 'month', used: month * 100, resetsAt: at(data, ['usages', 'limit_month_total', 'reset_time']), source: source.name, resolution: 'fractional' });
  }
  if (readings.length === 0) {
    throw new Error('no usage.used, limits[].detail.used|remaining or usages.limit_month_total.used_ratio number in the kimi answer — read the raw body; limit_5h/limit_7d.used_ratio have only ever answered 0');
  }
  return readings;
}

// The Z.AI key is already in the harness: the glm provider's env in orch's
// providers.json. Reading it there keeps one copy instead of two that drift.
export async function glm({ key, request = getJson, details = false } = {}) {
  const file = path.join(stateDirFor(HOME), 'providers.json');
  key ??= process.env.Z_AI_API_KEY || at(readJson(file), ['glm', 'env', 'ANTHROPIC_AUTH_TOKEN']);
  if (!key) throw new Error(`no Z_AI_API_KEY and no glm.env.ANTHROPIC_AUTH_TOKEN in ${file}`);
  const data = await request('https://api.z.ai/api/monitor/usage/quota/limit', { Authorization: `Bearer ${key}` });
  if (data.success === false) throw new Error(String(data.msg ?? 'z.ai refused the key'));
  const limits = at(data, ['data', 'limits']) ?? [];
  if (limits.length === 0) throw new Error('data.limits is empty');
  // Z.AI names a window by unit and number (live 2026-09-23): unit 3 = hours (5h tokens),
  // unit 6 = weeks (the weekly token window), unit 5 = months (TIME_LIMIT: the monthly MCP call quota).
  const label = (entry) => {
    const n = Number(entry.number) || 1;
    const base = entry.unit === 3 ? `${n}h` : entry.unit === 6 ? `${n * 7}d` : entry.unit === 5 ? (n === 1 ? 'month' : `${n}month`) : `unit${entry.unit}`;
    return entry.type === 'TIME_LIMIT' ? `${base}·mcp` : base;
  };
  const readings = limits.map((entry) => ({
    window: label(entry),
    used: entry.percentage,
    resetsAt: entry.nextResetTime ? new Date(entry.nextResetTime).toISOString() : null,
  }));
  return details ? withResets(readings, async () => glmResets(await request(
    'https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL', { Authorization: `Bearer ${key}` },
  ))) : readings;
}

// The OpenCode Go gateway (operator decision 2026-09-19, memory #9840) keeps the
// key under the PROVIDER's name: `opencode-go` is the subscription, `opencode`
// is pay-as-you-go Zen. Reading the wrong entry would report the wrong wallet.
// Its answer is already a percentage per window, so nothing is divided here.
export async function opencode({
  home = HOME,
  pi = piEntry(home, 'opencode-go'),
  auth = readJson(path.join(home, '.local', 'share', 'opencode', 'auth.json')),
  request = getJson,
} = {}) {
  // Pi 1.3.0 opencode-go uses envApiKeyAuth, storing { type: 'api_key', key }.
  // This is the same Go plan key the quota endpoint already accepts as Bearer.
  const stores = [
    { name: 'pi', token: pi?.type === 'api_key' ? pi.key : null },
    { name: 'opencode-cli', token: at(auth, ['opencode-go', 'key']) },
  ].map((store) => ({ ...store, fresh: typeof store.token === 'string' && store.token.trim().length > 0 }));
  const answer = await readFreshStore(() => stores, (store) =>
    request('https://opencode.ai/zen/go/v1/usage', { Authorization: `Bearer ${store.token}` }), Date.now);
  if (!answer) throw new Error('no opencode-go entry in Pi or ~/.local/share/opencode/auth.json — run `node ops/bootstrap/harness-login.mjs opencode`');
  const data = answer.data;
  // `monthly` is a calendar month: the 2026-10-10 reading reset 31 days out (Oct 9 ->
  // Nov 9), which a fixed `30d` length read as elapsed 0 and starved the family (task 2359).
  const windows = [['rolling', '5h'], ['weekly', '7d'], ['monthly', 'month']];
  const readings = [];
  for (const [key_, label] of windows) {
    const entry = at(data, ['usage', key_]);
    const percent = Number(at(entry, ['percent']));
    if (!Number.isFinite(percent)) continue;
    readings.push({ window: label, used: percent, resetsAt: at(entry, ['resetsAt']), source: answer.store.name });
  }
  if (readings.length === 0) throw new Error('no usage.<window>.percent in the opencode answer');
  return readings;
}

// The seat family is what a lead picks, so the row is keyed by family, not by
// the vendor's own product name.
const FAMILIES = [
  { family: 'claude', provider: 'claude', read: claude },
  { family: 'astra', provider: 'codex', read: codex },
  { family: 'grok', provider: 'grok', read: grok },
  { family: 'kimi', provider: 'kimi', read: kimi },
  { family: 'glm', provider: 'zai-coding-plan', read: glm },
  { family: 'opencode', provider: 'opencode-go', read: opencode },
  { family: 'qwen', provider: 'qwen-token-plan-individual', read: qwen },
  { family: 'mimo', provider: 'mimo-token-plan', read: mimo },
];

/**
 * A reading with a number in it. Not Number(...) alone: Number(null) is 0, and a
 * missing reading would pass as an idle 0% (review by an opencode seat, 2026-09-22).
 */
export function isReading(reading) {
  return reading.used !== null && reading.used !== undefined && reading.used !== '' && Number.isFinite(Number(reading.used));
}

/** Stand guard: read only this family's live endpoint; never use a stale parked snapshot or refresh another account. */
export async function readFamilyUsage(family, readers = FAMILIES) {
  const key = family === 'codex' ? 'astra' : family;
  const entry = readers.find((row) => row.family === key);
  if (!entry) throw new Error(`unknown usage family ${family}`);
  const readings = (await entry.read()).filter(isReading);
  if (!readings.length) throw new Error(`${family}: no numeric reading in the live answer`);
  return { family, provider: entry.provider, takenAt: new Date().toISOString(), readings };
}

/** Read every family's load, least loaded first, and park the snapshot for the session-start hook. */
export async function takeSnapshot() {
  const rows = await Promise.all(
    FAMILIES.map(async ({ family, provider, read }) => {
      try {
        const answer = await read({ details: true });
        const readings = (Array.isArray(answer) ? answer : answer.readings).filter(isReading);
        const inventory = Array.isArray(answer) ? { resets: [], resetsError: null }
          : { resets: answer.resets, resetsError: answer.resetsError };
        if (readings.length === 0) return { family, provider, worst: null, readings: [], error: 'no numeric reading in the answer', ...inventory };
        const worst = readings.reduce((left, right) => (Number(right.used) > Number(left.used) ? right : left));
        return { family, provider, worst: Number(worst.used), readings, error: null, ...inventory };
      } catch (error) {
        const program = RESET_PROGRAM_FAMILIES.includes(family);
        return { family, provider, worst: null, readings: [], error: error.message,
          resets: program ? null : [], resetsError: program ? 'reset inventory unavailable: usage read failed' : null };
      }
    }),
  );

  // Least loaded first; a family whose load cannot be read sorts last, because
  // "unknown" is not "free".
  rows.sort((left, right) => {
    if (left.worst === null && right.worst === null) return left.family.localeCompare(right.family);
    if (left.worst === null) return 1;
    if (right.worst === null) return -1;
    return left.worst - right.worst;
  });

  // Park it for the session-start hook: that hook must not make network calls of
  // its own, so what it shows is whatever the last run of this script left behind.
  const snapshot = { takenAt: new Date().toISOString(), rows };
  // A run that could read no family at all (no credentials here, no network) must not replace a good parked snapshot.
  let cacheError;
  if (rows.some((row) => row.worst !== null)) {
    writeCache(snapshot, undefined, (error) => { cacheError = `usage cache unavailable (${error.message})`; });
  }
  // A broken cache/config must not discard live vendor readings. CLI JSON and
  // the daemon retain the cache failure separately from each family's answer.
  return { ...snapshot, ...(cacheError ? { cacheError } : {}) };
}

let isMain = false;
try {
  isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
} catch { /* an unresolvable argv[1] is not this module */ }

if (isMain) {
  const snapshot = await takeSnapshot();
  const rows = snapshot.rows;
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } else {
    if (snapshot.cacheError) process.stdout.write(`${snapshot.cacheError}\n`);
    for (const row of rows) {
      if (row.error) {
        process.stdout.write(`${row.family.padEnd(8)} unknown   ${row.error}\n`);
        continue;
      }
      const detail = row.readings.map((reading) => `${reading.window} ${Math.round(Number(reading.used))}%${reading.source ? ` (${reading.source})` : ''}`).join('  ');
      process.stdout.write(`${row.family.padEnd(8)} ${String(`${Math.round(row.worst)}%`).padEnd(9)} ${detail}\n`);
    }
  }
}
