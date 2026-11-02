// A durable undo intent precedes every value-file mutation. Its removal commits the batch.
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SettingsError } from './registry.ts';

export type SettingsPublication = { file: string; text: string; before: string | null };
type Staged = SettingsPublication & { temp: string; mode: number };
type Intent = { version: 1; rows: Staged[] };

function current(file: string): string | null {
  try { return readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function journalFile(stateDir: string): string { return path.join(stateDir, 'settings.json.intent'); }
function tempPrefix(stateDir: string, file: string): string {
  const root = path.resolve(stateDir);
  const key = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 16);
  return `.${path.basename(file)}.settings-${key}-`;
}

function syncDirectory(dir: string): void {
  // Windows cannot open directories through Node's fs API. File data is still fsynced;
  // the recovery guarantee is process death, not power-loss durability on Windows.
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function stage(temp: string, text: string, mode: number): void {
  const fd = openSync(temp, 'wx', mode);
  try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function replace(temp: string, file: string): void {
  renameSync(temp, file);
  syncDirectory(path.dirname(file));
}

function prepareRows(plans: SettingsPublication[], stateDir: string): Staged[] {
  const seen = new Set<string>();
  return plans.map((plan) => {
    const file = path.resolve(plan.file);
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key)) throw new SettingsError(400, `${file}: duplicate publication target`);
    seen.add(key);
    if (current(file) !== plan.before) throw new SettingsError(409, `${file}: changed during settings update`);
    const mode = plan.before === null ? 0o600 : statSync(file).mode;
    const temp = path.join(path.dirname(file), `${tempPrefix(stateDir, file)}${randomUUID()}.tmp`);
    return { ...plan, file, temp, mode };
  });
}

function validContents(row: Staged): boolean {
  return typeof row.text === 'string' && (row.before === null || typeof row.before === 'string') && Number.isSafeInteger(row.mode);
}

function validRow(row: Staged, stateDir: string): boolean {
  if (!row || typeof row.file !== 'string' || typeof row.temp !== 'string') return false;
  if (!path.isAbsolute(row.file) || path.dirname(row.file) !== path.dirname(row.temp)) return false;
  const name = path.basename(row.temp);
  if (!name.startsWith(tempPrefix(stateDir, row.file)) || !name.endsWith('.tmp')) return false;
  return validContents(row);
}

function readIntent(stateDir: string): Intent | null {
  const file = journalFile(stateDir);
  const text = current(file);
  if (text === null) return null;
  let intent: Intent;
  try { intent = JSON.parse(text) as Intent; }
  catch { throw new SettingsError(409, `${file}: invalid settings recovery intent; manual recovery required`); }
  if (intent?.version !== 1 || !Array.isArray(intent.rows) || !intent.rows.length || !intent.rows.every((row) => validRow(row, stateDir))) {
    throw new SettingsError(409, `${file}: invalid settings recovery intent; manual recovery required`);
  }
  return intent;
}

function writeIntent(stateDir: string, rows: Staged[]): void {
  const file = journalFile(stateDir);
  const temp = path.join(stateDir, `${tempPrefix(stateDir, file)}${randomUUID()}.tmp`);
  stage(temp, `${JSON.stringify({ version: 1, rows })}\n`, 0o600);
  replace(temp, file);
}

function finish(stateDir: string, rows: Staged[]): void {
  // No unrecorded sibling temps can remain after the commit point.
  for (const row of rows) rmSync(row.temp, { force: true });
  rmSync(journalFile(stateDir));
  syncDirectory(stateDir);
}

function sweepIntentTemps(stateDir: string): void {
  // Only this store's intent staging files can exist without a published intent.
  const prefix = tempPrefix(stateDir, journalFile(stateDir));
  for (const name of readdirSync(stateDir)) {
    if (name.startsWith(prefix) && name.endsWith('.tmp')) rmSync(path.join(stateDir, name), { force: true });
  }
}

function undo(row: Staged): void {
  const text = current(row.file);
  if (text === row.before) return;
  // Do not overwrite an unrelated external edit, even during recovery. Fail closed.
  if (text !== row.text) throw new SettingsError(409, `${row.file}: changed outside interrupted settings update; manual recovery required`);
  rmSync(row.temp, { force: true });
  if (row.before === null) {
    rmSync(row.file);
    syncDirectory(path.dirname(row.file));
  } else {
    stage(row.temp, row.before, row.mode);
    replace(row.temp, row.file);
  }
}

/** Internal: caller holds the state-directory lock; run before EVERY read or write. */
export function recoverSettingsFiles(stateDir: string): void {
  const intent = readIntent(stateDir);
  if (intent) {
    // Repeated interruption is safe: each restored target already equals before.
    for (const row of [...intent.rows].reverse()) undo(row);
    finish(stateDir, intent.rows);
  }
  sweepIntentTemps(stateDir);
}

/** Caller holds the state-directory lock and has recovered any prior intent. */
export function publishSettingsFiles(plans: SettingsPublication[], stateDir: string): void {
  if (!plans.length) return;
  const rows = prepareRows(plans, stateDir);
  try {
    writeIntent(stateDir, rows);
    // Intent is durable before creating any sibling temps, so recovery knows them all.
    for (const row of rows) stage(row.temp, row.text, row.mode);
    for (const row of rows) {
      if (current(row.file) !== row.before) throw new SettingsError(409, `${row.file}: changed during settings update`);
      replace(row.temp, row.file);
    }
    finish(stateDir, rows);
  } catch (error) {
    try { recoverSettingsFiles(stateDir); }
    catch (recovery) { throw new AggregateError([error, recovery], `settings rollback incomplete; recovery intent retained at ${journalFile(stateDir)}`, { cause: error }); }
    throw error;
  }
}
