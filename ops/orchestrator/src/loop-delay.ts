import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
type Logger = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;

/**
 * The longest span of the current monitor window. Module-level on purpose:
 * providers and helpers cannot reach the runtime's monitor, but every callback
 * on this event loop can import `span`. It records with no monitor started too;
 * the monitor tick is the only reader and resets the window on every tick.
 */
let longest: { name: string; ms: number } | null = null;

/** A tick gap this far past the nominal 50 ms interval is a stall; a span over it blocks the loop on its own. */
const STALL_MS = 100;

/**
 * Time `fn`'s synchronous run and keep it as the longest span of the window.
 * For an async `fn` this covers only its synchronous prefix (the run until the
 * first await); continuations are separate windows and stay unattributed.
 */
export function span<T>(name: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - start;
    if (longest === null || ms > longest.ms) longest = { name, ms };
  }
}

/** Lifetime statistics; an empty histogram has no measured percentile yet. */
export function startLoopDelay(log: Logger) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  const since = new Date().toISOString();
  let label = 'daemon.startup';
  let stalls = 0;
  let previous = performance.now();
  longest = null; // a span recorded before this monitor is never read by its first tick
  histogram.enable();
  const timer = setInterval(() => {
    const now = performance.now();
    const delay = now - previous - 50;
    previous = now;
    const window = longest;
    longest = null; // the window resets on every tick, stall or not
    if (delay > STALL_MS) {
      stalls++;
      // Attribution, not suspicion: the span is named when it covers the delay,
      // or when it alone exceeds STALL_MS — a stall in its own right even when
      // unspanned blocking shares the same window (review 2026-10-19, win host).
      log('warn', 'loop.stall', {
        delay,
        label: window !== null && (window.ms >= delay || window.ms > STALL_MS) ? window.name : 'unattributed',
        span: window !== null ? window.ms : null,
        last: label,
      });
    }
  }, 50);
  timer.unref();
  return {
    mark(next: string): void { label = next; },
    snapshot() {
      const sampled = histogram.count > 0;
      return {
        p50: sampled ? histogram.percentile(50) / 1e6 : null,
        p99: sampled ? histogram.percentile(99) / 1e6 : null,
        max: sampled ? histogram.max / 1e6 : null,
        stalls,
        since,
      };
    },
    stop(): void {
      clearInterval(timer);
      histogram.disable();
    },
  };
}

export type LoopDelay = ReturnType<typeof startLoopDelay>;
