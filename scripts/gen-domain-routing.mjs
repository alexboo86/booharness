import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { scrubbedGitEnv } from './git-env.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// Routing build input. The domain-* SKILL.md files are not delivered as skills;
// install-harness.mjs only junctions `.agents/skills`. The generated JSON is
// what the memory router reads — this directory is only the glob source.
const DOMAINS = join(REPO, '.agents', 'domains');
const OUT = join(REPO, 'docs', 'agent', 'domain-routing.generated.json');

export function parseSkillFiles(md) {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const m = fm[1].match(/^files:\s*\n((?:[ \t]*-[ \t]*.+\n?)+)/m);
  if (!m) return [];
  return m[1].split('\n')
    .map(l => l.replace(/^[ \t]*-[ \t]*/, '').trim())
    .map(s => s.replace(/^(['"])(.*)\1$/, '$2')) // strip matching surrounding quotes (e.g. "**")
    .filter(Boolean);
}

// literal prefix length = chars before the first glob metachar; longer = more specific
function specificity(glob) {
  const i = glob.search(/[*?[]/);
  return i === -1 ? glob.length + 1000 : i;
}

// platform-shell is the designated CATCH-ALL: on a specificity tie it must always lose to a
// real domain (its broad src/** etc. globs tie with wildcard globs like src/**/*[Hh]eatmap*).
const CATCHALL = 'domain-platform-shell';

/// WHICH repository these globs describe, as its root commit.
//
// `domain-lessons-hook.mjs` reads this map to route a file's SUBJECT to its
// domain (Svod used to compile it into its own binary the same way before it
// was retired), so whatever reads it needs to know whether a given checkout is
// of THIS repository. A file at a
// well-known path is not that answer: a review seat measured on 2026-08-08 that
// any foreign checkout carrying `docs/agent/domain-routing.generated.json` would
// be routed by these globs and handed this project's domain skills. A root
// commit is the identity itself - the same in every clone and every worktree,
// and unchanged by the branch a checkout sits on, which is what a STALE worktree
// needs it to be.
//
// A repository with several root commits (merged histories) reports its oldest
// first; the reader accepts a match against ANY of the subject's roots, so this
// stays a one-way claim rather than a guess about which one is canonical.
//
// The kit build runs this generator inside its stage, which is no repository,
// and names the donor's git dir with `--git-dir`. Only that explicit argument
// redirects git; an inherited GIT_DIR is still scrubbed (task 2952).
function repositoryIdentity(gitDir) {
  return execFileSync('git', ['-C', REPO, 'rev-list', '--max-parents=0', 'HEAD'], {
    env: gitDir ? { ...scrubbedGitEnv(), GIT_DIR: gitDir } : scrubbedGitEnv(),
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop();
}

export function buildRoutingMap(byDomain, repository) {
  const order = [];
  for (const [domain, globs] of Object.entries(byDomain))
    for (const glob of globs) order.push({ glob, domain, spec: specificity(glob) });
  order.sort((a, b) =>
    b.spec - a.spec ||
    ((a.domain === CATCHALL) - (b.domain === CATCHALL)) ||
    a.glob.localeCompare(b.glob));
  return { repository, byDomain, order };
}

export function collect({ gitDir } = {}) {
  const byDomain = {};
  for (const d of readdirSync(DOMAINS)) {
    if (!d.startsWith('domain-')) continue;
    const p = join(DOMAINS, d, 'SKILL.md');
    if (!existsSync(p)) continue;
    byDomain[d] = parseSkillFiles(readFileSync(p, 'utf8'));
  }
  return {
    ...buildRoutingMap(byDomain, repositoryIdentity(gitDir)),
    retiredDomains: JSON.parse(readFileSync(join(DOMAINS, '_retired-domains.json'), 'utf8')),
  };
}

if (isMain(import.meta.url)) {
  const at = process.argv.indexOf('--git-dir');
  const gitDir = at === -1 ? undefined : process.argv[at + 1];
  if (at !== -1 && !gitDir) throw new Error('usage: gen-domain-routing.mjs [--git-dir <absolute git dir>]');
  const map = collect({ gitDir });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(map, null, 2) + '\n');
  console.log(`wrote ${OUT} — ${map.order.length} globs across ${Object.keys(map.byDomain).length} domains`);
}
