#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS } from './arms.mjs';
import { PILOTS } from './run.mjs';

const resultsDir = new URL('./results/', import.meta.url);
const statuses = ['done', 'capped', 'error', 'retryable', 'cancelled', 'skipped', 'deferred'];
const metrics = ['input', 'output', 'cacheRead', 'cacheWrite', 'hitShare', 'cost', 'tokens', 'duration', 'toolCalls', 'toolSuccess', 'score'];
const cohortFields = ['cohort', 'fixtureHash', 'fixtureBase', 'activationProfileHash', 'model', 'effort', 'tokenCap', 'timeoutMinutes', 'budgetPoints', 'instruments'];
// Mirror run.mjs cellKey (pilot cells append their cohort tag; matrix cells append nothing)
// solely to verify whether a recorded candidate actually explains a sparse row's opaque key.
// A digest alone is not reversible and supplies no missing values.
function verifiedKey(cell) {
  if (!Object.hasOwn(ARMS, cell.arm) || !cell.fixtureHash || !cell.fixtureBase || !cell.model || !cell.effort ||
      !Number.isInteger(cell.tokenCap) || !Number.isInteger(cell.timeoutMinutes)) return null;
  const instruments = { codegraph: false, 'ast-grep': cell.arm === 'no-codegraph', memory: false };
  return createHash('sha256').update(JSON.stringify([cell.task, cell.family, cell.arm, cell.rep,
    cell.fixtureHash, cell.fixtureBase, cell.tokenCap, cell.timeoutMinutes, cell.budgetPoints ?? null,
    cell.model, cell.effort, instruments, cell.activationProfileHash ?? null,
    ...(cell.cohort ? [cell.cohort] : [])])).digest('hex');
}

function resolveRows(rows, recorded = rows) {
  return rows.map((row) => {
    if (!row.cellKey) return row;
    // Same-key history may include a fuller row that was later superseded. For
    // other repetitions, accept only a configuration that hashes to this cellKey.
    const candidates = recorded.filter((candidate) => candidate.arm === row.arm && candidate.family === row.family &&
      candidate.task === row.task && candidate.fixtureHash && candidate.fixtureBase && candidate.model && candidate.effort &&
      Number.isInteger(candidate.tokenCap) && Number.isInteger(candidate.timeoutMinutes));
    const matches = candidates.map((candidate) => {
      if (!cohortFields.every((field) => row[field] == null || candidate[field] == null ||
        JSON.stringify(row[field]) === JSON.stringify(candidate[field]))) return null;
      const merged = { ...candidate, ...Object.fromEntries(cohortFields.filter((field) => row[field] != null)
        .map((field) => [field, row[field]])), task: row.task, family: row.family, arm: row.arm, rep: row.rep };
      const verified = verifiedKey(merged) === row.cellKey;
      if (!verified && !(candidate.cellKey === row.cellKey && candidate.rep === row.rep)) return null;
      return { ...candidate, instruments: candidate.instruments ?? (verified ?
        { codegraph: false, 'ast-grep': row.arm === 'no-codegraph', memory: false } : null) };
    }).filter(Boolean);
    if (!matches.length) return row;
    const filled = { ...row };
    for (const field of cohortFields) if (filled[field] == null) {
      const known = [...new Set(matches.map((candidate) => JSON.stringify(candidate[field] ?? null)))];
      if (known.length === 1 && known[0] !== 'null') filled[field] = matches[0][field];
    }
    return filled;
  });
}
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
export const median = (values) => {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Consume all dated files in order; the last row for a recorded cell is its current state. */
export function readResults(dir = resultsDir, warn = (message) => console.error(message)) {
  if (!existsSync(dir)) return [];
  const latest = new Map();
  const recorded = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()) {
    readFileSync(path.join(fileURLToPathIfURL(dir), file), 'utf8').split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      let row;
      try { row = JSON.parse(line); } catch { throw new Error(`corrupt result ${file}:${index + 1}`); }
      if (row.status === 'budget-start') return;
      if (!statuses.includes(row.status)) { warn(`unknown result status ${file}:${index + 1}: ${String(row.status)}`); return; }
      if (!row.task || !row.family || !row.arm || !Number.isInteger(row.rep)) throw new Error(`invalid result ${file}:${index + 1}`);
      // Matrix cellKey includes fixture, profile, model, effort, limits and instruments.
      // Older single-cell runs have no cellKey; preserve their distinct recorded hashes.
      const key = row.cellKey ?? JSON.stringify([row.task, row.family, row.arm, row.rep, row.fixtureHash ?? null,
        row.fixtureBase ?? null, row.activationProfileHash ?? null, row.model ?? null, row.effort ?? null,
        row.tokenCap ?? null, row.timeoutMinutes ?? null, row.budgetPoints ?? null, row.cohort ?? null]);
      latest.set(key, row);
      recorded.push(row);
    });
  }
  return resolveRows([...latest.values()], recorded);
}

