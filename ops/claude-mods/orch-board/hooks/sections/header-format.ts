/**
 * Header strings, visibility and thresholds from the web board
 * (ops/orchestrator/src/dashboard.ts tick, the drain badge and its title,
 * summary chips, rtk, jev, paused, status age). A full Board is assignable:
 * every field is spelled as in Board and only the fields the header draws
 * are required.
 */

import type { BrightdataBalance } from '../../types';

export type HeaderSeat = {
  active: boolean;
  flags: readonly string[];
};

export type HeaderLead = {
  over: boolean;
};

export type HeaderDrain = {
  since: string;
  running: readonly { seat: string; turn: string }[];
  queued: number;
};

export type HeaderRtk = {
  saved: number;
  pct: number;
  histories: number;
  commands: number;
  /** Machines whose rtk answered this total (task 2750). Optional: an old daemon payload has none. */
  machines?: number;
  /** Hosts whose rtk read failed. Optional: an old daemon payload has none. */
  missing?: readonly string[];
};

export type HeaderJev = {
  todayUsd: number;
  balance: { usd: number; at: string } | null;
  remainingUsd: number | null;
  days: number | null;
  skippedRows: number;
};

export type HeaderData = {
  draining: HeaderDrain | null;
  version: string;
  at: string;
  seats: readonly HeaderSeat[];
  paused: readonly string[];
  pausedError: string | null;
  leads: readonly HeaderLead[];
  rtk: HeaderRtk | null;
  jev: HeaderJev | null;
  brightdata: BrightdataBalance | null;
};

export type SummaryChip = {
  key: 'working' | 'finished' | 'flagged';
  bold: string;
  rest: string;
  alert: boolean;
};
export type RtkView = {
  label: string;
  title: string;
};

export type JevView = {
  bold: string;
  rest: string;
  title: string;
  alert: boolean;
};

export type PausedView = {
  text: string;
  alert: boolean;
};

export type DrainView = {
  badge: string;
  detail: string;
};

export type HeaderView = {
  dot: 'success' | 'error';
  version: string;
  age: string;
  chips: SummaryChip[];
  paused: PausedView | null;
  rtk: RtkView | null;
  jev: JevView | null;
  brightdata: RtkView | null;
};

/** Small values stay exact; '0k' for a few hundred tokens would be a lie. */
export function compactCount(t: number): string {
  return t >= 1e6 ? (t / 1e6).toFixed(2) + 'M' : t >= 1000 ? Math.round(t / 1000) + 'k' : String(t);
}

/** Dollar text the web board's usd() prints: trim trailing zeros, then a trailing dot. */
export function formatUsd(n: number): string {
  return '$' + n.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
}

/** Header chip: two decimals, the figure the operator can read at a glance. */
export function formatUsd2(n: number): string {
  return '$' + (Math.round(Math.abs(n) * 100) / 100).toFixed(2);
}

export const LOADING_STATUS = 'loading…';

export function unreachableText(message: string): string {
  return 'daemon unreachable: ' + message;
}

/** Short age for the one header line. Invalid clocks draw nothing, never a zero. */
export function boardAge(at: string, now: number): string {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  return Math.floor(seconds / 3600) + 'h';
}

export function summaryChips(seats: readonly HeaderSeat[]): SummaryChip[] {
  const working = seats.filter((seat) => seat.active);
  const done = seats.filter((seat) => !seat.active).length;
  const flagged = working.filter((seat) => seat.flags.length).length;
  const chips: SummaryChip[] = [
    { key: 'working', bold: String(working.length), rest: ' working', alert: false },
    { key: 'finished', bold: String(done), rest: ' finished', alert: false },
  ];
  if (flagged) chips.push({ key: 'flagged', bold: String(flagged), rest: ' flagged', alert: true });
  return chips;
}

