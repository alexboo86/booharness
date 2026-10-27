import { expect, test } from 'claude-code/testing'

const assert = {
  equal(actual: unknown, expected: unknown): void { expect(actual).toBe(expected) },
  deepEqual(actual: unknown, expected: unknown): void { expect(actual).toEqual(expected) },
  ok(actual: unknown): void { expect(actual).toBeTruthy() },
  match(actual: string, expected: RegExp): void { expect(actual).toMatch(expected) },
  doesNotMatch(actual: string, expected: RegExp): void { expect(actual).not.toMatch(expected) },
}

import {
  ago, familyPresentation, FAMILY_CUTS, MACHINE_CUTS, machinePresentation,
  barWidth, meterTone, resetLabel, type FamilyMeterInput, type MachineMeterInput,
} from './meters-format';

import { familySvg } from '../svg/family';
import { svgBoard } from '../../tests/fixtures/svg';

test('limits omit family marks and keep unknown family names escaped', () => {
  const known = familySvg({ ...svgBoard, limits: [{ ...svgBoard.limits[0]!, family: 'claude' }] }, 800, NOW).svg;
  assert.match(known, />claude</);
  assert.equal((known.match(/<svg\b/g) || []).length, 1);
  const unknown = familySvg({ ...svgBoard, limits: [{ ...svgBoard.limits[0]!, family: '<new>' as never }] }, 800, NOW).svg;
  assert.match(unknown, /&lt;new&gt;/);
  assert.equal((unknown.match(/<svg\b/g) || []).length, 1);
});

