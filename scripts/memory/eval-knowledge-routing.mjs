#!/usr/bin/env node
// Frozen case set for knowledge-routing evaluation (task 1653 slice 1).
//
// The question a later slice asks is "did `routeKnowledgeSections` (the map
// render) deliver the knowledge sections this seat needed?" Both
// sides must be fixed in time: the orch DB keeps growing and knowledge pages
// keep being rewritten, so a set recomputed tomorrow answers a different
// question. This script builds the set once and writes it as tracked JSON.
//
// Read-only on every input: orch.sqlite opened read-only through node:sqlite,
// pages and file lists read from git objects, never written. No behaviour change.
//
// Pages at the turn's time. A seat saw the page as it read when its turn ran, so
// each case's page is taken from git at that moment: the last commit on master
// (first-parent) at or before the turn's start (`git rev-list -1 --first-parent
// --before=<iso> master`), then `git show <sha>:<page>`. A page absent at that
// commit means the domain had no page then — recorded as missing, never
// substituted with today's page. The pageStore key carries that commit.
//
// Sample. Eligible: first turns (seq 1) of coder and reviewer seats that had
// files. Coder seats carry structured files (seats.data.taskFiles, mirrored by
// the seat.files_added event); reviewer seats carry none (taskFiles is null on
// every one of them), so a reviewer's files are the repo paths its brief names.
// Eligible turns are sorted by created_at (then turn id) and taken by an even
// stride — `strideSample`, the sampler of eval-delivery-set.mjs — so the sample
// spreads across dates, and therefore across the domains those dates worked in.
//
// Proxy gold. A section is gold when a path it cites overlaps the files the seat
// demonstrably worked on: `changedFiles` of a coder's final report, or the files
// a reviewer cited in finding evidence. A cited bare basename (leads.ts:42) is
// resolved to a repo path only when unambiguous: one match among the case's own
// files first, else one match in the commit's file list. Unresolved and
// ambiguous citations stay unresolved and are counted in the manifest. This is
// a proxy measured by path overlap, never a Jev judgment. Cases whose gold is
// empty are kept and counted — they measure false positives.
//
// Storage. Git already holds page history immutably, so the frozen file stores
// per page only {domain, commit, path, pageHash, section headings/offsets} under
// pageStore, keyed "<domain>@<commit12>"; a case references its pages by
// pageRef and carries only its gold marks ({pageRef, at, goldAnchors}) — every
// other section is non-gold by exclusion. Bodies are read back through the
// exported loadPage(), which verifies pageHash. Briefs stay stored: slice 2
// routes by brief text. The frozen file is compact JSON — its consumer is
// JSON.parse through the loader, and the manifest is the human surface.
//
// Manifest. `<out>.manifest.json` (the eval-delivery-set naming) carries counts
// per role and domain, the empty-gold count, citation-resolution counts and the
// proxy's limits.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isMain } from '../lib/is-main.mjs';
import { strideSample } from './eval-delivery-set.mjs';
import { scrubbedGitEnv } from '../git-env.mjs';
import { domainsOfFiles, splitPage, routeKnowledgeSections, renderKnowledgePage, KNOWLEDGE_BUDGET_PER_PAGE,
  knowledgeDomainOf, readKnowledgePage } from '../../ops/bootstrap/knowledge-page-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DB = path.join(process.env.HOME ?? '~', '.local/state/orch/orch.sqlite');
// Repo-relative with forward slashes: also the path `git show <sha>:<path>` takes.
const ROUTING_REL = 'docs/agent/domain-routing.generated.json';
export const ROUTING = path.join(root, ROUTING_REL);
export const OUT = path.join(root, 'scripts/memory/eval-knowledge-routing.frozen.json');
export const TARGET = 60;

