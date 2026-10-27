// Sensor for the push half of the approval rules: operator approval to push covers YOUR
// work, but `git push` sends the BRANCH — every unpublished commit on it, including a
// parallel session's.
//
// On 2026-07-25 this failed with the evidence already on screen: `git log
// origin/master..HEAD` was run, a neighbouring session's commit was visible in the
// output, and the push went ahead anyway with the fact reported afterwards. The list was
// read as a formality. So this sensor does not print a list — it refuses to pass until
// every unpushed commit is named back to it:
//
//   npm run check:push                      -> lists what needs acknowledging, exits 1
//   npm run check:push -- --ack <sha>,<sha> -> passes only if the shas cover the list
//
// Naming a sha is cheap; naming one you have not looked at is a deliberate act rather
// than an oversight, which is the whole difference this is meant to make.
//
// What "already published" means is decided per DESTINATION URL, not per remote name —
// `origin` here has two push URLs and one of them was 25 commits behind. See rangesFor.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scrubbedGitEnv } from './git-env.mjs';

// argv[1] is the path AS TYPED while import.meta.url carries the RESOLVED real path, so an
// invocation through a symlink (macOS tmpdir fixtures: /var -> /private/var) never matched,
// the entry block silently did nothing and the guard approved by no-op. Compare the real
// path of argv[1]; an argv[1] that does not exist simply means "not the entry".
let isMain = false;
try {
  isMain = !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
} catch {
  isMain = false;
}
const SEP = '';

/**
 * @param {string} raw `git log --format=%h<SEP>%an<SEP>%ad<SEP>%s` output
 * @returns {Array<{ sha: string, author: string, date: string, subject: string }>}
 */
export function parseCommits(raw) {
  return String(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date, ...rest] = line.split(SEP);
      return { sha, author, date, subject: rest.join(SEP) };
    });
}

// A short prefix acknowledges by accident. `--ack 4` used to match every commit whose sha
// starts with 4 and print OK, which turns the whole gate off with one character.
export const MIN_ACK_CHARS = 7;

/** Acknowledgements match on a sha prefix, in either direction, if long enough to mean one commit. */
export function matches(sha, ack) {
  if (!sha || !ack || ack.length < MIN_ACK_CHARS) return false;
  return sha.startsWith(ack) || ack.startsWith(sha);
}

/**
 * @param {ReturnType<typeof parseCommits>} commits
 * @param {string[]} acks
 */
export function reconcile(commits, acks) {
  const unacked = commits.filter((c) => !acks.some((a) => matches(c.sha, a)));
  const unknown = acks.filter((a) => !commits.some((c) => matches(c.sha, a)));
  // One acknowledgement covering several commits is a bulk pass, not a reading of each.
  const ambiguous = acks.filter((a) => commits.filter((c) => matches(c.sha, a)).length > 1);
  const tooShort = acks.filter((a) => a.length < MIN_ACK_CHARS);
  return { unacked, unknown, ambiguous, tooShort };
}

/**
 * Refs git is actually about to push, from the pre-push stdin protocol:
 * `<local ref> <local sha> <remote ref> <remote sha>` per line. Reading only
 * origin/<current-branch>..HEAD missed every push of another branch or a tag.
 * A zero remote sha means the ref is new at the destination git contacted; a zero
 * LOCAL sha is a deletion and carries no commits.
 *
 * The remote sha is kept but is NOT the answer on its own: see resolveRanges.
 *
 * @param {string} stdin
 * @returns {Array<{ ref: string, tip: string, remoteSha: string, newRef: boolean }>}
 */
export function refsFromStdin(stdin) {
  const ZERO = /^0+$/;
  const out = [];
  for (const line of String(stdin).split('\n')) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue;
    out.push({
      ref: remoteRef || localRef,
      tip: localSha,
      remoteSha: ZERO.test(remoteSha || '') ? '' : remoteSha,
      newRef: ZERO.test(remoteSha || ''),
    });
  }
  return out;
}

/** @param {string} name @returns {string} the name if git has such a remote, else '' */
export function resolveRemote(name, listRemotes) {
  if (!name) return '';
  return listRemotes().includes(name) ? name : '';
}

const uniq = (list) => [...new Set(list.filter(Boolean))];

