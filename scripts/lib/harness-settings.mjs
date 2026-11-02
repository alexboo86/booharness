// Plain-JS project settings reader, also usable by bootstrap without importing orch.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function historyIdentity(entry) {
  return ['key', 'group', 'who', 'when'].every((field) => typeof entry[field] === 'string')
    && /^(operator|lead [A-Za-z0-9._-]{1,64})(?![\s\S])/.test(entry.who) && Number.isFinite(Date.parse(entry.when));
}

function validHistory(entry) {
  return object(entry) && historyIdentity(entry) && Number.isSafeInteger(entry.revision) && entry.revision > 0
    && ['set', 'reset'].includes(entry.operation) && Object.hasOwn(entry, 'old') && Object.hasOwn(entry, 'new');
}

function validateInstallExtras(history, linkDefaults, gatesOff) {
  if (!Array.isArray(history) || !history.every(validHistory)) throw new Error('invalid settings history');
  if (!object(linkDefaults)) throw new Error('invalid link defaults');
  if (!Array.isArray(gatesOff) || !gatesOff.every((key) => typeof key === 'string' && /^[A-Za-z][\w-]*(\.[\w-]+)+$/.test(key))) throw new Error('invalid gates-off summary');
}

function installDocument(value) {
  if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !object(value.values)) throw new Error('expected revision counter and values');
  if (Object.keys(value).some((key) => !['revision', 'values', 'history', 'linkDefaults', 'gatesOff'].includes(key))) throw new Error('unknown install settings field');
  const history = Object.hasOwn(value, 'history') ? value.history : [];
  const linkDefaults = Object.hasOwn(value, 'linkDefaults') ? value.linkDefaults : {};
  const gatesOff = Object.hasOwn(value, 'gatesOff') ? value.gatesOff : [];
  validateInstallExtras(history, linkDefaults, gatesOff);
  return { ...value, history, linkDefaults, gatesOff };
}

export function readInstallSettings(stateDir) {
  const file = path.join(stateDir, 'settings.json');
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { file, text: null, document: installDocument({ revision: 0, values: {} }) };
    throw new Error(`${file}: ${error.message}`, { cause: error });
  }
  try { return { file, text, document: installDocument(JSON.parse(text)) }; }
  catch (error) { throw new Error(`${file}: ${error.message}`, { cause: error }); }
}

export function settingsAuditLine(stateDir = process.env.ORCH_STATE_DIR || path.join(homedir(), '.local/state/orch')) {
  const { document } = readInstallSettings(stateDir);
  const last = document.history.at(-1);
  return `Gates off: ${document.gatesOff.join(', ') || 'none'}; last settings change: ${last ? JSON.stringify(last) : 'none'}\n`;
}

export function readHarnessSettings(repoRoot) {
  const file = path.join(repoRoot, '.agents/harness-settings.json');
  try {
    const text = readFileSync(file, 'utf8');
    const document = JSON.parse(text);
    if (!document || typeof document !== 'object' || Array.isArray(document)
      || document.version !== 1 || Object.keys(document).some((key) => !['version', 'values'].includes(key))
      || !document.values || typeof document.values !== 'object' || Array.isArray(document.values)) {
      throw new Error('expected {version: 1, values: object}');
    }
    return { file, text, values: document.values };
  } catch (error) {
    throw new Error(`${file}: ${error.message}`, { cause: error });
  }
}

/** Required project boolean, without a compiled fallback or orch imports. */
export function readHarnessBoolean(repoRoot, key) {
  const { file, values } = readHarnessSettings(repoRoot);
  if (typeof values[key] !== 'boolean') throw new Error(`${file}: expected boolean setting '${key}'`);
  return values[key];
}

// Jev score thresholds (task 3459 C4b). Hooks and checks are plain Node and cannot import
// the orchestrator registry, so the shipped default percents live here in ONE place; the
// declarations in ops/orchestrator/src/settings/categories/jev-scripts.ts import this map
// for their `default` field instead of copying the literals. A percent is a share of 1.0:
// 60 is today's 0.6, 50 today's 0.5.
export const JEV_THRESHOLD_KEYS = {
  lessonDelivery: 'jev.lessonDeliveryPercent',
  domainPage: 'jev.domainPagePercent',
  historyGate: 'jev.historyGatePercent',
};
export const JEV_THRESHOLD_DEFAULTS = Object.freeze({
  [JEV_THRESHOLD_KEYS.lessonDelivery]: 60,
  [JEV_THRESHOLD_KEYS.domainPage]: 50,
  [JEV_THRESHOLD_KEYS.historyGate]: 60,
});

function jevThresholdPercent(key, value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error(`${key}: expected an integer percent within {"min":0,"max":100}, got ${JSON.stringify(value)}`);
  }
  return value / 100;
}

function jevThresholdValue(values, key) {
  const value = Object.hasOwn(values, key) ? values[key] : JEV_THRESHOLD_DEFAULTS[key];
  if (value === undefined) throw new Error(`${key}: not a Jev threshold key`);
  return jevThresholdPercent(key, value);
}

/** Install-scope Jev threshold: the stored percent, else the shipped default. A corrupt file
 * or an invalid stored value throws naming the file or key; the default never hides a broken store. */
export function installJevThreshold(stateDir, key) {
  const { document } = readInstallSettings(stateDir);
  return jevThresholdValue(document.values, key);
}

/** Project-scope Jev threshold: the checkout's shipped percent, else the default. Read errors name the file. */
export function projectJevThreshold(repoRoot, key) {
  const { values } = readHarnessSettings(repoRoot);
  return jevThresholdValue(values, key);
}

/** The install state dir hooks read settings from; the same rule the orchestrator daemon uses (config.ts). */
export function orchStateDir(env = process.env, home = homedir()) {
  return env.ORCH_STATE_DIR ? path.resolve(env.ORCH_STATE_DIR) : path.join(home, '.local', 'state', 'orch');
}
