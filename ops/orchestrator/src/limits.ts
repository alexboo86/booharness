// Phase 4: the load of each family's subscription, told to the lead when it
// seats one (design #10457: limits are reported to the lead, never enforced by
// orch). On 2026-09-22 a lead seated codex at 99% of its week because nothing
// in seat_create said so; the operator had to stop it by hand.
//
// The numbers come from ops/usage-snapshot.mjs, the same reader the
// session-start line uses: one HTTP call per vendor with the credentials its
// own CLI keeps. orch never blocks a seat on them. A reading is served from
// memory, refreshed in the background once it is older than FRESH_MS, and
// carries its age, so a stale number is never shown as a current one.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { takeSnapshot, RESET_PROGRAM_FAMILIES } from '../../usage-snapshot.mjs';
import { readCache } from '../../usage-cache.mjs';
import type { Family } from './providers/types.ts';
import { appliesToModel, lenientMatrix, paceReading, type AccountingRole } from './profiles.ts';
import { hasQuotaRates } from './quota-rates.ts';
import type { DoneUsage, DoneUsageOptions, TurnEnd } from './store.ts';
import { TokenKick } from './token-kick.ts';

export const FRESH_MS = 5 * 60_000;
/** How long a snapshot's reset inventory outlives FRESH_MS: one refresh cycle
 *  (a take, a 30 s token kick, the retry take) must land inside it, so a family
 *  with a good recent inventory keeps it between reads instead of flipping to
 *  unknown while the refresh that the same read triggered is still running.
 *  Past FRESH_MS + this bound the inventory reads unknown until a fresh
 *  snapshot lands: it may have been redeemed elsewhere in the meantime. */
export const INVENTORY_GRACE_MS = 2 * 60_000;
/** Snapshot-row families whose subscriptions bank resets (`ops/usage-snapshot.mjs`): their empty
 *  resets row is a confirmed zero — a reading that ages like any counts. Every other family's
 *  empty row means "no reset program" and never ages. */
const RESET_PROGRAMS = new Set(RESET_PROGRAM_FAMILIES);
/** From this share of any window up, seat_create warns and names less loaded families. */
export const HIGH_LOAD = 85;
/** A turn error that says the subscription ran out: a signal of its own, and the only one while a family cannot be read. */
// Exhaustion, not throttling: a transient 429 or "rate limit" blip is not a spent plan (review 2026-09-22), and a
// bare 429 inside a pid or a byte count is nothing at all.
export const QUOTA_ERROR = /quota|usage limit|limit (?:reached|exceeded)|insufficient.?balance|exceeded your current|out of credits/i;
/** How long a quota error is shown with the family's load. */
export const QUOTA_ERROR_MS = 24 * 3600_000;
/** Provider failures are transient, not evidence that the subscription is spent. */
// A service-side entitlement check while the login is still valid (task 1841): only a line that is the provider's
// own "Codex error: Unable to verify <words> access. Please try again." A quote of that line after another prefix
// on the same line (review: `rg "..."`) is not an outage.
// "Selected model is at capacity" (Pi 1.0.1 retries it, CHANGELOG #10278). Observed in orch.sqlite turns.error
// only for the older "currently at capacity" wording, whose rows show Pi's delivery shapes: the provider message
// at the start of the error string, bare or behind a Pi wrapper. Pi composes that wrapper itself:
// `Error Code ${event.code}: ${event.message}` (openai-responses-shared.js:643) and, for response.failed,
// `${error.code || "unknown"}: ${error.message}` (openai-responses-shared.js:651). The phrase and its wrappers
// are taken from that source, not from a stored row. Anchored at the string start with only those provider-owned
// prefixes: a quote after another prefix (`rg "Selected model is at capacity"`) or on a later line of an exit
// error (providers/pi.ts:190 appends stderr) is not an outage.
export const OUTAGE_ERROR = /service temporarily unavailable|model is currently at capacity|overloaded_error|\b(?:provider|server) overloaded\b|\b(?:status|error code)\s*[:=]?\s*529\b|\b(?:503|529)\s+(?:service unavailable|overloaded)\b|(?:^|\n)\s*Codex error: Unable to verify (?:[a-z0-9]+ ){1,4}access\. Please try again\.|^(?:(?:Error Code )?[A-Za-z0-9_.-]+: )?Selected model is at capacity/i;
export const OUTAGE_ERROR_MS = 20 * 60_000;
/**
 * A credential the provider does not have or refused: neither a spent plan nor an outage. It stands until a turn of
 * the family completes or AUTH_ERROR_MS passes, since an auto pick never retries a family ranked last and only a
 * re-login heals it (task 1519). The forms are Pi's ("No API key for provider:
 * x", "OAuth refresh failed for kimi-coding: ... unauthorized", orch.sqlite 2026-09-24) and the standard 401/403 ones;
 * a bare "auth" or "authorized" is not one (codex's cyber flag says "To get authorized for security work").
 */
