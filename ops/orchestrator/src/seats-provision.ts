import type { SeatManager } from './seats.ts';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { codexEditEligible, codexEditModels, codexEditWanted, localCodexEdit, remoteCodexEditExtension, type CodexEdit } from './codex-edit.ts';
import { hashlineEditWanted, localHashlineEdit, remoteHashlineEdit, type HashlineEdit } from './hashline-edit.ts';
import { remotePiMcpPath } from './remote-pi-mcp.ts';
import type { Seat } from './store.ts';
import { readHost } from './config.ts';
import type { Target, LoadProbe } from './placement.ts';
import { dirExistsOnHost, prepareCheckout, removeCheckout, syncHostRuntime, type DirProbe } from './remote-repo.ts';
import { provisionRemote as setupRemote, checkCodexEditOnHost, checkHashlineEditOnHost, provisionCodexEdit, provisionHashlineEdit } from './remote-provision.ts';
import { assertMirrorPath, removeMirror, snapshotAvailable, snapshotBack, syncMirror } from './remote-worktree.ts';
import { createWorktree, deleteBranch, noteCodegraphDaemonStop, provisionWorktree, removeWorktree, runnableRepo } from './worktrees.ts';
import { KEPT_TREES, ROLE_POLICY, landable, type SeatData, type SeatRole } from './seats-defs.ts';

/** A debater whose provisioning failed can be the last event that ends its table (task 2794). */
function postTableAfterFailure(self: SeatManager, seat: Seat): void {
  if (seat.role !== 'debater' || !Array.isArray(seat.data.options) || seat.data.options.length === 0) return;
  try { self.maybePostTable(seat); }
  catch (error) { self.options.log('warn', 'seat.table_post_failed', { seat: seat.id, message: (error as Error).message }); }
}

/** Rebuild the provisioning step from durable create fields, for new and drain-held seats. */
export function queueProvision(self: SeatManager, row: Seat): void {
  const held = row.data.provisionHeld === true;
  self.chain(row.id, async () => {
    let seat = self.store.getSeat(row.id);
    if (!seat || seat.status !== 'provisioning' || self.closing.has(row.id)) return;
    if (held && (seat.data.provisionHeld !== true || self.draining)) return;
    seat = self.store.updateSeat(row.id, { data: { provisionHeld: false } }, 'seat.provision_started');
    const { repo, main, base, branch, remoteDir, mirror } = seat.data as {
      repo: string; main: string; base: string; branch: string | null; remoteDir?: string; mirror?: string;
    };
    if (typeof remoteDir === 'string') {
      if (!self.options.daemonRuntime && !self.options.syncHostRuntime) {
        postTableAfterFailure(self, self.store.updateSeat(row.id, { status: 'failed', data: { failure: 'remote create needs the daemon commit resolved at serve start' } }, 'seat.provision_failed'));
        self.maybeDrainExit();
        return;
      }
      if (typeof mirror === 'string') await self.provisionRemoteCoder(seat, repo, base!, remoteDir, mirror);
      else await self.provisionRemote(seat, repo, base!, remoteDir);
    } else await self.provision(seat, main, repo, base!, branch);
  });
}

/** Schedule held setup before scheduling any queued turns for those seats. */
export function resumeProvisioning(self: SeatManager): void {
  for (const seat of self.store.listSeats('provisioning')) {
    if (seat.data.provisionHeld === true) self.queueProvision(seat);
  }
}

/** Probe this Mac and every named host at once; a probe that fails is an error value, never a throw. */
export async function probeTargets(self: SeatManager, hosts: readonly string[]): Promise<Map<Target, LoadProbe>> {
    const probe = self.options.probeLoad;
    const targets: Target[] = ['local', ...hosts];
    const results = await Promise.all(targets.map((target) => probe(target)));
    return new Map(targets.map((target, i) => [target, results[i]]));
  }

/** Seats consuming resources per target: a host seat counts on its host, every other seat on this Mac. */
export function activeByTarget(self: SeatManager): Map<Target, number> {
    const active = new Map<Target, number>();
    // The two live statuses only (defect 2026-10-16): never the closed history.
    for (const seat of [...self.store.listSeats('working'), ...self.store.listSeats('provisioning')]) {
      const target = typeof seat.data.host === 'string' ? seat.data.host : 'local';
      active.set(target, (active.get(target) ?? 0) + 1);
    }
    return active;
  }

