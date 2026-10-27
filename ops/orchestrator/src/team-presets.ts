// Task 2275 slice M2a (plan 16302): team presets as data, and a pure function that
// builds a role matrix from the families a user has. ops/bootstrap/team-presets.json
// holds, for every orch family and every role it can serve (the measured capability
// of profiles.ts MATRIX), a model and an effort in three tiers. `balanced` is the
// compiled MATRIX cell for cell (pinned by scripts/test-orch-team-presets.mjs, so a
// MATRIX edit without a preset edit fails that test); `economy` and `strong` walk
// each family's model and effort ladder except where a recorded decision fixes an
// axis (reviewer and critic run at high in every tier, operator 2026-09-28 decision
// #12649; scout on codex runs at high at every tier, operator #12934). The file is also the catalogue of known models for
// knownModel's later wizard warning.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FAMILIES, type Family } from './providers/types.ts';
import { FAMILY_EFFORTS, hasAdapter } from './providers/index.ts';
import type { Profile, ProfileRole } from './profiles.ts';
import { SAFE } from './seats-defs.ts';

export type PresetTier = 'economy' | 'balanced' | 'strong';
/** One tier: role → family → cell, with the family set of the compiled matrix (capability is measured, not tiered). */
export type Preset = Record<ProfileRole, Partial<Record<Family, Profile>>>;
export type TeamPresets = Record<PresetTier, Preset>;
export type BuiltMatrix = {
  /** The roles.json object for the chosen families: only those families appear. EVERY role of the matrix is named — a role no chosen family serves gets an empty row, so the roles.json loader replaces the compiled row it would otherwise keep (profiles.ts parseRoles keeps the compiled row for any role the file omits) — and such a role is listed in `missing`. */
  matrix: Record<ProfileRole, Partial<Record<Family, Profile>>>;
  /** The roles the chosen families cannot serve at all; their rows in the matrix are empty. */
  missing: ProfileRole[];
  /** Gaps of the team: a role that must run on the coder's family (decision 16083), or a debater row without two different models (decision 16088). */
  gaps: { role: ProfileRole; reason: string }[];
};