export const AUTH_ERROR = /\bno api key (?:for|found|provided)\b|\bno (?:oauth )?credentials? (?:for|found|configured|available)\b|\boauth refresh failed\b(?! to reach)|\binvalid (?:x-)?api[ _-]?key\b|\binvalid_api_key\b|\bincorrect api key provided\b|\binvalid (?:authorization grant|access token|bearer token)\b|\bauthentication(?:_error| failed| required)\b|\bnot (?:logged in|authenticated)\b|\b(?:oauth|access|auth) token (?:has )?expired\b|\b401 unauthorized\b|\b403 forbidden\b|\b(?:status(?: code)?|error code|api error)\s*[:=]?\s*\(?40[13]\b|\bhttp\s*40[13]\s*(?::|\)|$)/i;
export const AUTH_ERROR_MS = 60 * 60_000;
/**
 * Turn errors orch writes itself (seats.ts turn end, providers/turn.ts TurnTimeout). They say nothing about the
 * provider and can quote a seat's own tool arguments: a loop interrupt over `rg "401 unauthorized"` is not an auth failure.
 */
export const ORCH_ERROR = /^(?:orch interrupted the turn:|stand token cap reached:|turn timed out after \d+ ms|seat was closed while its provider was starting)/;

/** The provider's own error of a turn that failed, or null when orch ended it (interrupt, token cap, deadline, close). */
export function providerError(end: Pick<TurnEnd, 'status' | 'error' | 'watch'>): string | null {
  if (end.status !== 'error' || !end.error) return null;
  // Structured first: an interrupted turn's error is always orch's own text.
  if (end.watch?.actions?.some((action) => action.action === 'interrupt')) return null;
  return ORCH_ERROR.test(end.error) ? null : end.error;
}
/**
 * How long a family's last good reading stands in when it cannot be read now. grok's and kimi's
 * tokens expire every few hours and only their CLI's next run refreshes them: on 2026-09-22 a seat
 * got grok's raw HTTP 401 for its load while the plan sat at 89%.
 */
export const LAST_GOOD_MS = 24 * 3600_000;

/** The snapshot's row per orch family. codex's subscription is the one the snapshot calls astra. */
const ROW: Record<Family, string | null> = {
  claude: 'claude',
  codex: 'astra',
  grok: 'grok',
  kimi: 'kimi',
  glm: 'glm',
  opencode: 'opencode',
  // Read through the Model Studio console session, not the plan key (memory #10506).
  qwen: 'qwen',
  mimo: 'mimo', // Console Cookie reader; a missing/expired Cookie stays unknown.
};

/** Set by the usage reader, never inferred from the number. Absent means unknown: do not episode-accumulate. */
export type MeterResolution = 'integer' | 'fractional';
export type Reading = { window: string; used: number; resetsAt: string | null; source?: string; resolution?: MeterResolution };
export type ResetInventory = { scope: '5h' | 'week' | 'both'; available: number; expiresAt: string | null };
type Row = { family: string; worst: number | null; readings: Reading[]; error: string | null; resets?: ResetInventory[] | null; resetsError?: string | null };
type Snapshot = { takenAt: string; rows: Row[]; cacheError?: string };

