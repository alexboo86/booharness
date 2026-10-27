import '../jev-test-state.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { scrubbedGitEnv } from '../git-env.mjs';
import { anchorInRefs, anchorRefs, gateNewLesson } from './capture-gate.mjs';
import { resolveDomain, resolveExplicitDomain } from './store.mjs';

const candidate = { title: 'Protect capture', body: '- trigger: When capturing\n- rule: Refuse missing anchors before a lesson is written.\n- why: It prevents undeliverable knowledge.\n- evidence: #12333', links: { domain: 'domain-harness', anchor: 'scripts/memory/capture-lesson.mjs:captureLesson', status: 'inbox' } };
const routing = () => ({ order: [{ glob: 'scripts/memory/**', domain: 'domain-harness', spec: 10 }] });
const good = { answers: { rule: { noul: 0.9 }, useful: { noul: 0.9 }, anchor: { noul: 0.9 } } };
function deps(extra = {}) { return { routing, exists: () => true, ask: async () => good, brevity: async () => {}, ...extra }; }

test('shared capture gate enforces fields even with a separate brevity check', async (t) => {
  for (const [body, message] of [
    [candidate.body.replace('- trigger: When capturing\n', ''), /--trigger is required/],
    [candidate.body.replace('#12333', 'git, status'), /--evidence carries none/],
    [candidate.body.replace('#12333', 'node;rm file'), /--evidence carries none/],
    [candidate.body.replace('#12333', 'mentions node in prose'), /--evidence carries none/],
    [candidate.body.replace('#12333', 'node'), /--evidence carries none/],
  ]) await t.test(body, async () => {
    await assert.rejects(gateNewLesson({ ...candidate, body }, deps()), message);
  });
  for (const evidence of ['ABC1234', 'node --version', 'git status', 'npm test', 'npx vitest', 'cargo check', 'rg pattern', 'bash script.sh']) {
    assert.equal((await gateNewLesson({ ...candidate, body: candidate.body.replace('#12333', evidence) }, deps())).status, 'active');
  }
});

test('route, explicit domain and ref existence refuse before Jev', async () => {
  for (const [change, options, message] of [
    [{}, { routing: () => ({ order: [] }) }, /add a glob to the domain/],
    [{}, { exists: () => false }, /no HEAD, local branch or origin/],
  ]) {
    let brevity = 0;
    await assert.rejects(gateNewLesson({ ...candidate, ...change }, deps({ ...options, brevity: async () => { brevity++; } })), message);
    assert.equal(brevity, 0);
  }
});

test('off-route lessons use the sole explicit domain, including bare names; ambiguous and absent routes refuse', async () => {
  for (const proposed of ['harness', 'domain-other']) {
    const links = await gateNewLesson({ ...candidate, links: { ...candidate.links, domain: proposed } }, deps());
    assert.equal(links.domain, 'domain-harness');
  }
  const ambiguous = { order: [...routing().order, { glob: 'scripts/**', domain: 'domain-other', spec: 5 }] };
  await assert.rejects(gateNewLesson({ ...candidate, links: { ...candidate.links, domain: 'harness' } }, deps({ routing: () => ambiguous })), /multiple candidate domains/);
  await assert.rejects(gateNewLesson({ ...candidate, links: { ...candidate.links, domain: 'harness' } }, deps({ routing: () => ({ order: [] }) })), /no route/);
  await assert.rejects(gateNewLesson({ ...candidate, links: { ...candidate.links, domain: 'domain-other' } }, deps({ mode: 'move' })),
    /anchor routes to domain-harness; use that domain instead of domain-other/);
  const conflicting = { order: [{ glob: '**', domain: 'domain-platform-shell', spec: 20 }, ...routing().order] };
  await assert.rejects(gateNewLesson({ ...candidate, links: { ...candidate.links, domain: 'domain-other' } }, deps({ routing: () => conflicting })),
    /selected route domain-platform-shell conflicts with sole explicit candidate domain-harness/);
});

