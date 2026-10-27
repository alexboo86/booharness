// Phase 5: which of OUR instruments a seat actually used in a turn (operator,
// 2026-09-23): rtk, codegraph, rg, ast-grep, memoryctl, the scout script and our
// MCP servers, beside the provider's built-in read/grep/edit and every other
// shell program. A seat that runs `grep` and `cat` where the contract says `rtk`
// and codegraph shows it here, and the operator asks it why.
//
// A tool event is what the provider reports (ops/orchestrator/src/providers):
// claude `Bash`/`Read`/`mcp__server__tool`, codex `commandExecution`/`mcpToolCall`/
// `fileChange`, Pi `bash`/`read`/`mcp` (server in args), ACP a title with rawInput.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { invocations, split } from './seat-guard.ts';

/** Our instruments, in the order the dashboard shows them. */
export const INSTRUMENTS = ['rtk', 'codegraph', 'rg', 'ast-grep', 'memoryctl', 'scout'] as const;

const SHELL_TOOLS = new Set(['bash', 'shell', 'commandexecution', 'exec_command', 'local_shell', 'local_shell_call', 'run_shell_command', 'execute']);
const PROGRAM_ALIAS: Record<string, string> = { sg: 'ast-grep', 'scout.sh': 'scout' };
// scout: a seat's scout_request (Pi direct tool, or the seat MCP server `scout` on native seats) lights the scout badge.
const MCP_ALIAS: Record<string, string> = { codegraph: 'codegraph', memoryctl: 'memoryctl', memory: 'memoryctl', scout: 'scout' };
const BUILTIN_ALIAS: Record<string, string> = {
  read: 'read', view: 'read', grep: 'grep', glob: 'glob', find: 'find', ls: 'ls',
  edit: 'edit', multiedit: 'edit', write: 'edit', apply_patch: 'edit', filechange: 'edit', notebookedit: 'edit',
  websearch: 'web', webfetch: 'web', web_search: 'web', agent: 'subagent', task: 'subagent',
};
/** Shell words that start no program of their own. */
const SKIP_WORDS = new Set(['cd', 'echo', 'printf', 'export', 'set', 'true', 'false', 'test', '[', '[[', 'for', 'while', 'if', 'then', 'do', 'done', 'else', 'elif', 'fi', 'case', 'esac', 'in', '{', '}', '(', ')']);
const PREFIX_WORDS = new Set(['exec', 'then', 'do', 'else']);

