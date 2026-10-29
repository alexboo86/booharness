// Loopback HTTP surface includes health, dashboard, MCP and seat endpoints; the separate LAN surface serves the dashboard only.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from './config.ts';
import { board, DASHBOARD_HTML } from './dashboard.ts';
import { formatDigest } from './digest-text.ts';
import { applyMemory, confirmLessonDuplicate } from './memory-proposals.ts';
import { handoffDraft } from './handoff-draft.ts';
import type { Logger } from './log.ts';
import { span, type LoopDelay } from './shared.entry.ts';
import { NO_FILES_WARNING, type Choose, type SeatManager } from './seats.ts';
import { hasWorktree, landable, roleHint, pickRole, wordCount, BRIEF_WORDS, WIDE_BRIEF_P, AUTO_ROLE_TEST0, AUTO_ROLE_UNJUDGED, type ScopeDecision, type SeatData } from './seats-defs.ts';
import { jevText } from './watch.ts';
import { repoOf } from './worktrees.ts';
import { drainWarning, TERMINAL_TURN, type Seat, type Store, type ScopeFeatures } from './store.ts';
import type { Limits } from './limits.ts';
import type { Family } from './providers/types.ts';
import { activeLeads, windowSeatSessions } from './leads.ts';
import { land } from './land.ts';
import { hostRuntimeStates } from './remote-repo.ts';
import { assertCheckHolder, prepareCheckOn, snapshotForCheck } from './check-on.ts';
import { ALL_ON, seatInstruments } from './shared.entry.ts';
import { missingHostInstruments, seatHost, touchesMacDesktop } from './placement.ts';
import { machineLoads } from './machine-load.ts';
import { STAND_ARMS } from './stand.ts';
import { reviewPlan } from './review-plan.ts';
import { ScoutGate } from './scout-request.ts';
import { SCOUT_TOOL, SEAT_MCP_PATH, SEAT_SCOUT_PATH } from './shared.entry.ts';
import { chatJoin, chatRelease, chatList, chatPost, chatAddressees, chatPostOperator, chatPostCommitMiss, chatPostDocsNote, chatLiveHandle, chatRead, chatPending, chatWakePending, chatDelivered, chatConfirmed, type ChatAddress } from './chat.ts';
import { createTasksRoutes } from './tasks-routes.ts';
import { steSummary, type LanguageSummary } from './ste.ts';
import { readLanguageMode } from './shared.entry.ts';

/** The absolute `node … wait <turn>` command a lead runs in the background. */
const WAIT_COMMAND = `node ${JSON.stringify(fileURLToPath(new URL('./main.ts', import.meta.url)))} wait`;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** One trust boundary for both MCP file lists: reject absolute/escaping paths before using them for routing. */
export function parseTaskFiles(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('files must be an array of repo-relative paths');
  if (value.length > 200) throw new Error('files may contain at most 200 paths');
  return value.map((file: unknown) => {
    if (typeof file !== 'string' || !file.trim() || file.length > 512) throw new Error('files must be repo-relative paths of at most 512 characters');
    const normalized = file.replaceAll('\\', '/');
    if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || file.startsWith('\\') || /^[A-Za-z]:/.test(file) || normalized.split('/').includes('..')) {
      throw new Error('files must be an array of repo-relative paths');
    }
    return normalized;
  });
}

/** `code` is the fingerprint of the code this daemon started with (ops/orchestrator/code-hash.mjs). */
export type Runtime = { store: Store; seats: SeatManager; log: Logger; loop?: LoopDelay; startedAt: number; stateDir: string; port: () => number; code: string; limits: Limits; configHealth?: import('./config-health.ts').ConfigHealth };

/** The hostname of a Host header value, without its port. */
function hostOf(value: string): string {
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':')[0];
}

/**
 * DNS-rebinding guard. A browser page on evil.example resolved to 127.0.0.1
 * still sends `Host: evil.example` and its own Origin, so both are checked.
 * A missing Host is refused (HTTP/1.1 requires it); a missing Origin is a
 * non-browser client and allowed.
 */
export function rejectReason(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (!host || !LOOPBACK.has(hostOf(host).toLowerCase())) return `host '${host ?? ''}' is not loopback`;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let hostname: string;
    try {
      hostname = new URL(origin).hostname.toLowerCase();
    } catch {
      return `origin '${origin}' is not a URL`;
    }
    if (!LOOPBACK.has(hostname)) return `origin '${origin}' is not loopback`;
  }
  return null;
}

/** A load row as the lead reads it: `readings` repeat `windows` for the dashboard, and the lead's context is the dearest line. */
function lean({ readings: _readings, ...row }: ReturnType<Limits['load']>) {
  return row;
}

/** Project the stored seat for the lead; the board and store retain the full record. */
function leanSeat(seat: Seat, warning?: string | null) {
  const data = seat.data;
  return {
    // `title` is what tells two seats of one role apart for the lead (review 2026-09-23).
    id: seat.id, role: seat.role, family: seat.family, title: seat.title,
    model: data.model ?? null, effort: data.effort ?? null,
    status: seat.status, host: seatHost(data), picked: data.picked ?? null,
    // Where the seat runs and why (decision #12522); seats created before it carry none.
    ...(data.placement ? { placement: data.placement } : {}),
    // The instruments the seat effectively runs with (task 1452): the A/B row records this.
    instruments: seatInstruments(data),
    ...(warning ? { warning } : {}),
    ...(hasWorktree(seat.role)
      ? { worktree: seat.worktree, branch: data.branch ?? null, base: data.base ?? null }
      : {}),
    ...(typeof data.failure === 'string' ? { failure: data.failure } : {}),
  };
}

/** Specialist-role hints not yet shown on this seat, persisted once on seat data (task 2953). */
function roleHintWarning(store: Store, seat: Seat, files: readonly string[], scope: ScopeFeatures | null): { seat: Seat; text: string } {
  const shown = Array.isArray(seat.data.roleHints) ? seat.data.roleHints as string[] : [];
  const fresh = roleHint(files, scope).filter((hint) => !shown.includes(hint.kind));
  if (!fresh.length) return { seat, text: '' };
  const updated = store.updateSeat(seat.id, { data: { roleHints: [...shown, ...fresh.map((hint) => hint.kind)] } }, 'seat.role_hint', { kinds: fresh.map((hint) => hint.kind) });
  return { seat: updated, text: fresh.map((hint) => hint.text).join(' ') };
}

/** Closed seats per seats_list page when the caller names no limit. */
const CLOSED_PAGE = 50;

/** A closed seat as history: enough to find it and read its last report (`main.ts wait <turn>`). */
function closedSeat(seat: Seat, store: Store) {
  const last = store.listTurns(seat.id).at(-1);
  return {
    id: seat.id, role: seat.role, family: seat.family, title: seat.title, status: seat.status, host: seatHost(seat.data),
    turn: last?.id ?? null, turnStatus: last?.status ?? null, ended: last?.ended_at ?? seat.updated_at,
    ...(seat.data.placement ? { placement: seat.data.placement } : {}),
    ...(typeof seat.data.failure === 'string' ? { failure: seat.data.failure } : {}),
  };
}

/**
 * The lead families an automatic pick steps aside from (decision #17805 D2): the creating lead's
 * own family when `session` resolves to an active lead, else every lead active in the last
 * 10 minutes (today's behaviour, named in `picked` so a lead knows to pass `session`).
 */
async function leadAside(store: Store, home: string, session?: string): Promise<{ leadFamily: Family | null; families: Family[]; note: string | null }> {
  try {
    // Fresh scan, not the board cache: a miss of `session` steps every active family aside.
    const rows = await activeLeads({ minutes: 10, home, seatSessions: windowSeatSessions(store, Date.now(), 10) });
    if (session !== undefined) {
      const own = rows.find((lead) => lead.session === session);
      if (own) return { leadFamily: own.family as Family, families: [own.family as Family], note: null };
    }
    const families = [...new Set(rows.map((lead) => lead.family as Family))];
    return {
      leadFamily: null,
      families,
      note: families.length ? `the lead step-aside covers every active lead family (${families.join(', ')}) because ${session === undefined ? 'seat_create got no session' : `session '${session}' is not an active lead`} (decision #17805 D2: pass your session id)` : null,
    };
  } catch {
    return { leadFamily: null, families: [], note: null };
  }
}

function health(rt: Runtime) {
  const hosts = hostRuntimeStates();
  // Reuse the board's non-blocking combined load/tool probe and its timestamp.
  // Unknown/down is explicit, never an empty missing list that would imply all tools exist.
  const hostInstruments = machineLoads(rt.stateDir).filter((row) => row.name !== 'mac' && row.name !== 'hosts.json').map((row) => ({
    host: row.name, at: row.at,
    instruments: row.load?.ok === true ? row.load.instruments ?? null : null,
    missing: row.load?.ok === true ? missingHostInstruments(row.load, ALL_ON) : null,
    ...(row.load?.ok === false ? { error: row.load.error } : {}),
  }));
  return {
    version: VERSION,
    pid: process.pid,
    uptime: Math.round((Date.now() - rt.startedAt) / 1000),
    loop: rt.loop?.snapshot() ?? null,
    schema: rt.store.schemaVersion(),
    code: rt.code,
    configError: rt.configHealth?.snapshot().configError ?? null,
    frozenProjectKeys: rt.configHealth?.snapshot().frozenProjectKeys ?? [],
    // The tree this daemon loads: `restart` checks the suite record against it.
    checkout: path.resolve(fileURLToPath(new URL('../../..', import.meta.url))),
    busy: rt.store.activeTurns(),
    draining: rt.store.drainStatus(),
    // Each registered host's runtime checkout against this daemon's commit (task 1784).
    ...(hosts.length ? { hostRuntimes: hosts } : {}),
    ...(hostInstruments.length ? { hostInstruments } : {}),
  };
}

