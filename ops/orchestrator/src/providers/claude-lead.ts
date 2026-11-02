/**
 * The claude lead provider (task 3459): `claude -p --input-format stream-json --output-format
 * stream-json --include-partial-messages --verbose`, one session surviving turn boundaries; a
 * crashed one continues with `--resume <session>` (probe 2026-10-30, decision 22394). This file
 * moved the protocol half of `lead-driver.ts` unchanged in effect: same argv, same env, same
 * event order for every line today's fixtures carry; usage and compaction lines that were
 * previously read but discarded now normalize to events.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LeadPermissionMode, LeadProvider, LeadProviderEvent, LeadProviderSpawn, LeadProviderSpawnOptions, LeadUsage } from './lead-provider.ts';

/** The claude stream-json flags; partial messages let deltas arrive as content_block_delta. */
const STREAM_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'] as const;

/**
 * claude reads `CLAUDE_CODE_ENTRYPOINT` (observed in the installed cli: print mode rewrites it to
 * `sdk-cli`); orch's lead scan counts an interactive-looking entrypoint as a person
 * (ops/orchestrator/src/leads.ts claudeInteractive). Setting it explicitly keeps these supervised
 * children out of the desktop-lead count on every version.
 */
const ENTRYPOINT_ENV = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };

/** The vendored secrets-veil plugin (task 3459 L3; VENDOR.json pins its files). */
const SECRETS_VEIL_DIR = fileURLToPath(new URL('../../../claude-mods/secrets-veil', import.meta.url));

/** The child's plugin dirs: the inherited list plus secrets-veil, listed once. The engine loads a
 *  directory once per listing, and double-listing loads the mod twice (ops-claude-mods invariants). */
function withSecretsVeil(dirs: string | undefined): string {
  const list = (dirs ?? '').split(path.delimiter).filter(Boolean);
  const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  return (list.some((dir) => same(path.resolve(dir), path.resolve(SECRETS_VEIL_DIR))) ? list : [...list, SECRETS_VEIL_DIR]).join(path.delimiter);
}

/** One line of claude's stream-json output; fields are read, never trusted. */
type OutLine = { readonly [key: string]: unknown };

type ToolCall = { name: string; startedAt: number; json: string; announced: boolean };

export type ClaudeLeadProviderOptions = {
  /** The claude binary to run; tests replace this with a fixture command. */
  command?: string;
  /** Extra arguments before the stream-json flags. */
  baseArgs?: readonly string[];
  /** Extra environment for the child, merged over the daemon's. */
  env?: Record<string, string>;
  /** When set, the child carries orch's permission tool wired to this per-lead MCP URL. */
  mcp?: { url: string; permissionTool: string };
  /** lead.permissionMode (task 3459 C9); 'default'/undefined adds no flag — today's argv. */
  permissionMode?: LeadPermissionMode;
};

export class ClaudeLeadProvider implements LeadProvider {
  readonly supportsResume = true;
  readonly compactProducesResult = true;
  /** claude's own --permission-mode accepts every operator choice (task 3459 C9). */
  readonly permissionModes: readonly LeadPermissionMode[] = ['default', 'plan', 'bypassPermissions'];
  private readonly command: string;
  private readonly baseArgs: readonly string[];
  private readonly env: Record<string, string>;
  private readonly mcp: { url: string; permissionTool: string } | undefined;
  private readonly permissionMode: LeadPermissionMode | undefined;
  /** content_block index → the tool_use block it announced; deltas address blocks by index. */
  private readonly blocks = new Map<number, string>();
  private readonly tools = new Map<string, ToolCall>();
  /** Whether a delta arrived since the last assistant line; without it the line is the payload. */
  private sawDelta = true;
  /** Between-turn compact requests waiting for the driver's stdin drain. */
  private writes: string[] = [];

  constructor(options: ClaudeLeadProviderOptions = {}) {
    this.command = options.command ?? 'claude';
    this.baseArgs = options.baseArgs ?? [];
    this.env = options.env ?? {};
    this.mcp = options.mcp;
    this.permissionMode = options.permissionMode;
  }

