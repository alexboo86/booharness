// Who may take which seat, on which model and at which effort (operator,
// 2026-09-23, task 1436), and which of those families a seat gets when the lead
// names none. The Paseo profiles were the reference, not the copy:
//  - a scout is a cheap model: opencode, grok, qwen, mimo flash, codex luna or glm flash;
//    a plan critic (role critic, operator #13286) takes the reviewer row instead;
//  - claude worker seats run native Claude Code (decision #11849; Pi's anthropic
//    route bills the Max OAuth as extra usage, memory #11848) and only research and code;
//  - a bughunter thinks at max effort except kimi, which runs high in every role (operator 2026-09-28, decision #12648);
//  - a family at or behind pace (need at least 1) is picked first by need over
//    working seats of the role, need/(1+A), so parallel seats spread over wallets
//    (operator decision 16307, task 2382); need is the max over the wallet's
//    readable windows of one day or more, so a shorter window that expires unspent
//    ranks too, while the longest window's own need stays the floor. Need is unspent
//    over the share of the window still left, floored at 0.5;
//    a family ahead of pace still ranks by headroom in days of that window
//    (decision #11851, #10685); among the wallets at or behind pace the weekly tier
//    file (role-quality.ts tierOf, task 2382 P3b) ranks NORMAL cells before WEAK
//    ones, and a tier has no effect on the ahead-of-pace order;
//    kimi also paces on its month (operator #14189 revises #12717);
//    shorter or equal-length windows throttle and calibrated burn can veto a turn;
//  - unreadable is last, and lead/author families step aside (a lead family does not step aside from a coder pick, decision #11829).
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { FAMILIES, type Family } from './providers/types.ts';
import { FAMILY_EFFORTS, hasAdapter } from './providers/index.ts';
import { formatPause, pauseFor } from './paused-families.ts';
import { SAFE } from './seats-defs.ts';
import type { FamilyLoad, Reading } from './limits.ts';

/** The quality tier of one matrix cell as the pick reads it; `tierOf` of role-quality.ts answers this shape. It is declared here and not imported, so that this module does not depend on the statistics modules. */
export type CellTier = { tier: 'WEAK' | 'NORMAL'; warning: string | null; cell: { rated: number; mean: number | null; failShare: number } | null };

export type Profile = { model: string; effort: string | null };
export type ProfileRole = 'scout' | 'researcher' | 'debater' | 'coder' | 'tester' | 'designer' | 'copywriter' | 'reviewer' | 'critic' | 'legal' | 'bughunter' | 'security';
/** Accounting only: a critic keeps the scout lifecycle, but never shares scout burn or stats. */
export type AccountingRole = ProfileRole;
export function accountingRole<R extends string>(seat: { role: R; data: Record<string, unknown> }): R | 'critic' {
  // Role critic and a legacy flagged scout are one accounting kind; the flag is read
  // only to recognise rows written before the role existed (plan 14746 D6).
  return seat.role === 'critic' || (seat.role === 'scout' && seat.data.critic === true) ? 'critic' : seat.role;
}

/** accountingRole as an SQL expression over a seats row alias. It must decide like accountingRole: a JS
 * function called per row JSON-parsed every walked seat's data, 50-70 ms per doneUsage call (task 2640). */
export const accountingRoleSql = (seat: string): string =>
  `CASE WHEN ${seat}.role = 'critic' OR (${seat}.role = 'scout' AND json_type(${seat}.data, '$.critic') = 'true') THEN 'critic' ELSE ${seat}.role END`;

