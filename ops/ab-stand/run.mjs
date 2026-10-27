#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { changedPaths, scoreCoder, scoreEdit, scoreProbe, scoreScout, validateTruth } from './scorer.mjs';
import { runLessonProbe } from './lesson-probe.mjs';
import { firstEditOutcome } from './edit-metrics.mjs';
import { ARMS, armInstruments, profileHash, standDirectory } from './arms.mjs';
import { indexGitnexus } from './gitnexus-install.mjs';
import { indexWithOllama, withOllama } from './ollama.mjs';
import { indexWithOpenViking, withOpenVikingServer } from './openviking.mjs';
import { isStandSnapshotParseError, syncStandAuth } from './auth.mjs';
import { budgetReading, roleMatrix, windowLength, windowMs, MIN_LEFT } from '../orchestrator/src/profiles.ts';
import { HIGH_LOAD } from '../orchestrator/src/limits.ts';
import { readFamilyUsage } from '../usage-snapshot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
export const MATRIX_FAMILIES = ['glm', 'kimi', 'grok', 'codex'];
export const MATRIX_ARMS = ['base', 'no-codegraph', 'pi-condense', 'context-mode', 'aider-repo-map', 'serena', 'codebase-memory-mcp', 'open-codebase-index'];
export const MATRIX_TASKS = ['scout-short', 'coder-short'];
/**
 * Guarded mini-cohorts run through the same
 * cellKey path as the matrix (live guard, token cap, measured-usage and activation-proof
 * checks) but is keyed apart from it: pilot cells carry `cohort`, which cellKey appends,
 * so a pilot row never shares a key with a matrix row, and the pilot takes no --budget,
 * so it never writes a budget-start row and never touches a matrix budgetKey.
 * `turnMinutes` replaces TURN_MINUTES for pilot cells only: the first live edit-1 base run
 * made its edit and was capped at 2 minutes before reporting (6 tools, 77k tokens); the
 * token cap, not the clock, bounds spend.
 */
