// rtk's user config (config.toml) holds `[hooks].exclude_commands`: commands
// its hook engine refuses to rewrite. The installer adds its own entries there
// as OWNED entries (task 2783), so the operator's own exclusions survive every
// re-install and a canon entry can be retired by removing it from the source.
// The installer holds its home lock before calling this, like the permissions
// and MCP targets.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { harnessPaths, readHarnessConfig } from '../../scripts/lib/harness-config.mjs';
import { writeOwned } from './owned-entries.mjs';

/// rtk resolves its config from `dirs::config_dir()` + `rtk` (upstream
/// src/core/user_dirs.rs at v1.0.1): `$HOME/Library/Application Support/rtk`
/// on macOS (measured live 2026-10-21: `rtk config` named exactly that file),
/// the real RoamingAppData on Windows, and on Linux the XDG path — the
/// upstream comment for `config()` says test isolation pins XDG_CONFIG_HOME
/// precisely because a spawned `rtk` reads it there. `dirs` honours the
/// variable only when it is absolute, so a relative one falls back to
/// `$HOME/.config` like an unset one.
export function rtkConfigFile({ home, platform, xdg }) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'rtk', 'config.toml');
  if (platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'rtk', 'config.toml');
  const configHome = xdg ?? (platform === 'linux' ? process.env.XDG_CONFIG_HOME : undefined);
  if (configHome && path.isAbsolute(configHome)) return path.join(configHome, 'rtk', 'config.toml');
  return path.join(home, '.config', 'rtk', 'config.toml');
}

/// A `[hooks]` table header in EVERY spelling TOML allows — bare, `[ hooks ]`,
/// basic- or literal-quoted — with an optional trailing `# comment` and an
/// optional `\r` before the line end (lesson 16377: anchoring at the closing
/// bracket made a commented header unrecognizable, the installer appended its
/// own table, and the file stopped being valid TOML).
const HOOKS_HEADER = /^\s*\[\s*(?:"hooks"|'hooks'|hooks)\s*\]\s*(?:#.*)?\r?$/;
/// `[[hooks]]` is an array of tables — a different structure this writer does
/// not model, so its presence refuses the step instead of corrupting it.
const HOOKS_ARRAY_HEADER = /^\s*\[\s*\[\s*(?:"hooks"|'hooks'|hooks)\s*\]\s*\]\s*(?:#.*)?\r?$/;
/// The `exclude_commands` key in every spelling (bare, basic- or
/// literal-quoted). `\r?` — `.` never matches `\r`, so without it a CRLF key
/// line looks absent and the installer would add a duplicate key (reviewer
/// blocker: tomllib then answers "Cannot overwrite a value").
const EXCLUDE_KEY = /^(\s*)(?:"exclude_commands"|'exclude_commands'|exclude_commands)(\s*)=(.*)\r?$/;
const ANY_HEADER = /^\s*\[/;

function unescapeBasic(raw) {
  // Decode a TOML basic string body (without quotes). Returns the decoded
  // text, or null for an escape this decoder does not model — the caller then
  // refuses rather than guess at the operator's bytes.
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const esc = raw[i + 1];
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (simple[esc]) {
      out += simple[esc];
      i += 1;
      continue;
    }
    const hex = esc === 'u' ? raw.slice(i + 2, i + 6) : esc === 'U' ? raw.slice(i + 2, i + 10) : null;
    if (!hex || !/^[0-9a-fA-F]+$/.test(hex)) return null;
    out += String.fromCodePoint(parseInt(hex, 16));
    i += esc === 'u' ? 5 : 9;
  }
  return out;
}

/// Parse the array-of-strings value of `exclude_commands` into items: each
/// entry with its RAW slice (written back byte-for-byte — a decoded-then-
/// re-encoded entry would grow a backslash on every install, reviewer defect:
/// `^git\s+status` became `^git\\s+status`) and its decoded text (what the
/// runtime reads, used for membership), plus interior `#` comments (kept).
/// Returns { items, end } with end the offset of `]`, or null when the value
/// is not an array of single-line strings this reader fully models.
function parseArrayItems(text, from) {
  let i = from;
  while (i < text.length && /[ \t\r\n]/.test(text[i])) i += 1;
  if (text[i] !== '[') return null;
  const items = [];
  let quote = null;
  let entryStart = -1;
  let sawComma = true;
  for (i += 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === '"') {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') {
        if (text[i + 1] === '"' || text.slice(entryStart, entryStart + 3) === '"""') return null; // """ multiline
        const raw = text.slice(entryStart, i + 1);
        const decoded = unescapeBasic(raw.slice(1, -1));
        if (decoded === null) return null;
        items.push({ kind: 'entry', raw, decoded, at: entryStart });
        quote = null;
        sawComma = false;
      }
      continue;
    }
    if (quote === "'") {
      if (ch === "'" && text[i + 1] === "'") return null; // ''' multiline
      if (ch === "'") {
        const raw = text.slice(entryStart, i + 1);
        items.push({ kind: 'entry', raw, decoded: raw.slice(1, -1), at: entryStart });
        quote = null;
        sawComma = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (!sawComma) return null; // `["a" "b"]` without a separator
      quote = ch;
      entryStart = i;
      sawComma = false;
      continue;
    }
    if (ch === ',') {
      if (sawComma) return null; // `["a",, "b"]`
      sawComma = true;
      continue;
    }
    if (ch === '#') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      items.push({ kind: 'comment', raw: text.slice(i, stop) });
      i = stop - 1;
      continue;
    }
    if (ch === ']') return { items, end: i };
    if (!/\s/.test(ch)) return null; // a non-string element: not ours to rewrite
  }
  return null;
}

function findArrayEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') {
      const end = text.indexOf('\n', i);
      i = (end === -1 ? text.length : end) - 1;
    } else if (ch === ']') return i;
  }
  return -1;
}

/// The writer must not trust its own recognizer to prove absence (task 2783
/// second correction, reviewer defect): before appending a new `[hooks]`
/// table or key, the WHOLE file is scanned for any other form that can define
/// the same table or key — a dotted key whose first segment is `hooks` (bare
/// or quoted), an inline `hooks = {…}` table, any header or key whose NAME
/// holds a backslash escape (it may decode to hooks/exclude_commands), and
/// `[hooks.<x>]` subtables. The editor is deliberately NOT extended to these
/// forms; when one exists the step leaves the file unchanged and reports a
/// manual step. Returns a reason string, or null when the file is clean.
function foreignHooksDefinition(content) {
  let atTopLevel = true;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const header = line.match(/^\s*\[(.*)\]\s*(?:#.*)?$/);
    if (header) {
      atTopLevel = false;
      if (header[1].includes('\\')) return 'an escaped table header';
      if (!HOOKS_HEADER.test(raw) && !HOOKS_ARRAY_HEADER.test(raw)
        && /^\s*(?:"hooks"|'hooks'|hooks)\s*\./.test(header[1])) return 'a [hooks.<x>] subtable';
      continue;
    }
    if (/^\s*[#]/.test(line)) continue;
    const eq = line.match(/^\s*([^=]*)=/);
    if (!eq) continue;
    const name = eq[1];
    if (name.includes('\\')) return 'a key holding a backslash escape';
    if (!atTopLevel) continue;
    const first = name.split('.')[0].trim();
    if (first === 'hooks' || first === '"hooks"' || first === "'hooks'") {
      return /^\s*\{/.test(line.slice(eq[0].length))
        ? 'an inline hooks table'
        : 'a dotted hooks key';
    }
  }
  return null;
}

/// Where the `[hooks]` section runs and its one `exclude_commands` key sits.
/// Throws for a file this writer cannot fully recognise — a `[[hooks]]` array
/// of tables, or a second `[hooks]`/key (already invalid TOML) — leaving the
/// file for a manual step instead of duplicating anything into it.
function locateExcludeKey(content) {
  const lines = content.split('\n');
  let hooksIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (HOOKS_ARRAY_HEADER.test(lines[i])) {
      throw new Error(
        'rtk config.toml: [[hooks]] array of tables is not a structure this installer writes — '
          + 'add "git log" to it by hand and re-run',
      );
    }
    if (HOOKS_HEADER.test(lines[i])) {
      if (hooksIndex !== -1) throw new Error('rtk config.toml: two [hooks] tables — fix the file by hand and re-run');
      hooksIndex = i;
    }
  }
  if (hooksIndex === -1) return null;
  let sectionEnd = lines.length;
  for (let i = hooksIndex + 1; i < lines.length; i += 1) {
    if (ANY_HEADER.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  let found = null;
  for (let i = hooksIndex + 1; i < sectionEnd; i += 1) {
    const match = lines[i].match(EXCLUDE_KEY);
    if (!match) continue;
    if (found) throw new Error('rtk config.toml: two exclude_commands keys — fix the file by hand and re-run');
    const lineStart = lines.slice(0, i).reduce((sum, line) => sum + line.length + 1, 0);
    found = { line: i, match, valueStart: lineStart + match[0].indexOf('=') + 1 };
  }
  return { hooksIndex, sectionEnd, key: found };
}

function parseValueAt(content, valueStart) {
  const end = findArrayEnd(content, valueStart);
  if (end === -1) throw new Error('rtk config.toml: exclude_commands value is not a closed array');
  const parsed = parseArrayItems(content, valueStart);
  if (!parsed) {
    throw new Error(
      'rtk config.toml: exclude_commands is not an array of strings this installer can preserve — '
        + 'edit it by hand and re-run',
    );
  }
  return { ...parsed, end };
}

/// Replace `[hooks].exclude_commands` with `entries`, preserving every byte
/// outside the value — and, inside it, every existing entry (raw slice, so
/// escapes never double) and every comment. A pure addition inserts the new
/// entries after the last existing one and touches nothing else; only a
/// retirement (an entry leaving the canon) rewrites the interior, and then
/// entry and comment TEXTS survive while the whitespace between them may not.
/// Returns the new file text.
export function renderRtkExcludes(content, entries) {
  const serializedArray = `[${entries.map((entry) => JSON.stringify(entry)).join(', ')}]`;
  if (content.length === 0) return `[hooks]\nexclude_commands = ${serializedArray}\n`;
  const lines = content.split('\n');
  const serialized = `exclude_commands = ${serializedArray}`;
  const located = locateExcludeKey(content);
  // The recognizer above can only vouch for what it models. Before appending
  // a table or a key on its word that nothing defines `hooks` yet, the whole
  // file is scanned for foreign spellings of the same definition — the
  // recognizer cannot see them, so neither could verifyRendered.
  if (!located?.key) {
    const foreign = foreignHooksDefinition(content);
    if (foreign) {
      throw new Error(
        `rtk config.toml holds ${foreign}, a form this installer does not rewrite — left unchanged; add "git log" to exclude_commands by hand and re-run`,
      );
    }
  }
  if (!located) {
    const block = ['[hooks]', serialized, ''];
    return content.endsWith('\n') ? [...lines, ...block].join('\n') : [...lines, '', ...block].join('\n');
  }
  const { hooksIndex, key } = located;
  if (!key) {
    lines.splice(hooksIndex + 1, 0, serialized);
    return lines.join('\n');
  }
  const { items, end } = parseValueAt(content, key.valueStart);
  const existing = items.filter((item) => item.kind === 'entry');
  const wanted = new Set(entries);
  const removals = existing.some((item) => !wanted.has(item.decoded));
  if (removals) {
    // Rewrite the whole interior: every kept entry stays byte-for-byte, every
    // comment text survives on its own line before `]`.
    const kept = existing.filter((item) => wanted.has(item.decoded));
    const comments = items.filter((item) => item.kind === 'comment');
    const interior = `${kept.map((item) => item.raw).join(', ')}${comments.map((c) => `${kept.length ? ' ' : ''}${c.raw}`).join('')}${comments.length ? '\n' : ''}`;
    return content.slice(0, key.valueStart) + ` [${interior}]` + content.slice(end + 1);
  }
  const missing = entries.filter((entry) => !existing.some((item) => item.decoded === entry));
  if (!missing.length) return content; // nothing to add or retire: byte-identical
  // Pure addition: splice after the LAST entry's closing quote (its recorded
  // offset, not a search — the same bytes can appear in an earlier comment),
  // so trailing commas, interior comments and the bracket stay untouched.
  const serializedNew = missing.map((entry) => JSON.stringify(entry)).join(', ');
  const last = existing[existing.length - 1];
  const at = existing.length ? last.at + last.raw.length : content.indexOf('[', key.valueStart) + 1;
  const insert = existing.length ? `, ${serializedNew}` : `${serializedNew}, `;
  return content.slice(0, at) + insert + content.slice(at);
}

/// The decoded entries currently in the file, or [] when the key/section/file
/// is absent. Anything this reader does not fully model throws (see
/// locateExcludeKey): rewriting a value it cannot round-trip would corrupt
/// the operator's config.
export function readPresentExcludes(content) {
  if (!content) return [];
  const located = locateExcludeKey(content);
  if (!located?.key) return [];
  const { items } = parseValueAt(content, located.key.valueStart);
  return items.filter((item) => item.kind === 'entry').map((item) => item.decoded);
}

/// The Rule (task 2783 correction): never write a file the installer cannot
/// fully recognise. Re-parse the rendered text exactly the way the reader
/// does and confirm the shape a runtime would see: one `[hooks]` table, one
/// `exclude_commands` key in it, and exactly the entry list the merge
/// decided (the operator's own plus the canon, minus what the manifest
/// retired). Throws (so nothing is written) when it does not hold.
function verifyRendered(rendered, wanted) {
  const located = locateExcludeKey(rendered);
  if (!located?.key) throw new Error('rtk config.toml: rendered text lost the [hooks] table or its key');
  const now = readPresentExcludes(rendered);
  const expected = [...new Set(wanted)];
  const same = now.length === expected.length && expected.every((entry) => now.includes(entry));
  if (!same) {
    throw new Error(`rtk config.toml: rendered text holds [${now.join(', ')}] where [${expected.join(', ')}] was decided — left unchanged, edit it by hand`);
  }
}

/// Merge `canon` into `[hooks].exclude_commands` as owned entries, keeping the
/// user's own. Same ownership manifest the permissions and MCP targets use.
export function writeRtkExcludes({ repoRoot, home, platform, xdg, canon }) {
  const file = rtkConfigFile({ home, platform, xdg });
  const content = (() => {
    try {
      return readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  })();
  const present = readPresentExcludes(content);
  const config = readHarnessConfig({ repoRoot });
  const { stateDir } = harnessPaths({ prefix: config.names.prefix, home });
  const merged = writeOwned({
    manifestPath: path.join(stateDir, 'installed-entries.json'),
    targetPath: file,
    lists: { exclude_commands: { present, canon } },
    writeTarget: (lists) => {
      const rendered = renderRtkExcludes(content, lists.exclude_commands);
      verifyRendered(rendered, lists.exclude_commands);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, rendered, { encoding: 'utf8' });
    },
  });
  return { file, entries: merged.exclude_commands };
}

/**
 * The installer step body for `--only rtk-excludes` (task 2783); the wiring in
 * install-harness.mjs is one import and one call, so this file owns the step
 * the way permissions-target and mcp-config-target own theirs.
 *
 * rtk's hook engine reads `[hooks].exclude_commands` from its user config
 * (`dirs::config_dir()` + `rtk`, upstream src/core/user_dirs.rs at v1.0.1:
 * `~/Library/Application Support/rtk` on macOS — measured live with
 * `rtk config` 2026-10-21 — RoamingAppData on Windows, `$XDG_CONFIG_HOME`
 * when absolute else `~/.config` on Linux) and refuses to rewrite any command
 * an entry matches. Matching is per chain segment: a plain entry is
 * regex-escaped and anchored `^<entry>($|\s)` (word-boundary prefix:
 * `"git log"` excludes `git log -S x` and `git  log`, never `git status`),
 * while an entry with a LEADING `^` is used as a raw regex (upstream
 * compile_exclude_patterns), measured live 2026-10-21.
 *
 * `git log` is excluded because rtk's log filter caps history silently
 * (task 2783, rtk 1.0.1: `rtk git log` printed 10 of 45 entries, `-S KEY`
 * 10 of 15 matches, no marker and no recall hash), and `git log -S/-G` is
 * how an agent answers "when did this line appear or vanish". The plain
 * entry cannot reach `git -C <dir> log` or `git --git-dir=x log` — the
 * prefix ends before the global option — so a second, raw-regex entry
 * covers global options before the verb (measured live: both forms excluded,
 * `git status`, `git -C <dir> status` and `git stash log` still rewritten).
 * The rewrite layer (rtk-rewrite-lib.mjs) refuses the same commands
 * independently via gitSubcommandOf, which skips global options; this config
 * entry carries the routes the lib cannot reach: rtk's own `rtk hook claude`
 * and the Pi extension's `rtk rewrite`.
 *
 * The entries are OWNED through the same manifest as permissions and MCP ids,
 * so the operator's own exclusions survive every re-install and a canon
 * entry can be retired by removing it here.
 */
const RTK_EXCLUDE_COMMANDS = [
  'git log',
  '^git\\s+(?:-{1,2}[A-Za-z][A-Za-z0-9-]*(?:[= ]\\S+)?[ ]+)*log(?:[ ]|$)',
];

export function installRtkExcludes(ctx) {
  try {
    return writeRtkExcludes({
      repoRoot: ctx.repo,
      home: ctx.home,
      platform: ctx.platform,
      xdg: ctx.xdg,
      canon: RTK_EXCLUDE_COMMANDS,
    });
  } catch (error) {
    // The Rule: never write a file the installer cannot fully recognise. The
    // step reports a manual step instead of failing the whole install.
    return {
      file: rtkConfigFile({ home: ctx.home, platform: ctx.platform, xdg: ctx.xdg }),
      warning: `manual step: ${error.message}`,
    };
  }
}