test('catchall accepts platform-shell lessons but refuses a different stored domain before Jev', async () => {
  const floor = { order: [{ glob: '**', domain: 'domain-platform-shell', spec: 0 }] };
  const links = { ...candidate.links, domain: 'domain-platform-shell' };
  assert.equal(resolveDomain('scripts/memory/capture-lesson.mjs', floor), 'domain-platform-shell');
  assert.equal(resolveExplicitDomain('scripts/memory/capture-lesson.mjs', floor), null);
  assert.equal((await gateNewLesson({ ...candidate, links }, deps({ routing: () => floor }))).domain, 'domain-platform-shell');
  await assert.rejects(gateNewLesson(candidate, deps({ routing: () => floor,
    exists: () => assert.fail('ref check must not run'),
    ask: async () => assert.fail('Jev must not run'),
  })), /anchor has no glob in domain-harness; add one and regenerate the routing map, or file it under domain-platform-shell/);
  const specific = { order: [...floor.order, { glob: 'scripts/memory/**', domain: 'domain-harness', spec: 15 }] };
  assert.equal(resolveExplicitDomain('scripts/memory/capture-lesson.mjs', specific), 'domain-harness');
  // A specific platform-shell glob is not the bare '**' floor.
  assert.equal(resolveExplicitDomain('scripts/memory/capture-lesson.mjs', { order: [
    ...floor.order, { glob: 'scripts/memory/**', domain: 'domain-platform-shell', spec: 15 },
  ] }), 'domain-platform-shell');
});

test('file and glob refs use current trees, not a deleted file in history', () => {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === '--literal-pathspecs' && args[1] === 'log') return '';
    if (args[0] === 'for-each-ref') return `refs/heads/feature ${'b'.repeat(40)}\nrefs/remotes/origin/master ${'a'.repeat(40)}\n`;
    if (args[0] === 'rev-parse') return `${'a'.repeat(40)}\n`;
    if (args[0] === 'ls-tree') {
      assert.deepEqual(args.slice(0, 4), ['ls-tree', '-z', '-r', '--name-only']);
      return args[4] === 'b'.repeat(40) ? 'scripts/memory/gone.mjs\0scripts/memory/якорь.mjs\0' : '';
    }
    throw new Error(args.join(' '));
  };
  assert.deepEqual(anchorRefs('scripts/memory/gone.mjs:f', { git }), ['refs/heads/feature']);
  assert.equal(calls.some((args) => args[0] === 'log'), false);
  assert.equal(anchorInRefs('scripts/memory/missing.mjs:f', { git }), false);
  assert.equal(anchorInRefs('scripts/memory/*.mjs', { git }), true);
  assert.deepEqual(anchorRefs('scripts/memory/якорь.mjs', { git }), ['refs/heads/feature']);
  assert.deepEqual(anchorRefs('../outside.mjs', { git }), []);
  assert.equal(calls.filter((args) => args[0] === 'ls-tree').length, 2, 'two unique trees read once across four anchors');
});

test('existence check stops at first matching tree, probes plain files exactly, and ignores directories', () => {
  const calls = [];
  const head = 'a'.repeat(40);
  const branch = 'b'.repeat(40);
  const git = (args) => {
    calls.push(args);
    if (args[0] === '--literal-pathspecs' && args[1] === 'log') return '';
    if (args[0] === 'for-each-ref') return `refs/heads/feature ${branch}\nrefs/remotes/origin/master ${head}\n`;
    if (args[0] === 'rev-parse') return `${head}\n`;
    if (args[0] === 'ls-tree') {
      const files = args[4] === head ? ['src/here.ts', 'src/deep/file.ts'] : ['src/branch.ts'];
      return (args[5] === '--' ? files.filter((file) => file === args[6].replace(':(literal)', '')) : files).join('\0') + '\0';
    }
    throw new Error(args.join(' '));
  };
  assert.equal(anchorInRefs('src/here.ts', { git }), true);
  assert.equal(calls.filter((args) => args[0] === 'ls-tree').length, 1, 'HEAD match does not inspect other trees');
  assert.deepEqual(calls.at(-1).slice(5), ['--', ':(literal)src/here.ts']);
  assert.equal(anchorInRefs('src/deep', { git }), false, 'a directory is not a file anchor');
  assert.equal(anchorInRefs('src/branch.ts', { git }), true);
  assert.equal(calls.filter((args) => args[0] === 'ls-tree').length, 5, 'duplicate origin tree is skipped');
  assert.equal(anchorInRefs('src/*.ts', { git }), true);
  assert.equal(calls.filter((args) => args[0] === 'ls-tree').length, 6, 'glob reads only HEAD full tree');
  assert.deepEqual(anchorRefs('src/branch.ts', { git }), ['refs/heads/feature']);
});

