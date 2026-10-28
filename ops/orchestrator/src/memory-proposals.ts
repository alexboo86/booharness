// Report proposals are data for the lead; lesson capture is a manual decision.
// The validated final text is the durable proposal snapshot across restarts.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Store } from './store.ts';
import { parseReport, type ReportRole } from './report.ts';
import { reviewRights } from './seats-defs.ts';
import { tableContractOf } from './seats-scope.ts';
import { refusalReasons, withoutRefusalLogEnvelopes } from './lesson-stats.ts';
import { resolveMemoryctl, spawnPlan } from '../../../scripts/memory/lesson-lib.mjs';
import { gateNewLesson } from '../../../scripts/memory/capture-gate.mjs';
import { lessonFields } from '../../../scripts/memory/lesson-quality.mjs';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const KINDS = ['lesson', 'decision', 'feedback', 'reference', 'project'];
const MAX_PROPOSALS = 12;
export type MemoryProposal = { op: 'append' | 'supersede' | 'retire'; id?: number; kind: string; title: string; body: string; links?: Record<string, unknown>; reason: string };

export function checkMemory(value: unknown): string[] {
  if (!Array.isArray(value)) return ['memory must be an array'];
  const errors: string[] = [];
  if (value.length > MAX_PROPOSALS) errors.push(`memory has ${value.length} entries > ${MAX_PROPOSALS}`);
  for (const [i, item] of value.entries()) {
    const name = `memory[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${name} must be an object`); continue; }
    const p = item as Record<string, unknown>;
    for (const key of Object.keys(p)) if (!['op', 'id', 'kind', 'title', 'body', 'links', 'reason'].includes(key)) errors.push(`${name} unknown key '${key}'`);
    if (!['append', 'supersede', 'retire'].includes(p.op as string)) errors.push(`${name}.op must be append|supersede|retire`);
    if (!KINDS.includes(p.kind as string)) errors.push(`${name}.kind must be ${KINDS.join('|')}`);
    if (p.op === 'append' && p.id !== undefined) errors.push(`${name}.id is only for supersede/retire`);
    if ((p.op === 'supersede' || p.op === 'retire') && (!Number.isSafeInteger(p.id) || (p.id as number) <= 0)) errors.push(`${name}.id must be a positive integer`);
    if (p.op === 'retire' && p.kind !== 'lesson') errors.push(`${name}.kind must be lesson for retire`);
    for (const [field, max] of [['title', 480], ['body', 4000], ['reason', 400]] as const) {
      if (typeof p[field] !== 'string' || !p[field].trim() || p[field].length > max) errors.push(`${name}.${field} must be non-empty text of at most ${max} characters`);
    }
    if (p.links !== undefined && (p.op === 'retire' || !p.links || typeof p.links !== 'object' || Array.isArray(p.links) || JSON.stringify(p.links).length > 1000)) errors.push(`${name}.links must be an object up to 1000 characters, only for append/supersede`);
  }
  return errors;
}

