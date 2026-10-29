// Delivery gate for a proposed lesson compilation. Stubs stand in for the router and memoryctl.
import '../jev-test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expandTracked, GLOB_PROBE_CAP, main as runMain } from './eval-compile-delivery.mjs';
import { LESSON_CONTEXT_BYTES, renderLessonContext } from '../../ops/bootstrap/lesson-router.mjs';
import { LESSONS_MAX_BYTES, selectLessonsForPath } from './store.mjs';
import { fixtureRouting } from './store-test-helpers.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'eval-compile-delivery-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
mkdirSync(path.join(dir, 'docs/agent'), { recursive: true });
writeFileSync(path.join(dir, 'docs/agent/domain-routing.generated.json'), JSON.stringify(fixtureRouting()));

function main(args, deps) {
  return runMain(args, { repoRoot: dir, expandGlob: (pattern) => expandTracked(pattern), ...deps });
}

const lesson = (id, anchor = 'src/billing/store.ts:widen') => ({
  id,
  uuid: `lesson-${id}`,
  version: 1,
  title: `lesson ${id}`,
  anchor,
  links: { trigger: `editing ${id}`, anchor, domain: 'domain-billing', status: 'active' },
  body: `- trigger: editing ${id}\n- rule: keep lesson ${id}\n`,
});

function writeJson(name, value) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

function routed(selectedIds, source = 'anchors', reason) {
  return {
    text: 'body', source, selectedIds, indexedIds: [], bytes: 12,
    ...(reason ? { reason } : {}),
  };
}

test('a lesson delivered before and lost after exits 1 and names the id', async () => {
  const lessons = writeJson('lost-lessons.json', [lesson(7), lesson(8)]);
  const logs = [];
  const code = await main(['compare', '--lessons', lessons, '--no-cache'], {
    log: (line) => logs.push(line),
    err: () => {},
    lessonsForPath: () => ({ items: [{ id: 7 }, { id: 8 }], omitted: 0 }),
    // Seat drops 7 only on the after pass. Lead still delivers it, so a seat-only check must fire.
    renderLessonContext: async ({ role, phase }) => routed(phase === 'after' && role === 'coder' ? [8] : [7, 8]),
  });
  const payload = JSON.parse(logs.at(-1));
  assert.equal(code, 1);
  assert.deepEqual(payload.lost, [7]);
  assert.equal(payload.detail[0].seat, true);
  assert.equal(payload.detail[0].lead, false);

  const leadLogs = [];
  const leadCode = await main(['compare', '--lessons', lessons, '--no-cache'], {
    log: (line) => leadLogs.push(line),
    err: () => {},
    lessonsForPath: () => ({ items: [{ id: 7 }, { id: 8 }], omitted: 0 }),
    renderLessonContext: async ({ role, phase }) => routed(phase === 'after' && role === 'lead' ? [8] : [7, 8]),
  });
  const lead = JSON.parse(leadLogs.at(-1));
  assert.equal(leadCode, 1);
  assert.deepEqual(lead.lost, [7]);
  assert.equal(lead.detail[0].lead, true);
  assert.equal(lead.detail[0].seat, false);
});

test('a retired id that disappears is not a loss', async () => {
  const lessons = writeJson('retire-lessons.json', [lesson(7), lesson(8)]);
  const retire = path.join(dir, 'retire.txt');
  writeFileSync(retire, '7\n');
  const logs = [];
  const code = await main(['compare', '--lessons', lessons, '--retire', retire, '--no-cache'], {
    log: (line) => logs.push(line),
    err: () => {},
    lessonsForPath: () => ({ items: [{ id: 7 }, { id: 8 }], omitted: 0 }),
    renderLessonContext: async ({ sources }) => routed(sources.flatMap((source) => source.envelope.items.map((item) => item.id)), 'jev'),
  });
  const payload = JSON.parse(logs.at(-1));
  assert.equal(code, 0);
  assert.deepEqual(payload.lost, []);
  assert.equal(payload.after.retired, 1);
});

test('compare pairs unchanged scores across retirement but still detects a removed delivery', async () => {
  const file = 'src/billing/store.ts';
  const lessons = writeJson('drifting-lessons.json', [lesson(7, file), lesson(8, file)]);
  const retire = path.join(dir, 'drifting-retire.txt');
  const merged = writeJson('drifting-merged.json', { 7: 8 });
  const items = [7, 8].map((id) => ({
    id, title: `lesson ${id}`, anchor: file, trigger: `editing ${id}`,
    rule: `keep lesson ${id}`, match: 'anchor',
  }));
  for (const merge of [false, true]) {
    // Retiring a merge's survivor really removes the old lesson's delivery.
    writeFileSync(retire, merge ? '8\n' : '7\n');
    const logs = [];
    const errors = [];
    let requests = 0;
    const code = await main([
      'compare', '--lessons', lessons, '--retire', retire, '--no-cache',
      ...(merge ? ['--merged', merged] : []),
    ], {
      log: (line) => logs.push(line), err: (line) => errors.push(line),
      lessonsForPath: () => ({ items, omitted: 0 }),
      routeKnowledgeSections: () => ({ sections: [] }),
      renderLessonContext: (call) => renderLessonContext({
        ...call,
        ask: async ({ questions }) => {
          const score = ++requests <= 4 ? 0.77 : 0.58;
          return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: score }])) };
        },
      }),
    });
    assert.equal(code, merge ? 1 : 0, errors.join('\n'));
    assert.deepEqual(JSON.parse(logs.at(-1)).lost, merge ? [7] : []);
  }
});

