#!/usr/bin/env node
// PreToolUse: deliver durable lessons once per edited file and routed knowledge
// once per domain per session (a lead's first Read in a domain also takes the page). Both marks reset after compaction through
// session-start.mjs; when neither has content, say nothing at all.
//
// Why a hook and not a rule. The contract has told every agent for weeks to run
// `memoryctl lessons --path <file>` before editing domain code, and the domain
// skills that carry the path map repeat it. Measured 2026-07-30: across all 50
// Svod run audits, ZERO agents ever loaded a domain skill - while the store held
// 20 active lessons for `svod/src/adapter/mod.rs` alone, none of which reached the
// agents editing it. Prose does not deliver; a hook does.
//
// Why it is the cheap option. Prose in the system prompt is paid by every turn
// of every session whether or not a lesson exists. This costs zero tokens while
// the store is empty (the hook prints nothing), and exactly the matching lessons
// when it is not — scoped to the ONE file being edited, delivered once, at the
// moment the knowledge is about to matter, within a single byte budget.
//
//   node domain-lessons-hook.mjs [claude|codex|glm|kimi|grok]
//
// Fail-open everywhere: unparsable event, no session id, path outside the repo,
// memoryctl missing, service down, slow, or non-JSON -> allow the edit. A
// failed query is not "no lessons": the lesson mark is written only after the
// store answers; page reads fail independently without blocking lessons.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The lesson router loads Jev and the page renderer its routing map, which cost
// more than the fast exits themselves; they are imported only once a delivery is due. Every lead Read
// runs this hook, and most Reads deliver nothing.
import { domainOf } from '../../scripts/lib/domain-of.mjs';
import { codeIntelMark, indexFor } from './code-intel-order-lib.mjs';
import { createHash } from 'node:crypto';
import { renameSync } from 'node:fs';

const allow = () => process.exit(0);
// stdout is written with writeSync: process.exit() right after an async
// process.stdout.write() truncates the JSON at the 64 KiB pipe buffer (measured
// 2026-09-14 with a 50-file apply_patch: markers written, answer cut mid-string).
const runtime = process.argv[2] ?? 'claude';
const denyDelivery = runtime === 'grok' || runtime === 'kimi';
// Environment that changes where `git rev-parse` stops looking; with any of it
// set only git itself can answer (declared here: main() runs before the helpers
// at the bottom of this file are initialised).
const GIT_DISCOVERY_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM'];

// The repository this hook belongs to, derived from the hook's own location
// rather than from the session's cwd: a worktree session edits files under its
// own root, and `memoryctl lessons` keys lessons by REPO-RELATIVE path.
const repoRoot = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/// Where one session's "already delivered" marks live, or '' when the event
/// names no session they can be kept for.
///
/// The one place this path is spelled: the hook marks here, and
/// session-start.mjs empties it when the host compacts the context.
export function deliveredMarksDir(sessionId) {
  const session = String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  // `.` and `..` pass the character filter and name the marks root itself or
  // the OS temp dir above it: a mark written there is litter, and a reset
  // would delete the temp dir.
  if (!session || session === '.' || session === '..') return '';
  return join(tmpdir(), 'toolset-domain-lessons', session);
}

/// Forget what this session was already given, so the next edit of each file
/// delivers its lessons again. For a context that no longer holds them.
export function forgetDeliveredLessons(sessionId) {
  const marks = deliveredMarksDir(sessionId);
  if (marks) rmSync(marks, { recursive: true, force: true });
}

