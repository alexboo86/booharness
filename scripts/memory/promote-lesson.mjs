#!/usr/bin/env node
import { dbArgument, readLessons, requireServiceWrite } from './service-client.mjs';
// Promote inbox lessons (links.status=inbox) → active via memoryctl supersede.
// Dedup against active by {domain, anchor, title} + content_hash.
// Duplicates → update-evidence supersede (never a second active copy).
//
// Usage: node scripts/memory/promote-lesson.mjs <domain>|--all [--id <n> ...] [--dry] [--db <path>]
//
// --id narrows the run to the named inbox lessons. The curate procedure judges
// PER ITEM - a lesson whose anchor lives only on a branch stays in inbox - and
// a whole-domain promotion cannot express that (2026-09-11: 159 inbox lessons,
// 41 of them anchored to files master does not have).

import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/is-main.mjs';

import {
  REPO_ROOT,
  DOMAINS_ROOT,
  anchorFile,
  buildLessonLinks,
  classifyAnchor,
  globResolves,
  isGlobAnchor,
  listRepoPaths,
  lessonDedupKey,
  parseLinks,
  filterLessons,
  resolveMemoryctl,
  runMemoryctl,
  sha256,
} from './lesson-lib.mjs';

/**
 * The legacy duplicate check did not exclude the row being superseded, so a status-only
 * supersede with identical body 409s on UNIQUE(kind,title,content_hash).
 * Stamp the body so the replacement hash is distinct (content preserved).
 * @param {string} body
 * @param {string} tag
 */
export function stampBody(body, tag = 'promoted') {
  let b = String(body ?? '');
  // Drop prior promote/close stamps to avoid unbounded growth
  b = b.replace(/\n- (?:promoted|closed-dup): .+$/gm, '');
  if (!b.endsWith('\n')) b += '\n';
  return `${b}- ${tag}: ${new Date().toISOString()}\n`;
}

/**
 * The links a promoted (or closed) row keeps from the row it came from.
 *
 * Promotion rebuilds `links` rather than editing it, and every field not named
 * here is DROPPED. Measured by review 2026-08-05: `probe` was not named, so a
 * lesson captured with its own check reached active status without one — while
 * its body still printed the `- probe:` line, which is exactly the drift the
 * probe mechanism exists to catch. `globs` had the same hole: only a glob-shaped
 * anchor was re-derived, so an explicit list was lost.
 *
 * @param {Record<string, unknown>} links the inbox row's links
 * @param {string} domain the domain being promoted, used when links omit it
 * @param {'active'|'inbox'} status
 */
export function carriedLinks(links, domain, status) {
  const source = links || {};
  const built = buildLessonLinks({
    domain: String(source.domain || domain),
    anchor: String(source.anchor || ''),
    status,
    trigger: source.trigger ? String(source.trigger) : undefined,
    globs: Array.isArray(source.globs) ? source.globs.map(String) : [],
    probe: source.probe ?? undefined,
  });
  return built;
}

/**
 * Build active index maps for dedup.
 * @param {ReturnType<typeof filterLessons>} active
 */
export function buildActiveIndex(active) {
  /** @type {Map<string, typeof active[0]>} */
  const byKey = new Map();
  /** @type {Map<string, typeof active[0]>} */
  const byHash = new Map();
  for (const row of active) {
    const links = row.linksObj || parseLinks(row.links);
    const key = lessonDedupKey({
      domain: String(links.domain || ''),
      anchor: String(links.anchor || ''),
      title: String(row.title || ''),
    });
    byKey.set(key, row);
    byHash.set(String(row.content_hash), row);
  }
  return { byKey, byHash };
}

/** The file half of an anchor lives in lesson-lib.mjs (shared with reanchor
 * and lesson-duplicates); re-exported here for its tests. */
export { anchorFile };

/**
 * Decide promote action for one inbox lesson.
 * @param {(anchor: string) => boolean} [exists] resolves an anchor against the tree
 * @returns {'promote'|'dedupe-hash'|'dedupe-key'|'skip'|'skip-anchor-missing'}
 */
