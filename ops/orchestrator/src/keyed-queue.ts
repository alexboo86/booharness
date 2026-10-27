/** Independent FIFO turns per key. Not reentrant for the same key. */
export function createKeyedQueue() {
  const queues = new Map<string, Promise<void>>();
  return async function withTurn<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const ahead = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    const tail = ahead.then(() => done);
    queues.set(key, tail);
    // An aborted waiter must not forget the queue while its predecessor still runs.
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    try {
      await turn(ahead, signal);
      return await work();
    } finally {
      release();
    }
  };
}

function turn(ahead: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return ahead;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void ahead.then(() => { signal.removeEventListener('abort', abort); resolve(); });
  });
}
