import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
type Logger = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;

/**
 * The longest span of the current monitor window. Module-level on purpose:
 * providers and helpers cannot reach the runtime's monitor, but every callback
 * on this event loop can import `span`. It records with no monitor started too;
 * the monitor tick is the only reader and resets the window on every tick.
 */
let longest: { name: string; ms: number } | null = null;

/** A labelled section of daemon work: opened at an entry point, closed when the flow ends, possibly after awaits. */
type Section = { name: string; startedAt: number };

/** Sections opened and not yet closed; the last entry is the newest, not necessarily the one running. */
const open: Section[] = [];

/** The last section to close within the current tick window, with how long it ran. */
type EndedSection = Section & { ms: number };
let lastEnded: EndedSection | null = null;

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

/**
 * Open a labelled section of daemon work and return how to close it. Unlike
 * `span`, which times only a synchronous prefix, a section stays open across
 * awaits (an HTTP request's whole handling, awaits included), so a stall
 * records which flows were in flight. It is context, not cause: with
 * concurrent requests the newest open section may be an idle one while an
 * older request's continuation blocks. Nesting restores the
 * enclosing section; closing twice is a no-op. Never a label: a section held
 * open for minutes (a wake poll) must not inherit a stranger's stall.
 */
export function section(name: string): () => void {
  const entry = { name, startedAt: performance.now() };
  open.push(entry);
  return () => {
    const index = open.indexOf(entry);
    if (index === -1) return;
    open.splice(index, 1);
    lastEnded = { ...entry, ms: performance.now() - entry.startedAt };
  };
}

/**
 * The loop.stall record. `label` and `span` keep the covering rule exactly as
 * before. Section fields are context for the unattributed share, never a
 * blocker identity: `section` is the newest still-open section (its `sectionMs` is age, not CPU — an old
 * age is an idle held poll, not the blocker); `sectionEnded` closed within
 * this window, so it was in flight while the loop was blocked; its ms is
 * wall time, not proof it was the blocker.
 */
function stallFields(
  now: number,
  delay: number,
  window: { name: string; ms: number } | null,
  done: EndedSection | null,
  running: Section | null,
  last: string,
) {
  return {
    delay,
    label: window !== null && (window.ms >= delay || window.ms > STALL_MS) ? window.name : 'unattributed',
    span: window !== null ? window.ms : null,
    last,
    section: running !== null ? running.name : null,
    sectionMs: running !== null ? now - running.startedAt : null,
    sectionEnded: done !== null ? done.name : null,
    sectionEndedMs: done !== null ? done.ms : null,
  };
}

/** Lifetime statistics; an empty histogram has no measured percentile yet. */
export function startLoopDelay(log: Logger) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  const since = new Date().toISOString();
  let label = 'daemon.startup';
  let stalls = 0;
  let previous = performance.now();
  longest = null; // a span recorded before this monitor is never read by its first tick
  lastEnded = null; // nor is a section: windows belong to the running monitor alone
  open.length = 0;
  histogram.enable();
  const timer = setInterval(() => {
    const now = performance.now();
    const delay = now - previous - 50;
    previous = now;
    const window = longest;
    longest = null; // the window resets on every tick, stall or not
    const done = lastEnded;
    lastEnded = null;
    const running = open.length > 0 ? open[open.length - 1] : null;
    if (delay > STALL_MS) {
      stalls++;
      // Attribution, not suspicion: the span is named when it covers the delay,
      // or when it alone exceeds STALL_MS — a stall in its own right even when
      // unspanned blocking shares the same window (review 2026-10-19, win host).
      log('warn', 'loop.stall', stallFields(now, delay, window, done, running, label));
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
