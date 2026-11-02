import type { EngineInterface } from 'claude-code'

const key = (session: string) => `wake-idle:${session}`;
export const IDLE_MS = 40 * 60_000;
type Idle = { session: string; since: number; compacted: boolean };

/** Independent session keys avoid cross-session read/modify/write and eviction.
 * The host's whole-store capacity limit fails closed rather than dropping age. */
export function idleContext($: EngineInterface) {
  return new IdleContext({
    get: (session) => $.store.get(key(session)),
    set: (session, value) => $.store.set(key(session), value),
    id: () => $.session.id(),
    now: () => $.clock.now(),
  });
}

type IdleApi = {
  get(session: string): Promise<unknown>;
  set(session: string, value: unknown): Promise<void>;
  id(): Promise<string>;
  now(): Promise<number>;
};
class IdleContext {
  private writes = Promise.resolve();
  private version = 0;
  private pending = new Map<string, Idle | null>();
  constructor(private api: IdleApi) {}
  private write<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work);
    this.writes = result.then(() => {}, () => {});
    return result;
  }
  private async flush(session: string) {
    if (!this.pending.has(session)) return;
    const value = this.pending.get(session)!;
    if (value?.compacted) {
      const stored = await this.api.get(session) as Idle | null;
      if (stored?.since !== value.since) {
        if (this.pending.get(session) === value) this.pending.delete(session);
        return;
      }
    }
    await this.api.set(session, value);
    if (this.pending.get(session) === value) this.pending.delete(session);
  }
  async read(session: string): Promise<Idle | null> {
    await this.write(() => this.flush(session));
    return this.valid(await this.api.get(session), session);
  }
  private valid(raw: unknown, session: string): Idle | null {
    const value = raw as Partial<Idle> | null;
    if (!value || value.session !== session || typeof value.since !== 'number' ||
      !Number.isFinite(value.since) || typeof value.compacted !== 'boolean') return null;
    return value as Idle;
  }
  started() {
    ++this.version;
    // Invalidate synchronously; identity/storage must not hold up a user turn.
    // Later preparation waits for this queued write and retries a failed flush.
    void this.write(async () => {
      const session = await this.api.id();
      this.pending.set(session, null);
      await this.flush(session);
    }).catch(() => {});
    return Promise.resolve();
  }
  ended(current: () => boolean) {
    return this.write(async () => {
      const session = await this.api.id();
      const since = await this.api.now();
      const sameSession = await this.api.id() === session;
      if (current() && sameSession) {
        this.pending.set(session, { session, since, compacted: false });
        await this.flush(session);
      }
    });
  }
  compacted(idle: Idle, expected: number) {
    if (this.version !== expected) return Promise.resolve();
    // Remember success before I/O. A failed persistence attempt must never
    // cause this live context to compact twice when the store recovers.
    this.pending.set(idle.session, { ...idle, compacted: true });
    return this.write(() => this.flush(idle.session));
  }
  revision() { return this.version; }
}
