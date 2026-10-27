// Git object transport for a remote orch checkout.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readHost, type RemoteHost } from './config.ts';
import { refuseHostSsh, spawnProvider } from './providers/spawn.ts';
import type { Logger } from './log.ts';
import { createKeyedQueue } from './keyed-queue.ts';
import { collect, text } from './shared.entry.ts';
export { collect, text } from './shared.entry.ts';

export const hash = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const name = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Stream a lead check using exactly the managed seat transport (jobwrap on win32). */
export async function runCheckCommand(host: string | undefined, cwd: string, command: string[], stdout: NodeJS.WritableStream = process.stdout, stderr: NodeJS.WritableStream = process.stderr): Promise<number> {
  if (!command[0]) throw new Error('check-on needs a command');
  const child = spawnProvider({ host, cwd, command: command[0], args: command.slice(1) });
  child.stdout.pipe(stdout, { end: false });
  child.stderr.pipe(stderr, { end: false });
  child.stdin.on('error', () => {});
  if (host === undefined) child.stdin.end();
  const interrupt = () => { child.kill('SIGINT'); };
  const terminate = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

export const transferRef = (kind: 'transfer' | 'snapshot' = 'transfer') => `refs/orch-${kind}/${randomUUID()}`;

export function checkoutArgs(dir: string, sha: string): string[] {
  if (!hash.test(sha)) throw new Error(`invalid commit hash ${sha}`);
  if (!path.isAbsolute(dir) && !path.win32.isAbsolute(dir)) throw new Error(`checkout path must be absolute: ${dir}`);
  return ['worktree', 'add', '--detach', dir, sha];
}

export function assertCheckoutIdentity(expected: { sha: string; tree: string }, actual: { sha: string; tree: string; status: string }): void {
  if (expected.sha !== actual.sha || expected.tree !== actual.tree || actual.status !== '') {
    throw new Error(`remote checkout mismatch: local sha=${expected.sha} tree=${expected.tree}; remote sha=${actual.sha} tree=${actual.tree} status=${JSON.stringify(actual.status)}`);
  }
}

function run(command: string, args: string[], cwd: string, input?: Buffer, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  // A deleted cwd makes spawn report the binary as missing (spawn git ENOENT).
  if (!existsSync(cwd)) return Promise.reject(new Error(`git cwd missing: ${cwd}`));
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  return collect(child, input, `${command} ${args.join(' ')}`)
    .finally(() => signal?.removeEventListener('abort', abort));
}

/** Host omitted runs git here (the isolated tests); an aborted signal kills the command. */
function remote(host: string | undefined, cwd: string, args: string[], input?: Buffer, signal?: AbortSignal, finiteInput = false): Promise<Buffer> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  // SSH stdin EOF means disconnect to remote-exec. A finite-input Git reader
  // needs EOF on its own pipe instead, after exactly the supplied bytes.
  const finiteGit = `
    const { spawn } = require('node:child_process');
    const child = spawn('git', process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] });
    let remaining = Number(process.argv[1]);
    const fail = error => { console.error(error.message); process.exit(1); };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', code => process.exit(code ?? 1));
    process.stdin.on('data', chunk => {
      remaining -= chunk.length;
      if (remaining === 0) { child.stdin.end(chunk); process.stdin.pause(); }
      else child.stdin.write(chunk);
    });
  `;
  const child = finiteInput && input?.length
    ? spawnProvider({ host, command: 'node', cwd, args: ['-e', finiteGit, String(input.length), ...args] })
    : spawnProvider({ host, command: 'git', cwd, args });
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  return collect(child, input, `${host ? 'remote' : 'local'} git ${args.join(' ')}`, Boolean(host))
    .finally(() => signal?.removeEventListener('abort', abort));
}
const local = (repo: string, ...args: string[]) => run('git', args, repo).then(text);
const onHost = (host: string | undefined, repo: string, ...args: string[]) => remote(host, repo, args).then(text);
const bounded = (host: string | undefined, dir: string, signal: AbortSignal | undefined) => (...args: string[]) => remote(host, dir, args, undefined, signal).then(text);

function hostConfig(host: string): RemoteHost { return readHost(host); }

const hostQueue = createKeyedQueue();

/**
 * Run `work` alone against one host's clone. Git takes a lock per ref, so two parallel
 * `fetch --prune` there fail with "cannot lock ref" (task 1744a); fetch, unbundle and
 * worktree add/remove on one host therefore take turns, while different hosts never wait
 * for each other. A queued waiter honors its signal: abort rejects it at once, and its
 * turn passes to the next waiter only after the operation ahead of it settles. A failed or
 * aborted operation releases its turn. Not reentrant: `work` must not call it for the same host.
 */
export async function withHostClone<T>(host: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return hostQueue(host, work, signal);
}

export function refName(host: string, branch: string): string {
  if (!name.test(host) || !branch.split('/').every(part => name.test(part) && part !== '.' && !part.includes('..') && !part.endsWith('.') && !part.endsWith('.lock'))) throw new Error('invalid remote ref name');
  return `refs/remotes/${host}/${branch}`;
}

/** The sole command allowed before remote-exec exists in the new checkout. */
export function cloneSshArgs(host: RemoteHost, origin: string): string[] {
  // ssh joins remote argv into a shell command. Only shell-literal URL bytes are
  // admitted; never pass an arbitrary git-config string to the remote shell.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@:/~+-]*$/.test(origin)) throw new Error('origin URL contains unsupported remote-shell characters');
  // readHosts rejects double quotes, %, ^, &, |, <, > and ! (and newlines)
  // from repo, so cmd.exe cannot expand or break out of this quoted path.
  const repo = host.platform === 'win32' ? `"${host.repo}"` : `'${host.repo.replaceAll("'", "'\\''")}'`;
  return ['-T', '-o', 'BatchMode=yes', host.ssh, 'git', 'clone', origin, repo];
}

export function ensureClone(host: string, localRepo: string): Promise<void> {
  return withHostClone(host, () => cloneReady(host, localRepo));
}

/** The top of the repo containing `dir` — the daemon's own checkout. */
export function repoTop(dir: string): Promise<string> { return local(dir, 'rev-parse', '--show-toplevel'); }

