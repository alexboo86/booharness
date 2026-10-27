// Phase 5: the lead's view of orch in a browser tab (decisions #10457, #10478):
// the Claude Desktop and Codex in-app browsers open http://127.0.0.1:7760/ and
// see what the Paseo composer pills showed — the seats at work, with which of our
// instruments each one used (operator, 2026-09-23: rtk, codegraph, rg, ast-grep,
// memoryctl, MCP — used or not, and so why not) — plus each family's weekly and
// monthly load and every active lead's context against its /next limit.
// Finished seats fold away. Read-only; loopback only, behind the same
// DNS-rebinding guard as /mcp. The page polls /api/dashboard; nothing runs a model.
import { VERSION } from './config.ts';
import type { Runtime } from './http.ts';
import { activeLeads, windowSeatSessions, type LeadRow } from './leads.ts';
import { cachedRtkGain, type RtkGain } from './rtk-gain.ts';
import { cachedJevEstimate } from '../../bootstrap/jev-ledger.mjs';
import { cachedBrightdataBalance } from './brightdata.ts';
import { CODEX_DEFAULT } from './providers/codex.ts';
import { TERMINAL_TURN, type TurnWatchRecord } from './store.ts';
import { INSTRUMENTS } from './toolkinds.ts';
import { codexEditEligible, codexEditWanted } from './codex-edit.ts';
import { hashlineEditWanted } from './hashline-edit.ts';
import { budgetReading } from './profiles.ts';
import { landable } from './seats-defs.ts';
import { seatHost } from './placement.ts';
import { machineLoads, type MachineReading } from './machine-load.ts';
import { formatPause, readPauseRecords } from './paused-families.ts';
import { idleDays } from './prune.ts';
import { RESERVED_HANDLE } from './chat.ts';
import { FAMILY_LOGOS } from './family-logos.ts';

export type BoardSeat = {
  id: string;
  role: string;
  family: string;
  title: string;
  status: string;
  /** Named remote host, or mac for this Mac. */
  host: string;
  /** The model the provider reports it runs (else the one asked for) and the effort it was given. */
  model: string | null;
  effort: string | null;
  /** Skills the context inlined (required) and listed for the seat to read (context.ts). */
  skills: { required: string[]; listed: string[]; router: { skills: string; lessons: string; knowledge: string; skillReason?: string; lessonReason?: string; knowledgeReason?: string } | null } | null;
  /** The Pi extensions orch itself loads into this seat's session (providers/pi.ts piArgs, stand.ts); empty for a native harness. */
  extensions: string[];
  /** Provisioning, or a turn queued or running: the seat is at work now. */
  active: boolean;
  turn: string | null;
  turnStatus: string | null;
  queued: number;
  tools: number;
  /** Tool calls by kind (toolkinds.ts); live for a running turn. */
  kinds: Record<string, number> | null;
  seconds: number | null;
  ended: string | null;
  verdict: string | null;
  findings: number | null;
  flags: string[];
  // Decision #11839 (2026-09-24): coder overlap warnings are the lead's alone — only the seat_prompt
  // answer carries them, so no board seat row exposes them.
  worktree: { files: number; stat: string } | null;
  /** Coder only: the scope of its latest turn that carries one (the first brief). Absent otherwise. */
  scope?: NonNullable<TurnWatchRecord['scope']>;
  /** A scout a worker seat asked for (scout-request.ts) names that seat. */
  parent: string | null;
  /** The scouts this seat asked for, closed ones included: a scout closes after one answer and leaves the board. */
  scouts: { id: string; family: string; status: string }[];
};

export type Board = { configError: import('./config-health.ts').ConfigError | null; frozenProjectKeys: string[]; draining: ReturnType<Runtime['store']['drainStatus']>; version: string; at: string; instruments: readonly string[]; seats: BoardSeat[]; limits: unknown; paused: string[]; pausedError: string | null; leads: LeadRow[]; rtk: RtkGain | null; jev: Awaited<ReturnType<typeof cachedJevEstimate>>; brightdata: Awaited<ReturnType<typeof cachedBrightdataBalance>>; machines: MachineReading[] };

/** A lead is active while its last timestamped log entry is under 10 minutes old (operator: only the active one). */
export const ACTIVE_LEAD_MINUTES = 10;
/**
 * The lead scan visits every transcript under ~/.claude/projects. An append does not change a
 * directory mtime, so the walk cannot skip one; it yields instead (leads.ts). A page polling
 * every 3 s reuses one scan for 10 s. The cache holds the scan's promise, so polls that arrive
 * while it runs share it and an older scan never replaces a newer one; a failed scan is dropped
 * so the next poll scans again (task 2622 review: per-poll scans reached 93.5 ms).
 */
const LEADS_TTL_MS = 10_000;
export function leadsReader(store: Pick<Runtime['store'], 'listSeats'>): () => Promise<LeadRow[]> {
  let cache: { at: number; rows: Promise<LeadRow[]> } | null = null;
  return () => {
    const now = Date.now();
    if (!cache || now - cache.at > LEADS_TTL_MS) {
      const rows = activeLeads({ now, minutes: ACTIVE_LEAD_MINUTES, seatSessions: windowSeatSessions(store, now, ACTIVE_LEAD_MINUTES) })
        .then((found) => found.filter((lead) => !lead.handedOver));
      const entry = { at: now, rows };
      cache = entry;
      rows.catch(() => { if (cache === entry) cache = null; });
    }
    return cache.rows;
  };
}
const boardLeads = new WeakMap<Runtime['store'], () => Promise<LeadRow[]>>();
function cachedLeads(rt: Runtime): Promise<LeadRow[]> {
  let read = boardLeads.get(rt.store);
  if (!read) { read = leadsReader(rt.store); boardLeads.set(rt.store, read); }
  return read();
}

/**
 * digest() runs three asynchronous git calls per worktree. An ended turn's digest no longer changes, so it is computed
 * once per turn; only turns still running are read again on each poll.
 */
const endedDigests = new Map<string, ReturnType<Runtime['seats']['digest']>>();
async function digestOf(rt: Runtime, turn: NonNullable<ReturnType<Runtime['store']['getTurn']>>) {
  if (!TERMINAL_TURN.has(turn.status)) return rt.seats.digest(turn);
  const key = `${turn.id}\n${turn.ended_at}`;
  let digest = endedDigests.get(key);
  if (!digest) {
    digest = rt.seats.digest(turn);
    endedDigests.set(key, digest);
    void digest.catch(() => { if (endedDigests.get(key) === digest) endedDigests.delete(key); });
    if (endedDigests.size > 500) endedDigests.delete(endedDigests.keys().next().value!);
  }
  return digest;
}

/** A coder's scope lives on its first turn only; later turns carry none. */
function scopeOf(role: string, turns: ReturnType<Runtime['store']['listTurns']>): Pick<BoardSeat, 'scope'> {
  const scope = role === 'coder' ? turns.findLast((turn) => turn.watch?.scope)?.watch?.scope : undefined;
  return scope ? { scope } : {};
}

/** Only what orch passes to Pi and verifies at start: its own guard, the pinned edit extensions (never codex-edit on a win32 host, task 1956), the stand arm's profile. */
function piExtensions(role: string, family: string, data: Record<string, any>, stateDir?: string): string[] {
  if (data.harness !== 'pi') return [];
  const seat = { role, family, access: data.access, harness: data.harness, standArm: data.standArm };
  const codexEdit = codexEditWanted(seat) && codexEditEligible(typeof data.host === 'string' ? data.host : undefined, stateDir);
  return ['orch-guard', ...(codexEdit ? ['codex-edit'] : []), ...(hashlineEditWanted(seat) ? ['hashline-edit'] : []), ...(typeof data.standArm === 'string' ? [`arm:${data.standArm}`] : [])];
}

/**
 * Header totals a poll must not wait for. A cold `rtk gain` is seconds on this history and a cold
 * Jev ledger read is over 100 ms; the page ticks every 3 s, and a poll of two seats with no turns
 * must stay under 50 ms (task 2098; the limit is decision #11839). The last settled value is served
 * at once — null until the first read lands, which the header already treats as absent. buildBoard still
 * awaits an injected reader, so a caller that passes one sees its value on this poll.
 */
function settled<T>(read: () => Promise<T>, empty: T): () => Promise<T> {
  let value = empty;
  let inflight: Promise<void> | null = null;
  return () => {
    if (!inflight) {
      // A microtask would still run the spawn before this poll's promises flush. setImmediate
      // starts the read after the poll has returned.
      inflight = new Promise((resolve) => {
        setImmediate(() => {
          void read().then(
            (next) => { value = next; },
            () => { value = empty; },
          ).finally(() => { inflight = null; resolve(); });
        });
      });
    }
    return Promise.resolve(value);
  };
}

