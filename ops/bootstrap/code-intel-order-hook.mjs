#!/usr/bin/env node
// PreToolUse ordering rule, one per session: the FIRST read/search of
// TypeScript source must go to the code search, not to grep. Once any search
// call has happened in the session, this hook is silent forever.
//
// WHAT COUNTS AS THE OPENER MOVES WITH THE TOOL. It named the retired indexed
// tool until 2026-08-13, and on the day that tool was removed this gate would
// have denied every TypeScript read on the machine while demanding a program
// nobody has -
// which is exactly the dead end the Rust half of this file already describes.
// A gate and the tool it names are one change, never two.
//
// Rust IS gated, since 2026-08-14. It was not, and the reason was good until it
// expired: the gate named Serena, Serena was removed (2026-07-30), and a gate
// that names a tool nobody has is a dead end rather than a gate. What stands in
// its place answers Rust as well as TypeScript - `codegraph` carries the call
// graph of the whole tree, kept fresh by a watcher, and `ast-grep` answers the SHAPE questions
// (every trait impl, every call of X) that a text search cannot. The reason for
// the exemption is gone, so the exemption goes with it.
//
// Measured 2026-08-14 in a lead session the operator was reading over: about
// twenty greps over `.rs` and ZERO probe calls, with the trigger map sitting in
// that session's context the whole time. The lead was not bypassing this hook -
// there was nothing here to bypass. Prose does not order; naming the opener AT
// THE MOMENT of the action does, and it now names one for Rust too.
//
// Revived from the rolled-back gate (memory #254) as a single narrow rule:
// measured 2026-07-28 across five live sessions — 26-41 Rust edits and 7-38
// greps over .rs each, ZERO code-intelligence calls, while the trigger map sat
// in their context.
//
// It ordered by REFUSING until 2026-08-21, and the operator made it warn-only on
// the cost: a denied command is re-issued, not answered, so the ordering rule was
// paid for with a whole model turn on a session's first grep. The verdict is
// unchanged and every spelling it learned is still caught - what it emits is a
// PreToolUse hint, once per session. The reasoning is at the emit site.
//
//   node code-intel-order-hook.mjs <claude|codex|zcode|kimi|grok>
//
// Fail-open everywhere except the commit gate: parse failure, missing session
// id, unknown tool -> allow. A commit-bearing command is judged even then
// (task 1847).

