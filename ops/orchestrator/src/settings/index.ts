// Pure settings facade. The daemon explicitly initializes its process-local service.
export { defineSetting, SettingsError } from './registry.ts';
export type { SettingDefinition, SettingValue, SettingGroup, SettingsActor } from './registry.ts';
export type { SettingsHistoryEntry } from './changes.ts';
export { createSettingsStore } from './store.ts';
export type { SettingsStore, SettingsOptions, SettingsLinkAdapter } from './store.ts';
export { publishSettingsFiles } from './publish.ts';
export type { SettingsPublication } from './publish.ts';
export { readInstallSetting, readAdvisoryInstallSettings } from './read.ts';
export { BRIEF_WORDS, WIDE_BRIEF_P, WARN_BRIEF_P, SKIP_LOGIC_RISK, RAISE_LOGIC_RISK, REPORT_WARN_WORDS, FINISHED_P, SUPPORTED_P, SAME_DEFECT_P } from './jev-defaults.ts';
export { composeSettingsLinks } from './links.ts';
export { createRatchetSettingsAdapter } from './ratchet.ts';
import { createSettingsStore, type SettingsOptions, type SettingsStore } from './store.ts';

let active: SettingsStore | undefined;
export function initializeSettings(options: SettingsOptions): SettingsStore {
  active = createSettingsStore(options);
  return active;
}
function store(): SettingsStore {
  if (!active) throw new Error('settings service is not initialized');
  return active;
}
export function getSetting(key: string) { return store().getSetting(key); }
export function listSettings() { return store().listSettings(); }
export function putSettings(changes: unknown, revision: unknown) { return store().putSettings(changes, revision); }
export function resetSettings(selector: unknown, revision: unknown) { return store().resetSettings(selector, revision); }
export function listSettingHistory() { return store().listHistory(); }