const boardRtk = settled(cachedRtkGain, null);
const boardJev = settled(cachedJevEstimate, null);
const boardBrightdata = settled(cachedBrightdataBalance, null);

// Cold requests share one build; warm requests never wait for the Git fan-out.
const inFlightBoards = new WeakMap<Runtime, Promise<Board>>();
const builtBoards = new WeakMap<Runtime, { value: Board; builtAt: number }>();
export function board(rt: Runtime, leads: () => LeadRow[] | Promise<LeadRow[]> = () => cachedLeads(rt), gain: () => Promise<RtkGain | null> = boardRtk, jev: typeof cachedJevEstimate = boardJev, machines: () => MachineReading[] | Promise<MachineReading[]> = () => machineLoads(rt.stateDir), brightdata: typeof cachedBrightdataBalance = boardBrightdata): Promise<Board> {
  const built = builtBoards.get(rt);
  const previous = inFlightBoards.get(rt);
  if (!previous && (!built || Date.now() - built.builtAt > 3000)) {
    // Digest setup and the store scan do synchronous work too: let the HTTP caller
    // send the cached answer before starting either.
    const current = built
      ? new Promise<Board>((resolve) => { setImmediate(() => resolve(buildBoard(rt, leads, gain, jev, machines, brightdata))); })
      : buildBoard(rt, leads, gain, jev, machines, brightdata);
    inFlightBoards.set(rt, current);
    void current.then((value) => {
      builtBoards.set(rt, { value, builtAt: Date.now() });
      inFlightBoards.delete(rt);
    }, () => { inFlightBoards.delete(rt); }); // A failed refresh leaves the last good board intact.
    if (!built) return current;
  }
  return built ? Promise.resolve(built.value) : previous!;
}

async function buildBoard(rt: Runtime, leads: () => LeadRow[] | Promise<LeadRow[]>, gain: () => Promise<RtkGain | null>, jev: typeof cachedJevEstimate, machinesFn: () => MachineReading[] | Promise<MachineReading[]>, brightdata: typeof cachedBrightdataBalance): Promise<Board> {
  const now = Date.now();
  let paused: string[] = [];
  let pausedError: string | null = null;
  if (rt.stateDir) {
    try { paused = readPauseRecords(rt.stateDir).map((record) => formatPause(record, now)); }
    catch (error) { pausedError = error instanceof Error ? error.message : String(error); }
  }
  // The seat fan-out starts before the first await: a synchronous digest call must stay
  // synchronous, and the rtk read runs alongside it, never ahead of it. Both reads are bounded
  // (defect 2026-10-16): the closed history never enters a board build — open seats come per status
  // from the seats index, and the scouts fan-out asks only for scouts of seats still on the board
  // (closed parents were never rendered, so their scouts were never read).
  const open = rt.store.listSeats({ notStatus: 'closed' });
  const scoutsOf = new Map<string, BoardSeat['scouts']>();
  for (const scout of open.length ? rt.store.listSeats({ parentIn: open.map((seat) => seat.id) }) : []) {
    const parent = (scout.data as Record<string, unknown>).parent;
    if (typeof parent !== 'string') continue;
    const status = rt.store.listTurns(scout.id).at(-1)?.status ?? scout.status;
    scoutsOf.set(parent, [...(scoutsOf.get(parent) ?? []), { id: scout.id, family: scout.family, status }]);
  }
  const seatsPromise = Promise.all(open.map(async (seat): Promise<BoardSeat> => {
    const turns = rt.store.listTurns(seat.id);
    const queued = turns.filter((turn) => turn.status === 'queued').length;
    const turn = turns.find((turn) => turn.status === 'running') ?? turns.at(-1) ?? null;
    const data = seat.data as Record<string, any>;
    const days = landable(seat.role) ? idleDays(seat, turns, now) : null;
    const idleFlags = days === null ? [] : [`${seat.role} idle for ${days.toFixed(1)} days; checkout retained pending landed/no-change proof`];
    const base = {
      id: seat.id, role: seat.role, family: seat.family, title: seat.title, status: seat.status, host: seatHost(data),
      model: typeof data.providerModel === 'string' ? data.providerModel : typeof data.model === 'string' ? data.model : null,
      effort: typeof data.effort === 'string' ? data.effort : seat.family === 'codex' ? CODEX_DEFAULT.effort : null,
      skills: data.skills && Array.isArray(data.skills.required) && Array.isArray(data.skills.listed) ? { required: data.skills.required, listed: data.skills.listed, router: data.skills.router && typeof data.skills.router.skills === 'string' && typeof data.skills.router.lessons === 'string' ? data.skills.router : null } : null,
      extensions: piExtensions(seat.role, seat.family, data, rt.stateDir),
      ...scopeOf(seat.role, turns),
      parent: typeof data.parent === 'string' ? data.parent : null,
      scouts: scoutsOf.get(seat.id) ?? [],
    };
    if (!turn) {
      return { ...base, active: seat.status === 'provisioning', turn: null, turnStatus: null, queued, tools: 0, kinds: null, seconds: null, ended: null, verdict: null, findings: null, flags: [], worktree: null };
    }
    const digest = await digestOf(rt, turn);
    const running = !TERMINAL_TURN.has(turn.status);
    const report = digest.report as Record<string, unknown> | null;
    return {
      ...base,
      active: running || seat.status === 'provisioning',
      turn: turn.id,
      turnStatus: turn.status,
      queued,
      tools: running ? rt.seats.liveToolCount(turn.id) ?? 0 : turn.tools,
      kinds: running ? rt.seats.liveToolKinds(turn.id) : turn.watch?.tools ?? null,
      seconds: running ? (turn.started_at ? Math.round((now - Date.parse(turn.started_at)) / 1000) : null) : digest.seconds,
      ended: turn.ended_at,
      verdict: typeof report?.verdict === 'string' ? report.verdict : null,
      findings: Array.isArray(report?.findings) ? report.findings.length : null,
      flags: [...digest.flags, ...idleFlags],
      worktree: digest.worktree ? { files: digest.worktree.files, stat: digest.worktree.stat } : null,
    };
  }));
  // .then(gain): a gain that throws synchronously must not reject the board and strand the seat fan-out.
  const gains = Promise.resolve().then(gain).then((value) => value, () => null);
  const estimate = Promise.resolve().then(jev).catch(() => null);
  const balance = Promise.resolve().then(brightdata);
  // Machine probes ride the same fan-out; a malformed hosts.json or probe transport error shows as no panel, never a failed board.
  const machineReadings = Promise.resolve().then(machinesFn).catch(() => [] as MachineReading[]);
  const [rtk, seats, jevEstimate, machineList, brightdataBalance] = await Promise.all([gains, seatsPromise, estimate, machineReadings, balance]);
  return { configError: rt.configHealth?.snapshot().configError ?? null, frozenProjectKeys: rt.configHealth?.snapshot().frozenProjectKeys ?? [], draining: rt.store.drainStatus(), version: VERSION, at: new Date(now).toISOString(), instruments: INSTRUMENTS, seats, paused, pausedError, limits: rt.limits.all().map((load) => ({ ...load, budget: budgetReading(load.readings) })), leads: await leads(), rtk, jev: jevEstimate, brightdata: brightdataBalance, machines: machineList };
}

