/**
 * Retained code (task 1563, arXiv 2604.20779): the share of the lines a coder
 * seat added that survive into the commit that landed its work. Pure git, no
 * store: callers link a seat to its landing commit.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await exec('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 60_000, windowsHide: true })).stdout;

// Pinned against user config: color, external/textconv drivers, prefixes and relative diffs
// would change the text parsed below. Renames on, so a moved file is not counted as added.
const PATCH = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '--find-renames', '--unified=0'];

export type RetainedShare = { added: number; retained: number; share: number } | { unmeasurable: string };

/** The commit `ref` names, or null when it names none (pruned branch, unknown commit). */
export async function commitOf(repo: string, ref: string): Promise<string | null> {
  try {
    return (await git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return null;
    throw error;
  }
}

/** Git's C-quoted path ("a\tb", "\303\251") back to its bytes, decoded as UTF-8. */
function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const bytes: number[] = [];
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const next = raw[++i];
    if (/[0-7]/.test(next)) { bytes.push(parseInt(raw.slice(i, i + 3), 8)); i += 2; }
    else if (next in named) bytes.push(named[next]);
    else throw new Error(`unknown escape \\${next} in git path ${raw}`);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Added lines per destination path, trailing whitespace trimmed, as a multiset. */
function addedLines(patch: string): Map<string, Map<string, number>> {
  const byPath = new Map<string, Map<string, number>>();
  let current: Map<string, number> | null = null;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { current = null; inHunk = false; continue; }
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        const target = line.slice(4);
        if (target === '/dev/null') { current = null; continue; }
        const file = unquote(target);
        if (!file.startsWith('b/')) throw new Error(`unexpected diff target ${target}`);
        current = byPath.get(file.slice(2)) ?? new Map();
        byPath.set(file.slice(2), current);
      } else if (line.startsWith('@@ ')) inHunk = true;
      continue;
    }
    if (line.startsWith('@@ ')) continue;
    if (line.startsWith('+') && current) {
      const text = line.slice(1).replace(/\s+$/, '');
      current.set(text, (current.get(text) ?? 0) + 1);
    }
  }
  return byPath;
}

// A landing commit naming several seats is parsed once per run; a commit id never changes its patch.
const landings = new Map<string, Promise<Map<string, Map<string, number>>>>();

/** One landing commit's added lines per destination path, cached per run. */
function landingAdded(repo: string, commit: string): Promise<Map<string, Map<string, number>>> {
  const key = `${repo}\0${commit}`;
  if (!landings.has(key)) landings.set(key, git(repo, ['show', '--format=', '--diff-merges=first-parent', ...PATCH, commit, '--']).then(addedLines));
  return landings.get(key)!;
}

// Blob content is immutable; key by repo and blob sha. One `cat-file --batch` per call fills the misses,
// and the module-level cache carries every fetched blob across the seats of a report run.
const blobs = new Map<string, Promise<string>>();

/** git with bytes on stdin and stdout, the land.ts gitInput shape: object ids stay off argv. */
const gitBuffer = async (cwd: string, args: string[], input: string): Promise<Buffer> => {
  const run = exec('git', args, { cwd, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, timeout: 60_000, windowsHide: true });
  run.child.stdin!.on('error', () => {});
  run.child.stdin!.end(input);
  return (await run).stdout as Buffer;
};

/**
 * Contents of the given blob shas, fetched in a single `git cat-file --batch` process.
 * Sizes in the batch header are BYTES: the payload is cut from the raw Buffer by byte
 * offsets and only then decoded; slicing a decoded string would misalign every blob
 * after a UTF-8 one (task 1768 review).
 */
async function blobContents(repo: string, shas: string[]): Promise<Map<string, string>> {
  const missing = [...new Set(shas)].filter((sha) => !blobs.has(`${repo}\0${sha}`));
  if (missing.length) {
    const batch = await gitBuffer(repo, ['cat-file', '--batch'], missing.map((sha) => `${sha}\n`).join(''));
    // --batch answers in request order: "<sha> blob <size>\n<bytes>\n" or "<sha> missing\n".
    const payloads = new Map<string, Buffer>();
    for (let at = 0; at < batch.length;) {
      const eol = batch.indexOf(10, at);
      if (eol === -1) throw new Error('truncated git cat-file --batch header');
      const [oid, , size] = batch.subarray(at, eol).toString('utf8').split(' ');
      if (size === undefined) { payloads.set(oid, Buffer.alloc(0)); at = eol + 1; continue; } // missing
      payloads.set(oid, batch.subarray(eol + 1, eol + 1 + Number(size)));
      at = eol + 1 + Number(size) + 1;
    }
    for (const sha of missing) blobs.set(`${repo}\0${sha}`, Promise.resolve((payloads.get(sha) ?? Buffer.alloc(0)).toString('utf8')));
  }
  return new Map(await Promise.all(shas.map(async (sha) => [sha, await blobs.get(`${repo}\0${sha}`)!] as const)));
}