/** Checkout and commit the running daemon was started from. Resolved once at serve start. */
export async function daemonCheckout(dir: string): Promise<{ repo: string; sha: string }> {
  const repo = await repoTop(dir);
  const sha = await local(repo, 'rev-parse', 'HEAD');
  if (!hash.test(sha)) throw new Error(`invalid daemon commit ${sha}`);
  return { repo, sha };
}

async function cloneReady(host: string, localRepo: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  const remoteHost = hostConfig(host);
  const { repo, platform } = remoteHost;
  // A missing checkout cannot run remote-exec (its path is INSIDE host.repo).
  let exists = true;
  try { await remote(host, repo, ['rev-parse', '--show-toplevel'], undefined, signal); }
  catch {
    if (signal?.aborted) throw signal.reason;
    exists = false;
  }
  // Config is written only when the clone is created. An existing checkout, including
  // one already on the daemon commit, is left untouched (task 1784).
  if (exists) return;
  const origin = await run('git', ['remote', 'get-url', 'origin'], localRepo, undefined, signal).then(text);
  if (signal?.aborted) throw signal.reason;
  refuseHostSsh(remoteHost.ssh);
  const child = spawn('ssh', cloneSshArgs(remoteHost, origin), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await collect(child, undefined, 'ssh git clone');
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  if (signal?.aborted) throw signal.reason;
  await remote(host, repo, ['config', '--local', 'core.autocrlf', 'false'], undefined, signal);
  if (platform === 'win32') await remote(host, repo, ['config', '--local', 'core.longpaths', 'true'], undefined, signal);
}

export function syncAll(host: string, signal?: AbortSignal): Promise<void> {
  return withHostClone(host, () => fetchAll(host, hostConfig(host).repo, signal), signal);
}

async function fetchAll(host: string | undefined, repo: string, signal?: AbortSignal): Promise<void> {
  await remote(host, repo, ['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], undefined, signal);
}

/** Create a bundle for an arbitrary commit (including an unreferenced snapshot) without moving the lead's branch. */
async function bundleCommit(localRepo: string, sha: string, prerequisites: string[], signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw signal.reason;
  const ref = transferRef();
  await run('git', ['update-ref', ref, sha], localRepo, undefined, signal).then(text);
  try {
    const revisions = Buffer.from(prerequisites.map(commit => `^${commit}\n`).join(''));
    return await run('git', ['bundle', 'create', '-', ref, '--stdin'], localRepo, revisions, signal);
  }
  finally {
    // Share the caller's remaining deadline. If it expired, leave this UUID ref
    // behind rather than extending the host turn; later transfers use new refs.
    await run('git', ['update-ref', '-d', ref], localRepo, undefined, signal).then(text);
  }
}

/** Make a local commit, an unreferenced snapshot included, present in the host's repo. The caller holds the host's turn. */
async function transferCommit(host: string | undefined, repo: string, localRepo: string, sha: string, signal?: AbortSignal, fetchOrigin = true): Promise<void> {
  const git = bounded(host, repo, signal);
  if (fetchOrigin) {
    await fetchAll(host, repo, signal);
    try { await git('cat-file', '-e', `${sha}^{commit}`); return; }
    catch { if (signal?.aborted) throw signal.reason; }
  }
  // Snapshot parents usually exist on the host. Origin tips also bound the
  // bundle when unpublished local commits sit between origin and the snapshot.
  // Local refs alone prove nothing: only exclude commits confirmed by the host.
  const parents = text(await run('git', ['rev-list', '--parents', '-n', '1', sha], localRepo, undefined, signal)).split(/\s+/).slice(1);
  const origin = text(await run('git', ['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin/'], localRepo, undefined, signal)).split(/\s+/);
  const candidates = new Set([...parents, ...origin].filter(candidate => hash.test(candidate)));
  const prerequisites: string[] = [];
  if (candidates.size || !fetchOrigin) {
    // Lead checks transfer their exact supplied snapshot, not origin's latest
    // branch. Probe it and all usable prerequisites in a single round trip.
    const input = Buffer.from([...(!fetchOrigin ? [sha] : []), ...candidates].join('\n') + '\n');
    const present = text(await remote(host, repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], input, signal, true));
    for (const line of present.split(/\r?\n/)) {
      const [candidate, type] = line.split(' ');
      if (!fetchOrigin && candidate === sha && type === 'commit') return;
      if (type === 'commit' && candidates.has(candidate)) prerequisites.push(candidate);
    }
  }
  // No shared commit means the existing complete-history bundle is necessary.
  const bundle = await bundleCommit(localRepo, sha, prerequisites, signal);
  await remote(host, repo, ['bundle', 'unbundle', '-'], bundle, signal);
  // Lead preparation immediately resets and verifies HEAD/tree/index itself.
  if (fetchOrigin) await git('cat-file', '-e', `${sha}^{commit}`);
}

/**
 * A host runtime move is bounded like a seat checkout move: a hung ssh fails the sync
 * instead of holding the host's turn chain and every later remote create on it.
 */
export const HOST_RUNTIME_TIMEOUT_MS = 120_000;

// Several minute-scale checkout provisions can precede an operation on one host.
// Allow a ten-minute queue wait without spending the operation's own work deadline.
const HOST_RUNTIME_WAIT_TIMEOUT_MS = 600_000;
const HOST_RUNTIME_HOOKS_TIMEOUT_MS = 15_000;

/** Checkout-local maintenance has a fresh deadline and never refuses a verified move. */
async function refreshRuntimeHooks(host: string, repo: string, log?: Logger): Promise<void> {
  const signal = AbortSignal.timeout(HOST_RUNTIME_HOOKS_TIMEOUT_MS);
  let abort: (() => void) | undefined;
  try {
    const child = spawnProvider({ host, command: 'node', cwd: repo,
      args: ['ops/bootstrap/install-git-hooks.mjs', repo] });
    const expired = new Promise<never>((_, reject) => {
      abort = () => {
        child.kill('SIGKILL');
        reject(new Error(`host '${host}' git hook refresh timed out after ${HOST_RUNTIME_HOOKS_TIMEOUT_MS}ms`));
      };
      signal.addEventListener('abort', abort, { once: true });
    });
    await Promise.race([collect(child, undefined, 'remote git hook refresh', true), expired]);
  } catch (error) {
    log?.('warn', 'daemon.host_runtime_hooks_failed', { host, message: (error as Error).message });
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

export type HostRuntimeState = {
  host: string; target: string; head: string | null;
  current: boolean; moved: boolean; error: string | null; at: string;
};
/** The last runtime-checkout sync per host, surfaced by /health and orch_status (task 1784). */
const hostRuntime = new Map<string, HostRuntimeState>();
export function hostRuntimeStates(): HostRuntimeState[] { return [...hostRuntime.values()]; }

/**
 * Move a host's runtime checkout — the hosts.json repo every remote seat's remote-exec and
 * build gate run from — to the commit this daemon runs from (task 1784). `options.sha` is that
 * commit when serve already resolved it; otherwise HEAD of `localRepo` (the bundle source).
 * A checkout already on the commit is left untouched, including its config; one with uncommitted
 * TRACKED changes is refused and nothing in it changes (they are never discarded); untracked files
 * always stay. Every git and ssh call of the sync honors `timeoutMs`, starting once it holds
 * the host's turn. Waiting for that turn has a separate ten-minute bound. Serialized with
 * the host's other git operations through withHostClone. After a verified remote move,
 * git hook shims are refreshed under a separate short deadline; failure only logs a warning.
 * Host omitted: a local checkout
 * (the isolated tests), which needs options.repo and must already exist.
 */
export async function syncHostRuntime(host: string | undefined, localRepo: string, options: { repo?: string; timeoutMs?: number; sha?: string; log?: Logger } = {}): Promise<{ moved: boolean; from: string; to: string }> {
  if (host === undefined && options.repo === undefined) throw new Error('syncHostRuntime without a host needs options.repo');
  if (options.sha !== undefined && !hash.test(options.sha)) throw new Error(`invalid commit hash ${options.sha}`);
  const repo = options.repo ?? hostConfig(host as string).repo;
  const name = host ?? 'local';
  const timeoutMs = options.timeoutMs ?? HOST_RUNTIME_TIMEOUT_MS;
  const waitSignal = AbortSignal.timeout(HOST_RUNTIME_WAIT_TIMEOUT_MS);
  let workSignal: AbortSignal | undefined;
  let sha = options.sha ?? '';
  try {
    const result = await withHostClone(name, async () => {
      const signal = workSignal = AbortSignal.timeout(timeoutMs);
      if (sha === '') sha = await run('git', ['rev-parse', 'HEAD'], localRepo, undefined, signal).then(text);
      if (!hash.test(sha)) throw new Error(`invalid commit hash ${sha}`);
      const tree = await run('git', ['rev-parse', '--verify', `${sha}^{tree}`], localRepo, undefined, signal).then(text);
      if (host !== undefined) await cloneReady(host, localRepo, signal);
      const git = bounded(host, repo, signal);
      const head = await git('rev-parse', 'HEAD');
      if (head === sha) return { moved: false, from: head, to: sha };
      // Only uncommitted TRACKED changes refuse the move; they are never discarded.
      const dirty = await git('--no-optional-locks', 'status', '--porcelain', '--untracked-files=no');
      if (dirty !== '') throw new Error(`host '${name}' runtime checkout ${repo} has uncommitted tracked changes; refusing to move it to ${sha}: ${dirty.split('\n').slice(0, 3).join('; ')}`);
      await transferCommit(host, repo, localRepo, sha, signal);
      // A clean tracked tree makes checkout --detach keep every untracked file.
      await git('checkout', '--detach', sha);
      assertCheckoutIdentity({ sha, tree }, {
        sha: await git('rev-parse', 'HEAD'),
        tree: await git('rev-parse', 'HEAD^{tree}'),
        status: await git('--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'),
      });
      if (host !== undefined) await refreshRuntimeHooks(host, repo, options.log);
      return { moved: true, from: head, to: sha };
    }, waitSignal);
    hostRuntime.set(name, { host: name, target: sha, head: result.to, current: true, moved: result.moved, error: null, at: new Date().toISOString() });
    return result;
  } catch (error) {
    const failure = workSignal?.aborted
      ? new Error(`host '${name}' runtime checkout move timed out after ${timeoutMs}ms`)
      : !workSignal && waitSignal.aborted
        ? new Error(`host '${name}' busy host queue wait timed out after ${HOST_RUNTIME_WAIT_TIMEOUT_MS}ms`)
        : error as Error;
    hostRuntime.set(name, { host: name, target: sha, head: null, current: false, moved: false, error: failure.message, at: new Date().toISOString() });
    throw failure;
  }
}

export async function prepareCheckout(host: string, { sha, localRepo }: { sha: string; localRepo: string }, dir: string): Promise<void> {
  const { repo, platform } = hostConfig(host);
  const args = checkoutArgs(dir, sha);
  const tree = await local(localRepo, 'rev-parse', '--verify', `${sha}^{tree}`);
  // One turn from clone to verified checkout: no other fetch or worktree change lands in between.
  await withHostClone(host, () => addCheckout(host, repo, platform, { sha, tree, localRepo }, args, dir));
}

async function addCheckout(host: string | undefined, repo: string, platform: RemoteHost['platform'], { sha, tree, localRepo }: { sha: string; tree: string; localRepo: string }, args: string[], dir: string): Promise<void> {
  if (host !== undefined) await cloneReady(host, localRepo);
  await transferCommit(host, repo, localRepo, sha);
  // A failed `worktree add` can leave a registered checkout behind. Refuse an
  // existing path up front; only a new, registered, clean checkout is ours to undo.
  const existed = text(await collect(spawnProvider({ host, cwd: repo, command: 'node',
    args: ['-e', 'process.stdout.write(String(require("node:fs").existsSync(process.argv[1])))', dir] }), undefined, 'remote checkout preflight', host !== undefined));
  if (existed !== 'false') throw new Error(`remote checkout path already exists: ${dir}`);
  const normalized = (value: string) => platform === 'win32' ? path.win32.normalize(value).toLowerCase() : path.posix.normalize(value);
  const registered = async () => (await onHost(host, repo, 'worktree', 'list', '--porcelain')).split(/\r?\n/)
    .some((line) => line.startsWith('worktree ') && normalized(line.slice(9)) === normalized(dir));
  await addVerifiedCheckout(dir, {
    add: () => remote(host, repo, args).then(() => undefined),
    verify: () => verifyCheckout(host, dir, { sha, tree }),
    registered,
    status: () => onHost(host, dir, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'),
    remove: () => removeWorktree(host, repo, dir),
  });
}

/**
 * A host checkout move is bounded: a hung ssh fails the recheck instead of holding the reviewer's turn chain.
 * The bound covers the transfer and reset after the separately bounded wait for the host's clone queue.
 */
export const MOVE_TIMEOUT_MS = 120_000;

/** Lead checks reuse one registered scratch checkout. Never nests the host queue. */
export async function prepareLeadCheckout(host: string | undefined, snapshot: { sha: string; localRepo: string }, dir: string, options: { repo?: string; timings?: Record<string, number> } = {}): Promise<{ created: boolean }> {
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await work(); }
    finally { if (options.timings) options.timings[name] = performance.now() - start; }
  };
  if (host === undefined && options.repo === undefined) throw new Error('local lead checkout needs options.repo');
  const { repo, platform } = host === undefined ? { repo: options.repo!, platform: process.platform } : hostConfig(host);
  const args = checkoutArgs(dir, snapshot.sha);
  const tree = await step('tree', () => local(snapshot.localRepo, 'rev-parse', '--verify', `${snapshot.sha}^{tree}`));
  const queued = performance.now();
  return withHostClone(host ?? repo, async () => {
    if (options.timings) options.timings.queue = performance.now() - queued;
    const signal = AbortSignal.timeout(MOVE_TIMEOUT_MS);
    if (host !== undefined) await step('clone', () => cloneReady(host, snapshot.localRepo, signal));
    const inspect = await step('preflight', () => hostScript(host, repo, `
      const fs=require('node:fs'),p=require('node:path'),dir=process.argv[1];
      for(let d=dir;;d=p.dirname(d)){
        try{if(fs.lstatSync(d).isSymbolicLink())throw new Error('linked lead-check path: '+d)}
        catch(e){if(e.code!=='ENOENT')throw e}
        if(p.dirname(d)===d)break;
      }
      if(!fs.existsSync(dir)){process.stdout.write('absent');process.exit(0)}
      const normalize=v=>process.platform==='win32'?p.win32.normalize(v).toLowerCase():p.posix.normalize(v);
      const list=require('node:child_process').execFileSync('git',['worktree','list','--porcelain'],{encoding:'utf8'});
      if(!list.split(/\\r?\\n/).some(line=>line.startsWith('worktree ')&&normalize(line.slice(9))===normalize(dir)))
        throw new Error('refusing unregistered lead checkout '+dir);
      process.stdout.write('present');
    `, [dir], signal));
    if (inspect === 'absent') {
      await step('add', () => addCheckout(host, repo, platform, { ...snapshot, tree }, args, dir));
      return { created: true };
    }
    if (inspect !== 'present') throw new Error(`cannot inspect lead checkout ${dir}`);
    await step('transfer', () => transferCommit(host, repo, snapshot.localRepo, snapshot.sha, signal, false));
    await step('reset', () => resetCheckout(host, dir, { sha: snapshot.sha, tree }, signal));
    return { created: false };
  }, AbortSignal.timeout(HOST_RUNTIME_WAIT_TIMEOUT_MS));
}

/**
 * Move an existing host checkout to a local commit (a reviewer's recheck, task 1704e-3). The host's
 * clone exists (the checkout lives in it); the commit is fetched or bundled there, then the checkout reset.
 * Host omitted: a local checkout (the isolated tests), which needs options.repo and must already exist.
 */
export async function moveCheckout(host: string | undefined, { sha, localRepo }: { sha: string; localRepo: string }, dir: string, timeoutMs = MOVE_TIMEOUT_MS, options: { repo?: string } = {}): Promise<void> {
  if (host === undefined && options.repo === undefined) throw new Error('moveCheckout without a host needs options.repo');
  if (!hash.test(sha)) throw new Error(`invalid commit hash ${sha}`);
  const repo = options.repo ?? hostConfig(host as string).repo;
  const name = host ?? 'local';
  const tree = await local(localRepo, 'rev-parse', '--verify', `${sha}^{tree}`);
  const waitSignal = AbortSignal.timeout(HOST_RUNTIME_WAIT_TIMEOUT_MS);
  let workSignal: AbortSignal | undefined;
  try {
    await withHostClone(name, () => {
      const signal = workSignal = AbortSignal.timeout(timeoutMs);
      return transferCommit(host, repo, localRepo, sha, signal);
    }, waitSignal);
    // The reset touches only the checkout's own index and HEAD, not the clone's refs or worktree list.
    await resetCheckout(host, dir, { sha, tree }, workSignal);
  } catch (error) {
    if (workSignal?.aborted) throw new Error(`host checkout move timed out after ${timeoutMs}ms`);
    if (!workSignal && waitSignal.aborted) throw new Error(`host '${name}' busy host queue wait timed out after ${HOST_RUNTIME_WAIT_TIMEOUT_MS}ms`);
    throw error;
  }
}

async function hostScript(host: string | undefined, cwd: string, script: string, args: string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw signal.reason;
  const child = spawnProvider({ host, cwd, command: 'node', args: ['-e', script, ...args] });
  const abort = () => { child.kill('SIGKILL'); };
  signal?.addEventListener('abort', abort, { once: true });
  try { return text(await collect(child, undefined, 'checkout script', host !== undefined)); }
  finally { signal?.removeEventListener('abort', abort); }
}

/**
 * Point an existing checkout at a commit with nothing of the tree it held before. A fresh index drops
 * skip-worktree and assume-unchanged flags that would hide stale tracked bytes; untracked files go,
 * gitignored ones (provisioned dependencies) stay. Host omitted: a local checkout (the isolated tests).
 */
export async function resetCheckout(host: string | undefined, dir: string, expected: { sha: string; tree: string }, signal?: AbortSignal): Promise<void> {
  if (!hash.test(expected.sha)) throw new Error(`invalid commit hash ${expected.sha}`);
  // read-tree without -m builds the index afresh, flags included. Remove outputs whose conversion
  // can differ from their blob, then raw-refresh stat data for the normal forced checkout.
  // The checkout is the reviewer's scratch copy, never the code under review.
  // Keep ordered Git operations and all gates, but pay the SSH/jobwrap startup only once.
  const actual = JSON.parse(await hostScript(host, dir, `
    const {execFileSync}=require('node:child_process'),fs=require('node:fs'),p=require('node:path');
    const options={encoding:'utf8',maxBuffer:64*1024*1024};
    const git=(...args)=>execFileSync('git',args,options).trim();
    const gitInput=(input,...args)=>execFileSync('git',args,{...options,input}).trim();
    const sha=process.argv[1],common=git('rev-parse','--git-common-dir');
    try {
      if(fs.readFileSync(p.resolve(common,'info','attributes'),'utf8').length)
        throw new Error('remote checkout reset refuses non-empty info/attributes');
    } catch(error) { if(error.code!=='ENOENT')throw error; }
    git('read-tree',sha);
    const files=execFileSync('git',['ls-files','-z'],options);
    const described=execFileSync('git',['check-attr','--cached','--stdin','-z','eol','text','filter','ident','working-tree-encoding'],{...options,input:files}).split('\\0');
    const autocrlf=git('config','--bool','--default=false','--get','core.autocrlf')==='true';
    const converted=new Map(),set=value=>value!=='unspecified'&&value!=='unset';
    for(let i=0;i+2<described.length;i+=3){
      const [name,attr,value]=described.slice(i,i+3),attrs=converted.get(name)??{};
      attrs[attr]=value;converted.set(name,attrs);
    }
    const root=p.resolve(process.cwd());
    for(const [name,attrs] of converted){
      if(attrs.eol!=='crlf'&&!(set(attrs.filter)||set(attrs.ident)||set(attrs['working-tree-encoding']))&&
        !(autocrlf&&attrs.eol==='unspecified'&&attrs.text!=='unset'))continue;
      const file=p.resolve(root,name);
      if(!file.startsWith(root+p.sep))throw new Error('tracked path escapes checkout: '+name);
      try { if(fs.lstatSync(file).isFile())fs.unlinkSync(file); }
      catch(error) { if(error.code!=='ENOENT')throw error; }
    }
    const raw=gitInput('* -text -filter -ident -working-tree-encoding\\n','hash-object','-w','--stdin');
    const attrs=gitInput('100644 blob '+raw+'\\t.gitattributes\\n','mktree');
    try { git('--attr-source='+attrs,'-c','core.autocrlf=false','update-index','-q','--refresh'); }
    catch (error) { if (error.status !== 1) throw error; } // 1: needs update; --force restores it.
    git('checkout','-q','--detach','--force',sha);
    git('clean','-fdq');
    process.stdout.write(JSON.stringify({
      sha:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),
      status:git('--no-optional-locks','status','--porcelain','--untracked-files=all'),
      tagged:git('ls-files','-t','-z'),
      sparse:git('config','--bool','--default=false','--get','core.sparseCheckout'),
      assumed:git('ls-files','-v','-z')
    }));
  `, [expected.sha], signal));
  assertCheckoutIdentity(expected, actual);
  assertCheckoutIndex(actual.tagged, actual.sparse);
  // ls-files -v tags an assume-unchanged entry in lower case; -t does not show it.
  const assumed = (actual.assumed as string).split('\0').filter((entry) => /^[a-z] /.test(entry));
  if (assumed.length) throw new Error(`remote checkout mismatch: assume-unchanged entries ${assumed.map((entry) => entry.slice(2)).join(', ')}`);
}

/** A failed add may have registered its checkout before reporting failure. */
export async function addVerifiedCheckout(dir: string, actions: {
  add: () => Promise<void>; verify: () => Promise<void>; registered: () => Promise<boolean>;
  status: () => Promise<string>; remove: () => Promise<void>;
}): Promise<void> {
  let added = false;
  try {
    await actions.add();
    added = true;
    await actions.verify();
  } catch (error) {
    // The caller proved the path did not exist before add. Never remove an
    // unregistered or dirty path, even if the add command partly completed.
    let created = added;
    try { if (!created) created = await actions.registered(); }
    catch (cleanup) { throw new Error(`${(error as Error).message}; checkout ownership unknown at ${dir}: ${(cleanup as Error).message}`); }
    if (!created) throw error;
    try {
      if (await actions.status() === '') await actions.remove();
      else throw new Error('new checkout is dirty');
    } catch (cleanup) {
      throw new Error(`${(error as Error).message}; host checkout retained at ${dir}: ${(cleanup as Error).message}`);
    }
    throw error;
  }
}

export function assertCheckoutIndex(taggedFiles: string, sparse: string): void {
  // git ls-files -t -z marks skip-worktree entries with 'S '; -z keeps
  // filenames containing newlines from masquerading as independent entries.
  if (taggedFiles.split('\0').some(entry => entry.startsWith('S ')) || sparse !== 'false') {
    throw new Error(`remote checkout mismatch: skip-worktree or sparse checkout (core.sparseCheckout=${JSON.stringify(sparse)})`);
  }
}

export async function verifyCheckout(host: string | undefined, dir: string, expected: { sha: string; tree: string }): Promise<void> {
  const actual = {
    sha: await onHost(host, dir, 'rev-parse', 'HEAD'),
    tree: await onHost(host, dir, 'rev-parse', 'HEAD^{tree}'),
    status: await onHost(host, dir, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'),
  };
  assertCheckoutIdentity(expected, actual);
  assertCheckoutIndex(
    await onHost(host, dir, 'ls-files', '-t', '-z'),
    await onHost(host, dir, 'config', '--bool', '--default=false', '--get', 'core.sparseCheckout'),
  );
}

export async function fetchBack(host: string, dir: string, branch: string, localRepo: string): Promise<void> {
  const ref = refName(host, branch);
  const sha = await onHost(host, dir, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
  const tree = await onHost(host, dir, 'rev-parse', `${sha}^{tree}`);
  const bundle = await remote(host, dir, ['bundle', 'create', '-', `refs/heads/${branch}`]);
  // git bundle unbundle - imports objects but does not move any local branch.
  const heads = text(await run('git', ['bundle', 'unbundle', '-'], localRepo, bundle));
  if (!heads.split('\n').includes(`${sha} refs/heads/${branch}`)) {
    throw new Error(`remote bundle tip mismatch: reported sha=${sha} tree=${tree}; bundle heads=${heads}`);
  }
  const importedTree = await local(localRepo, 'rev-parse', `${sha}^{tree}`);
  assertCheckoutIdentity({ sha, tree }, { sha, tree: importedTree, status: '' });
  await local(localRepo, 'update-ref', ref, sha);
  const localSha = await local(localRepo, 'rev-parse', ref);
  const localTree = await local(localRepo, 'rev-parse', `${ref}^{tree}`);
  assertCheckoutIdentity({ sha, tree }, { sha: localSha, tree: localTree, status: '' });
}

/**
 * Remove a seat's host checkout. `allowDeadLeftover` authorizes the recovery for a
 * checkout git already emptied (task 1836): a caller whose snapshot is recorded may
 * drop the leftover root directory and its stale registration. Every other caller
 * keeps the fail-closed checks: an unregistered or gitless path is left alone.
 */
export function removeCheckout(host: string, dir: string, signal?: AbortSignal, repo?: string, options: { allowDeadLeftover?: boolean } = {}): Promise<void> {
  return withHostClone(host, () => removeWorktree(host, repo ?? hostConfig(host).repo, dir, signal, options.allowDeadLeftover === true), signal);
}

/**
 * One probe command on the host (or here, in the isolated tests); never throws.
 * Stdin is NEVER ended: remote-exec kills a still-running child on stdin EOF
 * (remote-exec.mjs:49), which made an existing directory report absent over SSH
 * (task 1744b review). `code` null means transport failure, spawn error or timeout.
 */
type ProbeChild = (command: string, args: string[], cwd: string) => ReturnType<typeof spawnProvider>;
/** Stderr a probe keeps: only the tail, so a chatty child cannot grow the failure message without bound. */
const PROBE_STDERR_CHARS = 8_192;
function hostProbe(host: string | undefined, command: string, args: string[], cwd: string, spawnChild?: ProbeChild): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawnChild ? spawnChild(command, args, cwd) : host === undefined
    ? spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    : spawnProvider({ host, command, cwd, args });
  return new Promise(resolve => {
    let settled = false;
    const out: Buffer[] = [];
    let err = '';
    const done = (code: number | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, out: Buffer.concat(out).toString('utf8').trim(), err: err.trim() }); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString('utf8')).slice(-PROBE_STDERR_CHARS); });
    child.once('error', () => done(null));
    child.once('close', code => done(code));
  });
}

