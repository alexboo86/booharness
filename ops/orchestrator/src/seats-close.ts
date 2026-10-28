import type { SeatManager } from './seats.ts';
import type { Seat } from './store.ts';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inside, processCwdFields } from './sweep-shared.ts';
import { branchTip, checkoutInUse, coderRepo, clearCaches, DAY_MS, dropIdleSeatTargets, idleCloseCandidate, inspectIdleCoder, LeadRepoMissingError, ownedWorktree, pruneAgedMirror, pruneLanded, type PruneDecision } from './prune.ts';
import { noteCodegraphDaemonStop, removeWorktree } from './worktrees.ts';
import { hasWorktree, ROLE_POLICY, landable } from './seats-defs.ts';
import type { SeatRole, DeferredReplacement, SeatData } from './seats-defs.ts';

export async function close(self: SeatManager, seatId: string): Promise<Seat> {
    const seat = self.store.getSeat(seatId);
    if (!seat) throw new Error(`no seat '${seatId}'`);
    if (seat.data.closePending === true && self.closing.has(seatId)) return seat;
    if (seat.status === 'closed' && (!self.remoteRemovalPending(seat) || self.remoteClosing.has(seatId))) return seat;
    // Keep provisioning visible to drain/land guards until setup has finished.
    // The row owns the intent so startup can replay a lost callback.
    const held = seat.status === 'provisioning' && seat.data.provisionHeld === true;
    const pending = seat.status === 'provisioning' && !held;
    if (pending) self.store.updateSeat(seatId, { data: { closePending: true } }, 'seat.close_pending');
    const chainBusy = self.busyChains.has(seatId), live = self.live.has(seatId);
    if (chainBusy || live) {
      const waiting = { seat: seatId, chainBusy, live };
      self.store.appendEvent('seat.close_waiting', waiting, seatId);
      self.options.log('info', 'seat.close_waiting', waiting);
    }
    // Wake queued waiters now, even if the running provider ignores cancellation or
    // provisioning has not completed. The chain later skips these ended turns.
    self.closing.add(seatId);
    for (const turn of self.store.listTurns(seatId)) {
      if (turn.status !== 'queued') continue;
      self.drainHeld.delete(turn.id);
      self.briefFiles.delete(turn.id);
      self.recheckCheckouts.delete(turn.id);
      self.end(turn.id, { status: 'cancelled', text: null, error: 'seat was closed before this turn started', stop_reason: null, usage: null, tools: 0, duration_ms: 0 });
    }
    // Held provisioning has made no resources and has no setup callback to await.
    if (held) {
      try { return await self.closeNow(seatId); }
      finally { self.closing.delete(seatId); }
    }
    // Close itself still waits behind the running turn and provisioning, so no
    // checkout is torn down under a live step.
    if (!pending) await self.live.get(seatId)?.cancel().catch(() => undefined);
    let closed!: Seat;
    self.chain(seatId, async () => {
      try {
        closed = await self.closeNow(seatId);
        self.scheduleClosedCleanup(closed);
      } catch (error) {
        self.options.log('error', 'seat.close_failed', { seat: seatId, message: (error as Error).message });
        throw error;
      } finally {
        self.closing.delete(seatId);
      }
    });
    if (pending) return self.store.getSeat(seatId)!;
    await self.chains.get(seatId);
    return closed ?? self.store.getSeat(seatId)!;
  }

export function scheduleClosedCleanup(self: SeatManager, closed: Seat | undefined): void {
    if (!closed || closed.status !== 'closed') return;
    const seatId = closed.id;
    // The local closed state is durable before any host I/O. The same seat chain keeps
    // snapshot -> mirror -> host removal ordered, and recovery retries an interrupted step.
    if (self.remoteRemovalPending(closed) && !self.remoteClosing.has(seatId)) {
      self.remoteClosing.add(seatId);
      self.chain(seatId, async () => {
        try { await self.finishRemoteClose(seatId); }
        finally { self.remoteClosing.delete(seatId); }
      });
    }
    // Queued behind remote cleanup, not awaited (task 1521).
    self.chain(seatId, () => self.clearSeatCaches(seatId));
  }

export async function finishRemoteClose(self: SeatManager, seatId: string): Promise<void> {
    const seat = self.store.getSeat(seatId)!;
    if (!self.remoteRemovalPending(seat)) return;
    // A non-coder checkout is disposable (removed unconditionally at close); a coder's
    // removal is authorized by finishRemoteCoder only once its snapshot is recorded.
    const removal = landable(seat.role) ? await self.finishRemoteCoder(seat) : await self.removeRemoteSeat(seat, true);
    const failure = seat.data.failure;
    const stop = landable(seat.role) ? await self.remoteCleanupStop(seat, removal) : {};
    self.store.updateSeat(seatId, { data: { ...removal, ...stop, remoteCleanupPending: false,
      ...(removal.remoteRemoveError ? { failure: `remote checkout removal failed: ${removal.remoteRemoveError}` }
        : typeof failure === 'string' && failure.startsWith('remote checkout removal failed:') ? { failure: null } : {}) } }, 'seat.remote_checkout_removal');
    if (removal.remoteRemoveError) self.options.log('warn', 'seat.remote_checkout_remove_failed', { seat: seatId, message: removal.remoteRemoveError });
  }