async function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    allow();
  }

  const toolName = String(event.tool_name ?? event.toolName ?? '');
  // Lessons go to editors only: they are about what BREAKS when you change
  // something. A lead often READS a subsystem before its first edit, so Claude's
  // native Read carries the knowledge page and module, under their own marks.
  // Deny runtimes cannot take context on a read.
  const isRead = toolName === 'Read';
  if (isRead && denyDelivery) allow();
  if (!isRead && !/^(Edit|Write|MultiEdit|NotebookEdit|str_replace_editor|apply_patch|search_replace)$/i.test(toolName)) {
    allow();
  }

  const input = (event.tool_input ?? event.toolInput) ?? {};
  const isPatch = toolName.toLowerCase() === 'apply_patch';
  let filePaths;
  if (isPatch) {
    // Codex CLI 0.154.0 PreToolUse was measured with tool_input.command.
    // Other patch callers supply the text directly or under patch / input.
    const patch = typeof input === 'string' ? input : input.command ?? input.patch ?? input.input;
    if (typeof patch !== 'string') allow();
    filePaths = [...new Set([...patch.matchAll(/^\*\*\* (?:Update File|Add File|Delete File|Move to): ([^\r\n]+)\r?$/gm)]
      .map((match) => match[1]))];
    if (!filePaths.length) allow();
  } else {
    const filePath = String(input.file_path ?? input.path ?? input.notebook_path ?? '');
    if (!filePath) allow();
    filePaths = [filePath];
  }

  const stateDir = deliveredMarksDir(event.session_id ?? event.sessionId);
  if (!stateDir) allow();

  // code-intel-order-hook refuses a lead's native Read of a source file until a
  // code search has written its session mark. A refused Read's context reaches
  // nobody, so a page must not ride on it or spend its mark. Its mark counts
  // only if it predates this process: the sibling runs beside us on the SAME
  // call and writes the mark right after refusing it.
  let readRefused = false;
  if (isRead && indexFor(filePaths[0])) {
    try {
      readRefused = statSync(codeIntelMark(event.session_id ?? event.sessionId)).mtimeMs >= performance.timeOrigin;
    } catch {
      readRefused = true;
    }
  }

  // A patch's new file (or move target) may have no parent directory yet.
  // Resolve its repository from the event cwd, where apply_patch executes.
  const patchCwd = isPatch ? resolve(event.cwd ?? process.cwd()) : null;
  const patchRoot = isPatch ? worktreeRootOfDirectory(patchCwd) ?? repoRoot : null;
  const pending = [];
  // Orch seats already received routed pages in their initial brief. The
  // existing seat-launch environment marker is forwarded to native hooks.
  const knowledge = new Map();
  const modules = new Map();
  const indexes = new Map();
  const orchSeat = Boolean(process.env.ORCH_SEAT_ID);
  for (const filePath of filePaths) {
    // The directory as the filesystem names it: the worktree root below is
    // resolved, so a target reached through a symlinked alias must be too.
    const target = physicalPath(isPatch ? resolve(patchCwd, filePath) : resolve(filePath));
    const worktreeRoot = isPatch ? patchRoot : worktreeRootOfDirectory(dirOf(target)) ?? repoRoot;
    const relativePath = relative(worktreeRoot, target).split(sep).join('/');
    // Outside the tree, above it, or on another drive: not ours to advise on.
    //
    // `isAbsolute` is the case a `..` check alone misses, and it is not theoretical:
    // on Windows `path.relative` between two DIFFERENT DRIVES returns the target
    // unchanged, so `C:/Windows/win.ini` sailed past a startsWith('..') guard and was
    // sent to memoryctl as if it were a repository path. The real client answered
    // "no domain owns it" and hid the hole - the same shape of bug the round that
    // prompted this hook kept finding: a guard written against the spelling of a path
    // instead of against where the path actually is.
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) continue;

    // Resolve before the lesson/page early exits: even an already-paged Read
    // (including a seat's Read) can touch a module it has not received yet.
    if (!readRefused) {
      try {
        const registry = await import('../../scripts/module-registry.mjs');
        if (!indexes.has(worktreeRoot)) indexes.set(worktreeRoot, cachedModuleIndex(worktreeRoot, registry.moduleIndex));
        const module = registry.moduleForPath(worktreeRoot, relativePath, indexes.get(worktreeRoot));
        if (module && !modules.has(module.id)) {
          const mark = join(stateDir, 'modules', createHash('sha256').update(module.id).digest('hex'));
          if (!existsSync(mark)) modules.set(module.id, { ...module, root: worktreeRoot, mark });
        }
      } catch {
        // A contract or cache fault must never suppress lessons or the edit.
      }
    }

    // The page has its own once-per-domain mark; a failed page read must not
    // suppress lessons, and a failed lesson query must not suppress the page.
    if (!orchSeat && !readRefused) {
      try {
        const map = JSON.parse(readFileSync(join(worktreeRoot, 'docs/agent/domain-routing.generated.json'), 'utf8'));
        const domain = domainOf(relativePath, map);
        if (domain && /^domain-[a-z0-9-]+$/.test(domain) && !knowledge.has(domain)) {
          const mark = join(stateDir, 'knowledge', domain);
          if (!existsSync(mark)) {
            const { knowledgePageRel, readKnowledgePage } = await import('./knowledge-page-lib.mjs');
            const domainsRoot = join(worktreeRoot, '.agents', 'domains');
            const page = realpathSync(join(worktreeRoot, knowledgePageRel(domain)));
            const inside = relative(domainsRoot, page);
            if (inside && !inside.startsWith('..') && !isAbsolute(inside)) {
              const body = readKnowledgePage(domain, (path) => {
                const part = realpathSync(join(worktreeRoot, path));
                const inside = relative(domainsRoot, part);
                if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`Knowledge path outside domains: ${path}`);
                return readFileSync(part, 'utf8');
              });
              knowledge.set(domain, { domain, file: relativePath, map, body, mark });
            }
          }
        }
      } catch {
        // Unrouted, absent page, or unreadable page: lessons continue.
      }
    }

    // A read never queries lessons: an unpaged or already-paged file costs no
    // memoryctl spawn.
    if (isRead) continue;

    // Once per (session, file) until the context is compacted. Re-delivering the
    // same lessons on the second edit of the same file is pure cost: the agent
    // already has them in context.
    const mark = join(stateDir, relativePath.replace(/[^A-Za-z0-9._-]/g, '_'));
    if (existsSync(mark)) continue;

    const queried = lessonsFor(relativePath);
    // A failed store query must not mark the file: a later edit can retry.
    if (queried.ok) pending.push({ file: relativePath, mark, envelope: queried.envelope });
  }
  if (!pending.length && !knowledge.size && !modules.size) allow();
  const { LESSON_CONTEXT_BYTES, renderLessonContext } = await import('./lesson-router.mjs');
  const { routeKnowledgeSections } = await import('./knowledge-page-lib.mjs');

  // Bound the ENTIRE delivered context, not just each file's lesson bodies.
  // Keep the same task for every file in a patch; the Jev client redacts the
  // old/new text (or patch command) before it crosses the network boundary.
  const brief = `${pending.map(({ file }) => file).join('\n')}\n${typeof input === 'string' ? input : JSON.stringify(input)}`;
  const sources = pending.map(({ file, envelope }) => ({ file, envelope }));
  const { sections, prefix, hasLessons } = leadEditContext(pending, { denyDelivery });
  let lessons = '';
  let routed = null;
  if (hasLessons) {
    try {
      routed = await renderLessonContext({ sources, brief, role: 'lead', repoRoot,
        budget: LESSON_CONTEXT_BYTES - Buffer.byteLength(prefix), });
      lessons = routed.text;
    } catch {
      // A router error is not an empty store answer. Do not mark this edit.
      allow();
    }
  }
  if (denyDelivery && !hasLessons) {
    // Neither skills, pages nor modules alone may deny an edit on grok/kimi.
    sections.length = 0;
    modules.clear();
  }
  if (lessons) sections.push(`Durable lessons (memoryctl):\n${lessons}`);
  if (denyDelivery && lessons) sections.push('The lesson is now delivered; re-run the same edit.');
  if (Buffer.byteLength(sections.join('\n\n')) > LESSON_CONTEXT_BYTES) allow();

  // Budget lessons and skill hints FIRST; a page never shrinks the lesson
  // router's allowance. Deny runtimes cannot see additionalContext, so pages
  // ride only in an existing lesson deny, never create a new refusal.
  const deliveredKnowledge = [];
  if (!denyDelivery || hasLessons) for (const page of knowledge.values()) {
    try {
      // The deterministic file-map render, with the same per-page budget used for seat prompts.
      const routed = routeKnowledgeSections({ files: [page.file], map: page.map,
        pageFor: (domain) => domain === page.domain ? page.body : null });
      const section = routed.sections.find((text) => text.startsWith(`## Knowledge: ${page.domain}\n`));
      if (section && Buffer.byteLength([...sections, section].join('\n\n')) <= LESSON_CONTEXT_BYTES) {
        sections.splice(deliveredKnowledge.length, 0, section);
        deliveredKnowledge.push(page);
      }
    } catch {
      // A page router failure cannot stop the lesson delivery or the edit.
    }
  }
  // Modules come LAST and own at most 2 KiB inside the shared cap. They
  // never reduce the lesson/page allowance or trigger the drop-everything exit.
  const deliveredModules = [];
  let moduleBytes = 0;
  for (const module of modules.values()) {
    const room = Math.min(2048 - moduleBytes - (deliveredModules.length ? 2 : 0),
      LESSON_CONTEXT_BYTES - Buffer.byteLength(sections.join('\n\n')) - (sections.length ? 2 : 0));
    const pointer = `module ${module.id} (${module.owner}, ${module.layer}): read ${module.contract}`;
    if (Buffer.byteLength(pointer) > Math.min(room, 2048)) continue;
    try {
      let section = pointer;
      if (room >= 2048) {
        const { contractSummary } = await import('../../scripts/module-registry.mjs');
        section += `\n${contractSummary(module.root, module.contract, 2048 - Buffer.byteLength(pointer) - 1)}`;
      }
      sections.push(section);
      deliveredModules.push(module);
      moduleBytes += Buffer.byteLength(section) + (deliveredModules.length > 1 ? 2 : 0);
    } catch {
      // An unreadable contract remains unmarked and can retry on the next tool.
    }
  }
  for (const { file, mark } of pending) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(mark, file, denyDelivery ? { flag: 'wx' } : undefined);
    } catch {
      if (denyDelivery) allow();
      /* best effort for context-only runtimes */
    }
  }
  if (!sections.length) allow();
  for (const { mark, domain } of deliveredKnowledge) {
    try {
      mkdirSync(join(stateDir, 'knowledge'), { recursive: true });
      writeFileSync(mark, domain, { flag: 'wx' });
    } catch { /* best effort; the next edit may repeat the page */ }
  }
  for (const { mark, id } of deliveredModules) {
    try {
      mkdirSync(join(stateDir, 'modules'), { recursive: true });
      writeFileSync(mark, id, { flag: 'wx' });
    } catch { /* best effort; the next tool may repeat the module */ }
  }

  // Task 2684: report what was delivered so lesson statistics count leads too. Seats
  // are already recorded per turn (context.ts), so ORCH_SEAT_ID skips this entirely.
  // Fail-open: recording never changes this hook's answer (task 2684 slice B).
  if (!orchSeat) await reportLeadLessons(event.session_id ?? event.sessionId, pending, routed);

  if (denyDelivery && hasLessons) {
    writeSync(1, JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: sections.join('\n\n'),
      },
    }));
    // grok user-guide/10-hooks.md:324: exit 2 is explicit PreToolUse deny;
    // :269 names permissionDecisionReason. Kimi 0.43.0's bundled
    // externalHooks/internal/runHook.ts reads that field only at exit 0.
    process.exit(runtime === 'grok' ? 2 : 0);
  }

  writeSync(1, 
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: sections.join('\n\n'),
      },
    }),
  );
  process.exit(0);
}