export type DirProbe = 'present' | 'absent' | 'unknown';

/**
 * Tri-state directory probe. Only exit 0 plus the exact marker counts; any
 * transport error, timeout or unexpected output is 'unknown', and 'unknown'
 * must never be treated as absent on a deletion path.
 */
export async function dirExistsOnHost(host: string | undefined, dir: string, platform: NodeJS.Platform, cwd: string, spawnChild?: ProbeChild): Promise<DirProbe> {
  const literal = dir.replaceAll("'", "''");
  const probe = platform === 'win32'
    ? await hostProbe(host, 'powershell', ['-NoProfile', '-NonInteractive', '-Command', `if (Test-Path -LiteralPath '${literal}') { 'PRESENT' } else { 'ABSENT' }`], cwd, spawnChild)
    : await hostProbe(host, 'sh', ['-c', `if [ -e "$1" ]; then echo PRESENT; else echo ABSENT; fi`, 'probe', dir], cwd, spawnChild);
  if (probe.code === 0 && probe.out === 'PRESENT') return 'present';
  if (probe.code === 0 && probe.out === 'ABSENT') return 'absent';
  return 'unknown';
}

/** Windows reserved device basenames cannot be deleted through normal path APIs. */
const reservedName = /^(nul|con|prn|aux|com[1-9]|lpt[1-9])$/i;
/** Seat checkout ids: role-family-hash, letters, digits and dashes only. */
const seatId = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * Fail-closed scope guard: after normalization the target must be exactly
 * <dirname(repo)>/worktrees/<seat-id> — no `.`/`..` segments, no separators or
 * drive/UNC prefixes inside the seat segment, no trailing separator. Anything
 * else is refused BEFORE any delete runs.
 */
