import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROBE_MATCH_TIMEOUT_MS,
  extract,
  makeVerbChecker,
  matchUnderDeadline,
  runProbe,
  sweep,
  windowsEntryPoint,
} from './sweep-probes.mjs';
import { probeObjections } from './lesson-lib.mjs';

const lesson = (id, body, probe = null) => ({ id, title: `lesson ${id}`, body, domain: 'domain-harness', probe });
const world = (over = {}) => ({
  npmScripts: new Set(['test:memory', 'check:skills-drift']),
  repoFiles: new Set(['scripts/memory/store.mjs']),
  verb: () => 'keep',
  ...over,
});

test('extract finds npm scripts, cli verbs and repo paths', () => {
  const e = extract('run `npm run test:memory`, then rtk gain, see scripts/memory/store.mjs');
  assert.deepEqual(e.npm, ['test:memory']);
  assert.deepEqual(e.cli, ['rtk gain']);
  assert.deepEqual(e.paths, ['scripts/memory/store.mjs']);
});

test('a colon after the script name is punctuation, not part of it', () => {
  // The shape that broke it: prose introducing a sensor with a colon.
  const e = extract('три скила Свода. npm run test:harness-audit: проза вернулась');
  assert.deepEqual(e.npm, ['test:harness-audit']);
});

test('a trailing dash or underscore is punctuation too', () => {
  assert.deepEqual(extract('npm run test:memory — свип').npm, ['test:memory']);
  assert.deepEqual(extract('npm run test:memory_ hm').npm, ['test:memory']);
});

test('a live gate introduced with a colon is not reported gone', () => {
  // End to end: this is what kept `sweep:probes` red. `gone` is the only
  // severity that fails, so one sentence of prose was enough.
  const rows = sweep([lesson(1, 'сенсор: npm run test:memory: проза вернулась')], world());
  assert.deepEqual(rows[0].gone, []);
});

test('extract does not mistake a preposition for a subcommand', () => {
  // "memoryctl is the only route" must not probe for a verb named "is".
  assert.deepEqual(extract('memoryctl is the only route').cli, []);
});

test('an npm script the repo does not have is gone, and gone fails', () => {
  const rows = sweep([lesson(1, 'the gate is `npm run check:nothing`')], world());
  assert.deepEqual(rows[0].gone, ['npm run check:nothing']);
});

test('an npm script the repo has counts as answered', () => {
  const rows = sweep([lesson(1, 'sensor: `npm run test:memory`')], world());
  assert.deepEqual(rows[0].gone, []);
  assert.equal(rows[0].keep, 1);
});

test('a verb missing from --help drifts, it does not fail', () => {
  const rows = sweep([lesson(1, 'rtk stat is not a subcommand')], world({ verb: () => 'drift' }));
  assert.deepEqual(rows[0].drift, ['rtk stat']);
  assert.deepEqual(rows[0].gone, []);
});

test('a binary that is not installed here is unknown, never drift', () => {
  // A laptop without svod must not report the whole corpus rotten.
  const rows = sweep([lesson(1, 'svod status shows the map')], world({ verb: () => 'unknown' }));
  assert.deepEqual(rows[0].drift, []);
});

test('makeVerbChecker asks each binary once and caches the answer', () => {
  let calls = 0;
  const check = makeVerbChecker(() => {
    calls += 1;
    return { stdout: 'Commands:\n  gain   show savings\n  proxy  raw passthrough\n' };
  });
  assert.equal(check('rtk', 'gain'), 'keep');
  assert.equal(check('rtk', 'proxy'), 'keep');
  assert.equal(check('rtk', 'stat'), 'drift');
  assert.equal(calls, 1);
});

test('makeVerbChecker reports unknown when the binary cannot run', () => {
  const check = makeVerbChecker(() => ({ error: new Error('ENOENT') }));
  assert.equal(check('svod', 'status'), 'unknown');
});

