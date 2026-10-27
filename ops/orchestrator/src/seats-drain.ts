import { AsyncLocalStorage } from 'node:async_hooks';
import { span } from './shared.entry.ts';
import type { SeatManager } from './seats.ts';
import { provisioningStarted, type Store } from './store.ts';
export async function oneAtATime(self: SeatManager, key: string, work: () => Promise<void>): Promise<void> {
    const next = (self.settling.get(key) ?? Promise.resolve()).then(work);
    const tail = next.catch(() => undefined);
    self.settling.set(key, tail);
    try {
      await next;
    } finally {
      if (self.settling.get(key) === tail) self.settling.delete(key);
    }
  }

/** The seat whose chain work is on this async stack. A queued tail is not a holder. */
const chainHolder = new AsyncLocalStorage<string>();

export function chainHolds(seatId: string): boolean {
  return chainHolder.getStore() === seatId;
}

export function chain(self: SeatManager, seatId: string, work: () => Promise<void>): void {
    self.busyChains.add(seatId);
    // The span times `work`'s synchronous start (until its first await): a chain
    // step blocking the loop is named, a later continuation is not.
    const next = (self.chains.get(seatId) ?? Promise.resolve()).then(() => chainHolder.run(seatId, () => span(`seat.chain ${seatId}`, work))).catch((error) => {
      self.options.log('error', 'seat.chain_failed', { seat: seatId, message: (error as Error).message });
    });
    self.chains.set(seatId, next);
    void next.finally(() => {
      if (self.chains.get(seatId) === next) self.busyChains.delete(seatId);
    });
  }

/** Arm drain. The flag is committed before this returns, so a crash cannot lose it. */
export function beginDrain(self: SeatManager): { draining: true; running: number } {
    self.store.setDrain(true);
    self.draining = true;
    const running = self.store.runningTurns();
    self.maybeDrainExit();
    return { draining: true, running };
  }

/** Withdraw an armed drain without touching callbacks still in the normal FIFO. */
export function cancelDrain(self: SeatManager): { draining: false; resumed: number } {
    if (self.drainLeaving) throw new Error('cannot cancel restart: drain exit has already begun');
    if (!self.draining) throw new Error('cannot cancel restart: no drain is armed');
    const held = self.store.listQueued().filter((turn) => self.drainHeld.has(turn.id));
    self.store.setDrain(false);
    self.draining = false;
    self.resumeProvisioning();
    for (const seatId of new Set(held.map((turn) => turn.seat_id))) {
      self.chain(seatId, () => self.resumeHeld(seatId));
    }
    return { draining: false, resumed: held.length };
  }

/** stopDrain found work that appeared after the idle check: wait for the next edge. */
export function rearmDrain(self: SeatManager): void {
    self.drainLeaving = false;
    queueMicrotask(() => self.maybeDrainExit());
  }

export function restorePending(self: SeatManager, turnId: string): ReturnType<Store['pendingOf']> {
    const pending = self.store.pendingOf(turnId);
    if (pending) {
      self.briefFiles.set(turnId, pending.files);
      if (pending.tokenCap !== undefined) self.tokenCaps.set(turnId, pending.tokenCap);
      if (pending.recheck === false) self.recheckOptOut.add(turnId);
      if (pending.checkout) self.recheckCheckouts.set(turnId, pending.checkout);
    }
    return pending;
  }

/** Start turns a drain restart left queued. Caller clears the flag after this schedules them. */
export function resumeQueued(self: SeatManager): void {
    for (const turn of self.store.listQueued()) {
      const pending = self.restorePending(turn.id);
      self.chain(turn.seat_id, () => self.run(turn.seat_id, turn.id, pending?.timeoutMs ?? self.options.turnTimeoutMs));
    }
  }

/** A still-chained later turn must not overtake an earlier skipped callback. */
export async function resumeHeld(self: SeatManager, seatId: string, beforeSeq = Infinity): Promise<void> {
    for (const turn of self.store.listTurns(seatId)) {
      if (self.draining) return;
      const timeoutMs = self.drainHeld.get(turn.id);
      if (timeoutMs === undefined || turn.seq >= beforeSeq) continue;
      self.drainHeld.delete(turn.id);
      if (turn.status !== 'queued') continue;
      self.restorePending(turn.id);
      await self.run(seatId, turn.id, timeoutMs);
    }
  }

export function maybeDrainExit(self: SeatManager): void {
    if (!self.draining || self.drainLeaving) return;
    if (self.store.runningTurns() > 0) return;
    if (self.store.listSeats('provisioning').some(provisioningStarted)) return;
    self.drainLeaving = true;
    self.options.onDrainIdle?.();
  }
