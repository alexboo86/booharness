import '../jev-test-state.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { captureLesson, validateCaptureArgs, renderLesson } from './capture-lesson.mjs';
import { checkLesson, lessonFields, lessonChanges, withLongReason, LIMITS, TARGETS } from './lesson-quality.mjs';

test('capture reports routed domain substitution and posts the corrected links without a live write', async () => {
  const input = { domain: 'other', title: 'Route test', anchor: 'scripts/memory/capture-lesson.mjs:captureLesson', trigger: 'When routing a new lesson', rule: 'R', why: 'W', evidence: 'scripts/memory/capture-lesson.mjs' };
  let posted;
  const result = await captureLesson(input, { resolve: () => {}, run: (args) => {
    posted = JSON.parse(args[args.indexOf('--links') + 1]);
    return { stdout: 'id=1' };
  } });
  assert.equal(posted.domain, 'domain-harness');
  assert.equal(result.domain, 'domain-harness');
  assert.equal(result.substitution, 'domain other -> domain-harness: routed for scripts/memory/capture-lesson.mjs');
  assert.equal((await captureLesson({ ...input, domain: 'harness' }, { resolve: () => {}, run: () => ({ stdout: 'id=2' }) })).substitution,
    'domain harness -> domain-harness: routed for scripts/memory/capture-lesson.mjs');
});

