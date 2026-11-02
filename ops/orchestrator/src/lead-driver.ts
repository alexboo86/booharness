import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Logger } from './log.ts';
import { readInstallSetting } from './settings/index.ts';
import { ClaudeLeadProvider, PiLeadProvider, piRouteFor, type Family, type LeadPermissionAnswer, type LeadPermissionMode, type LeadProvider, type LeadProviderEvent, type LeadProviderKind, type LeadProviderSpawn, type LeadUsage } from './providers/index.ts';

/**
 * The supervised lead process (pult M2, task 3466 slice 1; provider seam task 3459). One child per
 * lead id, kept alive across turns; the vendor protocol lives behind a `LeadProvider` (claude by
 * default: `--input-format stream-json --output-format stream-json --include-partial-messages`,
 * probe 2026-10-30, decision 22394 — one process and one session survive turn boundaries;
 * `--resume <session>` continues a crashed one). The driver owns supervision: restart backoff, the
 * permission cards, delta coalescing and the `lead.event` frames on an injected event stream.
 * Ordered `LeadExtension`s observe every frame, rewrite prompts before the child and run at turn
 * end; the usage tracker here records the last usage per session.
 */

/** One translated stream-json frame: `data` of a `lead.event` on the /events stream. */
export type LeadEventKind = 'text' | 'thinking' | 'tool_start' | 'tool_end' | 'status' | 'permission_request' | 'permission_resolved' | 'result' | 'usage' | 'compaction' | 'session.replaced';
export type LeadEvent = {
  lead: string;
  session: string | null;
  kind: LeadEventKind;
  text?: string;
  tool?: { id: string; name: string; input?: unknown; durationMs?: number; isError?: boolean };
  request?: PermissionRequestFrame;
  usage?: LeadUsage;
  /** A `session.replaced` frame's pair: the session restartFresh left and the one that followed. */
  replaced?: { old: string | null; new: string | null };
};

/** A permission card travelling on the stream: the ask, then how it was settled. */
export type PermissionRequestFrame = {
  id: string;
  tool?: string;
  input?: unknown;
  decision?: 'allow' | 'deny';
  message?: string;
  /** How a request ended without an operator answer: timeout, stop, crash, exit or no lead. */
  reason?: string;
};

/** What an extension sees of one lead at a hook; stateless, supplied per call. */
export type LeadExtensionContext = { lead: string; session: string | null };

/**
 * One ordered middleware over the driver (task 3459): `onEvent` observes every emitted frame,
 * `onBeforeSend` rewrites a prompt before it reaches the child, `onTurnEnd` runs when a result
 * frame closes the turn. A disabled extension is skipped entirely; a throwing hook is logged and
 * never takes the lead or the daemon down.
 */
export type LeadExtension = {
  readonly id: string;
  enabled: boolean;
  onEvent?(event: LeadEvent, ctx: LeadExtensionContext): void;
  onBeforeSend?(prompt: string, ctx: LeadExtensionContext): string;
  onTurnEnd?(ctx: LeadExtensionContext): void;
};

/** Records the last usage frame per session id; the autonomy loop (R12) reads it. */
export class LeadUsageTracker implements LeadExtension {
  readonly id = 'usage-tracker';
  enabled = true;
  private readonly lastBySession = new Map<string, LeadUsage>();
  onEvent(event: LeadEvent): void {
    if (event.kind === 'usage' && event.usage && event.session) this.lastBySession.set(event.session, event.usage);
  }
  /** The session's last recorded usage, or null when none arrived yet. */
  usage(session: string | null): LeadUsage | null {
    return session !== null ? this.lastBySession.get(session) ?? null : null;
  }
}

/** The documented shape a claude permission-prompt tool must answer with. */
export type PermissionAnswer = { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string };

/** What the driver needs from the /events stream; the real EventStream satisfies this structurally. */
export type LeadEventSink = { emit(type: 'lead.event', data: Record<string, unknown>): void };

export type LeadStatus = 'running' | 'restarting' | 'failed' | 'stopped';

/** The MCP tool name (claude sees `mcp__orch__<name>`) the children answer permission prompts through. */
export const LEAD_PERMISSION_TOOL = 'lead_permission';

/** A lead id an operator may create: bounded printable ASCII, no shell metacharacters. */
export const LEAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The per-start route overrides for one lead's session (task 3459 L0c): an optional family,
 *  model and effort that win over the driver's own, the lead keeps across its restarts and
 *  restartFresh, and the leads.models gate checks the provider and model they resolve to. */
export type LeadStartSpec = { family?: Family; model?: string; effort?: string };