function fileURLToPathIfURL(dir) { return dir instanceof URL ? fileURLToPath(dir) : dir; }

// Share of prompt tokens served from cache; Pi's input excludes cache reads and writes.
export function hitShare(input, cacheRead, cacheWrite) {
  if (input === null || cacheRead === null || cacheWrite === null) return null;
  const prompt = input + cacheRead + cacheWrite;
  return prompt > 0 ? cacheRead / prompt : null;
}

function values(row) {
  const tools = Array.isArray(row.deliveredTools) ? row.deliveredTools : null;
  const input = number(row.usage?.input), cacheRead = number(row.usage?.cacheRead), cacheWrite = number(row.usage?.cacheWrite);
  return {
    input, output: number(row.usage?.output), cacheRead, cacheWrite, hitShare: hitShare(input, cacheRead, cacheWrite),
    cost: number(row.usage?.cost),
    tokens: number(row.usage?.total), duration: number(row.seconds),
    toolCalls: number(row.tools) ?? (tools ? tools.length : null),
    toolSuccess: tools ? tools.filter((tool) => tool.success === true).length : null,
    score: ['skipped', 'deferred', 'cancelled', 'retryable'].includes(row.status) ? null : number(row.score),
  };
}

const medians = (runs) => Object.fromEntries(metrics.map((metric) => [metric, median(runs.map((run) => run.metrics[metric]))]));
const doneMedians = (runs) => medians(runs.filter((run) => run.status === 'done'));
// Include every run.mjs cellKey cohort dimension except repetition and arm; profile/instruments
// identify an arm generation and must not be averaged with another generation.
const configuration = (row) => ({ cohort: row.cohort ?? null, fixtureHash: row.fixtureHash ?? null, fixtureBase: row.fixtureBase ?? null,
  activationProfileHash: row.activationProfileHash ?? null, model: row.model ?? null,
  effort: row.effort ?? null, tokenCap: row.tokenCap ?? null, timeoutMinutes: row.timeoutMinutes ?? null,
  budgetPoints: row.budgetPoints ?? null, instruments: row.instruments ?? null });
const comparisonKey = (group) => group.config.fixtureHash && group.config.fixtureBase ? JSON.stringify([
  group.config.cohort, group.family, group.task, group.config.fixtureHash, group.config.fixtureBase,
  group.config.model, group.config.effort, group.config.tokenCap,
  group.config.timeoutMinutes, group.config.budgetPoints]) : null;

/** First arm of a pilot whose control is not base. Base-first pilots stay on deltaVsBase. */
function nonBaseControl(cohort) {
  if (typeof cohort !== 'string' || !cohort.startsWith('pilot:')) return null;
  const control = PILOTS[cohort.slice('pilot:'.length)]?.arms?.[0];
  return control && control !== 'base' ? control : null;
}

