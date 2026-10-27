// Start a provider CLI as a child process with piped stdio, on macOS and Windows.
//
// Windows: Node refuses to spawn a .cmd/.bat without a shell (CVE-2024-27980),
// and a shell would re-parse every argument. npm installs codex, kimi and
// opencode as .cmd shims whose last line runs `node "%dp0%\<script>.js" %*`, so
// the shim is read and its target is run directly: a script under this Node, or
// the native .exe some packages (opencode) point their shim at.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import path from 'node:path';
import { RTK_DB_PATH, readHost, stateDirFor, type RemoteHost } from '../config.ts';
import { buildGateScript, gateEnv, writeBuildShims } from '../build-gate.ts';
import { span } from '../shared.entry.ts';
import { quoteShellPath } from '../role-policy.ts';
export { quoteShellPath } from '../role-policy.ts';

export type Command = { file: string; args: string[] };

const NPM_SHIM_TARGET = /"%dp0%\\([^"]+\.(?:[cm]?js|exe))"/gi;

/**
 * The target of an npm .cmd shim: `node_modules\\...\\x.js` or `...\\x.exe`, or null.
 * The LAST quoted %dp0% path is the one executed; an earlier one is the shim's
 * own `IF EXIST "%dp0%\\node.exe"` probe.
 */
export function npmShimTarget(text: string): string | null {
  return [...text.matchAll(NPM_SHIM_TARGET)].at(-1)?.[1] ?? null;
}

/** Resolve a bare command name against PATH (and PATHEXT on Windows). */
export function resolveCommand(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Command {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (p.isAbsolute(name)) return fromFile(name, platform, env);
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      if (existsSync(candidate)) {
        if (platform === 'win32' && ext === '') continue; // the extensionless npm file is a sh script
        return fromFile(candidate, platform, env);
      }
    }
  }
  throw new Error(`'${name}' is not on PATH`);
}

