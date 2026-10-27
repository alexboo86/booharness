import { expect, test } from 'claude-code/testing'

const assert = {
  equal(actual: unknown, expected: unknown): void { expect(actual).toBe(expected) },
  deepEqual(actual: unknown, expected: unknown): void { expect(actual).toEqual(expected) },
  ok(actual: unknown): void { expect(actual).toBeTruthy() },
  match(actual: string, expected: RegExp): void { expect(actual).toMatch(expected) },
  doesNotMatch(actual: string, expected: RegExp): void { expect(actual).not.toMatch(expected) },
}

import {
  ago,
  dur,
  findingsCalls,
  finishedIsHidden,
  finishedMeta,
  finishedSeats,
  finishedTitle,
  hostColor,
  lineageOf,
  modelEffort,
  queuedText,
  sectionOpen,
  statusColor,
  verdictColor,
  verdictLabel,
  workingSeats,
  worktreeText,
} from './seats-format';

import { seatsSvg } from '../svg/seats';
import { finishedSvg } from '../svg/finished';
import { svgBoard } from '../../tests/fixtures/svg';

for (const active of [true, false]) test((active ? 'seat' : 'finished') + ' family has a registry mark; unknown family stays escaped text', () => {
  const render = (family: string) => {
    const board = { ...svgBoard, seats: [{ ...svgBoard.seats[0]!, active, family }] };
    return active ? seatsSvg(board, 800).svg : finishedSvg(board, 800, NOW).svg;
  };
  const known = render('claude');
  assert.match(known, /<path d="M17\.3041/);
  assert.match(known, /<use href="#fam-claude"/);
  assert.ok(known.indexOf('<use href="#fam-claude"') < known.indexOf('>claude'));
  for (const family of ['<new>', '__proto__', 'codex" onload="x']) {
    const unknown = render(family);
    if (family === '<new>') assert.match(unknown, /&lt;new&gt;/);
    assert.equal((unknown.match(/<svg\b/g) || []).length, 1);
    assert.doesNotMatch(unknown, /<symbol\b|<use\b|<new>/);
  }
});

const NOW = Date.parse('2026-10-14T12:00:00Z');

test('duration matches the board dur()', () => {
  assert.equal(dur(null), '');
  assert.equal(dur(0), '0s');
  assert.equal(dur(59), '59s');
  assert.equal(dur(60), '1m 00s');
  assert.equal(dur(61), '1m 01s');
  assert.equal(dur(3599), '59m 59s');
  assert.equal(dur(3600), '1h 00m');
  assert.equal(dur(3661), '1h 01m');
});

test('ago is blank without a timestamp and clamps the future to 0s', () => {
  assert.equal(ago(null, NOW), '');
  assert.equal(ago('', NOW), '');
  assert.equal(ago('2026-10-14T11:59:01Z', NOW), '59s ago');
  assert.equal(ago('2026-10-14T11:59:00Z', NOW), '1m 00s ago');
  assert.equal(ago('2026-10-14T11:00:00Z', NOW), '1h 00m ago');
  assert.equal(ago('2026-10-14T12:05:00Z', NOW), '0s ago');
});

test('status dot colours are the page state classes, case-sensitive', () => {
  for (const status of ['running', 'queued', 'provisioning']) assert.equal(statusColor(status), 'claude');
  assert.equal(statusColor('done'), 'success');
  for (const status of ['error', 'failed', 'interrupted']) assert.equal(statusColor(status), 'error');
  assert.equal(statusColor('closed'), 'subtle');
  assert.equal(statusColor('Running'), 'subtle');
});

test('host chip: mac is local accent, any other name is remote, blank is omitted', () => {
  assert.equal(hostColor(''), null);
  assert.equal(hostColor('mac'), 'claude');
  assert.equal(hostColor('macbook'), 'warning');
  assert.equal(hostColor('win'), 'warning');
});

test('seat card texts: queued, model effort, worktree', () => {
  assert.equal(queuedText(0), null);
  assert.equal(queuedText(2), '+2 queued');
  assert.equal(modelEffort(null, null), 'default model · effort default');
  assert.equal(modelEffort('grok-4', 'high'), 'grok-4 · effort high');
  assert.equal(worktreeText(null), null);
  assert.equal(worktreeText({ files: 0, stat: 'clean' }), null);
  assert.equal(worktreeText({ files: 3, stat: 'dirty' }), '3 files · dirty');
  assert.equal(worktreeText({ files: 1, stat: '' }), '1 files · ');
});

test('lineage is omitted when empty; asked scouts become one count with full tooltip and any-live status', () => {
  assert.equal(lineageOf({ parent: null, scouts: [] }), null);
  const line = lineageOf({
    parent: 'coder-grok-1',
    scouts: [
      { id: 'scout-a', family: 'grok', status: 'running' },
      { id: 'scout-b', family: 'codex', status: 'done' },
    ],
  });
  assert.equal(line?.parentLabel, 'for coder-grok-1');
  assert.deepEqual(line?.scoutCount, {
    label: 'asked scout 2',
    tooltip: 'scout-a · grok · running\nscout-b · codex · done',
    live: true,
  });
  assert.deepEqual(lineageOf({ parent: 'coder-grok-1', scouts: [] }), {
    parentLabel: 'for coder-grok-1', scoutCount: null,
  });
  assert.deepEqual(lineageOf({ parent: null, scouts: [{ id: 'scout-c', family: 'kimi', status: 'closed' }] })?.scoutCount, {
    label: 'asked scout 1', tooltip: 'scout-c · kimi · closed', live: false,
  });
});

test('finished row texts and verdict colour', () => {
  assert.equal(findingsCalls(null, 7), '7 calls');
  assert.equal(findingsCalls(0, 7), '0 findings · 7 calls');
  assert.equal(findingsCalls(2, 7), '2 findings · 7 calls');
  assert.equal(verdictLabel(null, 'done', 'closed'), 'done');
  assert.equal(verdictLabel(null, null, 'closed'), 'closed');
  assert.equal(verdictLabel('APPROVE', 'done', 'closed'), 'APPROVE');
  assert.equal(verdictColor('APPROVE'), 'success');
  assert.equal(verdictColor('REQUEST_CHANGES'), 'error');
  assert.equal(verdictColor(null), 'text');
  assert.equal(verdictColor('COMMENT'), 'text');
  assert.equal(finishedTitle(3), 'Finished · 3');
  assert.equal(finishedIsHidden(0), true);
  assert.equal(finishedIsHidden(1), false);
  assert.equal(finishedMeta({
    parent: 'lead-1',
    scouts: [{ family: 'grok' }, { family: 'codex' }],
    model: null,
    effort: null,
    ended: '2026-10-14T11:00:00Z',
  }, NOW), 'for lead-1 · scouts grok, codex · default model · default · 1h 00m ago');
});

test('working keeps board order; finished is newest string-ended first and does not rewrite the list', () => {
  const seats = [
    { id: 'old', active: false, ended: '2026-10-01T00:00:00Z' },
    { id: 'live-b', active: true, ended: null },
    { id: 'new', active: false, ended: '2026-10-14T00:00:00Z' },
    { id: 'live-a', active: true, ended: '2026-10-20T00:00:00Z' },
    { id: 'none', active: false, ended: null },
  ];
  assert.deepEqual(workingSeats(seats).map((seat) => seat.id), ['live-b', 'live-a']);
  assert.deepEqual(finishedSeats(seats).map((seat) => seat.id), ['none', 'new', 'old']);
  assert.deepEqual(seats.map((seat) => seat.id), ['old', 'live-b', 'new', 'live-a', 'none']);
});

test('seats start open, finished starts closed, and an explicit fold wins', () => {
  assert.equal(sectionOpen('seats', undefined), true);
  assert.equal(sectionOpen('finished', undefined), false);
  assert.equal(sectionOpen('seats', false), false);
  assert.equal(sectionOpen('finished', true), true);
});