export type LeadDriverOptions = {
  events: LeadEventSink;
  log?: Logger;
  /** The command the default claude provider runs; tests replace this with a fixture script. */
  command?: string;
  /** Extra arguments before the provider's own stream flags; tests drive their fixture with them. */
  baseArgs?: readonly string[];
  /** Extra environment for the child, merged over the daemon's; tests drive their fixture with it. */
  env?: Record<string, string>;
  /** The first backoff delay and its cap; a restart doubles the previous delay up to the cap. */
  backoffFirstMs?: number;
  backoffMaxMs?: number;
  /** At most `maxRestarts` restarts inside `restartWindowMs`; past the cap the lead is failed. */
  restartWindowMs?: number;
  maxRestarts?: number;
  /** How many milliseconds of text/thinking deltas may coalesce into one frame. */
  coalesceMs?: number;
  /** A permission card the operator never answers is denied after this long. */
  permissionTimeoutMs?: number;
  /** When set, children run with --permission-prompt-tool/--mcp-config wired to this per-lead URL. */
  mcpUrlFor?: (lead: string) => string;
  /** The provider a lead speaks when its start names none: 'claude' (the default, unchanged when
   *  omitted), 'codex' (family codex through the pinned Pi runtime since task 3535 L0d), or 'pi' —
   *  the pinned Pi runtime through providers/pi-lead.ts, so any family with a Pi route can lead
   *  (task 3459 L0b). */
  provider?: LeadProviderKind;
  /** The pi lead's family; required when a lead speaks pi, ignored otherwise. */
  family?: Family;
  /** lead.permissionMode (task 3459 C9), read once per daemon start: a set mode reaches a
   *  claude child's argv; a provider that cannot honour it refuses the start. */
  permissionMode?: LeadPermissionMode;
  /** Why lead.permissionMode could not be read (broken settings document); while set, every
   *  lead start refuses rather than guess a permission level. */
  permissionModeFault?: string;
  /** Explicit model id for a pi child; the route's default when omitted. */
  model?: string;
  /** Thinking effort for a pi child; the route's default when omitted. */
  effort?: string;
  /** The install state dir; when set, the `leads.models` install setting gates which provider
   *  and model a start may name (task 3459 C6, decision 22510 item 4), read per start. */
  stateDir?: string;
  /** The provider each new lead session speaks, by the lead's chosen kind; defaults to the claude child and the Pi runtime (a codex start is family codex through Pi, task 3535 L0d). */
  providerFor?: (lead: string, provider: LeadProviderKind, spec?: LeadStartSpec) => LeadProvider;
  /** Ordered middleware over every lead: frame observation, prompt rewrite, turn end. */
  extensions?: readonly LeadExtension[];
};

const BACKOFF_FIRST_MS = 500;
const BACKOFF_MAX_MS = 8_000;
const RESTART_WINDOW_MS = 5 * 60_000;
const MAX_RESTARTS = 3;
const COALESCE_MS = 100;
const KILL_GRACE_MS = 3_000;
const PERMISSION_TIMEOUT_MS = 5 * 60_000;

/**
 * SIGTERM now, SIGKILL after a grace if the child is still alive. The escalation belongs to the
 * child, not the entry: a repeated stop, a same-id restart or a dropped reference must never
 * cancel it, or a live child would outlive its lead's status (reviewer-codex-d36833 items 1, 2).
 */
function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  killTimer.unref();
  child.once('exit', () => clearTimeout(killTimer));
}

type PendingPermission = { tool: string; input: unknown; resolve: (answer: PermissionAnswer) => void; timer: NodeJS.Timeout; /** The child's own request id when the ask came from the provider, not claude's MCP tool. */ child?: string | number };

type LeadEntry = {
  lead: string;
  cwd: string;
  phase: LeadStatus;
  child: ChildProcess | null;
  /** The most recent child spawned for this entry, kept past its end to drop its late lines when the entry moves on. */
  lastChild: ChildProcess | null;
  /** The vendor protocol this lead's child speaks; one instance per session. */
  provider: LeadProvider;
  /** The kind the lead was started with; restarts and fresh restarts keep speaking it. */
  providerKind: LeadProviderKind;
  /** The family/model/effort this lead started with (per start over the driver's own, task 3459
   *  L0c); a crash restart and restartFresh keep them. */
  spec: LeadStartSpec;
  session: string | null;
  /** A replacement waiting for its new session id; undefined when the session was not replaced. */
  replacedFrom: string | null | undefined;
  /** Text sent but not yet answered by a result frame; re-sent after a crash resume. */
  pending: string | null;
  /** Claude's /compact result is not the result of a wake sent at its compact_boundary. */
  compactResultPending: boolean;
  restarts: number[];
  /** Permission cards this child is blocked on, by request id. */
  permissions: Map<string, PendingPermission>;
  coalesced: { text: string[]; thinking: string[] };
  flushTimer: NodeJS.Timeout | null;
  /** A pending crash-restart timer; cleared whenever the entry is stopped or reused. */
  restartTimer: NodeJS.Timeout | null;
};

export class LeadDriver {
  private readonly leads = new Map<string, LeadEntry>();
  private readonly events: LeadEventSink;
  private readonly log: Logger;
  private readonly command: string;
  private readonly baseArgs: readonly string[];
  private readonly env: Record<string, string>;
  private readonly backoffFirstMs: number;
  private readonly backoffMaxMs: number;
  private readonly restartWindowMs: number;
  private readonly maxRestarts: number;
  private readonly coalesceMs: number;
  private readonly permissionTimeoutMs: number;
  private readonly mcpUrlFor: ((lead: string) => string) | undefined;
  private readonly defaultKind: LeadProviderKind;
  private readonly family: Family | undefined;
  private readonly model: string | undefined;
  private readonly effort: string | undefined;
  private readonly stateDir: string | undefined;
  private readonly permissionMode: LeadPermissionMode | undefined;
  private readonly permissionModeFault: string | undefined;
  /** An explicit child command for a pi lead (tests); unset resolves the pinned Pi runtime. */
  private readonly piCommand: { command: string; args: readonly string[] } | undefined;
  private readonly providerFor: (lead: string, provider: LeadProviderKind, spec?: LeadStartSpec) => LeadProvider;
  private readonly extensions: readonly LeadExtension[];
  /** Children the entry let go of (stop, restartFresh, stdin failure); their late lines drop. */
  private readonly releasedChildren = new WeakSet<ChildProcess>();
  /** Children a provider `fatal` ended: their exit is a crash whatever code or signal it reports,
   *  because a child may trap SIGTERM and exit 0 (codex app-server, observed on codex 0.163). */
  private readonly failingChildren = new WeakSet<ChildProcess>();