// --- declared probes: the exact half -------------------------------------
// A probe answers only when the command SUCCEEDED, so the stub says so.
const exec = (out) => () => ({ stdout: out, stderr: '', status: 0 });

test('a declared expect that still matches keeps the lesson', () => {
  const r = runProbe({ cmd: 'rtk gain --help', expect: '--reset' }, exec('  --reset  Reset all stats\n'));
  assert.equal(r.verdict, 'keep');
});

test('a declared expect that stopped matching is broken', () => {
  const r = runProbe({ cmd: 'rtk gain --help', expect: '--reset' }, exec('  -q, --quota\n'));
  assert.equal(r.verdict, 'broken');
});

test('expect-absent is how a lesson asserts an ABSENCE, and it breaks when the thing appears', () => {
  // The 2026-08-05 case: lesson 866 said rtk had no reset. It has one now.
  const gone = runProbe({ cmd: 'rtk gain --help', absent: 'reset|clear|purge' }, exec('  -q, --quota\n'));
  assert.equal(gone.verdict, 'keep');
  const back = runProbe({ cmd: 'rtk gain --help', absent: 'reset|clear|purge' }, exec('  --reset  Reset all stats\n'));
  assert.equal(back.verdict, 'broken');
});

test('a probe is re-validated at run time, not trusted because it was stored', () => {
  let ran = false;
  const r = runProbe({ cmd: 'rtk gain; rm -rf /tmp/x', expect: 'a' }, () => {
    ran = true;
    return { stdout: '' };
  });
  assert.equal(r.verdict, 'refused');
  assert.equal(ran, false, 'a refused probe must never reach the executor');
});

test('a probe whose binary is absent is unknown, not broken', () => {
  const r = runProbe({ cmd: 'codegraph node X', expect: 'run' }, () => ({ error: new Error('ENOENT') }));
  assert.equal(r.verdict, 'unknown');
});

test('a declared probe answers for its lesson instead of the heuristics', () => {
  const rows = sweep(
    [lesson(1, 'rtk stat is not a subcommand', { cmd: 'rtk gain --help', absent: 'stat' })],
    world({ verb: () => 'drift', exec: exec('  -q, --quota\n') }),
  );
  assert.equal(rows[0].declared.verdict, 'keep');
});

test('the probe allowlist rejects an entry point that is not read-only', () => {
  assert.ok(probeObjections({ cmd: 'curl http://x', expect: 'a' }).some((s) => s.includes('must start with')));
});

// --- the allowlist is a gate, not a prefix test ---------------------------
// Review of 3a8994eec: every case below passed the old `startsWith` check, and
// the string it checks comes OUT OF THE MEMORY DATABASE and is then executed.

test('a node probe may not climb out of the audited list', () => {
  // Traversal was the first round's finding; the path is normalized before it
  // is compared, so `scripts/../../../evil.mjs` is not "under scripts/" twice over.
  const bad = probeObjections({ cmd: 'node scripts/../../../evil.mjs', expect: 'a' });
  assert.ok(bad.length > 0, `traversal must be refused, got: ${bad.join('; ')}`);
  assert.ok(probeObjections({ cmd: 'node scripts/../scripts/memory/test-sweep-probes.mjs', expect: 'a' }).length === 0,
    'a normalized path that lands ON an audited entry point is the same entry point');
});

test('node may run an audited file, and only a file', () => {
  assert.deepEqual(probeObjections({ cmd: 'node scripts/rtk-gain-split.mjs --json', expect: 'operator' }), []);
  // `node -e "<anything>"` is arbitrary code with a read-only-looking prefix.
  assert.ok(probeObjections({ cmd: 'node -e process.exit(0)', expect: 'a' }).length > 0);
});

