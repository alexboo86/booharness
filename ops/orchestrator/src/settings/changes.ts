// Shared authorization, reset selection and audit generation for every settings writer.
import { SettingsError, settingsObject, validateSetting, type SettingDefinition, type SettingValue, type SettingsActor } from './registry.ts';

type Row = { schema: SettingDefinition; value: SettingValue };
export type SettingsHistoryEntry = { key: string; group: string; who: SettingsActor; when: string; old: SettingValue; new: SettingValue; revision: number; operation: 'set' | 'reset' };
export type SettingsMutation = { changes?: unknown; reset?: unknown };

function resetChanges(selector: unknown, rows: Row[]): Record<string, unknown> {
  const input = settingsObject(selector, 'reset');
  const keys = Object.keys(input);
  if (keys.length !== 1 || !['key', 'group'].includes(keys[0])) throw new SettingsError(400, 'reset requires exactly one key or group');
  const selected = rows.filter((row) => row.schema[keys[0] as 'key' | 'group'] === input[keys[0]]);
  if (!selected.length) throw new SettingsError(400, `reset: unknown ${keys[0]} '${String(input[keys[0]])}'`);
  return Object.fromEntries(selected.filter((row) => keys[0] !== 'group' || !row.schema.readOnly)
    .map((row) => [row.schema.key, structuredClone(row.schema.default)]));
}

export function prepareMutation(mutation: SettingsMutation, rows: Row[], who: SettingsActor) {
  if (typeof who !== 'string' || !/^(operator|lead [A-Za-z0-9._-]{1,64})(?![\s\S])/.test(who)) throw new SettingsError(400, 'settings writes require an operator or bound lead identity');
  const resetting = Object.hasOwn(mutation, 'reset');
  const input = resetting ? resetChanges(mutation.reset, rows) : settingsObject(mutation.changes, 'changes');
  requireChanges(input, resetting);
  const changed = Object.entries(input).map(([key, value]) => {
    const row = rows.find((item) => item.schema.key === key);
    if (!row) throw new SettingsError(400, `${key}: unknown setting`);
    if (row.schema.readOnly) throw new SettingsError(400, `${key}: read-only; orch cannot change this setting's consumer`);
    if (row.schema.class === 'operator-only' && who !== 'operator') throw new SettingsError(403, `${key} is operator-only; use the BooHarness operator UI with its write guard`);
    validateSetting(row.schema, value);
    return { ...row, next: structuredClone(value) as SettingValue };
  });
  const effective = Object.fromEntries(rows.map((row) => [row.schema.key, row.value]));
  for (const row of changed) effective[row.schema.key] = row.next;
  validateJevBands(effective);
  return { changed: resetting ? changed.filter((row) => JSON.stringify(row.value) !== JSON.stringify(row.next)) : changed, resetting };
}

function requireChanges(input: Record<string, unknown>, resetting: boolean): void {
  if (!Object.keys(input).length && !resetting) throw new SettingsError(400, 'changes: at least one setting is required');
}

function validateJevBands(values: Record<string, SettingValue>): void {
  for (const [lower, upper] of [['jev.review.skip', 'jev.review.raise'], ['jev.scope.warn', 'jev.scope.refuse']]) {
    if ((values[lower] as number) > (values[upper] as number)) throw new SettingsError(400, `${lower} must be <= ${upper}`);
  }
  if (values['jev.review.skip'] === 1) throw new SettingsError(400, 'jev.review.skip must be < 1 and <= jev.review.raise');
}

export function mutationHistory(prepared: ReturnType<typeof prepareMutation>, who: SettingsActor, revision: number): SettingsHistoryEntry[] {
  const when = new Date().toISOString();
  return prepared.changed.filter((row) => JSON.stringify(row.value) !== JSON.stringify(row.next)).map((row) => ({
    key: row.schema.key, group: row.schema.group, who, when, revision,
    old: row.schema.control === 'secret' ? '[redacted]' : row.value,
    new: row.schema.control === 'secret' ? '[redacted]' : row.next,
    operation: prepared.resetting ? 'reset' : 'set',
  }));
}

export function publicSettings<T extends Row>(rows: T[]): T[] {
  return rows.map((row) => row.schema.control === 'secret'
    ? { ...row, schema: { ...row.schema, default: '[redacted]', options: undefined }, value: '[redacted]' } : row);
}