export const PILOTS = {
  'codex-edit': { families: ['codex'], arms: ['base', 'codex-edit'], tasks: ['edit-1', 'edit-2'], turnMinutes: 10 },
  'hashline-edit': { families: ['kimi', 'mimo', 'qwen', 'grok'], arms: ['base', 'hashline-edit-451'], tasks: ['edit-1', 'edit-2'], turnMinutes: 5 },
  // Task 1883 (operator #13055): base (lessons injected) against no-lessons on five replayed
  // reviewer-reproduced mistakes; memory is off in every stand cell (matrixInstruments), so
  // injection is the only lesson path. grok at --reps 5: 5 tasks x 2 arms x 5 = 50 runs.
  'lesson-usefulness': { families: ['grok'], arms: ['base', 'no-lessons'],
    tasks: ['lesson-12805', 'lesson-12713', 'lesson-12737', 'lesson-12562', 'lesson-12703'], turnMinutes: 15 },
  // Operator 2026-10-01 (#13149): glm was never in the hashline pilot; only glm runs now.
  'hashline-edit-glm': { families: ['glm'], arms: ['base', 'hashline-edit-451'], tasks: ['edit-1', 'edit-2'], turnMinutes: 5 },
  // Operator #13170: 5.0.0 against 4.5.1. Control is hashline-edit-451, not base.
  // --reps above 3 is refused (operator allows 1-2, ceiling 3).
  'hashline-500': { families: ['qwen'], arms: ['hashline-edit-451', 'hashline-edit-500'], tasks: ['edit-1', 'edit-2'], turnMinutes: 5 },
  // Operator #13197: pruning against base. lesson-12737 (332 words) and lesson-12713 (319 words)
  // are the two longest replay briefs, so the seat re-reads and edits the same owned files and
  // tool-result context grows; edit-1/edit-2 are smaller single-file edits (memory #13097: 91k/133k).
  // Stand results/*.jsonl are absent here, so this ranking is brief size, the observed proxy.
  // --reps above 3 is refused (operator allows 1-2, ceiling 3). turnMinutes 15 matches the other lesson replay.
  'context-pruning': { families: ['qwen'], arms: ['base', 'context-pruning'], tasks: ['lesson-12737', 'lesson-12713'], turnMinutes: 15 },
  // Operator #13197: short code-intelligence pilot, default one rep, ceiling three.
  // turnMinutes 10, not 5: start_lsp times out cold twice (30 s each), and the first edit-1 challenger
  // run was cut at 300 s with its edit made and no report (243k tokens), which is no data.
  // scout-1 and scout-2, not edit-1/edit-2 (operator 2026-10-01): the edit fixtures name the file to change,
  // so nothing in them needs symbol navigation, and four finished edit cells made zero LSP calls.
  'agent-lsp': { families: ['qwen'], arms: ['base', 'agent-lsp'], tasks: ['scout-1', 'scout-2'], turnMinutes: 10 },
  // Operator #13197: probe against base. Short runs, 1 rep, never above 3.
  // scout-1 and scout-2 exercise code search: scout-1 must cite seat/turn/usage/restart
  // in ops/orchestrator/src/store.ts; scout-2 must cite cached input in
  // ops/orchestrator/src/providers/codex.ts and the digest total in ops/orchestrator/src/seats.ts.
  // edit-1/edit-2 are single-file edits, not searches. --reps above 3 is refused.
  probe: { families: ['qwen'], arms: ['base', 'probe'], tasks: ['scout-1', 'scout-2'], turnMinutes: 5 },
  // Operator #13197: gitnexus against base. scout-short asks where a seat is persisted
  // (file:line navigation). coder-short must find item() in digest-text.ts before the edit.
  // Those are the matrix code-navigation fixtures; edit-1/edit-2 are single-file edits, the fallback only.
  // --reps above 3 is refused (operator allows 1, ceiling 3). Short runs: turnMinutes 5.
  gitnexus: { families: ['qwen'], arms: ['base', 'gitnexus'], tasks: ['scout-short', 'coder-short'], turnMinutes: 5 },
  // Operator #13197: jcodemunch against base. scout-1 and scout-2 require file:line of symbols
  // the seat must find (store.ts seats/turns/usage; codex.ts cached input and seats.ts digest).
  // edit-1/edit-2 name the one file to change, so they do not exercise code navigation.
  // --reps above 3 is refused (operator allows 1-2, ceiling 3). turnMinutes 15 matches the other #13197 pilot.
  jcodemunch: { families: ['qwen'], arms: ['base', 'jcodemunch'], tasks: ['scout-1', 'scout-2'], turnMinutes: 15 },
  // Operator #13197: the openviking context database against base, qwen only, short runs.
  // scout-short and scout-1 are the two code-navigation fixtures: both locate orch's seat
  // persistence at a pinned commit and cite repo-relative file:line, and the challenger
  // navigates through openviking instead of codegraph (matrixInstruments turns codegraph off
  // for every arm), so navigation quality is exactly what this arm changes. edit-1/edit-2 are
  // smaller single-file edits and stay the fallback. --reps above 3 is refused (ceiling 3).
  'openviking': { families: ['qwen'], arms: ['base', 'openviking'], tasks: ['scout-short', 'scout-1'], turnMinutes: 5 },
  // Operator #13197: sleev local gateway against base. lesson-12737 (332 words) and
  // lesson-12713 (319 words) are the two longest replay briefs: the seat re-reads and
  // edits the same owned files and conversation history grows across turns, which is
  // exactly what the gateway's history compression changes; edit-1/edit-2 are smaller
  // single-file edits (memory #13097: 91k/133k observed runs).
  // --reps above 3 is refused (operator: short runs, 1 rep, ceiling 3). turnMinutes 15 matches the lesson replays.
  sleev: { families: ['qwen'], arms: ['base', 'sleev'], tasks: ['lesson-12737', 'lesson-12713'], turnMinutes: 15 },
};
export const TURN_MINUTES = 2;
// Added to a cell's turn limit when waiting for it: a loaded daemon starts a queued turn minutes late.
export const QUEUE_MARGIN_MINUTES = 10;
// Per-run cumulative input + output + cacheRead, not a per-message ceiling: repeated
// cached role context can push even a two-tool turn past 12k (observed ~65k).
export const TOKEN_CAP = 400_000;
export const MAX_FAMILY_RUNS = 2; // Require a fresh invocation and fresh vendor quota readings before another batch.
/** The matrix is against RTK alone, not the step-2b all-on base profile. */
export function matrixInstruments(arm) {
  if (!Object.hasOwn(ARMS, arm)) throw new Error(`unknown matrix arm ${arm}`);
  return { codegraph: false, 'ast-grep': arm === 'no-codegraph', memory: false };
}
const resultsDir = path.join(root, 'ops/ab-stand/results');
const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function options(argv, deps = {}) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run' && !Object.hasOwn(opts, 'dryRun')) { opts.dryRun = true; continue; }
    const key = argv[i]?.slice(2);
    if (!['--task', '--family', '--arm', '--reps', '--families', '--token-cap', '--budget', '--pilot', '--pace-override'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(opts, key)) throw new Error('usage: run.mjs [--families kimi,grok,glm,codex] [--reps 1] [--token-cap N] [--budget kimi=+5] [--dry-run] (or --pilot ID --reps N [--pace-override "<operator reason>"] [--dry-run]) (or --task ID --family F --arm A --reps N)');
    opts[key] = argv[++i];
  }
  if (!/^[1-9]\d*$/.test(opts.reps ?? '1') || Number(opts.reps ?? '1') > 100) throw new Error('reps must be 1..100');
  opts.reps ??= '1';
  opts.tokenCap = opts['token-cap'];
  if (opts.tokenCap !== undefined && (!/^[1-9]\d*$/.test(opts.tokenCap) || Number(opts.tokenCap) < 256 || Number(opts.tokenCap) > 1_000_000)) throw new Error('token-cap must be an integer from 256 to 1000000');
  opts.tokenCap = opts.tokenCap === undefined ? TOKEN_CAP : Number(opts.tokenCap);
  const budgets = {};
  if (opts.budget !== undefined) for (const item of opts.budget.split(',')) {
    const match = /^(kimi|grok|glm|codex)=\+(\d+(?:\.\d+)?)$/.exec(item);
    if (!match || Object.hasOwn(budgets, match[1]) || Number(match[2]) <= 0 || Number(match[2]) > 100) throw new Error('--budget requires distinct family=+points (0 < points <= 100)');
    budgets[match[1]] = Number(match[2]);
  }
  if (opts.pilot !== undefined) {
    if (opts.task || opts.family || opts.arm || opts.families !== undefined) throw new Error('--pilot cannot be combined with --families or a single cell');
    if (opts.budget !== undefined) throw new Error('--budget is for the full matrix only; the pilot has no budget exception and never writes a budget-start');
    const paceOverride = opts['pace-override'];
    if (paceOverride !== undefined && paceOverride.trim().length < 10) throw new Error('--pace-override needs the operator reason (at least 10 characters)');
    const pilot = PILOTS[opts.pilot];
    if (!pilot) throw new Error(`unknown pilot '${opts.pilot}'; known pilots: ${Object.keys(PILOTS).join(', ')}`);
    if (pilot.tasks.some((task) => !fixtures[task])) throw new Error(`pilot '${opts.pilot}' names a missing fixture`);
    if (opts.pilot === 'hashline-500' && Number(opts.reps) > 3) throw new Error(`pilot 'hashline-500' refuses --reps above 3`);
    if (opts.pilot === 'context-pruning' && Number(opts.reps) > 3) throw new Error(`pilot 'context-pruning' refuses --reps above 3`);
    if (opts.pilot === 'agent-lsp' && Number(opts.reps) > 3) throw new Error(`pilot 'agent-lsp' refuses --reps above 3`);
    if (opts.pilot === 'probe' && Number(opts.reps) > 3) throw new Error(`pilot 'probe' refuses --reps above 3`);
    if (opts.pilot === 'gitnexus' && Number(opts.reps) > 3) throw new Error(`pilot 'gitnexus' refuses --reps above 3`);
    if (opts.pilot === 'jcodemunch' && Number(opts.reps) > 3) throw new Error(`pilot 'jcodemunch' refuses --reps above 3`);
    if (opts.pilot === 'openviking' && Number(opts.reps) > 3) throw new Error(`pilot 'openviking' refuses --reps above 3`);
    if (opts.pilot === 'sleev' && Number(opts.reps) > 3) throw new Error(`pilot 'sleev' refuses --reps above 3`);
    return { pilot: opts.pilot, families: pilot.families, budgets: {}, reps: opts.reps, tokenCap: opts.tokenCap, dryRun: opts.dryRun === true, ...(paceOverride !== undefined ? { paceOverride: paceOverride.trim() } : {}) };
  }
  if (opts['pace-override'] !== undefined) throw new Error('--pace-override is for a pilot only');
  if (opts.families !== undefined || !opts.task && !opts.family && !opts.arm) {
    if (opts.task || opts.family || opts.arm) throw new Error('--families cannot be combined with a single cell');
    if (opts.reps !== '1') throw new Error('full matrix is one repetition per cell; resume instead of multiplying runs');
    const families = (opts.families ?? 'kimi,grok,glm,codex').split(',');
    if (new Set(families).size !== families.length || families.some((family) => !['kimi', 'grok', 'glm', 'codex'].includes(family))) throw new Error('--families must list distinct kimi,grok,glm,codex');
    if (Object.keys(budgets).some((family) => !families.includes(family))) throw new Error('--budget family must be in --families');
    return { matrix: true, families: MATRIX_FAMILIES.filter((family) => families.includes(family)), budgets, reps: opts.reps, tokenCap: opts.tokenCap, dryRun: opts.dryRun === true };
  }
  if (opts.budget !== undefined) throw new Error('--budget is for the full matrix only');
  if (!fixtures[opts.task] || !/^[a-z][a-z0-9-]*$/.test(opts.family ?? '') || !/^[a-zA-Z0-9_-]+$/.test(opts.arm ?? '')) throw new Error('invalid task, family or arm');
  const seatRole = opts.task === 'scout-short' ? 'researcher' : fixtures[opts.task].role;
  if (!roleMatrix()[seatRole]?.[opts.family]) throw new Error(`family '${opts.family}' cannot take a ${seatRole} seat; allowed: ${Object.keys(roleMatrix()[seatRole] ?? {}).join(', ')}`);
  if (!Object.hasOwn(ARMS, opts.arm)) throw new Error(`unknown arm '${opts.arm}'; known arms: ${Object.keys(ARMS).join(', ')}`);
  opts.instruments = armInstruments(opts.arm, deps);
  return opts;
}