export async function clearSeatCaches(self: SeatManager, seatId: string): Promise<void> {
    const worktree = ownedWorktree(self.options.stateDir, self.store.getSeat(seatId)!);
    if (!worktree) return;
    try {
      const cleanup = await clearCaches(worktree);
      if (cleanup.codegraphDaemon) noteCodegraphDaemonStop(cleanup.codegraphDaemon, seatId, worktree, self.store, self.options.log);
      const { bytes, removed, skipped } = cleanup;
      if (removed.length || skipped.length) self.options.log('info', 'seat.caches_cleared', { seat: seatId, bytes, removed: removed.map((entry) => entry.path), skipped });
    } catch (error) {
      self.options.log('warn', 'seat.caches_clear_failed', { seat: seatId, message: (error as Error).message });
    }
  }

function cwdPids(fields: string, root: string): number[] {
  const pids = new Set<number>();
  let pid = 0;
  for (const field of fields.split('\n')) {
    if (/^p\d+$/.test(field)) pid = Number(field.slice(1));
    if (field.startsWith('n') && pid > 0 && pid !== process.pid &&
        path.isAbsolute(field.slice(1)) && inside(root, field.slice(1))) pids.add(pid);
  }
  return [...pids];
}

function signalPid(pid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(pid, signal); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function stopWorktreeProcesses(self: SeatManager, seat: Seat): Promise<void> {
  if (typeof seat.data.host === 'string' || seat.data.provisionHeld === true) return;
  try {
    const worktree = ownedWorktree(self.options.stateDir, seat);
    if (!worktree) return;
    const root = await realpath(worktree);
    const pids = cwdPids(await processCwdFields({ skipUnreadable: true }), root);
    const errors: string[] = [];
    const signal = (pid: number, kind: NodeJS.Signals | 0): boolean => {
      try { return signalPid(pid, kind); }
      catch (error) { errors.push((error as Error).message); return false; }
    };
    const sent = pids.filter((pid) => signal(pid, 'SIGTERM'));
    if (sent.length) await delay(500);
    const killed = sent.filter((pid) => signal(pid, 0) && signal(pid, 'SIGKILL'));
    if (pids.length) self.store.appendEvent('seat.worktree_processes_stopped', { pids, killed, errors }, seat.id);
    if (errors.length) self.options.log('warn', 'seat.worktree_process_stop_failed', { seat: seat.id, errors });
  } catch (error) {
    self.options.log('warn', 'seat.worktree_process_stop_failed', { seat: seat.id, message: (error as Error).message });
  }
}

export async function closeNow(self: SeatManager, seatId: string, keepOnError = false): Promise<Seat> {
    self.store.appendEvent('seat.close_now_start', { seat: seatId }, seatId);
    self.options.log('info', 'seat.close_now_start', { seat: seatId });
    await self.drop(seatId);
    const seat = self.store.getSeat(seatId)!;
    const data = seat.data as SeatData;
    if (seat.status === 'closed' && !self.remoteRemovalPending(seat)) return seat;
    if (keepOnError && (idleCloseCandidate(seat, self.store.listTurns(seatId)) === null || checkoutInUse(self.store, seat) ||
        Object.keys((data.deferredReplacements as Record<string, unknown> | undefined) ?? {}).length)) return seat;
    const held = seat.data.provisionHeld === true;
    const patch: Record<string, unknown> = { ...(data.closePending === true ? { closePending: false } : {}),
      ...(held ? { provisionHeld: false, worktreeRemoved: true } : {}) };
    await stopWorktreeProcesses(self, seat);
    // One instant for closedAt and remoteCleanupSince, so a coder's two dates never differ.
    const closedAt = new Date().toISOString();
    // A verified host checkout is cleaned up after local closure; unowned paths are never touched.
    // remoteCleanupSince dates the pending note for every role: only a coder records closedAt (task 3287).
    if (self.remoteRemovalPending(seat)) Object.assign(patch, { remoteCleanupPending: true, remoteCleanupSince: closedAt });
    // A reviewer's checkout is disposable; a coder's branch and worktree stay for the lead to land.
    if (!held && seat.worktree && !data.worktreeRemoved && ROLE_POLICY[seat.role as SeatRole].worktree === 'detached') {
      try {
        const daemons = await removeWorktree(data.repo, seat.worktree);
        noteCodegraphDaemonStop(daemons, seatId, seat.worktree, self.store, self.options.log);
        patch.worktreeRemoved = true;
      } catch (error) {
        if (keepOnError) throw error;
        self.options.log('warn', 'seat.worktree_remove_failed', { seat: seatId, message: (error as Error).message });
      }
    }
    if (landable(seat.role)) {
      patch.closedAt = closedAt;
      if (keepOnError) patch.autoClosedIdle = true;
      const deferred = Object.keys((data.deferredReplacements as Record<string, DeferredReplacement> | undefined) ?? {});
      if (deferred.length) {
        patch.deferredReplacements = {};
        self.options.log('warn', 'seat.deferred_replacements_dropped', { seat: seatId, reviewers: deferred, reason: 'coder closed before a turn sync succeeded' });
      }
      // The daemon sweep removes a landed checkout only while its branch still sits here (task 1522).
      if (!held && typeof data.branch === 'string') {
        try { patch.closedBranchTip = await branchTip((await coderRepo(seat)).repo, data.branch); } catch (error) {
          if (keepOnError) throw error;
          self.options.log('warn', 'seat.branch_tip_failed', { seat: seatId, message: (error as Error).message });
        }
      }
    }
    if (keepOnError && (checkoutInUse(self.store, seat) ||
        Object.keys((self.store.getSeat(seatId)?.data.deferredReplacements as Record<string, unknown> | undefined) ?? {}).length)) return seat;
    const closed = self.store.updateSeat(seatId, { status: 'closed', data: patch }, 'seat.closed');
    // The seat is closed: its retained live logs (task 2883) go with it.
    self.turnLogsForget(seatId);
    // A table member's close may be the last event that ends the table (operator #19423, plan item 7):
    // a member closed before round 2 counts as not voting, so its close must still release the post.
    if (closed.role === 'debater') {
      try { self.maybePostTable(closed); } catch (error) { self.options.log('warn', 'seat.table_post_failed', { seat: seatId, message: (error as Error).message }); }
    }
    return closed;
  }


/** Closed-candidate scan page: small enough that no page is a measurable event-loop
 *  stretch; the sweep pauses between pages instead of parsing the whole closed
 *  history in one synchronous read (task 2616). */
const PRUNE_CANDIDATE_PAGE = 500;

/** One macrotask per candidate: cheap kept verdicts resolve through microtasks only,
 *  so without this a run of them fuses into a single event-loop-blocking stretch
 *  (task 2616: 900 memoized keeps with an fsync apiece measured 2 s as one span). */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function pruneLandedSeats(self: SeatManager): Promise<PruneDecision[]> {
    const results: PruneDecision[] = [];
    // Task 2861: an idle open seat keeps its checkout but loses its regenerable cargo
    // targets long before idle close; source, node_modules and .codegraph stay.
    for (const drop of await dropIdleSeatTargets(self.store)) {
      if (drop.error) self.options.log('warn', 'seat.targets_drop_failed', { seat: drop.seat, message: drop.error });
      else if (drop.removed.length) {
        self.options.log('info', 'seat.targets_dropped', { seat: drop.seat, removed: drop.removed, bytesBefore: drop.bytesBefore });
      }
    }
    // Only closed seats the sweep still owes work, in the order listSeats('closed')
    // produced them; the per-seat guards below still decide.
    const previouslyClosed: Seat[] = [];
    let cursor: { created_at: string; id: string } | null = null;
    for (;;) {
      const page = self.store.pruneCandidatesPage(cursor, PRUNE_CANDIDATE_PAGE);
      previouslyClosed.push(...page.seats);
      cursor = page.next;
      if (cursor === null) break;
      await yieldToLoop();
    }
    for (const seat of [...self.store.listSeats('ready'), ...self.store.listSeats('failed')]) {
      const candidate = idleCloseCandidate(seat, self.store.listTurns(seat.id));
      if (!candidate || (candidate.kind === 'idle' && !hasWorktree(seat.role))) continue;
      self.chain(seat.id, async () => {
        try {
          const current = self.store.getSeat(seat.id);
          const currentCandidate = current ? idleCloseCandidate(current, self.store.listTurns(seat.id)) : null;
          if (!current || !currentCandidate || self.closing.has(seat.id) || self.scopePending.has(seat.id)) return;
          if (checkoutInUse(self.store, current)) return;
          let unlanded = false;
          if (landable(current.role)) {
            if (Object.keys((current.data.deferredReplacements as Record<string, unknown> | undefined) ?? {}).length) return;
            if (currentCandidate.kind === 'idle' && currentCandidate.days >= 2) unlanded = true;
            else if (currentCandidate.kind !== 'failed') {
              const proof = await inspectIdleCoder(self.options.stateDir, current);
              if (!proof.remove) {
                results.push(proof);
                return;
              }
            }
          }
          // The proof awaited Git. Recheck after it, on this chain, then fence
          // synchronous prompt() before closeNow's first await. Never call
          // close() here: it cancels queued turns and would await its own chain.
          const latest = self.store.getSeat(seat.id);
          const latestCandidate = latest ? idleCloseCandidate(latest, self.store.listTurns(seat.id)) : null;
          if (!latest || !latestCandidate || self.closing.has(seat.id) || self.scopePending.has(seat.id) ||
              checkoutInUse(self.store, latest) ||
              (latest.role === 'coder' && Object.keys((latest.data.deferredReplacements as Record<string, unknown> | undefined) ?? {}).length)) return;
          self.closing.add(seat.id);
          try {
            const closed = await self.closeNow(seat.id, true);
            if (closed.status !== 'closed') return;
            self.scheduleClosedCleanup(closed);
            self.options.log('info', 'seat.auto_closed_idle', { seat: seat.id, idleDays: latestCandidate.days, kind: latestCandidate.kind, ...(unlanded ? { unlanded: true } : {}) });
          } finally { self.closing.delete(seat.id); }
        } catch (error) {
          if (error instanceof LeadRepoMissingError) {
            if (!self.autoCloseMissingRepoLogged.has(seat.id)) {
              self.autoCloseMissingRepoLogged.add(seat.id);
              self.options.log('info', 'seat.auto_close_skipped', { seat: seat.id, reason: 'lead repo missing' });
            }
            return;
          }
          self.options.log('warn', 'seat.auto_close_failed', { seat: seat.id, message: (error as Error).message });
        }
      });
      await self.chains.get(seat.id);
      await yieldToLoop();
    }
    for (const seat of previouslyClosed) {
      if (!landable(seat.role) || seat.data.worktreeRemoved) continue;
      self.chain(seat.id, async () => {
        try {
          const current = self.store.getSeat(seat.id);
          if (!current || current.status !== 'closed' || current.data.worktreeRemoved ||
              checkoutInUse(self.store, current)) return;
          if (current.data.autoClosedIdle === true) {
            const age = Date.now() - Date.parse(String(current.data.closedAt));
            if (!Number.isFinite(age) || age < DAY_MS) return;
          }
          const before = (current.data.autoPruneKept as { reason?: string } | undefined)?.reason;
          const decision = typeof current.data.host === 'string'
            ? await pruneAgedMirror(self.store, self.options.stateDir, seat.id)
            : await pruneLanded(self.store, self.options.stateDir, seat.id);
          results.push(decision);
          if (decision.remove) self.options.log('info', 'seat.auto_pruned', { seat: seat.id, reason: decision.reason, lost: decision.lost });
          else if (decision.reason !== before) self.options.log('info', 'seat.auto_prune_kept', { seat: seat.id, reason: decision.reason });
        } catch (error) {
          self.options.log('warn', 'seat.auto_prune_failed', { seat: seat.id, message: (error as Error).message });
        }
      });
      await self.chains.get(seat.id);
      await yieldToLoop();
    }
    return results;
  }

/** Unused rebuttal window after a debater's first answer (task 2156 D3). Not the idle sweep. */
export const REBUTTAL_IDLE_MS = 60 * 60 * 1000;

/** One-shot close. unref so it does not keep the process alive; a restart drops it. `delayMs` lets recovery re-arm only the remaining window. */
export function armRebuttalClose(self: SeatManager, seatId: string, delayMs = REBUTTAL_IDLE_MS): void {
  const timer = setTimeout(() => rebuttalWindowEnded(self, seatId), delayMs);
  timer.unref();
}

async function rebuttalWindowEnded(self: SeatManager, seatId: string): Promise<void> {
  try {
    const seat = self.store.getSeat(seatId);
    if (!seat || seat.status === 'closed' || seat.status === 'failed' || self.closing.has(seatId)) return;
    const turns = self.store.listTurns(seatId);
    // A second turn, queued or running, means the lead used the chance. Any later turn does too.
    if (turns.length >= 2 || turns.some((turn) => turn.status === 'queued' || turn.status === 'running')) return;
    await self.close(seatId);
  } catch (error) {
    self.options.log('warn', 'seat.rebuttal_close_failed', { seat: seatId, message: (error as Error).message });
  }
}

export async function shutdown(self: SeatManager): Promise<void> {
    await Promise.all([...self.live.keys()].map((id) => self.drop(id)));
  }

export { pruneLandedSeats as pruneLanded };
