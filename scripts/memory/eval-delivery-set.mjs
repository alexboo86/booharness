#!/usr/bin/env node
// Frozen evaluation set for lesson delivery (task 1557 slice 1a).
//
// The question a later slice asks is "what did `memoryctl lessons --path` hand an
// agent editing THIS commit's files, against what it should have handed". That
// comparison is only honest when both sides are fixed in time: the store keeps
// growing and rewriting lessons, so a set recomputed tomorrow answers a different
// question. This script builds the set once and writes it as tracked JSON.
//
// Read-only on both inputs: memory through GET routes of memoryd, git through
// `git log`. Nothing is appended, superseded or committed.
//
// Point in time. Every lesson rewrite is a new row whose `supersedes` names the
// row before it (retirement too: retire-lesson.mjs supersedes with
// links.status "retired"). A version is in force at commit time T when it was
// written at or before T and its successor, if any, was not: a successor written
// at exactly T replaces its predecessor, so exactly one version of a chain holds
// at any instant. Only `active` counts, because the lessons route delivers
// `active` only; `inbox` and `retired` are delivered to nobody. Nothing written
// after T can enter.
//
// Clock. T is the committer date (%ct, whole seconds). A rebased or
// cherry-picked commit carries the rebase date, not its authoring date, so its T
// is the moment it was rewritten.
//
// Tier-1 gold. The point-in-time lessons whose anchor names one of the commit's
// files, decided by the store's own matcher (`lessonPathMatchKind` = 'anchor'),
// so an evaluation never disagrees with delivery about what an anchor means.
// Class matches (glob anchors, `globs`) are not tier-1.
//
// Live gold (task 1632). A lesson the store has since retired cannot be asked of
// delivery today: it scores nothing and only hides the cases it sits in. So each
// point-in-time gold version is followed to the live head of its lineage, the
// way `memoryctl get <id> --follow latest` reads it (the store's own walker, one
// GET per lineage root). An active head stays gold under the head's id, with
// `inForce` naming the version the commit saw; any other head is dropped into
// the commit's `dropped` list. Nothing is silently lost: every remap and drop is
// in the set and in its manifest.
//
// Sample. Eligible: non-merge commits of the ref, committed no earlier than the
// first lesson version, that touch a file some lesson version (any status, any
// time) is anchored at. A commit whose lesson came later is still eligible: its
// empty gold is part of the set. N of them are taken by an even stride from the
// oldest to the newest, so one busy day cannot fill the set. With
// --min-scoring M, N grows one at a time until M of the sampled commits have
// non-empty live gold (a scoring case), or every eligible commit is taken.
//
//   node scripts/memory/eval-delivery-set.mjs [--n 80] [--min-scoring 80]
//        [--ref master] [--out scripts/memory/eval-delivery-set.frozen.json] [--force]
//
// The manifest is written beside the set, `.frozen.json` replaced by
// `.manifest.json`: commit range, case and gold counts, every remap and drop,
// and how many cases of the set it replaced still score today.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { anchorFile } from './lesson-lib.mjs';
import { readMemory, serviceUrl } from './service-client.mjs';
import { lessonPathMatchKind } from './store.mjs';
import { scrubbedGitEnv } from '../git-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = path.join(HERE, 'eval-delivery-set.frozen.json');
export const DEFAULT_N = 80;
export const IN_FORCE_STATUS = 'active';
const FETCH_CONCURRENCY = 16;

function decodeLinks(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function version(row) {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    supersedes: row.supersedes == null ? null : Number(row.supersedes),
    supersededBy: row.superseded_by == null ? null : Number(row.superseded_by),
    links: decodeLinks(row.links),
  };
}

/**
 * Every lesson version ever written: the live heads, then each chain walked back
 * through `supersedes`. `read(resource)` is a GET against /api/memory/<resource>.
 */