/**
 * The seat's remote-exec and build gate run from the host's runtime checkout: it must be on
 * this daemon's commit first (task 1784). It runs in the seat chain, never before the row
 * (task 1757: a bundle transfer may outlive the client's create timeout); a refusal or
 * failure fails only this seat.
 */
export async function syncRuntime(self: SeatManager, host: string, top: string): Promise<void> {
    const runtime = self.options.daemonRuntime;
    const sync = self.options.syncHostRuntime ?? syncHostRuntime;
    // The target is the commit this daemon started from, never the seat repo (a lead worktree can be elsewhere).
    if (runtime) await sync(host, runtime.repo, { sha: runtime.sha, log: self.options.log });
    // Injected fixtures predate daemonRuntime and ignore the target; create refuses the real sync without it.
    else await sync(host, top);
  }

export async function provisionRemote(self: SeatManager, seat: Seat, top: string, commit: string, dir: string): Promise<void> {
    const host = seat.data.host as string;
    try {
      await self.syncRuntime(host, top);
      await (self.options.prepareRemoteCheckout ?? prepareCheckout)(host, { sha: commit, localRepo: top }, dir);
      // Owned only once prepareCheckout returns: close and recover must not touch a path it never verified.
      self.store.updateSeat(seat.id, { data: { remoteCheckoutOwned: true } }, 'seat.remote_checkout_owned');
      const readOnly = seat.role in ROLE_POLICY && ROLE_POLICY[seat.role as SeatRole].access === 'read-only';
      const result = await (self.options.setupRemote ?? setupRemote)(host, dir, { readOnly, codexEdit: self.wantsCodexEdit(seat), hashlineEdit: self.wantsHashlineEdit(seat), role: seat.role });
      if (!result.ok) {
        const failed = result.steps[result.steps.length - 1];
        throw new Error(`remote provision failed: ${failed?.command} exited ${failed?.code}: ${failed?.tail}`);
      }
      const remoteProvisionNotes = result.notes;
      self.store.updateSeat(seat.id, { status: 'ready', data: { remoteMcpConfig: remotePiMcpPath(readHost(host, self.options.stateDir), dir), remoteProvisionNotes, ...(result.codexEditExtension ? { codexEditExtension: result.codexEditExtension } : {}), ...(result.hashlineEditExtension ? { hashlineEditExtension: result.hashlineEditExtension } : {}) } }, 'seat.ready');
    } catch (error) {
      // A checkout mismatch is not ours to repair; a failed setup must never reach ready or select its MCP config.
      postTableAfterFailure(self, self.store.updateSeat(seat.id, { status: 'failed', data: { failure: (error as Error).message } }, 'seat.provision_failed'));
    } finally {
      self.maybeDrainExit();
    }
  }

/**
 * A remote coder's slow checkout work, chained behind the row create answers
 * with (task 1757): host checkout transfer, setup, then the local mirror.
 * Success flips the seat ready and selects its MCP config; a failure fails the
 * seat with the reason and reclaims both sides best-effort, as a local
 * provisioning failure does. A prompt queued meanwhile runs or cancels after.
 */
