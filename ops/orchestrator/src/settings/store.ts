import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readHarnessSettings, readInstallSettings } from '../../../../scripts/lib/harness-config.mjs';
import { acquireInstallLock } from '../../../../scripts/lib/install-lock.mjs';
import { publishSettingsFiles, recoverSettingsFiles, type SettingsPublication } from './publish.ts';
import { SettingsError, settingDefinitions, validateDefinition, validateSetting, type SettingDefinition, type SettingValue, type SettingsActor } from './registry.ts';
import { mutationHistory, prepareMutation, publicSettings, type SettingsHistoryEntry, type SettingsMutation } from './changes.ts';
import { registerCategories } from './categories/index.ts';
import { memoryOwnerValue } from './categories/memory.ts';

export interface SettingsLinkAdapter {
  read(): { definitions: SettingDefinition[]; values: Record<string, SettingValue>; source: string | Record<string, string>; fingerprint: string };
  prepare(changes: Record<string, SettingValue>): SettingsPublication[];
}
export type SettingsOptions = { stateDir: string; repoRoot: string; links?: SettingsLinkAdapter };
type Values = Record<string, SettingValue>;
type ScopedValues = Record<SettingDefinition['scope'], Values>;
type Install = { revision: number; values: Values; history: SettingsHistoryEntry[]; linkDefaults: Values; gatesOff: string[] };

function definitionsFor(links: ReturnType<SettingsLinkAdapter['read']> | undefined, defaults: Values): SettingDefinition[] {
  const entries = [...settingDefinitions(), ...(links?.definitions ?? [])].map((entry) =>
    entry.scope === 'link' && Object.hasOwn(defaults, entry.key) ? { ...entry, default: defaults[entry.key] } : entry);
  const keys = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.key)) throw new SettingsError(400, `${entry.key}: duplicate declaration`);
    validateDefinition(entry);
    keys.add(entry.key);
  }
  return entries;
}

function validateValues(values: Record<string, unknown>, scope: SettingDefinition['scope'], definitions: SettingDefinition[], source: string): void {
  for (const [key, value] of Object.entries(values)) {
    const entry = definitions.find((item) => item.key === key && item.scope === scope);
    if (!entry) throw new SettingsError(400, `${source}: unknown ${scope} setting '${key}'`);
    if (entry.readOnly) throw new SettingsError(400, `${source}: ${key} is read-only`);
    try { validateSetting(entry, value); }
    catch (error) { throw new SettingsError(400, `${source}: ${(error as Error).message}`); }
  }
}

function linkedSource(links: ReturnType<SettingsLinkAdapter['read']> | undefined, key: string): string {
  return (typeof links?.source === 'string' ? links.source : links?.source[key]) ?? 'link';
}

function selectValue(schema: SettingDefinition, install: Values, project: { file: string; values: Values }, links: ReturnType<SettingsLinkAdapter['read']> | undefined, file: string) {
  if (schema.scope === 'install') return Object.hasOwn(install, schema.key)
    ? { value: install[schema.key], source: file } : { value: structuredClone(schema.default), source: 'default' };
  const values = schema.scope === 'project' ? project.values : links?.values ?? {};
  const source = schema.scope === 'project' ? project.file : linkedSource(links, schema.key);
  if (!Object.hasOwn(values, schema.key)) throw new SettingsError(400, `${source}: missing setting '${schema.key}'`);
  return { value: values[schema.key], source };
}

/** One instance per daemon runtime, shared by HTTP and MCP. Publication never yields. */
class Store {
  private options: SettingsOptions;
  private file: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(options: SettingsOptions) {
    registerCategories();
    this.options = options;
    this.file = path.join(options.stateDir, 'settings.json');
  }

  private snapshot() {
    const install = readInstallSettings(this.options.stateDir) as { text: string | null; document: Install };
    const project = readHarnessSettings(this.options.repoRoot);
    const links = this.options.links?.read();
    const definitions = definitionsFor(links, install.document.linkDefaults);
    validateValues(install.document.values, 'install', definitions, this.file);
    validateValues(project.values, 'project', definitions, project.file);
    validateValues(links?.values ?? {}, 'link', definitions, 'linked settings');
    const selections = definitions.map((schema) => ({ schema,
      ...memoryOwnerValue(schema.key, this.options.repoRoot) ?? selectValue(schema, install.document.values, project, links, this.file) }));
    const observations = selections.filter((row) => row.schema.readOnly).map((row) => [row.schema.key, row.value, row.source]);
    const hash = createHash('sha256').update(JSON.stringify([install.text, project.text, links?.fingerprint ?? null, observations])).digest('hex');
    const revision = `${install.document.revision}:${hash}`;
    const settings = selections.map((row) => {
      validateSetting(row.schema, row.value);
      return { ...row, revision };
    });
    return { install, project, settings, revision };
  }