function fromFile(file: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Command {
  const lower = file.toLowerCase();
  if (platform !== 'win32' || !(lower.endsWith('.cmd') || lower.endsWith('.bat'))) return { file, args: [] };
  const text = readFileSync(file, 'utf8');
  const dir = path.win32.dirname(file);
  // Node ships npm/npx wrappers, not cmd-shim output. Their prefix probe may
  // select a global CLI instead of the copy next to this wrapper.
  const cli = /^SET "(NPM|NPX)_CLI_JS=%~dp0\\(node_modules\\npm\\bin\\(?:npm|npx)-cli\.js)"\r?$/mi.exec(text);
  if (cli && text.includes('SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"')
    && text.trimEnd().endsWith(`"%NODE_EXE%" "%${cli[1]}_CLI_JS%" %*`)) {
    const bundledNode = path.win32.join(dir, 'node.exe');
    const node = existsSync(bundledNode) ? bundledNode : resolveCommand('node', env, platform).file;
    const prefix = spawnSync(node, [path.win32.join(dir, 'node_modules', 'npm', 'bin', 'npm-prefix.js')], {
      env, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    if (prefix.error) throw prefix.error;
    // FOR /F ignores blank lines and comments, assigning once per output line.
    const lastPrefix = prefix.stdout?.split(/\r?\n/).filter((line) => line && !line.startsWith(';')).at(-1);
    const override = lastPrefix ? path.win32.join(lastPrefix, cli[2]) : undefined;
    return { file: node, args: [override && existsSync(override) ? override : path.win32.join(dir, cli[2])] };
  }
  const target = npmShimTarget(text);
  if (!target) throw new Error(`${file} is not an npm shim this resolver can read`);
  if (target.toLowerCase().endsWith('.exe')) return { file: path.win32.join(dir, target), args: [] };
  const bundledNode = path.win32.join(dir, 'node.exe');
  return { file: existsSync(bundledNode) ? bundledNode : process.execPath, args: [path.win32.join(dir, target)] };
}

/**
 * `forward`: the Mac daemon's loopback base URL (`http://127.0.0.1:<port>`) a remote child must reach.
 * The host's own 127.0.0.1 is another machine, whose orch also listens on 7760; the daemon stays
 * loopback-only, so the seat's ssh session carries a reverse forward instead.
 */
export type SpawnSpec = {
  command: string; args: string[]; cwd: string; env?: Record<string, string>; unset?: RegExp; host?: string; forward?: string; forwardTimeoutMs?: number;
  /** Start the child as the leader of its own process group, so the caller can kill it with every descendant (posix only). */
  ownGroup?: boolean;
};

/** The spawn option behind `ownGroup`: win32 has no process groups to signal. */
export const ownGroup = (wanted = true): { detached: boolean } => ({ detached: wanted && process.platform !== 'win32' });

/** How long a forwarded seat waits for ssh to report the host port before it fails. */
export const FORWARD_ALLOCATION_MS = 10_000;

/** The port of a `http://127.0.0.1:<port>` base URL; anything else is refused, the forward targets the Mac's loopback only. */
export function loopbackPort(base: string): number {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(base);
  const port = match ? Number(match[1]) : NaN;
  if (!(port > 0 && port < 65536)) throw new Error(`forward target must be http://127.0.0.1:<port>: ${base}`);
  return port;
}

/**
 * ssh argv for a remote child. A forward asks sshd for `-R 0:...`: the HOST allocates a free
 * loopback port, so it never collides with the host's orch (7760, already bound) nor with another
 * seat's forward; ExitOnForwardFailure ends the session rather than start a seat that cannot reach orch.
 */
export function sshArgs(host: RemoteHost, forwardPort?: number): string[] {
  const remoteScript = host.platform === 'win32'
    ? path.win32.join(host.repo, 'ops', 'orchestrator', 'remote-exec.mjs').replaceAll('\\', '/')
    : path.posix.join(host.repo, 'ops', 'orchestrator', 'remote-exec.mjs');
  // ssh joins the remote argv into a shell command; quote the path, never the JSON header.
  const quotedScript = quoteShellPath(remoteScript, host.platform);
  return [...sshNodeArgs(host, forwardPort), quotedScript];
}

/** ssh argv up to the host's node: the one set of ssh options, shared by a remote child and the host probe. */
export function sshNodeArgs(host: RemoteHost, forwardPort?: number): string[] {
  const forward = forwardPort === undefined ? [] : ['-o', 'ExitOnForwardFailure=yes', '-R', `0:127.0.0.1:${forwardPort}`];
  return ['-T', '-o', 'BatchMode=yes', '-o', 'SendEnv=-*', ...forward, host.ssh, host.node];
}

/** The host port ssh reports for the forward to `forwardPort` (`Allocated port N for remote forward to ...`), or null. */
export function allocatedPort(stderr: string, forwardPort: number): number | null {
  const match = new RegExp(`Allocated port (\\d+) for remote forward to 127\\.0\\.0\\.1:${forwardPort}\\b`).exec(stderr);
  return match ? Number(match[1]) : null;
}

/** `env` with every value at the Mac base URL moved to the host end of the forward. */
export function forwardEnv(env: Record<string, string>, base: string, remotePort: number): Record<string, string> {
  const remote = `http://127.0.0.1:${remotePort}`;
  return Object.fromEntries(Object.entries(env).map(([name, value]) =>
    [name, value === base || value.startsWith(`${base}/`) ? remote + value.slice(base.length) : value]));
}

// Variables that mark a PARENT agent session. When orch (or its smoke run) is
// started from inside Claude Code they leak into every child, and a child
// `claude` then authenticates through the host session: measured 2026-09-22,
// the glm seat sent the host's credentials to Z.AI and retried 401s for minutes.
// Pi marks its children the same way (docs/environment-variables.md): a seat
// that runs orch's tests or a nested agent from its bash tool must not hand on
// its own session, model and provider (found by a qwen coder seat 2026-09-22).
const HOST_SESSION = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_|AI_AGENT$|PI_CODING_AGENT$|PI_SESSION_ID$|PI_SESSION_FILE$|PI_PROVIDER$|PI_MODEL$|PI_REASONING_LEVEL$)/;

// Task 2861 C: a review seat builds only to verify, never edit-and-rebuild, so its cargo
// target carries line-tables-only debug info and no incremental artifacts (memory #19649:
// a fresh `cargo test -p terminal-server --no-run` target fell 10.4 -> 4.7 GiB, the cold
// build 190 -> 137 s). The roles that edit keep the default profile (a post-edit rebuild
// would take 99 s, not 20 s) and the read-only roles run no cargo. A value the environment
// already sets for either variable is never overwritten: the default applies only where
// the merged env holds no entry.
const CARGO_SMALL_TARGET_ROLES: ReadonlySet<string> = new Set(['reviewer', 'security', 'legal', 'bughunter']);
const CARGO_SMALL_TARGET_ENV = { CARGO_PROFILE_DEV_DEBUG: 'line-tables-only', CARGO_INCREMENTAL: '0' } as const;

/** The small-target cargo defaults a review seat's role earns, keeping every value `env` already sets. */
export function smallCargoTargetEnv(role: string | undefined, env: Record<string, string | undefined>): Partial<typeof CARGO_SMALL_TARGET_ENV> {
  if (!role || !CARGO_SMALL_TARGET_ROLES.has(role)) return {};
  return Object.fromEntries(Object.entries(CARGO_SMALL_TARGET_ENV).filter(([name]) => env[name] === undefined));
}

/** The cargo jobs default, without provider environment or build-gate side effects. */
export function cargoBuildJobsDefault(): string {
  return String(Math.max(2, Math.floor(cpus().length / 2)));
}

/**
 * The environment a provider starts with: orch's own, minus host-session and `unset` names, plus `extra`.
 * Every local seat also builds through this machine's build-gate shims (task 1796), written
 * idempotently into `<state dir>/build-gate/bin` and put first on PATH; `gate` is the gate
 * script, and wiring stays dormant while that file is absent from the checkout.
 */
export function providerEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}, unset?: RegExp, gate: string = buildGateScript()): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || HOST_SESSION.test(name) || unset?.test(name)) continue;
    env[name] = value;
  }
  const merged = { RTK_DB_PATH, ...env, CARGO_BUILD_JOBS: env.CARGO_BUILD_JOBS ?? cargoBuildJobsDefault(), ...extra };
  // The seat's role rides spec.env (SEAT_POLICY_ROLE, seats-digest session()); a spawn that names no role keeps the default cargo profile.
  Object.assign(merged, smallCargoTargetEnv(extra.SEAT_POLICY_ROLE, merged));
  const stateDir = base.ORCH_STATE_DIR ? path.resolve(base.ORCH_STATE_DIR) : stateDirFor(homedir());
  const bin = writeBuildShims(stateDir, gate);
  return bin ? gateEnv(merged, bin) : merged;
}