function pairedComparison(groupRows, baseline, baselineLabel) {
  if (!baseline) return null;
  const matched = [];
  const comparable = [];
  const used = new Set();
  for (const row of groupRows) {
    if (row.status !== 'done') continue;
    const matching = baseline.rows.filter((controlRow) => controlRow.status === 'done' && controlRow.rep === row.rep);
    if (matching.length !== 1 || used.has(matching[0])) continue;
    used.add(matching[0]);
    comparable.push({ status: row.status, metrics: values(row) });
    matched.push({ status: 'done', metrics: values(matching[0]) });
  }
  if (!comparable.length) return null;
  const armMedian = doneMedians(comparable);
  const controlMedian = doneMedians(matched);
  return {
    n: comparable.length, [baselineLabel]: controlMedian, arm: armMedian,
    delta: Object.fromEntries(metrics.map((metric) => {
      const a = armMedian[metric], b = controlMedian[metric];
      return [metric, { absolute: a === null || b === null ? null : a - b,
        percent: a === null || b === null || b === 0 ? null : (a - b) / b * 100 }];
    })),
  };
}
export function makeReport(rows) {
  const groups = new Map();
  for (const row of resolveRows(rows)) {
    if (!statuses.includes(row.status)) continue;
    const config = configuration(row);
    const key = JSON.stringify([row.arm, row.family, row.task, config]);
    if (!groups.has(key)) groups.set(key, { arm: row.arm, family: row.family, task: row.task, config, rows: [] });
    groups.get(key).rows.push(row);
  }
  const allGroups = [...groups.values()];
  // Profile hashes differ across arms. Only a unique base generation with exactly one
  // done row for a repetition is a defensible match; ambiguous baselines get no delta.
  const baseGroups = new Map();
  for (const group of allGroups) if (group.arm === 'base' && comparisonKey(group) && group.rows.some((row) => row.status === 'done')) {
    const key = comparisonKey(group);
    if (!baseGroups.has(key)) baseGroups.set(key, []);
    baseGroups.get(key).push(group);
  }
  const controlGroups = new Map();
  for (const group of allGroups) {
    const control = nonBaseControl(group.config.cohort);
    if (group.arm === control && comparisonKey(group) && group.rows.some((row) => row.status === 'done')) {
      const key = comparisonKey(group);
      if (!controlGroups.has(key)) controlGroups.set(key, []);
      controlGroups.get(key).push(group);
    }
  }
  const cells = allGroups.map(({ arm, family, task, config, rows: groupRows }) => {
    const runs = groupRows.map((row) => ({ rep: row.rep, cellKey: row.cellKey ?? null,
      status: row.status, capped: row.status === 'capped', metrics: values(row),
      ...(typeof row.firstEdit === 'string' ? { firstEdit: row.firstEdit } : {}) }));
    // Edit-only rows (task 1868 slice 3b) carry the transcript first-edit outcome; tally it per cell.
    const firstEdit = { success: 0, failed: 0, unknown: 0 };
    let hasFirstEdit = false;
    for (const row of groupRows) if (typeof row.firstEdit === 'string' && row.firstEdit in firstEdit) { hasFirstEdit = true; firstEdit[row.firstEdit]++; }
    const status = Object.fromEntries(statuses.map((state) => [state, groupRows.filter((row) => row.status === state).length]));
    const group = { family, task, config };
    const candidates = baseGroups.get(comparisonKey(group)) ?? [];
    const baseline = arm !== 'base' && candidates.length === 1 ? candidates[0] : null;
    const deltaVsBase = pairedComparison(groupRows, baseline, 'base');
    const controlArm = nonBaseControl(config.cohort);
    const controlCandidates = controlArm && arm !== controlArm ? (controlGroups.get(comparisonKey(group)) ?? []) : [];
    const paired = controlCandidates.length === 1 ? pairedComparison(groupRows, controlCandidates[0], 'control') : null;
    const deltaVsControl = paired ? { controlArm, ...paired } : null;
    return { arm, family, task, cohort: config, n: runs.length, status, runs, firstEdit: hasFirstEdit ? firstEdit : null, median: doneMedians(runs), deltaVsBase, ...(deltaVsControl ? { deltaVsControl } : {}) };
  });
  const arms = [...new Set(allGroups.map((group) => group.arm))].sort((a, b) => a === 'base' ? -1 : b === 'base' ? 1 : a.localeCompare(b));
  return { arms: arms.map((arm) => ({ arm, cells: cells.filter((cell) => cell.arm === arm)
    .map(({ arm: _arm, ...cell }) => cell)
    .sort((a, b) => a.family.localeCompare(b.family) || a.task.localeCompare(b.task) ||
      JSON.stringify(a.cohort).localeCompare(JSON.stringify(b.cohort))) })) };
}

// Cost is USD cents-scale per run and hit share a fraction, so both keep four decimals.
const digits = { cost: 4, hitShare: 4 };
const display = (value, places = 2) => value === null ? '—' : String(Number(value.toFixed(places)));
const trio = (metrics) => metrics ? [metrics.input, metrics.output, metrics.cacheRead].map((value) => display(value)).join(' / ') : '—';
const amount = (metrics, key) => metrics ? display(metrics[key], digits[key]) : '—';
const change = (delta, key) => delta ? `${display(delta[key].absolute, digits[key])} (${display(delta[key].percent)}%)` : '—';
const bar = (value, maximum) => value === null || maximum <= 0 ? '—' : '█'.repeat(Math.round(value / maximum * 20));