test('renderLesson emits the anchored schema', () => {
  const out = renderLesson({ title: 'X', anchor: 'a.rs:f', rule: 'do Y', why: 'because', evidence: 'commit abc', date: '2026-06-27' });
  assert.match(out, /## X/);
  assert.match(out, /anchor: a\.rs:f/);
  assert.match(out, /rule: do Y/);
  assert.match(out, /date: 2026-06-27/);
});

test('renderLesson omits trigger line when absent', () => {
  const out = renderLesson({ title: 'X', anchor: 'a', rule: 'r', why: 'w', evidence: 'e', date: 'd' });
  assert.ok(!out.includes('trigger:'));
});

test('renderLesson includes trigger line when present', () => {
  const out = renderLesson({ title: 'X', anchor: 'a', trigger: 'when Z', rule: 'r', why: 'w', evidence: 'e', date: 'd' });
  assert.match(out, /trigger: when Z/);
});

const fields = { title: 'One rule', rule: 'Do X', trigger: 'When X', why: 'Prevents Y', evidence: 'test 1' };
test('short lesson passes; parsed fields are unchanged', async () => {
  await checkLesson(fields);
  assert.deepEqual(lessonFields('One rule', renderLesson({ ...fields, anchor: 'a.mjs:x', date: '2026-09-23' })), fields);
});

test('targets are advice, even when every field exceeds its target', async () => {
  const overTarget = Object.fromEntries(Object.keys(LIMITS).map(name => [name, '💡'.repeat((TARGETS[name] ?? LIMITS[name] / 2) + 1)]));
  await checkLesson(overTarget);
  await checkLesson({ ...fields, trigger: '' }, { only: ['trigger'] });
});

test('ceilings count code points; no reason refuses only fields over their ceiling', async () => {
  for (const name of Object.keys(LIMITS)) {
    await checkLesson({ ...fields, [name]: '💡'.repeat(LIMITS[name]) }, { only: [name] });
    await assert.rejects(checkLesson({ ...fields, [name]: '💡'.repeat(LIMITS[name] + 1) }, { only: [name] }),
      new RegExp(`${name}: ${LIMITS[name] + 1} chars / ${LIMITS[name]}; --long reason required`));
  }
  await assert.rejects(checkLesson({ ...fields, title: 'T'.repeat(121), rule: 'R'.repeat(301) }), error => {
    assert.match(error.message, /title: 121 chars \/ 120; --long reason required; target ~40 \(advice\)/);
    assert.match(error.message, /rule: 301 chars \/ 300; --long reason required; target ~110 \(advice\)/);
    return true;
  });
});

test('a nonempty --long reason allows over-ceiling fields, but not missing fields', async () => {
  await checkLesson({ ...fields, rule: 'R'.repeat(301) }, { long: 'necessary explanation' });
  await assert.rejects(checkLesson({ ...fields, rule: 'R'.repeat(301) }, { long: ' ' }), /--long needs a nonempty explanation/);
  await assert.rejects(checkLesson({ ...fields, rule: '' }, { long: 'reason' }), /lesson rule is missing/);
});

test('legacy oversize fields are not judged again on metadata-only supersede', async () => {
  const old = { title: 'X'.repeat(200), body: `- rule: ${'R'.repeat(500)}\n- why: Y\n- evidence: Z` };
  const change = lessonChanges(old, old.title, old.body, { links: { status: 'active' } });
  assert.deepEqual(change.only, []);
  await checkLesson(change.fields, { only: change.only });
  const revised = lessonChanges(old, old.title, old.body.replace('- why: Y', `- why: ${'N'.repeat(200)}`), { links: { status: 'active' } });
  assert.deepEqual(revised.only, ['why']);
  await checkLesson(revised.fields, { only: revised.only });
  assert.deepEqual(lessonChanges(old, `RETIRED: obsolete — ${old.title}`, `${old.body}\n- retired: obsolete`, { links: { status: 'retired' } }).only, []);
});

test('missing lesson field refusal names exact body shape, budgets and capture command', async () => {
  const missing = (error) => {
    assert.match(error.message, /lesson rule is missing/);
    assert.match(error.message, /- rule: <text>, - why: <text>, - evidence: <text>/);
    assert.match(error.message, /title <=120, rule <=300, trigger\/why\/evidence <=400/);
    assert.match(error.message, /suggested targets title ~40, rule ~110 \(one sentence\), why ~120, evidence ~70 \(advice, not refusal\)/);
    assert.match(error.message, /capture-lesson\.mjs <domain> "<title>" --anchor <file:symbol>/);
    return true;
  };
  assert.throws(() => lessonFields('X', 'rule: R\n- why: W\n- evidence: E'), missing);
  await assert.rejects(checkLesson({ ...fields, rule: '' }, { only: ['rule'] }), missing);
});

test('capture-lesson --help and usage failure advertise budgets and --long', () => {
  const help = execFileSync(process.execPath, ['scripts/memory/capture-lesson.mjs', '--help'], { encoding: 'utf8' });
  assert.match(help, /title <=120, rule <=300, trigger\/why\/evidence <=400/);
  assert.match(help, /\[--long "<reason>"\]/);
  assert.match(help, /suggested targets title ~40, rule ~110 \(one sentence\), why ~120, evidence ~70 \(advice, not refusal\); ceilings title <=120/);
  assert.throws(() => validateCaptureArgs({ domain: 'domain-harness', title: '--anchor' }), (error) => {
    assert.match(error.message, /title <=120, rule <=300, trigger\/why\/evidence <=400/);
    assert.match(error.message, /\[--long "<reason>"\]/);
    return true;
  });
});

test('store-compatible multiline parsing and duplicate field refusal', () => {
  const body = '- rule: use checks\n  - keep this bullet\n  then a second line\n- why: Y\n- evidence: Z';
  assert.equal(lessonFields('X', body).rule, 'use checks\n- keep this bullet\nthen a second line');
  assert.throws(() => lessonFields('X', `${body}\n- rule: bypass`), /rule is duplicated/);
  const old = { title: 'X', body: `${body}\n- rule: inherited duplicate` };
  assert.deepEqual(lessonChanges(old, 'X', `${old.body}\n- promoted: today`).only, []);
  assert.throws(() => lessonChanges(old, 'X', `${old.body}\n- rule: third copy`), /rule is duplicated/);
});

test('--long explanation is stored with the lesson', () => {
  assert.match(withLongReason('- rule: R', 'why this needs detail'), /- long: "why this needs detail"/);
});

test('validateCaptureArgs refuses a flag in the title slot', () => {
  // A call that skips the positional title makes argv[3] the next flag ('--title', '--anchor'),
  // and six inbox lessons were captured with that literal as their title (curate 2026-09-06).
  assert.throws(
    () => validateCaptureArgs({ domain: 'domain-harness', title: '--anchor', anchor: 'a.mjs:x', rule: 'r', why: 'w', evidence: 'e' }),
    /usage: capture-lesson\.mjs/,
  );
});

const validCapture = { domain: 'domain-harness', title: 'T', anchor: 'a.mjs:x', trigger: 'When capturing a lesson', rule: 'r', why: 'w', evidence: '82414fc' };

test('missing --trigger is refused like the other required flags', async () => {
  const { trigger, ...withoutTrigger } = validCapture;
  assert.ok(trigger, 'fixture must carry a trigger');
  assert.throws(() => validateCaptureArgs(withoutTrigger), /--trigger is required/);
  assert.throws(() => validateCaptureArgs({ ...validCapture, trigger: '?' }), /--trigger is required/);
  await assert.rejects(captureLesson(withoutTrigger), /--trigger is required/);
});

test('prose-only evidence is refused and the refusal names the four forms', () => {
  assert.throws(() => validateCaptureArgs({ ...validCapture, evidence: 'the fix works and reads cleanly' }), error => {
    assert.match(error.message, /--evidence carries none of the reproducible forms/);
    assert.match(error.message, /commit SHA \(7-40 hex chars with at least one digit\)/);
    assert.match(error.message, /memory id #N/);
    assert.match(error.message, /repo-relative path that exists in this checkout/);
    assert.match(error.message, /check\/test command/);
    return true;
  });
  // Whole tokens, never substrings: a hex run inside a word, 'nodescript' and a
  // digit-less hex word like 'deadbeef' are prose.
  assert.throws(() => validateCaptureArgs({ ...validCapture, evidence: 'fixed abc1234issue via nodescript and deadbeef' }), /--evidence carries none/);
});

test('each reproducible evidence form is accepted', () => {
  for (const evidence of [
    'commit 82414fc4ecd2a8d9302c9c60cb8881aef780fe17',
    'memory #12433',
    'scripts/memory/capture-lesson.mjs',
    'node scripts/memory/test-capture-lesson.mjs',
  ]) {
    validateCaptureArgs({ ...validCapture, evidence });
  }
});

// Prose puts a comma, a bracket or a full stop next to an id; 16 of 21 lessons of task 2809
// were refused for that alone. Only edge punctuation goes: 'abc1234issue' above stays prose.
test('an id, a SHA or a path next to prose punctuation is accepted', () => {
  for (const evidence of [
    '(memoryctl #15463, task 2278)',
    'live on master 82414fc.',
    'decision #18503): 252 refusals',
    'the guard lives in scripts/memory/capture-lesson.mjs.',
  ]) {
    validateCaptureArgs({ ...validCapture, evidence });
  }
});
