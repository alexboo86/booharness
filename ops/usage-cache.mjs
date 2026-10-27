// Where the usage snapshot is parked between runs, and the one line a lead
// reads at session start.
//
// The snapshot itself is five to six HTTP calls against five vendors; a hook
// that made them would put a network round trip in front of every session, and
// a vendor having a bad minute would delay the start of work. So the snapshot
// is written by `ops/usage-snapshot.mjs` whenever it runs, and the hook only
// READS the file and says how old it is. Age is part of the line on purpose: a
// number with no age is indistinguishable from a number that is a day stale.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessPaths, readHarnessConfig } from '../scripts/lib/harness-config.mjs';

const REPO = fileURLToPath(new URL('../', import.meta.url));

/** The state file, under the same root the memory client's pointer uses. */
export function cacheFile(home = homedir()) {
  const { stateDir } = harnessPaths({ home, prefix: readHarnessConfig({ repoRoot: REPO }).names.prefix });
  return path.join(stateDir, 'usage-snapshot.json');
}

/** Best effort: a snapshot that cannot be parked is still a snapshot printed. */
export function writeCache(payload, home = homedir(), onUnavailable = (_error) => {}) {
  try {
    const file = cacheFile(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8');
    return file;
  } catch (error) {
    onUnavailable(error);
    return null;
  }
}

/** Hooks omit the callback and stay silent; daemon callers retain the reason. */
export function readCache(home = homedir(), onUnavailable = (_error) => {}) {
  let file;
  try {
    file = cacheFile(home);
  } catch (error) {
    onUnavailable(error);
    return null;
  }
  // A snapshot that does not exist yet or does not parse is "no reading yet", as before the prefix.
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.rows) ? parsed : null;
  } catch {
    return null;
  }
}

function ageLabel(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * One line, least-loaded family first, or null when there is nothing to say.
 * A family whose reading failed is printed as `?` rather than dropped: "we
 * could not read grok" is a fact a lead acts on, and a silent absence is not.
 */
export function formatLine(snapshot, now = Date.now()) {
  if (!snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length === 0) return null;
  const takenAt = Date.parse(snapshot.takenAt ?? '');
  const minutes = Number.isFinite(takenAt) ? Math.max(0, Math.round((now - takenAt) / 60_000)) : null;
  // `typeof`, not `Number(...)`: Number(null) is 0, and a family whose reading
  // failed would be printed as an idle 0% — the most expensive possible lie for
  // a lead choosing where to put work.
  const cells = snapshot.rows.map((row) =>
    typeof row.worst === 'number' && Number.isFinite(row.worst)
      ? `${row.family} ${Math.round(row.worst)}%`
      : `${row.family} ?`,
  );
  const age = minutes === null ? 'age unknown' : `age ${ageLabel(minutes)}`;
  return `- seat load (${age}): ${cells.join(' · ')}`;
}

/** Older than this and the line is worth refreshing before the next session. */
export const STALE_MINUTES = 30;

export function isStale(snapshot, now = Date.now()) {
  const takenAt = Date.parse(snapshot?.takenAt ?? '');
  if (!Number.isFinite(takenAt)) return true;
  return now - takenAt > STALE_MINUTES * 60_000;
}
