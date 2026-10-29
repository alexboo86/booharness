import path from 'node:path';
import { existsSync, mkdirSync, chmodSync, lstatSync, mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import type { SeatManager } from './seats.ts';
import type { Family, ProviderSession, SessionSpec, Usage } from './providers/types.ts';
import { instrumentsOff, offEnv, seatInstruments } from './shared.entry.ts';
import { isStandArm, standEnv } from './stand.ts';
import { gradeFlags, SUPPORTED_P, type Finding, type Grade } from './grading.ts';
import { deliveryReport, parseReport, tableRows, WITHDRAWN } from './report.ts';
import { lessonApplications, type MemoryProposal } from './memory-proposals.ts';
import { TERMINAL_TURN, drainWarning, type Seat, type Turn, type TurnEnd } from './store.ts';
import { lastCheckResults } from './check-verify.ts';
import { criteriaFlags, modelCallFlags } from './digest-text.ts';
import { seatToolEnv } from './shared.entry.ts';
import { worktreeChanges } from './worktrees.ts';
import { NO_FILES_WARNING, claudeTranscriptPath, gitAsync, currentScope, landable, pathInWriteScope, TEST_FILE_GLOBS, validGrade, watchFlags, writeScopeOf } from './seats-defs.ts';
import type { SeatRole, Digest, CoderTree, SeatData } from './seats-defs.ts';
import { readLanguageMode } from './shared.entry.ts';
import { steSummary, type LanguageSummary } from './ste.ts';

export async function session(self: SeatManager, seat: Seat): Promise<ProviderSession> {
    const live = self.live.get(seat.id);
    if (live && !live.closed) return live;
    // The provider process exited (a dropped Mac⇄host link kills every remote seat's pi at once):
    // prompting it would only replay the stale exit error, so resume the stored session on a new
    // process (remote: a new ssh with a new forward). A failed resume propagates: run's catch fails
    // the turn with THAT error, never the stale one, and sessionId stays stored so the next turn
    // retries the resume instead of silently losing the conversation after a transient link flap.
    const exited = live;
    if (exited) self.live.delete(seat.id);
    const data = seat.data as SeatData;
    const off = instrumentsOff(seatInstruments(seat.data));
    const tool = self.seatTool?.(seat) ?? null;
    // A codex Pi seat that edits loads the verified codex-edit extension (operator
    // #13098); a missing, tampered or unverified install throws here, so the seat
    // fails visibly instead of silently keeping Pi's stock edit tools.
    const codexEdit = await self.codexEditFor(seat, data);
    const hashlineEdit = await self.hashlineEditFor(seat, data);
    const writeScope = writeScopeOf(seat.role);
    const spec: SessionSpec = {
      family: seat.family as Family,
      cwd: seat.cwd!,
      ...(typeof data.host === 'string' ? { host: data.host } : {}),
      ...(typeof data.remoteMcpConfig === 'string' ? { remoteMcpConfig: data.remoteMcpConfig } : {}),
      ...(codexEdit ? { codexEdit } : {}),
      ...(hashlineEdit ? { hashlineEdit } : {}),
      access: data.access,
      ...(data.model ? { model: data.model } : {}),
      ...(data.effort ? { effort: data.effort } : {}),
      ...(off.length ? { instrumentsOff: off } : {}),
      // ORCH_SEAT_INSTRUMENTS_OFF is what the Pi extension reads to refuse an off instrument.
      env: { SEAT_POLICY_ROLE: seat.role, ORCH_SEAT_ID: seat.id, ...(off.length ? { ORCH_SEAT_INSTRUMENTS_OFF: offEnv(off) } : {}), ...(hashlineEdit ? { PI_HASHLINE_DIR: hashlineEdit.store } : {}), ...(isStandArm(data.standArm) ? standEnv(self.options.stateDir, data.standArm, process.env.PATH ?? '') : {}), ...(tool && data.harness === 'pi' ? seatToolEnv(tool) : {}), ...(writeScope !== undefined ? { ORCH_SEAT_WRITE_SCOPE: JSON.stringify(writeScope) } : {}) },
      ...(tool ? { seatTool: tool } : {}),
    };
    const adapter = self.adapter(seat.family as Family, data.harness);
    // A seat that already had a provider session resumes it: after an orch restart the conversation continues.
    // A session the provider no longer knows would fail every later turn the same way, so the seat starts a
    // fresh one instead, and the next message carries the whole role context again (task 1429).
    let session: ProviderSession;
    if (data.sessionId) {
      if (exited) {
        self.options.log('warn', 'seat.session_exited', { seat: seat.id, sessionId: data.sessionId });
        session = await adapter.resume(spec, data.sessionId);
      } else {
        try {
          session = await adapter.resume(spec, data.sessionId);
        } catch (error) {
          self.options.log('warn', 'seat.resume_failed', { seat: seat.id, sessionId: data.sessionId, message: (error as Error).message });
          self.store.updateSeat(seat.id, { data: { sessionId: null, contextDelivered: false } }, 'seat.resume_failed');
          session = await adapter.start(spec);
        }
      }
    } else {
      session = await adapter.start(spec);
    }
    self.live.set(seat.id, session);
    if (session.sessionId !== data.sessionId || session.model !== data.providerModel) {
      self.store.updateSeat(seat.id, { data: { sessionId: session.sessionId, providerModel: session.model } }, 'seat.session');
    }
    return session;
  }

export function end(self: SeatManager, turnId: string, end: TurnEnd): void {
    self.liveTools.delete(turnId);
    self.turnLogEnd(turnId);
    const watch = self.store.getTurn(turnId)?.watch;
    // What was recorded at queue time survives a turn that ends before run() built its own record.
    const scope = self.takeBypassScope(turnId, currentScope(watch?.scope));
    const initial = scope ? { scope } : {};
    self.store.finishTurn(turnId, Object.keys(initial).length && !end.watch ? { ...end, watch: initial } : end);
    self.wake(turnId);
  }

/** Tool calls a running turn has made so far, for the dashboard; null once it ended or before its first. */
export function liveToolCount(self: SeatManager, turnId: string): number | null {
    return self.liveTools.get(turnId)?.count ?? null;
  }

/** The same turn's calls by kind (toolkinds.ts), or null. */
export function liveToolKinds(self: SeatManager, turnId: string): Record<string, number> | null {
    const live = self.liveTools.get(turnId);
    return live ? { ...live.kinds } : null;
  }

export function wake(self: SeatManager, turnId: string): void {
    for (const wake of self.waiters.get(turnId) ?? []) wake();
    self.waiters.delete(turnId);
  }

export async function drop(self: SeatManager, seatId: string): Promise<void> {
    const session = self.live.get(seatId);
    self.live.delete(seatId);
    await session?.close().catch(() => undefined);
  }

/**
 * The turn once it has ended, or its current state when `timeoutMs` runs out first. An ended coder
 * correction returns once its recheck routing is recorded, or when that hold's bound runs out.
 */
export async function wait(self: SeatManager, turnId: string, timeoutMs: number): Promise<Turn> {
    const turn = self.store.getTurn(turnId);
    if (!turn) throw new Error(self.store.noTurnError(turnId));
    if (timeoutMs <= 0) return turn;
    if (!TERMINAL_TURN.has(turn.status)) {
      const set = self.waiters.get(turnId) ?? new Set<() => void>();
      self.waiters.set(turnId, set);
      let wake!: () => void;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => wake(), timeoutMs);
        wake = () => { clearTimeout(timer); set.delete(wake); resolve(); };
        set.add(wake);
      });
    }
    // Post-finish work registered with afterTurn() holds a waiter up to each entry's bound;
    // a pending entry past its bound still shows its digest field as pending (memory #12411).
    for (const { settled, until } of [...(self.postTurn.get(turnId)?.values() ?? [])]) {
      const left = until - Date.now();
      if (left <= 0) continue;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, left); })]);
      clearTimeout(timer);
    }
    return self.store.getTurn(turnId)!;
  }

