// Pi (`pi --mode rpc`, @earendil-works/pi-coding-agent) as the one worker
// harness (operator decision 2026-09-22, memory #10477): JSONL commands on stdin,
// a `response` per command, agent events on stdout, `agent_settled` when a
// prompt is fully done. Protocol: docs/rpc.md of the installed package.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readHost, type RemoteHost } from '../config.ts';
import { collect, text } from '../shared.entry.ts';
import { remotePiMcpPath } from '../remote-pi-mcp.ts';
import { SCOUT_TOOL } from '../shared.entry.ts';
import { readLines, spawnProvider, stderrTail } from './spawn.ts';
import { span } from '../shared.entry.ts';
import { drainNote, settlesWithin, TurnTimeout, withTimeout } from './turn.ts';
import type { ContextUsage, Family, PromptOptions, ProviderAdapter, ProviderSession, SessionSpec, StopReason, TurnResult, Usage } from './types.ts';
import { PI_DIRECT_TOOLS } from '../shared.entry.ts';
import { codexEditActive } from '../codex-edit.ts';

export type PiRoute = {
  /** Pi provider id (docs/providers.md), e.g. zai, opencode-go, openai-codex. */
  provider: string | (() => string);
  /** Required: `--provider` alone does not pick a model, and Pi then runs the
   *  settings.json default, which is whatever provider was logged in last. */
  defaultModel: string;
  /** `--thinking` when the seat names no effort. */
  defaultEffort?: string;
  /** Credentials as env; Pi's own ~/.pi/agent/auth.json wins over env when both exist. */
  env?: () => Record<string, string>;
};

// A read-only seat gets no tool that edits files. Its bash runs only what
// seat-guard.ts allows (rg, ast-grep, the codegraph CLI, memoryctl reads, git
// reads; task 1436): Pi has no permission prompts, so the orch extension below
// is the guard, and a seat whose extension did not load never starts.
// `codegraph_explore` and `memoryctl_memory` are pi-mcp-adapter direct tools
// (the installer's `directTools`); `mcp` is its proxy to the rest. Which servers
// a seat reaches is cut by the role gate; a memory write stays possible and is
// held by the role in the brief (operator, 2026-09-22).
const PI_BUILTIN_TOOLS = {
  'read-only': ['read', 'grep', 'find', 'ls', 'bash'],
  full: ['read', 'bash', 'edit', 'write'],
};
export const PI_READ_ONLY_TOOLS = [...PI_BUILTIN_TOOLS['read-only'], 'mcp', ...Object.values(PI_DIRECT_TOOLS).flat()].join(',');

/** The loadout orch supplies: shared by the read-only allowlist and startup manifest.
 *  `model` is the resolved model id: codex-edit swaps built-in `edit` for `apply_patch`
 *  at session_start only for the models its pinned config allows. */
