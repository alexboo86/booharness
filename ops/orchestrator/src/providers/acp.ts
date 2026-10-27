// Agent Client Protocol (JSON-RPC 2.0 over stdio), spoken natively by grok
// (`grok agent stdio`), kimi (`kimi acp`) and opencode (`opencode acp`).
// orch advertises no fs or terminal capability, so the agent uses its own tools
// and orch only answers permission requests.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonRpcPeer, RpcError } from './jsonrpc.ts';
import { spawnProvider } from './spawn.ts';
import { drainNote, settlesWithin, TurnTimeout, withTimeout } from './turn.ts';
import type { Access, Family, PromptOptions, ProviderAdapter, ProviderSession, SessionSpec, StopReason, TurnEvent, TurnResult, Usage } from './types.ts';

export type AcpLaunch = {
  command: string;
  /** Arguments for this spec; model/effort go here when the CLI takes them as flags. */
  args: (spec: SessionSpec) => string[];
  /** Process-only provider credentials/settings; never persisted by orch. */
  env?: (spec: SessionSpec) => Record<string, string>;
  /** Resolve model/effort to a native model id; consumes effort instead of setting thought_level. */
  model?: (spec: SessionSpec) => string;
  /** Apply model/effort through the session's config options after new/resume. */
  configOptions: boolean;
  /**
   * The session mode (config option category 'mode') each access level needs.
   * Measured 2026-09-22: opencode's default `build` mode writes without asking,
   * so read-only must switch to `plan`; a global yolo setting must not leak in.
   */
  modes?: Record<Access, string>;
  /**
   * The turn's usage from the agent's own records, for an agent whose ACP answer
   * does not carry the whole turn; null when the records cannot say.
   */
  turnUsage?: (sessionId: string, sinceMs: number) => Promise<Usage | null>;
  /** Sum per-model-call agent_message_chunk._meta.usage (opt-in, measured for Qwen). */
  streamedMessageUsage?: boolean;
  /** Qwen/MiMo announce empty input, then supply it in tool_call_update. */
  deferredToolInput?: boolean;
};

const READ_KINDS = new Set(['read', 'search', 'think', 'fetch']);
const STOP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  cancelled: 'cancelled',
  max_tokens: 'max_tokens',
  max_turn_requests: 'max_tokens',
  refusal: 'refusal',
};

/** Pick the permission option the seat's access allows; null means reject outright. */
export function choosePermission(access: Access, toolKind: string | undefined, options: Array<{ optionId: string; kind: string }>): { optionId: string; allow: boolean } | null {
  const allow = access === 'full' || READ_KINDS.has(toolKind ?? '');
  const order = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of order) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return { optionId: option.optionId, allow };
  }
  return null;
}

// ACP cost reports (usage_update.cost, grok costUsdTicks) have no documented per-turn
// meaning, so costUsd stays null here rather than a guessed number.
// ACP leaves open whether inputTokens includes cache reads; the agent's own
// totalTokens decides it (opencode: input+output+cached, grok: input+output).
// Without a total that settles it, the input stays whole and cacheRead is null.
export function usageOf(result: any): Usage | null {
  const usage = result?.usage ?? result?._meta?.usage;
  if (!usage || typeof usage.inputTokens !== 'number') return null;
  const input: number = usage.inputTokens;
  const output: number = usage.outputTokens ?? 0;
  const cached: number | null = typeof usage.cachedReadTokens === 'number' ? usage.cachedReadTokens : null;
  const write: number | null = typeof usage.cacheCreationTokens === 'number' ? usage.cacheCreationTokens : null;
  const total = usage.totalTokens;
  let inputTokens = input;
  let cacheReadTokens: number | null = null;
  if (cached === null || cached === 0) {
    cacheReadTokens = cached;
  } else if (total === input + output + cached) {
    cacheReadTokens = cached;
  } else if (total === input + output) {
    inputTokens = input - cached;
    cacheReadTokens = cached;
  }
  return { inputTokens, cacheReadTokens, cacheWriteTokens: write, outputTokens: output, costUsd: null, raw: usage };
}