export type FamilyLoad = {
  family: Family;
  /** The highest share used of any window, 0-100; null when it could not be read. */
  worst: number | null;
  windows: string | null;
  /** The same windows, one by one, for the dashboard; null when there is no reading. */
  readings: Reading[] | null;
  /** Banked resets, not scheduled window refreshes. Missing in pre-inventory caches. Used for ranking credit and short-throttle relief, never redeemed by the picker. */
  resets?: ResetInventory[] | null;
  resetsError?: string | null;
  /** Timestamp of the reading actually used, including a newer per-family last-good row. */
  readAt?: string;
  /** Minutes since the reading; null when there is none. */
  ageMinutes: number | null;
  unknown: string | null;
  /** Set when worst is the family's last good reading because the latest read failed: why it failed. */
  stale: string | null;
  /** The last turn error of this family that said its quota ran out, within QUOTA_ERROR_MS. */
  quotaError: { at: string; message: string } | null;
  /** A recent provider outage, independent of subscription quota. */
  outageError: { at: string; message: string } | null;
  /** The last credential failure of this family, within AUTH_ERROR_MS and until a turn of it completes. */
  authError: { at: string; message: string } | null;
  warning: string | null;
};

/**
 * The burn calibration pairs still trusted: `{at, delta, tokens}` fragments seen in the last 7 days
 * (not in the future), last 5 per family window, positive delta and tokens.
 * `tokens` are quota units (task 1998 S1): a pair of a family with a rate table is trusted only
 * once it carries u:1; pairs of unrated families hold raw tokens, which equal their units.
 */
export function freshBurnPairs(value: unknown, now: number, family?: string): { at: number; delta: number; tokens: number; u?: number }[] {
  if (!Array.isArray(value)) return [];
  const fresh = (at: number) => at >= now - 7 * 24 * 3600_000 && at <= now;
  const rated = family !== undefined && hasQuotaRates(family);
  // `{at, factor}` pairs have no episode volume. The live 33%/turn figure was the median of those fragments.
  const pairs = value.filter((pair): pair is { at: number; delta: number; tokens: number; u?: number } =>
    !!pair && typeof pair.at === 'number' && fresh(pair.at)
    && typeof pair.delta === 'number' && Number.isFinite(pair.delta) && pair.delta > 0
    && typeof pair.tokens === 'number' && Number.isFinite(pair.tokens) && pair.tokens > 0
    && (!rated || pair.u === 1));
  return pairs.slice(-5);
}

export class Limits {
  private snapshot: Snapshot | null;
  private cacheUnavailable: string | null = null;
  private refreshing: Promise<void> | null = null;
  private take: () => Promise<Snapshot>;
  private kick: TokenKick | null;
  private now: () => number;
  private off: string | null;
  private quotaErrors = new Map<Family, { at: number; message: string }>();
  private outageErrors = new Map<Family, { at: number; message: string }>();
  private authErrors = new Map<Family, { at: number; message: string }>();
  /** Per snapshot row: the last reading that had numbers, with when it was taken. */
  private lastGood = new Map<string, { row: Row; takenAt: string }>();

  /** Where lastGood outlives a daemon restart; null keeps it in memory only. */
  private lastGoodFile: string | null;
  /** Recent accepted episodes per family/window: points over every quota unit since `used` last changed. A factor with no token volume is a fragment and is ignored. u:1 marks quota-unit calibration. */
  private factors = new Map<string, { at: number; delta: number; tokens: number; u?: number }[]>();
  /** Open integer episode. Zero-delta snapshots still spent units the meter cannot show until the next point. */
  private pending = new Map<string, { used: number; tokens: number; since: number; u?: number }>();
  private doneUsage: ((family: Family, options?: DoneUsageOptions) => DoneUsage[]) | null;

