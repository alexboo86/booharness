#!/usr/bin/env node
// Move lessons filed under a legacy domain key onto the canonical domain that
// owns their paths, so path-based delivery can find them.
//
// Why. `memoryctl lessons --path <file>` resolves the path to a domain through
// the `files:` globs of `.agents/domains/domain-*`, and then asks for lessons
// filed under THAT name. Measured 2026-07-30 over 121 active lessons: 40 sat
// under `domain-harness`, but 26 under `harness`, 24 under `svod`, 12 under
// `platform-shell` against 1 under `domain-platform-shell`, and 1 under
// `platform`. Anchored lessons still arrive (delivery also matches the anchor
// path), but the domain fallback — the route for every file that has no lesson
// of its own — could not see half the store.
//
// The canonical set is the skills tree, never a list in here: it is the same
// SSOT `gen-domain-routing.mjs` reads, so a new domain needs no edit to this.
//
// Route: `memoryctl supersede`, one call per lesson, same title and same body.
// The knowledge is not touched - only which domain files it. Direct SQL would
// bypass the service that owns the store, its FTS index and its versioning.
//
// Usage:
//   node scripts/memory/normalize-lesson-domains.mjs [--dry] [--db <path>]
import { dbArgument, readLessons, requireServiceWrite } from './service-client.mjs';
import fs from 'node:fs';
import { DOMAINS_ROOT, parseLinks } from './lesson-lib.mjs';
import { supersedeDomain } from './lesson-domain-routes.mjs';

const dry = process.argv.includes('--dry');
const dbPath = dbArgument();
requireServiceWrite(dbPath, dry);

// A legacy key is only ever mapped to a domain that EXISTS in the skills tree;
// anything else is reported and left alone. `svod` folds into the harness domain
// because that is the domain which owns svod/ in the skills tree - there is no
// separate svod domain and inventing one here would fork the routing SSOT.
const LEGACY_KEYS = new Map([
  ['harness', 'domain-harness'],
  ['svod', 'domain-harness'],
  ['platform-shell', 'domain-platform-shell'],
  ['platform', 'domain-platform-shell'],
]);

function canonicalDomains() {
  return new Set(
    fs
      .readdirSync(DOMAINS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('domain-'))
      .map((entry) => entry.name),
  );
}

const known = canonicalDomains();
const rows = await readLessons({ dbPath });

let moved = 0;
let failed = 0;
const foreign = new Map();
const table = [];

for (const row of rows) {
  const links = parseLinks(row.links);
  const domain = String(links.domain || '');
  if (!domain || known.has(domain)) continue;
  const target = LEGACY_KEYS.get(domain);
  if (!target) {
    // Not this repository's domain at all (agtop lives in another repo). Naming
    // it is the point: a silent skip is how the last half of the store got lost.
    foreign.set(domain, (foreign.get(domain) ?? 0) + 1);
    continue;
  }
  if (!known.has(target)) {
    throw new Error(`mapping target ${target} is not a domain in ${DOMAINS_ROOT}`);
  }
  table.push({ id: row.id, from: domain, to: target, title: String(row.title).slice(0, 58) });
  if (dry) continue;
  try {
    supersedeDomain({ ...row, linksObj: links }, target);
    moved += 1;
  } catch (error) {
    failed += 1;
    console.error(`FAIL id=${row.id} ${domain} -> ${target}: ${error.message}`);
  }
}

console.log('id\tfrom -> to\ttitle');
for (const entry of table) {
  console.log(`${entry.id}\t${entry.from} -> ${entry.to}\t${entry.title}`);
}
for (const [domain, count] of foreign) {
  console.log(`left alone: ${count} lesson(s) under "${domain}" - no domain in this repository owns it`);
}
console.log(
  dry
    ? `normalize: ${table.length} lesson(s) would move (dry)`
    : `normalize: ${moved} moved, ${failed} failed of ${table.length} candidate(s)`,
);
if (failed) process.exit(1);
