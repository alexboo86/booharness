#!/usr/bin/env node
// Report near-duplicate and opposite-polarity lesson pairs. READ-ONLY: reads
// memoryd like sweep-anchors.mjs and never writes to memory (no registry, no
// CAS, no mutation).
//
// Lessons (active + inbox) are grouped by anchor FILE (the part before ':').
// Within a group every pair gets two independent lexical checks:
//   - similarity: Jaccard of normalized word sets of title+rule (lowercase,
//     punctuation split, common stop-words removed); pairs at or above
//     --threshold (default 0.4) are reported.
//   - conflict candidates: same anchor file, parsed `- rule:` field only, high
//     rule-word overlap, rule-level polarity differs. A candidate is a pair
//     for the curator to read, never a verdict that the rules contradict:
//     no model judges it (decision #12433). A lesson without a parseable
//     `- rule:` field cannot be a candidate; the report counts those.
//     Independent of the similarity threshold.
// Output: a table per section, or one JSON object with --json.
//
// Usage: node scripts/memory/lesson-duplicates.mjs [--threshold 0.4] [--json]

import { readLessons } from './service-client.mjs';
import { lessonFields } from './lesson-quality.mjs';
import { anchorFile as anchorFileOf } from './lesson-lib.mjs';
import { isMain } from '../lib/is-main.mjs';

/** Default similarity threshold. The #11804/#11824 fixture scores 0.55, but
 * the only near-duplicate in live memory on 2026-09-25 (#11908/#11918, one JS
 * Math.round rule in two wordings) scores 0.43, so 0.5 reported nothing on real
 * data (reviewer-qwen-9e821e.1). The curator judges every pair; a false
 * positive costs one glance. */
export const DEFAULT_THRESHOLD = 0.4;

/** A rule counts as negated when it carries one of these markers anywhere —
 * polarity only SELECTS candidates ('no-op' can false-positive here; the
 * curator, not the regex, decides). */
