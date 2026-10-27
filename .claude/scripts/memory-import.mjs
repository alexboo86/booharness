#!/usr/bin/env node
// One-shot idempotent importer: agent-memory markdown → memory.db (schema v1).
//
// Direct SQLite writes only — does NOT create schema. Operator must start the memory service
// once so memory.mjs migrations produce mem_entries. Zero npm deps (Node 26+).
//
// Usage:
//   node .claude/scripts/memory-import.mjs --src <dir> --db <memory.db> [--dry-run] [--report] [--parity]
//
// Mapping + idempotency rules: team board chunk D (BINDING).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_SECTION_BYTES = 64 * 1024; // 65536
export const SESSION_ID = 'import';
export const AGENT = 'importer';
export const REGISTRY_KEY = 'session-registry';

const PREFIX_KIND = [
  ['handoff_', 'handoff'],
  ['feedback_', 'feedback'],
  ['project_', 'project'],
  ['reference_', 'reference'],
  ['decision_', 'decision'],
];

const VERBATIM_KINDS = new Set(['handoff', 'feedback', 'project', 'reference', 'decision']);
const SPECIAL_SPLIT_FILES = new Set(['MEMORY-FULL.md', 'MEMORY-ARCHIVE.md']);
const SPECIAL_NAMES = new Set([
  'MEMORY.md',
  'MEMORY-FULL.md',
  'MEMORY-ARCHIVE.md',
  'SESSION-REGISTRY.md',
]);

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** @param {string|Buffer} value */
export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Map a basename to kind via filename prefix.
 * Unknown prefixes → 'archive'. Special files handled by callers.
 * @param {string} basename
 * @returns {'handoff'|'feedback'|'project'|'reference'|'decision'|'archive'}
 */
export function kindFromFilename(basename) {
  const name = path.basename(basename);
  for (const [prefix, kind] of PREFIX_KIND) {
    if (name.startsWith(prefix)) return kind;
  }
  return 'archive';
}

/**
 * First H1 (`# `) heading text, else fallback (usually filename).
 * Only matches ATX h1 with a space after `#`, not `##`.
 * @param {string} body
 * @param {string} fallback
 */
export function extractTitle(body, fallback) {
  if (typeof body !== 'string') return fallback;
  const m = body.match(/^#\s+(.+)$/m);
  if (!m) return fallback;
  const title = m[1].replace(/\s+$/, '').trim();
  return title || fallback;
}

/**
 * Heading text from a section body that starts with `## ` or `### `.
 * @param {string} sectionBody
 * @param {string} fallback
 * @param {2|3} level
 */
export function extractSectionTitle(sectionBody, fallback, level = 2) {
  const marker = level === 3 ? '### ' : '## ';
  if (!sectionBody.startsWith(marker)) {
    // preamble / hard-split fragment without its own heading
    return fallback;
  }
  const nl = sectionBody.indexOf('\n');
  const line = nl === -1 ? sectionBody.slice(marker.length) : sectionBody.slice(marker.length, nl);
  const title = line.replace(/\s+$/, '').trim();
  return title || fallback;
}

/**
 * Split text into sections at ATX headings of the given level.
 * Preserves every byte: join of section bodies === original text.
 * Preamble (bytes before the first matching heading) is section index 0 when non-empty.
 *
 * @param {string} text
 * @param {2|3} level
 * @returns {{ index: number, body: string, title: string }[]}
 */
export function splitByHeadings(text, level = 2) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (text.length === 0) return [];

  const marker = level === 3 ? '### ' : '## ';
  // Match start-of-string or after newline (handles \n and \r\n).
  const re = level === 3 ? /(^|\n)(### )/g : /(^|\n)(## )/g;

  /** @type {number[]} */
  const starts = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const markerAt = m.index + m[1].length; // index of '#'
    // Guard: '## ' must not be '### ' when level=2
    if (level === 2 && text.startsWith('###', markerAt)) continue;
    starts.push(markerAt);
  }

  if (starts.length === 0) {
    return [{ index: 0, body: text, title: extractSectionTitle(text, '(preamble)', level) }];
  }

  /** @type {{ index: number, body: string, title: string }[]} */
  const sections = [];
  let outIndex = 0;

  if (starts[0] > 0) {
    const body = text.slice(0, starts[0]);
    sections.push({
      index: outIndex++,
      body,
      title: extractSectionTitle(body, '(preamble)', level),
    });
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : text.length;
    const body = text.slice(start, end);
    sections.push({
      index: outIndex++,
      body,
      title: extractSectionTitle(body, `section-${outIndex}`, level),
    });
  }

  // Parity invariant
  if (sections.map((s) => s.body).join('') !== text) {
    throw new Error('splitByHeadings: concatenation does not reconstruct source (internal bug)');
  }
  return sections;
}