// Run only when this file IS the program: session-start.mjs imports
// `forgetDeliveredLessons`, and a hook that ran on import would read the
// SessionStart event off that process's stdin and exit it before the digest.
//
// Compared as RESOLVED paths, not as URLs (lesson 3926): `import.meta.url` is
// already realpath-resolved by the loader while `process.argv[1]` is the path as
// invoked, so one symlinked component in the hook's command line would make the
// hook exit 0 having delivered nothing - silently, like a file with no lessons.
let isMainModule = false;
try {
  isMainModule = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
} catch {
  // An argv[1] that cannot be resolved is not this file.
  isMainModule = false;
}
if (isMainModule) main().catch(allow);

/// POST the lessons this hook just delivered for a lead session to orch, which
/// stores them in lead_lesson_deliveries (task 2684). One batch per edited file;
/// the mode is the one the router delivered each lesson in — a body that fit the
/// budget is 'full', an index row is 'indexed', and a lesson that fit neither
/// was not delivered and is not reported. Every failure is ignored, and the
/// 500 ms timeout keeps a stuck daemon from stalling the edit.
async function reportLeadLessons(sessionId, pending, routed) {
  if (!sessionId || !routed) return;
  const full = new Set(routed.selectedIds.map(String));
  const indexed = new Set(routed.indexedIds.map(String));
  const batches = [];
  for (const { file, envelope } of pending) {
    const lessons = envelope.items.flatMap((item) => {
      const id = Number.isSafeInteger(item?.id) && item.id > 0 ? String(item.id) : null;
      return id && full.has(id) ? [{ id, mode: 'full' }] : id && indexed.has(id) ? [{ id, mode: 'indexed' }] : [];
    });
    if (lessons.length) batches.push({ file, lessons });
  }
  if (!batches.length) return;
  try {
    const { loadConfig, HOST } = await import('../orchestrator/src/config.ts');
    const base = `http://${HOST}:${loadConfig().port}`;
    await Promise.all(batches.map((batch) => fetch(`${base}/lead-lessons`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: sessionId, ...batch }), signal: AbortSignal.timeout(500),
    })));
  } catch { /* fail-open: any error is ignored */ }
}