test('compare re-scores changed questions and proposed candidates without freezing neighbours', async () => {
  const file = 'src/billing/store.ts';
  const originals = [
    { ...lesson(7, file), body: `- rule: ${'X'.repeat(1300)}original tail` },
    lesson(8, file),
  ];
  const envelopes = liveEnvelopes(originals, [file]);
  const cases = [
    ['title', '--moved', { 7: { title: 'changed title' } }, [7]],
    ['body', '--moved', { 7: { body: `- rule: ${'X'.repeat(1300)}changed tail` } }, [7]],
    ['trigger', '--moved', { 7: { trigger: 'different question' } }, [7]],
    ['anchor', '--moved', { 7: { anchor: 'src/billing/other.ts' } }, [7]],
    ['same-anchor', '--moved', { 7: { anchor: file } }, [7]],
    ['compiled', '--compiled', { 7: 'not present on page' }, [7]],
    ['merged', '--merged', { 7: 8 }, [7, 8]],
    ['question', null, null, [7, 8]],
    ['content-tail', null, null, [7]],
  ];
  for (const [name, option, proposal, lost] of cases) {
    const logs = [];
    const errors = [];
    const code = await main([
      'compare', '--lessons', writeJson(`rescore-${name}-lessons.json`, originals),
      ...(option ? [option, writeJson(`rescore-${name}-proposal.json`, proposal)] : []), '--no-cache',
    ], {
      log: (line) => logs.push(line), err: (line) => errors.push(line),
      loadLessons: async () => originals,
      lessonsForPath: (probed) => envelopes[probed] ?? { items: [], omitted: 0 },
      routeKnowledgeSections: () => ({ sections: [] }),
      renderLessonContext: (call) => renderLessonContext({
        ...call,
        brief: name === 'question' && call.phase === 'after' ? `${call.brief}\nA different task` : call.brief,
        sources: name === 'content-tail' && call.phase === 'after'
          ? call.sources.map((source) => ({ ...source, envelope: { ...source.envelope,
            items: source.envelope.items.map((item) => item.id === 7
              ? { ...item, rule: `${'X'.repeat(1300)}changed tail` } : item),
          } })) : call.sources,
        ask: async ({ questions }) => ({
          answers: Object.fromEntries(Object.keys(questions).map((key) => [key, {
            noul: call.phase === 'before' ? 0.77 : 0.58,
          }])),
        }),
      }),
    });
    assert.equal(code, 1, `${name}: ${errors.join('\n')}`);
    assert.deepEqual(JSON.parse(logs.at(-1)).lost, lost, name);
  }
});

test('compare re-asks a lesson when only its rendered match changes', async () => {
  const file = 'src/billing/store.ts';
  const logs = [];
  const asked = [];
  const afterSources = [];
  const code = await main([
    'compare', '--lessons', writeJson('match-change-lessons.json', [lesson(7, file)]), '--no-cache',
  ], {
    log: (line) => logs.push(line), err: () => {},
    lessonsForPath: () => ({ items: [{
      id: 7, title: 'lesson 7', anchor: file, trigger: 'editing 7', rule: 'keep lesson 7', match: 'anchor',
    }], omitted: 0 }),
    routeKnowledgeSections: () => ({ sections: [] }),
    renderLessonContext: async (call) => {
      const result = await renderLessonContext({
        ...call,
        sources: call.sources.map((source) => ({ ...source, envelope: { ...source.envelope,
          items: source.envelope.items.map((item) => ({ ...item, match: call.phase === 'after' ? 'class' : item.match })),
        } })),
        ask: async ({ questions }) => {
          asked.push(`${call.phase}:${call.role}`);
          return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, {
            noul: call.phase === 'before' ? 0.77 : 0.58,
          }])) };
        },
      });
      if (call.phase === 'after') afterSources.push(result.source);
      return result;
    },
  });
  assert.deepEqual(asked, ['before:coder', 'before:lead', 'after:coder', 'after:lead']);
  assert.deepEqual(afterSources, ['jev', 'jev']);
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(logs.at(-1)).lost, [7]);
});

test('a page that was the only delivery, then lost, exits 1', async () => {
  const row = (page) => ({
    id: 9,
    retired: false,
    seat: { lesson: false, page, source: 'cache' },
    leadEdit: { lesson: false, page: false, source: 'cache' },
    leadRead: { page: false },
  });
  const before = writeJson('page-before.json', { summary: { jevSources: { cache: 1 } }, rows: [row(true)] });
  const after = writeJson('page-after.json', { summary: { jevSources: { cache: 1 } }, rows: [row(false)] });
  const logs = [];
  const code = await main(['--before', before, '--after', after], {
    log: (line) => logs.push(line),
    err: () => {},
  });
  const payload = JSON.parse(logs.at(-1));
  assert.equal(code, 1);
  assert.deepEqual(payload.lost, [9]);
  assert.equal(payload.detail[0].seat, true);

  // Lead Read was the only lead delivery. Seat body stays, so this is not a seat loss.
  const leadRow = (page) => ({
    id: 11,
    retired: false,
    seat: { lesson: true, page: false, source: 'anchors' },
    leadEdit: { lesson: false, page: false, source: 'anchors' },
    leadRead: { page },
  });
  const leadBefore = writeJson('lead-page-before.json', { summary: { jevSources: { anchors: 1 } }, rows: [leadRow(true)] });
  const leadAfter = writeJson('lead-page-after.json', { summary: { jevSources: { anchors: 1 } }, rows: [leadRow(false)] });
  const leadLogs = [];
  const leadCode = await main(['compare', '--before', leadBefore, '--after', leadAfter], {
    log: (line) => leadLogs.push(line),
    err: () => {},
  });
  const lead = JSON.parse(leadLogs.at(-1));
  assert.equal(leadCode, 1);
  assert.deepEqual(lead.lost, [11]);
  assert.equal(lead.detail[0].lead, true);
  assert.equal(lead.detail[0].seat, false);
});

