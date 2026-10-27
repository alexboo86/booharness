// The routing map's glob matcher, kept free of imports: the edit and read hook
// (ops/bootstrap/domain-lessons-hook.mjs) resolves a domain on every lead Read,
// so the matcher must load without the memory store client or any other heavy
// import — its whole cost is the hook's fast exit.

/** Glob → anchored regex. Same semantics as check-domain-routing.mjs. */
export function globToRegExp(glob) {
  return new RegExp(`^${glob
    .replace(/\./g, '\\.')
    .replace(/\*\*\/?/g, 'DBLSTAR')
    .replace(/\*/g, '[^/]*')
    .replace(/DBLSTAR/g, '.*')
    .replace(/\?/g, '.')}$`);
}

/**
 * The domain that owns a repo-relative path, or null when none does.
 * `order` is sorted by specificity, so the first hit wins and the catch-all loses.
 * @param {string} filePath
 * @param {{ order: Array<{ glob: string, domain: string }> }} map
 */
export function domainOf(filePath, map) {
  for (const entry of map.order) {
    if (globToRegExp(entry.glob).test(filePath)) return entry.domain;
  }
  return null;
}
