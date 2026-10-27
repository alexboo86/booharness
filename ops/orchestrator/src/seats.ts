// Seats: a provider session with a role, a checkout and a turn history. The
// live sessions sit in this process; the store holds everything a restart must
// not lose (the provider's session id, every turn and its outcome).
import os from 'node:os';
import { adapterFor as realAdapterFor } from './providers/index.ts';
import type { Family, Harness, ProviderAdapter, ProviderSession, TurnEvent, TurnResult } from './providers/types.ts';
import type { PiToolManifest } from './providers/pi.ts';
import { closing, deadlineDelayMs, imageSkillOf, LESSON_ID, reportNowMessage, seatContext } from './context.ts';
import { steRuleBlock } from './shared.entry.ts';
import { seatInstruments } from './shared.entry.ts';
import { type CodexEdit } from './codex-edit.ts';
import { type HashlineEdit } from './hashline-edit.ts';
import { gradeReport, unsupportedFindings, type Finding, type Grade, type Sibling } from './grading.ts';
import { LESSON_ROLES, accountCorrection, accountRepair, appliedLessons, parseReport, REPAIR_QUOTE_CHARS, repairPrompt, reportedChecks, supportPrompt, type ReportRole } from './report.ts';
import { chatPostTable } from './chat.ts';
import { memberLabel, tallyTable } from './table.ts';
import { autoApplyLessons, brevityFields, recordLessonRepair, type MemoryProposal } from './memory-proposals.ts';
import { type Seat, type Store, type Turn, type TurnEnd, type TurnWatchRecord, type BypassScope, TERMINAL_TURN } from './store.ts';
import { steerMessage, TurnWatch, type WatchAction } from './watch.ts';
import { countTool, rtkHookRewrites, rtkMissed } from './toolkinds.ts';
import { type AccountingRole, type Load, type ProfileRole, type Reservation } from './profiles.ts';
import type { QualityAnswer } from './role-quality.ts';
import { probeLoad, type LoadProbe, type Target } from './placement.ts';
import { moveCheckout } from './remote-repo.ts';
import { verifyChecks } from './check-verify.ts';
import { type SeatTool } from './shared.entry.ts';
import type { PruneDecision } from './prune.ts';
import {
  ROLE_POLICY, roleTurnLimit, landable, reviewRights, MAX_QUEUED_TURNS, REPAIR, SUPPORT, MAX_REPAIRS, SUPPORT_MIN_LEFT, LESSON_HOLD_MS, TREE_HOLD_MS,
  gitAsync, reviewRepo, currentScope, withEarlier, addUsage, SeatClosed,
} from './seats-defs.ts';
import type { SeatRole, CreateSeat, Digest, Options, SeatOverlap, Choose, PromptOptions, ScopeDecision } from './seats-defs.ts';
import * as scopeMethods from './seats-scope.ts';
import * as drainMethods from './seats-drain.ts';
import * as provisionMethods from './seats-provision.ts';
import * as digestMethods from './seats-digest.ts';
import * as verifyMethods from './seats-verify.ts';
import * as closeMethods from './seats-close.ts';
import * as recoverMethods from './seats-recover.ts';
import * as promptMethods from './seats-prompt.ts';
import * as createMethods from './seats-create.ts';

// Re-exports: the names below lived here before seats-defs.ts existed (task 2143 slice 1);
// importers keep importing them from seats.ts.
export {
  ROLE_POLICY, claudeTranscriptPath, NO_FILES_WARNING, BRIEF_WORDS, WIDE_BRIEF_P, MAX_QUEUED_TURNS, REPAIR, SUPPORT, MAX_REPAIRS, SUPPORT_MIN_LEFT, FRESH_CONTEXT, EARLIER_REPORTS, LESSON_HOLD_MS, TREE_HOLD_MS, MAX_SIBLINGS,
} from './seats-defs.ts';
export type { SeatRole, CreateSeat, Digest, SeatOverlap, Recheck, Choose, PromptOptions, ScopeDecision } from './seats-defs.ts';

/** Not-voting labels that fit under the 600 code-point post cap, then `+N more`. Empty when even that suffix does not fit. */
function fittingNotVoting(prefix: string, labels: readonly string[]): string {
  if (labels.length === 0) return '';
  const head = '\nNot voting: ';
  const fits = (line: string): boolean => Array.from(prefix + line).length <= 600;
  let listed = 0;
  for (let i = 0; i < labels.length; i++) {
    const omitted = labels.length - (i + 1);
    const suffix = omitted > 0 ? `, +${omitted} more` : '';
    if (!fits(`${head}${labels.slice(0, i + 1).join(', ')}${suffix}`)) break;
    listed = i + 1;
  }
  const omitted = labels.length - listed;
  if (listed === 0) {
    const only = `${head}+${omitted} more`;
    return fits(only) ? only : '';
  }
  return `${head}${labels.slice(0, listed).join(', ')}${omitted > 0 ? `, +${omitted} more` : ''}`;
}

/** One board entry of a turn's live log (task 2883): `seq` is the entry's stable position in the turn. */
export type TurnLiveEntry =
  | { seq: number; at: string; kind: 'text' | 'thought'; text: string }
  | { seq: number; at: string; kind: 'tool'; name: string; status: string; args?: string };

/** At most this many live-log entries per turn; the oldest are dropped and counted as `trimmed`. */
export const TURN_LOG_MAX_ENTRIES = 500;
/** At most this many bytes of logged content per turn (task 2883). */
export const TURN_LOG_MAX_BYTES = 256 * 1024;
/** A single merged entry is cut to this many characters, so one entry alone can never pass the byte cap. */
const TURN_LOG_ENTRY_CHARS = 65_536;
/** The daemon retains at most this many turn logs (a seat keeps only its last ended one). */
export const TURN_LOG_MAX_TURNS = 50;
/** A tool entry's args as JSON, cut to this many characters. */
const TURN_LOG_ARGS_CHARS = 400;

const entryBytes = (entry: TurnLiveEntry): number => Buffer.byteLength(entry.kind === 'tool' ? `${entry.name}${entry.status}${entry.args ?? ''}` : entry.text);

/**
 * The bounded live log of one turn (task 2883): consecutive text (or thought) deltas merge into one
 * entry, a tool entry keeps name, status and args as JSON cut to 400 characters, and the caps drop
 * the oldest entries and count them as `trimmed`. Volatile by design: a restart loses every log.
 */
export class TurnLiveLog {
  entries: TurnLiveEntry[] = [];
  /** The seq the next NEW entry takes; deltas merging into the last entry keep its seq. */
  next = 1;
  trimmed = 0;
  bytes = 0;
  ended = false;
  readonly seatId: string;
  constructor(seatId: string) { this.seatId = seatId; }

  add(event: TurnEvent): void {
    if (event.kind === 'text' || event.kind === 'thought') {
      const last = this.entries.at(-1);
      if (last && last.kind === event.kind) {
        const merged = last.text + event.delta;
        if (merged.length > TURN_LOG_ENTRY_CHARS) {
          // A merged entry keeps the NEWEST tail when it alone would pass the entry cap. Only the
          // delta and the dropped head are measured — never the whole accumulated text: this runs
          // on every Pi stdout event.
          const head = merged.slice(0, merged.length - TURN_LOG_ENTRY_CHARS);
          last.text = merged.slice(-TURN_LOG_ENTRY_CHARS);
          this.bytes += Buffer.byteLength(event.delta) - Buffer.byteLength(head);
        } else {
          this.bytes += Buffer.byteLength(event.delta);
          last.text = merged;
        }
      } else {
        const text = event.delta.length > TURN_LOG_ENTRY_CHARS ? event.delta.slice(-TURN_LOG_ENTRY_CHARS) : event.delta;
        this.entries.push({ seq: this.next++, at: new Date().toISOString(), kind: event.kind, text });
        this.bytes += Buffer.byteLength(text);
      }
    } else if (event.kind === 'tool') {
      let args: string | undefined;
      if (event.args !== undefined) {
        try { args = JSON.stringify(event.args); } catch { args = String(event.args); }
        args = args.slice(0, TURN_LOG_ARGS_CHARS);
      }
      this.entries.push({ seq: this.next++, at: new Date().toISOString(), kind: 'tool', name: event.name, status: event.status, ...(args !== undefined ? { args } : {}) });
      this.bytes += Buffer.byteLength(`${event.name}${event.status}${args ?? ''}`);
    } else return;
    while (this.entries.length > TURN_LOG_MAX_ENTRIES || (this.bytes > TURN_LOG_MAX_BYTES && this.entries.length > 1)) {
      this.bytes -= entryBytes(this.entries.shift()!);
      this.trimmed += 1;
    }
  }

  /**
   * Entries with seq past `afterSeq`, and the `after` a poller should pass next time: one below the
   * last entry's seq while that entry can still grow (a running turn's merged delta), else the last
   * entry's seq — so a poller re-reads the one entry that mutates and never misses its growth.
   */
  after(afterSeq: number): { entries: TurnLiveEntry[]; next: number } {
    const last = this.entries.at(-1);
    const next = !this.ended && last && last.kind !== 'tool' ? last.seq - 1 : this.next - 1;
    // Held entries are consecutive from trimmed + 1, so a seq is an array index: a poll reads only
    // the entries it returns, never the whole array.
    const first = this.trimmed + 1;
    const from = afterSeq + 1 > first ? afterSeq + 1 : first;
    return { entries: this.entries.slice(from - first), next };
  }
}

