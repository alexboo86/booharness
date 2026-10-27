// Search presentation and the top-30 seam live outside the synchronous store.
const DAY_MS = 24 * 60 * 60 * 1000;
export const RERANK_HEAD = 30;

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