/**
 * Hard-split a string into ≤ maxBytes UTF-8 chunks, cutting only at line
 * boundaries (keep trailing newline in the preceding part). Never splits
 * mid-codepoint: string indexing is codepoint-safe in JS, and we only cut
 * after '\n'. A single line longer than maxBytes is emitted intact so
 * reconstruction stays byte-equal. Join of parts === original.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string[]}
 */
export function hardSplitBytes(text, maxBytes = MAX_SECTION_BYTES) {
  if (maxBytes < 1) throw new Error(`maxBytes must be >= 1, got ${maxBytes}`);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];

  /** @type {string[]} */
  const parts = [];
  let start = 0;
  while (start < text.length) {
    if (Buffer.byteLength(text.slice(start), 'utf8') <= maxBytes) {
      parts.push(text.slice(start));
      break;
    }
    // Greedy: last newline whose inclusion keeps this part within budget.
    let best = -1;
    let from = start;
    for (;;) {
      const nl = text.indexOf('\n', from);
      if (nl === -1) break;
      const incl = nl + 1; // include the newline in this part
      if (Buffer.byteLength(text.slice(start, incl), 'utf8') <= maxBytes) {
        best = nl;
        from = nl + 1;
      } else {
        break;
      }
    }
    if (best === -1) {
      // No newline fits within budget → emit remaining intact (may exceed maxBytes).
      parts.push(text.slice(start));
      break;
    }
    const cut = best + 1;
    parts.push(text.slice(start, cut));
    start = cut;
  }

  if (parts.join('') !== text) {
    throw new Error('hardSplitBytes: concatenation does not reconstruct source (internal bug)');
  }
  return parts.length ? parts : [text];
}

/**
 * Expand one section into ≤64KB compact entries.
 * Order: keep as-is → ###-split if oversized → hard-split residual oversized parts.
 *
 * @param {string} sectionBody
 * @param {string} sectionTitle
 * @param {number} [maxBytes]
 * @returns {{ title: string, body: string, partIndex: number }[]}
 */
export function expandOversizedSection(sectionBody, sectionTitle, maxBytes = MAX_SECTION_BYTES) {
  if (Buffer.byteLength(sectionBody, 'utf8') <= maxBytes) {
    return [{ title: sectionTitle, body: sectionBody, partIndex: 0 }];
  }

  // Prefer ### boundaries when present.
  const hasH3 = /(^|\n)### /.test(sectionBody);
  /** @type {{ body: string, title: string }[]} */
  let chunks;
  if (hasH3) {
    chunks = splitByHeadings(sectionBody, 3).map((s) => ({
      body: s.body,
      title: s.title,
    }));
  } else {
    chunks = [{ body: sectionBody, title: sectionTitle }];
  }

  /** @type {{ title: string, body: string, partIndex: number }[]} */
  const out = [];
  let globalPart = 0;

  for (const chunk of chunks) {
    const pieces = hardSplitBytes(chunk.body, maxBytes);
    for (let i = 0; i < pieces.length; i++) {
      let title = chunk.title;
      if (!hasH3) {
        // Whole section hard-split: Title (part N)
        title = `${sectionTitle} (part ${globalPart + 1})`;
      } else if (pieces.length > 1) {
        // ### chunk still too large: SubTitle (part N)
        title = `${chunk.title} (part ${i + 1})`;
      }
      out.push({ title, body: pieces[i], partIndex: globalPart++ });
    }
  }

  if (out.map((p) => p.body).join('') !== sectionBody) {
    throw new Error('expandOversizedSection: concatenation does not reconstruct section (internal bug)');
  }
  return out;
}

/**
 * Split a large archive-style document (MEMORY-FULL / MEMORY-ARCHIVE) into compact entries.
 * Non-empty preamble (text before first `## `) becomes kind=archive entry (not pinned);
 * title = H1 or `<basename> preamble`. Concat of all bodies === original file.
 * @param {string} text
 * @param {string} relPath  e.g. MEMORY-ARCHIVE.md
 * @param {number} [maxBytes]
 * @returns {{ title: string, body: string, source_path: string, sectionIndex: number, partIndex: number, isPreamble?: boolean }[]}
 */
