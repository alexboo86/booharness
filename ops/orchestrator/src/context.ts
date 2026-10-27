// The message a seat's provider receives first: role, knowledge, lessons,
// code-intel rules, routed skills, the lead's brief, and the closing with the
// role's report contract. orch owns this text; it does not use Paseo's builder
// (operator, 2026-09-22, memory #10494). The generic harness libraries behind
// it — the knowledge-page map render, the Jev lesson and skill routers — are shared,
// unchanged.
//
// No memory hot (operator, 2026-09-22): it is the lead's session digest (open
// P0 tasks, access cards, handoffs), measured at ~2.1k of a ~12k-character
// context, and a seat may search memory but not write it.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Harness } from './providers/types.ts';
import { contractRole, reportContract, type ContractRole, type ReportRole, type TableContract } from './report.ts';
import { readKnowledgePage, routeKnowledgeSections } from '../../bootstrap/knowledge-page-lib.mjs';
import { renderLessonContext } from '../../bootstrap/lesson-router.mjs';
import { route as routeSkills } from '../../bootstrap/skill-router.mjs';
import { imageInput } from './model-input.ts';
import { ALL_ON, instrumentsOff, type Instruments } from './shared.entry.ts';
import { killTree } from './worktrees.ts';
import { quoteShellPath, spawnProvider } from './providers/spawn.ts';
import { MAX_QUESTION_WORDS, SCOUT_CALLERS } from './shared.entry.ts';
import { renderModulesSection } from './context-modules.ts';
import { remotePiMissingServers } from './remote-pi-mcp.ts';
import { checkConfigHealth } from './config-health.ts';

const REPO = new URL('../../../', import.meta.url);
const SEAT_JEV_TIMEOUT_MS = 5000;

/** One sentence of purpose, then the contract each worker role is held to. */
export const ROLE_NOTES: Record<ContractRole, string> = {
  scout: 'CODE RECONNAISSANCE, cheap: where is X, who calls Y, a sweep across 3+ files, logs or memory. Read-only (rg, codegraph, memoryctl search). ONE QUESTION PER SEAT: the seat closes when it answers. FACTS ONLY (operator #17974): report what exists, where, how it is wired and what a source or measurement says; do not design, choose or recommend. When the brief asks how to build something or whether a plan is enough, report the facts that decision needs and name the open decision in forLead. If codegraph_explore does not return the source that decides the answer, query codegraph again by the file or symbol name; then run a bounded `rg` for a literal (by file glob or narrow path, with `-m`/`--max-count` where applicable) or a bounded `ast-grep` for a code shape before answering; report a partial answer only after these searches return empty, naming what was searched.',
  // A plan critic (plan 14746 D3): the scout lifecycle on the reviewer matrix, judging a plan, not a diff.
  critic: 'PLAN CRITIC: you are given a plan, not a diff. Find what it missed: edge cases (empty, single, maximum, error, two actors at once), destructive operations (trace what a remove, delete, clear, overwrite or reset leaves behind), hidden side effects, silent assumptions, fit with the code and the decisions already recorded, blast radius. Check in the code before you claim (rg, codegraph, memoryctl search); a finding your own check refutes is dropped, not reported. Each finding is one sentence with its file:line and a confidence rating; no rewriting, no alternative design, no style remarks. Read-only. ONE QUESTION PER SEAT: the seat closes when it answers.',
  researcher: 'WEB RESEARCH: current versions, upstream docs, pricing, prior art, tool comparisons. Every finding carries a URL and the date it was read. No code edits. ONE QUESTION PER SEAT.',
  debater: 'DEBATE: the lead names a fork and a side; defend it with evidence from the code and the docs, and name the weak points of your own position honestly. Analysis only, no edits. TWO TURNS: one answer, then one rebuttal whose brief carries the other side\'s stored report (claims, evidence, forLead) under a heading that names that turn. A third turn is refused.',
  coder: 'CODE against a plan the lead has already agreed: edits, typecheck, lint, cargo check, reproduction commands and refactors, in your own worktree. Tests are allowed (operator #14235): write and run them; a new or changed test passes the test-audit authoring gate; run the narrowest test that covers the change, not a whole suite for a one-file change. Never change existing assertions unless the brief allows it and names the change that made them stale (operator #14245). The curated money/data set is the CI and pre-deploy gate and changes only by operator decision. Performance measurement and visual evaluation remain allowed. Never commit, never write to memory, never create other agents.',
  reviewer: 'INDEPENDENT REVIEW of a diff in its own worktree. Hunt defects that BREAK something; a blocker or major is observed THIS turn by a command/test run or a file:line read. A cited path alone is not proof; an inferred consequence is a note/suggestion, never a blocker. Rust needs cargo check output. May run tests as evidence. The curated money/data set is the CI and pre-deploy gate. Performance measurement and visual evaluation remain allowed. No edits.',
  // Worded as a correctness review: codex refused "bug hunt ... crash the daemon" twice as a cybersecurity risk (2026-09-23).
  bughunter: 'CORRECTNESS REVIEW of existing code (not a diff): find where the subsystem the lead names computes a wrong result or fails, in your own worktree. A defect finding is observed THIS turn by a command/test run or a file:line read. A cited path alone is not proof; an inferred consequence is a note/suggestion, never a blocker. May run tests as evidence. The curated money/data set is the CI and pre-deploy gate. Performance measurement and visual evaluation remain allowed. Do not fix anything.',
  // Operator #19466. Report extras (test0/test3, defects[]) are a later slice; the seat still needs a contract.
  tester: 'PROVE behaviour with tests in your own branch worktree. Write and run tests; a new or changed test passes the test-audit authoring gate; run the narrowest test that covers the change. Never change existing assertions unless the brief allows it and names the change that made them stale (operator #14245). Never commit, never write to memory, never create other agents.',
};

