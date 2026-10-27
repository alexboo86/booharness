import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDomain } from './store.mjs';
import {
  anchorFile,
  applyPlan,
  planReanchor,
  reanchoredLinks,
  resumeCommand,
} from './reanchor-lesson.mjs';

const row = (id, links) => ({ id, title: `lesson ${id}`, body: 'body', links: JSON.stringify(links) });

const store = new Map([
  [1, row(1, { domain: 'domain-harness', anchor: 'old/gone.rs:sym', status: 'active', globs: [] })],
  [2, row(2, { domain: 'domain-harness', anchor: 'old/gone.rs', status: 'active', globs: ['old/*.rs'] })],
]);
const lookup = (id) => store.get(id);
/** A checkout with two real files, a directory, and a second routing domain. */
const tree = {
  isFile: (file) => file === 'new/here.rs' || file === 'far/away.rs',
  delivers: (links, file) => String(links.anchor || '').split(':')[0] === file,
  domainOf: (file) => (file === 'far/away.rs' ? 'domain-screener' : 'domain-harness'),
};

test('anchorFile keeps the file half and drops the symbol', () => {
  assert.equal(anchorFile('a/b.rs:LegRangeTracker::on_swing'), 'a/b.rs');
  assert.equal(anchorFile('a/b.rs'), 'a/b.rs');
});

test('a target file that does not exist is refused — a second ghost is the same defect', () => {
  // The failure this whole tool exists for: `svod/src/adapter.rs` became
  // `svod/src/adapter/`, 8 lessons kept pointing at the old path, and delivery
  // reached nobody editing the adapter. Re-anchoring to another missing path
  // would reproduce that silently.
  const { plan, problems } = planReanchor(new Map([[1, 'still/missing.rs']]), lookup, tree);
  assert.equal(plan.length, 0);
  assert.match(problems[0], /still\/missing\.rs.*names no file/);
});

test('a bare-word target is refused by name, not by a TypeError', () => {
  // The shared anchorFile (lesson-lib.mjs) returns null for a word with no
  // '/' and no '.'; that null once reached tree.isFile and threw instead of
  // refusing the batch (reviewer-mimo-5e69b2).
  const { plan, problems } = planReanchor(new Map([[1, 'renderCandles']]), lookup, tree);
  assert.equal(plan.length, 0);
  assert.match(problems[0], /renderCandles/);
  assert.match(problems[0], /names no file/);
});

test('a bare-word --to LICENSE is refused the same way', () => {
  const { plan, problems } = planReanchor(new Map([[1, 'LICENSE']]), lookup, tree);
  assert.equal(plan.length, 0);
  assert.match(problems[0], /LICENSE/);
  assert.match(problems[0], /names no file/);
});

test('a tracked root file without an extension is a real target', () => {
  // The shared anchorFile returns null for 'LICENSE'; reanchor must fall back to
  // the literal file half, or a tracked file is refused as missing (reviewer-qwen-9e821e.1).
  const withRootFile = { ...tree, isFile: (file) => file === 'LICENSE' || tree.isFile(file) };
  const { plan, problems } = planReanchor(new Map([[1, 'LICENSE']]), lookup, withRootFile);
  assert.deepEqual(problems, []);
  assert.equal(plan.length, 1);
});

/// The shape the first version accepted, and the one that cost the most.
///
/// `existsSync` is true for a DIRECTORY. `app/src/billing` (a directory) was therefore
/// accepted, reported as moved, and left the lesson reachable by nobody — the
/// matcher does not treat a directory as a prefix — while `sweep-anchors` then
/// threw `EISDIR` on that anchor and `check-domain-routing` turned the throw
/// into a red gate for the whole repository. Found by a review round the same
/// day the tool shipped.
test('a DIRECTORY target is refused, and the refusal says why it is worse than a missing one', () => {
  const { plan, problems } = planReanchor(new Map([[1, 'new']]), lookup, tree);
  assert.equal(plan.length, 0);
  assert.match(problems[0], /names no file/);
  assert.match(problems[0], /DIRECTORY/);
});

/// Delivery filters by DOMAIN before it looks at the anchor, so a target in
/// another routing domain produces a lesson that is active and unreachable.
test('a target in another routing domain is refused, not silently re-domained', () => {
  const { plan, problems } = planReanchor(new Map([[1, 'far/away.rs']]), lookup, tree);
  assert.equal(plan.length, 0);
  assert.match(problems[0], /routes to domain-screener/);
  assert.match(problems[0], /undeliverable/);
});

/// A path that exists but the matcher would not reach is the same defect as a
/// ghost, one step later.
test('a target the matcher would not deliver to is refused even though the file exists', () => {
  const blind = { ...tree, delivers: () => false };
  const { plan, problems } = planReanchor(new Map([[1, 'new/here.rs']]), lookup, blind);
  assert.equal(plan.length, 0);
  assert.match(problems[0], /would NOT be delivered/);
});