export function splitArchiveDocument(text, relPath, maxBytes = MAX_SECTION_BYTES) {
  const sections = splitByHeadings(text, 2);
  /** @type {{ title: string, body: string, source_path: string, sectionIndex: number, partIndex: number, isPreamble?: boolean }[]} */
  const entries = [];

  for (const sec of sections) {
    const isPreamble = !sec.body.startsWith('## ');
    const secTitle = isPreamble ? preambleTitle(sec.body, relPath) : sec.title;
    const parts = expandOversizedSection(sec.body, secTitle, maxBytes);
    for (const part of parts) {
      const source_path =
        parts.length === 1
          ? `${relPath}#${sec.index}`
          : `${relPath}#${sec.index}.p${part.partIndex}`;
      entries.push({
        title: part.title,
        body: part.body,
        source_path,
        sectionIndex: sec.index,
        partIndex: part.partIndex,
        isPreamble,
      });
    }
  }
  return entries;
}

/**
 * Preamble title: first H1 if present, else `<basename> preamble`.
 * @param {string} body
 * @param {string} relPath
 */
export function preambleTitle(body, relPath) {
  const base = path.basename(relPath);
  return extractTitle(body, `${base} preamble`);
}

/**
 * Split MEMORY.md into pinned entries: non-empty preamble (if any) + every `## `
 * section. Zero bytes may be dropped — concat of bodies === original file.
 * @param {string} text
 * @param {string} [relPath]
 */
export function splitMemoryHotSections(text, relPath = 'MEMORY.md') {
  const sections = splitByHeadings(text, 2);
  return sections.map((s) => {
    const isPreamble = !s.body.startsWith('## ');
    return {
      title: isPreamble ? preambleTitle(s.body, relPath) : s.title,
      body: s.body,
      source_path: `${relPath}#${s.index}`,
      pinned: 1,
      kind: 'reference',
      isPreamble,
    };
  });
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

/**
 * @param {string} srcRoot
 * @returns {{ abs: string, rel: string, basename: string }[]}
 */
export function listMarkdownFiles(srcRoot) {
  const root = path.resolve(srcRoot);
  if (!fs.existsSync(root)) {
    throw new Error(`source directory not found: ${root}`);
  }
  /** @type {{ abs: string, rel: string, basename: string }[]} */
  const out = [];

  /** @param {string} dir */
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`unreadable directory ${dir}: ${err?.message || err}`);
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      if (ent.isSymbolicLink()) {
        // Follow directory symlinks carefully; for files treat as file if target is file.
        let st;
        try {
          st = fs.statSync(abs);
        } catch (err) {
          throw new Error(`unreadable symlink ${abs}: ${err?.message || err}`);
        }
        if (st.isDirectory()) walk(abs);
        else if (st.isFile() && ent.name.endsWith('.md')) {
          out.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/'), basename: ent.name });
        }
        continue;
      }
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (ent.isFile()) {
        if (!ent.name.endsWith('.md')) continue;
        out.push({
          abs,
          rel: path.relative(root, abs).split(path.sep).join('/'),
          basename: ent.name,
        });
      }
    }
  }

  walk(root);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/**
 * Read file as UTF-8 string; fail LOUD on I/O errors or non-UTF8 bytes.
 * No latin1/mojibake fallback — invalid UTF-8 aborts the import for that run.
 * @param {string} absPath
 * @returns {{ text: string, bytes: Buffer, mtimeMs: number, encoding: 'utf8' }}
 */
export function readSourceFile(absPath) {
  let bytes;
  let st;
  try {
    st = fs.statSync(absPath);
    bytes = fs.readFileSync(absPath);
  } catch (err) {
    throw new Error(`unreadable file ${absPath}: ${err?.message || err}`);
  }
  const text = bytes.toString('utf8');
  if (Buffer.compare(Buffer.from(text, 'utf8'), bytes) !== 0) {
    throw new Error(
      `non-UTF8 file (refusing mojibake fallback): ${absPath}`,
    );
  }
  return { text, bytes, mtimeMs: Math.floor(st.mtimeMs), encoding: 'utf8' };
}

// ---------------------------------------------------------------------------
// Entry planning (pure: files → planned rows)
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   kind: string,
 *   key: string|null,
 *   title: string,
 *   body: string,
 *   pinned: number,
 *   source_path: string,
 *   ts: number,
 *   content_hash: string,
 *   verbatim: boolean,
 *   split: boolean,
 *   origin_file: string,
 *   section_index?: number,
 * }} PlannedEntry
 */

