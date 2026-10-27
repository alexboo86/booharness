// Shared RTK rewrite layer: upstream `rtk rewrite` first, then a conservative
// compound/reader/ssh pass the upstream binary (0.44.0, measured 2026-07-28)
// does not cover:
//   - `cd X && sed -n '1,50p' f | head -60`  -> upstream returns nothing
//   - `sed`/`awk` standalone                  -> unmapped, raw output to context
//   - `ssh host 'cargo test'` inside a compound -> unmapped there
//
// Rules (token flow, not cosmetics):
//   - In `&&` / `;` / `||` chains every command's output reaches the context,
//     so every chain element is rewritten independently.
//   - In a pipeline only the LAST stage's output reaches the context, so only
//     the last stage is prefixed; earlier stages feed the next stage and
//     filtering them would corrupt the data mid-pipe.
//   - A segment with a redirection (`>`, `<`) moves data to/from files; an RTK
//     filter there would corrupt the written data. Left raw, always.
//   - Substitutions ($(), backticks, <() >()), here-docs and newlines make the
//     top-level split unsound; the whole command is left to upstream verbatim.
//
// Coverage is deliberately NARROW (operator, 2026-07-31): on providers where
// the guard cannot rewrite (kimi; grok could not either until its updatedInput
// support was measured on 2026-09-14), every rewrite used to cost a full
// extra turn, so self-bounding readers (`head`/`tail`/`wc` — their output is
// small BY DESIGN) and low-volume filters (`cut`/`tr`/`sort`/`uniq`/`column`/
// `strings`/`nl`) pass through raw. Only filters whose output is genuinely
// unbounded stay covered: grep/rg/sed/awk/cat, plus the heavy classes (git,
// cargo, tsc, tests, ssh, big reads) where the measured savings live. Since
// 2026-07-31 rtk routing is WARN-ONLY where it cannot rewrite: this library
// computes the rewrite, the hook decides what to do with it.
//
// Pure logic + injectable upstream so it is testable without the binary.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/// `bash -lc "sed ..."` is a `sed` call wearing a coat - unwrap to the command.
export function unwrapShell(text) {
  const match = text
    .trim()
    .match(/^(?:bash|sh|zsh|pwsh|powershell)\s+(?:-[a-zA-Z]+\s+)*(['"])([\s\S]+)\1\s*$/);
  return match ? unwrapShell(match[2]) : text;
}

// Pure output filters: safe to run under `rtk <name>` passthrough, stdin-safe
// (measured: `printf .. | rtk sed/grep` all pass stdin through). Only filters
// with genuinely UNBOUNDED output stay here — see the header note on narrow
// coverage. head/tail/wc are self-bounding; cut/tr/sort/uniq/column/strings/
// nl are low-volume: rewriting them bought a denied turn for nothing.
const READER_FILTERS = new Set(['sed', 'awk', 'cat', 'grep', 'rg']);

// Self-bounding readers: output is small by design, so we decline even an
// upstream rewrite (rtk 0.44.0 maps `head -50 f` -> `rtk read f --max-lines
// 50`) — accepting it would still cost a deny-turn on guard-only providers.
// Readers whose own flags already bound the output. The question for these is
// not whether to route them but WHAT the answer runs: `wc -l x` -> `rtk wc -l x`
// keeps the program and changes nothing the caller sees, while `head -80 x` ->
// `rtk read x --max-lines 80` swaps in a different reader with a different
// output shape. substitutesReader() below draws that line; the set only says
// where to ask the question.
//
// It used to be a blanket decline for all three, justified by "accepting would
// cost a deny-turn for zero savings". Deny ended 2026-07-31 and took the
// justification with it. Measured 2026-08-05 over the 1200 most frequent
// commands in rtk's history db: the blanket decline was throwing away 29 pure
// routing rewrites (all `wc`) to avoid 2 substitutions.
const BOUNDED_READERS = new Set(['head', 'tail', 'wc']);

// The subcommands the binary RECOGNISES (rtk 0.44.1, `rtk --help`). A rewrite
// whose first word after `rtk` is missing here is not a rewrite at all: rtk
// answers `unrecognized subcommand`, falls back to running the command raw, and
// records a parse_failure. Measured 2026-08-02 on the live history db: 244 of
// 938 tracked commands (26%) were exactly that - `rtk du`, `rtk sed`,
// `rtk stat`, `rtk node`, `rtk powershell`, `rtk memoryctl` - each an extra
// process spawn for zero saved tokens, and each one polluting the savings
// average that the operator reads as "RTK efficiency". Upstream `rtk rewrite`
// produces most of them; this library produced the rest, by prefixing `sed`,
// `awk`, `cat` and `ssh`, none of which the binary implements.
//
// This set answers RECOGNITION only, never desirability - whether a recognised
// rewrite is a GOOD one stays upstream's judgment, as it was before.
//
// Pinned rather than queried: asking the binary would cost a spawn per hook
// call on the hot path. test-rtk-rewrite-plus.mjs diffs this set against
// `rtk --help`, so a version that adds a filter fails a test instead of
// silently going unused.
// Read from the file rather than written here, because a SECOND reader arrived:
// grok is forced to route only by `--deny 'Bash(<cmd> *)'` (measured 2026-08-07;
// `--allow` forbids nothing), and that list is built by the Rust adapter that
// launches the member. Two executors of one rule is a rule with two definitions
// - the same shape three review seats struck `skill_bundle_path` for on the same
// day - so the definition is `rtk-commands.json` and both sides read it.
export const RTK_COMMANDS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'rtk-commands.json'), 'utf8'),
);

