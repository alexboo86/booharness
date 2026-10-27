import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { run } from './apply-lesson-fixes.mjs';
import { checkLesson } from './lesson-quality.mjs';

function fixture(actions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-fixes-test-'));
  fs.mkdirSync(path.join(dir, 'bodies'));
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(actions));
  return { dir, file: path.join(dir, 'plan.json') };
}
const lesson = id => ({ id, kind: 'lesson', live: true, title: `Lesson ${id}`, body: '- rule: old\n- why: old\n- evidence: old\n', links: { anchor: 'scripts/memory/store.mjs', domain: 'domain-harness', status: 'active' } });
const improved = '- rule: improved\n- why: cause\n- evidence: test\n';
const quality = async () => ({ longIgnored: false });

function stub(rows, { failAt = 0 } = {}) {
  const writes = [];
  return { writes, call(command, args) {
    if (args[0] === 'get') {
      const id = Number(args[1]);
      const row = rows[id];
      return JSON.stringify(args.includes('--follow') && row?.superseded_by ? rows[row.superseded_by] : row);
    }
    writes.push([command, ...args]);
    if (writes.length === failAt) throw new Error('stubbed failure');
    const id = Number(args[args.indexOf('--id') + 1]);
    rows[id] = { ...rows[id], live: false };
    return '';
  } };
}

test('retirement quality preflight preserves emoji at the 480-code-point title boundary', async () => {
  for (const into of [undefined, 9]) {
    const head = `${into ? `MERGED-INTO: ${into}` : 'RETIRED: dup'} — `;
    const current = { ...lesson(10), title: `${'a'.repeat(479 - head.length)}😀tail` };
    const f = fixture([{ id: 10, action: 'retire', reason: 'dup', ...(into ? { into } : {}) }]);
    const tools = stub({ 10: current, 9: lesson(9) });
    let judged = false;
    try {
      await run(f.file, { call: tools.call, quality: async (fields, options) => {
        judged = true;
        assert.equal(fields.title, `${head}${'a'.repeat(479 - head.length)}😀`);
        assert.equal([...fields.title].length, 480);
        assert.equal(Buffer.from(fields.title, 'utf8').toString('utf8'), fields.title);
        return checkLesson(fields, options);
      } });
      assert.ok(judged, 'the actual retirement preflight must run');
      assert.equal(tools.writes.length, 0);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('dry run uses the full lesson quality check for a changed body, never writes', async () => {
  const f = fixture([{ id: 10, action: 'rewrite', bodyFile: 'bodies/10.md' }]);
  fs.writeFileSync(path.join(f.dir, 'bodies/10.md'), improved);
  const tools = stub({ 10: lesson(10) });
  let judged = 0;
  try {
    assert.deepEqual(await run(f.file, { call: tools.call, quality: async (fields, { only }) => {
      judged++; assert.deepEqual(only, ['rule', 'why', 'evidence']);
      return checkLesson(fields, { only });
    } }), { applied: [], skipped: [] });
    assert.equal(judged, 1);
    assert.equal(tools.writes.length, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('dry run refuses a ceiling objection before any write', async () => {
  const f = fixture([{ id: 10, action: 'rewrite', bodyFile: 'bodies/10.md' }]);
  fs.writeFileSync(path.join(f.dir, 'bodies/10.md'), improved);
  const tools = stub({ 10: lesson(10) });
  try {
    await assert.rejects(run(f.file, { call: tools.call, quality: async () => { throw new Error('lesson refused: rule: 301 chars / 300; --long reason required'); } }), /--long reason required/);
    assert.equal(tools.writes.length, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('apply stops at first writer failure; reports prefix and untouched remainder', async () => {
  const f = fixture([10, 11, 12].map(id => ({ id, action: 'retire', reason: 'stale' })));
  const tools = stub({ 10: lesson(10), 11: lesson(11), 12: lesson(12) }, { failAt: 2 });
  try {
    await assert.rejects(run(f.file, { apply: true, call: tools.call, quality }), /STOP #11 \(retire\): stubbed failure; applied=\[10\]; remaining=\[11,12\]/);
    assert.equal(tools.writes.length, 2);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('refuses retire when survivor follows to the retiree or is no longer active', async () => {
  const f = fixture([{ id: 11470, action: 'retire', into: 1555, reason: 'duplicate' }]);
  const old = { ...lesson(1555), live: false, superseded_by: 11470 };
  const current = lesson(11470);
  const tools = stub({ 1555: old, 11470: current });
  try {
    await assert.rejects(run(f.file, { apply: true, call: tools.call, quality }), /survivor #1555 is not a separate live active lesson/);
    assert.equal(tools.writes.length, 0);
    old.superseded_by = null;
    await assert.rejects(run(f.file, { call: tools.call, quality }), /survivor #1555 is not a separate live active lesson/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('accepts a survivor superseded by the preceding merge if its latest head is live', async () => {
  const f = fixture([{ id: 12, action: 'retire', into: 10, reason: 'duplicate' }]);
  const tools = stub({ 10: { ...lesson(10), live: false, superseded_by: 20 }, 20: lesson(20), 12: lesson(12) });
  try { await run(f.file, { call: tools.call, quality }); assert.equal(tools.writes.length, 0); }
  finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('rerun skips a completed rewrite and refuses unrelated supersession', async () => {
  const f = fixture([{ id: 10, action: 'rewrite', bodyFile: 'bodies/10.md' }]);
  fs.writeFileSync(path.join(f.dir, 'bodies/10.md'), improved);
  const row = { ...lesson(10), live: false, body: improved };
  const tools = stub({ 10: row });
  try {
    assert.deepEqual((await run(f.file, { apply: true, call: tools.call, quality })).skipped, [10]);
    assert.equal(tools.writes.length, 0);
    row.body = 'unrelated change';
    await assert.rejects(run(f.file, { apply: true, call: tools.call, quality }), /re-adjudicate/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('redomain gates new links and removes its temporary body', async () => {
  const f = fixture([{ id: 10, action: 'redomain', anchor: 'scripts/memory/lesson-lib.mjs', into: 'domain-harness' }]);
  const original = lesson(10);
  original.links.domain = 'domain-platform-shell';
  const tools = stub({ 10: original });
  try {
    await run(f.file, { apply: true, call: tools.call, quality, gate: (_row, links) => ({ ...links, gate: { v: 1 } }) });
    const args = tools.writes[0];
    assert.equal(tools.writes.length, 1);
    assert.equal(JSON.parse(args[args.indexOf('--links') + 1]).anchor, 'scripts/memory/lesson-lib.mjs');
    assert.equal(fs.existsSync(args[args.indexOf('--body-file') + 1]), false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('real quality budget refusal happens before a write', async () => {
  const f = fixture([{ id: 10, action: 'rewrite', bodyFile: 'bodies/10.md' }]);
  fs.writeFileSync(path.join(f.dir, 'bodies/10.md'), `- rule: ${'x'.repeat(301)}\n- why: cause\n- evidence: test\n`);
  const tools = stub({ 10: lesson(10) });
  try {
    await assert.rejects(run(f.file, { apply: true, call: tools.call, quality: (fields, { only }) => checkLesson(fields, { only }) }), /--long reason required/);
    assert.equal(tools.writes.length, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
