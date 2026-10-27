// Local login descriptors and a file-only proof. No network call, no paid
// request, and no secret value in a return or an error. Facts: ops/usage-snapshot.mjs,
// ops/orchestrator/src/providers/index.ts, and the secrets-file readers
// (ops/bootstrap/jev-client.mjs readApiKey, install-harness.mjs loadSecrets).
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_FAMILIES, readHarnessConfig } from './harness-config.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_FILE = fileURLToPath(new URL('../../ops/bootstrap/family-logins.json', import.meta.url));
const REQUIRED = Object.freeze([...HARNESS_FAMILIES, 'jev']);
const MAX_BYTES = 1_048_576;
const CLI_FILE = 'kimi-code.json';
const CLI_ENV_FILE = /^kimi-code-env-[a-f0-9]+\.json$/;
const FIELD = /^[A-Za-z0-9_-]{1,64}$/;
const ENTRY = /^[A-Za-z0-9._-]{1,80}$/;
const COMMAND = /^[A-Za-z0-9 ._-]{1,200}$/;
const PROMPT = /^[A-Za-z0-9 ._()/-]{1,120}$/;

let cachedFile;
let cached;

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function freeze(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function fail(message) {
  throw new Error(message);
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    fail('cannot read family logins');
  }
}

function parseJson(text, message) {
  try {
    return JSON.parse(text);
  } catch {
    fail(message);
  }
}

