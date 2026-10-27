// Read-only weekly lesson observations. No missing report is treated as a negative answer.
import { readLessons } from '../../../scripts/memory/service-client.mjs';
import { LESSON_ROLES, parseReport, type ReportRole } from './report.ts';
import { openReadOnlyStore } from './store.ts';

type Delivery = { lesson_id: string; mode: string; applied: number | null; why: string | null; role: string };
type Proposal = { idx: number; state: string; output: string; text: string; role: string };
type Repeat = { lesson_id: string; turn_id: string; seat_id: string; state: string | null; output: string | null };
type LessonRow = { id: number; title: string };

/** Stable --json contract: since (inclusive ISO), until (exclusive ISO), captures
 * {accepted,refused,refusals:[{reason,count}]}, roles:[{role,full,indexed}],
 * lessons:[{id,full,indexed,applied,notApplicable,notReported,reasons:[{reason,count}]}],
 * repeats:[{id,turns,seats,taskId,taskState}], deadWeight
 * {zeroFull:[{id,title}],deliveredNeverApplied:[{id,full}]}. Empty sets are [].
 * Applied/notApplicable count only full deliveries with a valid reported answer.
 * Task ID is null until the task creation output contains a confirmed numeric id.
 */
export type LessonStats = {
  since: string; until: string;
  captures: { accepted: number; refused: number; refusals: { reason: string; count: number }[] };
  roles: { role: string; full: number; indexed: number }[];
  lessons: { id: string; full: number; indexed: number; applied: number; notApplicable: number; notReported: number; reasons: { reason: string; count: number }[] }[];
  repeats: { id: string; turns: string[]; seats: string[]; taskId: number | null; taskState: string | null }[];
  deadWeight: { zeroFull: LessonRow[]; deliveredNeverApplied: { id: string; full: number }[] };
};

const counted = (map: Map<string, number>) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => ({ reason, count }));
const increment = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
// Human-only titles; keep them off the stable --json payload.
const humanTitles = new WeakMap<LessonStats, Map<string, string>>();

/** The memoryctl log envelope is metadata, not the first refusal line. */
export function withoutRefusalLogEnvelopes(text: string): string {
  return text.split(/\r?\n/).filter((raw) => {
    const line = raw.trim();
    if (!line.startsWith('{')) return true;
    try {
      const value: unknown = JSON.parse(line);
      return !(value !== null && typeof value === 'object' && !Array.isArray(value) && 'ts' in value && 'sha256' in value);
    } catch { return true; /* A plain refusal may start with '{'. */ }
  }).join('\n');
}

export function refusalReasons(text: string): string[] {
  const lines: string[] = [];
  let terminalError: string | null = null;
  for (const raw of withoutRefusalLogEnvelopes(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const value: unknown = JSON.parse(line);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)
          && 'error' in value && typeof value.error === 'string' && value.error.trim()) terminalError = value.error.trim();
      } catch { /* A plain refusal may start with '{'. */ }
    }
    lines.push(line);
  }
  // A memoryctl error is the terminal refusal, even if earlier lines were advisory.
  if (terminalError) return [terminalError];
  const first = lines[0];
  if (!first) return ['unspecified refusal'];
  if (/^lesson (?:write gate )?refused:$/.test(first) && lines[1]) {
    // Each rejected field counts once; length, Jev score and target are per-row metadata.
    const fields = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const detail = /^([a-z][\w-]*):\s*(?:\d+ chars \/ \d+;\s*)?(?:Jev brief=[^;]+;\s*)?(.+)$/i.exec(line);
      if (detail && !fields.has(detail[1].toLowerCase())) {
        fields.set(detail[1].toLowerCase(), `${detail[1]}: ${detail[2].replace(/;\s*target\s*~\d+\b/gi, '').trim()}`);
      }
    }
    return fields.size ? [...fields.values()] : [`${first} ${lines[1]}`];
  }
  return [first];
}

