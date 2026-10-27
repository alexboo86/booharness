// Lead instrument use, read from the lead's own Claude Code transcripts.
//
// Why this exists (2026-09-11): over 152 lead sessions (2026-08-16..09-10) the
// lead issued 8783 sed and 4234 cat calls against 161 probe and 14 ast-grep
// calls, and 4982 ssh calls against 442 calls of the booharness MCP that the
// contract puts before SSH. Nothing in this report showed it: the rtk, memory
// and svod collectors read their own journals, and none of them sees what the
// LEAD chose to type. The per-call hints in ops/bootstrap/code-intel-order-hook.mjs
// were added the same day; this section is how anyone learns whether they work.
//
// Counts are of shell PROGRAMS, not of lines: heredoc bodies are dropped and a
// command is split at top-level `&&`, `||`, `|`, `;` with the rtk scanner, so a
// script pasted into a heredoc does not count as forty `const` invocations.
// `rtk <cmd>` and `rtk proxy <cmd>` count as <cmd>.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitTopLevel, splitWords } from '../../ops/bootstrap/rtk-rewrite-lib.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_FILE = /\.(rs|ts|tsx|mjs|js|py)\b/i;
const SERVER_HOST = /^(?:[^@\s]+@)?(<configured-host>|<configured-host>)(?:-ro)?$/i;
const HEREDOC = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(?:\n|$)/g;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function emptySection() {
  return { id: 'lead', title: 'Lead instrument use (Claude transcripts)', health: [], metrics: [], rows: [], errors: [] };
}

function metric(label, value, unit, note = null) {
  return { label, value, unit, note };
}

/// This repository's lead transcripts: project directories named after a
/// checkout of harness-project, without the Svod member worktrees
/// (`-Users-...-Developer--svod-...`), whose seats are counted by Svod itself.
export function leadTranscripts(projectsRoot, sinceMs) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() || !dir.name.includes(path.resolve(process.env.HARNESS_PROJECT_ROOT || process.cwd()).replace(/[/\\:]/g, '-')) || dir.name.includes('--svod-')) continue;
    const full = path.join(projectsRoot, dir.name);
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(full, name);
      const stat = fs.statSync(file);
      if (stat.mtimeMs >= sinceMs) out.push(file);
    }
  }
  return out;
}

