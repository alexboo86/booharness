// The one shape every provider adapter presents to the rest of orch, whatever
// protocol it speaks underneath (Claude stream-json, codex app-server, ACP).

export type Family = 'claude' | 'glm' | 'codex' | 'grok' | 'kimi' | 'opencode' | 'qwen' | 'mimo';
export const FAMILIES: readonly Family[] = ['claude', 'glm', 'codex', 'grok', 'kimi', 'opencode', 'qwen', 'mimo'];

/**
 * `native` is the vendor's own CLI; `pi` runs the same family through Pi, the
 * worker harness the operator chose (memory #10477). Leads never use either:
 * they sit in the native Claude Code / Codex GUIs.
 */
export type Harness = 'native' | 'pi';

/**
 * `full` approves every tool request the agent raises; `read-only` rejects
 * writes and commands where the protocol can tell them apart, and asks the
 * agent's own sandbox for read-only where it has one (codex).
 */
export type Access = 'full' | 'read-only';

export type SessionSpec = {
  family: Family;
  cwd: string;
  /** Explicit remote host; cwd and resumed sessionId must be paths on that host. */
  host?: string;
  /** Set only after remote provisioning wrote this seat's MCP config; absent seats use the installed Pi profile. */
  remoteMcpConfig?: string;
  /**
   * Pi codex seats that edit (operator #13098): the verified codex-edit extension
   * to load beside orch's own, and the model ids it activates for. Absent seats
   * keep Pi's stock edit tools; orch never sets this for a read-only seat.
   */
  codexEdit?: { extension: string; models: readonly string[] };
  /** Verified stock qwen/grok/mimo editor and its stock-owned version-9 store. */
  hashlineEdit?: { extension: string; store: string };
  model?: string;
  effort?: string;
  access: Access;
  /** Extra environment for the provider process (merged over orch's own). */
  env?: Record<string, string>;
  /**
   * Seat instruments this seat runs without (task 1452, instruments.ts keys).
   * Each adapter enforces what its harness can: Pi the extension and the
   * read-only --tools list, claude --disallowedTools, codex -c server disables.
   */
  instrumentsOff?: readonly string[];
  /**
   * orch's seat endpoint and this session's token (scout-request.ts): a native
   * claude seat gets it as its one orch MCP server; Pi reads it from env.
   */
  seatTool?: { url: string; token: string };
};

/**
 * One turn's usage. Providers disagree on whether "input" includes cache reads
 * (Claude and opencode exclude them, codex and grok include them), so
 * `inputTokens` is always the UNCACHED input; a count the adapter cannot place
 * is null, never guessed. `raw` keeps the provider's own object.
 */
export type Usage = {
  inputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number;
  /** USD for this turn, only where the provider reports one (Claude). */
  costUsd: number | null;
  raw: unknown;
};

export type StopReason = 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' | 'error' | 'other';

export type TurnResult = {
  text: string;
  /** Earlier completed assistant replies in this prompt, oldest first (Pi continuations). */
  earlier?: string[];
  stopReason: StopReason;
  /** The provider's own stop value, verbatim, for the log. */
  rawStopReason: string | null;
  /** null when the provider reported no usage for the turn. */
  usage: Usage | null;
  error: string | null;
  durationMs: number;
};

export type TurnEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'thought'; delta: string }
  /** `args`: the call's input as the provider sent it, when the adapter can see it (orch's loop watch compares them). */
  | { kind: 'tool'; name: string; status: string; args?: unknown }
  /** Pi emits usage after each assistant message, before another model request. */
  | { kind: 'usage'; tokens: number }
  /** A successful Pi compaction, identified by its persisted session entry. */
  | { kind: 'compaction'; entryId: string }
  /** A non-fatal failure preparing context before sending the next Pi prompt. */
  | { kind: 'compaction_error'; error: string }
  | { kind: 'permission'; tool: string; decision: 'allow' | 'reject' };

export type PromptOptions = { onEvent?: (event: TurnEvent) => void; timeoutMs?: number };

export type ContextUsage = { tokens: number; window: number };

export interface ProviderSession {
  readonly family: Family;
  /** The provider's own session/thread id: what `resume` takes back. */
  readonly sessionId: string;
  /** The model the provider says it is running, when it says. */
  readonly model: string | null;
  prompt(text: string, options?: PromptOptions): Promise<TurnResult>;
  /** Add a message to the RUNNING turn, read before the model's next call. Absent where the protocol has no such thing. */
  steer?(text: string): Promise<void>;
  /** How full the session's context is now; null when the provider does not say. */
  contextUsage?(): Promise<ContextUsage | null>;
  /** True once the provider process has exited: prompting it only replays the exit error, so the seat must resume on a new process instead. */
  readonly closed?: boolean;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderAdapter {
  start(spec: SessionSpec): Promise<ProviderSession>;
  resume(spec: SessionSpec, sessionId: string): Promise<ProviderSession>;
}
