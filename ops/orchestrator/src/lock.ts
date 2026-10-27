// Single instance. `orch.pid` is the lock: created exclusively BEFORE the store is
// opened, so two overlapping `serve` runs cannot both get past it whatever port
// each asks for. It records {pid, port, born}; port is null until the socket is bound.
//
// A live pid alone does not keep the lock, because after a crash the OS may hand
// that pid to another process and a KeepAlive restart would then refuse forever.
// A live holder is identified by `born`, the OS start time its starter recorded:
// it counts whatever its port or /health says (a probe can stall; a shutting-down
// holder has closed its listener while it still owns the store), while a different
// start time means a reused pid. No `born`, or a start time the OS will not answer
// for, counts as the holder — fail closed — and the refusal names pid and reason.
import { spawnSync } from 'node:child_process';
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { HOST } from './config.ts';

type PidRecord = { pid: number; port: number | null; startedAt: string; born: string | null };

/**
 * The OS start time of a pid: the process's identity across pid reuse, decided by
 * the OS rather than by a port or a health answer. Null when the query fails.
 * TZ=UTC beside LC_ALL=C keeps `ps` bytes zone-free: a record written before
 * the machine's zone changed (travel, daylight saving) must still match.
 */
export function processBorn(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const query = spawnSync('powershell.exe',
        ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc().ToString()`],
        { encoding: 'utf8', timeout: 2000 });
      return query.status === 0 && /^\d+$/.test(query.stdout.trim()) ? query.stdout.trim() : null;
    }
    const query = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    return query.status === 0 && query.stdout.trim() ? query.stdout.trim() : null;
  } catch {
    return null;
  }
}

const STARTING_MS = 30_000;
export const PROBE_TIMEOUT_MS = 2000;

function readRecord(file: string): PidRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Number.isInteger(parsed.pid) && (parsed.port === null || Number.isInteger(parsed.port))
      ? { pid: parsed.pid, port: parsed.port, startedAt: parsed.startedAt, born: typeof parsed.born === 'string' ? parsed.born : null }
      : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockAgeMs(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

/** The live holder of the lock, or null when the file is absent or stale.
 * A live foreign pid is identified by its process start time (`born`), not by
 * its port: health answers nothing while a probe stalls or the holder is
 * shutting down with its listener closed, yet it still owns the store. A
 * mismatching start time is a reused pid and therefore stale; a missing or
 * unverifiable one fails closed onto the holder.
 */
function holderOf(file: string): (PidRecord & { reason: string }) | null {
  const record = readRecord(file);
  if (!record) {
    // A file being written this instant reads as garbage; give a young one the
    // benefit of the doubt, and treat an old unreadable one as stale.
    return lockAgeMs(file) < STARTING_MS ? { pid: -1, port: null, startedAt: '', born: null, reason: 'the lock file is unreadable but young' } : null;
  }
  if (record.pid === process.pid || !alive(record.pid)) return null;
  if (record.born === null) return { ...record, reason: 'identity unverified: the lock record has no process start time' };
  const born = processBorn(record.pid);
  if (born === null) return { ...record, reason: 'identity unverified: the start time query failed' };
  return born === record.born ? { ...record, reason: 'holder process start time matches the record' } : null;
}

/** A refused or unreachable port cannot belong to the recorded daemon. */
export function isUnreachableConnection(error: unknown): boolean {
  const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
  return code === 'ECONNREFUSED' || code === 'EHOSTUNREACH';
}

/** A wait target: a live lock holder is busy if health times out or resets, not absent.
 * An answered health probe with a different pid still identifies a stale lock.
 */
export async function waitingInstance(file: string, probeTimeoutMs = PROBE_TIMEOUT_MS): Promise<PidRecord | null> {
  const record = readRecord(file);
  if (!record) return lockAgeMs(file) < STARTING_MS ? { pid: -1, port: null, startedAt: '', born: null } : null;
  if (record.pid === process.pid || !alive(record.pid)) return null;
  if (record.port === null) return lockAgeMs(file) < STARTING_MS ? record : null;
  try {
    const response = await fetch(`http://${HOST}:${record.port}/health`, { signal: AbortSignal.timeout(probeTimeoutMs) });
    if (!response.ok || (await response.json()).pid !== record.pid) return null;
  } catch (error) {
    // A stalled or reset probe is inconclusive; a refused port is stale.
    if (isUnreachableConnection(error)) return null;
  }
  return record;
}

/** CLI discovery: an unanswered probe is busy, not proof that a live pid is stale.
 * Keep this separate from holderOf: lock takeover has a different contract.
 */
export async function runningInstance(file: string): Promise<(PidRecord & { health: Record<string, unknown> | null }) | null> {
  const record = readRecord(file);
  if (!record || record.pid === process.pid || !alive(record.pid) || record.port === null) return null;
  try {
    const response = await fetch(`http://${HOST}:${record.port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return null;
    const health = await response.json();
    if (health?.pid !== record.pid) return null;
    return { ...record, health };
  } catch (error) {
    if (isUnreachableConnection(error)) return null;
    return { ...record, health: null };
  }
}

function record(port: number | null): string {
  return `${JSON.stringify({ pid: process.pid, port, born: processBorn(process.pid), startedAt: new Date().toISOString() })}\n`;
}

/**
 * Take the lock or return the holder that keeps it. A stale lock is removed and
 * the O_EXCL create retried once; losing that retry to another starter means
 * that starter holds the lock.
 */
export async function acquireLock(file: string): Promise<{ ok: true } | { ok: false; holder: PidRecord & { reason: string } }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Written complete to a private file, then hard-linked into place: link()
    // fails with EEXIST like O_EXCL, and a reader never sees a half-written lock.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, record(null), 'utf8');
    try {
      linkSync(temp, file);
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      rmSync(temp, { force: true });
    }
    const holder = holderOf(file);
    if (holder) return { ok: false, holder };
    rmSync(file, { force: true });
  }
  const fallback = readRecord(file) ?? { pid: -1, port: null, startedAt: '', born: null };
  return { ok: false, holder: { ...fallback, reason: 'another starter holds the lock' } };
}

/** Record the bound port in the lock this process holds. */
export function recordPort(file: string, port: number): void {
  if (readRecord(file)?.pid !== process.pid) throw new Error(`lost the instance lock ${file}`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, record(port), 'utf8');
  renameSync(temp, file);
}

export function releaseLock(file: string): void {
  if (readRecord(file)?.pid === process.pid) rmSync(file, { force: true });
}

/** Release a Windows-terminated daemon's lock only after its recorded process is gone. */
export function releaseStoppedLock(file: string, pid: number, startedAt: string): void {
  const holder = readRecord(file);
  if (!holder || holder.pid !== pid || holder.startedAt !== startedAt) throw new Error(`instance lock changed: ${file}`);
  if (alive(pid)) throw new Error(`orch pid ${pid} is still running`);
  rmSync(file);
}

export function pidRecord(file: string): PidRecord | null {
  return readRecord(file);
}
