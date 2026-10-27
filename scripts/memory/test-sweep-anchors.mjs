import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyAnchor, sweep, printSweep } from './sweep-anchors.mjs';

test('missing file -> gone', () => {
  assert.equal(classifyAnchor('nope/x.rs:foo', () => null), 'gone');
});
test('file present, symbol present -> keep', () => {
  assert.equal(classifyAnchor('a.rs:foo', () => 'fn foo() {}'), 'keep');
});
test('file present, symbol absent -> drift', () => {
  assert.equal(classifyAnchor('a.rs:foo', () => 'fn bar() {}'), 'drift');
});
test('file-only anchor present -> keep', () => {
  assert.equal(classifyAnchor('a.rs', () => 'anything'), 'keep');
});
test('line-number anchor within range -> keep', () => {
  assert.equal(classifyAnchor('a.rs:3', () => 'l1\nl2\nl3\nl4'), 'keep');
});
test('line-number anchor out of range -> drift', () => {
  assert.equal(classifyAnchor('a.rs:99', () => 'l1\nl2'), 'drift');
});
test('glob without repoPaths -> gone (not auto-keep)', () => {
  assert.equal(classifyAnchor('src/**/*.ts', () => null), 'gone');
});
test('glob with matching path -> keep', () => {
  assert.equal(
    classifyAnchor('src/**/*.ts', () => null, { repoPaths: ['src/utils/x.ts'] }),
    'keep',
  );
});
test('glob with symbol matches the checkout path, not the suffix', () => {
  assert.equal(classifyAnchor('src/*.ts:Widget', () => null, { repoPaths: ['src/a.ts'] }), 'keep');
});
test('placeholder "?" and empty anchor -> drift (re-anchor), not gone', () => {
  assert.equal(classifyAnchor('?', () => null), 'drift');
  assert.equal(classifyAnchor('', () => null), 'drift');
});
test('concrete missing path -> gone', () => {
  assert.equal(classifyAnchor('does-not-exist-xyz.rs:foo', () => null), 'gone');
});

test('sweep separates checkout, branch-only, removed-in-history and glob refs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-sweep-'));
  try {
    fs.writeFileSync(path.join(root, 'here.rs'), 'fn here() {}');
    const calls = [];
    const git = (args) => {
      calls.push(args);
      if (args[0] === 'for-each-ref') return `refs/heads/feature ${'b'.repeat(40)} \nrefs/remotes/origin/master ${'c'.repeat(40)} \n`;
      if (args[0] === 'rev-parse') return `${'a'.repeat(40)}\n`;
      if (args[0] === 'ls-tree') return args[4] === 'b'.repeat(40)
        ? 'here.rs\0branch.rs\0src/a.ts\0' : 'here.rs\0';
      throw new Error(args.join(' '));
    };
    const lessons = ['here.rs:here', 'here.rs:missing', 'branch.rs:fn', 'src/*.ts', 'removed.rs', '?']
      .map((anchor, id) => ({ id, title: anchor, linksObj: { domain: 'domain-harness', anchor } }));
    const report = sweep({ lessons, repoRoot: root, git, listPaths: () => ['here.rs'] });
    assert.deepEqual(Object.fromEntries(Object.entries(report).map(([key, rows]) => [key, rows.length])),
      { keep: 1, drift: 2, branch: 2, gone: 1, error: 0 });
    assert.deepEqual(report.branch.map((row) => row.refs), [
      ['refs/heads/feature'], ['refs/heads/feature'],
    ]);
    assert.equal(report.gone[0].anchor, 'removed.rs');
    assert.equal(calls.filter((args) => args[0] === 'ls-tree').length, 3, 'trees cached across anchors');
    assert.equal(printSweep({ ...report, gone: [] }), 0);
    assert.equal(printSweep(report), 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a non-git sibling yields one ERROR without dropping the other verdicts', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-sibling-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, 'notagit'));
  fs.writeFileSync(path.join(base, 'notagit', 'present.rs'), 'fn present() {}');
  fs.writeFileSync(path.join(root, 'here.rs'), 'fn here() {}');
  try {
    const lessons = [
      { id: 1, linksObj: { anchor: 'missing.rs', repo: 'notagit', domain: 'domain-harness' } },
      { id: 2, linksObj: { anchor: 'here.rs', domain: 'domain-harness' } },
      { id: 3, linksObj: { anchor: 'present.rs', repo: 'notagit', domain: 'domain-harness' } },
    ];
    const git = (args, cwd) => {
      if (cwd.endsWith('notagit')) throw new Error('not a git repository');
      throw new Error(args.join(' '));
    };
    const report = sweep({ lessons, repoRoot: root, git, listPaths: () => ['here.rs'] });
    assert.deepEqual([report.error.length, report.keep.length, report.gone.length], [2, 1, 0]);
    assert.match(report.error[0].error, /not a git repository/);
    assert.equal(printSweep(report), 1);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
