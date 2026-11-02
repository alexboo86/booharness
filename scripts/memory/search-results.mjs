// Search presentation and the top-30 seam live outside the synchronous store.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const DAY_MS = 24 * 60 * 60 * 1000;
export const RERANK_HEAD = 30;

/** Lexical knowledge is a separate read-only corpus, never a dense candidate. */
export function knowledgeResults(file, query) {
  const terms = [...new Set((String(query).match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter((term) => !/^(?:what|which|how|where|does|do|are|is|the|a|an|to|of|and|on|in|for|with|when|from|by|can|its|it|as|be|or|under|during)$/i.test(term)))];
  if (!terms.length) return [];
  const match = terms.map((term) => `"${term}"`).join(' OR ');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT path, heading, section_key, source_commit,
      snippet(knowledge,4,'','','…',24) AS snippet FROM knowledge WHERE knowledge MATCH ?
      ORDER BY bm25(knowledge,0.1,8,0,0,1), rowid`).all(match);
    const selected = new Map();
    for (const row of rows) {
      if (!selected.has(row.section_key)) selected.set(row.section_key, { ...row, snippet: [...row.snippet].slice(0, 240).join(''), kind: 'knowledge', title: `${row.path}#${row.heading}` });
      if (selected.size === 3) break;
    }
    return [...selected.values()];
  } finally { db.close(); }
}

export function knowledgeSearchResponse(results, url) {
  if (url.searchParams.get('knowledge') !== '1') return results;
  const file = process.env.MEMORYCTL_KNOWLEDGE_INDEX || fileURLToPath(new URL('./knowledge.sqlite', import.meta.url));
  try { return { results, knowledge: knowledgeResults(file, url.searchParams.get('q')) }; }
  catch (error) { return { results, knowledge: [], knowledge_error: String(error.message).split('\n')[0] }; }
}

export function rerankedRows(rows, scores) {
  if (!scores) return rows;
  const head = rows.slice(0, RERANK_HEAD).map((row, index) => ({ row, index }));
  // Identity hits keep their dense order; only the other head rows use scores.
  head.sort((a, b) => Number(b.row.idMatch) - Number(a.row.idMatch)
    || (a.row.idMatch ? a.index - b.index : scores[b.index] - scores[a.index] || a.index - b.index));
  return [...head.map(({ row }) => row), ...rows.slice(RERANK_HEAD)];
}

export function searchResults(rows, now) {
  return rows.map((row) => ({
    id: Number(row.id),
    uuid: row.uuid,
    kind: row.kind,
    title: row.title,
    snippet: row.snippet,
    ts: Number(row.ts),
    // The date and age travel with every hit, not an unreadable epoch alone.
    date: new Date(Number(row.ts)).toISOString().slice(0, 10),
    age_days: Math.max(0, Math.floor((now - Number(row.ts)) / DAY_MS)),
    pinned: Boolean(row.pinned),
  }));
}
