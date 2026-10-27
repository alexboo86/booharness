#!/usr/bin/env node
// Split rtk's savings by WHO produced them: the operator's own session, or a
// orch seat (or a historical Svod member).
//
// `rtk gain` reports one number over every command it ever wrapped, and that
// number is a mixture: the operator reads big files and greps whole trees (where
// the filters have something to remove), while a review member mostly runs tests
// and short git commands (where they do not). Measured 2026-08-05 over 489 rows:
// the operator's own checkout saved 25%, members between 0% and 21%, and the
// blended figure `rtk gain` prints — 18% — describes nobody. A harness decision
// ("is rtk worth wiring into members at all") needs the two apart.
//
// The split is a property of `commands.project_path`: orch seats live in
// `<orch stateDir>/worktrees/<role>-<family>-<seat-id>`. Paseo seats live
// under `~/.paseo/worktrees/<workspace>/<branch>`. Historical Svod rows live in
// `<parent>/.svod/<checkout>/worktrees/<run-id>/<member-id>`.
// Other paths, including lead worktrees under `.claude/worktrees`, are operator.
//
//   node scripts/rtk-gain-split.mjs [--db <path>] [--json] [--since <ISO date>]

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { isMain } from './lib/is-main.mjs';
import { loadConfig } from '../ops/orchestrator/src/config.ts';
import { candidatePaths } from './harness-report/collect-rtk.mjs';

// Legacy `<...>/.svod/<checkout>/worktrees/<run>/<member>`: five segments.
const STATE_DIRECTORY = '.svod';
const WORKTREES_DIRECTORY = 'worktrees';
const SEAT_DEPTH = 5;

function segments(value) {
  return String(value || '').replace(/^\\\\\?\\/, '').split(/[\\/]+/).filter(Boolean);
}

/**
 * Who ran this command, read off the working directory it ran in.
 * @param {string} projectPath
 * @param {string} stateDir orch's configured state directory
 * @param {string} home operator's home directory
 * @returns {{ side: 'member'|'operator', run: string|null, member: string|null, family?: string }}
 */
export function classifyProject(projectPath, stateDir = loadConfig().stateDir, home = os.homedir()) {
  const parts = segments(projectPath);
  const root = segments(stateDir);
  if (root.length && parts.length > root.length + 1
    && root.every((part, i) => part.toLowerCase() === parts[i].toLowerCase())
    && parts[root.length].toLowerCase() === WORKTREES_DIRECTORY) {
    const member = parts[root.length + 1];
    const seat = /^[^-]+-([^-]+)-[^-]+$/.exec(member);
    if (seat) return { side: 'member', run: null, member, family: seat[1] };
  }
  const paseo = [...segments(home), '.paseo', WORKTREES_DIRECTORY];
  if (parts.length > paseo.length + 1
    && paseo.every((part, i) => part.toLowerCase() === parts[i].toLowerCase())) {
    return { side: 'member', run: null, member: `${parts[paseo.length]}/${parts[paseo.length + 1]}`, family: 'paseo' };
  }
  for (let i = 0; i + SEAT_DEPTH <= parts.length; i += 1) {
    // Windows compares paths without case, and the same worktree arrives spelled
    // both ways depending on who launched it.
    if (parts[i].toLowerCase() !== STATE_DIRECTORY) continue;
    if (parts[i + 2].toLowerCase() !== WORKTREES_DIRECTORY) continue;
    const run = parts[i + 3] || null;
    const member = parts[i + 4] || null;
    // A run directory with no seat under it is not a member's command.
    if (run && member) return { side: 'member', run, member };
  }
  return { side: 'operator', run: null, member: null };
}

/**
 * `--since` as the ISO DAY it names, or null when it is not a real calendar date.
 *
 * A day, not a timestamp, because `commands.timestamp` is ISO TEXT and the
 * filter compares text: an epoch number compared against
 * `2026-08-05T10:59:14+00:00` orders by the first character and matches
 * everything — measured by review 2026-08-05, a FUTURE `--since` returned all
 * 881 rows. `Date.parse` is separately too permissive: it accepts `2026-02-31`
 * (rolling into March) and `123` (a year), so a typo silently moves the window.
 * @param {string} value
 * @returns {string|null}
 */
export function parseSince(value) {
  const day = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(day);
  if (Number.isNaN(ms)) return null;
  // Round-trip: only a date that survives being rendered back is the date the
  // caller wrote. `2026-02-31` comes back as `2026-03-03`.
  return new Date(ms).toISOString().slice(0, 10) === day ? day : null;
}

/**
 * @param {Array<{project_path: string, input_tokens: number, saved_tokens: number}>} rows
 * @param {string} stateDir orch's configured state directory
 * @param {string} home operator's home directory
 */
