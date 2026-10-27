// The board header's total rtk gain (task 1471, count added 1480, hosts added 2750):
// commands run, tokens saved and percent across every rtk history of this Mac AND
// every registered host — the seats' RTK_DB_PATH (config.ts) and the lead's platform
// default are genuinely different files here (measured 2026-09-23: 25.3M saved in the
// state DB vs 1.35M in the Application Support one).
// rtk's own `gain -f json` is the reader: no SQLite parsing in the daemon, and an
// rtk that is missing or failing yields null — the header shows nothing, never a 0.
// A host answers through an inline node script (the probeDisk pattern): the board's
// poll never waits on ssh (dashboard.ts settled()), and host reads cache for 30 s
// because they are ssh spawns, unlike the 10 s local rtk spawn.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readHost, readHosts } from './config.ts';
import { probeEnd, PROBE_TIMEOUT_MS } from './placement.ts';
import { spawnProvider } from './providers/spawn.ts';

export type RtkGain = { saved: number; pct: number; histories: number; commands: number; machines: number; missing: string[] };
export type RtkRead = { saved: number; input: number; commands: number };

type Exec = (file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string }>;
const execAsync = promisify(execFile) as unknown as Exec;

/**
 * Candidate enumeration as plain JS source: ONE source of truth, evaluated by the
 * daemon below and embedded verbatim in RTK_GAIN_SCRIPT, which runs on a host that
 * sees only its own env, home and platform. Every place an rtk history.db can live:
 * the seats' RTK_DB_PATH (or its unix-style default) plus rtk's own platform default
 * for a lead shell that runs without the variable. Same shape as
 * scripts/harness-report/collect-rtk.mjs. Dedupe is by real file, not spelled path:
 * a symlinked default and RTK_DB_PATH naming the same history must count it once
 * (review 2026-09-23: a symlink doubled the total to 50.8M saved for one 25.4M DB).
 * No backticks and no ${ inside: the text is embedded in a template literal.
 */
const RTK_CANDIDATES_JS = `(env, home, platform, path, realpathSync) => {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    let real;
    try { real = realpathSync(path.resolve(p)); } catch { return; }
    const key = real.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(real);
  };
  if (env.RTK_DB_PATH) push(env.RTK_DB_PATH);
  push(path.join(home, '.local', 'state', 'rtk', 'history.db'));
  if (platform === 'darwin') push(path.join(home, 'Library', 'Application Support', 'rtk', 'history.db'));
  if (platform === 'linux') push(path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rtk', 'history.db'));
  if (env.LOCALAPPDATA || platform === 'win32') push(path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'rtk', 'history.db'));
  return out;
}`;

type CandidatesFn = (env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform, pathMod: typeof path, realpath: typeof realpathSync) => string[];
const rtkCandidates = new Function(`return (${RTK_CANDIDATES_JS})`)() as CandidatesFn;

export function rtkGainPaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  return rtkCandidates(env, home, platform, path, realpathSync);
}

/**
 * The host probe (the probeDisk pattern in placement.ts): enumerate this host's own
 * candidates, run `rtk gain --format json` per DB with RTK_DB_PATH set, print ONE
 * JSON line {reads:[{saved,input,commands}],failed:n}. A DB whose read fails (rtk missing,
 * corrupt DB, garbage JSON) does not hide the others, and `failed` counts it: an
 * answering host whose histories did not read is named in missing, never a zero.
 * shell:true on win32 so rtk.exe/.cmd resolves; the args are fixed literals, so the
 * shell re-parse is safe (the DB path travels by env, not argv).
 */
export const RTK_GAIN_SCRIPT = [
  `const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');`,
  `const candidates = (${RTK_CANDIDATES_JS})(process.env, os.homedir(), process.platform, path, fs.realpathSync);`,
  `const reads = [];`,
  `let failed = 0;`,
  `for (const db of candidates) {`,
  `  try {`,
  `    const out = cp.execFileSync('rtk', ['gain', '--format', 'json'], { env: Object.assign({}, process.env, { RTK_DB_PATH: db }), encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] });`,
  `    const summary = JSON.parse(out).summary;`,
  `    if (summary && typeof summary.total_saved === 'number' && typeof summary.total_input === 'number' && typeof summary.total_commands === 'number') reads.push({ saved: summary.total_saved, input: summary.total_input, commands: summary.total_commands });`,
  `    else failed += 1;`,
  `  } catch { failed += 1; /* one unreadable history must not hide the others */ }`,
  `}`,
  `console.log(JSON.stringify({ reads, failed }));`,
].join('\n');

