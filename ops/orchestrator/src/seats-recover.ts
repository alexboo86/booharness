import { existsSync, readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { SeatManager } from './seats.ts';
import { readHost, readHosts } from './config.ts';
import { dirExistsOnHost, dropGoneRegistration, HostTimeout, removeCheckout, type DirProbe } from './remote-repo.ts';
import { listRemoteCheckouts, removeOrphanMirror } from './remote-worktree.ts';
import { ROLE_POLICY, landable, remoteCheckoutGone } from './seats-defs.ts';
import type { SeatRole, SeatData } from './seats-defs.ts';
import { armRebuttalClose, REBUTTAL_IDLE_MS } from './seats-close.ts';

export async function recover(self: SeatManager): Promise<void> {
    const rows = self.store.listSeats();
    // Only names orch creates, immediately beneath its own roots. An absent row
    // cannot be handled by the per-seat recovery loop below.
    const seatName = new RegExp(`^(?:${Object.keys(ROLE_POLICY).join('|')})-[a-z]+-[0-9a-f]{6}$`);
    const bounded = async (work: Promise<void>): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('orphan removal timed out')), 5000);
      })]); } finally { clearTimeout(timer); }
    };
    for (const [host, config] of Object.entries(readHosts(self.options.stateDir))) {
      try {
        const remotePath = config.platform === 'win32' ? path.win32 : path.posix;
        const root = remotePath.join(remotePath.dirname(config.repo), 'worktrees');
        const dirs = await (self.options.listRemoteCheckouts ?? listRemoteCheckouts)(host, config.repo);
        for (const dir of dirs) {
          const id = remotePath.basename(dir);
          if (!seatName.test(id) || remotePath.normalize(dir) !== remotePath.join(root, id) || rows.some(row => row.id === id)) continue;
          try { await bounded((self.options.removeRemoteCheckout ?? removeCheckout)(host, remotePath.join(root, id))); }
          catch (error) { self.options.log('warn', 'seat.orphan_checkout_remove_failed', { host, seat: id, message: (error as Error).message }); }
        }
      } catch (error) { self.options.log('warn', 'seat.orphan_checkout_list_failed', { host, message: (error as Error).message }); }
    }
    const mirrors = path.join(self.options.stateDir, 'mirrors');
    if (existsSync(mirrors)) {
      for (const entry of readdirSync(mirrors, { withFileTypes: true })) {
        if (!entry.isDirectory() || !seatName.test(entry.name) || !landable(entry.name.split('-')[0] ?? '') || rows.some(row => row.id === entry.name)) continue;
        try { await bounded((self.options.removeOrphanMirror ?? removeOrphanMirror)(path.join(mirrors, entry.name), self.options.stateDir)); }
        catch (error) { self.options.log('warn', 'seat.orphan_mirror_remove_failed', { seat: entry.name, message: (error as Error).message }); }
      }
    }
    // A host whose gone probe answered unknown or whose drop timed out is not asked again this pass.
    const unreachable = new Set<string>();
    for (const seat of rows) {
      const data = seat.data as SeatData;
      // A detached close may have removed its checkout before committing seat.closed.
      // Absence alone is not intent or proof of Git deregistration: replay closeNow.
      if (seat.status === 'ready' && ROLE_POLICY[seat.role as SeatRole]?.worktree === 'detached' &&
          !data.host && seat.worktree && data.worktreeRemoved !== true) {
        const latestClose = self.store.db.prepare(`SELECT kind FROM events
          WHERE seat_id = ? AND kind IN ('seat.close_now_start', 'seat.closed')
          ORDER BY seq DESC LIMIT 1`).get(seat.id) as { kind: string } | undefined;
        if (latestClose?.kind === 'seat.close_now_start') {
          let absent = false;
          try { await stat(seat.worktree); }
          catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ENOENT'; }
          if (absent) {
            await self.closeNow(seat.id);
            self.options.log('info', 'seat.close_recovered', { seat: seat.id });
            continue;
          }
        }
      }
      // A turn a drain restart kept queued has not run yet and will run in this seat's
      // checkout, so a seat holding one is neither cleaned up nor closed below, whatever
      // turns it finished before the restart.
      const turns = self.store.listTurns(seat.id);
      const settled = turns.length > 0 && turns.every((turn) => turn.status !== 'queued');
      let rebuttalRemaining = 0;
      if (seat.role === 'debater' && turns.length === 1) {
        const endedAt = turns[0].ended_at ? Date.parse(turns[0].ended_at) : NaN;
        rebuttalRemaining = Number.isFinite(endedAt) ? REBUTTAL_IDLE_MS - (Date.now() - endedAt) : REBUTTAL_IDLE_MS;
      }
      // Reusable remote seats keep their checkout, as does a debater still owed its rebuttal.
      const closesInRecovery = seat.status === 'ready' && settled &&
        ROLE_POLICY[seat.role as SeatRole]?.sealed && rebuttalRemaining <= 0;
      // An interrupted background close is replayed before recovery finishes. A
      // drain-kept queued turn still owns its checkout, even if the row was closed.
      if (self.remoteRemovalPending(seat) && !turns.some((turn) => turn.status === 'queued') &&
          (seat.status === 'failed' || seat.status === 'closed' || closesInRecovery)) {
        await self.finishRemoteClose(seat.id);
      }
      // A stopped removal certified nothing (task 1952). An absent directory drops
      // only this seat's registration and records the observation. present and
      // unknown change nothing; remoteRemoved and remoteRemoveError stay.
      const current = self.store.getSeat(seat.id) ?? seat;
      const currentData = current.data;
      if (current.status === 'closed' && landable(current.role) && currentData.remoteCleanupStopped &&
          currentData.remoteRemoved !== true && !remoteCheckoutGone(currentData)) {
        const host = currentData.host;
        const remoteDir = currentData.remoteDir;
        if (typeof host === 'string' && typeof remoteDir === 'string' && !unreachable.has(host)) {
          let probe: DirProbe = 'unknown';
          try {
            const config = readHost(host, self.options.stateDir);
            probe = await (self.options.probeRemoteDir ?? dirExistsOnHost)(host, remoteDir, config.platform, config.repo);
          } catch { probe = 'unknown'; }
          if (probe === 'unknown') unreachable.add(host);
          if (probe === 'absent') {
            try {
              await (self.options.dropGoneRegistration ?? dropGoneRegistration)(host, remoteDir);
              self.store.updateSeat(current.id, { data: { remoteCheckoutGone: { at: new Date().toISOString() } } }, 'seat.remote_checkout_gone');
            } catch (error) {
              if (error instanceof HostTimeout) unreachable.add(host);
              self.options.log('warn', 'seat.remote_checkout_gone_failed', { seat: current.id, host, message: (error as Error).message });
            }
          }
        }
      }
      if (seat.status === 'failed' && seat.worktree && !data.host && !data.worktreeRemoved && !self.store.listTurns(seat.id).some((turn) => turn.started_at)) {
        await self.discardCheckout(seat.id);
      }
      // Explicit closure wins over drain-kept queued work. interruptOrphans has
      // already stopped provisioning; close cancels its queued turns as usual.
      if (data.closePending === true) {
        await self.close(seat.id);
        continue;
      }
      if (seat.status === 'ready' && ROLE_POLICY[seat.role as SeatRole]?.sealed && settled) {
        // A debater with one settled turn still owes its rebuttal (operator #19423, plan item 6): keep
        // it and re-arm the close for what is left of the 60-minute window from that turn's end, closing
        // at once when the window already passed. Two settled turns close as before.
        if (seat.role === 'debater' && turns.length === 1) {
          if (rebuttalRemaining <= 0) {
            self.store.updateSeat(seat.id, { status: 'closed' }, 'seat.closed');
            try { self.maybePostTable(self.store.getSeat(seat.id)!); } catch (error) { self.options.log('warn', 'seat.table_post_failed', { seat: seat.id, message: (error as Error).message }); }
          }
          else armRebuttalClose(self, seat.id, rebuttalRemaining);
          continue;
        }
        self.store.updateSeat(seat.id, { status: 'closed' }, 'seat.closed');
        if (seat.role === 'debater') {
          try { self.maybePostTable(self.store.getSeat(seat.id)!); } catch (error) { self.options.log('warn', 'seat.table_post_failed', { seat: seat.id, message: (error as Error).message }); }
        }
      }
    }
  }