/**
 * The page. Every value from the API is set as textContent: seat titles and paths are data, never
 * markup. Status colours are the dataviz status steps (good, warning, serious, critical), always
 * beside a number or a word, never alone.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>orch board</title>
<style>
:root {
  --bg: #f4f4f2; --surface: #fcfcfb; --raised: #ffffff; --ink: #1c1c1a; --ink-2: #4a4a45; --muted: #85847d;
  --line: #e4e3de; --track: #ebeae5; --accent: #465e80; --accent-soft: #e9edf3; --badge-ink: #304760; --badge-muted: #67665f;
  --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #bc3030; --critical-soft: #fbeaea; --on-critical: #ffffff; --warning-soft: #fdf4e1;
  --shadow: 0 1px 2px rgba(0,0,0,.05);
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #121211; --surface: #1a1a19; --raised: #1f1f1d; --ink: #edece7; --ink-2: #c3c2bb; --muted: #8d8c85;
    --line: #2d2c29; --track: #2a2926; --accent: #aabbd5; --accent-soft: #28313d; --badge-ink: #d9e3f1; --badge-muted: #aaa9a0; --critical: #ec8c8c; --critical-soft: #3a1f1f; --on-critical: #121211; --warning-soft: #3a3120;
    --shadow: none; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 1180px; margin: 0 auto; padding: 18px 16px 40px; }
header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
.brand { font-weight: 700; font-size: 16px; letter-spacing: -.01em; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); display: inline-block; }
.dot.off { background: var(--critical); }
.summary { display: flex; gap: 8px; flex-wrap: wrap; }
.stat { background: var(--raised); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; color: var(--ink-2); }
.stat b { color: var(--ink); }
#rtk { margin-left: auto; }
#rtk[hidden], #jev[hidden], #brightdata[hidden] { display: none; }
.stat.alert { border-color: var(--critical); color: var(--critical); background: var(--critical-soft); }
.stat.alert b { color: var(--critical); }
.muted { color: var(--muted); }
.accent { color: var(--accent); }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 22px 0 10px; font-weight: 600; }
.grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
.grid.small { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.card { background: var(--raised); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; min-width: 0; box-shadow: var(--shadow); }
.card.alert { border-color: var(--critical); box-shadow: 0 0 0 1px var(--critical) inset; }
.row { display: flex; gap: 8px; align-items: center; min-width: 0; }
.col { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.card > .title { display: block; white-space: normal; overflow-wrap: anywhere; margin: 6px 0 2px; }
.row > .state { margin-left: auto; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
.chip { font-size: 11px; line-height: 18px; padding: 0 8px; border-radius: 999px; white-space: nowrap; background: var(--accent-soft); color: var(--accent); font-weight: 600; flex: none; }
.family-label { display: inline-flex; align-items: center; gap: .5rem; min-width: 0; flex: none; }
.family-label > :last-child { display: inline-flex; align-items: center; }
.family-label > .chip { min-height: 1.125rem; }
.family-text { display: block; line-height: 1; }
.family-logo { display: inline-flex; align-items: center; justify-content: center; width: 1.25rem; height: 1.25rem; flex: none; }
.family-logo > svg { display: block; width: 100%; height: 100%; }
.host { font-size: 11px; line-height: 16px; padding: 0 7px; border-radius: 999px; white-space: nowrap; font-weight: 700; flex: none; border: 1px solid; }
.host.local { border-color: var(--accent); color: var(--accent); background: var(--raised); }
.host.remote { border-color: var(--warning); color: var(--ink); background: var(--warning-soft); }
.state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-2); white-space: nowrap; flex: none; }
.state::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.state.running::before, .state.queued::before, .state.provisioning::before { background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
.state.done::before { background: var(--good); }
.state.error::before, .state.failed::before, .state.interrupted::before { background: var(--critical); }
@keyframes pulse { 50% { opacity: .25; } }
.meta { display: flex; gap: 12px; flex-wrap: wrap; color: var(--ink-2); margin-top: 8px; font-variant-numeric: tabular-nums; }
.badges { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
.badges.flat, .sect { display: flex; flex-direction: row; gap: 5px; flex-wrap: wrap; align-items: center; }
.sect-label { font-size: 10px; line-height: 20px; width: 40px; flex: none; text-transform: uppercase; letter-spacing: .05em; color: var(--badge-muted); }
.badge { font-size: 11px; line-height: 20px; padding: 0 8px; border-radius: 6px; white-space: nowrap; font-variant-numeric: tabular-nums; border: 1px solid transparent; }
.badge b { font-weight: 700; margin-left: 5px; }
.badge.used, .badge.mcp { background: var(--accent-soft); color: var(--badge-ink); }
.badge.unused { border: 1px dashed var(--line); color: var(--badge-muted); }
.badge.missing { border: 1px solid var(--critical); color: var(--critical); background: var(--critical-soft); }
.badge.other { background: var(--track); color: var(--ink-2); }
.badge.skill { font-style: italic; }
.flags { margin: 10px 0 0; padding: 8px 10px 8px 26px; background: var(--warning-soft); border-radius: 8px; color: var(--ink); }
.flags li { margin: 2px 0; }
.gauges { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; gap: 6px 8px; align-items: center; margin-top: 6px; }
.gauge { display: contents; }
.gauge .lbl { font-size: 11px; font-weight: 600; color: var(--muted); }
.bar { height: 8px; border-radius: 999px; background: var(--track); overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: 999px; }
.gauge .val { font-size: 11.5px; color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; justify-self: end; }
.machine.err { border-color: var(--critical); }
.machine .errline { color: var(--critical); font-size: 11.5px; margin-top: 6px; overflow-wrap: anywhere; }
.verdict { font-weight: 700; font-size: 11px; letter-spacing: .03em; white-space: nowrap; }
.verdict.APPROVE { color: var(--good); }
.verdict.REQUEST_CHANGES { color: var(--critical); }
.ringbox { display: flex; gap: 16px; align-items: center; }
.ring { flex: none; }
.ring text { font: 700 13px ui-sans-serif, system-ui, sans-serif; fill: var(--ink); }
.ring .track { stroke: var(--track); }
.big { font-size: 22px; font-weight: 700; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
.next { margin-top: 12px; padding: 8px 12px; border-radius: 8px; background: var(--critical); color: var(--on-critical); font-weight: 700; }
.fam { display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; }
.fam .name { font-weight: 600; }
.fam .verdict { white-space: normal; }
.empty { color: var(--muted); padding: 6px 2px; }
.drain-banner { display: inline-block; background: var(--warning-soft); color: var(--ink); border-color: var(--warning); margin-bottom: 1em; font-weight: 600; cursor: help; }
.drain-banner[hidden] { display: none; }
details { margin-top: 22px; }
details.sec[open] > summary { margin-bottom: 10px; }
summary { cursor: pointer; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 600; }
.done-row { display: grid; grid-template-columns: minmax(0, 2fr) auto auto minmax(0, 3fr); gap: 12px; align-items: center; padding: 8px 2px; border-bottom: 1px solid var(--line); }
.done-row .badges { margin-top: 0; flex-direction: row; flex-wrap: wrap; gap: 4px 14px; }
.done-row .sect-label { width: auto; }
#chatPosts { height: 18rem; overflow-y: auto; overflow-anchor: none; scrollbar-color: var(--muted) var(--surface); min-width: 0; }
/* Stacked transcript (operator decision 14892): the message gets the row; time and author sit above it.
   Hairline dividers and vertical gaps separate posts, without bubbles. Nick tones stay the page palette. */