/** The reads line of a host probe, or null when it is absent, unparseable or carries a malformed entry or count. */
export function parseRtkReads(line: string): { reads: RtkRead[]; failed: number } | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (value === null || typeof value !== 'object') return null;
  const { reads, failed } = value as Record<string, unknown>;
  if (!Array.isArray(reads) || !Number.isSafeInteger(failed) || (failed as number) < 0) return null;
  const out: RtkRead[] = [];
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  for (const entry of reads) {
    if (entry === null || typeof entry !== 'object') return null;
    const { saved, input, commands } = entry as Record<string, unknown>;
    if (!finite(saved) || !finite(input) || !finite(commands)) return null;
    out.push({ saved, input, commands });
  }
  return { reads: out, failed: failed as number };
}

/** A host's answered reads, or the reason its probe line is unusable. */
export type HostRtkRead = { ok: true; reads: RtkRead[]; failed: number } | { ok: false; error: string };

/** Read one host's rtk histories over ssh and remote-exec; healthy only on exit 0 plus a parseable last line. */
export function probeRtkGain(host: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<HostRtkRead> {
  let child: ReturnType<typeof spawnProvider>;
  try {
    child = spawnProvider({ command: 'node', args: ['-e', RTK_GAIN_SCRIPT], cwd: readHost(host).repo, host, ownGroup: true });
  } catch (error) {
    return Promise.resolve({ ok: false, error: `${host}: ${(error as Error).message}` });
  }
  return probeEnd(child, timeoutMs).then((end): HostRtkRead => {
    if ('timedOut' in end) return { ok: false, error: `${host}: rtk read timed out after ${timeoutMs} ms; killed by SIGKILL` };
    if ('error' in end) return { ok: false, error: `${host}: ${end.error}` };
    const line = parseRtkReads(end.stdout.trim().split(/\r?\n/).pop() ?? '');
    if (end.code === 0 && line !== null) return { ok: true, ...line };
    const status = end.code === null ? `read killed by ${end.signal}` : `read exit ${end.code}`;
    return { ok: false, error: `${host}: ${status}${line === null ? ', no reads line' : ''}${end.stderr ? `: ${end.stderr}` : ''}` };
  });
}

/**
 * Host reads are ssh spawns: their own 30 s TTL, so the local 10 s board cache never
 * fires an ssh per read and the 3 s poll never waits on one (decision: task 2750;
 * the poll side stays non-blocking through settled() in dashboard.ts, task 2098).
 * Concurrent reads of one host share one probe; a failure is cached too, so a down
 * host costs one ssh per TTL, not one per poll.
 */
export const HOST_GAIN_TTL_MS = 30_000;
export function hostGainCache(read: (host: string) => Promise<HostRtkRead>, ttlMs: number = HOST_GAIN_TTL_MS): (host: string) => Promise<HostRtkRead> {
  const cache = new Map<string, { at: number; value: HostRtkRead }>();
  const inFlight = new Map<string, Promise<HostRtkRead>>();
  return (host) => {
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    const running = inFlight.get(host);
    if (running) return running;
    const promise = Promise.resolve()
      .then(() => read(host))
      .then((value) => value, (error): HostRtkRead => ({ ok: false, error: `${host}: ${error instanceof Error ? error.message : String(error)}` }))
      .then((value) => {
        cache.set(host, { at: Date.now(), value });
        inFlight.delete(host);
        return value;
      });
    inFlight.set(host, promise);
    return promise;
  };
}
export const cachedHostRtkGain = hostGainCache(probeRtkGain);

/** Registered hosts, or none when hosts.json is malformed: a broken registry costs the host reads, never the local one. */
function registeredHosts(): string[] {
  try { return Object.keys(readHosts()); } catch { return []; }
}

/**
 * Sum `rtk gain -f json` over every existing history of this Mac and every registered
 * host, all reads in parallel so one hung rtk or one down host costs a single timeout.
 * A machine whose probe fails, or whose existing histories did not all read, is named
 * in missing (this Mac as `mac`, the board's name for it), never silently dropped; the
 * histories that did read still count. machines counts the machines that read (this Mac
 * when a local history read, a host on a healthy probe line with a history read or none
 * failed — an answered host with no history counts and adds nothing to the totals). When nothing answered at all the result
 * is null — absent data, not a fabricated zero.
 */
export async function readRtkGain(opts: {
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  hosts?: readonly string[];
  hostRead?: (host: string) => Promise<HostRtkRead>;
} = {}): Promise<RtkGain | null> {
  const exec = opts.exec ?? execAsync;
  const env = opts.env ?? process.env;
  const hosts = opts.hosts ?? registeredHosts();
  const hostRead = opts.hostRead ?? cachedHostRtkGain;
  const paths = rtkGainPaths(env, opts.home, opts.platform);
  const [local, ...remote] = await Promise.all([
    Promise.all(paths.map(async (db): Promise<RtkRead | null> => {
      try {
        const { stdout } = await exec('rtk', ['gain', '--format', 'json'], { env: { ...env, RTK_DB_PATH: db }, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
        const summary = JSON.parse(stdout)?.summary;
        if (typeof summary?.total_saved !== 'number' || typeof summary?.total_input !== 'number' || typeof summary?.total_commands !== 'number') return null;
        return { saved: summary.total_saved, input: summary.total_input, commands: summary.total_commands };
      } catch {
        return null; // one unreadable history must not hide the others
      }
    })),
    ...hosts.map((host) => hostRead(host)),
  ]);
  const reads = local.filter((read): read is RtkRead => read !== null);
  const missing: string[] = [];
  const unread = (name: string, failed: number, read: number) => {
    if (failed > 0) missing.push(read > 0 ? `${name} (${failed} of ${failed + read} histories)` : name);
  };
  unread('mac', local.length - reads.length, reads.length);
  let machines = reads.length > 0 ? 1 : 0;
  remote.forEach((result, index) => {
    if (!result || result.ok !== true) { missing.push(hosts[index]); return; }
    unread(hosts[index], result.failed, result.reads.length);
    if (result.reads.length > 0 || result.failed === 0) machines += 1;
    reads.push(...result.reads);
  });
  if (!reads.length) return null;
  const saved = reads.reduce((total, read) => total + read.saved, 0);
  const input = reads.reduce((total, read) => total + read.input, 0);
  const commands = reads.reduce((total, read) => total + read.commands, 0);
  return { saved, pct: input > 0 ? (100 * saved) / input : 0, histories: reads.length, commands, machines, missing };
}

/**
 * A board poll never spawns rtk itself: the value is read at most once per TTL,
 * concurrent polls share one read, and a failed read is cached too (a machine
 * without rtk must not pay a spawn every poll). The board ticks every 3 s; the
 * TTL is 10 s so the live command count moves every 3-4 ticks while rtk spawns
 * at most once per 10 s instead of once per request (task 1480). Host reads
 * inside carry their own 30 s cache (hostGainCache), so this 10 s TTL never
 * means an ssh per read.
 */
const TTL_MS = 10_000;
export function gainCache(read: () => Promise<RtkGain | null>, ttlMs: number = TTL_MS): () => Promise<RtkGain | null> {
  let cache: { at: number; value: RtkGain | null } | null = null;
  let inFlight: Promise<RtkGain | null> | null = null;
  return () => {
    const now = Date.now();
    if (cache && now - cache.at < ttlMs) return Promise.resolve(cache.value);
    if (inFlight) return inFlight;
    inFlight = read().then((value) => {
      cache = { at: Date.now(), value };
      inFlight = null;
      return value;
    }, () => {
      cache = { at: Date.now(), value: null };
      inFlight = null;
      return null;
    });
    return inFlight;
  };
}
export const cachedRtkGain = gainCache(readRtkGain);