const SOL = 'gpt-6.1-sol';
// Every reviewer runs at high, never max (operator 2026-09-28, decision #12649).
// glm max found no more reproduced findings per review at similar tokens (task 1718);
// qwen's route clamps both max and high to xhigh.
const REVIEWER_MATRIX: Partial<Record<Family, Profile>> = {
  claude: { model: 'claude-sonnet-5-5', effort: 'high' },
  codex: { model: SOL, effort: 'high' },
  kimi: { model: 'k3.1-pro', effort: 'high' },
  glm: { model: 'glm-5.3', effort: 'high' },
  grok: { model: 'grok-4.7', effort: 'high' },
  qwen: { model: 'qwen3.8-max', effort: 'high' },
  mimo: { model: 'mimo-v2.6-pro', effort: 'high' },
};
export const MATRIX: Record<ProfileRole, Partial<Record<Family, Profile>>> = {
  scout: {
    opencode: { model: 'glm-5.3-flash', effort: null },
    grok: { model: 'grok-4.7', effort: 'low' },
    qwen: { model: 'qwen3.8-flash', effort: 'low' },
    mimo: { model: 'mimo-v2.6-flash', effort: 'low' },
    // ~20x cheaper than Sol on the shared Codex plan quota; glm flash spends 1/3 of glm-5.3 (decision #12038).
    // high, not medium: at medium it returned partial on large reconnaissance (operator #12934).
    codex: { model: 'gpt-6-luna', effort: 'high' },
    // high, not low: the 2026-10-20..27 trial scored 0.649 against 0.558 at low, at twice the tokens per turn
    // (decision #18608, task 2692); glm accepts only low, high and max.
    glm: { model: 'glm-5.3-flash', effort: 'high' },
  },
  researcher: {
    grok: { model: 'grok-4.7', effort: 'medium' },
    codex: { model: SOL, effort: 'medium' },
    claude: { model: 'claude-sonnet-5', effort: 'high' },
    qwen: { model: 'qwen3.8-max', effort: 'medium' },
    mimo: { model: 'mimo-v2.6-pro', effort: 'medium' },
    kimi: { model: 'k3.1-pro', effort: 'high' },
    glm: { model: 'glm-5.3', effort: 'low' },
  },
  debater: {
    codex: { model: SOL, effort: 'medium' },
    grok: { model: 'grok-4.7', effort: 'high' },
    kimi: { model: 'k3.1-pro', effort: 'high' },
    glm: { model: 'glm-5.3', effort: 'high' },
    qwen: { model: 'qwen3.8-max', effort: 'high' },
    mimo: { model: 'mimo-v2.6-pro', effort: 'high' },
  },
  coder: {
    codex: { model: SOL, effort: 'high' },
    claude: { model: 'claude-opus-5-5', effort: 'high' },
    kimi: { model: 'k3.1-pro', effort: 'high' },
    glm: { model: 'glm-5.3', effort: 'high' },
    grok: { model: 'grok-4.7', effort: 'high' },
    // medium, not high: qwen's route clamps high to xhigh, a budget of 262144 reasoning tokens for one response;
    // medium is a budget of 16384 (operator 2026-10-08, decision #15253; reference #15206).
    qwen: { model: 'qwen3.8-max', effort: 'medium' },
    mimo: { model: 'mimo-v2.6-pro', effort: 'high' },
  },
  // A copy of the coder row, not the same object: a later coder edit must not move tester (task 2802).
  tester: {
    codex: { model: SOL, effort: 'high' },
    claude: { model: 'claude-opus-5-5', effort: 'high' },
    kimi: { model: 'k3.1-pro', effort: 'high' },
    glm: { model: 'glm-5.3', effort: 'high' },
    grok: { model: 'grok-4.7', effort: 'high' },
    qwen: { model: 'qwen3.8-max', effort: 'medium' },
    mimo: { model: 'mimo-v2.6-pro', effort: 'high' },
  },
  // Copies of the coder row, not the same object: a later coder edit must not move them (task 2802 S1b).
  designer: {
    codex: { model: SOL, effort: 'high' },
    claude: { model: 'claude-opus-5-5', effort: 'high' },
    kimi: { model: 'k3.1-pro', effort: 'high' },
    glm: { model: 'glm-5.3', effort: 'high' },
    grok: { model: 'grok-4.7', effort: 'high' },
    qwen: { model: 'qwen3.8-max', effort: 'medium' },
    mimo: { model: 'mimo-v2.6-pro', effort: 'high' },
  },
  copywriter: {
    codex: { model: SOL, effort: 'high' },
    claude: { model: 'claude-opus-5-5', effort: 'high' },
    kimi: { model: 'k3.1-pro', effort: 'high' },
    glm: { model: 'glm-5.3', effort: 'high' },
    grok: { model: 'grok-4.7', effort: 'high' },
    qwen: { model: 'qwen3.8-max', effort: 'medium' },
    mimo: { model: 'mimo-v2.6-pro', effort: 'high' },
  },
  reviewer: REVIEWER_MATRIX,
  // The same object as reviewer, not a copy (decision 13286; plan 14746 D2): a plan critic
  // runs the whole reviewer matrix, so one edit moves both.
  critic: REVIEWER_MATRIX,
  // A copy of the reviewer row, not the same object: a later reviewer edit must not move legal (task 2802 S1b).
  legal: {
    claude: { model: 'claude-sonnet-5-5', effort: 'high' },
    codex: { model: SOL, effort: 'high' },
    kimi: { model: 'k3.1-pro', effort: 'high' },
    glm: { model: 'glm-5.3', effort: 'high' },
    grok: { model: 'grok-4.7', effort: 'high' },
    qwen: { model: 'qwen3.8-max', effort: 'high' },
    mimo: { model: 'mimo-v2.6-pro', effort: 'high' },
  },
  bughunter: {
    codex: { model: SOL, effort: 'max' },
    kimi: { model: 'k3.1-pro', effort: 'high' },
    glm: { model: 'glm-5.3', effort: 'max' },
    qwen: { model: 'qwen3.8-max', effort: 'max' },
    // Pi's MiMo catalog has no thinkingLevelMap: getSupportedThinkingLevels tops out at high.
    mimo: { model: 'mimo-v2.6-pro', effort: 'high' },
  },
  // A copy of the bughunter row: max effort where the route supports it (kimi and mimo top out
  // at high); a later bughunter edit must not move security (task 2802 S1b).
  security: {
    codex: { model: SOL, effort: 'max' },
    kimi: { model: 'k3.1-pro', effort: 'high' },
    glm: { model: 'glm-5.3', effort: 'max' },
    qwen: { model: 'qwen3.8-max', effort: 'max' },
    mimo: { model: 'mimo-v2.6-pro', effort: 'high' },
  },
};

/** The role matrix as each production choice reads it (task 2275 slice M1b, plan 16302): `<stateDir>/roles.json` (loadConfig's dir, the daemon's own), read at each choice in the pattern of readPauseRecords, so a file that appears or changes takes effect with no daemon restart. An absent file returns the compiled MATRIX itself, not a copy, so a test's in-place patch of MATRIX stays visible; a role the file does not name keeps its compiled row, and an absent `critic` key means the reviewer row of the result as the SAME object (decision 13286), while a present one is its own row. A malformed file or a failed cell check throws and names the file, the role, the family and the rule; no part of a bad file is used. The parsed table is kept only while the file's mtime and size do not change. Every read goes through here at call time, never captured at module load. */
export function roleMatrix(): Record<ProfileRole, Partial<Record<Family, Profile>>> {
  return readRolesMatrix();
}

/** The parsed roles.json with the stat that produced it; kept only while that stat holds. */
let lastRoles: { file: string; mtimeMs: number; size: number; table: Record<ProfileRole, Partial<Record<Family, Profile>>> } | null = null;

/** The last table that passed the loader's checks in this process; the lenient reader's fallback when the file has gone bad. Cleared when the file is absent. */
let lastGoodRoles: Record<ProfileRole, Partial<Record<Family, Profile>>> | null = null;

/** The strict read both readers share (stat-cached): throws on a file that fails the checks, clears the last good table and returns the compiled MATRIX when the file is absent. */
function readRolesMatrix(): Record<ProfileRole, Partial<Record<Family, Profile>>> {
  const file = path.join(loadConfig().stateDir, 'roles.json');
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { lastRoles = null; lastGoodRoles = null; return MATRIX; }
    throw error;
  }
  if (lastRoles?.file === file && lastRoles.mtimeMs === stat.mtimeMs && lastRoles.size === stat.size) return lastRoles.table;
  const table = parseRoles(readFileSync(file, 'utf8'), file);
  lastRoles = { file, mtimeMs: stat.mtimeMs, size: stat.size, table };
  lastGoodRoles = table;
  return table;
}

/** The matrix for reads about a seat that exists or about accounting (task 2275 M1b correction): the strict read first, so an edit or a deletion of roles.json reaches seatModel, doneUsage and estimate at once, with the same stat cache. Only when that read throws — a malformed or invalid file — it returns the last table that passed the checks in this process, else the compiled MATRIX: a seat's turn must not end on a roles.json broken after the seat was created, while roleMatrix() keeps refusing new choices. */
export function lenientMatrix(): Record<ProfileRole, Partial<Record<Family, Profile>>> {
  try { return readRolesMatrix(); }
  catch { return lastGoodRoles ?? MATRIX; }
}