#chatHandles, #chatReadStatus { overflow-wrap: anywhere; }
.chat-post { display: block; min-width: 0; padding: 1rem 0; border-bottom-width: 1px; border-bottom-style: solid; border-bottom-color: var(--line); }
.chat-post:last-child { border-bottom-width: 0; }
.chat-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: .25rem .5rem; min-width: 0; }
.chat-text { display: block; min-width: 0; margin-top: .5rem; }
.chat-time { flex: none; white-space: nowrap; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.chat-nick { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.chat-nick.chat-accent { color: var(--accent); }
.chat-nick.chat-c0 { color: var(--good); }
.chat-nick.chat-c1 { color: var(--serious); }
.chat-nick.chat-c2 { color: var(--critical); }
.chat-nick.chat-c3 { color: var(--badge-ink); }
.chat-nick.chat-c4 { color: var(--ink-2); }
.chat-to { display: block; color: var(--ink-2); margin-bottom: .25rem; overflow-wrap: anywhere; }
.chat-body { display: block; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
.chat-wake { color: var(--serious); }
.chat-receipts { display: flex; flex-wrap: wrap; gap: .25rem .5rem; margin-top: .75rem; color: var(--ink-2); min-width: 0; }
.chat-rc { min-width: 0; max-width: 100%; overflow-wrap: anywhere; background: var(--surface); border: thin solid var(--line); border-radius: .25rem; padding: .25rem .5rem; }
.chat-rc-state { white-space: nowrap; }
#chatForm { display: flex; flex-direction: column; gap: .5em; margin-top: .75em; }
#chatForm .row { flex-wrap: wrap; }
#chatForm[hidden], #chatReleaseForm[hidden] { display: none; }
#chatBody, #chatTo, #chatSend { font: inherit; color: var(--ink); background: var(--surface); border: thin solid var(--line); border-radius: .5em; padding: .5em; }
#chatBody { width: 100%; resize: vertical; caret-color: var(--ink); }
#chatTo { min-width: 0; max-width: 100%; }
#chatSend { cursor: pointer; }
#chatSend:hover { background: var(--accent-soft); }
#chatForm :focus-visible, #chatPosts:focus-visible { outline: thin solid var(--accent); outline-offset: .15em; }
#chatForm :disabled { opacity: .6; cursor: not-allowed; }
#chat ::selection { background: var(--accent-soft); color: var(--ink); }
/* A seat card's folded live turn (task 2883): text as paragraphs, thought muted, tool one monospace line. */
.turnlog { margin-top: 10px; border-top: 1px solid var(--line); }
.turnlog > summary { margin-top: 6px; }
.turnlog-body { max-height: 16rem; overflow-y: auto; min-width: 0; margin-top: 4px; scrollbar-color: var(--muted) var(--surface); }
.turnlog-body p { margin: 4px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.turnlog-body .tool-line { margin: 3px 0; }
@media (max-width: 640px) { .done-row { grid-template-columns: 1fr; } .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
<div id="drain" role="status" class="stat drain-banner" hidden></div>
<div id="config-health" role="status" class="stat drain-banner" hidden></div>
<header>
  <span class="dot" id="dot"></span><span class="brand">orch</span><nav aria-label="Main" style="display:inline-flex;border:thin solid var(--line);border-radius:.5rem;overflow:hidden;flex:none;font-weight:600"><a href="/" aria-current="page" style="padding:.375rem .875rem;text-decoration:none;background:var(--accent-soft);color:var(--accent)">Board</a><a href="/tasks" style="padding:.375rem .875rem;text-decoration:none;color:var(--ink-2)">Tasks</a></nav>
  <div class="summary" id="summary"></div>
  <span class="muted" id="status">loading…</span>
  <span class="stat" id="paused" hidden></span><span class="stat" id="rtk" hidden></span><span class="stat" id="jev" hidden></span><span class="stat" id="brightdata" hidden></span>
</header>
<details class="sec" id="secLeads" open><summary>Lead</summary><div class="grid" id="leads"></div></details>
<section id="chat" aria-labelledby="chatTitle">
<details class="sec" id="secChat" open><summary id="chatTitle">Chat</summary>
  <div class="card">
    <div id="chatHandles" class="muted">Live handles: loading…</div>
    <div id="chatReadStatus" class="muted" role="status"></div>
    <div id="chatPosts" tabindex="0" aria-label="Chat posts"></div>
    <form id="chatForm">
      <label for="chatBody">Message</label>
      <textarea id="chatBody" rows="2" maxlength="1200" aria-describedby="chatCount" required></textarea>
      <div class="row">
        <span id="chatCount" class="muted">0 / 600</span>
        <label for="chatTo">To (empty = all)</label><input id="chatTo" type="text" aria-label="To, comma-separated handles; empty means all">
        <label><input id="chatWake" type="checkbox"> Wake · act now</label>
        <button id="chatSend" type="submit" disabled>Send</button>
      </div>
      <div id="chatSendStatus" role="status" class="muted"></div>
    </form>
    <form id="chatReleaseForm" class="row sect">
      <label for="chatReleaseHandle">Handle</label><input id="chatReleaseHandle" type="text" size="16" maxlength="64" required>
      <button id="chatRelease" type="submit">Release handle</button>
      <span id="chatReleaseStatus" role="status" class="muted"></span>
    </form>
  </div>
</details>
</section>
<details class="sec" id="secSeats" open><summary>Seats at work</summary><div class="grid" id="seats"></div></details>
<details class="sec" id="secMachines" open><summary>Machines</summary><div class="grid" id="machines"></div></details>
<details class="sec" id="secLimits" open><summary>Family load · week and month</summary><div class="grid small" id="limits"></div></details>
<details class="sec" id="finishedBox"><summary id="finishedTitle">Finished</summary><div id="finished"></div></details>
</main>
<script>
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };
const familyLogos = ${JSON.stringify(FAMILY_LOGOS)};
function familyLabel(tag, cls, key, name, prefix) {
  const group = el(tag, 'family-label');
  const label = el('span', cls);
  label.append(el('span', 'family-text', (prefix || '') + String(name)));
  const logo = key === 'astra' ? 'codex' : key;
  if (Object.hasOwn(familyLogos, logo)) {
    // Only our static registry is parsed; family/lead/seat data stays text via el/append.
    const svg = new DOMParser().parseFromString(familyLogos[logo], 'image/svg+xml').documentElement;
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const slot = el('span', 'family-logo');
    slot.append(document.importNode(svg, true));
    group.append(slot);
  }
  group.append(label);
  return group;
}
// Every section folds on its title; the browser keeps what the operator opened or closed.
for (const sec of document.querySelectorAll('details.sec')) {
  const key = 'orch.board.open.' + sec.id;
  let saved = null;
  try { saved = localStorage.getItem(key); } catch { /* storage refused: the section still folds */ }
  if (saved !== null) sec.open = saved === '1';
  sec.addEventListener('toggle', () => { try { localStorage.setItem(key, sec.open ? '1' : '0'); } catch { /* not remembered */ } });
}
// The transcript line's local HH:MM, and the stable nick tone: five palette classes, the operator accent (operator decision 14795).
const hhmm = (iso) => { const at = new Date(iso); return String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0'); };
const nickTone = (handle) => { let tone = 0; for (let index = 0; index < handle.length; index++) tone = (tone * 31 + handle.charCodeAt(index)) >>> 0; return 'c' + tone % 5; };
// Chat owns its polling and errors: neither feed waits for the other.
function startChat() {
  const panel = document.getElementById('chat');
  if (!panel) return;
  const box = document.getElementById('chatPosts');
  const handlesLine = document.getElementById('chatHandles');
  const readStatus = document.getElementById('chatReadStatus');
  const sendStatus = document.getElementById('chatSendStatus');
  const form = document.getElementById('chatForm');
  const body = document.getElementById('chatBody');
  const to = document.getElementById('chatTo');
  const wake = document.getElementById('chatWake');
  const send = document.getElementById('chatSend');
  let stopped = false, reading = false, sending = false, refreshPending = false, readOnly = false;
  let timer;
  const counter = () => {
    const chars = Array.from(body.value);
    if (chars.length > 600) body.value = chars.slice(0, 600).join('');
    document.getElementById('chatCount').textContent = Math.min(chars.length, 600) + ' / 600';
    send.disabled = sending || !body.value.length;
  };
  async function pollChat() {
    if (stopped || reading) return;
    clearTimeout(timer);
    reading = true;
    refreshPending = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/api/chat', { cache: 'no-store', signal: controller.signal });
      if (response.status === 404) {
        stopped = true;
        panel.hidden = true;
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Chat HTTP ' + response.status);
      readOnly = data.readOnly === true;
      form.hidden = releaseForm.hidden = readOnly;
      const handles = data.handles.map((binding) => binding.handle);
      // The daemon's liveness fact for the panel: how many /chat/wake polls it holds right now.
      handlesLine.textContent = 'Live handles: ' + (handles.join(', ') || 'none')
        + (typeof data.watchers === 'number' ? ' · ' + data.watchers + ' watching' : '');
      const bottom = box.scrollHeight - box.clientHeight - box.scrollTop <= 1;
      const top = box.scrollTop;
      const rows = data.posts.map((post) => {
        // Stacked transcript (operator decision 14892): time and author above the message, receipts a
        // wrapping footer of handle and state. The feed's optional receipts detail
        // ({ handle, state, delivered_at, confirmed_at }, named for the chat_receipts table) overrides the
        // derived words — a later slice feeds queued and asleep states through it.
        const row = el('div', 'chat-post');
        const broadcast = post.to === 'all' || (Array.isArray(post.to) && post.to.includes('all'));
        const detail = new Map(Array.isArray(post.receipts)
          ? post.receipts.filter((receipt) => receipt && typeof receipt.handle === 'string').map((receipt) => [receipt.handle, receipt])
          : []);
        const meta = el('span', 'chat-meta');
        meta.append(el('span', 'chat-time mono', hhmm(post.at)), ' ',
          el('span', 'chat-nick ' + (post.author === '${RESERVED_HANDLE}' ? 'chat-accent' : 'chat-' + nickTone(post.author)), post.author));
        if (post.wake) { const mark = el('span', 'chat-wake', '⚑'); mark.title = 'wake'; meta.append(' ', mark); }
        row.append(meta);
        const text = el('span', 'chat-text');
        if (post.to !== null) text.append(el('span', 'chat-to mono', (broadcast ? 'all' : post.to.join(', ')) + ':'));
        text.append(el('span', 'chat-body', post.body));
        row.append(text);
        if (post.to !== null) {
          const recipients = broadcast
            ? [...new Set([...handles.filter((handle) => handle !== post.author), ...post.delivered, ...post.confirmed, ...detail.keys()])]
            : post.to;
          const receipts = el('footer', 'chat-receipts mono');
          receipts.setAttribute('aria-label', 'Delivery receipts');
          recipients.forEach((handle) => {
            const receipt = detail.get(handle);
            const state = receipt && typeof receipt.state === 'string' && receipt.state ? receipt.state
              : post.confirmed.includes(handle) ? 'read' : post.delivered.includes(handle) ? 'delivered' : 'pending';
            const tooltip = [handle + ': ' + state];
            if (receipt && typeof receipt.delivered_at === 'string' && Number.isFinite(Date.parse(receipt.delivered_at))) tooltip.push('delivered ' + hhmm(receipt.delivered_at));
            if (receipt && typeof receipt.confirmed_at === 'string' && Number.isFinite(Date.parse(receipt.confirmed_at))) tooltip.push('confirmed ' + hhmm(receipt.confirmed_at));
            const entry = el('span', 'chat-rc');
            entry.append(el('span', 'chat-rc-handle', handle), ' · ', el('span', 'chat-rc-state', state));
            entry.title = tooltip.join(' · ');
            receipts.append(entry);
          });
          row.append(receipts);
        }
        return row;
      });
      box.replaceChildren(...(rows.length ? rows : [el('div', 'empty', 'no posts')]));
      box.scrollTop = bottom ? box.scrollHeight : top;
      readStatus.textContent = '';
    } catch (error) {
      readStatus.textContent = 'Chat unavailable: ' + error.message;
    } finally {
      clearTimeout(timeout);
      reading = false;
      if (refreshPending && !stopped) void pollChat();
      else if (!stopped) timer = setTimeout(pollChat, 3000);
    }
  }
  body.addEventListener('input', counter);
  body.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (stopped || readOnly || sending || !body.value.length) return;
    if (Array.from(body.value).length > 600) {
      sendStatus.textContent = 'Message must be at most 600 characters.';
      return;
    }
    const input = { body: body.value, to: to.value.trim() ? to.value.split(',').map((handle) => handle.trim()) : 'all', wake: wake.checked };
    sending = true;
    for (const control of [body, to, wake, send]) control.disabled = true;
    sendStatus.textContent = 'Sending…';
    try {
      const response = await fetch('/chat/post', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Orch-Chat': '1' }, body: JSON.stringify(input),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Chat HTTP ' + response.status);
      body.value = '';
      sendStatus.textContent = 'Sent';
      // A successful send must refresh even if an older snapshot is still in flight.
      refreshPending = true;
      void pollChat();
    } catch (error) { sendStatus.textContent = error.message; }
    finally {
      sending = false;
      for (const control of [body, to, wake]) control.disabled = false;
      counter();
    }
  });
  // Release is a separate operator action, also for handles without a live holder.
  const releaseForm = document.getElementById('chatReleaseForm');
  const releaseHandle = document.getElementById('chatReleaseHandle');
  const releaseButton = document.getElementById('chatRelease');
  const releaseStatus = document.getElementById('chatReleaseStatus');
  let releasing = false;
  releaseForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const handle = releaseHandle.value.trim();
    if (stopped || readOnly || releasing || !handle) return;
    releasing = true;
    releaseHandle.disabled = releaseButton.disabled = true;
    releaseStatus.textContent = 'Checking live session…';
    try {
      // Fetch at confirmation time, not from the last background snapshot.
      const snapshot = await fetch('/api/chat', { cache: 'no-store' });
      const feed = await snapshot.json();
      if (!snapshot.ok) throw new Error(feed.error || 'Chat HTTP ' + snapshot.status);
      const binding = feed.handles.find((entry) => entry.handle === handle);
      if (!window.confirm('Release handle "' + handle + '" (' + (binding ? 'live session: ' + binding.session : 'no live session') + ')?')) {
        releaseStatus.textContent = '';
        return;
      }
      releaseStatus.textContent = 'Releasing…';
      const response = await fetch('/chat/release', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Orch-Chat': '1' }, body: JSON.stringify({ handle }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Chat HTTP ' + response.status);
      releaseHandle.value = '';
      releaseStatus.textContent = 'Released ' + data.handle;
      refreshPending = true;
      void pollChat();
    } catch (error) { releaseStatus.textContent = error.message; }
    finally {
      releasing = false;
      releaseHandle.disabled = releaseButton.disabled = false;
    }
  });
  void pollChat();
}
// Small values are exact ('0k' for a real 300-token saving is a lie); large ones compact.
const k = (t) => t >= 1e6 ? (t / 1e6).toFixed(2) + 'M' : t >= 1000 ? Math.round(t / 1000) + 'k' : String(t);
const usd = (n) => '$' + n.toFixed(9).replace(/0+$/, '').replace(/\\.$/, '');
const dur = (s) => s == null ? '' : s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's' : Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm';
const ago = (iso) => { if (!iso) return ''; const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return dur(s) + ' ago'; };
const tone = (pct, cuts) => pct == null ? 'var(--muted)' : pct >= cuts[2] ? 'var(--critical)' : pct >= cuts[1] ? 'var(--serious)' : pct >= cuts[0] ? 'var(--warning)' : 'var(--good)';

function gauge(label, pct, text) {
  const row = el('div', 'gauge');
  row.append(el('span', 'lbl', label));
  const bar = el('div', 'bar');
  if (pct != null) { const i = el('i'); i.style.width = Math.min(Math.max(pct, 0), 100) + '%'; i.style.background = tone(pct, [60, 80, 90]); bar.append(i); }
  row.append(bar, el('span', 'val', text));
  return row;
}

const gb = (n) => n >= 100 ? Math.round(n) : n.toFixed(1);

// One panel per machine (decision #12680): CPU, memory and disk bars; a machine with no reading yet says probing, a failed probe is an error line, never 0%.
function machine(m, seats) {
  const probing = !m.load;
  const failed = !probing && !m.load.ok;
  const c = el('div', 'card machine' + (failed ? ' err' : ''));
  const top = el('div', 'row');
  const h = el('span', 'host ' + (m.name === 'mac' ? 'local' : 'remote'), m.name);
  h.title = m.name === 'mac' ? 'this Mac' : 'host of hosts.json';
  top.append(h, el('span', 'title', m.name === 'mac' ? 'this Mac' : m.name));
  const active = seats.filter((s) => s.active && s.host === m.name).length;
  top.append(el('span', 'muted', (active ? active + ' active seat' + (active === 1 ? '' : 's') : 'no active seats') + (m.at ? ' · read ' + ago(m.at) : '')));
  c.append(top);
  if (probing) {
    c.append(el('div', 'muted', 'probing…'));
  } else if (failed) {
    c.append(el('div', 'errline', 'unreachable: ' + m.load.error));
  }
  // One grid per card: the rows share a single column template, so the tracks line up.
  const rows = el('div', 'gauges');
  if (!probing && !failed) {
    const l = m.load.load;
    rows.append(gauge('CPU', Math.round(l.cpuBusyPct), Math.round(l.cpuBusyPct) + '% · ' + l.cpus + ' cpus'));
    const memUsed = l.totalMemGb - l.freeMemGb, memPct = l.totalMemGb > 0 ? 100 * memUsed / l.totalMemGb : null;
    rows.append(gauge('MEM', memPct == null ? null : Math.round(memPct), (memPct == null ? '?' : Math.round(memPct)) + '% · ' + gb(memUsed) + ' of ' + gb(l.totalMemGb) + ' GB' + (m.memAt && m.memAt !== m.at ? ' · ' + ago(m.memAt) : '')));
  }
  if (m.disk && m.disk.ok) {
    const d = m.disk.disk, usedPct = d.totalGb > 0 ? 100 * (d.totalGb - d.freeGb) / d.totalGb : null;
    rows.append(gauge('DISK', usedPct == null ? null : Math.round(usedPct), (usedPct == null ? '?' : Math.round(usedPct)) + '% · ' + gb(d.freeGb) + ' GB free' + (m.diskAt && m.diskAt !== m.at ? ' · ' + ago(m.diskAt) : '')));
  }
  if (rows.firstChild) c.append(rows);
  if (m.disk && !m.disk.ok) {
    c.append(el('div', 'errline', 'disk unreadable: ' + m.disk.error));
  }
  return c;
}

function ring(pct, size, color, label, tip) {
  const stroke = Math.max(5, Math.round(size / 9)), r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ring'); svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', tip || label);
  const circle = (cls) => { const e = document.createElementNS(NS, 'circle'); e.setAttribute('cx', size / 2); e.setAttribute('cy', size / 2); e.setAttribute('r', r); e.setAttribute('fill', 'none'); e.setAttribute('stroke-width', stroke); if (cls) e.setAttribute('class', cls); return e; };
  svg.append(circle('track'));
  if (pct != null) {
    const arc = circle(); arc.setAttribute('stroke', color); arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke-dasharray', (c * Math.min(Math.max(pct, 0), 100) / 100) + ' ' + c);
    arc.setAttribute('transform', 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')');
    svg.append(arc);
  }
  const t = document.createElementNS(NS, 'text'); t.setAttribute('x', '50%'); t.setAttribute('y', '50%'); t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'central');
  if (size >= 80) t.style.fontSize = '18px';
  t.textContent = label; svg.append(t);
  if (tip) { const title = document.createElementNS(NS, 'title'); title.textContent = tip; svg.append(title); }
  return svg;
}