test('an unavailable probe source exits 2 and names the cause', async () => {
  const lessons = writeJson('unavailable-lessons.json', [lesson(7)]);
  const errors = [];
  const logs = [];
  const code = await main(['--lessons', lessons, '--no-cache'], {
    log: (line) => logs.push(line),
    err: (line) => errors.push(line),
    lessonsForPath: () => ({ items: [{ id: 7 }], omitted: 0 }),
    renderLessonContext: async () => routed([], 'unavailable', 'request-failed'),
  });
  assert.equal(code, 2);
  assert.equal(logs.length, 0);
  assert.match(errors.join('\n'), /unavailable/);
  assert.match(errors.join('\n'), /request-failed/);
  assert.match(errors.join('\n'), /lesson 7/);

  const saved = writeJson('unavailable-report.json', {
    summary: { jevSources: { unavailable: 1 } },
    rows: [{ id: 7, seat: { lesson: true, page: false, source: 'unavailable', reason: 'timeout' }, leadEdit: { lesson: true, page: false, source: 'jev' }, leadRead: { page: false } }],
  });
  const kept = writeJson('kept-report.json', {
    summary: { jevSources: { jev: 1 } },
    rows: [{ id: 7, seat: { lesson: false, page: false, source: 'jev' }, leadEdit: { lesson: false, page: false, source: 'jev' }, leadRead: { page: false } }],
  });
  const fileErrors = [];
  const fileCode = await main(['compare', '--before', saved, '--after', kept], {
    log: () => {},
    err: (line) => fileErrors.push(line),
  });
  assert.equal(fileCode, 2);
  assert.match(fileErrors.join('\n'), /unavailable/);
});

test('jev, cache and anchors are valid probe sources', async () => {
  const lessons = writeJson('valid-lessons.json', [lesson(7)]);
  for (const source of ['jev', 'cache', 'anchors']) {
    const logs = [];
    const code = await main(['--lessons', lessons, '--no-cache'], {
      log: (line) => logs.push(line),
      err: () => {},
      lessonsForPath: () => ({ items: [{ id: 7 }], omitted: 0 }),
      renderLessonContext: async () => routed([7], source),
    });
    const summary = JSON.parse(logs.at(-1));
    assert.equal(code, 0, source);
    assert.equal(summary.seatContent, 1, source);
    assert.equal(summary.jevSources[source], 1, source);
    assert.equal(summary.jevSources.unavailable, undefined, source);
  }
});

