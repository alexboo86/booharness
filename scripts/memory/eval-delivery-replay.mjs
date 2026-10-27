#!/usr/bin/env node
// Delivery replay over the frozen evaluation set (task 1557 slice 1b).
//
// For every commit of eval-delivery-set.frozen.json and every file the commit
// touched, ask what `memoryctl lessons --path <file>` would have delivered had
// the lesson store stood at commit time — and compare that against the
// commit's tier-1 gold. The SELECTION is not reimplemented here: it is the
// store's own `selectLessonsForPath`, the same function the `lessons` route
// calls, so this measurement cannot drift away from delivery.
//
// Point in time is decided by eval-delivery-set.mjs's `lessonsInForce` over
// the same chain walk slice 1a used, so "in force at commit time" means here
// exactly what gold means there. The store has grown since the freeze; nothing
// written after a commit can enter its in-force set, so recomputation answers
// the frozen question.
//
// One clock for everything, the routing map included: each commit is replayed
// under docs/agent/domain-routing.generated.json AS OF that commit (`git show
// <sha>:<map>` in the repository the set was built from). Today's map moved
// whole trees between domains, so replaying old lessons under it measured the
// map's drift, not delivery. A commit whose tree has no map is NOT scored: it
// is counted as `noMap` and today's map is never substituted.
//
// Today's map still answers one separate, labelled question - `domainDrift`:
// gold roots whose head today is active but whose anchor today routes to a
// domain other than the lesson's own, so today's `lessons --path` can never
// deliver them. That is a present-day defect, not a replay figure.
//
// Recall is per commit over lineage ROOTS: a gold root counts delivered when
// any delivered item's chain reaches it, however many files delivered it.
// Aggregate recall is the mean over commits with non-empty gold; empty-gold
// commits are reported, not averaged. Noise is delivered roots outside gold
// (count, and share of delivered); stale is delivered roots whose lineage head
// TODAY is retired. Share aggregates are means over commits that delivered.
//
// Bytes are what the route would send for the commit: the sum, over its files,
// of each `lessons --path` answer's own `bytes` (the store's envelope weighs
// itself by a fixed point, so no second renderer is involved). Median and p90
// are nearest-rank over ALL commits, empty-gold included - cost does not wait
// for gold. Every gold root not delivered carries a reason: `not-matched` when
// no file of the commit matched it (matchLessonsForPath), `cut` when one did and
// the selection still dropped it (byte ceiling).
//
//   node scripts/memory/eval-delivery-replay.mjs [--set <frozen.json>]

import { scrubbedGitEnv } from '../git-env.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_OUT, lessonsInForce, loadLessonVersions } from './eval-delivery-set.mjs';
import { readMemory } from './service-client.mjs';
import { loadRoutingMap, matchLessonsForPath, resolveDomain, selectLessonsForPath } from './store.mjs';

const FETCH_CONCURRENCY = 32;
const ROUTING_MAP_FILE = 'docs/agent/domain-routing.generated.json';

/**
 * The routing map as committed at `sha`, or null when that tree has no map
 * file. A commit missing from the repository, or a map that does not parse,
 * throws: only a proven absence may become `noMap`.
 */
