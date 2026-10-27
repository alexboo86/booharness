// Claude Code in print mode with stream-json on both pipes: one long-lived
// process per session, one user message per turn, a `result` message per turn.
// The glm family is the same CLI pointed at Z.AI's Anthropic-compatible API.
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLines, spawnProvider, stderrTail } from './spawn.ts';
import { span } from '../shared.entry.ts';
import { drainNote, settlesWithin, TurnTimeout, withTimeout } from './turn.ts';
import type { ContextUsage, Family, PromptOptions, ProviderAdapter, ProviderSession, SessionSpec, StopReason, TurnResult, Usage } from './types.ts';
import { MCP_SERVERS, type InstrumentKey } from '../shared.entry.ts';
import { SEAT_MCP_PATH, SEAT_MCP_SERVER } from '../shared.entry.ts';
import { SKILL_INSTALL_DENY } from '../seat-guard.ts';

const STOP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

type WorkerMcp = { file: string; dir: string; names: string[]; operatorNames: string[] };

const OPERATOR_MCP = fileURLToPath(new URL('../../../bootstrap/mcp-servers.operator.json', import.meta.url));
const WORKER_MCP_KEYS = ['codegraph', 'memory'] as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function workerMcp(spec: SessionSpec, operatorPath: string): WorkerMcp {
  // The operator list is mandatory even when every instrument is off: a missing
  // list must never remove the defense-in-depth deny on operator-only tools. An empty
  // `servers` object is valid: a project with no operator-only server (the kit).
  const operator = JSON.parse(readFileSync(operatorPath, 'utf8')) as unknown;
  if (!object(operator) || !object(operator.servers)) throw new Error(`invalid operator MCP list: ${operatorPath}`);
  const operatorNames = Object.keys(operator.servers);
  if (operatorNames.some((name) => !name || name === 'orch')) throw new Error(`invalid operator MCP names: ${operatorPath}`);
  const names = WORKER_MCP_KEYS.filter((key) => !spec.instrumentsOff?.includes(key)).flatMap((key) => MCP_SERVERS[key]);
  if (names.some((name) => operatorNames.includes(name) || name === 'orch')) throw new Error('worker MCP conflicts with operator-only or orch server');
  const servers: Record<string, unknown> = {};
  if (names.length) {
    const configDir = spec.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
    const source = configDir
      ? path.join(configDir, '.claude.json')
      : path.join(spec.env?.HOME ?? os.homedir(), '.claude.json');
    const global = JSON.parse(readFileSync(source, 'utf8')) as unknown;
    if (!object(global) || !object(global.mcpServers)) throw new Error(`invalid Claude MCP config: ${source}`);
    for (const name of names) {
      const entry = global.mcpServers[name];
      if (!object(entry) || typeof entry.command !== 'string' || !entry.command ||
          !Array.isArray(entry.args) || !entry.args.every((arg: unknown) => typeof arg === 'string') ||
          (entry.env !== undefined && (!object(entry.env) || Object.values(entry.env).some((v) => typeof v !== 'string')))) {
        throw new Error(`missing or invalid worker MCP '${name}' in ${source}`);
      }
      servers[name] = entry;
    }
  }
  // orch's seat endpoint (scout-request.ts): the seat's only orch tool, under a
  // server name that is not `orch`, so the mcp__orch deny below still holds.
  if (spec.seatTool) {
    if (operatorNames.includes(SEAT_MCP_SERVER) || names.includes(SEAT_MCP_SERVER)) throw new Error(`seat MCP name '${SEAT_MCP_SERVER}' conflicts`);
    servers[SEAT_MCP_SERVER] = { type: 'http', url: `${spec.seatTool.url}${SEAT_MCP_PATH}`, headers: { Authorization: `Bearer ${spec.seatTool.token}` } };
    names.push(SEAT_MCP_SERVER);
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-claude-mcp-'));
  const file = path.join(dir, 'worker.json');
  try {
    writeFileSync(file, `${JSON.stringify({ mcpServers: servers })}\n`, { mode: 0o600 });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { file, dir, names, operatorNames };
}

export function claudeArgs(spec: SessionSpec, session: { id: string; resume: boolean }, mcp?: WorkerMcp): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  // Read-only is plan mode, not `default`: the operator's global allow rules
  // (Bash(rtk *), cargo build, ...) would still run writes under `default`.
  args.push('--permission-mode', spec.access === 'full' ? 'bypassPermissions' : 'plan');
  if (spec.model) args.push('--model', spec.model);
  if (spec.effort) args.push('--effort', spec.effort);
  // orch's own MCP is registered globally for the lead; a worker seat must not
  // create or steer seats. A deny rule holds under bypassPermissions too.
  // mcp__<server> denies the whole server: the instrument override (task 1452)
  // turns a seat's MCP-surfaced instruments off here for a native seat.
  const denied = ['mcp__orch', ...(mcp?.operatorNames ?? []).map((name) => `mcp__${name}`)];
  for (const key of spec.instrumentsOff ?? []) for (const server of MCP_SERVERS[key as InstrumentKey] ?? []) denied.push(`mcp__${server}`);
  // Only the lead installs skills (task 1566): the Pi seats' guard as deny rules.
  denied.push(...SKILL_INSTALL_DENY);
  args.push('--disallowedTools', ...denied);
  if (mcp) args.push('--mcp-config', mcp.file, '--strict-mcp-config');
  // Strict MCP config does not exclude plugin MCPs. Clear settings as well as
  // the process env below: either source alone can still load operator mods.
  args.push('--settings', JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: '' } }));
  args.push(session.resume ? '--resume' : '--session-id', session.id);
  return args;
}

