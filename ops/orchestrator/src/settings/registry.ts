// Setting declarations and validation; category modules register explicitly, never on import.
export type SettingValue = boolean | number | string | string[] | { name: string; command: string }[] | Record<string, number> | null;
export const SETTING_GROUPS = ['seats', 'models', 'tools', 'automation', 'safety', 'privacy'] as const;
export type SettingGroup = typeof SETTING_GROUPS[number];
export type SettingsActor = 'operator' | `lead ${string}`;
export type SettingDefinition = {
  label: string;
  group: SettingGroup;
  tier: 'basic' | 'advanced';
  control: 'switch' | 'number' | 'text' | 'secret' | 'select' | 'slider' | 'list' | 'matrix';
  class: 'user' | 'operator-only';
  key: string;
  category: string;
  scope: 'install' | 'project' | 'link';
  type: 'bool' | 'int' | 'number' | 'enum' | 'list' | 'command-list' | 'percent-map' | 'auto-or-int' | 'choice-auto-or-int' | 'string';
  default: SettingValue;
  bounds?: { min?: number; max?: number };
  options?: string[];
  /** Shape rule for list items (task 3459 C6), as regex source: every item must match. A string,
   *  so the public schema keeps it after JSON and clients can read the rule. */
  itemPattern?: string;
  /** Regex source (unicode) a string value must match; registration refuses one that does not compile. */
  pattern?: string;
  nullable?: boolean;
  /** Externally owned observations cannot be set or reset through settings. */
  readOnly?: true;
  apply: 'live' | 'restart' | 'next-seat';
  help: string;
  reads: string;
};

export class SettingsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const definitions = new Map<string, SettingDefinition>();

export function defineSetting(entry: SettingDefinition): void {
  if (definitions.has(entry.key)) throw new SettingsError(400, `duplicate setting '${entry.key}'`);
  validateDefinition(entry);
  definitions.set(entry.key, structuredClone(entry));
}

function requiredText(value: unknown, key: string, field: string): void {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new SettingsError(400, `${key}: ${field} must be nonempty, one-line text`);
}

function validateReadOnly(entry: SettingDefinition): void {
  if (entry.readOnly !== undefined && entry.readOnly !== true) throw new SettingsError(400, `${entry.key}: readOnly must be true or omitted`);
  if (entry.readOnly && entry.control === 'secret') throw new SettingsError(400, `${entry.key}: secret controls cannot be read-only`);
}

/** A string setting's optional pattern must belong to a string and compile (unicode). */
function compilePattern(entry: SettingDefinition): void {
  if (entry.pattern === undefined) return;
  if (entry.type !== 'string') throw new SettingsError(400, `${entry.key}: pattern is a string-type field`);
  try {
    new RegExp(entry.pattern, 'u');
  } catch {
    throw new SettingsError(400, `${entry.key}: pattern does not compile`);
  }
}

export function validateDefinition(entry: SettingDefinition): void {
  if (!/^[A-Za-z][\w-]*(\.[\w-]+)+$/.test(entry.key)) throw new SettingsError(400, `invalid setting key '${entry.key}'`);
  for (const field of ['label', 'help', 'category', 'reads'] as const) requiredText(entry[field], entry.key, field);
  const choices = { group: SETTING_GROUPS, tier: ['basic', 'advanced'],
    control: ['switch', 'number', 'text', 'secret', 'select', 'slider', 'list', 'matrix'],
    class: ['user', 'operator-only'], apply: ['live', 'restart', 'next-seat'],
    scope: ['install', 'project', 'link'], type: Object.keys(validators) };
  for (const [field, allowed] of Object.entries(choices)) {
    if (!(allowed as readonly unknown[]).includes(entry[field as keyof SettingDefinition])) throw new SettingsError(400, `${entry.key}: invalid ${field}`);
  }
  if ((entry.control === 'secret' || entry.category === 'gates') && entry.class !== 'operator-only') throw new SettingsError(400, `${entry.key}: secrets and gate switches must be operator-only`);
  validateReadOnly(entry);
  compilePattern(entry);
  validateSetting(entry, entry.default);
}