/** Finished-report summaries kept across board polls. Oldest insertion drops first. */
export const LANGUAGE_CACHE_CAP = 128;
const languageCache = new Map<string, LanguageSummary>();

export function languageCacheSize(): number {
  return languageCache.size;
}

function rememberLanguage(key: string, summary: LanguageSummary): void {
  if (languageCache.has(key)) return;
  while (languageCache.size >= LANGUAGE_CACHE_CAP) {
    const oldest = languageCache.keys().next().value;
    if (oldest === undefined) break;
    languageCache.delete(oldest);
  }
  languageCache.set(key, summary);
}

/** Claims, then forLead. Evidence, checked and notChecked are never judged. */
function reportFreeText(report: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(report.findings)) {
    for (const finding of report.findings) {
      if (!finding || typeof finding !== 'object') continue;
      const claim = (finding as { claim?: unknown }).claim;
      if (typeof claim === 'string') parts.push(claim);
    }
  }
  if (typeof report.forLead === 'string') parts.push(report.forLead);
  return parts.join('\n');
}

/** One summary per turn, mode and free text. A later poll of the same turn does not run the checker again. */
function languageFor(self: SeatManager, turn: Turn, report: Record<string, unknown> | null): LanguageSummary | null {
  if (turn.status !== 'done' || !report) return null;
  const stateDir = self.options.stateDir;
  const mode = readLanguageMode(stateDir).mode;
  if (mode === 'off') return null;
  const text = reportFreeText(report);
  const key = `${turn.id}\0${mode}\0${text}`;
  const cached = languageCache.get(key);
  if (cached) return cached;
  let summary: LanguageSummary | null;
  try {
    summary = steSummary(text, stateDir);
  } catch {
    return null;
  }
  if (summary) rememberLanguage(key, summary);
  return summary;
}