const fill = (id, nodes, empty) => document.getElementById(id).replaceChildren(...(nodes.length ? nodes : [el('div', 'empty', empty)]));

function lead(l, instruments) {
  const c = el('div', 'card' + (l.over ? ' alert' : ''));
  const box = el('div', 'ringbox');
  box.append(ring(l.percent, 88, tone(l.percent, [70, 85, 100]), l.percent + '%', k(l.tokens) + ' of the ' + k(l.limit) + ' /next limit'));
  const col = el('div', 'col');
  const top = el('div', 'row');
  top.append(familyLabel('span', 'chip', l.family, l.family === 'codex' ? 'Codex' : l.family === 'claude' ? 'Claude' : l.family), el('span', 'title', (l.cwd || '').split(/[\\\\/]/).filter(Boolean).slice(-2).join('/') || l.session));
  col.append(top, el('div', 'big', k(l.tokens) + ' / ' + k(l.limit)));
  col.append(el('div', 'muted', [l.model, l.window ? 'window ' + k(l.window) : null, 'active ' + ago(l.updated)].filter(Boolean).join(' · ')));
  col.append(el('div', 'muted mono', l.session));
  box.append(col); c.append(box);
  c.append(badges(l, instruments));
  if (l.over) c.append(el('div', 'next', 'Context past the limit: finish the step, write the handoff, run /next'));
  return c;
}

