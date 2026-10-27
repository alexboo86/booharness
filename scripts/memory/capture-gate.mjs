// Pre-append gate shared by CLI capture and orch lesson proposals. No write on refusal.
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { scrubbedGitEnv } from '../git-env.mjs';
import { REPO_ROOT, anchorFile, isGlobAnchor, matchGlob } from './lesson-lib.mjs';
import { LESSON_GATE_VERSION, resolveDomain, resolveExplicitDomain } from './store.mjs';
import { checkLesson, lessonFields } from './lesson-quality.mjs';

// Evidence is inspected as text, never executed. Commands must start a line:
// mentioning a bare command in prose is not a reproducible invocation.
export const EVIDENCE_FORMS = 'a commit SHA (7-40 hex chars with at least one digit), a memory id #N, a repo-relative path that exists in this checkout, or a check/test command (a line starting with the exact word node, npm, npx, cargo, git, rg or bash followed by whitespace and an argument token using only letters, digits, _./@=:+-)';
const MEMORY_ID = /^#[0-9]+$/;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
const CHECK_COMMAND = /^(?:node|npm|npx|cargo|git|rg|bash)[ \t]+[A-Za-z0-9_./@=:+-]+(?:[ \t]|$)/;
const EDGE_PUNCTUATION = /^[("'«[]+|[)"'»\],.;:!?]+$/g;

export function evidenceProblem(evidence) {
  const text = String(evidence ?? '');
  // Prose punctuation at a token's edges ('(#123,', 'abc1234.') is not part of the id.
  const reproducible = text.split(/\s+/).map((word) => word.replace(EDGE_PUNCTUATION, '')).filter(Boolean).some((token) => {
    if (MEMORY_ID.test(token)) return true;
    if (COMMIT_SHA.test(token) && /[0-9]/.test(token)) return true;
    if (path.isAbsolute(token) || /^[A-Za-z]:/.test(token) || token.split(/[\\/]/).includes('..')) return false;
    const resolved = path.resolve(REPO_ROOT, token);
    return resolved !== REPO_ROOT && resolved.startsWith(REPO_ROOT + path.sep) && fs.existsSync(resolved);
  }) || text.split(/\r?\n/).some(line => CHECK_COMMAND.test(line.trim()));
  return reproducible ? null : `--evidence carries none of the reproducible forms: ${EVIDENCE_FORMS}`;
}

// Supersede callers pass only newly authored fields; moves pass none.
export function checkCaptureFields(fields, { only = ['trigger', 'evidence'] } = {}) {
  if (only.includes('trigger') && (!fields.trigger?.trim() || fields.trigger.trim() === '?')) {
    throw new Error('--trigger is required');
  }
  if (only.includes('evidence')) {
    if (!fields.evidence?.trim() || fields.evidence.trim() === '?') throw new Error('--evidence is required');
    const problem = evidenceProblem(fields.evidence);
    if (problem) throw new Error(problem);
  }
}

export function canonicalAnchorFile(anchor) {
  const file = anchorFile(anchor);
  if (!file) throw new Error('lesson refused: anchor needs a normalized repo-relative file path');
  const normalized = path.posix.normalize(file.replaceAll('\\', '/')).replace(/\/$/, '');
  const suggestion = path.isAbsolute(normalized) ? path.relative(REPO_ROOT, normalized).replaceAll('\\', '/') : normalized;
  if (file !== normalized || file.startsWith('./') || file.startsWith(':') || file.includes('\\') || path.isAbsolute(file) || /^[A-Za-z]:/.test(file)
    || file.split('/').some((part) => part === '.' || part === '..') || normalized.startsWith('../')) {
    throw new Error(`lesson refused: anchor path ${file} is not normalized repo-relative; use ${suggestion} if inside the repository`);
  }
  return file;
}

const defaultGit = (args) => execFileSync('git', args, {
  cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
  env: scrubbedGitEnv(),
});

const refTreesByGit = new WeakMap();
/** Refresh refs each query; reuse immutable tree contents by SHA across queries. */
function refTrees(git) {
  // Return ref names and tree IDs in stdout so ref count cannot grow argv.
  const refs = git(['for-each-ref', '--format=%(refname) %(tree) %(*tree)', 'refs/heads', 'refs/remotes/origin']).trim().split('\n').filter(Boolean).map((line) => line.split(' '));
  const names = ['HEAD', ...refs.map(([name]) => name)];
  // Annotated tags have no direct tree; use their peeled commit's tree instead.
  const ids = [git(['rev-parse', 'HEAD^{tree}']).trim(), ...refs.map(([, tree, peeledTree]) => tree || peeledTree)];
  if (ids.length !== names.length || ids.some((id) => !/^[0-9a-f]{40,64}$/.test(id))) {
    throw new Error('cannot resolve lesson anchor git ref trees');
  }
  if (!refTreesByGit.has(git)) refTreesByGit.set(git, new Map());
  return { names, ids: new Map(names.map((name, index) => [name, ids[index]])), paths: refTreesByGit.get(git) };
}

/** Git -z is mandatory: --name-only otherwise quotes non-ASCII names. */
function treeEntry(snapshot, tree) {
  if (!snapshot.paths.has(tree)) snapshot.paths.set(tree, { names: null, globMatches: new Map(), fileMatches: new Map() });
  return snapshot.paths.get(tree);
}

function treePaths(snapshot, tree, git) {
  const entry = treeEntry(snapshot, tree);
  if (!entry.names) entry.names = new Set(git(['ls-tree', '-z', '-r', '--name-only', tree]).split('\0').filter(Boolean));
  return entry;
}

const deletionRefsByGit = new WeakMap();
function eligibleAnchorRefs(file, snapshot, git) {
  // A glob spans many paths: deleting one member must not exclude holders of another.
  if (isGlobAnchor(file)) return snapshot.names;
  if (!deletionRefsByGit.has(git)) deletionRefsByGit.set(git, new Map());
  const cache = deletionRefsByGit.get(git);
  if (!cache.has(file)) {
    // Combined diffs catch merge-only deletions, not merges importing a side's deletion.
    const deletion = git(['--literal-pathspecs', 'log', '-1', '--cc', '--no-renames', '--diff-filter=D', '--format=%H', 'HEAD', '--', file]).trim().split('\n')[0];
    cache.set(file, deletion ? new Set(['HEAD', ...git([
      'for-each-ref', `--contains=${deletion}`, '--format=%(refname)', 'refs/heads', 'refs/remotes/origin',
    ]).trim().split('\n').filter(Boolean)]) : null);
  }
  const containing = cache.get(file);
  return containing ? snapshot.names.filter((ref) => containing.has(ref)) : snapshot.names;
}

export function anchorRefs(anchor, { git = defaultGit } = {}) {
  let file;
  try { file = canonicalAnchorFile(anchor); } catch { return []; }
  const glob = isGlobAnchor(file);
  const snapshot = refTrees(git);
  return eligibleAnchorRefs(file, snapshot, git).filter((ref) => {
    const entry = treePaths(snapshot, snapshot.ids.get(ref), git);
    if (!glob) return entry.names.has(file);
    if (!entry.globMatches.has(file)) entry.globMatches.set(file, [...entry.names].some((name) => matchGlob(file, name)));
    return entry.globMatches.get(file);
  });
}

export function anchorInRefs(anchor, { git = defaultGit } = {}) {
  let file;
  try { file = canonicalAnchorFile(anchor); } catch { return false; }
  const glob = isGlobAnchor(file);
  const snapshot = refTrees(git);
  for (const tree of new Set(eligibleAnchorRefs(file, snapshot, git).map((ref) => snapshot.ids.get(ref)))) {
    if (glob) {
      const entry = treePaths(snapshot, tree, git);
      if (!entry.globMatches.has(file)) entry.globMatches.set(file, [...entry.names].some((name) => matchGlob(file, name)));
      if (entry.globMatches.get(file)) return true;
    } else {
      const entry = treeEntry(snapshot, tree);
      if (entry.names) {
        if (entry.names.has(file)) return true;
      } else {
        if (!entry.fileMatches.has(file)) {
          // Exact literal pathspec and recursive names: directories do not count as files.
          entry.fileMatches.set(file, git(['ls-tree', '-z', '-r', '--name-only', tree, '--', `:(literal)${file}`]).split('\0').includes(file));
        }
        if (entry.fileMatches.get(file)) return true;
      }
    }
  }
  return false;
}

// The catchall floor does not choose a domain for an off-route proposal.
// Multiple matching explicit domains are ambiguous even when the resolver has a winner.
export function routedLessonDomain(anchor, proposed, map, mode = 'capture') {
  const file = canonicalAnchorFile(anchor);
  const domain = resolveDomain(file, map);
  if (!domain) throw new Error(`lesson refused: no route for ${anchor}; add a glob to the domain`);
  if (proposed === domain) return domain;
  // Moving a live lesson is never an implicit re-domain. This is the old move
  // contract; only a new capture may accept a correction to proposed links.
  if (mode === 'move') {
    if (!resolveExplicitDomain(file, map)) throw new Error(`lesson refused: anchor has no glob in ${proposed}; add one and regenerate the routing map, or file it under domain-platform-shell`);
    throw new Error(`lesson refused: anchor routes to ${domain}; use that domain instead of ${proposed}`);
  }
  if (mode !== 'capture') throw new Error(`unknown lesson domain mode: ${mode}`);
  const explicit = resolveExplicitDomain(file, map); // Same routing verdict as drain-inbox.
  const candidates = new Set(map.order.filter((route) => route.glob !== '**' && matchGlob(route.glob, file)).map((route) => route.domain));
  if (candidates.size === 1 && (!explicit || explicit !== domain || !candidates.has(explicit))) {
    throw new Error(`lesson refused: selected route ${domain} conflicts with sole explicit candidate ${[...candidates][0]} for ${anchor}; correct the routing map`);
  }
  if (!explicit || !candidates.size) throw new Error(`lesson refused: anchor has no glob in ${proposed}; add one and regenerate the routing map, or file it under domain-platform-shell`);
  if (candidates.size !== 1) throw new Error(`lesson refused: anchor has multiple candidate domains for ${anchor}; use a single explicit route`);
  return explicit;
}

export async function gateNewLesson({ title, body, links, long }, {
  routing = () => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs/agent/domain-routing.generated.json'), 'utf8')),
  exists = anchorInRefs,
  brevity = checkLesson,
  mode = 'capture',
} = {}) {
  const anchor = links?.anchor;
  const domain = routedLessonDomain(anchor, links.domain, routing(), mode);
  if (!exists(anchor)) throw new Error(`lesson refused: anchor ${anchor} exists in no HEAD, local branch or origin/* ref; correct the anchor or add its file`);
  const fields = lessonFields(title, body);
  if (mode === 'capture') {
    try { checkCaptureFields(fields); }
    catch (error) { throw new Error(`lesson refused: ${error.message}`); }
  }
  await brevity(fields, { long });
  // No Jev judgement of rule / usefulness / anchor fit: measured wrong in any phrasing
  // (adjudication of 58 flags, S6 precision 0.00-0.11; #12336). Usefulness is measured by
  // lessonsApplied and delivery statistics instead (decision #12333). No duplicate
  // judgement either (decision #12433): the weekly lesson-dedupe routine finds duplicates.
  // The marker tells memoryd this append came through this gate; the server
  // refuses a new lesson without it (store.mjs lessonGateProblem). It is an
  // accident guard against an agent using the wrong command, not authentication:
  // anyone holding the write token can forge it. Duplicate markers of the retired
  // check are dropped, so a caller cannot forge them onto a new lesson.
  const { possibleDuplicateOf: _oldDuplicates, duplicateCheck: _oldCheck, ...baseLinks } = links;
  return { ...baseLinks, domain, status: 'active', gate: { v: LESSON_GATE_VERSION, at: new Date().toISOString() } };
}

/**
 * Gate a live lesson moved onto new links (anchor or domain) before its supersede:
 * memoryd refuses a moved anchor without a fresh marker. Synchronous, through this
 * file's CLI, so the sync maintenance tools can call it. The body is unchanged, so
 * brevity is not re-judged; the lesson keeps its status. Throws the gate's reason.
 */
export function gateMovedLesson(row, links) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-move-gate-'));
  try {
    const titleFile = path.join(dir, 'title');
    const bodyFile = path.join(dir, 'body.md');
    fs.writeFileSync(titleFile, String(row.title), 'utf8');
    fs.writeFileSync(bodyFile, row.body ?? '', 'utf8');
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), titleFile, bodyFile, JSON.stringify(links), String(row.id)], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000,
    });
    if (result.status !== 0) {
      const reason = String(result.stderr || result.error?.message || 'capture gate failed').split('\n').filter((line) => line && !line.startsWith('{')).pop();
      throw new Error(reason || 'capture gate failed');
    }
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The CLI already runs lesson-quality.mjs before this pre-append gate, including
// its --long marker. The other callers use gateNewLesson's default brevity gate.
// A fourth argument is the id of a live lesson being moved (gateMovedLesson).
if (isMain(import.meta.url)) {
  try {
    const [titleFile, bodyFile, linksJson, movedId] = process.argv.slice(2);
    if (!titleFile || !bodyFile || !linksJson) throw new Error('lesson refused: capture gate needs title-file, body-file and links');
    const title = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(titleFile));
    const body = fs.readFileSync(bodyFile, 'utf8');
    const links = JSON.parse(linksJson);
    const gated = await gateNewLesson({ title, body, links }, { brevity: async () => {}, mode: movedId === undefined ? 'capture' : 'move' });
    console.log(JSON.stringify(movedId === undefined ? gated : { ...gated, status: links.status }));
    if (movedId === undefined && gated.domain !== links.domain) console.error(`domain ${links.domain} -> ${gated.domain}: routed for ${canonicalAnchorFile(links.anchor)}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