export function piExpectedTools(spec: SessionSpec, model?: string): string[] {
  const off = new Set(spec.instrumentsOff ?? []);
  const tools = [...PI_BUILTIN_TOOLS[spec.access], 'mcp', ...Object.entries(PI_DIRECT_TOOLS)
    .filter(([key]) => !off.has(key)).flatMap(([, names]) => names)];
  // A read-only seat never carries codexEdit (orch loads no editing extension for it),
  // and its list has no `edit` to swap: the allowlist stays exactly what it was.
  const editor = spec.codexEdit && codexEditActive(spec.codexEdit.models, model) ? tools.indexOf('edit') : -1;
  if (editor !== -1) tools[editor] = 'apply_patch';
  // Hashline replaces read in-place and disables edit. Stock 4.5.1 and the
  // hashline stand profiles disable anchor_grep; 4.5.1 and 5.0.0 also disable
  // copy/move. Only the hashline-edit-500 stand arm expects replace_within
  // (replaceWithinEnabled:true). Stock seats and the 451 arm keep this list.
  const arm = spec.env?.ORCH_SEAT_STAND_ARM;
  const hashline = spec.hashlineEdit || arm === 'hashline-edit' || arm === 'hashline-edit-451' || arm === 'hashline-edit-500';
  if (spec.access === 'full' && hashline) {
    const edit = tools.indexOf('edit');
    if (edit !== -1) tools.splice(edit, 1, 'replace', 'insert', 'undo_last_change');
    if (arm === 'hashline-edit-500') tools.push('replace_within');
  }
  // Pi-package tools explicitly supplied by stand arms; never expect acp_delegate.
  if (spec.env?.ORCH_SEAT_STAND_ARM === 'open-codebase-index') tools.push('codebase_context', 'codebase_peek', 'index_status');
  if (spec.env?.ORCH_SEAT_STAND_ARM === 'pi-condense') tools.push('context_tree_query');
  // sol-pi: Action Fusion re-registers edit and write under their built-in names, so the only
  // new name is ObservationPack's obs_recall. A read-only seat needs it too: the context hook
  // packs large observations on every access, and without the tool they could not be recalled.
  if (arm === 'sol-pi') tools.push('obs_recall');
  if (spec.env?.ORCH_SEAT_STAND_ARM === 'billion-context') tools.push('compress', 'decompress', 'search_context', 'acp_status');
  if (spec.seatTool) tools.push(SCOUT_TOOL.name);
  return tools;
}

/** Pi-only observation: native provider sessions do not carry it. */
export type PiToolManifest = { missingTools: readonly string[] };
/** orch's Pi extension: the read-only bash guard and the command that actually ran. */
export const PI_EXTENSION = fileURLToPath(new URL('../pi-extension.ts', import.meta.url));
const ORCH_SEAT_COMMAND = 'orch-seat';