/** Remote children inherit their own machine's environment, never the Mac daemon's. */
export function remoteEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { CARGO_BUILD_JOBS: cargoBuildJobsDefault(), ...extra };
}

/** Lower macOS seat priority without applying a QoS clamp to build workers. */
export function providerLaunch(resolved: Command, args: string[], platform: NodeJS.Platform = process.platform): Command {
  const command = { file: resolved.file, args: [...resolved.args, ...args] };
  return platform === 'darwin' ? { file: '/usr/bin/nice', args: ['-n', '10', command.file, ...command.args] } : command;
}

/** A test process sets this so a missed host stub fails before ssh starts. Production never sets it. */
export function refuseHostSsh(target: string): void {
  if (process.env.ORCH_REFUSE_HOST_SSH === '1') {
    throw new Error(`refusing ssh to '${target}': ORCH_REFUSE_HOST_SSH=1 is set, this process must not reach a real machine`);
  }
}

export function spawnProvider(spec: SpawnSpec): ChildProcessWithoutNullStreams {
  if (spec.host) {
    const remoteHost = readHost(spec.host);
    refuseHostSsh(remoteHost.ssh);
    const forwardPort = spec.forward === undefined ? undefined : loopbackPort(spec.forward);
    const child = spawn('ssh', sshArgs(remoteHost, forwardPort), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...ownGroup(spec.ownGroup === true),
    });
    const header = (env: Record<string, string>) => JSON.stringify({ cwd: spec.cwd, env, command: spec.command, args: spec.args }) + '\n';
    if (forwardPort === undefined) {
      // ssh can die before this write lands (unreachable host, refused key): its stdin pipe is gone,
      // and an unheard EPIPE would crash orch before any caller can attach its own listener. The
      // child's exit already reports the dead pipe; later caller writes still reach their own stdin errors.
      child.stdin.on('error', () => {});
      child.stdin.write(header(remoteEnv(spec.env)));
      return child;
    }
    // The header carries the host port, known only once sshd allocates it: the caller's stdin
    // writes are held until the header has gone out first.
    const stdin = child.stdin;
    const held = new PassThrough();
    // The caller listens on the swapped stream only: a dead ssh pipe (EPIPE) must reach it there,
    // as it would on the plain path, not crash orch as an unheard 'error' on the original.
    stdin.on('error', (error) => held.destroy(error));
    let seen = '';
    const onStderr = (chunk: Buffer | string) => {
      seen = (seen + chunk.toString()).slice(-8192);
      const port = allocatedPort(seen, forwardPort);
      if (port === null) return;
      clearTimeout(deadline);
      child.stderr.off('data', onStderr);
      stdin.write(header(forwardEnv(remoteEnv(spec.env), spec.forward!, port)));
      held.pipe(stdin);
    };
    const timeoutMs = spec.forwardTimeoutMs ?? FORWARD_ALLOCATION_MS;
    const deadline = setTimeout(() => {
      child.stderr.off('data', onStderr);
      child.emit('error', new Error(`ssh forward to 127.0.0.1:${forwardPort} did not report an allocated port within ${timeoutMs} ms`));
      child.kill();
    }, timeoutMs);
    deadline.unref();
    child.stderr.on('data', onStderr);
    child.once('exit', () => {
      clearTimeout(deadline);
      held.unpipe(stdin);
      held.destroy();
    });
    Object.defineProperty(child, 'stdin', { value: held, configurable: true });
    return child;
  }
  const env = providerEnv(process.env, spec.env, spec.unset);
  const resolved = resolveCommand(spec.command, env);
  const launch = providerLaunch(resolved, spec.args);
  return spawn(launch.file, launch.args, {
    cwd: spec.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...ownGroup(spec.ownGroup === true),
  });
}

/** Call `onLine` for every complete newline-terminated line of a stream. `label` names the loop-delay span of the data callback. */
export function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void, label = 'pipe stdout'): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => span(label, () => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
      index = buffer.indexOf('\n');
    }
  }));
}

/** Keep the last `limit` bytes of stderr for error reports. */
export function stderrTail(child: ChildProcessWithoutNullStreams, limit = 4000): () => string {
  let tail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    tail = (tail + chunk).slice(-limit);
  });
  return () => tail.trim();
}