  buildSpawn(options: LeadProviderSpawnOptions): LeadProviderSpawn {
    // Every spawn starts a stream from scratch: no delta of the previous process may mark this
    // one as delta-carried (the pre-seam driver reset this per spawn; reviewer item 4).
    this.sawDelta = true;
    const args = [...this.baseArgs, ...STREAM_ARGS,
      // lead.permissionMode (task 3459 C9): only a set, non-default mode reaches the argv.
      ...(this.permissionMode !== undefined && this.permissionMode !== 'default' ? ['--permission-mode', this.permissionMode] : []),
      ...this.permissionArgs(), ...(options.resumeSession ? ['--resume', options.resumeSession] : [])];
    const env: Record<string, string> = { ...process.env, ...ENTRYPOINT_ENV, ...this.env };
    // lead.secretsVeil (task 3459 L3): load the vendored secrets-veil plugin for this child. On a
    // clean install `claude -p` loads no orch mod at all (claude plugin list, probe 2026-11-02), so
    // the driver must name the plugin itself. Proof the channel loads it: `CLAUDE_CODE_PLUGIN_DIRS=<dir>
    // claude plugin list` shows `secrets-veil@inline ... Status: loaded`, and `claude plugin validate`
    // sees the module's hooks (session.start, tool.call). The channel is the mod's own installer one
    // (ops/bootstrap/permissions-target.mjs); the child env keeps every other listed mod.
    if (options.secretsVeil) env.CLAUDE_CODE_PLUGIN_DIRS = withSecretsVeil(env.CLAUDE_CODE_PLUGIN_DIRS);
    return { argv: [this.command, ...args], env };
  }

  /** Claude's own slash command compacts without creating a driver pending user turn. */
  compact(): void {
    this.writes.push(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/compact' }] } })}`);
  }

  takeWrites(): string[] {
    return this.writes.splice(0);
  }

  parseLine(line: string): LeadProviderEvent[] {
    if (!line.trim()) return [];
    let parsed: OutLine;
    try { parsed = JSON.parse(line) as OutLine; } catch { return []; }
    return this.handle(unwrapStreamEvent(parsed));
  }

  private handle(event: OutLine): LeadProviderEvent[] {
    switch (event.type) {
      case 'content_block_start': return this.onBlockStart(event);
      case 'content_block_stop': return this.onBlockStop(event);
      case 'content_block_delta': return this.onBlockDelta(event);
      case 'assistant': return this.onAssistant(event.message as OutLine | undefined);
      case 'user': return this.onToolResults(event.message as OutLine | undefined);
      case 'system': return this.onSystem(event);
      case 'result': return this.onResult(event);
      default: return [];
    }
  }

  private onBlockStart(event: OutLine): LeadProviderEvent[] {
    const block = event.content_block as OutLine | undefined;
    if (block?.type !== 'tool_use' || typeof block.id !== 'string' || !block.id) return [];
    if (typeof event.index === 'number') this.blocks.set(event.index, block.id);
    // Without the block: its `input` here is the empty placeholder `{}`, and the input_json_delta
    // stream must accumulate on an empty string (reviewer item 1). Only the assistant message's
    // tool_use block carries the complete input.
    return this.announce(block.id, typeof block.name === 'string' ? block.name : '');
  }

  private onBlockStop(event: OutLine): LeadProviderEvent[] {
    if (typeof event.index === 'number') this.blocks.delete(event.index);
    return [];
  }

  private onBlockDelta(event: OutLine): LeadProviderEvent[] {
    const delta = event.delta as OutLine | undefined;
    if (!delta) return [];
    if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const tool = this.blockTool(event);
      if (tool) tool.json += delta.partial_json;
      return [];
    }
    return this.textDelta(delta);
  }