/** Roles orch no longer has; roles.json may still name them. */
const RETIRED_ROLES: ReadonlySet<string> = new Set(['screenshotter']);

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Parse and check the whole file before any part of it is used: a cell the checks refuse never reaches a pick. The compiled MATRIX supplies every role the file does not name (same row objects, so in-place patches stay visible), and the role names themselves stay the compiled set. */
function parseRoles(text: string, file: string): Record<ProfileRole, Partial<Record<Family, Profile>>> {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${file}: malformed roles JSON; refusing to choose a family`); }
  if (!plain(value)) throw new Error(`${file}: expected a JSON object of role → family → { model, effort? }`);
  const roles = Object.keys(MATRIX) as ProfileRole[];
  for (const key of Object.keys(value)) {
    // A key of a removed role (an older `roles preset` wrote every role) is ignored, not refused (decision #19248).
    if (RETIRED_ROLES.has(key)) continue;
    if (!roles.includes(key as ProfileRole)) throw new Error(`${file}: unknown role '${key}'; expected one of ${roles.join(', ')}`);
  }
  const fail = (role: string, family: string | null, rule: string): never => {
    throw new Error(`${file}: role '${role}'${family === null ? '' : ` family '${family}'`}: ${rule}`);
  };
  // A JSON value can be an object with no usable toString ({"toString": null}); rendering it
  // must not throw, or the refusal itself dies as a bare TypeError instead of naming the rule.
  const show = (value: unknown): string => {
    if (typeof value === 'string') return `'${value}'`;
    if (value !== null && typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
    return String(value);
  };
  const table = {} as Record<ProfileRole, Partial<Record<Family, Profile>>>;
  for (const role of roles) {
    if (!Object.hasOwn(value, role)) { table[role] = MATRIX[role]; continue; }
    const row = value[role];
    if (!plain(row)) fail(role, null, 'the row must be an object of family → { model, effort? }');
    const parsed: Partial<Record<Family, Profile>> = {};
    for (const [name, cell] of Object.entries(row)) {
      if (!(FAMILIES as readonly string[]).includes(name)) fail(role, name, `unknown orch family; expected one of ${FAMILIES.join(', ')}`);
      const family = name as Family;
      if (!hasAdapter(family, 'pi') && !hasAdapter(family, 'native')) fail(role, name, 'no adapter and no Pi route');
      if (!plain(cell)) fail(role, name, 'a cell must be exactly { model, effort? }');
      const keys = Object.keys(cell).sort().join(',');
      if (keys !== 'model' && keys !== 'effort,model') fail(role, name, `a cell must be exactly { model, effort? }, got keys: ${keys}`);
      const { model, effort } = cell;
      if (typeof model !== 'string' || !SAFE.test(model)) fail(role, name, `model ${show(model)} is not a plain identifier`);
      const accepted = FAMILY_EFFORTS[family];
      if (effort !== undefined && effort !== null && (typeof effort !== 'string' || !accepted.includes(effort))) {
        fail(role, name, `effort ${show(effort)} is not accepted by ${family}; accepted: ${accepted.join(', ') || 'none; omit effort'}`);
      }
      parsed[family] = { model, effort: effort === undefined || effort === null ? null : effort as string };
    }
    table[role] = parsed;
  }
  // The critic takes the reviewer row of THIS table as the same object (decision 13286): one
  // edit of roles.json reviewer moves both, exactly as the compiled REVIEWER_MATRIX does.
  if (!Object.hasOwn(value, 'critic')) table.critic = table.reviewer;
  return table;
}

/** One row of `roles show`: `file` when roles.json names the role, otherwise `compiled`. Cells are the effective row (an absent critic key is the reviewer row, so its cells can differ from the compiled critic while the mark stays `compiled`). */
export type DescribedRole = { role: ProfileRole; mark: 'file' | 'compiled'; cells: Partial<Record<Family, Profile>> };

/** The effective matrix with each row marked. A bad file throws the loader's fault; nothing is printed from a partial table. */
export function describeRoles(): DescribedRole[] {
  const file = path.join(loadConfig().stateDir, 'roles.json');
  const table = roleMatrix();
  const named = new Set<string>();
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (plain(value)) for (const key of Object.keys(value)) named.add(key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return (Object.keys(MATRIX) as ProfileRole[]).map((role) => ({
    role,
    mark: named.has(role) ? 'file' : 'compiled',
    cells: table[role],
  }));
}

function readRolesRaw(file: string): Record<string, unknown> {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  parseRoles(text, file);
  return JSON.parse(text) as Record<string, unknown>;
}

function cellForFile(cell: Profile): { model: string; effort?: string } {
  return cell.effort == null ? { model: cell.model } : { model: cell.model, effort: cell.effort };
}

/** Bracket assignment of `__proto__` sets the prototype, so the key never reaches JSON.stringify. An own data property is what the serializer emits; parseRoles remains the only name check. */
function own(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function isWriterTemp(name: string, fileBase: string): boolean {
  const prefix = `${fileBase}.`;
  if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return false;
  return /^\d+\.[0-9a-f]{12}$/.test(name.slice(prefix.length, -'.tmp'.length));
}

/** A temp this writer left when a write was killed. The next successful write removes it; the lock is not removed here. */
function dropWriterTemps(file: string): void {
  const dir = path.dirname(file);
  const base = path.basename(file);
  for (const name of readdirSync(dir)) {
    if (isWriterTemp(name, base)) rmSync(path.join(dir, name), { force: true });
  }
}

/** Stable file order: compiled role order, then family order, cell keys model then effort. Unknown keys stay as own properties, so parseRoles still refuses them. */
function orderRolesFile(raw: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  const roles = Object.keys(MATRIX);
  for (const role of [...roles, ...Object.keys(raw).filter((key) => !roles.includes(key))]) {
    if (!Object.hasOwn(raw, role)) continue;
    const row = raw[role];
    if (!plain(row)) { own(ordered, role, row); continue; }
    const cells: Record<string, unknown> = {};
    const names = [...FAMILIES, ...Object.keys(row).filter((key) => !(FAMILIES as readonly string[]).includes(key))];
    for (const family of names) {
      if (!Object.hasOwn(row, family)) continue;
      const cell = row[family];
      if (!plain(cell)) { own(cells, family, cell); continue; }
      const stored: Record<string, unknown> = {};
      if (Object.hasOwn(cell, 'model')) own(stored, 'model', cell.model);
      if (Object.hasOwn(cell, 'effort')) own(stored, 'effort', cell.effort);
      for (const key of Object.keys(cell)) if (!Object.hasOwn(stored, key)) own(stored, key, cell[key]);
      own(cells, family, stored);
    }
    own(ordered, role, cells);
  }
  return ordered;
}

/**
 * The only writer of roles.json (task 2275 slice M1c). Reads under a lock directory,
 * changes, checks the whole result with parseRoles (no second copy of a rule), then
 * writes a temp file in the same directory, fsyncs and renames. A refusal throws before
 * the rename, so the live file stays whole; a kill between the temp write and the rename
 * leaves the same old file and its temp, which the next successful write removes. The lock
 * stays as addHost has it: a lock of a process that no longer runs is removed by hand.
 * `null` from change removes the file (the last row of a reset).
 */
function changeRoles(change: (raw: Record<string, unknown>, file: string) => Record<string, unknown> | null): Record<string, unknown> {
  const stateDir = loadConfig().stateDir;
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'roles.json');
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  // The lock and rename of addHost (config.ts changeHosts): mkdir is exclusive across
  // processes, and the read MUST be inside the lock or a concurrent edit is lost.
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`${lock}: roles edit lock busy; no changes made (a lock of a process that no longer runs is removed by hand)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const raw = readRolesRaw(file);
    const next = change(raw, file);
    if (next === null) {
      rmSync(file, { force: true });
      dropWriterTemps(file);
      return {};
    }
    const text = `${JSON.stringify(next, null, 2)}\n`;
    parseRoles(text, file);
    const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const fd = openSync(temp, 'wx');
      try {
        writeFileSync(fd, text);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temp, file);
      dropWriterTemps(file);
    } finally { rmSync(temp, { force: true }); }
    return next;
  } finally { rmdirSync(lock); }
}

