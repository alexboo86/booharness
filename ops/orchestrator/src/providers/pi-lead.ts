/**
 * The Pi lead provider (task 3459 L0b): the pinned Pi runtime (ops/pi-runtime, the same install
 * and argv the seat adapter builds) in `--mode rpc` as the supervised lead child, so any family
 * with a Pi route can lead a team. The driver still speaks claude stream-json to its children,
 * so the spawned child is the `pi-lead-child.mjs` shim; this file only builds the spawn (route,
 * model, effort, env, `--session <file>` resume — all reused from pi.ts, no second copy) and
 * parses the Pi RPC events the shim forwards into the normalized `LeadProviderEvent`s
 * claude-lead emits. Pi has no permission hook (memory #10739): the tool gate is orch's Pi
 * extension, loaded with `-e` and verified by the shim before any turn runs. Pi does not raise
 * lead_permission cards; the per-lead orch MCP server supplies the lead's orchestration tools.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORCH_SEAT_COMMAND, PI_ENV, PI_UNSET, PI_EXTENSION, assertLocalPiRuntime, piArgs, piExpectedTools, type PiRoute } from './pi.ts';
import type { LeadProvider, LeadProviderEvent, LeadProviderSpawn, LeadProviderSpawnOptions, LeadUsage } from './lead-provider.ts';
import type { Family, SessionSpec } from './types.ts';

/** The shim spawned as the lead child; it runs Pi and speaks both protocol halves. */
const CHILD = fileURLToPath(new URL('./pi-lead-child.mjs', import.meta.url));

/** lead.secretsVeil (task 3459 L3): the extension gate value for one spawn. */
function secretsVeilEnv(on: boolean): string {
  return on ? 'on' : 'off';
}
export type PiLeadProviderOptions = {
  /** The lead's family; only names the route's credentials and defaults. */
  family: Family;
  /** The Pi route (providers/index.ts piRouteFor); the command/env source of truth. */
  route: PiRoute;
  /** Model id; the route default when null. */
  model?: string | null;
  /** `--thinking` effort; the route default when null. */
  effort?: string | null;
  /** The pi binary with its args; tests replace this with a fixture command. */
  command?: string;
  args?: readonly string[];
  /** Extra environment for the child, merged over the guarded provider env. */
  env?: Record<string, string>;
  /** When set, the child carries an `orch` MCP server wired to this per-lead URL (`--mcp-config`
   *  takes a file, so one is written per provider instance under the os tmpdir). */
  mcp?: { url: string };
};

/** One Pi stdout line; fields are read, checked, then used. */
type OutLine = { readonly [key: string]: unknown };
type ToolCall = { name: string; startedAt: number; args: unknown };

export class PiLeadProvider implements LeadProvider {
  /** Pi resumes a session by file: the session id this provider reports is `get_state`'s
   *  sessionFile, and `--session <file>` continues a crashed lead from any cwd (pi.ts). */
  readonly supportsResume = true;
  private readonly family: Family;
  private readonly route: PiRoute;
  private readonly model: string | null;
  private readonly effort: string | null;
  private readonly command: string | undefined;
  private readonly args: readonly string[];
  private readonly env: Record<string, string>;
  private readonly mcpConfig: string | undefined;
  /** Tool calls announced but not ended, for the end event's name, input and duration. */
  private readonly tools = new Map<string, ToolCall>();
  /** Whole text blocks are emitted only when no delta carried them (claude-lead parity). */
  private sawDelta = false;
  /** The last assistant message's text: `agent_settled` closes the turn with it as the result. */
  private lastText = '';
  /** The model's context window from the shim's get_session_stats answers (lesson #10797);
   *  null until one is reported — never invented, and the handover then keeps the flat cap. */
  private contextWindow: number | null = null;
  /** The last usage numbers a message reported (lesson #10797): a window that first arrives or
   *  changes re-emits exactly these numbers with their real window, never new ones. */
  private lastUsage: LeadUsage | null = null;
  /** Between-turn compact requests waiting for the driver's stdin drain. */
  private writes: string[] = [];