/**
 * @param {{ abs: string, rel: string, basename: string }} file
 * @returns {{ planned: PlannedEntry[], skipped?: string }}
 */
export function planFile(file) {
  const { text, mtimeMs } = readSourceFile(file.abs);
  const ts = mtimeMs;
  const planned = [];

  // SESSION-REGISTRY.md
  if (file.basename === 'SESSION-REGISTRY.md' && !file.rel.includes('/')) {
    const title = extractTitle(text, 'SESSION-REGISTRY.md');
    const body = text;
    planned.push({
      kind: 'registry',
      key: REGISTRY_KEY,
      title,
      body,
      pinned: 0,
      source_path: file.rel,
      ts,
      content_hash: sha256(body),
      verbatim: true,
      split: false,
      origin_file: file.rel,
    });
    return { planned };
  }

  // MEMORY.md → pinned ## sections as reference
  if (file.basename === 'MEMORY.md' && !file.rel.includes('/')) {
    const sections = splitMemoryHotSections(text, file.rel);
    for (const sec of sections) {
      planned.push({
        kind: 'reference',
        key: null,
        title: sec.title,
        body: sec.body,
        pinned: 1,
        source_path: sec.source_path,
        ts,
        content_hash: sha256(sec.body),
        verbatim: false,
        split: true,
        origin_file: file.rel,
      });
    }
    return { planned };
  }

  // MEMORY-FULL / MEMORY-ARCHIVE → ## split + compact
  if (SPECIAL_SPLIT_FILES.has(file.basename) && !file.rel.includes('/')) {
    const parts = splitArchiveDocument(text, file.rel);
    for (const p of parts) {
      planned.push({
        kind: 'archive',
        key: null,
        title: p.title,
        body: p.body,
        pinned: 0,
        source_path: p.source_path,
        ts,
        content_hash: sha256(p.body),
        verbatim: false,
        split: true,
        origin_file: file.rel,
        section_index: p.sectionIndex,
      });
    }
    return { planned };
  }

  // Nested copies of special names under _archive etc. → treat as regular files
  // (prefix map or archive).
  const kind = kindFromFilename(file.basename);
  const title = extractTitle(text, file.basename);
  const body = text;
  planned.push({
    kind,
    key: null,
    title,
    body,
    pinned: 0,
    source_path: file.rel,
    ts,
    content_hash: sha256(body),
    verbatim: VERBATIM_KINDS.has(kind),
    split: false,
    origin_file: file.rel,
  });
  return { planned };
}

// ---------------------------------------------------------------------------
// SQLite access
// ---------------------------------------------------------------------------

/** Exact schema v1 column set expected on mem_entries (chunk A). */
export const EXPECTED_MEM_ENTRIES_COLUMNS = Object.freeze([
  'id',
  'uuid',
  'ts',
  'session_id',
  'agent',
  'kind',
  'key',
  'title',
  'body',
  'links',
  'sha_refs',
  'pinned',
  'content_hash',
  'source_path',
  'supersedes',
  'superseded_by',
  'version',
  // v4: which declaration a handoff made at session end ('none' | 'tails'),
  // NULL for anything written before the gate existed. This list is a SECOND
  // copy of the same contract (the first lives in scripts/memory/lesson-lib.mjs)
  // and a strict reader that does not know a column the service writes refuses
  // a database that is perfectly valid - `npm run tracks` died that way when
  // the column landed, and four reviewers caught this copy still stale.
  'handoff_declaration',
]);

const SCHEMA_CHECK_SQL = `
SELECT 1 AS ok FROM sqlite_master
WHERE type = 'table' AND name = 'mem_entries'
LIMIT 1`;

/**
 * Validate mem_entries has the exact expected v1 column set.
 * Throws a named loud error on missing table or column mismatch.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [dbPath] for error messages
 */