test('--no-cache passes cacheDir null and the default leaves the router cache on', async () => {
  const lessons = writeJson('cache-lessons.json', [lesson(7)]);
  const seen = [];
  const code = await main(['--lessons', lessons, '--no-cache'], {
    log: () => {},
    err: () => {},
    lessonsForPath: () => ({ items: [{ id: 7 }], omitted: 0 }),
    renderLessonContext: async (call) => {
      seen.push(call.cacheDir);
      return routed([7], 'anchors');
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, [null, null]);

  const defaults = [];
  const plain = await main(['--lessons', lessons], {
    log: () => {},
    err: () => {},
    lessonsForPath: () => ({ items: [{ id: 7 }], omitted: 0 }),
    renderLessonContext: async (call) => {
      defaults.push(call.cacheDir);
      return routed([7], 'anchors');
    },
  });
  assert.equal(plain, 0);
  assert.deepEqual(defaults, [undefined, undefined]);
});

test('a merged lesson is delivered when its survivor is selected, and lost when the survivor is not', async () => {
  const lessons = writeJson('merge-lessons.json', [lesson(7), lesson(8)]);
  const merged = writeJson('merged.json', { 7: 8 });
  const kept = await main(['compare', '--lessons', lessons, '--merged', merged, '--no-cache'], {
    log: () => {},
    err: () => {},
    lessonsForPath: () => ({ items: [{ id: 7 }, { id: 8 }], omitted: 0 }),
    renderLessonContext: async ({ phase }) => routed(phase === 'after' ? [8] : [7, 8], 'jev'),
  });
  assert.equal(kept, 0);

  const logs = [];
  const lost = await main(['compare', '--lessons', lessons, '--merged', merged, '--no-cache'], {
    log: (line) => logs.push(line),
    err: () => {},
    lessonsForPath: () => ({ items: [{ id: 7 }, { id: 8 }], omitted: 0 }),
    renderLessonContext: async ({ phase }) => routed(phase === 'after' ? [] : [7, 8], 'anchors'),
  });
  assert.equal(lost, 1);
  assert.ok(JSON.parse(logs.at(-1)).lost.includes(7));
});

test('--tree is the knowledge root of the after pass', async () => {
  const tree = path.join(dir, 'after-tree');
  const page = path.join(tree, '.agents/domains/domain-billing/knowledge.md');
  mkdirSync(path.dirname(page), { recursive: true });
  const line = 'COMPILED-LINE-billing-unique-2685';
  writeFileSync(page, `## Billing\n\n${line}\n`);
  const lessons = writeJson('tree-lessons.json', [lesson(7)]);
  const compiled = writeJson('compiled.json', { 7: line });
  const seen = [];
  const code = await main(['compare', '--lessons', lessons, '--compiled', compiled, '--tree', tree, '--no-cache'], {
    log: () => {},
    err: () => {},
    lessonsForPath: () => ({ items: [{ id: 7 }], omitted: 0 }),
    renderLessonContext: async () => routed([7], 'cache'),
    routeKnowledgeSections: ({ pageFor }) => {
      const body = pageFor('domain-billing');
      seen.push(body?.text ?? '');
      return { sections: [body?.text ?? ''] };
    },
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].includes(line), false);
  assert.equal(seen[1].includes(line), true);
});

const selected = (sources) => sources.flatMap((source) => source.envelope.items.map((item) => item.id));

test('compare probes L globs, so a survivor that does not cover them is a loss', async () => {
  const left = lesson(7, 'collector.rs:run');
  left.links.globs = ['chunk_store.rs'];
  const right = lesson(8, 'codec.rs:run');
  right.links.globs = ['collector.rs'];
  const lessons = writeJson('glob-cover.json', [left, right]);
  const merged = writeJson('glob-cover-merged.json', { 7: 8 });
  const seen = [];
  const logs = [];
  const code = await main(['compare', '--lessons', lessons, '--merged', merged, '--no-cache'], {
    log: (line) => logs.push(line),
    err: () => {},
    lessonsForPath: (file) => {
      seen.push(file);
      if (file === 'chunk_store.rs') return { items: [{ id: 7 }], omitted: 0, domain: 'domain-billing' };
      if (file === 'collector.rs') return { items: [{ id: 7 }, { id: 8 }], omitted: 0, domain: 'domain-billing' };
      return { items: [{ id: 8 }], omitted: 0, domain: 'domain-billing' };
    },
    renderLessonContext: async ({ sources }) => routed(selected(sources)),
  });
  assert.ok(seen.includes('chunk_store.rs'));
  assert.equal(code, 1);
  assert.ok(JSON.parse(logs.at(-1)).lost.includes(7));
});

test('a glob anchor is expanded, and an unprobeable glob fails compare closed', async () => {
  const lessons = writeJson('glob-anchor.json', [lesson(9, 'src/billing_v4/*.rs'), lesson(10, 'codec.rs:run')]);
  const merged = writeJson('glob-anchor-merged.json', { 9: 10 });
  const seen = [];
  const lostCode = await main(['compare', '--lessons', lessons, '--merged', merged, '--no-cache'], {
    log: () => {},
    err: () => {},
    expandGlob: (pattern) => (pattern.includes('*') ? ['src/billing_v4/b.rs', 'src/billing_v4/a.rs'] : [pattern]),
    lessonsForPath: (file) => {
      seen.push(file);
      return { items: file.startsWith('src/billing_v4/') ? [{ id: 9 }] : [{ id: 10 }], omitted: 0 };
    },
    renderLessonContext: async ({ sources }) => routed(selected(sources)),
  });
  assert.equal(lostCode, 1);
  assert.deepEqual(seen.filter((file) => file.startsWith('src/billing_v4/')), ['src/billing_v4/a.rs', 'src/billing_v4/b.rs']);

  const errs = [];
  const closed = await main(['compare', '--lessons', lessons, '--merged', merged, '--no-cache'], {
    log: () => {},
    err: (line) => errs.push(line),
    expandGlob: (pattern) => (pattern.includes('*') ? [] : [pattern]),
    lessonsForPath: () => ({ items: [{ id: 10 }], omitted: 0 }),
    renderLessonContext: async ({ sources }) => routed(selected(sources)),
  });
  assert.equal(closed, 2);
  assert.match(errs.join('\n'), /lesson 9 cannot be probed/);

  const wide = expandTracked('scripts/memory/*');
  assert.ok(wide.length > 0 && wide.length <= GLOB_PROBE_CAP);
  assert.deepEqual(wide, [...wide].sort());
});

test('lead Edit budget subtracts the hook domain skill hint', async (t) => {
  const skills = ['test-audit', 'verify-change'];
  const read = fs.readFileSync;
  const stub = t.mock.method(fs, 'readFileSync', (file, options) => (
    file === path.resolve('ops/bootstrap/domain-skills.json')
      ? JSON.stringify({ domains: { 'domain-billing': { skills } } })
      : read(file, options)
  ));
  syncBuiltinESMExports();
  t.after(() => {
    stub.mock.restore();
    syncBuiltinESMExports();
  });
  const lessons = writeJson('skill-budget.json', [lesson(7)]);
  let budget;
  const code = await main(['--lessons', lessons, '--no-cache'], {
    log: () => {},
    err: () => {},
    lessonsForPath: () => ({ domain: 'domain-billing', items: [{ id: 7 }], omitted: 0 }),
    renderLessonContext: async (call) => {
      if (call.role === 'lead') budget = call.budget;
      return routed([7], 'cache');
    },
  });
  const hint = `The method for domain-billing — load what this edit warrants (Skill tool):\n${skills.map((skill) => `- ${skill}`).join('\n')}`;
  const file = 'src/billing/store.ts';
  const bare = Buffer.byteLength(`What is already known about ${file} (delivered once this session):\n\nDurable lessons (memoryctl):\n`);
  const withSkills = Buffer.byteLength(
    `What is already known about ${file} (delivered once this session):\n\n${hint}\n\nDurable lessons (memoryctl):\n`,
  );
  assert.equal(code, 0);
  assert.ok(budget < LESSON_CONTEXT_BYTES - bare);
  assert.equal(budget, LESSON_CONTEXT_BYTES - withSkills);
});

async function compareMoved(name, proposals, {
  lessons = [lesson(7, 'src/billing/dead.ts:widen')], envelopes = {}, activeLessons = lessons, args = [],
} = {}) {
  const logs = [];
  const errors = [];
  const calls = [];
  const out = path.join(dir, `${name}-out.json`);
  const code = await main([
    'compare', '--lessons', writeJson(`${name}-lessons.json`, lessons),
    '--moved', writeJson(`${name}-moved.json`, proposals), '--no-cache', '--out', out, ...args,
  ], {
    log: (line) => logs.push(line),
    err: (line) => errors.push(line),
    loadLessons: async () => activeLessons,
    lessonsForPath: (file) => envelopes[file] ?? { domain: 'domain-billing', items: [], omitted: 0 },
    routeKnowledgeSections: () => ({ sections: [] }),
    renderLessonContext: async (call) => {
      const result = await renderLessonContext({
        ...call,
        ask: async ({ questions }) => ({
          answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 1 }])),
        }),
      });
      calls.push({ ...call, result });
      return result;
    },
  });
  return {
    code, errors, calls,
    payload: logs.length ? JSON.parse(logs.at(-1)) : null,
    report: logs.length ? JSON.parse(readFileSync(out, 'utf8')) : null,
  };
}

