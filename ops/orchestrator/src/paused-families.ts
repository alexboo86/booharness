// Operator-controlled seat exclusion. Read on every choice, not at daemon startup:
// a CLI pause takes effect for the next seat without restarting orch.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FAMILIES, type Family } from './providers/types.ts';

export type Pause = { family: Family; reason: string; at: string };
export const pausedFile = (stateDir: string): string => path.join(stateDir, 'paused-families.json');

// seats.ts builds a Set(readPaused(...)) and calls pickFamily synchronously, without
// an await. Preserve that interface and the metadata of its latest read for the pick.
let lastRead: readonly Pause[] = [];
export function pauseFor(family: Family): Pause | undefined { return lastRead.find((pause) => pause.family === family); }

export function readPauseRecords(stateDir: string): Pause[] {
  const file = pausedFile(stateDir);
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { lastRead = []; return []; }
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${file}: malformed paused families JSON; refusing to choose a family`); }
  const validFamily = (name: unknown): name is Family => typeof name === 'string' && FAMILIES.includes(name as Family);
  const valid = Array.isArray(value) && value.every((entry) =>
    validFamily(entry) || (entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      && validFamily(entry.family) && typeof entry.reason === 'string' && entry.reason.trim().length > 0 && entry.reason.trim().length <= 200
      && typeof entry.at === 'string' && ((entry.at === '' && entry.reason === 'unknown (legacy)') || !Number.isNaN(Date.parse(entry.at)))));
  if (!Array.isArray(value) || !valid || new Set(value.map((entry: Family | Pause) => typeof entry === 'string' ? entry : entry.family)).size !== value.length) {
    throw new Error(`${file}: expected a JSON array of unique orch family names or pause records; refusing to choose a family`);
  }
  const records: Pause[] = value.map((entry: Family | Pause) => typeof entry === 'string'
    ? { family: entry, reason: 'unknown (legacy)', at: '' } : entry);
  lastRead = records;
  return records;
}

export function readPaused(stateDir: string): Family[] { return readPauseRecords(stateDir).map(({ family }) => family); }

export function formatPause({ family, reason, at }: Pause, now = Date.now()): string {
  const elapsed = at ? Math.max(0, now - Date.parse(at)) : null;
  const age = elapsed === null ? 'unknown age' : elapsed < 60_000 ? `${Math.floor(elapsed / 1000)}s` : elapsed < 3600_000 ? `${Math.floor(elapsed / 60_000)}m` : elapsed < 86400_000 ? `${Math.floor(elapsed / 3600_000)}h` : `${Math.floor(elapsed / 86400_000)}d`;
  return `${family} paused ${age}: ${reason.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()}`;
}

/** Write a complete validated list by rename; a failed write never truncates the live file. */
export function changePaused(stateDir: string, family: Family, pause: boolean, reason?: string): Pause[] {
  if (!FAMILIES.includes(family)) throw new Error(`unknown family '${family}'; expected ${FAMILIES.join(', ')}`);
  if (pause && (!reason || !reason.trim() || reason.trim().length > 200)) throw new Error('pause requires a reason of 1–200 characters after trim');
  mkdirSync(stateDir, { recursive: true });
  const file = pausedFile(stateDir);
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  // mkdir is exclusive across CLI processes. The read MUST be inside the lock:
  // atomic rename alone prevents torn writes but loses concurrent additions.
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`${lock}: pause edit lock busy; no changes made (inspect a stale lock before removing it)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const previous = readPauseRecords(stateDir);
    const next = FAMILIES.flatMap((name) => name === family
      ? pause ? [previous.find((entry) => entry.family === name && entry.reason === reason!.trim()) ?? { family: name, reason: reason!.trim(), at: new Date().toISOString() }] : []
      : previous.filter((entry) => entry.family === name));
    const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(next)}\n`, { encoding: 'utf8', flag: 'wx' });
      renameSync(temp, file);
    } finally { rmSync(temp, { force: true }); }
    lastRead = next;
    return next;
  } finally { rmdirSync(lock); }
}