const hash = (value) => createHash('sha256').update(value).digest('hex');
const norm = (file) => String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
const git = (repo, args) => execFileSync('git', args,
  { env: scrubbedGitEnv(), cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** The last commit on master (first-parent) at or before the turn's start. */
export function turnCommit(repo, iso) {
  const out = git(repo, ['rev-list', '-1', '--first-parent', `--before=${iso}`, 'master']).trim();
  if (!out) throw new Error(`no master commit at or before ${iso}`);
  return out;
}

/** The page body at a commit, or null when the page did not exist there. */
export function pageAtCommit(repo, commit, relPath) {
  const read = (file) => {
    try {
      return git(repo, ['show', `${commit}:${file}`]);
    } catch (error) {
      // Absence is not permission to replace revision bytes with today's page.
      if (/does not exist in|exists on disk, but not in/i.test(String(error.stderr ?? ''))) return null;
      throw error;
    }
  };
  const domain = knowledgeDomainOf(relPath);
  return domain && relPath.endsWith('/knowledge.md')
    ? readKnowledgePage(domain, read)?.text ?? null : read(relPath);
}

/** The commit's file list — `git ls-files`' content at a past commit. */
export function lsFilesAt(repo, commit) {
  return git(repo, ['ls-tree', '-r', '--name-only', commit]).split('\n').filter(Boolean);
}

/**
 * Repo paths and path:symbols cited in text. A token needs at least one '/' (a
 * bare filename is not identifiable as a repo path) and must look path-like: a
 * trailing '/' (a directory), a file extension, or a segment carrying '.', '_',
 * '-' or capitals ("and/or" has none; "native-desktop/qml" has). A URL's host
 * tail ("com/x.md") is blocked by the lookbehind, so both sides of an overlap
 * cannot share the same noise token.
 */
export function extractAnchors(text) {
  return [...new Set([...anchorMatches(text)].map(({ token }) => token))];
}

/** Every place of text that cites a slash path, repeats kept: the token and where it starts. */
function* anchorMatches(text) {
  for (const match of String(text ?? '').matchAll(/(?<![\w:@/.\-])(?:[\w.@+-]+\/)+[\w.@+-]*/g)) {
    let token = match[0];
    if (!token.endsWith('/')) token = token.replace(/[.+-]+$/, '');
    if (!token) continue;
    const segments = token.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    const keep = token.endsWith('/') || /\.[A-Za-z0-9]+$/.test(last)
      || segments.some((seg) => /[._-]/.test(seg) || /[A-Z]/.test(seg));
    if (keep) yield { token, index: match.index };
  }
}

/**
 * Bare filename citations (leads.ts:42): a name with an extension, not the tail
 * of a slash path, name at least two characters and carrying a letter. They are
 * anchors only after `resolveCitations` places them in the repo.
 */
export function extractBareNames(text) {
  return [...new Set([...bareNameMatches(text)].map(({ token }) => token))];
}

/** Every place of text that cites a bare filename, repeats kept: the token and where it starts. */
function* bareNameMatches(text) {
  for (const match of String(text ?? '').matchAll(/(?<![\w:@/.\-])[\w-]*[A-Za-z_][\w-]*\.[A-Za-z0-9]+/g)) {
    const token = match[0].replace(/[.+-]+$/, '');
    const name = token.slice(0, token.lastIndexOf('.'));
    if (token && name.length >= 2) yield { token, index: match.index };
  }
}

/**
 * Every citation of text as a repo path. A bare basename resolves only when
 * unambiguous: exactly one match among the case's own files first, else exactly
 * one match in the commit's file list. Ambiguous and unmatched stay unresolved.
 * When `exists` is given, every pushed path must pass it — the real filter
 * behind "the brief names a file that exists".
 */
export function resolveCitations(text, { files = [], lsFiles = [], exists = null } = {}) {
  const paths = [];
  const unresolved = [];
  const ambiguous = [];
  const push = (file) => {
    if (!file || (exists && !exists(file))) return;
    if (!paths.includes(file)) paths.push(file);
  };
  for (const anchor of extractAnchors(text)) push(anchor);
  for (const name of extractBareNames(text)) {
    const named = (file) => file === name || file.endsWith(`/${name}`);
    const inCase = files.filter(named);
    if (inCase.length === 1) { push(inCase[0]); continue; }
    if (inCase.length > 1) { ambiguous.push(name); continue; }
    const inTree = lsFiles.filter(named);
    if (inTree.length === 1) push(inTree[0]);
    else if (inTree.length > 1) ambiguous.push(name);
    else unresolved.push(name);
  }
  return { paths, unresolved, ambiguous };
}

/** An anchor names a file when it equals it, or names the directory holding it. */
export function anchorOverlaps(anchor, file) {
  const a = norm(anchor);
  const f = norm(file);
  if (!a || !f) return false;
  return a === f || (a.endsWith('/') && f.startsWith(a));
}

/** Gold overlap ignores top-level directory anchors (src/, native-desktop/ —
 * one segment ending in '/'): they name nearly every file. Directory anchors of
 * depth >= 2 stay. */
export const isTopLevelDir = (anchor) => anchor.endsWith('/') && anchor.split('/').filter(Boolean).length === 1;

/** The gold marks of one section: which of its cited paths overlap the worked files. */
export function sectionGold(sectionText, workedFiles, ctx = {}) {
  const files = (workedFiles ?? []).map(norm).filter(Boolean);
  const resolved = resolveCitations(sectionText, ctx);
  const anchors = resolved.paths.filter((anchor) => !isTopLevelDir(anchor))
    .filter((anchor) => files.some((file) => anchorOverlaps(anchor, file)));
  return { gold: anchors.length > 0, goldAnchors: anchors };
}

/** The router's candidate sections, via the library's own splitter
 *  (splitPage = knowledge-page-lib.mjs:28): the `## ` chunks after the head. */
export function pageSections(body) {
  return splitPage(body).sections.map((section, at) => {
    const lines = section.trimEnd().split('\n');
    return { at, heading: lines[0].trim(), body: lines.slice(1).join('\n').trim() };
  });
}

/** The section as the router sees it: heading line plus body. */
export const sectionText = (section) => `${section.heading}\n${section.body}`;

/** Read one frozen page's sections back from git at its frozen commit, verified
 *  against the frozen hash. Slice 2 loads every body through this; the frozen
 *  file never stores body text. */
export function loadPage(entry, repo = root) {
  return pageSections(loadPageBody(entry, repo));
}

/** One frozen page's body from git at its frozen commit, hash-verified. Slice 2
 *  feeds the router these bodies; the frozen file never stores body text. */
export function loadPageBody(entry, repo = root) {
  const body = pageAtCommit(repo, entry.commit, entry.path);
  if (body === null) throw new Error(`page ${entry.path} absent at ${entry.commit}`);
  if (hash(body) !== entry.pageHash) throw new Error(`page hash mismatch for ${entry.path} at ${entry.commit}`);
  return body;
}

/**
 * What a seat actually receives from one page render, classified per section:
 * 'full' (the section text rides whole), 'clipped' (its opening lines and the
 * cut marker), 'index' (only its title in the index line — or nothing, when the
 * head alone overflows the budget). The render is knowledge-page-lib.mjs's own
 * renderKnowledgePage with the same budget and selected set seatContext's call
 * through routeKnowledgeSections uses (ops/orchestrator/src/context.ts):
 * selected === null reproduces the map render (knowledgeSections); a list of
 * section indexes is the seam for a future ranker's arm. Two identical sections
 * both classify 'full' when one is kept —
 * accepted, pages do not carry duplicate sections.
 */
export function classifyDelivery({ domain, body, files = [], budget = KNOWLEDGE_BUDGET_PER_PAGE, selected = null }) {
  const render = renderKnowledgePage(domain, body, files, budget, selected === null ? null : new Set(selected));
  const classes = splitPage(body).sections.map((section) => {
    const full = section.trimEnd();
    if (full && render.includes(full)) return 'full';
    if (render.includes(section.split('\n', 1)[0])) return 'clipped';
    return 'index';
  });
  return { classes, bytes: Buffer.byteLength(render, 'utf8'), render };
}

/**
 * The gold anchor LINES of one gold mark: the lines of its section that cite one
 * of the mark's goldAnchors. A line cites an anchor when it carries it as a
 * slash path (extractAnchors — the regex cannot cross a line break, so a line's
 * tokens are the section's tokens on that line) or as a bare filename that is
 * the anchor's basename (extractBareNames). The bare rule goes by basename and
 * does not repeat the freeze's tree resolution: a bare name the freeze resolved
 * to another file of the same basename still counts here.
 */
export function goldAnchorLines(section, goldAnchors = []) {
  if (!goldAnchors.length) return [];
  return String(section ?? '').split('\n').filter((line) => goldCitations(line, goldAnchors).length);
}

/** The places of one line that cite a gold anchor, as [start, end) of the cited token. */
function goldCitations(line, goldAnchors) {
  return [
    ...[...anchorMatches(line)].filter(({ token }) => goldAnchors.includes(token)),
    ...[...bareNameMatches(line)].filter(({ token }) => goldAnchors.some((anchor) => anchor === token || anchor.endsWith(`/${token}`))),
  ].map(({ token, index }) => [index, index + token.length]);
}

// The characters of its line an occurrence carries on each side of the anchor.
export const OCCURRENCE_CONTEXT = 40;

/**
 * The gold OCCURRENCES of one gold mark: every place of its section that cites
 * one of the mark's goldAnchors (goldAnchorLines' citing rule, so a line that
 * cites twice holds two). Each is returned as its passage: the anchor with
 * OCCURRENCE_CONTEXT characters of its line on each side, cut at the ends of
 * the line (trailing whitespace aside, as in goldLineDelivery).
 */
export function goldOccurrences(section, goldAnchors = []) {
  if (!goldAnchors.length) return [];
  return String(section ?? '').split('\n').flatMap((raw) => {
    const line = raw.trimEnd();
    return goldCitations(line, goldAnchors)
      .map(([start, end]) => line.slice(Math.max(0, start - OCCURRENCE_CONTEXT), end + OCCURRENCE_CONTEXT));
  });
}

/**
 * Line-level delivery of one page render: how many gold anchor lines of the
 * given marks the page holds, and how many of them ride whole in the render.
 * A line rides when the render carries it as a line of its own (trailing
 * whitespace aside: the renderer trims a section's end), so the number does not
 * depend on where a section starts or stops. A gold line whose text also stands
 * elsewhere in the render counts as delivered — the same accepted limit as
 * classifyDelivery's duplicate sections.
 */
export function goldLineDelivery({ body, render, marks = [], maxBytes = Infinity }) {
  const { sections } = splitPage(body);
  const shown = new Set(String(render ?? '').split('\n').map((line) => line.trimEnd()));
  const lines = marks.flatMap((mark) => goldAnchorLines(sections[mark.at], mark.goldAnchors))
    .filter((line) => Buffer.byteLength(line, 'utf8') <= maxBytes);
  return { gold: lines.length, delivered: lines.filter((line) => shown.has(line.trimEnd())).length };
}

/**
 * Occurrence-level delivery of one page render: how many gold occurrences of
 * the given marks the page holds, and how many of their passages are in the
 * render. Unlike a whole line, a passage survives a cut inside its line, so a
 * render that delivers the sentence around an anchor of a 20 KB paragraph is
 * counted. A passage whose text also stands elsewhere in the render counts as
 * delivered — the limit goldLineDelivery accepts, wider here for a short line.
 */
export function goldOccurrenceDelivery({ body, render, marks = [] }) {
  const { sections } = splitPage(body);
  const shown = String(render ?? '');
  const passages = marks.flatMap((mark) => goldOccurrences(sections[mark.at], mark.goldAnchors));
  return { gold: passages.length, delivered: passages.filter((passage) => shown.includes(passage)).length };
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const key = (pageRef, at) => `${pageRef}:${at}`;

/**
 * Score routeKnowledgeSections against the frozen proxy gold. One arm, `map`:
 * the deterministic render every seat receives (operator decision #12450
 * dropped the Jev arm; its 2026-09-26 run stays recorded as history in
 * eval-knowledge-routing.score.json). The arm is scored on what its real render
 * delivers (classifyDelivery over renderKnowledgePage with the seat budget),
 * never on the pre-budget selection: recall is content-reached
 * (full-or-clipped) with a full-only level beside it, precision is over the
 * delivered content, and the pre-budget candidate count stays as an
 * informational column. Results keep the per-arm shape (`arms.map`), so a
 * future deterministic ranker adds an arm beside it: classifyDelivery takes
 * its selected section indexes.
 */

export function score({
  frozen = JSON.parse(fs.readFileSync(OUT, 'utf8')),
  repo = root,
  routing = null,
  routingCommit = null,
  budget = KNOWLEDGE_BUDGET_PER_PAGE,
  loadBody = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (routing === null) {
    // The working tree's map, or (--routing-commit) the map git holds at a
    // commit: the tree's map moves on after a freeze, the frozen one stays in history.
    const raw = routingCommit ? pageAtCommit(repo, routingCommit, ROUTING_REL) : fs.readFileSync(ROUTING, 'utf8');
    if (raw === null) throw new Error(`no routing map at commit ${routingCommit}: ${ROUTING_REL} is absent there`);
    routing = JSON.parse(raw);
    // The cases were routed with this exact map at freeze time; a drifted map
    // would score different domains than the gold marks assume.
    if (frozen.source?.routingHash && hash(raw) !== frozen.source.routingHash) {
      throw new Error(routingCommit
        ? `routing map drifted since freeze: ${ROUTING_REL} at commit ${routingCommit} does not match frozen.source.routingHash; pass --routing-commit <sha> of a commit whose map does`
        : `routing map drifted since freeze: ${ROUTING} no longer matches frozen.source.routingHash; score --routing-commit <sha> reads the map from git at a commit whose map does`);
    }
  }
  loadBody ??= (entry) => loadPageBody(entry, repo);
  const bodies = new Map();
  const bodyFor = (pageRef) => {
    if (!bodies.has(pageRef)) bodies.set(pageRef, loadBody(frozen.pageStore[pageRef]));
    return bodies.get(pageRef);
  };
  const cases = [];
  for (const entry of frozen.cases) {
    const pageByDomain = new Map(entry.pages.map((page) => [page.domain, page.pageRef]));
    const domains = domainsOfFiles(entry.files, routing);
    const pageFor = (domain) => (pageByDomain.has(domain) ? bodyFor(pageByDomain.get(domain)) : null);
    const candidates = domains.flatMap((domain) => {
      const pageRef = pageByDomain.get(domain);
      if (!pageRef) return [];
      return pageSections(bodyFor(pageRef)).map((section, at) => ({ pageRef, at }));
    });
    const goldKeys = new Set((entry.gold?.sections ?? []).map((mark) => key(mark.pageRef, mark.at)));
    const { source } = routeKnowledgeSections({ files: entry.files, map: routing, pageFor, budget });
    // Score what the seat receives, not the pre-budget candidates: re-render
    // every page with the same function and budget the seat context builder
    // uses, and classify each section's delivery.
    const report = { source, preBudget: candidates.length };
    const classes = {};
    const delivered = { full: 0, clipped: 0, index: 0 };
    // One render per domain of the case: its bytes and its gold anchor lines.
    const byDomain = {};
    const lines = { gold: 0, delivered: 0 };
    const shortLines = { gold: 0, delivered: 0 };
    const occurrences = { gold: 0, delivered: 0 };
    let bytes = 0;
    for (const domain of domains) {
      const pageRef = pageByDomain.get(domain);
      if (!pageRef) continue;
      const render = classifyDelivery({ domain, body: bodyFor(pageRef), files: entry.files, budget });
      bytes += render.bytes;
      render.classes.forEach((delivery, at) => {
        classes[key(pageRef, at)] = delivery;
        delivered[delivery]++;
      });
      const marks = (entry.gold?.sections ?? []).filter((mark) => mark.pageRef === pageRef);
      const reached = goldLineDelivery({ body: bodyFor(pageRef), render: render.render, marks });
      const short = goldLineDelivery({ body: bodyFor(pageRef), render: render.render, marks, maxBytes: 1024 });
      const cited = goldOccurrenceDelivery({ body: bodyFor(pageRef), render: render.render, marks });
      byDomain[domain] = { bytes: render.bytes, gold: reached.gold, delivered: reached.delivered, shortLines: short, occurrences: cited };
      lines.gold += reached.gold;
      lines.delivered += reached.delivered;
      shortLines.gold += short.gold;
      shortLines.delivered += short.delivered;
      occurrences.gold += cited.gold;
      occurrences.delivered += cited.delivered;
    }
    report.classes = classes;
    report.delivered = delivered;
    report.bytes = bytes;
    report.byDomain = byDomain;
    report.lines = lines;
    report.shortLines = shortLines;
    report.occurrences = occurrences;
    if (goldKeys.size) {
      const reached = (delivery) => delivery === 'full' || delivery === 'clipped';
      const hits = [...goldKeys].filter((mark) => reached(classes[mark])).length;
      const hitsFull = [...goldKeys].filter((mark) => classes[mark] === 'full').length;
      const content = delivered.full + delivered.clipped;
      report.hits = hits;
      report.recall = hits / goldKeys.size;
      report.recallFull = hitsFull / goldKeys.size;
      report.precision = content ? hits / content : 0;
      report.precisionFull = delivered.full ? hitsFull / delivered.full : 0;
    }
    cases.push({ id: entry.id, role: entry.role, gold: goldKeys.size, arms: { map: report } });
  }
  const summarize = (arm, subset) => {
    const scored = subset.filter((entry) => entry.arms[arm].recall !== undefined);
    const hits = scored.reduce((total, entry) => total + entry.arms[arm].hits, 0);
    const gold = scored.reduce((total, entry) => total + entry.gold, 0);
    const content = scored.reduce((total, entry) => total + entry.arms[arm].delivered.full + entry.arms[arm].delivered.clipped, 0);
    return {
      cases: subset.length, scored: scored.length,
      recall: mean(scored.map((entry) => entry.arms[arm].recall)),
      recallFull: mean(scored.map((entry) => entry.arms[arm].recallFull)),
      precision: mean(scored.map((entry) => entry.arms[arm].precision)),
      precisionFull: mean(scored.map((entry) => entry.arms[arm].precisionFull)),
      micro: { recall: gold ? hits / gold : null, precision: content ? hits / content : null },
      bytes: subset.reduce((total, entry) => total + entry.arms[arm].bytes, 0),
      preBudget: subset.reduce((total, entry) => total + entry.arms[arm].preBudget, 0),
      delivered: subset.reduce((total, entry) => {
        const d = entry.arms[arm].delivered;
        return { full: total.full + d.full, clipped: total.clipped + d.clipped, index: total.index + d.index };
      }, { full: 0, clipped: 0, index: 0 }),
    };
  };
  const roles = [...new Set(cases.map((entry) => entry.role))].sort();
  const arms = { map: { all: summarize('map', cases) } };
  for (const role of roles) arms.map[role] = summarize('map', cases.filter((entry) => entry.role === role));
  // Per domain and in total: the rendered bytes of a page (the render alone,
  // without the "## Knowledge:" heading the brief puts above it) and the share
  // of gold anchor lines that ride whole. `share` pools the lines; `shareByCase`
  // is the mean over the cases that hold a gold line, the level of `recall`.
  // `occurrences` is the same pair of shares over the gold occurrences.
  const pooled = (counts) => {
    const gold = counts.reduce((total, count) => total + count.gold, 0);
    const reached = counts.reduce((total, count) => total + count.delivered, 0);
    const scored = counts.filter((count) => count.gold);
    return { cases: scored.length, gold, delivered: reached, share: gold ? reached / gold : null,
      shareByCase: mean(scored.map((count) => count.delivered / count.gold)) };
  };
  const summarizeRenders = (rows) => {
    const sizes = rows.flatMap((row) => row.bytes);
    return {
      cases: rows.length, renders: sizes.length,
      bytes: { mean: mean(sizes), max: sizes.length ? Math.max(...sizes) : null },
      lines: pooled(rows),
      shortLines: pooled(rows.map((row) => row.shortLines)),
      occurrences: pooled(rows.map((row) => row.occurrences)),
    };
  };
  const rendersOf = (arm, domain) => cases.flatMap((entry) => {
    const report = entry.arms[arm];
    if (domain === null) {
      const sizes = Object.values(report.byDomain).map((row) => row.bytes);
      return sizes.length ? [{ bytes: sizes, ...report.lines, shortLines: report.shortLines, occurrences: report.occurrences }] : [];
    }
    const row = report.byDomain[domain];
    return row ? [{ ...row, bytes: [row.bytes] }] : [];
  });
  const domains = { map: { all: summarizeRenders(rendersOf('map', null)) } };
  for (const domain of [...new Set(cases.flatMap((entry) => Object.keys(entry.arms.map.byDomain)))].sort()) {
    domains.map[domain] = summarizeRenders(rendersOf('map', domain));
  }
  return { generatedAt: now(), arms, domains, cases };
}

export function scoreTable(results) {
  const pct = (value) => (value === null || value === undefined ? '  -  ' : (value * 100).toFixed(1).padStart(5));
  const lines = ['arm  role      cases scored   rec recFull   prec precFull preBudget bytes',
    '---  -------- ----- ------ ----- ------- ------ -------- --------- -----'];
  for (const arm of Object.keys(results.arms)) {
    for (const role of Object.keys(results.arms[arm])) {
      const s = results.arms[arm][role];
      lines.push(`${arm}   ${role.padEnd(8)} ${String(s.cases).padStart(5)} ${String(s.scored).padStart(6)} ${pct(s.recall)} ${pct(s.recallFull)} ${pct(s.precision)} ${pct(s.precisionFull)} ${String(s.preBudget).padStart(9)} ${String(s.bytes).padStart(6)}`);
    }
  }
  return lines.join('\n');
}

/** The per-domain table of a score: rendered bytes and line-level gold delivery. */
export function domainTable(results) {
  const pct = (value) => (value === null || value === undefined ? '  -  ' : (value * 100).toFixed(1).padStart(5));
  const lines = ['arm  domain                     cases renders bytesMean bytesMax goldLines delivered share byCase',
    '---  -------------------------- ----- ------- --------- -------- --------- --------- ----- ------'];
  for (const arm of Object.keys(results.domains)) {
    for (const domain of Object.keys(results.domains[arm])) {
      const s = results.domains[arm][domain];
      const size = s.bytes.mean === null ? '-' : s.bytes.mean.toFixed(0);
      lines.push(`${arm}   ${domain.padEnd(26)} ${String(s.cases).padStart(5)} ${String(s.renders).padStart(7)} ${size.padStart(9)} ${String(s.bytes.max ?? '-').padStart(8)} ${String(s.lines.gold).padStart(9)} ${String(s.lines.delivered).padStart(9)} ${pct(s.lines.share)} ${pct(s.lines.shareByCase).padStart(6)}`);
    }
  }
  return lines.join('\n');
}

/** The per-domain table of a score's gold delivery: whole lines beside occurrences. */
export function occurrenceTable(results) {
  const pct = (value) => (value === null || value === undefined ? '  -  ' : (value * 100).toFixed(1).padStart(5));
  const lines = ['arm  domain                     goldLines delivered share occurrences delivered share byCase',
    '---  -------------------------- --------- --------- ----- ----------- --------- ----- ------'];
  for (const arm of Object.keys(results.domains)) {
    for (const domain of Object.keys(results.domains[arm])) {
      const { lines: whole, occurrences: cited } = results.domains[arm][domain];
      lines.push(`${arm}   ${domain.padEnd(26)} ${String(whole.gold).padStart(9)} ${String(whole.delivered).padStart(9)} ${pct(whole.share)} ${String(cited.gold).padStart(11)} ${String(cited.delivered).padStart(9)} ${pct(cited.share)} ${pct(cited.shareByCase).padStart(6)}`);
    }
  }
  return lines.join('\n');
}

/** Compare the same frozen cases, never just the occurrence headline. */
export function compareScores(before, after) {
  if (JSON.stringify(before.cases.map(({ id }) => id)) !== JSON.stringify(after.cases.map(({ id }) => id))) {
    throw new Error('score comparison requires the same frozen cases');
  }
  const domains = {};
  const failures = [];
  const mustRise = new Set(['domain-harness', 'domain-platform-shell', 'domain-chart-engine']);
  for (const [domain, next] of Object.entries(after.domains.map)) {
    const prior = before.domains.map[domain];
    if (!prior?.shortLines || prior.lines.gold !== next.lines.gold
      || prior.shortLines.gold !== next.shortLines.gold || prior.occurrences.gold !== next.occurrences.gold) {
      throw new Error(`${domain}: comparison requires matching gold counts and short-line metrics`);
    }
    const metrics = (result, row) => ({
      occurrences: row.occurrences.delivered, lines: row.lines.delivered,
      shortLines: row.shortLines.delivered,
      bytes: domain === 'all' ? result.arms.map.all.bytes
        : result.cases.reduce((sum, entry) => sum + (entry.arms.map.byDomain[domain]?.bytes ?? 0), 0),
      maxBytes: row.bytes.max,
    });
    domains[domain] = { before: metrics(before, prior), after: metrics(after, next) };
    if (next.occurrences.delivered < prior.occurrences.delivered
      || (mustRise.has(domain) && next.occurrences.delivered === prior.occurrences.delivered)) {
      failures.push(`${domain}: occurrence delivery must ${mustRise.has(domain) ? 'rise' : 'not fall'}`);
    }
    if (next.shortLines.delivered < prior.shortLines.delivered) failures.push(`${domain}: short whole-line delivery fell`);
    if (next.bytes.max > KNOWLEDGE_BUDGET_PER_PAGE + 1536) failures.push(`${domain}: render exceeds byte cap`);
  }
  for (const domain of Object.keys(before.domains.map)) {
    if (!domains[domain]) throw new Error(`${domain}: missing from after score`);
  }
  return { domains, failures };
}

export function comparisonTable({ domains, failures }) {
  const rows = ['domain                      occurrences wholeLines lines<=1024 renderedBytes maxBytes (before -> after)'];
  for (const [domain, { before, after }] of Object.entries(domains)) {
    rows.push(`${domain.padEnd(27)} ${before.occurrences}->${after.occurrences} ${before.lines}->${after.lines} ${before.shortLines}->${after.shortLines} ${before.bytes}->${after.bytes} ${before.maxBytes}->${after.maxBytes}`);
  }
  rows.push(failures.length ? `FAIL: ${failures.join('; ')}` : 'PASS: delivery and byte-cap criteria');
  return rows.join('\n');
}

// The paragraph size the report counts above.
export const PARAGRAPH_LARGE = 2048;

/**
 * Paragraph sizes of one page body. A paragraph is a block of lines between
 * blank lines; its size is the bytes of the block without the blank lines
 * around it. Median and p90 are nearest-rank values, so each is the size of a
 * real paragraph.
 */
export function paragraphStats(body, large = PARAGRAPH_LARGE) {
  const sizes = [];
  let block = [];
  const flush = () => {
    if (block.length) sizes.push(Buffer.byteLength(block.join('\n'), 'utf8'));
    block = [];
  };
  for (const line of String(body ?? '').split('\n')) {
    if (line.trim()) block.push(line);
    else flush();
  }
  flush();
  sizes.sort((a, b) => a - b);
  const rank = (share) => (sizes.length ? sizes[Math.ceil(share * sizes.length) - 1] : null);
  return { count: sizes.length, median: rank(0.5), p90: rank(0.9), max: rank(1),
    large: sizes.filter((size) => size > large).length };
}

/** Paragraph sizes of every knowledge page of the working tree. Reads only. */
export function paragraphReport({ repo = root } = {}) {
  const dir = path.join(repo, '.agents/domains');
  const pages = [];
  for (const domain of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, domain, 'knowledge.md');
    if (!fs.existsSync(file)) continue;
    const body = readKnowledgePage(domain, (rel) => fs.readFileSync(path.join(repo, rel), 'utf8')).text;
    pages.push({ domain, bytes: Buffer.byteLength(body, 'utf8'), ...paragraphStats(body) });
  }
  return pages;
}

export function paragraphTable(pages) {
  const lines = [`domain                      bytes count median    p90    max >${PARAGRAPH_LARGE}`,
    '-------------------------- ------ ----- ------ ------ ------ -----'];
  for (const page of pages) {
    lines.push(`${page.domain.padEnd(26)} ${String(page.bytes).padStart(6)} ${String(page.count).padStart(5)} ${String(page.median ?? '-').padStart(6)} ${String(page.p90 ?? '-').padStart(6)} ${String(page.max ?? '-').padStart(6)} ${String(page.large).padStart(5)}`);
  }
  return lines.join('\n');
}

/** Deterministic sample: chronological (created_at, then id), then an even stride. */
export function sampleCases(rows, n = TARGET) {
  const sorted = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1
    : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return strideSample(sorted, n);
}

/** The report JSON block of a final message, or null when there is none. */
export function reportOf(text) {
  const match = String(text ?? '').match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string').map(norm).filter(Boolean) : []);

/** Files the turn demonstrably worked on: coder `changedFiles`, reviewer evidence. */
export function workedFilesOf(role, report, ctx = {}) {
  if (role === 'coder') {
    return { files: list(report?.changedFiles), source: 'report.changedFiles', report: Boolean(report),
      unresolved: [], ambiguous: [] };
  }
  const evidence = (report?.findings ?? []).flatMap((finding) => [finding?.evidence].flat())
    .filter((item) => typeof item === 'string');
  const resolution = resolveCitations(evidence.join('\n'), ctx);
  return { files: resolution.paths, source: 'report.findings[].evidence', report: Boolean(report),
    unresolved: resolution.unresolved, ambiguous: resolution.ambiguous };
}

export function manifestPath(out) {
  return out.endsWith('.frozen.json') ? out.replace(/\.frozen\.json$/, '.manifest.json') : `${out}.manifest.json`;
}

export function collectCase(row, { routing, git: gitAt, exists }) {
  const lsFiles = gitAt.lsFiles(row.commit);
  const ctx = { files: [...list(row.taskFiles), ...list(row.filesAdded)], lsFiles };
  const briefFiles = row.role === 'reviewer'
    ? resolveCitations(row.brief, { ...ctx, exists }).paths
    : [];
  const files = [...new Set([...list(row.taskFiles), ...list(row.filesAdded), ...briefFiles])].sort();
  ctx.files = files;
  const filesSource = list(row.taskFiles).length || list(row.filesAdded).length
    ? 'seats.data.taskFiles + seat.files_added' : 'brief-named paths (reviewer seats carry no structured files)';
  const worked = workedFilesOf(row.role, row.report, ctx);
  const routedDomains = domainsOfFiles(files, routing);
  const pages = [];
  const pageMissing = [];
  const goldSections = [];
  for (const domain of routedDomains) {
    const body = readKnowledgePage(domain, (rel) => gitAt.pageAt(row.commit, rel))?.text ?? null;
    if (body === null) { pageMissing.push({ domain, commit: row.commit }); continue; }
    const pageRef = `${domain}@${row.commit.slice(0, 12)}`;
    for (const section of pageSections(body)) {
      const marks = sectionGold(sectionText(section), worked.files, ctx);
      if (marks.gold) goldSections.push({ pageRef, at: section.at, goldAnchors: marks.goldAnchors });
    }
    pages.push({ domain, pageRef });
  }
  return {
    id: row.id, role: row.role, createdAt: row.createdAt, commit: row.commit, brief: row.brief,
    files, filesSource, routedDomains, pageMissing, pages,
    gold: { files: worked.files, source: worked.source, report: worked.report,
      sections: goldSections, empty: goldSections.length === 0,
      citations: { unresolved: worked.unresolved, ambiguous: worked.ambiguous } },
  };
}

export function freeze({ dbFile = DB, out = OUT, target = TARGET, repo = root, now = () => new Date().toISOString() } = {}) {
  const routing = JSON.parse(fs.readFileSync(ROUTING, 'utf8'));
  const gitAt = {
    commit: (iso) => turnCommit(repo, iso),
    lsFiles: (commit) => lsFilesAt(repo, commit),
    // pageAtCommit assembles entry pages; collectCase also accepts a raw
    // revision reader, so parts remain ordinary revision files here.
    pageAt: (commit, relPath) => pageAtCommit(repo, commit, relPath),
  };
  const exists = (file) => {
    try { return fs.statSync(path.join(root, file)).isFile(); } catch { return false; }
  };
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let rows;
  let watermark = { turns: 0, maxTurnCreatedAt: null };
  try {
    const filesAdded = new Map();
    for (const event of db.prepare("SELECT seat_id, payload FROM events WHERE kind = 'seat.files_added'").all()) {
      try {
        const files = list(JSON.parse(event.payload)?.files);
        if (files.length) filesAdded.set(event.seat_id, [...new Set([...(filesAdded.get(event.seat_id) ?? []), ...files])]);
      } catch { /* A payload that is not JSON carries no files. */ }
    }
    const [mark] = db.prepare('SELECT COUNT(*) AS turns, MAX(created_at) AS maxTurnCreatedAt FROM turns').all();
    watermark = { turns: Number(mark.turns), maxTurnCreatedAt: mark.maxTurnCreatedAt };
    rows = db.prepare(`SELECT t.id AS id, t.prompt AS brief, t.text AS text, t.created_at AS createdAt,
         t.started_at AS startedAt, s.role AS role, s.data AS data
       FROM turns t JOIN seats s ON s.id = t.seat_id
       WHERE s.role IN ('coder', 'reviewer') AND t.seq = 1`).all()
      .map((row) => {
        let taskFiles = [];
        try { taskFiles = list(JSON.parse(row.data)?.taskFiles); } catch { /* Unparseable data carries no files. */ }
        return {
          id: row.id, role: row.role, createdAt: row.createdAt,
          at: row.startedAt || row.createdAt, brief: row.brief,
          taskFiles, filesAdded: filesAdded.get(String(row.id).replace(/\.\d+$/, '')) ?? [],
          report: reportOf(row.text),
        };
      })
      .filter((row) => list(row.taskFiles).length || list(row.filesAdded).length
        || (row.role === 'reviewer' && extractAnchors(row.brief).some((anchor) => exists(anchor))));
  } finally {
    db.close();
  }
  const sample = sampleCases(rows, target).map((row) => ({ ...row, commit: gitAt.commit(row.at) }));
  const cases = sample.map((row) => collectCase(row, { routing, git: gitAt, exists }));
  const pageStore = {};
  for (const entry of cases) {
    for (const page of entry.pages) {
      const relPath = `.agents/domains/${page.domain}/knowledge.md`;
      const body = gitAt.pageAt(entry.commit, relPath);
      pageStore[page.pageRef] = {
        domain: page.domain, path: relPath, commit: entry.commit, pageHash: hash(body),
        sections: pageSections(body).map(({ at, heading }) => ({ at, heading })),
      };
    }
  }
  const limits = [
    'Proxy gold is path overlap on cited paths, never a Jev judgment: a section citing no resolvable path can never be gold.',
    'Top-level directory anchors (src/, one segment ending in "/") never count for gold overlap; directory anchors of depth >= 2 do.',
    'Bare basenames resolve to a repo path only when unambiguous (one case-file match, else one commit-tree match); unresolved and ambiguous citations are counted.',
    "Coder worked files are `changedFiles` of the final report; a turn without a parseable report has empty gold (counted).",
    'Reviewer seats carry no structured files; their files are the brief-named paths that pass the exists() filter (a worktree file at freeze time).',
    'Reviewer worked files are the paths cited in finding evidence; existence is not filtered there.',
    'Pages and file lists come from git at the turn-start commit on master (first-parent); a page absent then is recorded missing and never replaced by today\'s page.',
    'Page bodies are not stored: loadPage() reads `git show <commit>:<path>` and verifies pageHash; pageStore keeps headings and offsets only, and a case\'s gold.sections are the gold marks — every other section is non-gold by exclusion.',
  ];
  const frozen = {
    generatedAt: now(),
    source: { db: dbFile, routing: path.relative(root, ROUTING), routingHash: hash(fs.readFileSync(ROUTING, 'utf8')),
      repo, ref: 'master (first-parent) at the turn-start commit' },
    sampling: { method: 'strideSample over eligible turns sorted by (createdAt, id)', target,
      eligible: rows.length, sampled: cases.length },
    proxy: { gold: 'section cited-path overlap with worked files', limits },
    pageStore,
    cases,
  };
  const byRole = {};
  const byDomain = {};
  const emptyGoldByRole = {};
  const citations = { unresolved: 0, ambiguous: 0 };
  let emptyGold = 0;
  let noReport = 0;
  let pageMissing = 0;
  for (const entry of cases) {
    byRole[entry.role] = (byRole[entry.role] ?? 0) + 1;
    for (const domain of entry.routedDomains) byDomain[domain] = (byDomain[domain] ?? 0) + 1;
    if (entry.gold.empty) {
      emptyGold++;
      emptyGoldByRole[entry.role] = (emptyGoldByRole[entry.role] ?? 0) + 1;
    }
    if (!entry.gold.report) noReport++;
    pageMissing += entry.pageMissing.length;
    citations.unresolved += entry.gold.citations.unresolved.length;
    citations.ambiguous += entry.gold.citations.ambiguous.length;
  }
  const manifest = {
    generatedAt: frozen.generatedAt,
    db: watermark,
    cases: cases.length, eligible: rows.length, byRole, byDomain,
    emptyGold, emptyGoldByRole, turnsWithoutReport: noReport,
    pageStoreEntries: Object.keys(pageStore).length, pageMissing,
    citationResolution: citations,
    sampling: frozen.sampling,
    proxy: frozen.proxy,
  };
  fs.writeFileSync(out, JSON.stringify(frozen));
  manifest.frozenBytes = fs.statSync(out).size;
  fs.writeFileSync(manifestPath(out), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const options = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--out') options.out = path.resolve(argv[++i]);
    else if (argv[i] === '--count') options.target = Number(argv[++i]);
    else if (argv[i] === '--db') options.dbFile = path.resolve(argv[++i]);
    else if (argv[i] === '--routing-commit') options.routingCommit = argv[++i];
    else if (argv[i] === '--before') options.before = path.resolve(argv[++i]);
    else { console.error(`unknown argument: ${argv[i]}`); process.exitCode = 2; }
  }
  if (command === 'score' && process.exitCode !== 2) {
    try {
      const results = score(options);
      if (options.before) results.comparison = compareScores(JSON.parse(fs.readFileSync(options.before, 'utf8')), results);
      // The Jev-vs-map run of 2026-09-26 stays in eval-knowledge-routing.score.json as history.
      const out = options.out ?? path.join(root, 'scripts/memory/eval-knowledge-routing.map-score.json');
      fs.writeFileSync(out, JSON.stringify(results));
      console.log(scoreTable(results));
      console.log(`\n${domainTable(results)}`);
      console.log(`\n${occurrenceTable(results)}`);
      if (results.comparison) {
        console.log(`\n${comparisonTable(results.comparison)}`);
        if (results.comparison.failures.length) process.exitCode = 1;
      }
      console.log(`wrote ${path.relative(root, out)}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else if (command === 'paragraphs' && process.exitCode !== 2) {
    console.log(paragraphTable(paragraphReport()));
  } else if (command !== 'freeze' || process.exitCode === 2) {
    console.error('usage: eval-knowledge-routing.mjs freeze [--out path] [--count n] [--db path]');
    console.error('       eval-knowledge-routing.mjs score [--out path] [--routing-commit sha] [--before score.json]');
    console.error('       eval-knowledge-routing.mjs paragraphs');
    process.exitCode = 2;
  } else {
    try {
      const manifest = freeze(options);
      console.log(JSON.stringify({ cases: manifest.cases, byRole: manifest.byRole, emptyGold: manifest.emptyGold,
        emptyGoldByRole: manifest.emptyGoldByRole, turnsWithoutReport: manifest.turnsWithoutReport,
        pageMissing: manifest.pageMissing, citationResolution: manifest.citationResolution,
        byDomain: manifest.byDomain }));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