// Seats never phone home: no install ping, no provider attribution headers, no
// version check (docs/environment-variables.md). Local seats read the installed
// Pi MCP config; remote seats explicitly select their provisioned checkout config.
const PI_ENV = { PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', PI_MCP_CONFIG_MODE: 'exclusive' };
// A Typesafe key would switch the adapter's semantic search to Jev; an inherited
// ANTHROPIC_* could pick a provider's endpoint or bill. Neither reaches a seat.
// ORCH_SEAT_INSTRUMENTS_OFF neither: the daemon may itself run inside a seat
// that has it set, and a no-override seat must not inherit that arm (review
// 2026-09-23); a seat's own off list comes back through spec.env after the unset.
// An inherited KIMI_API_KEY would authenticate a kimi seat that has no Pi OAuth,
// billing another plan (operator #12679).
const PI_UNSET = /^(TYPESAFE_|ANTHROPIC_|KIMI_API_KEY$|ORCH_SEAT_TOKEN$|ORCH_SEAT_TOOL_URL$|ORCH_SEAT_INSTRUMENTS_OFF$|ORCH_SEAT_STAND_ARM$|ORCH_SEAT_EXPECTED_TOOLS$|ORCH_SEAT_WRITE_SCOPE$|PI_CODING_AGENT_DIR$|PI_CODING_AGENT_SESSION_DIR$|PI_PACKAGE_DIR$)/;

const STOP: Record<string, StopReason> = { stop: 'end_turn', length: 'max_tokens', aborted: 'cancelled', error: 'error' };
/** Operator #13093: compact only while idle, before the next prompt. */
export const PI_COMPACTION_CONTEXT_TOKENS = 150_000;

// The extension is checked into each host's clone. Pi's default agent and session
// directories belong to the remote user's home, never the launching Mac.
export function piHostPaths(host: RemoteHost, cwd: string, sessionPath: string | null): { extension: string; cwd: string; sessionPath: string | null } {
  const p = host.platform === 'win32' ? path.win32 : path.posix;
  // win32.isAbsolute('/Users/...') is true, although this is a Mac path,
  // not a usable absolute drive path on the configured Windows host.
  const remoteAbsolute = (value: string) => p.isAbsolute(value) && (host.platform !== 'win32' || /^[a-zA-Z]:[\\/]/.test(value));
  if (!remoteAbsolute(cwd)) throw new Error(`Pi remote cwd must be an absolute ${host.platform} path: ${cwd}`);
  if (sessionPath && !remoteAbsolute(sessionPath)) throw new Error(`Pi remote session must be an absolute ${host.platform} path: ${sessionPath}`);
  return { extension: p.join(host.repo, 'ops', 'orchestrator', 'src', 'pi-extension.ts'), cwd, sessionPath };
}

// The A/B stand creates these paths on the Mac, not on a remote host. Fail
// rather than let Pi use a Mac agent profile, package cache or history file.
const LOCAL_PROFILE_PATH = /^(HOME|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PI_PACKAGE_DIR|XDG_.*_HOME|npm_config_cache|CONTEXT_MODE_DIR|CBM_CACHE_DIR|RTK_DB_PATH|AIDER_.*_FILE|PATH)$/;
export function piRemoteEnv(env: Record<string, string> | undefined, host?: RemoteHost): Record<string, string> | undefined {
  const localPath = Object.keys(env ?? {}).find((key) => LOCAL_PROFILE_PATH.test(key) || key.startsWith('ORCH_HOST_'));
  if (localPath) throw new Error(`remote Pi cannot use locally generated ${localPath}; provision it on the host`);
  return host?.native ? { ...env, ORCH_HOST_VCVARS64: host.native.vcvars64,
    ORCH_HOST_PATH_PREPEND: JSON.stringify(host.native.pathPrepend),
    ORCH_HOST_CMAKE_PREFIX_PATH: host.native.cmakePrefixPath } : env;
}

export function piMcpConfigForSeat(spec: SessionSpec, host: RemoteHost | null): string {
  if (!host) {
    // Only the seat's explicit profile override may replace the installed user
    // profile; PI_UNSET strips an inherited PI_CODING_AGENT_DIR from the child.
    const agent = spec.env?.PI_CODING_AGENT_DIR ?? path.join(spec.env?.HOME ?? os.homedir(), '.pi', 'agent');
    const config = path.resolve(agent, 'mcp-adapter.json');
    if (!existsSync(config)) throw new Error(`local Pi MCP config is missing at ${config}; run ${spec.env?.PI_CODING_AGENT_DIR ? 'node ops/ab-stand/install.mjs --all' : 'ops/bootstrap/install-harness.mjs --only mcp'}`);
    return config;
  }
  const expected = remotePiMcpPath(host, spec.cwd);
  if (!spec.remoteMcpConfig) throw new Error(`remote Pi MCP config is missing: remoteMcpConfig must record ${expected}; provision the seat MCP config on ${spec.host ?? host.ssh} before starting Pi`);
  if (spec.remoteMcpConfig !== expected) throw new Error(`remote Pi MCP config path does not match seat checkout: ${spec.remoteMcpConfig}`);
  return expected;
}

export function piArgs(route: PiRoute, spec: SessionSpec, sessionPath: string | null, extension = PI_EXTENSION, mcpConfig?: string): string[] {
  // --no-skills: the seat's skills come from orch's context (routed, the role's own inlined); Pi's
  // discovery listed the operator's paseo-* launch skills to every seat (measured 2026-09-23).
  // The seat contract is provided by orch, not Pi's automatic AGENTS.md/CLAUDE.md discovery.
  const args = ['--mode', 'rpc', '-e', extension,
    // codex-edit beside orch's own extension, and only for a seat that edits: an
    // unverified or absent install never reaches here (codex-edit.ts throws first).
    ...(spec.access === 'full' && spec.codexEdit ? ['-e', spec.codexEdit.extension] : []),
    ...(spec.access === 'full' && spec.hashlineEdit ? ['-e', spec.hashlineEdit.extension] : []),
    '--no-skills',
    // --no-approve: a seat checkout's project-trust-gated resources (project settings, MCP
    // config, extensions, skills, prompts, themes, packages) never load. Adapter 5.3.2
    // uses .pi/mcp-adapter.json and gates project servers too; exclusive mode keeps
    // checkout MCP configs out. This flag still refuses all project resources (#14061).
    // Extensions orch passes
    // with -e above and agent-directory packages (A/B stand) load independently of it.
    '--no-approve', '--no-context-files', '--provider', typeof route.provider === 'string' ? route.provider : route.provider()];
  args.push('--model', spec.model ?? route.defaultModel);
  const effort = spec.effort ?? route.defaultEffort;
  if (effort) args.push('--thinking', effort);
  if (spec.access === 'read-only') {
    // An instrument the seat turned off leaves the tool list too (task 1452);
    // the extension still refuses a proxied call, this keeps it unadvertised.
    args.push('--tools', piExpectedTools(spec, spec.model ?? route.defaultModel).join(','));
  }
  if (sessionPath) args.push('--session', sessionPath);
  if (mcpConfig) args.push('--mcp-config', mcpConfig);
  return args;
}

/**
 * Pi reports input WITHOUT cache reads (its session total is
 * input+output+cacheRead+cacheWrite). Its `cost` is Pi's catalog price, which
 * is not what a subscription or coding plan pays, so costUsd stays null.
 */
export function piUsage(messages: any[]): Usage | null {
  const usages = messages.map((message) => message?.usage).filter((usage) => usage && typeof usage.input === 'number');
  if (!usages.length) return null;
  const sum = (key: string) => usages.reduce((total, usage) => total + (usage[key] ?? 0), 0);
  return { inputTokens: sum('input'), cacheReadTokens: sum('cacheRead'), cacheWriteTokens: sum('cacheWrite'), outputTokens: sum('output'), costUsd: null, raw: usages };
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
type Turn = { messages: any[]; onEvent?: PromptOptions['onEvent']; retryError: string | null; settled: () => void; bash: Map<string, any>; promptSent: boolean; cancelled: boolean };

class PiSession implements ProviderSession {
  readonly family: Family;
  sessionId = '';
  model: string | null = null;
  missingTools: readonly string[] = [];
  private child: ChildProcessWithoutNullStreams;
  private stderr: () => string;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private turn: Turn | null = null;
  private closedError: Error | null = null;
  private markClosed!: (error: Error) => void;
  readonly whenClosed: Promise<Error> = new Promise((resolve) => { this.markClosed = resolve; });

  constructor(family: Family, child: ChildProcessWithoutNullStreams) {
    this.family = family;
    this.child = child;
    this.stderr = stderrTail(child);
    readLines(child.stdout, (line) => this.receive(line), 'pi stdout');
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) => span('pi exit', () => {
      const tail = this.stderr();
      this.fail(new Error(`pi exited (${signal ?? code})${tail ? `: ${tail}` : ''}`));
    }));
    child.stdin.on('error', (error) => this.fail(error));
  }

  get closed(): boolean {
    return this.closedError !== null;
  }

  command(type: string, fields: Record<string, unknown> = {}): Promise<any> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = `orch-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  }

  private fail(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.markClosed(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private kill(reason: string): void {
    this.fail(new Error(reason));
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  private receive(line: string): void {
    if (this.closedError) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === 'response') {
      const pending = event.id ? this.pending.get(event.id) : undefined;
      if (!pending) return;
      this.pending.delete(event.id);
      if (event.success) pending.resolve(event.data);
      else pending.reject(new Error(`${event.command}: ${event.error}`));
      return;
    }
    if (event.type === 'extension_ui_request') {
      // session_compact carries the entry Pi has appended to its JSONL, not an attempt.
      if (event.method === 'setStatus' && event.statusKey === 'orch-compaction' && typeof event.statusText === 'string') {
        this.turn?.onEvent?.({ kind: 'compaction', entryId: event.statusText });
      }
      if (event.method === 'setStatus' && event.statusKey === 'orch-tools-missing' && typeof event.statusText === 'string') {
        try {
          const names: unknown = JSON.parse(event.statusText);
          if (Array.isArray(names) && names.every((name) => typeof name === 'string')) this.missingTools = names;
        } catch { /* Ignore malformed extension status, like other unsupported UI requests. */ }
      }
      // A headless seat has no one to answer a dialog; dismiss it so nothing blocks.
      if (['select', 'confirm', 'input', 'editor'].includes(event.method)) {
        this.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true })}\n`);
      }
      return;
    }
    const turn = this.turn;
    if (!turn) return;
    switch (event.type) {
      case 'message_update': {
        const delta = event.assistantMessageEvent;
        if (delta?.type === 'text_delta') turn.onEvent?.({ kind: 'text', delta: delta.delta });
        else if (delta?.type === 'thinking_delta') turn.onEvent?.({ kind: 'thought', delta: delta.delta });
        break;
      }
      case 'message_end':
        if (event.message?.role === 'assistant') {
          turn.messages.push(event.message);
          const usage = piUsage([event.message]);
          if (usage) turn.onEvent?.({ kind: 'usage', tokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens });
        }
        break;
      case 'tool_execution_start':
        // A bash call is reported when it ends: its start carries the model's command, and only
        // the result's `details.orchCommand` (pi-extension.ts) says what ran after rtk rewrote it.
        if (event.toolName === 'bash') turn.bash.set(event.toolCallId, event.args);
        else turn.onEvent?.({ kind: 'tool', name: event.toolName, status: 'started', args: event.args });
        break;
      case 'tool_execution_end':
        if (event.toolName === 'bash') {
          const args = turn.bash.get(event.toolCallId) ?? {};
          turn.bash.delete(event.toolCallId);
          const ran = event.result?.details?.orchCommand;
          turn.onEvent?.({ kind: 'tool', name: 'bash', status: 'started', args: typeof ran === 'string' ? { ...args, command: ran } : args });
        }
        break;
      case 'auto_retry_end':
        if (event.success === false) turn.retryError = event.finalError ?? 'retries exhausted';
        break;
      case 'agent_settled':
        if (turn.promptSent) turn.settled();
        break;
      default:
        break;
    }
  }

  private async compactBeforePrompt(turn: Turn): Promise<void> {
    try {
      const usage = await this.contextUsage();
      if (!usage || !Number.isFinite(usage.tokens) || !Number.isFinite(usage.window)
        || usage.tokens <= PI_COMPACTION_CONTEXT_TOKENS || usage.window <= PI_COMPACTION_CONTEXT_TOKENS) return;
      const state = await this.command('get_state');
      // Manual compaction aborts active work. Never call it unless Pi confirms idle.
      if (state?.isStreaming !== false || state?.isCompacting !== false || state?.pendingMessageCount !== 0) {
        throw new Error('between-turn compaction skipped: Pi is not idle');
      }
      if (turn.cancelled || this.turn !== turn) return;
      await this.command('compact');
    } catch (error) {
      // A failed compaction must not suppress the user's next prompt.
      if (!turn.cancelled && this.turn === turn) {
        turn.onEvent?.({ kind: 'compaction_error', error: (error as Error).message });
      }
    }
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<TurnResult> {
    const started = Date.now();
    if (this.closedError) return { text: '', earlier: [], stopReason: 'error', rawStopReason: null, usage: null, error: this.closedError.message, durationMs: 0 };
    if (this.turn) throw new Error('a turn is already running on this session');
    let settled!: () => void;
    const done = new Promise<void>((resolve) => { settled = resolve; });
    const turn: Turn = { messages: [], onEvent: options.onEvent, retryError: null, settled, bash: new Map(), promptSent: false, cancelled: false };
    const replies = () => {
      const texts = turn.messages.map((message) => (message.content ?? [])
        .filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''));
      return { text: texts.at(-1) ?? '', earlier: texts.slice(0, -1) };
    };
    // Install the NEW turn's event sink before idle compaction, not after it.
    this.turn = turn;
    try {
      const run = (async () => {
        await this.compactBeforePrompt(turn);
        // Cancellation/timeout during preparation must not launch a late run.
        if (turn.cancelled || this.turn !== turn) return;
        turn.promptSent = true;
        await this.command('prompt', { message: text });
        await Promise.race([done, this.whenClosed.then((reason) => { throw reason; })]);
      })();
      await withTimeout(run, options.timeoutMs);
      const last = turn.messages.at(-1);
      const raw: string | null = last?.stopReason ?? null;
      const error = turn.retryError ?? (raw === 'error' ? String(last?.errorMessage ?? 'provider error') : null);
      return { ...replies(), stopReason: turn.cancelled ? 'cancelled' : error ? 'error' : STOP[raw ?? ''] ?? 'other', rawStopReason: raw, usage: piUsage(turn.messages), error, durationMs: Date.now() - started };
    } catch (error) {
      let message = (error as Error).message;
      if (error instanceof TurnTimeout) {
        turn.cancelled = true;
        // `abort` answers only once the session is idle: that is the drain.
        const drained = await settlesWithin(this.command('abort'));
        const exited = this.closedError !== null;
        if (!drained) this.kill('closed by orch: turn did not stop after abort');
        message = `${message}; ${drainNote(drained, exited)}`;
      }
      return { ...replies(), stopReason: 'error', rawStopReason: null, usage: piUsage(turn.messages), error: message, durationMs: Date.now() - started };
    } finally {
      this.turn = null;
    }
  }

  async steer(text: string): Promise<void> {
    await this.command('steer', { message: text });
  }

  async contextUsage(): Promise<ContextUsage | null> {
    const stats = await this.command('get_session_stats');
    const usage = stats?.contextUsage;
    return typeof usage?.tokens === 'number' && typeof usage?.contextWindow === 'number' && usage.contextWindow > 0
      ? { tokens: usage.tokens, window: usage.contextWindow }
      : null;
  }

  async cancel(): Promise<void> {
    if (this.turn) this.turn.cancelled = true;
    // abort answers only when idle; a session that never gets there is closed.
    if (!(await settlesWithin(this.command('abort')))) this.kill('closed by orch: turn did not stop after abort');
  }

  async close(): Promise<void> {
    if (this.closedError) return;
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
}

