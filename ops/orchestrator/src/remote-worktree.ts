// Transport a remote seat's dirty checkout without committing or changing its index.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnProvider } from './providers/spawn.ts';
import { assertCheckoutIdentity, assertCheckoutIndex, checkoutArgs, collect, hash, text, transferRef } from './remote-repo.ts';
import { ROLE_POLICY, landable } from './seats-defs.ts';
type Location = { host?: string; dir: string };

async function command(location: Location, args: string[], options: { env?: Record<string, string>; input?: Buffer; program?: string; signal?: AbortSignal } = {}): Promise<Buffer> {
  if (options.signal?.aborted) throw options.signal.reason;
  const program = options.program ?? 'git';
  const child = spawnProvider({ host: location.host, cwd: location.dir, command: program, args, env: options.env });
  const abort = () => child.kill('SIGKILL');
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    return await collect(child, options.input, `${location.host ?? 'local'} ${program} ${args.join(' ')}`, Boolean(location.host));
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
const git = (location: Location, ...args: string[]) => command(location, args).then(text);

const pinSeat = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
/**
 * The local ref that pins a seat's imported snapshot commit (task 1842): unbundle
 * leaves the tip dangling, so without the pin a later failure (a mirror reset dying
 * on a stale index.lock) keeps the only local copy one gc from loss. removeMirror
 * deletes the pin with a proved-landed mirror; aged unlanded removal keeps it.
 */
export const snapshotPinRef = (seat: string): string => {
  if (!pinSeat.test(seat)) throw new Error(`invalid snapshot pin seat: ${seat}`);
  return `refs/orch/snapshots/${seat}`;
};

/** True while the local repo still holds an imported snapshot commit (task 1842). */
export async function snapshotAvailable(localRepo: string, snapshot: string): Promise<boolean> {
  if (!hash.test(snapshot)) return false;
  try { await git({ dir: localRepo }, 'cat-file', '-e', `${snapshot}^{commit}`); return true; }
  catch { return false; }
}
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const MAX_REFUSED = 64;

function pathsMatching(message: string, pattern: RegExp): string[] {
  return [...message.matchAll(pattern)].map((match) => match[1]).filter((file) => file.length > 0);
}

/** Paths named by a failed `git add`, in the forms this host's git actually prints. */
function refusedCandidates(message: string): string[] {
  return [...new Set([
    ...pathsMatching(message, /invalid path '([^']*)'/gi),
    ...pathsMatching(message, /unable to index file '([^']*)'/g),
    ...pathsMatching(message, /open\("([^"]*)"\)/g),
    ...pathsMatching(message, /short read while indexing (\S+)/g),
  ])];
}

function excludable(file: string): boolean {
  return file !== '.' && file !== '..' && !file.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(file) && !/[\0\r\n\\]/.test(file);
}

type GitRun = (location: Location, args: string[], options?: { env?: Record<string, string> }) => Promise<Buffer>;

async function pathRefusedByGit(run: GitRun, source: Location, file: string, probeIndex: string, signal: AbortSignal | undefined): Promise<boolean> {
  try {
    await run(source, ['update-index', '--add', '--cacheinfo', `100644,${EMPTY_BLOB},${file}`], { env: { GIT_INDEX_FILE: probeIndex } });
    return false;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return /invalid path '/i.test((error as Error).message);
  }
}

/**
 * Stage the worktree the way `git add -A -- .` does. When that add fails, leave out only
 * paths git itself refuses as an invalid path, and name them. A different add failure is
 * rethrown, and the first attempt is always the plain add so a clean tree is unchanged
 * (task 2381).
 */