  private commit(mutation: SettingsMutation, revision: unknown, who: SettingsActor) {
    const current = this.snapshot();
    const prepared = prepareMutation(mutation, current.settings, who);
    const keys = prepared.changed.map((row) => row.schema.key).join(', ');
    if (typeof revision !== 'string') throw new SettingsError(400, `${keys}: revision must be the token from settings_get`);
    if (revision !== current.revision) throw new SettingsError(409, `${keys}: stale revision`);
    if (!prepared.changed.length) return { settings: publicSettings(current.settings), revision: current.revision };
    const values: ScopedValues = { install: { ...current.install.document.values }, project: { ...current.project.values }, link: {} };
    for (const row of prepared.changed) {
      if (prepared.resetting && row.schema.scope === 'install') delete values.install[row.schema.key];
      else values[row.schema.scope][row.schema.key] = row.next;
    }
    const history = mutationHistory(prepared, who, current.install.document.revision + 1);
    publishSettingsFiles(this.preparePlans(current, values, history), this.options.stateDir);
    const { settings, revision: nextRevision } = this.snapshot();
    return { settings: publicSettings(settings), revision: nextRevision };
  }

  private preparePlans(current: ReturnType<Store['snapshot']>, values: ScopedValues, history: SettingsHistoryEntry[]): SettingsPublication[] {
    const plans = Object.keys(values.link).length ? this.options.links!.prepare(values.link) : [];
    if (JSON.stringify(values.project) !== JSON.stringify(current.project.values)) {
      plans.push({ file: current.project.file, text: `${JSON.stringify({ version: 1, values: values.project }, null, 2)}\n`, before: current.project.text });
    }
    if (current.install.document.revision === Number.MAX_SAFE_INTEGER) throw new SettingsError(400, 'settings revision counter exhausted');
    const linkDefaults = Object.fromEntries(current.settings.filter((row) => row.schema.scope === 'link').map((row) => [row.schema.key, row.schema.default]));
    const gatesOff = current.settings.filter((row) => row.schema.category === 'gates').filter((row) => {
      const next = values[row.schema.scope];
      const fallback = row.schema.scope === 'install' ? row.schema.default : row.value;
      return (Object.hasOwn(next, row.schema.key) ? next[row.schema.key] : fallback) === false;
    }).map((row) => row.schema.key);
    const document: Install = { revision: current.install.document.revision + 1, values: values.install,
      linkDefaults: { ...current.install.document.linkDefaults, ...linkDefaults }, gatesOff, history: [...current.install.document.history, ...history] };
    plans.push({ file: this.file, before: current.install.text, text: `${JSON.stringify(document, null, 2)}\n` });
    return plans;
  }

  private locked<T>(operation: () => T, label: string): T {
    mkdirSync(this.options.stateDir, { recursive: true });
    let release: () => void;
    // Scope the existing pid-owned, generation-safe lock to this install's state.
    try { release = acquireInstallLock({ home: this.options.stateDir }); }
    catch (error) {
      if ((error as Error).message.startsWith('Installer lock held by live pid ')) throw new SettingsError(409, `settings lock busy: ${label}; ${(error as Error).message}`);
      throw error;
    }
    try {
      recoverSettingsFiles(this.options.stateDir);
      return operation();
    } finally { release(); }
  }

  async listSettings() {
    await this.writes;
    return this.locked(() => {
      const { settings, revision } = this.snapshot();
      return { settings: publicSettings(settings), revision };
    }, 'settings read');
  }
  async getSetting(key: string) {
    const current = await this.listSettings();
    const setting = current.settings.find((item) => item.schema.key === key);
    if (!setting) throw new SettingsError(400, `${key}: unknown setting`);
    return setting;
  }
  async listHistory() {
    await this.writes;
    return this.locked(() => {
      const { install, revision } = this.snapshot();
      return { history: install.document.history, revision };
    }, 'settings history');
  }
  private enqueue(mutation: SettingsMutation, revision: unknown, who: SettingsActor) {
    const input = structuredClone(mutation);
    const operation = this.writes.then(() => this.locked(() => this.commit(input, revision, who), 'settings update'));
    this.writes = operation.then(() => undefined, () => undefined);
    return operation;
  }
  putSettings(changes: unknown, revision: unknown, who: SettingsActor = 'operator') { return this.enqueue({ changes }, revision, who); }
  resetSettings(selector: unknown, revision: unknown, who: SettingsActor = 'operator') { return this.enqueue({ reset: selector }, revision, who); }
}

export function createSettingsStore(options: SettingsOptions) { return new Store(options); }
export type SettingsStore = ReturnType<typeof createSettingsStore>;