test('a dead-anchor lesson moved to a live file is delivered after', async () => {
  const original = lesson(7, 'src/billing/dead.ts:widen');
  original.links.trigger = 'editing widen';
  const result = await compareMoved('dead-to-live', {
    7: { anchor: 'src/billing/store.ts:widen', trigger: 'editing widen' },
  }, { lessons: [original] });
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.equal(result.report.beforeRows[0].seat.lesson, false);
  assert.equal(result.report.afterRows[0].file, 'src/billing/store.ts');
  assert.equal(result.report.afterRows[0].seat.lesson, true);
  assert.equal(result.report.afterRows[0].leadEdit.lesson, true);
  assert.deepEqual(result.payload.movedUndelivered, []);
  assert.ok(result.calls.filter((call) => call.phase === 'after').every((call) => call.brief.includes('editing widen')));
});

test('a move that crowds out a destination neighbour reports that neighbour lost', async () => {
  const neighbour = {
    uuid: 'neighbour-8', id: 8, title: 'ZZZ neighbour', anchor: 'src/billing/other.ts:widen',
    trigger: 'editing widen', rule: 'N'.repeat(3500), why: null, evidence: null, date: null, rank: 1, match: 'class',
  };
  const neighbourLesson = {
    ...lesson(8, neighbour.anchor), title: neighbour.title, body: `- rule: ${neighbour.rule}`,
    links: { ...lesson(8, neighbour.anchor).links, globs: ['src/billing/store.ts'], trigger: neighbour.trigger },
  };
  const result = await compareMoved('crowded-neighbour', {
    7: { anchor: 'src/billing/store.ts:widen', title: 'AAA moved', body: `- rule: ${'M'.repeat(3500)}`, trigger: 'editing widen' },
  }, {
    lessons: [lesson(7, 'src/billing/dead.ts:widen'), neighbourLesson],
    envelopes: {
      'src/billing/store.ts': { domain: 'domain-billing', items: [neighbour], omitted: 0 },
      'src/billing/other.ts': { domain: 'domain-billing', items: [{ ...neighbour, match: 'anchor' }], omitted: 0 },
    },
  });
  assert.equal(result.code, 1, result.errors.join('\n'));
  assert.deepEqual(result.payload.lost, [8]);
  assert.deepEqual(result.payload.movedUndelivered, []);
  assert.ok(result.report.beforeRows.some((row) => row.id === 8 && row.seat.lesson));
  assert.ok(result.report.afterRows.some((row) => row.id === 8 && !row.seat.lesson));
  assert.ok(result.report.afterRows.some((row) => row.id === 8 && !row.probeFile && row.seat.lesson));
});