import { existsSync, mkdirSync, writeFileSync, writeSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// Task 611: the shell scanning below was hand-written here and quote-blind at
// two levels. These two are the rtk hook's scanner, already in this tree and
// already exercised by its own suite - a second hand-rolled parse of the same
// grammar beside it is the defect, not the spelling of any one split.
import { splitTopLevel, splitWords } from './rtk-rewrite-lib.mjs';
import { codeIntelMark, indexFor } from './code-intel-order-lib.mjs';
import { projectConfig, PROJECT_DEFAULTS } from '../../scripts/lib/harness-config.mjs';

const MODE = process.argv[2] || 'claude';
const allow = () => process.exit(0);

// Task 1847: the read-order rule may fail open, the commit gate may not. An
// event that does not parse into an object has no command to shape-check, so
// raw text naming git and commit anywhere (any case, escapes and all) is
// refused; an event without a session id still goes through the full gate.
let raw = '';
let event = null;
try {
  raw = readFileSync(0, 'utf8');
  event = JSON.parse(raw);
} catch {
  /* judged below */
}
if (event === null || typeof event !== 'object' || Array.isArray(event)) {
  if (namesBypass(raw)) denyCommit();
  allow();
}

const toolName = String(event.tool_name ?? event.toolName ?? '');
const input = (event.tool_input ?? event.toolInput) ?? {};
const command = typeof input.command === 'string' ? input.command : '';
const sessionId = String(event.session_id ?? event.sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
if (!sessionId) {
  commitGate(command);
  allow();
}

// The mark path and indexFor live in code-intel-order-lib.mjs: the sibling
// domain-lessons-hook reads the same rule to hold back a page on a refused Read.
const mark = codeIntelMark(sessionId);
const stateDir = dirname(mark);

// PER-CALL hints, added 2026-09-11. The session-order rule above is spent after
// one search, and the numbers say that was the wrong unit: over 152 lead
// sessions (2026-08-16..09-10) the lead issued 8783 sed and 4234 cat calls
// against 161 probe and 14 ast-grep calls, and 4982 ssh calls against 442 calls
// of the production MCP that project policy puts before SSH. One search opened the
// session and every later numbered-range read of a source file was free.
// These two hints name a cheaper instrument AT THE CALL that wastes, and they
// do not refuse (a refusal costs a turn - operator decision 2026-08-21). Each
// kind is repeated at most once per HINT_INTERVAL_MS per session, so a session
// of forty sed ranges pays for three hints, not forty.
const HINT_INTERVAL_MS = 15 * 60 * 1000;
const hintMark = `${mark}.hints.json`;
const SOURCE_FILE = /\.(rs|ts|tsx|mjs|js|py)$/i;
let project = PROJECT_DEFAULTS;
try { project = projectConfig(); } catch { /* optional advice stays fail-open; commit checks still run */ }
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SERVER_HOST = new RegExp(`^(?:[^@\\s]+@)?(?:${project.productionHosts.length ? project.productionHosts.map(escapePattern).join('|') : '(?!)'})(?:-ro)?$`, 'i');
const extraDiagnostics = project.diagnosticCommands.map(escapePattern);
const SERVER_DIAGNOSTIC = new RegExp(`\\b(docker\\s+(logs|ps|stats|inspect)|df|free|uptime|journalctl|iostat|vmstat${extraDiagnostics.length ? `|${extraDiagnostics.join('|')}` : ''})\\b|curl\\b[^|;]*/health`);
const SSH_VALUE_FLAGS = new Set(['-i', '-p', '-o', '-l', '-F', '-J', '-b', '-c', '-E', '-L', '-R', '-D', '-W']);
const SED_RANGE_MIN_LINES = 60;

function wasteHint(commandText) {
  if (!commandText) return null;
  for (const { part } of splitTopLevel(commandText, ['&&', '||', '|', ';'])) {
    let words = splitWords(part).map((word) => word.replace(/^["']+|["']+$/g, ''));
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
    // `bypass` is 1.0.1's canonical name for `proxy` (silent alias): both peel.
    if (words[0] === 'rtk') words = words.slice(words[1] === 'proxy' || words[1] === 'bypass' ? 2 : 1);
    if (!words.length) continue;
    const program = words[0].split('/').pop().toLowerCase();
    const operands = words.slice(1);
    if (program === 'sed' && operands.includes('-n')) {
      const range = operands.map((word) => /^(\d+),(\d+)p$/.exec(word)).find(Boolean);
      const file = operands.find((word) => SOURCE_FILE.test(word));
      if (range && file && Number(range[2]) - Number(range[1]) + 1 >= SED_RANGE_MIN_LINES) {
        return {
          kind: 'sed-range',
          text: `\`sed -n ${range[1]},${range[2]}p ${file}\` reads ${Number(range[2]) - Number(range[1]) + 1} lines by number. ` +
            `For a symbol, \`codegraph node <symbol>\` returns its source plus callers and callees; ` +
            'for an unknown location, `codegraph explore \'<english query>\'` (lesson 7652).',
        };
      }
    }
    if (program === 'cat') {
      const file = operands.find((word) => SOURCE_FILE.test(word));
      if (file) {
        return {
          kind: 'cat-source',
          text: `\`cat ${file}\` puts the whole file in context. \`codegraph node <symbol>\` returns one symbol; ` +
            'the Read tool takes offset/limit (lesson 7652).',
        };
      }
    }
    if (program === 'ssh') {
      let at = 0;
      while (at < operands.length && operands[at].startsWith('-')) at += SSH_VALUE_FLAGS.has(operands[at]) ? 2 : 1;
      const host = operands[at];
      if (project.productionMcp && host && SERVER_HOST.test(host) && SERVER_DIAGNOSTIC.test(operands.slice(at + 1).join(' '))) {
        return {
          kind: 'ssh-diagnostic',
          text: `Server status, logs and metrics come from the ${project.productionMcp} MCP before SSH (CLAUDE.md): ` +
            (project.productionTools.length ? `mcp__${project.productionMcp}__${project.productionTools.join(', ')}. ` : '') +
            'SSH is for what those tools do not answer.',
        };
      }
    }
  }
  return null;
}

// The scout hint, same day (operator: "да, делай подсказку"). An orch scout
// seat runs a read-only sweep on the quota of the family orch picks (decision
// #12069: scouts run only as orch seats); an Explore or general-purpose
// subagent runs the same sweep on the operator's Claude limit, and only a
// CLAUDE.md line pointed from one to the other - the prose that did not move
// the lead from sed to probe either. Named at the call, like the hints above.
// Inside THIS repository only: orch provisions a scout seat from this
// repository, and a scout is never pointed at a foreign tree.
const SUBAGENT_TOOL = /^(Agent|Task)$/;
const EXPLORER_AGENTS = new Set(['', 'explore', 'general-purpose', 'code-scout']);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function insideRepo(cwd) {
  try {
    const root = realpathSync(REPO_ROOT);
    const at = realpathSync(String(cwd));
    return at === root || at.startsWith(root + sep);
  } catch {
    return false;
  }
}

const SCOUT_ADVICE = 'A sweep of 3+ files, another branch, logs, transcripts or memory goes to an orch scout seat ' +
  '(`seat_create` role scout, one question) - orch picks the family and the seat reports with exact references.';

function subagentHint(name, toolInput, cwd) {
  if (!SUBAGENT_TOOL.test(name)) return null;
  if (!EXPLORER_AGENTS.has(String(toolInput.subagent_type ?? '').toLowerCase())) return null;
  if (!cwd || !insideRepo(cwd)) return null;
  return {
    kind: 'subagent-scout',
    text: `This subagent explores on the operator's Claude quota. ${SCOUT_ADVICE} A subagent is for work that edits, builds or runs.`,
  };
}

// The same sweep done by hand. Measured 2026-09-11 in the first Fable lead
// session after the scout shipped: no subagent at all, and calls 7-19 walked a
// feature branch with `git grep` (up to five in one command) and
// `git show <rev>:<file>` (up to four) - the scout was used only after the
// operator asked why not. Two such reads in ONE command is the sweep shape; a
// single `git show` of one file is a point read and stays quiet.
const REVISION_SOURCE = /^[^:\s]+:\S*\.(rs|ts|tsx|mjs|js|py)$/i;

function gitSweepHint(commandText, cwd) {
  if (!commandText || !cwd || !insideRepo(cwd)) return null;
  let reads = 0;
  for (const { part } of splitTopLevel(commandText, ['&&', '||', '|', ';'])) {
    let words = splitWords(part).map((word) => word.replace(/^["']+|["']+$/g, ''));
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
    if (words[0] === 'rtk') words = words.slice(words[1] === 'proxy' || words[1] === 'bypass' ? 2 : 1);
    if (words[0]?.split('/').pop() !== 'git') continue;
    let operands = words.slice(1);
    // git's own options before the subcommand: `-C <dir>` and `-c k=v` take a value.
    while (operands.length && operands[0].startsWith('-')) operands = operands.slice(['-C', '-c'].includes(operands[0]) ? 2 : 1);
    if (operands[0] === 'grep') reads += 1;
    if (operands[0] === 'show') reads += operands.slice(1).filter((word) => REVISION_SOURCE.test(word)).length;
  }
  if (reads < 2) return null;
  return {
    kind: 'git-sweep',
    text: `This command reads another revision file by file (\`git grep\`, \`git show <rev>:<file>\`) - that is a sweep. ${SCOUT_ADVICE}`,
  };
}

function dueHint(hint) {
  if (!hint) return null;
  try {
    const seen = JSON.parse(readFileSync(hintMark, 'utf8'));
    if (Date.now() - Number(seen[hint.kind] ?? 0) < HINT_INTERVAL_MS) return null;
  } catch {
    // no record yet, or an unreadable one: the hint is due
  }
  return hint;
}

function recordHint(hint) {
  let seen = {};
  try {
    seen = JSON.parse(readFileSync(hintMark, 'utf8'));
  } catch {
    seen = {};
  }
  seen[hint.kind] = Date.now();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(hintMark, JSON.stringify(seen));
}

// grok reads no context channel from a hook (see the emit site below).
const perCallHint = MODE === 'grok'
  ? null
  : dueHint(
    wasteHint(typeof input.command === 'string' ? input.command : '') ??
      gitSweepHint(typeof input.command === 'string' ? input.command : '', event.cwd) ??
      subagentHint(toolName, input, event.cwd),
  );

/// Deliver a PreToolUse context line. `onDelivered` runs only when the write
/// reached the reader: a write to a destroyed pipe does not throw, and a mark
/// written for a hint nobody received spends it (see the emit site below).
function deliver(text, onDelivered) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }),
    (error) => {
      if (!error) {
        try {
          onDelivered();
        } catch {
          /* recording is best-effort: at worst the hint arrives twice */
        }
      }
      process.exit(0);
    },
  );
  // Nothing after a delivery may run: the module would go on to the next
  // verdict and write a second answer. The write callback ends the process.
  return new Promise(() => {});
}

const allowOrHint = () => (perCallHint ? deliver(perCallHint.text, () => recordHint(perCallHint)) : allow());

// Any code-search tool call satisfies the order, in every provider's spelling:
// mcp__codegraph__codegraph_explore, codegraph_explore — and Codex, which spells
// MCP tools by BARE name with no server prefix at all. `ast-grep` has no MCP
// server; its CLI form is caught below with codegraph's.
//
// BOTH bare names, because the codex matcher admits both. `extract_code` was put
// in that matcher so the release branch would RECEIVE it, and then this regex did
// not recognise it - so a codex lead that opened with an extract answered the
// refusal correctly and was denied again for the rest of its session. Found
// independently by the codex and glm seats of harness-code-intel-review-r1.
const SEARCH_TOOL = /(^|_)(codegraph|ast[_-]?grep)(_|$)|^(codegraph_explore|search_code|extract_code)$/i;
if (SEARCH_TOOL.test(toolName)) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(mark, String(Date.now()));
  } catch {
    /* recording is best-effort */
  }
  allow();
}

// Both shell gates judge the program after the same wrapper chain. Keep this
// peel shared: the read-order rule already knows rtk, env, paths and .exe names.
function unquote(word) { return word.replace(/^["']+|["']+$/g, ''); }
function normalize(word) {
  return unquote(word).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|com|ps1)$/, '');
}
function peelProgram(words, { shell = false, onAssignment = () => {} } = {}) {
  // Function-local so the fail-closed gate can also run before session setup.
  const WRAPPERS = new Set(['rtk', 'proxy', 'bypass', 'npx', 'npm', 'pnpm', 'bunx', '&', 'env', 'command', 'exec', 'builtin', 'time', 'nice', 'nohup', 'xargs', 'timeout', 'stdbuf']);
  const VALUE_FLAGS = {
    // env's -S/--split-string is NOT here: its "value" is the whole nested
    // command, handled below like `bash -c`'s payload, not eaten as a flag.
    env: new Set(['-u', '--unset']),
    exec: new Set(['-a']), nice: new Set(['-n', '--adjustment']),
    time: new Set(['-f', '-o', '--format', '--output']),
    xargs: new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars']),
    timeout: new Set(['-k', '-s', '--kill-after', '--signal']),
    stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  };
  const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
  const WRAPPER_VERBS = new Set(['exec', 'dlx', 'run']);
  const SHELL_WRAPPERS = new Set(['powershell', 'pwsh', 'cmd', 'sh', 'bash', 'zsh']);
  const SHELL_COMMAND_FLAGS = new Set(['-command', '-c', '/c', '/k', '-lc', '-lic', '-ic']);
  let rest = words;
  const COMPOUND = new Set(['(', ')', '{', '}', '!', 'then', 'do', 'else', 'elif', 'while', 'until', 'if', 'case', 'in', 'esac']);
  const isName = (word) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(word);
  while (rest.length) {
    // `function name` and `function name()` are headers, like `name()`. The
    // `{` that follows is a compound keyword, so the body is the command.
    if (shell && rest[0] === 'function' && isName(rest[1])) {
      rest = rest.slice(2);
      if (rest[0] === '(' && rest[1] === ')') rest = rest.slice(2);
      continue;
    }
    // `case WORD in` is a header: exactly one shell word, then the `in`
    // keyword, then the first arm's pattern (peeled below on the next pass).
    // It must go HERE: `case` is also a bare compound keyword, and peeling
    // only that would leave WORD in the program slot and the arm's command
    // unjudged. `for NAME in …` keeps `for` as the program, so its word list
    // is never judged as a command; a leading `in`/`esac` stays a plain
    // compound keyword, and either word as an operand stays an operand.
    if (shell && rest[0] === 'case' && rest[2] === 'in') {
      rest = rest.slice(3);
      continue;
    }
    // A case arm starts a segment after `in` / `;;`: `pat)`, `(pat)`, or the
    // right half of `a|b)`. A pattern may LEAD with a dash (`--force)`,
    // `-y)`, `(-y)`): an option-like word, not a flag of the arm's command -
    // in command position a `)` word can only be a pattern close. One word
    // inside `( )` is a pattern; a subshell `(git commit …)` has more, so
    // the compound peel still judges it.
    if (shell && rest[0] === '(' && rest[2] === ')' && rest[1] && !/^[()]/.test(rest[1])) {
      rest = rest.slice(3);
      continue;
    }
    if (shell && rest[1] === ')' && rest[0] && rest[0] !== '(') {
      rest = rest.slice(2);
      continue;
    }
    // name() is `name ( )` after splitWords detaches the operators. Peel the
    // header and any following compound keyword so the body is the command.
    if (shell && isName(rest[0]) && rest[1] === '(' && rest[2] === ')') {
      rest = rest.slice(3);
      continue;
    }
    if (shell && /^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(rest[0])) {
      rest = rest.slice(1);
      continue;
    }
    if (shell && COMPOUND.has(rest[0])) {
      rest = rest.slice(1);
      continue;
    }
    if (ASSIGNMENT.test(rest[0])) {
      onAssignment(rest[0]);
      rest = rest.slice(1);
      continue;
    }
    break;
  }
  if (!rest.length) return { program: '', operands: [], viaRouter: false, npmRun: false };
  let program = normalize(rest[0]);
  let operands = rest.slice(1);
  const viaRouter = program === 'rtk';
  let npmRun = false;
  // Each wrapper consumes its own switches, assignments and verb; shell
  // command flags expose an already-quoted nested payload to the same scanner.
  let peeled = 0;
  while (operands.length && peeled < rest.length) {
    peeled += 1;
    if (program === 'eval') {
      const nestedCommand = operands.filter((word, i) => i !== 0 || word !== '--').join(' ');
      if (shell) return { nestedCommand };
      const nested = splitWords(nestedCommand);
      if (!nested.length) break;
      program = normalize(nested[0]);
      operands = nested.slice(1);
      continue;
    }
    if (program === 'command' && /^-[vV]$/.test(operands[0])) break;
    if (WRAPPERS.has(program)) {
      // `env -S "cmd args"` carries the command INSIDE its string, exactly
      // like `bash -c`; treating the string as a flag value swallowed the
      // command and hid its bypass (task 2665 third correction).
      const envSplit = (word) => {
        if (program !== 'env' || !word) return null;
        if (word === '-S' || word === '--split-string') {
          return operands[1] === undefined ? { missing: true } : { payload: operands[1], rest: operands.slice(2) };
        }
        // Attached -Sstring and --split-string=string. The commit gate rebuilds
        // the command env runs: split payload plus every following argument.
        if (!shell) return null;
        if (word.startsWith('--split-string=')) {
          return { payload: word.slice('--split-string='.length), rest: operands.slice(1) };
        }
        if (word.startsWith('-S') && word.length > 2) return { payload: word.slice(2), rest: operands.slice(1) };
        return null;
      };
      while (
        operands.length &&
        !envSplit(operands[0]) &&
        (operands[0].startsWith('-') ||
          ASSIGNMENT.test(operands[0]) ||
          WRAPPER_VERBS.has(operands[0].toLowerCase()))
      ) {
        if (ASSIGNMENT.test(operands[0])) onAssignment(operands[0]);
        if (program === 'npm' && operands[0].toLowerCase() === 'run') npmRun = true;
        const takesValue = VALUE_FLAGS[program]?.has(operands[0]);
        operands = operands.slice(takesValue ? 2 : 1);
      }
      const split = envSplit(operands[0] ?? '');
      if (split) {
        if (split.missing) break;
        const nestedCommand = [split.payload, ...split.rest].join(' ');
        if (shell) return { nestedCommand };
        const nested = splitWords(split.payload);
        if (!nested.length) break;
        operands = [...nested.slice(1), ...split.rest];
        program = normalize(nested[0]);
        continue;
      }
      // `timeout` takes one DURATION positional before the command it runs.
      if (program === 'timeout' && operands.length && !operands[0].startsWith('-')) operands = operands.slice(1);
      if (!operands.length) break;
      program = normalize(operands[0]);
      operands = operands.slice(1);
      continue;
    }
    if (SHELL_WRAPPERS.has(program)) {
      const at = operands.findIndex((word) => SHELL_COMMAND_FLAGS.has(word.toLowerCase()));
      if (at === -1) break;
      operands = operands.slice(at + 1);
      if (!operands.length) break;
      if (shell) return { nestedCommand: operands[0] };
      const nested = splitWords(operands[0]);
      if (!nested.length) break;
      program = normalize(nested[0]);
      operands = [...nested.slice(1), ...operands.slice(1)];
      continue;
    }
    break;
  }
  return { program, operands, viaRouter, npmRun };
}

// COMMIT GATE, task 2665 slice 2 (operator decision #18503). Slice 1 moved the
// proof of check:commit into git itself: on exit 0 check-commit.mjs stamps the
// tree it passed and .githooks/pre-commit refuses an unstamped tree, so the
// exact-shape allowlist this gate enforced (task 1833b, decision #12868) is
// spent, and with it the shell grammar five review rounds (tasks 1787, 1833)
// kept proving wrong. What remains is the one thing the stamp cannot see: Bash
// TEXT that bypasses git's own hooks. A commit-bearing command is refused when
// it carries one hook bypass - `--no-verify` or `-n` on the commit,
// `SKIP_GIT_GUARD`, `core.hooksPath`, `git commit-tree`, `git update-ref` -
// and every other text naming git and commit passes: `git add`, a log grep, a
// message file, `npm run check:commit -- <paths> && git commit ...`.
//
// This gate is per CALL, not per session, and runs before the session mark
// below, so an opened session is still gated. A commit that passes falls
// through to the read-order rule: a commit message that mentions codegraph
// must not release the session.
//
// A declaration, not inline code: the no-session path above calls it before
// the session state exists (task 1847). Task 1970's `/usr/bin/git` rule is
// kept for the DENY: the detection word `git` matches inside the absolute
// path, so a bypass written `/usr/bin/git commit --no-verify` denies.
// Task 2126: enter a worktree to edit and commit its files, then call
// ExitWorktree {action: "keep"} before any git outside it (worktree and branch
// stay). Land yourself with git -C <main checkout> merge --ff-only <sha>, then
// git -C <main checkout> push origin master; do not ask the operator to fast-forward.
// A protected config key named inside FREE TEXT (env values, unparsable
// commands): the unanchored twin of the anchored protectedKey() test, so a
// comment value like "sets core.hooksPath" is not a key and is not matched.
const PROTECTED_KEY_WORD = /(?:^|[^A-Za-z0-9_.-])(?:core\.hooksPath|include\.path|includeIf\.[A-Za-z0-9_.:-]*)(?![A-Za-z0-9_.-])/i;

function namesBypass(text) {
  const detected = text.replace(/\\\r?\n/g, '').replace(/[\\'"]/g, '');
  return /\bSKIP_GIT_GUARD\b|\bGIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)\b/i.test(detected) ||
    (/\bGIT_CONFIG_PARAMETERS\b/i.test(detected) && PROTECTED_KEY_WORD.test(detected)) ||
    (/\bgit\b/i.test(detected) && /\b(?:commit(?:-tree)?|update-ref|config)\b/i.test(detected)) ||
    // The bypass words that need no verb beside git itself: a hooksPath/include
    // override or a --no-veri prefix in text the word scanner never parsed.
    (/\bgit\b/i.test(detected) &&
      (PROTECTED_KEY_WORD.test(detected) || /(?<![\w-])--no-veri(?:f(?:y)?)?(?![\w-])/i.test(detected)));
}

function commitGate(command, depth = 0) {
  if (!command) return;
  // Git's builtin names, not an allowlist of command text. Unknown subcommands
  // may be aliases for commit, so their -n flags need the commit policy too.
  const builtins = new Set(`add am annotate apply archive backfill bisect blame branch bugreport bundle
    cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout--worker checkout-index
    cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects credential
    credential-cache credential-cache--daemon credential-store describe diagnose diff diff-files diff-index
    diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack fmt-merge-msg for-each-ref
    for-each-repo format-patch format-rev fsck fsck-objects fsmonitor--daemon gc get-tar-commit-id grep
    hash-object help history hook index-pack init init-db interpret-trailers last-modified log ls-files
    ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-ours
    merge-recursive merge-recursive-ours merge-recursive-theirs merge-subtree merge-tree mktag mktree
    multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id pickaxe prune
    prune-packed pull push range-diff read-tree rebase receive-pack reflog refs remote remote-ext remote-fd
    repack replace replay repo rerere reset restore rev-list rev-parse revert rm send-pack shortlog show
    show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule--helper survey
    switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info
    upload-archive upload-archive--writer upload-pack url-parse var verify-commit verify-pack verify-tag
    version whatchanged worktree write-tree`.split(/\s+/));
  const protectedKey = (key) => /^(?:core\.hookspath|include\.path|includeif\..*)$/i.test(key);
  const configValue = (key, value) => {
    if (protectedKey(key)) denyCommit('a git config override replaces the repo hooks (core.hooksPath/include)');
    if (/^alias\./i.test(key)) commitGate(value.startsWith('!') ? value.slice(1) : `git ${value}`, depth + 1);
  };
  const configOverride = (value) => {
    const at = value.indexOf('=');
    configValue(at < 0 ? value : value.slice(0, at), at < 0 ? '' : value.slice(at + 1));
  };
  const onAssignment = (word) => {
    if (/^SKIP_GIT_GUARD(?:=|$)/.test(word)) denyCommit('`SKIP_GIT_GUARD` disarms the repo hooks');
    // Env names compare case-insensitively: the harness installs on Windows,
    // where GIT_CONFIG_KEY_0 and git_config_key_0 are one variable.
    const key = word.match(/^git_config_key_\d+=(.*)$/is)?.[1];
    if (key !== undefined && protectedKey(key)) denyCommit('`GIT_CONFIG_KEY_n` replaces the repo hooks (core.hooksPath/include)');
    const parameters = word.match(/^git_config_parameters=(.*)$/is)?.[1];
    if (parameters !== undefined && PROTECTED_KEY_WORD.test(parameters.replace(/['"\\]/g, ''))) denyCommit('`GIT_CONFIG_PARAMETERS` carries a config override (core.hooksPath/include)');
  };
  const noVerify = (word) => /^--no-veri(?:f(?:y)?)?$/.test(word);
  try {
    if (depth > 8) throw new SyntaxError('Shell nesting limit');
    const substitutions = [];
    // `in`/`esac` are NOT split operators: bash reads them as keywords only
    // in keyword position, and a bare word split hid a bypass behind a data
    // word (`git commit -m in --no-verify`, task 2665 fifth correction round
    // 2). peelProgram judges the keyword positions: the `case WORD in`
    // header, a leading keyword, and the arm patterns.
    for (const { part } of splitTopLevel(command, ['&&', '||', '|&', ';;&', ';;', ';&', '|', ';', '&', '\n'], { shell: true, substitutions })) {
      const words = splitWords(part, { shell: true });
      const { program, operands, nestedCommand } = peelProgram(words, { shell: true, onAssignment });
      if (nestedCommand !== undefined) { commitGate(nestedCommand, depth + 1); continue; }
      if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(program)) {
        // The declaring builtins export too: `declare -x`, `typeset -x`,
        // `local -x` and `readonly` put the name into the environment of
        // every later command in the shell. Their own flags (-x, -r, -g,
        // ...) are options, not assignments (task 2665 third correction).
        let options = true;
        for (const word of operands) {
          if (options && word === '--') { options = false; continue; }
          if (options && word.startsWith('-')) continue;
          onAssignment(word);
        }
        continue;
      }
      if (program !== 'git') continue;
      let i = 0;
      // Global options have their own arity; -c is a config override here,
      // whereas commit's -c consumes a commit-message source.
      for (; i < operands.length && operands[i].startsWith('-'); i += 1) {
        const word = operands[i];
        if (noVerify(word)) denyCommit('`--no-verify` skips the commit hooks');
        if (word === '-c') configOverride(operands[++i] ?? '');
        else if (word.startsWith('-c')) configOverride(word.slice(2));
        else if (word === '--config-env') {
          const key = (operands[++i] ?? '').split('=')[0];
          if (protectedKey(key)) configValue(key, '');
        } else if (word.startsWith('--config-env=')) {
          const key = word.slice('--config-env='.length).split('=')[0];
          if (protectedKey(key)) configValue(key, '');
        } else if (['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--attr-source'].includes(word)) i += 1;
      }
      const subcommand = operands[i++];
      const args = operands.slice(i);
      if (subcommand === 'update-ref' || subcommand === 'commit-tree') denyCommit(`\`git ${subcommand}\` records a commit or ref with no hook run`);
      if (subcommand === 'config') {
        // Reads and removals do not install a hook/config bypass. The newer
        // syntax (`--comment note k v`, `set --value v k v`) only ADDS words
        // around the key, so the write rule is positional: with no read verb
        // leading, a protected key named anywhere in the operands is written
        // (task 2665 third correction). A lone operand is the value query.
        const reads = /^(?:--(?:get(?:-all|-regexp|-urlmatch)?|unset(?:-all)?|list)|-l)$/;
        const positional = [];
        let read = false;
        let options = true;
        for (let j = 0; j < args.length; j += 1) {
          const word = args[j];
          if (options && word === '--') { options = false; continue; }
          if (options && reads.test(word)) { read = true; continue; }
          if (options && ['--file', '-f', '--type', '-t', '--blob', '--default', '--comment', '--value', '--fixed-value'].includes(word)) { j += 1; continue; }
          if (!options || !word.startsWith('-')) positional.push(word);
        }
        if (positional.length <= 1 || ['get', 'unset', 'list'].includes(positional[0])) read = true;
        if (!read) {
          for (let j = 0; j < positional.length; j += 1) configValue(positional[j], positional[j + 1] ?? '');
        }
      }
      const commitLike = subcommand === 'commit' || (subcommand && !builtins.has(subcommand));
      for (let j = 0; j < args.length; j += 1) {
        const word = args[j];
        if (word === '--') break;
        if (noVerify(word)) denyCommit('`--no-verify` skips the commit hooks');
        if (!commitLike) continue;
        if (['--message', '--file'].includes(word)) { j += 1; continue; }
        if (!/^-[^-]/.test(word)) continue;
        for (let k = 1; k < word.length; k += 1) {
          if (word[k] === 'n') denyCommit('`-n` on a commit skips the commit hooks');
          // Git's own short options end the cluster scan when they take an
          // argument: the rest of the word is data, not flags (`-uno`,
          // `-unormal`, `-tnotes`, `-Snightly`). `-u` and `-S` take it
          // ATTACHED ONLY, so at cluster end they do not eat the next word;
          // m/F/t/C/c take the next word when the cluster ends on them.
          if ('utSmFCc'.includes(word[k])) {
            if (k === word.length - 1 && !'uS'.includes(word[k])) j += 1;
            break;
          }
        }
      }
    }
    for (const body of substitutions) commitGate(body, depth + 1);
  } catch {
    // A malformed command naming a bypass cannot safely be judged by words.
    // Normalization is detection-only, never an allow-shape matcher.
    if (namesBypass(command)) denyCommit();
  }
}

function denyCommit(bypass) {
  // The refusal names the bypass it found and points at the stamp that
  // replaced the shapes; the no-argument call is the fail-closed path for an
  // event that never parsed (task 1847).
  const found = bypass
    ? `This command bypasses git's own commit hooks: ${bypass}.`
    : 'This event does not parse and its raw text names a git hook bypass, so it is refused fail-closed.';
  try {
    writeSync(1, JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `${found} The stamp, not this hook, now proves check:commit (task 2665, decision #18503): ` +
          'run `npm run check:commit -- <paths>` - exit 0 stamps the tree - then commit plainly; ' +
          '`.githooks/pre-commit` refuses an unstamped tree. ' +
          'EnterWorktree is for editing and committing files of that worktree. Before any git outside it call `ExitWorktree {action: "keep"}` (the worktree and branch stay), then land yourself with `git -C <main checkout> merge --ff-only <sha>` and `git -C <main checkout> push origin master`. Do not ask the operator to run the fast-forward.',
      },
    }));
  } catch {
    process.exit(0); // No delivered refusal: fail open, without touching session state.
  }
  process.exit(MODE === 'grok' ? 2 : 0);
}

commitGate(command);

if (existsSync(mark)) await allowOrHint();


let offender = null;
if (command) {
  // Judge the PROGRAM of each pipeline segment, not substrings: a commit
  // message containing the words "read" and ".rs" is not a file read (this
  // very hook denied its own `git commit` before this narrowing).
  //
  // The RELEASE is judged the same way, and that is the fix of 2026-08-14. It
  // used to be a regex over the whole command string, so anything that merely
  // MENTIONED probe, ast-grep or ` sg ` — a commit message, an echo, a quoted
  // sentence in a refusal being pasted back — wrote the session mark and
  // disarmed the gate for the rest of the session. Named by the glm seat of
  // harness-code-intel-review-r2. A rule that a sentence about the rule can
  // switch off is not a rule.
  const SEARCHES = new Set(['codegraph', 'ast-grep', 'sg']);
  // `sg` is @ast-grep/cli's second bin name, which the audit records as
  // ast-grep since b37d25289: a lead that heeds the refusal under npm's other
  // spelling must not stay gated for the rest of its session.
  //
  // POWERSHELL READS COUNT. `Get-Content`, `Select-String` and their aliases
  // (`gc`, `type`, `sls`) plus cmd's `findstr` were absent until 2026-08-14, so
  // on the Windows installs this very repository ships, a lead could read
  // .rs/.ts source all session and the gate never fired — the hole was found
  // independently by four seats of harness-code-intel-review-r2, each of them
  // driving the hook live. `cat` and `more` were already here and are also
  // PowerShell aliases, which is exactly why the gap was invisible: the set
  // looked like it covered the shell.
  const READERS = new Set([
    'rg', 'grep', 'cat', 'sed', 'awk', 'head', 'tail', 'less', 'more',
    'get-content', 'gc', 'type', 'select-string', 'sls', 'findstr',
  ]);
  const GLUE = new Set(['cd', 'echo', 'true']);
  // Compound commands are the contract's own token-economy idiom ("связанные
  // inspect/verify команды объединять в один compound"). Measured in battle
  // (native-configs session, 2026-07-28): denying a compound for one grep link
  // punishes the idiom, not the intent. The rule therefore fires only when the
  // WHOLE command is source reading — a lone grep/read of .rs/.ts.
  let sawNonReader = false;
  let released = false;
  // Longer operators first: the scanner takes the first candidate that
  // matches, so `|` ahead of `||` would read one operator as two.
  for (const { part: segment } of splitTopLevel(command, ['&&', '||', '|', ';'])) {
    const { program, operands, viaRouter } = peelProgram(splitWords(segment));
    if (!program) continue;
    // A search the lead actually RAN, in this segment's program position -
    // through `rtk` too, which is how the contract asks for it to be run.
    if (SEARCHES.has(program)) {
      released = true;
      continue;
    }
    if (!READERS.has(program) && !(viaRouter && program === 'read')) {
      // cd/echo glue does not make a command "not a read".
      if (!GLUE.has(program)) sawNonReader = true;
      continue;
    }
    if (!offender) {
      for (const word of operands) {
        const trimmed = unquote(word);
        if (trimmed.startsWith('-')) continue;
        const entry = indexFor(trimmed);
        if (entry) {
          offender = { target: trimmed, entry };
          break;
        }
      }
    }
    // No break: a non-reader segment AFTER the offender still clears the
    // command, so the verdict waits until every segment has been seen.
  }
  if (released) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(mark, String(Date.now()));
    } catch {
      /* recording is best-effort */
    }
    allow();
  }
  if (sawNonReader) offender = null;
} else {
  // Native read/search tools: Claude/kimi/zcode Read/Grep/Glob, grok read_file/grep.
  const target = input.file_path ?? input.path ?? input.glob ?? input.pattern ?? '';
  const entry = indexFor(target);
  if (entry) offender = { target, entry };
}

if (!offender) await allowOrHint();

const reason =
  'Session order: query codegraph again by the file or symbol name, then use bounded `rg` for a literal or bounded `ast-grep` for a code shape. ' +
  `\`${offender.target}\` ` +
  `is answered by ${offender.entry}. This refusal comes once per session: after it, direct reads and \`rg\` pass.`;

// Warn-only since 2026-08-21, operator decision. The VERDICT above is unchanged -
// every spelling this file learned to catch is still caught. What changed is that
// the verdict no longer refuses the command.
//
// The header's claim - prose does not order, a refusal does - was measured and
// true, and it is now half of one. What orders is a hint delivered AT THE MOMENT
// of the action, and `additionalContext` is that; the refusal was the delivery,
// not the ordering. It cost a whole extra model turn on every session's FIRST
// grep, because a denied command is re-issued rather than answered - the same
// measurement that made the rtk guards warn-only on 2026-07-31 (~137K cache-read
// per bare command). Measured again 2026-08-21: a lead session lost a turn to it
// inside its first ten tool calls.
//
// grok used to get SILENCE here, and the reason was sound while the verdict was a
// warning: its runtime reads no context channel from a hook, so a warning there
// could only be a comment — measured on the retired kimi/grok WARN hook at seven
// would-deny lines in nineteen days. A REFUSAL is a different channel, and grok
// honours it (`user-guide/10-hooks.md:324`, exit 2). So grok no longer falls
// through: it is the family this gate is most for, at 74 of the last 181 seats
// and 408 whole-file reads in one day.

// The shape the sibling hook already proves on every runtime that carries one
// (`domain-lessons-hook.mjs`): PreToolUse context, no permission decision at all,
// so the command runs under the session's normal permission flow.
// Delivered ONCE per session, and the mark is written on the DELIVERY rather than
// only on a search, because a warning does not limit itself. The refusal did: a
// denied command does not run, so the lead had to answer it before doing anything
// else. A hint does not stop anything, and only a SEARCH writes this mark - so a
// lead that keeps grepping without one was handed the same 250 bytes on every
// single qualifying tool call. Measured 2026-08-21: three identical injections for
// three greps of one file in one session, and the sessions this hook was written
// for run 20-40 such greps.
//
// The mark is written from the write CALLBACK, and it has to be: three seats of
// code-intel-warn-r1 measured the same thing independently - with the reader gone
// the hook exits 0, the hint reaches nobody, and the session's only hint is spent.
// Reordering alone does not fix it, measured here: a write to a destroyed pipe
// does not throw, so the next statement runs either way. The callback is what
// KNOWS - it is handed EPIPE - and it is also what makes the exit safe, because
// process.exit() may truncate a pending pipe write.
// The command a seat of THIS family can actually run. The August refusal named
// none, which is most of why it cost a turn: it said "search first" to runtimes
// where the search did not work.
const replacement = MODE === 'grok'
  ? 'Your shell splits the command on WHITESPACE and passes quotes through as characters, '
    + 'so `codegraph explore "<phrase>"` cannot work here. Call the MCP tool '
    + '`codegraph__codegraph_explore` first; a literal you already know then goes to `rg <literal> <path>` '
    + 'with NO quotes.'
  : "Run codegraph explore '<the question in ENGLISH>' first; a literal you already know then goes to "
    + '`rg <literal> <path>`.';

// REFUSAL, restored 2026-09-18 by operator decision, overturning his own call of
// 2026-08-21 (#4260). What that measurement showed was real: a denied command is
// re-issued rather than answered, so the refusal cost an extra model turn on a
// session's first grep. What it could not show is WHY — the replacement did not
// exist. ripgrep was not installed on this machine at all (`rtk rg` answered
// `program not found`), and grok's shell shredded `probe search "<phrase>"` into
// separate arguments. Both were fixed on 2026-09-18, and the smoke now records
// `grok rg PASS` where the same question was previously answered by reading whole
// files. A refusal that names a command the seat can run costs one turn once; the
// 408 whole-file reads it replaces cost far more.
//
// Once per session — and the EMIT comes first, the mark second. A refusal nobody
// received must not spend the session, exactly as a hint nobody received must
// not (2026-09-10, the same case in this file's own suite). The order is the
// opposite of the hint path for a mechanical reason: `write` is asynchronous and
// only its callback knows about EPIPE, while `writeSync` THROWS on a destroyed
// pipe, so the next statement already knows delivery happened.
try {
  writeSync(1, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${reason} ${replacement}${perCallHint ? ` ${perCallHint.text}` : ''}`,
    },
  }));
} catch {
  // The reader is gone: the seat never saw the refusal, so the session keeps its
  // turn. Exit 0 rather than deny — refusing a command over a dead channel gives
  // the seat a wall with no reason attached.
  process.exit(0);
}
mkdirSync(stateDir, { recursive: true });
writeFileSync(mark, String(Date.now()));
if (perCallHint) recordHint(perCallHint);
// The shape the sibling hook proves on every runtime: one JSON body, and grok
// alone needs exit 2 — its `user-guide/10-hooks.md:324` makes that the explicit
// PreToolUse deny, while kimi 0.43.0 reads `permissionDecisionReason` only at
// exit 0 (domain-lessons-hook.mjs:160-173).
process.exit(MODE === 'grok' ? 2 : 0);
