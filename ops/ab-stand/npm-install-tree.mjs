// Shared locked-package validation and full installed-tree enumeration.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** npm ci validates each locked tarball's integrity before extraction. */
export function integrityPinnedPackages(lock, pins, extraDependencies = {}, name = 'codex-edit') {
  if (lock.lockfileVersion !== 3) throw new Error(`${name}: unsupported lockfile`);
  const entries = Object.entries(lock.packages).filter(([key]) => key !== '');
  for (const [key, entry] of entries) {
    if (!key.startsWith('node_modules/') || key.includes('\\') || key.split('/').some(part => part === '..' || part === '.' || part === '') ||
        typeof entry.version !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? '') ||
        typeof entry.resolved !== 'string' || !entry.resolved.startsWith(pins.registry) || entry.link) {
      throw new Error(`${name}: dependency ${key} is not integrity-pinned`);
    }
  }
  const main = lock.packages[`node_modules/${pins.package}`];
  if (main?.version !== pins.version || main.integrity !== pins.integrity ||
      lock.packages[''].dependencies?.[pins.package] !== pins.version ||
      Object.entries(extraDependencies).some(([dependency, version]) =>
        lock.packages[`node_modules/${dependency}`]?.version !== version ||
        lock.packages[''].dependencies?.[dependency] !== version)) throw new Error(`${name}: lockfile differs from shared pins`);
  return entries;
}

/** Hash every regular file, rejecting links/special files via the caller's
 * containment check. Enumeration detects additions and deletions as well. */
export function installedTree(root, inside, name) {
  const tree = {};
  const visit = (dir) => {
    for (const entry of readdirSync(inside(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = inside(root, path.join(dir, entry.name));
      const stat = lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) tree[path.relative(root, file).split(path.sep).join('/')] = createHash('sha256').update(readFileSync(file)).digest('hex');
      else throw new Error(`${name}: refusing non-regular dependency entry ${file}`);
    }
  };
  visit(path.join(root, 'node_modules'));
  return tree;
}
