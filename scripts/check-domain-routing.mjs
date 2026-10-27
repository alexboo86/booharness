import { dbArgument, readLessons } from './memory/service-client.mjs';
// CI ratchet for the domain-skill memory routing map + lesson anchors (DB).
//
// File-based (unchanged): skill cap, every domain has globs, no ambiguous
// same-specificity collision, repository-wide tracked-path coverage.
//
// DB-based: active lesson anchors resolve (GONE = fail, BRANCH = report);
// active and inbox domains must match their anchor route. Budget counts active only.
// Drift = warn only. There is no per-domain count check — see the note where the
// constant used to be, in memory/lesson-lib.mjs.
import { collect } from './gen-domain-routing.mjs';
import { sweep } from './memory/sweep-anchors.mjs';
import { auditLessonDomainRoutes } from './memory/lesson-domain-routes.mjs';
import {
  LESSON_PAYLOAD_BUDGET_PER_FILE,
  parseLinks,
} from './memory/lesson-lib.mjs';
import {
  deliveredLessonBytes, lessonMatchesPath, matchGlob, resolveDomain,
} from './memory/store.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { scrubbedGitEnv } from './git-env.mjs';

const SKILL_CAP = 17; // Operator-gated ceiling; retiring a domain does not raise it.
const COVERAGE_STRICT = true; // every tracked repository path must map to a domain
let failed = false;
const fail = (m) => { console.error('FAIL: ' + m); failed = true; };

const map = collect();
const retired = map.retiredDomains ?? {};
for (const domain of auditLessonDomainRoutes([], map).conflicts) {
  fail(`retired domain ${domain} is also routed`);
}

// 1. skill cap
const n = Object.keys(map.byDomain).length;
if (n > SKILL_CAP) fail(`domain skill count ${n} > cap ${SKILL_CAP} (operator-gated to raise)`);

// 2. no domain with zero globs
for (const [d, g] of Object.entries(map.byDomain)) if (!g.length) fail(`${d} declares no files: globs`);

// 3. coverage + collision
//
// Matched by matchGlob — the same function that routes a lesson at runtime, and
// the same dialect the Rust matcher is held to (scripts/memory/glob-dialect.
// cases.json). This gate used to build a regex of its own, "same semantics as
// skill-gate.sh", a file that no longer exists: it left `[` to the regex engine
// and turned `?` into `.`, so the gate that says a path is covered answered from
// a third dialect nobody was keeping in step.
// Measured 2026-08-12: limiting this denominator to three source roots reported
// 2991/2991 covered while package.json, root configs, the agent contract, and
// docs had no route at all. The routing promise is repository-wide, so git's
// complete tracked tree is the only denominator that can enforce it.
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', env: scrubbedGitEnv() }).split('\n').filter(Boolean);
let uncovered = 0;
for (const f of files) {
  const hits = map.order.filter(e => matchGlob(e.glob, f));
  const domains = [...new Set(hits.map(h => h.domain))];
  if (domains.length === 0) { uncovered++; if (COVERAGE_STRICT) fail(`no domain owns ${f}`); continue; }
  if (domains.length > 1) {
    const top = hits[0].spec;
    // the catch-all (platform-shell) loses ties by design (gen sort) — not ambiguity
    const topDomains = [...new Set(hits.filter(h => h.spec === top).map(h => h.domain))]
      .filter(d => d !== 'domain-platform-shell' || hits.filter(h => h.spec === top).every(h => h.domain === 'domain-platform-shell'));
    if (topDomains.length > 1) fail(`ambiguous routing for ${f}: ${topDomains.join(', ')} (same specificity ${top})`);
  }
}
console.log(`routing: ${files.length} tracked files, ${uncovered} uncovered${COVERAGE_STRICT ? '' : ' (expected >0 until all domains land)'}`);

// 4. lesson checks from DB (inbox checked for route; active for sweep and budget)
const dbPath = dbArgument();
/** @type {{ keep: object[], drift: object[], branch: object[], gone: object[], error: object[] }} */
let r = { keep: [], drift: [], branch: [], gone: [], error: [] };
/** @type {Record<string, number>} */
const perDomainActive = {};

