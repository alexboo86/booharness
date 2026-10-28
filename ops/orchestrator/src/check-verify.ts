/** Command recognition for Pi's post-mutation check loop; report checks are not rerun. */
import { realpathSync } from 'node:fs';
import path from 'node:path';

/** The reported check fields read here; report.ts validates the shape. */
type ClaimedCheck = { command: string; result: string };

/** A check command as claims are matched: control characters folded, one trailing (…)/[…] note dropped. */
export function checkCommand(raw: string): string {
  // A seat-written command must not split the digest.
  // eslint-disable-next-line no-control-regex -- the control characters are the subject of the match
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()
    .replace(/\s+(?:\[[^[\]]+\]|\([^()]+\))$/, '');
}

/** Read only reported results; the last reported entry for each normalized command decides its claim. */
export function lastCheckResults(report: Record<string, unknown> | null): Map<string, string> {
  const results = new Map<string, string>();
  for (const check of (report?.checks ?? []) as ClaimedCheck[]) results.set(checkCommand(check.command), check.result);
  return results;
}

/** Why a command is not recognized as a check. */
type Refusal = { refused: string };
type Recognition = Record<string, never> | Refusal;
const NOT_ALLOWED: Refusal = { refused: 'not allow-listed' };

/** Refuse shell syntax and quotes except the punctuation in a validated Node test-pattern argv. */
const SHELL_CHARS = /[|&;<>`$(){}\\'"*?~!#\n\r]/;
const CRATE = /^[A-Za-z0-9_-]+$/;

/**
 * Whitespace tokenisation cannot preserve quoted patterns: accept only the no-space = form.
 * Pattern punctuation is safe only in this validated argv, never in a shell or a file argument.
 */
function nodeTestWords(command: string): string[] | undefined {
  if (/[\n\r]/.test(command)) return;
  let words = command.trim().split(/\s+/);
  // `bypass` is 1.0.1's canonical name for `proxy` (a silent alias): both peel.
  if (words[0] === 'rtk') words = words.slice(words[1] === 'proxy' || words[1] === 'bypass' ? 2 : 1);
  if (words[0] !== 'node' || words[1] !== '--test' || words.length < 3) return;
  const file = words[words.length - 1];
  if (file.startsWith('-') || SHELL_CHARS.test(file)) return;
  const seen = new Set<string>();
  for (const flag of words.slice(2, -1)) {
    let key: string;
    if (/^--test-timeout=\d{1,7}$/.test(flag)) key = '--test-timeout';
    else if (flag === '--test-force-exit') key = flag;
    else if (/^--test-name-pattern=[A-Za-z0-9_.:,()#-]+$/.test(flag)) key = '--test-name-pattern';
    else return;
    if (seen.has(key)) return;
    seen.add(key);
  }
  return words;
}

/**
 * A repo-relative path whose real location, every symlink followed, sits inside the real worktree
 * root; else why not. A link inside the tree to a script outside it would otherwise run that script.
 */
function confine(root: string, file: string): string | Refusal {
  if (!file || file.startsWith('-') || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return NOT_ALLOWED;
  let real: string;
  try { real = realpathSync(path.resolve(root, file)); } catch { return { refused: `path does not exist: ${file}` }; }
  return real === root || real.startsWith(root + path.sep) ? file : { refused: `path escapes the worktree: ${file}` };
}

/**
 * Recognize an allow-listed command as an empty object, or explain its refusal; no execution plan.
 * A leading `rtk` (and its silent-alias pair `rtk proxy`/`rtk bypass`) is dropped: it only filters output.
 */
export function planCheck(worktree: string, command: string, remote?: { root: string; paths: Record<string, string | null>; platform: NodeJS.Platform }): Recognition {
  const testWords = nodeTestWords(command);
  if (SHELL_CHARS.test(command) && !testWords) return NOT_ALLOWED;
  // Remote paths are resolved by node in the host checkout, not by the unprovisioned Mac mirror.
  let root: string;
  try { root = remote?.root ?? realpathSync(path.resolve(worktree)); } catch { return { refused: 'worktree does not exist' }; }
  const confined = (file: string): string | Refusal => {
    if (!remote) return confine(root, file);
    if (!file || file.startsWith('-') || (remote.platform === 'win32' ? path.win32 : path.posix).isAbsolute(file) || file.split(/[\\/]/).includes('..')) return NOT_ALLOWED;
    const real = remote.paths[file];
    if (real === undefined || real === null) return { refused: `path does not exist: ${file}` };
    const normal = (s: string) => remote.platform === 'win32' ? s.replaceAll('\\', '/').toLowerCase() : s;
    return normal(real) === normal(root) || normal(real).startsWith(normal(root).replace(/\/$/, '') + '/')
      ? file : { refused: `path escapes the worktree: ${file}` };
  };
  let words = command.trim().split(/\s+/);
  if (words[0] === 'rtk') words = words.slice(words[1] === 'proxy' || words[1] === 'bypass' ? 2 : 1);
  const [head, ...rest] = words;
  const at = (i: number) => rest[i] ?? '';
  const on = (arg: string, recognize: () => Recognition = () => ({})): Recognition => {
    const file = confined(arg);
    return typeof file === 'string' ? recognize() : file;
  };
  if (testWords) return on(testWords[testWords.length - 1]);
  if (head === 'node') {
    if (rest.length === 2 && at(0) === '--check') return on(at(1));
    if (rest.length === 1 && /^scripts\/(?:check|test)-[^/]+\.mjs$/.test(at(0))) return on(at(0));
    return NOT_ALLOWED;
  }
  // Recognition still requires the worktree's confined tool, never a registry fallback.
  // Check .bin locally; a remote Windows tool uses its package's JS entry, not a shim.
  const local = (tool: 'tsc' | 'eslint' | 'vitest'): Recognition => {
    const bin = confined(remote?.platform === 'win32'
      ? `node_modules/${tool === 'tsc' ? 'typescript/bin/tsc' : tool === 'eslint' ? 'eslint/bin/eslint.js' : 'vitest/vitest.mjs'}`
      : `node_modules/.bin/${tool}`);
    if (typeof bin !== 'string') return bin.refused.startsWith('path does not exist') ? { refused: `node_modules/.bin/${tool} missing` } : bin;
    return {};
  };
  if (head === 'npm' && rest.length === 2 && at(0) === 'run' && at(1) === 'lint')
    return local('eslint');
  if (head === 'npx') {
    if (rest.length === 4 && at(0) === 'tsc' && at(1) === '--noEmit' && at(2) === '-p')
      return on(at(3), () => local('tsc'));
    if (rest.length === 2 && at(0) === 'eslint' && at(1) === '.') return local('eslint');
    if (rest.length === 3 && at(0) === 'vitest' && at(1) === 'run')
      return on(at(2), () => local('vitest'));
    return NOT_ALLOWED;
  }
  if (head === 'cargo' && rest.length === 3 && at(0) === 'check' && at(1) === '-p' && CRATE.test(at(2)))
    return {};
  return NOT_ALLOWED;
}