/**
 * Every push URL of a remote, from `git remote get-url --push --all <name>`.
 *
 * A remote NAME is not a destination. `origin` here carries two pushurls — github and
 * the NAS — and one `git push origin master` publishes to both.
 */
export function parsePushUrls(raw) {
  return uniq(String(raw).split('\n').map((s) => s.trim()));
}

/**
 * `git ls-remote <url>` output as { ref: sha }. Peeled tag lines (`refs/tags/v1^{}`)
 * describe the commit a tag points at, not a ref of its own.
 */
export function parseLsRemote(raw) {
  const out = {};
  for (const line of String(raw).split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref || ref.endsWith('^{}')) continue;
    out[ref] = sha;
  }
  return out;
}

/**
 * Ranges to examine: one per (ref being pushed × destination URL).
 *
 * `--not --remotes` — every remote — was the first hole: a commit sitting only on nas/*
 * counted as published and rode to origin unnamed, reproduced against
 * nas/refactor/a3-step1-feed-task-id. Naming ONE remote fixed that and opened the second
 * hole, found 2026-07-27: a remote name can have several push URLs, and `origin/master`
 * tracks only the first of them. `git push origin master` published to github (2 commits
 * acked, gate printed OK) and to the NAS, which was 25 commits behind — 23 commits reached
 * a destination unacknowledged, invisibly, because no ref in this repository described it.
 *
 * So the destination is a URL, what it already has comes from asking THAT URL, and the
 * acknowledgement covers the union. `excludes` is what the URL advertises AND we hold
 * locally: an advertised sha we do not have cannot be a `git log` argument, so the range
 * falls back to excluding everything we can name there — a superset of the commits, never
 * a subset, which errs toward demanding an ack rather than skipping one.
 *
 * A destination marked `unnamed` (a raw-URL push, where no remote name resolves) can only
 * be judged from the sha git itself advertised; for a ref that is new there, there is no
 * honest published set, so the entry carries `args: null` and the caller must refuse.
 *
 * @param {ReturnType<typeof refsFromStdin>} refs
 * @param {Array<{ url: string, advertised: Record<string, string>, excludes: string[], unnamed?: boolean }>} destinations
 */
export function rangesFor(refs, destinations) {
  const out = [];
  for (const d of destinations) {
    for (const r of refs) {
      const at = d.advertised[r.ref];
      const usable = at && d.excludes.includes(at);
      out.push({
        ref: r.ref,
        url: d.url,
        tip: r.tip,
        newRef: !at,
        args: usable
          ? [`${at}..${r.tip}`]
          : d.unnamed
            ? null
            : [r.tip, '--not', ...d.excludes],
      });
    }
  }
  return out;
}

/**
 * The published set per destination, asked of each destination.
 *
 * @param {ReturnType<typeof refsFromStdin>} refs
 * @param {string} remote destination remote NAME, already verified against `git remote`
 * @param {{ pushUrls: (name: string) => string[], lsRemote: (url: string) => string, knownCommits: (shas: string[]) => string[] }} io
 * @returns {{ ranges: ReturnType<typeof rangesFor>, urls: string[], unreachable: string[] }}
 */
export function resolveRanges(refs, remote, io) {
  if (!refs.length) return { ranges: [], urls: [], unreachable: [] };

  if (!remote) {
    const advertised = {};
    for (const r of refs) if (r.remoteSha) advertised[r.ref] = r.remoteSha;
    const excludes = io.knownCommits(Object.values(advertised));
    const destination = { url: '<unnamed destination>', advertised, excludes, unnamed: true };
    return { ranges: rangesFor(refs, [destination]), urls: [], unreachable: [] };
  }

  const urls = io.pushUrls(remote);
  const unreachable = [];
  const destinations = [];
  for (const url of urls) {
    let advertised;
    try {
      advertised = parseLsRemote(io.lsRemote(url));
    } catch {
      // Unreachable is not empty: a destination we cannot ask has an unknown published
      // set, and guessing it is what let 23 commits through. The caller refuses.
      unreachable.push(url);
      continue;
    }
    destinations.push({ url, advertised, excludes: io.knownCommits(Object.values(advertised)) });
  }
  if (!urls.length) unreachable.push(`(no push URL configured for ${remote})`);
  return { ranges: rangesFor(refs, destinations), urls, unreachable };
}