export function validateMemEntriesSchema(db, dbPath = 'memory.db') {
  let cols;
  try {
    const table = db.prepare(SCHEMA_CHECK_SQL).get();
    if (!table) {
      throw new Error(
        `SchemaError: mem_entries table is MISSING from ${dbPath} — start the memory service once so it initializes the schema. Aborting import; no rows written.`,
      );
    }
    cols = db.prepare('PRAGMA table_info(mem_entries)').all().map((r) => r.name);
  } catch (err) {
    if (String(err?.message || err).startsWith('SchemaError:')) throw err;
    throw new Error(`SchemaError: schema probe failed on ${dbPath}: ${err?.message || err}`);
  }
  if (!cols.length) {
    throw new Error(
      `SchemaError: mem_entries table is MISSING from ${dbPath} — start the memory service once so it initializes the schema. Aborting import; no rows written.`,
    );
  }
  const colSet = new Set(cols);
  const missing = EXPECTED_MEM_ENTRIES_COLUMNS.filter((c) => !colSet.has(c));
  const extra = cols.filter((c) => !EXPECTED_MEM_ENTRIES_COLUMNS.includes(c));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`missing columns: ${missing.join(', ')}`);
    if (extra.length) parts.push(`unexpected columns: ${extra.join(', ')}`);
    throw new Error(
      `SchemaError: mem_entries schema mismatch — ${parts.join('; ')}. Expected schema v1 columns: ${EXPECTED_MEM_ENTRIES_COLUMNS.join(', ')}. Aborting import; no rows written.`,
    );
  }
}

/**
 * Open existing memory.db; fail if mem_entries missing or columns diverge from v1.
 * @param {string} dbPath
 */
export function openExistingMemoryDb(dbPath) {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `memory.db not found: ${resolved}\n` +
        'Start the memory service once so store.mjs migrations create the schema, then re-run the importer.',
    );
  }
  const db = new DatabaseSync(resolved);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    validateMemEntriesSchema(db, resolved);
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {PlannedEntry} entry
 * @returns {'inserted'|'deduped'|'registry_skipped'}
 */