const NEGATION_RE = /\b(?:never|not|no|don'?t|cannot|can'?t|won'?t|avoid|refuse|forbid\w*)\b/i;
/** Rule-word overlap (Jaccard of normalized word sets) at/above which a pair
 * is a candidate worth the curator's reading. */
const CANDIDATE_OVERLAP = 0.4;

// Function words only. "not" IS listed (negation carries no identity between
// two rules); "out" and "never" stay content words: dropping a shared word
// only lowers similarity, and the calibration pair in test-lesson-duplicates.mjs
// sits at or above 0.5 with this exact list. Change the list, recalibrate the test.
const STOP_WORDS = new Set(('a about above after again against all always am an and any are as at be because been before being '
  + 'below between both but by can cannot could did do does doing down during each few for from further had has have '
  + 'having he her here hers herself him himself his how i if in into is it its itself just me more most must my '
  + 'myself no nor not now of off on once only or other our ours ourselves over own same she should so some such than '
  + 'that the their theirs them themselves then there these they this those through to too under until up very was we '
  + 'were what when where which while who whom why will with would you your yours yourself yourselves').split(/\s+/));

/**
 * Normalized word SEQUENCE of a text (order preserved): lowercase,
 * punctuation acts as a word split ("re-lay-out" -> re/lay/out), stop-words
 * dropped. normalizeWordSet deduplicates this.
 * @param {string} text
 * @returns {string[]}
 */
export function normalizeWords(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
}

/**
 * Normalized word set of a text.
 * @param {string} text
 * @returns {Set<string>}
 */
export function normalizeWordSet(text) {
  return new Set(normalizeWords(text));
}

/**
 * Jaccard similarity of two texts: |A∩B| / |A∪B| over normalized word sets.
 * 0 when either side is empty after normalization.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function jaccardSimilarity(a, b) {
  const setA = normalizeWordSet(a);
  const setB = normalizeWordSet(b);
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Anchor FILE: the part before the first ':' (dir/symbol -> dir; a bare path
 * or glob stays whole). Core logic lives in lesson-lib.mjs (shared with
 * reanchor and promote; Windows-drive-letter aware); this wrapper names the
 * empty-anchor group.
 * @param {string} anchor
 * @returns {string}
 */
export function anchorFile(anchor) {
  return anchorFileOf(anchor) || '(no anchor)';
}

/**
 * The text a lesson is scored on: title + the `- rule:` field of its body.
 * An unparseable body still scores on the title alone.
 * @param {{ title?: unknown, body?: unknown }} row
 * @returns {string}
 */
export function lessonText(row) {
  let rule = '';
  try {
    rule = lessonFields(String(row.title ?? ''), String(row.body ?? ''), { partial: true, allowDuplicates: true }).rule || '';
  } catch {
    rule = '';
  }
  return `${String(row.title ?? '')}\n${rule}`;
}

/**
 * Score all same-anchor-file lesson pairs, keep those >= threshold,
 * sorted by similarity descending.
 * @param {Array<object>} lessons rows as filterLessons returns them (linksObj attached)
 * @param {number} threshold
 */
export function findDuplicatePairs(lessons, threshold = DEFAULT_THRESHOLD) {
  /** @type {Map<string, object[]>} */
  const groups = new Map();
  for (const row of lessons) {
    const links = row.linksObj || {};
    const file = anchorFile(links.anchor);
    const bucket = groups.get(file);
    if (bucket) bucket.push(row);
    else groups.set(file, [row]);
  }
  /** @type {Array<{ idA: number, idB: number, anchorFile: string, similarity: number, titleA: string, titleB: string, statusA: string, statusB: string }>} */
  const pairs = [];
  for (const [file, rows] of groups) {
    const texts = rows.map((row) => lessonText(row));
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const similarity = jaccardSimilarity(texts[i], texts[j]);
        if (similarity < threshold) continue;
        pairs.push({
          idA: Number(rows[i].id),
          idB: Number(rows[j].id),
          anchorFile: file,
          similarity: Number(similarity.toFixed(4)),
          titleA: String(rows[i].title ?? ''),
          titleB: String(rows[j].title ?? ''),
          statusA: String(rows[i].status ?? ''),
          statusB: String(rows[j].status ?? ''),
        });
      }
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity || x.idA - y.idA || x.idB - y.idB);
  for (const pair of pairs) pair.kind = 'similar';
  return pairs;
}

/**
 * Lexical CANDIDATE selection, nothing more: same-anchor-file pairs whose
 * parsed rules differ in polarity (one carries a negation marker) and share
 * enough rule words. A candidate is a question for the curator, never a verdict.
 * @param {string} ruleA
 * @param {string} ruleB
 * @returns {{ similarity: number } | null}
 */
export function candidatePair(ruleA, ruleB) {
  const a = String(ruleA ?? '');
  const b = String(ruleB ?? '');
  if (NEGATION_RE.test(a) === NEGATION_RE.test(b)) return null; // polarity must differ
  const similarity = jaccardSimilarity(a, b);
  if (similarity < CANDIDATE_OVERLAP) return null;
  return { similarity: Number(similarity.toFixed(4)) };
}

/**
 * Same-anchor-file opposite-polarity candidate pairs, highest rule overlap
 * first. Nothing is reported as a contradiction: the curator reads each pair.
 * @param {Array<object>} lessons rows as filterLessons returns them (linksObj attached)
 */
