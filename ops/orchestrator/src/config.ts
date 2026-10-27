// Where orch lives on this machine. One layout on macOS and Windows alike:
// `~/.local/state/orch`, resolved from os.homedir() so a Windows profile gets
// the same relative shape instead of a second, %APPDATA%-based convention.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 7760;
/** Operator's monthly Personal Pro Token Plan purchase date (memory #11883). */
export const MIMO_PLAN_START_UTC = '2026-09-24';
// Resolve once when the daemon starts; launchd does not inherit the operator's shell env.
// An empty value would make rtk fall back to its platform default, so it counts as unset.
export const RTK_DB_PATH = process.env.RTK_DB_PATH || path.join(os.homedir(), '.local', 'state', 'rtk', 'history.db');

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const VERSION: string = pkg.version;

export type Config = {
  stateDir: string;
  dbFile: string;
  pidFile: string;
  logFile: string;
  /** Each family's last good load reading, kept across restarts. */
  lastGoodFile: string;
  host: string;
  port: number;
  /** Read vendor quota for the lead (phase 4); ORCH_USAGE=off keeps a test daemon off the network. */
  usage: boolean;
};

export function stateDirFor(home: string): string {
  return path.join(home, '.local', 'state', 'orch');
}

export type RemoteHost = {
  ssh: string; platform: NodeJS.Platform; repo: string; node: string;
  /** Optional Windows native toolchain for Pi seats; paths are host-local, not daemon paths. */
  native?: { vcvars64: string; pathPrepend: string[]; cmakePrefixPath: string };
};

/** Hosts are explicit: a missing registry is empty, but malformed entries never silently disappear. */
export function readHosts(stateDir = loadConfig().stateDir): Record<string, RemoteHost> {
  const file = path.join(stateDir, 'hosts.json');
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const hosts: unknown = JSON.parse(text);
  checkHosts(hosts, file);
  return hosts;
}

/** The one set of hosts.json rules: readHosts applies it to the file, the writer to the content it is about to write. */
export function checkHosts(hosts: unknown, file: string): asserts hosts is Record<string, RemoteHost> {
  if (!plain(hosts)) throw new Error('hosts.json must be an object');
  for (const [key, value] of Object.entries(hosts)) {
    // Placement names this Mac 'local' (placement.ts Target) and 'mac' (seatHost, needs, the board's local chip): a host by either name would be taken for the Mac.
    if (key === 'local' || key === 'mac') throw new Error(`reserved orch host name '${key}' in ${file}: '${key}' means this Mac; rename the host`);
    const problem = hostProblem(key, value);
    if (problem) throw new Error(`invalid orch host '${key}' in hosts.json: ${problem}`);
  }
}

const WIN_PATH_RULE = 'an absolute drive path of at most 512 characters without " % ^ & | < > ! or a line break';

