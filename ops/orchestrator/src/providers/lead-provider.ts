/**
 * The lead-runtime provider seam (task 3459): what a supervised lead child speaks. A provider owns
 * one vendor protocol — how its child is spawned and how each output line normalizes — while
 * `lead-driver.ts` owns supervision: restarts, backoff, permissions, coalescing and frames.
 */

/** Normalized token usage; fields the protocol does not report stay null, never guessed. */
export type LeadUsage = {
  input: number | null;
  cacheRead: number | null;
  cacheCreate: number | null;
  output: number | null;
  contextWindow?: number | null;
};

/** The settled outcome of a permission card, as a provider renders it onto the child's stdin. */
export type LeadPermissionAnswer = { behavior: 'allow' | 'deny' };

/**
 * One normalized provider event, in the child's arrival order. Deltas (`*_delta`) may coalesce at
 * the driver; whole `text`/`thinking` are message-line payloads that already arrived complete.
 * A `permission` event is the child asking orch for approval (codex's JSON-RPC request); the driver
 * mints the same card claude's MCP tool produces and settles it through `answerPermission`.
 */
export type LeadProviderEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'tool_start'; tool: { id: string; name: string } }
  | { kind: 'tool_end'; tool: { id: string; name: string; input?: unknown; durationMs?: number; isError: boolean } }
  | { kind: 'usage'; usage: LeadUsage }
  | { kind: 'compaction' }
  | { kind: 'result'; text: string }
  /** A protocol failure, not a result: the driver reports it and terminates the child for supervised restart. */
  | { kind: 'fatal'; text: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'permission'; requestId: string | number; tool: string; input: unknown };

/** The argv/env for one provider child; argv[0] is the command to execute. */
export type LeadProviderSpawn = { argv: string[]; env: Record<string, string> };

export type LeadProviderSpawnOptions = {
  /** Resume a previous session when the provider supports it; null starts a fresh one. */
  resumeSession: string | null;
  /** The directory the child was spawned in, for protocols whose thread settings name a cwd. */
  cwd?: string;
  /** lead.secretsVeil (task 3459 L3): the child's tool results are masked before its model reads
   *  them — claude loads the vendored secrets-veil plugin, pi arms the extension's veil handler.
   *  False is the operator's explicit off: raw results, and the driver says so at spawn. */
  secretsVeil: boolean;
};

/** The provider a new lead speaks, by the lead's spawn option; claude is the default (task 3459). */
export type LeadProviderKind = 'claude' | 'codex' | 'pi';

/**
 * The operator's lead.permissionMode values (task 3459 C9): claude's --permission-mode
 * spellings. 'default' is today's bare child argv — no flag; the driver only ever passes a
 * set mode onward, and refuses one a provider cannot honour rather than ignoring it.
 */
export type LeadPermissionMode = 'default' | 'plan' | 'bypassPermissions';

/**
 * One provider instance per lead session: `parseLine` keeps per-session protocol state (open
 * content blocks, announced tools), so a fresh session gets a fresh instance. Implementations
 * must not trust line fields: everything is read, checked, then used.
 *
 * The three optional methods are the stdin side, for protocols that cannot take one fixed user-turn
 * line (codex's JSON-RPC handshake and per-turn requests). Providers without them keep the
 * driver's plain one-line turn write; a provider that has them owns every byte it wants written.
 */
export type LeadProvider = {
  /** Whether a stopped child can continue its session (claude: `--resume <session>`). */
  readonly supportsResume: boolean;
  /** The lead.permissionMode values this provider's child can honour; absent means none beyond today's bare argv. */
  readonly permissionModes?: readonly LeadPermissionMode[];
  buildSpawn(options: LeadProviderSpawnOptions): LeadProviderSpawn;
  /** Parse one output line; empty or non-JSON lines normalize to no events. */
  parseLine(line: string): LeadProviderEvent[];
  /** Queue one user turn; the lines it becomes leave through `takeWrites` when the child can take them. */
  enqueueTurn?(text: string): void;
  /** The lines waiting for the child's stdin, oldest first; the driver writes and clears them. */
  takeWrites?(): string[];
  /** Queue between-turn compaction; absent means this provider cannot compact on request. */
  compact?(): void;
  /** Whether the compact command closes with its own result frame after the compaction event. */
  readonly compactProducesResult?: boolean;
  /** Settle a child-originated permission ask; the response line leaves through `takeWrites`. */
  answerPermission?(requestId: string | number, answer: LeadPermissionAnswer): void;
  /** Release per-session resources on stop, replacement or terminal failure; not on a crash restart. Idempotent. */
  dispose?(): void;
};