export function seatCheckoutDir(dir: string, repo: string, platform: NodeJS.Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (/[/\\]$/.test(dir)) throw new Error(`reserved-name cleanup refused (trailing separator): ${dir}`);
  const resolved = p.normalize(dir);
  const expected = p.join(p.dirname(p.normalize(repo)), 'worktrees');
  if (p.dirname(resolved) !== expected || !seatId.test(p.basename(resolved))) {
    throw new Error(`reserved-name cleanup refused outside worktrees/<seat>: ${dir}`);
  }
  return resolved;
}

/**
 * A seat's bash `> nul` creates a file Windows can list but not delete; the
 * `\\?\` prefix bypasses the reserved-name check (task 1744b, a Windows host). Runs
 * ONLY when every remaining non-directory entry is a reserved device name; a
 * single other survivor aborts the script before anything is deleted.
 */
async function purgeReservedNames(host: string | undefined, dir: string, repo: string, platform: NodeJS.Platform): Promise<void> {
  const resolved = seatCheckoutDir(dir, repo, platform);
  const literal = resolved.replaceAll("'", "''");
  const script = [
    `$ErrorActionPreference='Stop'`,
    `$root='${literal}'`,
    `$files = @(Get-ChildItem -LiteralPath $root -Recurse -Force | Where-Object { -not $_.PSIsContainer })`,
    `$bad = @($files | Where-Object { [IO.Path]::GetFileNameWithoutExtension($_.Name) -inotmatch '^${reservedName.source}$' })`,
    `if ($bad.Count -gt 0) { [Console]::Error.WriteLine('non-reserved entries remain: ' + ($bad | ForEach-Object { $_.FullName })); exit 3 }`,
    `$files | ForEach-Object { [IO.File]::Delete('\\\\?\\' + $_.FullName) }`,
    `Remove-Item -LiteralPath $root -Recurse -Force`,
  ].join('; ');
  const probe = await hostProbe(host, 'powershell', ['-NoProfile', '-NonInteractive', '-Command', script], repo);
  if (probe.code !== 0) throw new Error(`reserved-name cleanup failed at ${resolved}: exit ${String(probe.code)} ${probe.err || probe.out}`);
}