// The machine a seat runs on sits beside its role · family: 'mac' is this Mac (placement.ts seatHost), any other name a remote host.
function hostChip(s) {
  if (!s.host) return null;
  const b = el('span', 'host ' + (s.host === 'mac' ? 'local' : 'remote'), s.host);
  b.title = 'runs on ' + s.host;
  return b;
}

// One labelled row per group (operator 2026-10-01): skills, tools, mcp, pi. An empty group is not drawn.
const MCP_INSTRUMENTS = ['codegraph', 'memoryctl'];
// The tools a pinned edit extension registers; their calls count toward the extension's badge, not the tool row.
const EXTENSION_TOOLS = { 'hashline-edit': ['tool:replace', 'tool:insert', 'tool:undo_last_change', 'tool:replace_within', 'tool:copy', 'tool:move', 'tool:anchor_grep'], 'codex-edit': ['edit'] };

function badges(s, instruments) {
  const kinds = s.kinds || {};
  const root = el('div', 'badges');
  const sect = (label) => { const row = el('div', 'sect'); row.append(el('span', 'sect-label', label)); return row; };
  const close = (row) => { if (row.children.length > 1) root.append(row); };
  const extensions = s.extensions || [];
  const owned = new Set(extensions.flatMap((name) => EXTENSION_TOOLS[name] || []));

  // The seat's skills: an inlined one is delivered; a listed one lights when the seat read its SKILL.md.
  const wrap = sect('skills');
  if (s.skills) {
    // A fallback may mean Jev failed, was not asked, or memory was unavailable. Knowledge
    // sections are always the map render (operator decision #12450), so knowledge=map is no fallback.
    const r = s.skills.router;
    if (r && (r.skills === 'map' || r.lessons === 'unavailable')) {
      const b = el('span', 'badge missing', 'no jev');
      b.title = [r.skills === 'map' && 'skills: map (' + (r.skillReason ?? 'unknown') + ')',
        r.lessons === 'unavailable' && 'lessons: unavailable (' + (r.lessonReason ?? 'unknown') + ')']
        .filter(Boolean).join('; ') + ': routing fallback';
      wrap.append(b);
    }
    for (const name of s.skills.required) { const b = el('span', 'badge skill used', name); b.title = 'skill inlined in the brief'; wrap.append(b); }
    for (const name of s.skills.listed) {
      const n = kinds['skill:' + name] || 0;
      const b = el('span', 'badge skill ' + (n ? 'used' : 'unused'), name);
      b.title = n ? 'SKILL.md read' : 'routed to this seat, not read';
      wrap.append(b);
    }
  }
  // A knowledge read is counted for leads and seats without skills metadata too.
  if (kinds.knowledge) { const kb = el('span', 'badge used', 'knowledge'); kb.append(el('b', '', kinds.knowledge)); kb.title = 'domain knowledge.md read'; wrap.append(kb); }
  close(wrap);

  // Tools: our shell instruments that were used, the provider's own tools, and one shell badge.
  // rtk is red only where rtk's own registry had a filter and the command ran without it
  // (operator, 2026-09-23, #10523): a shell full of node and sed owes rtk nothing.
  const tools = sect('tools');
  const missed = kinds['rtk-missed'] || 0;
  // A lead's rtk verdict comes from an rtk rewrite call off the event loop (leads.ts): a call
  // still waiting for it shows as pending, never as a miss and never as zero.
  const pending = kinds['rtk-pending'] || 0;
  for (const name of instruments.filter((name) => !MCP_INSTRUMENTS.includes(name))) {
    const n = kinds[name] || 0;
    const waiting = name === 'rtk' && pending;
    const bad = name === 'rtk' && missed;
    if (!n && !waiting && !bad) continue;
    const b = el('span', 'badge ' + (bad ? 'missing' : n ? 'used' : 'other'), name);
    if (n) b.append(el('b', '', n));
    if (bad) b.append(el('b', '', missed + ' missed'));
    if (waiting) b.append(el('b', '', pending + ' pending'));
    b.title = bad ? missed + ' shell calls rtk has a filter for ran without it' : waiting ? pending + ' shell calls still waiting for an rtk verdict' : n + ' calls';
    tools.append(b);
  }
  const rest = Object.entries(kinds).filter(([key]) => !instruments.includes(key) && !owned.has(key) && key !== 'shell' && key !== 'rtk-missed' && key !== 'rtk-pending' && key !== 'knowledge' && !key.startsWith('skill:')).sort((a, b) => b[1] - a[1]);
  for (const [key, n] of rest.filter(([key]) => !key.startsWith('mcp:') && !key.startsWith('sh:'))) {
    const b = el('span', 'badge other', key.replace(/^tool:/, ''));
    b.append(el('b', '', n));
    b.title = key.startsWith('tool:') ? 'provider tool' : 'built-in tool';
    tools.append(b);
  }
  // Shell programs outside our instruments are one badge; the programs are its tooltip.
  const programs = rest.filter(([key]) => key.startsWith('sh:'));
  if (programs.length) {
    const b = el('span', 'badge other', 'shell');
    b.append(el('b', '', programs.reduce((sum, [, n]) => sum + n, 0)));
    b.title = 'shell programs, not through our instruments: ' + programs.map(([key, n]) => key.slice(3) + ' ' + n).join(', ');
    tools.append(b);
  }
  close(tools);

  const mcp = sect('mcp');
  for (const name of MCP_INSTRUMENTS) {
    const n = kinds[name] || 0;
    if (!n) continue;
    const b = el('span', 'badge mcp', name); b.append(el('b', '', n)); b.title = n + ' calls (MCP tool or CLI)'; mcp.append(b);
  }
  for (const [key, n] of rest.filter(([key]) => key.startsWith('mcp:'))) { const b = el('span', 'badge mcp', key.slice(4)); b.append(el('b', '', n)); b.title = 'MCP server ' + key.slice(4); mcp.append(b); }
  close(mcp);

  // Pi extensions orch loaded into the session; an edit extension lights when its tools were called.
  const pi = sect('pi');
  for (const name of extensions) {
    const mine = EXTENSION_TOOLS[name];
    const n = mine ? mine.reduce((sum, key) => sum + (kinds[key] || 0), 0) : 0;
    const b = el('span', 'badge ' + (!mine ? 'other' : n ? 'used' : 'unused'), name);
    if (n) b.append(el('b', '', n));
    b.title = !mine ? 'Pi extension loaded for this seat' : n ? n + ' calls of its tools' : 'Pi extension loaded, its tools not called yet';
    pi.append(b);
  }
  close(pi);
  return root;
}