/** Blob sha of `path` in `ref`'s tree, or null when the path is absent (or not a blob). */
async function blobAt(repo: string, ref: string, file: string): Promise<string | null> {
  const out = await git(repo, ['ls-tree', '-z', '--end-of-options', ref, '--', `:(literal)${file}`]);
  const match = /^\d+ blob ([0-9a-f]{40,64})\t/.exec(out.split('\0')[0] ?? '');
  return match ? match[1] : null;
}

/** Count per trimmed line of a blob's content, matching addedLines' trailing-whitespace trim. */
function lineCounts(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of content.split('\n')) {
    const text = line.replace(/\s+$/, '');
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

/** Oldest reachable commit after the land time touching a recorded literal path. */
export async function firstRecordedLanding(repo: string, at: string, paths: string[]): Promise<string | null> {
  // %cI has whole seconds; `at` has milliseconds, so compare from the start of the land's second.
  const since = Math.floor(Date.parse(at) / 1000) * 1000;
  if (!Number.isFinite(since) || !paths.length) return null;
  const log = await git(repo, ['log', '--reverse', '--format=%H%x00%cI', '-z', 'HEAD', '--', ...paths.map((file) => `:(literal)${file}`)]);
  const fields = log.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (Date.parse(fields[i + 1]) >= since) return fields[i].trim();
  }
  return null;
}

export async function retainedShare({ repo, seatBase, seatTip, landingCommit }: { repo: string; seatBase: string; seatTip: string; landingCommit: string }): Promise<RetainedShare> {
  if (!existsSync(repo)) return { unmeasurable: `repository ${repo} does not exist` };
  const refs = { seatBase, seatTip, landingCommit };
  const resolved: Record<string, string> = {};
  for (const [name, ref] of Object.entries(refs)) {
    const sha = await commitOf(repo, ref);
    if (!sha) return { unmeasurable: `${name} '${ref}' does not name a commit in ${repo}` };
    resolved[name] = sha;
  }
  const seat = addedLines(await git(repo, ['diff', ...PATCH, resolved.seatBase, resolved.seatTip, '--']));
  // First parent for a merge: the lines the landing brought in, in the plain patch format.
  const landing = await landingAdded(repo, resolved.landingCommit);
  let added = 0;
  let retained = 0;
  for (const [file, lines] of seat) {
    const landed = landing.get(file);
    for (const [text, count] of lines) {
      added += count;
      retained += Math.min(count, landed?.get(text) ?? 0);
    }
  }
  if (!added) return { unmeasurable: 'the seat diff adds no lines' };
  return { added, retained, share: retained / added };
}

export type SurvivalShare = { added: number; surviving: number; share: number } | { young: true } | { unmeasurable: string };

/** A line too short or too symbolic to track across rewrites (braces match anywhere). */
function countable(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 4 && /[A-Za-z0-9]/.test(trimmed);
}

/**
 * Survival share (task 1768): of the lines the landing commit brought in, how many are still
 * in HEAD. Denominator: the multiset intersection of the seat patch's added lines with the
 * landing's added lines (the same landed lines retainedShare counts, filtered by `countable`).
 * Numerator: those texts still present in the HEAD blob of the same path, following one rename
 * remap per seat; a path absent at HEAD without a rename entry counts 0 surviving. A landing
 * younger than `days` has not aged enough: { young: true }. The seat patch is `S^..S` of its
 * land snapshot when one exists, else base..tip.
 */
