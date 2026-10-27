import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDomainArg, selectInbox, carriedLinks, stampBody, anchorFile, decidePromote, promoteLessons } from './promote-lesson.mjs';

const inbox = {
  domain: 'domain-harness',
  anchor: 'scripts/memory/lesson-lib.mjs:probeObjections',
  status: 'inbox',
  globs: ['scripts/memory/*.mjs'],
  trigger: 'editing the probe validator',
  probe: { cmd: 'node scripts/memory/test-sweep-probes.mjs', expect: 'fail 0' },
};

test('promotion carries the probe across — it is the lesson\'s own check', () => {
  // Measured by review 2026-08-05: promotion rebuilt links from four fields and
  // `probe` was not among them, so a lesson captured WITH a check reached active
  // status without one, while its body still printed the `- probe:` line.
  const promoted = carriedLinks(inbox, 'domain-harness', 'active');
  assert.deepEqual(promoted.probe, inbox.probe);
  assert.equal(promoted.status, 'active');
});

test('promotion carries the globs too, not only the anchor', () => {
  const promoted = carriedLinks(inbox, 'domain-harness', 'active');
  assert.ok(promoted.globs.includes('scripts/memory/*.mjs'), JSON.stringify(promoted.globs));
});

test('closing a duplicate keeps the same fields, at inbox status', () => {
  const closed = carriedLinks(inbox, 'domain-harness', 'inbox');
  assert.deepEqual(closed.probe, inbox.probe);
  assert.equal(closed.status, 'inbox');
});

test('a lesson without a probe gains no probe key', () => {
  const bare = { domain: 'domain-harness', anchor: 'docs/agent/memory.md', status: 'inbox' };
  const promoted = carriedLinks(bare, 'domain-harness', 'active');
  assert.ok(!('probe' in promoted), JSON.stringify(promoted));
});

test('the domain falls back to the one being promoted when links omit it', () => {
  const promoted = carriedLinks({ anchor: 'a.mjs', status: 'inbox' }, 'domain-screener', 'active');
  assert.equal(promoted.domain, 'domain-screener');
});

test('stampBody replaces its own stamp instead of stacking them', () => {
  const once = stampBody('rule\n', 'promoted');
  const twice = stampBody(once, 'promoted');
  assert.equal(twice.match(/- promoted:/g).length, 1);
});

test('--id narrows promotion to the named inbox lessons', () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(selectInbox(rows, new Set([2, 3])).map((row) => row.id), [2, 3]);
  assert.equal(selectInbox(rows, new Set()).length, 3, 'no ids means the whole inbox, as before');
});

test('the domain operand is found wherever it sits, and never taken from a flag or its value', () => {
  assert.equal(pickDomainArg(['--dry', '--id', '5'], new Set([5])), '--all');
  assert.equal(pickDomainArg(['--dry', 'harness'], new Set()), 'harness');
  assert.equal(pickDomainArg(['--db', '/x.db', '--all', '--dry'], new Set()), '--all');
  assert.equal(pickDomainArg(['--dry'], new Set()), undefined, 'no domain and no ids is a usage error');
});

// The anchor is the ONLY delivery route, so a lesson anchored outside this
// checkout reaches nobody — and promoting it turns `check-domain-routing` red,
// which blocks every other commit until someone parks it back. The file header
// warned about this in prose from 2026-09-11 and stopped nobody; on 2026-09-18
// it happened twice in one night, the second time to the author of the lesson
// warning about it. A live `--all --dry` right after the gate landed found 45
// inbox lessons in exactly that state.
const emptyIndex = { byKey: new Map(), byHash: new Map() };
const row = (anchor) => ({ id: 1, title: 'T', body: 'b', linksObj: { domain: 'domain-harness', anchor } });