/** The effective row of a role the file does not name, copied through roleMatrix() at call time. Critic's effective row is the reviewer row. */
function seedRow(role: string): Record<string, unknown> {
  if (!(Object.keys(MATRIX) as string[]).includes(role)) return {};
  const seeded: Record<string, unknown> = {};
  for (const [family, cell] of Object.entries(roleMatrix()[role as ProfileRole])) seeded[family] = cellForFile(cell);
  return seeded;
}

/** Set one cell. A role the file does not name is copied from its effective row first, then the cell changes. Returns the file object as written. */
export function setRole(role: string, family: string, model: string, effort?: string): Record<string, unknown> {
  return changeRoles((raw) => {
    const next: Record<string, unknown> = { ...raw };
    const existing = Object.hasOwn(next, role) ? next[role] : seedRow(role);
    const row: Record<string, unknown> = plain(existing) ? { ...existing } : {};
    const cell: Record<string, unknown> = { model };
    if (effort !== undefined) cell.effort = effort;
    own(row, family, cell);
    own(next, role, row);
    return orderRolesFile(next);
  });
}

/** Remove one family. A role the file does not name is copied first. An empty row is refused and nothing is written. */
export function unsetRole(role: string, family: string): Record<string, unknown> {
  return changeRoles((raw, file) => {
    const next: Record<string, unknown> = { ...raw };
    const existing = Object.hasOwn(next, role) ? next[role] : seedRow(role);
    if (!plain(existing) || !Object.hasOwn(existing, family)) throw new Error(`${file}: role '${role}' has no family '${family}'`);
    if (Object.keys(existing).length === 1) throw new Error(`${file}: role '${role}': refusing to leave an empty row`);
    const row = { ...existing };
    delete row[family];
    own(next, role, row);
    return orderRolesFile(next);
  });
}

/** Remove a role the file names. The last row removes the file. A role the file does not name is refused and nothing is written. */
export function resetRole(role: string): Record<string, unknown> {
  return changeRoles((raw, file) => {
    if (!Object.hasOwn(raw, role)) throw new Error(`${file}: role '${role}' is not in the file`);
    const next = { ...raw };
    delete next[role];
    return Object.keys(next).length === 0 ? null : orderRolesFile(next);
  });
}

/**
 * Write a whole matrix as roles.json (task 2275 slice M2b): the preset verb's write.
 * The whole previous file is replaced — nothing of it is merged — under the same lock,
 * parseRoles check and rename as every other write. Every role of the compiled order is
 * named, so a role the matrix leaves empty (a family set that cannot serve it) gets an
 * EMPTY row and the loader replaces its compiled row instead of keeping it (profiles.ts
 * parseRoles keeps the compiled row for any role the file omits).
 */
export function writeRolesMatrix(matrix: Record<ProfileRole, Partial<Record<Family, Profile>>>): Record<string, unknown> {
  return changeRoles(() => {
    const next: Record<string, unknown> = {};
    for (const role of Object.keys(MATRIX) as ProfileRole[]) {
      const cells: Record<string, unknown> = {};
      for (const [family, cell] of Object.entries(matrix[role] ?? {})) own(cells, family, cellForFile(cell));
      own(next, role, cells);
    }
    return orderRolesFile(next);
  });
}

/** At most this many reviewers per task (the same title in the same repo): a recheck is a turn of one of them; a closed reviewer that never delivered a valid report does not count, so it can be recreated once. */
export const MAX_REVIEWERS = 2;

/** Working coder seats a family may run before an automatic coder pick steps aside; an explicitly named family is never refused by it (operator, task 1501; default 2→3, decision #11828; every family 5, operator decision #14790; codex 10, operator decision #16961; glm 10, operator decision #20271). */
export const CODER_CAP: Partial<Record<Family, number>> = { codex: 10, glm: 10 };
export const DEFAULT_CODER_CAP = 5;
export function coderCap(family: Family): number {
  return CODER_CAP[family] ?? DEFAULT_CODER_CAP;
}

export type Load = Pick<FamilyLoad, 'family' | 'worst'> & Partial<Pick<FamilyLoad, 'readings' | 'readAt' | 'outageError' | 'authError' | 'resets'>> & { estimate?: { window: string; used: number; burn: number; resetsAt: string } | null;
  /** This seat's calibrated burn on each other window, by window label; a window without one is absent, never guessed. */
  estimates?: Record<string, number> };