export function insertEntry(db, entry) {
  // Registry seed: never clobber a live registry row.
  if (entry.kind === 'registry' && entry.key === REGISTRY_KEY) {
    const live = db
      .prepare(
        `SELECT id FROM mem_entries WHERE key = ? AND superseded_by IS NULL LIMIT 1`,
      )
      .get(REGISTRY_KEY);
    if (live) return 'registry_skipped';
  }

  const existing = db
    .prepare(
      `SELECT id FROM mem_entries WHERE kind = ? AND title = ? AND content_hash = ? LIMIT 1`,
    )
    .get(entry.kind, entry.title, entry.content_hash);
  if (existing) return 'deduped';

  const uuid = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO mem_entries(
        uuid, ts, session_id, agent, kind, key, title, body, links, sha_refs,
        pinned, content_hash, source_path, supersedes, superseded_by, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, NULL, NULL, 1)`,
    ).run(
      uuid,
      entry.ts,
      SESSION_ID,
      AGENT,
      entry.kind,
      entry.key,
      entry.title,
      entry.body,
      entry.pinned,
      entry.content_hash,
      entry.source_path,
    );
  } catch (err) {
    // Race-safe: UNIQUE collision → treat as dedup
    const msg = String(err?.message || err);
    if (/UNIQUE constraint failed/i.test(msg)) return 'deduped';
    throw new Error(
      `insert failed for ${entry.source_path} (${entry.kind}/${entry.title}): ${msg}`,
    );
  }
  return 'inserted';
}

// ---------------------------------------------------------------------------
// Report + import orchestration
// ---------------------------------------------------------------------------

export function emptyReport() {
  return {
    files_seen: 0,
    files_non_md_skipped: 0,
    files_planned: 0,
    entries_planned: 0,
    imported: 0,
    deduped_skipped: 0,
    registry_skipped: 0,
    split_count: 0,
    per_kind: /** @type {Record<string, number>} */ ({}),
    bytes_in: 0,
    bytes_stored_planned: 0,
    bytes_stored_inserted: 0,
    dry_run: false,
    parity: null,
  };
}

function bumpKind(report, kind) {
  report.per_kind[kind] = (report.per_kind[kind] || 0) + 1;
}

/**
 * @param {object} opts
 * @param {string} opts.src
 * @param {string} [opts.dbPath]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.doParity]
 * @param {boolean} [opts.report]
 */
export function runImport(opts) {
  const src = path.resolve(opts.src);
  const dryRun = Boolean(opts.dryRun);
  const doParity = Boolean(opts.doParity);
  const report = emptyReport();
  report.dry_run = dryRun;

  const files = listMarkdownFiles(src);
  report.files_seen = files.length;

  // Count non-md at top-level walk for report (optional best-effort)
  report.files_non_md_skipped = countNonMd(src);

  /** @type {PlannedEntry[]} */
  const allPlanned = [];
  for (const file of files) {
    const { planned } = planFile(file);
    if (planned.length === 0) continue;
    report.files_planned += 1;
    for (const p of planned) {
      allPlanned.push(p);
      report.entries_planned += 1;
      report.bytes_in += Buffer.byteLength(p.body, 'utf8');
      report.bytes_stored_planned += Buffer.byteLength(p.body, 'utf8');
      bumpKind(report, p.kind);
      if (p.split) report.split_count += 1;
    }
  }

  /** @type {import('node:sqlite').DatabaseSync|null} */
  let db = null;
  if (!dryRun || doParity) {
    if (!opts.dbPath) {
      throw new Error('--db <path> is required unless --dry-run without --parity');
    }
  }

  if (!dryRun) {
    if (!opts.dbPath) throw new Error('--db <path> is required for write import');
    db = openExistingMemoryDb(opts.dbPath);
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const entry of allPlanned) {
        const result = insertEntry(db, entry);
        if (result === 'inserted') {
          report.imported += 1;
          report.bytes_stored_inserted += Buffer.byteLength(entry.body, 'utf8');
        } else if (result === 'deduped') {
          report.deduped_skipped += 1;
        } else if (result === 'registry_skipped') {
          report.registry_skipped += 1;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      db.close();
      throw err;
    }
  }

  if (doParity) {
    if (!db) {
      db = openExistingMemoryDb(opts.dbPath);
    }
    try {
      report.parity = runParity(db, src, allPlanned);
    } finally {
      // keep open if we opened for write; close only if parity-only
    }
  }

  if (db) db.close();
  return { report, planned: allPlanned };
}

function countNonMd(srcRoot) {
  let n = 0;
  const root = path.resolve(srcRoot);
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      try {
        if (ent.isDirectory() || (ent.isSymbolicLink() && fs.statSync(abs).isDirectory())) {
          walk(abs);
        } else if (ent.isFile() || (ent.isSymbolicLink() && fs.statSync(abs).isFile())) {
          if (!ent.name.endsWith('.md')) n += 1;
        }
      } catch {
        /* skip unreadable in count only */
      }
    }
  }
  walk(root);
  return n;
}

/**
 * Sort key for source_path fragments: "file#0", "file#0.p1", "file#1.p0" …
 * @param {string} sourcePath
 * @returns {number[]}
 */
function fragOf(sourcePath) {
  const h = sourcePath.indexOf('#');
  if (h === -1) return [];
  const frag = sourcePath.slice(h + 1);
  // "0" or "0.p1" or "1.2" — collect numeric tokens
  return frag.split(/[^0-9]+/).filter(Boolean).map((n) => parseInt(n, 10));
}

function cmpFrag(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Whole-file + section-level parity for split documents.
 * Reconstructs the full original by concatenating entry bodies in source_path order
 * and byte-compares with the source file. Also checks each expected section/part.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} src
 * @param {PlannedEntry[]} planned
 */
export function runParity(db, src, planned) {
  const bySource = db.prepare(
    `SELECT id, kind, title, body, content_hash, source_path FROM mem_entries WHERE source_path = ?`,
  );
  const byHash = db.prepare(
    `SELECT id, kind, title, body, content_hash, source_path FROM mem_entries
     WHERE kind = ? AND title = ? AND content_hash = ? LIMIT 1`,
  );

  /** @type {{ path: string, status: 'PASS'|'FAIL', detail?: string }[]} */
  const results = [];
  let pass = 0;
  let fail = 0;

  // Group planned by origin for split reconstruction checks
  /** @type {Map<string, PlannedEntry[]>} */
  const byOrigin = new Map();
  for (const p of planned) {
    if (!byOrigin.has(p.origin_file)) byOrigin.set(p.origin_file, []);
    byOrigin.get(p.origin_file).push(p);
  }

  for (const [origin, entries] of byOrigin) {
    const abs = path.join(src, origin);
    let fileText;
    try {
      fileText = readSourceFile(abs).text;
    } catch (err) {
      results.push({ path: origin, status: 'FAIL', detail: String(err?.message || err) });
      fail += 1;
      continue;
    }

    // Verbatim single-entry files
    if (entries.length === 1 && entries[0].verbatim && !entries[0].split) {
      const e = entries[0];
      const row =
        bySource.all(e.source_path)[0] ||
        byHash.get(e.kind, e.title, e.content_hash);
      if (!row) {
        results.push({ path: origin, status: 'FAIL', detail: 'no DB row' });
        fail += 1;
        continue;
      }
      if (row.body !== fileText) {
        results.push({
          path: origin,
          status: 'FAIL',
          detail: `body byte mismatch (file ${Buffer.byteLength(fileText)} vs db ${Buffer.byteLength(row.body)})`,
        });
        fail += 1;
        continue;
      }
      if (row.content_hash !== sha256(fileText)) {
        results.push({ path: origin, status: 'FAIL', detail: 'content_hash mismatch' });
        fail += 1;
        continue;
      }
      results.push({ path: origin, status: 'PASS' });
      pass += 1;
      continue;
    }

    // Registry verbatim
    if (entries.length === 1 && entries[0].kind === 'registry') {
      const e = entries[0];
      const row =
        bySource.all(e.source_path)[0] ||
        byHash.get(e.kind, e.title, e.content_hash);
      // Live registry may have been skipped — if a different live registry exists, PASS with note
      if (!row) {
        const live = db
          .prepare(
            `SELECT id FROM mem_entries WHERE key = ? AND superseded_by IS NULL LIMIT 1`,
          )
          .get(REGISTRY_KEY);
        if (live) {
          results.push({
            path: origin,
            status: 'PASS',
            detail: 'registry seed skipped (live row exists)',
          });
          pass += 1;
          continue;
        }
        results.push({ path: origin, status: 'FAIL', detail: 'no DB row for registry' });
        fail += 1;
        continue;
      }
      if (row.body !== fileText) {
        results.push({ path: origin, status: 'FAIL', detail: 'registry body mismatch' });
        fail += 1;
        continue;
      }
      results.push({ path: origin, status: 'PASS' });
      pass += 1;
      continue;
    }

    // Split kinds: whole-file byte parity + section-level checks
    const base = path.basename(origin);
    if (base === 'MEMORY.md' || SPECIAL_SPLIT_FILES.has(base)) {
      /** @type {{ title: string, body: string, source_path: string }[]} */
      const expected =
        base === 'MEMORY.md'
          ? splitMemoryHotSections(fileText, origin)
          : splitArchiveDocument(fileText, origin);
      const kind = base === 'MEMORY.md' ? 'reference' : 'archive';

      // 1) Whole-file: concat all entry bodies in order must equal source bytes.
      // Prefer planned order (source of truth for what should have been stored),
      // resolve each part from DB (or hash for cross-path dedup).
      const ordered = [...expected].sort((a, b) =>
        cmpFrag(fragOf(a.source_path), fragOf(b.source_path)),
      );
      const wholeParts = [];
      let wholeFail = false;
      for (const exp of ordered) {
        const row =
          bySource.all(exp.source_path)[0] ||
          byHash.get(kind, exp.title, sha256(exp.body));
        if (!row) {
          results.push({
            path: origin,
            status: 'FAIL',
            detail: `whole-file parity: missing part ${exp.source_path}`,
          });
          fail += 1;
          wholeFail = true;
          break;
        }
        wholeParts.push(row.body);
      }
      if (!wholeFail) {
        const reconstructed = wholeParts.join('');
        if (reconstructed !== fileText) {
          results.push({
            path: origin,
            status: 'FAIL',
            detail: `whole-file byte parity FAIL (reconstructed ${Buffer.byteLength(reconstructed)}B != source ${Buffer.byteLength(fileText)}B)`,
          });
          fail += 1;
          wholeFail = true;
        }
      }

      // 2) Section-level: each expected part body matches DB (still useful diagnostics)
      let sectionFail = false;
      for (const exp of expected) {
        const row =
          bySource.all(exp.source_path)[0] ||
          byHash.get(kind, exp.title, sha256(exp.body));
        if (!row || row.body !== exp.body) {
          results.push({
            path: exp.source_path,
            status: 'FAIL',
            detail: row ? 'section body mismatch' : 'missing section row',
          });
          fail += 1;
          sectionFail = true;
        }
      }

      // 3) Planned-set vs expected-set: if planner dropped a preamble, ordered
      // reconstruction of *planned* alone would still pass when re-derived the
      // same way — whole-file above uses re-split expected which includes preamble.
      // Also flag if planned concat ≠ source (planner bug).
      const plannedOrdered = [...entries].sort((a, b) =>
        cmpFrag(fragOf(a.source_path), fragOf(b.source_path)),
      );
      const plannedConcat = plannedOrdered.map((e) => e.body).join('');
      if (plannedConcat !== fileText) {
        results.push({
          path: origin,
          status: 'FAIL',
          detail: `planned entries do not reconstruct source (planned ${Buffer.byteLength(plannedConcat)}B != source ${Buffer.byteLength(fileText)}B) — possible dropped preamble`,
        });
        fail += 1;
        sectionFail = true;
      }

      if (!wholeFail && !sectionFail) {
        results.push({
          path: origin,
          status: 'PASS',
          detail: `whole-file + ${expected.length} parts`,
        });
        pass += 1;
      }
      continue;
    }

    // Fallback: each planned entry must match DB
    let ok = true;
    for (const e of entries) {
      const row =
        bySource.all(e.source_path)[0] ||
        byHash.get(e.kind, e.title, e.content_hash);
      if (!row || row.body !== e.body) {
        results.push({
          path: e.source_path,
          status: 'FAIL',
          detail: row ? 'body mismatch' : 'missing row',
        });
        fail += 1;
        ok = false;
      }
    }
    if (ok) {
      results.push({ path: origin, status: 'PASS' });
      pass += 1;
    }
  }

  return {
    pass,
    fail,
    total: pass + fail,
    results,
    ok: fail === 0,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printReport(report) {
  const lines = [
    '=== memory-import report ===',
    `files_seen:           ${report.files_seen}`,
    `files_non_md_skipped: ${report.files_non_md_skipped}`,
    `files_planned:        ${report.files_planned}`,
    `entries_planned:      ${report.entries_planned}`,
    `imported:             ${report.imported}`,
    `deduped_skipped:      ${report.deduped_skipped}`,
    `registry_skipped:     ${report.registry_skipped}`,
    `split_count:          ${report.split_count}`,
    `bytes_in:             ${report.bytes_in}`,
    `bytes_stored_planned: ${report.bytes_stored_planned}`,
    `bytes_stored_inserted:${report.bytes_stored_inserted}`,
    `dry_run:              ${report.dry_run}`,
    'per_kind:',
  ];
  for (const [k, v] of Object.entries(report.per_kind).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${k}: ${v}`);
  }
  if (report.parity) {
    lines.push(
      `parity: ${report.parity.ok ? 'PASS' : 'FAIL'} (${report.parity.pass}/${report.parity.total})`,
    );
    for (const r of report.parity.results) {
      if (r.status === 'FAIL') {
        lines.push(`  FAIL ${r.path}${r.detail ? ' — ' + r.detail : ''}`);
      }
    }
    // Also print PASS summary count; optionally first few PASS lines when verbose
    const fails = report.parity.results.filter((r) => r.status === 'FAIL');
    if (fails.length === 0) {
      lines.push(`  all ${report.parity.pass} origin files PASS`);
    }
  }
  // Live import does not notify the exporter — operator/lead must flush.
  lines.push('NOTE: refresh any file projection explicitly after live import');
  console.log(lines.join('\n'));
}