export async function provisionRemoteCoder(self: SeatManager, seat: Seat, top: string, commit: string, dir: string, mirror: string): Promise<void> {
    const host = seat.data.host as string;
    let prepareMs = 0, setupMs = 0, mirrorMs = 0;
    let prepared = false;
    try {
      await self.syncRuntime(host, top);
      let phase = Date.now();
      await (self.options.prepareRemoteCheckout ?? prepareCheckout)(host, { sha: commit, localRepo: top }, dir);
      prepared = true; prepareMs = Date.now() - phase; phase = Date.now();
      self.store.updateSeat(seat.id, { data: { remoteCheckoutOwned: true } }, 'seat.remote_checkout_owned');
      const result = await (self.options.setupRemote ?? setupRemote)(host, dir, { codexEdit: self.wantsCodexEdit(seat), hashlineEdit: self.wantsHashlineEdit(seat), role: seat.role });
      setupMs = Date.now() - phase; phase = Date.now();
      if (!result.ok) {
        const failed = result.steps[result.steps.length - 1];
        throw new Error(`remote provision failed: ${failed?.command} exited ${failed?.code}: ${failed?.tail}`);
      }
      await (self.options.syncRemoteMirror ?? syncMirror)(top, mirror, commit, commit, self.options.stateDir);
      mirrorMs = Date.now() - phase;
      self.options.log('info', 'seat.remote_provision', { seat: seat.id, prepareMs, setupMs, mirrorMs });
      self.store.updateSeat(seat.id, { status: 'ready', data: { remoteMcpConfig: remotePiMcpPath(readHost(host, self.options.stateDir), dir), remoteProvisionNotes: result.notes, ...(result.codexEditExtension ? { codexEditExtension: result.codexEditExtension } : {}), ...(result.hashlineEditExtension ? { hashlineEditExtension: result.hashlineEditExtension } : {}) } }, 'seat.ready');
    } catch (error) {
      const failures: string[] = [];
      try { await (self.options.removeRemoteMirror ?? removeMirror)(top, mirror, self.options.stateDir); }
      catch (cleanup) { failures.push(`mirror ${mirror}: ${(cleanup as Error).message}`); }
      if (prepared) {
        try { await (self.options.removeRemoteCheckout ?? removeCheckout)(host, dir); }
        catch (cleanup) { failures.push(`host ${dir}: ${(cleanup as Error).message}`); }
      }
      const message = failures.length ? `${(error as Error).message}; cleanup failed: ${failures.join('; ')}` : (error as Error).message;
      self.options.log('warn', 'seat.remote_provision_failed', { seat: seat.id, prepareMs, setupMs, mirrorMs, message });
      // remoteRemoved only once the host checkout is verified gone: an unprepared
      // checkout is never deleted unverified (the mismatch rule in provisionRemote).
      postTableAfterFailure(self, self.store.updateSeat(seat.id, { status: 'failed', data: { failure: message,
        ...(failures.length ? {} : { worktreeRemoved: true, ...(prepared ? { remoteRemoved: true } : {}) }) } }, 'seat.provision_failed'));
    } finally {
      self.maybeDrainExit();
    }
  }

export async function provision(self: SeatManager, seat: Seat, main: string, top: string, commit: string, branch: string | null): Promise<void> {
    const dir = seat.worktree!;
    try {
      mkdirSync(path.dirname(dir), { recursive: true });
      await createWorktree(top, dir, commit, branch);
      const result = await (self.options.provision ?? provisionWorktree)(main, dir);
      const steps = result.steps.map((step) => ({ command: step.command.slice(0, 120), code: step.code, ms: step.ms }));
      if (!result.ok) {
        const failed = result.steps[result.steps.length - 1];
        postTableAfterFailure(self, self.store.updateSeat(seat.id, { status: 'failed', data: { provision: steps, failure: `${failed.command.slice(0, 120)} exited ${failed.code}: ${failed.tail.slice(-600)}` } }, 'seat.provision_failed'));
        await self.discardCheckout(seat.id);
        return;
      }
      // Provisioning has no observable changes; discard warnings from reads attempted before the checkout was ready.
      self.observationFailed.delete(seat.id);
      self.store.updateSeat(seat.id, { status: 'ready', data: { provision: steps } }, 'seat.ready');
    } catch (error) {
      postTableAfterFailure(self, self.store.updateSeat(seat.id, { status: 'failed', data: { failure: (error as Error).message } }, 'seat.provision_failed'));
      await self.discardCheckout(seat.id);
    } finally {
      self.maybeDrainExit();
    }
  }

/**
 * A checkout no turn ever ran in (failed provisioning) is removed with its
 * branch, so failures do not pile up in `git worktree list`. The failure
 * text stays in the seat's data.
 */