export async function loadLessonVersions(read) {
  const byId = new Map();
  let frontier = [];
  for (const row of await read('entries?kind=lesson')) {
    const v = version(row);
    byId.set(v.id, v);
    if (v.supersedes !== null) frontier.push(v.supersedes);
  }
  while (frontier.length > 0) {
    const pending = [...new Set(frontier)].filter((id) => !byId.has(id));
    frontier = [];
    for (let i = 0; i < pending.length; i += FETCH_CONCURRENCY) {
      const rows = await Promise.all(pending.slice(i, i + FETCH_CONCURRENCY)
        .map((id) => read(`entry?id=${id}`)));
      for (const row of rows) {
        if (row.kind !== 'lesson') {
          throw new Error(`lesson chain reaches entry ${row.id} of kind ${row.kind}`);
        }
        const v = version(row);
        byId.set(v.id, v);
        if (v.supersedes !== null && !byId.has(v.supersedes)) frontier.push(v.supersedes);
      }
    }
  }
  const roots = new Map();
  const rootOf = (v) => {
    if (roots.has(v.id)) return roots.get(v.id);
    const seen = new Set();
    let at = v;
    while (at.supersedes !== null && byId.has(at.supersedes) && !seen.has(at.id)) {
      seen.add(at.id);
      at = byId.get(at.supersedes);
    }
    roots.set(v.id, at.id);
    return at.id;
  };
  return [...byId.values()].map((v) => ({
    ...v,
    root: rootOf(v),
    // successor's write time closes this version's interval; null = still live
    until: v.supersededBy !== null && byId.has(v.supersededBy) ? byId.get(v.supersededBy).ts : null,
  }));
}

/** The versions in force at `atMs`: written at or before it, not yet replaced, active. */
export function lessonsInForce(versions, atMs) {
  return versions.filter((v) => v.ts <= atMs
    && (v.until === null || v.until > atMs)
    && v.links?.status === IN_FORCE_STATUS
    && typeof v.links.anchor === 'string');
}

export function tierOneGold(inForce, files) {
  return inForce
    .filter((v) => files.some((file) => lessonPathMatchKind(v.links, file) === 'anchor'))
    .map((v) => ({ id: v.id, root: v.root, anchor: v.links.anchor }))
    .sort((a, b) => a.id - b.id);
}

/**
 * The live head of each lineage root, read through `entry?id=<root>&follow=latest`
 * (what `memoryctl get <id> --follow latest` calls). Map root → { id, status }.
 */
export async function loadLiveHeads(read, roots) {
  const heads = new Map();
  const pending = [...new Set(roots)];
  for (let i = 0; i < pending.length; i += FETCH_CONCURRENCY) {
    const batch = pending.slice(i, i + FETCH_CONCURRENCY);
    const rows = await Promise.all(batch.map((root) => read(`entry?id=${root}&follow=latest`)));
    rows.forEach((row, at) => {
      heads.set(batch[at], { id: Number(row.id), status: decodeLinks(row.links)?.status ?? null });
    });
  }
  return heads;
}

/** Point-in-time gold split by its live head: active heads kept under the head id, the rest dropped. */
export function liveGold(gold, heads) {
  const kept = [];
  const dropped = [];
  for (const item of gold) {
    const head = heads.get(item.root);
    if (!head) throw new Error(`no live head loaded for lineage root ${item.root} (gold ${item.id})`);
    if (head.status === IN_FORCE_STATUS) {
      kept.push({ id: head.id, root: item.root, anchor: item.anchor, inForce: item.id });
    } else {
      dropped.push({ inForce: item.id, root: item.root, anchor: item.anchor, head: head.id, status: head.status });
    }
  }
  return { gold: kept.sort((a, b) => a.id - b.id), dropped };
}