// Who asked whom (scout-request.ts): a scout names its caller; a caller lists its scouts, closed ones included.
function lineage(s) {
  if (!s.parent && !s.scouts.length) return null;
  const wrap = el('div', 'badges flat');
  if (s.parent) { const b = el('span', 'badge used mono', 'for ' + s.parent); b.title = 'the seat that asked for this scout'; wrap.append(b); }
  if (s.scouts.length) {
    const live = s.scouts.some((x) => x.status === 'running' || x.status === 'queued' || x.status === 'provisioning');
    const b = el('span', live ? 'accent' : 'muted', 'asked scout ' + s.scouts.length);
    b.title = s.scouts.map((x) => x.id + ' · ' + x.family + ' · ' + x.status).join('\\n');
    wrap.append(b);
  }
  return wrap;
}

// A seat's running turn as a folded chat (task 2883): one panel element per seat id, reattached to
// each rebuilt card, so its open state survives replaceChildren. A browser drops a moved element's
// scroll offset, so the panel keeps its own (follow the newest entry, or the reader's place) and
// restores it after each rebuild and each read. It fetches only while
// open; one request at a time — the next 3 s poll is scheduled after the earlier one ends, and a
// request is aborted after 20 s. Everything renders through textContent (el), never as markup.
const turnPanels = new Map();
function turnPanel(s) {
  if (!s.turn) return null;
  let kept = turnPanels.get(s.id);
  if (!kept) {
    const panel = el('details', 'turnlog');
    panel.append(el('summary', '', 'turn'));
    const trimmedLine = el('div', 'muted mono');
    trimmedLine.hidden = true;
    const body = el('div', 'turnlog-body');
    body.tabIndex = 0;
    body.setAttribute('aria-label', 'Live turn log');
    const status = el('div', 'muted');
    panel.append(trimmedLine, body, status);
    const state = { turn: null, cursor: 0, timer: null, reading: false, nodes: new Map(), follow: true, top: 0 };
    body.addEventListener('scroll', () => {
      state.follow = body.scrollHeight - body.clientHeight - body.scrollTop <= 1;
      state.top = body.scrollTop;
    });
    const restore = () => { if (panel.open && panel.isConnected) body.scrollTop = state.follow ? body.scrollHeight : state.top; };
    const render = (data) => {
      // The panel holds only what the server still holds: entries it trimmed leave the DOM too.
      if (data.trimmed) {
        for (const [seq, node] of state.nodes) if (seq <= data.trimmed) { node.remove(); state.nodes.delete(seq); }
      }
      for (const item of data.entries) {
        let node = state.nodes.get(item.seq);
        if (!node) {
          node = item.kind === 'tool' ? el('div', 'mono tool-line') : el('p', item.kind === 'thought' ? 'muted' : undefined);
          state.nodes.set(item.seq, node);
          body.append(node);
        }
        node.textContent = item.kind === 'tool'
          ? item.name + ' · ' + item.status + (item.args === undefined ? '' : ' · ' + item.args)
          : item.text;
      }
      trimmedLine.hidden = !data.trimmed;
      if (data.trimmed) trimmedLine.textContent = data.trimmed + ' oldest entries trimmed';
      status.textContent = data.running ? '' : (state.nodes.size ? 'turn ended' : 'no live log: the turn has not started or the daemon restarted');
      restore();
    };
    const poll = async () => {
      clearTimeout(state.timer);
      if (!panel.open || state.reading) return;
      state.reading = true;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const turn = state.turn;
      let again = false;
      try {
        const response = await fetch('/api/turn-live?turn=' + encodeURIComponent(turn) + '&after=' + state.cursor, { cache: 'no-store', signal: controller.signal });
        if (state.turn !== turn) { again = panel.open; return; } // stale: the seat moved on — restart for the current turn
        if (response.status === 404) {
          const gone = await response.json();
          status.textContent = 'live turn unavailable: ' + (gone && gone.error ? gone.error : 'not found');
          return;
        }
        const data = await response.json();
        if (state.turn !== turn) { again = panel.open; return; } // stale: the seat moved on — restart for the current turn
        state.cursor = data.next;
        render(data);
        again = data.running;
      } catch (error) {
        status.textContent = 'live read failed: ' + error.message;
        again = true;
      } finally {
        clearTimeout(timeout);
        state.reading = false;
        if (again && panel.open) state.timer = setTimeout(poll, 3000);
      }
    };
    panel.addEventListener('toggle', () => { if (panel.open) { restore(); void poll(); } else clearTimeout(state.timer); });
    kept = { panel, state, body, trimmedLine, status, poll, restore };
    turnPanels.set(s.id, kept);
  }
  if (kept.state.turn !== s.turn) {
    clearTimeout(kept.state.timer);
    kept.state.turn = s.turn;
    kept.state.cursor = 0;
    kept.state.nodes.clear();
    kept.state.follow = true;
    kept.state.top = 0;
    kept.body.replaceChildren();
    kept.trimmedLine.hidden = true;
    kept.status.textContent = '';
    if (kept.panel.open) void kept.poll();
  }
  return kept.panel;
}

function seat(s, instruments) {
  const c = el('div', 'card');
  const top = el('div', 'row');
  const st = s.turnStatus || s.status;
  top.append(...[familyLabel('span', 'chip', s.family, s.family, s.role + ' · '), hostChip(s), el('span', 'state ' + st, st)].filter(Boolean));
  if (s.queued) top.append(el('span', 'muted', '+' + s.queued + ' queued'));
  // The title gets its own line and wraps: in the header row it was cut to a few characters.
  c.append(top, el('div', 'title', s.title));
  const asked = lineage(s);
  if (asked) c.append(asked);
  const meta = el('div', 'meta');
  meta.append(el('span', 'mono', (s.model || 'default model') + ' · effort ' + (s.effort || 'default')), el('span', '', dur(s.seconds)));
  if (s.worktree && s.worktree.files) meta.append(el('span', 'mono', s.worktree.files + ' files · ' + (s.worktree.stat || '')));
  c.append(meta, badges(s, instruments));
  if (s.flags.length) { const ul = el('ul', 'flags'); for (const f of s.flags) ul.append(el('li', '', f)); c.append(ul); }
  const liveTurn = turnPanel(s);
  if (liveTurn) c.append(liveTurn);
  return c;
}

function finishedRow(s, instruments) {
  const r = el('div', 'done-row');
  const name = el('div', 'col');
  const line = el('div', 'row');
  line.append(...[familyLabel('span', 'muted', s.family, s.family, s.role + ' · '), hostChip(s), el('span', 'muted', [s.parent ? 'for ' + s.parent : null, s.scouts.length ? 'scouts ' + s.scouts.map((x) => x.family).join(', ') : null, s.model || 'default model', s.effort || 'default', ago(s.ended)].filter(Boolean).join(' · '))].filter(Boolean));
  name.append(el('span', 'title', s.title), line);
  r.append(name, el('span', 'verdict ' + (s.verdict || ''), s.verdict || s.turnStatus || s.status), el('span', 'muted', (s.findings != null ? s.findings + ' findings · ' : '') + s.tools + ' calls'), badges(s, instruments));
  return r;
}


function resetLabel(iso) {
  if (!iso) return '';
  const remaining = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(remaining)) return '';
  if (remaining <= 0) return 'reset passed, reading stale';
  const minutes = Math.ceil(remaining / 60000);
  return 'reset ' + (minutes >= 1440 ? Math.floor(minutes / 1440) + 'd ' + Math.floor(minutes % 1440 / 60) + 'h' : minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm' : minutes + 'm');
}

