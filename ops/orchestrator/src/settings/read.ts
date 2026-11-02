import { readInstallSettings } from '../../../../scripts/lib/harness-settings.mjs';
import { registerCategories } from './categories/index.ts';
import { memoryOwnerValue } from './categories/memory.ts';
import { settingDefinitions, validateSetting, SettingsError, type SettingValue } from './registry.ts';

/**
 * One install-scope value for a synchronous read site, such as family picking. Reads the
 * file on each call, so a change applies with no restart. A corrupt file or a stored value
 * that fails validation throws: the default never hides a broken store.
 */
export function readInstallSetting(stateDir: string, key: string): SettingValue {
  registerCategories();
  const schema = settingDefinitions().find((entry) => entry.key === key);
  if (!schema) throw new SettingsError(400, `${key}: unknown setting`);
  if (schema.scope !== 'install') throw new SettingsError(400, `${key}: scope ${schema.scope} has no synchronous read`);
  const { document } = readInstallSettings(stateDir) as { document: { values: Record<string, unknown> } };
  if (schema.readOnly && Object.hasOwn(document.values, key)) throw new SettingsError(400, `${key}: read-only setting cannot have an install override`);
  const owner = memoryOwnerValue(key);
  if (owner) return owner.value;
  if (!Object.hasOwn(document.values, key)) return schema.default;
  validateSetting(schema, document.values[key]);
  return document.values[key] as SettingValue;
}

/** Delivery-only reads: preserve the advice's defaults and surface one settings error. */
export function readAdvisoryInstallSettings<K extends string>(stateDir: string, defaults: Record<K, SettingValue>, flags: string[]): Record<K, SettingValue> {
  try {
    return Object.fromEntries(Object.keys(defaults).map((key) => [key, readInstallSetting(stateDir, key)])) as Record<K, SettingValue>;
  } catch (error) {
    flags.push(`settings error: ${error instanceof Error ? error.message : String(error)}; using advisory defaults`);
    return defaults;
  }
}