  constructor(options: LeadDriverOptions) {
    const opt = <T,>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value);
    this.events = options.events;
    this.log = opt(options.log, () => {});
    this.command = opt(options.command, 'claude');
    this.baseArgs = opt(options.baseArgs, []);
    this.env = opt(options.env, {});
    this.backoffFirstMs = opt(options.backoffFirstMs, BACKOFF_FIRST_MS);
    this.backoffMaxMs = opt(options.backoffMaxMs, BACKOFF_MAX_MS);
    this.restartWindowMs = opt(options.restartWindowMs, RESTART_WINDOW_MS);
    this.maxRestarts = opt(options.maxRestarts, MAX_RESTARTS);
    this.coalesceMs = opt(options.coalesceMs, COALESCE_MS);
    this.permissionTimeoutMs = opt(options.permissionTimeoutMs, PERMISSION_TIMEOUT_MS);
    this.mcpUrlFor = options.mcpUrlFor;
    this.defaultKind = options.provider ?? 'claude';
    this.family = options.family;
    this.model = options.model;
    this.effort = options.effort;
    this.stateDir = options.stateDir;
    this.permissionMode = options.permissionMode;
    this.permissionModeFault = options.permissionModeFault;
    if (this.defaultKind === 'pi' && !this.family) throw new Error("provider 'pi' needs a family with a Pi route");
    // A pi child replaces the default claude binary; unset, the provider resolves the pinned runtime.
    this.piCommand = options.command !== undefined ? { command: options.command, args: this.baseArgs } : undefined;
    this.providerFor = options.providerFor ?? ((lead: string, provider: LeadProviderKind, spec?: LeadStartSpec) => this.defaultProvider(lead, provider, spec));
    this.extensions = opt(options.extensions, []);
  }

  /** The default provider for a new lead session: claude, or the pinned Pi runtime for providers
   *  'pi' and 'codex' — a codex start is family codex through Pi (task 3535 L0d). */
  private defaultProvider(lead: string, provider: LeadProviderKind, spec?: LeadStartSpec): LeadProvider {
    if (provider === 'codex') return this.piProvider(lead, { ...spec, family: 'codex' });
    if (provider !== 'pi') {
      return new ClaudeLeadProvider({
        command: this.command,
        baseArgs: this.baseArgs,
        env: this.env,
        ...(this.permissionMode !== undefined ? { permissionMode: this.permissionMode } : {}),
        ...(this.mcpUrlFor ? { mcp: { url: this.mcpUrlFor(lead), permissionTool: `mcp__orch__${LEAD_PERMISSION_TOOL}` } } : {}),
      });
    }
    return this.piProvider(lead, spec ?? {});
  }


  /** The Pi provider for one start's resolved spec (task 3459 L0c); pi always needs a family. */
  private piProvider(lead: string, spec: LeadStartSpec): LeadProvider {
    const family = spec.family ?? this.family;
    if (!family) throw new Error("provider 'pi' needs a family with a Pi route");
    const model = spec.model ?? this.model;
    const effort = spec.effort ?? this.effort;
    return new PiLeadProvider({
      family,
      route: piRouteFor(family),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(this.piCommand ? { command: this.piCommand.command, args: this.piCommand.args } : {}),
      env: this.env,
      ...(this.mcpUrlFor ? { mcp: { url: this.mcpUrlFor(lead) } } : {}),
    });
  }
  /** The lead's current phase, or null when no child was ever started for it. */
  status(lead: string): LeadStatus | null {
    return this.leads.get(lead)?.phase ?? null;
  }

  /** Every lead this driver holds, as GET /api/leads reads it. The row carries the
   *  provider and the per-start route spec (task 3459 L0c) the child was started with,
   *  so a composer can show the lead's real family, model and effort (M1.3). */
  list(): Array<{ id: string; cwd: string; status: LeadStatus; session: string | null; provider: LeadProviderKind; family: string | null; model: string | null; effort: string | null }> {
    return [...this.leads.values()].map((entry) => ({
      id: entry.lead, cwd: entry.cwd, status: entry.phase, session: entry.session,
      provider: entry.providerKind,
      family: entry.spec.family ?? null,
      model: entry.spec.model ?? null,
      effort: entry.spec.effort ?? null,
    }));
  }

  /** lead.permissionMode (task 3459 C9): an unreadable settings document, or a provider that
   *  cannot honour the set mode, refuses the start — the mode is never silently ignored. */
  private refuseUnservablePermissionMode(lead: string, provider: LeadProviderKind, sessionProvider: LeadProvider): void {
    if (this.permissionModeFault !== undefined) {
      throw new Error(`lead ${lead} cannot start: lead.permissionMode could not be read: ${this.permissionModeFault}`);
    }
    const mode = this.permissionMode;
    if (mode !== undefined && mode !== 'default' && !(sessionProvider.permissionModes ?? []).includes(mode)) {
      throw new Error(`lead ${lead} cannot start: provider ${provider} cannot honour lead.permissionMode '${mode}'`);
    }
  }

  /** Start (or take over) the lead's child, speaking the named provider (default claude); an
   *  optional per-start spec (task 3459 L0c) wins over the driver's family/model/effort and the
   *  lead keeps it across its restarts and restartFresh. */
  start(lead: string, cwd: string, provider: LeadProviderKind = this.defaultKind, overrides?: LeadStartSpec): void {
    const existing = this.leads.get(lead);
    if (existing && (existing.phase === 'running' || existing.phase === 'restarting')) return;
    const spec = this.resolveStartSpec(provider, overrides);
    this.allowLeadStart(provider, spec);
    const sessionProvider = this.providerFor(lead, provider, spec);
    this.refuseUnservablePermissionMode(lead, provider, sessionProvider);
    if (existing) this.clearTimers(existing);
    const entry: LeadEntry = {
      lead, cwd, phase: 'running', child: null, lastChild: null, provider: sessionProvider, providerKind: provider, spec,
      session: existing?.session ?? null, replacedFrom: undefined, pending: null, compactResultPending: false,
      restarts: [], permissions: new Map(), coalesced: { text: [], thinking: [] }, flushTimer: null, restartTimer: null,
    };
    this.leads.set(lead, entry);
    this.spawnChild(entry, 'started');
  }

  /** The spec a start resolves to (task 3459 L0c): the per-start overrides win over the
   *  driver's family/model/effort, pi always needs a family, and codex implies family codex
   *  (task 3535 L0d). */
  private resolveStartSpec(provider: LeadProviderKind, overrides?: LeadStartSpec): LeadStartSpec {
    const spec: LeadStartSpec = {
      family: provider === 'codex' ? 'codex' : overrides?.family ?? this.family,
      model: overrides?.model ?? this.model,
      effort: overrides?.effort ?? this.effort,
    };
    if (provider === 'pi' && !spec.family) throw new Error("provider 'pi' needs a family with a Pi route");
    return spec;
  }

  /** What a start names in the leads.models list: the provider, or for pi the family and model
   *  the start resolves to (per start over the driver's own; task 3459 C6, L0c). A codex start
   *  runs family codex through Pi (task 3535 L0d), so both its provider name and its resolved
   *  route name may allow it and nothing else does. */
  private leadStartDescriptors(provider: LeadProviderKind, spec: LeadStartSpec): string[] {
    if (provider === 'pi') {
      if (!spec.family) throw new Error("provider 'pi' needs a family with a Pi route");
      return [`pi:${spec.family}${spec.model ? `:${spec.model}` : ''}`];
    }
    if (provider === 'codex') {
      const model = spec.model ? `:${spec.model}` : '';
      return [`codex${model}`, `pi:codex${model}`];
    }
    return [provider];
  }

  /** The `leads.models` install setting limits which provider and model a lead may start with;
   *  a refused start names the allowed list (task 3459 C6). Read per start, so a change applies
   *  with no restart; null (the default) refuses nothing, which is today's behaviour. */
  private allowLeadStart(provider: LeadProviderKind, spec: LeadStartSpec): void {
    if (this.stateDir === undefined) return;
    const allowed = readInstallSetting(this.stateDir, 'leads.models') as string[] | null;
    if (allowed === null) return;
    const descriptors = this.leadStartDescriptors(provider, spec);
    const permitted = allowed.some((entry) => descriptors.some((descriptor) => entry === descriptor || descriptor.startsWith(`${entry}:`)));
    if (!permitted) throw new Error(`lead start refused: ${descriptors[0]} is not in leads.models (allowed: ${allowed.join(', ')})`);
  }

  /**
   * Write one user turn as a stream-json line, through `onBeforeSend`. Buffered while a crash
   * resume is pending and re-sent once the new process is up; false when the lead has no live
   * child to deliver to.
   */
  send(lead: string, text: string): boolean {
    const entry = this.leads.get(lead);
    if (!entry || (entry.phase !== 'running' && entry.phase !== 'restarting')) return false;
    const prompt = this.beforeSend(entry, text);
    entry.pending = prompt;
    if (entry.phase === 'restarting' || !entry.child?.stdin?.writable) return true;
    this.writeTurn(entry, prompt);
    return true;
  }

  /** Queue between-turn compaction without making it a pending user turn; false when unsupported or no live child would receive it. */
  compact(lead: string): boolean {
    const entry = this.leads.get(lead);
    if (!entry || entry.phase !== 'running' || !entry.child?.stdin?.writable || !entry.provider.compact) return false;
    entry.compactResultPending = entry.provider.compactProducesResult === true;
    entry.provider.compact();
    this.drainWrites(entry);
    return true;
  }

  /**
   * Stop the child and start a fresh session for the same lead: no resume, the seeded prompt (through
   * `onBeforeSend`) is the new session's first turn, and the next session id the child reports emits
   * a `session.replaced {old, new}` frame. False for an unknown lead or a failed spawn;
   * preparation failure leaves the old child, session and permissions intact.
   */
  restartFresh(lead: string, seededPrompt: string): boolean {
    const entry = this.leads.get(lead);
    if (!entry) return false;
    const replacement = this.prepareFreshChild(entry);
    if (!replacement) return false;
    // Flush the old tail before changing its session, but only after the OS accepted the new spawn.
    this.flushCoalesced(entry);
    this.clearTimers(entry);
    const child = entry.child;
    entry.child = null;
    // Release the child this entry ran — live or already ended — so its late lines cannot feed the
    // fresh session's provider.
    const released = child ?? entry.lastChild;
    if (released) this.releasedChildren.add(released);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin?.end();
      terminate(child);
    }
    this.denyPermissions(entry, 'session replaced');
    entry.provider.dispose?.();
    entry.provider = replacement.provider;
    entry.replacedFrom = entry.session;
    entry.session = null;
    entry.pending = this.beforeSend(entry, seededPrompt);
    entry.phase = 'running';
    // A fresh session is a fresh supervision epoch: no stale restart budget (item 5).
    entry.restarts = [];
    this.attachChild(entry, replacement.child, 'restarted');
    return true;
  }

  /** Prepare without touching the live entry: buildSpawn may throw, and OS spawn may fail. */
  private prepareFreshChild(entry: LeadEntry): { provider: LeadProvider; child: ChildProcess } | null {
    let provider: LeadProvider | undefined;
    try {
      provider = this.providerFor(entry.lead, entry.providerKind, entry.spec);
      const child = this.createChild(provider, entry.cwd, null);
      // Node sets pid only when the OS created the process; a failed spawn reports its error
      // on the next tick. Consume that event without handing it to the old lead's supervision.
      if (child.pid === undefined) {
        child.once('error', (error) => this.freshSpawnRefused(entry, error));
        provider.dispose?.();
        return null;
      }
      return { provider, child };
    } catch (error) {
      provider?.dispose?.();
      this.freshSpawnRefused(entry, error);
      return null;
    }
  }

  private freshSpawnRefused(entry: LeadEntry, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log('warn', 'lead.fresh_spawn_error', { lead: entry.lead, error: message });
    this.emitDirect(entry, 'status', { text: `fresh restart refused: ${message}; previous session retained` });
  }

  /** One status frame on the lead's stream, from a driver-side actor such as the handover
   *  extension (R12); false when no such lead. Goes through dispatch, so extensions see it too. */
  emitStatus(lead: string, text: string): boolean {
    const entry = this.leads.get(lead);
    if (!entry) return false;
    this.emitDirect(entry, 'status', { text });
    return true;
  }

  /** Stop one lead, or every lead when no id is given: flush, end stdin, kill the child. */
  stop(lead?: string): void {
    const targets = lead === undefined ? [...this.leads.values()] : [this.leads.get(lead)].filter((entry): entry is LeadEntry => Boolean(entry));
    for (const entry of targets) this.stopEntry(entry);
  }

  private stopEntry(entry: LeadEntry): void {
    entry.phase = 'stopped';
    this.clearTimers(entry);
    this.denyPermissions(entry, 'stop');
    entry.provider.dispose?.();
    this.emitDirect(entry, 'status', { text: 'stopped' });
    const child = entry.child;
    entry.child = null;
    const released = child ?? entry.lastChild;
    if (released) this.releasedChildren.add(released);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    terminate(child);
  }

  /** A stop ends here; any other exit either ends supervision (clean) or resumes (crash). */
  private onExit(entry: LeadEntry, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null, crashed: boolean): void {
    // An exit of a child the entry no longer holds (stopped, replaced by restartFresh) is not this
    // lead's exit; treating it as one would restart or fail the wrong session.
    if (entry.child !== child || entry.phase !== 'running') return;
    this.flushCoalesced(entry);
    entry.child = null;
    if (!crashed && code === 0 && signal === null && !this.failingChildren.has(child)) {
      // claude -p holds its session open (decision 22394): a clean exit without stop() is claude
      // ending the session itself, so supervision ends instead of re-sending answered turns.
      // A child a provider `fatal` ended is never "clean" — whatever it reports, it crashed.
      entry.phase = 'stopped';
      this.denyPermissions(entry, 'exit');
      entry.provider.dispose?.();
      this.emitDirect(entry, 'status', { text: 'exited' });
      return;
    }
    this.denyPermissions(entry, 'crash');
    const now = Date.now();
    entry.restarts = entry.restarts.filter((at) => now - at < this.restartWindowMs);
    if (entry.restarts.length >= this.maxRestarts) {
      entry.phase = 'failed';
      entry.provider.dispose?.();
      this.emitDirect(entry, 'status', { text: 'failed' });
      this.log('warn', 'lead.failed', { lead: entry.lead, restarts: entry.restarts.length });
      return;
    }
    this.scheduleRestart(entry, now);
  }

  private scheduleRestart(entry: LeadEntry, now: number): void {
    entry.restarts.push(now);
    const delay = Math.min(this.backoffFirstMs * 2 ** (entry.restarts.length - 1), this.backoffMaxMs);
    entry.phase = 'restarting';
    this.emitDirect(entry, 'status', { text: 'restarting' });
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      if (entry.phase !== 'restarting') return;
      entry.phase = 'running';
      this.spawnChild(entry, 'restarted');
    }, delay);
    entry.restartTimer.unref();
  }

  /** lead.secretsVeil (task 3459 L3), read per child spawn: default on. An unreadable settings
   *  document keeps the mask on (fail closed) and is named at spawn — a broken store must never
   *  silently hand a lead raw secrets. */
  private secretsVeilState(): { on: boolean; fault?: string } {
    if (this.stateDir === undefined) return { on: true };
    try {
      return { on: readInstallSetting(this.stateDir, 'lead.secretsVeil') !== false };
    } catch (error) {
      return { on: true, fault: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The one status frame at spawn for a veil that is off or unreadable (lead.secretsVeil). */
  private secretsVeilNotice(entry: LeadEntry): void {
    const veil = this.secretsVeilState();
    if (veil.fault !== undefined) {
      this.emitDirect(entry, 'status', { text: `lead.secretsVeil could not be read (${veil.fault}); tool results stay masked` });
    } else if (!veil.on) {
      this.emitDirect(entry, 'status', { text: 'lead.secretsVeil off: tool results reach the model unmasked' });
    }
  }

  private createChild(provider: LeadProvider, cwd: string, session: string | null): ChildProcess {
    const spec: LeadProviderSpawn = provider.buildSpawn({ resumeSession: provider.supportsResume ? session : null, cwd, secretsVeil: this.secretsVeilState().on });
    return spawn(spec.argv[0], spec.argv.slice(1), { cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  private spawnChild(entry: LeadEntry, status: string): void {
    let child: ChildProcess;
    try {
      child = this.createChild(entry.provider, entry.cwd, entry.session);
    } catch (error) {
      this.onBuildSpawnError(entry, error);
      return;
    }
    this.attachChild(entry, child, status);
  }

  private attachChild(entry: LeadEntry, child: ChildProcess, status: string): void {
    entry.child = child;
    entry.lastChild = child;
    entry.compactResultPending = false;
    this.emitDirect(entry, 'status', { text: status });
    // lead.secretsVeil (task 3459 L3): at every spawn, one status line when the veil is off (raw
    // results) or the settings document could not be read (results stay masked).
    this.secretsVeilNotice(entry);
    child.on('error', (error) => {
      this.log('warn', 'lead.spawn_error', { lead: entry.lead, error: String(error) });
      this.onExit(entry, child, null, null, true);
    });
    child.on('exit', (code, signal) => this.onExit(entry, child, code, signal, false));
    const stdout = createInterface({ input: child.stdout! });
    // Only lines of a child the entry released (stop, restartFresh, stdin failure) are dropped:
    // 'exit' is not ordered before a child's final 'line' events, so a child that ended on its own
    // still delivers its last frames (reviewer item 2).
    stdout.on('line', (line) => { if (!this.releasedChildren.has(child)) this.onLine(entry, line); });
    // A child that closed its stdin turns the next write into EPIPE; an unhandled stream error
    // would take the whole daemon down, so the lead fails with the reason instead (item 2).
    child.stdin?.on('error', (error: Error) => this.onStdinError(entry, child, error));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.log('info', 'lead.stderr', { lead: entry.lead, text: text.slice(0, 500) });
    });
    // A turn the crashed process never answered opens the resumed session.
    if (entry.pending !== null) this.writeTurn(entry, entry.pending);
    this.drainWrites(entry);
  }

  private writeTurn(entry: LeadEntry, text: string): void {
    const provider = entry.provider;
    // A stdin-owning provider (codex's JSON-RPC) queues the turn and releases it when the child can take it.
    if (provider.enqueueTurn) { provider.enqueueTurn(text); this.drainWrites(entry); return; }
    entry.child?.stdin?.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
  }

  /** Write what a stdin-owning provider queued (handshake, turns, permission answers), oldest first. */
  private drainWrites(entry: LeadEntry): void {
    for (const line of entry.provider.takeWrites?.() ?? []) entry.child?.stdin?.write(`${line}\n`);
  }

  /** A broken child stdin fails the lead with the reason; the daemon itself lives on. */
  private onStdinError(entry: LeadEntry, child: ChildProcess, error: Error): void {
    this.log('warn', 'lead.stdin_error', { lead: entry.lead, error: error.message });
    if (entry.child !== child || entry.phase !== 'running') return;
    entry.child = null;
    this.releasedChildren.add(child);
    entry.phase = 'failed';
    this.clearTimers(entry);
    this.denyPermissions(entry, 'stdin error');
    entry.provider.dispose?.();
    this.emitDirect(entry, 'status', { text: `failed: ${error.message}` });
    // The entry lets go of the child, so the escalation must be armed here too (d36833.2).
    terminate(child);
  }

  /** A `buildSpawn` throw fails the lead with the reason; there is no child to terminate. */
  private onBuildSpawnError(entry: LeadEntry, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log('warn', 'lead.spawn_error', { lead: entry.lead, error: message });
    entry.child = null;
    entry.phase = 'failed';
    this.clearTimers(entry);
    this.denyPermissions(entry, 'spawn error');
    entry.provider.dispose?.();
    this.emitDirect(entry, 'status', { text: `failed: ${message}` });
  }

  /**
   * One permission card: emitted on the stream, then blocked until the operator answers, the
   * timeout denies, or the lead stops, crashes or exits. Never rejects; a missing lead denies.
   */
  async permissionRequest(lead: string, tool: string, input: unknown, childRequestId?: string | number): Promise<PermissionAnswer> {
    const entry = this.leads.get(lead);
    if (!entry || (entry.phase !== 'running' && entry.phase !== 'restarting')) {
      this.emitPermission(entry ?? null, lead, { id: randomUUID(), tool, input, decision: 'deny', message: `lead ${lead} is not running`, reason: 'not running' });
      return { behavior: 'deny', message: `lead ${lead} is not running` };
    }
    const id = randomUUID();
    const answer = new Promise<PermissionAnswer>((resolve) => {
      const pending: PendingPermission = { tool, input, resolve, ...(childRequestId !== undefined ? { child: childRequestId } : {}), timer: setTimeout(() => {
        entry.permissions.delete(id);
        const message = `permission request ${id} timed out`;
        resolve({ behavior: 'deny', message });
        this.answerChildPermission(entry, childRequestId, { behavior: 'deny' });
        this.emitPermission(entry, lead, { id, decision: 'deny', message, reason: 'timeout' });
      }, this.permissionTimeoutMs) };
      pending.timer.unref();
      entry.permissions.set(id, pending);
    });
    this.emitPermission(entry, lead, { id, tool, input });
    return answer;
  }

  /** Settle one card by id: false when no such request is pending for this lead. */
  resolvePermission(lead: string, id: string, decision: 'allow' | 'deny', message?: string): boolean {
    const entry = this.leads.get(lead);
    const pending = entry?.permissions.get(id);
    if (!entry || !pending) return false;
    entry.permissions.delete(id);
    clearTimeout(pending.timer);
    const denyMessage = decision === 'deny' ? (message ?? `permission request ${id} denied`) : `permission request ${id} cannot take a message`;
    const answer = decision === 'allow' ? { behavior: 'allow', updatedInput: pending.input } as const : { behavior: 'deny', message: denyMessage } as const;
    pending.resolve(answer);
    this.answerChildPermission(entry, pending.child, { behavior: decision });
    this.emitPermission(entry, lead, { id, tool: pending.tool, decision, ...(decision === 'deny' && message !== undefined ? { message } : {}) });
    return true;
  }

  /** A child-originated ask is answered on its stdin when its provider renders one. */
  private answerChildPermission(entry: LeadEntry, childRequestId: string | number | undefined, answer: LeadPermissionAnswer): void {
    if (childRequestId === undefined || !entry.provider.answerPermission) return;
    entry.provider.answerPermission(childRequestId, answer);
    this.drainWrites(entry);
  }

  /** Every card of a lead that stopped, crashed, exited, was replaced or timed out resolves as a denial. */
  private denyPermissions(entry: LeadEntry, reason: string): void {
    for (const [id, pending] of [...entry.permissions.entries()]) {
      entry.permissions.delete(id);
      clearTimeout(pending.timer);
      const message = `permission request ${id} denied: the lead ${reason === 'stop' ? 'stopped' : `ended (${reason})`}`;
      pending.resolve({ behavior: 'deny', message });
      this.answerChildPermission(entry, pending.child, { behavior: 'deny' });
      this.emitPermission(entry, entry.lead, { id, tool: pending.tool, decision: 'deny', message, reason });
    }
  }

  private emitPermission(entry: LeadEntry | null, lead: string, request: PermissionRequestFrame): void {
    this.dispatch(entry, lead, { kind: request.decision === undefined ? 'permission_request' : 'permission_resolved', request });
  }

  private onLine(entry: LeadEntry, line: string): void {
    for (const event of entry.provider.parseLine(line)) this.onProviderEvent(entry, event);
    // Reading a line can queue the next handshake or turn write (initialize answered, thread opened).
    this.drainWrites(entry);
  }

  /** Translate the provider's normalized events, keeping the child's arrival order. */
  private onProviderEvent(entry: LeadEntry, event: LeadProviderEvent): void {
    switch (event.kind) {
      case 'text_delta': this.coalesce(entry, 'text', event.text); return;
      case 'thinking_delta': this.coalesce(entry, 'thinking', event.text); return;
      case 'result': this.onResultEvent(entry, event); return;
      case 'fatal': this.onProviderFailure(entry, event.text); return;
      default: this.onFrameEvent(entry, event); return;
    }
  }

  /** Keep the unanswered prompt for resume; the child's exit consumes the normal restart budget.
   *  The child is marked failing, so its exit takes the crash path whatever code or signal it
   *  reports, and the fatal plus that exit count once against the cap. */
  private onProviderFailure(entry: LeadEntry, text: string): void {
    const child = entry.child;
    if (!child || entry.phase !== 'running') return;
    this.emitDirect(entry, 'status', { text: `failed: ${text}` });
    this.releasedChildren.add(child);
    this.failingChildren.add(child);
    terminate(child);
  }

  /** A result frame closes the turn: the pending prompt is answered and extensions run. */
  private onResultEvent(entry: LeadEntry, event: Extract<LeadProviderEvent, { kind: 'result' }>): void {
    const compactResult = entry.compactResultPending;
    entry.compactResultPending = false;
    // A compact_boundary can release the wake before Claude's own /compact result arrives.
    // That result must not clear the wake's pending prompt or close its turn (Pi has no such result).
    if (compactResult && entry.pending !== null) {
      this.emitDirect(entry, 'result', { text: event.text });
      return;
    }
    entry.pending = null;
    this.emitDirect(entry, 'result', { text: event.text });
    this.forEachExtension(entry, entry.lead, (extension, ctx) => extension.onTurnEnd?.(ctx));
  }

  /** Every remaining event emits its frame (or names the session) directly. */
  private onFrameEvent(entry: LeadEntry, event: LeadProviderEvent): void {
    switch (event.kind) {
      case 'text':
      case 'thinking': this.dispatch(entry, entry.lead, { kind: event.kind, text: event.text }); return;
      case 'tool_start':
      case 'tool_end': this.flushCoalesced(entry); this.dispatch(entry, entry.lead, { kind: event.kind, tool: event.tool }); return;
      case 'usage': this.dispatch(entry, entry.lead, { kind: 'usage', usage: event.usage }); return;
      case 'compaction': this.dispatch(entry, entry.lead, { kind: 'compaction' }); return;
      case 'session': this.onSessionId(entry, event.sessionId); return;
      case 'permission': this.onProviderPermission(entry, event.requestId, event.tool, event.input); return;
      default: return;
    }
  }

  /** A provider-originated ask becomes the same card claude's MCP tool produces, answered on stdin. */
  private onProviderPermission(entry: LeadEntry, requestId: string | number, tool: string, input: unknown): void {
    void this.permissionRequest(entry.lead, tool, input, requestId);
  }

  /** A session id names every later frame and the next resume; a replacement first reports itself. */
  private onSessionId(entry: LeadEntry, sessionId: string): void {
    entry.session = sessionId;
    if (entry.replacedFrom === undefined) return;
    const old = entry.replacedFrom;
    entry.replacedFrom = undefined;
    this.emitDirect(entry, 'session.replaced', { replaced: { old, new: sessionId } });
  }

  /** One prompt through the extensions' `onBeforeSend`, in order. */
  private beforeSend(entry: LeadEntry, prompt: string): string {
    let text = prompt;
    this.forEachExtension(entry, entry.lead, (extension, ctx) => { text = extension.onBeforeSend?.(text, ctx) ?? text; });
    return text;
  }

  /** Emit one frame and show it to every enabled extension, in order. */
  private dispatch(entry: LeadEntry | null, lead: string, event: Omit<LeadEvent, 'lead' | 'session'>): void {
    const frame: LeadEvent = { lead, session: entry?.session ?? null, ...event };
    this.events.emit('lead.event', frame as unknown as Record<string, unknown>);
    this.forEachExtension(entry, lead, (extension, ctx) => extension.onEvent?.(frame, ctx));
  }

  private forEachExtension(entry: LeadEntry | null, lead: string, run: (extension: LeadExtension, ctx: LeadExtensionContext) => void): void {
    for (const extension of this.extensions) {
      if (!extension.enabled) continue;
      try { run(extension, { lead, session: entry?.session ?? null }); }
      catch (error) { this.log('warn', 'lead.extension_error', { lead, id: extension.id, error: String(error) }); }
    }
  }

  /** Deltas of one kind coalesce into at most one frame per `coalesceMs`; a direct frame flushes early. */
  private coalesce(entry: LeadEntry, kind: 'text' | 'thinking', text: string): void {
    if (!text) return;
    entry.coalesced[kind].push(text);
    if (entry.flushTimer) return;
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null;
      this.flushCoalesced(entry);
    }, this.coalesceMs);
    entry.flushTimer.unref();
  }

  private flushCoalesced(entry: LeadEntry): void {
    if (entry.flushTimer) { clearTimeout(entry.flushTimer); entry.flushTimer = null; }
    // Thinking precedes text: those deltas arrive in that order from the stream, so the flush
    // follows the child's arrival order (reviewer-codex-d36833.1 item 3).
    for (const kind of ['thinking', 'text'] as const) {
      const parts = entry.coalesced[kind];
      if (!parts.length) continue;
      const text = parts.join('');
      entry.coalesced[kind] = [];
      if (text) this.dispatch(entry, entry.lead, { kind, text });
    }
  }

  /** A non-delta frame first flushes anything coalesced, so the stream order follows the child's. */
  private emitDirect(entry: LeadEntry, kind: LeadEvent['kind'], extra: { text?: string; replaced?: { old: string | null; new: string | null } } = {}): void {
    this.flushCoalesced(entry);
    this.dispatch(entry, entry.lead, { kind, ...extra });
  }

  private clearTimers(entry: LeadEntry): void {
    if (entry.flushTimer) { clearTimeout(entry.flushTimer); entry.flushTimer = null; }
    if (entry.restartTimer) { clearTimeout(entry.restartTimer); entry.restartTimer = null; }
  }
}

/**
 * One MCP `lead_permission` call: validated input in, claude's documented answer out. Fail closed —
 * a malformed ask denies rather than guessing what claude meant.
 */
export async function permissionToolCall(driver: LeadDriver, lead: string, args: Record<string, unknown>): Promise<{ answer: PermissionAnswer } | { error: string }> {
  const invalid = permissionArgError(args);
  if (invalid !== null) return { error: invalid };
  const toolName = args.tool_name as string;
  const checked = permissionInput(args);
  if ('error' in checked) return checked;
  return { answer: await driver.permissionRequest(lead, toolName, checked.input) };
}

/** Validate the prompt-tool arguments. claude's --permission-prompt-tool calls also carry tool_use_id
 * (the asking tool call's id); it is accepted and bounded here but the card is keyed by the request id LeadDriver mints. */
function permissionArgError(args: Record<string, unknown>): string | null {
  for (const key of Object.keys(args)) if (!['tool_name', 'tool_input', 'input', 'tool_use_id'].includes(key)) return `lead_permission takes no '${key}'`;
  if (args.tool_use_id !== undefined && (typeof args.tool_use_id !== 'string' || !args.tool_use_id || args.tool_use_id.length > 200)) return 'tool_use_id must be a string of 1-200 characters';
  if (typeof args.tool_name !== 'string' || !args.tool_name || args.tool_name.length > 200) return 'tool_name must be a string of 1-200 characters';
  return null;
}

/** The tool call's input object, when claude sent a usable one. */
function permissionInput(args: Record<string, unknown>): { input: unknown } | { error: string } {
  const input = args.tool_input !== undefined ? args.tool_input : args.input;
  if (input === undefined) return { input: {} };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { error: 'tool_input must be an object' };
  return { input };
}
