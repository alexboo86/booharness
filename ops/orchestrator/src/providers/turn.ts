// Turn timing shared by the adapters. A timed-out turn is cancelled and then
// DRAINED: the adapter waits for that turn's own end (its prompt response, its
// `result`, its `turn/completed`) before the session takes another prompt, so
// late output of the old turn can never be read as the next turn's. A provider
// that does not stop within DRAIN_MS loses its process instead.
// ORCH_DRAIN_MS exists for the test suite, like ORCH_PORT.
export const DRAIN_MS = Number(process.env.ORCH_DRAIN_MS) || 10000;

export class TurnTimeout extends Error {}

/** `work`, or a TurnTimeout rejection after `ms` (no limit when ms is undefined). */
export function withTimeout<T>(work: Promise<T>, ms: number | undefined): Promise<T> {
  if (!ms) return work;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TurnTimeout(`turn timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** true once `work` settles either way within `ms`, false if it does not. */
export async function settlesWithin(work: Promise<unknown>, ms = DRAIN_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  const settled = work.then(() => true, () => true);
  try {
    return await Promise.race([settled, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export function drainNote(drained: boolean, exited: boolean): string {
  if (!drained) return `the provider did not stop within ${DRAIN_MS} ms; the session was closed`;
  return exited ? 'the provider exited while stopping' : 'cancelled';
}