const TIERS: readonly PresetTier[] = ['economy', 'balanced', 'strong'];
/** Every role, in matrix order; the object form makes a role missing from this list a type error. */
const ROLES_ORDER: Record<ProfileRole, true> = {
  scout: true, researcher: true, debater: true, coder: true, tester: true, designer: true, copywriter: true,
  reviewer: true, critic: true, legal: true, bughunter: true, security: true,
};
const ROLES = Object.keys(ROLES_ORDER) as ProfileRole[];

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** A JSON value in an error line; rendering it must never throw ({ "toString": null }). */
function show(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (value !== null && typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
  return String(value);
}

/** Parse and check the whole file before any part of it is used, naming the file, the tier, the role, the family and the rule, in the shape of profiles.ts parseRoles. */
export function loadTeamPresets(text: string, file: string): TeamPresets {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${file}: malformed team presets JSON; refusing to build a role matrix`); }
  if (!plain(value)) throw new Error(`${file}: expected a JSON object of tier → role → family → { model, effort? }`);
  const fail: (tier: string | null, role: string | null, family: string | null, rule: string) => never = (tier, role, family, rule) => {
    const where = [tier === null ? null : `tier '${tier}'`, role === null ? null : `role '${role}'`, family === null ? null : `family '${family}'`]
      .filter((part): part is string => part !== null).join(' ');
    throw new Error(`${file}: ${where === '' ? '' : `${where}: `}${rule}`);
  };
  for (const key of Object.keys(value)) {
    if (!TIERS.includes(key as PresetTier)) fail(null, null, null, `unknown tier '${key}'; expected one of ${TIERS.join(', ')}`);
  }
  for (const tier of TIERS) {
    if (!Object.hasOwn(value, tier)) fail(tier, null, null, `missing tier; expected all of ${TIERS.join(', ')}`);
  }
  const parsed = {} as TeamPresets;
  for (const tier of TIERS) {
    const rawTier = (value as Record<string, unknown>)[tier];
    if (!plain(rawTier)) fail(tier, null, null, 'the tier must be an object of role → family → { model, effort? }');
    for (const key of Object.keys(rawTier)) {
      if (!Object.hasOwn(ROLES_ORDER, key)) fail(tier, null, null, `unknown role '${key}'; expected one of ${ROLES.join(', ')}`);
    }
    const table = {} as Preset;
    for (const role of ROLES) {
      if (!Object.hasOwn(rawTier, role)) fail(tier, role, null, 'the role row is missing; every tier must name every role of the matrix');
      const rawRow = rawTier[role];
      if (!plain(rawRow)) fail(tier, role, null, 'the row must be an object of family → { model, effort? }');
      const row: Partial<Record<Family, Profile>> = {};
      for (const [name, cell] of Object.entries(rawRow)) {
        if (!FAMILIES.includes(name as Family)) fail(tier, role, null, `unknown family '${name}'; expected one of ${FAMILIES.join(', ')}`);
        const family = name as Family;
        if (!hasAdapter(family, 'pi') && !hasAdapter(family, 'native')) fail(tier, role, family, 'no adapter and no Pi route');
        if (!plain(cell)) fail(tier, role, family, 'a cell must be exactly { model, effort? }');
        const keys = Object.keys(cell).sort().join(',');
        if (keys !== 'model' && keys !== 'effort,model') fail(tier, role, family, `a cell must be exactly { model, effort? }, got keys: ${keys}`);
        const { model, effort } = cell;
        if (typeof model !== 'string' || !SAFE.test(model)) fail(tier, role, family, `model ${show(model)} is not a plain identifier`);
        const accepted = FAMILY_EFFORTS[family];
        if (effort !== undefined && effort !== null && (typeof effort !== 'string' || !accepted.includes(effort))) {
          fail(tier, role, family, `effort ${show(effort)} is not accepted by ${family}; accepted: ${accepted.join(', ') || 'none; omit effort'}`);
        }
        row[family] = { model, effort: effort === undefined || effort === null ? null : effort as string };
      }
      table[role] = row;
    }
    parsed[tier] = table;
  }
  // Every tier serves exactly the roles and families of `balanced`: a family's role
  // capability is measured (grok no bughunter, kimi no scout,
  // claude misses three), so a tier may move a cell's model and effort, never its keys.
  const balanced = parsed.balanced;
  const pair = (tier: Preset, role: ProfileRole, family: Family): boolean => Object.hasOwn(tier[role], family);
  for (const tier of TIERS) {
    if (tier === 'balanced') continue;
    for (const role of ROLES) {
      for (const family of FAMILIES) {
        if (pair(parsed[tier], role, family) && !pair(balanced, role, family)) fail(tier, role, family, "present here but absent from tier 'balanced'");
        if (!pair(parsed[tier], role, family) && pair(balanced, role, family)) fail(tier, role, family, "absent here but present in tier 'balanced'");
      }
    }
  }
  return parsed;
}

const PRESETS_URL = new URL('../../bootstrap/team-presets.json', import.meta.url);

/** The shipped team-presets.json, read and checked at call time like every other state read. */
export function teamPresets(): TeamPresets {
  return loadTeamPresets(readFileSync(PRESETS_URL, 'utf8'), fileURLToPath(PRESETS_URL));
}

/**
 * The roles.json object for `families` under one preset, pure: only the given
 * families appear. EVERY role of the matrix is named: a role no chosen family
 * serves gets an empty row, so the roles.json loader replaces the compiled row
 * instead of keeping it (profiles.ts parseRoles keeps the compiled row for any
 * role the file omits) and pickFamily refuses that role rather than reaching
 * outside the chosen families. That role is still listed in `missing`. `gaps`
 * lists where the team cannot review or debate itself: a reviewer or a critic
 * forced onto the coder's family (decision 16083), and a debater row with fewer
 * than two different models, so the two debater seats of one fork could not run
 * different models (decision 16088).
 */
export function buildMatrix(families: readonly Family[], preset: Preset): BuiltMatrix {
  const chosen = [...new Set(families)];
  for (const family of chosen) {
    if (!FAMILIES.includes(family)) throw new Error(`buildMatrix: unknown family ${show(family)}; expected one of ${FAMILIES.join(', ')}`);
  }
  const matrix = {} as BuiltMatrix['matrix'];
  const missing: ProfileRole[] = [];
  for (const role of ROLES) {
    const row: Partial<Record<Family, Profile>> = {};
    for (const family of chosen) {
      const cell = preset[role][family];
      if (cell) row[family] = { model: cell.model, effort: cell.effort };
    }
    if (Object.keys(row).length === 0) missing.push(role);
    matrix[role] = row;
  }
  // The critic runs the reviewer row of THIS result as the same object (decision 13286), exactly as MATRIX does.
  matrix.critic = matrix.reviewer;
  const gaps: BuiltMatrix['gaps'] = [];
  for (const role of ['reviewer', 'critic'] as const) {
    const onRole = Object.keys(matrix[role]) as Family[];
    const coders = Object.keys(matrix.coder) as Family[];
    const canDiffer = onRole.some((reviewer) => coders.some((coder) => coder !== reviewer));
    if (onRole.length > 0 && coders.length > 0 && !canDiffer) {
      gaps.push({ role, reason: `a ${role} must run on ${onRole.join(', ')}, the coder's own family; it cannot be independent of the coder (decision 16083)` });
    }
  }
  // Decision 16088: the two debater seats of one fork must not run the same model.
  const debaterModels = [...new Set(Object.values(matrix.debater).map((cell) => cell.model))];
  if (debaterModels.length < 2) {
    gaps.push({ role: 'debater', reason: `the debater row runs ${debaterModels.join(', ') || 'no model'}; the two debater seats of one fork must not run the same model (decision 16088), so there is no second debater` });
  }
  return { matrix, missing, gaps };
}

/** Whether `model` is one the preset catalogue runs on `family` (any role, any tier); the later wizard warning's question. */
export function knownModel(family: Family, model: string): boolean {
  const presets = teamPresets();
  return TIERS.some((tier) => ROLES.some((role) => presets[tier][role][family]?.model === model));
}