/** Checkout this module was loaded from. `pi-extension.ts` sits at ops/orchestrator/src, three levels down. */
const DAEMON_REPO = path.resolve(path.dirname(PI_EXTENSION), '..', '..', '..');
// Test-only seam (task 2036 follow-up, operator #14027): scripts/test-orch-providers.mjs
// points local Pi launches at a fixture runtime root holding a fake pinned install. This
// is a module function, not an env var, seat field or host file: spec.env, a brief and a
// host file are data and cannot call it, so no seat can redirect its own runtime.
// Production code never calls it, and with the override unset the root stays DAEMON_REPO.
let piRuntimeRootOverride: string | null = null;
export function setPiRuntimeRootForTest(root: string | null): void {
  piRuntimeRootOverride = root;
}
const piRuntimeRoot = (): string => piRuntimeRootOverride ?? DAEMON_REPO;
const PI_PACKAGE = '@earendil-works/pi-coding-agent';
/** A host file read must not hold seat start. Same order of bound as the other host probes. */
const PI_RUNTIME_PROBE_MS = 30_000;
// `node -e`: argv[1] is the bin, argv[2] the installed package.json. Remote seats read those
// host files through spawnProvider → remote-exec.mjs (the checkout preflight's path, remote-repo.ts).
const PI_INSTALL_PROBE = "const fs=require('node:fs');const [bin,manifest]=process.argv.slice(1);let version=null;try{const v=JSON.parse(fs.readFileSync(manifest,'utf8')).version;version=typeof v==='string'?v:null}catch{}process.stdout.write(JSON.stringify({bin:fs.existsSync(bin),version}));";