/** A fresh vendor reading is required for every executed cell; unknown quota is not spare quota. */
// `paceOverride` (a pilot's operator reason) waives ONLY the "ahead of pace" rule here; liveGuard
// no longer calls this for a pilot with an operator reason (it reads no quota at all).
export function guardVerdict(readings, now = Date.now(), override = null, paceOverride = null) {
  const budget = budgetReading(readings);
  const length = budget && windowLength(budget);
  const left = budget?.resetsAt ? Date.parse(budget.resetsAt) - now : NaN;
  if (!budget || !length || !Number.isFinite(left) || left <= 0 || left > length || !Number.isFinite(budget.used)) return { run: false, reason: 'budget window/reset unreadable' };
  if (readings.some((row) => windowMs(row.window) !== null && (!Number.isFinite(row.used) || row.used < 0 || row.used > 100))) return { run: false, reason: 'a quota window is unreadable' };
  const elapsed = 100 * (1 - left / length);
  const short = readings.find((row) => row !== budget && windowLength(row) !== null && windowLength(row) < length && 100 - row.used < MIN_LEFT);
  // The budget exception is ONLY for the 7d pace rule, and only within one reset.
  // A fresh reading establishes the start; every later reading uses that exact start.
  const validWeek = override && length === 7 * 24 * 3600_000 && /^(week|7d)$/.test(budget.window);
  const startUsed = override?.startUsed ?? budget.used;
  const ceiling = override ? startUsed + override.points : null;
  const budgetOverride = validWeek && Number.isFinite(startUsed) && startUsed >= 0 && startUsed <= 100 &&
    (!override.resetsAt || override.resetsAt === budget.resetsAt) && (!override.window || override.window === budget.window)
    ? { points: override.points, startUsed, ceiling, window: budget.window, resetsAt: budget.resetsAt, takenAt: override.takenAt ?? new Date(now).toISOString() } : null;
  const reason = override && !budgetOverride ? 'budget override requires the same readable 7d window/reset' :
    short ? `short ${short.window} throttle: ${short.used}%` : budget.used >= HIGH_LOAD ? `budget ${budget.window} high load: ${budget.used}% >= ${HIGH_LOAD}%` :
    budgetOverride ? budget.used < startUsed ? `budget ${budget.window} reading regressed below start ${startUsed}%` : budget.used >= ceiling ? `budget ${budget.window} override ceiling reached: ${budget.used}% >= ${ceiling}%` : null :
    budget.used > elapsed && !paceOverride ? `budget ${budget.window} ahead of pace: ${budget.used}% > ${elapsed.toFixed(1)}%` :
    100 - budget.used < MIN_LEFT ? `budget ${budget.window} below ${MIN_LEFT}% reserve` : null;
  return { run: reason === null, reason, budget: { window: budget.window, used: budget.used, elapsed: Number(elapsed.toFixed(1)), resetsAt: budget.resetsAt }, short: short ? { window: short.window, used: short.used } : null, ...(override ? { budgetOverride } : {}), ...(paceOverride && budget.used > elapsed ? { paceOverride } : {}) };
}

export async function liveGuard(family, readUsage = readFamilyUsage, override = null, paceOverride = null) {
  // Operator 2026-09-30: a pilot run with an operator reason reads no quota itself; orch's own
  // family budgets govern it (#13110). The stand reading stays for the matrix.
  if (paceOverride) return { run: true, reason: null, paceOverride, quota: 'not read by the stand (operator pilot)' };
  try {
    const usage = await readUsage(family);
    const taken = Date.parse(usage.takenAt);
    return !Number.isFinite(taken) || Date.now() - taken > 60_000 || taken > Date.now() + 5_000
      ? { run: false, reason: 'usage reading is stale or undated' } : guardVerdict(usage.readings, taken, override, paceOverride);
  } catch (error) { return { run: false, reason: `usage unavailable: ${error.message}` }; }
}

