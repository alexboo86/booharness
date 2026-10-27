#!/usr/bin/env node
// Sweep active lesson anchors against live code. Source = memoryd.
// Classification: keep | drift | branch | gone | error. NO auto-supersede.
// Verdict → registry CAS report key=anchor-sweep-latest + printed table.
// Exit non-zero iff gone/error > 0 (drift = warn only).
//
// Usage: node scripts/memory/sweep-anchors.mjs [--json] [--no-report]

import { readLessons, readMemory, updateRegistry } from './service-client.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { anchorRefs } from './capture-gate.mjs';
import { scrubbedGitEnv } from '../git-env.mjs';
import { isMain } from '../lib/is-main.mjs';

import {
  REPO_ROOT,
  SWEEP_REPORT_KEY,
  classifyAnchor,
  listRepoPaths,
  parseLinks,
} from './lesson-lib.mjs';

// Re-export pure classifier for tests (backward-compatible import path)
export { classifyAnchor } from './lesson-lib.mjs';

/**
 * Run sweep over active lessons already read from memoryd.
 * @param {{ lessons: object[], repoRoot?: string, git?: (args: string[], root: string) => string, listPaths?: (root: string) => string[] }} opts
 */
export function sweep(opts) {
  const repoRoot = opts.repoRoot || REPO_ROOT;
  /** @type {{ keep: object[], drift: object[], branch: object[], gone: object[], error: object[] }} */
  const report = { keep: [], drift: [], branch: [], gone: [], error: [] };
  const git = opts.git || ((args, root) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
    env: scrubbedGitEnv(),
  }));
  const runs = new Map();
  const siblingErrors = new Map();
  const refsFor = (root) => {
    if (!runs.has(root)) runs.set(root, (args) => git(args, root));
    return (anchor) => anchorRefs(anchor, { git: runs.get(root) });
  };

    const active = opts.lessons;
    // A lesson may belong to a SIBLING repository (links.repo, e.g. "agtop"):
    // resolving its anchor against this tree reported every such lesson GONE
    // while the file sat alive one directory over — 8 false positives on
    // 2026-07-28. Each named repo resolves against <this-repo>/../<repo>;
    // a repo directory that genuinely does not exist falls back to this tree,
    // which keeps the honest GONE for anchors that are nowhere.
    const rootFor = new Map([['', repoRoot]]);
    const resolveRoot = (repoName) => {
      if (!rootFor.has(repoName)) {
        const candidate = path.resolve(repoRoot, '..', repoName);
        rootFor.set(repoName, fs.existsSync(candidate) ? candidate : repoRoot);
      }
      return rootFor.get(repoName);
    };
    const pathsFor = new Map();
    const listPathsCached = (root) => {
      if (!pathsFor.has(root)) pathsFor.set(root, (opts.listPaths || listRepoPaths)(root));
      return pathsFor.get(root);
    };
    // A lesson's anchor is a FILE. One anchored at a directory used to throw
    // EISDIR out of readFileSync and take the whole sweep down with it — every
    // other anchor went unjudged because one row was wrong (#9102 pointed at
    // .agents/skills/impeccable). A non-file anchor is a verdict, not a crash.
    const readerFor = (root) => (file) => {
      const p = path.join(root, file);
      return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ? fs.readFileSync(p, 'utf8') : null;
    };

    for (const row of active) {
      const links = row.linksObj || parseLinks(row.links);
      const anchor = String(links.anchor || '').trim();
      const domain = String(links.domain || '?');
      const root = resolveRoot(String(links.repo || '').trim());
      if (root !== repoRoot) {
        if (!siblingErrors.has(root)) {
          try {
            const top = git(['rev-parse', '--show-toplevel'], root).trim();
            siblingErrors.set(root, fs.realpathSync(top) === fs.realpathSync(root) ? null : `not a repository root: ${root}`);
          } catch (cause) { siblingErrors.set(root, String(cause?.message || cause)); }
        }
        if (siblingErrors.get(root)) {
          report.error.push({ domain, anchor: anchor || '(empty)', title: row.title, id: row.id, error: siblingErrors.get(root) });
          continue;
        }
      }
      // Empty / "?" go through classifyAnchor → drift (re-anchor), not auto-gone
      const checkoutVerdict = classifyAnchor(anchor, readerFor(root), { repoPaths: listPathsCached(root) });
      let refs = [];
      let error;
      if (checkoutVerdict === 'gone') {
        try { refs = refsFor(root)(anchor); }
        catch (cause) { error = String(cause?.message || cause); }
      }
      const verdict = error ? 'error' : checkoutVerdict === 'gone' && refs.length ? 'branch' : checkoutVerdict;
      report[verdict].push({
        ...(verdict === 'branch' ? { refs } : {}),
        ...(error ? { error } : {}),
        domain,
        anchor: anchor || '(empty)',
        title: row.title,
        id: row.id,
      });
    }

  return report;
}