function parseArgs(argv) {
  const opts = {
    src: null,
    dbPath: null,
    dryRun: false,
    report: false,
    doParity: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') opts.src = argv[++i];
    else if (a === '--db') opts.dbPath = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--report') opts.report = true;
    else if (a === '--parity') opts.doParity = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function usage() {
  return `Usage: node memory-import.mjs --src <dir> [--db <memory.db>] [--dry-run] [--report] [--parity]

  --src       agent-memory root (default from env MEMORY_SRC or standard path)
  --db        path to existing memory.db (schema v1; required for write / parity)
  --dry-run   plan + report only, zero DB writes
  --report    print counts
  --parity    after import (or against existing DB) verify byte parity; FAIL → exit 1
`;
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(String(err?.message || err));
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(usage());
    return;
  }

  const src = opts.src || process.env.MEMORY_SRC;
  if (!src) {
    console.error('error: --src or MEMORY_SRC is required');
    process.exitCode = 2;
    return;
  }

  if (!opts.dryRun && !opts.dbPath) {
    console.error('error: --db is required unless --dry-run');
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (opts.doParity && !opts.dbPath) {
    console.error('error: --parity requires --db');
    process.exitCode = 2;
    return;
  }

  try {
    const { report } = runImport({
      src,
      dbPath: opts.dbPath,
      dryRun: opts.dryRun,
      doParity: opts.doParity,
      report: opts.report,
    });
    if (opts.report || opts.dryRun || opts.doParity) printReport(report);
    if (report.parity && !report.parity.ok) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`memory-import FATAL: ${err?.message || err}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