test('git is admitted by reading verb, never by the prefix "git "', () => {
  for (const write of ['git push', 'git fetch origin', 'git config user.email x']) {
    const bad = probeObjections({ cmd: write, expect: 'a' });
    assert.ok(bad.length > 0, `${write} must be refused`);
  }
  for (const read of ['git diff --stat', 'git log -1 --format=%H', 'git ls-files scripts/']) {
    assert.deepEqual(probeObjections({ cmd: read, expect: 'a' }), [], `${read} must be allowed`);
  }
});

test('a wrapper binary may not be used to run something else', () => {
  // rtk <cmd> runs <cmd>; memoryctl append writes. Both passed the old prefix.
  assert.ok(probeObjections({ cmd: 'rtk git push', expect: 'a' }).length > 0);
  assert.ok(probeObjections({ cmd: 'memoryctl append --kind fact', expect: 'a' }).length > 0);
  assert.deepEqual(probeObjections({ cmd: 'rtk gain --help', expect: 'a' }), []);
  assert.deepEqual(probeObjections({ cmd: 'memoryctl search x', expect: 'a' }), []);
});

test('a probe that FAILED to run is unknown, never keep', () => {
  // The dangerous direction: with --expect-absent a crashed command prints
  // nothing, nothing matches, and silence reads as "the lesson still holds".
  const failed = () => ({ stdout: '', stderr: 'error: unknown option\n', status: 1 });
  const r = runProbe({ cmd: 'rtk gain --help', absent: 'reset' }, failed);
  assert.equal(r.verdict, 'unknown');
  assert.match(r.detail, /exited 1/);
  const killed = runProbe({ cmd: 'rtk gain --help', absent: 'reset' }, () => ({ stdout: '', status: null, signal: 'SIGTERM' }));
  assert.equal(killed.verdict, 'unknown');
});

test('a catastrophic pattern is refused, so the sweep cannot hang on it', () => {
  const probe = { cmd: 'rtk gain --help', absent: '(a+)+$' };
  assert.ok(probeObjections(probe).some((s) => /quantifier/i.test(s)), 'nested quantifier must be refused at capture');
  const started = process.hrtime.bigint();
  const r = runProbe(probe, exec(`${'a'.repeat(40000)}b`));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(r.verdict, 'refused');
  assert.ok(ms < 1000, `a refusal must be instant, took ${ms}ms`);
});

test('an overlong pattern is refused before it is ever compiled from the db', () => {
  assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: 'x'.repeat(500) }).some((s) => s.includes('longer than')));
});

// --- round 2: the layer under the closed blockers -------------------------
// Measured by the Svod round on the first fix: a READ verb still writes and
// still executes, because only the verb was judged and never its arguments.

test('a reading git verb may not be handed a writing or executing flag', () => {
  for (const writes of [
    'git log -1 --output=C:/tmp/x',
    'git show --output=C:/tmp/x HEAD',
    'git diff --output=C:/tmp/x HEAD~1 HEAD',
    'git show --textconv HEAD',
    'git diff --ext-diff HEAD~1',
    'git log --exec-path=C:/evil',
  ]) {
    assert.ok(probeObjections({ cmd: writes, expect: 'a' }).length > 0, `${writes} must be refused`);
  }
  for (const reads of [
    'git diff --stat',
    'git log -1 --format=%H',
    'git log --oneline -5',
    'git status --porcelain',
    'git ls-files scripts/',
    'git rev-parse HEAD',
    'git show --stat HEAD',
  ]) {
    assert.deepEqual(probeObjections({ cmd: reads, expect: 'a' }), [], `${reads} must stay allowed`);
  }
});

test('a chain of optional atoms is a quantifier chain, and it is refused', () => {
  // `a?a?a?…aaa…` backtracks exponentially without a single * + or {.
  const evil = `${'a?'.repeat(40)}${'a'.repeat(40)}`;
  assert.ok(evil.length <= 200);
  assert.ok(
    probeObjections({ cmd: 'rtk gain --help', absent: evil }).some((s) => /quantifier/i.test(s)),
    'an optional-atom chain must be refused',
  );
  // `(?:` opens a group and `*?` is laziness — neither is an extra quantifier.
  assert.deepEqual(probeObjections({ cmd: 'rtk gain --help', expect: '(?:keep=)\\d+?' }), []);
});