export function piRuntimeLayout(repo: string, platform: NodeJS.Platform): { command: string; installed: string } {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = p.join(repo, 'ops', 'pi-runtime');
  return {
    // win32 resolveCommand unwraps an absolute .cmd shim and will not execute the extensionless sh file.
    command: p.join(root, 'node_modules', '.bin', platform === 'win32' ? 'pi.cmd' : 'pi'),
    installed: p.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'),
  };
}

function piRuntimeError(machine: string, detail: string): Error {
  return new Error(`pi on ${machine} is not the pinned install (${detail}); repair with: npm ci --prefix ops/pi-runtime`);
}

/** The probe never answered (ssh exit, the probe bound's kill, a spawn error, output that is
 *  not the probe's JSON): no install verdict exists, so unlike `piRuntimeError` this is a
 *  transport failure — often transient, and never repaired by `npm ci` on the host. */
class PiProbeTransportError extends Error {}

function probeTransportError(machine: string, cause: string): PiProbeTransportError {
  return new PiProbeTransportError(`pi on ${machine} did not answer the runtime probe (${cause}); ssh transport failure, not an install verdict`);
}

// A drained restart resumes dozens of turns at once and ssh can refuse the first connection
// (task 2864: kex_exchange_identification resets; a minute later the probe passes unchanged).
// Retry the transport only: a probe that answered with a verdict is a fact about the host,
// and `assertPiRuntime` refuses it on the first attempt, never retried.
const PI_PROBE_ATTEMPTS = 3;
const PI_PROBE_BACKOFF_MS = [2_000, 5_000];