/** Quota percentage reserved for one turn when this role has no calibrated burn yet; reservations are estimates, not observed usage. */
export const DEFAULT_TURN_BURN: Record<ProfileRole, number> = {
  scout: 0.25, researcher: 0.5, debater: 0.5, coder: 1, tester: 1, designer: 1, copywriter: 1,
  reviewer: 0.5, critic: 0.5, legal: 0.5, bughunter: 1, security: 1,
};
/** `burn` is spent on `pace`, the window of the seat's own pace reading (null when that is unreadable); `burns` holds the calibrated burn on each other window the seat's model spends, absent where none is known. A pick charges `burn` only to `pace` and each `burns` entry only to its own window — never by label equality with the pick's budget (lesson 17774, decision 17805 F1). */
export type Reservation = { family: Family; burn: number; pace?: string | null; burns?: Record<string, number> };
export type EligibleFamily = { family: Family; used: number; elapsed: number | null; burn: number | null };

/** Only recognized snapshot durations can define a budget; unknown labels are not guessed. */
export function windowMs(label: string): number | null {
  const base = label.split('·')[0];
  const match = /^(\d+)(m|h|d|month)$/.exec(base) ?? (base === 'month' ? ['', '1', 'month'] : base === 'week' ? ['', '7', 'd'] : null);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = { m: 60_000, h: 3600_000, d: 24 * 3600_000, month: 30 * 24 * 3600_000 }[match[2] as 'm' | 'h' | 'd' | 'month'];
  const length = count * unit;
  return count > 0 && Number.isSafeInteger(length) ? length : null;
}

/** Calendar months vary from 28 to 31 days. UTC arithmetic keeps a local timezone from moving the reset. */
export function windowLength(reading: Reading): number | null {
  const nominal = windowMs(reading.window);
  const match = /^(\d+)?month(?:·|$)/.exec(reading.window);
  if (!match || !reading.resetsAt) return nominal;
  const end = Date.parse(reading.resetsAt);
  if (!Number.isFinite(end)) return nominal;
  const count = Number(match[1] ?? 1);
  const date = new Date(end);
  const startMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - count, 1));
  const lastDay = new Date(Date.UTC(startMonth.getUTCFullYear(), startMonth.getUTCMonth() + 1, 0)).getUTCDate();
  startMonth.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  startMonth.setUTCHours(date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());
  const length = end - startMonth.getTime();
  return Number.isSafeInteger(length) && length > 0 ? length : nominal;
}

export function budgetReading(readings: readonly Reading[] | null | undefined): Reading | null {
  const valid = (readings ?? []).filter((reading) => windowMs(reading.window) !== null && Number.isFinite(reading.used) && reading.used >= 0);
  // Claude model-scoped weeks can be the only weekly reading, so they outrank
  // a general 5h; equal-length general rows win over a named model's quota.
  // GLM's month·mcp counts MCP calls, not model tokens: never make it the
  // family's budget while a token window exists. Scoped-only remains readable.
  const tokenWindows = valid.filter((reading) => !reading.window.endsWith('·mcp'));
  return (tokenWindows.length ? tokenWindows : valid)
    .sort((a, b) => windowLength(b)! - windowLength(a)!
      || Number(a.window.includes('·')) - Number(b.window.includes('·')) || a.window.localeCompare(b.window))[0] ?? null;
}

// Every family paces on its longest budget window; kimi's month paces and its
// 5h window only throttles (operator #14189 revises #12717; #10685, #11851).
/** Ranking, burn estimates and reservations share the same budget reading. */
export function paceReading(family: Family, readings: readonly Reading[] | null | undefined): Reading | null {
  return budgetReading(readings);
}

export const MIN_LEFT = 5;

/** Percent of every token window (pace and throttling, not ·mcp) kept for non-seat consumers: hermes-agent shares GLM's key (operator #12969). */
export const WINDOW_RESERVE: Partial<Record<Family, number>> = { glm: 5 };

/** A named quota belongs to its model, not every seat in the family. MCP counts are not model scopes. */
export function appliesToModel(reading: Reading, model: string): boolean {
  const scope = reading.window.split('·')[1];
  if (!scope || scope === 'mcp') return true;
  const name = scope.toLowerCase().replaceAll(' ', '-');
  const id = model.toLowerCase();
  return id === name || `-${id}-`.includes(`-${name}-`);
}

