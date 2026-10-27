// scout_request (decision #11990, task 1571): a coder, bughunter or reviewer seat
// asks orch for ONE read-only scout; orch creates it (pace-picked family, parent
// recorded), waits for its turn, hands the digest back as the tool result and
// closes it. Limits are enforced here, never trusted to the caller:
//  - depth 1: only the three worker roles may ask, and a seat that has a parent
//    (a scout) never gets a token, so a scout cannot ask for another;
//  - one at a time per seat (no lifetime cap, decision #19107);
//  - the question is at most MAX_QUESTION_WORDS words.
// Identity is bound by orch: each worker session gets a random token at spawn;
// the token alone names the seat, so a seat cannot claim to be another one.
// No other orch tool reaches a seat: the seat endpoint serves only this one.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { readHost } from './config.ts';
import { hostCheckoutExists, listRemoteCheckouts } from './remote-worktree.ts';
import { formatDigest } from './digest-text.ts';
import type { Logger } from './log.ts';
import type { Choose, SeatManager } from './seats.ts';
import { TERMINAL_TURN, type Seat, type Store } from './store.ts';
import { MAX_FILES, MAX_QUESTION_WORDS, SCOUT_CALLERS, type SeatTool } from './shared.entry.ts';

const SCOUT_TIMEOUT_MS = 15 * 60_000;

export class ScoutRefused extends Error {}

type Deps = { store: Store; seats: SeatManager; log: Logger; port: () => number; choose: () => Choose | Promise<Choose>;
  stateDir: string; listRemoteCheckouts?: typeof listRemoteCheckouts; hostCheckoutExists?: typeof hostCheckoutExists };

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

export class ScoutGate {
  private deps: Deps;
  /** Token of each seat's current session; a respawn replaces it. Memory only: a restart respawns every session. */
  private tokens = new Map<string, Buffer>();
  private inFlight = new Set<string>();

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** The endpoint and token a worker seat's session is spawned with; null for a seat that may not ask. */
  issue(seat: Seat): SeatTool | null {
    if (!SCOUT_CALLERS.includes(seat.role) || typeof (seat.data as Record<string, unknown>).parent === 'string') return null;
    const token = randomBytes(32);
    this.tokens.set(seat.id, token);
    return { url: `http://127.0.0.1:${this.deps.port()}`, token: token.toString('hex') };
  }

  /** The seat a bearer token belongs to, or null: a forged or stale token names no seat. */
  seatOf(authorization: string | undefined): string | null {
    const match = /^Bearer ([0-9a-f]{64})$/.exec(authorization ?? '');
    if (!match) return null;
    const given = Buffer.from(match[1], 'hex');
    for (const [seatId, token] of this.tokens) if (timingSafeEqual(token, given)) return seatId;
    return null;
  }

  private refuse(seatId: string, reason: string): never {
    this.deps.log('info', 'seat.scout_refused', { seat: seatId, reason });
    throw new ScoutRefused(reason);
  }

  /** Runs one scout for `seatId` and returns its digest text. */
  async request(seatId: string, input: Record<string, unknown>): Promise<string> {
    const { store, seats, log } = this.deps;
    const parent = store.getSeat(seatId);
    if (!parent) this.refuse(seatId, `no seat '${seatId}'`);
    if (!SCOUT_CALLERS.includes(parent.role)) this.refuse(seatId, `a ${parent.role} seat cannot request a scout`);
    if (typeof (parent.data as Record<string, unknown>).parent === 'string') this.refuse(seatId, 'a scout cannot request a scout (depth 1)');
    if (parent.status === 'closed' || parent.status === 'failed') this.refuse(seatId, `seat is ${parent.status}`);
    const keys = Object.keys(input).filter((key) => key !== 'question' && key !== 'files');
    if (keys.length) this.refuse(seatId, `unknown argument ${keys.join(', ')}`);
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (!question) this.refuse(seatId, 'question must be non-empty text');
    const count = words(question);
    if (count > MAX_QUESTION_WORDS) this.refuse(seatId, `question is ${count} words; at most ${MAX_QUESTION_WORDS}`);
    const files = input.files;
    if (files !== undefined && (!Array.isArray(files) || files.length > MAX_FILES || files.some((file) => typeof file !== 'string' || !file))) {
      this.refuse(seatId, `files must be at most ${MAX_FILES} non-empty paths`);
    }
    // Checked and claimed with no await in between: two concurrent calls cannot both pass.
    if (this.inFlight.has(seatId)) this.refuse(seatId, 'a scout for this seat is still running; one at a time');
    this.inFlight.add(seatId);
    let scoutId: string | null = null;
    try {
      const data = parent.data as Record<string, any>;
      const host = typeof data.host === 'string' ? data.host : null;
      if (host) {
        const dir = data.remoteDir;
        if (typeof dir !== 'string' || dir !== parent.cwd) this.refuse(seatId, `parent host checkout is unavailable on ${host}`);
        try {
          const config = readHost(host, this.deps.stateDir);
          const normalize = config.platform === 'win32'
            ? (value: string) => path.win32.normalize(value).toLowerCase()
            : (value: string) => path.posix.normalize(value);
          const registered = await (this.deps.listRemoteCheckouts ?? listRemoteCheckouts)(host, config.repo);
          if (!registered.some((checkout) => normalize(checkout) === normalize(dir)) ||
              !await (this.deps.hostCheckoutExists ?? hostCheckoutExists)(host, config.repo, dir)) {
            this.refuse(seatId, `parent host checkout is missing on ${host}: ${dir}`);
          }
        } catch (error) {
          if (error instanceof ScoutRefused) throw error;
          this.refuse(seatId, `parent host checkout is unavailable on ${host}: ${(error as Error).message}`);
        }
      }
      const scout = await seats.create({
        role: 'scout',
        title: `scout for ${seatId}: ${question.replace(/\s+/g, ' ').slice(0, 120)}`,
        // Local scouts read the Mac worktree; remote scouts borrow the parent's live host checkout.
        repo: host ? data.repo : parent.worktree ?? data.repo,
        ...(host ? { host } : { needs: 'mac' }),
        parent: seatId,
      }, await this.deps.choose());
      scoutId = scout.id;
      log('info', 'seat.scout_requested', { seat: seatId, scout: scout.id, family: scout.family, words: count });
      const turn = await seats.promptScoped(scout.id, question, SCOUT_TIMEOUT_MS, { files: files as string[] | undefined });
      let ended = turn;
      while (!TERMINAL_TURN.has(ended.status)) ended = await seats.wait(turn.id, 60_000);
      return formatDigest(await seats.digest(ended));
    } finally {
      this.inFlight.delete(seatId);
      if (scoutId) await seats.close(scoutId).catch((error) => log('warn', 'seat.scout_close_failed', { seat: seatId, scout: scoutId, message: (error as Error).message }));
    }
  }
}