test('adjacent quantified atoms are the exponential shape a group nesting rule cannot see', () => {
  // Measured by review: `a*a*a*b` scores 4 quantifiers, no nesting, and V8 does
  // not finish it on 2000 characters.
  for (const evil of ['a*a*a*b', '[a-z]*[a-z]*[a-z]*x', 'a?a?a?a?aaaa']) {
    assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: evil }).length > 0, `${evil} must be refused`);
  }
  for (const fine of ['keep=\\d+', 'swept \\d+ live lessons', '\\s*broken=\\d+ .*gone=\\d+', '(?:keep|broken)=\\d+']) {
    assert.deepEqual(probeObjections({ cmd: 'rtk gain --help', expect: fine }), [], `${fine} must stay allowed`);
  }
});

test('the match itself runs under a deadline, so a pattern the scanner missed cannot wedge the sweep', () => {
  // The scanner is a heuristic over regexp source and always will be. What makes
  // a hang impossible is that the match runs somewhere killable.
  const started = process.hrtime.bigint();
  const answer = matchUnderDeadline('(a+)+$', `${'a'.repeat(40000)}b`);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(answer.answered, false, 'a pattern that cannot finish must report that it did not');
  assert.ok(ms < PROBE_MATCH_TIMEOUT_MS * 3, `the deadline must bound it, took ${ms}ms`);
  assert.deepEqual(matchUnderDeadline('keep=\\d+', 'sweep-probes: keep=207'), { answered: true, matched: true });
  assert.deepEqual(matchUnderDeadline('keep=\\d+', 'nothing here'), { answered: true, matched: false });
});

// --- round 3: what the second layer still admitted ------------------------

test('a flag that persists a file is not a reading flag, whatever the verb', () => {
  // The same defect class as `git --output=`, through other binaries.
  assert.ok(probeObjections({ cmd: 'memoryctl search x --out report.json', expect: 'a' }).length > 0);
  assert.ok(probeObjections({ cmd: 'codegraph node X --save out.json', expect: 'a' }).length > 0);
  assert.deepEqual(probeObjections({ cmd: 'codegraph callers X --limit 5', expect: 'a' }), []);
});

test('a probe field that is not a string is refused, not coerced', () => {
  // `new RegExp({})` compiles to /[object Object]/ and judges a lesson by it.
  assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: {} }).length > 0);
  assert.ok(probeObjections({ cmd: 'rtk gain --help', absent: 42 }).length > 0);
  assert.ok(probeObjections({ cmd: ['rtk', 'gain'], expect: 'a' }).length > 0);
});

test('a command whose exit status is unknowable is unknown, not keep', () => {
  const r = runProbe({ cmd: 'rtk gain --help', expect: 'x' }, () => ({ stdout: 'x' }));
  assert.equal(r.verdict, 'unknown');
});

test('a quantified alternation of distinct literals is not the ambiguous shape', () => {
  // `(a|aa)+` overlaps and backtracks; `(?:foo|bar)+` does not — measured by
  // review at 47 ms over 60001 characters, and refusing it costs a real probe.
  assert.deepEqual(probeObjections({ cmd: 'rtk gain --help', expect: '^(?:foo|bar)+$' }), []);
  assert.deepEqual(probeObjections({ cmd: 'rtk gain --help', expect: '(keep|broken|gone)+' }), []);
  assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: '(a|aa)+' }).length > 0);
  assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: '(a|ab)*x' }).length > 0);
  assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: '([a-z]|\\w+)+' }).length > 0);
});

// --- round 4: a family name is not an audit --------------------------------