async function addAcceptedPaths(run: GitRun, source: Location, env: Record<string, string>, signal: AbortSignal | undefined, probeIndex: string, markProbed: () => void): Promise<string[]> {
  const skipped: string[] = [];
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    const args = ['add', '-A', '--', '.', ...skipped.map((file) => `:(exclude,literal)${file}`)];
    try {
      await run(source, args, { env });
      return skipped;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const message = (error as Error).message ?? '';
      const named = new Set(pathsMatching(message, /invalid path '([^']*)'/gi));
      const fresh: string[] = [];
      for (const file of refusedCandidates(message)) {
        if (skipped.includes(file) || fresh.includes(file) || !excludable(file)) continue;
        if (named.has(file)) { fresh.push(file); continue; }
        markProbed();
        if (await pathRefusedByGit(run, source, file, probeIndex, signal)) fresh.push(file);
      }
      if (!fresh.length || skipped.length + fresh.length > MAX_REFUSED) throw error;
      skipped.push(...fresh);
      await run(source, ['read-tree', 'HEAD'], { env });
    }
  }
}

/** Host may be omitted for a local checkout (also used by the isolated transport tests). */
export async function snapshotBack(host: string | undefined, dir: string, localRepo: string, base: string, onBundle?: (bytes: number) => void, signal?: AbortSignal, pin?: string): Promise<{ head: string; snapshot: string; invalidPaths: string[] }> {
  if (!hash.test(base)) throw new Error(`invalid prerequisite ${base}`);
  const git = (location: Location, ...args: string[]) => command(location, args, { signal }).then(text);
  const run = (location: Location, args: string[], options: { env?: Record<string, string>; input?: Buffer; program?: string } = {}) => command(location, args, { ...options, signal });
  const source: Location = { host, dir };
  const target: Location = { dir: localRepo };
  const head = await git(source, 'rev-parse', 'HEAD');
  if (!hash.test(head)) throw new Error(`invalid remote HEAD ${head}`);
  await git(source, 'merge-base', '--is-ancestor', base, head);
  const headTree = await git(source, 'rev-parse', `${head}^{tree}`);
  assertCheckoutIndex(await git(source, 'ls-files', '-t', '-z'),
    await git(source, 'config', '--bool', '--default=false', '--get', 'core.sparseCheckout'));
  // A linked worktree has its own gitdir and index. Keep the temporary index there,
  // not in the shared object directory, and remove it even if bundle import fails.
  const gitDir = await git(source, 'rev-parse', '--absolute-git-dir');
  const index = `${gitDir.replace(/[\\/]$/, '')}/orch-snapshot-${randomUUID()}.index`;
  const probeIndex = `${gitDir.replace(/[\\/]$/, '')}/orch-snapshot-${randomUUID()}.probe`;
  let probed = false;
  const ref = transferRef('snapshot');
  const env = { GIT_INDEX_FILE: index };
  let refCreated = false;
  try {
    await run(source, ['read-tree', 'HEAD'], { env });
    const invalidPaths = await addAcceptedPaths(run, source, env, signal, probeIndex, () => { probed = true; });
    const tree = text(await run(source, ['write-tree'], { env }));
    const snapshot = await git(source, 'commit-tree', tree, '-p', head, '-m', 'orch worktree snapshot');
    await git(source, 'update-ref', ref, snapshot);
    refCreated = true;
    const bundle = await run(source, ['bundle', 'create', '-', ref, `^${base}`]);
    // unbundle reads the entire pack before exiting; collect keeps SSH stdin open
    // until then and handles EPIPE if the peer dies during a large write.
    const listed = text(await run(target, ['bundle', 'unbundle', '-'], { input: bundle }));
    if (!listed.split('\n').includes(`${snapshot} ${ref}`)) throw new Error(`snapshot bundle tip mismatch: ${listed}`);
    // Pin the imported tip before anything resets the mirror: unpinned, a failure
    // after this point leaves the only local copy dangling for gc (task 1842).
    if (pin !== undefined) await run(target, ['update-ref', snapshotPinRef(pin), snapshot]);
    const importedHead = await git(target, 'rev-parse', `${snapshot}^`);
    const importedHeadTree = await git(target, 'rev-parse', `${importedHead}^{tree}`);
    assertCheckoutIdentity({ sha: head, tree: headTree }, { sha: importedHead, tree: importedHeadTree, status: '' });
    const importedTree = await git(target, 'rev-parse', `${snapshot}^{tree}`);
    assertCheckoutIdentity({ sha: snapshot, tree }, { sha: snapshot, tree: importedTree, status: '' });
    onBundle?.(bundle.length);
    return { head, snapshot, invalidPaths };
  } finally {
    // Share the caller's remaining deadline. If it expired, leave this UUID ref
    // and temporary index behind; later snapshots use new names.
    try { if (refCreated) await command(source, ['update-ref', '-d', ref], { signal }); }
    finally {
      for (const file of probed ? [index, probeIndex] : [index]) {
        try {
          // recursive enables retries for Windows EPERM/EBUSY on files too.
          // Use async rm: native rmSync does not retry a held file on Node 26.
          // These UUID paths belong to this checkout's private gitdir.
          await command(source, ['-e', 'require("node:fs").rm(process.argv[1],{force:true,recursive:true,maxRetries:3,retryDelay:100},error=>{if(error){console.error(error);process.exitCode=1}})', file], { program: 'node', signal });
        } catch (error) {
          // eslint-disable-next-line no-unsafe-finally -- a caller abort must reject even after a pinned import (task 3048)
          if (signal?.aborted) throw signal.reason;
          // An imported/pinned snapshot must survive disposable-index cleanup
          // failure; on failure before import, preserve the original error too.
          console.warn(`snapshot temporary index cleanup failed; left ${file} with checkout: ${(error as Error).message}`);
        }
      }
    }
  }
}