export class SeatManager {
  store: Store;
  options: Required<Omit<Options, 'adapterFor' | 'provision' | 'prepareRemoteCheckout' | 'syncHostRuntime' | 'daemonRuntime' | 'moveRemoteCheckout' | 'removeRemoteCheckout' | 'dropGoneRegistration' | 'probeRemoteDir' | 'setupRemote' | 'snapshotRemote' | 'syncRemoteMirror' | 'removeRemoteMirror' | 'listRemoteCheckouts' | 'removeOrphanMirror' | 'context' | 'onTurnEnd' | 'onDrainIdle' | 'grade' | 'ask' | 'rtkMissed' | 'landedCheck' | 'hashlineEditFor' | 'codexEditFor'>> & Pick<Options, 'adapterFor' | 'provision' | 'prepareRemoteCheckout' | 'syncHostRuntime' | 'daemonRuntime' | 'moveRemoteCheckout' | 'removeRemoteCheckout' | 'dropGoneRegistration' | 'probeRemoteDir' | 'setupRemote' | 'snapshotRemote' | 'syncRemoteMirror' | 'removeRemoteMirror' | 'listRemoteCheckouts' | 'removeOrphanMirror' | 'context' | 'onTurnEnd' | 'onDrainIdle' | 'grade' | 'ask' | 'rtkMissed' | 'landedCheck' | 'hashlineEditFor' | 'codexEditFor'>;
  live = new Map<string, ProviderSession>();
  /** One chain per seat: provisioning, then each turn in order. */
  chains = new Map<string, Promise<void>>();
  /** Unsettled chain tails only; chains also retains completed promises. */
  busyChains = new Set<string>();
  waiters = new Map<string, Set<() => void>>();
  /** Seats whose close was asked for: queued turns are cancelled at once, and a running turn ends as cancelled. */
  closing = new Set<string>();
  autoCloseMissingRepoLogged = new Set<string>();
  /** Prevent duplicate host cleanup when close is called again while its background step runs. */
  remoteClosing = new Set<string>();
  /** The files a queued turn's brief named. Also stored on the turn so a drain restart can start it. */
  briefFiles = new Map<string, string[]>();
  /** restart --when-idle: accept turns, do not start them, exit when nothing is running. */
  draining = false;
  /** The idle exit has been asked for; a re-check clears this if work appeared. */
  drainLeaving = false;
  /** Only turns whose callback was skipped (or never chained) by the drain. */
  drainHeld = new Map<string, number>();
  /** A same-reviewer recheck turn's snapshot of the coder worktree: the reviewer's checkout moves there as the turn starts (task 1605). */
  recheckCheckouts = new Map<string, string>();
  tokenCaps = new Map<string, number>();
  scopePending = new Map<string, Promise<void>>();
  /** A bypassed first brief's background Jev reading per turn (task 1943): null while pending, deleted when the turn's watch is persisted. */
  bypassScope = new Map<string, BypassScope | null>();
  recheckOptOut = new Set<string>();
  /**
   * Per-turn registry of work that runs after finishTurn and writes digest fields (memory #12411):
   * wait() (any timeout, 0 included) holds up to each entry's bound and digest() reports the field
   * as pending while an entry is registered. Every post-finish step registers here via afterTurn();
   * an ad-hoc hold is how the next step forgets.
   */
  postTurn = new Map<string, Map<string, { settled: Promise<void>; until: number }>>();

  /** Register post-finish work before the turn is marked ended; release() when its result is recorded. */
  private afterTurn(turnId: string, label: string, holdMs: number): { release: () => void } {
    let release!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    let entries = this.postTurn.get(turnId);
    if (!entries) this.postTurn.set(turnId, (entries = new Map()));
    entries.set(label, { settled, until: Date.now() + holdMs });
    // Hard cap well past the hold: work that never settles must not leak the entry; past the cap the
    // digest stops claiming pending for work presumed dead.
    const expire = setTimeout(() => {
      entries.delete(label);
      if (!entries.size && this.postTurn.get(turnId) === entries) this.postTurn.delete(turnId);
    }, holdMs + this.options.afterTurnCapMs);
    expire.unref?.();
    return {
      release: () => {
        clearTimeout(expire);
        release();
        entries.delete(label);
        if (!entries.size && this.postTurn.get(turnId) === entries) this.postTurn.delete(turnId);
      },
    };
  }

  /** True while post-finish work `label` has not recorded its result, even past its bound. */
  afterTurnPending(turnId: string, label: string): boolean {
    return this.postTurn.get(turnId)?.has(label) ?? false;
  }
  /** Git observations are refreshed on prompts only, never on the board polling path. */
  observedFiles = new Map<string, string[]>();
  /** Rebuilt only when turn files or an observation changes, not on every board poll. */
  normalizedFiles = new Map<string, Set<string>>();
  observationFailed = new Set<string>();
  landed = new Set<string>();
  /** The family pick's inputs for a reviewer orch creates itself (a recheck's new reviewer); http.ts sets it. */
  chooser: (() => Choose | Promise<Choose>) | null = null;
  seatTool: ((seat: Seat) => SeatTool | null) | null = null;
  /** Per repo and title: the reviewer turn now settling, so the next one grades after it has ended. */
  settling = new Map<string, Promise<void>>();
  /** Tool calls of each running turn so far, by kind (toolkinds.ts): the stored ones are written only when the turn ends. */
  liveTools = new Map<string, { count: number; kinds: Record<string, number> }>();
  /** Each turn's bounded live log (task 2883): volatile, lost on restart; http.ts serves it to the board. */
  turnLogs = new Map<string, TurnLiveLog>();
  /** The check verification running for a seat's ended turn: close() aborts it rather than wait out its cap. */
  verifying = new Map<string, AbortController>();

  constructor(store: Store, options: Options) {
    this.store = store;
    this.options = { snapshotRemoteMaxBytes: createMethods.SNAPSHOT_REMOTE_MAX_BYTES, turnTimeoutMs: 30 * 60_000, remoteTurnSyncMs: 120_000, home: os.homedir(), verifyChecks, probeLoad, recheckHoldMs: 90_000, lessonHoldMs: LESSON_HOLD_MS, treeHoldMs: TREE_HOLD_MS, afterTurnCapMs: 10 * 60_000, autoLessons: autoApplyLessons, ...options };
  }

  useChooser(choose: () => Choose | Promise<Choose>): void {
    this.chooser = choose;
  }

  /** http.ts issues each worker session its scout_request endpoint and token (scout-request.ts). */
  useSeatTool(issue: (seat: Seat) => SeatTool | null): void {
    this.seatTool = issue;
  }

  adapter(family: Family, harness: Harness): ProviderAdapter {
    return (this.options.adapterFor ?? realAdapterFor)(family, harness);
  }

  /**
   * `loads` and `leadFamilies` choose the family when the lead names none, with
   * the creating lead's own family — every active lead's when no `session`
   * resolved (decision #17805 D2); except for a coder seat, decision #11829 —
   * and the author's stepping aside (profiles.ts).
   */
  /** In-flight creates by request_id, with the role, title, repo, effective images and options a retry must match. */
  creating = new Map<string, { role: string; title: string; repo: string; critic: boolean; images: boolean; options?: string[]; work: Promise<Seat> }>();

  // Not async on the common path: returning createSeat's promise unchanged keeps the
  // exact settle timing existing callers (and the provisioning chain race) rely on.
  create(input: CreateSeat, choose: Choose & { replaces?: string } = {}, skillMap?: string): Promise<Seat> {
    // debt: one release of alias (plan 14746 D5, decision 14702): a lead session's MCP client
    // keeps the tool schema from its connect and refuses an enum value it does not know, so
    // role:'scout', critic:true must keep making a critic until each lead has reconnected.
    // Remove this block, the critic field of CreateSeat and http.ts's flag description together.
    // Refusals reject, never throw: create's errors were always async (they came from createSeat).
    // skillMap is a test seam (reviewer-glm-aa37bd.1): a temporary skill-map path. Production omits it.
    if (input.critic !== undefined) {
      const refuse = (message: string): Promise<never> => Promise.reject(new Error(message));
      if (typeof input.critic !== 'boolean') return refuse('critic must be true or false');
      if (input.role !== 'scout' && input.role !== 'critic')
        return refuse("critic is for a scout seat only: a plan critic is role: 'critic', which keeps the scout lifecycle on the reviewer matrix");
      input = input.critic === true ? { ...input, role: 'critic' } : { ...input };
      delete input.critic;
    }
    if (input.request_id === undefined) return this.createSeat(input, choose, skillMap);
    return this.createIdempotent(input, choose, skillMap);
  }

  private async createIdempotent(input: CreateSeat, choose: Choose & { replaces?: string }, skillMap?: string): Promise<Seat> {
    return createMethods.createIdempotent(this, input, choose, skillMap);
  }

  async createSeat(input: CreateSeat, choose: Choose & { replaces?: string }, skillMap?: string, images?: boolean): Promise<Seat> {
    return createMethods.createSeat(this, input, choose, skillMap, images);
  }

  /** Probe this Mac and every named host at once; a probe that fails is an error value, never a throw. */
  probeTargets(hosts: readonly string[]): Promise<Map<Target, LoadProbe>> {
    return provisionMethods.probeTargets(this, hosts);
  }

  /** Seats consuming resources per target: a host seat counts on its host, every other seat on this Mac. */
  activeByTarget(): Map<Target, number> {
    return provisionMethods.activeByTarget(this);
  }

  /**
   * The seat's remote-exec and build gate run from the host's runtime checkout: it must be on
   * this daemon's commit first (task 1784). It runs in the seat chain, never before the row
   * (task 1757: a bundle transfer may outlive the client's create timeout); a refusal or
   * failure fails only this seat.
   */
  syncRuntime(host: string, top: string): Promise<void> {
    return provisionMethods.syncRuntime(this, host, top);
  }

  provisionRemote(seat: Seat, top: string, commit: string, dir: string): Promise<void> {
    return provisionMethods.provisionRemote(this, seat, top, commit, dir);
  }

  /**
   * A remote coder's slow checkout work, chained behind the row create answers
   * with (task 1757): host checkout transfer, setup, then the local mirror.
   * Success flips the seat ready and selects its MCP config; a failure fails the
   * seat with the reason and reclaims both sides best-effort, as a local
   * provisioning failure does. A prompt queued meanwhile runs or cancels after.
   */
  provisionRemoteCoder(seat: Seat, top: string, commit: string, dir: string, mirror: string): Promise<void> {
    return provisionMethods.provisionRemoteCoder(this, seat, top, commit, dir, mirror);
  }