/** A checkout whose changes can be read: sync did not fail, and the worktree is still there. */
function changesCheckout(seat: Seat, syncFailure: unknown): { worktree: string; base: string } | null {
  const data = seat.data as SeatData;
  if (syncFailure || !seat.worktree || !data.base || data.worktreeRemoved || !existsSync(seat.worktree)) return null;
  return { worktree: seat.worktree, base: data.base };
}
/** Modified already-tracked test files in a scoped checkout. A git failure leaves the flag out (digest must not throw). */
async function modifiedTrackedTestFlags(self: SeatManager, seat: Seat, checkout: { worktree: string; base: string } | null): Promise<string[]> {
  if (writeScopeOf(seat.role) === undefined || !checkout) return [];
  try {
    const stdout = (await gitAsync('git', ['--no-optional-locks', 'diff', '--name-status', '--no-renames', '-z', checkout.base], {
      cwd: checkout.worktree, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
    })).stdout;
    const fields = String(stdout).split('\0').filter(Boolean);
    const flags: string[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (fields[i] === 'M' && pathInWriteScope(fields[i + 1], TEST_FILE_GLOBS)) flags.push(`existing test file modified: ${fields[i + 1]}`);
    }
    return flags;
  } catch (error) {
    self.options.log('warn', 'seat.write_scope_flag_unavailable', { seat: seat.id, turn: undefined, message: (error as Error).message });
    return [];
  }
}


/** Rebuilt from the durable report on delivery too, so restart/missing artifacts cannot yield dead paths. */
export function persistTable(self: SeatManager, turnId: string, report: Record<string, unknown>): Digest['table'] {
  if (!['scout', 'researcher'].includes(String(report.role)) || typeof report.table !== 'string') return undefined;
  if (!/^(?:scout|researcher)-[a-z][a-z0-9-]*-[0-9a-f]{6}\.[1-9]\d*$/.test(turnId)) throw new Error('invalid table turn id');
  const dir = path.join(self.options.stateDir, 'tables');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('table directory is not a real directory');
  chmodSync(dir, 0o700);
  const temp = mkdtempSync(path.join(dir, '.write-'));
  const file = path.join(dir, `${turnId}.md`);
  try {
    const pending = path.join(temp, 'table.md');
    writeFileSync(pending, report.table, { mode: 0o600, flag: 'wx' });
    renameSync(pending, file);
  } finally { rmSync(temp, { recursive: true, force: true }); }
  return { rows: tableRows(report.table), path: file };
}

/** Digest fields for the turn's inventory table; a failed write becomes a flag, never a broken digest. */
function tableFields(self: SeatManager, turnId: string, report: Pick<Digest, 'report' | 'flags'>): { table?: Digest['table'] } {
  let table: Digest['table'] = undefined;
  try {
    if (report.report) table = persistTable(self, turnId, report.report);
  } catch (error) {
    report.flags.push(`table unavailable: ${(error as Error).message}`);
  }
  return table ? { table } : {};
}