export function rtkLine(rtk: HeaderRtk | null): RtkView | null {
  if (!rtk || !(rtk.saved > 0)) return null;
  const machines = rtk.machines ?? 1; // an old daemon counted only itself
  const missing = rtk.missing ?? [];
  return {
    label: 'rtk ' + compactCount(rtk.saved) + ' · ' + Math.round(rtk.pct) + '%',
    title: rtk.commands + ' rtk calls, token savings across ' + rtk.histories + (rtk.histories === 1 ? ' history' : ' histories') + ' on ' + machines + (machines === 1 ? ' machine' : ' machines') + (missing.length ? '; no reading from ' + missing.join(', ') : ''),
  };
}

export function jevLine(jev: HeaderJev | null): JevView | null {
  if (!jev) return null;
  const overspent = jev.balance != null && jev.remainingUsd != null && jev.remainingUsd < 0;
  const bold = 'jev ' + (overspent
    ? 'overspent ' + formatUsd2(-(jev.remainingUsd as number))
    : jev.balance
      ? formatUsd2(jev.remainingUsd as number)
      : formatUsd2(jev.todayUsd) + ' today');
  const rest = jev.balance && !overspent
    ? ' · ' + (jev.days === null ? 'days unknown' : jev.days > 365 ? '>365 d' : '~' + jev.days.toFixed(1) + ' d')
    : '';
  const title = (jev.balance
    ? 'Entered ' + formatUsd(jev.balance.usd) + ' at ' + new Date(jev.balance.at).toLocaleString() + '; today ' + formatUsd(jev.todayUsd) + '; estimate from the last 7 days of spend'
    : 'Jev spend today; no balance entered')
    + (jev.skippedRows ? '; ' + jev.skippedRows + ' unreadable ledger rows skipped — spend is a lower bound' : '; 0 unreadable ledger rows');
  return { bold, rest, title, alert: overspent || (jev.days !== null && jev.days < 2) };
}

export function brightdataLine(balance: BrightdataBalance | null | undefined): RtkView | null {
  if (!balance) return null;
  return {
    label: balance.error !== undefined ? 'bd ? · ' + balance.error : 'bd $' + balance.balance.toFixed(2),
    title: 'Bright Data ' + (balance.error !== undefined ? balance.error + '; attempted ' : 'balance read ')
      + new Date(balance.at).toLocaleString()
      + (balance.error === undefined && balance.pendingCosts !== null ? '; pending cost $' + balance.pendingCosts.toFixed(2) : ''),
  };
}

/** Family token before the daemon's ` paused ` mark; a bare name is already a name. */
export function pausedName(entry: string): string {
  const mark = ' paused ';
  const at = entry.indexOf(mark);
  return (at === -1 ? entry : entry.slice(0, at)).trim();
}

/** Band only when families are paused. The text is names, never the reason sentence. */
export function pausedLine(paused: readonly string[], pausedError: string | null): PausedView | null {
  const names = paused.map(pausedName).filter(Boolean);
  if (!names.length) return null;
  return { text: names.join(', '), alert: pausedError != null };
}

export function drainBanner(drain: HeaderDrain | null): DrainView | null {
  if (!drain) return null;
  const names = drain.running.map((turn) => turn.seat + '/' + turn.turn).join(', ');
  return {
    badge: 'DRAIN · ' + drain.running.length,
    detail: 'orch draining for a restart since ' + drain.since.slice(11, 16) + ' UTC · ' + drain.queued + ' queued · waiting on ' + drain.running.length + ' running turns (' + (names || 'none') + '). Queued turns start automatically after restart.',
  };
}

/**
 * Last good chips stay up when the poll fails: the catch only replaces
 * the dot and the version line. No board yet is the static "loading…" row,
 * or the unreachable line when the first poll fails.
 */
export function headerView(data: HeaderData | null, unreachable: string | null | undefined, now: number): HeaderView {
  const failed = unreachable != null;
  return {
    dot: failed ? 'error' : 'success',
    version: failed ? unreachableText(unreachable) : data ? 'v' + data.version : LOADING_STATUS,
    age: !failed && data ? boardAge(data.at, now) : '',
    chips: data ? summaryChips(data.seats) : [],
    paused: data ? pausedLine(data.paused, data.pausedError) : null,
    rtk: data ? rtkLine(data.rtk) : null,
    jev: data ? jevLine(data.jev) : null,
    brightdata: data ? brightdataLine(data.brightdata) : null,
  };
}