// Preserve the published body shape; refuse an unavailable service or two CAS conflicts.
export async function writeSweepReport(report) {
  const body = [
    '# anchor-sweep-latest',
    '',
    `- ts: ${new Date().toISOString()}`,
    `- keep: ${report.keep.length}`,
    `- drift: ${report.drift.length}`,
    `- branch: ${report.branch.length}`,
    `- gone: ${report.gone.length}`,
    `- error: ${report.error.length}`,
    '',
  ];
  if (report.branch.length) {
    body.push('## BRANCH');
    for (const e of report.branch) body.push(`- ${e.domain}: ${e.anchor} [${e.refs.join(', ')}]${e.title ? ` (${e.title})` : ''}`);
    body.push('');
  }
  if (report.error.length) {
    body.push('## ERROR');
    for (const e of report.error) body.push(`- ${e.domain}: ${e.anchor} [${e.error}]`);
    body.push('');
  }
  if (report.gone.length) {
    body.push('## GONE');
    for (const e of report.gone) body.push(`- ${e.domain}: ${e.anchor}${e.title ? ` (${e.title})` : ''}`);
    body.push('');
  }
  if (report.drift.length) {
    body.push('## DRIFT');
    for (const e of report.drift) body.push(`- ${e.domain}: ${e.anchor}${e.title ? ` (${e.title})` : ''}`);
    body.push('');
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readMemory(`registry?key=${encodeURIComponent(SWEEP_REPORT_KEY)}`);
    if (!Number.isSafeInteger(current?.version) || current.version < 0) {
      throw new Error('invalid memoryd registry version');
    }
    if (await updateRegistry(SWEEP_REPORT_KEY, current.version, body.join('\n'))) return;
  }
  throw new Error(`CAS conflict writing ${SWEEP_REPORT_KEY} after retry`);
}

/**
 * Print human table + summary. Returns exit code (1 if gone/error>0).
 */
export function printSweep(report) {
  console.log(`keep=${report.keep.length} drift=${report.drift.length} branch=${report.branch.length} gone=${report.gone.length} error=${report.error.length}`);
  for (const e of report.error) {
    console.error(`  ERROR ${e.domain}: ${e.anchor} [${e.error}]`);
  }
  for (const e of report.branch) {
    console.log(`  BRANCH ${e.domain}: ${e.anchor} [${e.refs.join(', ')}]`);
  }
  for (const e of report.drift) {
    console.log(`  DRIFT ${e.domain}: ${e.anchor}`);
  }
  for (const e of report.gone) {
    console.log(`  GONE  ${e.domain}: ${e.anchor}`);
  }
  if (report.drift.length) {
    console.warn(`WARN: ${report.drift.length} drifted anchors (re-review; no auto-supersede)`);
  }
  return report.gone.length + report.error.length > 0 ? 1 : 0;
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.includes('--db')) throw new Error('REFUSED --db: sweep reads memoryd only');
    const asJson = process.argv.includes('--json');
    const lessons = await readLessons({}, { status: 'active' });
    const report = sweep({ lessons });
    if (!process.argv.includes('--no-report')) await writeSweepReport(report);
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    }
    const code = printSweep(report);
    process.exit(code);
  } catch (err) {
    console.error(String(err?.message || err));
    process.exit(1);
  }
}
