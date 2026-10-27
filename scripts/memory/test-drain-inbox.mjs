import '../jev-test-state.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainInbox } from './drain-inbox.mjs';

const row = (id, status = 'inbox', extras = {}) => ({
  id, kind: 'lesson', title: `Rule ${id}`, body: '- rule: Keep the proof.\n- why: Avoid drift.\n- evidence: Test.\n',
  links: JSON.stringify({ domain: 'domain-harness', anchor: 'scripts/memory/test-drain-inbox.mjs', status,
    trigger: 'editing', globs: ['scripts/memory/*.mjs'], probe: { command: 'true' }, ...extras }),
});

test('dry run gates only open inbox lessons, reports passes and refusals without writes', async () => {
  const calls = [];
  const lines = [];
  const plan = await drainInbox({ read: async () => [row(1), row(2), row(3, 'active'), row(4, 'inbox', { closed: true })],
    gate: async ({ title, links }) => {
      calls.push(title);
      if (title === 'Rule 2') throw new Error('lesson refused: duplicate of #91: supersede it');
      return { ...links, status: 'active' };
    },
    supersede: () => assert.fail('dry run must not write'), print: (line) => lines.push(line),
  });
  assert.deepEqual(calls, ['Rule 1', 'Rule 2']);
  assert.deepEqual(plan, [{ id: 1, action: 'pass' },
    { id: 2, action: 'refuse', reason: 'lesson refused: duplicate of #91: supersede it' }]);
  assert.match(lines.join('\n'), /#2 refuse: lesson refused: duplicate of #91/);
  assert.match(lines.at(-1), /1 pass, 1 refuse, 0 error \(dry run\)/);
});

test('apply carries the accepted active links including trigger, globs and probe', async () => {
  const written = [];
  await drainInbox({ apply: true, read: async () => [row(8)],
    gate: async ({ links }) => ({ ...links, status: 'active' }),
    supersede: (lesson, links) => written.push({ id: lesson.id, links }), print: () => {},
  });
  assert.equal(written[0].id, 8);
  assert.deepEqual(written[0].links, { domain: 'domain-harness', anchor: 'scripts/memory/test-drain-inbox.mjs',
    globs: ['scripts/memory/*.mjs'], status: 'active', trigger: 'editing', probe: { command: 'true' } });
});

test('re-domains before gating and writes the routed domain while carrying metadata', async () => {
  const routed = { order: [{ glob: 'scripts/memory/**', domain: 'domain-harness', spec: 1 }] };
  const lines = [];
  const written = [];
  const original = row(10, 'inbox', { domain: 'domain-old' });
  const plan = await drainInbox({ apply: true, read: async () => [original], routing: () => routed,
    gate: async ({ links }, { routing }) => {
      assert.equal(routing(), routed);
      assert.equal(links.domain, 'domain-harness');
      assert.equal(JSON.parse(original.links).domain, 'domain-old');
      return { ...links, status: 'active' };
    },
    supersede: (_row, links) => written.push(links), print: (line) => lines.push(line),
  });
  assert.deepEqual(plan, [{ id: 10, action: 'pass', redomain: { from: 'domain-old', to: 'domain-harness' } }]);
  assert.match(lines.join('\n'), /#10 redomain domain-old -> domain-harness/);
  assert.equal(written[0].domain, 'domain-harness');
  assert.equal(written[0].status, 'active');
  assert.deepEqual(written[0].globs, ['scripts/memory/*.mjs']);
  assert.deepEqual(written[0].probe, { command: 'true' });
});

test('ambiguous explicit routes refuse inbox re-domain before gating', async () => {
  const routed = { order: [{ glob: 'scripts/memory/**', domain: 'domain-harness', spec: 10 },
    { glob: 'scripts/**', domain: 'domain-other', spec: 5 }] };
  const plan = await drainInbox({ read: async () => [row(15, 'inbox', { domain: 'domain-old' })],
    routing: () => routed, gate: async () => assert.fail('ambiguous route must not reach the gate'),
    supersede: () => assert.fail('ambiguous route must not write'), print: () => {} });
  assert.match(plan[0].reason, /multiple candidate domains/);
  assert.equal(plan[0].action, 'refuse');
});

test('re-domained candidate still refuses a gate duplicate, without writing', async () => {
  const lines = [];
  const plan = await drainInbox({ read: async () => [row(11, 'inbox', { domain: 'domain-old' })],
    gate: async ({ links }) => {
      assert.equal(links.domain, 'domain-harness');
      throw new Error('lesson refused: duplicate of #99: supersede it');
    },
    supersede: () => assert.fail('refused lesson must not write'), print: (line) => lines.push(line),
  });
  assert.deepEqual(plan, [{ id: 11, action: 'refuse', reason: 'lesson refused: duplicate of #99: supersede it',
    redomain: { from: 'domain-old', to: 'domain-harness' } }]);
  assert.match(lines.join('\n'), /#11 redomain domain-old -> domain-harness\n#11 refuse: lesson refused: duplicate of #99/);
});

test('a floor-only route refuses a different stored domain without re-domaining', async () => {
  const lines = [];
  const floor = { order: [{ glob: '**', domain: 'domain-platform-shell', spec: 0 }] };
  const plan = await drainInbox({ read: async () => [row(13, 'inbox', {
    anchor: 'app/src/unrouted/example.rs', domain: 'domain-billing',
  })], routing: () => floor, supersede: () => assert.fail('must not write'), print: (line) => lines.push(line) });
  assert.deepEqual(plan, [{ id: 13, action: 'refuse',
    reason: 'lesson refused: anchor has no glob in domain-billing; add one and regenerate the routing map, or file it under domain-platform-shell' }]);
  assert.doesNotMatch(lines.join('\n'), /redomain/);
});

test('a platform-shell row passes the catchall without re-domaining', async () => {
  const lines = [];
  const floor = { order: [{ glob: '**', domain: 'domain-platform-shell', spec: 0 }] };
  const plan = await drainInbox({ read: async () => [row(14, 'inbox', { domain: 'domain-platform-shell' })],
    routing: () => floor, gate: async ({ links }) => {
      assert.equal(links.domain, 'domain-platform-shell');
      return { ...links, status: 'active' };
    }, supersede: () => assert.fail('dry run must not write'), print: (line) => lines.push(line) });
  assert.deepEqual(plan, [{ id: 14, action: 'pass' }]);
  assert.doesNotMatch(lines.join('\n'), /redomain/);
});

test('noncanonical anchor refuses before routing or gate', async () => {
  const plan = await drainInbox({ read: async () => [row(12, 'inbox', { anchor: './scripts/memory/test-drain-inbox.mjs' })],
    gate: async () => assert.fail('noncanonical anchor must not reach the gate'), print: () => {},
  });
  assert.match(plan[0].reason, /not normalized repo-relative/);
});

test('apply stops after a failed supersede rather than misreporting a refusal', async () => {
  let gated = 0;
  await assert.rejects(drainInbox({ apply: true, read: async () => [row(8), row(9)],
    gate: async ({ links }) => { gated++; return { ...links, status: 'active' }; },
    supersede: () => { throw new Error('write outcome unknown'); }, print: () => {},
  }), /write outcome unknown/);
  assert.equal(gated, 1);
});