export function findConflicts(lessons) {
  const groups = new Map();
  for (const row of lessons) {
    const rule = lessonRule(row);
    if (!rule) continue;
    const links = row.linksObj || {};
    const file = anchorFile(links.anchor);
    const bucket = groups.get(file);
    if (bucket) bucket.push({ row, rule });
    else groups.set(file, [{ row, rule }]);
  }
  const pairs = [];
  for (const [file, entries] of groups) {
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const candidate = candidatePair(entries[i].rule, entries[j].rule);
        if (!candidate) continue;
        const { row: rowA } = entries[i];
        const { row: rowB } = entries[j];
        pairs.push({
          idA: Number(rowA.id),
          idB: Number(rowB.id),
          anchorFile: file,
          similarity: candidate.similarity,
          titleA: String(rowA.title ?? ''),
          titleB: String(rowB.title ?? ''),
          statusA: String(rowA.status ?? ''),
          statusB: String(rowB.status ?? ''),
        });
      }
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity || x.idA - y.idA || x.idB - y.idB);
  return pairs;
}

/**
 * The parsed `- rule:` field of a lesson (titles are context, not rules);
 * '' when the body has no parseable rule.
 * @param {{ title?: unknown, body?: unknown }} row
 * @returns {string}
 */
export function lessonRule(row) {
  try {
    return lessonFields(String(row.title ?? ''), String(row.body ?? ''), { partial: true, allowDuplicates: true }).rule || '';
  } catch {
    return '';
  }
}

function printTable(pairs) {
  if (!pairs.length) {
    console.log('no duplicate pairs at or above threshold');
    return;
  }
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const widths = { id: 0, file: 0 };
  for (const pair of pairs) {
    widths.id = Math.max(widths.id, `#${pair.idA}/#${pair.idB}`.length);
    widths.file = Math.max(widths.file, Math.min(pair.anchorFile.length, 48));
  }
  console.log(`${'ids'.padEnd(widths.id)}  ${'anchor file'.padEnd(widths.file)}  sim     titles`);
  for (const pair of pairs) {
    const ids = `#${pair.idA}/#${pair.idB}`.padEnd(widths.id);
    const file = clip(pair.anchorFile, 48).padEnd(widths.file);
    console.log(`${ids}  ${file}  ${pair.similarity.toFixed(3)}   ${clip(pair.titleA, 70)} | ${clip(pair.titleB, 70)}`);
  }
  console.log(`\nsimilarity pairs: ${pairs.length}`);
}

const clipText = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function printConflicts(pairs) {
  if (!pairs.length) {
    console.log('no candidates');
    return;
  }
  for (const pair of pairs) {
    console.log(`${pair.similarity.toFixed(3)}  ${pair.anchorFile}  #${pair.idA}/#${pair.idB}`);
    console.log(`  A #${pair.idA}: ${clipText(pair.titleA, 90)}`);
    console.log(`  B #${pair.idB}: ${clipText(pair.titleB, 90)}`);
  }
  console.log(`\ncandidates: ${pairs.length}`);
}

function parseThreshold(argv) {
  const index = argv.indexOf('--threshold');
  if (index === -1) return DEFAULT_THRESHOLD;
  const raw = argv[index + 1];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`--threshold needs a number in (0, 1], got ${JSON.stringify(raw)}`);
  }
  return value;
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.includes('--db')) throw new Error('REFUSED --db: duplicates report reads memoryd only');
    const threshold = parseThreshold(process.argv);
    const active = await readLessons({}, { status: 'active' });
    const inbox = await readLessons({}, { status: 'inbox' });
    const lessons = [...active, ...inbox];
    const similarity = findDuplicatePairs(lessons, threshold);
    const conflict = findConflicts(lessons);
    const withoutRule = lessons.filter((row) => !lessonRule(row)).map((row) => Number(row.id));
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ similarity, conflict, withoutRule }, null, 2));
    } else {
      console.log(`similarity >= ${threshold}`);
      printTable(similarity);
      console.log('\nconflict candidates (opposite polarity, unjudged)');
      printConflicts(conflict);
      if (withoutRule.length) {
        console.log(`not checked for conflicts, no parseable \`- rule:\` line: ${withoutRule.length} (${withoutRule.map((id) => `#${id}`).join(' ')})`);
      }
    }
  } catch (err) {
    console.error(String(err?.message || err));
    process.exit(1);
  }
}
