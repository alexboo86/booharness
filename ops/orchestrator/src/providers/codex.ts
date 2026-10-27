// `codex app-server`: codex's own JSON-RPC over stdio (no "jsonrpc" member).
// One process per session: thread/start or thread/resume, then turn/start per
// turn; the turn ends with turn/completed. Types: `codex app-server generate-ts`.
import { JsonRpcPeer, RpcError } from './jsonrpc.ts';
import { spawnProvider } from './spawn.ts';
import { drainNote, settlesWithin, TurnTimeout, withTimeout } from './turn.ts';
import type { ContextUsage, Family, PromptOptions, ProviderAdapter, ProviderSession, SessionSpec, StopReason, TurnResult, Usage } from './types.ts';
import { MCP_SERVERS, type InstrumentKey } from '../shared.entry.ts';

const STOP: Record<string, StopReason> = { completed: 'end_turn', interrupted: 'cancelled', failed: 'error' };

/** codex counts cached input inside inputTokens (OpenAI convention). */
export function codexUsage(last: any): Usage | null {
  if (!last || typeof last.inputTokens !== 'number') return null;
  const cached = typeof last.cachedInputTokens === 'number' ? last.cachedInputTokens : null;
  return {
    inputTokens: cached === null ? last.inputTokens : last.inputTokens - cached,
    cacheReadTokens: cached,
    cacheWriteTokens: typeof last.cacheWriteInputTokens === 'number' ? last.cacheWriteInputTokens : null,
    outputTokens: last.outputTokens ?? 0,
    costUsd: null,
    raw: last,
  };
}

const USAGE_FIELDS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];

// `last` is ONE model call, and a turn with tools makes several: the turn is
// the sum of every `last` it reported (measured 2026-09-22: one codex scout turn
// was 27.7k by `last`, 131.8k by the rollout's total). The thread `total` is not
// used directly because a resumed thread's total also counts earlier turns; it
// only drops a repeated notification.
function addUsage(turn: Turn, tokenUsage: any): void {
  const last = tokenUsage?.last;
  if (!last || typeof last.inputTokens !== 'number') return;
  const total = tokenUsage.total?.totalTokens;
  if (typeof total === 'number') {
    if (total === turn.seenTotal) return;
    turn.seenTotal = total;
  }
  turn.usage ??= {};
  for (const field of USAGE_FIELDS) {
    if (typeof last[field] === 'number') turn.usage[field] = (turn.usage[field] ?? 0) + last[field];
  }
}

/** What a call asked for, without the fields that change as it runs (status, output, timing). */
function callArgs(item: any): unknown {
  const args = { ...item };
  for (const field of ['id', 'type', 'status', 'aggregatedOutput', 'exitCode', 'durationMs', 'processId', 'output', 'result', 'error']) {
    delete args[field];
  }
  return args;
}

/** The main codex worker when a seat names none (operator 2026-09-29, gpt-6.1-sol replaces gpt-6-sol of memory #10512); the CLI's own default is gpt-6-astra. */
export const CODEX_DEFAULT = { model: 'gpt-6.1-sol', effort: 'high' };

function threadSettings(spec: SessionSpec) {
  return {
    cwd: spec.cwd,
    model: spec.model ?? CODEX_DEFAULT.model,
    approvalPolicy: 'never',
    sandbox: spec.access === 'full' ? 'danger-full-access' : 'read-only',
  };
}

// `early` holds every notification that arrives before turn/start answers: with
// the id unknown nothing can be attributed, so they are replayed through the id
// filter once it is known, and another turn's items or completion stay out.
type Turn = { id: string | null; text: string; usage: any; seenTotal?: number; onEvent?: PromptOptions['onEvent']; done: (turn: any) => void; early: Array<[string, any]> };

class CodexSession implements ProviderSession {
  readonly family: Family = 'codex';
  sessionId = '';
  model: string | null = null;
  private peer: JsonRpcPeer;
  private spec: SessionSpec;
  private turn: Turn | null = null;
  private context: ContextUsage | null = null;

  constructor(peer: JsonRpcPeer, spec: SessionSpec) {
    this.peer = peer;
    this.spec = spec;
    peer.onNotification = (method, params) => this.notification(method, params);
    peer.onRequest = (method) => this.request(method);
  }

  get closed(): boolean {
    return this.peer.closed;
  }

  private notification(method: string, params: any): void {
    const turn = this.turn;
    if (!turn || params?.threadId !== this.sessionId) return;
    if (!turn.id) {
      turn.early.push([method, params]);
      return;
    }
    if (params.turnId && params.turnId !== turn.id) return;
    switch (method) {
      case 'item/agentMessage/delta':
        turn.onEvent?.({ kind: 'text', delta: params.delta });
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        turn.onEvent?.({ kind: 'thought', delta: params.delta });
        break;
      case 'item/started':
        if (params.item?.type && params.item.type !== 'agentMessage' && params.item.type !== 'reasoning' && params.item.type !== 'userMessage') {
          turn.onEvent?.({ kind: 'tool', name: params.item.type, status: 'started', args: callArgs(params.item) });
        }
        break;
      case 'item/completed':
        if (params.item?.type === 'agentMessage') turn.text += (turn.text ? '\n\n' : '') + params.item.text;
        break;
      case 'thread/tokenUsage/updated':
        addUsage(turn, params.tokenUsage);
        this.noteContext(params.tokenUsage);
        break;
      case 'turn/completed':
        // turn/completed carries the id inside `turn`, not as `turnId`.
        if (params.turn?.id === turn.id) turn.done(params.turn);
        break;
      default:
        break;
    }
  }