test('ONE bad move refuses the WHOLE batch', () => {
  // A half-applied re-anchor leaves the store in a state nobody wrote down.
  const { plan, problems } = planReanchor(
    new Map([[1, 'new/here.rs:sym'], [2, 'still/missing.rs']]),
    lookup,
    tree,
  );
  assert.equal(plan.length, 0, 'the good move must not go through either');
  assert.equal(problems.length, 1);
});

/// The preflight refuses the whole batch; the WRITE could not, and used to
/// carry on through failures. Three writes with the middle one failing ran all
/// three and reported `2 moved, 1 failed of 3` — a count, not a state.
test('a write that fails stops the batch and names both halves', () => {
  const entry = (id) => ({ row: { id, title: `lesson ${id}` }, from: 'old.rs', to: `new/${id}.rs` });
  const called = [];
  const { moved, failed, remaining } = applyPlan([entry(1), entry(2), entry(3)], (item) => {
    called.push(item.row.id);
    if (item.row.id === 2) throw new Error('memoryctl supersede failed: 42');
  });
  assert.deepEqual(called, [1, 2], 'the third write must not run after the second failed');
  assert.deepEqual(moved, [1]);
  assert.equal(failed.id, 2);
  assert.deepEqual(remaining.map((item) => item.id), [3]);
  assert.equal(
    resumeCommand(failed, remaining),
    'node scripts/memory/reanchor-lesson.mjs --id 2 --to new/2.rs --id 3 --to new/3.rs',
  );
});

/// The two ends of the batch, where an off-by-one in the boundary hides.
test('the first and the last write failing are both reported as state, not as a count', () => {
  const entry = (id) => ({ row: { id }, to: `new/${id}.rs` });
  const first = applyPlan([entry(1), entry(2), entry(3)], (item) => {
    if (item.row.id === 1) throw new Error('memoryctl supersede failed: 42');
  });
  assert.deepEqual(first.moved, []);
  assert.equal(first.failed.id, 1);
  assert.deepEqual(first.remaining.map((item) => item.id), [2, 3]);
  assert.equal(
    resumeCommand(first.failed, first.remaining),
    'node scripts/memory/reanchor-lesson.mjs --id 1 --to new/1.rs --id 2 --to new/2.rs --id 3 --to new/3.rs',
  );

  const last = applyPlan([entry(1), entry(2), entry(3)], (item) => {
    if (item.row.id === 3) throw new Error('memoryctl supersede failed: 42');
  });
  assert.deepEqual(last.moved, [1, 2]);
  assert.equal(last.failed.id, 3);
  assert.deepEqual(last.remaining, []);
  // Never an already-moved id: `supersede` retires it, and a retry would be
  // refused with "no LIVE lesson with this id".
  assert.equal(
    resumeCommand(last.failed, last.remaining),
    'node scripts/memory/reanchor-lesson.mjs --id 3 --to new/3.rs',
  );
});

test('a clean batch reports every move and nothing outstanding', () => {
  const entry = (id) => ({ row: { id }, to: `new/${id}.rs` });
  const { moved, failed, remaining } = applyPlan([entry(1), entry(2)], () => {});
  assert.deepEqual(moved, [1, 2]);
  assert.equal(failed, null);
  assert.deepEqual(remaining, []);
});

