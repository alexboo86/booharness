// The shell a READ-ONLY Pi seat may run (operator, 2026-09-23, task 1436): a scout
// needs rg, ast-grep, the codegraph CLI and memoryctl, which Pi's own read/grep/
// find/ls tools do not reach, but Pi has no permission prompts, so the allowlist
// is the whole guard (docs/security.md of the Pi package). The precedent is the
// opencode scout's shell (decision 2026-09-20); this one is narrower: a command
// runs only when every program in it is on the list below with arguments that
// cannot write, and anything the parser cannot see through is refused.
//
// It sees the command either before or after rtk's own Pi extension rewrote it
// (both load; their order is Pi's load order), so `rtk <sub>` is read through.
// The Pi extension (pi-extension.ts) and the tests import this guard.
import { homedir } from 'node:os';
import { isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteShellPath } from './role-policy.ts';
import { heavy, toolName } from '../build-gate.mjs';

/** Every ordinary Pi seat bash command is bounded, even when the caller omits a timeout. Callers may only shorten it. */
export const SEAT_BASH_TIMEOUT_SECONDS = 10 * 60;
/** Heavy builds, plus cmake configure and ctest (bound only, no build slot). Ignores a shorter seat request (task 1852). */
export const SEAT_BASH_BUILD_TIMEOUT_SECONDS = 45 * 60;

/** Refuse unbounded search scopes, not patterns or find predicates (decision 12892). */
export function refuseBroadSearch(command: string): string | null {
  const root = (value: string): boolean => {
    const path = posix.normalize(value.replace(/\\/g, '/'));
    if (/^~[^/]*\/?$|^\$(?:HOME|USERPROFILE)\/?$|^\$\{(?:HOME|USERPROFILE)\}\/?$/.test(path)) return true;
    if (/^\/$|^[a-z]:\/?$|^\/[a-z]$/i.test(path)) return true;
    // Literal home directories, including Git Bash's drive spelling on Windows.
    if (/^\/(?:Users|home)\/[^/]+\/?$|^\/root\/?$|^(?:[a-z]:|\/[a-z])\/Users\/[^/]+\/?$/i.test(path)) return true;
    const absolute = resolve(value).replace(/\\/g, '/').replace(/\/$/, '');
    const home = homedir().replace(/\\/g, '/').replace(/\/$/, '');
    return absolute === home || absolute === '' || /^[a-z]:$/i.test(absolute);
  };
  const valueFlags = new Set(['-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not',
    '-m', '--max-count', '-A', '-B', '-C', '--after-context', '--before-context', '--context',
    '--encoding', '--threads', '-j', '--max-depth', '--max-filesize', '--ignore-file',
    '--include', '--exclude', '--exclude-dir', '--label', '--color', '--binary-files', '-d', '--directories']);
  let rootDirectory: string | null = null;
  for (const words of deepSegments(command)) {
    for (const run of invocations(words)) {
      const name = basename(run[0]).replace(/\.exe$/i, '');
      if (name === 'cd') {
        const target = run.slice(1).find((arg) => !['-L', '-P', '--'].includes(arg)) ?? '~';
        if (root(target)) rootDirectory = target;
        continue;
      }
      if (!['find', 'rg', 'grep'].includes(name)) continue;
      if (rootDirectory !== null) return `${name} search after cd to ${rootDirectory} is refused; limit searches to the seat worktree and named install dirs (e.g. C:/Qt/6.11.2)`;
      const args = run.slice(1);
      const optionEnd = args.indexOf('--');
      // Explicit patterns may occur after the paths: `rg / -e foo` searches /.
      let pattern = args.slice(0, optionEnd < 0 ? args.length : optionEnd)
        .some((arg) => /^-[^-]*[ef]|^--(?:regexp|file)(?:=|$)/.test(arg));
      let options = true;
      let findPaths = false;
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (name === 'find') {
          if (!findPaths && ['-H', '-L', '-P'].includes(arg)) continue;
          if (arg === '--' && !findPaths) continue;
          if (arg.startsWith('-') || arg === '(' || arg === '!') break;
          findPaths = true;
        } else {
          if (options && arg === '--') { options = false; continue; }
          if (options && arg.startsWith('-')) {
            const flag = arg.split('=')[0];
            if (['-e', '--regexp', '-f', '--file'].includes(flag)) {
              pattern = true;
              if (!arg.includes('=')) i += 1;
            } else if (/^-[^-]*?[ef]/.test(arg)) {
              pattern = true;
              if (/^-[^-]*?[ef]$/.test(arg)) i += 1;
            } else if (valueFlags.has(flag) && !arg.includes('=')) i += 1;
            continue;
          }
          if (!pattern) { pattern = true; continue; }
        }
        if (root(arg)) return `${name} search rooted at ${arg} is refused; limit searches to the seat worktree and named install dirs (e.g. C:/Qt/6.11.2)`;
      }
    }
  }
  return null;
}

/** Timeout the Pi extension sets. The 45 min bound applies only when every unwrapped segment is a build, configure, test run, or plain cd. */
export function seatBashTimeoutSeconds(command: string, requested?: unknown): number {
  if (bashBuildBound(command)) return SEAT_BASH_BUILD_TIMEOUT_SECONDS;
  const asked = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? requested : SEAT_BASH_TIMEOUT_SECONDS;
  return Math.min(asked, SEAT_BASH_TIMEOUT_SECONDS);
}