const DUTY: Record<ContractRole, string> = {
  scout: 'Nothing edited.',
  critic: 'Nothing edited. Each finding: one sentence, its file:line, a confidence rating.',
  researcher: 'URL and date per claim.',
  debater: 'Two positions; the lead decides and says why.',
  coder: 'Report changed files and each check with the tail of its output, including what did not pass. A done report ties every acceptance criterion of the brief to the check command that would fail without it (check: null with a reason when nothing runnable exists). Do not commit.',
  reviewer: 'Every blocker and major needs an observation THIS turn (command/test run or file:line read); inferred consequences are suggestions. Do not edit files.',
  bughunter: 'Every blocker and major carries its observation THIS turn (command/test run or file:line read); inferred consequences are suggestions. Do not edit tracked files; a reproducing test or command goes in forLead as text.',
  tester: 'Report what you ran and what it showed. Do not commit.',
};

const BANS = 'Do NOT write to memory (memoryctl append/handoff/task or the MCP memory tool): your final message is your delivery, orch keeps it and hands the lead only its JSON; put anything worth remembering in forLead. '
  + 'Do NOT commission work from another model by any route other than your own scout_request tool, if you have it (no orch seat_* tool, no Paseo, no subagent of your own runtime): the lead commissions every review; if your change needs a second opinion, say what to check in forLead. '
  // Decision #12892: a seat's filesystem-wide search ran for hours and starved its host.
  + 'Do NOT search the whole filesystem (/, ~, a drive root): search your worktree and the install directories the brief names. '
  // Decision #12674: GUI runs on the operator\'s screen switched their windows and cost them time.
  + 'A GUI probe or screenshot runs offscreen (QT_QPA_PLATFORM=offscreen); a window on the operator\'s screen needs the lead\'s explicit leave in the brief.';

/** A round-table member's added duty (operator #19423): pick one option, vote, and let the majority decide. */
const TABLE_NOTE = 'Pick one option; at round 2 change your vote only by naming the other member\'s new evidence in changedBy; the table\'s majority decides; the lead is chairman: records it, overrides only with a reproduced fact and says why, breaks a tie. Name no model, family or seat in your report text: the appendix quotes it verbatim.';

// A scout audit on 2026-09-24 reported the lesson brevity gate as a defect and the
// lead asked the operator to loosen it, although decision #10820 prescribed it.
const DECISIONS = 'A gate, limit, refusal or policy that a live operator decision prescribes is by design, not a defect: before you call one a defect, search memory for its decision and cite the id (memory off: say in forLead that it is unchecked).';

/** Fraction of the turn limit at which the seat must already have delivered its report. */
export const DEADLINE_FRACTION = 0.8;

/** Delay before the one mid-turn "report now" steer. Zero when the turn has no limit. */
export function deadlineDelayMs(timeoutMs: number): number {
  if (!(timeoutMs > 0)) return 0;
  return Math.floor(timeoutMs * DEADLINE_FRACTION);
}

function budgetLabel(ms: number): string {
  if (!(ms > 0)) return '0 ms';
  if (ms % 60_000 === 0) return `${ms / 60_000} minutes`;
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return seconds ? `${minutes} minutes ${seconds} seconds` : `${minutes} minutes`;
  }
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} seconds`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} seconds`;
  return `${ms} ms`;
}

/** What the role context tells the seat: the real limit, and a partial report by ~80% of it. */
export function deadlineNote(timeoutMs: number): string {
  const wholeMinutes = timeoutMs > 0 && timeoutMs % 60_000 === 0 ? timeoutMs / 60_000 : null;
  const named = wholeMinutes === null ? `this turn's limit is ${budgetLabel(timeoutMs)}` : `timeout_minutes=${wholeMinutes}`;
  return `Deadline: ${named}. This turn is killed after ${budgetLabel(timeoutMs)}, and a timed-out turn is not done. By ${budgetLabel(deadlineDelayMs(timeoutMs))} (~80% of the limit), stop and deliver your JSON report; if the work is unfinished, status is "partial" and notChecked lists what remains. Do not keep working past that.`;
}