test('node runs an audited entry point, not a family of names', () => {
  // Measured by review: `check-` and `sweep-` are naming conventions, not
  // contracts. `node scripts/check-portability.mjs --write-baseline` rewrites a
  // tracked baseline, `scripts/memory/sweep-anchors.mjs` calls
  // `memoryctl registry-update`, and `scripts/test-deepseek-classifier.mjs`
  // goes to the network — every one of them passed the family rule.
  for (const writes of [
    'node scripts/check-portability.mjs --write-baseline',
    'node scripts/check-large-file-ratchet.mjs --write-baseline',
    'node scripts/check-doc-graph.mjs --write-baseline',
    'node scripts/memory/sweep-anchors.mjs',
    'node scripts/test-deepseek-classifier.mjs',
  ]) {
    assert.ok(probeObjections({ cmd: writes, expect: 'a' }).length > 0, `${writes} must be refused`);
  }
  assert.deepEqual(probeObjections({ cmd: 'node scripts/memory/test-sweep-probes.mjs', expect: 'fail 0' }), []);
  // Not even an audited script may be handed an argument nobody audited.
  assert.ok(probeObjections({ cmd: 'node scripts/memory/test-sweep-probes.mjs --write-baseline', expect: 'a' }).length > 0);
});

test('npm run names an audited script, not a namespace', () => {
  // `test:memory-routing` regenerates a tracked file; `sweep:probes` is the
  // sweep itself. Both live in namespaces the old rule waved through.
  for (const writes of ['npm run test:memory-routing', 'npm run sweep:probes', 'npm run check:ui-canon']) {
    assert.ok(probeObjections({ cmd: writes, expect: 'a' }).length > 0, `${writes} must be refused`);
  }
  assert.deepEqual(probeObjections({ cmd: 'npm run test:memory', expect: 'pass' }), []);
});

test('a probe may state one expectation, not two', () => {
  // Measured by review: both were accepted and the executor silently judged by
  // `absent`, so an output missing BOTH tokens came back `keep`.
  const both = probeObjections({ cmd: 'rtk gain --help', expect: 'MUST-BE-PRESENT', absent: 'MUST-BE-ABSENT' });
  assert.ok(both.some((s) => /one of/i.test(s) || /both/i.test(s)), both.join('; '));
});

test('a separator anywhere in the body forces the split, not only at its ends', () => {
  // Measured by review: `(\w+-\w+)+`, `([A-Z][a-z]+)+` and `(\d+:\d+)+` were
  // refused although every iteration must consume one character the repeating
  // classes cannot match, which is exactly what makes the split forced.
  for (const fine of ['(\\w+-\\w+)+', '([A-Z][a-z]+)+', '(\\d+:\\d+)+', '(?:\\d+\\.){3}\\d+']) {
    assert.deepEqual(probeObjections({ cmd: 'rtk gain --help', expect: fine }), [], `${fine} must stay allowed`);
  }
  // `\f` is a form feed, not the letter f, and `\s` eats it — so this one is
  // ambiguous however it looks.
  for (const evil of ['^(?:\\s+\\f)+$', '(\\w+\\w)+', '(a+)+', '(\\d+\\d*)+']) {
    assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: evil }).length > 0, `${evil} must be refused`);
  }
});

test('alternation is judged by what the branches can match, not by their spelling', () => {
  // `[ab]` and `cd` cannot both match the same text; the earlier rule refused
  // every branch that was not a plain literal, which is not the same question.
  for (const fine of ['(?:[ab]|cd)+', '(?:\\d+|[a-z])', '(?:bar|baz)+']) {
    assert.deepEqual(probeObjections({ cmd: 'rtk gain --help', expect: fine }), [], `${fine} must stay allowed`);
  }
  for (const evil of ['(?:[ab]|ac)+', '(a|aa)+', '(ab|abc)+']) {
    assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: evil }).length > 0, `${evil} must be refused`);
  }
});

