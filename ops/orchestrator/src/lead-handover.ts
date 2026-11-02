// Task 3459 slice L1 (requirement R12): a supervised lead of any provider hands over by itself
// once its context reaches the limit. One LeadExtension over the driver: it watches each
// session's last usage frame, asks the lead at the limit (and then once per further band, the
// same rule as the interactive-lead hook) to write `memoryctl handoff` and reply with the id,
// verifies that id against the memory service, and only then restarts the session fresh with a
// seed naming the id. An unverified id never restarts anything; the reason goes out as a status
// frame. A pending permission card or a running turn defers the restart, never skips it.
import { LEAD_BAND_SHARE, count, leadBand, leadLimit } from './leads.ts';
import { LeadUsageTracker, type LeadEvent, type LeadExtension, type LeadExtensionContext } from './lead-driver.ts';
import { readInstallSetting } from './settings/index.ts';
import type { Logger } from './log.ts';
import { readMemory } from '../../../scripts/memory/service-client.mjs';

/** The driver seams the extension drives; http.ts and the tests wire the LeadDriver methods. */
export type LeadHandoverDeps = {
  /** One user turn to the lead (LeadDriver.send); false when it has no live child. */
  send: (lead: string, text: string) => boolean;
  /** Stop the child and start a fresh session seeded with the prompt (LeadDriver.restartFresh). */
  restartFresh: (lead: string, seededPrompt: string) => boolean;
  /** One status frame on the lead's stream (LeadDriver.emitStatus). */
  emitStatus: (lead: string, text: string) => boolean;
  /** Rebinds the chat handle bound to the replaced session onto the new one; optional. */
  rebind?: (oldSession: string, newSession: string) => boolean;
  /** The install state dir for the `lead.handover` toggle; unset leaves the handover ungated. */
  stateDir?: string;
  log?: Logger;
  now?: () => number;
  /** Usage source; defaults to the extension's own LeadUsageTracker. */
  usage?: Pick<LeadUsageTracker, 'onEvent' | 'usage'>;
};

/** What one lead's watcher holds between turns; a new session starts a fresh watch. */
type Watch = {
  session: string | null;
  /** An ask was already sent in this session (the re-ask waits for the next band). */
  asked: boolean;
  /** The ask turn is open and its result text is the reply to verify. */
  awaitReply: boolean;
  /** A verification fetch is in flight; its late answer may no longer act. */
  verifying: boolean;
  /** A verified handoff id waiting for the restart gate (no card pending, no turn running). */
  verifiedId: number | null;
  askedBand: number | null;
  askedAt: number;
  /** After compaction dropped the tokens below the limit, the level that re-arms the ask. */
  nextAskTokens: number | null;
  /** One-shot status reports per session (no usage frame; unreadable toggle). */
  reported: Set<string>;
  /** The deferral reason already reported, so a wait is named once, not per turn. */
  deferredReported: boolean;
};

type LeadRecord = {
  watch: Watch;
  /** Cards opened minus cards settled for this lead, from permission_request/_resolved frames. */
  pendingCards: number;
  /** A prompt left through onBeforeSend and no result frame closed the turn yet. */
  turnRunning: boolean;
  /** The session the last frame named; a change of session resets the watch. */
  lastSession: string | null;
  lastResult: string;
  /** The window on this extension's last usage frame, to see a window that lands late. */
  usageWindow: { session: string | null; window: number | null } | null;
};

const freshWatch = (session: string | null): Watch => ({
  session, asked: false, awaitReply: false, verifying: false, verifiedId: null,
  askedBand: null, askedAt: 0, nextAskTokens: null, reported: new Set(), deferredReported: false,
});

const k = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/** Prefer an explicit #id; an untagged id must be the entire reply, not a token count. */
function parseHandoffId(text: string): number | null {
  const tagged = /#(\d{1,9})\b/.exec(text);
  if (tagged) return Number(tagged[1]);
  const plain = /^\s*(?:id\s+)?(\d{1,9})\s*$/i.exec(text);
  return plain ? Number(plain[1]) : null;
}