export async function readLessonStats(file: string, since: string, until = new Date().toISOString(),
  activeLessons: () => Promise<LessonRow[]> = async () => (await readLessons({}, { status: 'active' })).map((row: LessonRow) => ({ id: row.id, title: row.title }))): Promise<LessonStats> {
  const db = openReadOnlyStore(file);
  let deliveries: Delivery[]; let proposals: Proposal[]; let repeats: Repeat[];
  try {
    deliveries = db.prepare(`SELECT d.lesson_id, d.mode, d.applied, d.why, s.role FROM lesson_deliveries d
      JOIN seats s ON s.id = d.seat_id WHERE d.delivered_at >= ? AND d.delivered_at < ?`).all(since, until) as Delivery[];
    // Task 2684: a lead's deliveries have no seat to join, so they read as role 'lead'. A store the
    // v15 migration has not reached yet (read-only open never migrates) simply has no table yet.
    const leadTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lead_lesson_deliveries'").get();
    const lead: Omit<Delivery, 'role'>[] = leadTable
      ? db.prepare('SELECT lesson_id, mode, applied, why FROM lead_lesson_deliveries WHERE delivered_at >= ? AND delivered_at < ?').all(since, until) as Omit<Delivery, 'role'>[]
      : [];
    deliveries = [...deliveries, ...lead.map((row) => ({ ...row, role: 'lead' }))];
    proposals = db.prepare(`SELECT a.idx, a.state, a.output, t.text, s.role FROM memory_proposal_applications a
      JOIN turns t ON t.id = a.turn_id JOIN seats s ON s.id = t.seat_id
      WHERE t.ended_at >= ? AND t.ended_at < ?`).all(since, until) as Proposal[];
    repeats = db.prepare(`SELECT r.lesson_id, r.turn_id, r.seat_id, k.state, k.output FROM lesson_repeats r
      JOIN turns t ON t.id = r.turn_id LEFT JOIN lesson_repeat_tasks k ON k.lesson_id = r.lesson_id
      WHERE t.ended_at >= ? AND t.ended_at < ?`).all(since, until) as Repeat[];
  } finally { db.close(); }

  const roles = new Map<string, { role: string; full: number; indexed: number }>();
  const lessons = new Map<string, LessonStats['lessons'][number] & { whyCounts: Map<string, number> }>();
  for (const d of deliveries) {
    const role = roles.get(d.role) ?? { role: d.role, full: 0, indexed: 0 };
    role[d.mode as 'full' | 'indexed']++; roles.set(d.role, role);
    const lesson = lessons.get(d.lesson_id) ?? { id: d.lesson_id, full: 0, indexed: 0, applied: 0, notApplicable: 0, notReported: 0, reasons: [], whyCounts: new Map() };
    lesson[d.mode as 'full' | 'indexed']++;
    if (d.mode === 'full') {
      if (d.applied === 1) lesson.applied++;
      else if (d.applied === 0) { lesson.notApplicable++; increment(lesson.whyCounts, d.why ?? ''); }
      else lesson.notReported++;
    }
    lessons.set(d.lesson_id, lesson);
  }
  const refusals = new Map<string, number>();
  let accepted = 0; let refused = 0;
  for (const row of proposals) {
    const report = row.text && LESSON_ROLES.has(row.role as ReportRole)
      ? parseReport(row.text, row.role as ReportRole, [], { stored: true }) : null;
    if (!report?.ok || !Array.isArray(report.report.memory)) continue;
    const proposal = report.report.memory[row.idx];
    if (!proposal || proposal.kind !== 'lesson' || proposal.op !== 'append') continue;
    if (row.state === 'applied') accepted++;
    else if (row.state === 'refused') {
      refused++;
      const result = JSON.parse(row.output) as { text?: string };
      for (const reason of refusalReasons(result.text ?? '')) increment(refusals, reason);
    }
  }
  return aggregateCaptures({ since, until, repeats, roles, lessons, refusals, accepted, refused, activeLessons });
}

async function aggregateCaptures(input: {
  since: string; until: string; repeats: Repeat[];
  roles: Map<string, LessonStats['roles'][number]>;
  lessons: Map<string, LessonStats['lessons'][number] & { whyCounts: Map<string, number> }>;
  refusals: Map<string, number>; accepted: number; refused: number; activeLessons: () => Promise<LessonRow[]>;
}): Promise<LessonStats> {
  const { since, until, roles, lessons, repeats, refusals, activeLessons } = input;
  const active = await activeLessons();
  const lessonRows = [...lessons.values()].sort((a, b) => a.id.localeCompare(b.id)).map(({ whyCounts, ...row }) => ({ ...row, reasons: counted(whyCounts) }));
  const groups = new Map<string, { turns: Set<string>; seats: Set<string>; state: string | null; output: string | null }>();
  for (const r of repeats) {
    const group = groups.get(r.lesson_id) ?? { turns: new Set<string>(), seats: new Set<string>(), state: r.state, output: r.output };
    group.turns.add(r.turn_id); group.seats.add(r.seat_id); groups.set(r.lesson_id, group);
  }
  const result: LessonStats = { since, until,
    captures: { accepted: input.accepted, refused: input.refused, refusals: counted(refusals) },
    roles: [...roles.values()].sort((a, b) => a.role.localeCompare(b.role)), lessons: lessonRows,
    repeats: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([id, group]) => ({ id,
      turns: [...group.turns].sort(), seats: [...group.seats].sort(),
      taskId: group.state === 'created' ? Number(/"id"\s*:\s*(\d+)/.exec(group.output ?? '')?.[1] ?? NaN) || null : null,
      taskState: group.state })),
    deadWeight: { zeroFull: active.filter((row) => (lessons.get(String(row.id))?.full ?? 0) === 0).sort((a, b) => a.id - b.id),
      deliveredNeverApplied: lessonRows.filter((row) => row.notApplicable >= 3 && row.applied === 0).map(({ id, full }) => ({ id, full })) },
  };
  humanTitles.set(result, new Map(active.map(({ id, title }) => [String(id), title])));
  return result;
}

function limitedList(items: unknown[]): string {
  const first = items.slice(0, 10);
  return JSON.stringify(first, (_key, value: unknown) => Array.isArray(value) && value.length > 10
    ? { first: value.slice(0, 10), more: `+${value.length - 10} more (use --json)` } : value)
    + (items.length > 10 ? ` +${items.length - 10} more (use --json)` : '');
}

export function formatLessonStats(result: LessonStats): string {
  const titles = humanTitles.get(result);
  const neverApplied = result.lessons.filter((row) => row.notApplicable >= 3 && row.applied === 0).map((lesson) => {
    const title = titles?.get(lesson.id);
    const label = title === undefined ? '(not active)' : JSON.stringify(title);
    return `  ${lesson.id} ${label}: full: ${lesson.full}, indexed: ${lesson.indexed}, applied: ${lesson.applied}, notApplicable: ${lesson.notApplicable}, notReported: ${lesson.notReported}`;
  });
  return `lesson-stats ${result.since}..${result.until}\ncaptures: ${result.captures.accepted} accepted, ${result.captures.refused} refused\n`
    + `refusals: ${limitedList(result.captures.refusals)}\nroles: ${limitedList(result.roles)}\n`
    + `lessons: ${limitedList(result.lessons)}\nrepeats: ${limitedList(result.repeats)}\n`
    + `zeroFull: ${result.deadWeight.zeroFull.length} active lessons not delivered in full\n`
    + `deliveredNeverApplied:\n${neverApplied.join('\n')}`;
}
