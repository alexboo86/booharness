import { expect, test } from 'claude-code/testing'

const assert = {
  equal(actual: unknown, expected: unknown): void { expect(actual).toBe(expected) },
  deepEqual(actual: unknown, expected: unknown): void { expect(actual).toEqual(expected) },
  ok(actual: unknown): void { expect(actual).toBeTruthy() },
  match(actual: string, expected: RegExp): void { expect(actual).toMatch(expected) },
  doesNotMatch(actual: string, expected: RegExp): void { expect(actual).not.toMatch(expected) },
}

import { badgeGroups, leadAge, leadTone, tokenCount } from './leads-format';
import { leadsSvg } from '../svg/leads';
import { svgBoard } from '../../tests/fixtures/svg';

test('lead family draws the registry mark before its plain name; unknown families stay name-only', () => {
  const render = (family: string) => leadsSvg({ ...svgBoard, leads: [{ ...svgBoard.leads[0]!, family: family as never }] }, 800, Date.parse(svgBoard.at)).svg;
  const known = render('claude');
  assert.match(known, /<path d="M17\.3041/);
  assert.match(known, /<use href="#fam-claude"/);
  // The name now draws in the seat's plain tspan run, not a chip's flat text node.
  assert.ok(known.indexOf('<use href="#fam-claude"') < known.indexOf('>Claude</tspan>'));
  assert.doesNotMatch(known, /fill="var\(--accent-soft\)"[^>]*stroke="none"\/><text[^>]*>Claude/);
  for (const family of ['<new>', '__proto__', 'codex" onload="x']) {
    const unknown = render(family);
    if (family === '<new>') assert.match(unknown, /&lt;new&gt;/);
    assert.equal((unknown.match(/<svg\b/g) || []).length, 1);
    assert.doesNotMatch(unknown, /<symbol\b|<use\b|>Claude<|<new>/);
  }
});

test('token display preserves small exact counts and web-board k/M rounding', () => {
  for (const [tokens, text] of [
    [0, '0'], [300, '300'], [999, '999'], [1000, '1k'], [1499, '1k'],
    [1500, '2k'], [999999, '1000k'], [1000000, '1.00M'], [1234567, '1.23M'],
  ] as const) assert.equal(tokenCount(tokens), text);
});

test('lead age uses rounded seconds, minute/hour boundaries and clamps future dates', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  for (const [elapsedMs, text] of [
    [-1000, '0s ago'], [0, '0s ago'], [59499, '59s ago'], [59500, '1m 00s ago'],
    [61000, '1m 01s ago'], [3599000, '59m 59s ago'], [3600000, '1h 00m ago'],
    [7260000, '2h 01m ago'],
  ] as const) assert.equal(leadAge(new Date(now - elapsedMs).toISOString(), now), text);
  assert.equal(leadAge('', now), '');
});

test('lead context severity changes at exactly 70, 85 and 100 percent', () => {
  for (const [percent, tone] of [
    [null, 'subtle'], [0, 'success'], [69, 'success'], [70, 'warning'],
    [84, 'warning'], [85, 'permission'], [99, 'permission'], [100, 'error'], [130, 'error'],
  ] as const) assert.equal(leadTone(percent), tone);
});

test('empty metadata draws no badge groups or unused instruments', () => {
  assert.deepEqual(badgeGroups({}, ['rtk', 'codegraph', 'memoryctl']), []);
  assert.deepEqual(badgeGroups({ kinds: null, skills: null, extensions: [] }, ['rtk']), []);
});

test('skills distinguish delivered, read, unread and knowledge without tool duplication', () => {
  assert.deepEqual(badgeGroups({
    skills: { required: ['verify-change'], listed: ['test-audit', 'plan-before-code'], router: null },
    kinds: { 'skill:test-audit': 2, knowledge: 3 },
  }, []), [{
    label: 'skills',
    badges: [
      { name: 'verify-change', counts: [], tone: 'used', detail: 'skill inlined in the brief' },
      { name: 'test-audit', counts: [], tone: 'used', detail: 'SKILL.md read' },
      { name: 'plan-before-code', counts: [], tone: 'unused', detail: 'routed to this seat, not read' },
      { name: 'knowledge', counts: [3], tone: 'used', detail: 'domain knowledge.md read' },
    ],
  }]);
  assert.deepEqual(badgeGroups({ kinds: { knowledge: 1 } }, []).map((group) => group.label), ['skills']);
});