export async function digest(self: SeatManager, turn: Turn): Promise<Digest> {
    const seat = self.store.getSeat(turn.seat_id)!;
    const data = seat.data as SeatData;
    const usage = turn.usage as Usage | null;
    const tokens = usage
      ? {
          input: usage.inputTokens,
          cacheRead: usage.cacheReadTokens,
          output: usage.outputTokens,
          total: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens,
        }
      : null;
    const report = self.reportOf(turn);
    const table = tableFields(self, turn.id, report);
    const syncFailure = landable(seat.role) ? (data.remoteSyncFailures as Record<string, string> | undefined)?.[turn.id] : undefined;
    const leftOut = landable(seat.role) ? (data.remoteSyncInvalidPaths as Record<string, string[]> | undefined)?.[turn.id] : undefined;
    const circling = !syncFailure && seat.role === 'coder' && turn.seq >= 3 ? await self.circlingFlags(seat, turn, report.report) : [];
    const regressed = !syncFailure && seat.role === 'coder' && turn.seq >= 2 ? self.regressionFlags(seat, turn, report.report) : [];
    const checkout = changesCheckout(seat, syncFailure);
    const changes = checkout ? await worktreeChanges(checkout.worktree, checkout.base) : null;
    const testEditFlags = await modifiedTrackedTestFlags(self, seat, checkout);
    const drain = turn.status === 'queued' ? self.store.drainStatus() : null;
    const language = languageFor(self, turn, report.report);
    // Historical support outcomes must read authored severity, not the delivery projection.
    const support = self.supportNotes(turn, report.report, report.grade);
    const inferredHints = ((report.report?.findings ?? []) as Finding[]).flatMap((finding, i) =>
      finding.reproduced === false && ['blocker', 'major'].includes(finding.severity)
        ? [`finding ${i + 1} inferred (authored ${finding.severity}); delivered as suggestion. Inferred findings are suggestions, never blockers; reproduce to promote.`] : []);
    const compactions = data.harness === 'pi' ? data.compactionsByTurn?.[turn.id] ?? null : null;
    // Unrestricted coders also have no write-scope list, but their branches land.
    const compactionFlags = compactions !== null && compactions > 0 && !landable(seat.role) && writeScopeOf(seat.role) === undefined
      ? [`compacted: ${compactions} times; spot-check the evidence before use`] : [];
    return {
      seat: seat.id,
      title: seat.title,
      role: seat.role,
      family: seat.family,
      turn: turn.id,
      status: turn.status,
      seconds: turn.duration_ms === null ? null : Math.round(turn.duration_ms / 1000),
      tokens,
      tools: turn.tools,
      ...(data.harness === 'pi' ? { compactions } : {}),
      error: turn.error,
      ...(isStandArm(data.standArm) ? { sessionJsonl: typeof data.sessionId === 'string' && data.sessionId.startsWith(`${path.join(self.options.stateDir, 'ab-stand', 'arms', data.standArm, 'sessions')}${path.sep}`) ? data.sessionId : null } : data.harness === 'native' && (seat.family === 'claude' || seat.family === 'glm') ? { sessionJsonl: claudeTranscriptPath(self.options.home, seat.cwd!, typeof data.sessionId === 'string' ? data.sessionId : '') } : {}),
      ...report,
      ...table,
      report: report.report ? deliveryReport(report.report) : null,
      lessonApplications: lessonApplications(self.store, turn.id, (report.report?.memory ?? []) as MemoryProposal[]),
      flags: [...modelCallFlags(usage?.raw, data.harness, seat.family), ...compactionFlags, ...(data.compactionFailuresByTurn?.[turn.id] ?? []).map((error: string) => `Pi compaction failed: ${error}`), ...(data.harness === 'pi' && data.toolsMissingByTurn?.[turn.id]?.length ? [`tools missing: ${data.toolsMissingByTurn[turn.id].join(', ')}`] : []), ...(drain ? [`held by drain: ${drainWarning(drain)}`] : []), ...(data.remoteProvisionNotes ?? []), ...(data.noFilesTurn === turn.id ? [NO_FILES_WARNING] : []), ...(seat.role === 'coder' && turn.duration_ms !== null && turn.duration_ms > 25 * 60_000 ? ['long turn: over 25 minutes'] : []), ...circling, ...regressed, ...(syncFailure ? [`remote turn sync failed: ${syncFailure}; mirror and recorded tree unavailable`] : []), ...(leftOut?.length ? [`remote turn sync left out invalid paths: ${leftOut.join(', ')}`] : []), ...testEditFlags, ...criteriaFlags(report.report), ...watchFlags(turn.watch), ...report.flags, ...inferredHints, ...(turn.status === 'done' && turn.tools === 0 && turn.seq === 1 && ['scout', 'critic', 'coder', 'tester', 'designer', 'copywriter', 'motion', 'reviewer', 'legal', 'security', 'bughunter'].includes(seat.role) ? [`no tool calls: this ${seat.role} turn finished done without calling a tool`] : [])],
      watch: turn.watch,
      scope: turn.watch?.scope ?? null,
      worktree: changes && seat.worktree ? { path: seat.worktree, branch: data.branch, files: changes.files, stat: changes.stat } : null,
      rechecks: data.recheckResults?.[turn.id]?.rechecks ?? [],
      // Registered routing not yet recorded: say so rather than show no recheck (task 1620, memory #12411).
      recheckNotes: [...(data.recheckResults?.[turn.id]?.notes ?? []), ...(self.afterTurnPending(turn.id, 'rechecks') ? ['recheck routing pending: not settled yet; read the coder seat\'s recheckResults or seat.rechecks events'] : [])],
      support,
      ...(language ? { language } : {}),
    };
  }