/// Run the memoryctl client, whatever shape it has on this platform.
///
/// On Windows the client is a BASH script plus a `.cmd` wrapper, and neither is
/// executable for `spawnSync` on its own: the bare name is ENOENT (no `.exe`),
/// and the `.cmd` is EINVAL (a batch file needs the interpreter). Measured while
/// writing this hook, which is exactly how a silent knowledge channel is born -
/// the failure looks identical to "no lessons for this path". So the Windows
/// route goes through `cmd.exe` explicitly, with arguments still passed as
/// arguments rather than through a shell string.
function runMemoryctl(args) {
  const options = { encoding: 'utf8', timeout: 8000 };
  if (process.platform === 'win32') {
    return spawnSync('cmd.exe', ['/d', '/s', '/c', 'memoryctl.cmd', ...args], options);
  }
  return spawnSync('memoryctl', args, options);
}

/// A path with its directory resolved through symlinks. A directory that does
/// not exist yet keeps its missing tail below the nearest existing ancestor.
/// The last component is kept as spelled: a symlinked FILE is edited under its
/// own name, as git sees it.
function physicalPath(target) {
  let existing = dirname(target);
  const tail = [basename(target)];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return target;
    tail.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...tail);
  } catch {
    return target;
  }
}

/// The git worktree that contains `directory`, so a path inside any checkout of
/// this repository resolves to the same repo-relative key.
///
/// The common shapes answer without a process: the nearest `.git` that is a
/// directory holding HEAD (a main checkout), or a `gitdir:` file of at most
/// 1 KiB whose target exists (a linked worktree or submodule), owned by this
/// user, below any filesystem boundary. That agrees with `rev-parse
/// --show-toplevel` for those shapes; it does not validate the repository the
/// way git does. Anything else - a missing directory, which git refuses,
/// discovery overrides in the environment, a `.git` of another shape, another
/// owner (git's safe.directory check) - asks git. A filesystem boundary with no
/// `.git` below it is "not a repository", as git's own discovery answers.
function worktreeRootOfDirectory(directory) {
  if (!GIT_DISCOVERY_ENV.some((name) => process.env[name] !== undefined) && existsSync(directory)) {
    const found = nearestGitRoot(directory);
    if (found !== undefined) return found;
  }
  const probe = spawnSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 4000,
  });
  if (probe.status !== 0) return null;
  const top = String(probe.stdout ?? '').trim();
  return top ? resolve(top) : null;
}

