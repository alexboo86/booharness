// The weekly quality tier file of the seat pick (plan 16330, "The tier file"). Written by
// `main.ts role-stats --since 7d --write-tiers` and by no other code; read at the pick
// through tierOf. Quality never refuses a pick: without a usable file every cell is NORMAL
// and the reader answers with one warning instead of throwing (unlike paused-families.ts,
// a bad tier file must not stop the choice).
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { known, type RoleStats, type RoleStatsRow } from './role-stats.ts';

export type Tier = 'WEAK' | 'NORMAL';
/** One matrix cell: a role, a wallet (an orch family is one wallet), a model and an effort. */
export type CellRef = { role: string; wallet: string; model: string; effort: string };
export type QualityCell = {
  role: string; wallet: string; model: string; effort: string; tier: Tier;
  rated: number; mean: number | null; failShare: number; p25: number | null; median: number | null;
};
export type RoleQuality = {
  version: number; writtenAt: string; since: string;
  cells: QualityCell[]; manual: Record<string, Tier>;
};

export const ROLE_QUALITY_VERSION = 1;
/** A cell is qualified with this many rated seats in the window; a role is judged with this many qualified cells. */
export const QUALIFIED_MIN_RATED = 20;
export const JUDGED_MIN_CELLS = 5;
/** A qualified cell of a judged role is WEAK at this failure share, or this far below the median while under P25. */
export const WEAK_FAIL_SHARE = 0.15;
export const WEAK_MEAN_MARGIN = 0.05;
/** A file older than this answers NORMAL for every cell. */
export const TIER_FILE_MAX_AGE_MS = 14 * 86_400_000;

export const qualityFile = (stateDir: string): string => path.join(stateDir, 'role-quality.json');
export const cellKey = ({ role, wallet, model, effort }: CellRef): string => `${role}/${wallet}/${model}/${effort}`;

const isTier = (value: unknown): value is Tier => value === 'WEAK' || value === 'NORMAL';
const medianOf = (sorted: number[]): number =>
  sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

/** The tier rule, pure. Rows without a recorded model or effort name no cell of the matrix
 * (the pick always asks for a cell that has both): they are not written and they never count
 * toward the judgement, the P25 or the median. p25 is the nearest-rank value: the qualified
 * means sorted ascending, the value at rank ceil(0.25*n). "Below P25" is strict, and the margin
 * under the median is inclusive. rated seats always carry a finite score, so rated >=
 * QUALIFIED_MIN_RATED implies a mean; the finite check only keeps the percentile total if that
 * ever changes. p25 and median are recorded on every cell of a judged role so the pick can print
 * the tier's numbers; a role that is not judged answers null. */
const named = (row: RoleStatsRow): row is RoleStatsRow & { model: string; effort: string } =>
  typeof row.model === 'string' && typeof row.effort === 'string';
export function tierCells(stats: RoleStats): QualityCell[] {
  const cells: QualityCell[] = [];
  for (const { role, rows } of stats.roles) {
    const qualified = rows.filter((row) => named(row) && row.rated >= QUALIFIED_MIN_RATED && known(row.meanScore));
    const means = qualified.map((row) => row.meanScore as number).sort((a, b) => a - b);
    const judged = qualified.length >= JUDGED_MIN_CELLS;
    const p25 = judged ? means[Math.ceil(0.25 * means.length) - 1] : null;
    const median = judged ? medianOf(means) : null;
    for (const row of rows) {
      if (!named(row)) continue;
      const weak = judged && qualified.includes(row) && (row.failOrNoReport >= WEAK_FAIL_SHARE
        || (row.meanScore !== null && p25 !== null && median !== null
          && row.meanScore < p25 && median - row.meanScore >= WEAK_MEAN_MARGIN));
      cells.push({ role, wallet: row.family, model: row.model, effort: row.effort, tier: weak ? 'WEAK' : 'NORMAL',
        rated: row.rated, mean: row.meanScore, failShare: row.failOrNoReport, p25, median });
    }
  }
  return cells;
}

/** Strict parse of the file this module writes. cells may be absent (an older file): it reads
 * as an empty list. The manual object is kept verbatim (the operator edits it by hand); a value
 * that is not a tier simply never matches a lookup. */