test('the output cap is bytes, and a cut output cannot prove an absence', () => {
  // Measured by review: 65538 bytes of `€` are 21846 UTF-16 units, so a
  // character-counted cap left the sweep believing it had read everything.
  const euros = '€'.repeat(21846);
  const r = runProbe({ cmd: 'rtk gain --help', absent: 'zzz' }, () => ({ stdout: euros, status: 0 }));
  assert.equal(r.verdict, 'unknown');
  assert.match(r.detail, /truncat/i);
});

test('a project flag is a write flag for tsc, and npm needs its Windows shim', () => {
  // `tsc --noEmit -p <tsconfig with incremental>` still writes .tsbuildinfo.
  assert.ok(probeObjections({ cmd: 'npx tsc --noEmit -p web/tsconfig.base.json', expect: 'a' }).length > 0);
  assert.deepEqual(probeObjections({ cmd: 'npx tsc --noEmit', expect: 'error' }), []);
  // And an entry point the executor cannot spawn is a probe nobody ever judges.
  const expected = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  assert.equal(windowsEntryPoint('npm'), expected);
  assert.equal(windowsEntryPoint('git'), 'git');
});

test('a dot in a branch is any character, so the branches overlap', () => {
  assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: '^(?:.a|ba)+$' }).length > 0);
  assert.deepEqual(probeObjections({ cmd: 'rtk gain --help', expect: '^(?:\\.a|ba)+$' }), []);
});

test('a short flag written joined to its value is the same flag', () => {
  assert.deepEqual(probeObjections({ cmd: 'git diff -U0', expect: 'a' }), []);
  assert.ok(probeObjections({ cmd: 'git diff -Z9', expect: 'a' }).length > 0);
});

test('alternation branches that merely start alike are still unambiguous', () => {
  for (const fine of ['(?:bar|baz)+', '^(?:foo\\.|bar\\.)+$', '(keep|kept)+']) {
    assert.deepEqual(probeObjections({ cmd: 'rtk gain --help', expect: fine }), [], `${fine} must stay allowed`);
  }
  for (const evil of ['(a|aa)+', '(ab|abc)+']) {
    assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: evil }).length > 0, `${evil} must be refused`);
  }
});

test('svod is not a probe entry point at all — every working form of it writes', () => {
  // Measured by review: `svod status` requires --audit AND --state, --state
  // persists the projection to the path the probe names (847 bytes, parents
  // created), and even a read refreshes .git/svod/index.db. There is no
  // read-only form left to allow.
  for (const cmd of ['svod status --audit a.jsonl --state s.json', 'svod status --audit a.jsonl', 'svod status']) {
    assert.ok(probeObjections({ cmd, expect: 'a' }).length > 0, `${cmd} must be refused`);
  }
});

test('a control character is refused before it can kill the sweep', () => {
  // `spawnSync` throws on an argument containing NUL, synchronously, from
  // inside the matcher — the sweep died mid-corpus and printed no report.
  assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: 'a\0b' }).length > 0);
  assert.ok(probeObjections({ cmd: 'rtk gain\0 --help', expect: 'a' }).length > 0);
  assert.ok(probeObjections({ cmd: 'rtk gain --help', absent: 'ab' }).length > 0);
});

test('a bounded repetition is not exponential, however it nests', () => {
  // `(\d+){2}` repeats twice. Exponential blowup needs an UNBOUNDED outer
  // quantifier; refusing the bounded ones cost real probes for nothing.
  for (const fine of ['(\\d+){2}', '\\d+(\\.\\d+){2}', '(a|b|c){3}', '(error|warn)+', '(ab|cd)*']) {
    assert.deepEqual(probeObjections({ cmd: 'rtk gain --help', expect: fine }), [], `${fine} must stay allowed`);
  }
  assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: '(\\d+){2,}' }).length > 0, 'an open bound is unbounded');
});