function chart(cell, arm) {
  const vs = cell.deltaVsControl;
  const base = vs?.control ?? cell.deltaVsBase?.base ?? null;
  const current = arm === 'base' ? cell.median : (vs?.arm ?? cell.deltaVsBase?.arm ?? cell.median);
  const label = vs?.controlArm ?? 'base';
  return ['tokens', 'score', 'duration'].map((metric) => {
    const a = current[metric], b = base?.[metric] ?? null;
    const maximum = Math.max(a ?? 0, b ?? 0);
    return `${cell.family}/${cell.task} ${cell.cohort.cohort ?? 'matrix/legacy'} ${cell.cohort.fixtureHash?.slice(0, 8) ?? '—'} ${cell.cohort.model ?? '—'} cap:${display(cell.cohort.tokenCap)} ${metric}: ${label} ${bar(b, maximum)} ${display(b)} | ${arm} ${bar(a, maximum)} ${display(a)}`;
  });
}

export function markdown(report) {
  return report.arms.map(({ arm, cells }) => {
    const controlArms = [...new Set(cells.map((cell) => cell.deltaVsControl?.controlArm).filter(Boolean))];
    const vsLabel = !cells.some((cell) => cell.deltaVsBase) && controlArms.length === 1 ? controlArms[0] : 'Base';
    return [
    `## ${arm}`, '',
    `| Family | Task | Cohort | Fixture | Model | Cap | Profile | n (done/capped/error/retryable/cancelled/skipped+deferred) | ${vsLabel} tokens | Arm tokens | ${vsLabel} in/out/cache | Arm in/out/cache | ${vsLabel} cache write | Arm cache write | ${vsLabel} hit share | Arm hit share | ${vsLabel} cost USD | Arm cost USD | ${vsLabel} score | Arm score | ${vsLabel} seconds | Arm seconds | Δ tokens | Δ cache write | Δ hit share | Δ cost USD | Δ score | Δ seconds | First edit ✓/✗/? |`,
    '| --- | --- | --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- | --- |',
    ...cells.map((cell) => {
      const counts = [cell.status.done, cell.status.capped, cell.status.error, cell.status.retryable,
        cell.status.cancelled, cell.status.skipped + cell.status.deferred].join('/');
      const vs = cell.deltaVsControl;
      const base = arm === 'base' ? cell.median : (vs?.control ?? cell.deltaVsBase?.base ?? null);
      const current = arm === 'base' ? cell.median : (vs?.arm ?? cell.deltaVsBase?.arm ?? cell.median);
      const d = vs?.delta ?? cell.deltaVsBase?.delta ?? null;
      return `| ${cell.family} | ${cell.task} | ${cell.cohort.cohort ?? 'matrix/legacy'} | ${cell.cohort.fixtureHash?.slice(0, 8) ?? '—'} | ${cell.cohort.model ?? '—'} | ${display(cell.cohort.tokenCap)} | ${cell.cohort.activationProfileHash?.slice(0, 8) ?? '—'} | ${cell.n} (${counts}) | ${amount(base, 'tokens')} | ${amount(current, 'tokens')} | ${trio(base)} | ${trio(current)} | ${amount(base, 'cacheWrite')} | ${amount(current, 'cacheWrite')} | ${amount(base, 'hitShare')} | ${amount(current, 'hitShare')} | ${amount(base, 'cost')} | ${amount(current, 'cost')} | ${amount(base, 'score')} | ${amount(current, 'score')} | ${amount(base, 'duration')} | ${amount(current, 'duration')} | ${change(d, 'tokens')} | ${change(d, 'cacheWrite')} | ${change(d, 'hitShare')} | ${change(d, 'cost')} | ${change(d, 'score')} | ${change(d, 'duration')} | ${cell.firstEdit ? `${cell.firstEdit.success}/${cell.firstEdit.failed}/${cell.firstEdit.unknown}` : '—'} |`;
    }), '', '### Done-only chart (total tokens / score / seconds)', '',
    ...cells.flatMap((cell) => chart(cell, arm)), '',
  ].join('\n');
  }).join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 && args.length !== 4 || args[0] !== '--json' || !args[1] || args.length === 4 && (args[2] !== '--results' || !args[3])) throw new Error('usage: report.mjs --json <file> [--results <dir>]');
    const report = makeReport(readResults(args[3] ?? resultsDir));
    writeFileSync(args[1], `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${markdown(report)}\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
