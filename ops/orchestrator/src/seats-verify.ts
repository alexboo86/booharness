// Record coder trees, route rechecks, and compare retained reports.
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SeatManager } from './seats.ts';
import type { ContextUsage, Family, ProviderSession } from './providers/types.ts';
import { FINISHED_P, findingNamesFile, type Finding, type Sibling } from './grading.ts';
import { parseReport } from './report.ts';
import { tableContractOf } from './seats-scope.ts';
import { parseNumstat, testPath } from './review-plan.ts';
import type { Seat, Turn, TurnWatchRecord } from './store.ts';
import { PLATFORM_NEEDS, type PlatformNeed } from './placement.ts';
import { snapshotCommit } from './worktrees.ts';
import { FRESH_CONTEXT, EARLIER_REPORTS, EARLIER_CHARS, KEPT_TREES, CORRECTION_PATHS_CAP, MAX_SIBLINGS, gitAsync, reviewRepo, reviewRoles, validGrade } from './seats-defs.ts';
import type { SeatRole, CreateSeat, Recheck, DeferredReplacement, CoderTree, SeatData } from './seats-defs.ts';

export async function recordTree(self: SeatManager, coder: Seat, turnId: string): Promise<void> {
    if (!coder.worktree || self.closing.has(coder.id) || !existsSync(coder.worktree) ||
        (self.store.getSeat(coder.id)?.data.remoteSyncFailures as Record<string, string> | undefined)?.[turnId]) return;
    let scratch: string | null = null;
    const env = { ...process.env };
    delete env.GIT_INDEX_FILE;
    const git = async (args: string[], indexFile?: string) => (await gitAsync('git', ['--no-optional-locks', ...args], {
      cwd: coder.worktree!, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, env: indexFile ? { ...env, GIT_INDEX_FILE: indexFile } : env,
    })).stdout.trim();
    try {
      scratch = await mkdtemp(path.join(os.tmpdir(), 'orch-tree-'));
      const index = path.join(scratch, 'index');
      const real = path.resolve(coder.worktree, await git(['rev-parse', '--git-path', 'index']));
      // From a copy, add -A rehashes only what changed since the real index was written.
      await copyFile(real, index).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      await git(['add', '-A'], index);
      const tree = await git(['write-tree'], index);
      if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('git write-tree returned no tree id');
      const trees = (self.store.getSeat(coder.id)!.data.trees as CoderTree[] | undefined) ?? [];
      self.store.updateSeat(coder.id, { data: { trees: [...trees, { turn: turnId, at: new Date().toISOString(), tree }].slice(-KEPT_TREES) } }, 'seat.tree', { turn: turnId, tree });
    } catch (error) {
      self.options.log('warn', 'seat.tree_failed', { seat: coder.id, turn: turnId, message: (error as Error).message });
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

export async function treeDeltaPaths(self: SeatManager, before: string, now: string, git: (...args: string[]) => Promise<string>): Promise<string[]> {
    const numstat = await git('diff', '--numstat', '-z', '--no-renames', before, now);
    return parseNumstat(numstat, 'invalid correction numstat row').map((row) => row.path);
  }

export async function recheckRoute(self: SeatManager, coder: Seat, coderTurn: string, reviewed: Turn, blockers: Finding[], git: (...args: string[]) => Promise<string>): Promise<{ kind: 'same' | 'new'; reason: string; model?: string | null }> {
    const failure = (coder.data.remoteSyncFailures as Record<string, string> | undefined)?.[coderTurn];
    if (failure) return { kind: 'new', reason: `correction delta unavailable: remote sync failed: ${failure}`, model: 'rule' };
    const trees = (coder.data.trees as CoderTree[] | undefined) ?? [];
    const now = trees.find((entry) => entry.turn === coderTurn)?.tree;
    if (!now) return { kind: 'new', reason: 'correction delta unavailable: no tree was recorded at the correction end', model: 'rule' };
    const seen = reviewed.started_at ?? reviewed.created_at;
    const before = trees.filter((entry) => entry.turn !== coderTurn && entry.at <= seen).at(-1)?.tree ?? String(coder.data.base);
    let paths: string[];
    try {
      paths = await self.treeDeltaPaths(before, now, git);
    } catch (error) {
      return { kind: 'new', reason: `correction delta unavailable: ${(error as Error).message}`, model: 'rule' };
    }
    if (!paths.length) return { kind: 'same', reason: 'the correction changed nothing the reviewer had not seen', model: 'rule' };
    const roots = [coder.worktree!, String(coder.data.main ?? coder.data.repo)];
    const extra = paths.find((file) => !testPath(file) && !blockers.some((finding) => findingNamesFile(finding, file, paths, roots)));
    return extra
      ? { kind: 'new', reason: `correction path not named by the blockers: ${extra}`, model: 'rule' }
      : { kind: 'same', reason: paths.some((file) => testPath(file)) ? 'every correction path is named by the blockers or is a test file' : 'every correction path is named by the blockers', model: 'rule' };
  }

export async function correctionDelta(self: SeatManager, coder: Seat, coderTurn: string, git: (...args: string[]) => Promise<string>): Promise<{ paths: string[]; truncated: boolean } | null> {
    const unavailable = (reason: string) => {
      self.options.log('warn', 'seat.correction_paths_unavailable', { seat: coder.id, turn: coderTurn, reason });
      return null;
    };
    if (!coder.worktree) return unavailable('no coder worktree');
    const failure = (coder.data.remoteSyncFailures as Record<string, string> | undefined)?.[coderTurn];
    if (failure) return unavailable(`remote sync failed: ${failure}`);
    const trees = (coder.data.trees as CoderTree[] | undefined) ?? [];
    const now = trees.find((entry) => entry.turn === coderTurn)?.tree;
    if (!now) return unavailable('no tree was recorded at the correction end');
    const before = trees.filter((entry) => entry.turn !== coderTurn).at(-1)?.tree ?? String(coder.data.base);
    try {
      const unique = [...new Set(await self.treeDeltaPaths(before, now, git))].sort();
      return { paths: unique.slice(0, CORRECTION_PATHS_CAP), truncated: unique.length > CORRECTION_PATHS_CAP };
    } catch (error) {
      self.options.log('warn', 'seat.correction_paths_failed', { seat: coder.id, turn: coderTurn, message: (error as Error).message });
      return null;
    }
  }

export function replacementPlacement(self: SeatManager, reviewer: Seat): Pick<CreateSeat, 'needs' | 'host'> {
    const placement = reviewer.data.placement as { needs?: unknown; target?: unknown; reason?: unknown } | undefined;
    if (!placement || typeof placement.reason !== 'string') throw new Error(`reviewer ${reviewer.id} has no placement journal`);
    if (placement.reason === 'explicit host from the lead') {
      if (typeof placement.target !== 'string' || placement.target === 'local') throw new Error(`reviewer ${reviewer.id} has an invalid explicit host`);
      return { host: placement.target, ...(placement.needs === null ? {} : { needs: placement.needs as PlatformNeed }) };
    }
    if (placement.reason.startsWith('needs omitted (')) return {};
    if (!(PLATFORM_NEEDS as readonly unknown[]).includes(placement.needs)) throw new Error(`reviewer ${reviewer.id} has an invalid explicit need`);
    return { needs: placement.needs as PlatformNeed };
  }

export function deferredDue(self: SeatManager, coderId: string, turnId: string): boolean {
    const data = self.store.getSeat(coderId)?.data;
    return typeof data?.host === 'string' && data.remoteSyncState === 'ready' && !(data.remoteSyncFailures as Record<string, string> | undefined)?.[turnId] &&
      Object.keys((data.deferredReplacements as Record<string, DeferredReplacement> | undefined) ?? {}).length > 0;
  }

export async function queueRechecks(self: SeatManager, coder: Seat, coderTurn: string, deferredOnly = false): Promise<void> {
    coder = self.store.getSeat(coder.id)!;
    const rechecks: Recheck[] = [];
    const decisions: { reviewer: string; kind: 'same' | 'new'; reason: string; model: string | null }[] = [];
    const notes: string[] = [];
    const syncFailure = (coder.data.remoteSyncFailures as Record<string, string> | undefined)?.[coderTurn];
    const pending = { ...(coder.data.deferredReplacements as Record<string, DeferredReplacement> | undefined) };
    // Deferred replacements come due once a sync mirrored the host again; a closing coder's are dropped by closeNow.
    let due: Record<string, DeferredReplacement> = syncFailure || self.closing.has(coder.id) ? {} : { ...pending };
    const deferred: Record<string, DeferredReplacement> = {};
    const resolved = new Set<string>();
    const landedAt = (coder.data.landed as { at?: unknown } | undefined)?.at;
    const stale = typeof landedAt === 'string' ? Object.keys(due).filter((id) => due[id].at <= landedAt) : [];
    if (stale.length) {
      for (const id of stale) { resolved.add(id); notes.push(`deferred new reviewer for ${id} dropped: coder ${coder.id} landed before its host could be mirrored`); }
      self.options.log('warn', 'seat.deferred_replacements_dropped', { seat: coder.id, turn: coderTurn, reviewers: stale, reason: 'coder landed before a turn sync succeeded' });
      due = Object.fromEntries(Object.entries(due).filter(([id]) => !stale.includes(id)));
    }
    if (deferredOnly && !Object.keys(due).length && !resolved.size) return;
    let delta: { paths: string[]; truncated: boolean } | null = null;
    try {
      // The seats_author bound (task 2640): the same rows as the old filter over the unbounded read, closed reviewers included.
      const reviewers = self.store.listSeats({ role: 'reviewer', author: coder.id });
      for (const id of Object.keys(due)) {
        if (reviewers.some((reviewer) => reviewer.id === id)) continue;
        resolved.add(id);
        notes.push(`deferred new reviewer for ${id} dropped: no such reviewer of ${coder.id}`);
      }
      // Unlike a report's changedFiles, the checkout includes committed, staged and untracked paths.
      // Read once per correction, not from the prompt-time overlap cache (which may predate this turn).
      const git = async (...args: string[]) => (await gitAsync('git', ['--no-optional-locks', ...args], {
        cwd: coder.worktree!, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      })).stdout;
      let files: string[] | null = null;
      let omitted: string[] = [];
      let fileError: string | null = null;
      let snapshot: string | null = null;
      let snapshotError: string | null = null;
      // The correction delta is persisted for every correction (task 1702), not only when reproduced
      // blocker and major findings route a recheck: reviewerYieldCounts reads it to tell a held-up finding from an interim one.
      delta = await self.correctionDelta(coder, coderTurn, git);
      for (const reviewer of reviewers) {
        const deferral = due[reviewer.id];
        if (deferredOnly && !deferral) continue;
        // Whatever this pass decides for a deferred reviewer settles its deferral: it is created at most once.
        if (deferral) resolved.add(reviewer.id);
        // A superseded reviewer's blocker and major findings went to the reviewer that replaced it.
        if ((reviewer.data as SeatData).supersededBy) {
          if (deferral) notes.push(`deferred new reviewer for ${reviewer.id} dropped: already superseded by ${String(reviewer.data.supersededBy)}`);
          continue;
        }
        if (reviewer.status === 'closed' || reviewer.status === 'failed' || self.closing.has(reviewer.id)) {
          notes.push(`reviewer ${reviewer.id} is ${reviewer.status === 'closed' || reviewer.status === 'failed' ? reviewer.status : 'closing'}; recheck skipped`);
          continue;
        }
        const latest = self.store.listTurns(reviewer.id).filter((turn) => turn.status === 'done' && turn.text !== null).at(-1);
        if (!latest) {
          notes.push(`reviewer ${reviewer.id} has no latest settled report; recheck skipped`);
          continue;
        }
        const parsed = parseReport(latest.text, 'reviewer');
        if (!parsed.ok) {
          notes.push(`reviewer ${reviewer.id} has no valid settled report; recheck skipped`);
          continue;
        }
        const blockers = parsed.report.verdict === 'REQUEST_CHANGES' ? (parsed.report.findings as Finding[]).filter((finding) => (finding.severity === 'blocker' || finding.severity === 'major') && finding.reproduced) : [];
        if (!blockers.length) {
          if (deferral) notes.push(`deferred new reviewer for ${reviewer.id} dropped: its latest settled report has no reproduced blocker or major findings`);
          continue;
        }
        if (syncFailure) {
          const route = await self.recheckRoute(coder, coderTurn, latest, blockers, git);
          decisions.push({ reviewer: reviewer.id, kind: route.kind, reason: route.reason, model: route.model ?? null });
          // Kept on the coder: the next turn whose sync mirrors the host creates it (the earliest deferral stands).
          deferred[reviewer.id] = pending[reviewer.id] ?? { coderTurn, reason: route.reason, at: new Date().toISOString() };
          notes.push(`reviewer ${reviewer.id} needs a new full reviewer (${route.reason}); deferred until the host can be mirrored, never review a stale checkout`);
          continue;
        }
        if (files === null && fileError === null) {
          try {
            // --no-renames keeps numstat's -z rows uniform: added<TAB>deleted<TAB>path<NUL>.
            const [numstat, untracked] = await Promise.all([
              git('diff', '--numstat', '-z', '--no-renames', String(coder.data.base)),
              git('ls-files', '--others', '--exclude-standard', '-z'),
            ]);
            const sizes = new Map<string, number>();
            for (const { path: file, added, deleted, binary } of parseNumstat(numstat, 'git diff --numstat returned an invalid row')) {
              // Text: changed lines; binary: actual bytes (including a deleted binary in base).
              let size: number;
              if (!binary) size = added + deleted;
              else {
                try { size = (await stat(path.join(coder.worktree!, file))).size; }
                catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                  size = Number((await git('cat-file', '-s', `${coder.data.base}:${file}`)).trim());
                }
              }
              if (!Number.isSafeInteger(size) || size < 0) throw new Error(`git change size invalid for ${file}`);
              sizes.set(file, size);
            }
            await Promise.all(untracked.split('\0').filter(Boolean).map(async (file) => {
              sizes.set(file, (await stat(path.join(coder.worktree!, file))).size);
            }));
            const ranked = [...sizes].sort(([a, sizeA], [b, sizeB]) => sizeB - sizeA || a.localeCompare(b)).map(([file]) => file);
            files = ranked.slice(0, 12);
            omitted = ranked.slice(12);
          } catch (error) {
            fileError = (error as Error).message;
            self.options.log('error', 'seat.recheck_files_failed', { seat: coder.id, turn: coderTurn, message: fileError });
          }
        }
        if (fileError !== null) {
          notes.push(`reviewer ${reviewer.id} recheck not queued: coder changed files unavailable: ${fileError}`);
          continue;
        }
        const extra = omitted.length ? `\n${omitted.length} further changed files were not passed for lessons: ${omitted.slice(0, 20).join(', ')}${omitted.length > 20 ? ` (+${omitted.length - 20} more in the diff)` : ''}. Review the entire diff.` : '';
        const listed = blockers.map((finding, i) => `${i + 1}. Claim: ${finding.claim}\nEvidence: ${finding.evidence}`).join('\n');
        const inspect = `git -C ${JSON.stringify(coder.worktree)} diff ${coder.data.base} (committed, staged and unstaged); list untracked with git -C ${JSON.stringify(coder.worktree)} ls-files --others --exclude-standard and read those files separately.${extra} Do not change the coder's checkout.`;
        const route: { kind: 'same' | 'new'; reason: string; model?: string | null } = deferral
          ? { kind: 'new', reason: `deferred from coder turn ${deferral.coderTurn} (${deferral.reason}); the host is mirrored again`, model: 'rule' }
          : await self.recheckRoute(coder, coderTurn, latest, blockers, git);
        const model = route.model ?? null;
        decisions.push({ reviewer: reviewer.id, kind: route.kind, reason: route.reason, model });
        const same = async () => {
          // The reviewer's checkout moves to the coder's tree at this correction's end, as a new reviewer's would sit (task 1605).
          if (snapshot === null && snapshotError === null) {
            try { snapshot = await snapshotCommit(coder.worktree!); } catch (error) { snapshotError = (error as Error).message; }
          }
          // A host checkout has no coder worktree to read beside it: without a snapshot the recheck would review a stale tree.
          if (reviewer.data.host && snapshot === null) {
            notes.push(`reviewer ${reviewer.id} recheck not queued: remote checkout cannot move without a coder snapshot: ${snapshotError}`);
            return;
          }
          const own = snapshot !== null
            ? ` Your own checkout is moved to ${snapshot}, a snapshot of the coder's worktree at this correction's end: git diff HEAD^ there is the coder's uncommitted change.`
            : '';
          if (snapshotError !== null) notes.push(`reviewer ${reviewer.id} checkout not moved to the correction: coder snapshot failed: ${snapshotError}`);
          const brief = `Recheck ONLY your reproduced blocker and major findings from your latest settled report after coder correction ${coderTurn}:\n${listed}\nInspect the coder's full change read-only: ${inspect}${own} Return APPROVE or REQUEST_CHANGES with reproduction for these blocker and major findings only.`;
          try {
            const turn = self.prompt(reviewer.id, brief, undefined, { files: files!, longBrief: 'Reproduced blocker and major findings and evidence must be transmitted in full.' });
            if (snapshot !== null) {
              self.recheckCheckouts.set(turn.id, snapshot);
              self.store.patchPending(turn.id, { checkout: snapshot });
            }
            rechecks.push({ reviewer: reviewer.id, turn: turn.id, kind: 'same', model });
          } catch (error) {
            notes.push(`reviewer ${reviewer.id} recheck not queued: ${(error as Error).message}`);
          }
        };
        if (route.kind === 'same') { await same(); continue; }
        // A new reviewer of another family takes the whole accumulated diff; the old one is closed.
        // Its brief starts from the ORIGINAL review brief, never an earlier replacement's wrapper.
        const first = typeof reviewer.data.firstBrief === 'string' ? reviewer.data.firstBrief : self.store.listTurns(reviewer.id)[0]?.prompt ?? '';
        let next: Seat;
        // The replacement steps aside from the lead family stored on the coder seat (decision
        // #17805 D2), never from every active lead: another task's lead may review this one.
        const coderLead = typeof coder.data.leadFamily === 'string' ? coder.data.leadFamily as Family : null;
        try {
          // A snapshot of the coder's worktree, as a lead creates one: its uncommitted change is `git diff HEAD^` there (task 1605).
          next = await self.create({ role: 'reviewer', author: coder.id, coauthors: reviewer.data.coauthors as string[] | undefined, title: reviewer.title, repo: coder.worktree!, snapshot: true, ...self.replacementPlacement(reviewer), ...(reviewer.data.images === true ? { images: true } : {}) }, { ...(await self.chooser?.() ?? {}), ...(coderLead ? { leadFamilies: [coderLead], leadFamily: coderLead } : {}), leadAsideNote: undefined, replaces: reviewer.id });
        } catch (error) {
          // Reproduced blocker and major findings are never left unrechecked: without a replacement, their reviewer rechecks them.
          notes.push(`reviewer ${reviewer.id} needs a new reviewer (${route.reason}), not created: ${(error as Error).message}; its blocker and major findings go back to it`);
          await same();
          continue;
        }
        self.store.updateSeat(next.id, { data: { firstBrief: first, replaces: reviewer.id } }, 'seat.replaces', { seat: reviewer.id });
        self.store.updateSeat(reviewer.id, { data: { supersededBy: next.id } }, 'seat.superseded', { by: next.id, coderTurn, reason: route.reason });
        void self.close(reviewer.id).catch((error: Error) => self.options.log('warn', 'seat.superseded_close_failed', { seat: reviewer.id, message: error.message }));
        const brief = `${first}\n\nOrch hands this review to you (decision #11871): reviewer ${reviewer.id} reported these reproduced blocker and major findings, and coder ${coder.id} corrected them in turn ${coderTurn} with a change that is not confined to them (${route.reason}):\n${listed}\nConfirm each blocker and major finding is fixed, and review the WHOLE accumulated change, not only the correction: ${inspect} Return APPROVE or REQUEST_CHANGES.`;
        try {
          const turn = self.prompt(next.id, brief, undefined, { files: files!, longBrief: 'The original review brief and the reproduced blocker and major findings and evidence must be transmitted in full.' });
          rechecks.push({ reviewer: next.id, turn: turn.id, kind: 'new', replaces: reviewer.id, model });
          notes.push(`reviewer ${reviewer.id} superseded by new reviewer ${next.id}: ${route.reason}; ${reviewer.id} is closed and its queued recheck turns are cancelled`);
        } catch (error) {
          notes.push(`new reviewer ${next.id} for ${reviewer.id} not prompted: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      notes.push(`automatic rechecks failed: ${(error as Error).message}`);
      throw error;
    } finally {
      // Persist already queued IDs and the failure note before the coder waiter wakes.
      const current = self.store.getSeat(coder.id)!.data;
      const kept = Object.fromEntries(Object.entries({ ...(current.deferredReplacements as Record<string, DeferredReplacement> | undefined), ...deferred }).filter(([id]) => !resolved.has(id)));
      // changedPaths stays absent when the delta was unavailable: an empty list always means an empty delta.
      const entry = { rechecks, decisions, notes, ...(delta ? { changedPaths: delta.paths, ...(delta.truncated ? { changedPathsTruncated: true } : {}) } : {}) };
      self.store.updateSeat(coder.id, { data: { recheckResults: { ...(current.recheckResults as Record<string, unknown> ?? {}), [coderTurn]: entry }, deferredReplacements: kept } }, 'seat.rechecks', { coderTurn, rechecks, notes });
    }
  }

export async function continueOrFresh(self: SeatManager, seatId: string, session: ProviderSession): Promise<NonNullable<TurnWatchRecord['session']>> {
    const seat = self.store.getSeat(seatId)!;
    if (!(seat.data as SeatData).contextDelivered) return { mode: 'first', reason: null, context: null };
    const context: ContextUsage | null = session.contextUsage ? await session.contextUsage().catch(() => null) : null;
    if (context && context.tokens / context.window >= FRESH_CONTEXT) {
      return { mode: 'fresh', reason: `context ${Math.round((100 * context.tokens) / context.window)}% of ${context.window} tokens (fresh from ${Math.round(100 * FRESH_CONTEXT)}%)`, context };
    }
    return { mode: 'continued', reason: null, context };
  }

export function earlierReports(self: SeatManager, seatId: string, turnId: string, role: SeatRole): Record<string, unknown>[] {
    const seat = self.store.getSeat(seatId);
    const table = seat ? tableContractOf(seat) : undefined;
    const reports: Record<string, unknown>[] = [];
    for (const turn of self.store.listTurns(seatId)) {
      if (turn.id === turnId || turn.status !== 'done' || turn.text === null) continue;
      const parsed = parseReport(turn.text, role, [], { stored: true, table });
      if (parsed.ok) reports.push(parsed.report);
    }
    const kept = reports.slice(-EARLIER_REPORTS);
    while (kept.length > 1 && JSON.stringify(kept).length > EARLIER_CHARS) kept.shift();
    return kept;
  }

export function siblings(self: SeatManager, seat: Seat): Sibling[] {
    const repo = reviewRepo(seat);
    const found: { seat: string; ended: string; findings: Finding[] }[] = [];
    for (const other of reviewRoles().flatMap((reviewRole) => self.store.listSeats({ role: reviewRole, title: seat.title }))) {
      if (other.id === seat.id || reviewRepo(other) !== repo) continue;
      // A queued follow-up has not answered yet: use the last settled report. A running
      // follow-up is already replacing that answer and is not compared until it settles.
      const turns = self.store.listTurns(other.id);
      const last = turns.filter((turn) => turn.status !== 'queued').at(-1);
      if (!last || last.status !== 'done' || last.text === null || !last.ended_at) continue;
      const parsed = parseReport(last.text, 'reviewer');
      if (!parsed.ok) continue;
      const findings = parsed.report.findings as Finding[];
      // A report Jev graded as not finished (an empty seat's placeholder) is no second opinion: on
      // 2026-09-22 a real review was compared with the 6-second, zero-tool report of the seat it
      // replaced (task 1434). An ungraded or malformed grade stays: it says nothing about the report.
      const grade = validGrade(self.store.getGrade(last.id), findings.length);
      if (grade.status === 'graded' && grade.realReport < FINISHED_P) continue;
      found.push({ seat: other.id, ended: last.ended_at, findings });
    }
    return found.sort((a, b) => b.ended.localeCompare(a.ended)).slice(0, MAX_SIBLINGS).map(({ seat: id, findings }) => ({ seat: id, findings }));
  }