test('an id with no live lesson is named, not skipped', () => {
  const { problems } = planReanchor(new Map([[99, 'new/here.rs']]), lookup, tree);
  assert.match(problems[0], /#99: no LIVE lesson/);
});

test('a clean batch plans every move and reports where each came from', () => {
  const { plan, problems } = planReanchor(
    new Map([[1, 'new/here.rs:sym'], [2, 'new/here.rs']]),
    lookup,
    tree,
  );
  assert.equal(problems.length, 0);
  assert.deepEqual(plan.map((entry) => [entry.row.id, entry.from, entry.to]), [
    [1, 'old/gone.rs:sym', 'new/here.rs:sym'],
    [2, 'old/gone.rs', 'new/here.rs'],
  ]);
});

test('the OLD anchor is dropped from globs, or delivery keeps using the dead path', () => {
  // `buildLessonLinks` copies a glob anchor into `globs`. Leaving it there
  // re-delivers the lesson by the very path that just stopped existing.
  const links = reanchoredLinks(
    { domain: 'domain-harness', anchor: 'old/*.rs', status: 'active', globs: ['old/*.rs', 'keep/*.rs'] },
    'new/here.rs',
  );
  assert.deepEqual(links.globs, ['keep/*.rs']);
  assert.equal(links.anchor, 'new/here.rs');
});

test('every other link field survives the move untouched', () => {
  const links = reanchoredLinks(
    {
      domain: 'domain-harness',
      anchor: 'old/gone.rs',
      status: 'active',
      trigger: 'editing the adapter',
      probe: { cmd: 'node x.mjs', expect: 'ok' },
      globs: [],
    },
    'new/here.rs',
  );
  assert.equal(links.domain, 'domain-harness');
  assert.equal(links.status, 'active');
  assert.equal(links.trigger, 'editing the adapter');
  assert.deepEqual(links.probe, { cmd: 'node x.mjs', expect: 'ok' });
});

// Authoring gate: these exercise the production planner/writer boundary.
// Existing tests cover only supersedes, not capture/retire ordering, a dry
// runner, ambiguous explicit routes, or recovery after a partially applied move.
// The runner supplies process responses only; the owner must choose the new id,
// issue the commands in order, and stop the batch. No test-only export is needed.
const refileRow = (id = 1, rule = 'Keep the lesson deliverable.') => ({
  ...row(id, { domain: 'domain-harness', anchor: 'old/gone.rs', status: 'active' }),
  body: `- trigger: editing the moved code\n- rule: ${rule}\n- why: Otherwise editors miss it.\n- evidence: node scripts/check.mjs`,
});
const refileTree = (routes = [{ glob: 'far/**', domain: 'domain-screener', spec: 4 }]) => {
  const routing = { order: [...routes, { glob: '**', domain: 'domain-platform-shell', spec: 0 }] };
  return { ...tree, routing, domainOf: (file) => resolveDomain(file, routing) };
};
const refiles = (rows = [refileRow()], checkout = refileTree()) => planReanchor(
  new Map(rows.map((entry) => [entry.id, 'far/away.rs:handler'])),
  (id) => rows.find((entry) => entry.id === id),
  checkout,
  { refile: true },
);
const noSupersede = () => assert.fail('a refile must not supersede the old anchor');

test('--refile captures copied fields then retires into the returned new id', () => {
  for (const [rule, output, newId, long] of [
    ['Keep the lesson deliverable.', 'appended #901\n', '901', false],
    ['🧭'.repeat(300), '{"id":902}\n', '902', false],
    ['🧭'.repeat(301), '{"id":903}\n', '903', true],
    ['First line.\n  Second line.', '{"id":904}\n', '904', false],
  ]) {
    const { plan, problems } = refiles([refileRow(1, rule)]);
    assert.deepEqual(problems, []);
    const calls = [];
    const result = applyPlan(plan, noSupersede, {
      run: (args) => { calls.push(args); return output; },
      log: () => {},
    });
    assert.equal(result.failed, null);
    assert.deepEqual(result.moved, [1]);
    const capture = calls[0];
    assert.deepEqual(capture.slice(0, 3), ['scripts/memory/capture-lesson.mjs', 'domain-screener', 'lesson 1']);
    for (const [flag, value] of [
      ['--anchor', 'far/away.rs:handler'], ['--rule', rule],
      ['--trigger', 'editing the moved code'], ['--why', 'Otherwise editors miss it.'],
      ['--evidence', 'node scripts/check.mjs; re-filed from #1'],
    ]) assert.equal(capture[capture.indexOf(flag) + 1], value);
    assert.equal(capture.includes('--long'), long);
    if (long) assert.match(capture[capture.indexOf('--long') + 1], /#1/);
    assert.deepEqual(calls[1], ['scripts/memory/retire-lesson.mjs', '--id', '1', '--merged-into', newId]);
    assert.equal(calls.length, 2);
  }
});

test('--refile --dry prints capture and retire plans without invoking any writer', () => {
  const { plan, problems } = refiles();
  assert.deepEqual(problems, []);
  const lines = [];
  const result = applyPlan(plan, noSupersede, {
    dry: true,
    run: () => assert.fail('dry must not run a command'),
    log: (line) => lines.push(line),
  });
  assert.deepEqual(result.moved, []);
  assert.match(lines.join('\n'), /node scripts\/memory\/capture-lesson\.mjs domain-screener/);
  assert.match(lines.join('\n'), /node scripts\/memory\/retire-lesson\.mjs --id 1 --merged-into/);
});

test('--refile refuses several matching domains or only the catch-all floor before writing', () => {
  for (const [routes, message] of [
    [[{ glob: 'far/**', domain: 'domain-screener', spec: 4 },
      { glob: 'far/*.rs', domain: 'domain-other', spec: 7 }], /multiple candidate domains/],
    [[], /no glob/],
  ]) {
    const { plan, problems } = refiles([refileRow()], refileTree(routes));
    assert.equal(plan.length, 0);
    assert.match(problems[0], message);
  }
});

test('a failed refile retire reports old and new ids and stops with untouched ids', () => {
  const { plan, problems } = refiles([refileRow(1), refileRow(2), refileRow(3)]);
  assert.deepEqual(problems, []);
  const calls = [];
  const result = applyPlan(plan, noSupersede, {
    run: (args) => {
      calls.push(args);
      if (args[0].includes('retire') && args.includes('2')) throw new Error('retire unavailable');
      return calls.length === 1 ? '{"id":901}\n' : '{"id":902}\n';
    },
    log: () => {},
  });
  assert.deepEqual(result.moved, [1]);
  assert.equal(result.failed.id, 2);
  assert.equal(result.failed.newId, 902);
  assert.match(result.failed.message, /#2.*#902.*retire unavailable/);
  assert.deepEqual(result.remaining.map((entry) => entry.id), [3]);
  assert.equal(calls.length, 4, 'never capture id 3 after id 2 fails');
});