export async function discardCheckout(self: SeatManager, seatId: string): Promise<void> {
    const seat = self.store.getSeat(seatId)!;
    const data = seat.data as SeatData;
    if (!seat.worktree || data.worktreeRemoved) return;
    const problems: string[] = [];
    // Resolve before the worktree is removed: the branch delete would otherwise
    // run against a dead cwd. A resolution failure (worktree not a checkout) is
    // a per-seat problem logged below; it must never escape recovery and block
    // daemon startup (review 2026-09-25).
    let repo = data.repo;
    try { repo = await runnableRepo(data.repo, seat.worktree); } catch (error) { problems.push((error as Error).message); }
    if (existsSync(seat.worktree)) {
      try {
        const daemons = await removeWorktree(repo, seat.worktree);
        noteCodegraphDaemonStop(daemons, seatId, seat.worktree, self.store, self.options.log);
      } catch (error) { problems.push((error as Error).message); }
    }
    if (data.branch) {
      try { await deleteBranch(repo, data.branch); } catch (error) { problems.push((error as Error).message); }
    }
    if (problems.length) self.options.log('warn', 'seat.discard_failed', { seat: seatId, problems });
    self.store.updateSeat(seatId, { data: { worktreeRemoved: !problems.length } }, 'seat.discarded');
  }

/** Host removal is pending only for a path prepareCheckout verified. A row without the field predates it and stays owned. */
export function remoteRemovalPending(self: SeatManager, seat: Seat): boolean {
    const data = seat.data;
    if (typeof data.host !== 'string' || typeof data.remoteDir !== 'string' || data.borrowedRemote) return false;
    if (data.remoteCheckoutOwned === false) return false;
    // A recorded stop marker (task 1952) halts the retry loop; it is an observation,
    // never a removal record — land and prune keep the host cleanup outstanding.
    if (data.remoteCleanupStopped) return false;
    return !(landable(seat.role) ? data.remoteRemoved : data.worktreeRemoved);
  }

/**
 * Bound a closed remote coder's removal retries (task 1952): after a removal error,
 * probe the seat directory on the host. ABSENT (the bytes are gone by whatever cause)
 * or three failed attempts with the directory still PRESENT records `remoteCleanupStopped`
 * so recovery stops retrying; the reason states the observation only, orch deleted and
 * certified nothing, and clearing the field is a manual store edit. An unknown probe
 * changes nothing: the retry stays as today and is not counted.
 */
export async function remoteCleanupStop(self: SeatManager, seat: Seat, removal: { remoteRemoved?: true; remoteRemoveError: string | null }): Promise<Record<string, unknown>> {
    if (removal.remoteRemoved) {
      return typeof seat.data.remoteRemoveAttempts === 'number' ? { remoteRemoveAttempts: null } : {};
    }
    if (!removal.remoteRemoveError) return {};
    let probe: DirProbe = 'unknown';
    try {
      const config = readHost(seat.data.host as string, self.options.stateDir);
      probe = await (self.options.probeRemoteDir ?? dirExistsOnHost)(seat.data.host as string, seat.data.remoteDir as string, config.platform, config.repo);
    } catch { probe = 'unknown'; }
    if (probe === 'absent') {
      self.options.log('info', 'seat.remote_cleanup_stopped', { seat: seat.id, probe });
      return { remoteCleanupStopped: { reason: `existence probe answered ABSENT for the seat directory; orch deleted nothing and certifies nothing (last removal error: ${removal.remoteRemoveError})`, at: new Date().toISOString() } };
    }
    if (probe === 'present') {
      const attempts = (typeof seat.data.remoteRemoveAttempts === 'number' ? seat.data.remoteRemoveAttempts : 0) + 1;
      if (attempts >= 3) {
        self.options.log('info', 'seat.remote_cleanup_stopped', { seat: seat.id, attempts });
        return { remoteRemoveAttempts: attempts, remoteCleanupStopped: { reason: `${attempts} removal attempts failed and the seat directory still exists on the host; bytes kept on host (last error: ${removal.remoteRemoveError})`, at: new Date().toISOString() } };
      }
      return { remoteRemoveAttempts: attempts };
    }
    return {};
  }

