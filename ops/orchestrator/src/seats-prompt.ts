import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SeatManager } from './seats.ts';
import type { Family } from './providers/types.ts';
import { isStandArm } from './stand.ts';
import type { Seat, Turn, TurnPending } from './store.ts';
import { accountingRole, appliesToModel, DEFAULT_TURN_BURN, paceReading, roleMatrix, type AccountingRole, type Load, type ProfileRole, type Reservation } from './profiles.ts';
import { tierOf, type QualityAnswer } from './role-quality.ts';
import {
  ROLE_POLICY, roleTurnLimit, turnLimitMs, landable, BRIEF_WORDS, WIDE_BRIEF_P, MAX_QUEUED_TURNS, FILES_ROLES, currentScope, normalizeFile, stringsOf, wordCount,
 } from './seats-defs.ts';
import type { Choose, PromptOptions, SeatRole } from './seats-defs.ts';
import { parseReport } from './report.ts';
import { seatModel, tableMembers, tableContractOf } from './seats-scope.ts';
import { memberLabel } from './table.ts';

  /** What pickFamily reads beside the loads: each working seat's reserved burn, each family's working coder count, A (task 2382): the wallet's seats in the role of this pick, and the quality tier of each cell of the role's matrix (task 2382 P3b). */
export function pickInputs(self: SeatManager, choose: Choose, role: ProfileRole, model?: string, burnRole: AccountingRole = role): { loads: Load[]; reservations: Reservation[]; workingCoders: Map<Family, number>; workingSeats: Map<Family, number>; tiers: Map<Family, QualityAnswer> } {
    // Calibrated burn on every window but the seat's pace one, by full window label. The
    // pace window keeps `estimate` and the reservation's `burn` on `pace`, so a pick that
    // budgets a different window still sees the seat's charge there (lesson 17774).
    const windowBurns = (load: Load, seatRole: AccountingRole, seatModel: string | undefined) => {
      const pace = paceReading(load.family, load.readings?.filter((reading) => seatModel && appliesToModel(reading, seatModel)));
      const burns: Record<string, number> = {};
      for (const reading of load.readings ?? []) {
        if (reading.window === pace?.window || !seatModel || !appliesToModel(reading, seatModel)) continue;
        const estimate = choose.estimate?.(load, seatRole, seatModel, reading.window);
        if (estimate?.window === reading.window && estimate.used === reading.used && Number.isFinite(estimate.burn) && estimate.burn > 0) burns[reading.window] = estimate.burn;
      }
      return burns;
    };
    const loads = (choose.loads ?? []).map((load) => {
      const seatModel = model ?? roleMatrix()[role][load.family]?.model;
      return { ...load, estimate: choose.estimate?.(load, burnRole, seatModel), estimates: windowBurns(load, burnRole, seatModel) };
    });
    const reservations: Reservation[] = [];
    const workingCoders = new Map<Family, number>();
    for (const other of self.store.listSeats({ notStatus: 'closed' })) {
      if (other.status === 'failed') continue;
      const load = loads.find((row) => row.family === other.family);
      if (!load || !Object.hasOwn(ROLE_POLICY, other.role)) continue;
      const readAt = load.readAt ? Date.parse(load.readAt) : NaN;
      const sinceReading = Number.isFinite(readAt) && Date.parse(other.created_at) >= readAt;
      if (!sinceReading && !self.store.listTurns(other.id).some((turn) => turn.status === 'queued' || turn.status === 'running')) continue;
      const otherRole = accountingRole({ role: other.role as ProfileRole, data: other.data });
      const otherModel = typeof other.data.model === 'string' ? other.data.model : roleMatrix()[otherRole][load.family]?.model;
      const budget = paceReading(load.family, load.readings?.filter((reading) => otherModel && appliesToModel(reading, otherModel)));
      const estimate = choose.estimate?.(load, otherRole, otherModel);
      const calibrated = budget && estimate?.window === budget.window && estimate.used === budget.used && Number.isFinite(estimate.burn) && estimate.burn > 0;
      reservations.push({ family: load.family, burn: calibrated ? estimate!.burn : DEFAULT_TURN_BURN[otherRole], pace: budget?.window ?? null, burns: windowBurns(load, otherRole, otherModel) });
      if (other.role === 'coder') workingCoders.set(load.family, (workingCoders.get(load.family) ?? 0) + 1);
    }
    // A (task 2382 P2): the seats of this wallet in the role of this pick that can
    // still spend it — provisioning or working, plus a ready seat with no turn
    // younger than 10 minutes. Read from the store in the same synchronous step as
    // the pick and never gated on the limits reading (the reservations above are):
    // a create that interleaved must see every seat already inserted (critic answer 2).
    const workingSeats = new Map<Family, number>();
    const freshReady = Date.now() - 10 * 60_000;
    for (const other of self.store.listSeats({ notStatus: 'closed' })) {
      if (accountingRole({ role: other.role as ProfileRole, data: other.data }) !== role) continue;
      const live = other.status === 'provisioning' || other.status === 'working'
        || (other.status === 'ready' && !self.store.listTurns(other.id).length && Date.parse(other.created_at) > freshReady);
      if (live) workingSeats.set(other.family as Family, (workingSeats.get(other.family as Family) ?? 0) + 1);
    }
    // The quality tier of each cell of this role's matrix (task 2382 P3b), read in the
    // same synchronous step as the pick, beside A: no await sits between the pick and
    // the seat insert. The cell is the matrix's (role, wallet, model, effort) keyed by
    // the accounting role (role-stats, the writer's row key); a matrix cell without an
    // effort (scout opencode) names no written cell — role-stats records the seat's
    // effort and a null one writes no cell — so the sentinel can only answer NORMAL.
    const tiers = new Map<Family, QualityAnswer>();
    for (const family of Object.keys(roleMatrix()[role]) as Family[]) {
      const profile = roleMatrix()[role][family]!;
      tiers.set(family, tierOf(self.options.stateDir, { role: burnRole, wallet: family, model: profile.model, effort: profile.effort ?? 'none' }));
    }
    return { loads, reservations, workingCoders, workingSeats, tiers };
  }

  /** Files for a turn whose brief names none: the seat's persisted taskFiles; a reviewer without them takes its author coder's. */