function sumMessageUsage(usages: Usage[]): Usage | null {
  if (!usages.length) return null;
  const sumKnown = (key: 'cacheReadTokens' | 'cacheWriteTokens') => usages.some((usage) => usage[key] === null)
    ? null : usages.reduce((total, usage) => total + (usage[key] ?? 0), 0);
  return {
    inputTokens: usages.reduce((total, usage) => total + usage.inputTokens, 0),
    cacheReadTokens: sumKnown('cacheReadTokens'),
    cacheWriteTokens: sumKnown('cacheWriteTokens'),
    outputTokens: usages.reduce((total, usage) => total + usage.outputTokens, 0),
    costUsd: null,
    raw: usages.map((usage) => usage.raw),
  };
}

/**
 * opencode answers session/prompt with the usage of its LAST assistant message
 * only (opencode 1.18.31, `.at(-1)` in its ACP agent), so a turn with tool calls
 * is undercounted: measured 2026-09-22, 23.5k reported against 69.2k in its own
 * session. `opencode export` has every message; the turn is the assistant
 * messages created since it began.
 */
export function opencodeExportUsage(exported: string, sinceMs: number): Usage | null {
  const start = exported.indexOf('{');
  if (start < 0) return null;
  const messages: any[] = JSON.parse(exported.slice(start)).messages ?? [];
  const turn = messages.filter((message) => message?.info?.role === 'assistant' && message.info.tokens && message.info.time?.created >= sinceMs);
  // Right after session/prompt answers, opencode may not have finished writing
  // the last message; its tokens are final only once it is completed.
  if (!turn.length || turn.some((message) => !message.info.time?.completed)) return null;
  const sum = (pick: (tokens: any) => number | undefined) => turn.reduce((total, message) => total + (pick(message.info.tokens) ?? 0), 0);
  return {
    inputTokens: sum((tokens) => tokens.input),
    cacheReadTokens: sum((tokens) => tokens.cache?.read),
    cacheWriteTokens: sum((tokens) => tokens.cache?.write),
    outputTokens: sum((tokens) => tokens.output),
    costUsd: null,
    raw: turn.map((message) => message.info.tokens),
  };
}

/**
 * Default mapping of tool_call/tool_call_update: only the call forwards rawInput once;
 * its updates would count the same call again, so an update with no status of its own is 'updated',
 * never the 'pending' that counts a new call (review 2026-09-23: one call counted twice).
 */
export function acpToolEvent(update: any): Extract<TurnEvent, { kind: 'tool' }> {
  const call = update.sessionUpdate === 'tool_call';
  return { kind: 'tool', name: update.title ?? update.toolCallId ?? 'tool', status: update.status ?? (call ? 'pending' : 'updated'), args: call ? update.rawInput : undefined };
}

class AcpSession implements ProviderSession {
  readonly family: Family;
  sessionId = '';
  model: string | null = null;
  private peer: JsonRpcPeer;
  private spec: SessionSpec;
  private text = '';
  private messageUsages: Usage[] = [];
  private toolCalls = new Map<string, { name: string; args: unknown; emitted: boolean }>();
  private onEvent: PromptOptions['onEvent'];
  private busy = false;
  capabilities: any = {};

  private launch: AcpLaunch;

  constructor(family: Family, peer: JsonRpcPeer, spec: SessionSpec, launch: AcpLaunch) {
    this.family = family;
    this.peer = peer;
    this.spec = spec;
    this.launch = launch;
    peer.onNotification = (method, params) => this.notification(method, params);
    peer.onRequest = (method, params) => this.request(method, params);
  }

  get closed(): boolean {
    return this.peer.closed;
  }

