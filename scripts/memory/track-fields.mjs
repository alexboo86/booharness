import { parseLinks } from './lesson-lib.mjs';
import { parseTrackMarker } from './store.mjs';

/** Merge authoritative links over the body marker without changing parsing. */
export function trackFieldsOf(row) {
  const marker = parseTrackMarker(row.body || '');
  const links = parseLinks(row.links);
  const pick = (key) => {
    const fromLinks = links[key];
    if (typeof fromLinks === 'string' && fromLinks.trim()) return fromLinks.trim();
    const fromMarker = marker[key];
    return typeof fromMarker === 'string' && fromMarker.trim() ? fromMarker.trim() : '';
  };
  return { track: pick('track'), status: pick('status'), next: pick('next') };
}