/** Git's own words when removal died on bytes it could not delete. */
const deleteFailure = /failed to delete|directory not empty/i;

// Sweeps accept non-seat paths only beneath an explicit host-verified root.
const sweepRemovalScope = `
    if(allowedRoot){
      const root=p.resolve(allowedRoot),target=p.resolve(input);
      if(norm(input)!==norm(target))throw new Error('sweep resolved path mismatch: '+input);
      const relative=p.relative(norm(root),norm(target));
      if(!relative||relative==='..'||relative.startsWith('..'+p.sep)||p.isAbsolute(relative))
        throw new Error('sweep path outside allowed root: '+input);
      for(let parent=p.dirname(target);;parent=p.dirname(parent)){
        let entry;try{entry=fs.lstatSync(parent)}catch(e){if(e.code!=='ENOENT')throw e}
        if(entry&&(entry.isSymbolicLink()||!entry.isDirectory()))throw new Error('sweep parent is a link or not a directory: '+parent);
        if(norm(parent)===norm(root))break;
        if(p.dirname(parent)===parent)throw new Error('sweep path outside allowed root: '+input);
      }
    }`;

/** Caller holds withHostClone and has journaled this candidate before mutation. */
export function removeSweptWorktree(host: string | undefined, repo: string, dir: string, allowedRoot: string): Promise<void> {
  return removeWorktree(host, repo, dir, AbortSignal.timeout(120_000), true, allowedRoot);
}

