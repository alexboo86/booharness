// Lead check orchestration. Snapshot, checkout preparation and command execution
// stay separate so the daemon alone mutates shared host clones.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { checkoutTop, largestUntrackedSnapshotDirs, snapshotBytes, snapshotCommit } from './worktrees.ts';
import { SNAPSHOT_REMOTE_MAX_BYTES } from './seats-create.ts';
import { hash, prepareLeadCheckout, runCheckCommand } from './remote-repo.ts';
import { provisionCheckDependencies, provisionCheckPyTools } from './remote-provision.ts';
import { loadConfig, readHost } from './config.ts';
import { acquireLock, pidRecord, releaseLock, runningInstance } from './lock.ts';
import { probeHost } from './placement.ts';

const exec = promisify(execFile);
const git = async (repo: string, ...args: string[]) => (await exec('git', args, { cwd: repo })).stdout.trim();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const lockFile = (stateDir: string, host: string, repo: string) => path.join(stateDir, 'lead-check', `${digest(JSON.stringify([host, realpathSync(repo)]))}.lock`);
const activeLocks = new Set<string>();
const dependencyRoots = ['', 'ops/orchestrator', 'ops/mcp-vendor'];

async function prepareCheckPyTools(host: string | undefined, repo: string, sha: string, dir: string, timings?: Record<string, number>): Promise<void> {
  if (!await git(repo, 'ls-tree', sha, '--', 'ops/py-tools/install.mjs')) return;
  const started = performance.now();
  try { await provisionCheckPyTools(host, dir); }
  finally { if (timings) timings.pyTools = performance.now() - started; }
}

/** The daemon rechecks supplied snapshots too; a direct HTTP caller cannot bypass the bound. */
export async function snapshotForCheck(repo: string, supplied?: string): Promise<string> {
  const merge = await git(repo, 'rev-parse', '--git-path', 'MERGE_HEAD');
  if (existsSync(path.resolve(repo, merge))) throw new Error('check-on refuses during a merge (MERGE_HEAD exists)');
  if (supplied !== undefined && !hash.test(supplied)) throw new Error('invalid check-on snapshot hash');
  const sha = supplied ?? await snapshotCommit(repo);
  if (await snapshotBytes(repo, sha) > SNAPSHOT_REMOTE_MAX_BYTES) {
    throw new Error(`check-on snapshot exceeds 256 MiB; largest untracked directories: ${await largestUntrackedSnapshotDirs(repo, sha)}`);
  }
  return sha;
}