/** One steer, sent while the turn is still running, when the provider can take it. */
export function reportNowMessage(timeoutMs: number): string {
  const left = Math.max(0, timeoutMs - deadlineDelayMs(timeoutMs));
  return `orch: report now. ${budgetLabel(left)} remain before this turn is killed, and a timed-out turn is not done. Stop tool calls. Deliver the JSON report immediately: status "partial" if unfinished, and put what you did not check in notChecked.`;
}

/** Plan 14879 D6: with the rule block in this turn's message, the report's free text follows it. */
const STE_REPORT_LINE = 'The free text of the report follows the `ASD-STE100` rule block; JSON keys, evidence, code, paths and commands stay verbatim.';

/**
 * A role's closing: its duty line, the turn deadline, the report contract and the bans. `lessons`
 * are the ids delivered in full in this turn's context: the contract then asks one lessonsApplied entry for each.
 * `steRule` is the STE rule block this turn's message carries: the closing then binds the report's
 * free text to it. A null block keeps the closing byte-identical to a session with no switch.
 */
export function closing(role: ReportRole, timeoutMs = 30 * 60_000, lessons: readonly string[] = [], steRule: string | null = null, table?: TableContract): string {
  return `${DUTY[contractRole(role)]}${table ? ` ${TABLE_NOTE}` : ''} ${deadlineNote(timeoutMs)} ${DECISIONS} Final delivery to the lead: English.${steRule ? ` ${STE_REPORT_LINE}` : ''} ${reportContract(role, lessons, table)} ${BANS}`;
}

// grok's native run_terminal_command splits on whitespace and passes quotes
// through literally (measured 2026-09-18), so the code-intel rules need its
// workaround. Pi's bash tool has no such caveat. The workarounds name only the
// instruments the seat has (review 2026-09-23: it re-advertised codegraph
// after the retraction section of an arm that had it off).
const NATIVE_SHELL_NOTES: Record<string, (off: readonly string[]) => string> = {
  grok: (off) => {
    const workarounds = [];
    if (!off.includes('codegraph')) workarounds.push('ask a multi-word query through the codegraph MCP tool');
    return '## Your shell (grok)\n\nYour shell splits on whitespace and does not process quotes. Never quote an argument; '
      + (workarounds.length ? `${workarounds.join('; ')}; ` : '')
      + '`node -e` is unrunnable, write the script to a file.';
  },
};

const READ_ONLY: ReadonlySet<ReportRole> = new Set(['scout', 'critic', 'researcher', 'debater']);


/** What a Pi seat has and how it is meant to be used (task 1436, operator 2026-09-23). */
function piInstruments(readOnly: boolean, off: readonly string[], remote: boolean, host?: string): string {
  const lines = ['## Your instruments (Pi)', ''];
  // An instrument the seat turned off (task 1452) is not advertised; the
  // retraction section below names the replacement for what the stock text mentions.
  if (!off.includes('codegraph')) lines.push('- `codegraph_explore` is one of your tools: ask it FIRST for how X works, who calls Y, what a change touches. It returns the source with line numbers, so it replaces a grep-and-read loop. `rg` is for a known literal.');
  else lines.push('- `rg` is for a known literal.');
  if (!off.includes('memory')) lines.push('- `memoryctl_memory` is your memory tool: `hot`, then `search` (ids and titles), then `get <id>` for the whole entry; `lessons` with a file path before you judge or edit that file.');
  lines.push('- rtk is automatic: your bash commands that rtk has a filter for (git, rg, grep, cat, ls, find, tsc, cargo, tests, …) are rewritten to `rtk <cmd>` before they run, so you need not type `rtk`; never use `rtk proxy` or `rtk run` (they filter nothing); for exact bytes, bound the command (`head`, `rg -m`).');
  if (readOnly) {
    const readers = ['rg'];
    if (!off.includes('codegraph')) readers.push('the codegraph CLI (callers, callees, impact, node, explore)');
    if (!off.includes('memory')) readers.push('memoryctl reads');
    readers.push('git log/show/diff/status/grep/blame');
    lines.push(`- Your bash is read-only: ${readers.join(', ')}, and plain readers. A write, a redirection to a file, ` + '`$(…)`' + ' or any other program is refused with the reason.');
    if (remote || host !== undefined) {
      lines.push('- This host cannot read the report of an earlier seat, because the daemon and its dependencies are on a different machine. Put the turn id that you could not read into `notChecked` and continue with the brief.');
    } else {
      const script = fileURLToPath(new URL('./main.ts', import.meta.url)).replaceAll('\\', '/');
      lines.push(`- Read an earlier seat's report with \`node ${quoteShellPath(script, process.platform)} wait <turn>\` (optional \`--json\` last); this is the loaded orch checkout, not your working directory.`);
    }
  } else {
    lines.push('- Build and test through the named checks; their output is filtered by rtk, and a failure keeps its lines.');
  }
  return lines.join('\n');
}

