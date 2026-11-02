/** Shared vendor-manifest rule (task 3478): a path is vendored only when a
 *  folder's VENDOR.json pins the SHA-256 of the path's git blob in the judged
 *  tree. Differing bytes, missing entries, symlinks and gitlinks stay own code;
 *  an unreadable or invalid manifest fails loudly — provenance that cannot be
 *  verified must never silently skip a file (task 3467). review-plan.ts keeps
 *  its own copy (it must not import scripts/); test-vendor-paths.mjs pins both
 *  copies to the same verdicts, including review-plan's documentation exclusions.
 *  Provenance metadata and ordinary Markdown stay judged, never pinned payload. */
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

export function manifestPath(folder) {
  return folder === '.' ? 'VENDOR.json' : `${folder}/VENDOR.json`;
}

export function regularMode(mode) {
  return /^100(?:644|755)$/.test(mode);
}

/** review-plan.ts docPath rule: provenance/docs stay judged, except the
 *  agent-instruction filenames that review-plan deliberately treats as code. */
export function isVendorMeta(path) {
  return /(?:^|\/)(?:VENDOR\.json|NOTICE)$/i.test(path)
    || /\.md$/i.test(path) && !/(?:^|\/)(?:CLAUDE|AGENTS)\.md$/.test(path);
}

export function manifestFiles(bytes, manifest) {
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`Invalid VENDOR.json ${manifest}: not valid JSON`);
  }
  const shape = data && ['source', 'sha', 'path', 'license'].every(key => typeof data[key] === 'string')
    && data.files && typeof data.files === 'object' && !Array.isArray(data.files);
  if (!shape) throw new Error(`Invalid VENDOR.json ${manifest}: expected source/sha/path/license strings and a files object`);
  return data.files;
}

/** The pinned digest for `path` under `folder`, lowercased for comparison. */
export function pinnedSha(files, folder, path) {
  const key = folder === '.' ? path : path.slice(folder.length + 1);
  const expected = Object.hasOwn(files, key) ? files[key] : undefined;
  return typeof expected === 'string' && /^[0-9a-f]{64}$/i.test(expected) ? expected.toLowerCase() : null;
}

/** mode:oid map of a tree from one `git ls-tree -rz` read. */
export function stagedMap(tree, cwd, git) {
  const raw = git(['ls-tree', '-rz', tree], { cwd, maxBuffer: 1 << 28 });
  const staged = new Map();
  for (const row of String(raw).split('\0')) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(row);
    if (match) staged.set(match[4], { mode: match[1], oid: match[3] });
  }
  return staged;
}

/** SHA-256 of every blob named by `entries` ({path, oid}), one cat-file process. */
function blobDigests(entries, cwd, git) {
  const out = git(['cat-file', '--batch'], {
    cwd, encoding: undefined, maxBuffer: 1 << 30, input: entries.map(({ oid }) => `${oid}\n`).join(''),
  });
  const digests = new Map();
  let offset = 0;
  for (const { path } of entries) {
    const newline = out.indexOf(10, offset);
    if (newline < 0) throw new Error(`Invalid VENDOR.json blob read for ${path}`);
    const [oid, type, size] = out.subarray(offset, newline).toString('utf8').split(' ');
    if (type !== 'blob') throw new Error(`${oid} is not a blob (VENDOR.json pin for ${path})`);
    const end = newline + 1 + Number(size);
    if (end > out.length) throw new Error(`Invalid VENDOR.json blob read for ${path}`);
    digests.set(path, createHash('sha256').update(out.subarray(newline + 1, end)).digest('hex'));
    offset = end + 1;
  }
  return digests;
}

export function trackedManifestPaths(cwd, git) {
  return new Set(String(git(['ls-files', '--cached', '-z', '--', ':(glob)**/VENDOR.json'], {
    cwd, maxBuffer: 64 * 1024 * 1024,
  })).split('\0').filter(Boolean));
}

/** Resolve a tracked manifest from the judged tree. A disposable add -A tree
 *  may also hold untracked provenance: that must never certify an exemption. */
