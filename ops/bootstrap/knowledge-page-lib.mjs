// Pure delivery helpers for the domain knowledge pages (operator decision
// 2026-09-20, `.agents/domains/_domain-routing.schema.md` — "knowledge.md —
// the domain's knowledge page"). They live outside the seat context builder
// because that file carries a shebang, which a test runner's module transform
// cannot parse — the helpers are the testable surface, the builder is not.
import { domainOf } from '../../scripts/lib/domain-of.mjs';
import { scrubbedGitEnv } from '../../scripts/git-env.mjs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A page rides into a seat prompt, so it answers to a prompt budget, not to the
 * lesson store's 48 KB one. Measured 2026-09-21: the 40 KB harness page rode
 * whole into every harness seat and turned a 2 KB brief into a 50 KB prompt that
 * the lead paid to paste and the seat paid to read; the operator rejected it.
 */
export const KNOWLEDGE_BUDGET_PER_PAGE = 6 * 1024;

// Separate from the head/section budget: 6 KiB + this allowance + the
// knowledgeSections heading stays below the hook's 8 KiB total context cap.
const KNOWLEDGE_INDEX_ALLOWANCE = 1536;
export const KNOWLEDGE_TOC_MARKER = '<!-- knowledge:toc -->';

export function knowledgePageRel(domain) {
  return `.agents/domains/${domain}/knowledge.md`;
}

/** The single path rule for a page and its immediate part files. */
export function knowledgeDomainOf(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '')
    .match(/^\.agents\/domains\/(domain-[a-z0-9]+(?:-[a-z0-9]+)*)\/(?:knowledge\.md|knowledge\/[a-z0-9]+(?:-[a-z0-9]+)*\.md)$/)?.[1] ?? null;
}

/** The fence rule of the reader: a ``` or ~~~ run indented by at most three
 *  spaces opens or closes a code fence (CommonMark); four spaces or more are
 *  content. The match carries the run in group 1. */