  // approvalPolicy 'never' means codex should not ask; if it does anyway, the
  // seat's access decides, and anything unknown is refused.
  private request(method: string): unknown {
    const allow = this.spec.access === 'full';
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.turn?.onEvent?.({ kind: 'permission', tool: method, decision: allow ? 'allow' : 'reject' });
      return { decision: allow ? 'accept' : 'decline' };
    }
    throw new RpcError(-32601, `orch does not serve ${method}`);
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<TurnResult> {
    const started = Date.now();
    if (this.turn) throw new Error('a turn is already running on this session');
    let finished!: (turn: any) => void;
    const completed = new Promise<any>((resolve) => { finished = resolve; });
    const turn: Turn = { id: null, text: '', usage: null, onEvent: options.onEvent, done: finished, early: [] };
    this.turn = turn;
    let turnStarted = false;
    try {
      const start = this.peer.request('turn/start', {
        threadId: this.sessionId,
        input: [{ type: 'text', text, text_elements: [] }],
        effort: this.spec.effort ?? CODEX_DEFAULT.effort,
      });
      let response: any;
      try {
        response = await withTimeout(start, options.timeoutMs);
      } catch (error) {
        // No turn id to interrupt: the only way to stop it is the process.
        if (error instanceof TurnTimeout) this.peer.kill('turn/start did not answer');
        throw error;
      }
      turn.id = response?.turn?.id ?? null;
      if (!turn.id) {
        // A turn is running that can be neither followed nor interrupted.
        this.peer.kill('turn/start answered without a turn id');
        throw new Error('turn/start answered without a turn id');
      }
      turnStarted = true;
      for (const [method, params] of turn.early.splice(0)) this.notification(method, params);
      const closed = this.peer.whenClosed.then((reason) => { throw reason; });
      const final: any = await withTimeout(Promise.race([completed, closed]), options.timeoutMs);
      const raw: string | null = final?.status ?? null;
      return {
        text: turn.text,
        stopReason: STOP[raw ?? ''] ?? 'other',
        rawStopReason: raw,
        usage: codexUsage(turn.usage),
        error: final?.error?.message ?? null,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      let message = (error as Error).message;
      if (error instanceof TurnTimeout && turnStarted) {
        // Wait for this turn's own turn/completed before the session is reused.
        await this.cancel();
        const drained = await settlesWithin(Promise.race([completed, this.peer.whenClosed]));
        const exited = this.peer.closed;
        if (!drained) this.peer.kill('turn did not stop after interrupt');
        message = `${message}; ${drainNote(drained, exited)}`;
      }
      return { text: turn.text, stopReason: 'error', rawStopReason: null, usage: null, error: message, durationMs: Date.now() - started };
    } finally {
      this.turn = null;
    }
  }

  /** `last` is the latest model call: its tokens are what the context holds now. */
  private noteContext(tokenUsage: any): void {
    const tokens = tokenUsage?.last?.totalTokens;
    const window = tokenUsage?.modelContextWindow;
    if (typeof tokens === 'number' && typeof window === 'number' && window > 0) this.context = { tokens, window };
  }

  async contextUsage(): Promise<ContextUsage | null> {
    return this.context;
  }

  async steer(text: string): Promise<void> {
    const turnId = this.turn?.id;
    if (!turnId) throw new Error('no running turn to steer');
    await this.peer.request('turn/steer', { threadId: this.sessionId, input: [{ type: 'text', text, text_elements: [] }], expectedTurnId: turnId });
  }

  async cancel(): Promise<void> {
    const turnId = this.turn?.id;
    if (!turnId || this.peer.closed) return;
    await this.peer.request('turn/interrupt', { threadId: this.sessionId, turnId }).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.peer.kill();
  }
}

async function open(spec: SessionSpec, resumeId: string | null): Promise<ProviderSession> {
  // orch's MCP is in ~/.codex/config.toml for a Codex-desktop lead; a worker seat must not create or steer seats.
  // An instrument the seat turned off (task 1452) disables its server the same per-process way.
  const disabled = ['orch', ...(spec.instrumentsOff ?? []).flatMap((key) => MCP_SERVERS[key as InstrumentKey] ?? [])];
  const args = ['app-server', ...disabled.flatMap((server) => ['-c', `mcp_servers.${server}.enabled=false`])];
  const child = spawnProvider({ command: 'codex', args, cwd: spec.cwd, env: spec.env });
  const peer = new JsonRpcPeer(child, { withVersion: false });
  const session = new CodexSession(peer, spec);
  try {
    await peer.request('initialize', { clientInfo: { name: 'orch', title: null, version: '0.1.0' }, capabilities: null });
    peer.notify('initialized');
    const response: any = resumeId === null
      ? await peer.request('thread/start', threadSettings(spec))
      : await peer.request('thread/resume', { threadId: resumeId, ...threadSettings(spec) });
    session.sessionId = response.thread.id;
    session.model = response.model ?? null;
    return session;
  } catch (error) {
    peer.kill();
    throw error;
  }
}

export const codexAdapter: ProviderAdapter = { start: (spec) => open(spec, null), resume: (spec, id) => open(spec, id) };