  constructor(options: { take?: () => Promise<Snapshot>; seed?: Snapshot | null; now?: () => number; off?: string; lastGoodFile?: string; doneUsage?: (family: Family, options?: DoneUsageOptions) => DoneUsage[]; kick?: TokenKick | null } = {}) {
    this.off = options.off ?? null;
    this.take = options.take ?? (takeSnapshot as () => Promise<Snapshot>);
    this.now = options.now ?? Date.now;
    this.lastGoodFile = this.off ? null : options.lastGoodFile ?? null;
    this.kick = this.off ? null : options.kick === undefined ? (options.take ? null : new TokenKick(undefined, undefined, this.now, undefined, this.lastGoodFile)) : options.kick;
    this.doneUsage = options.doneUsage ?? null;
    this.loadFactors();
    // The shared snapshot cache holds only the latest run: after a restart a family whose token had
    // expired would show unknown (kimi, 2026-09-22). Its last good reading is kept here instead.
    this.loadLastGood();
    this.dropExpiredPending();
    // The last snapshot any reader parked (session start, a lead's CLI run) is a fair first answer.
    this.snapshot = this.off ? null : options.seed === undefined ? (readCache(undefined, (error) => {
      this.cacheUnavailable = `usage cache unavailable (${error.message})`;
    }) as Snapshot | null) : options.seed;
    this.remember(this.snapshot);
  }