/** The A/B arm's retraction (task 1452): what is off and what carries its load. */
export function instrumentsOffSection(off: readonly string[]): string {
  // ast-grep keeps a retraction bullet here (not a prescription): routed knowledge and
  // skills can still name it, and instrumentBan refuses its calls (review 2026-09-28).
  const bullets = [];
  if (off.includes('codegraph')) bullets.push('- **codegraph** — no `codegraph_explore` tool, no `codegraph` CLI. `rg` answers where text is.');
  if (off.includes('ast-grep')) bullets.push('- **ast-grep** — no `ast-grep`/`sg` CLI. Bound an `rg` pattern instead.');
  if (off.includes('memory')) bullets.push('- **memory** — no `memoryctl_memory` tool, no `memoryctl` CLI. The lessons above are all the durable memory you have.');
  if (!bullets.length) return '';
  return [
    '## Instruments OFF for this seat',
    '',
    'Every routed section of this context — the code-intel rules, the role notes, the knowledge pages and the lesson index — is stock text that does not know your arm. Wherever any of it names an instrument listed below, that instrument is OFF for you. Do not call its tools or CLIs — a Pi seat has those calls refused:',
    ...bullets,
  ].join('\n');
}

const SEAT_PRIME_ITEMS = [1, 3, 4, 5, 6, 9] as const;
// Work contract 3 is left out: its `memoryctl task` step is a memory write, which seats are banned from.
const SEAT_WORK_ITEMS = [2, 6] as const;
const SEAT_PRODUCT_BULLETS = ['ChartPane/subcharts:', '**Modules (task 2409):**', 'Indicator subscription SSOT:', 'Files ≥1500 lines:',
  'Docs:', '`web/` legal copy:', 'MCP/plugins/skills'] as const;
// The commit gate is the lead's step (seats never commit), so the seat copy of the checks drops it.
const SEAT_CHECKS_STRIP = 'npm run check:commit -- <explicit paths>\n';

/** The worker-only slice of the root contract. Missing anchors fail closed rather than yielding a partial contract. */
export function seatContract(): string {
  const contract = readFileSync(new URL('CLAUDE.md', REPO), 'utf8');
  const section = (heading: string): string => {
    const lines = contract.split(/\r?\n/);
    const start = lines.indexOf(`## ${heading}`);
    if (start < 0) throw new Error(`CLAUDE.md: missing ${heading} heading`);
    const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
    const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
    if (!body) throw new Error(`CLAUDE.md: empty ${heading} section`);
    return body;
  };
  const numbered = (heading: string, numbers: readonly number[]): string[] => {
    const lines = section(heading).split('\n');
    return numbers.map((number) => {
      const item = lines.find((line) => line.startsWith(`${number}. `));
      if (!item) throw new Error(`CLAUDE.md: missing ${heading} item ${number}`);
      return item;
    });
  };
  const items = numbered('PRIME — hard invariants', SEAT_PRIME_ITEMS);
  const work = numbered('Work contract', SEAT_WORK_ITEMS);
  const checks = section('Tree and checks');
  if (!checks.includes(SEAT_CHECKS_STRIP)) throw new Error('CLAUDE.md: Tree and checks drifted; expected the check:commit line');
  const product = section('Product and harness sensors').split('\n');
  const bullets = SEAT_PRODUCT_BULLETS.map((label) => {
    const item = product.find((line) => line.startsWith(`- ${label}`));
    if (!item) throw new Error(`CLAUDE.md: missing product bullet ${label}`);
    return item;
  });
  return ['### PRIME — hard invariants', ...items, '### Work contract', ...work, '### Before adding code', section('Before adding code'),
    '### Tree and checks', checks.replace(SEAT_CHECKS_STRIP, ''), '### Product constraints', ...bullets].join('\n\n');
}

export function codeIntelRules(): string {
  const contract = readFileSync(new URL('CLAUDE.md', REPO), 'utf8');
  return ['Code intel', 'Blast radius', 'RTK is mandatory'].map((label) => {
    const line = contract.split(/\r?\n/).find((entry) => entry.startsWith(`- **${label}**`));
    if (!line) throw new Error(`CLAUDE.md: missing ${label} rule`);
    return line;
  }).join('\n');
}