const CMAKE_VALUE = new Set(['-S', '-B', '-G', '-C', '-D', '-U', '-W', '--toolchain', '--install-prefix', '--graphviz', '--log-level']);

/** Timeout only, not a build slot: cmake configure, or ctest actually running tests. */
export function boundOnlyBuild(tool: string, args: readonly string[]): boolean {
  const name = toolName(tool);
  if (name === 'ctest') return !args.some((arg) => /^(--help|--version|--usage|-h|--help-.*|-N|--show-only(?:=.*)?)$/.test(arg) || arg === '-help' || arg === '-version');
  if (name !== 'cmake') return false;
  if (args.some((arg) => /^(--build|--install)(?:=|$)/.test(arg) || arg === '-E' || arg === '-P' || /^-E./.test(arg) || /^-P./.test(arg))) return false;
  if (args.some((arg) => arg === '--preset' || arg.startsWith('--preset=') || arg === '-S' || arg === '-B' || /^-[SB][^-]/.test(arg))) return true;
  let value = false;
  for (const arg of args) {
    if (arg === '--') break;
    if (value) { value = false; continue; }
    if (arg.startsWith('-')) { if (CMAKE_VALUE.has(arg)) value = true; continue; }
    return true;
  }
  return false;
}

function plainCd(run: string[]): boolean {
  if (toolName(basename(run[0] ?? '')) !== 'cd') return false;
  let operands = 0;
  for (const arg of run.slice(1)) {
    if (arg === '--' || arg === '-L' || arg === '-P') continue;
    if (arg.startsWith('-') && arg !== '-') return false;
    if (++operands > 1) return false;
  }
  return true;
}

/** True when every executed program, after launcher and shell unwrapping, is a build step or a plain cd, and at least one is a build step. */
function bashBuildBound(command: string): boolean {
  if (typeof command !== 'string') return false;
  let sawBuild = false;
  for (const words of deepSegments(command)) {
    for (const run of invocations(words)) {
      const bare = toolName(basename(run[0] ?? ''));
      // A shell is only a wrapper when it runs a `-c` payload (unwrapped by
      // invocations); a script file or stdin runs unparsed code.
      if (SHELLS.has(bare)) {
        if (!run.slice(1).some((arg, index, args) => args.slice(0, index).every((flag) => flag.startsWith('-')) && /^-[A-Za-z]*c$/.test(arg))) return false;
        continue;
      }
      if (!bare || Object.hasOwn(LAUNCHERS, bare)) continue;
      const args = run.slice(1);
      if (plainCd(run)) continue;
      if (!(heavy(bare, args) || boundOnlyBuild(bare, args))) return false;
      sawBuild = true;
    }
  }
  return sawBuild;
}

/** Why a command is refused, or null when it may run. */
export function refuseReadOnly(command: string, standArm?: string): string | null {
  if (typeof command !== 'string' || command.trim() === '') return 'empty command';
  // Anything that runs a command the split below cannot see, or writes a file.
  if (/\$\(|`|<\(|>\(/.test(command)) return 'command or process substitution';
  if (/<</.test(command)) return 'here-document';
  const segments = splitQuoted(command);
  if (segments === null) return 'unbalanced quotes';
  const hasNode = segments.some((segment) => segment.words.some((word) => basename(word) === 'node'));
  const directory = { changed: false };
  for (const segment of segments) {
    const why = refuseSegment(segment.words, standArm, directory, segment.single);
    if (why) return hasNode && !why.includes(ORCH_READ_FORMS) ? `${why}; ${ORCH_READ_FORMS}` : why;
  }
  return null;
}

/** One top-level segment's words, with which of them are fully single-quoted
 *  literals — the only words bash cannot expand into another word (task 2676 fix,
 *  reviewer-codex-382aee.1). */
type QuotedSegment = { words: string[]; single: boolean[] };

/** Top-level segments at `&&`, `||`, `;`, `|`, `&` and newlines, outside quotes. */
function splitCore(command: string): QuotedSegment[] | null {
  const out: QuotedSegment[] = [];
  let words: string[] = [];
  let single: boolean[] = [];
  let word = '';
  let wordSingle = true;
  let quoted = false;
  let quote: string | null = null;
  const endWord = () => {
    if (word !== '' || quoted) { words.push(word); single.push(wordSingle); }
    word = '';
    wordSingle = true;
    quoted = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) out.push({ words, single });
    words = [];
    single = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        if (command[i + 1] !== '\n') word += command[i + 1];
        wordSingle = false;
        i += 1;
      } else {
        word += ch;
        if (quote !== "'") wordSingle = false;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; quoted = true; if (ch === '"') wordSingle = false; continue; }
    // A backslash-newline is a line continuation: both are removed and the word continues.
    if (ch === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') word += command[i + 1];
      wordSingle = false;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    // `<` and `>` are shell metacharacters: they end the word before them unless it is a bare
    // descriptor (`2>`, `&>`), so `cat x>victim.txt` yields the word `>victim.txt` (qwen review
    // 2026-09-23: glued to `x`, it passed as an argument and truncated the file).
    if ((ch === '<' || ch === '>') && !/^(\d*|&)$/.test(word) && !/[<>]$/.test(word)) { endWord(); word = ch; wordSingle = false; continue; }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      // `2>&1` and `>&2` are redirections of a stream, not a background `&`.
      if (ch === '&' && /[<>]$/.test(word)) { word += ch; wordSingle = false; continue; }
      endSegment();
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i += 1;
      continue;
    }
    word += ch;
    wordSingle = false;
  }
  if (quote) return null;
  endSegment();
  return out;
}

function splitOnce(command: string): string[][] | null {
  return splitCore(command)?.map(({ words }) => words) ?? null;
}

/**
 * The command with shell comments removed: an unquoted `#` at a word start,
 * through end of line (the newline stays, so segment structure is kept).
 * An escaped `\#` or a glued `foo#bar` is word content and stays.
 */
function stripShellComments(command: string): string {
  let out = '';
  let word = false; // inside a word (characters or an opened quote)
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) out += command[++i];
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; word = true; out += ch; continue; }
    if (ch === '\\' && i + 1 < command.length) { word = true; out += ch + command[++i]; continue; }
    if (ch === '#' && !word) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i += 1;
      continue;
    }
    out += ch;
    if (' \t\n;|&<>'.includes(ch)) word = false;
    else word = true;
  }
  return out;
}

