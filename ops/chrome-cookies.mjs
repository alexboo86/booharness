// Reads one site's cookies from the operator's macOS Google Chrome and returns
// them as a Cookie header (operator decision #12040). Errors are labels only:
// never a cookie value, the Keychain password, or an underlying exception text.
import { execFile } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_CHROME_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const KEYCHAIN_TIMEOUT_MS = 60_000;
// Chrome stores times as microseconds since 1601-01-01 UTC.
const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000n;

let cachedPassword = null;

function keychainPassword() {
  if (cachedPassword) return cachedPassword;
  const read = new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], { timeout: KEYCHAIN_TIMEOUT_MS },
      (error, stdout) => {
        const password = String(stdout ?? '').replace(/\n$/, '');
        if (error || !password) reject(new Error('Chrome Keychain access denied'));
        else resolve(password);
      });
  });
  cachedPassword = read;
  // A denied or timed-out read is not cached, so the next call can ask again.
  read.catch(() => { if (cachedPassword === read) cachedPassword = null; });
  return read;
}

function profileDirs(chromeDir) {
  let entries;
  try { entries = readdirSync(chromeDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
    .map((entry) => path.join(chromeDir, entry.name));
}

function cookiesFile(profile) {
  // Chrome keeps Cookies in the profile root; some versions moved it under Network/.
  return [path.join(profile, 'Network', 'Cookies'), path.join(profile, 'Cookies')].find((file) => existsSync(file)) ?? null;
}

// Chrome holds a lock on the live database, so it is read from a private copy.
// The store runs in WAL mode: a fresh login may exist only in Cookies-wal, so the
// log is copied beside the copy. Cookies-shm is not copied: SQLite rebuilds the
// index from the copied log, while a live -shm may describe frames the copy lacks.
function readRows(file, hosts, nowUs) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chrome-cookies-'));
  try {
    const copy = path.join(dir, 'Cookies');
    let db;
    try {
      copyFileSync(file, copy);
      if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${copy}-wal`);
      db = new DatabaseSync(copy, { readOnly: true });
      const placeholders = hosts.map(() => '?').join(', ');
      const select = db.prepare(`SELECT host_key, name, value, encrypted_value, path, creation_utc, last_access_utc
        FROM cookies WHERE host_key IN (${placeholders}) AND (expires_utc = 0 OR expires_utc > ?)`);
      // Chrome timestamps exceed Number.MAX_SAFE_INTEGER.
      select.setReadBigInts(true);
      return select.all(...hosts, nowUs);
    } catch {
      throw new Error('Chrome Cookies database unreadable');
    } finally {
      db?.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function decrypt(row, key) {
  const encrypted = Buffer.from(row.encrypted_value ?? []);
  if (!encrypted.length) return row.value ?? '';
  if (encrypted.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('Chrome cookie encryption version unsupported');
  let plain;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    throw new Error('Chrome cookie decryption failed');
  }
  // Newer Chrome prepends SHA-256(host_key) to the plaintext.
  const hostHash = createHash('sha256').update(row.host_key).digest();
  if (plain.length >= 32 && plain.subarray(0, 32).equals(hostHash)) plain = plain.subarray(32);
  return plain.toString('utf8');
}

// RFC 6265 §5.1.4 path-match: the cookie path equals the request path, or is a
// prefix of it that ends with '/' or is followed by '/'.
function pathMatches(cookiePath, requestPath) {
  if (cookiePath === requestPath) return true;
  return requestPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/');
}

export async function chromeCookieHeader({ hosts, requestPath, chromeDir = DEFAULT_CHROME_DIR, keychainPassword: password, platform = process.platform, now = Date.now } = {}) {
  if (platform !== 'darwin') throw new Error('macOS Chrome only');
  if (!Array.isArray(hosts) || !hosts.length || !hosts.every((host) => typeof host === 'string' && host)) {
    throw new Error('chromeCookieHeader needs a non-empty hosts list');
  }
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/')) throw new Error('chromeCookieHeader needs a request path');
  const nowUs = BigInt(now()) * 1000n + CHROME_EPOCH_OFFSET_US;
  let best = null;
  for (const profile of profileDirs(chromeDir)) {
    const file = cookiesFile(profile);
    if (!file) continue;
    const rows = readRows(file, hosts, nowUs).filter((row) => pathMatches(row.path ?? '/', requestPath));
    if (!rows.length) continue;
    const newest = rows.reduce((max, row) => (row.last_access_utc > max ? row.last_access_utc : max), 0n);
    if (!best || newest > best.newest) best = { rows, newest };
  }
  if (!best) throw new Error(`not logged in to ${hosts[0]} in Chrome`);
  const key = pbkdf2Sync(password ?? await keychainPassword(), 'saltysalt', 1003, 16, 'sha1');
  // Browser order: longer paths first, then older cookies first.
  const rows = [...best.rows].sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0)
    || (a.creation_utc < b.creation_utc ? -1 : a.creation_utc > b.creation_utc ? 1 : 0));
  return rows.map((row) => `${row.name}=${decrypt(row, key)}`).join('; ');
}