async function removeWorktree(host: string | undefined, repo: string, dir: string, signal?: AbortSignal, allowDeadLeftover = false, allowedRoot?: string): Promise<void> {
  const platform = host ? hostConfig(host).platform : process.platform;
  if (allowedRoot === undefined) seatCheckoutDir(dir, repo, platform);
  // Git follows an unregistered junction into a different registered checkout and
  // removes that checkout's contents. Check the link AND registration on the host.
  const list = text(await remote(host, repo, ['worktree', 'list', '--porcelain', '-z'], undefined, signal));
  const blocks = list.split('\0\0').map(block => block.split('\0'));
  const registered = blocks.flatMap(lines => lines.filter(line => line.startsWith('worktree ')).map(line => line.slice(9)));
  const normalized = (value: string) => platform === 'win32' ? path.win32.normalize(value).toLowerCase() : path.posix.normalize(value);
  if (allowedRoot && blocks.some(lines => lines[0]?.startsWith('worktree ') && normalized(lines[0].slice(9)) === normalized(dir) && lines.some(line => line === 'locked' || line.startsWith('locked ')))) {
    throw new Error(`sweep checkout is locked: ${dir}`);
  }
  const script = `const fs=require('node:fs'),p=require('node:path');
    const [allowedRoot,input,...registered]=process.argv.slice(1);
    const target=allowedRoot?p.resolve(input):input;
    // git stores realpaths at add (/private/var on macOS): resolve the parent chain on both
    // sides but keep the last component, so a link at the target is still seen by lstat.
    const real=x=>{try{return p.join(fs.realpathSync(p.dirname(x)),p.basename(x))}catch{return p.resolve(x)}};
    const norm=x=>process.platform==='win32'?p.normalize(real(x)).toLowerCase():p.normalize(real(x));
    ${sweepRemovalScope}
    if(!registered.some(x=>norm(x)===norm(target)))throw new Error('checkout is not registered: '+target);
    let stat;try{stat=fs.lstatSync(target)}catch(e){if(e.code!=='ENOENT')throw e}
    if(stat){
      if(stat.isSymbolicLink())throw new Error('checkout is a reparse point or symlink: '+target);
      if(!stat.isDirectory())throw new Error('checkout is not a directory: '+target);
      if(norm(fs.realpathSync(target))!==norm(p.resolve(registered.find(x=>norm(x)===norm(target)))))
        throw new Error('checkout resolved path mismatch: '+target);
    }`;
  try {
    await collect(spawnProvider({ host, command: 'node', cwd: repo, args: ['-e', script, allowedRoot ?? '', dir, ...registered] }), undefined, 'checkout removal preflight', Boolean(host));
    const dotGit = (platform === 'win32' ? path.win32 : path.posix).join(dir, '.git');
    if (allowedRoot && await dirExistsOnHost(host, dotGit, platform, repo) === 'absent') {
      await removeDeadLeftover(host, repo, dir, registered, { allowedRoot, signal });
      return;
    }
    try {
      await remote(host, repo, ['worktree', 'remove', '--force', dir], undefined, signal);
      return;
    } catch (error) {
      const message = (error as Error).message;
      const probe = await dirExistsOnHost(host, dir, platform, repo);
      // Per-seat recovery must not prune repo-wide registrations, even when this
      // target is absent: another seat may be temporarily missing on this host.
      // Reserved-name recovery only for git's delete failure on a verified-present
      // seat checkout; a locked worktree or any other reason throws and deletes nothing.
      if (!allowedRoot && platform === 'win32' && deleteFailure.test(message) && probe === 'present') {
        try {
          await purgeReservedNames(host, dir, repo, platform);
        } catch (cleanup) {
          throw new Error(`${message}; reserved-name cleanup refused or failed at ${dir}: ${(cleanup as Error).message}`);
        }
        if (await dirExistsOnHost(host, dir, platform, repo) !== 'absent') {
          throw new Error(`${message}; reserved-name cleanup left ${dir} behind`);
        }
        return;
      }
      throw error;
    }
  } catch (error) {
    if (!allowDeadLeftover) throw error;
    // Git deletes a checkout's registration and contents before it fails on the root
    // directory a process held (task 1836): the leftover is no longer a git worktree,
    // `worktree remove` refuses it and the preflight no longer sees it registered.
    // Only a caller whose snapshot is recorded may drop it, and only after proving on
    // the host that the .git entry is gone: a directory that still is a git worktree
    // never takes this path and keeps its data.
    const dotGit = (platform === 'win32' ? path.win32 : path.posix).join(dir, '.git');
    if (await dirExistsOnHost(host, dotGit, platform, repo) !== 'absent') throw error;
    try {
      await removeDeadLeftover(host, repo, dir, registered, { allowedRoot, signal });
    } catch (cleanup) {
      throw new Error(`${(error as Error).message}; dead checkout leftover removal failed at ${dir}: ${(cleanup as Error).message}`);
    }
  }
}

