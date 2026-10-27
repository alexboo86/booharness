// Pure task helpers lifted out of store.mjs (large-file seam).
// They close over no database handle and no prepared statement.
// HttpError lives here so a refusal from these helpers is the same class
// the request path checks with `instanceof HttpError`.

export class HttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Closed means "needs no further work". Everything else is a live tail and can
// be named by a handoff.
export const TASK_CLOSED_STATUSES = new Set(['done', 'cancelled']);

// Advisory only: callers supply the existing task reader after explicit closures.
export function namedOpenTasks(entry, entryId, readTask) {
  const named = [];
  const seen = new Set();
  const mentions = `${entry.title}\n${entry.body}`.matchAll(/\btasks?\s+#?\d+\b(?:\s*,\s*#?\d+\b)*/gi);
  for (const [mention] of mentions) {
    for (const digits of mention.matchAll(/\d+/g)) {
      const id = Number(digits[0]);
      if (!Number.isSafeInteger(id) || seen.has(id)) continue;
      seen.add(id);
      const task = readTask(id);
      if (!task || TASK_CLOSED_STATUSES.has(task.status)) continue;
      named.push({ id, title: task.title, done: `memoryctl task done --id ${id} --evidence ${entryId}` });
      if (named.length === 10) return named;
    }
  }
  return named;
}

export function handoffWritePayload(result) {
  return {
    id: result.id,
    uuid: result.uuid,
    dedup: result.dedup,
    ...(result.open_tasks_named?.length ? { open_tasks_named: result.open_tasks_named } : {}),
  };
}

// How alike two task titles have to be before creating the second one is
// refused, as a Jaccard overlap of their word sets.
//
// 0.8, and the number is a measurement rather than a taste. Measured
// 2026-08-20 over this store's own 750 tasks (200 live, 550 closed):
//
//   * open against open: the HIGHEST similarity in 200 tasks is 0.286, two
//     different phases of one track. There is no such thing as a duplicate
//     open task here, and a gate that only watched them would have fired zero
//     times ever - the shape of the brief path scanner that was removed for
//     exactly that (55 refusals, nothing caught);
//   * open against CLOSED: four pairs at or above this threshold, and every
//     one is a real duplicate - #665/#669 and #664/#668 word for word,
//     #430/#431 differing only in capitalisation, #21/#25 by one leading verb.
//
// The price is named rather than hidden: #220/#221 is also a duplicate and
// scores 0.727, so this threshold lets it through. Lowering it to catch that
// one would reach 0.714, where "Разбор консолидации памяти 2026-08-06" and the
// same title dated 08-03 sit - two rounds of a RECURRING task, and refusing
// those would break the one workflow that legitimately repeats a title.
const TASK_DUPLICATE_THRESHOLD = 0.8;
// Below this many words a title is compared EXACTLY instead of by overlap: a
// ratio over two or three words is noise, and "tail one" against "tail two"
// scores 1.0 on the one word they share. Five of this store's 750 titles are
// that short, and no two of them are alike, so the exact rule costs nothing.
const TASK_DUPLICATE_MIN_WORDS = 4;

/// The `links.domain` of a raw row: a routing id of the routing map as
/// lessons use, or null when the task is filed under no domain.
export function taskRowDomain(row) {
  const links = JSON.parse(row.links);
  return links !== null && typeof links === 'object' && !Array.isArray(links)
    && typeof links.domain === 'string' ? links.domain : null;
}

/// The words of a title, as the duplicate check compares them.
///
/// A digit run counts whatever its length, and that is the whole difference
/// between a duplicate and a recurring task: dropping short tokens made
/// "Разбор консолидации памяти 2026-08-06" and the same title dated 08-03
/// identical, because only the year survived.
export function titleWords(title) {
  const words = String(title).toLowerCase().match(/[0-9a-zа-яё]+/gu) ?? [];
  return new Set(words.filter((word) => word.length >= 4 || /^\d+$/.test(word)));
}

/// Two titles say the same thing.
///
/// An overlap ratio is meaningless on a title too short to have one: "tail
/// one" and "tail two" share their only long word and score 1.0. Below four
/// words the comparison is EXACT and nothing else - which costs nothing here,
/// because five of this store's 750 titles are that short and no two of them
/// are alike.
export function titlesAlike(a, b) {
  if (!a.size || !b.size) return false;
  if (a.size < TASK_DUPLICATE_MIN_WORDS || b.size < TASK_DUPLICATE_MIN_WORDS) {
    return a.size === b.size && [...a].every((word) => b.has(word));
  }
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared) >= TASK_DUPLICATE_THRESHOLD;
}