export function contextFiles(self: SeatManager, seat: Seat): string[] {
    const own = stringsOf(seat.data.taskFiles);
    if (own.length || seat.role !== 'reviewer' || typeof seat.data.author !== 'string') return own;
    return stringsOf(self.store.getSeat(seat.data.author)?.data.taskFiles);
  }

  /** Serialize HTTP prompts per seat across Jev's await: two concurrent first calls cannot swap which one gets gated. */
export async function promptScoped(self: SeatManager, seatId: string, text: string, timeoutMs?: number, options: PromptOptions = {}, wideBrief?: string): Promise<Turn> {
    const previous = self.scopePending.get(seatId);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    self.scopePending.set(seatId, pending);
    try {
      await previous;
      // role 'auto' injects its create-time reading (task 2955): one judgeScope call serves the pick,
      // the gate and the hints.
      const scope = options.assessed !== undefined ? options.assessed : await self.assessScope(seatId, text, wideBrief);
      // role 'auto' with wide_brief: the create-time reading already scored wide; it is kept on the
      // turn, the bypass is recorded as usual, and no background reading is made (task 2955).
      const injectedBypass = options.assessed?.status === 'scored' && options.assessed.score > WIDE_BRIEF_P && wideBrief !== undefined;
      if (scope?.status === 'scored' && scope.score > WIDE_BRIEF_P && !injectedBypass) {
        const sha256 = createHash('sha256').update(text).digest('hex');
        self.options.log('info', 'seat.brief_refused', { seat: seatId, title: self.store.getSeat(seatId)!.title,
          score: scope.score, threshold: WIDE_BRIEF_P, sha256, brief: text.slice(0, 300) });
        // A refusal leaves no turn: the event log is the durable record the threshold is calibrated from (task 1943; 0.75 -> 0.85 by task 2817).
        self.store.appendEvent('seat.brief_refused', { score: scope.score, threshold: WIDE_BRIEF_P, features: scope.features, model: scope.model ?? null, sha256 }, seatId);
        throw new Error(`coder brief scope ${scope.score} above ${WIDE_BRIEF_P.toFixed(2)}: split the behaviors or new units across sequential seats, or pass wide_brief explaining why that cannot be done`);
      }
      const turn = self.prompt(seatId, text, timeoutMs, { ...options, scope: scope ?? undefined });
      if (scope?.status === 'bypassed') {
        self.store.updateSeat(seatId, { data: { wideBrief: { reason: scope.reason, at: new Date().toISOString(), turn: turn.id } } },
          'seat.wide_brief', { turn: turn.id, reason: scope.reason });
        // The bypassed turn is already queued; Jev reads the brief in the background and its score joins the
        // turn's persisted scope when it arrives (task 1943). It never refuses, and nothing retries a failure.
        self.bypassScope.set(turn.id, null);
        void self.recordBypassScope(text, turn.id);
      } else if (injectedBypass && wideBrief !== undefined) {
        self.store.updateSeat(seatId, { data: { wideBrief: { reason: wideBrief.trim(), at: new Date().toISOString(), turn: turn.id } } },
          'seat.wide_brief', { turn: turn.id, reason: wideBrief.trim() });
      }
      return turn;
    } finally {
      release();
      if (self.scopePending.get(seatId) === pending) self.scopePending.delete(seatId);
    }
  }
  /** The other side's stored report, copied onto the turn so a later close cannot drop it (task 2156 D2). */
  function opponentReport(turnId: string, report: Record<string, unknown>): string {
    const findings = report.findings as { claim: string; evidence: string }[];
    const forLead = typeof report.forLead === 'string' ? report.forLead : '';
    return ['', `## Opponent turn ${turnId}`, 'claims:', ...findings.map((finding) => finding.claim), 'evidence:', ...findings.map((finding) => finding.evidence), 'forLead:', forLead].join('\n');
  }

  /** Round 2 of a table member: every other member's round-1 report, anonymized as Member A/B/C by creation order (operator #19423). */
  function tableAppendix(self: SeatManager, seat: Seat, options: string[]): string {
    const lines: string[] = [];
    const members = tableMembers(self, seat);
    for (let i = 0; i < members.length; i += 1) {
      const member = members[i];
      if (member.id === seat.id) continue;
      const first = self.store.listTurns(member.id)[0];
      if (!first || first.status !== 'done' || first.text === null) continue;
      if (self.store.getGrade(first.id)?.reportRepairRejected === true) continue;
      const parsed = parseReport(first.text, 'debater', [], { stored: true, table: { options } });
      if (!parsed.ok) continue;
      const findings = parsed.report.findings as { claim: string; evidence: string }[];
      const forLead = typeof parsed.report.forLead === 'string' ? parsed.report.forLead : '';
      lines.push('', `## ${memberLabel(i)}`, 'claims:', ...findings.map((finding) => finding.claim), 'evidence:', ...findings.map((finding) => finding.evidence), 'forLead:', forLead);
    }
    return lines.join('\n');
  }

  /**
   * A debater's second turn requires rebut: another debater's done first turn with a parsed report.
   * Anything else is refused, and the message names the parameter. The appendix is outside the word count.
   */
  function rebuttalOf(self: SeatManager, seat: Seat, turns: Turn[], rebut: unknown): string {
    const second = seat.role === 'debater' && turns.length === 1;
    if (rebut === undefined) {
      if (second) throw new Error("a debater's second turn requires rebut: the turn id of another debater's done first turn");
      return '';
    }
    if (typeof rebut !== 'string' || !rebut.trim()) throw new Error('rebut must be a turn id');
    const named = rebut.trim();
    if (!second) throw new Error('rebut is only for a debater\'s second turn');
    if (named === 'table') {
      const options = Array.isArray(seat.data.options) ? seat.data.options as string[] : undefined;
      if (!options || options.length === 0) throw new Error('rebut "table" is only for a debater created with options (operator #19423)');
      return tableAppendix(self, seat, options);
    }
    // A table member's second turn reads the anonymized appendix, never a fork rebuttal: a turn id
    // would re-parse the named report without the vote contract and fail (operator #19423).
    if (Array.isArray(seat.data.options) && (seat.data.options as string[]).length) {
      throw new Error('a table member rebuts with rebut "table", not a turn id (operator #19423)');
    }
    const turn = self.store.getTurn(named);
    if (!turn) throw new Error(`rebut '${named}' is not a turn`);
    const other = self.store.getSeat(turn.seat_id);
    const first = other ? self.store.listTurns(other.id)[0] : undefined;
    if (!other || other.id === seat.id || other.role !== 'debater' || turn.status !== 'done' || first?.id !== turn.id) {
      throw new Error(`rebut '${named}' must be the done first turn of another debater`);
    }
    if (self.store.getGrade(turn.id)?.reportRepairRejected === true || turn.text === null) {
      throw new Error(`rebut '${named}' has no parsed report`);
    }
    const parsed = parseReport(turn.text, 'debater', [], { stored: true, table: tableContractOf(other) });
    if (!parsed.ok) throw new Error(`rebut '${named}' has no parsed report`);
    // Operator #16088: a fork is two models, so a rebuttal between two seats of one model is refused.
    const model = seatModel(seat);
    if (model !== undefined && model === seatModel(other)) {
      throw new Error(`rebut '${named}': ${seat.id} and ${other.id} both run ${model}; the two debaters of one fork never run the same model (operator #16088)`);
    }
    return opponentReport(turn.id, parsed.report);
  }