export const RTK_SUBCOMMANDS = new Set(RTK_COMMANDS.subcommands);

/// The bare commands a member must be REFUSED so that it routes through rtk.
///
/// A subset of the above, and it has to be: denying a command rtk cannot filter
/// leaves the member unable to run it by any route at all. The gate that holds
/// the two together lives in test-rtk-rewrite-plus.mjs and in the Rust adapter's
/// own test - both sides check it, because both sides act on it.
export const RTK_MANAGED_SHELL_COMMANDS = new Set(RTK_COMMANDS.managedShellCommands);

// The built-in set is NOT the whole story: a project may declare its own
// filters in `.rtk/filters.toml`, and rtk dispatches those by name exactly like
// a built-in. This repository declares `[filters.ssh]` - which is why `rtk ssh`
// filters real server-log output and must keep being emitted, even though
// `ssh` is absent from `rtk --help`. Resolved against the CWD, the same place
// rtk itself looks, so a Paseo worktree gets its own snapshot's filters.
let filterCache = null;

function projectFilterNames() {
  const path = join(process.cwd(), '.rtk', 'filters.toml');
  let stamp;
  try {
    const stat = statSync(path);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    filterCache = { path, stamp: null, names: new Set() };
    return filterCache.names;
  }
  if (filterCache && filterCache.path === path && filterCache.stamp === stamp) {
    return filterCache.names;
  }
  const names = new Set();
  try {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/^\s*\[filters\.([A-Za-z0-9_-]+)\]/gm)) {
      names.add(match[1]);
    }
  } catch {
    /* unreadable filters file simply contributes nothing */
  }
  filterCache = { path, stamp, names };
  return names;
}

/// True when `candidate` is an rtk invocation rtk can actually dispatch —
/// either a built-in subcommand or a project-declared filter. Anything else
/// must be declined, so the ORIGINAL command runs untouched.
function targetsKnownSubcommand(candidate) {
  const match = stripEnvPrefix(String(candidate).trim()).match(/^rtk(?:\.exe)?\s+([A-Za-z0-9_-]+)/);
  if (!match) return false;
  return RTK_SUBCOMMANDS.has(match[1]) || projectFilterNames().has(match[1]);
}

/// Drop a leading `env` / `VAR=value` run so the rtk invocation behind it can be
/// judged.
///
/// The gate above anchored at `^rtk`, so upstream's own correct answer for
/// `env CARGO_TARGET_DIR=… cargo test …` — which necessarily keeps the
/// assignment in front — read as "not an rtk call" and was thrown away.
/// Measured 2026-08-05 over the 300 most frequent commands in rtk's history db:
/// one of only two shapes where the binary rewrote and we declined, and it is
/// `cargo test`, the category that saves 85-97%.
///
/// ONLY assignments and `env` are skipped. Anything else in command position —
/// `sudo`, a wrapper script — still fails the gate, because there the rtk call
/// is not the thing being run and the answer is not ours to trust.
function stripEnvPrefix(text) {
  let rest = text;
  for (;;) {
    const next = rest.replace(/^(?:env\s+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)/, '');
    if (next === rest) return rest;
    rest = next;
  }
}

/// True when the answer runs a DIFFERENT reader than the caller asked for.
///
/// Only asked about BOUNDED_READERS, where the caller has already said how much
/// output it wants. Routing that same program through rtk is free; replacing it
/// with `rtk read` changes the output the caller reasoned about, and no token
/// saving is on offer either way because the bound was already there.
function substitutesReader(command, answer) {
  const program = firstWord(stripEnvPrefix(String(command).trim()));
  if (!BOUNDED_READERS.has(program)) return false;
  const match = stripEnvPrefix(String(answer).trim()).match(/^rtk(?:\.exe)?\s+([A-Za-z0-9_-]+)/);
  return !match || match[1] !== program;
}

/// The same question for a bare verb we are about to prefix ourselves.
function rtkCanDispatch(word) {
  return RTK_SUBCOMMANDS.has(word) || projectFilterNames().has(word);
}

