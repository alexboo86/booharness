// Land a coder's accumulated change with one 3-way patch; neither checkout's branch is committed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Store } from './store.ts';
import { parseNumstat } from './review-plan.ts';
import { copyIndex } from './worktrees.ts';
import { landable, pathInWriteScope, remoteCheckoutGone, TEST_FILE_GLOBS, writeScopeOf } from './seats-defs.ts';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Buffer> => {
  const { stdout } = await exec('git', args, { cwd, env, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, timeout: 60_000, windowsHide: true });
  return stdout as Buffer;
};
const names = (output: Buffer): string[] => {
  const decoded = output.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(output)) throw new Error('non-UTF-8 Git path: refusing to land a lossy path');
  return decoded.split('\0').filter(Boolean);
};
const text = (output: Buffer): string => output.toString('utf8').trim();
const checkout = async (dir: string): Promise<string> => {
  if (!path.isAbsolute(dir) || !existsSync(dir)) throw new Error(`'${dir}' is not an existing absolute checkout`);
  return path.resolve(text(await git(dir, ['rev-parse', '--show-toplevel'])));
};
const commonDir = async (cwd: string): Promise<string> => realpathSync(path.resolve(cwd, text(await git(cwd, ['rev-parse', '--git-common-dir']))));

/** Destination first in porcelain v1 -z rename entries, followed by the old path. */
function dirtyPaths(output: Buffer): Set<string> {
  const fields = names(output);
  const dirty = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i].slice(0, 2);
    dirty.add(fields[i].slice(3));
    if (status.includes('R') || status.includes('C')) dirty.add(fields[++i]);
  }
  return dirty;
}

/** An ignored/untracked symlink directory must not send git apply outside this checkout. */
function checkPath(root: string, file: string): { createdDirs: string[]; exists: boolean } {
  const normalized = path.posix.normalize(file);
  if (!file || file.includes('\\') || path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || normalized !== file || normalized === '..' || normalized.startsWith('../')) throw new Error(`unsafe patch path: ${file}`);
  const components = file.split('/');
  let current = root;
  const createdDirs: string[] = [];
  let missing = false;
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i]);
    if (missing) {
      if (i < components.length - 1) createdDirs.push(components.slice(0, i + 1).join('/'));
      continue;
    }
    let entry;
    try { entry = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing = true;
      if (i < components.length - 1) createdDirs.push(components.slice(0, i + 1).join('/'));
      continue;
    }
    if (i < components.length - 1 && entry.isSymbolicLink()) throw new Error(`target path has a symlink directory: ${file}`);
    if (i < components.length - 1 && !entry.isDirectory()) throw new Error(`target path has a non-directory component: ${file}`);
    if (i < components.length - 1) {
      const real = realpathSync(current);
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error(`target path leaves checkout: ${file}`);
    }
  }
  return { createdDirs, exists: !missing };
}

function hunkRanges(root: string, file: string): { start: number; end: number }[] {
  const absolute = path.join(root, file);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return [];
  const lines = readFileSync(absolute, 'utf8').split('\n');
  const ranges: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('<<<<<<< ')) start = i + 1;
    else if (lines[i].startsWith('>>>>>>> ') && start !== null) {
      ranges.push({ start, end: i + 1 });
      start = null;
    }
  }
  return ranges;
}

/** git with bytes on stdin: path lists and object ids stay off argv. */
const gitInput = async (cwd: string, args: string[], input: string, env?: NodeJS.ProcessEnv): Promise<Buffer> => {
  const run = exec('git', args, { cwd, env, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, timeout: 60_000, windowsHide: true });
  // git may exit before reading a large input; its exit status rejects the run, so an
  // EPIPE on stdin must not escape as an unhandled error that kills the daemon.
  run.child.stdin!.on('error', () => {});
  run.child.stdin!.end(input);
  return (await run).stdout as Buffer;
};
const endings = (blob: Buffer): { crlf: number; lf: number } => {
  let crlf = 0, lf = 0;
  for (let i = blob.indexOf(10); i !== -1; i = blob.indexOf(10, i + 1)) {
    if (i > 0 && blob[i - 1] === 13) crlf++;
    else lf++;
  }
  return { crlf, lf };
};
/** Added-line counts keyed by path; -z keeps a tab-named path whole (parseNumstat). */
const numstat = async (cwd: string, base: string, env: NodeJS.ProcessEnv, extra: string[]): Promise<Map<string, { added: number; binary: boolean }>> =>
  new Map(parseNumstat(names(await git(cwd, ['diff', '--cached', '--no-renames', '--numstat', '-z', ...extra, base, '--'], env)).join('\0'), 'invalid land numstat row')
    .map(({ path: file, added, binary }) => [file, { added, binary }]));