/**
 * Only the checkout allocated beside this registered host's repo may be removed.
 * `allowDeadLeftover` authorizes dropping a checkout git already emptied (task 1836):
 * a snapshot recorded, or a disposable checkout, never loses unsnapshotted bytes.
 */
export async function removeRemoteSeat(self: SeatManager, seat: Seat, allowDeadLeftover = false): Promise<{ worktreeRemoved?: true; remoteRemoved?: true; remoteRemoveError: string | null }> {
    if (seat.data.remoteCheckoutOwned === false) return { remoteRemoveError: null };
    const host = seat.data.host as string;
    const dir = seat.data.remoteDir as string;
    try {
      const config = readHost(host, self.options.stateDir);
      const remotePath = config.platform === 'win32' ? path.win32 : path.posix;
      const expected = remotePath.join(remotePath.dirname(config.repo), 'worktrees', seat.id);
      if (dir !== expected) throw new Error(`remote checkout path mismatch: ${dir}`);
      await (self.options.removeRemoteCheckout ?? removeCheckout)(host, dir, undefined, undefined, allowDeadLeftover ? { allowDeadLeftover: true } : undefined);
      return landable(seat.role) ? { remoteRemoved: true, remoteRemoveError: null } : { worktreeRemoved: true, remoteRemoveError: null };
    } catch (error) {
      return { remoteRemoveError: (error as Error).message };
    }
  }

/** Mirror a completed remote turn before checks, trees or routing inspect local bytes. */
export async function syncRemoteTurn(self: SeatManager, seat: Seat, turnId: string): Promise<void> {
    self.store.updateSeat(seat.id, { data: { remoteSyncState: 'pending' } }, 'seat.remote_sync_pending', { turn: turnId });
    self.observationError(seat, new Error('remote turn sync pending'));
    const signal = AbortSignal.timeout(self.options.remoteTurnSyncMs);
    const work = (async () => {
      const { head, snapshot, invalidPaths = [] } = await (self.options.snapshotRemote ?? snapshotBack)(seat.data.host as string, seat.data.remoteDir as string,
        seat.data.repo as string, seat.data.base as string, undefined, signal, seat.id);
      await (self.options.syncRemoteMirror ?? syncMirror)(seat.data.repo as string, seat.data.mirror as string,
        head, snapshot, self.options.stateDir, signal);
      return invalidPaths;
    })();
    let onAbort: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(`remote turn sync timed out after ${self.options.remoteTurnSyncMs}ms`));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      const invalidPaths = await Promise.race([work, deadline]);
      const leftOut = invalidPaths.filter((file) => typeof file === 'string' && file.length > 0);
      if (leftOut.length) {
        const previous = self.store.getSeat(seat.id)!.data.remoteSyncInvalidPaths as Record<string, string[]> | undefined;
        const kept = Object.fromEntries(Object.entries({ ...previous, [turnId]: leftOut }).slice(-KEPT_TREES));
        self.store.updateSeat(seat.id, { data: { remoteSyncState: 'ready', remoteSyncInvalidPaths: kept } },
          'seat.remote_synced', { turn: turnId, invalidPaths: leftOut });
        self.options.log('warn', 'seat.remote_sync_invalid_paths', { seat: seat.id, turn: turnId, paths: leftOut });
      } else {
        self.store.updateSeat(seat.id, { data: { remoteSyncState: 'ready' } }, 'seat.remote_synced', { turn: turnId });
      }
    } catch (error) {
      const message = (error as Error).message;
      const previous = self.store.getSeat(seat.id)!.data.remoteSyncFailures as Record<string, string> | undefined;
      const failures = { ...previous, [turnId]: message };
      self.store.updateSeat(seat.id, { data: { remoteSyncState: 'failed', remoteSyncFailures: Object.fromEntries(Object.entries(failures).slice(-KEPT_TREES)) } },
        'seat.remote_sync_failed', { turn: turnId, message });
      self.options.log('warn', 'seat.remote_sync_failed', { seat: seat.id, turn: turnId, message });
      // The real transport aborts its children. Hold briefly for cleanup; a test
      // stub that ignores AbortSignal cannot hold a turn indefinitely.
      if (signal.aborted) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([work.catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, 12_000); })]);
        } finally { if (timer) clearTimeout(timer); }
      }
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