test('anchorFile takes the path out of an anchor and ignores a symbol suffix', () => {
  assert.equal(anchorFile('scripts/memory/lesson-lib.mjs:probeObjections'), 'scripts/memory/lesson-lib.mjs');
  assert.equal(anchorFile('ops/bootstrap/install-harness.mjs'), 'ops/bootstrap/install-harness.mjs');
  // A bare word is a domain-shaped anchor, not a path: it is not gated.
  assert.equal(anchorFile('domain-harness'), null);
  assert.equal(anchorFile(''), null);
  assert.equal(anchorFile(undefined), null);
});

test('an inbox lesson whose anchor is not in this checkout is skipped, not promoted', () => {
  const missing = (anchor) => !anchor.startsWith('scripts/gone.mjs');
  assert.equal(decidePromote(row('scripts/gone.mjs'), emptyIndex, missing), 'skip-anchor-missing');
  assert.equal(decidePromote(row('scripts/gone.mjs:someSymbol'), emptyIndex, missing), 'skip-anchor-missing');
  assert.equal(decidePromote(row('scripts/here.mjs'), emptyIndex, missing), 'promote');
});

test('dry promotion refuses absent file and symbol, names anchors, and keeps valid promotion', async () => {
  const anchors = [
    'scripts/memory/not-in-this-checkout.mjs:decidePromote',
    'scripts/memory/promote-lesson.mjs:notARealSymbolForThisFixture',
    'scripts/memory/promote-lesson.mjs:decidePromote',
  ];
  const rows = anchors.map((anchor, index) => ({
    id: index + 1, kind: 'lesson', superseded_by: null, title: `Fixture ${index}`,
    body: 'fixture', links: JSON.stringify({ domain: 'domain-harness', status: 'inbox', anchor }),
  }));
  const fetchBefore = globalThis.fetch;
  const logBefore = console.log;
  const printed = [];
  try {
    globalThis.fetch = async (url) => {
      assert.equal(new URL(url).pathname, '/api/memory/entries');
      return Response.json(rows);
    };
    console.log = (line) => printed.push(line);
    const result = await promoteLessons({ arg: 'harness', dry: true });
    assert.deepEqual([result.promoted, result.skipped], [1, 2]);
    for (const anchor of anchors.slice(0, 2)) {
      assert.ok(printed.join('\n').includes(`skipped: anchor "${anchor}" does not resolve in this checkout; re-anchor before promotion`));
    }
    assert.match(printed.join('\n'), /Fixture 2\twould-promote\t3/);
  } finally {
    globalThis.fetch = fetchBefore;
    console.log = logBefore;
  }
});

test('without a resolver the decision is unchanged — the gate never guesses', () => {
  assert.equal(decidePromote(row('scripts/gone.mjs'), emptyIndex), 'promote');
});

test('a glob-shaped anchor is promoted: there is no single file to resolve', () => {
  const never = () => false;
  assert.equal(decidePromote(row('domain-harness'), emptyIndex, never), 'promote');
});

// A glob WITH a slash — `app/**` — went down the literal path, because
// `anchorFile` keeps anything containing a slash and `existsSync('app/**')`
// is false. So every such lesson was skipped forever and the glob route, which
// lesson-lib, the store and the delivery endpoint all implement, had no way in
// through the sanctioned capture path. Measured 2026-09-20: of eight lessons
// delivered for `app/src/feed.rs`, eight matched by anchor and none by
// glob. The resolver is asked about the GLOB now, not about a file of that name.
test('a path-shaped glob anchor is resolved as a glob, not as a file', () => {
  const asked = [];
  const resolver = (anchor) => {
    asked.push(anchor);
    return anchor === 'app/**';
  };
  assert.equal(decidePromote(row('app/**'), emptyIndex, resolver), 'promote');
  assert.deepEqual(asked, ['app/**'], 'the glob itself is resolved, not a file path cut from it');
  // A glob that matches nothing in this checkout is still refused.
  assert.equal(decidePromote(row('crates/gone/**'), emptyIndex, resolver), 'skip-anchor-missing');
});