export function settingDefinitions(): SettingDefinition[] {
  return structuredClone([...definitions.values()]);
}

function integer(entry: SettingDefinition, value: unknown): boolean {
  if (!Number.isSafeInteger(value)) return false;
  const n = value as number;
  return n >= (entry.bounds?.min ?? Number.MIN_SAFE_INTEGER) && n <= (entry.bounds?.max ?? Number.MAX_SAFE_INTEGER);
}

function list(entry: SettingDefinition, value: unknown): boolean {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return false;
  if (new Set(value).size !== value.length) return false;
  // For a list, bounds are item counts (task 3459 C6): min refuses the empty list.
  if (value.length < (entry.bounds?.min ?? 0) || value.length > (entry.bounds?.max ?? Number.MAX_SAFE_INTEGER)) return false;
  return value.every((item) => listItemOk(entry, item));
}

/** One list item against the declaration's own rules: an optional shape pattern, then options. */
function listItemOk(entry: SettingDefinition, item: string): boolean {
  if (entry.itemPattern && !new RegExp(entry.itemPattern).test(item)) return false;
  return !entry.options || entry.options.includes(item);
}

function percentMap(entry: SettingDefinition, value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entry.options && entries.some(([key]) => !entry.options!.includes(key))) return false;
  const values = entries.map(([, n]) => n);
  return validPercentValues(values) && Math.abs(values.reduce((sum, n) => sum + n, 0) - 100) < 1e-9;
}

function validPercentValues(values: unknown[]): boolean {
  return values.length > 0 && values.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100);
}

function commandEntry(value: unknown): value is { name: string; command: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).sort().join(',') !== 'command,name') return false;
  return [entry.name, entry.command].every((part) =>
    typeof part === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(part) && part.length <= 128);
}

function commandList(_entry: SettingDefinition, value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 64) return false;
  const entries = Array.from(value);
  if (!entries.every(commandEntry)) return false;
  const names = entries.map((entry) => entry.name.toLowerCase());
  const commands = entries.map((entry) => entry.command.toLowerCase());
  return new Set(names).size === names.length && new Set(commands).size === commands.length;
}

const validators: Record<SettingDefinition['type'], (entry: SettingDefinition, value: unknown) => boolean> = {
  bool: (_entry, value) => typeof value === 'boolean',
  string: (entry, value) => typeof value === 'string'
    && (entry.pattern === undefined || new RegExp(entry.pattern, 'u').test(value)),
  int: integer,
  number: (entry, value) => typeof value === 'number' && Number.isFinite(value) && value >= (entry.bounds?.min ?? -Infinity) && value <= (entry.bounds?.max ?? Infinity),
  enum: (entry, value) => typeof value === 'string' && !!entry.options?.includes(value),
  list,
  'command-list': commandList,
  'percent-map': percentMap,
  'auto-or-int': (entry, value) => value === 'auto' || integer(entry, value),
  'choice-auto-or-int': (entry, value) => value === 'auto' || integer(entry, value),
};

export function validateSetting(entry: SettingDefinition, value: unknown): void {
  if (value === null && entry.nullable) return;
  if (!validators[entry.type](entry, value)) throw new SettingsError(400, entry.control === 'secret' ? `${entry.key}: invalid secret value` : `${entry.key}: expected ${entry.type}${entry.bounds ? ` ${entry.type === 'list' ? 'with an item count within' : 'within'} ${JSON.stringify(entry.bounds)}` : ''}${entry.itemPattern ? ` matching /${entry.itemPattern}/` : ''}${entry.pattern ? ` matching /${entry.pattern}/u` : ''}${entry.options ? ` from ${entry.options.join(', ')}` : ''}`);
}

export function settingsObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SettingsError(400, `${label}: expected an object`);
  return value as Record<string, unknown>;
}