/** Name the latest retained, completed checkout where each currently failed check last passed. */
export function regressionFlags(self: SeatManager, seat: Seat, turn: Turn, report: Record<string, unknown> | null): string[] {
    if (!TERMINAL_TURN.has(turn.status)) return [];
    const failed = [...lastCheckResults(report)].filter(([, result]) => result === 'fail').map(([command]) => command);
    if (!failed.length) return [];
    const trees = new Map(((seat.data.trees as CoderTree[] | undefined) ?? []).map((entry) => [entry.turn, entry.tree]));
    const pending = new Set(failed);
    const lastPassed = new Map<string, { seq: number; tree: string }>();
    // listTurns is ordered by seq. Walk backward so an older pass cannot mask a newer recorded pass.
    const turns = self.store.listTurns(seat.id);
    for (let i = turns.length - 1; i >= 0 && pending.size; i--) {
      const earlier = turns[i];
      if (earlier.seq >= turn.seq || !TERMINAL_TURN.has(earlier.status)) continue;
      const tree = trees.get(earlier.id);
      if (!tree) continue; // Never suggest a restoration target orch cannot name.
      const checks = lastCheckResults(self.reportOf(earlier).report);
      for (const command of pending) {
        if (checks.get(command) !== 'pass') continue;
        lastPassed.set(command, { seq: earlier.seq, tree });
        pending.delete(command);
      }
    }
    return failed.flatMap((command) => {
      const passed = lastPassed.get(command);
      return passed ? [`regressed: ${command} passed at turn ${passed.seq} (tree ${passed.tree.slice(0, 7)})`] : [];
    });
  }

/** Compare only the three consecutive turn ends, never substitute an older recorded tree for a missing one. */
export async function circlingFlags(self: SeatManager, seat: Seat, turn: Turn, report: Record<string, unknown> | null): Promise<string[]> {
    const previous = self.store.listTurns(seat.id).filter((entry) => entry.seq === turn.seq - 1 || entry.seq === turn.seq - 2);
    const older = previous.find((entry) => entry.seq === turn.seq - 2);
    const recent = previous.find((entry) => entry.seq === turn.seq - 1);
    if (!older || !recent || !TERMINAL_TURN.has(turn.status)) return [];
    const flags: string[] = [];
    const checks = [older, recent, turn].map((entry) => lastCheckResults(entry.id === turn.id ? report : self.reportOf(entry).report));
    for (const [command, result] of checks[2]) {
      if (result === 'fail' && checks[0].get(command) === 'fail' && checks[1].get(command) === 'fail')
        flags.push(`circling: ${command} failed 3 turns running`);
    }
    const trees = (seat.data.trees as CoderTree[] | undefined) ?? [];
    const treeOf = (entry: Turn) => trees.find((record) => record.turn === entry.id)?.tree;
    const [before, middle, now] = [older, recent, turn].map(treeOf);
    if (!before || !middle || !now || !seat.worktree || !existsSync(seat.worktree)) return flags;
    const git = async (...args: string[]) => (await gitAsync('git', ['--no-optional-locks', ...args], {
      cwd: seat.worktree!, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
    })).stdout;
    try {
      const files = (await git('diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', before, middle)).split('\0').filter(Boolean);
      let restored = 0;
      for (const file of files) {
        // Object IDs compare bytes, not text or diff formatting; a missing blob has no content to restore.
        let original: string;
        let current: string;
        try {
          original = (await git('rev-parse', '-q', '--verify', `${before}:${file}`)).trim();
          current = (await git('rev-parse', '-q', '--verify', `${now}:${file}`)).trim();
        } catch { continue; } // A missing file has no byte content to restore.
        if (original === current) {
          flags.push(`circling: ${file} back to turn N-2 content`);
          if (++restored === 3) break;
        }
      }
    } catch (error) {
      self.options.log('warn', 'seat.circling_unavailable', { seat: seat.id, turn: turn.id, message: (error as Error).message });
    }
    return flags;
  }