export function matrixPlan(opts) {
  return MATRIX_TASKS.flatMap((task) => opts.families.flatMap((family) => MATRIX_ARMS.flatMap((arm) =>
    Array.from({ length: Number(opts.reps) }, (_, n) => planCell(opts, task, family, arm, n + 1)))));
}
/** Arms alternate within each rep, fixture and family, in PILOTS.arms order (control, then challenger). */
export function pilotPlan(opts) {
  const pilot = PILOTS[opts.pilot];
  if (!pilot) throw new Error(`unknown pilot '${opts.pilot}'`);
  return Array.from({ length: Number(opts.reps) }, (_, n) => pilot.tasks.flatMap((task) =>
    pilot.families.flatMap((family) => pilot.arms.map((arm) => ({ ...planCell(opts, task, family, arm, n + 1),
      timeoutMinutes: pilot.turnMinutes, cohort: `pilot:${opts.pilot}` }))))).flat();
}
function planCell(opts, task, family, arm, rep) {
  return { task, family, arm, rep,
    fixtureHash: digestOf(fixtures[task]), fixtureBase: fixtures[task].base, tokenCap: opts.tokenCap, timeoutMinutes: TURN_MINUTES, budgetPoints: opts.budgets?.[family] ?? null,
    model: roleMatrix()[fixtures[task].role === 'scout' ? 'researcher' : 'coder'][family].model, effort: 'low' };
}
// `cohort` is appended only when present, so matrix cell digests stay byte-identical to slice 3a.
export const cellKey = (cell) => digestOf([cell.task, cell.family, cell.arm, cell.rep, cell.fixtureHash, cell.fixtureBase, cell.tokenCap, cell.timeoutMinutes, cell.budgetPoints ?? null, cell.model, cell.effort, matrixInstruments(cell.arm), cell.activationProfileHash ?? null, ...(cell.cohort ? [cell.cohort] : []),
  // An arm's hint is part of its treatment: a changed hint is a new cell. Appended only when present, like `cohort`.
  ...(ARMS[cell.arm]?.hint ? [digestOf(ARMS[cell.arm].hint)] : [])]);

export function recordedCells(dir = resultsDir) {
  const completed = new Set();
  if (!existsSync(dir)) return completed;
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()) {
    readFileSync(path.join(dir, file), 'utf8').split('\n').forEach((line, index) => {
      if (!line) return;
      let row;
      try { row = JSON.parse(line); } catch { throw new Error(`corrupt result ${file}:${index + 1}`); }
      if (row.cellKey && ['done', 'capped', 'error'].includes(row.status) && !retryableInfra(row.error ?? row.reason)) completed.add(row.cellKey);
    });
  }
  return completed;
}

/** One recorded start per family and fixture set; changing a cap or re-running cannot buy a new +5. */
export const budgetKey = (family) => digestOf([family, ...MATRIX_TASKS.map((task) => [fixtures[task].base, digestOf(fixtures[task])])]);
export function recordedBudgetStarts(dir = resultsDir) {
  const starts = new Map();
  if (!existsSync(dir)) return starts;
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()) {
    readFileSync(path.join(dir, file), 'utf8').split('\n').forEach((line, index) => {
      if (!line) return;
      let row;
      try { row = JSON.parse(line); } catch { throw new Error(`corrupt result ${file}:${index + 1}`); }
      if (row.status !== 'budget-start') return;
      const start = row.budgetOverride;
      if (row.budgetKey !== budgetKey(row.family) || !start || !Number.isFinite(start.startUsed) || start.startUsed < 0 || start.startUsed > 100 ||
        !Number.isFinite(start.points) || start.points <= 0 || start.points > 100 || start.ceiling !== start.startUsed + start.points ||
        !/^(week|7d)$/.test(start.window) || !Number.isFinite(Date.parse(start.resetsAt)) || !Number.isFinite(Date.parse(start.takenAt)) ||
        starts.has(row.family)) throw new Error(`invalid or duplicate budget start ${file}:${index + 1}; refuse to reset ceiling`);
      starts.set(row.family, start);
    });
  }
  return starts;
}

function record(row, dir = resultsDir) {
  mkdirSync(dir, { recursive: true });
  const line = `${JSON.stringify(row)}\n`;
  appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), line, { flag: 'a' });
  process.stdout.write(line);
}

/** Keep actual Pi tool results, not the advertised tools or a self-reported answer. */
export function transcriptEvidence(file, arm, directory = standDirectory(arm)) {
  const sessions = path.join(directory, 'sessions');
  if (typeof file !== 'string' || !file.startsWith(`${sessions}${path.sep}`) || !existsSync(file) ||
    !realpathSync(file).startsWith(`${realpathSync(sessions)}${path.sep}`)) throw new Error(`stand transcript missing or outside ${sessions}`);
  const entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const messages = entries.map((entry) => entry.message).filter(Boolean);
  const results = new Map(messages.filter((message) => message.role === 'toolResult').map((message) => [message.toolCallId, message]));
  const calls = messages.flatMap((message) => message.role === 'assistant' ? (message.content ?? []).filter((part) => part.type === 'toolCall') : []);
  const deliveredTools = calls.map((call) => ({ name: call.name === 'mcp' ? `${call.arguments?.server ? `${call.arguments.server}:` : ''}${call.arguments?.tool ?? 'mcp'}` : call.name,
    success: results.has(call.id) ? results.get(call.id).isError === false : null }));
  const rtkCommands = [...new Set(messages.filter((message) => message.role === 'toolResult' && message.toolName === 'bash')
    .map((message) => message.details?.orchCommand).filter((command) => typeof command === 'string' && /(?:^|\s|&&)rtk\s/.test(command)))];
  // Gateway calls to the arm's own server, counted from the raw calls: `server` names it, or is left out (codegraph
  // and memory are off in every stand cell). deliveredTools names such a call `server:tool`, so a name match
  // counted two `probe:search_code` calls as zero (pilot probe, 2026-10-01).
  const armServer = ARMS[arm].requires?.mcp;
  const armToolCalls = armServer ? calls.filter((call) => call.name === 'mcp' && (call.arguments?.server ?? armServer) === armServer).length : null;
  return { sessionJsonl: file, deliveredTools, armToolCalls, rtkCommands, billing: billedOutsideAssistant(entries) ? { cacheWrite: null, cost: null } : piBilling(messages),
    activationProof: path.join(directory, ARMS[arm].requires ? 'delivery.json' : 'install.json') };
}