/** Non-merge commits of `ref` with committer time and every path they touch. */
export function readCommits(repo, ref) {
  const out = execFileSync('git', [
    '-C', repo, 'log', '--no-merges', '--no-renames', '--name-only',
    '--format=%x00%H%x09%ct', ref,
  ], { env: scrubbedGitEnv(), encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  return out.split('\0').filter((chunk) => chunk.trim()).map((chunk) => {
    const [head, ...rest] = chunk.split('\n');
    const [sha, ct] = head.split('\t');
    return {
      sha,
      ts: Number(ct) * 1000,
      files: [...new Set(rest.map((line) => line.trim()).filter(Boolean))].sort(),
    };
  });
}

export function buildDeliverySet({ versions, commits, n, heads, minScoring = 0 }) {
  // Sampling may look at every version ever written: it only chooses which
  // commits to ask about. Gold below looks at nothing written after the commit
  // except the live head its lineage has today.
  // Only the anchor decides an 'anchor' match, so each distinct anchor is tried once.
  const anchors = [...new Set(versions
    .map((v) => v.links?.anchor)
    .filter((anchor) => typeof anchor === 'string' && anchorFile(anchor) !== null))]
    .map((anchor) => ({ anchor }));
  const anchoredFile = new Map();
  const isAnchored = (file) => {
    if (!anchoredFile.has(file)) {
      anchoredFile.set(file, anchors.some((links) => lessonPathMatchKind(links, file) === 'anchor'));
    }
    return anchoredFile.get(file);
  };
  const firstLessonTs = Math.min(...versions.map((v) => v.ts));
  const eligible = commits
    .filter((commit) => commit.ts >= firstLessonTs && commit.files.some(isAnchored))
    .sort((a, b) => a.ts - b.ts || a.sha.localeCompare(b.sha));
  const date = (commit) => (commit ? new Date(commit.ts).toISOString() : null);
  const cases = new Map();
  const caseOf = (commit) => {
    if (!cases.has(commit.sha)) {
      cases.set(commit.sha, {
        sha: commit.sha,
        date: date(commit),
        files: commit.files,
        ...liveGold(tierOneGold(lessonsInForce(versions, commit.ts), commit.files), heads),
      });
    }
    return cases.get(commit.sha);
  };
  let size = n;
  let sample = strideSample(eligible, size).map(caseOf);
  while (sample.filter((entry) => entry.gold.length > 0).length < minScoring && size < eligible.length) {
    size += 1;
    sample = strideSample(eligible, size).map(caseOf);
  }
  return {
    sampling: {
      method: 'stride',
      n: size,
      minScoring,
      eligibleCount: eligible.length,
      firstLessonAt: Number.isFinite(firstLessonTs) ? new Date(firstLessonTs).toISOString() : null,
      firstCommitDate: sample[0]?.date ?? null,
      lastCommitDate: sample[sample.length - 1]?.date ?? null,
    },
    commits: sample,
  };
}

/** Every remap (in-force id → live head id) and every drop, each with the cases it touches. */
export function goldMappings(commits) {
  const remapped = new Map();
  const dropped = new Map();
  for (const commit of commits) {
    for (const item of commit.gold) {
      if (item.inForce === item.id) continue;
      const key = `${item.inForce}>${item.id}`;
      if (!remapped.has(key)) remapped.set(key, { from: item.inForce, to: item.id, root: item.root, cases: 0 });
      remapped.get(key).cases += 1;
    }
    for (const item of commit.dropped) {
      if (!dropped.has(item.inForce)) {
        dropped.set(item.inForce, { id: item.inForce, root: item.root, head: item.head, status: item.status, cases: 0 });
      }
      dropped.get(item.inForce).cases += 1;
    }
  }
  const byId = (a, b) => (a.from ?? a.id) - (b.from ?? b.id) || (a.to ?? 0) - (b.to ?? 0);
  return { remapped: [...remapped.values()].sort(byId), dropped: [...dropped.values()].sort(byId) };
}

/** Cases of an older set whose gold still has a lineage with an active head today. */
export function scoringCases(commits, heads) {
  return commits.filter((commit) => commit.gold
    .some((item) => heads.get(item.root)?.status === IN_FORCE_STATUS)).length;
}

export function manifestPath(out) {
  return out.endsWith('.frozen.json') ? out.replace(/\.frozen\.json$/, '.manifest.json') : `${out}.manifest.json`;
}

/** `n` items at an even stride from first to last, both ends included; all of them when n covers the list. */
export function strideSample(items, n) {
  if (items.length <= n) return [...items];
  if (n === 1) return [items[items.length - 1]];
  const step = (items.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => items[Math.round(i * step)]);
}

export function summarize(commits) {
  const sizes = commits.map((commit) => commit.gold.length);
  const distribution = {};
  for (const size of sizes) distribution[size] = (distribution[size] ?? 0) + 1;
  const sorted = [...sizes].sort((a, b) => a - b);
  return {
    commits: commits.length,
    withGold: sizes.filter((size) => size > 0).length,
    goldTotal: sizes.reduce((sum, size) => sum + size, 0),
    droppedTotal: commits.reduce((sum, commit) => sum + commit.dropped.length, 0),
    goldMedian: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    goldMax: sorted.length ? sorted[sorted.length - 1] : 0,
    distribution,
  };
}

function parseArgs(argv) {
  const options = { n: DEFAULT_N, minScoring: 0, ref: 'master', out: DEFAULT_OUT, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') options.force = true;
    else if (arg === '--n') options.n = Number(argv[++i]);
    else if (arg === '--min-scoring') options.minScoring = Number(argv[++i]);
    else if (arg === '--ref') options.ref = argv[++i];
    else if (arg === '--out') options.out = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(options.n) || options.n < 1) throw new Error('--n must be a positive integer');
  if (!Number.isInteger(options.minScoring) || options.minScoring < 0) {
    throw new Error('--min-scoring must be a non-negative integer');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (fs.existsSync(options.out) && !options.force) {
    throw new Error(`${options.out} exists and is frozen; pass --force to rebuild it`);
  }
  const previous = fs.existsSync(options.out) ? JSON.parse(fs.readFileSync(options.out, 'utf8')) : null;
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { env: scrubbedGitEnv(), encoding: 'utf8' }).trim();
  const refSha = execFileSync('git', ['-C', repo, 'rev-parse', options.ref], { env: scrubbedGitEnv(), encoding: 'utf8' }).trim();
  const versions = await loadLessonVersions(readMemory);
  const heads = await loadLiveHeads(readMemory, [
    ...versions.map((v) => v.root),
    ...(previous?.commits ?? []).flatMap((commit) => commit.gold.map((item) => item.root)),
  ]);
  const { sampling, commits } = buildDeliverySet({
    versions, commits: readCommits(repo, options.ref), n: options.n, heads, minScoring: options.minScoring,
  });
  const summary = summarize(commits);
  const set = {
    schema: 'eval-delivery-set/v1',
    builtAt: new Date().toISOString(),
    ref: options.ref,
    refSha,
    memory: serviceUrl(),
    lessonVersions: versions.length,
    rules: {
      sample: `${sampling.n} commits at an even stride, oldest to newest, over the eligible: non-merge, `
        + 'committed at or after the first lesson version, touching a file some lesson version is anchored at; '
        + `N grown from ${options.n} until ${options.minScoring} cases have non-empty live gold`,
      clock: 'commit time is the committer date (%ct, seconds); a rebased or cherry-picked commit carries its rebase date, not its authoring date',
      inForce: `version ts <= commit ts, successor absent or successor ts > commit ts, links.status = ${IN_FORCE_STATUS}`,
      gold: "tier-1: in-force lessons whose lessonPathMatchKind(links, file) = 'anchor' for a commit file",
      live: `each gold lineage followed to its live head (entry?id=<root>&follow=latest); head links.status = ${IN_FORCE_STATUS} `
        + 'stays gold under the head id (inForce = the version the commit saw), any other head goes to dropped',
    },
    sampling,
    summary,
    commits,
  };
  const manifest = {
    set: path.relative(repo, options.out),
    builtAt: set.builtAt,
    ref: options.ref,
    refSha,
    range: {
      firstSha: commits[0]?.sha ?? null,
      firstCommitDate: sampling.firstCommitDate,
      lastSha: commits[commits.length - 1]?.sha ?? null,
      lastCommitDate: sampling.lastCommitDate,
    },
    cases: summary.commits,
    scoringCases: summary.withGold,
    goldTotal: summary.goldTotal,
    droppedTotal: summary.droppedTotal,
    ...goldMappings(commits),
    previous: previous && {
      refSha: previous.refSha,
      builtAt: previous.builtAt,
      cases: previous.commits.length,
      goldTotal: previous.commits.reduce((sum, commit) => sum + commit.gold.length, 0),
      scoringCasesToday: scoringCases(previous.commits, heads),
    },
  };
  fs.writeFileSync(options.out, `${JSON.stringify(set, null, 2)}\n`);
  fs.writeFileSync(manifestPath(options.out), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    out: path.relative(repo, options.out), lessonVersions: versions.length, ...sampling, ...summary,
    remapped: manifest.remapped.length, droppedIds: manifest.dropped.length, previous: manifest.previous,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`eval-delivery-set: ${error.message}`);
    process.exit(1);
  });
}