  queueProvision(seat: Seat): void {
    return provisionMethods.queueProvision(this, seat);
  }

  resumeProvisioning(): void {
    return provisionMethods.resumeProvisioning(this);
  }

  provision(seat: Seat, main: string, top: string, commit: string, branch: string | null): Promise<void> {
    return provisionMethods.provision(this, seat, main, top, commit, branch);
  }

  /**
   * A checkout no turn ever ran in (failed provisioning) is removed with its
   * branch, so failures do not pile up in `git worktree list`. The failure
   * text stays in the seat's data.
   */
  discardCheckout(seatId: string): Promise<void> {
    return provisionMethods.discardCheckout(this, seatId);
  }

  /** Host removal is pending only for a path prepareCheckout verified. A row without the field predates it and stays owned. */
  remoteRemovalPending(seat: Seat): boolean {
    return provisionMethods.remoteRemovalPending(this, seat);
  }

  /**
   * Bound a closed remote coder's removal retries (task 1952): after a removal error,
   * probe the seat directory on the host. ABSENT (the bytes are gone by whatever cause)
   * or three failed attempts with the directory still PRESENT records `remoteCleanupStopped`
   * so recovery stops retrying; the reason states the observation only, orch deleted and
   * certified nothing, and clearing the field is a manual store edit. An unknown probe
   * changes nothing: the retry stays as today and is not counted.
   */
  remoteCleanupStop(seat: Seat, removal: { remoteRemoved?: true; remoteRemoveError: string | null }): Promise<Record<string, unknown>> {
    return provisionMethods.remoteCleanupStop(this, seat, removal);
  }

  /**
   * Only the checkout allocated beside this registered host's repo may be removed.
   * `allowDeadLeftover` authorizes dropping a checkout git already emptied (task 1836):
   * a snapshot recorded, or a disposable checkout, never loses unsnapshotted bytes.
   */
  removeRemoteSeat(seat: Seat, allowDeadLeftover = false): Promise<{ worktreeRemoved?: true; remoteRemoved?: true; remoteRemoveError: string | null }> {
    return provisionMethods.removeRemoteSeat(this, seat, allowDeadLeftover);
  }

  /** Mirror a completed remote turn before checks, trees or routing inspect local bytes. */
  private syncRemoteTurn(seat: Seat, turnId: string): Promise<void> {
    return provisionMethods.syncRemoteTurn(this, seat, turnId);
  }

  /** Move a remote coder's bytes home before releasing its host checkout. */
  finishRemoteCoder(seat: Seat): Promise<{ remoteRemoved?: true; remoteRemoveError: string | null }> {
    return provisionMethods.finishRemoteCoder(this, seat);
  }

  /**
   * After a restart (store.interruptOrphans ran first): a seat that died while
   * provisioning loses its half-built checkout, and a sealed seat whose one
   * question was interrupted is closed, since it may not be asked again.
   */
  async recover(): Promise<void> {
    return recoverMethods.recover(this);
  }

  private oneAtATime(key: string, work: () => Promise<void>): Promise<void> {
    return drainMethods.oneAtATime(this, key, work);
  }

  chain(seatId: string, work: () => Promise<void>): void {
    return drainMethods.chain(this, seatId, work);
  }

  /** Arm drain. The flag is committed before this returns, so a crash cannot lose it. */
  beginDrain(): { draining: true; running: number } {
    return drainMethods.beginDrain(this);
  }

  /** Withdraw an armed drain without touching callbacks still in the normal FIFO. */
  cancelDrain(): { draining: false; resumed: number } {
    return drainMethods.cancelDrain(this);
  }

  /** stopDrain found work that appeared after the idle check: wait for the next edge. */
  rearmDrain(): void {
    return drainMethods.rearmDrain(this);
  }

  restorePending(turnId: string): ReturnType<Store['pendingOf']> {
    return drainMethods.restorePending(this, turnId);
  }

  /** Start turns a drain restart left queued. Caller clears the flag after this schedules them. */
  resumeQueued(): void {
    return drainMethods.resumeQueued(this);
  }

  /** A still-chained later turn must not overtake an earlier skipped callback. */
  resumeHeld(seatId: string, beforeSeq = Infinity): Promise<void> {
    return drainMethods.resumeHeld(this, seatId, beforeSeq);
  }

  maybeDrainExit(): void {
    return drainMethods.maybeDrainExit(this);
  }

  /** Declared turn files survive restarts; git observations are a prompt-time cache. */
  filesOf(seat: Seat): Set<string> {
    return scopeMethods.filesOf(this, seat);
  }

  candidates(seat: Seat): Seat[] {
    return scopeMethods.candidates(this, seat);
  }

  /** A failed git read is unknown, never the empty set; only seat_prompt reads this cache. */
  overlapUnchecked(seatId: string): string[] {
    return scopeMethods.overlapUnchecked(this, seatId);
  }

  /** Called by seat_prompt with the prompting seat, never by the polling board; bounded asynchronous git for this repo only. */
  observeCoders(repo: unknown, seatId?: string): Promise<void> {
    return scopeMethods.observeCoders(this, repo, seatId);
  }

  intersects(a: Set<string>, b: Set<string>): boolean {
    return scopeMethods.intersects(this, a, b);
  }

  observationError(seat: Seat, error: unknown): void {
    return scopeMethods.observationError(this, seat, error);
  }

  /** 'yes' clears the warning; a definitive negative keeps it; anything else is unknown and goes to overlapUnchecked, never silently to landed. */
  applyLanding(seat: Seat, state: string): void {
    return scopeMethods.applyLanding(this, seat, state);
  }

  /** Open, unlanded coders in the same checkout only. Pure cached read for seat_prompt. */
  overlap(seatId: string): SeatOverlap[] {
    return scopeMethods.overlap(this, seatId);
  }

  /** Gate only the first coder brief, before queueing any work (decision #11871). */
  assessScope(seatId: string, brief: string, wideBrief?: string): Promise<ScopeDecision | null> {
    return scopeMethods.assessScope(this, seatId, brief, wideBrief);
  }

  /** Why Jev must not judge this brief (it would cut or block it, or it is over the input cap); null when it may. Shared by the gate and the background bypass reading. */
  scopeDeclined(brief: string, text: string): string | null {
    return scopeMethods.scopeDeclined(this, brief, text);
  }

  /** Jev's scope reading of a brief the guards allowed; an unavailable Jev is unjudged, never a throw. */
  judgeScope(text: string): Promise<ScopeDecision> {
    return scopeMethods.judgeScope(this, text);
  }

  /**
   * Task 1943: a bypassed first brief is judged by Jev after its turn is already queued; the reading lands in
   * the turn's persisted scope as `bypass` and never changes the bypass. A guard decline stores its reason;
   * a Jev failure leaves the field absent, and nothing retries.
   */
  recordBypassScope(brief: string, turnId: string): Promise<void> {
    return scopeMethods.recordBypassScope(this, brief, turnId);
  }

  /**
   * The turn's pending background bypass reading (task 1943), taken once: a turn's watch is written exactly
   * once, so a reading still pending here stays absent and one arriving afterwards is dropped.
   */
  takeBypassScope(turnId: string, scope: TurnWatchRecord['scope']): TurnWatchRecord['scope'] {
    return scopeMethods.takeBypassScope(this, turnId, scope);
  }

  /** The review-class seats on a task (task 2802 correction): same title, same reviewed repository, across reviewer, legal and security. */
  reviewSiblings(title: string, main: unknown): Seat[] {
    return scopeMethods.reviewSiblings(this, title, main);
  }

  /** The other debaters of one fork: same title, same reviewed repository, not closed (operator #16088). */
  debaterSiblings(title: string, main: unknown): Seat[] {
    return scopeMethods.debaterSiblings(this, title, main);
  }

  /** Siblings that count toward the reviewer cap (open, or closed with a valid report), and the families of superseded or replaced ones, which step aside. */
  countReviewers(siblings: readonly Seat[], replaces?: string): { counted: { seat: Seat; why: string }[]; replaced: Set<Family> } {
    return scopeMethods.countReviewers(this, siblings, replaces);
  }

  /** What pickFamily reads beside the loads: each working seat's reserved burn, each family's working coder count, the wallet's working seats in the role and the quality tier of the role's cells. */
  pickInputs(choose: Choose, role: ProfileRole, model?: string, burnRole: AccountingRole = role): { loads: Load[]; reservations: Reservation[]; workingCoders: Map<Family, number>; workingSeats: Map<Family, number>; tiers: Map<Family, QualityAnswer> } {
    return promptMethods.pickInputs(this, choose, role, model, burnRole);
  }

  /** Files for a turn whose brief names none: the seat's persisted taskFiles; a reviewer without them takes its author coder's. */
  contextFiles(seat: Seat): string[] {
    return promptMethods.contextFiles(this, seat);
  }

  /** Serialize HTTP prompts per seat across Jev's await: two concurrent first calls cannot swap which one gets gated. */
  async promptScoped(seatId: string, text: string, timeoutMs?: number, options: PromptOptions = {}, wideBrief?: string): Promise<Turn> {
    return promptMethods.promptScoped(this, seatId, text, timeoutMs, options, wideBrief);
  }

  prompt(seatId: string, text: string, timeoutMs?: number, options: PromptOptions = {}): Turn {
    return promptMethods.prompt(this, seatId, text, timeoutMs, options);
  }