/**
 * splitOnce, and when the text does not parse — an unclosed quote, commonly a
 * `#` comment holding an apostrophe (`rm -rf x # don't`,
 * `sh -c "rm -rf x # don't"`, reviewer-codex-243386.1) — one retry with shell
 * comments removed (task 2051). A text that parses keeps today's result:
 * comments are ordinary words to an interactive zsh without
 * interactivecomments, and the refusals built on the parsed form are
 * deliberate (shell-delete-hook.mjs header).
 */
export function split(command: string): string[][] | null {
  return splitOnce(command) ?? splitOnce(stripShellComments(command));
}

/** split(), keeping which words are fully single-quoted literals (task 2676 fix). */
function splitQuoted(command: string): QuotedSegment[] | null {
  return splitCore(command) ?? splitCore(stripShellComments(command));
}

const basename = (word: string) => (word.split(/[\\/]/).pop() ?? word);
/** Launcher table keys are lowercase and have no Windows suffix (`RTK.EXE` is `rtk`). */
const launcherName = (word: string) => basename(word).replace(/\.exe$/i, '').toLowerCase();
/** `NAME=value` before a command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A word that starts a redirection: `>`, `>>`, `2>`, `&>`, `<`, target joined or not. */
const REDIRECT = /^(\d*|&)(>>?|<)/;
/** Stream-only redirections that write nothing: `2>&1`, `>&2`, `2>/dev/null`. */
const HARMLESS_REDIRECT = /^\d*>&\d$|^(\d*|&)>>?\/dev\/null$/;

function refuseSegment(input: string[], standArm?: string, directory?: { changed: boolean }, inputSingle?: boolean[]): string | null {
  const words: string[] = [];
  const singles: boolean[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const w = input[i];
    if (!REDIRECT.test(w)) { words.push(w); singles.push(inputSingle?.[i] ?? false); continue; }
    // `> file`: the target is the next word.
    const bare = /^(\d*|&)(>>?|<)$/.test(w);
    const joined = bare ? `${w}${input[i + 1] ?? ''}` : w;
    if (bare) i += 1;
    // Reading a file is reading; `<>` opens it read-write and creates it.
    if (/^\d*<(?!>)/.test(joined)) continue;
    if (!HARMLESS_REDIRECT.test(joined)) return `writes through a redirection (${joined})`;
  }
  if (!words.length) return null;
  if (ASSIGNMENT.test(words[0])) return 'environment assignment before a command';
  if (directory?.changed && words[0] === 'node' && !isAbsolute(words[1] ?? '')) return 'node relative script after a directory change';
  const why = refuseProgram(words, standArm, singles);
  // Use the parsed program, not mentions of cd in a reader's arguments.
  if (!why && directory && words[0] === 'cd') directory.changed = true;
  return why;
}

const PLAIN_READERS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'tree', 'pwd', 'file', 'stat', 'du', 'basename', 'dirname',
  'realpath', 'which', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'cmp', 'diff', 'jq', 'echo', 'printf',
  'true', 'test', '[', 'cd',
]);

const GIT_READ = new Set([
  'log', 'show', 'diff', 'status', 'grep', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list',
  'describe', 'cat-file', 'merge-base', 'shortlog', 'name-rev', 'show-ref', 'for-each-ref',
]);
const CODEGRAPH_READ = new Set(['status', 'query', 'explore', 'context', 'node', 'files', 'callers', 'callees', 'impact', 'affected']);
const MEMORYCTL_READ = new Set(['hot', 'search', 'get', 'show', 'lessons', 'registry-read']);
const MEMORYCTL_TASK_READ = new Set(['list', 'show', 'ready']);
/** rtk subcommands that only filter a read; each maps to the program whose rules then apply. */
const RTK_READ: Record<string, string | null> = {
  read: 'cat', ls: 'ls', tree: 'tree', find: 'find', grep: 'grep', rg: 'rg', wc: 'wc', json: 'cat',
  diff: 'diff', log: 'cat', smart: 'cat', git: 'git',
};