  private loadLastGood(): void {
    if (!this.lastGoodFile) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.lastGoodFile, 'utf8'));
    } catch {
      return; // none yet, or unreadable: the next good reading rewrites it
    }
    for (const [family, entry] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
      if (family === '__burn' || family === '__burnPending' || family === '__kick') continue;
      const { row, takenAt } = (entry ?? {}) as { row?: Row; takenAt?: string };
      const taken = typeof takenAt === 'string' ? Date.parse(takenAt) : NaN;
      const readings = Array.isArray(row?.readings) && row!.readings.every((reading) => typeof reading?.window === 'string' && typeof reading.used === 'number' && Number.isFinite(reading.used));
      if (row && row.family === family && typeof row.worst === 'number' && Number.isFinite(row.worst) && readings && taken <= this.now() && this.now() - taken < LAST_GOOD_MS) {
        this.lastGood.set(family, { row, takenAt: takenAt! });
      }
    }
  }

  private loadFactors(): void {
    if (!this.lastGoodFile) return;
    try {
      const saved = JSON.parse(readFileSync(this.lastGoodFile, 'utf8')) as { __burn?: Record<string, unknown>; __burnPending?: Record<string, unknown> };
      // Task 1998 S1 migration, no calibration gap: entries written before quota units hold raw tokens.
      // An unversioned pair or pending episode of a rated family is rescaled ONCE by the family's
      // units/raw ratio over its done turns of the last 7 days (1 when there are none), then marked u:1.
      // The model mix inside an old interval is unknown, so R is the family-wide estimate; the 5-pair
      // window replaces rescaled pairs with exact ones as episodes close.
      const ratios = new Map<string, number>();
      const ratio = (family: string): number => {
        let r = ratios.get(family);
        if (r === undefined) {
          r = 1;
          if (this.doneUsage) {
            let units = 0;
            let raw = 0;
            for (const turn of this.doneUsage(family as Family, { from: new Date(this.now() - 7 * 24 * 3600_000).toISOString() })) {
              if (typeof turn.tokens === 'number' && Number.isFinite(turn.tokens) && turn.tokens > 0
                && typeof turn.raw === 'number' && Number.isFinite(turn.raw) && turn.raw > 0) {
                units += turn.tokens;
                raw += turn.raw;
              }
            }
            r = raw > 0 ? units / raw : 1;
          }
          ratios.set(family, r);
        }
        return r;
      };
      const familyOf = (key: string) => key.slice(0, key.indexOf(':'));
      for (const [key, value] of Object.entries(saved.__burn ?? {})) {
        const family = familyOf(key);
        const versioned = hasQuotaRates(family) && Array.isArray(value)
          ? value.map((pair) => pair && typeof pair === 'object' && (pair as { u?: unknown }).u !== 1 && typeof (pair as { tokens?: unknown }).tokens === 'number'
              ? { ...(pair as Record<string, unknown>), tokens: (pair as { tokens: number }).tokens * ratio(family), u: 1 } : pair)
          : value;
        const pairs = freshBurnPairs(versioned, this.now(), family);
        if (pairs.length) this.factors.set(key, pairs);
      }
      for (const [key, value] of Object.entries(saved.__burnPending ?? {})) {
        const pending = value as { used?: number; tokens?: number; since?: number; u?: number };
        if (typeof pending?.used !== 'number' || !Number.isFinite(pending.used)) continue;
        if (typeof pending.tokens !== 'number' || !Number.isFinite(pending.tokens) || pending.tokens < 0) continue;
        if (typeof pending.since !== 'number' || !(pending.since >= this.now() - 7 * 24 * 3600_000 && pending.since <= this.now())) continue;
        const rated = hasQuotaRates(familyOf(key));
        const tokens = rated && pending.u !== 1 ? pending.tokens * ratio(familyOf(key)) : pending.tokens;
        this.pending.set(key, { used: pending.used, tokens, since: pending.since, ...(rated || pending.u === 1 ? { u: 1 } : {}) });
      }
    } catch { /* No usable calibration yet. */ }
  }

  /** Pending outlives lastGood (7d vs 24h). An episode whose base reading was not kept cannot see the gap, so it is dropped, not reconstructed. */
  private dropExpiredPending(): void {
    for (const key of this.pending.keys()) {
      const family = key.slice(0, key.indexOf(':')) as Family;
      const known = ROW[family] ? this.lastGood.get(ROW[family]!) : undefined;
      const window = key.slice(key.indexOf(':') + 1);
      if (!known?.row.readings.some((reading) => reading.window === window)) this.pending.delete(key);
    }
  }

  private remember(snapshot: Snapshot | null, calibrate = true): void {
    let changed = false;
    // A reading with no parseable time could never be aged, so it is not kept.
    if (!snapshot || !Number.isFinite(Date.parse(snapshot.takenAt))) return;
    for (const row of snapshot.rows ?? []) {
      if (typeof row.worst !== 'number' || !Number.isFinite(row.worst)) continue;
      const family = (Object.keys(ROW) as Family[]).find((key) => ROW[key] === row.family);
      // An older snapshot (the shared cache read at start) never replaces a newer reading kept on disk.
      const known = this.lastGood.get(row.family);
      if (known && Date.parse(known.takenAt) <= this.now() && Date.parse(known.takenAt) >= Date.parse(snapshot.takenAt)) continue;
      if (calibrate && known && family && this.doneUsage && Date.parse(known.takenAt) >= this.now() - 7 * 24 * 3600_000
        && Date.parse(snapshot.takenAt) <= this.now()) {
        const turns = this.doneUsage(family, { from: known.takenAt, to: snapshot.takenAt });
        const counted = turns.every((turn) => typeof turn.tokens === 'number' && Number.isFinite(turn.tokens) && turn.tokens >= 0)
          ? turns.reduce((sum, turn) => sum + turn.tokens!, 0) : null;
        const at = Date.parse(snapshot.takenAt);
        for (const current of row.readings) {
          const key = `${family}:${current.window}`;
          const previous = known.row.readings.find((reading) => reading.window === current.window);
          // A changed reset, an unreadable interval, or falling usage ends the episode. It is not a rate.
          if (!previous || !current.resetsAt || current.resetsAt !== previous.resetsAt || counted === null
            || !Number.isFinite(current.used) || !Number.isFinite(previous.used)) {
            this.pending.delete(key);
            continue;
          }
          // Resolution is a property of the source. A fractional meter can still read 11 then 12.
          const quantized = previous.resolution === 'integer' && current.resolution === 'integer';
          const stored = this.pending.get(key);
          const witnessed = !!stored && stored.used === previous.used && at - stored.since <= 7 * 24 * 3600_000;
          const open = witnessed ? stored : { used: previous.used, tokens: 0, since: Date.parse(known.takenAt) };
          const delta = current.used - open.used;
          if (!Number.isFinite(delta) || delta < 0) {
            this.pending.delete(key);
            continue;
          }
          const episode = open.tokens + counted;
          if (delta === 0) {
            // Only a source declared integer hides usage below one point. Fractional or unknown stays per interval.
            if (quantized && episode > 0) this.pending.set(key, { used: open.used, tokens: episode, since: open.since, u: 1 });
            else this.pending.delete(key);
            continue;
          }
          // The approach to this integer started before we were watching. Anchor only; the next crossing is the first rate.
          if (quantized && !witnessed) {
            this.pending.set(key, { used: current.used, tokens: 0, since: at, u: 1 });
            continue;
          }
          this.pending.delete(key);
          // No orch turns in the bucket that crossed: operator usage, not an orch rate. Do not invent one from earlier tokens.
          if (counted <= 0) continue;
          const tokens = quantized ? episode : counted;
          if (tokens <= 0) continue;
          const pairs = (this.factors.get(key) ?? []).filter((pair) => pair.at >= this.now() - 7 * 24 * 3600_000);
          this.factors.set(key, [...pairs, { at, delta, tokens, u: 1 }].slice(-5));
        }
      }
      this.lastGood.set(row.family, { row, takenAt: snapshot.takenAt });
      changed = true;
    }
    if (changed && this.lastGoodFile) {
      // Best effort and atomic: a reading that cannot be kept is still served from memory.
      try {
        mkdirSync(path.dirname(this.lastGoodFile), { recursive: true });
        // A kick may have reserved its cooldown since the previous snapshot; never erase it.
        let kick: unknown;
        try { kick = (JSON.parse(readFileSync(this.lastGoodFile, 'utf8')) as { __kick?: unknown }).__kick; } catch { /* No cooldown yet. */ }
        writeFileSync(`${this.lastGoodFile}.tmp`, `${JSON.stringify({ ...Object.fromEntries(this.lastGood), __burn: Object.fromEntries(this.factors), __burnPending: Object.fromEntries(this.pending), ...(kick ? { __kick: kick } : {}) })}\n`, 'utf8');
        renameSync(`${this.lastGoodFile}.tmp`, this.lastGoodFile);
      } catch {
        // ignored on purpose, see above
      }
    }
  }

  /** Start a refresh when the reading is missing or older than FRESH_MS; never waits for it. */
  refresh(): Promise<void> | null {
    if (this.off) return null;
    const taken = this.snapshot ? Date.parse(this.snapshot.takenAt) : NaN;
    if (this.refreshing || (Number.isFinite(taken) && this.now() - taken < FRESH_MS)) return this.refreshing;
    this.refreshing = this.take()
      // A run that read no family at all (network down) keeps the last good reading, which carries its age.
      .then(async (first) => {
        if (first.rows.some((row) => typeof row.worst === 'number') || !this.snapshot) this.snapshot = first;
        if (first.rows.some((row) => typeof row.worst === 'number')) this.cacheUnavailable = first.cacheError ?? null;
        this.remember(first);
        if (this.kick && await this.kick.kick(first.rows)) {
          const retry = await this.take();
          if (retry.rows.some((row) => typeof row.worst === 'number')) {
            this.snapshot = retry;
            this.cacheUnavailable = retry.cacheError ?? null;
          }
          this.remember(retry, false);
        }
      })
      .catch(() => undefined)
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** Remember only explicit subscription exhaustion, credential failure or provider outage evidence. */
  noteError(family: Family, message: string): void {
    // Quota evidence wins: a spent plan can also report itself as unavailable.
    if (QUOTA_ERROR.test(message)) this.quotaErrors.set(family, { at: this.now(), message: message.slice(0, 200) });
    else if (AUTH_ERROR.test(message)) this.authErrors.set(family, { at: this.now(), message: message.slice(0, 200) });
    else if (OUTAGE_ERROR.test(message)) this.outageErrors.set(family, { at: this.now(), message: message.slice(0, 200) });
  }

  /** A turn that completed shows the family is serving again. */
  noteSuccess(family: Family): void {
    this.quotaErrors.delete(family);
    this.outageErrors.delete(family);
    this.authErrors.delete(family);
  }

  private authError(family: Family): FamilyLoad['authError'] {
    const seen = this.authErrors.get(family);
    return seen && this.now() - seen.at < AUTH_ERROR_MS ? { at: new Date(seen.at).toISOString(), message: seen.message } : null;
  }

  private quotaError(family: Family): FamilyLoad['quotaError'] {
    const seen = this.quotaErrors.get(family);
    return seen && this.now() - seen.at < QUOTA_ERROR_MS ? { at: new Date(seen.at).toISOString(), message: seen.message } : null;
  }

  private outageError(family: Family): FamilyLoad['outageError'] {
    const seen = this.outageErrors.get(family);
    return seen && this.now() - seen.at < OUTAGE_ERROR_MS ? { at: new Date(seen.at).toISOString(), message: seen.message } : null;
  }

  private age(takenAt = this.snapshot?.takenAt): number | null {
    const taken = takenAt ? Date.parse(takenAt) : NaN;
    return Number.isFinite(taken) ? Math.max(0, Math.round((this.now() - taken) / 60_000)) : null;
  }

  private row(family: Family): Row | null {
    const name = ROW[family];
    return name ? this.snapshot?.rows.find((row) => row.family === name) ?? null : null;
  }

  load(family: Family): FamilyLoad {
    this.refresh();
    const base = this.reading(family);
    const quotaError = this.quotaError(family);
    const outageError = this.outageError(family);
    const authError = this.authError(family);
    let warning: string | null = null;
    if (authError) {
      warning = `${family} auth failure at ${authError.at} (ranked last for 60 min or until a turn of it completes): ${authError.message}`;
    } else if (outageError) {
      warning = `${family} provider outage at ${outageError.at} (back off 20 min): ${outageError.message}`;
    } else if (quotaError) {
      warning = `${family} failed a turn on its quota at ${quotaError.at}: ${quotaError.message}`;
    } else if (base.worst !== null && base.worst >= HIGH_LOAD) {
      const lighter = this.all().filter((other) => other.family !== family && other.worst !== null && other.worst < HIGH_LOAD && !other.quotaError && !other.authError).map((other) => `${other.family} ${Math.round(other.worst!)}%`);
      warning = `${family} has used ${Math.round(base.worst)}% of a window (${base.windows}; ${base.ageMinutes === null ? 'reading age unknown' : `read ${base.ageMinutes} min ago`}${base.stale ? `, not newer: ${base.stale}` : ''}); ${lighter.length ? `less loaded: ${lighter.join(', ')}` : `no family with a reading is below ${HIGH_LOAD}%`}`;
    }
    warning ??= this.snapshot?.cacheError ?? this.cacheUnavailable;
    return { ...base, ...this.inventory(family), quotaError, outageError, authError, warning };
  }

  private inventory(family: Family): Pick<FamilyLoad, 'resets' | 'resetsError'> {
    const row = this.row(family);
    // An empty inventory of a family without a reset program means "no program" and never
    // ages. A confirmed zero of a program family is a reading: it survives the refresh window
    // like any counts and turns unknown past the bound, so a stalled refresh cannot hide a
    // later grant behind a fresh empty read.
    if (row && row.resets?.length === 0 && !RESET_PROGRAMS.has(row.family)) return { resets: [], resetsError: null };
    // Inventory may have been redeemed elsewhere; never resurrect it from lastGood.
    const at = this.snapshot ? Date.parse(this.snapshot.takenAt) : NaN;
    if (this.off || !Number.isFinite(at) || at > this.now() || this.now() - at >= FRESH_MS + INVENTORY_GRACE_MS) {
      return { resets: null, resetsError: 'reset inventory stale or unavailable; waiting for a fresh read' };
    }
    return {
      resets: row?.resets?.map((entry) => ({
        ...entry, available: entry.expiresAt && Date.parse(entry.expiresAt) <= this.now() ? 0 : entry.available,
      })) ?? null,
      resetsError: row?.resets == null ? row?.resetsError ?? 'reset inventory not read yet' : null,
    };
  }

  private reading(family: Family): Omit<FamilyLoad, 'quotaError' | 'outageError' | 'authError' | 'warning'> {
    if (this.off) return { family, worst: null, windows: null, readings: null, ageMinutes: null, unknown: this.off, stale: null };
    if (!ROW[family]) return { family, worst: null, windows: null, readings: null, ageMinutes: null, unknown: `no usage reader for ${family}`, stale: null };
    const age = this.age();
    const row = this.row(family);
    const windows = (good: Row) => good.readings.map((reading) => `${reading.window} ${Math.round(reading.used)}%`).join(', ');
    const good = this.lastGood.get(ROW[family]!);
    const savedAt = good ? Date.parse(good.takenAt) : NaN;
    const snapshotAt = this.snapshot ? Date.parse(this.snapshot.takenAt) : NaN;
    const readable = row && typeof row.worst === 'number' && Number.isFinite(row.worst);
    // A cached snapshot can predate the persisted per-family reading after restart.
    if (readable && (!good || !Number.isFinite(savedAt) || savedAt > this.now() || savedAt <= snapshotAt || this.now() - savedAt >= LAST_GOOD_MS)) {
      return { family, worst: row.worst!, windows: windows(row), readings: row.readings, readAt: this.snapshot!.takenAt, ageMinutes: age, unknown: null, stale: null };
    }
    const failure = readable ? 'older snapshot than last good' : row ? row.error ?? 'unreadable' : this.snapshot ? `${family} is missing from the usage snapshot` : this.cacheUnavailable ?? 'no usage reading yet; asked for one';
    // A failed or older read does not erase what was known: keep ITS age and explain why it stands.
    if (good && Number.isFinite(savedAt) && savedAt <= this.now() && this.now() - savedAt < LAST_GOOD_MS) {
      return { family, worst: good.row.worst, windows: windows(good.row), readings: good.row.readings, readAt: good.takenAt, ageMinutes: this.age(good.takenAt), unknown: null, stale: failure };
    }
    return { family, worst: null, windows: null, readings: null, ageMinutes: age, unknown: failure, stale: null };
  }

  /** Last ten completed turns: critics only use critics; a scout's family fallback excludes critics. Other roles keep the family fallback below three turns. */
  estimate(family: Family, role: AccountingRole, current?: Pick<FamilyLoad, 'worst'> & { readings?: Reading[] | null }, model?: string, window?: string): { window: string; used: number; burn: number; resetsAt: string } | null {
    const load = current ?? this.load(family);
    const profile = lenientMatrix()[role][family];
    if (!profile) return null; // The caller supplies all family loads, including families this role cannot run.
    const applicable = load.readings?.filter((row) => appliesToModel(row, model ?? profile.model));
    const reading = window === undefined ? paceReading(family, applicable) : applicable?.find((row) => row.window === window) ?? null;
    const pairs = reading && this.factors.get(`${family}:${reading.window}`)?.filter((pair) => pair.at >= this.now() - 7 * 24 * 3600_000 && pair.at <= this.now());
    if (!reading || !Number.isFinite(reading.used) || !reading.resetsAt || !pairs?.length || !this.doneUsage) return null;
    const byRole = this.doneUsage(family, { role, limit: 10 });
    const turns = byRole.length >= 3 || role === 'critic' ? byRole
      : this.doneUsage(family, { limit: 10, ...(role === 'scout' ? { excludeRole: 'critic' } : {}) });
    if (!turns.length || turns.some((turn) => turn.tokens === null || turn.tokens <= 0)) return null;
    const mean = turns.reduce((sum, turn) => sum + turn.tokens!, 0) / turns.length;
    // Pooled over the week's episodes: every point over every token. Each episode ends on a point change and
    // carries all tokens since the last one, so the pool is exact on average; a per-episode median is not, and
    // keeping only episodes longer than a turn left kimi's 5h rate on one low episode (1.7% for a ~6% turn).
    // ±1 integer point on less volume than one of these turns moves the per-turn rate by more than a point.
    const tokens = pairs.reduce((sum, pair) => sum + pair.tokens, 0);
    if (tokens < mean) return null;
    const burn = pairs.reduce((sum, pair) => sum + pair.delta, 0) / tokens * mean;
    return burn > 0 && Number.isFinite(burn) ? { window: reading.window, used: reading.used, burn, resetsAt: reading.resetsAt } : null;
  }

  /** Every orch family, least loaded first; unreadable ones last (unknown is not free). */
  all(): FamilyLoad[] {
    // orch_status and the dashboard read only this: without the refresh the readings stood still
    // from the daemon's start (36 min old on 2026-09-23 while no seat was created).
    this.refresh();
    const rows = (Object.keys(ROW) as Family[]).map((family) => ({ ...this.reading(family), ...this.inventory(family), quotaError: this.quotaError(family), outageError: this.outageError(family), authError: this.authError(family), warning: null }));
    const rank = (load: FamilyLoad) => (load.worst === null ? Number.MAX_SAFE_INTEGER : load.worst);
    return rows.sort((a, b) => rank(a) - rank(b) || a.family.localeCompare(b.family));
  }
}
