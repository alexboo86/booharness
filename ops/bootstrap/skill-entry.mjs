// How the installer decides a skill path is its own link, and the key it uses
// for skills.off. adopt-project imports these; a second copy would drift.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

// A Windows skill directory is case-insensitive. Other platforms are not.
export function skillKey(name) {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

// A symlink whose real target is a skill directory of this canon is the harness's
// link, including a link made through another path to that directory. A file, a
// directory, a link outside the canon, or an entry that cannot be read is not.
// A dangling target is the real path of its parent plus its last name. When that
// parent is missing too, or the path cannot be resolved, both sides stay
// unresolved, which is how the installer treated the link before this move.
export function inspectSkillEntry(dest, canon) {
  let entry;
  try {
    // lstat sees dangling symlinks AND Windows junctions without following
    // their targets. existsSync alone cannot distinguish them from no entry.
    entry = lstatSync(dest);
  } catch (error) {
    return error.code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unknown', reason: error.message };
  }
  if (!entry.isSymbolicLink()) return { kind: 'real' };
  try {
    let target = readlinkSync(dest);
    // Windows junction readlink may return a namespaced absolute path. Strip
    // only the namespace, preserving UNC roots; relative Unix links resolve
    // against the link's directory, never the installer's working directory.
    if (process.platform === 'win32') {
      target = target.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
    }
    target = path.resolve(path.dirname(dest), target);
    const judged = resolvedSkillDir(canon, target);
    return path.relative(judged.canonDir, path.dirname(judged.skillDir)) === ''
      ? { kind: 'managed', target, skill: path.basename(judged.skillDir) }
      : { kind: 'foreign', target, reason: 'target is outside this checkout canonical skills directory' };
  } catch (error) {
    return { kind: 'unknown', reason: error.message };
  }
}

function resolvedSkillDir(canon, target) {
  const unresolved = () => ({ canonDir: canon, skillDir: target });
  let canonDir;
  try {
    canonDir = realpathSync(canon);
  } catch {
    return unresolved();
  }
  try {
    return { canonDir, skillDir: realpathSync(target) };
  } catch (error) {
    if (error.code !== 'ENOENT') return unresolved();
  }
  try {
    return { canonDir, skillDir: path.join(realpathSync(path.dirname(target)), path.basename(target)) };
  } catch {
    return unresolved();
  }
}