export function decidePromote(inboxRow, index, exists) {
  const links = inboxRow.linksObj || parseLinks(inboxRow.links);
  // Already closed as duplicate (see closeInboxAsDup)
  if (links.closed === true) return 'skip';

  // A lesson whose anchor is not in this checkout cannot be DELIVERED: the
  // anchor is the only route, so promoting it buys nobody anything and turns
  // `check-domain-routing` red, which blocks every other commit until someone
  // parks it back. The file header has said so in prose since 2026-09-11 and it
  // stopped nobody — it happened again twice on 2026-09-18, once to the author
  // of the lesson warning about it. Prose is not a gate.
  // A GLOB anchor is deliverable when it matches something, not when a file of
  // that literal name exists — `src/app/**` never does. Judged by existsSync
  // alone, every glob lesson was skipped forever, so the glob mechanism that
  // lesson-lib, the store and the delivery endpoint all implement had no route
  // in through the sanctioned capture path. Measured 2026-09-20: of the lessons
  // delivered for a Rust source file, eight of eight matched by anchor and
  // none by glob. That is why a crate-wide fact — "this crate cannot be
  // built on Windows" — sat in memory as an undelivered `reference` from
  // 2026-08-11 while four coder seats in a row walked into it.
  if (exists && (isGlobAnchor(links.anchor) || anchorFile(links.anchor)) && !exists(links.anchor)) {
    return 'skip-anchor-missing';
  }

  const hash = String(inboxRow.content_hash || sha256(String(inboxRow.body || '')));
  if (index.byHash.has(hash)) return 'dedupe-hash';
  const key = lessonDedupKey({
    domain: String(links.domain || ''),
    anchor: String(links.anchor || ''),
    title: String(inboxRow.title || ''),
  });
  if (index.byKey.has(key)) return 'dedupe-key';
  return 'promote';
}

/**
 * @param {object} opts
 * @param {string} opts.arg  domain | --all
 * @param {boolean} [opts.dry]
 * @param {string} [opts.dbPath]
 */
/// The domain (or --all) is the first operand that is neither a flag nor a
/// flag's value, wherever it sits: `--dry --id 5` used to read '--dry' as a
/// domain and promote nothing, silently (review r2, kimi).
export function pickDomainArg(argv, ids) {
  const operand = argv.find((value, index) => (value === '--all' || !value.startsWith('--'))
    && !['--id', '--db'].includes(argv[index - 1]));
  return operand ?? (ids && ids.size ? '--all' : undefined);
}

/// The inbox rows a run may touch: all of them, or only the named ids.
export function selectInbox(rows, ids) {
  if (!ids || !ids.size) return rows;
  return rows.filter((row) => ids.has(Number(row.id)));
}

export async function promoteLessons(opts) {
  const dry = Boolean(opts.dry);
  const dbPath = opts.dbPath;
  requireServiceWrite(dbPath, dry);
  const lessons = await readLessons({ dbPath });

  let domains;
  if (opts.arg === '--all') {
    const domainsRoot = DOMAINS_ROOT;
    domains = fs
      .readdirSync(domainsRoot)
      .filter((d) => d.startsWith('domain-') && fs.existsSync(path.join(domainsRoot, d)));
  } else {
    const d = opts.arg.startsWith('domain-') ? opts.arg : `domain-${opts.arg}`;
    domains = [d];
  }

  if (!dry) {
    // Prove memoryctl before mutating
    resolveMemoryctl(REPO_ROOT);
  }

  const activeAll = filterLessons(lessons, { status: 'active' });
  const index = buildActiveIndex(activeAll);
  // Resolved against THIS checkout, which is the same tree `sweep-anchors` and
  // `check-domain-routing` read. A worktree that lacks a file master has is
  // the caller's problem to notice — the skip names itself in the table.
  // Literal anchors use the sweep's classifier, including file:symbol and
  // file:line drift. Globs resolve against TRACKED paths, not a literal file.
  // One glob engine (`matchGlob`, lesson-lib.mjs:741) serves delivery and sweep.
  let trackedPaths = null;
  const anchorExists = (anchor) => {
    if (isGlobAnchor(anchor)) {
      // listRepoPaths scrubs GIT_DIR and friends like the sweep does.
      if (trackedPaths === null) trackedPaths = listRepoPaths(REPO_ROOT);
      return globResolves(anchor, trackedPaths);
    }
    return classifyAnchor(anchor, (file) => {
      const location = path.join(REPO_ROOT, file);
      return fs.statSync(location, { throwIfNoEntry: false })?.isFile()
        ? fs.readFileSync(location, 'utf8') : null;
    }) === 'keep';
  };

  let promoted = 0;
  let deduped = 0;
  let skipped = 0;
  /** @type {{ domain: string, title: string, action: string, id: number }[]} */
  const table = [];

  for (const domain of domains) {
    const inbox = selectInbox(filterLessons(lessons, { status: 'inbox', domain }), opts.ids).filter((row) => {
      const L = row.linksObj || parseLinks(row.links);
      return L.closed !== true;
    });
    for (const row of inbox) {
      const action = decidePromote(row, index, anchorExists);
      const title = String(row.title || '');
      const id = Number(row.id);
      const links = row.linksObj || parseLinks(row.links);

      if (action === 'skip-anchor-missing') {
        skipped += 1;
        table.push({ domain, title, action: `skipped: anchor ${JSON.stringify(links.anchor)} does not resolve in this checkout; re-anchor before promotion`, id });
        continue;
      }

      if (action === 'skip') {
        skipped += 1;
        table.push({ domain, title, action: 'skipped', id });
        continue;
      }

      if (action === 'dedupe-hash') {
        // Exact content already active → close quarantine (no second active copy)
        deduped += 1;
        table.push({ domain, title, action: 'deduped-hash', id });
        if (!dry) closeInboxAsDup(row, domain);
        continue;
      }

      if (action === 'dedupe-key') {
        // Same {domain,anchor,title} active, different body → update-evidence on active
        // then close inbox as dup (never a second active copy).
        deduped += 1;
        table.push({ domain, title, action: 'deduped-key-update-evidence', id });
        if (!dry) {
          const key = lessonDedupKey({
            domain: String(links.domain || domain),
            anchor: String(links.anchor || ''),
            title,
          });
          const activeRow = index.byKey.get(key);
          if (activeRow) {
            const newBody = stampBody(String(row.body), 'promoted');
            const newLinks = carriedLinks(links, domain, 'active');
            supersedeRow(activeRow, { title, body: newBody, links: newLinks });
            closeInboxAsDup(row, domain);
            index.byHash.set(sha256(newBody), { ...activeRow, body: newBody, content_hash: sha256(newBody), linksObj: newLinks });
          }
        }
        continue;
      }

      // Fresh promote
      promoted += 1;
      table.push({ domain, title, action: dry ? 'would-promote' : 'promoted', id });
      if (!dry) {
        const newLinks = carriedLinks(links, domain, 'active');
        const newBody = stampBody(String(row.body), 'promoted');
        supersedeRow(row, { title, body: newBody, links: newLinks });
        const promotedRow = {
          ...row,
          body: newBody,
          content_hash: sha256(newBody),
          linksObj: newLinks,
          status: 'active',
        };
        index.byKey.set(
          lessonDedupKey({
            domain: String(newLinks.domain),
            anchor: String(newLinks.anchor || ''),
            title,
          }),
          promotedRow,
        );
        index.byHash.set(String(promotedRow.content_hash), promotedRow);
      }
    }
  }

  // Print table
  console.log('domain\ttitle\taction\tid');
  for (const r of table) {
    console.log(`${r.domain}\t${r.title.slice(0, 60)}\t${r.action}\t${r.id}`);
  }
  console.log(
    `promote: ${promoted} promoted, ${deduped} deduped, ${skipped} skipped across ${domains.length} domain(s)${dry ? ' (dry)' : ''}`,
  );
  return { promoted, deduped, skipped, table };
}