export async function survivalShare({ repo, seatBase, seatTip, snapshot, landingCommit, days = 7 }: { repo: string; seatBase: string; seatTip: string; snapshot: string | null; landingCommit: string; days?: number }): Promise<SurvivalShare> {
  if (!existsSync(repo)) return { unmeasurable: `repository ${repo} does not exist` };
  const landingSha = await commitOf(repo, landingCommit);
  if (!landingSha) return { unmeasurable: `landingCommit '${landingCommit}' does not name a commit in ${repo}` };
  const landedAt = Date.parse((await git(repo, ['show', '-s', '--format=%cI', '--end-of-options', landingSha])).trim());
  if (!Number.isFinite(landedAt)) return { unmeasurable: `landing commit ${landingSha} has no commit date` };
  if (Date.now() - landedAt < days * 86_400_000) return { young: true };
  let from = seatBase;
  let to = seatTip;
  if (snapshot) {
    const snap = await commitOf(repo, snapshot);
    if (!snap) return { unmeasurable: `snapshot '${snapshot}' does not name a commit in ${repo}` };
    from = `${snap}^`;
    to = snap;
  } else {
    const [base, tip] = [await commitOf(repo, seatBase), await commitOf(repo, seatTip)];
    if (!base) return { unmeasurable: `seatBase '${seatBase}' does not name a commit in ${repo}` };
    if (!tip) return { unmeasurable: `seatTip '${seatTip}' does not name a commit in ${repo}` };
    from = base;
    to = tip;
  }
  const patch = addedLines(await git(repo, ['diff', ...PATCH, from, to, '--']));
  const landing = await landingAdded(repo, landingSha);
  // Candidates: landed, countable texts per path, counted as the seat/landing multiset intersection.
  const wanted = new Map<string, Map<string, number>>();
  for (const [file, lines] of patch) {
    const landed = landing.get(file);
    if (!landed) continue;
    for (const [text, count] of lines) {
      if (!countable(text)) continue;
      const kept = Math.min(count, landed.get(text) ?? 0);
      if (kept) {
        const entry = wanted.get(file) ?? new Map();
        entry.set(text, kept);
        wanted.set(file, entry);
      }
    }
  }
  let added = 0;
  for (const lines of wanted.values()) for (const count of lines.values()) added += count;
  if (!added) return { unmeasurable: 'the landing keeps no countable seat lines' };
  // HEAD blob per path; one rename remap per seat for the paths HEAD has lost.
  const headBlobs = new Map<string, string | null>();
  const missing: string[] = [];
  for (const file of wanted.keys()) {
    const sha = await blobAt(repo, 'HEAD', file);
    headBlobs.set(file, sha);
    if (!sha) missing.push(file);
  }
  if (missing.length) {
    // No pathspec: restricting to the old paths hides the destination, so git reports D, not R.
    const renamed = await git(repo, ['diff', '-M', '--name-status', '-z', landingSha, 'HEAD']);
    // -z name-status: "R100\0old\0new\0"; keep only the rows whose source is a missing path.
    const fields = renamed.split('\0').filter(Boolean);
    const wantedMissing = new Set(missing);
    const remap = new Map<string, string>();
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].startsWith('R') && i + 2 < fields.length) {
        if (wantedMissing.has(fields[i + 1]) && !remap.has(fields[i + 1])) remap.set(fields[i + 1], fields[i + 2]);
        i += 2;
      }
    }
    for (const file of missing) {
      const target = remap.get(file);
      if (target) headBlobs.set(file, await blobAt(repo, 'HEAD', target));
    }
  }
  const contents = await blobContents(repo, [...headBlobs.values()].flatMap((sha) => sha ? [sha] : []));
  let surviving = 0;
  for (const [file, lines] of wanted) {
    const sha = headBlobs.get(file);
    if (!sha) continue; // Path gone at HEAD, no rename: 0 surviving.
    const head = lineCounts(contents.get(sha) ?? '');
    for (const [text, count] of lines) surviving += Math.min(count, head.get(text) ?? 0);
  }
  return { added, surviving, share: surviving / added };
}

/**
 * Commits on `ref` whose message names coder seats in the lead's trailer, newest first:
 * `Author coder-<id>` or `Authors coder-<a> (...), coder-<b> (...)`, with or without a colon
 * (`Author: coder-<id>.`). The list runs to the first ';' of its paragraph (it may wrap), or only
 * its own line when the paragraph has none.
 */
export async function landingCommits(repo: string, ref = 'HEAD'): Promise<{ commit: string; seats: string[] }[]> {
  const log = await git(repo, ['log', '-E', '--grep=^Authors?:? *coder-', '--format=%H%x00%B%x1e', '--end-of-options', ref, '--']);
  return log.split('\x1e').flatMap((record) => {
    const [head, body] = record.replace(/^\n/, '').split('\0');
    if (!body) return [];
    const lines = body.split('\n');
    const seats = new Set<string>();
    lines.forEach((line, i) => {
      if (!/^Authors?:? *coder-/.test(line)) return;
      const end = lines.findIndex((next, j) => j > i && next.trim() === '');
      const paragraph = lines.slice(i, end === -1 ? undefined : end).join('\n');
      const list = paragraph.includes(';') ? paragraph.slice(0, paragraph.indexOf(';')) : line;
      for (const id of list.match(/\bcoder-[a-z0-9]+-[0-9a-f]{6}\b/g) ?? []) seats.add(id);
    });
    return seats.size ? [{ commit: head.trim(), seats: [...seats] }] : [];
  });
}