function manifestOf(tree, manifest, staged, cwd, git, tracked) {
  if (!tracked.has(manifest)) return null;
  const entry = staged.get(manifest);
  if (!entry) return null;
  if (!regularMode(entry.mode)) throw new Error(`Invalid VENDOR.json ${manifest}: not a regular file`);
  return manifestFiles(git(['show', `${tree}:${manifest}`], { cwd, encoding: undefined, maxBuffer: 64 * 1024 * 1024 }), manifest);
}

/** The manifest that pins this tree blob, or null when the path is own code.
 *  Per-path form (check-complexity-growth.mjs); throws on an invalid manifest. */
export function vendorSkip(tree, path, staged, cwd, git) {
  // A pin certifies only a regular-file blob: a symlink (120000) or gitlink
  // (160000) is own code, the source-mode rule of review-plan.ts vendorPaths().
  if (isVendorMeta(path)) return null;
  const source = staged.get(path);
  if (!source || !regularMode(source.mode)) return null;
  const tracked = trackedManifestPaths(cwd, git);
  for (let folder = dirname(path); ; folder = dirname(folder)) {
    const manifest = manifestPath(folder);
    const files = manifestOf(tree, manifest, staged, cwd, git, tracked);
    if (files) {
      const expected = pinnedSha(files, folder, path);
      if (expected && createHash('sha256').update(git(['show', `${tree}:${path}`], { cwd, encoding: undefined, maxBuffer: 64 * 1024 * 1024 })).digest('hex') === expected) return manifest;
    }
    if (folder === '.') break;
  }
  return null;
}

/** All ancestor manifest pins for `path` in nearest-first order, or null when the
 *  path is own code (no regular-file blob, no pin, or vendored documentation). */
function resolvePin(path, staged, resolveManifest) {
  if (isVendorMeta(path)) return null;
  const entry = staged.get(path);
  if (!entry || !regularMode(entry.mode)) return null;
  const pins = [];
  for (let folder = dirname(path); ; folder = dirname(folder)) {
    const manifest = manifestPath(folder);
    const files = resolveManifest(manifest);
    if (files) {
      const expected = pinnedSha(files, folder, path);
      if (expected) pins.push({ manifest, expected });
    }
    if (folder === '.') break;
  }
  return pins.length ? { path, oid: entry.oid, pins } : null;
}

/** Split `paths` into vendored (path -> manifest) and own code for the judged
 *  tree. Batched: one ls-tree, one cat-file per manifest and one for every
 *  pinned candidate blob, so a 10k-file vendored tree stays one pass. A path
 *  with no pin, a tampered blob or an unlisted file stays own code. `tracked`
 *  may supply an already restricted pin snapshot's Set/Map of manifest paths
 *  (large-file's add -u + add -A excluding VENDOR.json, or selected index). */
export function splitVendorPaths({ tree, paths, cwd, git, staged = null, tracked = null }) {
  const map = staged ?? stagedMap(tree, cwd, git);
  const admitted = tracked ?? trackedManifestPaths(cwd, git);
  const cache = new Map();
  const resolveManifest = (manifest) => {
    if (!cache.has(manifest)) cache.set(manifest, manifestOf(tree, manifest, map, cwd, git, admitted));
    return cache.get(manifest);
  };
  // Metadata is never exempt, but a changed tracked manifest must still be valid
  // even without payload paths. Deleted and untracked manifests cannot certify pins.
  paths.filter(path => /(?:^|\/)VENDOR\.json$/.test(path)).forEach(resolveManifest);
  const own = [];
  const candidates = [];
  for (const path of paths) {
    const pin = resolvePin(path, map, resolveManifest);
    if (pin) candidates.push(pin);
    else own.push(path);
  }
  const vendored = new Map();
  if (candidates.length) {
    const digests = blobDigests(candidates, cwd, git);
    for (const { path, pins } of candidates) {
      const pin = pins.find(({ expected }) => digests.get(path) === expected);
      if (pin) vendored.set(path, pin.manifest);
      else own.push(path);
    }
  }
  return { vendored, own };
}