function askText(used: number, limit: number): string {
  return `[orch] Your context is ${k(used)} tokens, past the ${k(limit)} handover limit (decision #11903). `
    + 'Finish the step in hand, then run memoryctl handoff now with the open work and reply with the handoff id alone. Start no new work.';
}

function seedText(id: number): string {
  return `You continue this lead after a self handover. Read handoff #${id} with memoryctl get ${id} and continue its open work.`;
}

/** The memory record of one id, through the canonical client the memoryctl CLI uses. */
type HandoffRecord = { kind?: unknown; ts?: unknown; session_id?: unknown; agent?: unknown };

/** A recorded session is authoritative; a generic client agent cannot override it. */
function belongsToAskingLead(record: HandoffRecord, session: string | null, lead: string): boolean {
  if (session === null) return false;
  if (record.session_id != null) return record.session_id === session;
  return record.agent === session || record.agent === lead;
}

/** A fresh handoff must belong to the asking session; a legacy agent owner is also accepted. */
async function verifyHandoff(id: number, askedAt: number, session: string | null, lead: string): Promise<{ ok: boolean; reason: string | null }> {
  let record: HandoffRecord;
  try {
    record = await readMemory(`entry?id=${id}`) as HandoffRecord;
  } catch (error) {
    return { ok: false, reason: `handoff #${id} could not be verified: ${(error as Error).message}` };
  }
  if (record?.kind !== 'handoff') return { ok: false, reason: `#${id} is not a handoff entry` };
  if (typeof record.ts !== 'number' || !Number.isFinite(record.ts) || record.ts < askedAt) return { ok: false, reason: `handoff #${id} was written before the request` };
  if (!belongsToAskingLead(record, session, lead)) return { ok: false, reason: `handoff #${id} does not belong to the asking lead` };
  return { ok: true, reason: null };
}

/**
 * The supervised lead's autonomy loop (R12): reads the last usage per session, asks for a
 * verified `memoryctl handoff` at the limit, and restarts the session fresh only on one. The
 * extension is constructed before its driver and holds the driver seams as functions, so
 * `restartFresh`, `send` and `emitStatus` stay the driver's own.
 */
export class LeadHandoverExtension implements LeadExtension {
  readonly id = 'handover';
  enabled = true;
  private readonly deps: LeadHandoverDeps;
  private readonly usage: Pick<LeadUsageTracker, 'onEvent' | 'usage'>;
  private readonly now: () => number;
  private readonly byLead = new Map<string, LeadRecord>();

  constructor(deps: LeadHandoverDeps) {
    this.deps = deps;
    this.usage = deps.usage ?? new LeadUsageTracker();
    this.now = deps.now ?? Date.now;
  }

  onEvent(event: LeadEvent, ctx: LeadExtensionContext): void {
    const record = this.record(ctx.lead);
    record.lastSession = event.session;
    switch (event.kind) {
      case 'usage':
        this.onUsage(record, event, ctx);
        return;
      case 'result':
        record.lastResult = typeof event.text === 'string' ? event.text : '';
        return;
      case 'permission_request':
        record.pendingCards += 1;
        return;
      case 'permission_resolved':
        record.pendingCards = Math.max(0, record.pendingCards - 1);
        // A deferred handover may become possible the moment the last card settles.
        if (record.watch.verifiedId !== null) this.maybeRestart(ctx.lead);
        return;
      case 'session.replaced':
        this.sessionReplaced(ctx, event);
        return;
      default:
        return;
    }
  }

