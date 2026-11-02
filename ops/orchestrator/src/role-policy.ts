// Shared role authorization data; no daemon or provider dependencies.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TEST_FILE_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  'scripts/test-*.mjs',
  '**/__tests__/**',
  '**/tests/**',
  '**/tests.rs',
  '**/*_tests.rs',
  '**/test-*.mjs',
  '**/test-*.py',
  '**/test_*.py',
] as const;
export const CAPTURE_OUTPUT_GLOBS = ['captures/**'] as const;
export const FIXTURE_GLOBS = ['**/fixtures/**'] as const;
export const TESTER_WRITE_SCOPE = [...TEST_FILE_GLOBS, ...FIXTURE_GLOBS, ...CAPTURE_OUTPUT_GLOBS] as const;
export const DESIGNER_WRITE_SCOPE = ['src/**/*.tsx', 'src/**/*.css', 'web/apps/**'] as const;
export const COPYWRITER_WRITE_SCOPE = ['web/apps/**', 'src/locales/**'] as const;
/** Motion edits the landing page's media and its own drafts (task 3336 S1, decisions 21078/21079). */
export const MOTION_WRITE_SCOPE = ['web/apps/landing/public/media/**', 'web/apps/landing/_drafts/motion/**'] as const;

/** Lifecycle behaviour remains code; adding a role selects one of these existing bases. */
const BASE_ROLE_POLICY = {
  coder: { access: 'full', worktree: 'branch', sealed: false },
  reviewer: { access: 'full', worktree: 'detached', sealed: false, review: true },
  scout: { access: 'read-only', worktree: 'none', sealed: true },
  debater: { access: 'read-only', worktree: 'none', sealed: true, turns: 2 },
  bughunter: { access: 'full', worktree: 'detached', sealed: false },
  tester: { access: 'full', worktree: 'branch', sealed: false },
} as const;
export type RoleBase = keyof typeof BASE_ROLE_POLICY;
export type RoleModel = { model: string; effort: string | null };
export type RoleCatalogueEntry = {
  name: string;
  base: RoleBase;
  description: string;
  models: Record<string, RoleModel>;
  turnLimitMinutes: number;
  writeScope: string[] | null;
  images: boolean;
};
export type RolePolicy = {
  access: 'full' | 'read-only';
  worktree: 'branch' | 'detached' | 'none';
  sealed: boolean;
  turns?: number;
  review?: boolean;
  writeScope?: readonly string[];
};

export const ROLE_CATALOGUE_FILE = fileURLToPath(new URL('../roles.catalogue.json', import.meta.url));
const SKILL_MAP_FILE = fileURLToPath(new URL('../../../.agents/domains/_skill-map.json', import.meta.url));
const MCP_BY_ROLE_FILE = fileURLToPath(new URL('../mcp-by-role.json', import.meta.url));
const NON_SEAT_ROLES = new Set(['lead', 'advisor']);
const ENTRY_KEYS = 'base,description,images,models,name,turnLimitMinutes,writeScope';
const ROLE_NAME = /^[a-z][a-z0-9-]*$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'max']);

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function json(file: string | URL): unknown {
  const text = readFileSync(file, 'utf8');
  try { return JSON.parse(text); }
  catch { throw new Error(`${file}: malformed JSON`); }
}

/** Names in the skill and MCP role maps must be catalogue seats, apart from the two lead-only kinds. */
export function crossCheckRoleCatalogue(entries: readonly RoleCatalogueEntry[], skillMapFile = SKILL_MAP_FILE, mcpByRoleFile = MCP_BY_ROLE_FILE): { unmapped: string[] } {
  const names = new Set(entries.map((entry) => entry.name));
  for (const [file, select] of [
    [skillMapFile, (value: unknown) => plain(value) && plain(value.roleDefaults) ? Object.keys(value.roleDefaults) : null],
    [mcpByRoleFile, (value: unknown) => plain(value) ? Object.keys(value) : null],
  ] as const) {
    const keys = select(json(file));
    if (!keys) throw new Error(`${file}: expected a JSON object of role names`);
    for (const role of keys) {
      if (!NON_SEAT_ROLES.has(role) && !names.has(role)) throw new Error(`${file}: role '${role}' is absent from ${ROLE_CATALOGUE_FILE}`);
    }
  }
  const mapped = new Set([...Object.keys((json(skillMapFile) as Record<string, unknown>).roleDefaults as Record<string, unknown>), ...Object.keys(json(mcpByRoleFile) as Record<string, unknown>)]);
  return { unmapped: entries.map((entry) => entry.name).filter((name) => !mapped.has(name)) };
}

function catalogueFail(file: string | URL, role: string | null, rule: string): never {
  throw new Error(`${file}:${role === null ? '' : ` role '${role}':`} ${rule}`);
}

function catalogueName(item: Record<string, unknown>, names: Set<string>, file: string | URL): string {
  const name = typeof item.name === 'string' ? item.name : null;
  if (name === null || !ROLE_NAME.test(name)) catalogueFail(file, name, 'name must be a lower-case identifier');
  if (names.has(name)) catalogueFail(file, name, 'duplicate role name');
  names.add(name);
  return name;
}

function catalogueBase(value: unknown, name: string, file: string | URL): RoleBase {
  if (typeof value !== 'string' || !Object.hasOwn(BASE_ROLE_POLICY, value)) catalogueFail(file, name, `unknown base; expected one of ${Object.keys(BASE_ROLE_POLICY).join(', ')}`);
  return value as RoleBase;
}