/** Only git-registered worktrees are candidates; the caller checks each exact seat path. */
export async function listRemoteCheckouts(host: string, repo: string, timeoutMs = 5000): Promise<string[]> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      command({ host, dir: repo }, ['worktree', 'list', '--porcelain', '-z'], { signal: abort.signal }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        abort.abort(new Error(`remote checkout listing timed out after ${timeoutMs}ms`));
        reject(abort.signal.reason);
      }, timeoutMs); }),
    ]);
    return output.toString('utf8').split('\0').filter(field => field.startsWith('worktree ')).map(field => field.slice(9));
  } finally { clearTimeout(timer); }
}

/** A registered worktree can be prunable after its directory disappears; check the host filesystem too. */
export async function hostCheckoutExists(host: string, repo: string, dir: string, timeoutMs = 5000): Promise<boolean> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      command({ host, dir: repo }, ['-e', 'const fs = require("node:fs"); try { process.stdout.write(String(fs.statSync(process.argv[1]).isDirectory())); } catch (e) { if (e.code !== "ENOENT") throw e; process.stdout.write("false"); }', dir], { program: 'node', signal: abort.signal }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        abort.abort(new Error(`remote checkout stat timed out after ${timeoutMs}ms`));
        reject(abort.signal.reason);
      }, timeoutMs); }),
    ]);
    return text(output) === 'true';
  } finally { clearTimeout(timer); }
}

/** A mirror is exactly one child of the state directory's mirrors folder, never an arbitrary checkout. */
export function assertMirrorPath(stateDir: string, mirrorDir: string): void {
  const root = path.join(path.resolve(stateDir), 'mirrors');
  const owned = new RegExp(`^(?:${Object.keys(ROLE_POLICY).filter((role) => landable(role)).join('|')})-[A-Za-z0-9-]+$`);
  if (!path.isAbsolute(mirrorDir) || path.dirname(mirrorDir) !== root || !owned.test(path.basename(mirrorDir))) {
    throw new Error(`mirror path outside ${root}: ${mirrorDir}`);
  }
  if (existsSync(root) && realpathSync(root) !== path.join(realpathSync(stateDir), 'mirrors')) throw new Error(`mirror root is not owned: ${root}`);
  if (existsSync(mirrorDir) && realpathSync(mirrorDir) !== path.join(realpathSync(stateDir), 'mirrors', path.basename(mirrorDir))) throw new Error(`mirror path is a symlink: ${mirrorDir}`);
}