/// The root found by walking up to `.git`, null when there is none up to the
/// filesystem root, or undefined when git must decide.
function nearestGitRoot(directory) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let device = null;
  for (let dir = resolve(directory); ; dir = dirname(dir)) {
    let here;
    try { here = statSync(dir); } catch { return undefined; }
    if (device === null) device = here.dev;
    // git stops discovery at a filesystem boundary and answers "not a
    // repository"; GIT_DISCOVERY_ACROSS_FILESYSTEM already sent us to git.
    if (here.dev !== device) return null;
    const dotGit = join(dir, '.git');
    let stat = null;
    try { stat = statSync(dotGit); } catch { /* not here; go up */ }
    if (stat) {
      if (uid !== null && (stat.uid !== uid || here.uid !== uid)) return undefined;
      if (stat.isDirectory()) return existsSync(join(dotGit, 'HEAD')) ? realpathSync(dir) : undefined;
      if (!stat.isFile()) return undefined;
      let pointer;
      try { pointer = /^gitdir: (.+?)\r?\n?$/.exec(readHead(dotGit, 1024)); } catch { return undefined; }
      // The target must itself be a git dir (holds HEAD), else git refuses; defer to it.
      return pointer && existsSync(join(resolve(dir, pointer[1]), 'HEAD')) ? realpathSync(dir) : undefined;
    }
    if (dirname(dir) === dir) return null;
  }
}