test('routing fallback is explicit but ordinary map knowledge does not imply no jev', () => {
  assert.deepEqual(badgeGroups({
    skills: { required: [], listed: [], router: { skills: 'jev', lessons: 'jev' } },
  }, []), []);
  assert.deepEqual(badgeGroups({
    skills: { required: [], listed: [], router: { skills: 'map', lessons: 'unavailable', skillReason: 'timeout' } },
  }, []), [{
    label: 'skills',
    badges: [{
      name: 'no jev', counts: [], tone: 'missing',
      detail: 'skills: map (timeout); lessons: unavailable (unknown): routing fallback',
    }],
  }]);
});

test('RTK pending alone is not a miss or an invented zero call count', () => {
  for (const [kinds, counts, tone, detail] of [
    [{ 'rtk-pending': 2 }, ['2 pending'], 'other', '2 shell calls still waiting for an rtk verdict'],
    [{ 'rtk-missed': 3 }, ['3 missed'], 'missing', '3 shell calls rtk has a filter for ran without it'],
    [{ rtk: 4, 'rtk-missed': 3, 'rtk-pending': 2 }, [4, '3 missed', '2 pending'], 'missing', '3 shell calls rtk has a filter for ran without it'],
    [{ rtk: 4 }, [4], 'used', '4 calls'],
  ] as const) assert.deepEqual(badgeGroups({ kinds }, ['rtk']), [{
    label: 'tools', badges: [{ name: 'rtk', counts: [...counts], tone, detail }],
  }]);
});

test('tools keep instrument order, descending provider counts, shell aggregation, and a separate MCP row', () => {
  assert.deepEqual(badgeGroups({ kinds: {
    codegraph: 2, memoryctl: 1, rtk: 5, git: 3, shell: 99,
    'sh:node': 2, 'sh:sed': 4, 'tool:Read': 3, Bash: 8, 'mcp:booharness': 7,
  } }, ['rtk', 'git', 'memoryctl', 'codegraph']), [
    { label: 'tools', badges: [
      { name: 'rtk', counts: [5], tone: 'used', detail: '5 calls' },
      { name: 'git', counts: [3], tone: 'used', detail: '3 calls' },
      { name: 'Bash', counts: [8], tone: 'other', detail: 'built-in tool' },
      { name: 'Read', counts: [3], tone: 'other', detail: 'provider tool' },
      { name: 'shell', counts: [6], tone: 'other', detail: 'shell programs, not through our instruments: sed 4, node 2' },
    ] },
    { label: 'mcp', badges: [
      { name: 'codegraph', counts: [2], tone: 'mcp', detail: '2 calls (MCP tool or CLI)' },
      { name: 'memoryctl', counts: [1], tone: 'mcp', detail: '1 calls (MCP tool or CLI)' },
      { name: 'booharness', counts: [7], tone: 'mcp', detail: 'MCP server booharness' },
    ] },
  ]);
});

test('loaded edit extensions own their calls; unloaded extension tools remain visible', () => {
  const kinds = { edit: 2, 'tool:replace': 3, 'tool:insert': 1 };
  assert.deepEqual(badgeGroups({ kinds, extensions: ['orch-guard', 'codex-edit', 'hashline-edit', 'arm:test'] }, []), [{
    label: 'pi', badges: [
      { name: 'orch-guard', counts: [], tone: 'other', detail: 'Pi extension loaded for this seat' },
      { name: 'codex-edit', counts: [2], tone: 'used', detail: '2 calls of its tools' },
      { name: 'hashline-edit', counts: [4], tone: 'used', detail: '4 calls of its tools' },
      { name: 'arm:test', counts: [], tone: 'other', detail: 'Pi extension loaded for this seat' },
    ],
  }]);
  assert.deepEqual(badgeGroups({ extensions: ['codex-edit'] }, []), [{
    label: 'pi', badges: [{ name: 'codex-edit', counts: [], tone: 'unused', detail: 'Pi extension loaded, its tools not called yet' }],
  }]);
  assert.deepEqual(badgeGroups({ kinds }, []).flatMap((group) => group.badges.map((badge) => badge.name)), ['replace', 'edit', 'insert']);
});

test('all four nonempty badge groups retain skills/tools/mcp/pi order', () => {
  assert.deepEqual(badgeGroups({
    kinds: { knowledge: 1, rtk: 1, codegraph: 1 }, extensions: ['orch-guard'],
  }, ['codegraph', 'rtk']).map((group) => group.label), ['skills', 'tools', 'mcp', 'pi']);
});