test('anchor ref lookup handles 600 refs within the command-line limit and rejects invalid tree IDs', () => {
  const file = 'scripts/memory/large-ref-anchor.mjs';
  let head = 'a'.repeat(40);
  const matchingTree = 'b'.repeat(40);
  const refs = new Map(Array.from({ length: 600 }, (_, index) => [
    `refs/${index % 2 ? 'remotes/origin' : 'heads'}/feature-${index}-${'x'.repeat(50)}`,
    index === 300 || index === 599 ? matchingTree : head,
  ]));
  const names = [...refs.keys()];
  const git = (args) => {
    if (args.join(' ').length > 32000) throw Object.assign(new Error('spawnSync git ENAMETOOLONG'), { code: 'ENAMETOOLONG' });
    if (args[0] === '--literal-pathspecs' && args[1] === 'log') return `${'c'.repeat(40)}\n`;
    if (args[0] === 'for-each-ref' && args.some((arg) => arg.startsWith('--contains='))) return `${names[300]}\n${names[599]}\n`;
    if (args[0] === 'for-each-ref') return [...refs].map(([name, tree]) => args[1].includes('%(tree)') ? `${name} ${tree}` : name).join('\n') + '\n';
    if (args[0] === 'rev-parse') return args.slice(1).map((arg) => {
      const name = arg.replace(/\^\{tree\}$/, '');
      return name === 'HEAD' ? head : refs.get(name);
    }).join('\n') + '\n';
    if (args[0] === 'ls-tree') return args[4] === matchingTree ? `${file}\0` : '';
    throw new Error(args.join(' '));
  };
  assert.deepEqual(anchorRefs(file, { git }), [names[300], names[599]]);
  for (const invalid of ['', 'not-a-tree-id']) {
    refs.set(names[599], invalid);
    assert.throws(() => anchorRefs(file, { git }), /^Error: cannot resolve lesson anchor git ref trees$/);
    refs.set(names[599], matchingTree);
    head = invalid;
    assert.throws(() => anchorRefs(file, { git }), /^Error: cannot resolve lesson anchor git ref trees$/);
    head = 'a'.repeat(40);
  }
});

function anchorRepo(t) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'capture-gate-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', [
    '-c', 'user.name=Capture gate test', '-c', 'user.email=capture-gate@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: scrubbedGitEnv() });
  const commitFile = (file) => {
    fs.mkdirSync(join(root, file, '..'), { recursive: true });
    fs.writeFileSync(join(root, file), 'export const here = true;\n');
    git(['add', '--', file]);
    git(['commit', '-m', `add ${file}`]);
  };
  git(['init', '-b', 'master']);
  commitFile('base.mjs');
  return { git, commitFile };
}

test('HEAD deletion excludes stale branch and origin holders but leaves globs unchanged', (t) => {
  const { git: repoGit, commitFile } = anchorRepo(t);
  const calls = [];
  const git = (args) => { calls.push(args); return repoGit(args); };
  const file = 'scripts/memory/deleted.mjs';
  commitFile(file);
  git(['branch', 'old']);
  git(['update-ref', 'refs/remotes/origin/old', 'HEAD']);
  git(['rm', '--', file]);
  git(['commit', '-m', 'delete anchor']);
  assert.deepEqual(anchorRefs(file, { git }), []);
  assert.equal(anchorInRefs(file, { git }), false);
  assert.deepEqual(anchorRefs('scripts/memory/*.mjs', { git }), ['refs/heads/old', 'refs/remotes/origin/old']);
  assert.equal(anchorInRefs('scripts/memory/*.mjs', { git }), true);
  assert.equal(calls.filter((args) => args.includes('log')).length, 1, 'one deletion query per literal path across both APIs; none for globs');
  assert.equal(calls.filter((args) => args.some((arg) => arg.startsWith('--contains='))).length, 1, 'containing refs are cached with the deletion');
});

test('file new on a branch remains a holder without a HEAD deletion', (t) => {
  const { git: repoGit, commitFile } = anchorRepo(t);
  const calls = [];
  const git = (args) => { calls.push(args); return repoGit(args); };
  const file = 'scripts/memory/new.mjs';
  git(['checkout', '-b', 'new']);
  commitFile(file);
  git(['checkout', 'master']);
  assert.deepEqual(anchorRefs(file, { git }), ['refs/heads/new']);
  assert.equal(anchorInRefs(file, { git }), true);
  assert.equal(calls.filter((args) => args.includes('log')).length, 1, 'absence of a deletion is cached too');
  assert.equal(calls.some((args) => args.some((arg) => arg.startsWith('--contains='))), false);
});