/**
 * Drop the leftover of a checkout git already emptied: the directory (its missing
 * .git entry re-checked on the host, never a link) and only THIS checkout's
 * registration, found by the gitdir file that points at it. Zero gitdir matches
 * is success (git already dropped it); more than one still throws. Never a repo-wide
 * prune, which would drop another seat's temporarily missing checkout (task 1782).
 */
async function removeDeadLeftover(host: string | undefined, repo: string, dir: string, registered: string[], options: { registrationOnly?: boolean; signal?: AbortSignal; allowedRoot?: string } = {}): Promise<void> {
  const script = `const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');
    const [mode,repo,input,allowedRoot,...registered]=process.argv.slice(1);
    const target=p.resolve(input);
    // Native realpath preserves filesystem traversal through links before '..'.
    // Walk from the raw path so missing leftovers can still be compared safely.
    const real=x=>{let d=x;const rest=[];for(;;){try{return p.join(fs.realpathSync.native(d),...rest)}catch(e){if(e.code!=='ENOENT')throw e;const up=p.dirname(d);if(up===d)throw e;rest.unshift(p.basename(d));d=up}}};
    const norm=x=>process.platform==='win32'?p.normalize(real(x)).toLowerCase():p.normalize(real(x));
    ${sweepRemovalScope}
    if(norm(input)!==norm(target))throw new Error('leftover resolved path mismatch: '+input);
    const dot=p.join(target,'.git');
    let stat;try{stat=fs.lstatSync(target)}catch(e){if(e.code!=='ENOENT')throw e}
    if(stat){
      // Registration-only: a path that exists again holds new bytes and is never deleted (task 2774).
      if(mode==='registration')throw new Error('checkout directory exists again: '+target);
      if(stat.isSymbolicLink())throw new Error('leftover is a reparse point or symlink: '+target);
      if(!stat.isDirectory())throw new Error('leftover is not a directory: '+target);
      // Anchor at the real repo, not the possibly redirected target parent.
      // Stop at that canonical parent so system aliases such as /var stay valid.
      const base=allowedRoot?fs.realpathSync(allowedRoot):p.dirname(fs.realpathSync(repo));
      for(let parent=p.dirname(target);;parent=p.dirname(parent)){
        const entry=fs.lstatSync(parent);
        if(entry.isSymbolicLink())throw new Error('leftover parent is a reparse point or symlink: '+parent);
        if(!entry.isDirectory())throw new Error('leftover parent is not a directory: '+parent);
        if(norm(parent)===norm(base))break;
        if(p.dirname(parent)===parent)throw new Error('leftover is outside the real worktrees root: '+target);
      }
      let git;try{git=fs.lstatSync(dot)}catch(e){if(e.code!=='ENOENT')throw e}
      if(git)throw new Error('leftover still holds a .git entry: '+target);
      fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});
      if(fs.existsSync(target))throw new Error('leftover survived removal: '+target);
    }
    if(registered.some(x=>norm(x)===norm(target))){
      const common=cp.execFileSync('git',['-C',repo,'rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim();
      const root=p.join(common,'worktrees');
      const gitdirOf=name=>{try{return fs.readFileSync(p.join(root,name,'gitdir'),'utf8').trim()}catch{return null}};
      const stale=(fs.existsSync(root)?fs.readdirSync(root):[]).filter(name=>{const g=gitdirOf(name);return g!==null&&norm(g)===norm(dot)});
      if(stale.length>1)throw new Error('expected one registration for '+target+', found '+stale.length);
      // The git call above is the slow gap: a checkout restored meanwhile keeps its registration.
      if(mode==='registration'){try{fs.lstatSync(target);throw new Error('checkout directory exists again: '+target)}catch(e){if(e.code!=='ENOENT')throw e}}
      if(stale.length===1)fs.rmSync(p.join(root,stale[0]),{recursive:true,force:true});
    }`;
  const { signal } = options;
  if (signal?.aborted) throw signal.reason;
  const child = spawnProvider({ host, command: 'node', cwd: repo, args: ['-e', script, options.registrationOnly ? 'registration' : 'leftover', repo, dir, options.allowedRoot ?? '', ...registered] });
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  try { await collect(child, undefined, 'dead checkout leftover removal', Boolean(host)); }
  finally { signal?.removeEventListener('abort', abort); }
}