test('a repetition anchored by a separator it cannot eat is not the ambiguous shape', () => {
  // Measured by review: these five are bounded — every iteration must consume a
  // literal the inner class does not match — and the deadline answers each in
  // ~57 ms over 64 KB. Refusing them cost real lessons their probe.
  for (const fine of [
    '(?:\\d+\\.){3}\\d+',
    '(\\d+)(\\.\\d+)+',
    '(\\w+\\.){2,}\\w+',
    '(\\w+=\\w+ )+',
    '(\\w+, )+\\w+',
  ]) {
    assert.deepEqual(probeObjections({ cmd: 'rtk gain --help', expect: fine }), [], `${fine} must stay allowed`);
  }
  for (const evil of ['(a+)+$', '([a-z]+)*$', '(\\w+\\w)+', '(\\d+\\d*)+']) {
    assert.ok(probeObjections({ cmd: 'rtk gain --help', expect: evil }).length > 0, `${evil} must be refused`);
  }
});

test('the validator and the executor read the same command, whitespace and all', () => {
  // Measured by review: probeObjections trimmed and accepted `"  git log -1"`,
  // runProbe split the RAW string, spawned `''` and threw TypeError — out of
  // runProbe, out of sweep, and the lessons after it were never judged.
  const seen = [];
  const r = runProbe({ cmd: '  git log -1 --oneline', expect: 'x' }, (bin, args) => {
    seen.push([bin, ...args]);
    return { stdout: 'x', status: 0 };
  }, () => ({ answered: true, matched: true }));
  assert.equal(r.verdict, 'keep');
  assert.deepEqual(seen, [['git', 'log', '-1', '--oneline']]);
});

test('a probe that throws is a verdict, never an escape from the sweep', () => {
  const boom = () => { throw new TypeError("The argument 'file' cannot be empty"); };
  const r = runProbe({ cmd: 'git log -1', expect: 'x' }, boom);
  assert.equal(r.verdict, 'unknown');
  assert.match(r.detail, /cannot be empty/);
  // And the sweep goes on to the lessons behind it.
  const rows = sweep(
    [lesson(1, 'first', { cmd: 'git log -1', expect: 'x' }), lesson(2, 'second', { cmd: 'rtk gain --help', expect: 'x' })],
    world({ exec: boom }),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1].declared.verdict, 'unknown');
});

test('an invalid pattern is not a match, whatever the child exits with', () => {
  // `[` does not compile; a child that dies must not read as "found it".
  const answer = matchUnderDeadline('[', 'anything');
  assert.notEqual(answer.matched, true, 'a pattern that never compiled cannot have matched');
});

test('a probe whose pattern never answers is unknown, not keep and not broken', () => {
  const stalled = () => ({ answered: false });
  const absent = runProbe({ cmd: 'rtk gain --help', absent: 'x' }, exec('out'), stalled);
  assert.equal(absent.verdict, 'unknown');
  const expect = runProbe({ cmd: 'rtk gain --help', expect: 'x' }, exec('out'), stalled);
  assert.equal(expect.verdict, 'unknown');
});

test('a match that could be hiding past the output cut is unknown, never keep', () => {
  const huge = `${'x'.repeat(70 * 1024)}NEEDLE`;
  const absent = runProbe({ cmd: 'rtk gain --help', absent: 'NEEDLE' }, () => ({ stdout: huge, status: 0 }));
  assert.equal(absent.verdict, 'unknown', 'an absence proven only by a truncated output is not proven');
  assert.match(absent.detail, /truncat/i);
  const expect = runProbe({ cmd: 'rtk gain --help', expect: 'NEEDLE' }, () => ({ stdout: huge, status: 0 }));
  assert.equal(expect.verdict, 'unknown', 'a miss on truncated output is not a broken lesson either');
  // Truncation only matters when the pattern did NOT answer inside the cut.
  const found = runProbe({ cmd: 'rtk gain --help', absent: 'x{10}' }, () => ({ stdout: huge, status: 0 }));
  assert.equal(found.verdict, 'broken');
});