/** The first rule an entry breaks, as `<field>: <rule>`; null for a valid entry. */
function hostProblem(key: string, value: unknown): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) return 'name: letters, digits, _ and - only';
  if (!plain(value)) return 'entry: must be an object';
  if (Object.keys(value).sort().join(',') !== (value.native === undefined ? 'node,platform,repo,ssh' : 'native,node,platform,repo,ssh')) return 'fields: exactly ssh, platform, repo and node, plus an optional native';
  if (typeof value.ssh !== 'string' || !/^[a-zA-Z0-9_.@][a-zA-Z0-9_.@-]*$/.test(value.ssh)) return 'ssh: letters, digits, _ . @ and -, not starting with -';
  if (!['win32', 'darwin', 'linux'].includes(value.platform as string)) return 'platform: one of win32, darwin, linux';
  if (typeof value.repo !== 'string' ||
      !(value.platform === 'win32' ? path.win32 : path.posix).isAbsolute(value.repo) ||
      /["\r\n%^&|<>!]/.test(value.repo)) return 'repo: an absolute path of the platform without " % ^ & | < > ! or a line break';
  // ssh takes a word after the destination that starts with - as its own option (-F loads a config file on this Mac).
  if (typeof value.node !== 'string' || !/^[a-zA-Z0-9_./:\\][a-zA-Z0-9_./:\\-]*$/.test(value.node)) return 'node: letters, digits and _ . / : \\ - only, not starting with -';
  const native = value.native;
  if (native === undefined) return null;
  if (value.platform !== 'win32') return 'native: only for platform win32';
  if (!plain(native)) return 'native: must be an object';
  if (Object.keys(native).sort().join(',') !== 'cmakePrefixPath,pathPrepend,vcvars64') return 'native: exactly vcvars64, pathPrepend and cmakePrefixPath';
  if (!safeWinPath(native.cmakePrefixPath)) return `native.cmakePrefixPath: ${WIN_PATH_RULE}`;
  if (!safeWinPath(native.vcvars64) || !native.vcvars64.toLowerCase().endsWith('.bat')) return `native.vcvars64: a .bat file at ${WIN_PATH_RULE}`;
  if (!Array.isArray(native.pathPrepend) || !native.pathPrepend.length ||
      native.pathPrepend.length > 32 || !native.pathPrepend.every(safeWinPath)) return `native.pathPrepend: 1 to 32 entries, each ${WIN_PATH_RULE}`;
  return null;
}

/**
 * The one writer of hosts.json: read, change and check under a lock, then rename a
 * complete file into place. A refused or failed write never touches the live file.
 */
function changeHosts(stateDir: string, change: (hosts: Record<string, RemoteHost>, file: string) => Record<string, RemoteHost>): Record<string, RemoteHost> {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'hosts.json');
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  // The lock and rename of changePaused (paused-families.ts): mkdir is exclusive across
  // processes, and the read MUST be inside the lock or a concurrent add is lost.
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`${lock}: hosts edit lock busy; no changes made (inspect a stale lock before removing it)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const text = `${JSON.stringify(change(readHosts(stateDir), file), null, 2)}\n`;
    // Check the bytes that reach the disk, as the reader will, not the caller's object.
    const next: unknown = JSON.parse(text);
    checkHosts(next, file);
    const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
      renameSync(temp, file);
    } finally { rmSync(temp, { force: true }); }
    return next;
  } finally { rmdirSync(lock); }
}

/** The writer's refusal of a name that exists; a caller applies it too before it does work for the entry. */
export function refuseExistingHost(name: string, hosts: Record<string, RemoteHost>, file: string): void {
  if (Object.hasOwn(hosts, name)) throw new Error(`orch host '${name}' already exists in ${file}: a name must be new unless replace is set`);
}

/** Add a host; a name that exists is refused unless `replace` is set. Returns the registry as written. */
export function addHost(name: string, host: RemoteHost, { replace = false, stateDir = loadConfig().stateDir }: { replace?: boolean; stateDir?: string } = {}): Record<string, RemoteHost> {
  return changeHosts(stateDir, (hosts, file) => {
    if (!replace) refuseExistingHost(name, hosts, file);
    return { ...hosts, [name]: host };
  });
}

/** Remove a host; an unknown name is refused. Returns the registry as written. */
export function removeHost(name: string, stateDir = loadConfig().stateDir): Record<string, RemoteHost> {
  return changeHosts(stateDir, (hosts) => {
    if (!Object.hasOwn(hosts, name)) throw new Error(`unknown orch host '${name}'`);
    return Object.fromEntries(Object.entries(hosts).filter(([key]) => key !== name));
  });
}

export function readHost(name: string, stateDir = loadConfig().stateDir): RemoteHost {
  const hosts = readHosts(stateDir);
  if (!Object.hasOwn(hosts, name)) throw new Error(`unknown orch host '${name}'`);
  return hosts[name];
}

// vcvars is invoked by cmd; refuse shell metacharacters and expansion in configured paths.
function safeWinPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && /^[a-zA-Z]:[\\/]/.test(value) &&
    path.win32.isAbsolute(value) && !/["\r\n%^&|<>!]/.test(value);
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * ORCH_STATE_DIR, ORCH_PORT and ORCH_USAGE exist for the test suite: a test daemon must not
 * share the operator's database or port. Port 0 asks the OS for a free port;
 * the bound port is then written to the pid file and printed on stdout.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = env.ORCH_STATE_DIR ? path.resolve(env.ORCH_STATE_DIR) : stateDirFor(os.homedir());
  const rawPort = env.ORCH_PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`ORCH_PORT must be an integer 0..65535, got '${rawPort}'`);
  }
  return {
    stateDir,
    dbFile: path.join(stateDir, 'orch.sqlite'),
    pidFile: path.join(stateDir, 'orch.pid'),
    logFile: path.join(stateDir, 'orch.log'),
    lastGoodFile: path.join(stateDir, 'limits-last-good.json'),
    host: HOST,
    port,
    usage: env.ORCH_USAGE !== 'off',
  };
}
