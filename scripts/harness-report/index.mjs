#!/usr/bin/env node
// One screen for the state of the harness, joined from the three journals that
// were already being written and nowhere being read together.
//
// The failure this exists to end: the rtk statistics database split in two on
// 2026-07-28 and the corruption was found on 2026-08-02. For five days the
// savings figure the operator reads was computed over a fraction of the data,
// and there was no place where that could show. Every collector therefore
// reports integrity FIRST and volume second — a number computed over a broken
// or truncated source is worse than no number, because it still looks like an
// answer.
//
//   node scripts/harness-report/index.mjs [--days N] [--json] [--strict]
//
// --strict exits 1 when any check failed, so this can also be a gate. By
// default it always exits 0: a report that breaks a script nobody re-runs is a
// report nobody keeps.

import { collect as collectRtk } from './collect-rtk.mjs';
import { collect as collectMemory } from './collect-memory.mjs';
import { collect as collectLead } from './collect-lead.mjs';

const COLLECTORS = [
  ['rtk', collectRtk],
  ['memory', collectMemory],
  ['lead', collectLead],
];

const MARK = { ok: '  ok  ', warn: ' WARN ', fail: ' FAIL ' };
const RANK = { ok: 0, warn: 1, fail: 2 };

function parseArgs(argv) {
  const args = { days: 7, json: false, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--strict') args.strict = true;
    else if (argv[i] === '--days') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        console.error(`--days needs a positive number, got ${JSON.stringify(argv[i + 1])}`);
        process.exit(2);
      }
      args.days = value;
      i += 1;
    }
  }
  return args;
}

/// A collector is contracted never to throw. This catches it anyway and turns
/// the breach into a visible failed section, because the one thing this report
/// must not do is go quiet about a source.
async function safeCollect(id, collect, days) {
  try {
    const section = await collect({ days });
    if (!section || typeof section !== 'object') {
      throw new Error(`collector returned ${typeof section}, expected a Section`);
    }
    return section;
  } catch (error) {
    return {
      id,
      title: `${id} (collector failed)`,
      health: [{ label: 'collector', status: 'fail', detail: String(error && error.message) }],
      metrics: [],
      rows: [],
      errors: [`collect() threw: ${error && error.stack ? error.stack.split('\n')[0] : error}`],
    };
  }
}

function worstOf(section) {
  return (section.health || []).reduce(
    (acc, entry) => (RANK[entry.status] > RANK[acc] ? entry.status : acc),
    'ok',
  );
}

function renderTable(block, indent = '  ') {
  const columns = block.columns || [];
  const values = block.values || [];
  if (!columns.length || !values.length) return [];
  const widths = columns.map((name, index) =>
    Math.max(String(name).length, ...values.map((row) => String(row[index] ?? '').length)),
  );
  const line = (cells) =>
    indent + cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ').trimEnd();
  return [line(columns), indent + widths.map((width) => '-'.repeat(width)).join('  '), ...values.map(line)];
}

function renderSection(section) {
  const out = [`\n## ${section.title || section.id}`];

  for (const entry of section.health || []) {
    out.push(`${MARK[entry.status] || '  ?   '} ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`);
  }

  if ((section.metrics || []).length) {
    out.push('');
    const width = Math.max(...section.metrics.map((metric) => String(metric.label).length));
    for (const metric of section.metrics) {
      const unit = metric.unit ? ` ${metric.unit}` : '';
      const note = metric.note ? `   (${metric.note})` : '';
      out.push(`  ${String(metric.label).padEnd(width)}  ${metric.value}${unit}${note}`);
    }
  }

  for (const block of section.rows || []) {
    const table = renderTable(block);
    if (table.length) out.push('', ...table);
  }

  // Errors are printed even when every check passed: "could not be read" and
  // "read and found nothing" are different answers and must not look alike.
  for (const problem of section.errors || []) out.push(`  ! ${problem}`);

  return out;
}

const args = parseArgs(process.argv.slice(2));
const sections = await Promise.all(
  COLLECTORS.map(([id, collect]) => safeCollect(id, collect, args.days)),
);

if (args.json) {
  console.log(JSON.stringify({ days: args.days, sections }, null, 1));
} else {
  const worst = sections.map((section) => [section.id, worstOf(section)]);
  const lines = [
    `Harness report — last ${args.days}d`,
    worst.map(([id, status]) => `${id}:${status}`).join('   '),
  ];
  for (const section of sections) lines.push(...renderSection(section));

  const failed = worst.filter(([, status]) => status === 'fail').map(([id]) => id);
  const warned = worst.filter(([, status]) => status === 'warn').map(([id]) => id);
  lines.push('');
  if (failed.length) lines.push(`FAIL in: ${failed.join(', ')}`);
  if (warned.length) lines.push(`WARN in: ${warned.join(', ')}`);
  if (!failed.length && !warned.length) lines.push('All checks green.');
  console.log(lines.join('\n'));
}

if (args.strict && sections.some((section) => worstOf(section) === 'fail')) process.exit(1);