// An attempt is reserved before invoking an external process. An abandoned
// 'running' row cannot be replayed automatically: the CLI may have succeeded
// before orch died. A refusal may be explicitly retried after the gate is fixed.
function ledger(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS memory_proposal_applications (
    turn_id TEXT NOT NULL REFERENCES turns(id), idx INTEGER NOT NULL,
    state TEXT NOT NULL, output TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(turn_id, idx)
  )`);
}

// curl (7) and a refused TCP connect on the single task-create request prove it
// never reached memoryd; anything else may have landed.
const NOT_SENT = /curl:\s*\(7\)|\bECONNREFUSED\b|\bconnection refused\b|\bcould not connect\b/i;

export type ApplyResult = { index: number; status: 'applied' | 'refused' | 'already_applied' | 'uncertain' | 'deferred'; id?: number; text: string; substitution?: string; repairTurn?: string; deferred?: { file: string; at: string } };

export type BrevityField = { field: string; length: number; limit: number; target: number; ceiling: boolean };

/** Only a refusal made entirely of field brevity objections may be sent back to its author. */
export function brevityFields(text: string): BrevityField[] {
  // memoryctl's own re-check adds a trailer and may add a Jev-skip notice; neither is a reason.
  const lines = withoutRefusalLogEnvelopes(text).trim().split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !/^memoryctl: lesson write refused$/.test(line) && !/^lesson: Jev skipped or unanswered for\b/.test(line));
  if (!/^lesson (?:write gate )?refused:$/i.test(lines.shift() ?? '') || !lines.length) return [];
  const fields: BrevityField[] = [];
  for (const line of lines) {
    // Decision #12433: brevity is a code-point ceiling breach only; the target is advice.
    const ceiling = /^(title|rule|why|evidence|trigger): (\d+) chars \/ (\d+); --long reason required(?:; target ~(\d+) \(advice\))?$/.exec(line);
    if (ceiling) {
      fields.push({ field: ceiling[1], length: Number(ceiling[2]), limit: Number(ceiling[3]), target: Number(ceiling[4] ?? ceiling[3]), ceiling: true });
      continue;
    }
    // Jev-era format: a stale memoryctl install may still print it.
    const match = /^(title|rule|why|evidence|trigger): (\d+) chars \/ (\d+); Jev brief=(?:yes \(\d+\.\d{2}\)|no \(\d+\.\d{2}\)|skipped)(?:, needed explanation=(?:yes \(\d+\.\d{2}\)|no \(\d+\.\d{2}\)|skipped))?; (?:Jev brevity objection; shorten this field or supply --long|--long reason required)(?:; target ~(\d+))?$/.exec(line);
    if (!match || (!match[4] && match[1] !== 'trigger')) return [];
    fields.push({ field: match[1], length: Number(match[2]), limit: Number(match[3]), target: Number(match[4] ?? match[3]), ceiling: !match[4] });
  }
  return fields;
}

export type LessonApplication = { index: number; title: string; outcome: string };

/** Preserve durable historical outcomes while new proposals await the lead's decision. */
export function lessonApplications(store: Store, turnId: string, proposals: MemoryProposal[]): LessonApplication[] {
  const rows = store.db.prepare('SELECT idx, state, output FROM memory_proposal_applications WHERE turn_id = ?')
    .all(turnId) as { idx: number; state: string; output: string }[];
  const byIndex = new Map(rows.map((row) => [row.idx, row]));
  return proposals.flatMap((proposal, index) => {
    if (proposal.op !== 'append' || proposal.kind !== 'lesson') return [];
    const row = byIndex.get(index);
    let outcome: string;
    if (!row) outcome = 'proposed (lead capture: node scripts/memory/capture-lesson.mjs)';
    else if (row.state === 'applied') {
      const saved = JSON.parse(row.output) as ApplyResult;
      outcome = saved.id === undefined ? 'applied (id not recorded; check memory)' : `applied #${saved.id}`;
      if (saved.substitution) outcome += ` · ${saved.substitution}`;
    } else if (row.state === 'deferred') {
      outcome = `deferred: awaiting commit of ${(JSON.parse(row.output) as ApplyResult).deferred?.file} (legacy proposal; lead capture required)`;
    } else if (row.state === 'refused') {
      const saved = JSON.parse(row.output) as ApplyResult;
      outcome = saved.repairTurn ? `refused (brevity) — repair queued ${saved.repairTurn}` : `refused: ${refusalReasons(saved.text)[0]} · rewrite with node scripts/memory/capture-lesson.mjs`;
    } else if (row.state === 'retryable' || row.state === 'gate') outcome = 'retryable (lead action required)';
    else outcome = 'uncertain (check memory before re-applying)';
    return [{ index, title: proposal.title, outcome }];
  });
}
type Preview = { index: number; proposal: MemoryProposal; current?: { kind: string; title: string; status?: unknown; globs?: unknown } };

type LiveLesson = { title: string; body: string; links: Record<string, unknown> };

// The Windows entry point is a .cmd shim for an extensionless Git Bash script.
// execFile cannot run either directly; spawnPlan preserves argv without cmd.exe parsing.
function memoryctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const plan = spawnPlan(resolveMemoryctl(ROOT), args);
  return exec(plan.file, plan.argv, { cwd: ROOT, timeout: 30000, maxBuffer: 65536 });
}

/** The real gate walks git refs synchronously. Run it in a child, never on the
 * daemon event loop. Tests may supply a child script with a slow gate. */