export function summarize(rows, stateDir = loadConfig().stateDir, home = os.homedir()) {
  const blank = () => ({ commands: 0, input: 0, saved: 0 });
  const totals = { operator: blank(), member: blank() };
  const perMember = new Map();
  for (const row of rows) {
    const { side, run, member, family } = classifyProject(row.project_path, stateDir, home);
    const bucket = totals[side];
    bucket.commands += 1;
    bucket.input += row.input_tokens || 0;
    bucket.saved += row.saved_tokens || 0;
    if (side === 'member') {
      const key = `${member} · ${family ?? run}`;
      const seat = perMember.get(key) || blank();
      seat.commands += 1;
      seat.input += row.input_tokens || 0;
      seat.saved += row.saved_tokens || 0;
      perMember.set(key, seat);
    }
  }
  const pct = (b) => (b.input > 0 ? (100 * b.saved) / b.input : 0);
  return {
    operator: { ...totals.operator, savedPct: pct(totals.operator) },
    members: { ...totals.member, savedPct: pct(totals.member) },
    blended: {
      commands: totals.operator.commands + totals.member.commands,
      input: totals.operator.input + totals.member.input,
      saved: totals.operator.saved + totals.member.saved,
      savedPct: pct({
        input: totals.operator.input + totals.member.input,
        saved: totals.operator.saved + totals.member.saved,
      }),
    },
    seats: [...perMember.entries()]
      .map(([seat, b]) => ({ seat, ...b, savedPct: pct(b) }))
      .sort((a, b) => b.commands - a.commands),
  };
}

/** Read existing candidate DBs without counting the same command twice across DBs. */
export function readHistory(paths, since = null) {
  const dbPaths = [...new Set(paths.filter(existsSync))];
  if (!dbPaths.length) throw new Error(`no rtk history at: ${paths.join(', ')}`);
  const rows = [];
  const seen = new Map();
  for (const dbPath of dbPaths) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // A rotated shell is not a history; do not silently report partial totals.
      const hasCommands = db.prepare("select count(*) n from sqlite_master where type='table' and name='commands'").get().n > 0;
      if (!hasCommands) throw new Error(`${dbPath} has no rtk \`commands\` table — a rotated or empty history has nothing to split`);
      // `timestamp` is ISO text: compare with an ISO day, never an epoch integer.
      const found = since === null
        ? db.prepare('select timestamp, original_cmd, project_path, input_tokens, saved_tokens from commands').all()
        : db.prepare('select timestamp, original_cmd, project_path, input_tokens, saved_tokens from commands where timestamp >= ?').all(since);
      for (const row of found) {
        const key = JSON.stringify([row.timestamp, row.original_cmd, row.project_path]);
        const prior = seen.get(key);
        if (prior && prior.dbPath !== dbPath) {
          if (prior.input_tokens !== row.input_tokens || prior.saved_tokens !== row.saved_tokens) {
            throw new Error(`conflicting metrics for the same rtk command in ${prior.dbPath} and ${dbPath}: ${key}`);
          }
          continue;
        }
        seen.set(key, { dbPath, input_tokens: row.input_tokens, saved_tokens: row.saved_tokens });
        rows.push(row);
      }
    } finally {
      db.close();
    }
  }
  return { rows, dbPaths };
}

if (isMain(import.meta.url)) {
  const dbArg = process.argv.indexOf('--db');
  if (dbArg > -1 && !process.argv[dbArg + 1]) {
    console.error('--db needs a path');
    process.exit(1);
  }
  const paths = dbArg > -1 ? [process.argv[dbArg + 1]] : candidatePaths(os.homedir());
  const sinceArg = process.argv.indexOf('--since');
  const since = sinceArg > -1 ? parseSince(process.argv[sinceArg + 1]) : null;
  if (sinceArg > -1 && since === null) {
    console.error(`--since needs a real ISO date (YYYY-MM-DD), got ${process.argv[sinceArg + 1]}`);
    process.exit(1);
  }
  let history;
  try {
    history = readHistory(paths, since);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const { rows, dbPaths } = history;
  const report = summarize(rows);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ databases: dbPaths, ...report }, null, 2));
  } else {
    const line = (name, b) => `  ${name.padEnd(10)} ${String(b.commands).padStart(5)} cmd  ${b.input
      .toLocaleString('en-US')
      .padStart(12)} in  ${b.saved.toLocaleString('en-US').padStart(11)} saved  ${b.savedPct.toFixed(1).padStart(5)}%`;
    console.log(`rtk savings by who ran the command — ${rows.length} commands across ${dbPaths.length} DB(s):\n  ${dbPaths.join('\n  ')}\n`);
    console.log(line('operator', report.operator));
    console.log(line('members', report.members));
    console.log(line('blended', report.blended), '  ← combined across the listed histories');
    if (report.seats.length) {
      console.log('\n  per seat:');
      for (const seat of report.seats.slice(0, 12)) {
        console.log(`    ${seat.savedPct.toFixed(1).padStart(5)}%  ${String(seat.commands).padStart(4)} cmd  ${seat.seat}`);
      }
      if (report.seats.length > 12) console.log(`    … and ${report.seats.length - 12} more seats`);
    }
  }
}
