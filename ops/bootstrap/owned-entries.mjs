// String-list ownership shared by installer steps. Callers serialize runs with
// the installer lock and read/validate their target before calling writeOwned.
import { randomUUID } from 'node:crypto';
import {
  chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

function assertEntries(entries) {
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
    throw new TypeError('owned entries must be arrays of strings');
  }
}

// An absent ownership record adopts only present entries also in the canon.
export function mergeKeep(present, canon, owned) {
  assertEntries(present);
  assertEntries(canon);
  const previous = owned === undefined ? present.filter((entry) => canon.includes(entry)) : owned;
  assertEntries(previous);
  const ownedSet = new Set(previous);
  return [...new Set([...canon, ...present.filter((entry) => !ownedSet.has(entry))])];
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readManifest(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read ownership manifest ${file}: ${error.message}`, { cause: error });
  }
  try {
    const manifest = JSON.parse(text);
    if (!isRecord(manifest)) throw new TypeError('expected a target record');
    for (const lists of Object.values(manifest)) {
      if (!isRecord(lists)) throw new TypeError('expected a list record');
      for (const entries of Object.values(lists)) assertEntries(entries);
    }
    return manifest;
  } catch (error) {
    throw new Error(`Invalid ownership manifest ${file}: ${error.message}`, { cause: error });
  }
}

function writeManifest(file, manifest) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function targetIdentity(file) {
  let candidate = path.resolve(file);
  const suffix = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(candidate), ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Manifest shape: { [canonicalTargetPath]: { [listName]: string[] } }.
 * Missing targets use the nearest existing parent's real path plus the suffix.
 * lists: { [listName]: { present: string[], canon: string[] } }.
 * writeTarget(mergedLists) must synchronously persist the target or throw.
 * A thrown target write intentionally leaves the superset ownership manifest.
 */
export function writeOwned({ manifestPath, targetPath, lists, writeTarget }) {
  const file = path.resolve(manifestPath);
  const target = targetIdentity(targetPath);
  const manifest = readManifest(file);
  if (!isRecord(lists)) throw new TypeError('lists must be a record');
  if (typeof writeTarget !== 'function') throw new TypeError('writeTarget must be a function');
  const oldLists = Object.hasOwn(manifest, target) ? manifest[target] : {};
  const merged = {};
  let pendingLists = { ...oldLists };
  let finalLists = { ...oldLists };
  for (const [name, { present, canon }] of Object.entries(lists)) {
    const owned = Object.hasOwn(oldLists, name) ? oldLists[name] : undefined;
    const next = mergeKeep(present, canon, owned);
    Object.defineProperty(merged, name, { value: next, enumerable: true });
    const previous = owned ?? present.filter((entry) => canon.includes(entry));
    pendingLists = { ...pendingLists, [name]: [...new Set([...previous, ...canon])] };
    finalLists = { ...finalLists, [name]: [...new Set(canon)] };
  }
  writeManifest(file, { ...manifest, [target]: pendingLists });
  writeTarget(merged);
  writeManifest(file, { ...manifest, [target]: finalLists });
  return merged;
}