  constructor(options: PiLeadProviderOptions) {
    this.family = options.family;
    this.route = options.route;
    this.model = options.model ?? null;
    this.effort = options.effort ?? null;
    this.command = options.command;
    this.args = options.args ?? [];
    this.env = options.env ?? {};
    if (options.mcp) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-pi-lead-'));
      this.mcpConfig = path.join(dir, 'mcp.json');
      writeFileSync(this.mcpConfig, JSON.stringify({ mcpServers: { orch: { type: 'http', url: options.mcp.url } } }));
    }
  }

  buildSpawn(options: LeadProviderSpawnOptions): LeadProviderSpawn {
    const model = this.model ?? this.route.defaultModel;
    const spec: SessionSpec = { family: this.family, cwd: process.cwd(), model, ...(this.effort !== null ? { effort: this.effort } : {}), access: 'full', env: {} };
    // The lead's one Pi command, from the same builder the seats use; the shim wraps it.
    const args = piArgs(this.route, spec, options.resumeSession, PI_EXTENSION, this.mcpConfig);
    const command = this.command ?? assertLocalPiRuntime();
    const provider = typeof this.route.provider === 'string' ? this.route.provider : this.route.provider();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (!PI_UNSET.test(key) && value !== undefined) env[key] = value;
    return {
      argv: [process.execPath, CHILD, command, ...this.args, ...args],
      env: {
        ...env, ...(this.route.env?.() ?? {}), ...PI_ENV, ...this.env,
        ORCH_SEAT_ACCESS: 'full',
        ORCH_SEAT_EXPECTED_TOOLS: JSON.stringify(piExpectedTools(spec, model)),
        // The shim verifies both at child start: a silently substituted provider bills another
        // plan (lesson #10740), and an unloaded extension leaves the lead with no tool gate.
        ORCH_PI_LEAD_PROVIDER: provider,
        // lead.secretsVeil (task 3459 L3): the extension's tool_result veil masks this child's
        // tool results before its model reads them (pi-extension.ts); 'off' is the operator's raw.
        ORCH_PI_LEAD_SECRETS_VEIL: secretsVeilEnv(options.secretsVeil),
        ORCH_PI_LEAD_EXTENSION_COMMAND: ORCH_SEAT_COMMAND,
      },
    };
  }

  /** The shim translates this control line to Pi's compact RPC, not a prompt. */
  compact(): void {
    this.writes.push('{"type":"orch-compact"}');
  }

  takeWrites(): string[] {
    return this.writes.splice(0);
  }

  parseLine(line: string): LeadProviderEvent[] {
    if (!line.trim()) return [];
    let parsed: OutLine;
    try { parsed = JSON.parse(line) as OutLine; } catch { return []; }
    return this.onPiEvent(parsed);
  }

  dispose(): void {
    if (this.mcpConfig) rmSync(path.dirname(this.mcpConfig), { recursive: true, force: true });
  }

  private onPiEvent(event: OutLine): LeadProviderEvent[] {
    switch (event.type) {
      case 'message_start': return this.onMessageStart(event);
      case 'message_update': return this.onMessageUpdate(event);
      case 'message_end': return this.onMessageEnd(event);
      case 'tool_execution_start': return this.onToolStart(event);
      case 'tool_execution_end': return this.onToolEnd(event);
      case 'compaction_end': return [{ kind: 'compaction' }];
      case 'agent_settled': return this.onSettled();
      case 'response': return this.onResponse(event);
      default: return [];
    }
  }

  private onMessageStart(event: OutLine): LeadProviderEvent[] {
    if ((event.message as OutLine | undefined)?.role === 'assistant') this.sawDelta = false;
    return [];
  }

  private onMessageUpdate(event: OutLine): LeadProviderEvent[] {
    const delta = event.assistantMessageEvent as OutLine | undefined;
    if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
      this.sawDelta = true;
      return delta.delta ? [{ kind: 'text_delta', text: delta.delta }] : [];
    }
    if (delta?.type === 'thinking_delta' && typeof delta.delta === 'string') {
      this.sawDelta = true;
      return delta.delta ? [{ kind: 'thinking_delta', text: delta.delta }] : [];
    }
    return [];
  }

  /** `message_end.message` is the authoritative message: usage now, whole blocks only when no
   *  delta carried them, and the text blocks become the settled turn's result. */
  private onMessageEnd(event: OutLine): LeadProviderEvent[] {
    const message = event.message as OutLine | undefined;
    if (message?.role !== 'assistant') return [];
    const blocks = Array.isArray(message.content) ? message.content as OutLine[] : [];
    this.lastText = blockTexts(blocks).join('');
    const events = this.sawDelta ? [] : wholeBlocks(blocks);
    this.sawDelta = false;
    const usage = readUsage(message, this.contextWindow);
    if (usage) {
      // Keep the numbers: a window that arrives later re-emits them with their real window.
      this.lastUsage = usage;
      events.push({ kind: 'usage', usage });
    }
    return events;
  }

  private onToolStart(event: OutLine): LeadProviderEvent[] {
    const id = typeof event.toolCallId === 'string' ? event.toolCallId : '';
    const name = typeof event.toolName === 'string' ? event.toolName : '';
    if (!id || !name) return [];
    this.tools.set(id, { name, startedAt: Date.now(), args: event.args });
    return [{ kind: 'tool_start', tool: { id, name } }];
  }

  private onToolEnd(event: OutLine): LeadProviderEvent[] {
    const id = strField(event.toolCallId);
    if (!id) return [];
    const started = this.tools.get(id);
    this.tools.delete(id);
    const input = toolEndInput(event, started);
    const duration = toolEndDuration(event, started?.startedAt);
    return [{
      kind: 'tool_end',
      tool: {
        id,
        name: strField(event.toolName) || started?.name || '',
        ...(input !== undefined ? { input } : {}),
        ...(duration !== undefined ? { durationMs: duration } : {}),
        isError: event.isError === true,
      },
    }];
  }

  /** The shim's get_session_stats answer carries the context window the handover limit derives
   *  from (lesson #10797). Only a reported positive window is recorded; a failed or empty answer
   *  keeps null and the flat cap — the shim warns once, the lead never fails on it. The answer can
   *  land after its turn closed (a slow first reply), when the usage the driver holds was stamped
   *  without a window; a window that first arrives or changes then re-emits that usage with it, so
   *  the driver re-evaluates the handover. The numbers never change here and no second limit
   *  formula exists: leadLimit decides, exactly as at a turn end. */
  private onSessionStats(event: OutLine): LeadProviderEvent[] {
    const usage = recordOf((event.data as OutLine | undefined)?.contextUsage);
    const window = usage?.contextWindow;
    if (event.success !== true || typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return [];
    if (window === this.contextWindow) return [];
    this.contextWindow = window;
    return this.lastUsage ? [{ kind: 'usage', usage: { ...this.lastUsage, contextWindow: window } }] : [];
  }

  private onSettled(): LeadProviderEvent[] {
    const text = this.lastText;
    this.lastText = '';
    return [{ kind: 'result', text }];
  }

  /** The shim's startup `get_state` answer carries the session file: the driver's session id
   *  and, after a crash, the `--session <file>` the resumed child continues. */
  private onResponse(event: OutLine): LeadProviderEvent[] {
    if (event.command === 'prompt' && event.success === false) {
      return [{ kind: 'fatal', text: `Pi prompt failed: ${strField(event.error) || 'unknown error'}` }];
    }
    if (event.command === 'get_session_stats') return this.onSessionStats(event);
    if (event.command !== 'get_state' || event.success !== true) return [];
    const sessionFile = (event.data as OutLine | undefined)?.sessionFile;
    return typeof sessionFile === 'string' && sessionFile ? [{ kind: 'session', sessionId: sessionFile }] : [];
  }
}