  async run(seatId: string, turnId: string, timeoutMs: number): Promise<void> {
    // A critic keeps the scout drain rule (plan 14746): its one cheap question may run during a drain.
    const scout = ['scout', 'critic'].includes(this.store.getSeat(seatId)?.role ?? '');
    const queued = this.store.getTurn(turnId);
    if (!this.draining && this.drainHeld.size && queued?.status === 'queued') await this.resumeHeld(seatId, queued.seq);
    // A non-scout turn already chained when drain was armed must not start.
    if (!scout && this.draining && this.store.getTurn(turnId)?.status === 'queued') {
      this.drainHeld.set(turnId, timeoutMs);
      this.maybeDrainExit();
      return;
    }
    const files = this.briefFiles.get(turnId) ?? [];
    this.briefFiles.delete(turnId);
    const tokenCap = this.tokenCaps.get(turnId);
    this.tokenCaps.delete(turnId);
    const checkout = this.recheckCheckouts.get(turnId);
    this.recheckCheckouts.delete(turnId);
    // close() may already have ended this queued turn while the preceding step was still running.
    if (this.store.getTurn(turnId)?.status !== 'queued') { this.recheckOptOut.delete(turnId); return; }
    let seat = this.store.getSeat(seatId)!;
    if (this.closing.has(seatId)) {
      this.recheckOptOut.delete(turnId);
      this.end(turnId, { status: 'cancelled', text: null, error: 'seat was closed before this turn started', stop_reason: null, usage: null, tools: 0, duration_ms: 0 });
      return;
    }
    if (seat.status !== 'ready') {
      this.recheckOptOut.delete(turnId);
      this.end(turnId, { status: 'cancelled', text: null, error: `seat is ${seat.status}${seat.data.failure ? `: ${seat.data.failure}` : ''}`, stop_reason: null, usage: null, tools: 0, duration_ms: 0 });
      return;
    }
    if (checkout && seat.data.host) {
      // A host checkout moves by transfer; a failed move fails the recheck, never runs it on the tree reviewed before (task 1704e-3).
      try {
        await (this.options.moveRemoteCheckout ?? moveCheckout)(seat.data.host as string, { sha: checkout, localRepo: seat.data.repo as string }, seat.data.remoteDir as string);
        seat = this.store.updateSeat(seatId, { data: { base: checkout } }, 'seat.recheck_checkout', { turn: turnId, commit: checkout });
      } catch (error) {
        const message = (error as Error).message;
        this.options.log('error', 'seat.recheck_checkout_failed', { seat: seatId, turn: turnId, commit: checkout, message });
        this.end(turnId, { status: 'error', text: null, error: `remote reviewer recheck not run: host checkout not moved to coder snapshot ${checkout}: ${message}`, stop_reason: null, usage: null, tools: 0, duration_ms: 0 });
        return;
      }
    }
    if (checkout && seat.worktree) {
      // The reviewer's own checkout holds the tree it reviewed before; the recheck reviews the correction.
      // --force: the checkout is the reviewer's scratch copy, never the code under review; untracked files stay.
      try {
        await gitAsync('git', ['--no-optional-locks', 'checkout', '-q', '--detach', '--force', checkout], { cwd: seat.worktree, encoding: 'utf8', timeout: 30_000, windowsHide: true });
        seat = this.store.updateSeat(seatId, { data: { base: checkout } }, 'seat.recheck_checkout', { turn: turnId, commit: checkout });
      } catch (error) {
        this.options.log('warn', 'seat.recheck_checkout_failed', { seat: seatId, turn: turnId, commit: checkout, message: (error as Error).message });
      }
    }
    if (!scout && this.draining && this.store.getTurn(turnId)?.status === 'queued') {
      this.drainHeld.set(turnId, timeoutMs);
      this.maybeDrainExit();
      return;
    }
    const turn = this.store.startTurn(turnId);
    this.turnLogStart(turnId, seatId);
    const scope = currentScope(turn.watch?.scope);
    seat = this.store.updateSeat(seatId, { status: 'working' }, 'seat.working');
    const role = seat.role as SeatRole;
    const started = Date.now();
    // A table member's report carries a vote; a bare fork debater's does not (operator #19423).
    const table = seat.role === 'debater' && Array.isArray(seat.data.options) && (seat.data.options as string[]).length
      ? { options: seat.data.options as string[] } : undefined;
    let tools = 0;
    let observedTokens = 0;
    let tokenCapped = false;
    const kinds: Record<string, number> = {};
    // `rtk-missed`: shell calls rtk's own registry would have rewritten (toolkinds.ts rtkMissed) —
    // except on a harness whose PreToolUse hook rewrites them before they run (native claude
    // family, rtkHookRewrites): the stream records the model's pre-hook command there, so the
    // registry match is credited as `rtk`, exactly as a claude lead is in leads.ts creditRtk.
    const rtkMissedKey = rtkHookRewrites(seat.family, (seat.data as Record<string, any>).harness) ? 'rtk' : 'rtk-missed';
    const rtkChecks: Promise<void>[] = [];
    let end: TurnEnd;
    let first = false;
    let compactions: Set<string> | null = null;
    const compactionFailures = new Set<string>();
    const reportRepairFlags: string[] = [];
    let reportRepairRejected = false;
    // The grade computed for the support-round check, reused by settle when the answer it graded
    // still stands and (a reviewer) the compared sibling reports are unchanged — one Jev grading per
    // turn in the common case, never a stale comparison: a sibling that settled since means re-grading.
    let pregraded: Grade | null = null;
    let pregradedSiblings: Sibling[] | null = null;
    let sessionRecord: TurnWatchRecord['session'];
    // Lesson ids this turn's first brief delivered in full: its report answers for each (operator #12326).
    let lessons: string[] = [];
    let interrupted: WatchAction | null = null;
    let watch: TurnWatch | null = null;
    const watchRecord = (): TurnWatchRecord | null => {
      const scoped = this.takeBypassScope(turnId, scope);
      return (scoped || sessionRecord || watch?.actions.length || tools
      ? { ...(scoped ? { scope: scoped } : {}), ...(sessionRecord ? { session: { ...sessionRecord, model: sessionRecord.model ?? null } } : {}), ...(watch?.actions.length ? { actions: watch.actions.map((action) => ({ ...action, model: null })) } : {}), ...(tools ? { tools: { ...kinds } } : {}) }
      : null);
    };
    try {
      let session = await this.session(seat);
      // close() may have come while the provider was starting: no prompt then.
      if (this.closing.has(seatId)) throw new SeatClosed();
      sessionRecord = await this.continueOrFresh(seatId, session);
      if (sessionRecord.mode === 'fresh') {
        await this.drop(seatId);
        this.store.updateSeat(seatId, { data: { sessionId: null, contextDelivered: false } }, 'seat.fresh_session');
        session = await this.session(this.store.getSeat(seatId)!);
        if (this.closing.has(seatId)) throw new SeatClosed();
      }
      // Until a provider has taken the role context in a completed turn, each turn carries all of it;
      // after that only the brief and the closing (the session remembers the rest). Read after the
      // session starts: a failed resume has just cleared the flag.
      first = !(this.store.getSeat(seatId)!.data as Record<string, any>).contextDelivered;
      // A session that starts over on a seat with history (fresh, or a resume the provider refused)
      // gets what the seat reported before: its conversation is gone, its work is not.
      const brief = first ? withEarlier(turn.prompt, this.earlierReports(seatId, turnId, role)) : turn.prompt;
      // The STE rule block (plan 14879 D6), read at each turn: the first message carries it and the
      // closing binds the report to it. Off, a fault or a missing rule.md: null, today's messages.
      const steRule = steRuleBlock(this.options.stateDir);
      // The model the seat runs — an explicit model, else the role matrix model — so a context check
      // can judge a routed input:image skill against it (task 2385; a native seat stores no model).
      const model = scopeMethods.seatModel(seat);
      const message = first
        ? await (this.options.context ?? seatContext)({ role, family: seat.family, harness: (seat.data as Record<string, any>).harness, brief, files, timeoutMs, instruments: seatInstruments(seat.data as Record<string, any>), ...(steRule ? { steRule } : {}), ...(seat.data.standArm === 'no-lessons' ? { suppressLessons: true } : {}), ...(table ? { options: table.options } : {}), cwd: seat.cwd!, remote: Boolean(seat.data.host), ...(seat.data.host ? { host: String(seat.data.host) } : {}), ...((seat.data as Record<string, any>).snapshot ? { snapshot: true } : {}), ...(model !== undefined ? { model } : {}) })
        : `${turn.prompt}\n\n${closing(role, timeoutMs, [], steRule, table)}`;
      if (this.closing.has(seatId)) throw new SeatClosed();
      // Which skills the context inlined and which it listed (context.ts): the board lights the listed
      // ones the seat reads.
      const skillTag = first ? /<!-- orch-skills required=([a-z0-9,-]*) listed=([a-z0-9,-]*)(?: router=([a-z]+) lessons=([a-z]+)(?: knowledge=([a-z]+))?(?: skillReason=([^\s>]+) lessonReason=([^\s>]+) knowledgeReason=([^\s>]+))?)?(?: model=([a-zA-Z0-9._-]+))?(?: added=([a-z0-9,-]*))? -->/.exec(message) : null;
      if (skillTag) {
        const names = (text: string) => text.split(',').filter(Boolean);
        const reason = (value: string) => /^(?:none|unknown|not-asked|stand-no-lessons|memory-unavailable|lesson-router-unavailable|timeout|request-failed|invalid-response|invalid-answer|invalid-input|blocked|missing-api-key|http-[0-9]{3})$/.test(value) ? value : 'unknown';
        const router = skillTag[3] ? { skills: skillTag[3], lessons: skillTag[4], knowledge: skillTag[5] ?? 'none',
          ...(skillTag[6] ? { skillReason: reason(skillTag[6]), lessonReason: reason(skillTag[7]), knowledgeReason: reason(skillTag[8]) } : {}) } : null;
        this.store.updateSeat(seatId, { data: { skills: { required: names(skillTag[1]), listed: names(skillTag[2]), router, model: skillTag[9] && skillTag[9] !== 'null' ? skillTag[9] : null } } }, 'seat.skills');
        // Task 2385 I1c-2: a delivered skill that needs image input marks the seat (the create-time
        // flag could not know the brief routes one), so a replacement recheck keeps the image filter.
        if (imageSkillOf([...names(skillTag[1]), ...names(skillTag[2])]) && (seat.data as Record<string, any>).images !== true) {
          this.store.updateSeat(seatId, { data: { images: true } }, 'seat.images', { turn: turnId });
        }
      }
      // Which lessons the context delivered, in full or by index (context.ts): logged per turn.
      const lessonTag = first ? /<!-- orch-lessons full=([^\s>]*) indexed=([^\s>]*) -->/.exec(message) : null;
      if (lessonTag) {
        const ids = (text: string) => text.split(',').filter((id) => LESSON_ID.test(id));
        const delivered = { full: ids(lessonTag[1]), indexed: ids(lessonTag[2]) };
        lessons = delivered.full;
        if (delivered.full.length || delivered.indexed.length) this.store.recordLessonDelivery(seatId, turnId, delivered);
      }
      const live = session;
      if (seat.data.harness === 'pi') compactions = new Set();
      // Set once the main prompt has returned: a steer that fails after that finds no turn to steer,
      // and that is not a reason to call the finished turn interrupted.
      let over = false;
      watch = new TurnWatch({
        act: (action) => {
          this.store.appendEvent('seat.watch', { turn: turnId, ...action, model: null }, seatId);
          this.options.log('warn', 'seat.watch', { seat: seatId, turn: turnId, ...action });
          const stopTurn = () => {
            interrupted = action;
            watch!.stop();
            void live.cancel().catch(() => undefined);
          };
          // A provider with no way to steer a running turn is interrupted at once.
          if (action.action === 'interrupt' || !live.steer) {
            action.action = 'interrupt';
            stopTurn();
            return;
          }
          live.steer(steerMessage(action)).catch((error: Error) => {
            action.failed = error.message;
            if (over) return;
            action.action = 'interrupt';
            stopTurn();
          });
        },
      });
      const onEvent = (event: TurnEvent) => {
        this.turnLogs.get(turnId)?.add(event);
        if (event.kind === 'compaction') compactions?.add(event.entryId);
        if (event.kind === 'compaction_error') compactionFailures.add(event.error);
        if (event.kind === 'usage' && tokenCap !== undefined && !tokenCapped) {
          observedTokens += event.tokens;
          if (observedTokens >= tokenCap) {
            tokenCapped = true;
            void live.cancel().catch((error: Error) => this.options.log('warn', 'seat.token_cap_abort_failed', { seat: seatId, error: error.message }));
          }
        }
        if (event.kind === 'tool' && (event.status === 'started' || event.status === 'pending')) {
          tools += 1;
          countTool(kinds, event.name, event.args);
          const missed = (this.options.rtkMissed ?? rtkMissed)(event.name, event.args);
          // No verdict (rtk killed or timed out) stays visible as pending, never a silent zero (task 2772).
          if (missed) rtkChecks.push(missed.then((yes) => { const key = yes === null ? 'rtk-pending' : yes ? rtkMissedKey : null; if (key) kinds[key] = (kinds[key] ?? 0) + 1; }));
          this.liveTools.set(turnId, { count: tools, kinds });
          watch!.tool(event.name, event.args);
        }
      };
      // One nudge at ~80% of the limit, only where the protocol can steer a running turn
      // (Pi RPC `steer`: queued until the current tool batch ends, delivered before the next
      // model call). A provider without steer is not interrupted; the hard limit still ends the
      // turn as an error, never as done.
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0 && live.steer) {
        deadlineTimer = setTimeout(() => {
          if (over || this.closing.has(seatId)) return;
          this.store.appendEvent('seat.deadline', { turn: turnId }, seatId);
          this.options.log('warn', 'seat.deadline', { seat: seatId, turn: turnId });
          void live.steer!(reportNowMessage(timeoutMs)).catch((error: Error) => {
            if (over) return;
            this.options.log('warn', 'seat.deadline_steer_failed', { seat: seatId, turn: turnId, error: error.message });
          });
        }, deadlineDelayMs(timeoutMs));
        deadlineTimer.unref();
      }
      let result: TurnResult;
      try {
        result = await session.prompt(message, { timeoutMs, onEvent });
      } finally {
        // A callback already queued must not steer a repair or a finished turn.
        over = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        // Snapshot by turn: a later fresh/resumed session must not rewrite older flags.
        const missing = seat.data.harness === 'pi' ? (session as ProviderSession & Partial<PiToolManifest>).missingTools : undefined;
        if (missing?.length) {
          const previous = this.store.getSeat(seatId)!.data.toolsMissingByTurn as Record<string, readonly string[]> | undefined;
          this.store.updateSeat(seatId, { data: { toolsMissingByTurn: { ...previous, [turnId]: [...missing] } } }, 'seat.tools_missing', { turn: turnId, missing });
        }
      }
      // Repairs only re-emit the answer: the watch ends with the work, so a late tool event never
      // steers an idle session or a repair.
      watch.stop();
      if (first && result.error === null) this.store.updateSeat(seatId, { data: { contextDelivered: true } }, 'seat.context_delivered');
      // A verify/deadline/tool steer can continue after a complete report. Keep the latest
      // valid earlier report if the final reply is prose, invalid, or drops accounted entries.
      // Preserve the final stop/error/usage and surface its checks even when its text is refused.
      const prior = result.earlier?.findLast((text) => parseReport(text, role, lessons, { table }).ok);
      if (prior !== undefined) {
        const last = parseReport(result.text, role, lessons, { table });
        const problem = last.ok === false ? last.error : accountRepair(prior, result.text);
        if (problem) {
          reportRepairFlags.push(`continuation reply rejected: ${problem}; its checks: ${reportedChecks(result.text)}`);
          result = { ...result, text: prior };
        }
      }
      // Up to MAX_REPAIRS repairs: the seat re-emits its answer as the schema without redoing the work.
      // They spend what is left of the SAME turn budget, and a repair that fails or throws never costs
      // the answer already in hand: that turn stays done, with the last raw text.
      // Both attempts quote and account against the FIRST reply, never an intermediate repair.
      const refused = result.text;
      for (let attempt = 0; attempt < MAX_REPAIRS; attempt += 1) {
        // A cancelled turn is not repaired: a repair would answer for work that was stopped.
        const parsed = result.error === null && result.stopReason !== 'cancelled' && !interrupted && !this.closing.has(seatId) ? parseReport(result.text, role, lessons, { table }) : null;
        const left = timeoutMs - (Date.now() - started);
        if (tokenCapped || !parsed || parsed.ok !== false || left <= 0) break;
        this.options.log('info', 'seat.report_repair', { seat: seatId, turn: turnId, attempt: attempt + 1, reason: parsed.error });
        try {
          const repair = await session.prompt(`${REPAIR} ${repairPrompt(parsed.error, role, lessons, refused, table)}`, { timeoutMs: left, onEvent });
          if (attempt === 0 && refused.length > REPAIR_QUOTE_CHARS) reportRepairFlags.push(`schema repair quote truncated: ${refused.length} characters, first ${REPAIR_QUOTE_CHARS} quoted; preservation guard uses the full original`);
          const usage = addUsage(result.usage, repair.usage);
          const durationMs = result.durationMs + repair.durationMs;
          if (repair.error !== null) {
            this.options.log('warn', 'seat.report_repair_failed', { seat: seatId, turn: turnId, error: repair.error });
            result = { ...result, usage, durationMs };
            break;
          }
          const problem = accountRepair(refused, repair.text);
          if (problem) {
            reportRepairRejected = true;
            reportRepairFlags.push(`schema repair rejected: ${problem}; the full first refused reply remains available through seat_report`);
            result = { ...repair, text: refused, usage, durationMs };
            break;
          }
          result = { ...repair, usage, durationMs };
        } catch (error) {
          this.options.log('warn', 'seat.report_repair_failed', { seat: seatId, turn: turnId, error: (error as Error).message });
          await this.drop(seatId);
          break;
        }
      }
      // One support round (task 1447): a blocker/major finding Jev scored as unsupported earns ONE
      // follow-up turn — like a repair, inside what is left of the SAME turn budget — asking for
      // evidence that establishes the claim or a withdrawal/downgrade, answered as a full corrected
      // report. The correction must account for EVERY original finding, by index (task 1447
      // correction): unasked ones re-emitted unchanged, asked ones kept (settle re-grades), downgraded,
      // or withdrawn in place and named in forLead — a correction that drops or silently changes a
      // finding is rejected and the original report plus its flags stand. Skipped on a
      // cancelled/error/interrupted turn and when less than SUPPORT_MIN_LEFT of the budget is left; a
      // session that cannot answer (a throw) drops the seat like a failed repair and keeps the report.
      {
        const candidate = !tokenCapped && result.error === null && result.stopReason !== 'cancelled' && !interrupted && !this.closing.has(seatId) ? parseReport(result.text, role, lessons, { table }) : null;
        const left = timeoutMs - (Date.now() - started);
        if (candidate?.ok && left >= timeoutMs * SUPPORT_MIN_LEFT) {
          const siblings = reviewRights(role) ? this.siblings(seat) : [];
          const detection = await Promise.resolve().then(() => (this.options.grade ?? gradeReport)(candidate.report, siblings)).catch((error: Error): Grade => ({ status: 'ungraded', reason: error.message }));
          const unsupported = unsupportedFindings(candidate.report, detection);
          if (!unsupported.length) {
            pregraded = detection;
            pregradedSiblings = siblings;
          } else {
            // The detection grade itself spent budget: what the round may spend is what is left NOW.
            const remaining = timeoutMs - (Date.now() - started);
            if (remaining <= 0) {
              this.options.log('info', 'seat.support_round_skipped', { seat: seatId, turn: turnId, reason: 'the detection grade spent the rest of the budget' });
              pregraded = detection;
              pregradedSiblings = siblings;
            } else {
            this.options.log('info', 'seat.support_round', { seat: seatId, turn: turnId, findings: unsupported.map((item) => item.finding + 1) });
            let outcome: 'corrected' | 'invalid' | 'rejected' | 'failed' = 'corrected';
            let failure: string | null = null;
            let reason: string | null = null;
            try {
              const round = await session.prompt(`${SUPPORT} ${supportPrompt(unsupported, role, lessons, table)}`, { timeoutMs: remaining, onEvent });
              const usage = addUsage(result.usage, round.usage);
              const durationMs = result.durationMs + round.durationMs;
              if (round.error === null && round.stopReason !== 'cancelled' && !this.closing.has(seatId)) {
                const corrected = parseReport(round.text, role, lessons, { table });
                if (corrected.ok) {
                  // Index accounting (task 1447 correction): a correction that drops an unasked
                  // finding, changes one, or withdraws without naming the claim in forLead is
                  // rejected — the original report and its flags stand, nothing is overwritten.
                  const problem = accountCorrection(candidate.report, corrected.report, unsupported);
                  if (problem) { outcome = 'rejected'; reason = problem; result = { ...result, usage, durationMs }; }
                  else result = { ...round, usage, durationMs };
                } else { outcome = 'invalid'; result = { ...result, usage, durationMs }; }
              } else {
                outcome = 'failed';
                failure = round.error ?? 'cancelled';
                result = { ...result, usage, durationMs };
              }
            } catch (error) {
              outcome = 'failed';
              failure = (error as Error).message;
              this.options.log('warn', 'seat.support_round_failed', { seat: seatId, turn: turnId, error: failure });
              await this.drop(seatId);
            }
            const rounds = { ...((this.store.getSeat(seatId)!.data as Record<string, any>).supportRounds as Record<string, unknown> ?? {}), [turnId]: { asked: unsupported, model: detection.model ?? null, outcome, ...(reason ? { reason } : {}), ...(failure ? { error: failure } : {}) } };
            this.store.updateSeat(seatId, { data: { supportRounds: rounds } }, 'seat.support_round', { turn: turnId, outcome, ...(reason ? { reason } : {}) });
            // The answer settle grades is unchanged unless the round corrected it.
            if (outcome !== 'corrected') {
              pregraded = detection;
              pregradedSiblings = siblings;
            }
            }
          }
        }
      }
      await Promise.all(rtkChecks);
      const stopped = interrupted as WatchAction | null;
      end = {
        // A turn close() interrupted is cancelled whatever the provider called its stop: only Pi reports an abort as such.
        // A turn the watch interrupted is an error the lead must see, whatever the provider called it.
        // Pi and codex report a cancel with no error: a cancelled stop is never a done turn.
        status: this.closing.has(seatId) ? 'cancelled' : tokenCapped || stopped ? 'error' : result.stopReason === 'cancelled' ? 'cancelled' : result.error === null ? 'done' : 'error',
        text: result.text,
        error: tokenCapped ? `stand token cap reached: observed ${observedTokens} >= ${tokenCap}` : stopped && !this.closing.has(seatId) ? `orch interrupted the turn: ${stopped.kind}: ${stopped.detail}` : result.error,
        stop_reason: result.rawStopReason,
        usage: result.usage as Record<string, unknown> | null,
        tools,
        duration_ms: result.durationMs,
        watch: watchRecord(),
      };
    } catch (error) {
      watch?.stop();
      // A session that failed to start or died is not reused.
      await this.drop(seatId);
      end = error instanceof SeatClosed
        ? { status: 'cancelled', text: null, error: 'seat was closed while its provider was starting', stop_reason: null, usage: null, tools, duration_ms: Date.now() - started, watch: watchRecord() }
        : { status: 'error', text: null, error: (error as Error).message, stop_reason: null, usage: null, tools, duration_ms: Date.now() - started, watch: watchRecord() };
    }
    if (seat.data.harness === 'pi') {
      const previous = this.store.getSeat(seatId)!.data.compactionsByTurn as Record<string, number | null> | undefined;
      const failures = this.store.getSeat(seatId)!.data.compactionFailuresByTurn as Record<string, string[]> | undefined;
      this.store.updateSeat(seatId, { data: {
        compactionsByTurn: { ...previous, [turnId]: compactions?.size ?? null },
        compactionFailuresByTurn: { ...failures, [turnId]: [...compactionFailures] },
      } }, 'seat.compactions', { turn: turnId, count: compactions?.size ?? null, failures: [...compactionFailures] });
    }
    if (landable(role) && typeof seat.data.host === 'string') await this.syncRemoteTurn(seat, turnId);
    // Grade before the turn is marked ended, so a lead woken by it reads the grade with the report.
    // Nothing here may keep the turn from ending: a throw would leave it 'running' until a restart.
    let recheckDone: { release: () => void } | undefined;
    let treeDone: { release: () => void } | undefined;
    const settle = async () => {
      let verified: Promise<void> = Promise.resolve();
      if (end.status === 'done' && end.text !== null) {
        try {
          const parsed = parseReport(end.text, role, lessons, { table });
          if (parsed.ok && lessons.length) {
            try {
              this.store.recordLessonsApplied(turnId, appliedLessons(parsed.report));
            } catch (error) {
              this.options.log('warn', 'seat.lessons_applied_failed', { seat: seatId, turn: turnId, message: (error as Error).message });
            }
          }
          if (parsed.ok) {
            // A landable role's claimed passes are rerun alongside grading, so a waiter reads them
            // with the report (task 1561; task 2802: every landable role answers with the coder
            // report, and an unrerun check would flag its criteria 'not verified by orch rerun').
            if (landable(role)) verified = this.verifyTurn(seatId, turnId, parsed.report);
            const siblings = reviewRights(role) ? this.siblings(seat) : [];
            const reuse = pregraded && JSON.stringify(pregradedSiblings) === JSON.stringify(siblings) ? pregraded : null;
            const grade = reuse ?? await Promise.resolve().then(() => (this.options.grade ?? gradeReport)(parsed.report, siblings)).catch((error: Error): Grade => ({ status: 'ungraded', reason: error.message }));
            this.store.saveGrade(turnId, seatId, { ...grade, model: grade.model ?? null });
          }
        } catch (error) {
          this.options.log('warn', 'seat.grade_failed', { seat: seatId, turn: turnId, message: (error as Error).message });
        }
      }
      // The existing grade JSON holds repair diagnostics even when the original remains unparsed.
      // No seat.data growth or store schema change; persist before finishTurn wakes readers.
      if (reportRepairFlags.length) {
        try {
          this.store.saveGrade(turnId, seatId, {
            ...(this.store.getGrade(turnId) ?? { status: 'ungraded', reason: 'no valid report' }),
            reportRepairFlags,
            reportRepairRejected,
          });
        } catch (error) {
          this.options.log('warn', 'seat.grade_failed', { seat: seatId, turn: turnId, message: (error as Error).message });
        }
      }
      // verifyTurn records its own failure; this catch only keeps a throw from holding the turn open.
      await verified.catch((error: Error) => this.options.log('warn', 'seat.check_verify_failed', { seat: seatId, turn: turnId, message: error.message }));
      this.liveTools.delete(turnId);
      this.turnLogEnd(turnId);
      // Registered before the turn is marked ended: a wait() that sees it ended still waits for its
      // post-finish work. A coder with no authored reviewer has nothing to route, so its waiters are
      // not held. An unreadable seat list holds: routing then records its own failure and releases.
      // The seats_author bound (task 2640) keeps this off the closed history: it runs at every coder turn end.
      const reviewed = () => { try { return this.store.listSeats({ role: 'reviewer', author: seatId }).length > 0; } catch { return true; } };
      let lessonsDone: { release: () => void } | undefined;
      if (role === 'coder' && ((end.status === 'done' && this.store.getTurn(turnId)!.seq > 1 && !this.recheckOptOut.has(turnId) && reviewed()) || this.deferredDue(seatId, turnId))) {
        recheckDone = this.afterTurn(turnId, 'rechecks', this.options.recheckHoldMs);
      }
      const autoLessons = end.status === 'done' && LESSON_ROLES.has(role as ReportRole);
      if (autoLessons) lessonsDone = this.afterTurn(turnId, 'auto-apply', this.options.lessonHoldMs);
      // recordTree runs after finishTurn too: regressionFlags/circlingFlags read the trees, so a
      // waiter holds until the tree is recorded (reviewer-codex-8ab808.1).
      if (role === 'coder') treeDone = this.afterTurn(turnId, 'tree', this.options.treeHoldMs);
      this.store.finishTurn(turnId, end);
      try {
        if (autoLessons) {
          const results = await this.options.autoLessons(this.store, turnId);
          // This is a separate FIFO turn, not a report-schema retry. One round only:
          // a repair turn's own refusals remain visible to the lead, never requeued.
          if (!turn.prompt.startsWith('[orch:lesson-repair]') && !this.closing.has(seatId) && this.store.getSeat(seatId)?.status === 'working') {
            const parsed = end.text ? parseReport(end.text, role, lessons, { table }) : null;
            if (parsed?.ok) {
              const proposals = (parsed.report.memory ?? []) as MemoryProposal[];
              const refused = results.flatMap((result) => {
                const proposal = proposals[result.index];
                const fields = result.status === 'refused' ? brevityFields(result.text) : [];
                return proposal?.op === 'append' && proposal.kind === 'lesson' && fields.length ? [{ result, proposal, fields }] : [];
              });
              if (refused.length && this.store.listTurns(seatId).filter((item) => item.status === 'queued').length < MAX_QUEUED_TURNS) {
                const prompt = `[orch:lesson-repair] Rewrite ONLY these refused lesson append proposals in your report's memory array. No other work. Keep each lesson's meaning, anchor and route; obey the targets below. Use the normal full report contract.\n${refused.map(({ proposal, fields }, i) => `\nLesson ${i + 1}:\nTitle: ${proposal.title}\nBody:\n${proposal.body}\nObjected fields: ${fields.map(({ field, length, limit, target, ceiling }) => `${field} ${length} chars, ${ceiling ? `ceiling ${limit}${target < limit ? `, target ~${target}` : ''}` : `target ~${target}`}`).join('; ')}\nOriginal proposal: ${JSON.stringify(proposal)}`).join('\n')}`;
                const repair = this.prompt(seatId, prompt, undefined, { longBrief: 'The refused lesson bodies and objected field measurements must be included verbatim.', recheck: false });
                for (const { result } of refused) recordLessonRepair(this.store, turnId, result.index, result, repair.id);
              }
            }
          }
        }
      } catch (error) {
        this.options.log('warn', 'seat.lesson_auto_apply_failed', { seat: seatId, turn: turnId, message: (error as Error).message });
      } finally {
        lessonsDone?.release();
      }
    };
    // Sibling reviewers settle one at a time: two that finish together would otherwise each grade
    // while the other is still running, and neither would be compared (qwen review, 2026-09-22).
    if (reviewRights(role)) await this.oneAtATime(`${reviewRepo(seat)}\n${seat.title}`, settle);
    else await settle();
    this.options.onTurnEnd?.(seat, end);
    // The seat settles BEFORE anyone waiting is woken: a waiter reads the seat's state next.
    // A sealed seat closes once it has used its question limit. A queued follow-up has not
    // answered yet, so a debater with one settled turn stays ready (task 2156 D1).
    const limit = roleTurnLimit(seat.role as SeatRole);
    const used = this.store.listTurns(seatId).filter((turn) => turn.status !== 'queued').length;
    if (ROLE_POLICY[seat.role as SeatRole].sealed && used >= limit) await this.closeNow(seatId);
    else if (this.store.getSeat(seatId)!.status === 'working') this.store.updateSeat(seatId, { status: 'ready' }, 'seat.idle');
    // First answer settled and the debater is still ready: close 60 minutes later unless a second turn exists by then (task 2156 D3). A restart drops the timer; recovery then closes the seat.
    if (seat.role === 'debater' && used === 1 && this.store.getSeat(seatId)?.status === 'ready') closeMethods.armRebuttalClose(this, seatId);
    // The last member's second turn settles the table: tally the turn-2 votes and post once (operator #19423).
    if (seat.role === 'debater' && used === 2) {
      try { await this.maybePostTable(seat); }
      catch (error) { this.options.log('warn', 'seat.table_post_failed', { seat: seatId, turn: turnId, message: (error as Error).message }); }
    }
    // Waiters of a turn with pending post-finish work move on to the holds now, so their bound counts from the turn end.
    if (this.postTurn.has(turnId)) this.wake(turnId);
    const optedOut = this.recheckOptOut.delete(turnId);
    try {
      // recordTree settles its own hold: a hung recheck routing must not keep the tree entry pending.
      if (role === 'coder') { try { await this.recordTree(seat, turnId); } finally { treeDone?.release(); } }
      const routine = role === 'coder' && end.status === 'done' && this.store.getTurn(turnId)!.seq > 1 && !optedOut;
      // Any turn whose sync mirrored the host again creates the replacements an earlier failed sync deferred.
      if (routine || (role === 'coder' && this.deferredDue(seatId, turnId))) await this.queueRechecks(seat, turnId, !routine);
    } catch (error) {
      this.options.log('error', 'seat.rechecks_failed', { seat: seatId, turn: turnId, message: (error as Error).message });
    } finally {
      recheckDone?.release();
      this.wake(turnId);
    }
    this.maybeDrainExit();
  }

  /**
   * Reruns a done or partial coder report's claimed-pass checks in the seat's worktree (task 1561) and
   * keeps the result with the turn for the digest. verifyChecks caps its own time; this never throws.
   */
  private async verifyTurn(seatId: string, turnId: string, report: Record<string, unknown>): Promise<void> {
    return verifyMethods.verifyTurn(this, seatId, turnId, report);
  }

  /**
   * The coder checkout as a tree at each turn end, for the correction delta (decision #11871): a copy
   * of the real index under a temporary GIT_INDEX_FILE takes `add -A` and `write-tree`, so neither the
   * real index nor the shared stash is touched. A failure leaves no tree: the delta is then unavailable.
   */
  private async recordTree(coder: Seat, turnId: string): Promise<void> {
    return verifyMethods.recordTree(this, coder, turnId);
  }

  /** The repo-relative paths between two recorded coder trees (decision #12435); recheck routing and
   * the persisted correction delta (task 1702) share this reader. Throws when git or a numstat row fails. */
  async treeDeltaPaths(before: string, now: string, git: (...args: string[]) => Promise<string>): Promise<string[]> {
    return verifyMethods.treeDeltaPaths(this, before, now, git);
  }

  /**
   * Same reviewer or a new one for a correction (decision #11871). The delta runs from the coder tree
   * the reviewer's report saw (the last one recorded before that turn started; the coder base if none)
   * to the tree at this correction's end. Empty: the same reviewer. A test file counts as the blocker and major findings'
   * own (the fix's regression test, decision #12879). Any other path outside those findings, or an
   * unavailable delta: a new reviewer.
   */
  async recheckRoute(coder: Seat, coderTurn: string, reviewed: Turn, blockers: Finding[], git: (...args: string[]) => Promise<string>): Promise<{ kind: 'same' | 'new'; reason: string; model?: string | null }> {
    return verifyMethods.recheckRoute(this, coder, coderTurn, reviewed, blockers, git);
  }

  /**
   * The correction's changed repo-relative paths, persisted with its recheck entry for reviewer-yield
   * counts (task 1702): the delta from the previous tree recorded at a coder turn end to this
   * correction's, reviewer-independent, so it is computed for every correction, not only routed ones.
   * Sorted, deduplicated and capped. Null when the delta is unavailable — no worktree, a failed remote
   * sync, no recorded tree or a git error — and the failure is logged: never a fabricated empty list.
   */
  async correctionDelta(coder: Seat, coderTurn: string, git: (...args: string[]) => Promise<string>): Promise<{ paths: string[]; truncated: boolean } | null> {
    return verifyMethods.correctionDelta(this, coder, coderTurn, git);
  }

  /** Carry the lead's explicit placement, not the target an omitted need happened to pick. */
  replacementPlacement(reviewer: Seat): Pick<CreateSeat, 'needs' | 'host'> {
    return verifyMethods.replacementPlacement(this, reviewer);
  }

  /** A remote coder turn whose sync mirrored the host, with replacements an earlier failed sync deferred. */
  private deferredDue(coderId: string, turnId: string): boolean {
    return verifyMethods.deferredDue(this, coderId, turnId);
  }

  /**
   * Route each authored reviewer's reproduced blocker and major findings from its latest settled answer (decisions #11871, #12435).
   * deferredOnly: a turn that is not a routine correction only creates the replacements a failed sync deferred.
   */
  private async queueRechecks(coder: Seat, coderTurn: string, deferredOnly = false): Promise<void> {
    return verifyMethods.queueRechecks(this, coder, coderTurn, deferredOnly);
  }

  /**
   * A seat continues its provider conversation (decision #12435), except when the explicit
   * context-cap rule starts a fresh one. An unavailable context reading does not reset the seat.
   */
  private async continueOrFresh(seatId: string, session: ProviderSession): Promise<NonNullable<TurnWatchRecord['session']>> {
    return verifyMethods.continueOrFresh(this, seatId, session);
  }

  /** The valid reports of the seat's last EARLIER_REPORTS done turns before this one, oldest first. */
  private earlierReports(seatId: string, turnId: string, role: SeatRole): Record<string, unknown>[] {
    return verifyMethods.earlierReports(this, seatId, turnId, role);
  }

  /**
   * The other reviewer seats on this task: same title, same repo, each with its latest turn's valid
   * report. A sibling still working, or whose latest turn gave no report, is left out, as in the
   * Paseo plugin: an older answer is not what that reviewer says now. A lead that
   * reuses a title across tasks gets at most MAX_SIBLINGS comparisons, the most recent reports first.
   */
  private siblings(seat: Seat): Sibling[] {
    return verifyMethods.siblings(this, seat);
  }

  /**
   * One table, one daemon post (operator #19423, plan item 7): tally the turn-2 votes and post
   * once — to the lead's live handle with wake, or as a log line when leadHandle is null. Fires
   * when no member can still produce a turn 2: each member has a settled turn 2 (done or failed;
   * only a done turn with a parsed vote counts as cast) or its seat is closed/failed with no
   * queued or running turn 2. chatPostTable's check-and-set makes every other trigger a no-op.
   */
  maybePostTable(seat: Seat): void {
    const options = Array.isArray(seat.data.options) ? seat.data.options as string[] : undefined;
    if (!options || options.length === 0) return;
    const members = scopeMethods.tableMembers(this, seat);
    if (!members.length) return;
    const rows = members.map((member) => ({ member, turns: this.store.listTurns(member.id) }));
    const canStillVote = rows.some(({ member, turns }) => {
      const turn2 = turns[1];
      if (turn2 !== undefined && TERMINAL_TURN.has(turn2.status)) return false;
      const status = this.store.getSeat(member.id)?.status;
      const closedOrFailed = status === 'closed' || status === 'failed';
      const inFlight = turns.some((turn) => turn.status === 'queued' || turn.status === 'running');
      return !(closedOrFailed && !inFlight);
    });
    if (canStillVote) return;
    const voteOf = (turn: { status: string; text: string | null } | undefined): { option: string; confidence: number; changedBy: string | null } | null => {
      if (!turn || turn.status !== 'done' || turn.text === null) return null;
      const parsed = parseReport(turn.text, 'debater', [], { table: { options } });
      if (!parsed.ok) return null;
      const vote = parsed.report.vote as { option: string; confidence: number; changedBy: string | null } | undefined;
      return vote && typeof vote.option === 'string' && typeof vote.confidence === 'number' ? vote : null;
    };
    const votes = rows.map(({ member, turns }) => ({ member, turn1: voteOf(turns[0]), turn2: voteOf(turns[1]) }));
    const tally = tallyTable(options, votes.map(({ turn2 }, i) => ({ label: memberLabel(i), turn2 })));
    const line = (vote: { option: string; confidence: number; changedBy: string | null } | null): string => vote === null
      ? 'no vote' : `${vote.option} (${vote.confidence.toFixed(2)}, changed ${vote.changedBy === null ? 'no' : 'yes'})`;
    const title80 = Array.from(seat.title).slice(0, 80).join('');
    const header = `Table "${title80}": decided ${tally.decided}`;
    const tallyText = tally.counts.map((row) => `${row.option} ${row.count} (${row.confidence.toFixed(2)})`).join('; ');
    const memberLines = votes.map(({ turn1, turn2 }, i) => `${memberLabel(i)}: ${line(turn1)} -> ${line(turn2)}`);
    // Header and Tally always stay. Not voting lists labels while the 600 code-point cap holds, then `+N more`.
    const prefix = `${header}\nTally: ${tallyText}`;
    const notVotingText = fittingNotVoting(prefix, tally.notVoting);
    let body = `${prefix}${notVotingText}`;
    let included = 0;
    for (const memberLine of memberLines) {
      const next = `${body}\n${memberLine}`;
      if (Array.from(next).length <= 600) { body = next; included += 1; }
      else break;
    }
    if (included < memberLines.length) {
      const more = `\n+${memberLines.length - included} more`;
      if (Array.from(body + more).length <= 600) body += more;
    }
    const leadHandles = [...new Set(members.map((member) => member.data.leadHandle).filter((handle): handle is string => typeof handle === 'string' && handle.length > 0))];
    chatPostTable(this.store, { firstId: members[0].id, leadHandles, body });
  }

  /** Whether this seat must load codex-edit: a stock Pi codex seat that edits (operator #13098), never on a win32 target (task 1956, CODEX_EDIT_WIN32_WITHHELD: the pinned toolkit rejects every nested Windows path). */
  wantsCodexEdit(seat: Seat): boolean {
    return provisionMethods.wantsCodexEdit(this, seat);
  }

  wantsHashlineEdit(seat: Seat): boolean {
    return provisionMethods.wantsHashlineEdit(this, seat);
  }

  /**
   * The recorded extension path of a remote seat, installing lazily when the row predates the
   * pinned edit's rollout and records none (task 1914, lesson #13174): one host install, stored
   * under the same key provisioning writes, then the caller's shape gate and per-start --check run
   * unchanged. Serialization lives at the shared boundary (provisionPinnedEdit in
   * remote-provision.ts), so a lazy start and another seat's initial provisioning never run two
   * installers into one host prefix. A recorded path that is merely WRONG never reaches here: it
   * still throws in remoteCodexEditExtension/remoteHashlineEdit. A failed install throws with the
   * installer's tail and the host repair command.
   */
  pinnedEditRecorded(seat: Seat, host: string, name: 'codex-edit' | 'hashline-edit', recorded: unknown): Promise<unknown> {
    return provisionMethods.pinnedEditRecorded(this, seat, host, name, recorded);
  }

  hashlineEditFor(seat: Seat, data: Record<string, any>): Promise<HashlineEdit | undefined> {
    return this.options.hashlineEditFor ? this.options.hashlineEditFor(seat, data) : provisionMethods.hashlineEditFor(this, seat, data);
  }

  /**
   * The codex-edit extension this seat loads, proved at EVERY session start: on
   * this Mac by the installer's --check over the stock prefix, on a host by the
   * same --check run there plus the path provisioning recorded. Anything else
   * throws, so a codex seat that edits never silently runs on Pi's stock edit
   * tools (operator #13098).
   */
  codexEditFor(seat: Seat, data: Record<string, any>): Promise<CodexEdit | undefined> {
    return this.options.codexEditFor ? this.options.codexEditFor(seat, data) : provisionMethods.codexEditFor(this, seat, data);
  }

  private async session(seat: Seat): Promise<ProviderSession> {
    return digestMethods.session(this, seat);
  }

  end(turnId: string, end: TurnEnd): void {
    return digestMethods.end(this, turnId, end);
  }

  /** Tool calls a running turn has made so far, for the dashboard; null once it ended or before its first. */
  liveToolCount(turnId: string): number | null {
    return digestMethods.liveToolCount(this, turnId);
  }

  /** The same turn's calls by kind (toolkinds.ts), or null. */
  liveToolKinds(turnId: string): Record<string, number> | null {
    return digestMethods.liveToolKinds(this, turnId);
  }

  /** Start a turn's live log (run()); the board reads it through turnLiveLog until the seat closes. */
  turnLogStart(turnId: string, seatId: string): void {
    this.turnLogs.set(turnId, new TurnLiveLog(seatId));
    // The cap holds at insert too — 50 ended logs plus a new running turn is already 51. Evict the
    // oldest ENDED log (Map order is start order); a running turn's log is never the victim.
    while (this.turnLogs.size > TURN_LOG_MAX_TURNS) {
      const victim = [...this.turnLogs].find(([, other]) => other.ended);
      if (!victim) break;
      this.turnLogs.delete(victim[0]);
    }
  }

  /** A turn ended: its log stays readable as the seat's last ended one; at most TURN_LOG_MAX_TURNS logs. */
  turnLogEnd(turnId: string): void {
    const log = this.turnLogs.get(turnId);
    if (!log) return;
    log.ended = true;
    for (const [id, other] of this.turnLogs) if (other.ended && other.seatId === log.seatId && id !== turnId) this.turnLogs.delete(id);
    // Evict oldest-ended logs first (Map order is start order); a running turn's log is never the
    // victim. The just-ended log may be that oldest one — the cap holds for every completion order.
    while (this.turnLogs.size > TURN_LOG_MAX_TURNS) {
      const victim = [...this.turnLogs].find(([, other]) => other.ended);
      if (!victim) break;
      this.turnLogs.delete(victim[0]);
    }
  }

  /** A closed seat's logs go with it (seats-close.ts closeNow). */
  turnLogsForget(seatId: string): void {
    for (const [id, log] of this.turnLogs) if (log.seatId === seatId) this.turnLogs.delete(id);
  }

  /** The live log http.ts serves the board; null before the turn started and after a restart. */
  turnLiveLog(turnId: string): TurnLiveLog | null {
    return this.turnLogs.get(turnId) ?? null;
  }

  wake(turnId: string): void {
    return digestMethods.wake(this, turnId);
  }

  async drop(seatId: string): Promise<void> {
    return digestMethods.drop(this, seatId);
  }

  /**
   * The turn once it has ended, or its current state when `timeoutMs` runs out first. An ended coder
   * correction returns once its recheck routing is recorded, or when that hold's bound runs out.
   */
  async wait(turnId: string, timeoutMs: number): Promise<Turn> {
    return digestMethods.wait(this, turnId, timeoutMs);
  }

  async digest(turn: Turn): Promise<Digest> {
    return digestMethods.digest(this, turn);
  }

  /** Name the latest retained, completed checkout where each currently failed check last passed. */
  regressionFlags(seat: Seat, turn: Turn, report: Record<string, unknown> | null): string[] {
    return digestMethods.regressionFlags(this, seat, turn, report);
  }

  /** Compare only the three consecutive turn ends, never substitute an older recorded tree for a missing one. */
  async circlingFlags(seat: Seat, turn: Turn, report: Record<string, unknown> | null): Promise<string[]> {
    return digestMethods.circlingFlags(this, seat, turn, report);
  }

  /**
   * What became of the turn's one support round (task 1447), judged against the FINAL report and its
   * stored grade. Findings are identified by INDEX — the corrected report keeps count and order, so
   * claim text can be reworded and duplicates cannot bind to the wrong entry. A finding marked
   * "withdrawn" was withdrawn in place and its claim is named; one no longer blocker/major was
   * downgraded; one still flagged says so — the flag itself stays in `flags`. A rejected correction
   * left the original report standing, with its flags.
   */
  supportNotes(turn: Turn, report: Record<string, unknown> | null, grade: Grade | null): string[] {
    return digestMethods.supportNotes(this, turn, report, grade);
  }

  /** The parsed report, or why there is none. Never the seat's prose: that stays behind seat_report. */
  reportOf(turn: Turn): Pick<Digest, 'report' | 'reportError' | 'grade' | 'flags'> {
    return digestMethods.reportOf(this, turn);
  }

  async close(seatId: string): Promise<Seat> {
    return closeMethods.close(this, seatId);
  }

  scheduleClosedCleanup(closed: Seat | undefined): void {
    return closeMethods.scheduleClosedCleanup(this, closed);
  }

  /** Record the host outcome even when close has already answered. */
  async finishRemoteClose(seatId: string): Promise<void> {
    return closeMethods.finishRemoteClose(this, seatId);
  }

  /** A closed seat's regenerable caches; its branch, tracked and untracked source stay for landing. */
  async clearSeatCaches(seatId: string): Promise<void> {
    return closeMethods.clearSeatCaches(this, seatId);
  }

  async closeNow(seatId: string, keepOnError = false): Promise<Seat> {
    return closeMethods.closeNow(this, seatId, keepOnError);
  }



  /**
   * Close idle disposable seats and coders (proof required until two days idle),
   * then prune previously closed coders.
   */
  async pruneLanded(): Promise<PruneDecision[]> {
    return closeMethods.pruneLanded(this);
  }

  /** Close every live provider process (daemon shutdown); stored state stays for the next start. */
  async shutdown(): Promise<void> {
    return closeMethods.shutdown(this);
  }
}