/**
 * `usage` is per turn; `total_cost_usd` is the SESSION's running total, carried
 * across --resume (measured 2026-09-22: 0.2216 then 0.4381 after a resume).
 * A resumed process does not know the total it starts from, so its first turn
 * has costUsd null (costBefore null) rather than the whole session's cost.
 */
export function claudeUsage(result: any, costBefore: number | null): { usage: Usage | null; costAfter: number | null } {
  const costAfter = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : costBefore;
  const usage = result?.usage;
  if (!usage || typeof usage.input_tokens !== 'number') return { usage: null, costAfter };
  return {
    usage: {
      inputTokens: usage.input_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? null,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
      outputTokens: usage.output_tokens ?? 0,
      costUsd: typeof result?.total_cost_usd === 'number' && costBefore !== null ? Number((result.total_cost_usd - costBefore).toFixed(8)) : null,
      raw: usage,
    },
    costAfter,
  };
}

type Turn = { resolve: (result: any) => void; reject: (error: Error) => void; text: string; onEvent?: PromptOptions['onEvent'] };

class ClaudeSession implements ProviderSession {
  readonly family: Family;
  readonly sessionId: string;
  model: string | null = null;
  private child: ChildProcessWithoutNullStreams;
  private stderr: () => string;
  private turn: Turn | null = null;
  private cost: number | null;
  private exited: Error | null = null;
  private controlId = 0;

  private reportsCost: boolean;
  private mcpExpected: readonly string[] | null;
  private mcpVerified = false;
  /** The context of the last model call (input + cache), and the window the last result reported. */
  private contextTokens: number | null = null;
  private contextWindow: number | null = null;

  constructor(family: Family, child: ChildProcessWithoutNullStreams, sessionId: string, resumed: boolean, reportsCost: boolean, mcpExpected: readonly string[] | null = null) {
    this.mcpExpected = mcpExpected;
    this.cost = resumed ? null : 0;
    this.reportsCost = reportsCost;
    this.family = family;
    this.child = child;
    this.sessionId = sessionId;
    this.stderr = stderrTail(child);
    readLines(child.stdout, (line) => this.receive(line), 'claude stdout');
    const fail = (error: Error) => {
      if (this.exited) return;
      this.exited = error;
      this.turn?.reject(error);
      this.turn = null;
    };
    child.on('error', fail);
    child.on('exit', (code, signal) => span('claude exit', () => {
      const tail = this.stderr();
      fail(new Error(`claude exited (${signal ?? code})${tail ? `: ${tail}` : ''}`));
    }));
    child.stdin.on('error', fail);
  }

  get closed(): boolean {
    return this.exited !== null;
  }