function fenceEdge(line) {
  return line.match(/^ {0,3}(`{3,}|~{3,})/);
}

/** The `## ` sections of one part file, fence-aware: a heading inside a code
 *  fence is content, not a boundary. Returns { title, text, offset } per
 *  section; the texts concatenate back to the input byte-for-byte. The reader
 *  uses this so a part an author has appended a new `## ` section to stays
 *  readable (and cuttable) until scripts/split-knowledge-page.mjs splits it. */
function partSections(text) {
  const out = [];
  let fence = null;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    let eol = text.indexOf('\n', i);
    if (eol === -1) eol = text.length;
    const bare = text.slice(i, eol).replace(/\r$/, '');
    const edge = fenceEdge(bare);
    if (edge) {
      const ch = edge[1][0];
      if (!fence) fence = { ch, len: edge[1].length };
      else if (fence.ch === ch && edge[1].length >= fence.len) fence = null;
    } else if (!fence && bare.startsWith('## ')) {
      if (out.length) out[out.length - 1].text = text.slice(start, i);
      out.push({ title: bare.slice(3), text: '', offset: i });
      start = i;
    }
    i = eol + 1;
  }
  if (out.length) out[out.length - 1].text = text.slice(start);
  return out;
}

/**
 * Read either layout through a repo-relative path callback (null for an absent
 * entry page). The TOC is metadata, never body. Parts carry their original
 * separators, so concatenation preserves every body byte.
 */
export function readKnowledgePage(domain, read) {
  if (!/^domain-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(domain)) throw new Error(`Invalid knowledge domain: ${domain}`);
  const file = knowledgePageRel(domain);
  const entry = read(file);
  if (entry === null || entry === undefined) return null;
  const bodyStart = entry.search(/^## /m);
  const marker = entry.match(/^<!-- knowledge:toc -->\r?$/m);
  const tocStart = marker && (bodyStart < 0 || marker.index < bodyStart) ? marker.index : -1;
  let head, body, tableOfContents = '', toc = [], sections;
  if (tocStart >= 0) {
    head = entry.slice(0, tocStart);
    tableOfContents = entry.slice(tocStart + marker[0].length).replace(/^\n/, '');
    const seen = new Set();
    sections = [];
    for (const line of tableOfContents.split(/\r?\n/).filter((line) => line.trim())) {
      const match = line.match(/^- \[(.+?)\]\(knowledge\/([a-z0-9]+(?:-[a-z0-9]+)*\.md)\): (.*)$/);
      if (!match) throw new Error(`${file}: invalid table of contents line: ${line}`);
      const [, title, slug, summary] = match;
      const partFile = file.replace(/knowledge\.md$/, `knowledge/${slug}`);
      if (seen.has(partFile)) throw new Error(`${partFile}: named more than once`);
      seen.add(partFile);
      if ([...summary].length > 200) throw new Error(`${partFile}: summary exceeds 200 characters`);
      const text = read(partFile);
      if (text === null || text === undefined) throw new Error(`${partFile}: missing part`);
      const chunks = partSections(text);
      if (sections.length > 0 && !sections.at(-1).text.endsWith('\n')) {
        throw new Error(`${sections.at(-1).file}: part does not end with a line end`);
      }
      if (chunks.length === 0 || chunks[0].offset !== 0 || chunks[0].title !== title) {
        throw new Error(`${partFile}: expected a part headed ## ${title}`);
      }
      toc.push({ title, summary, file: partFile });
      for (const chunk of chunks) {
        sections.push({ title: chunk.title, file: partFile, text: chunk.text,
          line: text.slice(0, chunk.offset).split('\n').length });
      }
    }
    body = sections.map((section) => section.text).join('');
  } else {
    const parts = partSections(entry);
    const start = parts[0]?.offset ?? entry.length;
    head = entry.slice(0, start);
    body = entry.slice(start);
    sections = parts.map(({ title, text, offset }) => ({ title, file, text,
      line: entry.slice(0, offset).split('\n').length }));
  }
  let firstLine = 1;
  const ranges = sections.map((section, at) => {
    const lines = (section.text.match(/\n/g) ?? []).length + (at === sections.length - 1 ? 1 : 0);
    const range = { section, firstLine, end: firstLine + lines };
    firstLine += lines;
    return range;
  });
  return { head, tableOfContents, toc, body, sections, text: head + body, split: tocStart >= 0,
    locate(bodyLine) {
      if (!Number.isInteger(bodyLine) || bodyLine < 1) throw new RangeError(`Invalid body line: ${bodyLine}`);
      const range = ranges.find(({ firstLine, end }) => bodyLine >= firstLine && bodyLine < end);
      if (!range) throw new RangeError(`Body line outside page: ${bodyLine}`);
      return { file: range.section.file, line: range.section.line + bodyLine - range.firstLine };
    } };
}

/** The `## ` chunks of a page: its head (everything before the first `## ` line),
 * then one chunk per section. The single splitter behind the renderer's cut and
 * the routing eval's sections — consumers must see the same sections. */
export function splitPage(body) {
  const [head, ...sections] = String(body ?? '').split(/\n(?=## )/);
  return { head, sections };
}

/** Unique domains of the given files, in first-seen order. */
export function domainsOfFiles(files, map) {
  const seen = new Set();
  const out = [];
  for (const file of files) {
    const domain = domainOf(file, map);
    if (domain && !seen.has(domain)) {
      seen.add(domain);
      out.push(domain);
    }
  }
  return out;
}

// All offsets below are UTF-8 bytes, not JS character offsets.
function runeBorder(bytes, at, direction) {
  while (at > 0 && at < bytes.length && (bytes[at] & 0xc0) === 0x80) at += direction;
  return at;
}

function codeSpans(bytes) {
  const spans = [], ticks = [], previous = new Map();
  // Scan bytes once; link equal-width runs, then keep the same greedy pairing.
  for (let at = 0; at < bytes.length; at++) {
    if (bytes[at] !== 96) continue;
    const start = at;
    while (bytes[at + 1] === 96) at++;
    const width = at - start + 1;
    const last = previous.get(width);
    if (last !== undefined) ticks[last].close = ticks.length;
    previous.set(width, ticks.length);
    ticks.push({ start, end: at + 1, close: -1 });
  }
  for (let i = 0; i < ticks.length; i++) {
    const close = ticks[i].close;
    if (close < 0) continue;
    spans.push([ticks[i].start, ticks[close].end]);
    i = close;
  }
  return spans;
}

function outsideCode(at, spans, right) {
  const span = spans.find(([start, end]) => start < at && at < end);
  return span ? span[right ? 1 : 0] : at;
}

function windowEnd(bytes, at, right, spans) {
  if (at <= 0 || at >= bytes.length) return at;
  const direction = right ? 1 : -1;
  const limit = right ? Math.min(bytes.length, at + 80) : Math.max(0, at - 80);
  let end = at;
  let found = false;
  // A left delimiter belongs to the preceding clause; a right delimiter to
  // this clause. Neither end moves inward from the nominal 240-byte window.
  for (let cursor = at; right ? cursor <= limit : cursor >= limit; cursor += direction) {
    if (cursor >= 2 && bytes[cursor - 1] === 32 && [59, 46, 58].includes(bytes[cursor - 2])) {
      end = cursor;
      found = true;
      break;
    }
  }
  if (!found) {
    while (end > 0 && end < bytes.length && bytes[end] !== 32) end += direction;
  }
  return outsideCode(runeBorder(bytes, end, direction), spans, right);
}

/** Opening plus hit windows, joined only when they touch. No test-only seam. */
function partPassages(section, needles, openingBytes, allowance, label) {
  const bytes = Buffer.from(section, 'utf8');
  const spans = codeSpans(bytes);
  const opening = outsideCode(runeBorder(bytes, Math.min(openingBytes, bytes.length), -1), spans, true);
  const ranges = opening ? [{ start: 0, end: opening, left: false, right: opening < bytes.length, priority: 3 }] : [];
  // Blank lines delimit paragraphs; retain every byte within a paragraph.
  for (const match of section.matchAll(/^[^\n]*\S[^\n]*(?:\n(?![ \t]*\r?$)[^\n]*)*/gm)) {
    const start = Buffer.byteLength(section.slice(0, match.index));
    const paragraph = Buffer.from(match[0], 'utf8');
    const paragraphSpans = codeSpans(paragraph);
    for (const needle of needles) {
      const token = Buffer.from(needle, 'utf8');
      for (let at = paragraph.indexOf(token); at >= 0; at = paragraph.indexOf(token, at + token.length)) {
        const left = paragraph.length <= 1024 ? 0
          : windowEnd(paragraph, Math.max(0, at - 240), false, paragraphSpans);
        const right = paragraph.length <= 1024 ? paragraph.length
          : windowEnd(paragraph, Math.min(paragraph.length, at + token.length + 240), true, paragraphSpans);
        ranges.push({ start: start + left, end: start + right, left: left > 0, right: right < paragraph.length,
          priority: needle.endsWith('/') ? 1 : 2 });
      }
    }
  }
  ranges.sort((a, b) => b.priority - a.priority || a.start - b.start || a.end - b.end);
  let joined = [];
  const text = ({ start, end, left, right }) =>
    `${left ? '…' : ''}${bytes.subarray(start, end).toString('utf8').trimEnd()}${right ? '…' : ''}`;
  const render = (windows) => windows.length ? label + windows.map(text).join('\n\n') : '';
  for (const range of ranges) {
    const candidate = [];
    for (const window of [...joined, range].sort((a, b) => a.start - b.start || a.end - b.end)) {
      const last = candidate.at(-1);
      if (last && window.start <= last.end) {
        if (window.end > last.end) { last.end = window.end; last.right = window.right; }
        else if (window.end === last.end) last.right &&= window.right;
      } else candidate.push({ ...window });
    }
    // Admit whole windows, never cut one to fill the budget. Joining before
    // admission means a dense paragraph cannot erase its already-fitting hits.
    if (Buffer.byteLength(render(candidate), 'utf8') <= allowance) joined = candidate;
  }
  return render(joined);
}

/**
 * The part of a page this seat needs. A page over the budget keeps its header,
 * then the ranked TOC within its own allowance. File-bearing parts get their
 * openings and file hits first; directory hits use the remainder. The first
 * opening is 400 bytes, later ones 160. Whole windows and per-part labels count
 * against the body budget. Both layouts use the same byte-window rules.
 * @param {string} domain
 * @param {string | ReturnType<typeof readKnowledgePage>} body
 * @param {string[]} files the seat's explicit files
 * @param {number} budget bytes, default KNOWLEDGE_BUDGET_PER_PAGE
 * @param {Set<number> | null} selected section indexes an evaluated ranker chose
 *   (scripts/memory/eval-knowledge-routing.mjs); null is the map rank every caller uses
 */
export function renderKnowledgePage(domain, body, files = [], budget = KNOWLEDGE_BUDGET_PER_PAGE, selected = null) {
  const page = typeof body === 'string' ? null : body;
  body = page ? page.text : body;
  const bytes = Buffer.byteLength(body, 'utf8');
  if (!page?.split && selected === null && bytes <= budget) return body;
  const rel = knowledgePageRel(domain);
  if (page?.split && selected === null && bytes <= budget) {
    const rendered = page.head + page.sections.map(({ text, file }) =>
      text.replace(/^## [^\n]*(?:\n|$)/, (heading) =>
        `${heading}${heading.endsWith('\n') ? '' : '\n'}[section file: ${file}]\n`)).join('');
    if (Buffer.byteLength(rendered, 'utf8') > budget + KNOWLEDGE_INDEX_ALLOWANCE) {
      throw new Error(`${rel}: section locations exceed the prompt cap`);
    }
    return rendered;
  }
  const { head, sections } = page
    ? { head: page.head, sections: page.sections.map(({ text }) => text) }
    : splitPage(body);
  const sectionFile = (at) => page?.split ? page.sections[at].file : rel;
  if (Buffer.byteLength(head, 'utf8') > budget) {
    // A byte cut can land mid-rune; the replacement characters it leaves at the
    // seam are dropped rather than shown.
    const cut = Buffer.from(head, 'utf8').subarray(0, budget).toString('utf8').replace(/�+$/, '');
    return `${cut}\n\n[truncated: the page weighs ${bytes} bytes and only the first ${budget} are here — read the full page: ${rel}]\n`;
  }
  // A section that names the file more often outranks one naming only its
  // directory. A top-level directory ("scripts/", "src/") names nearly every section.
  // Pages cite repo paths with forward slashes; a Windows `--files` path must match too.
  files = files.map((file) => file.replace(/\\/g, '/'));
  const parents = files.map((file) => file.slice(0, file.lastIndexOf('/') + 1)).filter((dir) => dir.split('/').length > 2);
  const ancestors = files.flatMap((file) => {
    const dirs = file.split('/').slice(0, -1);
    return dirs.map((_, at) => dirs.slice(0, at + 1).join('/') + '/');
  });
  const hits = (section, needle) => section.split(needle).length - 1;
  const rank = (section) => 2 * files.reduce((sum, file) => sum + hits(section, file), 0)
    + (parents.some((dir) => section.includes(dir))
      || ancestors.some((dir) => dir.split('/').length > 2
        && (section.includes(`\`${dir}\``) || section.includes(`\`${dir}**`))) ? 1 : 0);
  const order = sections.map((section, at) => ({ at, score: rank(section) }))
    .filter(({ at, score }) => selected === null ? score > 0 : selected.has(at))
    .sort((a, b) => selected === null ? b.score - a.score || a.at - b.at : a.at - b.at);
  const ranked = [...order.map(({ at }) => at), ...sections.map((_, at) => at).filter((at) => !order.some((pick) => pick.at === at))];
  // The TOC comes before passages and includes their parts too. Keep the
  // imperative instruction of task 2127 even when the titles must be shed.
  const prefix = `\n\n[Index: this ${bytes}-byte page is NOT shown in full — read the parts covering your question in ${rel} BEFORE reading more of this domain's source]\n`;
  let index = prefix;
  let shown = 0;
  for (const at of ranked) {
    const title = sections[at].split('\n', 1)[0].replace(/^##\s*/, '').trim();
    const summary = page?.sections.findIndex(({ file }) => file === sectionFile(at)) === at
      ? page.toc.find(({ file }) => file === sectionFile(at))?.summary
      : undefined;
    const line = `- [${title}](${sectionFile(at)})${summary ? `: ${summary}` : ''}\n`;
    const rest = `… and ${ranked.length - shown} more\n`;
    if (Buffer.byteLength(index + line + rest, 'utf8') > KNOWLEDGE_INDEX_ALLOWANCE) break;
    index += line;
    shown++;
  }
  if (shown < ranked.length) index += `… and ${ranked.length - shown} more\n`;
  let content = head.trimEnd();
  const fileNeedles = [...new Set([...files.filter(Boolean), ...files.map((file) => file.split('/').at(-1)).filter(Boolean)])];
  const needles = [...new Set([...fileNeedles, ...ancestors])];
  const size = (text) => Buffer.byteLength(text, 'utf8');
  const parts = [];
  let used = size(content);
  for (const [nth, { at, score }] of order.entries()) {
    const file = sectionFile(at);
    const footer = `\n[part of ${file}: read the file for the rest]`;
    const label = `[passage: ${file}]\n`;
    const fixed = size('\n\n' + footer);
    const remaining = budget - used - fixed - size(label);
    const opening = nth === 0 ? 400 : 160;
    const openingBytes = Math.min(opening, Math.max(0, remaining - 3));
    const text = remaining > 0 && (score >= 2 || selected !== null)
      ? partPassages(sections[at], fileNeedles, openingBytes, remaining + size(label), label)
      : '';
    parts.push({ at, footer, label, fixed, opening, openingBytes, text });
    if (text) used += size(text) + fixed;
  }
  // Reconsider each part with the bytes left after all file-bearing parts.
  for (const part of parts) {
    const own = part.text ? size(part.text) + part.fixed : 0;
    const remaining = budget - (used - own) - part.fixed - size(part.label);
    if (remaining <= 0) continue;
    // Keep an admitted opening intact: reserving a new ellipsis can otherwise
    // turn a complete short section into an equal-sized clipped replacement.
    const openingBytes = part.text ? part.openingBytes : Math.min(part.opening, Math.max(0, remaining - 3));
    const text = partPassages(sections[part.at], needles, openingBytes, remaining + size(part.label), part.label);
    if (text && size(text) >= size(part.text)) {
      used += size(text) + part.fixed - own;
      part.text = text;
    }
  }
  for (const part of parts) if (part.text) content += '\n\n' + part.text + part.footer;
  const rendered = head.trimEnd() + index + content.slice(head.trimEnd().length);
  if (Buffer.byteLength(rendered, 'utf8') > budget + KNOWLEDGE_INDEX_ALLOWANCE) throw new Error(`${rel}: render exceeds the prompt cap`);
  return rendered;
}

/**
 * Knowledge sections for the brief: one section per domain that owns a page,
 * then one line per domain that owns none — the gap reads as "not written",
 * never as "nothing is known". The page rides ABOVE the lessons (map first,
 * scars second) and reaches read-only roles too, which is the builder's call;
 * this function only orders pages before the gap line.
 * @param {string[]} files
 * @param {{ order: Array<{ glob: string, domain: string }> }} map
 * @param {(domain: string) => string | null} pageFor domain → page body, or null when there is no page
 * @param {number} budget bytes per page, default KNOWLEDGE_BUDGET_PER_PAGE
 * @returns {string[]}
 */
export function knowledgeSections(files, map, pageFor, budget = KNOWLEDGE_BUDGET_PER_PAGE) {
  if (!files.length) return [];
  const pages = [];
  const gaps = [];
  for (const domain of domainsOfFiles(files, map)) {
    const body = pageFor(domain);
    if (body === null) {
      gaps.push(`- ${domain}: no knowledge page yet (${knowledgePageRel(domain)})`);
      continue;
    }
    pages.push(`## Knowledge: ${domain}\n\n${renderKnowledgePage(domain, body, files, budget)}`);
  }
  if (gaps.length) pages.push(`## Knowledge gaps\n\n${gaps.join('\n')}`);
  return pages;
}

/** The knowledge sections a seat or the lead receives: always the deterministic
 * map render (knowledgeSections), never a model's selection. Operator decision
 * #12450 (2026-09-26) dropped Jev from section routing after the frozen eval
 * (scripts/memory/eval-knowledge-routing.score.json) measured content-reached
 * gold recall Jev 6.9% against the map render 49.4%. `source` is 'map' when a
 * page was rendered, 'none' when no domain of the files owns a page. */
export function routeKnowledgeSections({ files, map, pageFor, budget = KNOWLEDGE_BUDGET_PER_PAGE } = {}) {
  let rendered = false;
  const sections = knowledgeSections(files, map, (domain) => {
    const body = pageFor(domain);
    if (body !== null) rendered = true;
    return body;
  }, budget);
  return { sections, source: rendered ? 'map' : 'none' };
}

/** Derived FTS artifacts never open memory.db. No import-time I/O. */
function knowledgeIndexSource(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare('SELECT * FROM source').get() ?? null;
  } catch {
    return null; // Missing or damaged metadata must not wedge publication.
  } finally { db?.close(); }
}

export function knowledgeIndexCommit(file) {
  return knowledgeIndexSource(file)?.commit_sha ?? null;
}

function* knowledgePassages(text, budget) {
  if (budget < 4) throw new Error('knowledge heading exceeds passage budget');
  while (text) {
    let prefix = '', bytes = 0;
    for (const char of text) {
      if (bytes + Buffer.byteLength(char) > budget) break;
      prefix += char;
      bytes += Buffer.byteLength(char);
    }
    let end = prefix.length;
    if (end < text.length) {
      const blank = prefix.lastIndexOf('\n\n'), line = prefix.lastIndexOf('\n');
      if (blank >= 0) end = blank + 2;
      else if (line >= 0) end = line + 1;
    }
    yield text.slice(0, end);
    text = text.slice(end);
  }
}

function insertKnowledgePage(db, git, commit, file) {
  const domain = knowledgeDomainOf(file);
  if (!domain) throw new Error('invalid knowledge domain');
  const read = (file) => git('show', `${commit}:${file}`);
  const insert = db.prepare('INSERT INTO knowledge(path,heading,section_key,source_commit,body) VALUES (?,?,?,?,?)');
  const page = readKnowledgePage(domain, read);
  const preamble = { file, title: page.head.match(/^# (.+)$/m)?.[1] ?? '@preamble', text: page.head };
  const seen = new Map();
  for (const section of [preamble, ...page.sections]) {
    const identity = `${section.file}#${section.title}`.normalize('NFC');
    const ordinal = seen.get(identity) ?? 0;
    seen.set(identity, ordinal + 1);
    const key = createHash('sha256').update(`${identity}\0${ordinal}`).digest('hex');
    const budget = 1800 - Buffer.byteLength(`${section.file}#${section.title}\n`);
    for (const body of knowledgePassages(section.text, budget)) {
      insert.run(section.file, section.title, key, commit, body);
    }
  }
}

function populateKnowledge(db, git, commit, log) {
  const files = git('ls-tree', '-r', '--name-only', commit, '--', '.agents/domains').split('\n');
  const pages = files.filter((file) => /^\.agents\/domains\/[^/]+\/knowledge\.md$/.test(file));
  for (const file of pages) {
    db.exec('SAVEPOINT page');
    try {
      insertKnowledgePage(db, git, commit, file);
    } catch (error) {
      db.exec('ROLLBACK TO page');
      log(`knowledge index skipped ${file}: ${String(error.message).split('\n')[0]}`);
    } finally {
      db.exec('RELEASE page');
    }
  }
}

/** Read only pinned committed master blobs; publish a closed single-file DB. */
export function rebuildKnowledgeIndex({ repoRoot, indexPath, log = console.error }) {
  const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8', env: scrubbedGitEnv(), maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const temporary = `${indexPath}.${randomUUID()}.tmp`;
  let db;
  try {
    const commit = git('rev-parse', 'refs/heads/master').trim();
    const tree = git('rev-parse', `${commit}:.agents/domains`).trim();
    // The builder's own bytes cover chunking rules and the index schema: a code-only landing rebuilds.
    const builder = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
    const source = knowledgeIndexSource(indexPath);
    if (source?.domains_tree === tree && source.builder === builder) return { ok: true, changed: false, commit: source.commit_sha };
    mkdirSync(dirname(indexPath), { recursive: true, mode: 0o700 });
    closeSync(openSync(temporary, 'wx', 0o600));
    db = new DatabaseSync(temporary);
    db.exec(`BEGIN;
      CREATE TABLE source(commit_sha TEXT NOT NULL, domains_tree TEXT NOT NULL, builder TEXT NOT NULL);
      CREATE VIRTUAL TABLE knowledge USING fts5(path,heading,section_key UNINDEXED,source_commit UNINDEXED,body,tokenize='porter unicode61');`);
    db.prepare('INSERT INTO source VALUES (?,?,?)').run(commit, tree, builder);
    populateKnowledge(db, git, commit, log);
    db.exec('COMMIT');
    db.close();
    db = null;
    if (git('rev-parse', 'refs/heads/master').trim() !== commit) throw new Error('master moved during knowledge rebuild');
    renameSync(temporary, indexPath);
    return { ok: true, changed: true, commit };
  } catch (error) {
    log(`knowledge index rebuild failed: ${String(error.message).split('\n')[0]}`);
    return { ok: false };
  } finally {
    db?.close();
    rmSync(temporary, { force: true });
  }
}