/** Only an orch-owned detached worktree may be reused; its previous contents are replaced. */
export async function syncMirror(localRepo: string, mirrorDir: string, head: string, snapshot: string, stateDir: string, signal?: AbortSignal): Promise<void> {
  assertMirrorPath(stateDir, mirrorDir);
  const git = (location: Location, ...args: string[]) => command(location, args, { signal }).then(text);
  if (!hash.test(head) || !hash.test(snapshot)) throw new Error('invalid mirror commit');
  const repo: Location = { dir: localRepo };
  const mirror: Location = { dir: mirrorDir };
  if (snapshot !== head) {
    const parent = await git(repo, 'rev-parse', `${snapshot}^`);
    if (parent !== head) throw new Error(`snapshot parent ${parent} differs from seat HEAD ${head}`);
  }
  await git(repo, 'cat-file', '-e', `${head}^{commit}`);
  await git(repo, 'cat-file', '-e', `${snapshot}^{commit}`);
  const mainCommon = realpathSync(await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const owner = `${realpathSync(localRepo)}\n${path.resolve(mirrorDir)}\n`;
  if (!existsSync(mirrorDir)) {
    mkdirSync(path.dirname(mirrorDir), { recursive: true });
    assertMirrorPath(stateDir, mirrorDir);
    await git(repo, ...checkoutArgs(mirrorDir, head));
    const metadata = await git(mirror, 'rev-parse', '--path-format=absolute', '--git-dir');
    writeFileSync(path.join(metadata, 'orch-mirror-owner'), owner, { flag: 'wx' });
  } else {
    const mirrorCommon = await git(mirror, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const metadata = await git(mirror, 'rev-parse', '--path-format=absolute', '--git-dir');
    if (mainCommon !== realpathSync(mirrorCommon) || realpathSync(await git(mirror, 'rev-parse', '--show-toplevel')) !== realpathSync(mirrorDir) ||
        await git(mirror, 'symbolic-ref', '-q', 'HEAD').then(() => true, () => false) ||
        !existsSync(path.join(metadata, 'orch-mirror-owner')) || readFileSync(path.join(metadata, 'orch-mirror-owner'), 'utf8') !== owner) {
      throw new Error(`not an owned detached mirror worktree: ${mirrorDir}`);
    }
    assertCheckoutIndex(await git(mirror, 'ls-files', '-t', '-z'), await git(mirror, 'config', '--bool', '--default=false', '--get', 'core.sparseCheckout'));
    await git(mirror, 'reset', '--hard', head);
    await git(mirror, 'clean', '-ffdx');
  }
  // Diff against the snapshot commit rather than checking it out: its additions
  // remain untracked and all other changes remain unstaged in the mirror.
  const patch = snapshot === head ? Buffer.alloc(0) : await command(repo, ['diff', '--binary', head, snapshot, '--'], { signal });
  if (patch.length) await command(mirror, ['apply', '--binary', '-'], { input: patch, signal });
  const mirrorHead = await git(mirror, 'rev-parse', 'HEAD');
  const mirrorTree = await git(mirror, 'rev-parse', 'HEAD^{tree}');
  const headTree = await git(repo, 'rev-parse', `${head}^{tree}`);
  assertCheckoutIdentity({ sha: head, tree: headTree }, { sha: mirrorHead, tree: mirrorTree, status: '' });
}

/**
 * A local mirror's whole working state, read through a temporary index so the
 * mirror's own index never changes: HEAD, the tree of every non-ignored file,
 * and the ignored entries no tree holds (task 1704d).
 */
export async function mirrorState(mirrorDir: string): Promise<{ head: string; tree: string; ignored: string[]; fingerprint: string }> {
  const mirror: Location = { dir: mirrorDir };
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orch-mirror-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
    const head = await git(mirror, 'rev-parse', 'HEAD');
    await command(mirror, ['read-tree', 'HEAD'], { env });
    await command(mirror, ['add', '-A'], { env });
    const tree = text(await command(mirror, ['write-tree'], { env }));
    const ignored = (await command(mirror, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).toString('utf8').split('\0').filter(Boolean);
    return { head, tree, ignored, fingerprint: [head, tree, ...ignored].join('\0') };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export const MIRROR_CHANGED = 'mirror changed since inspection; kept';

/** An unrecorded mirror has no seat row to supply its repo; the gitdir owner marker does. */
export async function removeOrphanMirror(mirrorDir: string, stateDir: string): Promise<void> {
  assertMirrorPath(stateDir, mirrorDir);
  const metadata = await git({ dir: mirrorDir }, 'rev-parse', '--path-format=absolute', '--git-dir');
  const owner = readFileSync(path.join(metadata, 'orch-mirror-owner'), 'utf8').split('\n');
  if (owner.length !== 3 || owner[1] !== mirrorDir || owner[2] !== '' || !path.isAbsolute(owner[0])) {
    throw new Error(`invalid mirror owner: ${mirrorDir}`);
  }
  await removeMirror(owner[0], mirrorDir, stateDir);
}

/**
 * Rollback only an owned mirror; never remove a checkout outside the state directory.
 * A mirror with changes goes only with `expected`, the mirrorState fingerprint prune
 * proved landed or backed up; it is recomputed before removal. Aged removal
 * keeps the snapshot pin and verifies archived bytes in beforeRemove. ownerRepo
 * is the recorded provisioning repo when localRepo was resolved after its loss;
 * the common directory must still match, and the owner marker must match exactly.
 */
export async function removeMirror(localRepo: string, mirrorDir: string, stateDir: string, options: {
  expected?: string; keepSnapshot?: boolean; ownerRepo?: string; beforeRemove?: () => Promise<void>;
} = {}): Promise<void> {
  assertMirrorPath(stateDir, mirrorDir);
  if (!existsSync(mirrorDir)) return;
  const repo: Location = { dir: localRepo }, mirror: Location = { dir: mirrorDir };
  const common = realpathSync(await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const mirrorCommon = realpathSync(await git(mirror, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const metadata = await git(mirror, 'rev-parse', '--path-format=absolute', '--git-dir');
  const recorded = options.ownerRepo ?? localRepo;
  const ownerRepo = existsSync(recorded) ? realpathSync(recorded) : path.resolve(recorded);
  if (common !== mirrorCommon || realpathSync(await git(mirror, 'rev-parse', '--show-toplevel')) !== realpathSync(mirrorDir) ||
      await git(mirror, 'symbolic-ref', '-q', 'HEAD').then(() => true, () => false) ||
      (options.expected === undefined && await git(mirror, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all') !== '') ||
      !existsSync(path.join(metadata, 'orch-mirror-owner')) ||
      readFileSync(path.join(metadata, 'orch-mirror-owner'), 'utf8') !== `${ownerRepo}\n${mirrorDir}\n`) {
    throw new Error(`not an owned detached mirror worktree: ${mirrorDir}`);
  }
  if (options.expected !== undefined && (await mirrorState(mirrorDir)).fingerprint !== options.expected) throw new Error(`${MIRROR_CHANGED}: ${mirrorDir}`);
  // The snapshot pin only ever backed up this mirror's bytes, proved landed before
  // removal; it goes first, so a failed ref delete keeps the mirror and a retry
  // removes both, while a mirror that vanished outside orch keeps its pin (task 1842).
  // A missing ref deletes cleanly.
  if (!options.keepSnapshot) await git(repo, 'update-ref', '-d', snapshotPinRef(path.basename(mirrorDir)));
  await options.beforeRemove?.();
  await git(repo, 'worktree', 'remove', '--force', mirrorDir);
}