  private notification(method: string, params: any): void {
    if (method !== 'session/update' || params?.sessionId !== this.sessionId) return;
    const update = params.update ?? {};
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (this.busy && this.launch.streamedMessageUsage && update._meta?.usage) {
          const usage = usageOf(update);
          if (usage) this.messageUsages.push(usage);
        }
        if (update.content?.type === 'text') {
          this.text += update.content.text;
          this.onEvent?.({ kind: 'text', delta: update.content.text });
        }
        break;
      case 'agent_thought_chunk':
        if (update.content?.type === 'text') this.onEvent?.({ kind: 'thought', delta: update.content.text });
        break;
      case 'tool_call':
      case 'tool_call_update':
        this.toolEvent(update);
        break;
      default:
        break;
    }
  }

  private toolEvent(update: { sessionUpdate?: string; toolCallId?: string; title?: string; status?: string; rawInput?: unknown }): void {
    const event = acpToolEvent(update);
    if (!this.launch.deferredToolInput || typeof update.toolCallId !== 'string') {
      this.onEvent?.(event);
      return;
    }
    if (typeof update.toolCallId === 'string') {
      let call = this.toolCalls.get(update.toolCallId);
      if (!call) {
        call = { name: update.title ?? update.toolCallId, args: undefined, emitted: false };
        this.toolCalls.set(update.toolCallId, call);
      }
      if (update.rawInput !== undefined) call.args = update.rawInput;
      const hasInput = call.args !== undefined && call.args !== null
        && (typeof call.args !== 'object' || Object.keys(call.args).length > 0);
      // Keep the original tool name: Qwen's later title embeds the arguments,
      // and MiMo's completion title may be a path or a description.
      // Still-empty calls count at turn end, allowing input after completion.
      if (!call.emitted && hasInput) {
        call.emitted = true;
        this.onEvent?.({ kind: 'tool', name: call.name, status: 'pending', args: call.args });
      }
    }
    // Only the event above counts, even if an update repeats pending/started.
    this.onEvent?.({ ...event, args: undefined, status: event.status === 'pending' || event.status === 'started' ? 'updated' : event.status });
  }

  private request(method: string, params: any): unknown {
    if (method === 'session/request_permission') {
      const choice = choosePermission(this.spec.access, params?.toolCall?.kind, params?.options ?? []);
      this.onEvent?.({ kind: 'permission', tool: params?.toolCall?.title ?? params?.toolCall?.kind ?? 'tool', decision: choice?.allow ? 'allow' : 'reject' });
      return choice ? { outcome: { outcome: 'selected', optionId: choice.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    throw new RpcError(-32601, `orch does not serve ${method}`);
  }

  async applyConfig(response: any, launch: AcpLaunch = this.launch): Promise<void> {
    this.model = response?.models?.currentModelId ?? null;
    let options: any[] = response?.configOptions ?? [];
    const current = (category: string) => options.find((option) => option.category === category);
    if (options.length) this.model = current('model')?.currentValue ?? this.model;
    if (!launch.configOptions) return;
    const wanted: Array<[string, string | undefined]> = [['model', this.spec.model], ['thought_level', this.spec.effort], ['mode', launch.modes?.[this.spec.access]]];
    for (const [category, value] of wanted) {
      if (value === undefined) continue;
      const option = current(category);
      if (!option) throw new Error(`${this.family} offers no '${category}' option to set '${value}'`);
      if (!option.options?.some((candidate: any) => candidate.value === value)) {
        throw new Error(`${this.family} ${category} '${value}' is not one of: ${option.options.map((candidate: any) => candidate.value).join(', ')}`);
      }
      if (option.currentValue === value) continue;
      const result = await this.peer.request('session/set_config_option', { sessionId: this.sessionId, configId: option.id, value });
      options = result?.configOptions ?? options.map((candidate) => (candidate.id === option.id ? { ...candidate, currentValue: value } : candidate));
    }
    this.model = current('model')?.currentValue ?? this.model;
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<TurnResult> {
    const started = Date.now();
    // ACP updates carry no turn id: one turn at a time keeps text and events apart.
    if (this.busy) throw new Error('a turn is already running on this session');
    this.busy = true;
    this.text = '';
    this.messageUsages = [];
    this.toolCalls.clear();
    this.onEvent = options.onEvent;
    const request = this.peer.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] });
    try {
      const result: any = await withTimeout(request, options.timeoutMs);
      const raw = typeof result?.stopReason === 'string' ? result.stopReason : null;
      const usage = this.launch.turnUsage ? await this.launch.turnUsage(this.sessionId, started)
        : this.launch.streamedMessageUsage ? sumMessageUsage(this.messageUsages) : usageOf(result);
      return { text: this.text, stopReason: STOP[raw ?? ''] ?? 'other', rawStopReason: raw, usage, error: null, durationMs: Date.now() - started };
    } catch (error) {
      let message = (error as Error).message;
      if (error instanceof TurnTimeout) {
        // The agent answers the cancelled prompt after its last update for it.
        await this.cancel();
        const drained = await settlesWithin(request);
        const exited = this.peer.closed;
        if (!drained) this.peer.kill('turn did not stop after cancel');
        message = `${message}; ${drainNote(drained, exited)}`;
      }
      return { text: this.text, stopReason: 'error', rawStopReason: null, usage: this.launch.streamedMessageUsage ? sumMessageUsage(this.messageUsages) : null, error: message, durationMs: Date.now() - started };
    } finally {
      for (const call of this.toolCalls.values()) {
        if (call.emitted) continue;
        call.emitted = true;
        this.onEvent?.({ kind: 'tool', name: call.name, status: 'pending', args: call.args });
      }
      this.busy = false;
      this.onEvent = undefined;
      this.toolCalls.clear();
    }
  }

  async cancel(): Promise<void> {
    this.peer.notify('session/cancel', { sessionId: this.sessionId });
  }

  async close(): Promise<void> {
    if (!this.peer.closed && this.capabilities?.sessionCapabilities?.close && this.sessionId) {
      await Promise.race([
        this.peer.request('session/close', { sessionId: this.sessionId }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    this.peer.kill();
  }
}

export function acpAdapter(family: Family, launch: AcpLaunch): ProviderAdapter {
  async function open(spec: SessionSpec, resumeId: string | null): Promise<ProviderSession> {
    const args = launch.args(spec);
    if (launch.model) spec = { ...spec, model: launch.model(spec), effort: undefined };
    const child: ChildProcessWithoutNullStreams = spawnProvider({ command: launch.command, args, cwd: spec.cwd, env: { ...spec.env, ...launch.env?.(spec) } });
    const peer = new JsonRpcPeer(child);
    const session = new AcpSession(family, peer, spec, launch);
    try {
      const init: any = await peer.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'orch', version: '0.1.0' },
      });
      session.capabilities = init?.agentCapabilities ?? {};
      let response: any;
      if (resumeId === null) {
        response = await peer.request('session/new', { cwd: spec.cwd, mcpServers: [] });
        session.sessionId = response.sessionId;
      } else {
        session.sessionId = resumeId;
        const caps = session.capabilities;
        if (caps.sessionCapabilities?.resume) response = await peer.request('session/resume', { sessionId: resumeId, cwd: spec.cwd, mcpServers: [] });
        else if (caps.loadSession) response = await peer.request('session/load', { sessionId: resumeId, cwd: spec.cwd, mcpServers: [] });
        else throw new Error(`${family} can neither resume nor load a session`);
      }
      await session.applyConfig(response, launch);
      return session;
    } catch (error) {
      peer.kill();
      throw error;
    }
  }
  return { start: (spec) => open(spec, null), resume: (spec, sessionId) => open(spec, sessionId) };
}