function catalogueDescription(value: unknown, name: string, file: string | URL): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) catalogueFail(file, name, 'description must be 1..2000 characters');
  return (value as string).trim();
}

function catalogueModelCell(cell: unknown, family: string, name: string, file: string | URL): RoleModel {
  if (!plain(cell) || Object.keys(cell).sort().join(',') !== 'effort,model') catalogueFail(file, name, `family '${family}': a cell must be exactly { model, effort }`);
  const profile = cell as Record<string, unknown>;
  const model = profile.model;
  const effort = profile.effort;
  if (typeof model !== 'string' || !MODEL_NAME.test(model)) catalogueFail(file, name, `family '${family}': model must be a plain identifier`);
  if (effort !== null && (typeof effort !== 'string' || !EFFORTS.has(effort))) catalogueFail(file, name, `family '${family}': effort must be low, medium, high, max or null`);
  return { model: model as string, effort: effort as string | null };
}

function catalogueModels(value: unknown, name: string, file: string | URL): Record<string, RoleModel> {
  if (!plain(value) || Object.keys(value).length === 0) catalogueFail(file, name, 'models must be a non-empty family → { model, effort } object');
  const models: Record<string, RoleModel> = {};
  for (const [family, cell] of Object.entries(value)) models[family] = catalogueModelCell(cell, family, name, file);
  return models;
}

function catalogueTurnLimit(value: unknown, name: string, file: string | URL): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 240) catalogueFail(file, name, 'turnLimitMinutes must be an integer from 1 to 240');
  return value as number;
}

function catalogueWriteScope(value: unknown, name: string, file: string | URL): string[] | null {
  if (value !== null && (!Array.isArray(value) || value.some((glob) => typeof glob !== 'string' || !glob.trim()))) catalogueFail(file, name, 'writeScope must be null or an array of non-empty globs');
  return value === null ? null : [...value as string[]];
}

function catalogueImages(value: unknown, name: string, file: string | URL): boolean {
  if (typeof value !== 'boolean') catalogueFail(file, name, 'images must be true or false');
  return value as boolean;
}

function catalogueEntry(raw: unknown, names: Set<string>, file: string | URL): RoleCatalogueEntry {
  if (!plain(raw)) catalogueFail(file, null, 'a role entry must be an object');
  const item = raw as Record<string, unknown>;
  const name = catalogueName(item, names, file);
  if (Object.keys(item).sort().join(',') !== ENTRY_KEYS) catalogueFail(file, name, `expected exactly ${ENTRY_KEYS}`);
  return {
    name,
    base: catalogueBase(item.base, name, file),
    description: catalogueDescription(item.description, name, file),
    models: catalogueModels(item.models, name, file),
    turnLimitMinutes: catalogueTurnLimit(item.turnLimitMinutes, name, file),
    writeScope: catalogueWriteScope(item.writeScope, name, file),
    images: catalogueImages(item.images, name, file),
  };
}

function sameModels(left: Record<string, RoleModel>, right: Record<string, RoleModel>): boolean {
  const families = Object.keys(left);
  if (families.length !== Object.keys(right).length) return false;
  return families.every((family) => right[family]?.model === left[family].model && right[family]?.effort === left[family].effort);
}

/** Validate the complete catalogue before exposing any entry. Every refusal names its role when one exists. */
export function loadRoleCatalogue(file: string | URL = ROLE_CATALOGUE_FILE): RoleCatalogueEntry[] {
  const value = json(file);
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'roles,version' || value.version !== 1 || !Array.isArray(value.roles) || value.roles.length === 0) {
    catalogueFail(file, null, 'expected exactly { version: 1, roles: [non-empty role entries] }');
  }
  const names = new Set<string>();
  const entries = (value as { roles: unknown[] }).roles.map((raw) => catalogueEntry(raw, names, file));
  const critic = entries.find((entry) => entry.name === 'critic');
  const reviewer = entries.find((entry) => entry.name === 'reviewer');
  if (critic && reviewer && !sameModels(critic.models, reviewer.models)) catalogueFail(file, 'critic', 'models must match reviewer (the critic aliases the reviewer matrix)');
  crossCheckRoleCatalogue(entries);
  return entries;
}

/** The process's catalogue: MCP schemas are built from it at startup, so edits take a daemon restart/client reconnect. */
export const ROLE_CATALOGUE: readonly RoleCatalogueEntry[] = loadRoleCatalogue(ROLE_CATALOGUE_FILE);
export const ROLE_POLICY: Record<string, RolePolicy> = Object.fromEntries(ROLE_CATALOGUE.map((entry) => [
  entry.name,
  { ...BASE_ROLE_POLICY[entry.base], ...(entry.writeScope === null ? {} : { writeScope: entry.writeScope }) },
]));
export type SeatRole = string;

export function roleBase(role: string): RoleBase | undefined {
  return ROLE_CATALOGUE.find((entry) => entry.name === role)?.base;
}

export function roleImagesDefault(role: string): boolean {
  return ROLE_CATALOGUE.find((entry) => entry.name === role)?.images ?? false;
}

/** The seat owns a writable branch the lead can land. Unknown roles do not. */
export function landable(role: string): boolean {
  return role in ROLE_POLICY && ROLE_POLICY[role].worktree === 'branch';
}

/** Quote a host-local script path using the managed SSH shell convention. */
export function quoteShellPath(file: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `"${file}"` : `'${file.replaceAll("'", "'\\''")}'`;
}