/**
 * What became of the turn's one support round (task 1447), judged against the FINAL report and its
 * stored grade. Findings are identified by INDEX — the corrected report keeps count and order, so
 * claim text can be reworded and duplicates cannot bind to the wrong entry. A finding marked
 * "withdrawn" was withdrawn in place and its claim is named; one no longer blocker/major was
 * downgraded; one still flagged says so — the flag itself stays in `flags`. A rejected correction
 * left the original report standing, with its flags.
 */
export function supportNotes(self: SeatManager, turn: Turn, report: Record<string, unknown> | null, grade: Grade | null): string[] {
    const data = self.store.getSeat(turn.seat_id)!.data as SeatData;
    const round = data.supportRounds?.[turn.id] as { asked: { finding: number; severity: string; score: number; claim: string }[]; outcome: string; reason?: string; error?: string } | undefined;
    if (!round) return [];
    if (round.outcome === 'failed') return [`failed${round.error ? `: ${round.error}` : ''}; the original report stands`];
    if (round.outcome === 'rejected') return [`rejected: ${round.reason ?? 'the corrected report does not account for every original finding'}; the original report stands`];
    if (round.outcome === 'invalid') return ['the corrected answer was not a valid report; the original report stands'];
    if (!report) return ['the corrected report is missing'];
    const findings = (Array.isArray(report.findings) ? report.findings : []) as Finding[];
    return round.asked.map((asked) => {
      const finding = findings[asked.finding];
      if (!finding) return `finding ${asked.finding + 1} is missing from the corrected report`;
      if (finding.severity === WITHDRAWN) return `finding ${asked.finding + 1} withdrawn: ${finding.claim}`;
      if (!['blocker', 'major'].includes(String(finding.severity))) return `finding ${asked.finding + 1} downgraded to ${finding.severity}`;
      const score = grade?.status === 'graded' ? grade.evidenceSupports[asked.finding] : undefined;
      if (typeof score !== 'number') return `finding ${asked.finding + 1} re-grade unavailable`;
      return score >= SUPPORTED_P ? `finding ${asked.finding + 1} now supported (${score.toFixed(2)})` : `finding ${asked.finding + 1} still unsupported (${score.toFixed(2)})`;
    });
  }

/** The parsed report, or why there is none. Never the seat's prose: that stays behind seat_report. */
export function reportOf(self: SeatManager, turn: Turn): Pick<Digest, 'report' | 'reportError' | 'grade' | 'flags'> {
    if (turn.text === null) {
      // A done turn with nothing to read must never look like an accepted report.
      return turn.status === 'done'
        ? { report: null, reportError: 'the turn produced no final message', grade: null, flags: ['no final message'] }
        : { report: null, reportError: null, grade: null, flags: [] };
    }
    const seat = self.store.getSeat(turn.seat_id)!;
    const lessons = self.store.lessonDeliveries(turn.id).filter((row) => row.mode === 'full').map((row) => row.lesson_id);
    // A table member's report carries `vote`; the digest re-parses with the same contract the turn held.
    const table = seat.role === 'debater' && Array.isArray(seat.data.options) && (seat.data.options as string[]).length
      ? { options: seat.data.options as string[] } : undefined;
    const storedGrade = self.store.getGrade(turn.id);
    const repairFlags = Array.isArray(storedGrade?.reportRepairFlags) ? storedGrade.reportRepairFlags.filter((flag): flag is string => typeof flag === 'string') : [];
    // Stored parsing is lenient about legacy criteria; a rejected repair must still stay unparsed.
    if (storedGrade?.reportRepairRejected === true) return { report: null, reportError: 'schema repair rejected; read the full original with seat_report', grade: null, flags: ['no valid report', ...repairFlags] };
    const parsed = parseReport(turn.text, seat.role as SeatRole, lessons, { stored: true, table });
    if (parsed.ok === false) return { report: null, reportError: `${parsed.error}; read the raw message with seat_report only if you need it`, grade: null, flags: ['no valid report', ...repairFlags] };
    const grade = validGrade(storedGrade, (parsed.report.findings as unknown[]).length);
    const failedChecks: string[] = [];
    if (seat.role === 'coder' && parsed.report.status === 'done') {
      for (const [command, result] of lastCheckResults(parsed.report)) {
        if (result === 'fail') failedChecks.push(`failed check: ${command}`);
      }
    }
    return { report: parsed.report, reportError: null, grade, flags: [...repairFlags, ...failedChecks, ...gradeFlags(parsed.report, grade)] };
  }