function family(l) {
  const windows = l.readings || [];
  const driving = l.budget;
  const worst = driving ? driving.used : null;
  const c = el('div', 'card fam');
  const tip = windows.map((w) => w.window + ' ' + Math.round(w.used) + '%' + (w.resetsAt ? ', resets ' + new Date(w.resetsAt).toLocaleString() : '')).join('\\n') || l.unknown || l.stale || '';
  c.append(ring(worst == null ? null : Math.round(worst), 64, tone(worst, [50, 70, 90]), worst == null ? '?' : Math.round(worst) + '%', tip));
  c.append(el('div', 'name', l.family));
  if (l.resets === null) {
    const unknown = el('div', 'muted', 'resets: unknown');
    unknown.title = l.resetsError || 'reset inventory not read yet';
    c.append(unknown);
  } else if (l.resets?.length) {
    const counts = new Map();
    l.resets.forEach((entry) => counts.set(entry.scope, (counts.get(entry.scope) || 0) + entry.available));
    c.append(el('div', 'mono', 'resets: ' + ['week', '5h', 'both'].filter((scope) => counts.has(scope))
      .map((scope) => scope + ' ' + counts.get(scope)).join(' · ')));
  }
  c.append(el('div', 'muted', windows.map((w) => { const reset = w.window === driving?.window ? resetLabel(w.resetsAt) : ''; return (w.window === driving?.window ? 'budget ' : '') + w.window + ' ' + Math.round(w.used) + '%' + (reset ? ' (' + reset + ')' : ''); }).join(' · ') || (l.unknown ? 'unreadable' : '')));
  if (l.quotaError) c.append(el('div', 'verdict REQUEST_CHANGES', 'quota ran out'));
  if (l.outageError) c.append(el('div', 'verdict REQUEST_CHANGES', 'provider outage · back off 20 min'));
  if (l.authError) c.append(el('div', 'verdict REQUEST_CHANGES', 'auth failure · ranked last 60 min'));
  if (l.ageMinutes != null) c.append(el('div', 'muted', 'read ' + l.ageMinutes + ' min ago'));
  if (l.stale) c.append(el('div', 'muted', 'last good reading'));
  return c;
}

async function tick() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch('/api/dashboard', { cache: 'no-store', signal: controller.signal });
    const d = await r.json();
    const drain = document.getElementById('drain');
    drain.hidden = !d.draining;
    // A compact badge; the detail is its tooltip (operator 2026-09-29).
    drain.textContent = d.draining ? 'DRAIN · ' + d.draining.running.length : '';
    drain.title = d.draining ? 'orch draining for a restart since ' + d.draining.since.slice(11, 16) + ' UTC · ' + d.draining.queued + ' queued · waiting on ' + d.draining.running.length + ' running turns (' + (d.draining.running.map((t) => t.seat + '/' + t.turn).join(', ') || 'none') + '). Queued turns start automatically after restart.' : '';
    const configBanner = document.getElementById('config-health');
    const configNotice = [];
    if (d.configError) {
      configNotice.push('Harness config rejected since ' + d.configError.since + ': ' + d.configError.message + '. ' +
        (d.configError.codeStale === true ? 'Run node ops/orchestrator/src/main.ts restart --when-idle.' : 'Fix ops/bootstrap/harness.config.json.'));
    }
    if (d.frozenProjectKeys && d.frozenProjectKeys.length) configNotice.push(d.frozenProjectKeys.join(', ') + ' changed since start; frozen until restart.');
    configBanner.hidden = configNotice.length === 0;
    configBanner.textContent = configNotice.join(' ');
    const working = d.seats.filter((s) => s.active);
    const finished = d.seats.filter((s) => !s.active).sort((a, b) => String(b.ended).localeCompare(String(a.ended)));
    const over = d.leads.filter((l) => l.over).length;
    const flagged = working.filter((s) => s.flags.length).length;
    const stats = [['working', working.length], ['finished', finished.length]].map(([label, n]) => { const s = el('span', 'stat'); s.append(el('b', '', n), document.createTextNode(' ' + label)); return s; });
    if (over) { const s = el('span', 'stat alert'); s.append(el('b', '', '/next'), document.createTextNode(' lead past the limit')); stats.push(s); }
    if (flagged) { const s = el('span', 'stat alert'); s.append(el('b', '', flagged), document.createTextNode(' flagged')); stats.push(s); }
    document.getElementById('summary').replaceChildren(...stats);
    const rtkStat = document.getElementById('rtk');
    if (d.rtk && d.rtk.saved > 0) {
      rtkStat.hidden = false;
      rtkStat.title = d.rtk.commands + ' rtk calls, token savings across ' + d.rtk.histories + (d.rtk.histories === 1 ? ' history' : ' histories') + ' on ' + (d.rtk.machines || 1) + ((d.rtk.machines || 1) === 1 ? ' machine' : ' machines') + (d.rtk.missing && d.rtk.missing.length ? '; no reading from ' + d.rtk.missing.join(', ') : '');
      rtkStat.replaceChildren(el('b', '', k(d.rtk.commands)), document.createTextNode(' calls · '), el('b', '', k(d.rtk.saved)), document.createTextNode(' rtk saved · ' + Math.round(d.rtk.pct) + '%'));
    } else {
      rtkStat.hidden = true;
    }
    const jevStat = document.getElementById('jev');
    const bdStat = document.getElementById('brightdata');
    bdStat.hidden = !d.brightdata;
    if (d.brightdata) {
      const b = d.brightdata;
      bdStat.replaceChildren(el('b', '', b.error ? 'bd ?' : 'bd $' + b.balance.toFixed(2)));
      bdStat.title = 'Bright Data ' + (b.error ? b.error + '; attempted ' : 'balance read ') + new Date(b.at).toLocaleString()
        + (!b.error && b.pendingCosts !== null ? '; pending cost $' + b.pendingCosts.toFixed(2) : '');
    }
    jevStat.hidden = !d.jev;
    if (d.jev) {
      const j = d.jev;
      const overspent = j.balance && j.remainingUsd < 0;
      jevStat.className = 'stat' + (overspent || j.days !== null && j.days < 2 ? ' alert' : '');
      jevStat.title = (j.balance ? 'Entered ' + usd(j.balance.usd) + ' at ' + new Date(j.balance.at).toLocaleString() + '; today ' + usd(j.todayUsd) + '; estimate from the last 7 days of spend' : 'Jev spend today; no balance entered')
        + (j.skippedRows ? '; ' + j.skippedRows + ' unreadable ledger rows skipped — spend is a lower bound' : '; 0 unreadable ledger rows');
      jevStat.replaceChildren(el('b', '', 'jev ' + (overspent ? 'overspent ≈' + usd(-j.remainingUsd) : j.balance ? '≈' + usd(j.remainingUsd) : usd(j.todayUsd) + ' today')),
        document.createTextNode(j.balance && !overspent ? ' · ' + (j.days === null ? 'days unknown' : j.days > 365 ? '>365 d' : '~' + j.days.toFixed(1) + ' d') : ''));
    }
    fill('leads', d.leads.map((l) => lead(l, d.instruments)), 'no lead active in the last 10 minutes');
    fill('seats', working.map((s) => seat(s, d.instruments)), 'no seat at work');
    for (const kept of turnPanels.values()) kept.restore();
    // A panel outlives its card only while its seat is still on the board.
    const boardSeatIds = new Set(d.seats.map((s) => s.id));
    for (const seatId of turnPanels.keys()) if (!boardSeatIds.has(seatId)) turnPanels.delete(seatId);
    fill('machines', (d.machines || []).map((m) => machine(m, d.seats)), 'no machines');
    const paused = document.getElementById('paused');
    paused.hidden = !(d.paused || []).length && !d.pausedError;
    paused.className = 'stat' + (d.pausedError ? ' alert' : '');
    paused.textContent = d.pausedError ? 'pause error: ' + d.pausedError : (d.paused || []).length ? 'paused: ' + d.paused.join(', ') : '';
    fill('limits', (d.limits || []).map(family), 'no load readings');
    document.getElementById('finishedTitle').textContent = 'Finished · ' + finished.length;
    document.getElementById('finished').replaceChildren(...finished.map((s) => finishedRow(s, d.instruments)));
    document.getElementById('finishedBox').style.display = finished.length ? '' : 'none';
    document.getElementById('dot').className = 'dot';
    const age = Date.now() - Date.parse(d.at);
    document.getElementById('status').textContent = 'v' + d.version + ' · ' + new Date(d.at).toLocaleTimeString()
      + (age > 15000 ? ' · board ' + Math.floor(age / 1000) + 's old' : '');
  } catch (e) {
    document.getElementById('dot').className = 'dot off';
    document.getElementById('status').textContent = 'daemon unreachable: ' + e.message;
  } finally {
    clearTimeout(timeout);
    setTimeout(tick, 3000);
  }
}
tick();
startChat();
</script>
</body>
</html>
`;