/** Each runnable, not-avoided family of a role with its budget pace reading: what pickFamily ranks. */
export function rankFamilies(role: ProfileRole, loads: Load[], avoid: ReadonlySet<Family>, runnable: (family: Family) => boolean, now = Date.now(), model?: string, reservations: readonly Reservation[] = [], workingSeats: ReadonlyMap<Family, number> = new Map(), tiers: ReadonlyMap<Family, CellTier> = new Map()) {
  return (Object.keys(roleMatrix()[role]) as Family[]).filter(runnable).filter((family) => !avoid.has(family)).map((family) => {
    const load = loads.find((row) => row.family === family);
    let weekResets = 0;
    let shortResets = 0;
    for (const reset of load?.resets ?? []) {
      if (!Number.isFinite(reset.available) || reset.available <= 0
        || (reset.expiresAt !== null && !(Date.parse(reset.expiresAt) > now))) continue;
      if (reset.scope === 'week' || reset.scope === 'both') weekResets += reset.available;
      if (reset.scope === '5h' || reset.scope === 'both') shortResets += reset.available;
    }
    const readings = (load?.readings ?? []).filter((reading) => appliesToModel(reading, model ?? roleMatrix()[role][family]!.model));
    const budget = paceReading(family, readings);
    const length = budget ? windowLength(budget) : null;
    const remaining = budget?.resetsAt ? Date.parse(budget.resetsAt) - now : NaN;
    const paced = length !== null && Number.isFinite(remaining);
    const elapsed = paced ? remaining <= 0 ? 0 : Math.max(0, 1 - remaining / length!) * 100 : null;
    const used = budget?.used ?? null;
    const reserve = WINDOW_RESERVE[family] ?? 0;
    const reserveOn = (reading: Reading) => reading.window.endsWith('·mcp') ? 0 : reserve;
    const effectiveUsed = used !== null ? used + reserveOn(budget!) : null;
    const pending = reservations.filter((seat) => seat.family === family);
    // Lesson 17774 (decision 17805 F1): a pending seat's burn is spent on the window it
    // was calibrated on — its own `pace` window — and its per-window `burns` on every
    // other window its model spends. A label equal to this pick's budget never moves a
    // burn: the pre-v2 rule charged every pace burn to the budget label while `burns`
    // omitted the seat's own pace window, so a shared 5h at 95% with a working seat
    // burning it did not throttle, and a seat pacing on a model-scoped window vanished
    // from a pick that budgets a different window it burns. A seat without a readable
    // pace window keeps the old charge: its default burn reserves on the pick's budget
    // window only.
    const burnOn = (seat: Reservation, window: string) => seat.pace != null
      ? (window === seat.pace ? seat.burn : seat.burns?.[window] ?? 0)
      : (window === budget?.window ? seat.burn : seat.burns?.[window] ?? 0);
    // Every window a pick budgets — need, headroom, throttle, veto, overrun, reserveHit,
    // MIN_LEFT, the fallback — carries the working seats' calibrated burn on that window
    // and this seat's own; without calibration a window carries no reservation, only the floor.
    const reservedOn = (window: string) => pending.reduce((sum, seat) => sum + burnOn(seat, window), 0);
    const reserved = budget ? reservedOn(budget.window) : pending.reduce((sum, seat) => sum + seat.burn, 0);
    const headroom = elapsed !== null && effectiveUsed !== null ? elapsed - effectiveUsed - reserved : null;
    const headroomDays = headroom !== null ? headroom / 100 * length! / (24 * 3600_000) : null;
    // Unspent over the share of the window still left. 1 finishes the budget at
    // reset on a linear pace; above 1 the remainder expires unless it is used.
    // The 0.5 floor keeps a window about to reset from dividing by zero.
    let need = elapsed !== null && effectiveUsed !== null ? (100 - effectiveUsed - reserved) / Math.max(0.5, 100 - elapsed) : null;
    // Task 2974: at or behind pace is read on what the wallet has spent, before the open
    // seats' reservations. Early in a window those grow faster than elapsed: on 2026-10-25
    // 11:05Z codex (1% used at 2.9% elapsed) fell to need 0.993 on six seats' 2.55%, so
    // nine copywriters went to qwen alone (operator #16307). The reserved need still ranks
    // the group, and every guard below keeps the reservations.
    const atPace = elapsed !== null && effectiveUsed !== null && (100 - effectiveUsed) / Math.max(0.5, 100 - elapsed) >= 1;
    // Task 2382 P2: a wallet at or behind pace on its longest window also ranks on a
    // readable token window of one day or more that expires unspent (opencode's 7d:
    // 0% used, reset hours away). need(w) uses that window's own reserve and
    // reservation; a `·mcp` window never counts and a shorter window stays a throttle
    // only (decision 14211). The pace window's own need stays the floor, so a budget
    // about to reset is still used first (decision 14790, now one term of the max).
    let needWindow: string | null = budget?.window ?? null;
    if (atPace) {
      const needOn = (reading: Reading): number | null => {
        const wLength = windowLength(reading);
        const end = reading.resetsAt ? Date.parse(reading.resetsAt) : NaN;
        if (wLength === null || !Number.isFinite(end) || !Number.isFinite(reading.used) || reading.used < 0) return null;
        const wRemaining = end - now;
        const wElapsed = wRemaining <= 0 ? 0 : Math.max(0, 1 - wRemaining / wLength) * 100;
        return (100 - reading.used - reserveOn(reading) - reservedOn(reading.window)) / Math.max(0.5, 100 - wElapsed);
      };
      for (const reading of readings) {
        if (reading.window.endsWith('·mcp') || (windowMs(reading.window) ?? 0) < 24 * 3600_000) continue;
        const wNeed = needOn(reading);
        if (wNeed !== null && wNeed > need) { need = wNeed; needWindow = reading.window; }
      }
    }
    const reserveHit = reserve > 0 && readings.some((reading) => !reading.window.endsWith('·mcp') && windowMs(reading.window) !== null && Number.isFinite(reading.used) && reading.used >= 0
      && 100 - reading.used - reservedOn(reading.window) - reserve <= 0);
    let shortFloorLifted = false;
    const throttledBy = readings.filter((reading) => {
      const readingLength = windowLength(reading);
      if (reading === budget || readingLength === null || length === null || readingLength > length || !Number.isFinite(reading.used)) return false;
      const left = 100 - reading.used - reserveOn(reading) - reservedOn(reading.window);
      // Banked short resets lift only the shorter-window floor; redemption is operator-only.
      const floor = shortResets > 0 && readingLength < length ? 0 : MIN_LEFT;
      const turnBurn = load?.estimates?.[reading.window] ?? 0;
      const throttled = left <= 0 || left < Math.max(floor, turnBurn);
      if (floor === 0 && !throttled && left < Math.max(MIN_LEFT, turnBurn)) shortFloorLifted = true;
      return throttled;
    })
      .map((reading) => `${reading.window} ${Math.round(reading.used)}%${reservedOn(reading.window) ? ` + ${reservedOn(reading.window).toFixed(1)}% reserved` : ''}${load?.estimates?.[reading.window] ? ` + ${load.estimates[reading.window].toPrecision(2)}%/turn` : ''}`);
    const throttle = throttledBy.length > 0;
    // Past the 5% floor a window is an emergency choice; a turn that cannot fit what the working seats leave of it is not capacity at all.
    const overrun = readings.some((reading) => reading !== budget && windowLength(reading) !== null && length !== null && windowLength(reading)! <= length && Number.isFinite(reading.used)
      && (100 - reading.used - reserveOn(reading) - reservedOn(reading.window) <= 0 || 100 - reading.used - reserveOn(reading) - reservedOn(reading.window) < (load?.estimates?.[reading.window] ?? 0)));
    const burn = budget && load?.estimate?.window === budget.window && load.estimate.used === used ? load.estimate.burn : null;
    const veto = burn !== null && Number.isFinite(burn) && burn > 0 && effectiveUsed !== null && 100 - effectiveUsed - reserved < burn;
    const blocked = reserveHit || (effectiveUsed !== null && (100 - effectiveUsed - reserved < MIN_LEFT || throttle || veto));
    const scopedSpent = readings.some((reading) => reading.window.includes('·') && !reading.window.endsWith('·mcp') && windowMs(reading.window) !== null && reading.used >= 100);
    return { family, budget, used, effectiveUsed, reserve, reserveHit, elapsed, headroom, headroomDays, need, needWindow, atPace, weekResets, shortResets, throttleLifted: shortFloorLifted && !throttle, resetsUnknown: load?.resets === null, working: workingSeats.get(family) ?? 0, tier: tiers.get(family)?.tier ?? 'NORMAL', tierCell: tiers.get(family)?.cell ?? null, burn, reserved, pending: pending.length, blocked, throttle, throttledBy, overrun, veto, scopedSpent, outage: load?.outageError ?? null, auth: load?.authError ?? null };
  });
}