/// At most `limit` bytes of a file as text: a `.git` pointer is one line.
function readHead(path, limit) {
  const buffer = Buffer.alloc(limit);
  const fd = openSync(path, 'r');
  try {
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, limit, 0));
  } finally {
    closeSync(fd);
  }
}

// Read Git's small metadata files rather than spawning rev-parse on every Read.
// Linked worktrees keep HEAD/index in gitdir and shared refs in commondir.
function moduleCacheKey(root) {
  const dotGit = join(root, '.git');
  const gitDir = statSync(dotGit).isDirectory() ? dotGit
    : resolve(root, /^gitdir: (.+?)\r?\n?$/.exec(readHead(dotGit, 1024))[1]);
  const commonFile = join(gitDir, 'commondir');
  const common = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir;
  let head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  const seen = new Set();
  while (head.startsWith('ref: ')) {
    const ref = head.slice(5);
    if (seen.has(ref)) throw new Error('Cyclic Git HEAD reference');
    seen.add(ref);
    const loose = [join(gitDir, ref), join(common, ref)].find(existsSync);
    if (loose) head = readFileSync(loose, 'utf8').trim();
    else {
      const packed = join(common, 'packed-refs');
      const row = existsSync(packed) && readFileSync(packed, 'utf8').split(/\r?\n/)
        .find((line) => line.split(' ')[1] === ref);
      head = row ? row.split(' ')[0] : `unborn:${ref}`;
    }
  }
  let indexMtime = null;
  try { indexMtime = statSync(join(gitDir, 'index')).mtimeMs; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return JSON.stringify([head, indexMtime]);
}

function cachedModuleIndex(root, buildIndex) {
  const key = moduleCacheKey(root);
  const dir = join(tmpdir(), 'toolset-domain-lessons', 'module-index');
  const file = join(dir, `${createHash('sha256').update(root).digest('hex')}.json`);
  try {
    const age = Date.now() - statSync(file).mtimeMs;
    if (age >= 0 && age < 10 * 60_000) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.version === 1 && saved.root === root && saved.key === key && Array.isArray(saved.index)) return saved.index;
    }
  } catch { /* Missing, expired or damaged: rebuild from the contract headers. */ }
  const index = buildIndex(root);
  const temporary = `${file}.${process.pid}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temporary, JSON.stringify({ version: 1, root, key, index }), { mode: 0o600 });
    renameSync(temporary, file);
  } catch { /* A read-only temp dir must not prevent the current delivery. */ }
  finally { try { rmSync(temporary, { force: true }); } catch { /* best effort */ } }
  return index;
}

function dirOf(target) {
  const cut = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  return cut > 0 ? target.slice(0, cut) : target;
}

/// The active lessons for one repo-relative path.
///
/// `ok: false` is a failed query (missing client, non-zero, unparseable) and
/// must not be marked as delivered. An empty envelope IS marked, so a file
/// with no lessons is not re-queried on every edit.
///
/// `memoryctl lessons` is the one delivery route the contract names, so the hook
/// calls it rather than reading the store: routing, domain resolution and the
/// active/retired distinction all live there and must not be reimplemented here.
function lessonsFor(relativePath) {
  const query = runMemoryctl(['lessons', '--path', relativePath, '--json']);
  if (!query || query.status !== 0) return { ok: false };
  let envelope;
  try {
    envelope = JSON.parse(String(query.stdout ?? ''));
  } catch {
    return { ok: false };
  }
  if (!envelope || !Array.isArray(envelope.items)) return { ok: false };
  // The store owns domain resolution; the hook only filters its answer.
  // An edit gets the lessons about ITS file - an anchor or a class rule - and
  // never the NEAREST by directory. Measured over 30 days (memory #8154): 1,123
  // of 1,479 deliveries were neighbours, each a few KB of rules about another
  // file dropped beside the edit; operator decision #8157 took them out. The
  // store still offers neighbours to an explicit `memoryctl lessons --path`.
  const items = envelope.items.filter((item) => item?.match !== 'nearby'
    && !/^(RETIRED|MERGED-INTO)\b/.test(String(item?.title ?? '')))
    // memoryctl calls a matched path-glob 'class'; the router calls it 'glob'.
    .map((item) => item.match === 'class' && /[*?]/.test(String(item.anchor ?? ''))
      ? { ...item, match: 'glob' } : item);
  return { ok: true, envelope: { ...envelope, items, nearby: 0 } };
}

/// The SKILLS this file's domain implies, named to the LEAD.
///
/// Operator instruction 2026-08-08: skill delivery is not an orchestrator-only
/// concern. A reviewing member was handed a domain-specific method;
/// the lead EDITING the same file got this file's lessons and nothing about the
/// method, because the map lived in Rust and only ran while a preset was being
/// built.
///
/// Read from `ops/bootstrap/domain-skills.json`, the shared canon file for this
/// mapping. Named, not loaded: the agent decides whether the edit warrants it,
/// and a skill silently prepended to every edit is the cost this hook already
/// refuses to pay for lessons.
/** The lead Edit prefix, including domain skill hints. The delivery gate imports
 *  this so its budget is the hook's budget, not a copy of the text. */
export function leadEditContext(pending, { denyDelivery = false, skillsFor = domainSkillsFor } = {}) {
  const hasLessons = pending.some(({ envelope }) => envelope?.items?.length || envelope?.omitted > 0);
  const sections = [];
  let hidden = 0;
  for (const { file, envelope } of pending) {
    const part = `What is already known about ${file} (delivered once this session):`;
    const skills = skillsFor(envelope?.domain);
    if (!hasLessons && !skills) continue;
    const candidate = [part, skills].filter(Boolean).join('\n\n');
    if (Buffer.byteLength([...sections, candidate].join('\n\n')) <= 1024) sections.push(candidate);
    else hidden++;
  }
  if (hidden) sections.push(`${hidden} more edited file(s); use memoryctl lessons --path <file> for details.`);
  const prefix = sections.join('\n\n') + '\n\nDurable lessons (memoryctl):\n'
    + (denyDelivery ? '\n\nThe lesson is now delivered; re-run the same edit.' : '');
  return { sections, prefix, hasLessons };
}


function domainSkillsFor(answeredDomain) {
  if (!answeredDomain) return '';
  let map;
  try {
    map = JSON.parse(readFileSync(join(repoRoot, 'ops', 'bootstrap', 'domain-skills.json'), 'utf8'));
  } catch {
    return '';
  }
  const skills = map?.domains?.[answeredDomain]?.skills;
  if (!Array.isArray(skills) || skills.length === 0) return '';
  return `The method for ${answeredDomain} — load what this edit warrants (Skill tool):\n`
    + skills.map((skill) => `- ${skill}`).join('\n');
}