/**
 * A host checkout on Windows can hand the mirror CRLF where the base stores LF; landing it would
 * rewrite whole files. Name each text file whose blob changed line endings against the base.
 * A new text file must carry no CRLF. Binary, -text and eol=crlf files (by the base's .gitattributes) are exempt.
 */
async function lineEndingDrift(source: string, base: string, env: NodeJS.ProcessEnv, paths: Set<string>): Promise<string[]> {
  const raw = names(await git(source, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', base, '--'], env));
  const candidates = new Map<string, { old: string | null; next: string }>();
  for (let i = 0; i < raw.length; i += 2) {
    const [, mode, oldOid, newOid, status] = raw[i].slice(1).split(' ');
    const file = raw[i + 1];
    if (!paths.has(file) || !/^100(644|755)$/.test(mode) || (status !== 'M' && status !== 'A')) continue;
    candidates.set(file, { old: status === 'M' ? oldOid : null, next: newOid });
  }
  if (!candidates.size) return [];
  const plain = await numstat(source, base, env, []);
  const ignoringCr = await numstat(source, base, env, ['--ignore-cr-at-eol']);
  const attrs = names(await gitInput(source, ['check-attr', '-z', '--stdin', `--source=${base}`, 'text', 'eol'], [...candidates.keys()].map((file) => `${file}\0`).join('')));
  for (let i = 0; i < attrs.length; i += 3) {
    const [file, attr, value] = attrs.slice(i, i + 3);
    if ((attr === 'text' && value === 'unset') || (attr === 'eol' && value === 'crlf')) candidates.delete(file);
  }
  for (const file of candidates.keys()) {
    const stat = plain.get(file);
    if (!stat) throw new Error(`land numstat has no row for changed file: ${file}`);
    if (stat.binary) candidates.delete(file); // git's binary detection
  }
  if (!candidates.size) return [];
  const oids = [...new Set([...candidates.values()].flatMap(({ old, next }) => old ? [old, next] : [next]))];
  const batch = await gitInput(source, ['cat-file', '--batch'], oids.map((oid) => `${oid}\n`).join(''));
  const blobs = new Map<string, Buffer>();
  for (let at = 0; at < batch.length;) {
    const eol = batch.indexOf(10, at);
    const [oid, , size] = batch.subarray(at, eol).toString('utf8').split(' ');
    blobs.set(oid, batch.subarray(eol + 1, eol + 1 + Number(size)));
    at = eol + 1 + Number(size) + 1;
  }
  const drift: string[] = [];
  for (const [file, { old, next }] of candidates) {
    const was = old ? endings(blobs.get(old)!) : null;
    const now = endings(blobs.get(next)!);
    // --ignore-cr-at-eol omits a file whose every change is a terminator; that file added no other line.
    const terminatorOnly = plain.get(file)!.added - (ignoringCr.get(file)?.added ?? 0);
    if (!was) { if (now.crlf) drift.push(`${file} (new file with CRLF endings: ${now.crlf} CRLF, ${now.lf} LF)`); }
    else if (was.lf && !was.crlf && now.crlf && !now.lf) drift.push(`${file} (converted LF to CRLF)`);
    else if (was.crlf && !was.lf && now.lf && !now.crlf) drift.push(`${file} (converted CRLF to LF)`);
    else if ((!was.crlf || !was.lf) && now.crlf && now.lf) drift.push(`${file} (mixed endings introduced: ${now.crlf} CRLF, ${now.lf} LF)`);
    else if (terminatorOnly > 0) drift.push(`${file} (${terminatorOnly} line(s) differ from base only in the terminator)`);
  }
  return drift;
}

const quote = (file: string): string => `'${file.replaceAll("'", "'\\''")}'`;
type Change = { path: string; conflicted: boolean } & ({ created: true } | { modified: true } | { deleted: true });
function recovery(files: Change[], createdDirs: Set<string>, stagedAdded?: Set<string>, baseRestore?: { base: string; paths: Set<string> }): { commands: string[] } {
  const tracked = files.filter((f) => !('created' in f));
  const added = files.filter((f) => 'created' in f);
  const staged = added.filter((f) => !stagedAdded || stagedAdded.has(f.path)).map((f) => quote(f.path));
  const commands: string[] = [];
  const append = (prefix: string, paths: string[]) => {
    for (let i = 0; i < paths.length; i += 200) commands.push(`${prefix} ${paths.slice(i, i + 200).join(' ')}`);
  };
  // A base-matched path holds an earlier slice of the same task, staged or dirty on top of an
  // older HEAD: restoring it from HEAD would discard that slice. Acceptance required index and
  // worktree to equal the seat base, so restoring both from the base commit returns exactly its
  // pre-land content (git apply --3way stages the postimage, so the index must be restored too).
  append('git restore --staged --worktree --', tracked.filter((f) => !baseRestore?.paths.has(f.path)).map((f) => quote(f.path)));
  if (baseRestore) append(`git restore --staged --worktree --source=${baseRestore.base} --`, tracked.filter((f) => baseRestore.paths.has(f.path)).map((f) => quote(f.path)));
  append('git restore --staged --', staged);
  append('rm --', added.map((f) => quote(f.path)));
  for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) commands.push(`rmdir -- ${quote(dir)}`);
  return { commands };
}

/** Serialize operations against the same checkout; preflight runs only after taking the lock. */
const targetLocks = new Map<string, Promise<void>>();
async function locked<T>(target: string, action: () => Promise<T>): Promise<T> {
  const previous = targetLocks.get(target);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  targetLocks.set(target, pending);
  if (previous) await previous;
  try { return await action(); }
  finally {
    if (targetLocks.get(target) === pending) targetLocks.delete(target);
    release();
  }
}

/** Land code only. The retired lesson-options slot stays reserved for existing callers. */
export async function land(store: Pick<Store, 'getSeat' | 'listTurns' | 'updateSeat'> & Partial<Store>, seatId: string, into?: string, _lessonOptions: unknown = {}, overrideReason?: string) {
  return landPatch(store, seatId, into, overrideReason);
}
async function landPatch(store: Pick<Store, 'getSeat' | 'listTurns' | 'updateSeat'> & Partial<Store>, seatId: string, into?: string, overrideReason?: string) {
  const seat = store.getSeat(seatId);
  if (!seat) throw new Error(`no seat '${seatId}'`);
  if (!landable(seat.role)) throw new Error(`seat '${seatId}' is not a coder or tester`);
  // Host removal and mirror integrity are separate: only close's recorded final
  // snapshot can authorize landing while the host checkout still needs removal.
  const remote = typeof seat.data.host === 'string';
  const cleanupOutstanding = remote && (seat.data.remoteRemoved !== true || Boolean(seat.data.remoteRemoveError));
  let recorded: { head: string; snapshot: string } | undefined;
  if (remote && seat.status !== 'closed') throw new Error(`seat '${seatId}' is not closed; close its remote checkout before landing`);
  if (cleanupOutstanding) {
    const refuse = (why: string, detail = ''): never => { throw new Error(`seat '${seatId}' has not safely mirrored its remote checkout: ${why}; retry seat_close before landing${detail}`); };
    if (seat.data.remoteCleanupPending !== false) {
      const since = [seat.data.remoteCleanupSince, seat.data.closedAt].find((at) => typeof at === 'string');
      const began = since ? ` began at ${since}` : ' (start time was not recorded)';
      refuse('remote close has not finished recording its mirror and cleanup outcome', `; pending remote close${began}; repeated seat_close does not hurry it`);
    }
    recorded = seat.data.remoteSnapshot as typeof recorded;
    if (!recorded || typeof recorded.head !== 'string' || typeof recorded.snapshot !== 'string' ||
        !/^[0-9a-f]{40,64}$/.test(recorded.head) || !/^[0-9a-f]{40,64}$/.test(recorded.snapshot)) {
      refuse('close recorded no complete snapshot and mirror');
    }
    // The snapshot ref alone may predate a turn or survive a failed mirror sync.
    // Match the durable close record and order it after all seat turn events;
    // event sequence handles equal millisecond timestamps without guessing.
    const proof = store.db?.prepare(`SELECT seq, ts,
      (SELECT COALESCE(MAX(seq), 0) FROM events WHERE seat_id = ? AND kind IN ('turn.queued', 'turn.started', 'turn.ended')) AS last_turn
      FROM events WHERE seat_id = ? AND kind = 'seat.remote_snapshot_recorded'
        AND json_extract(payload, '$.status') = 'closed'
        AND json_extract(payload, '$.remoteSnapshot.head') = ?
        AND json_extract(payload, '$.remoteSnapshot.snapshot') = ?
      ORDER BY seq DESC LIMIT 1`).get(seatId, seatId, recorded.head, recorded.snapshot) as { seq: number; ts: string; last_turn: number } | undefined;
    if (!proof) refuse('no durable close event proves this snapshot was completely mirrored');
    if (proof.seq <= proof.last_turn || store.listTurns(seatId).some((turn) => !turn.ended_at || turn.ended_at > proof.ts)) {
      refuse('recorded snapshot predates completion of the final turn');
    }
  }
  if (!seat.worktree || seat.data.worktreeRemoved || !existsSync(seat.worktree)) throw new Error(`seat '${seatId}' has no checkout to land`);
  const source = await checkout(seat.worktree);
  const target = realpathSync(await checkout(into ?? (seat.data.repo as string)));
  if (await commonDir(source) !== await commonDir(target)) throw new Error('into must be a checkout of the seat repository');
  if (realpathSync(source) === target) throw new Error('cannot land a seat into its own checkout');
  const base = seat.data.base;
  if (typeof base !== 'string' || !/^[0-9a-f]{40,64}$/.test(base)) throw new Error(`seat '${seatId}' has no resolved base commit`);
  const result = await locked(target, async () => {
    if (store.getSeat(seatId)?.data.closePending === true) throw new Error(`seat '${seatId}' has a pending close; wait before landing`);
    if (seat.status === 'provisioning' || store.listTurns(seatId).some((turn) => turn.status === 'running' || turn.status === 'queued')) throw new Error(`seat '${seatId}' has an active turn; wait before landing`);
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'orch-land-'));
    try {
      const index = path.join(scratch, 'index');
      const ownIndex = path.resolve(source, text(await git(source, ['rev-parse', '--git-path', 'index'])));
      if (existsSync(ownIndex)) await copyIndex(ownIndex, index);
      const env = { ...process.env, GIT_INDEX_FILE: index };
      if (!existsSync(index)) await git(source, ['read-tree', 'HEAD'], env);
      await git(source, ['add', '-A'], env);
      if (recorded) {
        let parent: string, snapshotTree: string;
        try {
          parent = text(await git(source, ['rev-parse', `${recorded.snapshot}^`]));
          snapshotTree = text(await git(source, ['rev-parse', `${recorded.snapshot}^{tree}`]));
        } catch {
          throw new Error(`seat '${seatId}' recorded remote snapshot is unavailable; retry seat_close before landing`);
        }
        if (parent !== recorded.head || text(await git(source, ['rev-parse', 'HEAD'])) !== recorded.head) {
          throw new Error(`seat '${seatId}' recorded remote snapshot does not match the mirror HEAD; retry seat_close before landing`);
        }
        if (text(await git(source, ['write-tree'], env)) !== snapshotTree) {
          throw new Error(`seat '${seatId}' mirror tree differs from its recorded remote snapshot; incomplete or changed mirror, nothing applied`);
        }
      }
      const skippedIgnored = names(await git(source, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']));
      const fields = names(await git(source, ['diff', '--cached', '--no-renames', '--name-status', '-z', base, '--'], env));
      const patchFiles = new Map<string, string>();
      for (let i = 0; i < fields.length; i += 2) patchFiles.set(fields[i + 1], fields[i]);
      if (!patchFiles.size) return { status: 'clean', files: [] as Change[], skippedIgnored, recovery: { commands: [] } };
      const patchPaths = [...patchFiles.keys()];
      const patchPathSet = new Set(patchPaths);
      const scope = writeScopeOf(seat.role);
      const outside = scope === undefined ? [] : patchPaths.filter((file) => !pathInWriteScope(file, scope));
      const scopeReason = overrideReason?.trim() || undefined;
      if (outside.length && !scopeReason) {
        throw new Error(`seat '${seatId}' patch paths are outside its write scope (${scope.join(', ')}): ${outside.join(', ')}; pass override_reason to land anyway`);
      }
      const modifiedTrackedTests = scope === undefined ? [] : patchPaths.filter((file) => patchFiles.get(file) === 'M' && pathInWriteScope(file, TEST_FILE_GLOBS));
      const trackedNote = modifiedTrackedTests.length ? { modifiedTrackedTests } : {};
      // status, ls-files and diff do not accept --pathspec-from-file (including Git 2.54).
      // Bound argv by filtering their NUL-delimited output instead.
      // A tracked patch path left dirty or staged by an earlier slice of the same task is landable
      // only when its RAW bytes, index blob and modes equal the seat base exactly: the patch hunks
      // then meet exactly the content they expect, git apply --3way's worktree-must-match-index rule
      // holds, and recovery by --source=<base> restores those exact bytes. git status/diff compare
      // after clean filters and eol normalization, so worktree equality is judged on raw bytes
      // against the smudged blob (exactly what checkout/restore writes), with ls-files -s and
      // ls-tree for stage, mode and oid. Any doubt or git failure refuses.
      const baseMatched = new Set<string>();
      // 'unstaged': the raw bytes and mode equal the base while the index entry still equals HEAD
      // (a change made by hand or by plain git apply, never staged). It is refused like any other
      // mismatch; the refusal names the remedy, because staging the path is the lead's act, not
      // seat_land's. An index entry that equals neither base nor HEAD holds bytes staged by the
      // lead that `git add` would replace, so it is 'differs' and gets no such hint.
      const baseState = async (file: string): Promise<'match' | 'unstaged' | 'differs'> => {
        try {
          const baseEntry = names(await git(target, ['--literal-pathspecs', 'ls-tree', '-z', base, '--', file]));
          const indexEntry = names(await git(target, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', file]));
          if (baseEntry.length !== 1 || indexEntry.length !== 1) return 'differs';
          const baseParts = /^(\d+) blob ([0-9a-f]{40,64})\t/.exec(baseEntry[0]);
          const indexParts = /^(\d+) ([0-9a-f]{40,64}) 0\t/.exec(indexEntry[0]);
          if (!baseParts || !indexParts) return 'differs';
          let same: 'match' | 'unstaged' = 'match';
          if (baseParts[1] !== indexParts[1] || baseParts[2] !== indexParts[2]) {
            const headEntry = names(await git(target, ['--literal-pathspecs', 'ls-tree', '-z', 'HEAD', '--', file]));
            const headParts = headEntry.length === 1 ? /^(\d+) blob ([0-9a-f]{40,64})\t/.exec(headEntry[0]) : null;
            if (!headParts || headParts[1] !== indexParts[1] || headParts[2] !== indexParts[2]) return 'differs';
            same = 'unstaged';
          }
          const [, mode, oid] = baseParts;
          const stat = lstatSync(path.join(target, file));
          if (stat.isSymbolicLink()) {
            if (mode !== '120000') return 'differs';
            return text(await gitInput(target, ['hash-object', '--stdin'], readlinkSync(path.join(target, file)))) === oid ? same : 'differs';
          }
          if (!stat.isFile()) return 'differs';
          if (mode !== '100644' && mode !== '100755') return 'differs';
          if (process.platform !== 'win32' && Boolean(stat.mode & 0o111) !== (mode === '100755')) return 'differs';
          // Recovery by --source=<base> writes the smudged blob, so accept only raw bytes equal to
          // it; a clean filter or eol normalization must not hide uncommitted bytes (#12950).
          // Size first: the raw file is unbounded, the smudged side is bounded by git()'s maxBuffer.
          const smudged = await git(target, ['cat-file', '--filters', `--path=${file}`, oid]);
          return smudged.length === stat.size && smudged.equals(readFileSync(path.join(target, file))) ? same : 'differs';
        } catch {
          return 'differs';
        }
      };
      const matchesBase = async (file: string): Promise<boolean> => (await baseState(file)) === 'match';
      /**
       * Smudged index blob of a tracked patch path, as checkout would write it; 'skip' only for a
       * verified symlink/gitlink stage-0 entry (no filters apply). Fails closed: a missing,
       * multiple, non-stage-0 or malformed entry, or an unexpected mode, refuses. --literal-pathspecs
       * keeps a filename like '[ab].txt' from matching other paths as a glob.
       */
      const smudgedIndex = async (file: string): Promise<Buffer | 'skip'> => {
        const entry = names(await git(target, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', file]));
        const parts = entry.length === 1 ? /^(\d+) ([0-9a-f]{40,64}) 0\t/.exec(entry[0]) : null;
        if (!parts) throw new Error(`target patch path has no single stage-0 index entry: ${file}`);
        if (parts[1] === '120000' || parts[1] === '160000') return 'skip';
        if (parts[1] !== '100644' && parts[1] !== '100755') throw new Error(`target patch path has unexpected index mode ${parts[1]}: ${file}`);
        return git(target, ['cat-file', '--filters', `--path=${file}`, parts[2]]);
      };
      const preflight = async () => {
        const dirty = dirtyPaths(await git(target, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all', '-z']));
        const createdDirs = new Set<string>();
        const tracked = new Set(names(await git(target, ['ls-files', '-z'])).filter((file) => patchPathSet.has(file)));
        const alreadyApplied: string[] = [];
        for (const file of patchPaths) {
          const state = checkPath(target, file);
          if (dirty.has(file) || (state.exists && !tracked.has(file))) {
            const versusBase = tracked.has(file) ? await baseState(file) : 'differs';
            if (versusBase === 'unstaged') {
              throw new Error(`target patch path is dirty and unstaged, but its bytes equal the seat's base: run \`git --literal-pathspecs add -- ${quote(file)}\` in the target checkout and land again: ${file}`);
            }
            if (versusBase !== 'match') {
              throw new Error(`target patch path is dirty, untracked or ignored: ${file}`);
            }
            baseMatched.add(file);
          } else if (state.exists && tracked.has(file)) {
            // A clean filter or eol normalization plus a refreshed stat cache makes status report
            // clean while raw worktree bytes hold uncommitted data; apply --3way would rewrite the
            // file and recovery restore only the blob. Accept only raw bytes equal to the smudged
            // index blob, i.e. exactly what checkout of the index would write (#12950).
            // Size first: the raw file is unbounded, the smudged side is bounded by git()'s maxBuffer.
            const smudged = await smudgedIndex(file);
            if (smudged !== 'skip') {
              const stat = lstatSync(path.join(target, file));
              if (!stat.isFile() || stat.size !== smudged.length || !smudged.equals(readFileSync(path.join(target, file)))) {
                throw new Error(`target patch path's raw bytes differ from the checked-out index blob: ${file}`);
              }
            }
          }
          if (patchFiles.get(file) === 'D' && !tracked.has(file)) alreadyApplied.push(file);
          else for (const dir of state.createdDirs) createdDirs.add(dir);
        }
        return { createdDirs, tracked, alreadyApplied };
      };
      // Report host drift before target preflight can hide its file list and restore guidance.
      // Already-applied deletions need no omission here: lineEndingDrift only checks additions/modifications.
      if (typeof seat.data.host === 'string') {
        const drift = await lineEndingDrift(source, base, env, patchPathSet);
        if (drift.length) throw new Error(`seat '${seatId}' changed line endings in its host checkout; nothing applied: ${drift.join('; ')}. `
          + `Restore each file's base endings in the mirror ${source} (an LF base: perl -pi -e 's/\\r$//' <file>), then land again`);
      }
      const initial = await preflight();
      let { createdDirs, tracked } = initial;
      const { alreadyApplied } = initial;
      if (alreadyApplied.length) {
        const omitted = path.join(scratch, 'already-applied-pathspecs');
        writeFileSync(omitted, alreadyApplied.map((file) => `:(literal)${file}\0`).join(''));
        // Only the disposable index is reset: the seat's index and worktree remain untouched.
        await git(source, ['reset', '-q', base, `--pathspec-from-file=${omitted}`, '--pathspec-file-nul'], env);
      }
      const omittedPaths = new Set(alreadyApplied);
      const paths = patchPaths.filter((file) => !omittedPaths.has(file));
      const applied = alreadyApplied.length ? { alreadyApplied } : {};
      if (!paths.length) return { status: 'clean', files: [] as Change[], skippedIgnored, ...applied, ...trackedNote, recovery: { commands: [] } };
      const patchFile = path.join(scratch, 'patch');
      // Git writes directly to disk; the patch never passes through execFile's stdout limit.
      await git(source, ['diff', '--cached', '--no-renames', '--binary', `--output=${patchFile}`, base], env);
      const rechecked = await preflight();
      if (rechecked.alreadyApplied.join('\0') !== alreadyApplied.join('\0')) throw new Error('target patch paths changed during preflight');
      ({ createdDirs, tracked } = rechecked);
      // This disposable index is the exact patch about to be applied (including untracked files,
      // excluding already-applied deletions). Keep the snapshot independent of the apply outcome.
      let snapshot: string | null = null;
      try {
        const ref = `refs/orch/landed/${seatId}`;
        await git(source, ['check-ref-format', ref]);
        const tree = text(await git(source, ['write-tree'], env));
        const commit = text(await git(source, ['-c', 'user.name=orch', '-c', 'user.email=orch@localhost', 'commit-tree', tree, '-p', base, '-m', `orch land ${seatId}`], env));
        await git(source, ['update-ref', ref, commit]);
        snapshot = commit;
      } catch (error) {
        console.warn(`seat_land snapshot failed for ${seatId}: ${(error as Error).message}`);
      }
      const changes = (conflicted: Set<string>): Change[] => paths.map((file) => ({
        path: file, conflicted: conflicted.has(file),
        ...(patchFiles.get(file) === 'D' ? { deleted: true as const } : tracked.has(file) ? { modified: true as const } : { created: true as const }),
      }));
      try {
        await git(target, ['apply', '--3way', '--binary', patchFile]);
      } catch (error) {
        const unmerged = names(await git(target, ['diff', '--name-only', '--diff-filter=U', '-z'])).filter((file) => patchPathSet.has(file));
        if (unmerged.length) {
          const files = changes(new Set(unmerged));
          return { status: 'conflict', files, skippedIgnored, ...applied, ...trackedNote, conflicts: unmerged.map((file) => ({ file, hunks: hunkRanges(target, file) })), recovery: recovery(files, createdDirs, undefined, { base, paths: baseMatched }) };
        }
        // Git refuses a delete/modify patch without an unmerged index. A failed
        // whole-patch apply must not be called a conflict if it changed the tree.
        const after = dirtyPaths(await git(target, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all', '-z']));
        let changedList = paths.filter((file) => after.has(file));
        // A base-matched path was dirty before the apply; only leaving its accepted state (raw
        // bytes, index blob and modes equal the base) proves the failed apply touched it.
        const changedKept: string[] = [];
        for (const file of changedList) {
          if (!baseMatched.has(file) || !(await matchesBase(file))) changedKept.push(file);
        }
        changedList = changedKept;
        if (changedList.length) {
          const changedPaths = new Set(changedList);
          const files = changes(changedPaths).filter((file) => changedPaths.has(file.path));
          const stagedAdded = new Set(names(await git(target, ['ls-files', '-z'])));
          const existingDirs = new Set([...createdDirs].filter((dir) => existsSync(path.join(target, dir))));
          return { status: 'conflict', files, skippedIgnored, ...applied, ...trackedNote, applyError: `git apply failed and target changed: ${(error as Error).message.slice(-1000)}`, recovery: recovery(files, existingDirs, stagedAdded, { base, paths: baseMatched }) };
        }
        const deleteModify = paths.filter((file) => patchFiles.get(file) === 'D' || (patchFiles.get(file) === 'M' && !tracked.has(file)));
        if (deleteModify.length) return {
          status: 'conflict', conflict: { kind: 'delete-modify', files: deleteModify }, nothingApplied: true,
          files: changes(new Set(deleteModify)), skippedIgnored, ...applied, ...trackedNote, recovery: { commands: [] },
        };
        throw new Error(`git apply failed without changes: ${(error as Error).message.slice(-1000)}`);
      }
      const files = changes(new Set());
      // Only a clean apply is recorded: after a conflict the target holds neither the snapshot nor a
      // known resolution. The record must not turn a landed change into a reported failure.
      const landed = { at: new Date().toISOString(), into: target, paths, snapshot, ...(scopeReason ? { overrideReason: scopeReason } : {}) };
      try {
        store.updateSeat(seatId, { data: { landed, ...(scopeReason ? { writeScopeOverride: { reason: scopeReason, at: landed.at, paths: outside } } : {}) } }, 'seat.updated', { landed: { ...landed, paths: paths.length } });
      } catch (error) {
        console.warn(`seat_land record failed for ${seatId}: ${(error as Error).message}`);
      }
      return { status: 'clean', files, skippedIgnored, ...applied, ...trackedNote, recovery: recovery(files, createdDirs, undefined, { base, paths: baseMatched }) };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  // The snapshot proof above still ran. The observation only stops reporting a removal the host no longer needs.
  return cleanupOutstanding && !remoteCheckoutGone(seat.data) ? { ...result, hostCheckoutNeedsRemoval: true, remoteRemoveError: seat.data.remoteRemoveError } : result;
}