/// `rtk <verb>` where rtk cannot dispatch <verb> — repair it into `rtk proxy
/// <verb>`, which it can.
///
/// Not a hypothetical. A Paseo member's `--allowedTools` is `Bash(rtk *)`, so it
/// CANNOT type a bare command even when the bare command is the right one: it
/// writes `rtk node --test x`, rtk answers `unrecognized subcommand`, and every
/// such call lands in parse_failures. Measured 2026-08-02 on a freshly reset
/// database: 6 of 6 failures were exactly this, all from one member during a
/// coding round. The gate that declines OUR prefixing cannot help there, because
/// the model types the command, not the hook.
///
/// `proxy` is a real subcommand that runs anything unfiltered while still
/// recording usage, so the member keeps its permission, rtk keeps its bookkeeping,
/// and the failure row stops being written.
/// The mirror of `proxyUndispatchable`, for a caller that is NOT caged.
///
/// `rtk proxy <x>` exists because a Paseo member's `--allowedTools` is
/// `Bash(rtk *)` — it cannot type a bare command even when the bare one is
/// right. Codex is under no such rule (its adapter passes no allowlist), so the
/// same repair there is a process hop that saves nothing and records a 0% row.
/// Measured 2026-08-05: codex typed `rtk powershell …` 8 and 9 times in two live
/// rollouts, and 53 of 105 member calls reached rtk through `proxy` at 0%.
///
/// So for that caller the correction runs the other way: strip the `rtk` (and an
/// explicit `proxy`) from a call rtk cannot dispatch, and let the bare command
/// run. What rtk really filters is left exactly as typed.
/// @returns {string|null} the unwrapped command, or null when nothing to undo
export function unwrapUndispatchable(rawCommand) {
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) return null;
  let changed = false;
  const rebuilt = splitTopLevel(unwrapShell(rawCommand), ['&&', '||', ';'])
    .map(({ part, sep }) => {
      const piped = splitTopLevel(part, ['|'])
        .map((stage) => {
          const bare = bareUndispatchable(stage.part);
          if (bare === null) return stage.part + stage.sep;
          changed = true;
          return bare + stage.sep;
        })
        .join('');
      return piped + sep;
    })
    .join('');
  return changed ? rebuilt : null;
}

/// `rtk <verb rtk cannot dispatch> …` -> `<verb> …`; anything else -> null.
function bareUndispatchable(segment) {
  const trimmed = segment.trim();
  // `bypass` is 1.0.1's canonical name; `proxy` its silent alias. Both coats
  // are stripped here so the unwrap treats one name exactly like the other.
  const match = trimmed.match(/^(rtk(?:\.exe)?)\s+(?:(proxy|bypass)\s+)?([A-Za-z0-9][A-Za-z0-9_.:-]*)(?:\s|$)/);
  if (!match) return null;
  // An explicit `rtk proxy x` is the same over-application, one word longer.
  if (!match[2] && rtkCanDispatch(match[3])) return null;
  const leading = segment.match(/^\s*/)[0];
  const head = match[2] ? `${match[1]} ${match[2]}` : match[1];
  return `${leading}${trimmed.slice(head.length).trim()}`;
}

function proxyUndispatchable(segment) {
  const trimmed = segment.trim();
  // A verb, not a flag: `rtk --version` is rtk's own business and stays untouched.
  const match = trimmed.match(/^(rtk(?:\.exe)?)\s+([A-Za-z0-9][A-Za-z0-9_.:-]*)(?:\s|$)/);
  if (!match) return null;
  if (rtkCanDispatch(match[2])) return null;
  const leading = segment.match(/^\s*/)[0];
  // Still the `proxy` spelling, not 1.0.1's canonical `bypass`: the alias is
  // silent and identical in behaviour (upstream test_proxy_is_a_silent_alias_
  // for_bypass at v1.0.1), and `proxy` also dispatches on machines still on
  // 0.51.0 while the pinned 1.0.1 install rolls out.
  return `${leading}${match[1]} proxy ${trimmed.slice(match[1].length).trim()}`;
}

// NEVER spawn through a shell here: with shell:true a `|` or quotes inside the
// command string EXECUTE in that shell (caught live 2026-07-28 - the hook fed
// rtk's usage text back as the "rewritten" command). Windows needs the .exe
// name for a shell-less spawn, so both are tried.
const RTK_CANDIDATES = process.env.RTK_BIN
  ? [process.env.RTK_BIN]
  : process.platform === 'win32'
    ? ['rtk.exe', 'rtk']
    : ['rtk'];