/** Host omitted is exclusively the isolated local Git test path, never a CLI fallback. */
export async function prepareCheckOn(host: string | undefined, repo: string, sha: string, stateDir: string, options: { repo?: string; timings?: Record<string, number> } = {}): Promise<string> {
  const started = performance.now();
  repo = realpathSync(repo);
  const remote = host === undefined ? { repo: options.repo!, platform: process.platform } : readHost(host);
  if (!remote.repo) throw new Error('local check preparation needs options.repo');
  const p = remote.platform === 'win32' ? path.win32 : path.posix;
  const name = path.basename(repo);
  if (!name || name === '.' || name === '..' || (remote.platform === 'win32' &&
    (/[<>:"/\\|?*]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 0x20) || /[. ]$/.test(name) ||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))) {
    throw new Error(`lead checkout name is invalid on ${remote.platform}: ${name}`);
  }
  const dir = p.join(p.dirname(remote.repo), 'lead-check', name);
  const state = path.join(stateDir, 'lead-check');
  mkdirSync(state, { recursive: true });
  // A second lead with the same basename must not overwrite this lead's scratch tree.
  const key = digest(JSON.stringify([host ?? remote.repo, remote.platform === 'win32' ? dir.toLowerCase() : dir]));
  const owner = path.join(state, `${key}.owner`);
  try { writeFileSync(owner, repo, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (readFileSync(owner, 'utf8') !== repo) throw new Error(`lead checkout ${dir} belongs to ${readFileSync(owner, 'utf8')}`);
  }
  const locks: Record<string, string> = {};
  for (const root of dependencyRoots) {
    const file = root ? `${root}/package-lock.json` : 'package-lock.json';
    const entry = await git(repo, 'ls-tree', sha, '--', file);
    if (entry) locks[root] = entry.split(/\s+/)[2]!;
    else if (!root) throw new Error('check-on snapshot has no root package-lock.json');
  }
  const receipt = path.join(state, `${key}.provision.json`);
  let previous: Record<string, string> = {};
  try { previous = JSON.parse(readFileSync(receipt, 'utf8')); }
  catch (error) {
    // A corrupt cache cannot authorize a skip; real I/O failures still refuse.
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (options.timings) options.timings.receipt = performance.now() - started;
  const { created } = await prepareLeadCheckout(host, { sha, localRepo: repo }, dir, options);
  const changed = Object.keys(locks).filter(root => created || previous[root] !== locks[root]);
  const save = (value: Record<string, string>) => {
    const temp = `${receipt}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, receipt);
  };
  // npm ci destroys the old installation before it can fail. Never retain a
  // receipt that could authorize skipping that old lock on a later retry.
  if (changed.length) save(Object.fromEntries(Object.entries(locks).filter(([root]) => !changed.includes(root))));
  const provision = performance.now();
  try { await provisionCheckDependencies(host, dir, changed); }
  finally { if (options.timings) options.timings.provision = performance.now() - provision; }
  save(locks);
  await prepareCheckPyTools(host, repo, sha, dir, options.timings);
  return dir;
}

export async function withCheckLock<T>(stateDir: string, host: string, repo: string, work: () => Promise<T>): Promise<T> {
  const file = lockFile(stateDir, host, repo);
  mkdirSync(path.dirname(file), { recursive: true });
  if (activeLocks.has(file)) throw new Error(`check-on held by pid ${process.pid} (${host}, ${repo})`);
  activeLocks.add(file);
  let acquired = false;
  try {
    const lock = await acquireLock(file);
    if (lock.ok === false) throw new Error(`check-on held by pid ${lock.holder.pid} (${host}, ${repo}): ${lock.holder.reason}`);
    acquired = true;
    return await work();
  } finally {
    if (acquired) releaseLock(file);
    activeLocks.delete(file);
  }
}

/** Only the CLI holding this checkout's lock may ask the daemon to move it. */
export function assertCheckHolder(stateDir: string, host: string, repo: string, pid: unknown): void {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || pidRecord(lockFile(stateDir, host, repo))?.pid !== pid) {
    throw new Error('check-on preparation requires the caller holding the lead-check lock');
  }
}

/** One preparation attempt; the caller's abort signal bounds the entire response. */
export async function requestCheckPreparation(
  url: string,
  body: { host: string; repo: string; sha: string; pid: number },
  signal: AbortSignal,
): Promise<{ dir?: unknown; timings?: Record<string, number> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const status = response.statusCode!;
          if (status < 200 || status >= 300) throw new Error(`daemon returned ${status}: ${text}`);
          resolve(JSON.parse(text));
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

export async function checkOn(argv: string[]): Promise<number> {
  const timings: Record<string, number> = {};
  const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await work(); }
    finally { timings[name] = performance.now() - start; }
  };
  try {
    const divider = argv.indexOf('--');
    const before = argv.slice(0, divider);
    if (divider < 1 || !argv[divider + 1] || !before[0] || before[0].startsWith('--') ||
      !(before.length === 1 || (before.length === 3 && before[1] === '--repo' && before[2] && !before[2].startsWith('--')))) {
      throw new Error('usage: node ops/orchestrator/src/main.ts check-on <host> [--repo <lead checkout>] -- <command...>');
    }
    const host = before[0];
    const repo = realpathSync(await checkoutTop(before[2] ?? process.cwd()));
    const remote = readHost(host); // Unknown hosts never reach spawnProvider's host-omitted path.
    const config = loadConfig();
    return await withCheckLock(config.stateDir, host, repo, async () => {
      const [snapshot, probed] = await Promise.allSettled([
        phase('snapshot', () => snapshotForCheck(repo)),
        phase('probe', () => probeHost(remote)),
      ]);
      if (snapshot.status === 'rejected') throw snapshot.reason;
      if (probed.status === 'rejected') throw probed.reason;
      const sha = snapshot.value, probe = probed.value;
      if (probe.ok === false) throw new Error(`host '${host}' refused (${probe.reason}): ${probe.error}`);
      const daemon = await runningInstance(config.pidFile);
      if (!daemon || daemon.port === null) throw new Error('orch daemon is not running');
      const result = await phase('prepare', () => requestCheckPreparation(
        `http://${config.host}:${daemon.port}/check-on`,
        { host, repo, sha, pid: process.pid },
        AbortSignal.timeout(75 * 60_000),
      ));
      for (const [name, ms] of Object.entries(result.timings ?? {})) {
        if (Number.isFinite(ms)) timings[`daemon_${name}`] = ms;
      }
      if (typeof result.dir !== 'string' || !result.dir) throw new Error('daemon returned no check-on checkout');
      return phase('command', () => runCheckCommand(host, result.dir as string, argv.slice(divider + 1)));
    });
  } catch (error) {
    process.stderr.write(`check-on: ${(error as Error).message.replace(/[\r\n]+/g, ' ')}\n`);
    return 1;
  } finally {
    process.stderr.write(`[check-on timing] ${Object.entries(timings).map(([name, ms]) => `${name}=${ms.toFixed(1)}ms`).join(' ')}\n`);
  }
}