test('compare --multi ranks companions once, so a re-anchor cannot lose unrelated lessons', async () => {
  const file = (name) => `src/billing/${name}.ts`;
  const wide = (id, name, rule) => {
    const anchor = file(name);
    return {
      ...lesson(id, anchor), body: `- rule: ${rule}`,
      links: { trigger: `editing ${id}`, anchor, domain: 'domain-billing', status: 'active' },
    };
  };
  const item = (id, anchor, rule) => ({
    id, title: `lesson ${id}`, anchor, trigger: `editing ${id}`, rule, match: 'anchor',
  });
  // Before the move the top-2 companions are [quiet, gate]; the mover is the only
  // lesson on gate, so moving it to quiet drops gate off the ranking and lifts
  // storm (a huge lesson) into the after top-2, crowding out a victim that never moved.
  const lessons = [
    wide(1, 'quiet', 'Q'.repeat(200)),
    wide(2, 'quiet', 'Q'.repeat(200)),
    lesson(7, file('gate')),
    wide(9, 'storm', 'S'.repeat(3300)),
    { ...lesson(8, `${file('victim')}:widen`), body: `- rule: ${'V'.repeat(2200)}` },
  ];
  const stub = (items) => ({ domain: 'domain-billing', items, omitted: 0 });
  const envelopes = {
    [file('quiet')]: stub([item(1, file('quiet'), 'Q'.repeat(200)), item(2, file('quiet'), 'Q'.repeat(200))]),
    [file('gate')]: stub([item(7, file('gate'), 'keep lesson 7')]),
    [file('storm')]: stub([item(9, file('storm'), 'S'.repeat(3300))]),
    [file('victim')]: stub([item(8, `${file('victim')}:widen`, 'V'.repeat(2200))]),
  };
  const result = await compareMoved('multi-companions', { 7: { anchor: file('quiet') } }, {
    lessons, envelopes, args: ['--multi'],
  });
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.deepEqual(result.payload.lost, []);
  assert.deepEqual(result.payload.movedUndelivered, []);
  // The victim really was delivered before, so the empty loss list is not vacuous.
  assert.equal(result.report.beforeRows.find((row) => row.id === 8 && !row.probeFile).seat.lesson, true);
  assert.equal(result.report.afterRows.find((row) => row.id === 8 && !row.probeFile).seat.lesson, true);
  // Both phases probe the same companion set for a lesson that never moved.
  const filesOf = (phase) => result.calls.find((call) => call.phase === phase
    && call.brief.startsWith(file('victim'))).sources.map((source) => source.file);
  assert.deepEqual(filesOf('after'), filesOf('before'));
  assert.equal(filesOf('before').includes(file('storm')), false);
});

test('a move removes the lesson from old-anchor envelopes without removing other lessons', async () => {
  const original = lesson(7, 'src/billing/dead.ts:widen');
  const result = await compareMoved('remove-old-anchor', { 7: { anchor: 'src/billing/store.ts:widen' } }, {
    lessons: [original, lesson(9, original.anchor)],
    envelopes: {
      'src/billing/dead.ts': {
        domain: 'domain-billing', omitted: 0,
        items: [7, 9].map((id) => ({
          id, title: `lesson ${id}`, anchor: original.anchor, trigger: 'editing widen', rule: 'keep this rule', match: 'anchor',
        })),
      },
    },
  });
  assert.equal(result.code, 0, result.errors.join('\n'));
  const oldCall = result.calls.find((call) => call.phase === 'after' && call.sources[0].file === 'src/billing/dead.ts');
  assert.deepEqual(oldCall.sources[0].envelope.items.map((item) => item.id), [9]);
  assert.deepEqual(result.payload.lost, []);
});

test('a cross-domain move exits 2 and names the routed domain', async () => {
  const result = await compareMoved('cross-domain', { 7: { anchor: 'scripts/memory/store.mjs' } });
  assert.equal(result.code, 2);
  assert.match(result.errors.join('\n'), /lesson 7.*domain-harness.*domain-billing/);
  assert.equal(result.calls.length, 0);
  const explicit = await compareMoved('explicit-domain', {
    7: { anchor: 'scripts/memory/store.mjs', domain: 'domain-harness' },
  });
  assert.equal(explicit.code, 0, explicit.errors.join('\n'));
  assert.deepEqual(explicit.payload.movedUndelivered, []);
});

test('a supersede body change reaches the envelope and keeps its anchor', async () => {
  const original = { ...lesson(7), uuid: 'lesson-7' };
  original.links.trigger = 'new explicit trigger';
  const result = await compareMoved('supersede-body', {
    7: { title: 'Rewritten lesson', body: '- trigger: new body trigger\n- rule: rewritten rule\n  continued rule\n- why: new reason\n- evidence: new proof\n- date: 2026-10-21', trigger: 'new explicit trigger' },
  }, {
    lessons: [original],
    envelopes: {
      'src/billing/store.ts': {
        domain: 'domain-billing', items: [{
          uuid: 'lesson-7', id: 7, title: original.title, anchor: original.anchor,
          trigger: original.links.trigger, rule: 'keep lesson 7', why: null, evidence: null, date: null, rank: 1, match: 'anchor',
        }], omitted: 0,
      },
    },
  });
  assert.equal(result.code, 0, result.errors.join('\n'));
  const after = result.calls.find((call) => call.phase === 'after');
  assert.deepEqual(after.sources[0].envelope.items, [{
    uuid: 'lesson-7', id: 7, title: 'Rewritten lesson', anchor: original.anchor,
    trigger: 'new explicit trigger', rule: 'rewritten rule\ncontinued rule', why: 'new reason',
    evidence: 'new proof', date: '2026-10-21', rank: 1, match: 'anchor',
  }]);
  assert.ok(after.brief.includes('new explicit trigger'));
  assert.equal(result.calls[0].sources[0].envelope.items[0].rule, 'keep lesson 7');
});