test('limits render banked counts in web order, unreadable with a tip, and omit absent programs', () => {
  const render = (extra: Partial<FamilyMeterInput>) => familySvg({ ...svgBoard, limits: [{ ...svgBoard.limits[0]!, ...extra } as typeof svgBoard.limits[number]] }, 800, NOW).svg;
  const counts = render({ resets: [
    { scope: '5h', available: 7, expiresAt: null },
    { scope: 'week', available: 1, expiresAt: null },
    { scope: 'week', available: 2, expiresAt: '2026-10-20T00:00:00Z' },
    { scope: 'both', available: 0, expiresAt: null },
  ] });
  const visible = [...counts.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map(match => match[1]).join(' ');
  assert.match(visible, /resets: week 3 · 5h 7 · both 0/);
  const unknown = render({ resets: null, resetsError: '<probe failed>' });
  assert.match(unknown, /resets: unknown/);
  assert.match(unknown, /<title>&lt;probe failed&gt;<\/title>/);
  assert.match(render({ resets: null }), /reset inventory not read yet/);
  assert.doesNotMatch(render({ resets: [] }), /resets:/);
  assert.doesNotMatch(render({}), /resets:/);
});

const NOW = Date.parse('2026-10-14T12:00:00Z');
const fresh = '2026-10-14T12:00:00Z';
const older = '2026-10-14T11:58:00Z';
const machine: MachineMeterInput = { name: 'mac', at: fresh, memAt: fresh, diskAt: fresh, load: null, disk: null };
const family: FamilyMeterInput = {
  family: 'codex', readings: null, budget: null, unknown: null, stale: null,
  ageMinutes: null, quotaError: null, outageError: null, authError: null,
};

test('machine and family threshold boundaries are inclusive and distinct', () => {
  for (const [cuts, cases] of [
    [MACHINE_CUTS, [[null, 'subtle'], [0, 'success'], [59.9, 'success'], [60, 'warning'], [79.9, 'warning'], [80, 'permission'], [89.9, 'permission'], [90, 'error'], [150, 'error']]],
    [FAMILY_CUTS, [[null, 'subtle'], [49.9, 'success'], [50, 'warning'], [69.9, 'warning'], [70, 'permission'], [89.9, 'permission'], [90, 'error']]],
  ] as const) {
    for (const [percent, expected] of cases) assert.equal(meterTone(percent, cuts), expected);
  }
});

test('ages preserve seconds/minutes/hours and never go negative', () => {
  for (const [seconds, expected] of [[0, '0s ago'], [59, '59s ago'], [60, '1m 00s ago'], [3599, '59m 59s ago'], [3600, '1h 00m ago'], [3660, '1h 01m ago']] as const) {
    assert.equal(ago(new Date(NOW - seconds * 1000).toISOString(), NOW), expected);
  }
  assert.equal(ago(new Date(NOW + 1000).toISOString(), NOW), '0s ago');
  assert.equal(ago(null, NOW), '');
});

test('reset labels round up and distinguish stale, invalid and absent resets', () => {
  for (const [milliseconds, expected] of [[1, 'reset 1m'], [60 * 60000, 'reset 1h 0m'], [61 * 60000, 'reset 1h 1m'], [1440 * 60000, 'reset 1d 0h'], [1501 * 60000, 'reset 1d 1h'], [0, 'reset passed, reading stale'], [-1, 'reset passed, reading stale']] as const) {
    assert.equal(resetLabel(new Date(NOW + milliseconds).toISOString(), NOW), expected);
  }
  assert.equal(resetLabel(null, NOW), '');
  assert.equal(resetLabel('unreadable', NOW), '');
});

test('probing and unreachable machines do not invent CPU or memory readings; disk remains independent', () => {
  const probing = machinePresentation({ ...machine, at: null }, [], NOW);
  assert.equal(probing.loadStatus, 'probing…');
  assert.equal(probing.activity, 'no active seats');
  assert.deepEqual(probing.gauges, []);
  const failed = machinePresentation({ ...machine, name: 'host-b', load: { ok: false, error: 'SSH timeout' }, disk: { ok: true, disk: { totalGb: 200, freeGb: 50 } } }, [], NOW);
  assert.equal(failed.failed, true);
  assert.equal(failed.title, 'host-b');
  assert.equal(failed.loadStatus, 'unreachable: SSH timeout');
  assert.deepEqual(failed.gauges, [{ label: 'DISK', percent: 75, text: '75% · 50.0 GB free' }]);
  const badDisk = machinePresentation({ ...machine, disk: { ok: false, error: 'access denied' } }, [], NOW);
  assert.equal(badDisk.diskError, 'disk unreadable: access denied');
  assert.deepEqual(badDisk.gauges, []);
});

test('machine gauges retain CPU/MEM/DISK order, rounding, GB precision and independent ages', () => {
  const loaded = { ...machine, memAt: older, diskAt: older,
    load: { ok: true, load: { cpuBusyPct: 59.6, cpus: 8, totalMemGb: 32, freeMemGb: 12 } },
    disk: { ok: true, disk: { totalGb: 1000, freeGb: 100.4 } },
  } satisfies MachineMeterInput;
  const seats = [{ host: 'mac', active: true }, { host: 'mac', active: false }, { host: 'host-b', active: true }];
  const view = machinePresentation(loaded, seats, NOW);
  assert.equal(view.title, 'this Mac');
  assert.equal(view.activity, '1 active seat · read 0s ago');
  assert.deepEqual(view.gauges, [
    { label: 'CPU', percent: 60, text: '60% · 8 cpus' },
    { label: 'MEM', percent: 63, text: '63% · 20.0 of 32.0 GB · 2m 00s ago' },
    { label: 'DISK', percent: 90, text: '90% · 100 GB free · 2m 00s ago' },
  ]);
  assert.equal(machinePresentation(loaded, [...seats, { host: 'mac', active: true }], NOW).activity, '2 active seats · read 0s ago');
  const equalAges = machinePresentation({ ...loaded, memAt: fresh, diskAt: fresh }, [], NOW);
  assert.equal(equalAges.gauges[1]?.text, '63% · 20.0 of 32.0 GB');
  assert.equal(equalAges.gauges[2]?.text, '90% · 100 GB free');
});

test('zero totals remain unknown while real zero usage remains zero', () => {
  const unknown = machinePresentation({ ...machine,
    load: { ok: true, load: { cpuBusyPct: 0, cpus: 1, totalMemGb: 0, freeMemGb: 0 } },
    disk: { ok: true, disk: { totalGb: 0, freeGb: 0 } },
  }, [], NOW);
  assert.deepEqual(unknown.gauges, [
    { label: 'CPU', percent: 0, text: '0% · 1 cpus' },
    { label: 'MEM', percent: null, text: '?% · 0.0 of 0.0 GB' },
    { label: 'DISK', percent: null, text: '?% · 0.0 GB free' },
  ]);
  assert.equal(familyPresentation({ ...family, budget: { window: 'week', used: 0, resetsAt: null } }, NOW).label, '0%');
});

test('family ring follows the budget, not the largest reading; windows preserve order and only budget shows reset', () => {
  const month = { window: 'month', used: 49.9, resetsAt: '2026-10-14T13:01:00Z' };
  const week = { window: 'week', used: 95, resetsAt: '2026-10-15T12:00:00Z' };
  const view = familyPresentation({ ...family, readings: [week, month], budget: month, ageMinutes: 0 }, NOW);
  assert.equal(view.percent, 50);
  assert.equal(view.tone, 'success');
  assert.equal(view.label, '50%');
  assert.equal(view.windows, 'week 95% · budget month 50% (reset 1h 1m)');
  assert.equal(view.age, 'read 0 min ago');
  assert.equal(view.tip, 'week 95%, resets ' + new Date(week.resetsAt).toLocaleString() + '\nmonth 50%, resets ' + new Date(month.resetsAt).toLocaleString());
});

test('family unknown and stale states retain warnings in quota/outage/auth order', () => {
  const view = familyPresentation({ ...family, unknown: 'quota probe denied', stale: 'token expired', ageMinutes: 23,
    quotaError: { at: fresh }, outageError: { at: fresh }, authError: { at: fresh },
  }, NOW);
  assert.equal(view.percent, null);
  assert.equal(view.label, '?');
  assert.equal(view.tone, 'subtle');
  assert.equal(view.tip, 'quota probe denied');
  assert.equal(view.windows, 'unreadable');
  assert.deepEqual(view.warnings, ['quota ran out', 'provider outage · back off 20 min', 'auth failure · ranked last 60 min']);
  assert.equal(view.age, 'read 23 min ago');
  assert.equal(view.stale, 'last good reading');
  const empty = familyPresentation(family, NOW);
  assert.equal(empty.windows, '');
  assert.equal(empty.age, '');
  assert.equal(empty.stale, '');
  assert.deepEqual(empty.warnings, []);
});

test('bar width is a clamped percent and unknown stays unset', () => {
  assert.equal(barWidth(null), null);
  assert.equal(barWidth(0), '0%');
  assert.equal(barWidth(37), '37%');
  assert.equal(barWidth(37.6), '38%');
  assert.equal(barWidth(120), '100%');
  assert.equal(barWidth(-12), '0%');
  assert.equal(barWidth(Number.NaN), null);
  assert.equal(barWidth(null) === barWidth(0), false);
});