/** Move a remote coder's bytes home before releasing its host checkout. */
export async function finishRemoteCoder(self: SeatManager, seat: Seat): Promise<{ remoteRemoved?: true; remoteRemoveError: string | null }> {
    if (seat.data.remoteCheckoutOwned === false) return { remoteRemoveError: null };
    // A coder that never ran a turn, and whose checkout never became ready, has nothing to snapshot.
    // Snapshotting that mid-setup tree fails and would keep the host checkout; its leftover
    // is droppable without a snapshot because no turn ever wrote into it.
    if (typeof seat.data.remoteMcpConfig !== 'string' && !self.store.listTurns(seat.id).some((turn) => turn.started_at)) {
      return await self.removeRemoteSeat(seat, true);
    }
    try {
      const mirror = seat.data.mirror as string;
      assertMirrorPath(self.options.stateDir, mirror);
      if (seat.worktree !== mirror) throw new Error(`mirror path mismatch: ${seat.worktree}`);
      const host = seat.data.host as string;
      const dir = seat.data.remoteDir as string;
      const config = readHost(host, self.options.stateDir);
      const remotePath = config.platform === 'win32' ? path.win32 : path.posix;
      if (dir !== remotePath.join(remotePath.dirname(config.repo), 'worktrees', seat.id)) throw new Error(`remote checkout path mismatch: ${dir}`);
      // The lead checkout may be gone by close; the mirror still names the repository (task 1993).
      const repo = await runnableRepo(seat.data.repo as string, mirror);
      // A close whose snapshot and mirror landed must never re-run against a dead
      // checkout — git may already have emptied it and `rev-parse HEAD` fails there
      // forever (task 1836). Record the snapshot once; a retry keeps the mirror and
      // may drop the leftover directory. The record authorizes skipping the re-sync
      // only while its commit is still in the local repo (pinned since task 1842):
      // an unavailable recorded tree makes the host checkout the last copy, so the
      // sync re-runs instead of deleting it.
      const recorded = seat.data.remoteSnapshot as { head: string; snapshot: string } | undefined;
      const usable = typeof recorded?.head === 'string' && typeof recorded?.snapshot === 'string' &&
        await snapshotAvailable(repo, recorded.snapshot);
      if (!usable) {
        try {
          // Bound the background sync: on timeout the host checkout stays for a retry and the error is recorded.
          const signal = AbortSignal.timeout(self.options.remoteTurnSyncMs);
          const { head, snapshot, invalidPaths = [] } = await (self.options.snapshotRemote ?? snapshotBack)(host, dir, repo, seat.data.base as string, undefined, signal, seat.id);
          await (self.options.syncRemoteMirror ?? syncMirror)(repo, mirror, head, snapshot, self.options.stateDir, signal);
          const leftOut = invalidPaths.filter((file) => typeof file === 'string' && file.length > 0);
          if (leftOut.length) self.options.log('warn', 'seat.remote_sync_invalid_paths', { seat: seat.id, paths: leftOut });
          self.store.updateSeat(seat.id, { data: { remoteSnapshot: leftOut.length ? { head, snapshot, invalidPaths: leftOut } : { head, snapshot } } }, 'seat.remote_snapshot_recorded');
        } catch (error) {
          // Name the recorded sync state: while it is not 'ready' the mirror may lack
          // the last turn's bytes and the kept host checkout is the only full copy (task 1842).
          const state = seat.data.remoteSyncState;
          const message = (error as Error).message;
          return { remoteRemoveError: typeof state === 'string' && state !== 'ready' ? `remote mirror unavailable (last sync ${state}): ${message}` : message };
        }
      }
      return await self.removeRemoteSeat(seat, true);
    } catch (error) {
      return { remoteRemoveError: (error as Error).message };
    }
  }

/** Whether this seat must load codex-edit: a stock Pi codex seat that edits (operator #13098), never on a win32 target (task 1956, CODEX_EDIT_WIN32_WITHHELD: the pinned toolkit rejects every nested Windows path). */
export function wantsCodexEdit(self: SeatManager, seat: Seat): boolean {
    const data = seat.data as SeatData;
    if (!codexEditWanted({ role: seat.role, family: seat.family, access: data.access, harness: data.harness, standArm: data.standArm })) return false;
    return codexEditEligible(typeof data.host === 'string' ? data.host : undefined, self.options.stateDir);
  }