/**
 * Whether a session entry bills outside an assistant message (a compaction or branch summary,
 * a usage row, any usage/cost field): the assistant-only sum would then undercount, so the
 * run's billing fails closed rather than folding a shape we have not seen into it.
 */
export function billedOutsideAssistant(entries) {
  const carries = (value) => value !== null && typeof value === 'object' &&
    (Array.isArray(value) ? value.some(carries) : Object.entries(value).some(([key, inner]) =>
      key === 'usage' || key === 'cost' || carries(inner)));
  return entries.some((entry) => entry?.type === 'usage' || carries(entry?.message?.role === 'assistant' ? { ...entry, message: null } : entry));
}

/**
 * Pi's own per-message usage (task 1716c): cacheWrite tokens and `cost.total`, Pi's catalog
 * USD price. A run's sum is null unless every assistant message carries it (a message
 * without usage would undercount); a message with tokens but a zero cost is a model Pi has
 * no price for, not a free call, so cost stays null.
 */
export function piBilling(messages) {
  const usages = messages.filter((message) => message.role === 'assistant').map((message) => message.usage);
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const priced = (usage) => finite(usage?.cost?.total) && (usage.cost.total > 0 ||
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every((part) => !part));
  return {
    cacheWrite: usages.length && usages.every((usage) => finite(usage?.cacheWrite)) ? usages.reduce((sum, usage) => sum + usage.cacheWrite, 0) : null,
    cost: usages.length && usages.every(priced) ? usages.reduce((sum, usage) => sum + usage.cost.total, 0) : null,
  };
}

/** Refuse a live matrix or pilot before allocating a seat if orch still runs its pre-stand code. */
export async function verifyLiveStand(fetcher = fetch, endpoint = 'http://127.0.0.1:7760/mcp', arms = MATRIX_ARMS) {
  const response = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`orch tools/list HTTP ${response.status}`);
  const list = await response.json();
  const tools = list.result?.tools ?? [];
  const create = tools.find((tool) => tool.name === 'seat_create');
  const prompt = tools.find((tool) => tool.name === 'seat_prompt');
  if (!arms.every((arm) => create?.inputSchema?.properties?.standArm?.enum?.includes(arm)) ||
      prompt?.inputSchema?.properties?.token_cap?.minimum !== 256) throw new Error('orch daemon lacks standArm/token_cap; safely reload only after live seats drain');
  return true;
}

export function createOrchClient(fetcher, endpoint = 'http://127.0.0.1:7760/mcp') {
  let requestId = 0;
  return async (name, args, timeoutMs = 120_000) => {
    const response = await fetcher(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const rpc = await response.json();
    if (rpc.error || rpc.result?.isError) throw new Error(`${name}: ${JSON.stringify(rpc.error ?? rpc.result.content)}`);
    return rpc.result?.structuredContent ?? JSON.parse(rpc.result.content[0].text);
  };
}

/** Coder checkout is a second worktree; index it only after orch provisioning is finished. */
export async function waitReady(orch, seat, timeoutMs = 180_000, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // One known seat, whatever its status: a scan of the closed list is paged and would lose an older seat (task 1569).
    const state = (await orch('seats_list', { seat })).seats?.find((item) => item.id === seat);
    if (!state) throw new Error(`provisioned seat ${seat} disappeared`);
    if (state.status === 'ready') return state;
    if (state.status === 'failed' || state.status === 'closed') throw new Error(`seat ${seat} ${state.status}: ${state.failure ?? 'unknown'}`);
    await delay(Math.min(1000, Math.max(0, until - Date.now())));
  }
  throw new Error(`seat ${seat} did not finish provisioning within ${timeoutMs} ms`);
}