{
  let active;
  try {
    active = await readLessons({ dbPath }, { status: 'active' });
    // Delivery filters by domain before matching the anchor, even off this branch.
    const inbox = await readLessons({ dbPath }, { status: 'inbox' });
    const audit = auditLessonDomainRoutes([...active, ...inbox], map);
    for (const [domain, count] of Object.entries(audit.retiredCounts)) {
      console.log(`retired domain ${domain}: ${count} stored lessons checked (active/inbox history; ${retired[domain]})`);
    }
    for (const { row, domain } of audit.unknown) {
      fail(`lesson ${row.id}: domain ${domain} is neither routed nor retired`);
    }
    for (const { row, anchor, storedDomain, resolvedDomain } of audit.mismatches) {
      fail(`lesson ${row.id} anchor ${anchor}: stored ${storedDomain}, resolved ${resolvedDomain}`);
    }
    active = active.filter((row) => !Object.hasOwn(retired, String((row.linksObj || parseLinks(row.links)).domain)));
    for (const row of active) {
      const links = row.linksObj || parseLinks(row.links);
      const domain = String(links.domain || '?');
      perDomainActive[domain] = (perDomainActive[domain] || 0) + 1;
    }
    // The one budget, measured on what a DELIVERY actually costs.
    //
    // Bounding the anchor STRING was the first version, and three reviewers
    // broke it independently in one round: `lessonMatchesPath` delivers a lesson
    // by its anchor path, by its BASENAME, and by every entry in `globs`, so two
    // lessons filed under different anchors reach the same file and jointly blow
    // its budget while a per-anchor sum stays under it. Their probe:
    // anchor `svod/src/adapter/mod.rs` reaches `svod/src/driver/mod.rs` on the
    // basename alone, and two 20 000-character bodies gave 40 000 delivered
    // against a gate that saw two safe halves.
    //
    // Two smaller corrections ride along, from the same round: the sum is taken
    // in UTF-8 BYTES (the payload is UTF-8 JSON, and `String.length` counts
    // UTF-16 units, so Cyrillic bodies were undercounted by nearly half), and
    // the DOMAIN filter is applied, because delivery drops a lesson whose domain
    // is not the one the path routes to before it looks at the anchor at all.
    //
    // Cost: the delivery set is built per lesson, not per file. An exact anchor
    // reaches its own path plus files sharing its basename - both answered from
    // an index - and only a glob-carrying lesson scans the tree.
    const trackedFiles = execFileSync('git', ['ls-files'], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      env: scrubbedGitEnv(),
    })
      .split('\n')
      .filter(Boolean);
    const filesByBasename = new Map();
    for (const file of trackedFiles) {
      const base = file.slice(file.lastIndexOf('/') + 1);
      if (!filesByBasename.has(base)) filesByBasename.set(base, []);
      filesByBasename.get(base).push(file);
    }
    const trackedSet = new Set(trackedFiles);
    const domainCache = new Map();
    const domainOf = (file) => {
      if (!domainCache.has(file)) domainCache.set(file, resolveDomain(file, map));
      return domainCache.get(file);
    };
    const isGlob = (value) => value.includes('*') || value.includes('?') || value.includes('[');

    /** Every tracked path this lesson would actually be delivered to. */
    const deliveredTo = (links) => {
      const anchorPath = String(links.anchor || '').split(':')[0];
      const globs = Array.isArray(links.globs) ? links.globs : [];
      const candidates = new Set();
      if (anchorPath && isGlob(anchorPath)) {
        for (const file of trackedFiles) if (matchGlob(anchorPath, file)) candidates.add(file);
      } else if (anchorPath) {
        if (trackedSet.has(anchorPath)) candidates.add(anchorPath);
        const base = anchorPath.slice(anchorPath.lastIndexOf('/') + 1);
        for (const file of filesByBasename.get(base) ?? []) candidates.add(file);
      }
      for (const glob of globs) {
        for (const file of trackedFiles) if (matchGlob(glob, file)) candidates.add(file);
      }
      // The matcher decides, always — the candidate set only narrows what to ask
      // about, so a shape it admits that this narrowing did not anticipate still
      // has to pass through `lessonMatchesPath` to count.
      return [...candidates].filter((file) => lessonMatchesPath(links, file));
    };

    // ROWS per file, then ONE weighing of the answer they would become.
    //
    // Summing raw body bytes and comparing that to the delivery ceiling compared
    // two different units: the wire answer is a JSON envelope whose items carry
    // field names, escaping and a header, so it is always LARGER than the bodies.
    // A file whose bodies sat just under the ceiling therefore delivered nothing
    // while this check exited 0 in silence - reproduced by the codex seat of
    // round `harness-tails-r1`: a 48 711-byte body under a 49 152-byte ceiling
    // answered `items: 0, omitted: 1`, and this sensor said nothing. So the size
    // now comes from the service's own builder (`deliveredLessonBytes`), which is
    // the same `lessonPayload` fixed point the delivery uses.
    const perPathRows = new Map();
    for (const row of active) {
      const links = row.linksObj || parseLinks(row.links);
      for (const file of deliveredTo(links)) {
        if (domainOf(file) !== links.domain) continue;
        let entry = perPathRows.get(file);
        if (!entry) {
          entry = { domain: links.domain, rows: [], lessons: [] };
          perPathRows.set(file, entry);
        }
        entry.rows.push(row);
        entry.lessons.push({
          title: String(row.title || '?'),
          anchor: String(links.anchor || '?'),
          bytes: Buffer.byteLength(String(row.body || ''), 'utf8'),
        });
      }
    }
    // How many active lessons each domain holds, because the live envelope writes
    // that number and its WIDTH is part of the size: three digits for
    // domain-harness today, and the 1-2 bytes it costs are exactly the window
    // three seats reproduced in round `lessons-wire-r1`.
    const activePerDomain = new Map();
    // And how many rows of that domain the SERVICE would count as unreadable.
    // Every live answer of such a domain carries `invalid: N`, twelve bytes the
    // sensor did not weigh - the third field this hand-model missed in three
    // rounds, and the reason the envelope is now built in one place
    // (`lessonEnvelope`) instead of described twice. Reproduced by the codex seat
    // of round `lessons-wire-r2`: sensor 49 142 under a 49 152 ceiling while the
    // live answer had already dropped the only matching rule.
    const invalidPerDomain = new Map();
    for (const row of active) {
      let links;
      try {
        links = row.linksObj || parseLinks(row.links);
      } catch {
        // A row this sensor cannot read is a row the SERVICE cannot read either,
        // and it counts against every domain it might have belonged to. The
        // domain is unknowable here, so it is counted globally and applied to
        // each - erring early, which is the only direction a warning may err.
        invalidPerDomain.set('*', (invalidPerDomain.get('*') ?? 0) + 1);
        continue;
      }
      if (!links || typeof links.domain !== 'string') {
        invalidPerDomain.set('*', (invalidPerDomain.get('*') ?? 0) + 1);
        continue;
      }
      activePerDomain.set(links.domain, (activePerDomain.get(links.domain) ?? 0) + 1);
    }
    const perPathBytes = new Map();
    for (const [file, entry] of perPathRows) {
      perPathBytes.set(file, {
        bytes: deliveredLessonBytes(
          entry.domain,
          entry.rows,
          activePerDomain.get(entry.domain) ?? 0,
          invalidPerDomain.get('*') ?? 0,
        ),
        lessons: entry.lessons,
      });
    }
    // One file's delivery must fit the service's wire ceiling. Splitting the
    // file, not discarding lessons, is the remedy when it exceeds the budget.
    for (const [file, entry] of [...perPathBytes].sort((a, b) => b[1].bytes - a[1].bytes)) {
      if (entry.bytes > LESSON_PAYLOAD_BUDGET_PER_FILE) {
        // The gate names the file AND the lessons: a bare number sends whoever
        // reads it hunting through the whole store for what to merge or move.
        fail(
          `editing ${file} would deliver ${entry.bytes} wire bytes of active lessons > budget `
            + `${LESSON_PAYLOAD_BUDGET_PER_FILE} - split the file or merge overlapping rules `
            + '(counted over the DELIVERY set: anchor, basename and globs; task 451)',
        );
        for (const lesson of entry.lessons.sort((a, b) => b.bytes - a.bytes)) {
          console.warn(`  lesson: ${lesson.title} (anchor ${lesson.anchor}, ${lesson.bytes} bytes)`);
        }
      }
    }
    // No per-DOMAIN count check: a domain has not entered any context as a unit
    // since delivery went per-file, and since 2026-08-11 its other titles are not
    // delivered either. See lesson-lib.mjs where the constant used to live.
    const counted = Object.entries(perDomainActive)
      .sort((left, right) => right[1] - left[1])
      .map(([d, count]) => `${d}=${count}`)
      .join(' ');
    console.log(`active lessons per domain (reported, not gated): ${counted}`);
  } catch (err) {
    fail(`lesson memory probe failed: ${err?.message || err}`);
  }

  // Sweep active anchors (no report write in CI — read-only check)
  try {
    if (active) r = sweep({ lessons: active, writeReport: false });
  } catch (err) {
    fail(`anchor sweep failed: ${err?.message || err}`);
    r = { keep: [], drift: [], branch: [], gone: [], error: [] };
  }

  console.log(`anchors: keep=${r.keep.length} drift=${r.drift.length} branch=${r.branch.length} gone=${r.gone.length} error=${r.error.length}`);
  for (const row of r.error) fail(`anchor ${row.id} ${row.anchor}: git ref check failed: ${row.error}`);
  if (r.branch.length) console.log(`BRANCH anchors: ` + r.branch.map(x => `${x.domain}:${x.anchor} [${x.refs.join(', ')}]`).join(', '));
  if (r.gone.length) {
    fail(`${r.gone.length} GONE anchors (stale): ` + r.gone.map(x => `${x.domain}:${x.anchor}`).join(', '));
  }
  if (r.drift.length) {
    console.warn(`WARN: ${r.drift.length} drifted anchors (re-review): ` + r.drift.map(x => `${x.domain}:${x.anchor}`).join(', '));
  }
}

// 5. MEMORY.md index-only (memory repo; no-op in main repo where it is absent)
if (existsSync('MEMORY.md')) {
  if (readFileSync('MEMORY.md', 'utf8').includes('```')) fail('MEMORY.md contains fenced code (must be index-only)');
}

const activeTotal = Object.values(perDomainActive).reduce((a, b) => a + b, 0);
console.log(
  failed
    ? 'check-domain-routing: FAIL'
    : `check-domain-routing: OK (${n} domains, ${r.keep.length} active anchors kept, ${activeTotal} active lessons in DB)`,
);
process.exit(failed ? 1 : 0);