test('branch merging HEAD deletion and restoring the file is a holder', (t) => {
  const { git, commitFile } = anchorRepo(t);
  const file = 'scripts/memory/restored.mjs';
  commitFile(file);
  git(['branch', 'restored']);
  git(['branch', 'old']);
  git(['rm', '--', file]);
  git(['commit', '-m', 'delete anchor']);
  git(['checkout', 'restored']);
  git(['merge', '--ff-only', 'master']);
  commitFile(file);
  git(['checkout', 'master']);
  assert.deepEqual(anchorRefs(file, { git }), ['refs/heads/restored']);
  assert.equal(anchorInRefs(file, { git }), true);
});

test('rename in HEAD history leaves no holder for the old literal path', (t) => {
  const { git, commitFile } = anchorRepo(t);
  const file = 'scripts/memory/old.mjs';
  commitFile(file);
  git(['branch', 'old']);
  git(['mv', file, 'scripts/memory/renamed.mjs']);
  git(['commit', '-m', 'rename anchor']);
  assert.deepEqual(anchorRefs(file, { git }), []);
  assert.equal(anchorInRefs(file, { git }), false);
});

test('capture refuses a HEAD-deleted anchor even when an old branch holds it', async (t) => {
  const { git, commitFile } = anchorRepo(t);
  const file = 'scripts/memory/deleted.mjs';
  commitFile(file);
  git(['branch', 'old']);
  git(['rm', '--', file]);
  git(['commit', '-m', 'delete anchor']);
  await assert.rejects(gateNewLesson({ ...candidate, links: { ...candidate.links, anchor: file } }, deps({
    exists: (anchor) => anchorInRefs(anchor, { git }),
    brevity: async () => assert.fail('deleted anchor must refuse before brevity'),
  })), /anchor .* exists in no HEAD, local branch or origin/);
});

test('merge-only deletion excludes old holders and capture refuses the anchor', async (t) => {
  const { git, commitFile } = anchorRepo(t);
  const file = 'scripts/memory/merge-deleted.mjs';
  commitFile(file);
  git(['branch', 'old']);
  git(['checkout', '-b', 'side']);
  commitFile('side.mjs');
  git(['checkout', 'master']);
  commitFile('master.mjs');
  git(['merge', '--no-ff', '--no-commit', 'side']);
  git(['rm', '--', file]);
  git(['commit', '-m', 'delete anchor only in merge result']);
  git(['cat-file', '-e', `HEAD^1:${file}`]);
  git(['cat-file', '-e', `HEAD^2:${file}`]);
  assert.equal(git(['ls-tree', '--name-only', 'HEAD', '--', file]), '');
  await assert.rejects(gateNewLesson({ ...candidate, links: { ...candidate.links, anchor: file } }, deps({
    exists: (anchor) => anchorInRefs(anchor, { git }),
  })), /anchor .* exists in no HEAD, local branch or origin/);
  assert.deepEqual(anchorRefs(file, { git }), []);
  assert.equal(anchorInRefs(file, { git }), false);
});

test('ordinary merge preserves a holder restored after the side deletion, excluding old holders', (t) => {
  const { git, commitFile } = anchorRepo(t);
  const file = 'scripts/memory/side-deleted.mjs';
  commitFile(file);
  git(['branch', 'old']);
  git(['checkout', '-b', 'side']);
  git(['rm', '--', file]);
  git(['commit', '-m', 'delete anchor on side']);
  git(['checkout', '-b', 'restored']);
  commitFile(file);
  git(['checkout', 'master']);
  commitFile('master.mjs');
  git(['merge', '--no-ff', '-m', 'import side deletion', 'side']);
  assert.equal(git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length, 3, 'HEAD really is a two-parent merge');
  assert.deepEqual(anchorRefs(file, { git }), ['refs/heads/restored']);
  assert.equal(anchorInRefs(file, { git }), true);
});