// Pi loads this extension from orch's checkout but starts Bash in the seat cwd.
const ORCH_SCRIPT = resolve(process.cwd(), 'ops/orchestrator/src/main.ts');
const ORCH_LOADED_SCRIPT = fileURLToPath(new URL('./main.ts', import.meta.url));
const ORCH_READ_FORMS = `node is not a read-only orch invocation; allowed forms with node ops/orchestrator/src/main.ts or node ${quoteShellPath(ORCH_LOADED_SCRIPT.replaceAll('\\', '/'))}: status; pick-stats [--json]; wait <turn> [--json]`;

/** Fixed read-only CLI grammar, not Node's general flag/script runner (decision #14672). */
function refuseOrchRead(args: string[]): string | null {
  const [script, ...argv] = args;
  if (!script || script.startsWith('-') || script.split(/[\\/]/).includes('..') || (resolve(script) !== ORCH_SCRIPT && resolve(script) !== ORCH_LOADED_SCRIPT)) return ORCH_READ_FORMS;
  if (argv.length === 1 && argv[0] === 'status') return null;
  // JSON is last; duplicates, unknown roles, flags and extra arguments fail closed.
  const tail = argv.at(-1) === '--json' ? argv.slice(0, -1) : argv;
  if (tail.length === 1 && tail[0] === 'pick-stats') return null;
  if (tail.length === 2 && tail[0] === 'wait' && /^[A-Za-z0-9._-]+$/.test(tail[1])) return null;
  return ORCH_READ_FORMS;
}

/**
 * Programs that run another program: wrappers and package runners, with the
 * flags that take the next word as a value, the flags whose value is a command
 * string, the sub-verbs they pass through (`pnpm dlx`, `rtk run|err|test|summary`;
 * npm must name one) and positional words before the program (`timeout 5`). This includes
 * `exec -a`, `env -P`, sudo long value flags, BSD xargs `-J`/`-R`/`-S`, and
 * runner globals before a sub-verb. Only npm/pnpm/yarn guess unlisted value
 * flags; their known boolean globals and rtk's boolean flags never eat a command.
 * The one table behind invocations(), deepSegments() and SKILL_INSTALL_DENY.
 */