export function defaultUpstreamRewrite(command) {
  for (const rtk of RTK_CANDIDATES) {
    try {
      const answer = spawnSync(rtk, ['rewrite', command], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      if (answer.error) continue;
      // stdout is the signal, not the exit code (measured on rtk 0.44.0), but
      // it is POLLUTED: the binary prepends nag lines ("[rtk] /!\ No hook
      // installed...", "Patch existing ... [y/N]", "(non-interactive mode...")
      // when its native hook line is absent from settings. Keep only real
      // rewrite content; a rewrite is exactly one line.
      const lines = ((answer && answer.stdout) || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(
          (line) =>
            line &&
            !line.startsWith('[rtk]') &&
            !line.startsWith('Patch existing') &&
            !line.startsWith('(non-interactive')
        );
      if (lines.length !== 1) return null;
      const out = lines[0];
      return out && out !== command ? out : null;
    } catch {
      continue;
    }
  }
  return null;
}

/// Split `text` on top-level occurrences of the given multi-char operators,
/// respecting single/double quotes and backslash escapes. Returns
/// [{part, sep}] where sep is the operator FOLLOWING the part ('' for last).
///
/// `export` since task 611: `code-intel-order-hook.mjs` was splitting commands
/// with `command.split(/\||&&|;/)`, which is quote-BLIND, so `grep -E "foo|bar"
/// x.rs` broke into two segments at the `|` inside the pattern and the read
/// walked past the gate. This scanner already answers that question for the rtk
/// hook; a second hand-written one beside it is the class the task names.
/// Longer operators must come FIRST in the list - the scanner takes the first
/// candidate that matches, so `['|', '||']` would read `||` as two pipes.
// Bash executes $(...) and backticks, including inside double quotes, and does
// not execute $((...)). Callers that pass `substitutions` receive each body
// so a gate can judge it like `bash -c`. Arithmetic is skipped, not a body.
// A `#` comment starts only after whitespace or a separator, matching the
// operator scan, so a `)` in a word like foo#bar) still closes.
function isSubstComment(text, i) {
  return text[i] === '#' && (i === 0 || /[\s;&|()]/.test(text[i - 1]));
}
function backtickEnd(text, i) {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\' && j + 1 < text.length) { j += 2; continue; }
    if (text[j] === '`') return j + 1;
    j += 1;
  }
  throw new SyntaxError('Incomplete command substitution');
}
function closeParen(text, open) {
  let depth = 0;
  let quote = null;
  for (let j = open; j < text.length; j += 1) {
    const c = text[j];
    if (quote) {
      if (c === '\\' && quote !== "'" && j + 1 < text.length) { j += 1; continue; }
      if (c === (quote === "$'" ? "'" : quote)) quote = null;
      continue;
    }
    if (c === '\\' && j + 1 < text.length) { j += 1; continue; }
    if (c === '$' && text[j + 1] === "'") { quote = "$'" ; j += 1; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (isSubstComment(text, j)) {
      while (j < text.length && text[j] !== '\n') j += 1;
      continue;
    }
    if (c === '`') { j = backtickEnd(text, j) - 1; continue; }
    if (c === '$' && text[j + 1] === '(') { j = closeParen(text, j + 1) - 1; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  throw new SyntaxError('Incomplete command substitution');
}
function takeSubstitution(text, i, substitutions) {
  if (text[i] === '`') {
    const end = backtickEnd(text, i);
    if (substitutions) substitutions.push(text.slice(i + 1, end - 1));
    return end;
  }
  const end = closeParen(text, i + 1);
  if (substitutions && text[i + 2] !== '(') substitutions.push(text.slice(i + 2, end - 1));
  return end;
}

function matchesOperator(text, i, candidate) {
  if (candidate === '\n') return text[i] === '\n';
  if (!text.startsWith(candidate, i)) return false;
  // Word operators (`in`, `esac`) must not split inside `join` or `input`.
  if (/^[A-Za-z]/.test(candidate)) {
    const before = i === 0 ? '' : text[i - 1];
    const after = text[i + candidate.length];
    const edge = (ch) => ch === undefined || ch === '' || !/[A-Za-z0-9_]/.test(ch);
    return edge(before) && edge(after);
  }
  return true;
}
// An unquoted heredoc expands like a double-quoted word: quotes in the body
// do not suppress $(...) or backticks, and a backslash hides the next byte.
function collectHeredocSubstitutions(body, substitutions) {
  let i = 0;
  while (i < body.length) {
    if (body[i] === '\\' && i + 1 < body.length) { i += 2; continue; }
    if (body[i] === '`' || (body[i] === '$' && body[i + 1] === '(')) {
      i = takeSubstitution(body, i, substitutions);
      continue;
    }
    i += 1;
  }
}

export function splitTopLevel(text, operators, { shell = false, substitutions } = {}) {
  const parts = [];
  let current = '';
  let i = 0;
  let quote = null;
  const heredocs = [];
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      // An escape consumes the next byte before a substitution test, so
      // A backslash-dollar or backslash-backtick stays data, not a substitution.
      if (ch === '\\' && (quote === '"' || quote === "$'") && i + 1 < text.length) {
        current += ch + text[i + 1];
        i += 2;
        continue;
      }
      if (shell && quote === '"' && (ch === '`' || (ch === '$' && text[i + 1] === '('))) {
        const end = takeSubstitution(text, i, substitutions);
        current += text.slice(i, end);
        i = end;
        continue;
      }
      current += ch;
      if (ch === (quote[0] === '$' ? "'" : quote)) quote = null;
      i += 1;
      continue;
    }
    if (shell && ch === '#' && (i === 0 || /[\s;&|]/.test(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (shell && ch === '$' && text[i + 1] === "'") {
      quote = "$'";
      current += "$'";
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      current += ch + text[i + 1];
      i += 2;
      continue;
    }
    if (shell && (ch === '`' || (ch === '$' && text[i + 1] === '('))) {
      const end = takeSubstitution(text, i, substitutions);
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (shell && text.startsWith('<<<', i)) {
      // A here-string has an operand, not a following body.
      current += '<<<';
      i += 3;
      continue;
    }
    if (shell && text.startsWith('<<', i)) {
      const start = i;
      i += 2;
      const stripTabs = text[i] === '-';
      if (stripTabs) i += 1;
      while (/[ \t]/.test(text[i] ?? '') && i < text.length) i += 1;
      const wordStart = i;
      let delimiterQuote = null;
      // Read exactly one shell word; quote removal is owned by splitWords.
      // In particular, spaced/escaped delimiters and trailing redirects do not
      // change where the body ends. A here-string cannot register a delimiter.
      while (i < text.length) {
        const c = text[i];
        if (c === '\\' && delimiterQuote !== "'") { i += 2; continue; }
        if (delimiterQuote) {
          if (c === delimiterQuote) delimiterQuote = null;
        } else if (c === "'" || c === '"') delimiterQuote = c;
        else if (/[\s;&|<>]/.test(c)) break;
        i += 1;
      }
      if (i === wordStart || delimiterQuote) throw new SyntaxError('Incomplete heredoc delimiter');
      const delimiter = splitWords(text.slice(wordStart, i), { shell: true })[0];
      if (delimiter === undefined) throw new SyntaxError('Invalid heredoc delimiter');
      const quoted = /['"\\]/.test(text.slice(wordStart, i).replace(/\\\n/g, ''));
      heredocs.push({ delimiter, stripTabs, quoted });
      current += text.slice(start, i);
      continue;
    }
    if (shell && ch === '\n' && heredocs.length) {
      let next = i + 1;
      for (const { delimiter, stripTabs, quoted } of heredocs.splice(0)) {
        const bodyStart = next;
        let lineStart = next;
        let closed = false;
        while (next < text.length) {
          lineStart = next;
          let line = '';
          let continued;
          do {
            const end = text.indexOf('\n', next);
            const stop = end < 0 ? text.length : end;
            const physical = text.slice(next, stop);
            next = end < 0 ? text.length : end + 1;
            // Bash joins an unquoted body's backslash-newline BEFORE testing
            // its delimiter. Quoted bodies keep those bytes literally.
            continued = !quoted && end >= 0 && /(?<!\\)(?:\\\\)*\\$/.test(physical);
            line += continued ? physical.slice(0, -1) : physical;
          } while (continued && next < text.length);
          // A CRLF closer is still the closer: strip one trailing CR before
          // matching, or the body swallows every command after it.
          if ((stripTabs ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === delimiter) {
            closed = true;
            break;
          }
        }
        // Unquoted bodies expand $(...) and backticks. Quoted delimiters stay literal.
        if (!quoted && substitutions) collectHeredocSubstitutions(text.slice(bodyStart, closed ? lineStart : next), substitutions);
      }
      // Neither body nor delimiter goes through the quote/operator scanner.
      // Keep the command-ending newline, then resume at the real command tail.
      i = next - 1;
    }
    // A redirection's ampersand is not a command separator.
    if (shell && ch === '&' && (text[i + 1] === '>' || /[<>]/.test(text[i - 1] ?? ''))) {
      current += ch;
      i += 1;
      continue;
    }
    const op = operators.find((candidate) => matchesOperator(text, i, candidate));
    if (op) {
      parts.push({ part: current, sep: op });
      current = '';
      i += op.length;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (shell && (quote || /(?<!\\)(?:\\\\)*\\$/.test(current))) throw new SyntaxError('Incomplete shell word');
  parts.push({ part: current, sep: '' });
  return parts;
}

/// Split `text` into WORDS at top-level whitespace, with one layer of quoting
/// removed.
///
/// The companion of `splitTopLevel` and the other half of task 611: a hook that
/// splits segments quote-aware and then words with `split(/\s+/)` has only
/// moved the blindness one level down. `pwsh -Command "bash -c \"grep x.rs\""`
/// is three words - the third one a whole command - and only a scanner that
/// knows where the quotes end can say so; the regex hands back five fragments
/// with quote characters glued to them, and the nested reader is never seen.
///
/// A BACKSLASH IS KEPT unless it escapes something a shell would actually
/// escape there, and that rule holds INSIDE double quotes too.
///
/// The commands this reads carry Windows paths, and a scanner that ate every
/// backslash turns one into a word whose basename cannot be found. The first
/// version consumed the slash before ANY character inside double quotes, so
/// `"C:\Users\...\rg.exe" foo x.rs` arrived as one run-together word and the
/// ordering gate went silent for a spelling the regex it replaced had caught —
/// named by three seats of `harness-fixes-review-r1` and reproduced against
/// both scanners. POSIX double quotes escape only `$`, a backtick, `"`, `\`
/// and a newline; everything else is two literal characters, which is exactly
/// what a Windows path needs.
///
/// A NEWLINE is not on this list because it is not escaped to a literal
/// newline: backslash-newline is POSIX LINE CONTINUATION and both characters
/// vanish, inside double quotes and outside them alike. Keeping either one
/// broke the word in the PROGRAM position - `"gr\<newline>ep" foo x.rs` reached
/// the reader as `gr\nep`, so `rg`/`grep` was not recognised and a lone source
/// read walked past the ordering gate. Named by the codex seat of
/// `harness-fixes-review-r2` and reproduced against the live hook: the plain
/// spelling denied, both continuation spellings allowed. Inside SINGLE quotes a
/// backslash is literal and no continuation exists, which the quote branch
/// below already honours by never looking at escapes there.
const DOUBLE_QUOTE_ESCAPES = new Set(['$', '`', '"', '\\']);

/// Backslash-newline: the shell removes both, and so does every branch here.
const isLineContinuation = (text, i) => text[i] === '\\' && text[i + 1] === '\n';

// Opt-in shell mode keeps legacy Windows-path readers unchanged. The gate
// needs shell escapes decoded and redirections separated even without spaces.
export function splitWords(text, { shell = false } = {}) {
  const words = [];
  let current = '';
  let started = false;
  let quote = null;
  let redirectTarget = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === "$'") {
        if (ch === "'") { quote = null; continue; }
        if (ch === '\\' && i + 1 < text.length) {
          const escape = text.slice(i + 1).match(/^(?:x[\da-fA-F]{1,2}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8}|[0-7]{1,3}|c.|.)/s)?.[0];
          const simple = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
          if (/^[xuU]/.test(escape) && escape.length > 1) {
            current += String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
          } else if (/^[0-7]/.test(escape)) {
            current += String.fromCharCode(Number.parseInt(escape, 8) & 255);
          } else if (escape.startsWith('c') && escape.length === 2) {
            current += String.fromCharCode(escape[1].toUpperCase().charCodeAt(0) & 31);
          } else current += simple[escape] ?? `\\${escape}`;
          i += escape.length;
          continue;
        }
        current += ch;
        continue;
      }
      // Double quotes do not stop a line continuation; single quotes do.
      if (quote === '"' && isLineContinuation(text, i)) {
        i += 1;
        continue;
      }
      if (
        ch === '\\'
        && quote === '"'
        && i + 1 < text.length
        && DOUBLE_QUOTE_ESCAPES.has(text[i + 1])
      ) {
        current += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (shell && ch === '#' && !started) break;
    if (shell && ch === '$' && text[i + 1] === "'") {
      quote = "$'";
      started = true;
      i += 1;
      continue;
    }
    if (shell && /[<>]/.test(ch)) {
      // Only unquoted operators are redirects. Consume their target here,
      // while quote provenance is available; a quoted ">" remains data.
      if (started && !redirectTarget && !/^\d+$/.test(current)) words.push(current);
      const op = text.slice(i).match(/^(?:<<<|<<-|>>|<<|<>|>&|<&|>\||>|<)/)[0];
      redirectTarget = true;
      i += op.length - 1;
      current = '';
      started = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      // `started` rather than `current.length`: `grep "" x.rs` has an empty
      // second word that IS a word, and dropping it would shift every operand
      // after it.
      if (started && !redirectTarget) words.push(current);
      if (started) redirectTarget = false;
      current = '';
      started = false;
      continue;
    }
    // Both characters go, and `started` is NOT set: a continuation between two
    // words is not a word. Setting it would push an empty string into `words`
    // and shift every operand after it.
    if (isLineContinuation(text, i)) {
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      current += shell ? text[i + 1] : ch + text[i + 1];
      i += 1;
      started = true;
      continue;
    }
    // Grouping ( ) are control operators even when attached. $(...) and
    // backticks stay one word; splitTopLevel already recorded their bodies.
    if (shell && !redirectTarget && (ch === '`' || (ch === '$' && text[i + 1] === '('))) {
      const end = takeSubstitution(text, i);
      current += text.slice(i, end);
      i = end - 1;
      started = true;
      continue;
    }
    if (shell && !redirectTarget && (ch === '(' || ch === ')')) {
      if (started) words.push(current);
      words.push(ch);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (shell && quote) throw new SyntaxError('Incomplete shell word');
  if (started && !redirectTarget) words.push(current);
  return words;
}

function outsideQuotes(text, predicate) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (predicate(text, i)) return true;
  }
  return false;
}

const UNSAFE = ['$(', '`', '<(', '>(', '<<'];

function hasUnsafeConstruct(command) {
  if (command.includes('\n')) return true;
  // Only single quotes protect from expansion: `"$(...)"` still executes.
  let inSingle = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === '\\' && !inSingle) {
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && UNSAFE.some((token) => command.startsWith(token, i))) {
      return true;
    }
  }
  return false;
}

function hasRedirection(segment) {
  return outsideQuotes(segment, (text, i) => text[i] === '>' || text[i] === '<');
}

function firstWord(segment) {
  const match = segment.trim().match(/^([A-Za-z0-9_./-]+)/);
  return match ? match[1].replace(/^.*\//, '') : '';
}

function prefixRtk(segment) {
  const leading = segment.match(/^\s*/)[0];
  return `${leading}rtk ${segment.trim()}`;
}

/// The git verb of a segment, past any global options, or null when the
/// segment is not a git call. Global options may carry operands (-C <path>).
function gitSubcommandOf(segment) {
  const [program, ...args] = splitWords(stripEnvPrefix(unwrapShell(segment.trim())));
  if (program !== 'git') return null;
  let i = 0;
  while (args[i]?.startsWith('-')) {
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]) ? 2 : 1;
  }
  return args[i] ?? null;
}

/// `git log` stays bare (task 2783). rtk's log filter caps history silently —
/// measured 2026-10-21 on a 45-commit fixture with rtk 1.0.1: `rtk git log`
/// printed 10 entries, `rtk git log -S KEY` 10 of 15 matches, no marker and no
/// recall hash, while an explicit `-n N` was honoured. Agents answer "when did
/// this line appear or vanish" with `git log -S/-G`, so a short answer reads
/// as the whole history. Every other git subcommand keeps its routing.
function isBareGitLog(segment) {
  return gitSubcommandOf(segment) === 'log';
}

/// True when any chain segment's FINAL pipeline stage is a `git log` call —
/// exactly the stages upstream `rtk rewrite` may route (it preserves
/// intermediate stages). Used to refuse a whole-command answer that would put
/// the truncating log filter in front of history inside a larger command.
function chainHasRoutableGitLog(command) {
  return splitTopLevel(command, ['&&', '||', ';']).some(({ part }) => {
    const stages = splitTopLevel(part, ['|']);
    return isBareGitLog(stages[stages.length - 1].part);
  });
}

/// Rewrite one pipeline-free simple command, or null when nothing applies.
function rewriteSimple(segment, upstream) {
  const trimmed = segment.trim();
  if (!trimmed || hasRedirection(segment)) return null;
  const word = firstWord(segment);
  if (word === 'rtk' || word === 'rtk.exe') return proxyUndispatchable(segment);
  // Upstream `rtk rewrite` answers `rtk git log …` for a command whose output
  // it would silently cap (see isBareGitLog): declined here, before asking.
  if (isBareGitLog(segment)) return null;
  const fromUpstream = upstream(trimmed);
  if (fromUpstream && substitutesReader(trimmed, fromUpstream)) return null;
  if (fromUpstream && targetsKnownSubcommand(fromUpstream)) {
    const leading = segment.match(/^\s*/)[0];
    return `${leading}${fromUpstream}`;
  }
  // Our own prefixing is gated by the same rule as upstream's answer: `sed`,
  // `awk`, `cat` and `ssh` all used to be prefixed here and NONE of them is an
  // rtk subcommand, so each produced a parse_failure and ran raw anyway. They
  // stay listed as intent - the day the binary implements one, the gate opens
  // by itself and no edit here is needed.
  if (READER_FILTERS.has(word) && rtkCanDispatch(word)) return prefixRtk(segment);
  // ssh with a remote command: the remote output lands in the context raw;
  // rtk wraps it locally (nothing is installed on the remote host). Dispatched
  // by this repository's `[filters.ssh]`, not by a built-in.
  if (word === 'ssh' && rtkCanDispatch('ssh') && trimmed.split(/\s+/).length >= 3) {
    return prefixRtk(segment);
  }
  return null;
}

/// Rewrite one pipeline (no && ; ||): only the last stage's output reaches the
/// context, so only the last stage is touched.
function rewritePipeline(segment, upstream) {
  const stages = splitTopLevel(segment, ['|']);
  if (stages.length === 1) return rewriteSimple(segment, upstream);
  // `||` never reaches here: chains are split before pipelines.
  const last = stages[stages.length - 1];
  const word = firstWord(last.part);
  if (hasRedirection(last.part)) return null;
  const rewrittenLast =
    word === 'rtk' || word === 'rtk.exe'
      ? proxyUndispatchable(last.part)
      : READER_FILTERS.has(word) && rtkCanDispatch(word)
        ? prefixRtk(last.part)
        : null;
  if (!rewrittenLast) return null;
  const rebuilt = stages
    .map((stage, index) => (index === stages.length - 1 ? rewrittenLast : stage.part))
    .map((part, index) => part + (stages[index].sep || ''))
    .join('');
  return rebuilt;
}

/// The full layer: upstream first on the whole command, then the compound pass.
/// Returns the rewritten command, or null when nothing applies.
/// Did the agent already put this command under `rtk` itself?
///
/// The warn-only guard logs every rewrite it would have denied, and that count
/// is the whole basis for deciding whether deny ever comes back. But a rewrite
/// of an ALREADY-routed command (`rtk cat x` -> `rtk proxy cat x`, because
/// `cat` is not a dispatchable subcommand) is not a would-deny event: the deny
/// only ever punished a bare heavy command. Measured 2026-08-05: 75 of 119
/// logged events were already-routed, inflating the number 2.7x.
///
/// Judged per top-level segment, and within a segment by the LAST pipeline
/// stage — the same rule rewritePipeline uses, because only that stage's output
/// reaches the context. One bare segment makes the whole command bare: that is
/// the segment a deny would have caught.
export function alreadyRouted(rawCommand) {
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) return false;
  const command = unwrapShell(rawCommand);
  const segments = splitTopLevel(command, ['&&', '||', ';'])
    .map(({ part }) => part)
    .filter((part) => part.trim());
  if (!segments.length) return false;
  return segments.every((segment) => {
    const stages = splitTopLevel(segment, ['|']).map(({ part }) => part);
    const word = firstWord(stages[stages.length - 1]);
    return word === 'rtk' || word === 'rtk.exe';
  });
}

export function rewritePlus(rawCommand, upstream = defaultUpstreamRewrite) {
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) return null;
  const command = unwrapShell(rawCommand);
  const whole = upstream(command);
  // A bounded reader answered with a DIFFERENT reader is refused outright: no
  // saving is on offer and the output shape would change under the caller.
  if (whole && substitutesReader(command, whole)) return null;
  // `git log` is refused before the whole-command acceptance: upstream answers
  // `rtk git log …` for a simple call AND whole-chain answers that route a
  // `git log` segment, and that filter caps history silently
  // (chainHasRoutableGitLog). Chain segments take the same refusal inside
  // rewriteSimple.
  if (whole && targetsKnownSubcommand(whole) && !chainHasRoutableGitLog(command)) return whole;
  if (hasUnsafeConstruct(command)) return null;
  const chain = splitTopLevel(command, ['&&', '||', ';']);
  let changed = false;
  const rebuilt = chain
    .map(({ part, sep }) => {
      const rewritten = rewritePipeline(part, upstream);
      if (rewritten !== null && rewritten !== part) {
        changed = true;
        return rewritten + sep;
      }
      return part + sep;
    })
    .join('');
  return changed ? rebuilt : null;
}

// A transparent rewrite is cheap; a kimi refusal costs another model turn.
// Keep RTK's filter catalogue as the authority, excluding bounded operations
// only for that refusal transport. This does not change rewritePlus.
// `log` is here for a different reason than the bounded verbs: the rewrite
// layer leaves `git log` bare on purpose (isBareGitLog, task 2783), so a deny
// would leave the member no way to run it at all — bare is the only route.
const BOUNDED_GIT = new Set([
  'status', 'checkout', 'add', 'commit', 'branch', 'rev-parse', 'stash',
  'fetch', 'push', 'pull', 'remote', 'worktree', 'config', 'switch', 'restore', 'tag',
  'log',
]);
const BOUNDED_COMMANDS = new Set(['pwd', 'echo', 'mkdir', 'rm', 'mv', 'cp', 'wc']);

function needsHeavyRouting(segment) {
  const first = splitTopLevel(segment, ['|'])[0].part;
  const [program, ...args] = splitWords(stripEnvPrefix(unwrapShell(first.trim())));
  if (!program || /^(?:rtk|rtk\.exe)$/.test(program) || BOUNDED_COMMANDS.has(program)) return false;
  if (program === 'git') {
    return !BOUNDED_GIT.has(gitSubcommandOf(segment));
  }
  if (program === 'ls') return args.some((arg) => arg === '--recursive' || /^-[^-]*R/.test(arg));
  if (program === 'node' && args.some((arg) => arg === '--check' || arg === '-c')) return false;
  if (program === 'head' || program === 'tail') {
    return args.some((arg) => /^--follow(?:=|$)/.test(arg) || /^-[^-]*[fF]/.test(arg));
  }
  return true;
}

export function rewriteHeavy(rawCommand) {
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) return null;
  const command = unwrapShell(rawCommand);
  const upstream = (simple) => {
    const bare = stripEnvPrefix(simple.trim());
    const [program, verb] = splitWords(bare);
    // RTK 0.49 does not map `npm test`; its native test filter runs the exact
    // command (including npm's pre/post hooks and arguments), preserving status.
    if (program === 'npm' && verb === 'test' && !hasRedirection(simple) && !hasUnsafeConstruct(simple)) {
      // Ask RTK about npm's canonical alias to keep a missing binary fail-open.
      if (!targetsKnownSubcommand(defaultUpstreamRewrite('npm run test') || '')) return null;
      const prefix = simple.trim().slice(0, simple.trim().length - bare.length);
      return `${prefix}rtk test ${bare}`;
    }
    return defaultUpstreamRewrite(simple);
  };
  if (hasUnsafeConstruct(command)) return needsHeavyRouting(command) ? rewritePlus(command, upstream) : null;
  let changed = false;
  const rebuilt = splitTopLevel(command, ['&&', '||', ';']).map(({ part, sep }) => {
    const rewritten = needsHeavyRouting(part) ? rewritePlus(part.trim(), upstream) : null;
    if (rewritten && rewritten !== part) {
      changed = true;
      return part.match(/^\s*/)[0] + rewritten + part.match(/\s*$/)[0] + sep;
    }
    return part + sep;
  }).join('');
  return changed ? rebuilt : null;
}