test('anchor lookup peels an annotated-tag remote ref to its commit tree', () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'capture-gate-tag-'));
  const git = (args) => execFileSync('git', [
    '-c', 'user.name=Capture gate test', '-c', 'user.email=capture-gate@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: scrubbedGitEnv() });
  try {
    git(['init', '-b', 'main']);
    fs.writeFileSync(join(root, 'here.mjs'), 'export const here = true;\n');
    git(['add', '.']);
    git(['commit', '-m', 'base']);
    fs.writeFileSync(join(root, 'tag-only.mjs'), 'export const tagged = true;\n');
    git(['add', '.']);
    git(['commit', '-m', 'tagged anchor']);
    git(['tag', '-a', 'lesson-snapshot', '-m', 'annotated snapshot']);
    git(['update-ref', 'refs/remotes/origin/points-at-tag', git(['rev-parse', 'lesson-snapshot']).trim()]);
    git(['reset', '--hard', 'HEAD^']);
    assert.deepEqual(anchorRefs('tag-only.mjs', { git }), ['refs/remotes/origin/points-at-tag']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('actual HEAD non-ASCII path survives git core.quotePath', () => {
  assert.ok(anchorRefs('docs/knowledge/image-notes/base-1-структура-рынка-углублённо.tsv').includes('HEAD'));
});

test('real routing and git reject noncanonical repo paths before any judgement', async () => {
  const goodAnchor = 'scripts/memory/capture-lesson.mjs:captureLesson';
  assert.equal(anchorInRefs(goodAnchor), true);
  const bad = [
    ['./scripts/memory/capture-lesson.mjs:captureLesson', 'scripts/memory/capture-lesson.mjs'],
    ['scripts/./memory/capture-lesson.mjs:captureLesson', 'scripts/memory/capture-lesson.mjs'],
    ['scripts//memory/capture-lesson.mjs:captureLesson', 'scripts/memory/capture-lesson.mjs'],
    ['scripts/memory/../memory/capture-lesson.mjs:captureLesson', 'scripts/memory/capture-lesson.mjs'],
    ['scripts/memory/:captureLesson', 'scripts/memory'],
    ['scripts/memory/capture-lesson.mjs/:captureLesson', 'scripts/memory/capture-lesson.mjs'],
    ['scripts\\memory\\capture-lesson.mjs:captureLesson', 'scripts/memory/capture-lesson.mjs'],
    [`${join(process.cwd(), 'scripts/memory/capture-lesson.mjs')}:captureLesson`, 'scripts/memory/capture-lesson.mjs'],
    ['../capture-lesson.mjs:captureLesson', '../capture-lesson.mjs'],
    // git pathspec magic: a leading ':' must never reach git as a pattern (review reviewer-glm-a0fa26.1).
    [':(icase)scripts/memory/capture-lesson.mjs', ':(icase)scripts/memory/capture-lesson.mjs'],
  ];
  for (const [anchor, suggestion] of bad) {
    assert.equal(anchorInRefs(anchor), false, anchor);
    await assert.rejects(gateNewLesson({ ...candidate, links: { ...candidate.links, domain: 'domain-platform-shell', anchor } }, {
      ask: async () => { assert.fail('path rejected before Jev'); },
    }), (error) => error.message.includes('not normalized repo-relative') && error.message.includes(suggestion), anchor);
  }
});

test('Jev never vetoes on rule, usefulness or anchor fit (#12336); passing result is active', async () => {
  const asked = [];
  const links0 = await gateNewLesson(candidate, deps({ ask: async ({ questions }) => { asked.push(...Object.keys(questions)); return good; } }));
  assert.equal(links0.status, 'active');
  assert.deepEqual(asked, [], 'the gate itself asks Jev nothing; only the injected brevity check may');
  const links = await gateNewLesson(candidate, deps());
  assert.equal(links.status, 'active');
  assert.equal(links.gate.v, 1);
  assert.equal(new Date(links.gate.at).toISOString(), links.gate.at);
});

test('brevity still refuses; no duplicate judgement, and caller duplicate markers are dropped (#12433)', async () => {
  await assert.rejects(gateNewLesson(candidate, deps({ brevity: async () => { throw new Error('shorten this field'); } })), /shorten this field/);
  const forged = { ...candidate, links: { ...candidate.links, possibleDuplicateOf: [42], duplicateCheck: 'incomplete' } };
  const links = await gateNewLesson(forged, deps({ ask: async () => assert.fail('no duplicate question reaches Jev') }));
  assert.equal('possibleDuplicateOf' in links, false);
  assert.equal('duplicateCheck' in links, false);
  assert.equal(links.anchor, candidate.links.anchor);
  assert.equal(links.status, 'active');
});