test('a moved lesson still undelivered after exits 1 even without a prior delivery', async () => {
  const result = await compareMoved('still-undelivered', {
    7: { anchor: 'src/billing/store.ts:widen', body: `- rule: ${'X'.repeat(9000)}` },
  });
  assert.equal(result.code, 1, result.errors.join('\n'));
  assert.deepEqual(result.payload.lost, []);
  assert.deepEqual(result.payload.movedUndelivered, [7]);
});

test('--moved rejects malformed entries and ids outside the requested set', async () => {
  for (const [name, proposals, message] of [
    ['array', [], /--moved must be a JSON object/],
    ['bad-id', { nope: { anchor: 'src/billing/store.ts' } }, /invalid.*id/],
    ['null', { 7: null }, /invalid.*entry/],
    ['empty', { 7: {} }, /invalid.*entry/],
    ['bad-anchor', { 7: { anchor: '' } }, /invalid.*anchor/],
    ['bad-body', { 7: { body: 42 } }, /invalid.*body/],
    ['unknown-field', { 7: { anchor: 'src/billing/store.ts', typo: true } }, /unknown.*typo/],
    ['unknown-id', { 8: { anchor: 'src/billing/store.ts' } }, /8.*probed set/],
  ]) {
    const result = await compareMoved(`invalid-${name}`, proposals);
    assert.equal(result.code, 2, name);
    assert.match(result.errors.join('\n'), message, name);
    assert.equal(result.calls.length, 0, name);
  }
});

function liveEnvelopes(lessons, files) {
  const map = fixtureRouting();
  const rows = lessons.map((row) => ({ ...row, links: JSON.stringify(row.links) }));
  return Object.fromEntries(files.map((file) => [file, selectLessonsForPath(rows, file, map)]));
}

test('chained moves keep primary obligations and still detect non-moved neighbour displacement', async () => {
  const store = 'src/billing/store.ts';
  const destination = 'src/billing/other2.ts';
  const neighbourFile = 'src/billing/neighbour.ts';
  for (const crowdNeighbour of [false, true]) {
    const lessons = [lesson(7, 'src/billing/dead.ts'), lesson(8, store)];
    if (crowdNeighbour) {
      const neighbour = { ...lesson(9, neighbourFile), title: 'ZZZ neighbour', body: `- rule: ${'N'.repeat(3500)}` };
      neighbour.links.globs = [store];
      lessons.push(neighbour);
    }
    const result = await compareMoved(`chained-${crowdNeighbour}`, {
      7: { anchor: store, title: 'AAA moved', body: `- rule: ${'M'.repeat(3500)}` },
      8: { anchor: destination },
    }, { lessons, envelopes: liveEnvelopes(lessons, [store, destination, neighbourFile]) });
    assert.equal(result.code, crowdNeighbour ? 1 : 0, result.errors.join('\n'));
    assert.deepEqual(result.payload.lost, crowdNeighbour ? [9] : []);
    assert.deepEqual(result.payload.movedUndelivered, []);
    for (const rows of [result.report.beforeRows, result.report.afterRows]) {
      assert.equal(rows.some((row) => [7, 8].includes(row.id) && row.probeFile), false);
    }
    assert.ok(result.report.afterRows.some((row) => row.id === 8 && !row.probeFile && row.seat.lesson));
    if (crowdNeighbour) {
      assert.ok(result.report.beforeRows.some((row) => row.id === 9 && row.probeFile === store && row.seat.lesson));
      assert.ok(result.report.afterRows.some((row) => row.id === 9 && row.probeFile === store && !row.seat.lesson));
      assert.ok(result.report.afterRows.some((row) => row.id === 9 && !row.probeFile && row.seat.lesson));
    }
  }
});

test('--moved refuses explicitly blank trigger and body fields before probing', async () => {
  const results = [];
  for (const field of ['trigger', 'body']) {
    for (const [label, value] of [['empty', ''], ['whitespace', ' \t\n ']]) {
      results.push({
        field,
        result: await compareMoved(`blank-${field}-${label}`, {
          7: { anchor: 'src/billing/store.ts', [field]: value },
        }),
      });
    }
  }
  assert.deepEqual(results.map(({ result }) => result.code), [2, 2, 2, 2]);
  for (const { field, result } of results) {
    assert.match(result.errors.join('\n'), new RegExp(`--moved has an invalid ${field} on lesson 7`));
    assert.equal(result.calls.length, 0);
    assert.equal(result.payload, null);
  }
});