/** Own timeout even if the client stub or network ignores AbortSignal. 60 s: a busy daemon answered seat_close after 10 s (2026-09-30). */
export async function closeSeat(orch, seat, timeoutMs = 60_000) {
  let timer;
  try {
    return await Promise.race([
      orch('seat_close', { seat }, timeoutMs),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`seat_close ${seat} timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function waitJson(turn, maxMinutes = 8) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'ops/orchestrator/src/main.ts'), 'wait', turn, '--json', '--timeout-minutes', String(maxMinutes)], { cwd: root });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const digest = JSON.parse(out);
        if (!digest.status || digest.waited) throw new Error(`wait exited ${code}: ${out}`);
        resolve(digest); // An error turn is still a scored run (zero), not a missing result.
      } catch (error) { reject(new Error(`wait --json: ${error.message}; ${err.slice(-300)}`)); }
    });
  });
}

export function toolArtifact(arm, file) {
  return (arm === 'open-codebase-index' && file.startsWith('.codebase-index/')) ||
    (arm === 'serena' && file.startsWith('.serena/')) ||
    (arm === 'gitnexus' && file.startsWith('.gitnexus/')) ||
    (arm === 'aider-repo-map' && (file.startsWith('.aider.tags.cache.v4/') || file === '.aider.chat.history.md'));
}

function namedTest(checkout, fixture) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${fixture.testName}$`, fixture.test], { cwd: checkout });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

export function retryableInfra(message) {
  return isStandSnapshotParseError(message) || typeof message === 'string' && /oauth refresh failed|provider (?:is )?unavailable|(?:provider|server) (?:at |has )?capacity|(?:provider|server) overloaded|no available capacity|temporarily unavailable|gave up after \d+ min|fetch failed/i.test(message);
}

export function measuredUsage(digest) {
  return Boolean(digest.tokens && ['input', 'output', 'total'].every((key) => Number.isFinite(digest.tokens[key])) &&
    (digest.tokens.cacheRead === null || Number.isFinite(digest.tokens.cacheRead)));
}

/** An edit-only row's first-edit outcome, read from the seat's own transcript; null when there is none to read. */
export function transcriptFirstEdit(sessionJsonl) {
  return typeof sessionJsonl === 'string' && existsSync(sessionJsonl) ? firstEditOutcome(sessionJsonl) : null;
}

export function resultRow(opts, rep, digest, fixture, paths, test, checkout, instruments = null) {
  // An edit-only fixture (no `test`) is scored on the owned diff alone and carries the
  // transcript first-edit outcome beside the score (task 1868 slice 3a, decisions #12881/#12895).
  const editOnly = fixture.role === 'coder' && !fixture.test && !fixture.probe;
  const { facts, precision, score } = fixture.role === 'scout'
    ? scoreScout(fixture, digest, root, checkout)
    : { facts: null, precision: null, score: fixture.probe ? scoreProbe(fixture, paths, test) : test ? scoreCoder(fixture, paths, test) : editOnly ? scoreEdit(fixture, paths) : 0 };
  // The instruments the seat EFFECTIVELY ran with (task 1452): from the
  // seat_create answer, else the arm's own override over the all-on default.
  const effective = instruments ?? (opts.instruments ? { codegraph: true, 'ast-grep': true, memory: true, ...opts.instruments } : { codegraph: true, 'ast-grep': true, memory: true });
  return { task: opts.task, arm: opts.arm, family: opts.family, rep, status: retryableInfra(digest.error) ? 'retryable' : /stand token cap reached|turn timed out/.test(digest.error ?? '') ? 'capped' : digest.status,
    ...(opts.cellKey ? { cellKey: opts.cellKey, fixtureHash: opts.fixtureHash, fixtureBase: fixture.base, model: opts.model, effort: opts.effort } : {}),
    ...(opts.cohort ? { cohort: opts.cohort } : {}),
    usage: digest.tokens, tools: digest.tools, seconds: digest.seconds, grade: digest.grade, facts, precision, score,
    ...(editOnly ? { firstEdit: transcriptFirstEdit(digest.sessionJsonl) } : {}),
    ...(fixture.probe ? { probe: test } : {}), instruments: effective };
}

export async function run(opts, rep, orch) {
  return opts.arm === 'open-codebase-index' ? withOllama(() => runIsolated(opts, rep, orch)) : opts.arm === 'openviking' ? withOpenVikingServer(() => runIsolated(opts, rep, orch)) : runIsolated(opts, rep, orch);
}

async function runIsolated(opts, rep, orch) {
  const fixture = fixtures[opts.task];
  if (fixture.role === 'scout') validateTruth(fixture, root);
  const checkout = path.join(realpathSync(tmpdir()), `orch-ab-${randomUUID()}`);
  let seat;
  let created;
  let digest;
  let originalError;
  try {
    git('worktree', 'add', '--detach', checkout, fixture.base);
    if (opts.arm === 'open-codebase-index') indexWithOllama(checkout, standDirectory(opts.arm));
    if (opts.arm === 'gitnexus' && fixture.role !== 'coder') indexGitnexus(checkout, standDirectory(opts.arm));
    if (opts.arm === 'openviking') indexWithOpenViking(checkout, standDirectory(opts.arm));
    created = await orch('seat_create', {
      role: opts.task === 'scout-short' ? 'researcher' : fixture.role, family: opts.family, repo: checkout, standArm: opts.arm,
      ...(opts.cellKey ? { harness: 'pi', model: opts.model, effort: opts.effort } : {}),
      ...(fixture.role === 'coder' ? { base: fixture.base } : {}),
      ...(opts.instruments ? { instruments: opts.instruments } : {}),
      title: `A/B ${opts.task} rep ${rep}`,
    });
    seat = created.id;
    if (!seat) throw new Error(`seat_create did not return an id: ${JSON.stringify(created)}`);
    if (opts.cellKey && (created.family !== opts.family || created.model !== opts.model || created.effort !== opts.effort ||
      Object.entries(opts.instruments).some(([name, enabled]) => created.instruments?.[name] !== enabled))) throw new Error('seat_create did not activate the requested matrix family/model/effort/instruments');
    if (fixture.role === 'coder' && !created.worktree) throw new Error('coder worktree missing from seat_create');
    if (opts.arm === 'open-codebase-index' && fixture.role === 'coder') {
      await waitReady(orch, seat);
      if (!created.worktree || !existsSync(created.worktree)) throw new Error('OCI coder worktree missing after provisioning');
      indexWithOllama(created.worktree, standDirectory(opts.arm));
    }
    if (opts.arm === 'gitnexus' && fixture.role === 'coder') {
      await waitReady(orch, seat);
      if (!created.worktree || !existsSync(created.worktree)) throw new Error('gitnexus coder worktree missing after provisioning');
      indexGitnexus(created.worktree, standDirectory(opts.arm));
    }
    if (opts.arm === 'openviking' && fixture.role === 'coder') {
      await waitReady(orch, seat);
      if (!created.worktree || !existsSync(created.worktree)) throw new Error('openviking coder worktree missing after provisioning');
      indexWithOpenViking(created.worktree, standDirectory(opts.arm));
    }
    // Provisioning and embedding can outlive a quota reading: recheck immediately
    // before the model starts, even after the matrix-level pre-create guard.
    if (opts.cellKey) {
      opts.guard = await liveGuard(opts.family, opts.readUsage ?? readFamilyUsage, opts.budgetOverride ?? null, opts.paceOverride ?? null);
      if (!opts.guard.run) {
        const skipped = { task: opts.task, family: opts.family, arm: opts.arm, rep, cellKey: opts.cellKey,
          fixtureHash: opts.fixtureHash, fixtureBase: fixture.base, ...(opts.cohort ? { cohort: opts.cohort } : {}),
          status: 'skipped', reason: opts.guard.reason, guard: opts.guard, usage: null, score: null };
        record(skipped, opts.resultsDir ?? resultsDir);
        return skipped;
      }
    }
    const auth = syncStandAuth(opts.arm, { ...(opts.cellKey ? { family: opts.family, timeoutMinutes: opts.timeoutMinutes } : {}), ...opts.authDeps });
    if (!auth.run) {
      const skipped = { task: opts.task, family: opts.family, arm: opts.arm, rep, cellKey: opts.cellKey,
        fixtureHash: opts.fixtureHash, fixtureBase: fixture.base, ...(opts.cohort ? { cohort: opts.cohort } : {}),
        status: 'skipped', reason: auth.reason, usage: null, score: null };
      record(skipped, opts.resultsDir ?? resultsDir);
      return skipped;
    }
    // A frozen fixture brief is the measured task: orch's 300-word limit takes long_brief, never a cut.
    // The arm's hint follows the frozen brief: a seat that is never told its tool exists never calls it
    // (pilots agent-lsp and probe, 2026-10-01: zero challenger tool calls in eight finished cells).
    const brief = ARMS[opts.arm].hint ? `${fixture.brief}\n\n${ARMS[opts.arm].hint}` : fixture.brief;
    const { turn } =  await orch('seat_prompt', { seat, prompt: brief,
      ...(brief.trim().split(/\s+/).length > 300 ? { long_brief: 'frozen A/B fixture brief: cutting it would change the measured task' } : {}),
      ...(opts.cellKey ? { timeout_minutes: opts.timeoutMinutes } : {}),
      ...(opts.tokenCap !== undefined ? { token_cap: opts.tokenCap } : {}),
      ...(fixture.role === 'coder' ? { files: fixture.owned } : {}) });
    if (!turn) throw new Error('seat_prompt did not return a turn');
    // The wait must outlast the cell's own turn limit plus its time in orch's queue: the fixed
    // 8 minutes gave up on a running 15-minute turn and recorded the cell as a scored error.
    digest = await waitJson(turn, opts.cellKey ? opts.timeoutMinutes + QUEUE_MARGIN_MINUTES : undefined);
    if (retryableInfra(digest.error)) {
      const row = { task: opts.task, arm: opts.arm, family: opts.family, rep, cellKey: opts.cellKey,
        fixtureHash: opts.fixtureHash, fixtureBase: fixture.base, ...(opts.cohort ? { cohort: opts.cohort } : {}),
        status: 'retryable', error: digest.error,
        usage: digest.tokens ?? null, score: null, sessionJsonl: digest.sessionJsonl ?? null, guard: opts.guard };
      record(row, opts.resultsDir ?? resultsDir);
      return row;
    }
    if (opts.cellKey && !/stand token cap reached|turn timed out/.test(digest.error ?? '') && !measuredUsage(digest)) throw new Error('stand turn usage missing; refuse an unmeasured score');
    const paths = fixture.role === 'coder' && digest.status === 'done' && existsSync(created.worktree) ? changedPaths(created.worktree, fixture.base).filter((p) => !toolArtifact(opts.arm, p)) : [];
    const test = fixture.role === 'coder' && digest.status === 'done' && existsSync(created.worktree)
      ? fixture.probe ? runLessonProbe(fixture.probe, created.worktree) : fixture.test ? await namedTest(created.worktree, fixture) : null
      : null;
    const row = resultRow(opts, rep, digest, fixture, paths, test, checkout, created.instruments ?? null);
    if (opts.cellKey) {
      const { billing, ...evidence } = transcriptEvidence(digest.sessionJsonl, opts.arm);
      if (row.usage) row.usage = { ...row.usage, ...billing };
      const currentProfileHash = profileHash(standDirectory(opts.arm));
      if (currentProfileHash !== opts.activationProfileHash ||
        ARMS[opts.arm].requires && JSON.parse(readFileSync(evidence.activationProof, 'utf8')).profileHash !== currentProfileHash) throw new Error('arm activation proof changed during the run');
      // evidence.armToolCalls: zero on a challenger means the comparison measured no tool: report it as no result.
      Object.assign(row, evidence, { activationProfileHash: currentProfileHash,
        guard: opts.guard, tokenCap: opts.tokenCap, timeoutMinutes: opts.timeoutMinutes, error: digest.error });
    }
    record(row, opts.resultsDir ?? resultsDir);
    if (row.score < 1) process.exitCode = 1;
    return row;
  } catch (error) {
    originalError = error;
    const paused = /\bis paused; unpause\b/.test(error.message);
    const retryable = retryableInfra(error.message);
    if (opts.cellKey) record({ task: opts.task, family: opts.family, arm: opts.arm, rep, cellKey: opts.cellKey,
      fixtureHash: opts.fixtureHash, fixtureBase: fixture.base, ...(opts.cohort ? { cohort: opts.cohort } : {}),
      status: paused ? 'skipped' : retryable ? 'retryable' : 'error', reason: error.message, score: paused || retryable ? null : 0,
      usage: digest?.tokens ?? null, sessionJsonl: digest?.sessionJsonl ?? null, guard: opts.guard }, opts.resultsDir ?? resultsDir);
    if ((paused || retryable) && opts.cellKey) return { status: paused ? 'skipped' : 'retryable', usage: null };
    throw error;
  } finally {
    let cleanupError;
    const clean = async (step) => { try { await step(); } catch (error) { cleanupError ??= error; console.error(`stand cleanup: ${error.message}`); } };
    let seatClosed = !seat;
    if (seat) {
      try { await closeSeat(orch, seat); seatClosed = true; }
      catch (error) { cleanupError = error; console.error(`stand cleanup: ${error.message}`); }
    }
    // Never delete a checkout beneath a seat whose close could not be proved.
    if (!seatClosed) console.error(`stand cleanup: preserving seat ${seat}, checkout ${checkout}, worktree ${created?.worktree ?? 'none'}; close the seat before manual removal`);
    else {
      if (created?.worktree && existsSync(created.worktree)) await clean(() => git('worktree', 'remove', '--force', created.worktree));
      if (created?.branch) await clean(() => { if (git('branch', '--list', created.branch).trim()) git('branch', '-D', created.branch); });
      await clean(() => {
        if (git('worktree', 'list', '--porcelain').includes(`worktree ${checkout}\n`)) git('worktree', 'remove', '--force', checkout);
        else rmSync(checkout, { recursive: true, force: true });
      });
    }
    if (cleanupError && !originalError) throw cleanupError;
  }
}

export async function executeMatrix(opts, deps = {}) {
  const plan = opts.pilot ? pilotPlan(opts) : matrixPlan(opts);
  const dir = deps.resultsDir ?? resultsDir;
  const finished = recordedCells(dir);
  // A pilot takes no --budget, so a matrix budget start (possibly from a past reset) never guards it.
  const starts = opts.pilot ? new Map() : recordedBudgetStarts(dir);
  const readUsage = deps.readUsage ?? readFamilyUsage;
  const orch = deps.orch ?? createOrchClient(fetch);
  const runCell = deps.runCell ?? run;
  const write = deps.record ?? ((row) => record(row, deps.resultsDir ?? resultsDir));
  const dryReadings = new Map();
  const startFailures = new Map();
  // Capture every requested family before ANY cell runs; a resume never samples
  // a new start or resets its ceiling. Dry runs show the proposed start only.
  for (const [family, points] of Object.entries(opts.budgets ?? {})) {
    const stored = starts.get(family);
    if (stored) {
      if (stored.points !== points) throw new Error(`budget ${family} already starts at ${stored.startUsed}% with +${stored.points}; refuse a new ceiling`);
      continue;
    }
    const verdict = await liveGuard(family, readUsage, { points });
    if (!verdict.budgetOverride) { startFailures.set(family, verdict); continue; }
    starts.set(family, verdict.budgetOverride);
    if (opts.dryRun) dryReadings.set(family, verdict);
    else write({ status: 'budget-start', family, budgetKey: budgetKey(family), budgetOverride: verdict.budgetOverride });
  }
  const paused = new Set();
  const familyRuns = new Map();
  const counts = { cells: plan.length, runnable: 0, skipped: 0, deferred: 0, recorded: 0, unarmed: 0 };
  for (const entry of plan) {
    let activationProfileHash = null;
    try { activationProfileHash = profileHash(standDirectory(entry.arm)); } catch { /* readiness below will refuse an incomplete profile */ }
    const cell = { ...entry, activationProfileHash };
    const key = cellKey(cell);
    if (finished.has(key)) {
      counts.recorded++;
      if (opts.dryRun) process.stdout.write(`${JSON.stringify({ mode: 'dry-run', task: cell.task, family: cell.family, arm: cell.arm, rep: cell.rep, verdict: 'recorded' })}\n`);
      continue;
    }
    let instruments;
    let readiness = null;
    try { (deps.probeArm ?? armInstruments)(cell.arm, deps.armDeps ?? {}); instruments = matrixInstruments(cell.arm); } catch (error) { readiness = error.message; counts.unarmed++; }
    let verdict;
    if (paused.has(cell.family)) verdict = { run: false, reason: 'family paused after a capped, retryable or unreadable turn' };
    else if (startFailures.has(cell.family)) verdict = startFailures.get(cell.family);
    else if (!opts.dryRun && (familyRuns.get(cell.family) ?? 0) >= MAX_FAMILY_RUNS) verdict = { run: true, reason: null };
    else if (opts.dryRun && dryReadings.has(cell.family)) verdict = dryReadings.get(cell.family);
    else {
      verdict = await liveGuard(cell.family, readUsage, starts.get(cell.family) ?? null, opts.paceOverride ?? null);
      if (opts.dryRun) dryReadings.set(cell.family, verdict);
    }
    const deferred = !readiness && verdict.run && (familyRuns.get(cell.family) ?? 0) >= MAX_FAMILY_RUNS;
    const reason = deferred ? `batch cap ${MAX_FAMILY_RUNS} runs per family; resume after quota refresh` : readiness ?? verdict.reason;
    if (opts.dryRun) {
      process.stdout.write(`${JSON.stringify({ mode: 'dry-run', task: cell.task, family: cell.family, arm: cell.arm, rep: cell.rep,
        verdict: deferred ? 'defer' : readiness ? 'unarmed' : verdict.run ? 'run' : 'skip', reason, budget: verdict.budget ?? null, budgetOverride: starts.get(cell.family) ?? null })}\n`);
      if (deferred) counts.deferred++; else if (!readiness && verdict.run) { counts.runnable++; familyRuns.set(cell.family, (familyRuns.get(cell.family) ?? 0) + 1); } else counts.skipped++;
      continue;
    }
    if (deferred || readiness || !verdict.run) {
      if (deferred) counts.deferred++; else counts.skipped++;
      write({ ...cell, cellKey: key, status: 'skipped', reason, guard: verdict, usage: null, score: null });
      continue;
    }
    const row = await runCell({ ...cell, cellKey: key, instruments, guard: verdict, budgetOverride: starts.get(cell.family) ?? null, paceOverride: opts.paceOverride ?? null, readUsage, resultsDir: dir }, cell.rep, orch);
    if (row.status === 'skipped') { counts.skipped++; paused.add(cell.family); continue; }
    counts.runnable++;
    familyRuns.set(cell.family, (familyRuns.get(cell.family) ?? 0) + 1);
    if (row.status === 'capped' || row.status === 'retryable' || row.usage === null) paused.add(cell.family);
  }
  process.stdout.write(`${JSON.stringify({ mode: opts.dryRun ? 'dry-run-summary' : opts.pilot ? 'pilot-summary' : 'matrix-summary', ...counts })}\n`);
  return counts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = options(process.argv.slice(2));
    if (opts.matrix || opts.pilot) {
      if (!opts.dryRun) await verifyLiveStand(fetch, undefined, opts.pilot ? [...new Set([...MATRIX_ARMS, ...PILOTS[opts.pilot].arms])] : MATRIX_ARMS);
      await executeMatrix(opts);
    } else if (opts.dryRun) throw new Error('--dry-run is for the full --families matrix or a --pilot');
    else {
      const orch = createOrchClient(fetch);
      for (let rep = 1; rep <= Number(opts.reps); rep++) await run(opts, rep, orch);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