/** The pin in this daemon's ops/pi-runtime/package.json — the version source, not a second constant. */
function pinnedPiVersion(): string {
  const file = path.join(piRuntimeRoot(), 'ops', 'pi-runtime', 'package.json');
  try {
    const dep = JSON.parse(readFileSync(file, 'utf8')).dependencies?.[PI_PACKAGE];
    if (typeof dep === 'string' && dep.length > 0) return dep;
  } catch { /* missing pin is the repair below */ }
  throw piRuntimeError(os.hostname(), 'daemon checkout ops/pi-runtime/package.json has no @earendil-works/pi-coding-agent pin');
}

async function readPiInstall(hostName: string | undefined, repo: string, platform: NodeJS.Platform): Promise<{ command: string; bin: boolean; version: string | null }> {
  const layout = piRuntimeLayout(repo, platform);
  if (!hostName) {
    let version: string | null = null;
    try {
      const parsed = JSON.parse(readFileSync(layout.installed, 'utf8')).version;
      version = typeof parsed === 'string' ? parsed : null;
    } catch { version = null; }
    return { command: layout.command, bin: existsSync(layout.command), version };
  }
  return readRemotePiInstall(hostName, repo, layout);
}

async function readRemotePiInstall(hostName: string, repo: string, layout: { command: string; installed: string }): Promise<{ command: string; bin: boolean; version: string | null }> {
  let failure: PiProbeTransportError | null = null;
  for (let attempt = 1; attempt <= PI_PROBE_ATTEMPTS; attempt++) {
    if (failure) await new Promise((resolve) => setTimeout(resolve, PI_PROBE_BACKOFF_MS[Math.min(attempt - 2, PI_PROBE_BACKOFF_MS.length - 1)]));
    // remoteProcess: do not EOF stdin; remote-exec treats that as a disconnect and kills the probe.
    // A synchronous throw (unknown host, refused ssh) is a deterministic config error: not retried.
    const child = spawnProvider({ host: hostName, command: 'node', cwd: repo, args: ['-e', PI_INSTALL_PROBE, layout.command, layout.installed] });
    const timer = setTimeout(() => child.kill(), PI_RUNTIME_PROBE_MS);
    try {
      const raw = text(await collect(child, undefined, `pi runtime on ${hostName}`, true));
      try {
        const parsed = JSON.parse(raw) as { bin?: unknown; version?: unknown };
        return { command: layout.command, bin: parsed.bin === true, version: typeof parsed.version === 'string' ? parsed.version : null };
      } catch {
        failure = probeTransportError(hostName, `probe output is not its JSON: ${raw.slice(0, 200)}`);
      }
    } catch (error) {
      failure = probeTransportError(hostName, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
  throw failure!;
}

/** Bin exists and the installed package version equals the pin. Throws before Pi is spawned. */
async function assertPiRuntime(hostName: string | undefined, repo: string, platform: NodeJS.Platform): Promise<string> {
  const pin = pinnedPiVersion();
  const install = await readPiInstall(hostName, repo, platform);
  if (!install.bin || install.version !== pin) {
    throw piRuntimeError(hostName ?? os.hostname(), !install.bin
      ? `bin missing at ${install.command}`
      : `installed ${install.version ?? 'unreadable'}, pin ${pin}`);
  }
  return install.command;
}

function assertLocalMcpAdapter(config: string): void {
  // Reuse the committed stand pin rather than letting stock seats drift behind it.
  const pin: string = JSON.parse(readFileSync(new URL('../../../ab-stand/codex-edit-stand-lock.json', import.meta.url), 'utf8'))
    .packages[''].dependencies['pi-mcp-adapter'];
  let version: unknown;
  try {
    version = JSON.parse(readFileSync(path.join(path.dirname(config), 'npm', 'node_modules', 'pi-mcp-adapter', 'package.json'), 'utf8')).version;
  } catch { /* report the same actionable repair for a missing or malformed manifest */ }
  if (version !== pin) throw new Error(`local pi-mcp-adapter is not pinned (${typeof version === 'string' ? version : 'missing or unreadable'}, expected ${pin}); install npm:pi-mcp-adapter@${pin} in ${path.dirname(config)} before starting seats`);
}

export function piAdapter(family: Family, route: PiRoute): ProviderAdapter {
  async function open(spec: SessionSpec, sessionPath: string | null): Promise<ProviderSession> {
    const provider = typeof route.provider === 'string' ? route.provider : route.provider();
    const host = spec.host ? readHost(spec.host) : null;
    const remote = host ? piHostPaths(host, spec.cwd, sessionPath) : null;
    const env = { ...(route.env?.() ?? {}), ...PI_ENV, ...spec.env, ORCH_SEAT_ACCESS: spec.access,
      ORCH_SEAT_EXPECTED_TOOLS: JSON.stringify(piExpectedTools(spec, spec.model ?? route.defaultModel)) };
    const mcpConfig = piMcpConfigForSeat(spec, host);
    if (!host) assertLocalMcpAdapter(mcpConfig);
    const args = piArgs({ ...route, provider }, spec, remote?.sessionPath ?? sessionPath, remote?.extension, mcpConfig);
    const command = await assertPiRuntime(spec.host, host?.repo ?? piRuntimeRoot(), host?.platform ?? process.platform);
    const child = spawnProvider({ command, args, cwd: remote?.cwd ?? spec.cwd, host: spec.host, ...(remote && spec.seatTool ? { forward: spec.seatTool.url } : {}), env: remote ? piRemoteEnv(env, host!) : env, unset: PI_UNSET });
    const session = new PiSession(family, child);
    try {
      // A win host seat start runs vcvars64 (up to 60 s, remote-exec.mjs) before Pi answers; this bound
      // stays above it so a slow capture fails with the vcvars64 error, not a generic timeout.
      const state = await withTimeout(session.command('get_state'), 75_000);
      // The session FILE is what `--session` takes back, from any cwd.
      session.sessionId = state?.sessionFile ?? '';
      if (!session.sessionId) throw new Error('pi reported no session file (is --no-session set?)');
      session.model = state?.model ? `${state.model.provider}/${state.model.id}` : null;
      // Pi falls back to its settings default instead of failing on a model it
      // cannot resolve, so a wrong provider here is a silent substitution.
      if (state?.model?.provider !== provider) {
        throw new Error(`pi runs ${session.model ?? 'no model'}, not provider ${provider}`);
      }
      // Without the extension a read-only seat has an unguarded bash, and no seat reports what rtk ran.
      const listed = await withTimeout(session.command('get_commands'), 30000);
      if (!listed?.commands?.some((c: any) => c?.name === ORCH_SEAT_COMMAND && c?.source === 'extension')) {
        throw new Error(`pi did not load the orch extension ${PI_EXTENSION}`);
      }
      return session;
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }
  return { start: (spec) => open(spec, null), resume: (spec, sessionPath) => open(spec, sessionPath) };
}