  /** A usage frame records the session's numbers. When it changes the window on usage already
   *  recorded — a window that first arrives or changes after the turn closed (a slow
   *  get_session_stats answer, providers/pi-lead.ts) — re-evaluate here so the handover is not
   *  lost; turn end stays the normal path. A frame inside a running turn or an awaited reply never
   *  re-evaluates, so an ask's reply text is never read early. */
  private onUsage(record: LeadRecord, event: LeadEvent, ctx: LeadExtensionContext): void {
    // The window is remembered here: the daemon registers a shared tracker ahead of this
    // extension, so the tracker already holds this frame when it arrives.
    const before = record.usageWindow?.session === event.session ? record.usageWindow : null;
    this.usage.onEvent(event);
    const window = event.usage?.contextWindow;
    record.usageWindow = { session: event.session, window: typeof window === 'number' ? window : null };
    const changed = before !== null && typeof window === 'number' && window !== before.window;
    if (changed && !record.turnRunning && !record.watch.awaitReply) this.evaluate(ctx.lead, ctx.session);
  }

  onBeforeSend(prompt: string, ctx: LeadExtensionContext): string {
    const record = this.record(ctx.lead);
    record.turnRunning = true;
    record.lastSession = ctx.session;
    return prompt;
  }

  onTurnEnd(ctx: LeadExtensionContext): void {
    const record = this.record(ctx.lead);
    record.turnRunning = false;
    record.lastSession = ctx.session;
    this.evaluate(ctx.lead, ctx.session);
  }

  /** Same lead id and chat handle stay: a handle bound to the replaced session rejoins under
   *  the new one, exactly as a successor's own chat_join would supersede it. */
  private sessionReplaced(ctx: LeadExtensionContext, event: LeadEvent): void {
    const record = this.record(ctx.lead);
    if (this.deps.rebind && event.replaced?.old && event.replaced.new) {
      try { this.deps.rebind(event.replaced.old, event.replaced.new); }
      catch (error) { this.deps.log?.('warn', 'lead.handover_rebind_error', { lead: ctx.lead, error: String(error) }); }
    }
    record.watch = freshWatch(event.session);
  }

  private record(lead: string): LeadRecord {
    let record = this.byLead.get(lead);
    if (!record) {
      record = { watch: freshWatch(null), pendingCards: 0, turnRunning: false, lastSession: null, lastResult: '', usageWindow: null };
      this.byLead.set(lead, record);
    }
    return record;
  }

  /** One status frame, unless the lead left the driver or the reason was already reported. */
  private note(lead: string, record: LeadRecord, once: string | null, text: string): void {
    if (once !== null) {
      if (record.watch.reported.has(once)) return;
      record.watch.reported.add(once);
    }
    this.deps.emitStatus(lead, text);
  }

  private evaluate(lead: string, session: string | null): void {
    const record = this.record(lead);
    if (record.watch.session !== session) record.watch = freshWatch(session);
    if (!this.toggleOn(lead, record)) return;
    const watch = record.watch;
    // A wait ended by a turn that just closed: the gate re-checks the card count.
    if (watch.verifiedId !== null) {
      this.maybeRestart(lead);
      return;
    }
    if (watch.verifying) return;
    const usage = this.usage.usage(session);
    if (usage === null) {
      this.note(lead, record, 'no-usage', 'handover: no usage frame this session; the limit is never estimated');
      return;
    }
    const used = count(usage.input) + count(usage.cacheRead) + count(usage.cacheCreate);
    const limit = leadLimit(typeof usage.contextWindow === 'number' ? usage.contextWindow : null);
    const band = leadBand(used, limit);
    if (watch.awaitReply) {
      this.evaluateReply(lead, record);
      return;
    }
    this.askWhenDue(lead, record, used, limit, band);
  }

  /** The ask rule: first at the limit, then once per further band, re-armed a tenth above a
   *  compaction floor — compaction is not a handover, so a session that already crossed the
   *  limit keeps being asked, exactly as the interactive-lead hook asks it. */
  private askWhenDue(lead: string, record: LeadRecord, used: number, limit: number, band: number | null): void {
    const watch = record.watch;
    const due = watch.asked
      ? (band !== null && band > (watch.askedBand ?? -1)) || (watch.nextAskTokens !== null && used >= watch.nextAskTokens)
      : band !== null;
    if (due) {
      this.sendAsk(lead, record, used, limit, band);
    } else if (watch.asked && band === null) {
      const threshold = used + limit * LEAD_BAND_SHARE;
      watch.nextAskTokens = Math.min(watch.nextAskTokens ?? threshold, threshold);
    }
  }