function allowedKeys(id, object, required, optional = []) {
  if (!plain(object)) fail(`family logins: ${id} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(object, key)) fail(`family logins: ${id} missing ${key}`);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`family logins: ${id} unexpected field`);
  }
}

function safeRelative(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (value.includes('\\') || value.includes('..') || value.startsWith('/')) return false;
  return value.split('/').every((part) => /^(?:[A-Za-z0-9._@-]|\{prefix\})+$/.test(part));
}

function fieldName(id, value) {
  if (typeof value !== 'string' || !FIELD.test(value)) fail(`family logins: ${id} field is invalid`);
}

function entryName(id, value) {
  if (typeof value !== 'string' || !ENTRY.test(value)) fail(`family logins: ${id} entry is invalid`);
}

function commandText(id, value) {
  if (typeof value !== 'string' || !COMMAND.test(value)) fail(`family logins: ${id} is not a command`);
}

function promptText(id, value) {
  // Printed on the terminal before the hidden read. No control characters, so a
  // descriptor cannot spoof the prompt or carry a value into the question.
  if (typeof value !== 'string' || value !== value.trim() || !PROMPT.test(value)) {
    fail(`family logins: ${id} prompt is invalid`);
  }
}

function validateKeyPrompts(id, login) {
  const names = login.entries ?? [login.entry];
  if (!plain(login.prompts)) fail(`family logins: ${id} entry has no prompt`);
  for (const name of names) {
    if (!Object.hasOwn(login.prompts, name)) fail(`family logins: ${id} entry has no prompt`);
    promptText(`${id}.prompts`, login.prompts[name]);
  }
  for (const key of Object.keys(login.prompts)) {
    if (!names.includes(key)) fail(`family logins: ${id} prompts do not match the entries`);
  }
}

function segments(id, value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) fail(`family logins: ${id} path is invalid`);
  for (const segment of value) fieldName(id, segment);
}

function entryList(id, value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) fail(`family logins: ${id} entries are invalid`);
  const seen = new Set();
  for (const entry of value) {
    entryName(id, entry);
    if (seen.has(entry)) fail(`family logins: ${id} entries are invalid`);
    seen.add(entry);
  }
}

function pathList(id, value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) fail(`family logins: ${id} paths are invalid`);
  const seen = new Set();
  for (const segments of value) {
    if (!Array.isArray(segments) || segments.length < 1 || segments.length > 8) fail(`family logins: ${id} paths are invalid`);
    for (const segment of segments) fieldName(id, segment);
    const name = segments.join('.');
    if (seen.has(name)) fail(`family logins: ${id} paths are invalid`);
    seen.add(name);
  }
}

function validateLogin(id, login) {
  if (!plain(login) || typeof login.kind !== 'string') fail(`family logins: ${id} must be an object`);
  if (login.kind === 'cli') {
    allowedKeys(id, login, ['kind', 'command'], ['instruction']);
    commandText(`${id}.command`, login.command);
    if (login.instruction !== undefined) commandText(`${id}.instruction`, login.instruction);
    return;
  }
  if (login.kind === 'key') {
    const many = Object.hasOwn(login, 'entries');
    if (many === Object.hasOwn(login, 'entry')) fail(`family logins: ${id} must name entry or entries`);
    allowedKeys(id, login, many ? ['kind', 'store', 'entries', 'prompts'] : ['kind', 'store', 'entry', 'prompts'], ['fixed']);
    if (!safeRelative(login.store)) fail(`family logins: ${id}.store is invalid`);
    if (many) entryList(id, login.entries);
    else entryName(id, login.entry);
    validateKeyPrompts(id, login);
    if (login.fixed !== undefined) {
      if (!plain(login.fixed)) fail(`family logins: ${id}.fixed must be an object`);
      const names = Object.keys(login.fixed);
      entryList(`${id}.fixed`, names);
      for (const name of names) {
        segments(`${id}.fixed`, name.split('.'));
        if ((login.entries ?? [login.entry]).includes(name)) fail(`family logins: ${id}.fixed overlaps an entry`);
        checkedValue(`${id}.fixed`, login.fixed[name]);
      }
    }
    return;
  }
  if (login.kind === 'pi') {
    allowedKeys(id, login, ['kind', 'command', 'entries']);
    if (login.command !== '/login') fail(`family logins: ${id}.command must be /login`);
    entryList(id, login.entries);
    return;
  }
  fail(`family logins: ${id}.kind must be cli, key or pi`);
}

function validateExpiry(id, expiry) {
  allowedKeys(id, expiry, ['path', 'unit', 'zeroMeansUnknown']);
  segments(id, expiry.path);
  if (expiry.unit !== 'ms' || expiry.zeroMeansUnknown !== true) fail(`family logins: ${id} expiry is invalid`);
}

function validatePiProof(id, pi) {
  allowedKeys(`${id}.proof.pi`, pi, ['path', 'entry', 'token', 'expiry', 'unit'], ['type']);
  if (!safeRelative(pi.path) || pi.path.includes('{')) fail(`family logins: ${id}.proof.pi.path is invalid`);
  entryName(`${id}.proof.pi`, pi.entry);
  fieldName(`${id}.proof.pi`, pi.token);
  fieldName(`${id}.proof.pi`, pi.expiry);
  if (pi.unit !== 'ms') fail(`family logins: ${id}.proof.pi.unit must be ms`);
  if (pi.type !== undefined && pi.type !== 'oauth') fail(`family logins: ${id}.proof.pi.type must be oauth`);
}

function validateProof(id, proof, login) {
  if (!plain(proof) || typeof proof.kind !== 'string') fail(`family logins: ${id}.proof must be an object`);
  const kind = proof.kind;
  if (login.fixed !== undefined && kind !== 'json') fail(`family logins: ${id} fixed values require a json proof`);
  if (kind === 'json') {
    allowedKeys(`${id}.proof`, proof, ['kind', 'required'], ['expiry']);
    pathList(`${id}.proof`, proof.required);
    if (proof.expiry !== undefined) validateExpiry(`${id}.proof`, proof.expiry);
    if (login.kind === 'key') {
      const names = [...(login.entries ?? [login.entry]), ...Object.keys(login.fixed ?? {})].sort();
      const proved = proof.required.map((segments) => segments.join('.')).sort();
      if (names.join('\0') !== proved.join('\0')) fail(`family logins: ${id} entry does not match the proof`);
    }
    return;
  }
  if (kind === 'jwt') {
    allowedKeys(`${id}.proof`, proof, ['kind', 'present'], ['required', 'pi']);
    segments(`${id}.proof`, proof.present);
    if (proof.required !== undefined) pathList(`${id}.proof`, proof.required);
    if (proof.pi !== undefined) validatePiProof(id, proof.pi);
    return;
  }
  if (kind === 'first-value') {
    allowedKeys(`${id}.proof`, proof, ['kind', 'field'], ['expiry', 'pi']);
    fieldName(`${id}.proof`, proof.field);
    if (proof.pi !== undefined) validatePiProof(id, proof.pi);
    if (proof.expiry !== undefined) {
      allowedKeys(`${id}.proof.expiry`, proof.expiry, ['field', 'unit']);
      fieldName(`${id}.proof.expiry`, proof.expiry.field);
      if (proof.expiry.unit !== 'iso') fail(`family logins: ${id}.proof.expiry is invalid`);
    }
    return;
  }
  if (kind === 'api-entry') {
    allowedKeys(`${id}.proof`, proof, ['kind', 'entry', 'type', 'field']);
    entryName(`${id}.proof`, proof.entry);
    fieldName(`${id}.proof`, proof.type);
    fieldName(`${id}.proof`, proof.field);
    if (login.kind === 'key' && proof.entry !== login.entry) fail(`family logins: ${id} entry does not match the proof`);
    return;
  }
  if (kind === 'api-entry-any') {
    allowedKeys(`${id}.proof`, proof, ['kind', 'entries', 'type', 'field']);
    entryList(`${id}.proof`, proof.entries);
    fieldName(`${id}.proof`, proof.type);
    fieldName(`${id}.proof`, proof.field);
    if (login.kind !== 'pi' || proof.entries.join('\0') !== login.entries.join('\0')) {
      fail(`family logins: ${id} entries do not match the proof`);
    }
    return;
  }
  if (kind === 'env-line') {
    allowedKeys(`${id}.proof`, proof, ['kind', 'entry']);
    entryName(`${id}.proof`, proof.entry);
    if (login.kind !== 'key' || proof.entry !== login.entry) fail(`family logins: ${id} entry does not match the proof`);
    return;
  }
  if (kind === 'kimi') {
    allowedKeys(`${id}.proof`, proof, ['kind', 'pi', 'cli']);
    validatePiProof(id, proof.pi);
    allowedKeys(`${id}.proof.cli`, proof.cli, ['dir', 'token', 'expiry', 'unit']);
    if (!safeRelative(proof.cli.dir) || proof.cli.dir.includes('{')) fail(`family logins: ${id}.proof.cli.dir is invalid`);
    fieldName(`${id}.proof.cli`, proof.cli.token);
    fieldName(`${id}.proof.cli`, proof.cli.expiry);
    if (proof.cli.unit !== 's') fail(`family logins: ${id}.proof.cli.unit must be s`);
    return;
  }
  fail(`family logins: ${id}.proof.kind is unknown`);
}

function validateUsage(id, usage) {
  if (!plain(usage)) fail(`family logins: ${id}.usageCredential must be an object`);
  if (usage.kind === 'chrome-cookie') {
    allowedKeys(`${id}.usageCredential`, usage, ['kind', 'hosts']);
    if (!Array.isArray(usage.hosts) || usage.hosts.length < 1 || usage.hosts.length > 8) {
      fail(`family logins: ${id}.usageCredential.hosts is invalid`);
    }
    for (const host of usage.hosts) {
      if (typeof host !== 'string' || !/^[A-Za-z0-9.-]{1,80}$/.test(host)) {
        fail(`family logins: ${id}.usageCredential.hosts is invalid`);
      }
    }
    return;
  }
  allowedKeys(`${id}.usageCredential`, usage, ['login', 'path', 'field']);
  allowedKeys(`${id}.usageCredential.login`, usage.login, ['kind', 'command']);
  if (usage.login.kind !== 'cli') fail(`family logins: ${id}.usageCredential.login.kind must be cli`);
  commandText(`${id}.usageCredential.login.command`, usage.login.command);
  if (!safeRelative(usage.path) || usage.path.includes('{')) fail(`family logins: ${id}.usageCredential.path is invalid`);
  fieldName(`${id}.usageCredential`, usage.field);
}

function validateUnread(id, store) {
  allowedKeys(`${id}.unreadStore`, store, ['platform', 'kind', 'name']);
  if (!['darwin', 'linux', 'win32'].includes(store.platform)) fail(`family logins: ${id}.unreadStore.platform is invalid`);
  if (store.kind !== 'keychain') fail(`family logins: ${id}.unreadStore.kind is invalid`);
  if (typeof store.name !== 'string' || !/^[A-Za-z0-9 ._-]{1,80}$/.test(store.name)) {
    fail(`family logins: ${id}.unreadStore.name is invalid`);
  }
}

function validateOne(id, entry) {
  allowedKeys(id, entry, ['login', 'credential', 'proof'], ['note', 'usageCredential', 'unreadStore', 'terminalLogin']);
  validateLogin(`${id}.login`, entry.login);
  if (entry.terminalLogin !== undefined) {
    allowedKeys(`${id}.terminalLogin`, entry.terminalLogin, ['command'], ['provider']);
    commandText(`${id}.terminalLogin.command`, entry.terminalLogin.command);
    if (entry.terminalLogin.provider !== undefined) {
      entryName(`${id}.terminalLogin.provider`, entry.terminalLogin.provider);
      if (entry.terminalLogin.command !== 'pi') fail(`family logins: ${id}.terminalLogin provider requires pi`);
    }
  }
  allowedKeys(`${id}.credential`, entry.credential, ['root', 'path']);
  if (entry.credential.root !== 'home' && entry.credential.root !== 'orchStateDir') {
    fail(`family logins: ${id}.credential.root must be home or orchStateDir`);
  }
  if (!safeRelative(entry.credential.path)) fail(`family logins: ${id}.credential.path is not relative`);
  if (entry.login.kind === 'key' && entry.login.store !== entry.credential.path) {
    fail(`family logins: ${id} store does not match the credential path`);
  }
  if (entry.proof?.kind === 'kimi' && entry.proof.cli?.dir !== entry.credential.path) {
    fail(`family logins: ${id} credential path must be the cli dir`);
  }
  validateProof(id, entry.proof, entry.login);
  if (entry.note !== undefined) {
    if (typeof entry.note !== 'string' || entry.note.length === 0 || entry.note.length > 240 || /[\r\n=]/.test(entry.note)) {
      fail(`family logins: ${id}.note is invalid`);
    }
  }
  if (entry.unreadStore !== undefined) {
    if (typeof entry.note !== 'string') fail(`family logins: ${id}.note is invalid`);
    validateUnread(id, entry.unreadStore);
  }
  if (entry.usageCredential !== undefined) validateUsage(id, entry.usageCredential);
}

function validate(value) {
  if (!plain(value)) fail('family logins: root must be an object');
  allowedKeys('root', value, ['schemaVersion', 'logins'], ['_comment']);
  if (value.schemaVersion !== 1) fail('family logins: schemaVersion must be 1');
  if (value._comment !== undefined && typeof value._comment !== 'string') fail('family logins: _comment must be a string');
  if (!plain(value.logins)) fail('family logins: logins must be an object');
  for (const id of REQUIRED) {
    if (!Object.hasOwn(value.logins, id)) fail(`family logins: missing ${id}`);
  }
  for (const id of Object.keys(value.logins)) {
    if (!REQUIRED.includes(id)) fail('family logins: unexpected key');
  }
  for (const id of REQUIRED) validateOne(id, value.logins[id]);
  return freeze(value.logins);
}

export function loadFamilyLogins(file = DEFAULT_FILE) {
  if (file === cachedFile && cached) return cached;
  const loaded = validate(parseJson(readText(file), 'invalid JSON in family logins'));
  if (file === DEFAULT_FILE) {
    cachedFile = file;
    cached = loaded;
  }
  return loaded;
}

function absoluteDir(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 4096
    && !value.includes('\0') && path.isAbsolute(value);
}

function secretsPrefix() {
  let prefix;
  try {
    prefix = readHarnessConfig({ repoRoot: REPO }).names.prefix;
  } catch {
    fail('cannot resolve the secrets file name');
  }
  if (typeof prefix !== 'string' || !/^[a-z][a-z0-9-]*$/.test(prefix) || prefix.length > 32) {
    fail('cannot resolve the secrets file name');
  }
  return prefix;
}

function resolveTemplate(relative) {
  if (!relative.includes('{prefix}')) return relative;
  const resolved = relative.replaceAll('{prefix}', secretsPrefix());
  if (!safeRelative(resolved) || resolved.includes('{') || resolved.includes('}')) {
    fail('cannot resolve the secrets file name');
  }
  return resolved;
}

function openRelative(root, relative, { directory = false } = {}) {
  if (!absoluteDir(root)) fail(directory ? 'home is required' : 'home is required');
  const parts = resolveTemplate(relative).split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) fail('credential file is unreadable');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return { missing: true };
      fail('credential file is unreadable');
    }
    if (stat.isSymbolicLink()) fail('refusing a symlink credential path');
    const last = index === parts.length - 1;
    if (!last) {
      if (!stat.isDirectory()) return { missing: true };
      continue;
    }
    if (directory) {
      if (!stat.isDirectory()) return { missing: true };
      return { directory: current };
    }
    if (!stat.isFile()) return { missing: true };
    if (stat.size > MAX_BYTES) fail('credential file is unreadable');
  }
  try {
    return { text: readFileSync(current, 'utf8') };
  } catch {
    fail('credential file is unreadable');
  }
}

function at(document, keys) {
  let current = document;
  for (const key of keys) {
    if (!plain(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function secretString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function absent() {
  return { state: 'missing', detail: 'local credential absent' };
}

function present() {
  return { state: 'ok', detail: 'local credential present' };
}

function expired() {
  return { state: 'expired', detail: 'local credential expired' };
}

function parseCredential(text) {
  return parseJson(text, 'credential file is unreadable');
}

function jwtExpMs(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function envPresent(text, name) {
  let value;
  for (const line of text.split(/\r?\n/)) {
    const cut = line.indexOf('=');
    if (cut > 0 && !line.trim().startsWith('#') && line.slice(0, cut).trim() === name) {
      value = line.slice(cut + 1).trim();
    }
  }
  return secretString(value);
}

function fromJson(proof) {
  return (document) => {
    if (!proof.required.every((segments) => secretString(at(document, segments)))) return absent();
    if (proof.expiry) {
      const atMs = Number(at(document, proof.expiry.path));
      if (Number.isFinite(atMs) && atMs > 0 && atMs < Date.now()) return expired();
    }
    return present();
  };
}

function fromJwt(proof) {
  return (document) => {
    const token = at(document, proof.present);
    if (!secretString(token)) return absent();
    const expMs = jwtExpMs(token);
    if (expMs !== null && expMs <= Date.now()) return expired();
    if (proof.required && !proof.required.every((segments) => secretString(at(document, segments)))) return absent();
    return present();
  };
}

function fromFirst(proof) {
  return (document) => {
    if (!plain(document)) return absent();
    const entry = Object.values(document)[0];
    if (!plain(entry) || !Object.hasOwn(entry, proof.field) || !secretString(entry[proof.field])) return absent();
    if (proof.expiry && Object.hasOwn(entry, proof.expiry.field)) {
      const atMs = Date.parse(entry[proof.expiry.field] ?? '');
      if (Number.isFinite(atMs) && atMs < Date.now()) return expired();
    }
    return present();
  };
}

function matchesEntry(document, name, type, field) {
  if (!plain(document) || !Object.hasOwn(document, name)) return false;
  const entry = document[name];
  return plain(entry) && entry.type === type && Object.hasOwn(entry, field) && secretString(entry[field]);
}

function fromApiEntry(proof) {
  return (document) => (matchesEntry(document, proof.entry, proof.type, proof.field) ? present() : absent());
}

function fromApiAny(proof) {
  return (document) => (
    proof.entries.some((name) => matchesEntry(document, name, proof.type, proof.field)) ? present() : absent()
  );
}

function readPi(spec, home) {
  let opened;
  try {
    opened = openRelative(home, spec.path);
  } catch (error) {
    return { token: false, usable: false, unreadable: true, symlink: error?.message === 'refusing a symlink credential path' };
  }
  if (opened.missing) return { token: false, usable: false };
  let document;
  try {
    document = JSON.parse(opened.text);
  } catch {
    return { token: false, usable: false, unreadable: true };
  }
  const entry = plain(document) && Object.hasOwn(document, spec.entry) ? document[spec.entry] : undefined;
  if (spec.type !== undefined && entry?.type !== spec.type) return { token: false, usable: false };
  const token = plain(entry) && Object.hasOwn(entry, spec.token) && secretString(entry[spec.token]);
  const atMs = plain(entry) ? Number(entry[spec.expiry]) : NaN;
  return { token, usable: Boolean(token) && Number.isFinite(atMs) && atMs > Date.now() };
}

function readKimiCli(spec, home) {
  let opened;
  try {
    opened = openRelative(home, spec.dir, { directory: true });
  } catch (error) {
    return { token: false, usable: false, unreadable: true, symlink: error?.message === 'refusing a symlink credential path' };
  }
  if (opened.missing) return { token: false, usable: false };
  let names;
  try {
    names = readdirSync(opened.directory);
  } catch {
    return { token: false, usable: false, unreadable: true };
  }
  if (names.length > 64) return { token: false, usable: false, unreadable: true };
  let latest = null;
  let expiry = -Infinity;
  let matched = 0;
  let failed = 0;
  let symlink = false;
  for (const name of names) {
    if (name !== CLI_FILE && !CLI_ENV_FILE.test(name)) continue;
    matched += 1;
    let file;
    try {
      file = openRelative(opened.directory, name);
    } catch (error) {
      failed += 1;
      if (error?.message === 'refusing a symlink credential path') symlink = true;
      continue;
    }
    if (file.missing) {
      failed += 1;
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(file.text);
    } catch {
      failed += 1;
      continue;
    }
    if (!plain(entry) || !Object.hasOwn(entry, spec.token) || !secretString(entry[spec.token])) continue;
    const atSeconds = Number(entry[spec.expiry]);
    const timestamp = entry[spec.expiry] == null || !Number.isFinite(atSeconds) ? -Infinity : atSeconds;
    if (latest === null || timestamp > expiry) {
      latest = entry;
      expiry = timestamp;
    }
  }
  if (!latest) return { token: false, usable: false, unreadable: matched > 0 && failed === matched, symlink };
  return { token: true, usable: Number.isFinite(expiry) && expiry * 1000 > Date.now() };
}

function proveKimi(proof, home) {
  if (!absoluteDir(home)) fail('home is required');
  const pi = readPi(proof.pi, home);
  const cli = readKimiCli(proof.cli, home);
  if (pi.usable || cli.usable) return present();
  if (pi.token || cli.token) return expired();
  if (pi.symlink || cli.symlink) fail('refusing a symlink credential path');
  if (pi.unreadable && cli.unreadable) fail('credential file is unreadable');
  return absent();
}

function proveFile(descriptor, { home, orchStateDir }) {
  const named = descriptor.credential.root;
  const root = named === 'orchStateDir' ? orchStateDir : home;
  if (!absoluteDir(root)) fail(named === 'orchStateDir' ? 'orchStateDir is required' : 'home is required');
  const opened = openRelative(root, descriptor.credential.path);
  if (opened.missing) return absent();
  if (descriptor.proof.kind === 'env-line') {
    return envPresent(opened.text, descriptor.proof.entry) ? present() : absent();
  }
  let document;
  try {
    document = JSON.parse(opened.text);
  } catch {
    if (descriptor.unreadStore && process.platform === descriptor.unreadStore.platform) return absent();
    fail('credential file is unreadable');
  }
  const readers = { json: fromJson, jwt: fromJwt, 'first-value': fromFirst, 'api-entry': fromApiEntry, 'api-entry-any': fromApiAny };
  return readers[descriptor.proof.kind](descriptor.proof)(document);
}

function prove(descriptor, options) {
  if (descriptor.proof.kind === 'kimi') return proveKimi(descriptor.proof, options.home);
  if (!descriptor.proof.pi) return proveFile(descriptor, options);
  if (!absoluteDir(options.home)) fail('home is required');
  const pi = readPi(descriptor.proof.pi, options.home);
  if (pi.usable) return present();
  let cli;
  let cliError;
  try {
    cli = proveFile(descriptor, options);
  } catch (error) {
    cliError = error;
  }
  if (cli?.state === 'ok') return cli;
  if (pi.token || cli?.state === 'expired') return expired();
  if (pi.symlink || cliError?.message === 'refusing a symlink credential path') fail('refusing a symlink credential path');
  if (pi.unreadable || cliError) fail('credential file is unreadable');
  return absent();
}

function conceal(descriptor, result) {
  const store = descriptor.unreadStore;
  if (!store || process.platform !== store.platform) return result;
  if (result.state !== 'missing' && result.state !== 'expired') return result;
  return { state: 'unknown', detail: descriptor.note };
}

export function checkLogin(family, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('home is required');
  if (Object.hasOwn(options, 'stateDir')) fail('pass orchStateDir, not stateDir');
  const logins = loadFamilyLogins();
  if (typeof family !== 'string' || !Object.hasOwn(logins, family)) fail('unknown login');
  return conceal(logins[family], prove(logins[family], options));
}

// ---- the secret write (task 2275, slice L1b) ----
// One canonical writer for a `key` login's own store. The value reaches this
// module only as an argument; it never enters a message, a return or a log.

const SECRET_VALUE = /^[^\x00-\x1f\x7f]{1,8192}$/;

function storeTarget(descriptor, { home, orchStateDir }) {
  const named = descriptor.credential.root;
  const root = named === 'orchStateDir' ? orchStateDir : home;
  if (!absoluteDir(root)) fail(named === 'orchStateDir' ? 'orchStateDir is required' : 'home is required');
  const parts = resolveTemplate(descriptor.credential.path).split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) fail('credential store is unreadable');
  return { root, parts, file: path.join(root, ...parts) };
}

// Every component below the trusted root down to the store is checked for
// symlinks (lesson 10772). The home directory itself, and an orch state
// directory that is not below home, are trusted roots; when the state
// directory IS below home, the components between home and it are checked too.
function insideHome(dir, home) {
  return dir === home || dir.startsWith(home + path.sep);
}

function assertWritablePath(root, parts, { home }) {
  // True precedent: migrateOrchProviders (ops/bootstrap/install-harness.mjs
  // :2066-2069) builds components = [path.resolve(ctx.home)] plus .local,
  // state, orch and lstats EACH component, the home directory included,
  // refusing one that is not a directory — so a symlinked home is refused
  // here too. Only the home component and the components below it are
  // checked, never its ancestors: on macOS the temporary directory sits
  // below /var or /tmp, which are symlinks above any test home (lesson 10772).
  // A state directory outside home is checked the same way, as its own root.
  const base = root === home || insideHome(root, home) ? home : root;
  let chain = path.relative(base, root).split(path.sep);
  if (chain.length === 1 && chain[0] === '') chain = [];
  if (chain.some((part) => part === '..' || part === '')) fail('credential store is unreadable');
  const all = [...chain, ...parts.slice(0, -1)];
  let current = base;
  // The root itself first — for a state directory below home that root IS
  // the home directory; a symlinked home is refused like any component.
  for (const component of [base, ...all]) {
    if (component !== base) current = path.join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return; // the rest is created by the write
      fail('credential store is unreadable');
    }
    if (stat.isSymbolicLink()) fail('refusing a symlink credential path');
    if (!stat.isDirectory()) fail('credential store is unreadable');
  }
}

function readStoreBytes(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('credential store is unreadable');
  }
  if (stat.isSymbolicLink()) fail('refusing a symlink credential path');
  if (!stat.isFile() || stat.size > MAX_BYTES) fail('credential store is unreadable');
  try {
    return readFileSync(file);
  } catch {
    fail('credential store is unreadable');
  }
}

function sameStore(now, snapshot) {
  if (now === null || snapshot === null) return now === snapshot;
  return Buffer.compare(now, snapshot) === 0;
}

function checkedValue(name, value) {
  if (typeof value !== 'string') fail(`family logins: ${name} value is invalid`);
  const trimmed = value.trim();
  if (!SECRET_VALUE.test(trimmed)) fail(`family logins: ${name} value is invalid`);
  return trimmed;
}

// The reader (install-harness.mjs loadSecrets, envPresent above) takes the
// LAST assignment for a name, so the write replaces the last one and leaves
// every other line, comments included, byte for byte.
function setEnvAssignment(text, name, value) {
  const lines = text.split('\n');
  let at = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const cut = line.indexOf('=');
    if (cut > 0 && !line.trim().startsWith('#') && line.slice(0, cut).trim() === name) at = index;
  }
  if (at >= 0) {
    lines[at] = `${name}=${value}`;
    return lines.join('\n');
  }
  let out = text;
  if (out.length > 0 && !out.endsWith('\n')) out += '\n';
  return `${out}${name}=${value}\n`;
}

function jsonObjectAt(text, file) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    fail(`${file} cannot be parsed; nothing was written`);
  }
  if (!plain(document)) fail(`${file} cannot be parsed; nothing was written`);
  return document;
}

// A `json` proof names each value as a dotted path into the store.
function setJsonPath(document, name, value) {
  const segments = name.split('.');
  let current = document;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index];
    if (!Object.hasOwn(current, key)) current[key] = {};
    else if (!plain(current[key])) fail(`family logins: store cannot hold ${name}`);
    current = current[key];
  }
  current[segments[segments.length - 1]] = value;
}

// An `api-entry` proof names one entry object with a type and a value field.
function setApiEntry(document, proof, value) {
  if (!Object.hasOwn(document, proof.entry)) document[proof.entry] = {};
  const entry = document[proof.entry];
  if (!plain(entry)) fail(`family logins: store cannot hold ${proof.entry}`);
  entry.type = proof.type;
  entry[proof.field] = value;
}

// Directories the write creates are owner-only (0700, whatever the umask
// leaves of it); a directory that already exists is never touched.
function ensureOwnerDir(directory) {
  if (existsSync(directory)) return;
  const parent = path.dirname(directory);
  if (parent !== directory) ensureOwnerDir(parent);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') fail('cannot write the credential store');
  }
}

function removeTemp(temp) {
  // Best effort: a removal that itself fails leaves a 0600 temp file in the
  // store's directory; it never becomes the store.
  try {
    unlinkSync(temp);
  } catch {
    // ignored, see above
  }
}

// Temp file in the same directory, mode forced 0600, fsync, then a rename.
// Every failure path removes the temp file, so the old bytes stay whole until
// one atomic step swaps them.
function atomicStoreWrite(file, text, snapshot) {
  try {
    ensureOwnerDir(path.dirname(file));
  } catch {
    fail('cannot write the credential store');
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
  } catch {
    fail('cannot write the credential store');
  }
  try {
    writeSync(fd, text, null, 'utf8');
    fsyncSync(fd);
    // A restrictive umask is allowed, but the store has exactly owner
    // read/write before it can become visible (migrateOrchProviders).
    fchmodSync(fd, 0o600);
    closeSync(fd);
    fd = undefined;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // the temp file is removed below
      }
    }
    removeTemp(temp);
    fail('cannot write the credential store');
  }
  // Lost update: the snapshot was taken when this write began (after the
  // value was typed); if another writer changed the store's bytes since, the
  // write refuses. Accepted limit: this is a compare, not a lock — a writer
  // that lands between this read and the rename is still overwritten, and no
  // lock is shared with Pi (Pi takes none).
  let now;
  try {
    now = readStoreBytes(file);
  } catch {
    removeTemp(temp);
    fail('the credential store changed while writing; nothing was written');
  }
  if (!sameStore(now, snapshot)) {
    removeTemp(temp);
    fail('the credential store changed while writing; nothing was written');
  }
  try {
    renameSync(temp, file);
  } catch {
    removeTemp(temp);
    fail('cannot write the credential store');
  }
}

function keyDescriptor(family) {
  const logins = loadFamilyLogins();
  if (typeof family !== 'string' || !Object.hasOwn(logins, family)) fail('unknown login');
  return logins[family];
}

// The shape a caller needs before it prompts: the entries of a `key` login in
// their stored order, each with its human prompt, or the provider's own login
// command when the family signs in some other way. The prompt is not the
// entry name: the name stays the store key.
export function keyLogin(family) {
  const descriptor = keyDescriptor(family);
  const login = descriptor.login;
  if (login.kind === 'key') {
    const entries = login.entries ?? [login.entry];
    return { entries, prompts: login.prompts };
  }
  return { command: login.command };
}

export function writeLoginSecrets(family, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('home is required');
  if (Object.hasOwn(options, 'stateDir')) fail('pass orchStateDir, not stateDir');
  const descriptor = keyDescriptor(family);
  if (descriptor.login.kind !== 'key') {
    fail(`${family} signs in with its own command: ${descriptor.login.command}`);
  }
  const names = descriptor.login.entries ?? [descriptor.login.entry];
  const values = options.values;
  if (!plain(values)) fail('family logins: values must be an object');
  const given = Object.keys(values);
  if (given.length !== names.length || names.some((name) => !given.includes(name))) {
    fail('family logins: values do not match the entries');
  }
  const target = storeTarget(descriptor, options);
  assertWritablePath(target.root, target.parts, options);
  // The store is read here, after the caller collected the values: the
  // snapshot below is the basis of the lost-update compare at the rename.
  const snapshot = readStoreBytes(target.file);
  let out;
  if (descriptor.proof.kind === 'env-line') {
    out = names.reduce((acc, name) => setEnvAssignment(acc, name, checkedValue(name, values[name])), snapshot === null ? '' : snapshot.toString('utf8'));
  } else {
    // Accepted limit: a JSON store is written again with JSON.stringify, so
    // its other entries keep their values and order, not their bytes.
    const document = snapshot === null ? {} : jsonObjectAt(snapshot.toString('utf8'), target.file);
    for (const name of names) {
      const value = checkedValue(name, values[name]);
      if (descriptor.proof.kind === 'api-entry') setApiEntry(document, descriptor.proof, value);
      else setJsonPath(document, name, value);
    }
    // Fixed descriptor values fill absent paths only; a user's endpoint stays.
    for (const [name, value] of Object.entries(descriptor.login.fixed ?? {})) {
      if (at(document, name.split('.')) === undefined) setJsonPath(document, name, checkedValue(name, value));
    }
    out = `${JSON.stringify(document, null, 2)}\n`;
  }
  atomicStoreWrite(target.file, out, snapshot);
  return { file: target.file, entries: names.length };
}
