import { familyLabel } from './family-format';
import type { ResetInventory } from '../../types';

// Presentation contracts ported from dashboard.ts:602-671,844-867.
export type MachineMeterInput = {
  name: string;
  at: string | null;
  memAt: string | null;
  diskAt: string | null;
  load: { ok: true; load: { cpuBusyPct: number; cpus: number; totalMemGb: number; freeMemGb: number } } | { ok: false; error: string } | null;
  disk: { ok: true; disk: { totalGb: number; freeGb: number } } | { ok: false; error: string } | null;
};

export type WindowReading = { window: string; used: number; resetsAt: string | null };
export type FamilyMeterInput = {
  family: string;
  resets?: ResetInventory[] | null;
  resetsError?: string | null;
  readings: WindowReading[] | null;
  budget: WindowReading | null;
  unknown: string | null;
  stale: string | null;
  ageMinutes: number | null;
  quotaError: unknown;
  outageError: unknown;
  authError: unknown;
};

export type MeterTone = 'subtle' | 'success' | 'warning' | 'permission' | 'error';
export const MACHINE_CUTS = [60, 80, 90] as const;
export const FAMILY_CUTS = [50, 70, 90] as const;

export function meterTone(percent: number | null, cuts: readonly [number, number, number]): MeterTone {
  return percent == null ? 'subtle' : percent >= cuts[2] ? 'error'
    : percent >= cuts[1] ? 'permission' : percent >= cuts[0] ? 'warning' : 'success';
}

function duration(seconds: number): string {
  return seconds < 60 ? seconds + 's' : seconds < 3600
    ? Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's'
    : Math.floor(seconds / 3600) + 'h ' + String(Math.floor(seconds % 3600 / 60)).padStart(2, '0') + 'm';
}

export function ago(iso: string | null, now: number): string {
  return iso ? duration(Math.max(0, Math.round((now - Date.parse(iso)) / 1000))) + ' ago' : '';
}

export function resetLabel(iso: string | null, now: number): string {
  if (!iso) return '';
  const remaining = Date.parse(iso) - now;
  if (!Number.isFinite(remaining)) return '';
  if (remaining <= 0) return 'reset passed, reading stale';
  const minutes = Math.ceil(remaining / 60000);
  return 'reset ' + (minutes >= 1440
    ? Math.floor(minutes / 1440) + 'd ' + Math.floor(minutes % 1440 / 60) + 'h'
    : minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm' : minutes + 'm');
}

function gb(value: number): string | number {
  return value >= 100 ? Math.round(value) : value.toFixed(1);
}

export type Gauge = { label: 'CPU' | 'MEM' | 'DISK'; percent: number | null; text: string };

export function machinePresentation(machine: MachineMeterInput, seats: readonly { host: string; active: boolean }[], now: number) {
  const active = seats.filter((seat) => seat.active && seat.host === machine.name).length;
  const gauges: Gauge[] = [];
  if (machine.load?.ok) {
    const load = machine.load.load;
    const used = load.totalMemGb - load.freeMemGb;
    const memory = load.totalMemGb > 0 ? Math.round(100 * used / load.totalMemGb) : null;
    gauges.push({ label: 'CPU', percent: Math.round(load.cpuBusyPct), text: Math.round(load.cpuBusyPct) + '% · ' + load.cpus + ' cpus' });
    gauges.push({ label: 'MEM', percent: memory, text: (memory ?? '?') + '% · ' + gb(used) + ' of ' + gb(load.totalMemGb) + ' GB'
      + (machine.memAt && machine.memAt !== machine.at ? ' · ' + ago(machine.memAt, now) : '') });
  }
  if (machine.disk?.ok) {
    const disk = machine.disk.disk;
    const used = disk.totalGb > 0 ? Math.round(100 * (disk.totalGb - disk.freeGb) / disk.totalGb) : null;
    gauges.push({ label: 'DISK', percent: used, text: (used ?? '?') + '% · ' + gb(disk.freeGb) + ' GB free'
      + (machine.diskAt && machine.diskAt !== machine.at ? ' · ' + ago(machine.diskAt, now) : '') });
  }
  return {
    title: machine.name === 'mac' ? 'this Mac' : machine.name,
    activity: (active ? active + ' active seat' + (active === 1 ? '' : 's') : 'no active seats')
      + (machine.at ? ' · read ' + ago(machine.at, now) : ''),
    loadStatus: !machine.load ? 'probing…' : !machine.load.ok ? 'unreachable: ' + machine.load.error : '',
    failed: machine.load?.ok === false,
    gauges,
    diskError: machine.disk?.ok === false ? 'disk unreadable: ' + machine.disk.error : '',
  };
}

export function familyPresentation(load: FamilyMeterInput, now: number) {
  const windows = load.readings || [];
  const driving = load.budget;
  const worst = driving ? driving.used : null;
  const percent = worst == null ? null : Math.round(worst);
  const counts = new Map<string, number>();
  for (const entry of load.resets || []) counts.set(entry.scope, (counts.get(entry.scope) || 0) + entry.available);
  return {
    family: familyLabel(load.family),
    resets: load.resets === null ? 'resets: unknown' : counts.size
      ? 'resets: ' + ['week', '5h', 'both'].filter(scope => counts.has(scope)).map(scope => scope + ' ' + counts.get(scope)).join(' · ') : '',
    resetsTip: load.resets === null ? load.resetsError || 'reset inventory not read yet' : '',
    percent,
    // The web board colors the unrounded budget, but draws its rounded value.
    tone: meterTone(worst, FAMILY_CUTS),
    label: percent == null ? '?' : percent + '%',
    tip: windows.map((window) => window.window + ' ' + Math.round(window.used) + '%'
      + (window.resetsAt ? ', resets ' + new Date(window.resetsAt).toLocaleString() : '')).join('\n') || load.unknown || load.stale || '',
    windows: windows.map((window) => {
      const budget = window.window === driving?.window;
      const reset = budget ? resetLabel(window.resetsAt, now) : '';
      return (budget ? 'budget ' : '') + window.window + ' ' + Math.round(window.used) + '%'
        + (reset ? ' (' + reset + ')' : '');
    }).join(' · ') || (load.unknown ? 'unreadable' : ''),
    warnings: [load.quotaError ? 'quota ran out' : '', load.outageError ? 'provider outage · back off 20 min' : '',
      load.authError ? 'auth failure · ranked last 60 min' : ''].filter(Boolean),
    age: load.ageMinutes != null ? 'read ' + load.ageMinutes + ' min ago' : '',
    stale: load.stale ? 'last good reading' : '',
  };
}

/** Width of a Box bar. Unknown stays unset, never a zero-width stand-in. Clamped to 0–100. */
export function barWidth(percent: number | null): string | null {
  if (percent == null || !Number.isFinite(percent)) return null;
  return Math.round(Math.min(Math.max(percent, 0), 100)) + '%';
}