/**
 * Close an inbox row without creating a second active lesson.
 * Stays status=inbox + links.closed=true so it is never injected and not re-promoted.
 * Body is stamped so the supersede uniqueness check passes.
 */
function closeInboxAsDup(row, domain) {
  const links = row.linksObj || parseLinks(row.links);
  const closedLinks = { ...carriedLinks(links, domain, 'inbox'), closed: true };
  supersedeRow(row, {
    title: String(row.title),
    body: stampBody(String(row.body), 'closed-dup'),
    links: closedLinks,
  });
}

function supersedeRow(row, { title, body, links }) {
  runMemoryctl(
    [
      'supersede',
      '--id', String(row.id),
      '--title', title,
      '--body-file', '-',
      '--links', JSON.stringify(links),
      '--session', process.env.MEMORYCTL_SESSION_ID || 'promote',
      '--agent', process.env.MEMORYCTL_AGENT_ID || 'promote-lesson',
    ],
    { cwd: REPO_ROOT, input: body },
  );
}

if (isMain(import.meta.url)) {
  try {
    const ids = new Set();
    process.argv.forEach((value, index) => {
      if (value !== '--id') return;
      const id = Number(process.argv[index + 1]);
      if (!Number.isInteger(id) || id <= 0) {
        console.error(`--id expects a lesson id, got ${JSON.stringify(process.argv[index + 1])}`);
        process.exit(1);
      }
      ids.add(id);
    });
    // The domain (or --all) is the first operand that is neither a flag nor a
    // flag's value, wherever it sits: `--dry --id 5` used to read '--dry' as a
    // domain and promote nothing, silently (review r2, kimi).
    const arg = pickDomainArg(process.argv.slice(2), ids);
    if (!arg) {
      console.error('usage: promote-lesson.mjs <domain>|--all [--id <n> ...] [--dry] [--db <path>]');
      process.exit(1);
    }
    const dry = process.argv.includes('--dry');
    const dbPath = dbArgument();
    await promoteLessons({ arg, dry, dbPath, ids });
  } catch (err) {
    console.error(String(err?.message || err));
    process.exit(typeof err?.status === 'number' && err.status !== 0 ? err.status : 1);
  }
}