/// Program words of one shell command, with `rtk`/`rtk proxy` peeled.
export function programs(command) {
  const out = [];
  const text = String(command ?? '').replace(HEREDOC, '\n');
  for (const line of text.split('\n')) {
    for (const { part } of splitTopLevel(line, ['&&', '||', '|', ';'])) {
      let words = splitWords(part).map((word) => word.replace(/^["'(]+|["')]+$/g, ''));
      while (words.length && (ASSIGNMENT.test(words[0]) || ['do', 'then', 'else', 'time', '!', '{'].includes(words[0]))) {
        words = words.slice(1);
      }
      if (words[0] === 'rtk') words = words.slice(words[1] === 'proxy' || words[1] === 'bypass' ? 2 : 1);
      if (!words.length) continue;
      out.push({ program: path.basename(words[0]).toLowerCase(), operands: words.slice(1) });
    }
  }
  return out;
}

export function tallySession(lines) {
  const t = {
    sourceReads: 0, codegraph: 0, astGrep: 0, blastRadius: 0, serverSsh: 0, booharnessMcp: 0,
    memorySearch: 0, memoryGet: 0, scout: 0, toolCalls: 0,
  };
  for (const line of lines) {
    if (!line.includes('"tool_use"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      t.toolCalls += 1;
      const name = String(block.name ?? '');
      if (/codegraph/.test(name)) t.codegraph += 1;
      if (name.startsWith('mcp__booharness__')) t.booharnessMcp += 1;
      // A lead's scout is an orch scout seat (decision #12069), classified as in
      // ops/orchestrator/src/toolkinds.ts; scout.sh runs below stay counted for history.
      if (name === 'mcp__orch__seat_create' && (block.input?.role ?? block.input?.arguments?.role) === 'scout') t.scout += 1;
      if (/memory/.test(name)) {
        const action = block.input?.action;
        if (action === 'search') t.memorySearch += 1;
        if (action === 'get') t.memoryGet += 1;
      }
      if (name === 'Read' && SOURCE_FILE.test(String(block.input?.file_path ?? '')) && !block.input?.limit) {
        t.sourceReads += 1;
      }
      if (name !== 'Bash') continue;
      const command = String(block.input?.command ?? '');
      if (/scripts\/scout\.sh/.test(command)) t.scout += 1;
      if (/blast-radius\.mjs/.test(command)) t.blastRadius += 1;
      for (const { program, operands } of programs(command)) {
        if (program === 'codegraph') t.codegraph += 1;
        else if (program === 'ast-grep' || program === 'sg') t.astGrep += 1;
        else if ((program === 'sed' || program === 'cat') && operands.some((word) => SOURCE_FILE.test(word))) t.sourceReads += 1;
        else if (program === 'ssh' && operands.some((word) => SERVER_HOST.test(word))) t.serverSsh += 1;
        else if (program === 'memoryctl' && operands[0] === 'search') t.memorySearch += 1;
        else if (program === 'memoryctl' && (operands[0] === 'get' || operands[0] === 'show')) t.memoryGet += 1;
      }
    }
  }
  return t;
}

export async function collect(options = {}) {
  const section = emptySection();
  const days = Number(options.days) > 0 ? Number(options.days) : 7;
  const projectsRoot = options.projectsRoot ?? path.join(os.homedir(), '.claude', 'projects');
  try {
    const files = leadTranscripts(projectsRoot, Date.now() - days * DAY_MS);
    if (!files.length) {
      section.health.push({ label: 'Transcripts', status: 'warn', detail: `no lead transcript touched in ${days}d under ${projectsRoot} - not measured` });
      return section;
    }
    const sum = {};
    const perSession = [];
    for (const file of files) {
      const tally = tallySession(fs.readFileSync(file, 'utf8').split('\n'));
      if (!tally.toolCalls) continue;
      perSession.push({ session: path.basename(file, '.jsonl').slice(0, 8), ...tally });
      for (const [key, value] of Object.entries(tally)) sum[key] = (sum[key] ?? 0) + value;
    }
    section.health.push({ label: 'Transcripts', status: 'ok', detail: `${perSession.length} lead session(s) with tool calls in ${days}d` });
    const codeIntel = (sum.codegraph ?? 0) + (sum.astGrep ?? 0);
    const ratio = sum.sourceReads ? codeIntel / sum.sourceReads : null;
    // Warn, never fail: a ratio is a question about how the lead works, not a
    // broken harness. The threshold is where the 2026-09-11 baseline stood
    // (161 + 14 against ~13000 source reads, about 1%): below one search per ten
    // numbered or whole-file reads the hints are not being acted on.
    section.health.push({
      label: 'Code search vs source reads',
      status: ratio === null || ratio >= 0.1 ? 'ok' : 'warn',
      detail: ratio === null ? 'no source reads' : `${codeIntel} codegraph/ast-grep per ${sum.sourceReads} sed/cat/whole-file reads of source`,
    });
    const sshShare = (sum.serverSsh ?? 0) + (sum.booharnessMcp ?? 0);
    section.health.push({
      label: 'booharness MCP vs ssh to <configured-host>/<configured-host>',
      status: !sshShare || (sum.booharnessMcp ?? 0) >= (sum.serverSsh ?? 0) ? 'ok' : 'warn',
      detail: `${sum.booharnessMcp ?? 0} MCP calls, ${sum.serverSsh ?? 0} ssh commands`,
    });
    section.metrics.push(
      metric('Source reads (sed/cat/whole Read)', sum.sourceReads ?? 0, 'calls'),
      metric('codegraph', sum.codegraph ?? 0, 'calls'),
      metric('ast-grep', sum.astGrep ?? 0, 'calls'),
      metric('blast-radius', sum.blastRadius ?? 0, 'calls'),
      metric('ssh to <configured-host>/<configured-host>', sum.serverSsh ?? 0, 'commands'),
      metric('booharness MCP', sum.booharnessMcp ?? 0, 'calls'),
      metric('memory search / get', `${sum.memorySearch ?? 0} / ${sum.memoryGet ?? 0}`, 'calls'),
      metric('scout runs', sum.scout ?? 0, 'runs'),
    );
    perSession.sort((left, right) => right.sourceReads - left.sourceReads);
    section.rows.push({
      title: 'Sessions by source reads',
      columns: ['session', 'reads', 'codegraph', 'ast-grep', 'ssh', 'mcp', 'mem search', 'scout'],
      values: perSession.slice(0, 10).map((s) => [s.session, s.sourceReads, s.codegraph, s.astGrep, s.serverSsh, s.booharnessMcp, s.memorySearch, s.scout]),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    section.health.push({ label: 'Transcripts', status: 'fail', detail: message });
    section.errors.push(`transcripts: ${message}`);
  }
  return section;
}