/** An npm-shim CLI: on win32 through ComSpec, never the bare name cmd.exe (a narrowed PATH makes that lookup ENOENT). */
function cliSpawn(name: string, args: string[]): [string, string[]] {
  if (process.platform !== 'win32') return [name, args];
  const comspec = process.env.ComSpec || (process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\cmd.exe` : 'cmd.exe');
  return [comspec, ['/d', '/s', '/c', `${name}.cmd`, ...args]];
}

/** Asynchronous: the daemon's event loop serves every other seat meanwhile. */
function memoryctl(args: string[]): Promise<string> {
  const [file, argv] = cliSpawn('memoryctl', args);
  return new Promise((resolve, reject) => {
    execFile(file, argv, { encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`memoryctl ${args.join(' ')} failed: ${stderr?.trim() || error.message}`));
      else if (!stdout.trim()) reject(new Error(`memoryctl ${args.join(' ')} failed: empty response`));
      else resolve(stdout);
    });
  });
}

/** The code map's share of a seat context (~3k tokens); the cut falls at a file boundary (task 1802a). */
export const CODE_MAP_CHARS = 12_000;
/** A cold index opened in 5.1 s and a warm one in 0.5 s (2026-09-29); the map runs beside the lesson and skill routers. */
const CODE_MAP_TIMEOUT_MS = 6000;

/** The bounded cause a non-zero codegraph exit names from stdout: the CLI prints some failures there (task 2723). */
const CODEGRAPH_ERROR_CHARS = 300;

/** A non-zero codegraph exit as a cause, not a bare code: stderr's last line first, else a bounded tail of stdout's last non-empty line. */
function codegraphExitError(code: number, stderr: string, stdout: string): Error {
  const stderrLine = stderr.trim().split('\n').pop();
  if (stderrLine) return new Error(stderrLine);
  const stdoutLine = stdout.slice(-4096).split('\n').filter((line) => line.trim()).pop();
  return new Error(stdoutLine ? stdoutLine.trim().slice(0, CODEGRAPH_ERROR_CHARS) : `exit ${code}`);
}

/** `codegraph explore` pinned to the seat checkout's own index; `-p` keeps it from resolving another one. */
function codegraphExplore(cwd: string, files: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const [file, argv] = cliSpawn('codegraph', ['explore', '-p', cwd, '--', ...files]);
    // Its own process group, so a timeout kills the codegraph bundle the launcher starts, not only the
    // launcher: a hung bundle outlived execFile's kill with PPID 1 (review of task 1802a).
    const child = spawn(file, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (child.exitCode === null && child.pid) killTree(child.pid);
        reject(error);
      } else resolve(stdout);
    };
    const timer = setTimeout(() => done(new Error(`timed out after ${CODE_MAP_TIMEOUT_MS / 1000} s`)), CODE_MAP_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) done(new Error('output over 16 MB'));
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', done);
    child.on('close', (code) => done(code !== 0 ? codegraphExitError(code, stderr, stdout) : stdout.trim() ? null : new Error('empty output')));
  });
}

// The host checks its own checkout before launching codegraph; a missing index never consults
// either the daemon checkout or a parent directory's index. remote-exec kills the host process
// tree when SSH stdin closes, including a codegraph bundle launched by the npm shim.
const REMOTE_NO_INDEX = '__ORCH_CODE_MAP_NO_INDEX__';
const REMOTE_EXPLORE = `const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
if(!fs.existsSync(path.join(process.cwd(),'.codegraph','codegraph.db')))console.log('${REMOTE_NO_INDEX}');
else import(require('node:url').pathToFileURL(path.join(process.cwd(),'ops','orchestrator','src','providers','spawn.ts')).href).then(({resolveCommand})=>{
  const cmd=resolveCommand('codegraph');
  const child=spawn(cmd.file,[...cmd.args,'explore','-p',process.cwd(),'--',...process.argv.slice(1)],{stdio:'inherit'});
  child.on('error',e=>{console.error(e);process.exitCode=1});
  child.on('close',code=>{process.exitCode=code??1});
}).catch(e=>{console.error(e);process.exitCode=1});`;

function remoteCodegraphExplore(host: string, cwd: string, files: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnProvider>;
    try { child = spawnProvider({ host, cwd, command: 'node', args: ['-e', REMOTE_EXPLORE, '--', ...files] }); }
    catch (error) { reject(error); return; }
    let stdout = '', stderr = '', settled = false;
    const done = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        // EOF makes remote-exec kill the *host* process tree; SSH is killed if it does not exit.
        child.stdin.end();
        const fallback = setTimeout(() => child.kill('SIGKILL'), 500);
        fallback.unref();
        reject(error);
      } else resolve(stdout.trim() === REMOTE_NO_INDEX ? null : stdout);
    };
    const timer = setTimeout(() => done(new Error(`timed out after ${CODE_MAP_TIMEOUT_MS / 1000} s`)), CODE_MAP_TIMEOUT_MS);
    child.stdin.on('error', (error) => done(error));
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) done(new Error('output over 16 MB'));
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', done);
    child.on('close', code => done(code !== 0 ? codegraphExitError(code, stderr, stdout) : stdout.trim() ? null : new Error('empty output')));
  });
}

/** Explore output within `cap` characters, marker included: whole file blocks while they fit. */
function capCodeMap(text: string, cap: number): string {
  // The trailing blockquote tells an MCP caller the source is complete and prices its next calls: false once cut, noise otherwise.
  const footer = text.search(/\n-{3}\n> \*\*/);
  const body = (footer >= 0 ? text.slice(0, footer) : text).trimEnd();
  if (body.length <= cap) return body;
  const starts = [...body.matchAll(/^\*\*`[^`\n]+`\*\*/gm)].map((match) => match.index!);
  const pieces = [0, ...starts].map((start, i, all) => body.slice(start, all[i + 1] ?? body.length)).filter(Boolean);
  const marker = (partial: boolean, hidden: number) => `\n\n[code map cut to fit ${CODE_MAP_CHARS} characters: ${partial ? 'the first file block shown in part, ' : ''}${hidden} of ${starts.length} file block(s) not shown; run codegraph explore on them yourself]`;
  // Room for the longest marker and a closing fence, so the result never passes the cap.
  const room = cap - marker(true, starts.length).length - '```\n'.length;
  let kept = '';
  let shown = 0;
  let partial = false;
  for (const piece of pieces) {
    if (kept.length + piece.length <= room) {
      kept += piece;
      if (piece.startsWith('**`')) shown += 1;
      continue;
    }
    if (!shown) {
      const head = piece.slice(0, Math.max(0, room - kept.length));
      kept += head.slice(0, head.lastIndexOf('\n') + 1);
      partial = piece.startsWith('**`') && head.includes('\n');
    }
    break;
  }
  // A cut inside a fenced block would swallow the marker as code.
  if ((kept.match(/^```/gm) ?? []).length % 2) kept += '```\n';
  return `${kept.trimEnd()}${marker(partial, starts.length - shown - (partial ? 1 : 0))}`;
}

/**
 * The precomputed code map of the brief's files from the seat checkout's OWN index (task 1802a).
 * Never the daemon checkout's index, which may sit on another commit; no index, failure or timeout
 * is one labelled line, never a failed seat. The whole section, heading included, stays within CODE_MAP_CHARS.
 */
export async function codeMapSection(files: string[], cwd: string, explore = codegraphExplore, host?: string,
  remoteExplore = remoteCodegraphExplore): Promise<string> {
  if (!files.length) return 'code map: none (the brief named no files)';
  if (!host && (resolvePath(cwd) === resolvePath(fileURLToPath(REPO)) || !existsSync(join(cwd, '.codegraph', 'codegraph.db')))) return 'code map: none (no index in this checkout)';
  const heading = '## Code map\n\n`codegraph explore` of the brief\'s files, from this checkout\'s index at its base:\n\n';
  try {
    const output = host ? await remoteExplore(host, cwd, files) : await explore(cwd, files);
    return output === null ? 'code map: none (no index in this checkout)' : `${heading}${capCodeMap(output, CODE_MAP_CHARS - heading.length)}`;
  } catch (error) {
    return `code map: none (codegraph ${(error as Error).message.replace(/\s+/g, ' ').slice(0, 200)})`;
  }
}

/** A memory id as lesson-router.mjs names it: a positive integer or a uuid; the tag below carries only these characters. */
export const LESSON_ID = /^(?:[1-9][0-9]*|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;

export type ContextInput = { role: ReportRole; family: string; harness: Harness; brief: string; files: string[]; snapshot?: boolean; timeoutMs?: number; instruments?: Instruments;
  /** The STE rule block (plan 14879 D6), read at each turn: appended once after the closing. Null keeps today's message. */
  steRule?: string | null;
  /** The no-lessons stand arm suppresses injection, not files, knowledge, skills or tools. */
  suppressLessons?: boolean;
  /** Seat checkout root; remote seats cannot read the daemon's local checkout. */
  cwd?: string; remote?: boolean; host?: string;
  /** The model the seat runs (`seatModel`, seats-scope.ts): a delivered skill that requires image input fails the turn when it is false (task 2385). */
  model?: string;
  /** debater round table (operator #19423): the option list the member picks and votes from. */
  options?: string[];
  /** Test seams, same shape as the real collaborators; production never passes them. */
  lookup?: typeof memoryctl; route?: typeof routeSkills; explore?: typeof codegraphExplore; remoteExplore?: typeof remoteCodegraphExplore };

/** Lesson ids a seat context carries: `full` with their bodies, `indexed` as an index row only. Id-less lessons cannot be named and are left out. */
export type LessonDelivery = { full: string[]; indexed: string[] };

const SKILL_MAP = new URL('.agents/domains/_skill-map.json', REPO);

/**
 * The first of these skills whose map entry holds the `requires` token `input:image`, or null
 * (task 2385). An absent or malformed map answers null: it never fails a turn. Not cached — each
 * context build reads the map again, as the create-time check does.
 */
export function imageSkillOf(names: readonly string[], mapPath: string | URL = SKILL_MAP): string | null {
  let map: { skills?: Record<string, { requires?: unknown }> };
  try {
    map = JSON.parse(readFileSync(mapPath, 'utf8'));
  } catch {
    return null;
  }
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return null;
  for (const name of names) {
    const requires = map.skills?.[name]?.requires;
    if (Array.isArray(requires) && requires.includes('input:image')) return name;
  }
  return null;
}

/** A failed lessons lookup means unknown, never an empty lesson set or a failed worker turn. */
export async function lessonSection(files: string[], brief: string, role: ReportRole, lookup = memoryctl): Promise<{ text: string; source: string; reason?: string } & LessonDelivery> {
  const sources = [];
  const warnings: string[] = [];
  for (const file of files) {
    try {
      const envelope = JSON.parse(await lookup(['lessons', '--path', file, '--json']));
      if (!Array.isArray(envelope?.items)) throw new Error('items must be an array');
      sources.push({ file, envelope });
    } catch (error) {
      warnings.push(`Lessons for ${file} unavailable (${(error as Error).message}). Do not treat this as no lessons; retry memoryctl lessons --path ${JSON.stringify(file)} before editing it.`);
    }
  }
  let lessons: Awaited<ReturnType<typeof renderLessonContext>> | null;
  try {
    // The router and its config belong to the daemon checkout, not the seat's older base.
    lessons = sources.length ? await renderLessonContext({ sources, brief, role,
      repoRoot: fileURLToPath(REPO), timeoutMs: SEAT_JEV_TIMEOUT_MS }) : null;
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
    checkConfigHealth();
    return { text: [...warnings, `lessons: unavailable (${reason})`].join('\n\n'), source: 'unavailable',
      reason: 'lesson-router-unavailable', full: [], indexed: [] };
  }
  const ids = (list: unknown) => (Array.isArray(list) ? list : []).filter((id): id is string => typeof id === 'string' && LESSON_ID.test(id));
  return { text: [...warnings, lessons?.text].filter(Boolean).join('\n\n'), source: warnings.length ? 'unavailable' : lessons?.source ?? 'none',
    full: ids(lessons?.selectedIds), indexed: ids(lessons?.indexedIds),
    ...(warnings.length ? { reason: 'memory-unavailable' } : lessons?.reason ? { reason: lessons.reason } : {}) };
}

export async function seatContext({ role, family, harness, brief, files, snapshot = false, timeoutMs = 30 * 60_000, instruments = ALL_ON, suppressLessons = false, steRule = null, cwd = fileURLToPath(REPO), remote = false, host, model, options, lookup = memoryctl, route = routeSkills, explore = codegraphExplore, remoteExplore = remoteCodegraphExplore }: ContextInput): Promise<string> {
  const paths = [...new Set(files)];
  const readOnly = READ_ONLY.has(role);
  const off = instrumentsOff(instruments);
  const table = Array.isArray(options) && options.length ? { options } : undefined;
  // A reading role cannot act on "this file broke this way before": no lesson bodies for it.
  const lessonFiles = readOnly || suppressLessons ? [] : paths;
  // Started now so its latency overlaps the lesson and skill routers. A reading role gets no map.
  const codeMap = readOnly ? null : codeMapSection(paths, cwd, explore, host, remoteExplore);
  const sections = [
    `<!-- orch-seat-context v2 role=${role} family=${family} harness=${harness} files=${paths.length} lessons=${lessonFiles.length} -->`,
    `Role (${role}): ${ROLE_NOTES[contractRole(role)]}${table ? ` ${TABLE_NOTE}` : ''}`,
  ];
  if (!readOnly) sections.push('A git worktree you add for comparison is removed with `git worktree remove --force <path>` before your report.');
  const missingServers = host === undefined ? [] : remotePiMissingServers(role);
  if (missingServers.length) {
    sections.push(`This host has no MCP server ${missingServers.join(', ')}. For production data, tell the lead to use a seat on the Mac.`);
  }
  // The seats that get scout_request (scout-tool.ts): Pi through its extension, the claude CLI (claude, glm) through its MCP config.
  if (SCOUT_CALLERS.includes(role) && (harness === 'pi' || family === 'claude' || family === 'glm')) {
    sections.push(`Scouts: when a sweep spans 3+ files, logs or memory, call your scout_request tool {question, files?} instead of reading them yourself; it returns a read-only scout's digest (one at a time per seat, question at most ${MAX_QUESTION_WORDS} words).`);
  }
  if (snapshot) sections.push('## Your checkout\n\nThis worktree is the lead\'s working tree as one commit on top of its HEAD: the change you are given is exactly `git diff HEAD^`, uncommitted and new files included.');
  let knowledgeRouter = 'none';
  if (paths.length) {
    if (readOnly) sections.push(`## Files that matter\n\n${paths.map((file) => `- ${file}`).join('\n')}`);
    const routing = JSON.parse(readFileSync(new URL('docs/agent/domain-routing.generated.json', REPO), 'utf8'));
    const pageFor = (domain: string) => readKnowledgePage(domain, (path: string) => {
      try {
        return readFileSync(new URL(path, REPO), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    });
    // The map render decides the sections, never Jev (operator decision #12450), so the tag's knowledgeReason is always none.
    const knowledge = routeKnowledgeSections({ files: paths, map: routing, pageFor });
    knowledgeRouter = knowledge.source;
    sections.push(...knowledge.sections);
  } else {
    sections.push('## Knowledge: none delivered\n\nThe brief named no files, so no knowledge page was delivered. The pages are `.agents/domains/domain-<name>/knowledge.md`, one per domain: read the one covering your subject BEFORE forming a hypothesis.');
  }
  const modules = renderModulesSection(fileURLToPath(REPO), paths);
  if (modules) sections.push(modules);
  // Who chose lessons and skills: Jev, cache, or a fallback (with its reason on the board).
  let lessonRouter = 'none';
  let lessonReason = suppressLessons ? 'stand-no-lessons' : 'none';
  const delivered: LessonDelivery = { full: [], indexed: [] };
  if (lessonFiles.length) {
    const lessons = await lessonSection(lessonFiles, brief, role, lookup);
    lessonRouter = lessons.source;
    lessonReason = lessons.reason ?? 'none';
    delivered.full = lessons.full;
    delivered.indexed = lessons.indexed;
    sections.push(lessons.text);
  }
  if (codeMap) sections.push(await codeMap);
  // A native CLI (claude, glm) loads the project CLAUDE.md itself; sending the slice again would only duplicate it.
  if (harness !== 'native') sections.push(`## Seat contract\n\n${seatContract()}`);
  sections.push(`## Code intel\n\n${codeIntelRules()}`);
  if (off.length) sections.push(instrumentsOffSection(off));
  if (harness === 'native' && NATIVE_SHELL_NOTES[family]) sections.push(NATIVE_SHELL_NOTES[family](off));
  if (harness === 'pi') sections.push(piInstruments(readOnly, off, remote, host));
  // The role's own skills (the skill map's roleDefaults) are part of the brief, inlined: a seat that
  // was only told to read one often did not (task 1436). The routed rest are listed with their path,
  // and the board lights each one the seat reads.
  let routed: Awaited<ReturnType<typeof routeSkills>>;
  try {
    // The imported router defaults to its own (daemon) checkout, never cwd.
    routed = await route({ role, files: paths, brief, timeoutMs: SEAT_JEV_TIMEOUT_MS });
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
    checkConfigHealth();
    sections.push(`skills: unavailable (${reason})`);
    routed = { skills: [], source: 'unavailable', model: null, reason: 'skill-router-unavailable' };
  }
  const { skills, source, model: skillModel, reason: skillReason = 'none', added: addedSkills = [] } = routed;
  const skillRouter = source === 'map' && !skills.length ? 'none' : source;
  const required: string[] = (JSON.parse(readFileSync(new URL('.agents/domains/_skill-map.json', REPO), 'utf8')).roleDefaults?.[role] ?? [])
    .filter((name: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name));
  // Task 2385 I1c-2: routing has answered, so the skills this seat really gets are known — the role
  // defaults above and the routed list. One of them requiring image input against a model with
  // none (the create-time pick could not know the brief routes such a skill) fails the turn here,
  // before the provider is prompted. A model the table does not hold, or no model answer, is
  // unknown and passes; the map check itself never fails (absent or malformed reads as no skill).
  const imageSkill = imageSkillOf([...required, ...skills.map(({ name }: { name: string }) => name)]);
  if (imageSkill && model !== undefined && imageInput(model) === false) {
    throw new Error(`images: skill ${imageSkill} requires image input, and model ${model} has none. Close this seat and create one with images: true`);
  }
  for (const name of required) {
    const body = readFileSync(new URL(`.agents/skills/${name}/SKILL.md`, REPO), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    sections.push(`## Required skill: ${name}\n\nThis is part of your brief; follow it for the whole task.\n\n${body}`);
  }
  // Names the board's tag can carry (seats.ts reads it back with the same character class).
  const listed = skills.filter(({ name }: { name: string }) => !required.includes(name) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name));
  if (listed.length) {
    const skillPath = (name: string) => {
      const relative = `.agents/skills/${name}/SKILL.md`;
      return remote || host !== undefined || existsSync(join(cwd, relative)) ? relative : fileURLToPath(new URL(relative, REPO));
    };
    const skillIntro = "Relative paths below are relative to the working directory (the seat's checkout root).";
    sections.push(`## Skills for this seat\n\n${skillIntro}\n${listed.map(({ name, description }: { name: string; description: string }) => `- ${name}: ${description} — read \`${skillPath(name)}\` before the part of the task it covers`).join('\n')}`);
  }
  sections[0] += `\n<!-- orch-skills required=${required.join(',')} listed=${listed.map(({ name }: { name: string }) => name).join(',')} router=${skillRouter} lessons=${lessonRouter} knowledge=${knowledgeRouter} skillReason=${skillReason} lessonReason=${lessonReason} knowledgeReason=none model=${typeof skillModel === 'string' && /^[a-zA-Z0-9._-]+$/.test(skillModel) ? skillModel : 'null'}${addedSkills.length ? ` added=${addedSkills.filter((name: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)).join(',')}` : ''} -->`;
  // Which lessons this context delivered (seats.ts logs them per turn and holds the report to the full ones).
  sections[0] += `\n<!-- orch-lessons full=${delivered.full.join(',')} indexed=${delivered.indexed.join(',')} -->`;
  sections.push(`<!-- brief:start -->${brief}<!-- brief:end -->`, closing(role, timeoutMs, delivered.full, steRule, table));
  // The STE rule block (plan 14879 D6), appended once; a null block adds no line at all.
  if (steRule) sections.push(steRule);
  return `${sections.join('\n\n')}\n`;
}