/** Only the end event's `details.orchCommand` says what a bash call actually ran after rtk's
 *  extension rewrote it (lesson #10753); other tools report the args their start announced. */
function toolEndInput(event: OutLine, started: ToolCall | undefined): unknown {
  const base = recordOf(started?.args) ?? {};
  const details = recordOf(recordOf(event.result)?.details);
  const ran = details !== undefined && typeof details.orchCommand === 'string' ? details.orchCommand : undefined;
  if (ran !== undefined) return { ...base, command: ran };
  return Object.keys(base).length ? base : undefined;
}

/** Pi measures the tool's own run with a monotonic clock; the wall-clock fallback covers a stream that omitted it. */
function toolEndDuration(event: OutLine, startedAt: number | undefined): number | undefined {
  if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)) return event.durationMs;
  return startedAt === undefined ? undefined : Math.max(0, Date.now() - startedAt);
}

/** A string field read from an untrusted line, or ''. */
function strField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A plain object field read from an untrusted line, or undefined. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The message's text blocks, in order. */
function blockTexts(blocks: OutLine[]): string[] {
  return blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text as string);
}

/** Whole text/thinking blocks, emitted only when no delta carried them (claude-lead parity). */
function wholeBlocks(blocks: OutLine[]): LeadProviderEvent[] {
  const text = blockTexts(blocks).join('');
  const thinking = blocks.filter((block) => block?.type === 'thinking' && typeof block.thinking === 'string').map((block) => block.thinking as string).join('');
  const events: LeadProviderEvent[] = [];
  if (text) events.push({ kind: 'text', text });
  if (thinking) events.push({ kind: 'thinking', text: thinking });
  return events;
}

/** Pi usage fields → normalized; absent fields stay null, never guessed. */
function readUsage(message: OutLine, contextWindow: number | null): LeadUsage | null {
  const usage = message.usage;
  if (!usage || typeof usage !== 'object') return null;
  const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const mapped: LeadUsage = {
    input: number((usage as OutLine).input),
    cacheRead: number((usage as OutLine).cacheRead),
    cacheCreate: number((usage as OutLine).cacheWrite),
    output: number((usage as OutLine).output),
    contextWindow,
  };
  return mapped.input === null && mapped.cacheRead === null && mapped.cacheCreate === null && mapped.output === null ? null : mapped;
}