const TOOLS = [
  {
    name: 'chat_join',
    description: 'Bind your lead-chat handle to a session, superseding its previous live binding; optional desktop is get_session "self" field sessionId (at most 80 characters, no whitespace), and rejoining updates only desktop. Use the session id SessionStart prints; no acknowledgement post is wanted.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        session: { type: 'string' },
        desktop: { type: 'string', minLength: 1, maxLength: 80, pattern: '^\\S+$' },
      },
      required: ['handle', 'session'],
      additionalProperties: false,
    },
  },
  {
    name: 'chat_post',
    description: 'Post under your live handle to named handles or all, or omit to for a log line; refuses any never-bound named handle and lists live handles, while known handles with no live binding are accepted and returned in `notLive` only when non-empty; a post reaches its addressee at that lead\'s next own turn, and only `wake` wakes an idle lead: set it when the addressee must act now and the sender cannot continue without that act; pass `class: \'fyi\'` to mark a post that must not wake an idle lead, even in reply to a wake post; your first post back to a lead whose wake post reached you in the last 24 h counts as a wake and names that post in `replyWake`; a wake reply lists live addressees with state (watcher, in turn, no watcher), lastSeen and desktop. Use the session id SessionStart prints; no acknowledgement post is wanted.',
    inputSchema: {
      type: 'object',
      properties: {
        as: { type: 'string' },
        session: { type: 'string' },
        body: { type: 'string', minLength: 1, maxLength: 600 },
        to: { anyOf: [{ type: 'string', const: 'all' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
        wake: { type: 'boolean' },
        class: { type: 'string', enum: ['fyi'] },
      },
      required: ['as', 'session', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'chat_read',
    description: 'Read and confirm unread posts for your live handle, or pass all for a read-only log (limit defaults to 50, maximum 200). Use the session id SessionStart prints; no acknowledgement post is wanted.',
    inputSchema: {
      type: 'object',
      properties: {
        as: { type: 'string' },
        session: { type: 'string' },
        all: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['as', 'session'],
      additionalProperties: false,
    },
  },
  {
    name: 'orch_status',
    description: 'orch daemon status: version, pid, uptime, schema version, state dir, port, seat counts by status, each family\'s subscription load (least loaded first, with the reading\'s age), and each registered host\'s runtime checkout against the daemon\'s commit (a host with error is refused or unreachable: its tracked changes are never discarded). Check it before choosing a family.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'seats_list',
    description: 'List seats known to orch. Open seats: every one, oldest first, full row. Omits closed seats unless `closed` is true or `status` is `closed`; closed seats come newest first, `limit` per page (default 50), in a compact row (id, role, family, title, status, last turn id and status, ended, failure) with `closedPage` naming the omitted count and the next `offset`. Optional exact status filter. `seat` returns that one seat in full whatever its status.',
    inputSchema: {
      type: 'object',
      properties: {
        seat: { type: 'string', description: 'Exactly this seat id, in the full row whatever its status, no paging; [] when unknown. Not combined with the other arguments.' },
        status: { type: 'string', description: 'Only seats with this status. The value closed returns closed seats even when the closed flag is omitted.' },
        closed: { type: 'boolean', description: 'Include closed seats. Default false. An exact `status` still applies.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: `Closed seats per page, newest first. Default ${CLOSED_PAGE}. Open seats are never limited.` },
        offset: { type: 'integer', minimum: 0, description: 'Closed seats to skip, newest first: pass the previous answer\'s closedPage.nextOffset. Default 0.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'seat_create',
    description:
      'Create a worker seat. coder: own worktree on branch orch/<seat> from `base` (kept after close for you to land); tester: own branch worktree, same landing as a coder, outside the coder cap and without coder rechecks; designer: own branch worktree like a coder that may only write src/**/*.tsx, src/**/*.css and web/apps/**, on this Mac or a host with the Bright Data key, reading images by default; copywriter: own branch worktree that may only write web/apps/** and src/locales/**, on this Mac or a host with the Bright Data key; motion: own branch worktree like a coder that may only write web/apps/landing/public/media/** and web/apps/landing/_drafts/motion/**, on this Mac only (the Higgsfield session and ffmpeg-full exist only here), reading images by default; legal: disposable detached worktree with reviewer rights (`base` or `snapshot`, author and coauthors step aside, nothing lands), on this Mac or a host with the Bright Data key; security: disposable detached worktree with reviewer rights, max effort where the route supports it (kimi, mimo: high); reviewer: disposable detached worktree at `base` or a `snapshot`, reviewing the ACCUMULATED diff once per task, at most 2 per task (same title), a recheck is a turn of one of them (a closed reviewer without a valid report does not count, nor one a recheck superseded, whose family stays out); bughunter: hunts reproduced defects in existing code at max effort (kimi: high), disposable worktree; scout/researcher: read the repo in place and answer ONE question; a scout reports facts only, never a design or a how-to (#17974). debater: read the repo in place, answer one question, then one rebuttal of the other side\'s done first turn (`seat_prompt` `rebut`); give the two debaters of a fork ONE title, and orch keeps them on different models. ' +
      'Leave `family` out: orch picks a family at or behind pace first, by need, then by pace headroom on the longest readable budget window; shorter windows throttle, equal-length model-scoped windows throttle only matching models, calibrated burn may veto, and unreadable usage ranks last. Paused families are excluded even from the emergency choice, and explicit requests for them are refused. Your own family (except for a coder seat or an eligible claude reviewer/plan critic), the author\'s and every coauthor\'s step aside. For a multi-slice task reviewed once, pass `author` and `coauthors` naming the other coder seats whose change is in the diff (reviewer or plan critic). The one reviewer exception is claude, which may review a named non-claude author only when every coauthor is also non-claude, even when claude is your family. Without `author`, or with a claude author or coauthor, claude never reviews, even when named explicitly. A claude plan critic may omit `author` and may share your family, but is excluded when any named author or coauthor is claude, even when named explicitly (#13875). Model and effort come from the role matrix. A family outside the role\'s matrix is refused. ' +
      'With `host`, Pi seats may run remotely: orch prepares a checkout on that host, refusing a SHA/tree mismatch; researcher, designer, copywriter and legal require the brightdata-web capability (BRIGHTDATA_API_KEY in the host environment or its prefixed secrets file); this Mac always offers it. Claude, motion, native harnesses and stand arms stay on this Mac. Local editing worktrees are provisioned like Paseo ones (npm ci, codegraph index, skills), so the seat is `provisioning` while setup runs; a prompt given meanwhile waits for it. Harness defaults to Pi for every family except claude, which runs native Claude Code (decision #11849: Pi\'s anthropic route bills the Max OAuth as extra usage); pass native for any family\'s own CLI, pi to opt claude into Pi explicitly. The answer carries `picked` (why this family), the seat\'s effective `instruments`, and, when load is high, a `warning`. A plan critic is `role: \'critic\'`. The `critic` flag is an alias kept for one release: `role: \'scout\'` with `critic: true` makes the same seat. ' +
      'Pass `images: true` when the seat must read images: each family whose model for this seat has no image input leaves the field before the pick, and neither the emergency choice nor the coder cap brings that family back. A role whose default skill requires image input is treated as `images: true` even when the flag is omitted. The effective value is stored on the seat; a `request_id` retry with a different value is refused. ' +
      'A debater round table (operator #19423) passes `options` (2-4 strings): every open debater of the same title must carry the identical list, and orch stores the lead-chat handle your `session` holds so the table\'s one tally post reaches you. Omit `options` for the classic two-side fork, which behaves exactly as before. A coder created with `files` also gets a non-blocking `warning` when every file is a test, fixture or capture (a tester seat fits) or any file is under src/locales/ (a copywriter seat fits). ' +
      'role \'auto\' (pass `brief` and non-empty `files`): orch picks the role itself — tester when every file is a test, fixture or capture, or when Jev reads a tests-only brief or a reported defect (a defect brief gains the Test 0 line: the tester writes the red test first, then a coder fixes it), else coder — creates exactly that one seat and queues the brief as its first turn. The answer adds `turn`, `wait` and `picked` {role, rule, jev: {wide, defect, tests_only, look, logic}, next}. Jev unavailable or a brief its gate would cut refuses with no seat created; a wide reading above 0.85 refuses like the coder scope gate and `wide_brief` bypasses it. After an orch restart your MCP client must reconnect before role \'auto\' reaches its cached copy of this schema.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['coder', 'tester', 'designer', 'copywriter', 'motion', 'reviewer', 'legal', 'security', 'bughunter', 'scout', 'critic', 'researcher', 'debater', 'auto'] },
        brief: { type: 'string', description: "role 'auto' only: the brief orch reads to pick tester or coder; it is queued as the seat's first turn and the seat_prompt 300-word rule applies." },
        wide_brief: { type: 'string', description: "role 'auto' only: why the work cannot be split when Jev reads the brief wider than 0.85; the same bypass as seat_prompt. At most 300 characters after trimming." },
        session: { type: 'string', description: 'Your hook session id, the same one the chat tools take. The own-family step-aside then covers only your family, and orch stores it on the seat so its own recheck reviewer steps aside from your family too (decision #17805 D2). Without it, or when it does not resolve, every lead active in the last 10 minutes steps aside and `picked` says so.' },
        family: { type: 'string', enum: ['claude', 'glm', 'codex', 'grok', 'kimi', 'opencode', 'qwen', 'mimo'], description: 'Omit to pick a family at or behind pace first, by need, then by pace headroom, among unpaused families; a paused explicit family is refused.' },
        author: { type: 'string', description: 'reviewer/plan critic: the primary coder seat whose change this reviews; its family never reviews it. Claude reviewers require a named non-claude author and only non-claude coauthors. Claude plan critics may omit author, but every named author/coauthor must be non-claude; both may share a claude lead family.' },
        coauthors: { type: 'array', items: { type: 'string' }, uniqueItems: true, maxItems: 20, description: 'reviewer/plan critic: for a multi-slice task reviewed once, the other existing coder seats whose change is in the diff. Requires author; each family is excluded, even when family is named explicitly.' },
        title: { type: 'string', description: 'What the seat is for, one line.' },
        repo: { type: 'string', description: 'Absolute path of your checkout; the seat works in this repository.' },
        base: { type: 'string', description: 'Commit or ref for a coder/bughunter worktree (default HEAD of `repo`); a reviewer needs it or `snapshot`.' },
        snapshot: { type: 'boolean', description: 'coder/reviewer: check out your working tree as it is now, uncommitted and untracked files included, as one commit on top of HEAD; the change is `git diff HEAD^` in the seat. Use it to review work you have not committed. Exclusive with base.' },
        harness: { type: 'string', enum: ['pi', 'native'] },
        host: { type: 'string', description: 'Named remote host for a Pi seat; researcher, designer, copywriter and legal require brightdata-web (the host holds BRIGHTDATA_API_KEY). Claude, motion, native harness and standArm cannot use a remote host.' },
        needs: { type: 'string', enum: ['mac', 'win', 'any'], description: 'Platform need: omitted defaults to any (decision #12591), probing this Mac and registered hosts and choosing the highest free capacity (free cores and free memory) for Pi seats of every role when hosts exist; with no registered hosts it stays on this Mac without probing, and if all probes fail it falls back to this Mac. mac pins this Mac without probing; win requires a win32 host. Claude, motion, native harness and standArm seats stay on this Mac when needs is omitted; explicit non-mac needs with native harness, standArm or motion are refused. Researcher, designer, copywriter and legal may use hosts offering brightdata-web (BRIGHTDATA_API_KEY); this Mac always offers it. No eligible target refuses creation. Explicit host chooses the machine instead of default placement. The seat row carries placement {needs, target, reason}.' },
        needs_reason: { type: 'string', maxLength: 300, description: 'Required with needs mac unless a file is this Mac\'s desktop runtime or the seat is claude, native or a stand arm (task 3288): what on this Mac the seat must touch (the Tauri runtime, state under ~/.local/state, a loopback service, Mac-only credentials, uncommitted files read in place). Stored in the placement reason. Refused without needs mac.' },
        files: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 512 }, description: 'Repo-relative paths the task is about, used to apply configured placement rules. Omit if not known at creation.' },
        model: { type: 'string' },
        effort: { type: 'string' },
        request_id: { type: 'string', description: 'Idempotency key: a retry of a create whose answer was lost (client timeout) passes the same request_id and gets the existing seat back instead of a duplicate.' },
        standArm: { type: 'string', enum: [...STAND_ARMS], description: 'A/B stand only: explicit isolated Pi profile. Omit for a stock seat; never pass a config path.' },
        critic: { type: 'boolean', description: '`role: \'critic\'` is a plan critic; this flag is an alias kept for one release (`role: \'scout\'` with `critic: true` makes the same seat) (#13286, #13875) — the scout lifecycle (one question, no worktree) on the whole reviewer matrix: its family pool, model and high effort. The plan author\'s seat may be named in `author`; its family and every coauthor\'s never take the seat. Your own family steps aside even when named explicitly, except claude may take the seat when no named author or coauthor is claude. `model`, `effort`, an explicit native harness and a family outside the reviewer matrix are refused; omitted harness runs claude natively with the matrix model.' },
        images: { type: 'boolean', description: 'True when this seat must read images. Each family whose model for this seat has no image input leaves the field before the pick, including the emergency choice and the coder cap. Omitted is false, except a role whose default skill requires image input, which is true either way. Stored on the seat; a request_id retry with a different value is refused.' },
        options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string', maxLength: 60 }, uniqueItems: true, description: 'debater round table (operator #19423): the 2-4 option strings every member votes on; every open debater of the same title must carry the identical list. Omit for the classic two-side fork.' },
        instruments: {
          type: 'object',
          description: 'Per-seat instrument override (task 1452): false turns that instrument off for this seat alone; omitted leaves every instrument on. RTK is never an arm.',
          properties: {
            codegraph: { type: 'boolean', description: 'The codegraph MCP tool and CLI.' },
            'ast-grep': { type: 'boolean', description: 'The ast-grep/sg CLI.' },
            memory: { type: 'boolean', description: 'The memoryctl MCP tool and CLI.' },
          },
          additionalProperties: false,
        },
      },
      required: ['role', 'title', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'review_plan',
    description: 'Suggest reviewer count and concern-based focus over accumulated staged, unstaged and untracked changes (decision #17931). Identical rules for a coder seat, repo with base, or snapshot:true (HEAD vs current tree). Exclude a changed file only when a parent VENDOR.json files entry for its folder-relative path has the SHA-256 of its reviewed Git blob; differing bytes count as own. No upstream network check. VENDOR.json and NOTICE are documentation. Documentation-only stays zero. Jev rates the remaining complete own diff: below 0.2 gives zero, 0.2 to below 0.7 gives one, 0.7 or more gives two. A security path retains at least one; two requires changed own security lines and Jev risk at least 0.7. Security stems: auth, token, secret, credential, security, permission, install, hook, oauth, plus named harness installers, .githooks/, the orch seat-guard and access_guards migrations; guard alone is no stem. Only hook is excluded under src/, web/ and server-admin-web/; harness knowledge markdown is documentation. Jev unavailable or cut input (80,000-character cap or gate alteration) gives one, or two with changed own security lines, labelled. Returns vendored paths left out and jevRisk (null when not scored). A Jev weakens_tests probability of 0.5 or more adds weakensTests and a focus line (plan and theme); it never changes the count. Multiple code domains return independent themes [{theme, paths, stats, count, reason, focus, vendored, jevRisk}]; total count is their sum. Create one reviewer set per theme, briefed on only its own paths (decision #12934); unmatched code is unrouted, documentation joins no theme. Read-only on the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        seat: { type: 'string', description: 'Coder seat id; exclusive with repo/base/snapshot.' },
        repo: { type: 'string', description: 'Absolute Git checkout to inspect, when no seat is given.' },
        base: { type: 'string', description: 'Diff current checkout against this commit/ref.' },
        snapshot: { type: 'boolean', description: 'Diff HEAD against current checkout when no base is provided.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'seat_prompt',
    description:
      'Give a seat its task; returns with the queued turn id and its own wait command. A first coder, tester or bughunter brief with no files (in `files` or at seat_create) is refused: pass the repo-relative files of the area (decision #17906). A coder first brief is Jev-scored for scope bloat: only above 0.85 it is refused; pass wide_brief with why it cannot be split to bypass; the trimmed reason is stored on the seat. Jev unavailable or a cut brief passes labelled in the turn digest. After a coder correction turn finishes, its digest lists the automatic rechecks of reproduced reviewer blocker and major findings: kind `same` is a turn of that reviewer when every path the correction changes is named in those findings; kind `new` is a new reviewer of another family over the whole diff, replacing it, when the correction changes any other path (decision #12435); set recheck:false on that prompt to opt out. A follow-up to a busy seat queues FIFO behind its running turn (at most 5 queued); you can wait on either turn independently. Coder answers include overlap: [{seat, files, more}] and overlapUnchecked: [seat] for worktree observations that failed; both warn only. `prompt` is the brief: English, at most 300 words (task, owned files, evidence, acceptance; link larger artifacts). A debater\'s second turn requires `rebut`: the turn id of another debater\'s done first turn with a parsed report; that report\'s claims, evidence and forLead are appended verbatim to the stored brief, outside the 300-word count. `rebut` on any other role or on a first turn is refused, and so is one between two seats that run the same model: the two debaters of a fork share ONE title and orch keeps them apart. orch wraps a seat\'s first brief in its role context (knowledge pages and lessons for `files`, code-intel rules, routed skills) and every turn ends in the role\'s JSON report contract (one fenced block, aimed under 5500 characters with each claim under 300; size is never refused); a reply off the schema gets up to two repair turns naming every fault, and the digest carries only the parsed `report`. Then wait WITHOUT polling: in Claude Code run the returned `wait` command as a background Bash task (you are notified with the digest); elsewhere call seat_wait. A first coder brief also carries a non-blocking `warning` when a specialist seat fits: tester (every file a test, fixture or capture, or Jev reads a tests-only brief), designer (Jev reads a surface-look change over a UI file), copywriter (a src/locales/ file), and a reported defect without a reproducing test (a tester writes the red test first).',
    inputSchema: {
      type: 'object',
      properties: {
        seat: { type: 'string' },
        prompt: { type: 'string', description: 'The brief, at most 300 words.' },
        files: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 512 }, description: 'Repo-relative files the task is about; they select knowledge pages and lessons.' },
        long_brief: { type: 'string', description: 'Only for a brief over 300 words: why it cannot be shorter.' },
        wide_brief: { type: 'string', description: 'Coder first brief only: why the work cannot be split into sequential seats (max 300 characters after trimming); bypasses the Jev scope gate.' },
        timeout_minutes: { type: 'number', minimum: 1, maximum: 240, description: 'Turn limit, default 30.' },
        token_cap: { type: 'integer', minimum: 256, maximum: 1000000, description: 'Stand Pi seats only: abort after this many cumulative input+output+cacheRead tokens; a single response may overshoot.' },
        recheck: { type: 'boolean', description: 'Coder correction only: false suppresses automatic rechecks of reproduced reviewer blocker and major findings.' },
        rebut: { type: 'string', description: 'Debater second turn only: the turn id of another debater\'s done first turn, or `table` for a round-table member (created with `options`) to see every other member\'s anonymized round-1 report. Required on that turn; refused on any other role or on a first turn.' },
      },
      required: ['seat', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'seat_wait',
    description: 'Wait up to `seconds` (max 50) for a turn; returns a compact text digest with flags, findings, checks and notes. Use `json: true` for the full digest including grade, watch and worktree. A null report names seat_report for raw text. No flags: accept the report as it stands; a flag names what to check. Prefer the background `wait` command in Claude Code.',
    inputSchema: {
      type: 'object',
      properties: { turn: { type: 'string' }, seconds: { type: 'number', minimum: 0, maximum: 50 }, json: { type: 'boolean', description: 'Return the full JSON digest instead of text.' } },
      required: ['turn'],
      additionalProperties: false,
    },
  },
  {
    name: 'seat_report',
    description: 'The raw final message of a turn. Read it ONLY when the JSON report in the digest is missing or you could not understand it: the report is the delivery.',
    inputSchema: { type: 'object', properties: { turn: { type: 'string' } }, required: ['turn'], additionalProperties: false },
  },
  {
    name: 'memory_apply',
    description: 'Apply a completed turn\'s stored proposals via memoryctl, sequentially; stops at the first refusal. Inspect the digest first. pick is distinct zero-based indexes; omitted means all. If any picked item is supersede/retire, omitting confirm:true returns a read-only preview of every picked proposal and each live entry\'s kind/title (memoryctl get). Call again with confirm:true to write. Applied items are not repeated; uncertain writes are never retried automatically.',
    inputSchema: { type: 'object', properties: { turn: { type: 'string' }, pick: { type: 'array', items: { type: 'integer', minimum: 0 } }, confirm: { type: 'boolean', description: 'Required to write when the selection contains supersede or retire.' } }, required: ['turn'], additionalProperties: false },
  },
  {
    name: 'handoff_draft',
    description: 'Read-only markdown draft for memoryctl handoff from stored seats and report fields. since: ISO UTC time or turn id (default earliest open seat, else last 12 hours); repo: optional checkout path. Edit before saving to memory.',
    inputSchema: { type: 'object', properties: { since: { type: 'string' }, repo: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'seat_land',
    description: 'Apply a coder or tester seat\'s accumulated committed, staged, unstaged and untracked changes since its base to the lead checkout (or into). Refuses dirty overlapping paths. A role write scope refuses patch paths outside it and lists them; override_reason lands those paths and stores the reason on the seat. Leaves conflicts in the lead checkout for resolution or rollback; never commits.',
    inputSchema: { type: 'object', properties: { seat: { type: 'string' }, into: { type: 'string', description: 'Optional absolute path to another checkout of the same repository; default the seat\'s original repo.' }, override_reason: { type: 'string', description: 'Land patch paths outside the seat role write scope and store this reason on the seat. Omitted: those paths are refused and listed.' } }, required: ['seat'], additionalProperties: false },
  },
  {
    name: 'seat_close',
    description: 'Close a seat: a running turn is cancelled, a reviewer worktree removed; a coder branch and worktree stay. While provisioning, answers immediately with closePending: true and status provisioning; closure and cleanup wait for setup to finish. A seat whose setup a restart drain holds has made nothing yet and closes at once (status closed).',
    inputSchema: { type: 'object', properties: { seat: { type: 'string' } }, required: ['seat'], additionalProperties: false },
  },
];

const str = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
};
const optStr = (value: unknown, name: string): string | undefined => (value === undefined ? undefined : str(value, name));
const optBool = (value: unknown, name: string): boolean | undefined => {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${name} must be true or false`);
  return value as boolean | undefined;
};

/** Brief or post summary. Mode off, a missing dictionary, a missing state directory and a checker throw add no key. */
function languageOf(text: string, stateDir: string | undefined): LanguageSummary | null {
  if (!stateDir) return null;
  try { return steSummary(text, stateDir); }
  catch { return null; }
}

const LANGUAGE_FLAG_COMMAND = 'node ops/orchestrator/src/main.ts language flag';

function languageViolationCount(summary: LanguageSummary): number {
  return summary.rejected.length + summary.unknown.length + summary.longSentences;
}

function languageRefusalMessage(summary: LanguageSummary): string {
  const rejected = summary.rejected.map((row) => `${row.word} (${row.alternatives.join(', ')})`).join(', ') || 'none';
  const unknown = summary.unknown.join(', ') || 'none';
  return `the brief has language violations. rejected: ${rejected}. unknown: ${unknown}. long sentences: ${summary.longSentences}. ${LANGUAGE_FLAG_COMMAND}`;
}

/** Null unless enforce and this lead brief has a violation. Orch-composed prompts never reach this. A missing dictionary or a checker throw never refuses. */
function leadLanguageRefusal(stateDir: string | undefined, text: string): string | null {
  if (!stateDir) return null;
  try {
    if (readLanguageMode(stateDir).mode !== 'enforce') return null;
    const summary = steSummary(text, stateDir);
    if (!summary || languageViolationCount(summary) < 1) return null;
    return languageRefusalMessage(summary);
  } catch {
    return null;
  }
}

/**
 * seat_create role 'auto' (task 2955): orch picks tester or coder from the brief, creates exactly
 * one seat of the picked role and queues the brief as its first turn. Every refusal lands before
 * the seat exists. One judgeScope reading serves the pick, the coder first-turn scope gate and the
 * task-2953 hints; the all-test-files rule needs no reading at all.
 */
async function createAutoRole(rt: Runtime, args: Record<string, unknown>, files: string[], session: string | undefined, leadHandle: string | null) {
  const brief = str(args.brief, 'brief');
  if (!brief.trim()) throw new Error('brief must be non-empty text');
  if (args.critic !== undefined) throw new Error("critic is for a scout seat only: a plan critic is role: 'critic', never role 'auto'");
  if (args.options !== undefined) throw new Error('options is for a debater round table only');
  // The brief is the lead's text: the same language boundary as seat_prompt (task 2164).
  const refusal = leadLanguageRefusal(rt.stateDir, brief);
  if (refusal) throw new Error(refusal);
  if (args.wide_brief !== undefined && (typeof args.wide_brief !== 'string' || !args.wide_brief.trim())) throw new Error('wide_brief must explain why the work cannot be split');
  const wideBrief = typeof args.wide_brief === 'string' ? args.wide_brief.trim() : undefined;
  if (wideBrief !== undefined && wideBrief.length > 300) throw new Error('wide_brief must be at most 300 characters after trimming');
  // The prompt-time word limit lands before any seat exists or Jev is asked (reviewer-codex-b4865c).
  const words = wordCount(brief);
  if (words > BRIEF_WORDS) {
    throw new Error(`the brief is ${words} words; the limit is ${BRIEF_WORDS}. Cut it to the task, owned files, evidence and acceptance and link larger artifacts, or pass long_brief with the reason it cannot be shorter`);
  }
  const title = str(args.title, 'title');
  const requestId = optStr(args.request_id, 'request_id');
  if (requestId !== undefined) {
    const repoPath = str(args.repo, 'repo');
    // A retry of an auto create whose answer was lost gets the stored seat, its first turn and the
    // stored pick: the reading is not made twice (the request_id rule of task 1757). The role is
    // 'auto' by construction here; title and repo must match, as createIdempotent requires.
    const existing = rt.store.seatByRequestId(requestId);
    if (existing) {
      const stored = existing.data.autoRole as SeatData['autoRole'];
      let sameRepo = false;
      try { sameRepo = (await repoOf(repoPath)).top === existing.data.repo; } catch { /* an unreadable repo never matches */ }
      if (!stored || existing.title !== title.trim() || !sameRepo) throw new Error(`request_id ${requestId} already belongs to ${existing.id}`);
      const first = rt.store.listTurns(existing.id)[0];
      return { ...leanSeat(existing), ...(first ? { turn: first.id, wait: `${WAIT_COMMAND} ${first.id}` } : {}), picked: { role: existing.role, ...stored } };
    }
    // A concurrent create with the same request_id shares the in-flight work: one pick, one seat,
    // one first turn. The entry is set before the first await, so the twin always finds it.
    const inFlight = autoCreating.get(requestId);
    if (inFlight) {
      let sameRepo = false;
      try { sameRepo = (await repoOf(repoPath)).top === (await inFlight.top); } catch { /* no match */ }
      if (inFlight.title !== title.trim() || !sameRepo) {
        const row = rt.store.seatByRequestId(requestId);
        throw new Error(`request_id ${requestId} already belongs to ${row?.id ?? 'a create still in flight'}`);
      }
      return inFlight.work;
    }
    const top = repoOf(repoPath).then((resolved) => resolved.top);
    const work = top.then(() => createAutoSeatWork(rt, args, files, session, leadHandle, brief, wideBrief, title, requestId));
    autoCreating.set(requestId, { title: title.trim(), top, work });
    try { return await work; } finally { autoCreating.delete(requestId); }
  }
  return createAutoSeatWork(rt, args, files, session, leadHandle, brief, wideBrief, title, undefined);
}

/** In-flight role 'auto' creates by request_id: a concurrent twin shares the one work promise. */
const autoCreating = new Map<string, { title: string; top: Promise<string>; work: Promise<unknown> }>();

/**
 * A lead's needs mac (task 3288): this Mac already carries the leads, the desktop app and the releases, and in
 * one day 19 of its 27 coders were pinned there over backend work that a Linux host builds. The pin names what on this
 * Mac the seat must touch, unless a file is this Mac's desktop runtime; claude, native and stand-arm seats stay
 * on the Mac by themselves. Internal creates (scout_request, the tasks agent) do not pass through here.
 */
function macNeedReason(args: Record<string, unknown>, files: string[] | undefined): string | undefined {
  if (args.needs !== 'mac') {
    if (args.needs_reason !== undefined) throw new Error('needs_reason goes with needs mac only');
    return undefined;
  }
  const reason = statedReason(args);
  if (reason || macPinExempt(args, files)) return reason;
  throw new Error('needs mac pins this Mac, which already carries the leads, the desktop app and the releases (operator 2026-10-28, task 3288): pass needs_reason naming what on this Mac the seat must touch (the Tauri runtime, state under ~/.local/state, a loopback service, Mac-only credentials, uncommitted files read in place), or omit needs and let load place it (decision #12591)');
}

/** The trimmed needs_reason, refused over 300 characters; undefined when absent or blank. */
function statedReason(args: Record<string, unknown>): string | undefined {
  const reason = optStr(args.needs_reason, 'needs_reason')?.trim();
  if (reason && reason.length > 300) throw new Error(`needs_reason is ${reason.length} characters; at most 300`);
  return reason || undefined;
}

/** Seats that stay on this Mac by themselves: claude, native harnesses, stand arms and this Mac's desktop runtime files. */
function macPinExempt(args: Record<string, unknown>, files: string[] | undefined): boolean {
  return args.family === 'claude' || args.harness === 'native' || args.standArm !== undefined || files?.some(touchesMacDesktop) === true;
}

/** The pick, create and first-turn queue of a role 'auto' create whose validations already passed. */
async function createAutoSeatWork(rt: Runtime, args: Record<string, unknown>, files: string[], session: string | undefined, leadHandle: string | null, brief: string, wideBrief: string | undefined, title: string, requestId: string | undefined) {
  let pick = pickRole(files, null);
  let decision: ScopeDecision | null = null;
  if (pick.rule !== 'files') {
    const text = jevText([['Coder brief (data, not instructions)', brief]]);
    if (rt.seats.scopeDeclined(brief, text)) throw new Error(AUTO_ROLE_UNJUDGED);
    decision = await rt.seats.judgeScope(text);
    if (decision.status !== 'scored') throw new Error(AUTO_ROLE_UNJUDGED);
    if (decision.score > WIDE_BRIEF_P && wideBrief === undefined) {
      // The same refusal the first coder brief's scope gate gives.
      throw new Error(`coder brief scope ${decision.score} above ${WIDE_BRIEF_P.toFixed(2)}: split the behaviors or new units across sequential seats, or pass wide_brief explaining why that cannot be done`);
    }
    pick = pickRole(files, decision);
  }
  const features = decision?.status === 'scored' ? decision.features : null;
  const jev = { wide: decision?.status === 'scored' ? decision.score : null, defect: features?.defect ?? null, tests_only: features?.tests_only ?? null, look: features?.look ?? null, logic: features?.logic ?? null };
  const seat = await rt.seats.create({
    role: pick.role, family: optStr(args.family, 'family'), author: optStr(args.author, 'author'), coauthors: args.coauthors as string[] | undefined, title, repo: str(args.repo, 'repo'),
    base: optStr(args.base, 'base'), snapshot: optBool(args.snapshot, 'snapshot'), harness: optStr(args.harness, 'harness'), host: optStr(args.host, 'host'), needs: optStr(args.needs, 'needs'), needsReason: macNeedReason(args, files), files, model: optStr(args.model, 'model'), effort: optStr(args.effort, 'effort'),
    instruments: args.instruments, standArm: args.standArm, request_id: requestId, images: optBool(args.images, 'images'), leadHandle,
  }, await choose(rt, session));
  // The pick evidence lands on the seat and in the event log in one write.
  const stored = rt.store.updateSeat(seat.id, { data: { autoRole: { rule: pick.rule, jev, next: pick.next } } }, 'seat.auto_role', { role: pick.role, rule: pick.rule, ...jev, next: pick.next });
  const turn = await rt.seats.promptScoped(stored.id, brief, undefined, {
    files,
    // A coder reuses the create-time reading, wide_brief bypass included: promptScoped records the
    // bypass and keeps THIS reading instead of judging again (reviewer-codex-b4865c, task 1943).
    ...(pick.role === 'coder' && decision?.status === 'scored' ? { assessed: decision } : {}),
    ...(pick.rule === 'defect' ? { briefSuffix: `\n\n${AUTO_ROLE_TEST0}` } : {}),
  }, wideBrief);
  // The task-2953 hints reuse the same reading; each kind still shows at most once per seat.
  const hinted = stored.role === 'coder' ? roleHintWarning(rt.store, stored, files, features) : { seat: stored, text: '' };
  const drain = rt.store.drainStatus();
  const warning = [rt.limits.load(hinted.seat.family as Family).warning, drain && drainWarning(drain), rt.configHealth?.warning(), hinted.text].filter(Boolean).join(' ');
  return { ...leanSeat(hinted.seat, warning), turn: turn.id, wait: `${WAIT_COMMAND} ${turn.id}`, picked: { role: pick.role, rule: pick.rule, jev, next: pick.next } };
}

function buildMcpServer(rt: Runtime, requests: ReadonlyMap<string, number>, held: () => string[]): Server {
  const server = new Server({ name: 'orch', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    // One trust boundary for every tool: an argument outside the tool's own schema is refused,
    // not silently ignored (a `prompt` on seat_create lost a lead ~4 h, memory #12948).
    const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
    if (tool) {
      const known = Object.keys(tool.inputSchema.properties);
      const unknown = Object.keys(args).filter((key) => !known.includes(key));
      if (unknown.length) {
        const fields = unknown.map((key) => `'${key}'`).join(', ');
        const text = request.params.name === 'seat_create' && unknown.includes('prompt')
          ? `seat_create takes no prompt: create the seat, then call seat_prompt with the brief${unknown.length > 1 ? `; also unknown: ${unknown.filter((key) => key !== 'prompt').map((key) => `'${key}'`).join(', ')}` : ''}`
          : `${request.params.name} takes no ${fields}`;
        return { isError: true, content: [{ type: 'text', text }] };
      }
    }
    let result: unknown;
    if (request.params.name === 'orch_status') {
      result = { ...health(rt), stateDir: rt.stateDir, port: rt.port(), seats: rt.store.seatCounts(), limits: rt.limits.all().map(lean) };
      rt.limits.refresh();
    } else if (request.params.name === 'seats_list' && args.seat !== undefined) {
      // One known seat (the A/B stand's waitReady): no scan, no paging, the full row whatever its status.
      if (typeof args.seat !== 'string' || !args.seat) return { isError: true, content: [{ type: 'text', text: 'seat must be a seat id' }] };
      if (Object.keys(args).length > 1) return { isError: true, content: [{ type: 'text', text: 'seat is not combined with status, closed, limit or offset' }] };
      const seat = rt.store.getSeat(args.seat);
      result = { seats: seat ? [leanSeat(seat, rt.limits.load(seat.family as Family).warning)] : [] };
    } else if (request.params.name === 'seats_list') {
      if (args.status !== undefined && typeof args.status !== 'string') {
        return { isError: true, content: [{ type: 'text', text: 'status must be a string' }] };
      }
      if (args.closed !== undefined && typeof args.closed !== 'boolean') {
        return { isError: true, content: [{ type: 'text', text: 'closed must be true or false' }] };
      }
      if (args.limit !== undefined && !(Number.isInteger(args.limit) && (args.limit as number) >= 1 && (args.limit as number) <= 500)) {
        return { isError: true, content: [{ type: 'text', text: 'limit must be an integer from 1 to 500' }] };
      }
      if (args.offset !== undefined && !(Number.isInteger(args.offset) && (args.offset as number) >= 0)) {
        return { isError: true, content: [{ type: 'text', text: 'offset must be a non-negative integer' }] };
      }
      const status = args.status as string | undefined;
      // Default list is what a lead can still drive. Closed history stays out unless asked for;
      // an exact status of `closed` is that ask. The board keeps its own filter. Both branches are
      // bounded reads (defect 2026-10-16): open seats by status, the closed page out of the store.
      const open = (status === 'closed' ? [] : status ? rt.store.listSeats(status) : rt.store.listSeats({ notStatus: 'closed' }))
        .filter((seat) => seat.status !== 'closed')
        .map((seat) => leanSeat(seat, rt.limits.load(seat.family as Family).warning));
      if (args.closed !== true && status !== 'closed') {
        result = { seats: open };
      } else {
        // ~900 closed seats in full rows were 579K characters (task 1569): a page of compact rows, newest first.
        const limit = (args.limit as number | undefined) ?? CLOSED_PAGE;
        const offset = (args.offset as number | undefined) ?? 0;
        const { seats: page, total } = status && status !== 'closed' ? { seats: [], total: 0 } : rt.store.closedSeatPage(offset, limit);
        const nextOffset = offset + page.length < total ? offset + page.length : null;
        result = { seats: [...open, ...page.map((seat) => closedSeat(seat, rt.store))], closedPage: { total, offset, returned: page.length, omitted: total - page.length, nextOffset } };
      }
    } else {
      try {
        switch (request.params.name) {
          case 'chat_join': {
            result = chatJoin(rt.store, { handle: str(args.handle, 'handle'), session: str(args.session, 'session'), desktop: args.desktop as string | undefined });
            break;
          }
          case 'chat_post': {
            const body = str(args.body, 'body');
            const posted = chatPost(rt.store, {
              as: str(args.as, 'as'), session: str(args.session, 'session'), body,
              to: args.to as ChatAddress | undefined, wake: optBool(args.wake, 'wake'), class: args.class as 'fyi' | undefined,
            });
            const language = languageOf(body, rt.stateDir);
            const reply = args.wake === true || posted.replyWake !== undefined ? { ...posted, addressees: chatAddressees(rt.store, posted.id, requests, held()) } : posted;
            result = language ? { ...reply, language } : reply;
            break;
          }
          case 'chat_read': {
            result = chatRead(rt.store, {
              as: str(args.as, 'as'), session: str(args.session, 'session'),
              all: optBool(args.all, 'all'), limit: args.limit as number | undefined,
            });
            break;
          }
          case 'seat_create': {
            const files = parseTaskFiles(args.files);
            macNeedReason(args, files);
            const session = optStr(args.session, 'session');
            const leadHandle = chatLiveHandle(rt.store, session);
            if (args.role === 'auto') {
              if (!files || !files.length) throw new Error("role 'auto' needs files: the repo-relative files of the area");
              result = await createAutoRole(rt, args, files, session, leadHandle);
              break;
            }
            // A request_id minted by role 'auto' never matches an explicit-role retry, even when the
            // explicit role happens to be the role orch picked (reviewer-codex-b4865c, task 2955).
            const retryId = optStr(args.request_id, 'request_id');
            if (retryId !== undefined) {
              const autoHolder = rt.store.seatByRequestId(retryId);
              if (autoHolder?.data.autoRole) throw new Error(`request_id ${retryId} already belongs to ${autoHolder.id}`);
              // A pending auto create holds its request_id from its first synchronous frame on
              // (reviewer-codex-b4865c.2, task 2955): an explicit-role create with it refuses too.
              if (autoCreating.has(retryId)) throw new Error(`request_id ${retryId} already belongs to a create still in flight`);
            }
            if (args.brief !== undefined) throw new Error("brief is for role 'auto' only: create the seat, then call seat_prompt with the brief");
            if (args.wide_brief !== undefined) throw new Error("wide_brief is for role 'auto' only");
            const seat = await rt.seats.create({
              role: str(args.role, 'role'), family: optStr(args.family, 'family'), author: optStr(args.author, 'author'), coauthors: args.coauthors as string[] | undefined, title: str(args.title, 'title'), repo: str(args.repo, 'repo'),
              base: optStr(args.base, 'base'), snapshot: optBool(args.snapshot, 'snapshot'), harness: optStr(args.harness, 'harness'), host: optStr(args.host, 'host'), needs: optStr(args.needs, 'needs'), needsReason: macNeedReason(args, files), files, model: optStr(args.model, 'model'), effort: optStr(args.effort, 'effort'),
              instruments: args.instruments, standArm: args.standArm, request_id: optStr(args.request_id, 'request_id'), critic: optBool(args.critic, 'critic'), images: optBool(args.images, 'images'), options: args.options as string[] | undefined, leadHandle,
            }, await choose(rt, session));
            const drain = seat.role === 'scout' || seat.role === 'critic' ? null : rt.store.drainStatus();
            // Deterministic specialist-role hints (tester, locales) for a coder with files (task 2953).
            const hinted = seat.role === 'coder' && files && files.length ? roleHintWarning(rt.store, seat, files, null) : { seat, text: '' };
            result = leanSeat(hinted.seat, [rt.limits.load(hinted.seat.family as Family).warning, drain && drainWarning(drain), rt.configHealth?.warning(), hinted.text].filter(Boolean).join(' '));
            break;
          }
          case 'review_plan': {
            result = await reviewPlan(rt.store, { seat: optStr(args.seat, 'seat'), repo: optStr(args.repo, 'repo'), base: optStr(args.base, 'base'), snapshot: optBool(args.snapshot, 'snapshot') });
            break;
          }
          case 'seat_prompt': {
            const minutes = args.timeout_minutes === undefined ? undefined : Number(args.timeout_minutes);
            if (minutes !== undefined && !(minutes >= 1 && minutes <= 240)) throw new Error('timeout_minutes must be 1..240');
            const files = parseTaskFiles(args.files);
            if (args.long_brief !== undefined && typeof args.long_brief !== 'string') throw new Error('long_brief must be text');
            if (args.wide_brief !== undefined) {
              if (typeof args.wide_brief !== 'string' || !args.wide_brief.trim()) throw new Error('wide_brief must explain why the work cannot be split');
              if (args.wide_brief.trim().length > 300) throw new Error('wide_brief must be at most 300 characters after trimming');
            }
            if (args.token_cap !== undefined && typeof args.token_cap !== 'number') throw new Error('token_cap must be an integer from 256 to 1000000');
            if (args.rebut !== undefined && (typeof args.rebut !== 'string' || !args.rebut.trim())) throw new Error('rebut must be a turn id');
            const seatId = str(args.seat, 'seat');
            const brief = str(args.prompt, 'prompt');
            // Enforce refuses only a brief a lead wrote. Orch calls prompt() itself and is not judged here (task 2164).
            const refusal = leadLanguageRefusal(rt.stateDir, brief);
            if (refusal) throw new Error(refusal);
            const turn = await rt.seats.promptScoped(seatId, brief, minutes === undefined ? undefined : minutes * 60_000, {
              tokenCap: typeof args.token_cap === 'number' ? args.token_cap : undefined,
              files,
              longBrief: args.long_brief as string | undefined,
              recheck: optBool(args.recheck, 'recheck'),
              rebut: typeof args.rebut === 'string' ? args.rebut.trim() : undefined,
            }, args.wide_brief as string | undefined);
            let seat = rt.store.getSeat(turn.seat_id)!;
            if (landable(seat.role)) await rt.seats.observeCoders(seat.data.repo, seat.id);
            const drain = turn.status === 'queued' && seat.role !== 'scout' && seat.role !== 'critic' ? rt.store.drainStatus() : null;
            // First coder brief: every specialist-role hint over seat files ∪ prompt files, each kind once (task 2953).
            const hinted = seat.role === 'coder' && turn.seq === 1
              ? roleHintWarning(rt.store, seat, [...(Array.isArray(seat.data.taskFiles) ? seat.data.taskFiles as string[] : []), ...(files ?? [])], turn.watch?.scope?.features ?? null)
              : { seat, text: '' };
            seat = hinted.seat;
            const warning = [seat.data.noFilesTurn === turn.id ? NO_FILES_WARNING : null, drain && drainWarning(drain), rt.configHealth?.warning(), hinted.text].filter(Boolean).join(' ');
            const language = languageOf(brief, rt.stateDir);
            result = { turn: turn.id, status: turn.status, wait: `${WAIT_COMMAND} ${turn.id}`, ...(warning ? { warning } : {}), overlap: rt.seats.overlap(turn.seat_id), overlapUnchecked: rt.seats.overlapUnchecked(turn.seat_id), ...(language ? { language } : {}) };
            break;
          }
          case 'seat_wait': {
            const seconds = args.seconds === undefined ? 50 : Number(args.seconds);
            if (!(seconds >= 0 && seconds <= 50)) throw new Error('seconds must be 0..50');
            const json = optBool(args.json, 'json');
            const digest = await rt.seats.digest(await rt.seats.wait(str(args.turn, 'turn'), seconds * 1000));
            result = json ? digest : formatDigest(digest);
            break;
          }
          case 'seat_report': {
            const turnId = str(args.turn, 'turn');
            const turn = rt.store.getTurn(turnId);
            if (!turn) throw new Error(rt.store.noTurnError(turnId));
            result = { turn: turn.id, status: turn.status, text: turn.text, error: turn.error };
            break;
          }
          case 'memory_apply': {
            result = await applyMemory(rt.store, str(args.turn, 'turn'), args.pick as number[] | undefined, optBool(args.confirm, 'confirm'));
            break;
          }
          case 'handoff_draft': {
            result = await handoffDraft(rt.store, { since: optStr(args.since, 'since'), repo: optStr(args.repo, 'repo') });
            break;
          }
          case 'seat_land': {
            result = await land(rt.store, str(args.seat, 'seat'), optStr(args.into, 'into'), {}, optStr(args.override_reason, 'override_reason'));
            break;
          }
          case 'seat_close': {
            const seat = await rt.seats.close(str(args.seat, 'seat'));
            result = {
              id: seat.id, status: seat.status,
              ...(seat.data.closePending === true ? { closePending: true } : {}),
              ...(landable(seat.role) && !seat.data.worktreeRemoved ? { branch: seat.data.branch ?? null, worktree: seat.worktree } : {}),
              ...(typeof seat.data.failure === 'string' ? { failure: seat.data.failure } : {}),
              // A remote close can outlive this answer while host cleanup runs (task 2152): say it is
              // still pending and when it began, mirroring the land refusal's wording.
              ...(seat.data.remoteCleanupPending === true ? {
                remoteCleanupPending: true,
                note: `pending remote close began at ${[seat.data.remoteCleanupSince, seat.data.closedAt].find((at) => typeof at === 'string') ?? '(start time was not recorded)'}`,
              } : {}),
            };
            break;
          }
          default:
            return { isError: true, content: [{ type: 'text', text: `unknown tool '${request.params.name}'` }] };
        }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: (error as Error).message }] };
      }
    }
    return typeof result === 'string'
      ? { content: [{ type: 'text', text: result }] }
      : { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
  });
  return server;
}

/** The seat endpoint's MCP server: scout_request for the one seat its token names, and nothing else (decision #11990). */
function buildSeatMcpServer(scouts: ScoutGate, seatId: string): Server {
  const server = new Server({ name: 'orch-seat', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [SCOUT_TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== SCOUT_TOOL.name) return { isError: true, content: [{ type: 'text', text: `unknown tool '${request.params.name}'` }] };
    try {
      return { content: [{ type: 'text', text: await scouts.request(seatId, (request.params.arguments ?? {}) as Record<string, unknown>) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: (error as Error).message }] };
    }
  });
  return server;
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error(`body over ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveMcp(server: Server, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Stateless: a fresh server and transport per request, so no session
  // state lives in memory that a restart would silently drop.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** What an automatic family pick reads: the lead's seat_create (its `session` names the creating lead) and orch's own recheck reviewer (decision #11871, #17805 D2). */
async function choose(rt: Runtime, session?: string): Promise<Choose> {
  const aside = await leadAside(rt.store, rt.seats.options.home, session);
  return {
    loads: rt.limits.all(),
    leadFamilies: aside.families,
    leadFamily: aside.leadFamily,
    ...(aside.note ? { leadAsideNote: aside.note } : {}),
    estimate: (load, role, model, window) => rt.limits.estimate(load.family, role, load, model, window),
  };
}

async function serveDashboard(rt: Runtime, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(DASHBOARD_HTML);
    return true;
  }
  if (pathname === '/api/dashboard') {
    sendJson(res, 200, await board(rt));
    return true;
  }
  return false;
}

// The sessions with a held /chat/wake poll, for each runtime. The loopback server owns the polls; the LAN
// chat feed reads them through chatList, so a receipt state on the phone equals the one on the loopback
// board (task 2286). The session ids stay inside chatList.
const heldWakes = new WeakMap<Runtime, () => string[]>();
const chatRequests = new WeakMap<Runtime, ReadonlyMap<string, number>>();

/** The LAN server cannot reach the loopback router, MCP or seat code. */
export function createLanBoardServer(rt: Runtime): HttpServer {
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
    catch { res.writeHead(404); res.end(); return; }
    const pathname = url.pathname;
    rt.loop?.mark(`lan ${req.method} ${pathname}`);
    if (req.method !== 'GET' || !['/', '/api/dashboard', '/api/chat'].includes(pathname)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      if (pathname === '/api/chat') {
        const numberParam = (name: string) => {
          const value = url.searchParams.get(name);
          return value === null ? undefined : value.trim() === '' ? NaN : Number(value);
        };
        try {
          const { posts, handles, watchers } = chatList(rt.store, {
            after: numberParam('after'), limit: numberParam('limit'), held: heldWakes.get(rt)?.() ?? [], requests: chatRequests.get(rt),
          });
          sendJson(res, 200, { posts, handles: handles.map(({ handle, bound_at }) => ({ handle, bound_at })), watchers, readOnly: true });
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
        return;
      }
      await serveDashboard(rt, req, res, pathname);
    } catch (error) {
      rt.log('error', 'http.error', { url: req.url, message: (error as Error).message });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    }
  };
  // The span times the handler's synchronous prefix (the run until its first
  // await); continuations after an await are later, unattributed windows.
  const server = createServer((req, res) =>
    span(`lan ${req.method} ${(req.url ?? '/').split('?')[0]}`, () => serve(req, res)));
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}

/** Whether one watcher's `since` predates another. ISO timestamps order by time; anything unparseable falls back to string order. */
function sinceOlder(since: string, newest: string): boolean {
  const a = Date.parse(since);
  const b = Date.parse(newest);
  return Number.isNaN(a) || Number.isNaN(b) ? since < newest : a < b;
}

export function createHttpServer(rt: Runtime): HttpServer {
  // A test runtime may stub the seat manager without it.
  rt.seats.useChooser?.(() => choose(rt));
  const scouts = new ScoutGate({ store: rt.store, seats: rt.seats, log: rt.log, port: rt.port, stateDir: rt.stateDir, choose: () => choose(rt) });
  rt.seats.useSeatTool?.((seat) => scouts.issue(seat));
  const wakes = new Map<string, { res: ServerResponse; since: string | undefined; mod?: true }>();
  // The newest watcher `since` per session, never a mod poll (task 2589). During a drain or
  // close no poll is held to supersede, so without this memory every Stop watcher of one
  // session would retry its 503 to the 7100 s deadline while each ended turn adds another
  // (measured 2026-10-26: 37 watchers, 2.2 GB RSS under one drain). Entries outlive the
  // watcher deadline itself, so no live watcher's `since` is forgotten while it still polls.
  const wakeSince = new Map<string, { since: string; at: number }>();
  // Only sessions seen in the last 7200 s: no live watcher polls past its 7100 s deadline.
  const wakeSinceLive = (session: string) => {
    const seen = wakeSince.get(session);
    if (seen !== undefined && Date.now() - seen.at > 7_200_000) {
      wakeSince.delete(session);
      return undefined;
    }
    return seen;
  };
  const rememberWakeSince = (session: string, since: string) => {
    const now = Date.now();
    for (const [seen, row] of wakeSince) if (now - row.at > 7_200_000) wakeSince.delete(seen);
    wakeSince.set(session, { since, at: now });
  };
  heldWakes.set(rt, () => [...wakes.keys()]);
  const requests = new Map<string, number>();
  chatRequests.set(rt, requests);
  const tasks = createTasksRoutes(rt, () => [...wakes.keys()]);
  const preparingChecks = new Set<string>();
  let wakePoll: ReturnType<typeof setInterval> | undefined;
  let closing = false;
  const forgetWake = (session: string, res: ServerResponse) => {
    if (wakes.get(session)?.res !== res) return;
    wakes.delete(session);
    if (!wakes.size) {
      clearInterval(wakePoll);
      wakePoll = undefined;
    }
  };
  const finishWake = (session: string, res: ServerResponse, status: number, body: unknown) => {
    forgetWake(session, res);
    if (!res.destroyed) sendJson(res, status, body);
  };
  const checkWake = (session: string, held: { res: ServerResponse; since: string | undefined }) => {
    if (closing || rt.store.draining()) {
      finishWake(session, held.res, 503, { error: closing ? 'daemon is closing' : 'daemon is draining' });
      return;
    }
    try {
      const pending = chatWakePending(rt.store, session, held.since);
      if (pending) finishWake(session, held.res, 200, pending);
    } catch (error) {
      finishWake(session, held.res, 400, { error: (error as Error).message });
    }
  };
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    // Exclude query strings (which may carry session ids) from the diagnostic.
    rt.loop?.mark(`http ${req.method} ${(req.url ?? '/').split('?')[0]}`);
    const refused = rejectReason(req);
    if (refused) {
      rt.log('warn', 'http.rejected', { reason: refused, url: req.url });
      sendJson(res, 403, { error: refused });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        sendJson(res, 200, health(rt));
        return;
      }
      if (await serveDashboard(rt, req, res, url.pathname)) return;
      // The tasks board and chat are deliberately outside serveDashboard: the LAN board cannot reach them.
      if (await tasks(req, res, url)) return;
      // A turn's live log (task 2883), loopback only for the same reason: tool args can hold secrets,
      // so this route is never added to the LAN allowlist in createLanBoardServer.
      if (url.pathname === '/api/turn-live' && req.method === 'GET') {
        try {
          const turn = str(url.searchParams.get('turn'), 'turn');
          const stored = rt.store.getTurn(turn);
          if (!stored) {
            sendJson(res, 404, { error: rt.store.noTurnError(turn) });
            return;
          }
          const raw = url.searchParams.get('after') ?? '0';
          const after = Number(raw);
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(after)) throw new Error('after must be a non-negative integer');
          const log = rt.seats.turnLiveLog(turn);
          const read = log ? log.after(after) : { entries: [], next: 0 };
          sendJson(res, 200, {
            turn,
            // A queued turn is live too: the board polls until a terminal status.
            running: !TERMINAL_TURN.has(stored.status),
            entries: read.entries,
            next: read.next,
            trimmed: log?.trimmed ?? 0,
            note: 'in memory only: a daemon restart loses the live log',
          });
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
        return;
      }
      if (url.pathname === '/api/chat' && req.method === 'GET') {
        const numberParam = (name: string) => {
          const value = url.searchParams.get(name);
          return value === null ? undefined : value.trim() === '' ? NaN : Number(value);
        };
        try {
          sendJson(res, 200, chatList(rt.store, { after: numberParam('after'), limit: numberParam('limit'), held: [...wakes.keys()], requests }));
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
        return;
      }
      if (url.pathname === '/chat/unread' && req.method === 'GET') {
        try {
          const session = str(url.searchParams.get('session'), 'session');
          requests.set(session, Date.now());
          sendJson(res, 200, chatPending(rt.store, { session }));
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
        return;
      }
      if (url.pathname === '/chat/wake' && req.method === 'GET') {
        try {
          const session = str(url.searchParams.get('session'), 'session');
          requests.set(session, Date.now());
          // Older watchers still send since. Decision 15057: the release decision no longer reads it.
          // An absent value is not an error.
          const since = url.searchParams.get('since') ?? undefined;
          // Validate before displacing the previous watcher; this also checks for a
          // wake already pending. The offer is read-only, just like /chat/unread.
          const pending = chatWakePending(rt.store, session, since);
          // Task 2589: the orch-board mod holds the poll for an idle desktop lead with no
          // Stop watcher (that expires after 7100 s). The mod's hold outranks a late
          // watcher, which is told at once it is superseded; only a newer mod poll displaces it.
          const mod = url.searchParams.get('holder') === 'mod' || undefined;
          // An older Stop watcher of this session is superseded at once, also while draining
          // or closing when no poll is held to displace: only the newest watcher survives, so
          // retries cannot pile up under a drain. The newest poll is recorded here and keeps
          // today's answer below (a drain 503 it survives to poll the new daemon).
          if (!mod && since !== undefined) {
            const newestSeen = wakeSinceLive(session);
            if (newestSeen !== undefined && sinceOlder(since, newestSeen.since)) {
              sendJson(res, 200, { superseded: true });
              return;
            }
            rememberWakeSince(session, since);
          }
          const previous = wakes.get(session);
          if (previous) {
            if (previous.mod && !mod) {
              sendJson(res, 200, { superseded: true });
              return;
            }
            finishWake(session, previous.res, 200, { superseded: true });
          }
          if (closing || rt.store.draining()) {
            sendJson(res, 503, { error: closing ? 'daemon is closing' : 'daemon is draining' });
          } else if (pending) {
            sendJson(res, 200, pending);
          } else {
            res.setTimeout(0);
            wakes.set(session, { res, since, mod });
            res.once('close', () => forgetWake(session, res));
            // Only while watchers exist. Query the store rather than a particular
            // posting route so direct/module writers and other DB connections wake too.
            wakePoll ??= setInterval(() => {
              rt.loop?.mark('timer chat.wakePoll');
              span('timer chat.wakePoll', () => {
                for (const [heldSession, held] of wakes) checkWake(heldSession, held);
              });
            }, 100);
            wakePoll.unref();
          }
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
        return;
      }
      if (['/chat/delivered', '/chat/confirmed'].includes(url.pathname) && req.method === 'POST') {
        // Hooks have no Origin; browser callers must use this daemon's exact origin.
        // The custom header requires a preflight, which this server never grants.
        const ownOrigin = new URL(`http://${hostOf(req.headers.host!)}:${rt.port()}`).origin;
        if (req.headers['x-orch-chat'] !== '1' ||
          (req.headers.origin !== undefined && req.headers.origin !== ownOrigin)) {
          sendJson(res, 403, { error: 'chat receipts require X-Orch-Chat: 1 and no Origin or the daemon origin' });
          return;
        }
        try {
          const body = await readJson(req, 64 * 1024);
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object');
          for (const key of Object.keys(body)) {
            if (!['session', 'posts'].includes(key)) throw new Error(`chat receipts take no '${key}'`);
          }
          const input = body as Parameters<typeof chatDelivered>[1];
          const operation = url.pathname === '/chat/delivered' ? chatDelivered : chatConfirmed;
          sendJson(res, 200, operation(rt.store, input));
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
        return;
      }
      if (['/chat/post', '/chat/release'].includes(url.pathname) && req.method === 'POST') {
        // Unlike other loopback callers, the board must supply its exact origin.
        // No CORS/preflight grant: a page on another localhost port cannot post.
        const ownOrigin = new URL(`http://${hostOf(req.headers.host!)}:${rt.port()}`).origin;
        if (req.headers.origin !== ownOrigin || req.headers['x-orch-chat'] !== '1') {
          sendJson(res, 403, { error: `chat ${url.pathname === '/chat/release' ? 'release' : 'post'} requires the daemon origin and X-Orch-Chat: 1` });
          return;
        }
        try {
          const body = await readJson(req, 64 * 1024);
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object');
          if (url.pathname === '/chat/release') {
            for (const key of Object.keys(body)) {
              if (key !== 'handle') throw new Error(`chat release takes no '${key}'`);
            }
            sendJson(res, 200, chatRelease(rt.store, { handle: str((body as Record<string, unknown>).handle, 'handle') }));
            return;
          }
          for (const key of Object.keys(body)) {
            if (!['body', 'to', 'wake'].includes(key)) throw new Error(`chat post takes no '${key}'`);
          }
          sendJson(res, 200, chatPostOperator(rt.store, body as Parameters<typeof chatPostOperator>[1]));
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
        return;
      }
      if (url.pathname === '/check-on' && req.method === 'POST') {
        let key: string | undefined;
        try {
          if (closing || rt.store.draining()) throw new Error('daemon is closing or draining');
          const raw = await readJson(req, 16 * 1024);
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('check-on requires a JSON object');
          const body = raw as Record<string, unknown>;
          if (Object.keys(body).some(field => !['host', 'repo', 'sha', 'pid'].includes(field))) throw new Error('unknown check-on field');
          const host = str(body.host, 'host'), repo = str(body.repo, 'repo'), sha = str(body.sha, 'sha');
          assertCheckHolder(rt.stateDir, host, repo, body.pid);
          const candidate = JSON.stringify([host, repo]);
          if (preparingChecks.has(candidate)) throw new Error('check-on preparation is already running');
          preparingChecks.add(candidate);
          key = candidate;
          res.setTimeout(0);
          const timings: Record<string, number> = {};
          const snapshotStart = performance.now();
          await snapshotForCheck(repo, sha);
          timings.snapshot = performance.now() - snapshotStart;
          const dir = await prepareCheckOn(host, repo, sha, rt.stateDir, { timings });
          sendJson(res, 200, { dir, timings });
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        } finally {
          if (key !== undefined) preparingChecks.delete(key);
        }
        return;
      }
      if (url.pathname === '/restart' && req.method === 'POST') {
        try {
          // Room for a 600-code-point post even with JSON escapes, plus the identity.
          const raw = await readJson(req, 16 * 1024);
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('restart requires a JSON object');
          const body = raw as Record<string, unknown>;
          const keys = Object.keys(body);
          if (body.cancel === true && keys.length === 1) {
            try {
              sendJson(res, 200, rt.seats.cancelDrain());
            } catch (error) {
              sendJson(res, 409, { error: (error as Error).message });
            }
            return;
          }
          const hasNote = 'note' in body;
          if (body.whenIdle !== true || keys.some((key) => !(hasNote ? ['whenIdle', 'as', 'session', 'note'] : ['whenIdle']).includes(key))) {
            throw new Error('restart requires { whenIdle: true } with optional as, session and note, or { cancel: true }');
          }
          if (hasNote) {
            if (closing || rt.store.draining()) {
              sendJson(res, 409, { error: closing ? 'daemon is closing' : 'daemon is draining' });
              return;
            }
            const note = str(body.note, 'note');
            // chatPost checks the live binding and the length of the WHOLE post.
            // No await between its commit and arming: idle drain may begin exit immediately.
            chatPost(rt.store, {
              as: str(body.as, 'as'), session: str(body.session, 'session'), to: 'all',
              body: `Orch pid ${process.pid} will exit when idle. The restart is over when node ops/orchestrator/src/main.ts status prints a different pid with draining null. ${note}`,
            });
          }
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
          return;
        }
        sendJson(res, 200, rt.seats.beginDrain());
        return;
      }
      if (url.pathname === '/lesson-repeat' && req.method === 'POST') {
        const body = await readJson(req, 1024) as { lesson?: unknown; duplicateOf?: unknown } | null;
        if (!body || typeof body !== 'object' || !/^[1-9]\d*$/.test(String(body.lesson)) || !/^[1-9]\d*$/.test(String(body.duplicateOf))) {
          sendJson(res, 400, { error: 'lesson and duplicateOf must be positive ids' });
          return;
        }
        if (String(body.lesson) === String(body.duplicateOf)) {
          sendJson(res, 400, { error: `lesson #${body.lesson} cannot duplicate itself` });
          return;
        }
        sendJson(res, 200, await confirmLessonDuplicate(rt.store, String(body.lesson), String(body.duplicateOf)));
        return;
      }
      // Task 2684 slice B: the domain-lessons hook reports what it delivered to a lead session.
      // Loopback-only like every writer above (rejectReason has already run); the body names the
      // session, the one file the batch is about, and the lessons with the mode they arrived in.
      if (url.pathname === '/lead-lessons' && req.method === 'POST') {
        try {
          const body = await readJson(req, 256 * 1024);
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object');
          for (const key of Object.keys(body)) {
            if (!['session', 'file', 'lessons'].includes(key)) throw new Error(`lead-lessons takes no '${key}'`);
          }
          const input = body as Record<string, unknown>;
          const session = str(input.session, 'session');
          if (session.length > 200) throw new Error('session must be at most 200 characters');
          const file = str(input.file, 'file');
          if (file.length > 1024) throw new Error('file must be at most 1024 characters');
          if (!Array.isArray(input.lessons) || input.lessons.length > 200) throw new Error('lessons must be an array of at most 200 entries');
          const lessons = input.lessons.map((entry) => {
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('each lesson must be a JSON object');
            for (const key of Object.keys(entry)) {
              if (!['id', 'mode'].includes(key)) throw new Error(`a lesson takes no '${key}'`);
            }
            const id = str((entry as Record<string, unknown>).id, 'id');
            if (!/^[1-9]\d{0,17}$/.test(id)) throw new Error('id must be a positive lesson id');
            const mode = (entry as Record<string, unknown>).mode;
            if (mode !== 'full' && mode !== 'indexed') throw new Error('mode must be full or indexed');
            return { id, mode } as { id: string; mode: 'full' | 'indexed' };
          });
          sendJson(res, 200, { recorded: rt.store.recordLeadLessonDelivery(session, file, lessons) });
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
        return;
      }
      // Push hints share the loopback guard above; no Git process runs in the daemon.
      if (url.pathname === '/docs-note' && req.method === 'POST') {
        try {
          const body = await readJson(req, 16 * 1024);
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object');
          for (const key of Object.keys(body)) {
            if (!['owner', 'lines'].includes(key)) throw new Error(`docs-note takes no '${key}'`);
          }
          const input = body as Record<string, unknown>;
          const owner = str(input.owner, 'owner');
          if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 50 ||
            !Array.from(input.lines).every((line) => typeof line === 'string')) {
            throw new Error('lines must be 1-50 strings');
          }
          sendJson(res, 200, chatPostDocsNote(rt.store, owner, input.lines as string[]));
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
        return;
      }
      // The post-commit hook reports a missing check stamp; the shared loopback guard has run.
      if (url.pathname === '/commit-miss' && req.method === 'POST') {
        try {
          const body = await readJson(req, 16 * 1024);
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object');
          for (const key of Object.keys(body)) {
            if (!['sha', 'branch', 'toplevel'].includes(key)) throw new Error(`commit-miss takes no '${key}'`);
          }
          const input = body as Record<string, unknown>;
          const sha = str(input.sha, 'sha');
          if (!/^[A-Fa-f0-9]{7,40}(?![\s\S])/.test(sha)) throw new Error('sha must be 7-40 hex characters');
          if (typeof input.branch !== 'string') throw new Error('branch must be a string');
          const toplevel = str(input.toplevel, 'toplevel');
          if (!path.isAbsolute(toplevel)) throw new Error('toplevel must be an absolute path');
          sendJson(res, 200, chatPostCommitMiss(rt.store,
            `Commit ${sha.slice(0, 7)} on ${input.branch} (${path.basename(toplevel)}) has no check:commit stamp: pre-commit was skipped. Run npm run check:commit on its paths and say why.`));
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
        return;
      }
      // Long-poll for `orch wait`: the digest once the turn ended, or its state after `wait` ms (max 55 s).
      const turnPath = /^\/turns\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
      if (turnPath && req.method === 'GET') {
        const waitMs = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) || 0, 0), 55_000);
        if (!rt.store.getTurn(turnPath[1])) {
          sendJson(res, 404, { error: rt.store.noTurnError(turnPath[1]) });
          return;
        }
        sendJson(res, 200, await rt.seats.digest(await rt.seats.wait(turnPath[1], waitMs)));
        return;
      }
      if (url.pathname === '/mcp') {
        await serveMcp(buildMcpServer(rt, requests, () => [...wakes.keys()]), req, res);
        return;
      }
      // A worker seat's endpoint (scout-request.ts): its token names the seat; nothing else is served here.
      if (url.pathname === SEAT_MCP_PATH || url.pathname === SEAT_SCOUT_PATH) {
        const seatId = scouts.seatOf(req.headers.authorization);
        if (!seatId) {
          rt.log('warn', 'seat.scout_refused', { reason: 'unknown seat token', url: url.pathname });
          sendJson(res, 401, { error: 'unknown seat token' });
          return;
        }
        if (url.pathname === SEAT_MCP_PATH) {
          await serveMcp(buildSeatMcpServer(scouts, seatId), req, res);
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' });
          return;
        }
        let body: unknown;
        try {
          body = await readJson(req, 64 * 1024);
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
          return;
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'body must be a JSON object' });
          return;
        }
        try {
          sendJson(res, 200, { text: await scouts.request(seatId, body as Record<string, unknown>) });
        } catch (error) {
          sendJson(res, 422, { error: (error as Error).message });
        }
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      rt.log('error', 'http.error', { url: req.url, message: (error as Error).message });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    }
  };
  // The span times the handler's synchronous prefix (the run until its first
  // await); continuations after an await are later, unattributed windows.
  const httpServer = createServer((req, res) =>
    span(`http ${req.method} ${(req.url ?? '/').split('?')[0]}`, () => serve(req, res)));
  // 'close' fires only after active responses end; release watchers BEFORE
  // invoking close, for both signal shutdown and the idle-drain lifecycle.
  const close = httpServer.close.bind(httpServer);
  httpServer.close = (callback) => {
    closing = true;
    for (const [session, held] of wakes) finishWake(session, held.res, 503, { error: 'daemon is closing' });
    return close(callback);
  };
  // Node's default 5 s keep-alive destroys an idle pooled socket when the event loop stalls past it inside an I/O callback, before the client's next request is read (the lead's MCP call fails with ECONNRESET and no handler runs); headersTimeout must exceed keepAliveTimeout.
  httpServer.keepAliveTimeout = 75_000;
  httpServer.headersTimeout = 80_000;
  return httpServer;
}
