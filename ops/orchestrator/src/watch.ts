// Phase 3: orch watches a running turn and steps in at once (operator decision #10511, after
// #10457 "Jev acts immediately"). One signal:
//   loop  — the same tool call, name and identical arguments, REPEAT_IN_A_ROW times in a row or
//           REPEAT_PER_TURN times in one turn. A file edit in between resets the count: edit, test,
//           edit, test is a coder working, not a loop.
// The drift steer and its Jev score were removed (task 2185): no stored drift score reached 0.8.
// The first loop steers the seat mid-turn; a second one in the same turn interrupts it. What
// happened is kept with the turn and shown in its digest.
//
// Only calls that carry their arguments count: a bare tool name ("bash") repeated is normal work.

export const REPEAT_IN_A_ROW = 3;
export const REPEAT_PER_TURN = 5;
/** Tools that change files: a repeat after one of these is a retry on new code, not a loop. */
const MUTATION = /edit|write|patch|filechange|notebook/i;

export type Ask = (input: { text: string; questions: Record<string, unknown>; timeoutMs?: number }) => Promise<any>;
export type WatchSignal = { kind: 'loop'; detail: string };
export type WatchAction = WatchSignal & { action: 'steer' | 'interrupt'; at: string; failed?: string };

/**
 * Text for Jev that its privacy gate (ops/bootstrap/jev-gate.mjs) lets through: plain labelled
 * sections, never one JSON line. The gate refuses anything holding a `<!-- brief:` marker and cuts
 * everything after a line with a builder closing phrase ("Do NOT write to memoryctl" is one), so
 * markers are removed and the caller puts the material that must survive first (review 2026-09-22).
 */
export function jevText(sections: [label: string, body: string][]): string {
  return sections.map(([label, body]) => `${label}:\n${body.replace(/<!--\s*brief:\w*\s*-->/g, '')}`).join('\n\n');
}

/** JSON with sorted keys, so two calls with the same arguments in another order are one call. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function steerMessage(signal: WatchSignal): string {
  return `orch: you are repeating the same tool call (${signal.detail}). It will not give a different result. Stop repeating it: use what you already have, try another approach, or finish with your report and say what blocked you.`;
}

export class TurnWatch {
  readonly actions: WatchAction[] = [];
  private act: (action: WatchAction) => void;
  private now: () => number;
  private last: string | null = null;
  private streak = 0;
  private counts = new Map<string, number>();
  private stopped = false;

  constructor(options: { act: (action: WatchAction) => void; now?: () => number }) {
    this.act = options.act;
    this.now = options.now ?? Date.now;
  }

  /** One tool call as the provider reported it; `args` undefined means the adapter could not see them. */
  tool(name: string, args: unknown): void {
    if (this.stopped || args === undefined) return;
    if (MUTATION.test(name)) {
      this.reset();
      return;
    }
    const key = `${name} ${stableJson(args)}`;
    this.streak = key === this.last ? this.streak + 1 : 1;
    this.last = key;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (this.streak >= REPEAT_IN_A_ROW) this.signal({ kind: 'loop', detail: `${short(key)} ${this.streak} times in a row` });
    else if (count >= REPEAT_PER_TURN) this.signal({ kind: 'loop', detail: `${short(key)} ${count} times this turn` });
  }

  /** The turn is over: a late tool event changes nothing. */
  stop(): void {
    this.stopped = true;
  }

  private reset(): void {
    this.last = null;
    this.streak = 0;
    this.counts.clear();
  }

  private signal(signal: WatchSignal): void {
    if (this.stopped) return;
    const action: WatchAction = { ...signal, action: this.actions.length ? 'interrupt' : 'steer', at: new Date(this.now()).toISOString() };
    this.actions.push(action);
    // A steered seat gets a clean count: only a NEW loop after the steer interrupts.
    this.reset();
    if (action.action === 'interrupt') this.stopped = true;
    this.act(action);
  }
}

function short(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