export async function runLessonGate(input: Parameters<typeof gateNewLesson>[0], script = fileURLToPath(new URL('./lesson-gate-child.mjs', import.meta.url))): Promise<Awaited<ReturnType<typeof gateNewLesson>>> {
  try {
    const { stdout } = await exec(process.execPath, [script, JSON.stringify(input)], { cwd: ROOT, timeout: 120000, maxBuffer: 65536 });
    return JSON.parse(stdout) as Awaited<ReturnType<typeof gateNewLesson>>;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

async function liveLesson(id: number, client: typeof memoryctl = memoryctl): Promise<LiveLesson> {
  const { stdout } = await client(['get', '--id', String(id), '--json']);
  const row = JSON.parse(stdout) as Record<string, unknown>;
  const links = typeof row.links === 'string' ? JSON.parse(row.links) as unknown : row.links;
  if (row.kind !== 'lesson' || row.live === false || typeof row.title !== 'string' || typeof row.body !== 'string'
    || !links || typeof links !== 'object' || Array.isArray(links)
    || typeof (links as Record<string, unknown>).domain !== 'string'
    || typeof (links as Record<string, unknown>).anchor !== 'string') {
    throw new Error(`memoryctl get ${id} returned no live lesson with domain/anchor`);
  }
  return { title: row.title, body: row.body, links: links as Record<string, unknown> };
}

// One field per line: a proposal's free text must not create a second lesson header.
function field(text: string): string { return text.trim().replace(/\r?\n/g, '\n  '); }

const inFlight = new WeakMap<Store, Map<string, Promise<void>>>();

export async function applyMemory(store: Store, turnId: string, pick?: number[], confirm = false, gate: typeof gateNewLesson = runLessonGate, client: typeof memoryctl = memoryctl): Promise<{ turn: string; results: ApplyResult[] } | { turn: string; preview: Preview[] }> {
  const turn = store.getTurn(turnId);
  if (!turn || turn.status !== 'done' || !turn.text) throw new Error(`turn '${turnId}' has no completed report`);
  const seat = store.getSeat(turn.seat_id);
  if (!seat) throw new Error(`no seat for turn '${turnId}'`);
  const lessons = store.lessonDeliveries(turnId).filter((row) => row.mode === 'full').map((row) => row.lesson_id);
  const parsed = parseReport(turn.text, seat.role as ReportRole, lessons, { stored: true, table: tableContractOf(seat) });
  if (parsed.ok === false) throw new Error(`turn '${turnId}' has no valid report: ${parsed.error}`);
  const proposals = (parsed.report.memory ?? []) as MemoryProposal[];
  if (!proposals.length) throw new Error(`turn '${turnId}' has no memory proposals`);
  const indexes = pick ?? proposals.map((_, index) => index);
  if (!Array.isArray(indexes) || !indexes.length || new Set(indexes).size !== indexes.length || indexes.some((n) => !Number.isSafeInteger(n) || n < 0 || n >= proposals.length)) throw new Error('pick must be distinct zero-based proposal indexes in range');
  if (!confirm && indexes.some((index) => proposals[index].op !== 'append')) {
    const preview: Preview[] = [];
    // Resolve every old entry before returning anything. A failed lookup cannot
    // accidentally turn a partial preview into an approval or a write.
    for (const index of indexes) {
      const proposal = proposals[index];
      if (proposal.op === 'append') { preview.push({ index, proposal }); continue; }
      if (proposal.kind === 'lesson') {
        const current = await liveLesson(proposal.id!, client);
        preview.push({ index, proposal, current: { kind: 'lesson', title: current.title, status: current.links.status ?? null, globs: current.links.globs ?? null } });
      } else {
        const { stdout } = await client(['get', '--id', String(proposal.id), '--json']);
        const current = JSON.parse(stdout) as Record<string, unknown>;
        if (typeof current.kind !== 'string' || typeof current.title !== 'string') throw new Error(`memoryctl get ${proposal.id} returned no kind/title`);
        preview.push({ index, proposal, current: { kind: current.kind, title: current.title } });
      }
    }
    return { turn: turnId, preview };
  }
  ledger(store);
  const results: ApplyResult[] = [];
  if (!inFlight.has(store)) inFlight.set(store, new Map());
  const flights = inFlight.get(store)!;
  for (const index of indexes) {
    // Concurrent explicit applications serialize before reading the previous writer's row.
    const key = `${turnId}\0${index}`;
    for (let flight = flights.get(key); flight; flight = flights.get(key)) await flight;
    let release!: () => void;
    flights.set(key, new Promise<void>((resolve) => { release = resolve; }));
    try {
      const prior = store.db.prepare('SELECT state, output FROM memory_proposal_applications WHERE turn_id = ? AND idx = ?').get(turnId, index) as { state: string; output: string } | undefined;
      if (prior?.state === 'applied') {
        const saved = JSON.parse(prior.output) as ApplyResult;
        results.push({ ...saved, status: 'already_applied' });
        continue;
      }
      if (prior?.state === 'running' || prior?.state === 'uncertain' || prior?.state === 'gate') {
        results.push({ index, status: 'uncertain', text: 'Previous attempt may have written memory; inspect memory before retrying.' });
        break;
      }
      // 'gate' and 'retryable' never reached the memoryctl append. The legacy
      // 'running' state has no such proof and must remain uncertain.
      const proposal = proposals[index];
      let lesson: LiveLesson | null = null;
      if (proposal.kind === 'lesson' && proposal.op !== 'append') {
        try { lesson = await liveLesson(proposal.id!, client); }
        catch (error) {
          const failure = error as Error & { stderr?: string; stdout?: string };
          const result: ApplyResult = { index, status: 'refused', text: String(failure.stderr || failure.stdout || failure.message).trim() };
          store.db.prepare("INSERT INTO memory_proposal_applications(turn_id, idx, state, output) VALUES (?, ?, 'refused', ?) ON CONFLICT(turn_id, idx) DO UPDATE SET state = 'refused', output = excluded.output")
            .run(turnId, index, JSON.stringify(result));
          results.push(result);
          break; // No write was attempted; a failed get must remain retryable.
        }
        // The read awaited a subprocess. Another apply may have reserved this index meanwhile.
        const afterRead = store.db.prepare('SELECT state, output FROM memory_proposal_applications WHERE turn_id = ? AND idx = ?').get(turnId, index) as { state: string; output: string } | undefined;
        if (afterRead?.state === 'applied') {
          results.push({ ...(JSON.parse(afterRead.output) as ApplyResult), status: 'already_applied' });
          continue;
        }
        if (afterRead?.state === 'running' || afterRead?.state === 'uncertain') {
          results.push({ index, status: 'uncertain', text: 'Previous attempt may have written memory; inspect memory before retrying.' });
          break;
        }
      }
      // The old trigger and evidence must be read exactly as the supersede gate reads them:
      // lessonFields takes the LAST duplicate value and accepts any whitespace after the dash,
      // where a first-match regex silently replaced a duplicated trigger/evidence or dropped a
      // spaced header (refused '--trigger is required'). The gate's input is the body line, never links.trigger.
      const oldFields = lesson ? lessonFields(lesson.title, lesson.body, { partial: true, allowDuplicates: true }) : undefined;
      const oldEvidence = oldFields?.evidence?.trim() || undefined;
      const oldTrigger = oldFields?.trigger?.trim() || undefined;
      if (proposal.op === 'retire' && !oldEvidence && [...proposal.body.trim()].length > 400) {
        const result: ApplyResult = { index, status: 'refused', text: 'retirement evidence exceeds 400 characters; supply concise evidence without dropping facts' };
        store.db.prepare("INSERT INTO memory_proposal_applications(turn_id, idx, state, output) VALUES (?, ?, 'refused', ?) ON CONFLICT(turn_id, idx) DO UPDATE SET state = 'refused', output = excluded.output")
          .run(turnId, index, JSON.stringify(result));
        results.push(result);
        break;
      }
      // Reserve the gate phase before its first await. A crash here cannot have
      // written memory; only the append phase becomes ambiguous after restart.
      store.db.prepare(`INSERT INTO memory_proposal_applications(turn_id, idx, state) VALUES (?, ?, 'gate')
        ON CONFLICT(turn_id, idx) DO UPDATE SET state = 'gate', output = ''`).run(turnId, index);
      let result: ApplyResult;
      let writeStarted = false;
      try {
        const links = lesson ? { ...lesson.links, ...(proposal.links?.trigger === undefined ? {} : { trigger: proposal.links.trigger }),
          status: proposal.op === 'retire' ? 'retired' : lesson.links.status ?? 'active' }
          : proposal.kind === 'lesson' && proposal.op === 'append'
            ? await gate({ title: proposal.title, body: proposal.body, links: proposal.links }) : proposal.links;
        const substitution = proposal.op === 'append' && proposal.kind === 'lesson' && links?.domain !== proposal.links?.domain
          ? `domain ${proposal.links?.domain} -> ${links?.domain}: routed for ${String(proposal.links?.anchor).split(':')[0]}` : undefined;
        const title = proposal.op === 'retire' ? `RETIRED: ${lesson!.title}` : proposal.title;
        const body = proposal.op === 'retire'
          ? `${oldTrigger === undefined ? '' : `- trigger: ${field(oldTrigger)}\n`}- rule: Retired; do not apply\n- why: ${field(proposal.reason)}\n- evidence: ${field(oldEvidence || proposal.body)}\n`
          : proposal.body;
        const directory = await mkdtemp(path.join(os.tmpdir(), 'orch-memory-'));
        try {
          const args = [proposal.op === 'retire' ? 'supersede' : proposal.op,
            ...(proposal.op === 'append' ? ['--kind', proposal.kind] : ['--id', String(proposal.id)]),
            '--title-file', path.join(directory, 'title.txt'), '--body-file', path.join(directory, 'body.md'), ...(links ? ['--links', JSON.stringify(links)] : [])];
          await writeFile(path.join(directory, 'title.txt'), title, 'utf8');
          await writeFile(path.join(directory, 'body.md'), body, 'utf8');
          // From this boundary a child process may have reached memoryd; never
          // auto-replay 'running' or an uncertain result after a restart.
          store.db.prepare("UPDATE memory_proposal_applications SET state = 'running' WHERE turn_id = ? AND idx = ?").run(turnId, index);
          writeStarted = true;
          const { stdout } = await client(args);
          const text = stdout.trim().slice(0, 2000);
          const found = /"id"\s*:\s*(\d+)/.exec(text) ?? /(?:^|\s)id[=:](\d+)/.exec(text);
          result = { index, status: 'applied', ...(found ? { id: Number(found[1]) } : proposal.op === 'retire' ? { id: proposal.id } : {}), text: substitution ? `${text}\n${substitution}` : text, ...(substitution ? { substitution } : {}) };
        } finally { await rm(directory, { recursive: true, force: true }); }
      } catch (error) {
        const failure = error as Error & { stderr?: string; stdout?: string };
        // Once append may have started, ONLY a definite content-gate refusal proves
        // no write happened. An unclassified failure is not permission to retry.
        // A definite gate refusal must reach the lead in full, including its repair instructions.
        const text = String(failure.stderr || failure.stdout || failure.message).trim();
        // A closed-duplicate 409 carries the stable marker in its JSON body (the
        // store's details.refusal), which the CLI prints before its conflict
        // line. The store throws that refusal before any insert, so like a gate
        // refusal it is a FINAL no-write refusal, never uncertain (task 2800).
        const definiteRefusal = /^(?:lesson refused:|lesson (?:write )?gate(?: refused)?:)/i.test(withoutRefusalLogEnvelopes(text).trimStart())
          || /"refusal"\s*:\s*"closed-duplicate"/.test(text);
        // A connect failure is not proof either: memoryctl's append makes more than one request (task 1484).
        const uncertain = writeStarted && !definiteRefusal;
        result = { index, status: uncertain ? 'uncertain' : 'refused', text: uncertain ? text.slice(0, 2000) : text };
      }
      const state = result.status === 'refused' && (!writeStarted && (gateOutage(result.text) || !withoutRefusalLogEnvelopes(result.text).trimStart().startsWith('lesson refused:')))
        ? 'retryable' : result.status;
      store.db.prepare('UPDATE memory_proposal_applications SET state = ?, output = ? WHERE turn_id = ? AND idx = ?')
        .run(state, JSON.stringify(result), turnId, index);
      results.push(result);
      if (result.status !== 'applied') break;
    } finally {
      flights.delete(key);
      release();
    }
  }
  return { turn: turnId, results };
}

function gateOutage(text: string): boolean {
  return /lesson refused: (?:Jev unavailable|cannot compare active lessons)/i.test(text);
}

/** The daemon owns repeat writes; a confirmed duplicate uses the same path as legacy refusals. */
export async function recordLessonRepeat(store: Store, turnId: string, index: number, lessonId: string, client: typeof memoryctl = memoryctl): Promise<{ recorded: boolean; task: { state: string; id: number | null } | null }> {
    const turn = store.getTurn(turnId);
    if (!turn?.ended_at) throw new Error(`no ended turn '${turnId}'`);
    const seat = store.getSeat(turn.seat_id);
    if (!seat) throw new Error(`no seat for turn '${turnId}'`);
    const earlier = store.db.prepare(`SELECT 1 FROM lesson_deliveries d JOIN seats s ON s.id = d.seat_id
      WHERE d.lesson_id = ? AND d.turn_id != ? AND d.delivered_at <= ?
        AND (d.seat_id = ? OR (s.title = ? AND COALESCE(json_extract(s.data, '$.main'), '') = ?)) LIMIT 1`)
      .get(lessonId, turnId, turn.ended_at, seat.id, seat.title, String(seat.data.main ?? '')) as unknown;
    const author = reviewRights(seat.role) && typeof seat.data.author === 'string' && seat.data.author ? seat.data.author : null;
    const authorDelivery = !earlier && author && store.db.prepare(`SELECT 1 FROM lesson_deliveries
      WHERE lesson_id = ? AND seat_id = ? AND mode = 'full' AND delivered_at <= ? LIMIT 1`)
      .get(lessonId, author, turn.ended_at);
    if (!earlier && !authorDelivery) return { recorded: false, task: null };
    store.db.prepare('INSERT OR IGNORE INTO lesson_repeats(turn_id, idx, lesson_id, seat_id) VALUES (?, ?, ?, ?)')
      .run(turnId, index, lessonId, seat.id);
    // A task already created (or with ambiguous delivery) needs no further read.
    const priorTask = store.db.prepare('SELECT state FROM lesson_repeat_tasks WHERE lesson_id = ?').get(lessonId) as { state: string } | undefined;
    const taskResult = () => {
      const row = store.db.prepare('SELECT state, output FROM lesson_repeat_tasks WHERE lesson_id = ?').get(lessonId) as { state: string; output: string } | undefined;
      let id: number | null = null;
      if (row?.state === 'created') {
        try { const parsed = JSON.parse(row.output) as { id?: unknown }; if (Number.isSafeInteger(parsed.id)) id = parsed.id as number; }
        catch { id = Number(/(?:task\s*)?#(\d+)/i.exec(row.output)?.[1]) || null; }
      }
      return { recorded: true, task: row ? { state: row.state, id } : null };
    };
    if (priorTask && priorTask.state !== 'retryable') return taskResult();
    // A failed read has written nothing and leaves no reservation: next recovery
    // or repeat may retry it. Reserve synchronously only after obtaining the title.
    let title: string;
    try {
      const current = await client(['get', '--id', lessonId, '--json']);
      const value = (JSON.parse(current.stdout) as { title?: unknown }).title;
      if (typeof value !== 'string' || !value.trim()) throw new Error(`memoryctl get ${lessonId} returned no lesson title`);
      title = value;
    } catch { return taskResult(); }
    // After reserving, a task create may have reached memoryd: no second create.
    const reserved = store.db.prepare(`INSERT INTO lesson_repeat_tasks(lesson_id, state) VALUES (?, 'uncertain')
      ON CONFLICT(lesson_id) DO UPDATE SET state = 'uncertain', output = '' WHERE state = 'retryable'`).run(lessonId);
    if (!reserved.changes) return taskResult();
    try {
      const { stdout } = await client(['task', 'create', '--title', `Repeated lesson #${lessonId}: ${title}`, '--priority', 'P1', '--next', `Turn lesson #${lessonId} into a mechanical check (repeat at ${turnId}, ${seat.id}${author ? ` reviewing ${author}` : ''})`]);
      store.db.prepare("UPDATE lesson_repeat_tasks SET state = 'created', output = ? WHERE lesson_id = ?").run(stdout.trim(), lessonId);
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      const text = String(failure.stderr || failure.message);
      // Anything but a proven pre-send failure may have created the task; keep it uncertain.
      const state = NOT_SENT.test(text) ? 'retryable' : 'uncertain';
      store.db.prepare('UPDATE lesson_repeat_tasks SET state = ?, output = ? WHERE lesson_id = ?').run(state, text, lessonId);
    }
    return taskResult();
}

/** Only a successful append ledger row proves orch authored this lesson. */
export async function confirmLessonDuplicate(store: Store, lessonId: string, duplicateOf: string, client: typeof memoryctl = memoryctl) {
  if (lessonId === duplicateOf) throw new Error(`lesson #${lessonId} cannot duplicate itself`);
  const rows = store.db.prepare(`SELECT a.turn_id, a.idx FROM memory_proposal_applications a
    JOIN turns t ON t.id = a.turn_id
    WHERE a.state = 'applied' AND json_valid(a.output) AND CAST(json_extract(a.output, '$.id') AS TEXT) = ?
    ORDER BY t.ended_at, a.turn_id, a.idx`).all(lessonId) as { turn_id: string; idx: number }[];
  for (const row of rows) {
    const result = await recordLessonRepeat(store, row.turn_id, row.idx, duplicateOf, client);
    if (result.recorded) return { lesson: lessonId, duplicateOf, provenance: true, ...result };
  }
  return { lesson: lessonId, duplicateOf, provenance: rows.length > 0, recorded: false, task: null };
}
