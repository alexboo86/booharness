// B1 handoff classification — the one predicate both consumers call: the
// consolidation scan (.agents/skills/consolidate-memory/scan.mjs) and the
// unattended archiver (archive-handoff.mjs). Until 2026-10 the judgement
// lived inline in the scan while archiving was a four-step hand procedure,
// so ~922 B1 candidates waited on a human; a predicate shared with the
// writer is what lets the scan print exactly what the archiver would do.
//
// "Live" here is the store's own notion, not a new one: a live row whose
// title is history (SEARCH_DEAD_TITLE) is not the present of a track, and
// neither is a row whose links say archived — gen-tracks drops the latter
// as an invalid status and the scan always skipped it, so both consumers
// already agreed without naming it. The status of a track is read the way
// gen-tracks reads it (trackFieldsOf), one implementation for both gates.

import { trackFieldsOf } from './track-fields.mjs';
import { parseLinks } from './lesson-lib.mjs';
import { TASK_CLOSED_STATUSES } from './task-pure.mjs';
import { SEARCH_DEAD_TITLE } from './store.mjs';

/// A track whose current status is one of these is protected work, not a
/// finished tail: `blocked` names a live obstacle somebody must still clear.
export const REFUSED_TRACK_STATUSES = Object.freeze(['blocked']);

/// The age both the consolidation scan and the archiver enforce. The scan
/// prints this constant; it does not read --archive-days.
export const B1_ARCHIVE_DAYS = 14;

const isHistory = (row) => SEARCH_DEAD_TITLE.test(String(row.title || ''))
  || String(parseLinks(row.links).status || '') === 'archived';

/**
 * Newest live handoff row per declared track, gen-tracks order (ts, then id).
 * History-titled and links-archived rows are not a track's present.
 * @param {Array<{ id: number, ts: number, title?: string, links?: string, body?: string }>} handoffs
 * @returns {Map<string, object>}
 */
export function latestLiveByTrack(handoffs) {
  const byTrack = new Map();
  for (const row of handoffs) {
    const { track } = trackFieldsOf(row);
    if (!track || isHistory(row)) continue;
    const prev = byTrack.get(track);
    if (!prev
      || Number(row.ts) > Number(prev.ts)
      || (Number(row.ts) === Number(prev.ts) && Number(row.id) > Number(prev.id))) {
      byTrack.set(track, row);
    }
  }
  return byTrack;
}

/**
 * The B1 verdict for one live handoff row.
 *
 * verdict 'skip'    — not B1's business at all (reason: archived, dead-title,
 *                     no-track, newest-live); the scan stays silent on these.
 * verdict 'refused' — protection holds (reason: pinned, open-tails, young,
 *                     track-status); the scan prints ЗАЩИЩЕНО, the archiver
 *                     refuses to write.
 * verdict 'candidate' — free to archive.
 *
 * Every result carries the facts both consumers print: track, the track's
 * current status (newest live handoff, 'active' when unset), ageDays,
 * openTails (declared tasks not done/cancelled) and latestId.
 *
 * @param {{ handoff: object, handoffs?: Array<object>, latestByTrack?: Map<string, object>,
 *           tasks?: Array<object>, archiveDays?: number, now?: number }} input
 */
export function classifyB1({ handoff, handoffs = [], latestByTrack, tasks = [], archiveDays = B1_ARCHIVE_DAYS, now = Date.now() }) {
  const elapsedMs = now - Number(handoff.ts);
  const ageDays = Math.floor(elapsedMs / 86400000);
  const openTails = (tasks || [])
    .filter((task) => (task.handoffs || []).map(Number).includes(Number(handoff.id)))
    .filter((task) => !TASK_CLOSED_STATUSES.has(task.status)).length;
  const { track } = trackFieldsOf(handoff);
  const base = { track, ageDays, openTails, trackStatus: '', latestId: null };
  if (String(parseLinks(handoff.links).status || '') === 'archived') {
    return { ...base, verdict: 'skip', reason: 'archived' };
  }
  if (SEARCH_DEAD_TITLE.test(String(handoff.title || ''))) {
    return { ...base, verdict: 'skip', reason: 'dead-title' };
  }
  if (!track) return { ...base, verdict: 'skip', reason: 'no-track' };
  const latest = (latestByTrack ?? latestLiveByTrack(handoffs)).get(track);
  if (!latest || Number(latest.id) === Number(handoff.id)) {
    return { ...base, verdict: 'skip', reason: 'newest-live' };
  }
  const trackStatus = trackFieldsOf(latest).status || 'active';
  const named = { track, ageDays, openTails, trackStatus, latestId: Number(latest.id) };
  if (Number(handoff.pinned)) return { ...named, verdict: 'refused', reason: 'pinned' };
  if (openTails) return { ...named, verdict: 'refused', reason: 'open-tails' };
  if (elapsedMs < archiveDays * 86400000) return { ...named, verdict: 'refused', reason: 'young' };
  if (REFUSED_TRACK_STATUSES.includes(trackStatus)) {
    return { ...named, verdict: 'refused', reason: 'track-status' };
  }
  return { ...named, verdict: 'candidate', reason: '' };
}