export function wantsHashlineEdit(self: SeatManager, seat: Seat): boolean {
    const data = seat.data as SeatData;
    return hashlineEditWanted({ role: seat.role, family: seat.family, access: data.access, harness: data.harness, standArm: data.standArm });
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
export async function pinnedEditRecorded(self: SeatManager, seat: Seat, host: string, name: 'codex-edit' | 'hashline-edit', recorded: unknown): Promise<unknown> {
    if (typeof recorded === 'string') return recorded;
    const result = await (name === 'codex-edit' ? provisionCodexEdit(host) : provisionHashlineEdit(host));
    if (!result.ok || typeof result.extension !== 'string') {
      const failed = result.steps[result.steps.length - 1];
      throw new Error(`${name}: host '${host}' has no provisioned extension for this seat and the lazy install failed: ${failed?.command ?? 'no step'} exited ${failed?.code ?? 'none'}: ${failed?.tail ?? 'no output'}; repair on the host with: node ops/ab-stand/${name}-install.mjs --ensure --prefix <host repo>/.pi-extensions/${name}`);
    }
    const extension = result.extension;
    const dataKey = name === 'codex-edit' ? 'codexEditExtension' : 'hashlineEditExtension';
    self.store.updateSeat(seat.id, { data: { [dataKey]: extension } }, 'seat.pinned_edit_lazy');
    self.options.log('info', 'seat.pinned_edit_lazy', { seat: seat.id, host, name, extension });
    return extension;
  }

export async function hashlineEditFor(self: SeatManager, seat: Seat, data: SeatData): Promise<HashlineEdit | undefined> {
    if (!self.wantsHashlineEdit(seat)) return undefined;
    if (typeof data.host !== 'string') return localHashlineEdit(self.options.stateDir);
    const recorded = await self.pinnedEditRecorded(seat, data.host, 'hashline-edit', data.hashlineEditExtension);
    const edit = remoteHashlineEdit(data.host, recorded);
    const verdict = await checkHashlineEditOnHost(data.host);
    if (!verdict.ok || verdict.extension !== edit.extension) {
      throw new Error(`hashline-edit on host '${data.host}' does not verify: ${verdict.reason ?? 'extension path mismatch'}; repair on the host with: node ops/ab-stand/hashline-edit-install.mjs --ensure --prefix <host repo>/.pi-extensions/hashline-edit or re-provision the seat`);
    }
    return edit;
  }

/**
 * The codex-edit extension this seat loads, proved at EVERY session start: on
 * this Mac by the installer's --check over the stock prefix, on a host by the
 * same --check run there plus the path provisioning recorded. Anything else
 * throws, so a codex seat that edits never silently runs on Pi's stock edit
 * tools (operator #13098).
 */
export async function codexEditFor(self: SeatManager, seat: Seat, data: SeatData): Promise<CodexEdit | undefined> {
    if (!self.wantsCodexEdit(seat)) return undefined;
    if (typeof data.host !== 'string') return localCodexEdit(self.options.stateDir);
    const recorded = await self.pinnedEditRecorded(seat, data.host, 'codex-edit', data.codexEditExtension);
    const extension = remoteCodexEditExtension(data.host, recorded);
    const verdict = await checkCodexEditOnHost(data.host);
    if (!verdict.ok) {
      throw new Error(`codex-edit on host '${data.host}' does not verify: ${verdict.reason ?? 'no verdict'}; repair it on the host (node ops/ab-stand/codex-edit-install.mjs --ensure --prefix <host repo>/.pi-extensions/codex-edit) or re-provision the seat`);
    }
    if (verdict.extension !== extension) {
      throw new Error(`codex-edit on host '${data.host}' verified ${verdict.extension ?? 'nothing'}, not the recorded ${extension}; re-provision the seat`);
    }
    return { extension, models: codexEditModels() };
  }