  private receive(line: string): void {
    if (this.exited) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === 'system' && message.subtype === 'init') {
      if (this.mcpExpected !== null) {
        const actual = message.mcp_servers;
        const expected = [...this.mcpExpected].sort();
        const names = Array.isArray(actual) ? actual.map((entry: unknown) => object(entry) && entry.status === 'connected' ? entry.name : null) : null;
        if (!names || names.some((name) => typeof name !== 'string') ||
            JSON.stringify([...names].sort()) !== JSON.stringify(expected)) {
          const error = new Error(`Claude worker MCP init mismatch: expected ${expected.join(',')}, received ${Array.isArray(names) ? names.join(',') : 'no server list'}`);
          this.exited = error;
          this.turn?.reject(error);
          this.turn = null;
          this.child.kill();
          return;
        }
        this.mcpVerified = true;
      }
      this.model = message.model ?? this.model;
      return;
    }
    const turn = this.turn;
    if (!turn) return;
    if (message.type === 'assistant') {
      const usage = message.message?.usage;
      if (typeof usage?.input_tokens === 'number') {
        this.contextTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        // Live usage per assistant message, as Pi's message_end does: the seats'
        // token cap watches it (seats.ts), not only the turn's final result.
        turn.onEvent?.({ kind: 'usage', tokens: this.contextTokens + (usage.output_tokens ?? 0) });
      }
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text') {
          turn.text += block.text;
          turn.onEvent?.({ kind: 'text', delta: block.text });
        } else if (block.type === 'thinking') {
          turn.onEvent?.({ kind: 'thought', delta: block.thinking ?? '' });
        } else if (block.type === 'tool_use') {
          turn.onEvent?.({ kind: 'tool', name: block.name, status: 'started', args: block.input });
        }
      }
      return;
    }
    if (message.type === 'result') {
      if (this.mcpExpected !== null && !this.mcpVerified) {
        const error = new Error('Claude worker did not confirm its MCP configuration in system/init');
        this.exited = error;
        this.turn = null;
        turn.reject(error);
        this.child.kill();
        return;
      }
      const windows = Object.values(message.modelUsage ?? {}).map((entry: any) => entry?.contextWindow).filter((value) => typeof value === 'number' && value > 0) as number[];
      if (windows.length) this.contextWindow = Math.max(...windows);
      this.turn = null;
      turn.resolve(message);
    }
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<TurnResult> {
    const started = Date.now();
    if (this.exited) return { text: '', stopReason: 'error', rawStopReason: null, usage: null, error: this.exited.message, durationMs: 0 };
    if (this.turn) throw new Error('a turn is already running on this session');
    let turn!: Turn;
    const done = new Promise<any>((resolve, reject) => {
      turn = { resolve, reject, text: '', onEvent: options.onEvent };
    });
    this.turn = turn;
    this.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
    try {
      const result = await withTimeout(done, options.timeoutMs);
      const { usage, costAfter } = claudeUsage(result, this.cost);
      this.cost = costAfter;
      if (usage && !this.reportsCost) usage.costUsd = null;
      const raw: string | null = result.stop_reason ?? null;
      const failed = result.is_error === true || (result.subtype && result.subtype !== 'success');
      return {
        text: typeof result.result === 'string' && result.result ? result.result : turn.text,
        stopReason: failed ? 'error' : STOP[raw ?? ''] ?? 'other',
        rawStopReason: raw ?? result.subtype ?? null,
        usage,
        error: failed ? String(result.result || result.subtype || 'error') : null,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      let message = (error as Error).message;
      if (error instanceof TurnTimeout) {
        // The interrupted turn still ends with its own `result`; the turn stays
        // current until then, so that result cannot close the next turn.
        await this.cancel();
        const drained = await settlesWithin(done);
        const exited = this.exited !== null;
        if (!drained) {
          // Dead from this moment, not from the exit event: a late result is never read.
          this.exited = new Error('closed by orch: turn did not stop after interrupt');
          this.turn = null;
          this.child.kill();
        }
        message = `${message}; ${drainNote(drained, exited)}`;
      }
      return { text: turn.text, stopReason: 'error', rawStopReason: null, usage: null, error: message, durationMs: Date.now() - started };
    }
  }

  // No steer: how stream-json treats a user message written mid-turn is unverified (a second
  // `result` would end this turn early), so orch's watch interrupts a claude seat instead.
  async contextUsage(): Promise<ContextUsage | null> {
    return this.contextTokens !== null && this.contextWindow !== null ? { tokens: this.contextTokens, window: this.contextWindow } : null;
  }

  async cancel(): Promise<void> {
    if (this.exited) return;
    this.controlId += 1;
    this.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `orch-${this.controlId}`, request: { subtype: 'interrupt' } })}\n`);
  }

  async close(): Promise<void> {
    if (this.exited) return;
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
}

// `costUsd: false` for glm: the CLI prices every turn at Claude rates, so its
// total_cost_usd for a Z.AI model is not a cost anyone pays.
export function claudeAdapter(family: Family, { env = () => ({}), defaultModel, costUsd = true, operatorListPath = OPERATOR_MCP }: { env?: () => Record<string, string>; defaultModel?: string; costUsd?: boolean; operatorListPath?: string } = {}): ProviderAdapter {
  function open(given: SessionSpec, id: string, resume: boolean): ProviderSession {
    const spec = { ...given, model: given.model ?? defaultModel };
    // Inherited ANTHROPIC_* (a host proxy URL, a launchd API key) would pick the
    // endpoint and the bill; claude uses its own login, glm brings its own env.
    // glm runs this same CLI on the same home, so it gets the same isolation.
    const mcp = workerMcp(spec, operatorListPath);
    try {
      const child = spawnProvider({ command: 'claude', args: claudeArgs(spec, { id, resume }, mcp), cwd: spec.cwd, env: { ...env(), ...spec.env, CLAUDE_CODE_PLUGIN_DIRS: '' }, unset: /^(ANTHROPIC_|ORCH_SEAT_TOKEN$|ORCH_SEAT_TOOL_URL$)/ });
      const cleanup = () => rmSync(mcp.dir, { recursive: true, force: true });
      child.once('exit', cleanup);
      child.once('error', cleanup);
      return new ClaudeSession(family, child, id, resume, costUsd, mcp.names);
    } catch (error) {
      rmSync(mcp.dir, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    start: async (spec) => open(spec, randomUUID(), false),
    resume: async (spec, sessionId) => open(spec, sessionId, true),
  };
}