type Launcher = { values?: readonly string[]; payloads?: readonly string[]; booleans?: readonly string[]; guessValues?: boolean; subs?: readonly string[]; subRequired?: boolean; positionals?: number; shellScript?: readonly string[]; runners?: readonly string[]; skipWords?: Readonly<Record<string, readonly string[]>> };
const RUNNER_FLAGS = { values: ['-p', '--package'], payloads: ['-c', '--call'], booleans: ['--silent', '-s', '--offline', '--prefer-offline', '--verbose', '--help', '-h', '--version', '-v'] } as const;
const LAUNCHERS: Record<string, Launcher> = {
  env: { values: ['-u', '--unset', '-C', '--chdir', '-P'], payloads: ['-S', '--split-string'] },
  sudo: { values: ['-u', '-g', '-U', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-R', '--user', '--group', '--chdir', '--prompt', '--role', '--type', '--host', '--close-from', '--other-user', '--chroot', '--command-timeout'] },
  // -R takes a value on macOS BSD xargs (orch's platform); GNU xargs uses it as a boolean.
  xargs: { values: ['-I', '-J', '-L', '-n', '-P', '-R', '-S', '-s', '-a', '-d', '-E'] },
  time: { values: ['-f', '-o'] },
  timeout: { values: ['-s', '--signal', '-k', '--kill-after'], positionals: 1 },
  nice: { values: ['-n', '--adjustment'] },
  stdbuf: { values: ['-i', '-o', '-e'] },
  watch: { values: ['-n', '--interval'] },
  nohup: {},
  exec: { values: ['-a'] },
  command: {},
  // err/test/summary run a command, like run. --shell <name> is a value; the next positional is one script. test skips !. Unlisted flags are not values.
  // `bypass` is 1.0.1's canonical name of `proxy` (silent alias, same argv behaviour); like proxy it is a pass-through sub, not a --shell runner.
  rtk: { payloads: ['-c', '--command'], values: ['--shell'], shellScript: ['--shell'], subs: ['proxy', 'bypass', 'run', 'err', 'test', 'summary'], runners: ['run', 'err', 'test', 'summary'], skipWords: { test: ['!'] } },
  npx: { ...RUNNER_FLAGS, values: [...RUNNER_FLAGS.values, '--shell'] },
  bunx: RUNNER_FLAGS,
  pnpx: RUNNER_FLAGS,
  pnpm: { ...RUNNER_FLAGS, values: [...RUNNER_FLAGS.values, '-C', '--dir', '--filter', '-F'], subs: ['dlx', 'exec'], guessValues: true },
  yarn: { ...RUNNER_FLAGS, values: [...RUNNER_FLAGS.values, '--cwd'], subs: ['dlx', 'exec'], guessValues: true },
  npm: { ...RUNNER_FLAGS, values: [...RUNNER_FLAGS.values, '--prefix', '-w', '--workspace'], subs: ['exec', 'x'], subRequired: true, guessValues: true },
};
/** A launcher's name or sub-verb: the word before a command string it runs (`rtk run '...'`). */
const LAUNCHER_WORDS = new Set(Object.entries(LAUNCHERS).flatMap(([name, spec]) => [name, ...(spec.subs ?? [])]));
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

/**
 * The programs one segment runs, each as its words from the program on: the
 * leading program seen through env assignments and LAUNCHERS with their flags
 * (`env -u X`/`-P path`, `sudo -u X`/`--user X`, `xargs -I {}`/`-J`/`-R`/`-S`,
 * `exec -a name`, `timeout 5`, `rtk proxy|bypass|run|err|test|summary`, `npx -y`/`-p <pkg>`,
 * `pnpm --filter X dlx`, `npm --loglevel http --silent exec`), plus every command string handed to
 * one of them or to a shell (`npx -c '...'`, `bash -c '...'`, `env -S '...'`,
 * `rtk run '...'`, `rtk err --shell sh '...'`, `rtk test ! cmd`). Only npm/pnpm/yarn infer unknown flag values before a
 * sub-verb; known boolean globals (e.g. `--silent`) and rtk flags do not consume
 * the next program. A substitution is not parsed.
 */
export function invocations(words: string[], onLauncher?: (name: string, sub?: string) => boolean): string[][] {
  const out: string[][] = [];
  const payload = (command: string) => { for (const segment of split(command) ?? []) out.push(...invocations(segment, onLauncher)); };
  let i = 0;
  const subverbAhead = (spec: Launcher): number | null => {
    let j = i;
    while (j < words.length) {
      if (spec.subs?.includes(words[j])) return j;
      const word = words[j];
      if (!word.startsWith('-') || word === '--') return null;
      const eq = word.startsWith('--') ? word.indexOf('=') : -1;
      const flag = eq < 0 ? word : word.slice(0, eq);
      j += 1;
      // A listed flag owns its value even if it spells a sub-verb. Only package
      // runners guess a value for an unlisted, non-boolean flag.
      if (eq < 0 && (spec.values?.includes(flag) || spec.payloads?.includes(flag) || spec.shellScript?.includes(flag)
        || (spec.guessValues && !spec.booleans?.includes(flag) && words[j] !== undefined
          && !words[j].startsWith('-') && !spec.subs?.includes(words[j])))) j += 1;
    }
    return null;
  };
  let shellScript = false;
  const skipFlags = (spec: Launcher, subverb: number | null = null) => {
    while (i < words.length && words[i].startsWith('-')) {
      const word = words[i++];
      if (word === '--') return;
      const eq = word.startsWith('--') ? word.indexOf('=') : -1;
      const flag = eq < 0 ? word : word.slice(0, eq);
      const glued = eq < 0 ? undefined : word.slice(eq + 1);
      if (spec.shellScript?.includes(flag)) shellScript = true;
      if (spec.payloads?.includes(flag)) {
        payload(glued ?? words[i++] ?? '');
        shellScript = false; // -c is the script; the positional is not a second one
      } else if (glued === undefined && (spec.values?.includes(flag) || spec.shellScript?.includes(flag))) i += 1;
      else if (spec.guessValues && !spec.booleans?.includes(flag) && subverb !== null
        && glued === undefined && i < subverb && !words[i].startsWith('-')) i += 1;
    }
  };
  for (;;) {
    // Assignments and redirections may lead in any order and any number
    // (`CI=1 2>/dev/null cmd`, `2>/dev/null CI=1 cmd`). A bare redirection
    // owns the next word, its target (reviewer-codex-7328fe.1, .2).
    for (;;) {
      if (i < words.length && REDIRECT.test(words[i])) {
        const bare = /^(\d*|&)(>>?|<)$/.test(words[i]);
        i += 1;
        if (bare) i += 1;
        continue;
      }
      if (i < words.length && ASSIGNMENT.test(words[i])) { i += 1; continue; }
      break;
    }
    const name = launcherName(words[i] ?? '');
    if (!Object.hasOwn(LAUNCHERS, name)) break;
    const spec = LAUNCHERS[name];
    i += 1;
    if (name === 'command' && /^-[vV]$/.test(words[i] ?? '')) return out; // a lookup, not a run
    // Package-runner global flags may precede their sub-verb (`pnpm --silent dlx`).
    if (spec.subs) skipFlags(spec, subverbAhead(spec));
    if (onLauncher?.(name, words[i]) === false) return out;
    const sub = spec.subs?.includes(words[i]) ? words[i] : undefined;
    if (sub) i += 1;
    else if (spec.subRequired) return out;
    shellScript = false; // only this sub's own --shell makes the next positional a script
    skipFlags(spec);
    // rtk test consumes every leading `!` (`rtk test ! ! git stash` still runs git).
    while (sub && spec.skipWords?.[sub]?.includes(words[i] ?? '')) {
      i += 1;
      shellScript = false;
      skipFlags(spec);
    }
    // rtk err|test|summary|run --shell <name> '<script>': the one argument after the shell name.
    if (sub && spec.runners?.includes(sub) && shellScript && i < words.length && !words[i].startsWith('-')) {
      payload(words[i]);
      return out;
    }
    i += spec.positionals ?? 0;
  }
  // A case-variant shell (`Bash`, `Zsh`, `SH`) is the same shell. A short cluster
  // that holds `c` (`-c`, `-lc`, `-cl`) runs a script. Every later word that does
  // not start with `-` or `+` is judged as a payload (`sh -c -o errexit 'cmd'`,
  // `sh -o errexit -c 'cmd'`), so a value before or after `-c` is not guessed.
  // A harmless operand such as `errexit` parses to nothing.
  const name = launcherName(words[i] ?? '');
  if (SHELLS.has(name)) {
    out.push(words.slice(i));
    let at = -1;
    for (let j = i + 1; j < words.length; j += 1) if (/^-[A-Za-z]*c/.test(words[j])) { at = j; break; }
    if (at >= 0) {
      for (let k = at + 1; k < words.length; k += 1) {
        if (words[k].startsWith('-') || words[k].startsWith('+')) continue;
        payload(words[k]);
      }
    }
    return out;
  }
  if (i >= words.length) return out;
  if (/\s/.test(words[i])) payload(words[i]); // `rtk run 'npx skills add x'`
  else out.push(words.slice(i));
  return out;
}

/**
 * The first banned program a command starts, or null (task 1452): an A/B arm
 * turns an instrument's CLI off for one Pi seat, and the extension refuses its
 * obvious invocations — each program `invocations` finds, by bare base name.
 * This guides an experiment arm; it is not a sandbox (a full shell can hide a
 * program in a substitution), and run rows record the effective instruments,
 * not a proof of unreachability.
 */
export function bannedProgram(command: string, banned: ReadonlySet<string>): string | null {
  if (typeof command !== 'string' || !banned.size) return null;
  const segments = split(command);
  if (segments === null) return null; // unbalanced quotes are the read-only guard's refusal, not this one's
  for (const words of segments) {
    for (const run of invocations(words)) {
      const name = basename(run[0]);
      if (banned.has(name)) return name;
    }
  }
  return null;
}

/** The only skills CLI calls a seat may make: reads. Any other verb, present or a future alias, is refused. */
const SKILLS_READ = new Set(['find', 'list', 'ls', '--help', '-h', '--version']);
/** The skills package and its second bin, with an optional version. */
const SKILLS_PACKAGE = /^(skills|add-skill)(@\S*)?$/;
/** A flag whose value is a command string: `-c`, clustered `-cl`/`-lc`, `env -S`, `npx --call`, `rtk run --command`. `--shell`'s value is the shell name; the script is the next positional. */
const PAYLOAD_FLAG = /^(-[A-Za-z]*[cS][A-Za-z]*|--call|--command|--split-string)$/;
const SHELL_SCRIPT_FLAGS = new Set(Object.values(LAUNCHERS).flatMap((spec) => spec.shellScript ?? []));
const SKIP_BEFORE_SCRIPT = new Set(Object.values(LAUNCHERS).flatMap((spec) => Object.values(spec.skipWords ?? {}).flat()));
const SHELL_SCRIPT_PROGRAMS = new Set(Object.entries(LAUNCHERS).filter(([, spec]) => spec.shellScript?.length || spec.skipWords).map(([name]) => name));

/** True when words[i] is a command string a launcher runs, not a literal argument. */
function commandString(words: string[], index: number): boolean {
  if (!/\s/.test(words[index] ?? '')) return false;
  const prev = words[index - 1] ?? '';
  if (PAYLOAD_FLAG.test(prev) || LAUNCHER_WORDS.has(basename(prev))) return true;
  const programBefore = (end: number) => words.slice(0, end).some((word) => SHELL_SCRIPT_PROGRAMS.has(launcherName(word)));
  if (SKIP_BEFORE_SCRIPT.has(prev) && programBefore(index - 1)) return true;
  const glued = /^--([^=]+)=/.exec(prev);
  const shellAt = glued && SHELL_SCRIPT_FLAGS.has(`--${glued[1]}`) ? index - 1
    : SHELL_SCRIPT_FLAGS.has(words[index - 2] ?? '') ? index - 2 : -1;
  return shellAt >= 0 && programBefore(shellAt);
}

/** Every segment of a command and, recursively, of each command string handed to a launcher or shell. */
function deepSegments(command: string): string[][] {
  const out: string[][] = [];
  for (const words of split(command) ?? []) {
    out.push(words);
    for (let i = 1; i < words.length; i += 1) {
      const glued = /^--(call|command|split-string)=(.*)$/s.exec(words[i]);
      if (glued) out.push(...deepSegments(glued[2]));
      else if (commandString(words, i)) out.push(...deepSegments(words[i]));
    }
  }
  return out;
}

/**
 * Why a command may change the installed skills, or null (task 1566, decision
 * #11984): every seat has find-skills in its canon, whose instructions run
 * `npx skills add -g -y <pkg>`, a supply-chain write outside the worktree. Only
 * the lead installs skills, so this refuses for every seat role.
 *
 * The shape follows reviews that kept finding launchers and aliases a parser
 * missed (clustered flags, `pnpm --silent dlx`, `timeout 5`, `find -exec`,
 * `skills r`, the `add-skill` bin): no launcher is required. In every segment,
 * and recursively in each `-c`-style command string, any word whose basename is
 * a skills bin (`skills`, `add-skill`, `@version` allowed) must be followed by a
 * read verb (SKILLS_READ), nothing, or a path (`/`, leading `.` or `~`): the
 * CLI (skills@1.7.0 main()) dispatches only exact verbs and prints "Unknown
 * command" for anything else, so `rg skills .agents` runs.
 * Accepted false positives: `echo npx skills add`, `npm run skills x`, `npm test "skills add"`,
 * `rg skills src`, `grep -c "skills x" f`, `ls dir/skills foo`, and `npx skills init`
 * (it only scaffolds, but is not on the read list).
 * Documented limit: a substitution (`$(...)`, backticks) or another interpreter
 * (`python -c`, `node -e`) is not parsed. Pi seats get this through
 * pi-extension.ts, native claude seats get SKILL_INSTALL_DENY; the native
 * codex/grok/kimi/opencode harnesses have no guard (those families default to Pi).
 */
export function refuseSkillInstall(command: string): string | null {
  if (typeof command !== 'string') return null;
  for (const words of deepSegments(command)) {
    for (let i = 0; i < words.length; i += 1) {
      const token = basename(words[i]);
      if (!SKILLS_PACKAGE.test(token)) continue;
      const verb = words.slice(i + 1).find((w) => !/^(\d*|&)?[<>]/.test(w)); // a redirection is not a verb
      if (verb === undefined || SKILLS_READ.has(verb) || /^[.~]|\//.test(verb)) continue;
      return `${token.replace(/@.*$/, '')} ${verb} is not a read of the installed skills`;
    }
  }
  return null;
}

/** What a seat is told when refuseSkillInstall refuses. */
export const SKILL_INSTALL_REFUSAL = 'only the lead installs skills; name the skill you need in your report';

/**
 * Every mutating verb skills@1.7.0 dispatches (dist/cli.mjs switch: add/a/install/i, use,
 * remove/rm/r, check/update/upgrade, init, experimental_*). Only the claude deny rules use
 * this list: Pi refuses by the read allowlist above, which also catches a future alias.
 */
const SKILLS_WRITE_KNOWN = ['add', 'a', 'install', 'i', 'use', 'remove', 'rm', 'r', 'check', 'update', 'upgrade', 'init', 'experimental_*'];

/**
 * The same refusal as Claude Code deny rules for a native claude seat (`--disallowedTools`,
 * held under bypassPermissions): `skills` or `skills@<version>` followed by a known mutating
 * verb, and the `add-skill` bin. A rule cannot express "any verb off the read list", so a
 * future alias passes here until it is added to SKILLS_WRITE_KNOWN; keying on launcher words
 * instead denied ordinary work (`rg environment .agents/skills`, `npm run check:skills-drift`).
 * Accepted false positives: a quoted phrase such as `rg "skills add"` without a following
 * quote-free word still matches `*skills add`.
 */
export const SKILL_INSTALL_DENY: readonly string[] = [
  ...SKILLS_WRITE_KNOWN.flatMap((verb) => [`Bash(*skills ${verb})`, `Bash(*skills ${verb} *)`, `Bash(*skills@* ${verb})`, `Bash(*skills@* ${verb} *)`]),
  'Bash(*add-skill*)',
];

/** The one sed script a read-only seat may run: a line number or range, then `p` (task 2676). */
const SED_RANGE = /^\d+(,\d+)?p$/;
/** reviewer-codex-382aee.1: an unquoted operand bash cannot expand into another word —
 *  letters, digits, `.`, `_`, `/`, and `-` after the first character; no braces, globs,
 *  `$`, tilde, `!`, escapes, brackets, `=` or quotes. */
const SED_OPERAND_SAFE = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/** Task 2676: seats read line ranges of a file — only `-n`, one script that is exactly a
 *  line number or range then `p` (any w/W/r/R/e, `;`, newline or regex address fails the
 *  pattern), and file operands bash cannot expand into another word: `sed -n '1p'
 *  {-i,victim}` and a `*` matching a file named `-i` both truncated a file after the guard
 *  had checked the literal, so an operand passes only as a fully single-quoted literal or
 *  inert unquoted text. `--` and any operand that could restart option parsing stay refused. */
function refuseSedRun(words: string[], singles?: boolean[]): string | null {
  if (words[1] !== '-n' || !SED_RANGE.test(words[2] ?? '') || words.length <= 3) return 'sed is not on the read-only list';
  for (let i = 3; i < words.length; i += 1) {
    const operand = words[i];
    const literal = singles?.[i] === true && operand !== '' && !operand.startsWith('-');
    if (literal || SED_OPERAND_SAFE.test(operand)) continue;
    return 'sed is not on the read-only list';
  }
  return null;
}

function refuseProgram(words: string[], standArm?: string, singles?: boolean[]): string | null {
  // A bare name only: `./cat` or `/tmp/x/rg` is whatever file sits there, not the reader on PATH
  // (codex review 2026-09-23).
  const name = words[0];
  if (name.includes('/') || name.includes('\\')) return `${name}: run a program by its bare name`;
  const args = words.slice(1);
  if (PLAIN_READERS.has(name)) {
    // The two readers with an output-file flag, and sort's helper program.
    if ((name === 'sort' || name === 'tree') && args.some((a) => /^(-o|--output)(=|$)|^-o./.test(a))) return `${name} -o writes a file`;
    if (name === 'sort' && args.some((a) => /^--compress-program(=|$)/.test(a))) return 'sort --compress-program runs a program';
    return null;
  }
  switch (name) {
    case 'node':
      return refuseOrchRead(args);
    // Only the stand's zero-infra arm gets aider's inspect-and-exit mode.
    // No project/model/command flags or custom paths may be supplied by the model.
    case 'aider':
      return standArm === 'aider-repo-map' && args.length === 1 && args[0] === '--show-repo-map'
        ? null : 'aider is not a read-only repo-map invocation';
    // Only the stand's sleev arm proves its gateway with this one read-only status call.
    case 'sleev':
      return standArm === 'sleev' && args.length === 2 && args[0] === 'gateway' && args[1] === 'status'
        ? null : 'sleev is not a read-only gateway status invocation';
    case 'rtk': {
      const sub = args[0];
      if (!sub || !Object.hasOwn(RTK_READ, sub)) return `rtk ${sub ?? ''} runs or changes more than a read`.trim();
      const inner = RTK_READ[sub];
      return inner === null ? null : refuseProgram([inner, ...args.slice(1)], standArm);
    }
    case 'sed':
      return refuseSedRun(words, singles);
    case 'rg':
      return args.some((a) => /^--pre(-glob)?(=|$)/.test(a)) ? 'rg --pre runs a program' : null;
    case 'find':
      return args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a)) ? `find ${args.find((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))} is not a read` : null;
    case 'ast-grep':
    case 'sg': {
      const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'run';
      if (!['run', 'scan', 'outline'].includes(sub)) return `ast-grep ${sub} is not a search`;
      const writes = args.find((a) => /^(-U|--update-all|-i|--interactive|-r|--rewrite)(=|$)/.test(a));
      return writes ? `ast-grep ${writes} rewrites files` : null;
    }
    case 'codegraph':
      return args[0] && CODEGRAPH_READ.has(args[0]) ? null : `codegraph ${args[0] ?? ''} is not a read`.trim();
    case 'memoryctl':
      if (args[0] === 'task') return MEMORYCTL_TASK_READ.has(args[1] ?? '') ? null : `memoryctl task ${args[1] ?? ''} writes`.trim();
      return args[0] && MEMORYCTL_READ.has(args[0]) ? null : `memoryctl ${args[0] ?? ''} writes`.trim();
    case 'git': {
      let i = 0;
      // Global options before the verb: -C <dir> and --no-pager only; `-c` can set a pager or an alias.
      // This loop deliberately keeps refusing unknown pre-verb flags where refuseStash skips them: skipping `-c` here would let a read-only seat run `git -c alias.x='!cmd'`.
      while (i < args.length && args[i].startsWith('-')) {
        if (args[i] === '-C') i += 2;
        else if (args[i] === '--no-pager') i += 1;
        else return `git ${args[i]} before the verb`;
      }
      const verb = args[i];
      if (!verb || !GIT_READ.has(verb)) return `git ${verb ?? ''} is not a read`.trim();
      const bad = args.slice(i + 1).find((a) => /^--(output|ext-diff|textconv|filters|open-files-in-pager)(=|$)|^-O/.test(a));
      return bad ? `git ${verb} ${bad} writes or runs a program` : null;
    }
    default:
      return `${name} is not on the read-only list`;
  }
}

/** Stash subcommands that only read; every other form (and bare `git stash`, which is `git stash push`) rewrites the stack. */
const STASH_READ = new Set(['list', 'show']);
/** Git global options whose value is a separate word; every other pre-verb option is one word (`--name=value`, glued `-C<dir>`; `--exec-path` is `=`-only). */
const GIT_VALUE_NEXT = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);
/** What a seat is told when refuseStash refuses. */
export const STASH_REFUSAL = 'the stash stack is shared by every worktree of this repository; set work aside with a WIP commit on your seat branch or a file copy, and build a base with `git worktree add`';