/** The git-backed side of resolveRanges. @param {string} cwd */
export function gitIo(cwd) {
  // An offline destination must fail, not hang: ssh would sit on a dead NAS until the TCP
  // timeout, and a credential prompt would wait for a human who is not there.
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes -oConnectTimeout=8',
    ...scrubbedGitEnv(),
  };
  const run = (args, options = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', ...options, env });
  return {
    pushUrls: (name) => parsePushUrls(run(['remote', 'get-url', '--push', '--all', name])),
    lsRemote: (url) => run(['ls-remote', url], { timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }),
    knownCommits: (shas) => {
      const list = uniq(shas);
      if (!list.length) return [];
      const out = run(['cat-file', '--batch-check'], { input: `${list.join('\n')}\n` });
      return out
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .filter(([, type]) => type === 'commit' || type === 'tag')
        .map(([sha]) => sha);
    },
  };
}

export function parseAcks(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--ack') continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) continue;
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

if (isMain) {
  const FORMAT = `--format=%h${SEP}%an${SEP}%ad${SEP}%s`;

  // The hook feeds git's pre-push refs on stdin; a manual run has none and judges the
  // current branch. It also forwards the destination remote NAME, whose push URLs are the
  // destinations that decide whether a commit is already published.
  const useStdin = process.argv.includes('--stdin-refs');

  // WHICH repository to judge. `npm run` climbs to the nearest package.json: invoked in a
  // worktree whose branch has none (corpus/knowledge-sources: a README and docs/), it runs
  // this script from the MAIN checkout while the caller stands in the worktree. Deriving
  // the repository from the script's own path then judged the main checkout's HEAD — on
  // 2026-08-05 it listed six commits of an unrelated branch as about to be published.
  // So the manual check judges the repository of the directory it was invoked from (npm
  // records it in INIT_CWD); a directory outside any git work tree is a loud refusal,
  // never a silent switch to the script's checkout. A direct node call can inherit stale
  // INIT_CWD: only use it under npm. Probed on npm 11: npm run sets npm_command=run;
  // npm exec and npx set npm_command=exec (and lifecycle_event=npx). The hook path is
  // unchanged: git runs it with cwd set to the worktree being pushed, ignoring INIT_CWD.
  const fromNpm = process.env.npm_command === 'run' || process.env.npm_command === 'exec';
  const invokeCwd = useStdin ? process.cwd() : (fromNpm && process.env.INIT_CWD) || process.cwd();
  let REPO;
  try {
    REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: invokeCwd, encoding: 'utf8', env: scrubbedGitEnv() }).trim();
  } catch (err) {
    console.error(`FAIL: the invoking directory is not inside a git work tree: ${invokeCwd}`);
    console.error(`git rev-parse --show-toplevel: ${err?.message || err}`);
    console.error('The check judges the repository the caller stands in; it will not silently switch to another one.');
    process.exit(1);
  }
  const scriptRepo = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  if (realpathSync(REPO) !== scriptRepo) {
    console.log(`check-push-safety: judging ${REPO} — the repository of the invoking directory, not the script's (${scriptRepo})`);
  }

  const log = (args) =>
    parseCommits(execFileSync('git', ['log', FORMAT, '--date=short', ...args], { cwd: REPO, encoding: 'utf8', env: scrubbedGitEnv() }));

  const stdinRefs = useStdin ? readFileSync(0, 'utf8') : '';
  const remoteArg = process.argv[process.argv.indexOf('--remote') + 1];
  const listRemotes = () =>
    execFileSync('git', ['remote'], { cwd: REPO, encoding: 'utf8', env: scrubbedGitEnv() }).split('\n').map((s) => s.trim()).filter(Boolean);
  const remote = resolveRemote(process.argv.includes('--remote') ? remoteArg : 'origin', listRemotes);

  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO, encoding: 'utf8', env: scrubbedGitEnv() }).trim();
  const refs = useStdin
    ? refsFromStdin(stdinRefs)
    : [
        {
          ref: `refs/heads/${branch}`,
          tip: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', env: scrubbedGitEnv() }).trim(),
          remoteSha: '',
          newRef: true,
        },
      ];

  // git fires pre-push with EMPTY stdin when there is nothing to send. Falling through to
  // the manual fallback then judged origin/<branch>..HEAD instead, which blocked a no-op
  // `git push nas master` demanding an ack for a commit that was already on nas and was
  // not part of any push. With --stdin-refs, stdin is the authority, including when empty.
  if (useStdin && !refs.length) {
    console.log('check-push-safety: OK (no refs being published)');
    process.exit(0);
  }

  let commits = [];
  let scope;
  try {
    // An explicit upstream is the escape when a destination cannot be asked at all; it
    // judges that one ref and says so, instead of pretending to cover every push URL.
    if (!useStdin && process.env.PUSH_UPSTREAM) {
      scope = process.env.PUSH_UPSTREAM;
      commits = log([`${scope}..HEAD`]);
    } else {
      const { ranges, urls, unreachable } = resolveRanges(refs, remote, gitIo(REPO));

      if (unreachable.length) {
        console.error(`FAIL: cannot ask ${unreachable.length} push destination(s) of "${remote}" what they already have:`);
        for (const url of unreachable) console.error(`  ${url}`);
        console.error('A destination whose published set is unknown is exactly how 23 commits reached the NAS');
        console.error('unacknowledged on 2026-07-27. Bring it up, push that URL alone (git push <url> <ref>),');
        console.error('or set PUSH_UPSTREAM=<ref> to judge one destination deliberately.');
        process.exit(1);
      }

      const unresolved = ranges.filter((r) => !r.args);
      if (unresolved.length) {
        console.error(
          `FAIL: pushing new ref(s) ${unresolved.map((r) => r.ref).join(', ')} to an unnamed destination ` +
            `(--remote ${remoteArg || '<missing>'}).`,
        );
        console.error('"Already published" only means anything against ONE destination: a commit on nas is not');
        console.error('published on github. Pass the destination remote name, or push through a named remote.');
        process.exit(1);
      }

      const seen = new Set();
      for (const r of ranges) {
        for (const c of log(r.args)) {
          if (seen.has(c.sha)) continue;
          seen.add(c.sha);
          commits.push(c);
        }
      }
      const where = urls.length ? `${urls.length} push URL(s) of ${remote}` : remoteArg || 'the named destination';
      scope = `${[...new Set(refs.map((r) => r.ref))].join(', ')} -> ${where}`;
    }
  } catch (err) {
    console.error(`FAIL: cannot resolve what is being pushed (${scope || 'no range'}) — ${err?.message || err}`);
    console.error('Fetch the remote, or set PUSH_UPSTREAM to name the comparison deliberately.');
    process.exit(1);
  }

  if (!commits.length) {
    console.log(`check-push-safety: OK (nothing to publish for ${scope})`);
    process.exit(0);
  }

  // A git pre-push hook cannot pass arguments, so it carries the acknowledgement in the
  // environment instead: PUSH_ACK=<sha>,<sha> git push
  const acks = [
    ...parseAcks(process.argv.slice(2)),
    ...(process.env.PUSH_ACK ? parseAcks(['--ack', process.env.PUSH_ACK]) : []),
  ];
  const { unacked, unknown, ambiguous, tooShort } = reconcile(commits, acks);

  for (const a of tooShort) console.error(`FAIL: ack "${a}" is shorter than ${MIN_ACK_CHARS} characters — name the commit, not a prefix`);
  for (const a of ambiguous) console.error(`FAIL: ack "${a}" matches more than one commit — one ack per commit`);
  for (const a of unknown) console.error(`FAIL: ack "${a}" matches no commit being pushed`);

  if (unacked.length) {
    console.error(`FAIL: ${unacked.length} of ${commits.length} commit(s) about to be published are not acknowledged.`);
    console.error('Pushing sends whole refs. Read each one, confirm it is yours to publish,');
    console.error('and ask the operator about any that is not:\n');
    for (const c of unacked) console.error(`  ${c.sha}  ${c.date}  ${c.author.padEnd(16)}  ${c.subject}`);
    console.error(`\n  npm run check:push -- --ack ${commits.map((c) => c.sha).join(',')}`);
    process.exit(1);
  }

  if (unknown.length || ambiguous.length || tooShort.length) process.exit(1);
  console.log(`check-push-safety: OK (${commits.length} commit(s) acknowledged for ${scope})`);
}