  /** lead.handover (default on), read per evaluation; an unreadable document fails closed. */
  private toggleOn(lead: string, record: LeadRecord): boolean {
    if (this.deps.stateDir === undefined) return true;
    try {
      return readInstallSetting(this.deps.stateDir, 'lead.handover') !== false;
    } catch (error) {
      this.note(lead, record, 'toggle-unreadable', `handover: lead.handover could not be read, so no self handover: ${(error as Error).message}`);
      return false;
    }
  }

  private sendAsk(lead: string, record: LeadRecord, used: number, limit: number, band: number | null): void {
    const watch = record.watch;
    const at = this.now();
    if (!this.deps.send(lead, askText(used, limit))) {
      this.note(lead, record, null, 'handover: ask not delivered: the lead has no live child');
      return;
    }
    watch.asked = true;
    watch.awaitReply = true;
    watch.askedAt = at;
    watch.askedBand = band ?? watch.askedBand;
    watch.nextAskTokens = null;
  }

  private evaluateReply(lead: string, record: LeadRecord): void {
    const watch = record.watch;
    const id = parseHandoffId(record.lastResult);
    if (id === null || !Number.isSafeInteger(id) || id <= 0) {
      this.unverified(lead, record, 'no handoff id in the reply');
      return;
    }
    watch.verifying = true;
    const token = watch;
    verifyHandoff(id, watch.askedAt, watch.session, lead)
      .then((verdict) => this.settleReply(lead, token, id, record, verdict))
      .catch((error: unknown) => this.settleReply(lead, token, id, record, { ok: false, reason: String(error) }));
  }

  /** A verification settled: act only when the session it answered for never moved on. */
  private settleReply(lead: string, token: Watch, id: number, record: LeadRecord, verdict: { ok: boolean; reason: string | null }): void {
    // A session that moved on (replaced, stopped) no longer acts on a late answer.
    const live = this.byLead.get(lead);
    if (live?.watch !== token || token.session !== live.lastSession) return;
    token.verifying = false;
    token.awaitReply = false;
    if (!verdict.ok) {
      this.unverified(lead, record, verdict.reason ?? 'verification failed');
      return;
    }
    token.verifiedId = id;
    this.maybeRestart(lead);
  }

  private unverified(lead: string, record: LeadRecord, reason: string): void {
    record.watch.awaitReply = false;
    this.note(lead, record, null, `handover: ${reason}; no restart, asking again at the next band`);
  }

  /** Restart only with no pending card and no running turn; otherwise wait and say so once. */
  private maybeRestart(lead: string): void {
    const record = this.byLead.get(lead);
    const watch = record?.watch;
    if (!record || !watch || watch.verifiedId === null || watch.verifying) return;
    if (!this.toggleOn(lead, record)) return;
    if (record.turnRunning || record.pendingCards > 0) {
      this.deferOnce(lead, record);
      return;
    }
    const id = watch.verifiedId;
    watch.verifiedId = null;
    watch.awaitReply = false;
    if (!this.deps.restartFresh(lead, seedText(id))) {
      this.deps.emitStatus(lead, `handover: restart of ${lead} refused`);
    }
  }

  /** A verified handover waits; the reason is named once, not once per turn or card. */
  private deferOnce(lead: string, record: LeadRecord): void {
    const watch = record.watch;
    if (watch.deferredReported) return;
    watch.deferredReported = true;
    const reason = record.pendingCards > 0 ? 'a permission card is pending' : 'a turn is running';
    this.deps.emitStatus(lead, `handover: verified handoff #${watch.verifiedId} waits: ${reason}`);
  }
}