function program(word: string): string {
  const base = path.basename(word.replace(/^["'`]+|["'`]+$/g, ''));
  return PROGRAM_ALIAS[base] ?? base;
}

/**
 * A command line cut at `&&`, `||`, `;`, `|`, newlines and `$(` — but only outside quotes, and with
 * heredoc bodies dropped: a `node -e '…'` or `python3 <<EOF` body is data, not commands (the
 * first live board, 2026-09-23, showed `function`, `import` and `const` as shell programs).
 */
function segments(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  const lines = command.split('\n');
  for (let l = 0; l < lines.length; l += 1) {
    const line = lines[l];
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        if (ch === '\\' && quote === '"') { current += ch + (line[i + 1] ?? ''); i += 1; continue; }
        if (ch === quote) quote = null;
        current += ch;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
      const two = line.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '$(') { out.push(current); current = ''; i += 1; continue; }
      if (ch === ';' || ch === '|') { out.push(current); current = ''; continue; }
      current += ch;
    }
    if (quote) { current += '\n'; continue; }
    // A heredoc: skip its body up to the delimiter line.
    const heredoc = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    out.push(current);
    current = '';
    if (heredoc) {
      while (l + 1 < lines.length && lines[l + 1].trim() !== heredoc[1]) l += 1;
      l += 1;
    }
  }
  out.push(current);
  return out;
}

/** The programs one shell command line starts, in order; `rtk <cmd>` yields both rtk and cmd. */
export function shellPrograms(command: string): string[] {
  const found: string[] = [];
  for (const segment of segments(command)) {
    const words = split(segment.trim().replace(/^[({!]+\s*/, ''))?.[0] ?? [];
    while (words.length && (PREFIX_WORDS.has(words[0]) || /^-/.test(words[0]))) words.shift();
    if (!words.length || SKIP_WORDS.has(words[0])) continue;
    // The guard owns wrapper/option parsing. The board also credits rtk itself,
    // but rtk proxy (and 1.0.1's canonical name `bypass`) deliberately receives
    // no inner-program badge: it filters nothing.
    const runs = invocations(words, (name, sub) => {
      if (name === 'rtk') { found.push('rtk'); return sub !== 'proxy' && sub !== 'bypass'; }
      if (name === 'npm') { found.push('npm'); return false; }
      return true;
    });
    for (const run of runs) {
      let name = program(run[0]);
      if (SKIP_WORDS.has(name)) continue;
      // Shell -c payloads are already traversed by invocations; PowerShell is not.
      if (['bash', 'sh', 'zsh', 'pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'].includes(name)) {
        const flag = run.findIndex((word) => /^-(l?c|lc|Command|c)$/i.test(word));
        if (flag >= 0) {
          if (['bash', 'sh', 'zsh'].includes(name)) continue;
          found.push(...shellPrograms(run.slice(flag + 1).join(' ')));
          continue;
        }
        if (run[1] && !run[1].startsWith('-')) name = program(run[1]);
      }
      if (/^[A-Za-z0-9._+-]{1,32}$/.test(name)) found.push(name);
    }
  }
  return found;
}

/** ACP (grok) hands rawInput over as a JSON string; the other providers as an object. */
function object(args: unknown): Record<string, unknown> | null {
  if (typeof args === 'string') {
    try { const parsed = JSON.parse(args); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
  }
  return args && typeof args === 'object' ? args as Record<string, unknown> : null;
}

function commandOf(input: unknown): string | null {
  const args = object(input);
  const value = args?.command ?? args?.cmd;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value.join(' ');
  return null;
}

/** The MCP server a call went to, or null. */
function mcpServer(name: string, input: unknown): string | null {
  const a = object(input) ?? {};
  const named = /^mcp__([^_]+(?:_[^_]+)*?)(?:__|$)/.exec(name);
  if (named) return named[1];
  // grok's ACP: a `use_tool` call whose rawInput names `server__tool`.
  if (typeof a.tool_name === 'string' && a.tool_name.includes('__')) return a.tool_name.split('__')[0];
  if (name === 'mcp' || name === 'mcpToolCall') {
    const server = a.server ?? a.connect;
    if (typeof server === 'string') return server;
    // Pi's mcp proxy often names only the tool, `<server>_<tool>` (codegraph_explore, memoryctl_memory).
    if (typeof a.tool === 'string' && a.tool.includes('_')) return a.tool.split('_')[0];
    return 'mcp';
  }
  return null;
}

/** The badge keys one tool call counts toward. */
export function toolKinds(name: string, args?: unknown): string[] {
  const command = commandOf(args);
  if (command !== null || SHELL_TOOLS.has(name.toLowerCase())) {
    const kinds = ['shell'];
    for (const found of new Set(shellPrograms(command ?? ''))) {
      kinds.push((INSTRUMENTS as readonly string[]).includes(found) ? found : `sh:${found}`);
    }
    return kinds;
  }
  const server = mcpServer(name, args);
  if (server !== null) {
    const kinds = [MCP_ALIAS[server] ?? `mcp:${server}`];
    // A lead's scout is an orch scout seat now, not only `scout.sh` (operator, 2026-09-23).
    const a = object(args) ?? {};
    const role = a.role ?? object(a.arguments)?.role;
    if (server === 'orch' && /seat_create$/.test(name + (typeof a.tool === 'string' ? a.tool : '')) && (role === 'scout' || role === 'critic')) kinds.push('scout');
    return kinds;
  }
  // pi-mcp-adapter direct tools (installer `directTools`): `codegraph_explore`, `memoryctl_memory`.
  const direct = /^([a-z]+)_/.exec(name)?.[1];
  if (direct && Object.hasOwn(MCP_ALIAS, direct)) return [MCP_ALIAS[direct]];
  const builtin = BUILTIN_ALIAS[name.toLowerCase()];
  return [builtin ?? `tool:${name.slice(0, 32)}`];
}

/** A read of a routed domain page (not a write or merely mentioning a page in a prompt). */
export function knowledgeRead(name: string, args?: unknown): boolean {
  const a = object(args);
  if (commandOf(args) === null && BUILTIN_ALIAS[name.toLowerCase()] !== 'read') return false;
  const text = [a?.path, a?.file_path, a?.filePath, commandOf(args)].filter((value) => typeof value === 'string').join('\n');
  return /\.agents[\\/]domains[\\/]domain-[a-z0-9-]+[\\/]knowledge\.md\b/.test(text);
}

/** The skills a call read: a read of `.agents/skills/<name>/SKILL.md`, by a read tool or a shell reader. */
export function skillReads(name: string, args?: unknown): string[] {
  const a = object(args);
  const text = [a?.path, a?.file_path, a?.filePath, commandOf(args)].filter((value) => typeof value === 'string').join('\n');
  if (!text) return [];
  if (commandOf(args) === null && BUILTIN_ALIAS[name.toLowerCase()] !== 'read') return [];
  return [...new Set([...text.matchAll(/skills[\\/]([a-z0-9]+(?:-[a-z0-9]+)*)[\\/]SKILL\.md/g)].map((match) => match[1]))];
}

export function countTool(counts: Record<string, number>, name: string, args?: unknown): void {
  for (const kind of [...toolKinds(name, args), ...skillReads(name, args).map((skill) => `skill:${skill}`), ...(knowledgeRead(name, args) ? ['knowledge'] : [])]) counts[kind] = (counts[kind] ?? 0) + 1;
}

/**
 * rtk's own registry is the only judge (operator, 2026-09-23, #10523): `rtk rewrite`
 * answers with a different command exactly when a part of this one should have gone
 * through rtk; a command it already rewrote comes back unchanged, and one outside
 * its registry gets no answer.
 */
function rtkRewrote(stdout: unknown, command: string): boolean {
  const rewritten = typeof stdout === 'string' ? stdout.trim().split('\n').filter((line) => !line.startsWith('[rtk]')).join('\n').trim() : '';
  return rewritten !== '' && rewritten !== command.trim();
}

/** A spawn that never reached rtk: no verdict, so nothing worth remembering. */
function rtkUnreachable(error: { code?: string | number | null } | null): boolean {
  return error?.code === 'ENOENT' || error?.code === 'EACCES';
}

/**
 * The verdicts rtk gave, memoised per (rtk, command) so a refresh asks nothing
 * twice (review 2026-09-23: 1,000 spawnSync calls in leadTools blocked the
 * daemon's loop for 10 s). Bounded: the oldest verdict goes when it is full.
 */
const RTK_MEMO_MAX = 4096;
/** At most this many `rtk rewrite` processes at once; the rest wait in a queue. */
const RTK_CONCURRENCY = 4;
const rtkMemo = new Map<string, boolean>();
const rtkFlight = new Map<string, Promise<boolean | null>>();
const rtkQueue: Array<() => void> = [];
let rtkRunning = 0;

function rtkPump(): void {
  while (rtkRunning < RTK_CONCURRENCY) {
    const start = rtkQueue.shift();
    if (!start) return;
    rtkRunning += 1;
    start();
  }
}

/**
 * What rtk's registry says about one command, resolved later and never blocking
 * the event loop. A missing rtk counts as no miss and is not memoised, so the
 * next refresh judges again once it is reachable. A killed or timed-out rewrite
 * may have printed half an answer (qwen review): it resolves null, no verdict, and
 * is not memoised, so a load spike does not fix a routed call as unrouted until
 * the daemon restarts (task 2771).
 */
export function rtkRewrites(command: string, rtk = 'rtk'): Promise<boolean | null> {
  // A NUL byte cannot be a process argument: execFile throws synchronously, out of
  // rtkPump with a slot taken, and the daemon died on it (task 1630). No verdict.
  if (command.includes('\u0000')) return Promise.resolve(false);
  const key = `${rtk}\u0000${command}`;
  const memo = rtkMemo.get(key);
  if (memo !== undefined) return Promise.resolve(memo);
  const flight = rtkFlight.get(key);
  if (flight) return flight;
  const promise = new Promise<boolean | null>((resolve) => {
    rtkQueue.push(() => {
      execFile(rtk, ['rewrite', command], { timeout: 2000, encoding: 'utf8' }, (error, stdout) => {
        rtkRunning -= 1;
        rtkPump();
        if (error && (error.killed || error.signal)) { resolve(null); return; }
        const verdict = rtkRewrote(stdout, command);
        if (!rtkUnreachable(error)) {
          if (!rtkMemo.has(key) && rtkMemo.size >= RTK_MEMO_MAX) rtkMemo.delete(rtkMemo.keys().next().value!);
          rtkMemo.set(key, verdict);
        }
        resolve(verdict);
      });
    });
    rtkPump();
  });
  rtkFlight.set(key, promise);
  void promise.then(() => { if (rtkFlight.get(key) === promise) rtkFlight.delete(key); });
  return promise;
}

/**
 * The rtk verdict for a tool call without blocking the caller: `known` is the
 * memoised verdict, or null with `evaluate` resolving it later, so the caller
 * can report the call as pending meanwhile — pending is neither a miss nor a
 * zero. `evaluate` resolves null when rtk gave no verdict (killed, timed out):
 * the call is still pending. Both are null when the call is not a shell call,
 * or has no command.
 */
export function rtkVerdict(name: string, args: unknown, rtk = 'rtk'): { known: boolean | null; evaluate: (() => Promise<boolean | null>) | null } {
  const none = { known: null, evaluate: null };
  const command = commandOf(args);
  if (command === null && !SHELL_TOOLS.has(name.toLowerCase())) return none;
  if (!command || !command.trim()) return none;
  const memo = rtkMemo.get(`${rtk}\u0000${command}`);
  return memo === undefined ? { known: null, evaluate: () => rtkRewrites(command, rtk) } : { known: memo, evaluate: null };
}

/**
 * Whether rtk's registry would have rewritten a seat's shell call. Resolves null when
 * rtk gave no verdict (killed, timed out): an unjudged call, never a silent "no miss"
 * (task 2772).
 */
export function rtkMissed(name: string, args: unknown, rtk = 'rtk'): Promise<boolean | null> | null {
  const command = commandOf(args);
  if (command === null && !SHELL_TOOLS.has(name.toLowerCase())) return null;
  if (!command || !command.trim()) return null;
  // execFile throws on a NUL byte; the unhandled rejection killed the daemon (task 1630).
  if (command.includes('\u0000')) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(rtk, ['rewrite', command], { timeout: 2000, encoding: 'utf8' }, (error, stdout) => {
      // A timed-out or killed rewrite may have printed half an answer: no verdict (qwen review).
      if (error && (error.killed || error.signal)) { resolve(null); return; }
      resolve(rtkRewrote(stdout, command));
    });
  });
}

/**
 * Whether a seat's harness rewrites its shell commands through rtk's PreToolUse
 * hook between the model and the stream: the native claude-family runtimes
 * (claude, glm), whose settings the installer wires with `rtk hook claude`
 * (install-harness.mjs JSON_HOOK_TARGETS). Their stream-json tool_use carries
 * the model's command BEFORE the rewrite (claude.ts emits block.input as-is),
 * so a registry match there (`rtk rewrite`, the hook's own single source of
 * truth) is routing the hook already did — rtk usage, not a miss. Pi reports
 * the post-rtk command instead (pi.ts reads `details.orchCommand`), so a bare
 * command in its stream ran bare and stays a real miss; an unknown harness is
 * no hook either, keeping misses visible. Codex's own hook is untrusted until
 * codex records its hash, so native codex keeps counting its misses.
 */
export function rtkHookRewrites(family: string, harness: unknown): boolean {
  return (family === 'claude' || family === 'glm') && harness === 'native';
}