/** Bound on one gone-registration drop: the host-clone queue wait, the worktree list and the removal. */
export const DROP_GONE_TIMEOUT_MS = 60_000;

/** A host operation that hit its deadline; recovery skips the host for the rest of its pass. */
export class HostTimeout extends Error {}

/**
 * Drop only this seat's git registration when its directory is already gone.
 * A fresh worktree list under the host-clone lock decides; an unregistered
 * target is already dropped; a directory that exists again refuses and keeps
 * its bytes. Never a repo-wide prune. Host omitted runs here on `repo` (the
 * isolated tests). One deadline covers the queue wait and both host commands.
 */
export async function dropGoneRegistration(host: string, dir: string, repo?: string, timeoutMs = DROP_GONE_TIMEOUT_MS): Promise<void> {
  const config = host ? hostConfig(host) : undefined;
  const clone = repo ?? config?.repo;
  if (!clone) throw new Error('gone registration drop needs a host or a repo');
  const platform = config?.platform ?? process.platform;
  const normalized = (value: string) => platform === 'win32' ? path.win32.normalize(value).toLowerCase() : path.posix.normalize(value);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await withHostClone(host, async () => {
      const list = text(await remote(host || undefined, clone, ['worktree', 'list', '--porcelain'], undefined, signal));
      const registered = list.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
      if (!registered.some((entry) => normalized(entry) === normalized(dir))) return;
      await removeDeadLeftover(host || undefined, clone, dir, registered, { registrationOnly: true, signal });
    }, signal);
  } catch (error) {
    if (signal.aborted) throw new HostTimeout(`gone registration drop on '${host}' timed out after ${timeoutMs}ms`);
    throw error;
  }
}