function withEvidence(linksText, evidence) {
  if (!evidence) return linksText;
  const links = JSON.parse(linksText);
  if (!links || typeof links !== 'object' || Array.isArray(links)) {
    throw new HttpError(400, 'links must be a JSON object to carry closed_evidence');
  }
  return JSON.stringify({ ...links, closed_evidence: evidence });
}

/// The routing ids a task may be filed under: the domains the routing map
/// itself carries, sorted, so one refusal can name them all.
function taskDomainIds(routingMap) {
  return [...new Set((routingMap.order ?? []).map((entry) => entry.domain))].sort();
}

/// The problem with a `domain` a write supplies: `null` clears it, a routing
/// id sets it, and anything else is refused WITH THE LIST — a refusal that
/// says only "unknown" costs the caller a second round trip to learn the ids.
export function taskDomainProblem(domain, routingMap) {
  if (domain === null) return null;
  if (typeof domain !== 'string' || !domain.trim()) {
    return `domain must be a routing id or null, got ${JSON.stringify(domain)}`;
  }
  const ids = taskDomainIds(routingMap);
  return ids.includes(domain)
    ? null
    : `unknown domain ${JSON.stringify(domain)}: routing ids are ${ids.join(', ')}; null (CLI --domain none) clears it`;
}

/// The links a task write leaves behind. The domain — the top-level `domain`,
/// or the `domain` a wholesale `links` write names itself — is merged into
/// `links` and every other key survives, `closed_evidence` among them; a
/// wholesale `links` write that names no domain keeps the stored one. Only a
/// value the CALLER writes is judged: a legacy row whose domain the map no
/// longer carries must stay writable for every other field.
export function taskLinks(linksText, input, routingMap, evidence, linksWritten, storedLinksText) {
  const parsed = JSON.parse(linksText);
  const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  const stored = storedLinksText === null ? null : JSON.parse(storedLinksText);
  const storedObject = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : null;
  let domain = null;
  let written = false;
  let judged = false;
  if (input.domain !== undefined) {
    domain = input.domain ?? null;
    written = true;
    judged = true;
  } else if (linksWritten && isObject && Object.prototype.hasOwnProperty.call(parsed, 'domain')) {
    domain = parsed.domain ?? null;
    written = true;
    judged = true;
  } else if (storedObject && Object.prototype.hasOwnProperty.call(storedObject, 'domain')) {
    domain = storedObject.domain ?? null;
    written = true;
  }
  let next = linksText;
  if (written) {
    if (judged) {
      const problem = taskDomainProblem(domain, routingMap);
      if (problem) throw new HttpError(400, problem);
    }
    if (!isObject) throw new HttpError(400, 'links must be a JSON object to carry domain');
    const merged = { ...parsed };
    if (domain === null) delete merged.domain;
    else merged.domain = domain;
    next = JSON.stringify(merged);
  }
  return withEvidence(next, evidence);
}

export function taskMatchesListFilters(row, status, priority, track, closedSince, domain) {
  return (
    (status === null || row.status === status)
    && (priority === null || row.priority === priority)
    && (track === null || row.track === track)
    // A closed task is listed only when it closed inside the window; a task
    // that never closed is unaffected by the filter.
    && (closedSince === null || row.closed_ts === null || Number(row.closed_ts) >= Number(closedSince))
    && (domain === null
      || (domain === 'none' ? taskRowDomain(row) === null : taskRowDomain(row) === domain))
  );
}

export function taskListApplied(status, priority, track, closedSince, fields, domain) {
  // The answer NAMES the filters it applied, so a client can tell a memoryd
  // that ignored a key from one that honoured it.
  return [
    ['status', status], ['priority', priority], ['track', track],
    ['closed_since', closedSince], ['fields', fields], ['domain', domain],
  ].filter(([, value]) => value !== null).map(([name]) => name);
}