test('near-ceiling destinations pack moved lessons and neighbours before scoring delivery', async () => {
  const file = 'src/billing/store.ts';
  const filler = { ...lesson(8, file), title: 'AAA filler', body: `- rule: ${'F'.repeat(LESSONS_MAX_BYTES - 2200)}` };
  const neighbour = { ...lesson(9, file), title: 'CCC neighbour', body: `- rule: ${'N'.repeat(600)}` };
  const moving = lesson(7, 'src/billing/dead.ts:widen');
  const activeLessons = [filler, neighbour, moving];
  const before = liveEnvelopes(activeLessons, [file])[file];
  assert.deepEqual(before.items.map((item) => item.id), [8, 9]);
  for (const [name, title, lost, undelivered] of [
    ['move-omitted', 'ZZZ moved', [], [7]],
    ['neighbour-omitted', 'BBB moved', [9], []],
  ]) {
    const result = await compareMoved(`ceiling-${name}`, {
      7: { anchor: file, title, body: `- rule: ${'M'.repeat(1200)}` },
    }, { lessons: [moving], activeLessons, envelopes: { [file]: before } });
    assert.equal(result.code, 1, result.errors.join('\n'));
    assert.deepEqual(result.payload.lost, lost, name);
    assert.deepEqual(result.payload.movedUndelivered, undelivered, name);
    const after = result.calls.find((call) => call.phase === 'after').sources[0].envelope;
    assert.equal(after.omitted, 1, name);
    assert.ok(after.bytes <= LESSONS_MAX_BYTES, name);
    assert.equal(after.bytes, Buffer.byteLength(JSON.stringify(after)), name);
    assert.deepEqual(after.items.map((item) => item.id), name === 'move-omitted' ? [8, 9] : [8, 7]);
  }
});

test('a glob-bearing body-only supersede preserves delivery on every claimed file', async () => {
  const original = lesson(7);
  original.links.globs = ['src/billing/other.ts'];
  const envelopes = liveEnvelopes([original], ['src/billing/store.ts', 'src/billing/other.ts']);
  const result = await compareMoved('glob-supersede', { 7: { body: '- rule: rewritten glob rule' } }, {
    lessons: [original], envelopes,
  });
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.deepEqual(result.payload.lost, []);
  assert.deepEqual(result.payload.movedUndelivered, []);
  const after = result.calls.find((call) => call.phase === 'after');
  assert.equal(after.sources.length, 2);
  for (const { envelope } of after.sources) {
    assert.equal(envelope.items.find((item) => item.id === 7)?.rule, 'rewritten glob rule');
    assert.equal(envelope.bytes, Buffer.byteLength(JSON.stringify(envelope)));
  }
});

test('repacking a shrinking supersede admits an active candidate omitted from the live envelope', async () => {
  const file = 'src/billing/store.ts';
  const original = { ...lesson(7, file), title: 'AAA original', body: `- rule: ${'X'.repeat(LESSONS_MAX_BYTES - 1000)}` };
  const candidate = { ...lesson(8, file), title: 'BBB omitted', body: `- rule: ${'C'.repeat(1200)}` };
  const activeLessons = [original, candidate];
  const envelopes = liveEnvelopes(activeLessons, [file]);
  assert.deepEqual(envelopes[file].items.map((item) => item.id), [7]);
  assert.equal(envelopes[file].omitted, 1);
  const result = await compareMoved('admit-omitted', { 7: { body: '- rule: small replacement', trigger: 'must not replace links' } }, {
    lessons: [original], activeLessons, envelopes,
  });
  assert.equal(result.code, 0, result.errors.join('\n'));
  const after = result.calls.find((call) => call.phase === 'after').sources[0].envelope;
  assert.deepEqual(after.items.map((item) => item.id), [7, 8]);
  assert.equal(after.omitted, 0);
  assert.equal(after.items[0].trigger, original.links.trigger);
});

test('re-anchors drop the old anchor glob, retain same-domain globs, and discard globs on refile', async () => {
  const oldFile = 'src/billing/old.ts';
  const retainedFile = 'src/billing/retained.ts';
  const harnessFile = 'scripts/memory/other.mjs';
  for (const [name, anchor, domain, expectedFiles, expectedTrigger] of [
    ['same-domain', 'src/billing/store.ts', 'domain-billing', ['src/billing/store.ts', retainedFile], 'editing 7'],
    ['refile', 'scripts/memory/store.mjs', 'domain-harness', ['scripts/memory/store.mjs'], 'refile trigger'],
    ['glob-refile', 'scripts/memory/store.mj?', 'domain-harness', ['scripts/memory/store.mjs'], 'refile trigger'],
  ]) {
    const original = lesson(7, oldFile);
    original.links.globs = [oldFile, retainedFile];
    const other = lesson(9, harnessFile);
    other.links.domain = 'domain-harness';
    const activeLessons = [original, lesson(8, oldFile), lesson(10, retainedFile), other];
    const result = await compareMoved(`link-rules-${name}`, {
      7: { anchor, domain, trigger: 'refile trigger' },
    }, {
      lessons: activeLessons, activeLessons,
      envelopes: liveEnvelopes(activeLessons, [oldFile, retainedFile, harnessFile, 'scripts/memory/store.mjs', 'src/billing/store.ts']),
    });
    assert.equal(result.code, 0, result.errors.join('\n'));
    const primary = result.calls.find((call) => call.phase === 'after' && call.brief.includes(expectedFiles[0]));
    assert.deepEqual(primary.sources.map((source) => source.file), expectedFiles, name);
    assert.equal(primary.sources[0].envelope.items.find((item) => item.id === 7)?.trigger, expectedTrigger, name);
    const oldCall = result.calls.find((call) => call.phase === 'after' && call.sources[0].file === oldFile);
    assert.equal(oldCall.sources[0].envelope.items.some((item) => item.id === 7), false, name);
    if (name !== 'same-domain') {
      const retainedCall = result.calls.find((call) => call.phase === 'after' && call.sources[0].file === retainedFile);
      assert.equal(retainedCall.sources[0].envelope.items.some((item) => item.id === 7), false, name);
    }
  }
});