export function prompt(self: SeatManager, seatId: string, text: string, timeoutMs?: number, options: PromptOptions = {}): Turn {
    const seat = self.store.getSeat(seatId);
    if (!seat) throw new Error(`no seat '${seatId}'`);
    if (self.closing.has(seatId) || seat.data.closePending === true) throw new Error(`seat ${seatId} is closing`);
    if (seat.status === 'closed' || seat.status === 'failed') throw new Error(`seat ${seatId} is ${seat.status}${seat.data.failure ? `: ${seat.data.failure}` : ''}`);
    if (typeof text !== 'string' || !text.trim()) throw new Error('prompt must be non-empty text');
    if (options.tokenCap !== undefined) {
      if (!isStandArm(seat.data.standArm) || seat.data.harness !== 'pi') throw new Error('token_cap is for isolated Pi stand seats only');
      if (!Number.isInteger(options.tokenCap) || options.tokenCap < 256 || options.tokenCap > 1_000_000) throw new Error('token_cap must be an integer from 256 to 1000000');
    }
    const words = wordCount(text);
    const longBrief = typeof options.longBrief === 'string' ? options.longBrief.trim() : '';
    if (words > BRIEF_WORDS && !longBrief) {
      throw new Error(`the brief is ${words} words; the limit is ${BRIEF_WORDS}. Cut it to the task, owned files, evidence and acceptance and link larger artifacts, or pass long_brief with the reason it cannot be shorter`);
    }
    const files = options.files ?? [];
    if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || !file.trim() || path.isAbsolute(file))) {
      throw new Error('files must be repo-relative paths');
    }
    // A row stored before its role was removed (screenshotter, decision #19248) takes no turn.
    if (!Object.hasOwn(ROLE_POLICY, seat.role)) throw new Error(`role '${seat.role}' was removed; close seat ${seatId}`);
    const turns = self.store.listTurns(seatId);
    // A sealed role answers a fixed number of questions (absent turns means 1). A further prompt is a new seat.
    const limit = roleTurnLimit(seat.role as SeatRole);
    if (ROLE_POLICY[seat.role as SeatRole].sealed && turns.length >= limit) {
      const how = limit === 1 ? 'one question' : `${limit} questions`;
      throw new Error(`${seat.role} seats answer ${how}; create a new seat`);
    }
    if (turns.filter((turn) => turn.status === 'queued').length >= MAX_QUEUED_TURNS) {
      throw new Error(`seat ${seatId} already has ${MAX_QUEUED_TURNS} queued turns; wait for one to start before prompting again`);
    }
    // The opponent report is outside the 300-word count: wordCount already ran on the lead brief alone (task 2156 D2).
    // briefSuffix rides outside the word count exactly like the rebuttal appendix (task 2955).
    const stored = text + rebuttalOf(self, seat, turns, options.rebut) + (options.briefSuffix ?? '');
    const named = [...new Set(files.map((file) => file.trim()))];
    const context = named.length ? named : self.contextFiles(seat);
    if (!turns.length && !context.length && (landable(seat.role) || seat.role === 'bughunter')) {
      throw new Error('files are required for a first coder, tester, designer, copywriter, motion or bughunter brief; pass the repo-relative files of the area (for a bug with an unknown cause, the suspected area)');
    }
    const limitMs = timeoutMs ?? turnLimitMs(seat, self.options.turnTimeoutMs);
    const pending: TurnPending = {
      files: context,
      timeoutMs: limitMs,
      recheck: !(seat.role === 'coder' && options.recheck === false),
      ...(options.tokenCap !== undefined ? { tokenCap: options.tokenCap } : {}),
    };
    const turn = self.store.insertTurn(seatId, stored, seat.role === 'coder' && !turns.length && options.scope ? { scope: currentScope({ ...options.scope, model: options.scope.model ?? null }) } : undefined, pending);
    if (seat.role === 'coder' && options.recheck === false) self.recheckOptOut.add(turn.id);
    self.briefFiles.set(turn.id, context);
    if (!turns.length && !context.length && FILES_ROLES.has(seat.role)) self.store.updateSeat(seatId, { data: { noFilesTurn: turn.id } }, 'seat.no_files', { turn: turn.id });
    if (options.tokenCap !== undefined) self.tokenCaps.set(turn.id, options.tokenCap);
    if (landable(seat.role)) {
      const existing = Array.isArray(seat.data.taskFiles) ? seat.data.taskFiles as string[] : [];
      const known = new Set(existing.map(normalizeFile));
      const added = named.filter((file) => {
        const normalized = normalizeFile(file);
        if (known.has(normalized)) return false;
        known.add(normalized);
        return true;
      });
      if (added.length) {
        self.store.updateSeat(seatId, { data: { taskFiles: [...existing, ...added] } }, 'seat.files_added', { files: added });
        self.normalizedFiles.delete(seatId);
      }
    }
    // Rechecks wait for restart or cancel during drain; a parent waiting for a scout must not hold the drain open forever.
    // A critic keeps the scout rule (plan 14746): its one question runs during a drain.
    if (!self.draining || seat.role === 'scout' || seat.role === 'critic') self.chain(seatId, () => self.run(seatId, turn.id, limitMs));
    else self.drainHeld.set(turn.id, limitMs);
    return turn;
  }