export function routingMapAt(repo, sha) {
  const git = (args) => spawnSync('git', ['-C', repo, ...args], { env: scrubbedGitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git(['cat-file', '-e', `${sha}^{commit}`]).status !== 0) {
    throw new Error(`commit ${sha} is not in ${repo}`);
  }
  if (git(['cat-file', '-e', `${sha}:${ROUTING_MAP_FILE}`]).status !== 0) return null;
  const shown = git(['show', `${sha}:${ROUTING_MAP_FILE}`]);
  if (shown.status !== 0) throw new Error(`git show ${sha}:${ROUTING_MAP_FILE}: ${shown.stderr.trim()}`);
  const map = JSON.parse(shown.stdout);
  if (!map || !Array.isArray(map.order)) {
    throw new Error(`routing map at ${sha} has no order array`);
  }
  return map;
}

/** Head today of each lineage: its newest version. */
function headsByRoot(versions) {
  const heads = new Map();
  for (const v of versions) {
    const head = heads.get(v.root);
    if (!head || v.ts > head.ts) heads.set(v.root, v);
  }
  return heads;
}

/**
 * What `lessons --path` would hand the commit's files, with the in-force
 * versions stood up as the store's rows: the union of delivered roots, the
 * union of roots that MATCHED some file before the selection packed, and the
 * summed bytes of the per-file answers. `rowsById`
 * supplies title/body for a version id (they ride in the byte budget); `uuid`
 * and `version` are synthesized from the id because they only feed
 * `inputs_hash`, a fixed-width sha256, and the nearby dedupe set.
 */
export function replayCommit(commit, versions, rowsById, routingMap) {
  const byId = new Map(versions.map((v) => [v.id, v]));
  const inForce = lessonsInForce(versions, Date.parse(commit.date));
  const rows = inForce.map((v) => ({
    id: v.id,
    uuid: `v${v.id}`,
    version: 1,
    title: rowsById.get(v.id)?.title ?? `lesson ${v.id}`,
    body: rowsById.get(v.id)?.body ?? '',
    links: JSON.stringify(v.links),
  }));
  const delivered = new Set();
  const matched = new Set();
  let bytes = 0;
  for (const file of commit.files) {
    for (const { row } of matchLessonsForPath(rows, file, routingMap).candidates) {
      const version = byId.get(Number(row.id));
      if (version) matched.add(version.root);
    }
    const payload = selectLessonsForPath(rows, file, routingMap);
    bytes += payload.bytes;
    for (const item of payload.items) {
      const version = byId.get(Number(item.id));
      if (version) delivered.add(version.root);
    }
  }
  return { delivered, matched, bytes };
}

/** The union of lesson roots `lessons --path` would deliver across the commit's files. */
export function deliveredRootsForCommit(commit, versions, rowsById, routingMap) {
  return replayCommit(commit, versions, rowsById, routingMap).delivered;
}

/** Nearest-rank percentile of a list of numbers; null when the list is empty. */
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/**
 * Per-commit recall against tier-1 gold roots, plus noise/stale, and the
 * aggregates. `routingAt(commit)` returns the map in force at that commit, or
 * null when there was none - such a commit is listed in `noMapCommits` and
 * enters no figure.
 */
export function evaluateCommits(commits, versions, rowsById, routingAt) {
  // A lineage the store later retired (head today 'retired') makes every
  // delivered root of it stale.
  const headByRoot = headsByRoot(versions);
  const isStaleRoot = (root) => headByRoot.get(root)?.links?.status === 'retired';
  const noMapCommits = [];
  const mapped = [];
  for (const commit of commits) {
    const routingMap = routingAt(commit);
    if (routingMap === null) noMapCommits.push(commit.sha);
    else mapped.push({ commit, routingMap });
  }
  const perCommit = mapped.map(({ commit, routingMap }) => {
    const goldRoots = [...new Set(commit.gold.map((g) => g.root))];
    const { delivered, matched, bytes } = replayCommit(commit, versions, rowsById, routingMap);
    const hits = goldRoots.filter((root) => delivered.has(root)).length;
    const misses = goldRoots.filter((root) => !delivered.has(root))
      .map((root) => ({ root, reason: matched.has(root) ? 'cut' : 'not-matched' }));
    const noiseRoots = [...delivered].filter((root) => !goldRoots.includes(root));
    const stale = [...delivered].filter(isStaleRoot).length;
    return {
      sha: commit.sha,
      date: commit.date,
      gold: goldRoots.length,
      delivered: hits,
      recall: goldRoots.length > 0 ? hits / goldRoots.length : null,
      deliveredTotal: delivered.size,
      noise: noiseRoots.length,
      noiseShare: delivered.size > 0 ? noiseRoots.length / delivered.size : null,
      stale,
      staleShare: delivered.size > 0 ? stale / delivered.size : null,
      bytes,
      misses,
    };
  });
  const mean = (entries, key) => (entries.length > 0
    ? entries.reduce((sum, entry) => sum + entry[key], 0) / entries.length
    : null);
  const scored = perCommit.filter((entry) => entry.recall !== null);
  const delivering = perCommit.filter((entry) => entry.deliveredTotal > 0);
  return {
    aggregateRecall: mean(scored, 'recall'),
    aggregateNoiseShare: mean(delivering, 'noiseShare'),
    aggregateStaleShare: mean(delivering, 'staleShare'),
    totalNoise: perCommit.reduce((sum, entry) => sum + entry.noise, 0),
    totalStale: perCommit.reduce((sum, entry) => sum + entry.stale, 0),
    medianBytes: percentile(perCommit.map((entry) => entry.bytes), 0.5),
    p90Bytes: percentile(perCommit.map((entry) => entry.bytes), 0.9),
    missReasons: {
      'not-matched': countMisses(perCommit, 'not-matched'),
      cut: countMisses(perCommit, 'cut'),
    },
    scoredCommits: scored.length,
    emptyGold: perCommit.length - scored.length,
    noMap: noMapCommits.length,
    noMapCommits,
    commits: perCommit,
  };
}

/**
 * PRESENT-DAY defect, not a replay figure: gold roots whose head today is
 * active but whose anchor path today routes to a domain other than the
 * lesson's `links.domain`. The route filters on that equality, so today's
 * `lessons --path` never delivers them.
 */
export function domainDrift(commits, versions, todayMap, limit = 10) {
  const headByRoot = headsByRoot(versions);
  const roots = [...new Set(commits.flatMap((commit) => commit.gold.map((g) => g.root)))]
    .sort((a, b) => a - b);
  const drifted = [];
  for (const root of roots) {
    const head = headByRoot.get(root);
    if (head?.links?.status !== 'active') continue;
    const anchor = String(head.links.anchor ?? '');
    const separator = anchor.indexOf(':');
    const anchorPath = separator === -1 ? anchor : anchor.slice(0, separator);
    const todayDomain = resolveDomain(anchorPath, todayMap);
    if (todayDomain === head.links.domain) continue;
    drifted.push({ id: head.id, anchor, lessonDomain: head.links.domain, todayDomain });
  }
  return { count: drifted.length, examples: drifted.slice(0, limit) };
}

function countMisses(perCommit, reason) {
  return perCommit.reduce((sum, entry) => sum + entry.misses.filter((miss) => miss.reason === reason).length, 0);
}

/** title/body for every version id: live heads come in one read, chain ancestors by id. */
export async function loadRowsById(versions, read) {
  const rowsById = new Map();
  for (const row of await read('entries?kind=lesson')) {
    rowsById.set(Number(row.id), { title: String(row.title ?? ''), body: String(row.body ?? '') });
  }
  const missing = versions.map((v) => v.id).filter((id) => !rowsById.has(id));
  for (let i = 0; i < missing.length; i += FETCH_CONCURRENCY) {
    const rows = await Promise.all(missing.slice(i, i + FETCH_CONCURRENCY)
      .map((id) => read(`entry?id=${id}`)));
    for (const row of rows) {
      rowsById.set(Number(row.id), { title: String(row.title ?? ''), body: String(row.body ?? '') });
    }
  }
  return rowsById;
}

function parseArgs(argv) {
  const options = { set: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--set') options.set = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const set = JSON.parse(fs.readFileSync(options.set, 'utf8'));
  if (set.schema !== 'eval-delivery-set/v1') throw new Error(`unexpected schema ${set.schema}`);
  const versions = await loadLessonVersions(readMemory);
  const rowsById = await loadRowsById(versions, readMemory);
  const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { env: scrubbedGitEnv(), encoding: 'utf8' }).stdout.trim();
  // The set names the ref it was sampled from; its commits must be in THIS
  // repository, or every map lookup below would be a guess.
  if (spawnSync('git', ['-C', repo, 'cat-file', '-e', `${set.refSha}^{commit}`], { env: scrubbedGitEnv() }).status !== 0) {
    throw new Error(`the set's refSha ${set.refSha} (${set.ref}) is not in ${repo}`);
  }
  const result = evaluateCommits(set.commits, versions, rowsById, (commit) => routingMapAt(repo, commit.sha));
  console.log(JSON.stringify({
    set: path.relative(process.cwd(), options.set),
    frozenAt: set.builtAt,
    ...result,
    domainDrift: domainDrift(set.commits, versions, loadRoutingMap()),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`eval-delivery-replay: ${error.message}`);
    process.exit(1);
  });
}
