import { familyLabel } from './family-format';

export function seatFamily(role: string, family: string) {
  return familyLabel(family, family, role + ' · ');
}

/**
 * Texts, colours, and order for Seats at work and Finished.
 * Same rules as the web board (ops/orchestrator/src/dashboard.ts seat card,
 * finishedRow, dur/ago, and the tick that splits active seats). Theme colour
 * names only: live accent is `claude` (no accent key), good is `success`,
 * critical is `error`, muted is `subtle`, remote host and flags are `warning`.
 */

export const SEATS_TITLE = 'Seats at work';
export const SEATS_EMPTY = 'no seat at work';
/** `<details id="secSeats" open>` */
export const SEATS_OPEN_BY_DEFAULT = true;
/** `<details id="finishedBox">` has no open attribute. */
export const FINISHED_OPEN_BY_DEFAULT = false;

export type StatusColor = 'claude' | 'success' | 'error' | 'subtle';
export type HostColor = 'claude' | 'warning';
export type VerdictColor = 'success' | 'error' | 'text';

const LIVE_STATUS = new Set(['running', 'queued', 'provisioning']);
const FAILED_STATUS = new Set(['error', 'failed', 'interrupted']);

/** Seconds, as the page's dur(): null is blank, under an hour keeps seconds. */
export function dur(seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}

/** `dur` plus " ago". Blank when iso is missing. `now` is injectable for tests. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return `${dur(seconds)} ago`;
}

/** Dot colour for `.state.<status>`. Unknown statuses stay muted, never a live colour. */
export function statusColor(status: string): StatusColor {
  if (LIVE_STATUS.has(status)) return 'claude';
  if (status === 'done') return 'success';
  if (FAILED_STATUS.has(status)) return 'error';
  return 'subtle';
}

export function stateLabel(turnStatus: string | null, status: string): string {
  return turnStatus || status;
}

/** mac is this Mac (accent); any other name is a remote host (warning). Blank draws nothing. */
export function hostColor(host: string): HostColor | null {
  if (!host) return null;
  return host === 'mac' ? 'claude' : 'warning';
}

export function queuedText(queued: number): string | null {
  return queued ? `+${queued} queued` : null;
}

export function modelEffort(model: string | null, effort: string | null): string {
  return `${model || 'default model'} · effort ${effort || 'default'}`;
}

export function toolCallsText(tools: number): string {
  return `${tools} ${tools === 1 ? 'call' : 'calls'}`;
}

/** Capture cards identify the artifact, not the operator's private directory. */
export function captureName(captures: string | null): string | null {
  return captures?.split(/[\\/]/).filter(Boolean).pop() || null;
}

/** Hidden when there is no worktree or it has no files, same as the page. */
export function worktreeText(worktree: { files: number; stat: string } | null): string | null {
  if (!worktree?.files) return null;
  return `${worktree.files} files · ${worktree.stat || ''}`;
}

export type ScoutCount = {
  label: string;
  tooltip: string;
  live: boolean;
};

export type LineageView = {
  parentLabel: string | null;
  scoutCount: ScoutCount | null;
};

export function scoutLive(status: string): boolean {
  return LIVE_STATUS.has(status);
}

/** Null when the seat has no parent and asked for no scouts. */
export function lineageOf(seat: {
  parent: string | null;
  scouts: readonly { id: string; family: string; status: string }[];
}): LineageView | null {
  if (!seat.parent && seat.scouts.length === 0) return null;
  return {
    parentLabel: seat.parent ? `for ${seat.parent}` : null,
    scoutCount: seat.scouts.length ? {
      label: `asked scout ${seat.scouts.length}`,
      tooltip: seat.scouts.map((scout) => `${scout.id} · ${scout.family} · ${scout.status}`).join('\n'),
      live: seat.scouts.some((scout) => scoutLive(scout.status)),
    } : null,
  };
}

export function findingsCalls(findings: number | null, tools: number): string {
  return `${findings != null ? `${findings} findings · ` : ''}${toolCallsText(tools)}`;
}

/** Class is the verdict only; a missing verdict stays plain text, not the fallback status colour. */
export function verdictColor(verdict: string | null): VerdictColor {
  if (verdict === 'APPROVE') return 'success';
  if (verdict === 'REQUEST_CHANGES') return 'error';
  return 'text';
}

export function verdictLabel(verdict: string | null, turnStatus: string | null, status: string): string {
  return verdict || turnStatus || status;
}

export function finishedTitle(count: number): string {
  return `Finished · ${count}`;
}

export function finishedIsHidden(count: number): boolean {
  return count === 0;
}

export function finishedMeta(seat: {
  parent: string | null;
  scouts: readonly { family: string }[];
  model: string | null;
  effort: string | null;
  ended: string | null;
}, now = Date.now()): string {
  return [
    seat.parent ? `for ${seat.parent}` : '',
    seat.scouts.length ? `scouts ${seat.scouts.map((scout) => scout.family).join(', ')}` : '',
    seat.model || 'default model',
    seat.effort || 'default',
    ago(seat.ended, now),
  ].filter((part) => part !== '').join(' · ');
}

export function sectionOpen(which: 'seats' | 'finished', open: boolean | undefined): boolean {
  if (open !== undefined) return open;
  return which === 'seats' ? SEATS_OPEN_BY_DEFAULT : FINISHED_OPEN_BY_DEFAULT;
}

/** Active seats, board order. */
export function workingSeats<T extends { active: boolean }>(seats: readonly T[]): T[] {
  return seats.filter((seat) => seat.active);
}

/**
 * Inactive seats, newest `ended` first. The page sorts `String(ended)`, so a
 * missing ended is the word "null" and sorts ahead of an ISO timestamp.
 */
export function finishedSeats<T extends { active: boolean; ended: string | null }>(seats: readonly T[]): T[] {
  return seats.filter((seat) => !seat.active).sort((a, b) => String(b.ended).localeCompare(String(a.ended)));
}