function parseQuality(text: string): RoleQuality | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const file = value as Record<string, unknown>;
  if (file.version !== ROLE_QUALITY_VERSION) return null;
  if (typeof file.writtenAt !== 'string' || Number.isNaN(Date.parse(file.writtenAt))) return null;
  if (typeof file.since !== 'string') return null;
  const cell = (entry: unknown): entry is QualityCell => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const c = entry as Record<string, unknown>;
    return typeof c.role === 'string' && typeof c.wallet === 'string' && typeof c.model === 'string' && typeof c.effort === 'string'
      && isTier(c.tier) && known(c.rated) && c.rated >= 0 && (c.mean === null || known(c.mean))
      && known(c.failShare) && c.failShare >= 0 && (c.p25 === null || known(c.p25)) && (c.median === null || known(c.median));
  };
  const cells = file.cells ?? [];
  if (!Array.isArray(cells) || !cells.every(cell)) return null;
  if (file.manual !== undefined && (typeof file.manual !== 'object' || file.manual === null || Array.isArray(file.manual))) return null;
  return { version: file.version, writtenAt: file.writtenAt, since: file.since,
    cells, manual: { ...(file.manual as Record<string, Tier> | undefined) } };
}

export type QualityAnswer = { tier: Tier; manual: boolean; warning: string | null; cell: QualityCell | null };

/** The tier of one cell. A manual entry wins over cells; an entry that names no known cell is
 * ignored because it is never looked up. An absent file, a file older than 14 days or a file
 * that does not parse answers NORMAL with one warning, so `picked` prints it once. Never throws. */
export function tierOf(stateDir: string, cell: CellRef, now: number | Date = Date.now()): QualityAnswer {
  const file = qualityFile(stateDir);
  const at = now instanceof Date ? now.getTime() : now;
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? `no tier file at ${file}` : `${file} cannot be read`;
    return { tier: 'NORMAL', manual: false, warning: `role-quality: ${reason}; every cell is NORMAL`, cell: null };
  }
  const parsed = parseQuality(text);
  if (parsed === null) return { tier: 'NORMAL', manual: false, warning: `role-quality: ${file} does not parse; every cell is NORMAL`, cell: null };
  if (at - Date.parse(parsed.writtenAt) > TIER_FILE_MAX_AGE_MS) {
    return { tier: 'NORMAL', manual: false, warning: `role-quality: ${file} is older than 14 days; every cell is NORMAL`, cell: null };
  }
  const key = cellKey(cell);
  const found = parsed.cells.find((entry) => cellKey(entry) === key) ?? null;
  const manualTier = parsed.manual[key];
  if (isTier(manualTier)) return { tier: manualTier, manual: true, warning: null, cell: found };
  return { tier: found?.tier ?? 'NORMAL', manual: false, warning: null, cell: found };
}

export type TierWrite = { file: string; cells: QualityCell[]; manual: Record<string, Tier>; entered: QualityCell[]; left: QualityCell[] };

/** Write the tier file for a computed window: a temporary file in the same directory plus a
 * rename, so a pick never reads half a file. The manual key of the existing file is kept as
 * found (a file that does not parse has nothing to keep). entered and left are the cells whose
 * computed tier changed to and from WEAK against the previous file's cells; a cell absent from
 * the previous file counts as entered. A manual entry is not a cell and never enters or leaves. */
export function writeTierFile(stateDir: string, stats: RoleStats, now: number | Date = Date.now()): TierWrite {
  mkdirSync(stateDir, { recursive: true });
  const file = qualityFile(stateDir);
  let previous: RoleQuality | null = null;
  try { previous = parseQuality(readFileSync(file, 'utf8')); } catch { /* absent or unreadable: nothing to keep or compare */ }
  const cells = tierCells(stats);
  const wasWeak = new Map((previous?.cells ?? []).map((cell) => [cellKey(cell), cell.tier === 'WEAK'] as const));
  const isWeak = new Set(cells.filter((cell) => cell.tier === 'WEAK').map(cellKey));
  const next: RoleQuality = {
    version: ROLE_QUALITY_VERSION,
    writtenAt: new Date(now instanceof Date ? now.getTime() : now).toISOString(),
    since: stats.since, cells, manual: previous?.manual ?? {},
  };
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(next)}\n`, { encoding: 'utf8', flag: 'wx' });
    // Windows can throw EPERM here with two writers at one time; accepted: the weekly routine is the only writer and the file stays whole.
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
  return {
    file, cells, manual: next.manual,
    entered: cells.filter((cell) => cell.tier === 'WEAK' && wasWeak.get(cellKey(cell)) !== true),
    left: (previous?.cells ?? []).filter((cell) => cell.tier === 'WEAK' && !isWeak.has(cellKey(cell))),
  };
}