  /** A text or thinking delta; arriving at all marks the turn as delta-carried. */
  private textDelta(delta: OutLine): LeadProviderEvent[] {
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      this.sawDelta = true;
      return delta.text ? [{ kind: 'text_delta', text: delta.text }] : [];
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      this.sawDelta = true;
      return delta.thinking ? [{ kind: 'thinking_delta', text: delta.thinking }] : [];
    }
    return [];
  }

  /** Register a tool use and announce its `tool_start` exactly once, from either path. */
  private announce(id: string, name: string, block?: OutLine): LeadProviderEvent[] {
    if (!this.tools.has(id)) this.tools.set(id, { name, startedAt: Date.now(), json: '', announced: false });
    const tool = this.tools.get(id)!;
    if (typeof block?.name === 'string') tool.name = block.name;
    if (block?.input !== undefined) tool.json = JSON.stringify(block.input);
    if (tool.announced) return [];
    tool.announced = true;
    return [{ kind: 'tool_start', tool: { id, name: tool.name } }];
  }

  /** Without `--include-partial-messages` the assistant line itself carries the whole message. */
  private onAssistant(message: OutLine | undefined): LeadProviderEvent[] {
    if (!Array.isArray(message?.content)) return [];
    const sawDelta = this.sawDelta;
    this.sawDelta = false;
    const events: LeadProviderEvent[] = [];
    for (const block of message.content as OutLine[]) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && block.id) {
        events.push(...this.announce(block.id, '', block));
      } else {
        const whole = this.wholeBlock(block, sawDelta);
        if (whole) events.push(whole);
      }
    }
    const usage = readUsage(message);
    if (usage) events.push({ kind: 'usage', usage });
    return events;
  }

  /** A message-level text/thinking block is the payload only when no delta carried it. */
  private wholeBlock(block: OutLine, sawDelta: boolean): LeadProviderEvent | null {
    if (sawDelta) return null;
    if (block?.type === 'text' && typeof block.text === 'string' && block.text) return { kind: 'text', text: block.text };
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) return { kind: 'thinking', text: block.thinking };
    return null;
  }

  private onToolResults(message: OutLine | undefined): LeadProviderEvent[] {
    if (!Array.isArray(message?.content)) return [];
    const events: LeadProviderEvent[] = [];
    for (const block of message.content as OutLine[]) if (block?.type === 'tool_result') events.push(...this.onToolResult(block));
    return events;
  }

  private onToolResult(block: OutLine): LeadProviderEvent[] {
    if (typeof block.tool_use_id !== 'string') return [];
    const tool = this.tools.get(block.tool_use_id);
    this.tools.delete(block.tool_use_id);
    return [{
      kind: 'tool_end',
      tool: {
        id: block.tool_use_id,
        name: tool?.name ?? '',
        ...(tool && tool.json ? { input: parseJson(tool.json) } : {}),
        ...(tool ? { durationMs: Math.max(0, Date.now() - tool.startedAt) } : {}),
        isError: block.is_error === true,
      },
    }];
  }

  private onSystem(event: OutLine): LeadProviderEvent[] {
    const events: LeadProviderEvent[] = [];
    if (typeof event.session_id === 'string' && event.session_id) events.push({ kind: 'session', sessionId: event.session_id });
    if (event.subtype === 'compact_boundary') events.push({ kind: 'compaction' });
    return events;
  }

  private onResult(event: OutLine): LeadProviderEvent[] {
    const events: LeadProviderEvent[] = [];
    if (typeof event.session_id === 'string' && event.session_id) events.push({ kind: 'session', sessionId: event.session_id });
    const usage = readUsage(event);
    if (usage) events.push({ kind: 'usage', usage });
    events.push({ kind: 'result', text: typeof event.result === 'string' ? event.result : '' });
    return events;
  }

  /** The tool_use block a delta's content_block index addresses, when one is open. */
  private blockTool(event: OutLine): ToolCall | null {
    if (typeof event.index !== 'number') return null;
    const id = this.blocks.get(event.index);
    return id !== undefined ? this.tools.get(id) ?? null : null;
  }

  /** The MCP wiring every child carries: the permission tool and orch's own endpoint for it. */
  private permissionArgs(): string[] {
    if (!this.mcp) return [];
    const config = JSON.stringify({ mcpServers: { orch: { type: 'http', url: this.mcp.url } } });
    return ['--permission-prompt-tool', this.mcp.permissionTool, '--mcp-config', config];
  }
}

/** claude usage fields → normalized; absent fields stay null, never guessed. */
function readUsage(source: OutLine | undefined): LeadUsage | null {
  const usage = source?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const mapped: LeadUsage = {
    input: number((usage as OutLine).input_tokens),
    cacheRead: number((usage as OutLine).cache_read_input_tokens),
    cacheCreate: number((usage as OutLine).cache_creation_input_tokens),
    output: number((usage as OutLine).output_tokens),
    contextWindow: null,
  };
  return mapped.input === null && mapped.cacheRead === null && mapped.cacheCreate === null && mapped.output === null ? null : mapped;
}

/** The SDK wrapper carries the raw protocol event in `event`; bare lines are the event itself. */
function unwrapStreamEvent(line: OutLine): OutLine {
  return line.type === 'stream_event' && line.event && typeof line.event === 'object' ? line.event as OutLine : line;
}

/** A tool input's accumulated `input_json_delta` stream, or the raw string when it never parsed. */
function parseJson(json: string): unknown {
  try { return JSON.parse(json); } catch { return json; }
}