/**
 * Why a command rewrites the shared stash stack, or null (task 1999, lesson
 * #11940): refuse `git stash` itself and every subcommand except the reads
 * `list` and `show` — one stash pop in one worktree drops another seat's stashed
 * work in every other worktree. The verb is the first word that is not a global
 * option: every pre-verb option is skipped (codex review 2026-10-04 bypassed the
 * first scan's stop at an unknown flag), consuming the next word for those in
 * GIT_VALUE_NEXT; `--name=value` and glued `-C<dir>` are one word. Like
 * bannedProgram this deters a mistake; it is not a sandbox, and a substitution
 * hides any program from it.
 */
export function refuseStash(command: string): string | null {
  if (typeof command !== 'string') return null;
  for (const words of split(command) ?? []) {
    for (const run of invocations(words)) {
      if (basename(run[0] ?? '').replace(/\.exe$/i, '') !== 'git') continue;
      const args = run.slice(1);
      let i = 0;
      while (i < args.length && args[i].startsWith('-') && args[i] !== '--') {
        i += !args[i].includes('=') && GIT_VALUE_NEXT.has(args[i]) ? 2 : 1;
      }
      if (args[i] !== 'stash') continue;
      const sub = args[i + 1];
      if (sub === undefined || !STASH_READ.has(sub)) return `git stash${sub === undefined ? '' : ` ${sub}`} rewrites the stash stack every worktree shares`;
    }
  }
  return null;
}
