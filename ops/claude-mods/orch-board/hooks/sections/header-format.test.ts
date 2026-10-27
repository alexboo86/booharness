import { expect, test } from 'claude-code/testing'
import { parseDashboard } from '../parse'
import { headerSvg } from '../svg/header'
import { palette } from '../svg/kinora'
import { dashboardText } from '../../tests/fixtures/payloads'

const assert = {
  equal(actual: unknown, expected: unknown): void { expect(actual).toBe(expected) },
  deepEqual(actual: unknown, expected: unknown): void { expect(actual).toEqual(expected) },
  ok(actual: unknown): void { expect(actual).toBeTruthy() },
  match(actual: string, expected: RegExp): void { expect(actual).toMatch(expected) },
  doesNotMatch(actual: string, expected: RegExp): void { expect(actual).not.toMatch(expected) },
}

import {
  boardAge,
  compactCount,
  drainBanner,
  formatUsd,
  formatUsd2,
  headerView,
  jevLine,
  LOADING_STATUS,
  pausedLine,
  rtkLine,
  summaryChips,
  unreachableText,
} from './header-format';

const AT = '2026-10-14T15:04:05.000Z';

test('Bright Data reaches the pane header as a dated USD balance or muted error, never a missing-value zero', () => {
  for (const [brightdata, label, detail] of [
    [null, null, null],
    [{ at: AT, balance: 12.34, pendingCosts: 0.56 }, 'bd $12.34', 'pending cost $0.56'],
    [{ at: AT, balance: 0, pendingCosts: null }, 'bd $0.00', null],
    [{ at: AT, balance: -1.5, pendingCosts: null }, 'bd $-1.50', null],
    [{ at: AT, error: 'HTTP 401' }, 'bd ? · HTTP 401', 'HTTP 401'],
    [{ at: AT, error: 'timeout' }, 'bd ? · timeout', 'timeout'],
  ] as const) {
    const parsed = parseDashboard(JSON.stringify({ ...JSON.parse(dashboardText), brightdata }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const view = headerView(parsed.value, null, Date.parse(AT));
    const svg = headerSvg(parsed.value, 800, Date.parse(AT)).svg;
    if (label === null) {
      assert.equal(view.brightdata, null);
      assert.doesNotMatch(svg, />bd /);
    } else {
      assert.equal(view.brightdata!.label, label);
      assert.ok(view.brightdata!.title.includes(new Date(AT).toLocaleString()));
      if (detail) assert.ok(view.brightdata!.title.includes(detail));
      assert.ok(svg.includes('>' + label + '</text>'));
      assert.ok(svg.includes('<title>' + view.brightdata!.title + '</title>'));
      const metric = svg.match(/<text\b[^>]*>bd [^<]*<\/text>/)![0];
      assert.ok(metric.includes('fill="' + palette.muted + '"'));
      if ('error' in brightdata!) assert.doesNotMatch(label, /\$/);
    }
  }
});

test('Bright Data dashboard envelope rejects non-record values instead of letting the pane format them', () => {
  for (const brightdata of [42, '12.34', [], false]) {
    const parsed = parseDashboard(JSON.stringify({ ...JSON.parse(dashboardText), brightdata }));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.error, 'brightdata is not an object or null');
  }
});

test('board age is a short duration and is blank when the clock is not a time', () => {
  const parsed = Date.parse(AT);
  assert.equal(boardAge(AT, parsed), '0s');
  assert.equal(boardAge(AT, parsed + 16_000), '16s');
  assert.equal(boardAge(AT, parsed + 60_000), '1m');
  assert.equal(boardAge(AT, parsed + 3_600_000), '1h');
  assert.equal(boardAge(AT, parsed - 5_000), '0s');
  assert.equal(boardAge('not-a-time', parsed), '');
});

test('daemon failure and the empty poll use the web board texts', () => {
  assert.equal(unreachableText('fetch failed'), 'daemon unreachable: fetch failed');
  assert.equal(LOADING_STATUS, 'loading…');
});

test('summary chips are working, finished, then flagged only when a working seat is flagged', () => {
  const seats = [
    { active: true, flags: [] },
    { active: true, flags: ['overlap'] },
    { active: false, flags: ['stale'] },
  ];
  assert.deepEqual(summaryChips(seats), [
    { key: 'working', bold: '2', rest: ' working', alert: false },
    { key: 'finished', bold: '1', rest: ' finished', alert: false },
    { key: 'flagged', bold: '1', rest: ' flagged', alert: true },
  ]);
  assert.deepEqual(summaryChips([]), [
    { key: 'working', bold: '0', rest: ' working', alert: false },
    { key: 'finished', bold: '0', rest: ' finished', alert: false },
  ]);
  assert.deepEqual(summaryChips([{ active: true, flags: [] }, { active: false, flags: ['historical'] }]), [
    { key: 'working', bold: '1', rest: ' working', alert: false },
    { key: 'finished', bold: '1', rest: ' finished', alert: false },
  ]);
});

test('rtk is hidden unless tokens were saved, and the title keeps the raw call count', () => {
  assert.equal(rtkLine(null), null);
  assert.equal(rtkLine({ saved: 0, pct: 10, histories: 1, commands: 3 }), null);
  assert.equal(rtkLine({ saved: -1, pct: 10, histories: 1, commands: 3 }), null);
  const line = rtkLine({ saved: 2_500_000, pct: 12.4, histories: 1, commands: 1500 });
  assert.equal(line!.label, 'rtk 2.50M · 12%');
  assert.equal(line!.title, '1500 rtk calls, token savings across 1 history on 1 machine'); // an old daemon payload without machines counts this one machine
  assert.equal(rtkLine({ saved: 398_140_000, pct: 69, histories: 2, commands: 226_000 })!.label, 'rtk 398.14M · 69%');
  assert.equal(
    rtkLine({ saved: 1, pct: 0.4, histories: 0, commands: 2 })!.label,
    'rtk 1 · 0%',
  );
  assert.equal(
    rtkLine({ saved: 1, pct: 0, histories: 0, commands: 2 })!.title,
    '2 rtk calls, token savings across 0 histories on 1 machine',
  );
});

test('the rtk title names every machine and the hosts with no reading; the label stays', () => {
  const line = rtkLine({ saved: 300, pct: 30, histories: 2, commands: 25, machines: 2, missing: [] });
  assert.equal(line!.label, 'rtk 300 · 30%'); // the label is unchanged by the multi-machine total
  assert.equal(line!.title, '25 rtk calls, token savings across 2 histories on 2 machines');
  assert.equal(
    rtkLine({ saved: 1, pct: 0, histories: 1, commands: 2, machines: 3, missing: ['host-a', 'host-b'] })!.title,
    '2 rtk calls, token savings across 1 history on 3 machines; no reading from host-a, host-b', // a failed host is named, never silently dropped
  );
  assert.equal(
    rtkLine({ saved: 1, pct: 0, histories: 1, commands: 2, machines: 1, missing: [] })!.title,
    '2 rtk calls, token savings across 1 history on 1 machine',
  );
});

test('jev spend matches the web board, including the days alert and the lower-bound title', () => {
  assert.equal(jevLine(null), null);
  const today = jevLine({ todayUsd: 0.042, balance: null, remainingUsd: null, days: null, skippedRows: 0 });
  assert.equal(today!.bold, 'jev $0.04 today');
  assert.equal(today!.rest, '');
  assert.equal(today!.alert, false);
  assert.equal(today!.title, 'Jev spend today; no balance entered; 0 unreadable ledger rows');

  const entered = '2026-10-01T12:00:00.000Z';
  const calm = jevLine({
    todayUsd: 1.5,
    balance: { usd: 10, at: entered },
    remainingUsd: 3.25,
    days: 2.04,
    skippedRows: 3,
  });
  assert.equal(calm!.bold, 'jev $3.25');
  assert.equal(calm!.rest, ' · ~2.0 d');
  assert.equal(calm!.alert, false);
  assert.equal(
    calm!.title,
    'Entered $10 at ' + new Date(entered).toLocaleString() + '; today $1.5; estimate from the last 7 days of spend; 3 unreadable ledger rows skipped — spend is a lower bound',
  );

  const short = jevLine({ todayUsd: 1, balance: { usd: 10, at: entered }, remainingUsd: 1, days: 1.96, skippedRows: 0 });
  assert.equal(short!.rest, ' · ~2.0 d');
  assert.equal(short!.alert, true);

  const unknown = jevLine({ todayUsd: 1, balance: { usd: 10, at: entered }, remainingUsd: 1, days: null, skippedRows: 0 });
  assert.equal(unknown!.rest, ' · days unknown');
  assert.equal(unknown!.alert, false);

  const long = jevLine({ todayUsd: 1, balance: { usd: 10, at: entered }, remainingUsd: 1, days: 365, skippedRows: 0 });
  assert.equal(long!.rest, ' · ~365.0 d');
  const capped = jevLine({ todayUsd: 1, balance: { usd: 10, at: entered }, remainingUsd: 1, days: 365.1, skippedRows: 0 });
  assert.equal(capped!.rest, ' · >365 d');

  const over = jevLine({ todayUsd: 4, balance: { usd: 1, at: entered }, remainingUsd: -1.5, days: 0, skippedRows: 0 });
  assert.equal(over!.bold, 'jev overspent $1.50');
  assert.equal(over!.rest, '');
  assert.equal(over!.alert, true);
});

test('paused band is family names only, and a pause error without names draws nothing', () => {
  assert.equal(pausedLine([], null), null);
  assert.equal(pausedLine([], ''), null);
  assert.deepEqual(pausedLine(['grok paused 1h: quota'], null), { text: 'grok', alert: false });
  assert.deepEqual(pausedLine(['a', 'b'], null), { text: 'a, b', alert: false });
  assert.deepEqual(pausedLine(['a'], 'unreadable'), { text: 'a', alert: true });
  assert.equal(pausedLine([], 'unreadable'), null);
});

test('drain badge counts running turns; the detail carries the start, the queue and the names', () => {
  assert.equal(drainBanner(null), null);
  const empty = drainBanner({ since: '2026-10-14T08:15:00.000Z', running: [], queued: 3 });
  assert.equal(empty!.badge, 'DRAIN · 0');
  assert.equal(
    empty!.detail,
    'orch draining for a restart since 08:15 UTC · 3 queued · waiting on 0 running turns (none). Queued turns start automatically after restart.',
  );
  const held = drainBanner({
    since: '2026-10-14T08:15:00.000Z',
    running: [{ seat: 'coder-a', turn: 'turn-1' }, { seat: 'coder-b', turn: 'turn-2' }],
    queued: 1,
  });
  assert.equal(held!.badge, 'DRAIN · 2');
  assert.match(held!.detail, /waiting on 2 running turns \(coder-a\/turn-1, coder-b\/turn-2\)/);
});

test('count and dollar compaction match the web board boundaries', () => {
  assert.equal(compactCount(300), '300');
  assert.equal(compactCount(999), '999');
  assert.equal(compactCount(1000), '1k');
  assert.equal(compactCount(1500), '2k');
  assert.equal(compactCount(999_999), '1000k');
  assert.equal(compactCount(1_000_000), '1.00M');
  assert.equal(formatUsd(1), '$1');
  assert.equal(formatUsd(1.5), '$1.5');
  assert.equal(formatUsd(0.042), '$0.042');
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd2(7.778638136), '$7.78');
  assert.equal(formatUsd2(0.042), '$0.04');
  assert.equal(formatUsd2(-1.5), '$1.50');
});

test('a failed poll turns the dot red and keeps the last chips; no board yet is loading or unreachable', () => {
  const data = {
    draining: null,
    version: '9',
    at: AT,
    seats: [{ active: true, flags: [] }],
    paused: [],
    pausedError: null,
    leads: [],
    rtk: null,
    jev: null,
    brightdata: null,
  };
  const failed = headerView(data, 'down', Date.parse(AT));
  assert.equal(failed.dot, 'error');
  assert.equal(failed.version, 'daemon unreachable: down');
  assert.equal(failed.chips[0]!.bold, '1');
  assert.equal(failed.chips[1]!.bold, '0');

  const loading = headerView(null, null, Date.parse(AT));
  assert.equal(loading.dot, 'success');
  assert.equal(loading.version, 'loading…');
  assert.equal(loading.age, '');
  assert.deepEqual(loading.chips, []);

  const firstFail = headerView(null, 'down', Date.parse(AT));
  assert.equal(firstFail.dot, 'error');
  assert.equal(firstFail.version, 'daemon unreachable: down');
  assert.deepEqual(firstFail.chips, []);
});