// Task 2382 P4: the 2026-10-11 18:56Z trial sent three scouts to opencode
// (need 33.0x, A 0/1/2) over glm at 1.2x; cap only the spread, not the raw need.
export const NEED_SPREAD_CAP = 3;

/** Choose a seat by capped needed pace over the role's working seats when a budget is at or behind its reset, otherwise by headroom in days plus one binary seven-day credit for any banked weekly reset, less half a day per working seat of the family in this pick's role; exhausted windows and a turn too expensive step aside. A coder pick also steps aside from a family already running its coder cap of working coders (`coderCap`; `workingCoders`, the reservations' notion of working); when every candidate is capped the cap yields to the best-ranked choice rather than refusing. `workingSeats` is A, the store's count of the wallet's seats in this role (provisioning, working, or a ready seat with no turn younger than 10 min), read in the same synchronous step as the pick; with none and one readable window per family the order is exactly the pre-spread order. `tiers` is the quality tier of the role's matrix cell per family (task 2382 P3b): among the spend-first rows NORMAL ranks before WEAK (plan 16330), a tier never refuses a pick and never touches the ahead-of-pace order; with an empty map every row is NORMAL and the order is exactly the pre-tier order. */
export function pickFamily(role: ProfileRole, loads: Load[], avoid: ReadonlySet<Family>, runnable: (family: Family) => boolean, now = Date.now(), paused: ReadonlySet<Family> = new Set(), model?: string, reservations: readonly Reservation[] = [], workingCoders: ReadonlyMap<Family, number> = new Map(), workingSeats: ReadonlyMap<Family, number> = new Map(), tiers: ReadonlyMap<Family, CellTier> = new Map()): { family: Family; why: string; eligible: EligibleFamily[] } {
  const allowed = (Object.keys(roleMatrix()[role]) as Family[]).filter(runnable);
  const open = allowed.filter((family) => !avoid.has(family) && !paused.has(family));
  if (!open.length) throw new Error(`no family is left for a ${role}: allowed ${allowed.join(', ') || 'none'}, stepping aside ${[...avoid].join(', ') || 'none'}, paused ${[...paused].join(', ') || 'none'}`);
  const ranked = rankFamilies(role, loads, avoid, runnable, now, model, reservations, workingSeats, tiers);
  // A provider that is down or refuses the family's credential serves no seat: ranked last either way.
  const down = (row: typeof ranked[number]) => Number(!!(row.outage || row.auth));
  // At or behind pace on what is spent (atPace, task 2974) first, by capped need over the
  // role's working seats (task 2382: the spread term), so a budget about to reset is used
  // without giving one wallet every parallel seat. Ahead of pace adds one binary seven-day credit
  // for any banked weekly reset and pays half a day per working seat (decision 17805,
  // revising #17669); equal spread scores use raw need, then today's chain.
  const spendFirst = (row: typeof ranked[number]) => row.atPace;
  const spreadScore = (row: typeof ranked[number]) => Math.min(row.need ?? 0, NEED_SPREAD_CAP) / (1 + row.working);
  // Decision 17805 D1/D3: the ahead-of-pace key — headroom days plus one binary seven-day
  // credit for any banked weekly reset (never seven per reset; the count still prints),
  // less half a day per working seat of the family in this pick's role (A), the unspent
  // work a fresh seat holds. Tier stays out of this order (plan 16330, D4).
  const aheadKey = (row: typeof ranked[number]) => row.headroomDays! + 7 * Number(row.weekResets >= 1) - 0.5 * row.working;
  // Task 2382 P3b: within the spend-first rows the NORMAL cells of the tier file
  // rank before the WEAK ones (plan 16330); each half keeps the spread order. A
  // tier never reaches the ahead-of-pace rows, which use reset-adjusted headroom days.
  const tierRank = (row: typeof ranked[number]) => row.tier === 'WEAK' ? 1 : 0;
  const compare = (a: typeof ranked[number], b: typeof ranked[number]) =>
    down(a) - down(b)
    || (a.used === null ? 1 : 0) - (b.used === null ? 1 : 0)
    || (a.headroomDays === null ? 1 : 0) - (b.headroomDays === null ? 1 : 0)
    || Number(spendFirst(b)) - Number(spendFirst(a))
    || (spendFirst(a) && spendFirst(b) ? tierRank(a) - tierRank(b) : 0)
    || (spendFirst(a) && spendFirst(b) ? spreadScore(b) - spreadScore(a) : 0)
    || (spendFirst(a) && spendFirst(b) ? b.need! - a.need! : 0)
    || (!spendFirst(a) && !spendFirst(b) && a.headroomDays !== null && b.headroomDays !== null ? aheadKey(b) - aheadKey(a) : 0)
    || (a.used ?? Infinity) - (b.used ?? Infinity) || a.family.localeCompare(b.family);
  const available = ranked.filter((row) => !paused.has(row.family));
  const eligible = available.filter((row) => !row.outage && !row.auth && !row.reserveHit && !row.blocked && row.used !== null);
  const allAside = !eligible.length;
  // Near-exhausted budgets may be emergency choices, but a spent (>=100%)
  // budget is not capacity, even if every other family stepped aside.
  const fallback = available.filter((row) => !row.reserveHit && !row.scopedSpent && !row.overrun && (row.effectiveUsed === null || row.effectiveUsed + row.reserved < 100));
  if (allAside && !fallback.length) throw new Error(`no family has budget left for a ${role}: ${ranked.map((row) => `${row.family} ${row.used}%${row.reserveHit ? ` (${row.family} reserve ${row.reserve}% kept for hermes-agent)` : ''}`).join(', ')}`);
  const best = allAside ? fallback.sort((a, b) => down(a) - down(b) || (a.effectiveUsed === null ? Infinity : a.effectiveUsed + a.reserved) - (b.effectiveUsed === null ? Infinity : b.effectiveUsed + b.reserved) || a.family.localeCompare(b.family))[0]
    : eligible.sort(compare)[0];
  // The coder cap only moves the choice, never refuses: the next family in the
  // same ranking wins while one is free; a fully capped field keeps the best.
  const working = (family: Family) => workingCoders.get(family) ?? 0;
  let choice = best;
  let capNote: string | null = null;
  if (role === 'coder' && working(best.family) >= coderCap(best.family)) {
    const free = (allAside ? fallback : eligible).find((row) => working(row.family) < coderCap(row.family));
    if (free) {
      capNote = `coder cap ${coderCap(best.family)}: ${best.family} already has ${working(best.family)} working coder seat${working(best.family) === 1 ? '' : 's'}; picking ${free.family} instead`;
      choice = free;
    } else {
      capNote = `coder cap: every eligible family is already at its working coder cap; cap not enforced`;
    }
  }
  const bestWithPauses = ranked.filter((row) => !row.outage && !row.auth && !row.blocked && row.headroomDays !== null).sort(compare)[0];
  const pausedBest = bestWithPauses && paused.has(bestWithPauses.family) && compare(bestWithPauses, choice) < 0
    ? bestWithPauses : null;
  const pauseText = [...paused].map((family) => pauseFor(family)).filter((record) => record !== undefined).map((record) => formatPause(record, now));
  const sorted = available.sort(compare);
  const details = sorted.map((row) => {
    const detail = row.budget
      ? `${row.family} budget ${row.budget.window}: elapsed ${row.elapsed === null ? 'unknown' : row.elapsed.toFixed(1) + '%'}, used ${row.used}%, headroom ${row.headroom === null ? 'unknown' : `${row.headroom.toFixed(1)}% (${row.headroomDays!.toFixed(1)} d)`}${row.need === null ? '' : `, need ${row.need.toFixed(1)}x${row.needWindow && row.needWindow !== row.budget.window ? ` on ${row.needWindow}` : ''}`}${row.pending ? ` (reserved ${row.reserved.toFixed(2)}% for ${row.pending} seat${row.pending === 1 ? '' : 's'})` : ''}${row.burn !== null ? `, burn ${row.burn.toPrecision(2)}%/turn` : ''}${row.blocked ? ` (step aside: ${row.reserveHit ? `${row.family} reserve ${row.reserve}% kept for hermes-agent` : row.throttle ? `window throttle: ${row.throttledBy.join(', ')}` : row.veto ? 'turn exceeds budget' : 'budget below minimum'})` : ''}`
      : `${row.family} usage unreadable (ranked last)`;
    const resets = `${row.resetsUnknown ? ', resets unknown' : ''}${row.weekResets > 0 ? `, week resets ${row.weekResets} (+7 d)` : ''}${row.shortResets > 0 ? `, 5h resets ${row.shortResets}${row.throttleLifted ? ' (throttle lifted)' : ''}` : ''}`;
    return `${detail}${resets}${row.auth ? ` (auth failure since ${row.auth.at}; ranked last for 60 min or until a turn of it completes)` : ''}${row.outage ? ` (provider outage since ${row.outage.at}; ranked last)` : ''}`;
  });
  // Task 2382 P2: the pick's spread inputs, for the winner and the runner-up — need,
  // the window that gave it and A, the wallet's working seats in this role. P3b adds
  // the tier of the cell, and a WEAK cell's numbers (rated, mean, failure share).
  const spreadOf = (row: typeof ranked[number]) => `${row.family} need ${row.need === null ? 'unknown' : `${row.need.toFixed(1)}x${row.needWindow ? ` on ${row.needWindow}` : ''}${row.need > NEED_SPREAD_CAP ? `, capped at ${NEED_SPREAD_CAP.toFixed(1)}x for the spread` : ''}`}, A ${row.working}, tier ${row.tier}${row.tier === 'WEAK' && row.tierCell ? ` (rated ${row.tierCell.rated}, mean ${row.tierCell.mean === null ? 'unknown' : row.tierCell.mean.toFixed(3)}, fail share ${row.tierCell.failShare.toFixed(3)})` : ''}`;
  // Decision 17805: the runner-up is the next row the pick could actually have chosen —
  // the sorted eligible list, or the fallback list when every family stepped aside (both
  // are sorted where `best` was chosen). A family that stepped aside never names itself
  // the runner-up; its cause stays in the ranking details above.
  const runnerUp = (allAside ? fallback : eligible).find((row) => row.family !== choice.family);
  const spreadNote = `; pick spread: ${spreadOf(choice)}${runnerUp ? `; runner-up ${spreadOf(runnerUp)}` : ''}`;
  // One warning for the whole pick (an absent, old or malformed tier file): the reader
  // answers it for every cell, and every cell is then NORMAL (task 2382 P3b).
  const tierWarning = [...tiers.values()].find((answer) => answer.warning)?.warning ?? null;
  // Task 2668: an ahead-of-pace win names the key it won on (aheadKey), so a family
  // with less raw headroom that holds a banked weekly reset reads as ranked, not misordered.
  const aheadWhy = choice.headroomDays === null ? 'highest reset-adjusted pace headroom'
    : `highest reset-adjusted pace headroom ${aheadKey(choice).toFixed(1)} d (headroom ${choice.headroomDays.toFixed(1)} d${choice.weekResets >= 1 ? ' + 7 d week reset' : ''}${choice.working ? ` - 0.5 d x ${choice.working} working` : ''})`;
  return { eligible: eligible.filter((row) => role !== 'coder' || working(row.family) < coderCap(row.family))
    .map(({ family, used, elapsed, burn }) => ({ family, used: used!, elapsed, burn })),
    family: choice.family, why: `${choice.auth ? 'WARNING: auth failure emergency fallback' : choice.outage ? 'WARNING: provider outage emergency fallback' : allAside ? choice.used === null ? 'WARNING: no readable budget; usage unknown' : 'WARNING: all families stepped aside; least-loaded budget fallback' : spendFirst(choice) ? 'most budget to spend before its reset' : aheadWhy}: ${choice.family}; ranking: ${details.join('; ')}${capNote ? `; ${capNote}` : ''}${spreadNote}${tierWarning ? `; ${tierWarning}` : ''}${avoid.size ? `; stepping aside: ${[...avoid].join(', ')}` : ''}${paused.size ? `; paused: ${[...paused].join(', ')}${pauseText.length ? ` (${pauseText.join('; ')})` : ''}` : ''}${pausedBest ? `; WARNING: the first-ranked family is paused: ${pauseFor(pausedBest.family) ? formatPause(pauseFor(pausedBest.family)!, now) : pausedBest.family}` : ''}` };
}
