// Role recommendations (task 3459, slice C17a): read-only aggregation of public
// skill and MCP sources for a seat role, mounted as GET /api/role-recommendations
// on the loopback listener. Every remote string is data: sanitized, capped, plain
// fields — never HTML, and the board renders such values as textContent. A failed
// source is an answer row with its error, never a silent empty list.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './http-leads.ts';

export type RecommendationCard = {
  name: string;
  kind: 'skill' | 'mcp';
  publisher: string | null;
  license: string | null;
  archived: boolean | null;
  popularity: number | null;
  popularityUnit: 'installs' | 'stars' | null;
  sourceUrl: string | null;
  commitSha: string | null;
  contentHash: string | null;
  source: 'skills-sh' | 'mcp-registry';
};

export type RecommendationSourceStatus = {
  source: 'skills-sh' | 'mcp-registry' | 'github';
  ok: boolean;
  error: string | null;
  results: number;
};

export type RoleRecommendations = {
  role: string;
  q: string;
  cards: RecommendationCard[];
  sources: RecommendationSourceStatus[];
  cached: boolean;
  at: string;
};

export type RecommendationEndpoints = { skills: string; registry: string; github: string };

const DEFAULT_ENDPOINTS: RecommendationEndpoints = {
  skills: 'https://skills.sh',
  registry: 'https://registry.modelcontextprotocol.io',
  github: 'https://api.github.com',
};

const PER_SOURCE = 8;
// GitHub stays unauthenticated in this slice (60 requests/hour, measured header), so one answer enriches at most this many repositories.
const ENRICH_MAX = 5;
const TIMEOUT_MS = 8_000;
const MAX_BYTES = 512 * 1024;
const FIELD_MAX = 300;
const URL_MAX = 500;
const ERROR_MAX = 200;
const CACHE_TTL_MS = 600_000;
const CACHE_MAX = 32;

/** One remote string as a plain field: control characters dropped, whitespace folded, length capped. */
function cleanText(value: unknown, max = FIELD_MAX): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- the control characters are the subject of the match
  const plain = value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return plain.length ? plain : null;
}

/** A remote link only as a clean absolute http(s) URL without credentials; anything else stays null. */
function cleanUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.username = '';
    url.password = '';
    return url.toString().slice(0, URL_MAX);
  } catch {
    return null;
  }
}

function cleanCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const SHA_40 = /^[0-9a-f]{40}$/;
const CONTENT_HASH = /^[0-9a-f]{32,128}$/;
function cleanHex(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

/** The owner/repository of a github.com URL, or null; the charset keeps the value out of the API path's structure. */
function githubRepoOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/^(www\.)?github\.com$/.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || !parts.slice(0, 2).every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) return null;
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

/** A source error carries a status code, a limit or a failure name — never response bytes. */
class SourceError extends Error {}

/** Any transport failure becomes a short SourceError naming a code or limit, never response bytes. */
function toSourceError(error: unknown, timeoutMs: number): SourceError {
  const name = error instanceof Error ? error.name : 'Error';
  if (name === 'TimeoutError' || name === 'AbortError') return new SourceError(`timeout after ${timeoutMs} ms`);
  if (name === 'SyntaxError') return new SourceError('invalid JSON');
  return new SourceError(`request failed (${name})`);
}

/** Read a response body capped at maxBytes; the reader is cancelled at the cap so the socket is freed. */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new SourceError(`response larger than ${maxBytes} bytes`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new SourceError('response has no body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Cancel before throwing: an abandoned body holds its socket open.
      await reader.cancel().catch(() => {});
      throw new SourceError(`response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One bounded GET returning parsed JSON. Errors stay short and ASCII; a 200 HTML page fails as invalid JSON, not as markup. */
export async function fetchJson(url: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { accept: 'application/json' } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new SourceError(`HTTP ${res.status}`);
    }
    return JSON.parse(await readBounded(res, maxBytes));
  } catch (error) {
    throw error instanceof SourceError ? error : toSourceError(error, timeoutMs);
  }
}

type Draft = { card: RecommendationCard; repo: string | null };
type Outcome = { drafts: Draft[]; error: string | null };

const REPO_PATTERN = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

/** skills.sh unauthenticated search (https://skills.sh/api/search?q=): name, publisher and install count; it gives no licence, commit or hash. */
async function fromSkills(term: string, base: string): Promise<Outcome> {
  const body = await fetchJson(`${base}/api/search?q=${encodeURIComponent(term)}`) as { skills?: unknown };
  const rows = Array.isArray(body.skills) ? body.skills.slice(0, PER_SOURCE) : [];
  const drafts: Draft[] = [];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const name = cleanText(record.skillId) ?? cleanText(record.name);
    const repo = cleanText(record.source, 100);
    if (!name || !repo || !REPO_PATTERN.test(repo)) continue;
    const id = cleanText(record.id, 200);
    const installs = cleanCount(record.installs);
    drafts.push({
      repo,
      card: {
        name,
        kind: 'skill',
        publisher: cleanText(repo.split('/')[0], 100),
        license: null,
        archived: null,
        popularity: installs,
        popularityUnit: installs === null ? null : 'installs',
        sourceUrl: id && id.startsWith(`${repo}/`) ? cleanUrl(`https://skills.sh/${id}`) : cleanUrl(`https://skills.sh/${repo}`),
        commitSha: null,
        contentHash: null,
        source: 'skills-sh',
      },
    });
  }
  return { drafts, error: null };
}

/** The first well-formed hex field of its kind among the registry packages, or null. */
function pickHex(packages: Record<string, unknown>[] | null, key: string, pattern: RegExp): string | null {
  if (!packages) return null;
  for (const entry of packages) {
    const hex = cleanHex(entry[key], pattern);
    if (hex !== null) return hex;
  }
  return null;
}

/** One registry row as a draft, or null when its name is unusable. */
function registryDraft(row: unknown): Draft | null {
  const server = (row as { server?: unknown }).server;
  if (!server || typeof server !== 'object') return null;
  const record = server as Record<string, unknown>;
  const fullName = typeof record.name === 'string' ? record.name : '';
  const name = cleanText(record.title) ?? cleanText(fullName.split('/').at(-1));
  if (!name) return null;
  const sourceUrl = cleanUrl((record.repository as { url?: unknown } | undefined)?.url);
  const packages = Array.isArray(record.packages) ? record.packages as Record<string, unknown>[] : null;
  return {
    repo: githubRepoOf(sourceUrl),
    card: {
      name,
      kind: 'mcp',
      publisher: fullName.includes('/') ? cleanText(fullName.split('/')[0], 100) : null,
      license: null,
      archived: null,
      popularity: null,
      popularityUnit: null,
      sourceUrl,
      commitSha: pickHex(packages, 'version_commit_hash', SHA_40),
      contentHash: pickHex(packages, 'version_hash', CONTENT_HASH),
      source: 'mcp-registry',
    },
  };
}

/** The official MCP registry (GET /v0/servers?search=&version=latest&limit=): name substring search of at least 3 characters. */
async function fromRegistry(term: string, base: string): Promise<Outcome> {
  if (term.length < 3) throw new SourceError('search term shorter than 3 characters');
  const body = await fetchJson(`${base}/v0/servers?search=${encodeURIComponent(term)}&version=latest&limit=${PER_SOURCE}`) as { servers?: unknown };
  const rows = Array.isArray(body.servers) ? body.servers.slice(0, PER_SOURCE) : [];
  return { drafts: rows.map(registryDraft).filter((draft): draft is Draft => draft !== null), error: null };
}

type GithubRow = { license: string | null; archived: boolean | null; stars: number | null; sha: string | null };

/** One repository's metadata plus the HEAD commit; GitHub gives the licence, archived flag, stars and commit SHA the search sources lack. */
async function githubRow(repo: string, base: string): Promise<GithubRow> {
  const meta = await fetchJson(`${base}/repos/${repo}`) as Record<string, unknown>;
  const license = meta.license && typeof meta.license === 'object' ? cleanText((meta.license as Record<string, unknown>).spdx_id, 40) : null;
  let sha: string | null = null;
  try {
    sha = cleanHex((await fetchJson(`${base}/repos/${repo}/commits/HEAD`) as Record<string, unknown>).sha, SHA_40);
  } catch {
    sha = null; // the commit lookup is optional enrichment, never a source failure
  }
  return { license: license === 'NOASSERTION' ? null : license, archived: typeof meta.archived === 'boolean' ? meta.archived : null, stars: cleanCount(meta.stargazers_count), sha };
}

/** Enrich drafts from GitHub; a lookup that fails leaves that card's fields null while the others still enrich. */
async function withGithub(drafts: Draft[], base: string): Promise<{ rows: Map<string, GithubRow>; status: RecommendationSourceStatus }> {
  const repos = [...new Set(drafts.map((draft) => draft.repo).filter((repo): repo is string => repo !== null))].slice(0, ENRICH_MAX);
  const settled = await Promise.all(repos.map(async (repo) => {
    try {
      return { repo, row: await githubRow(repo, base) };
    } catch (error) {
      return { repo, failed: cleanText((error as Error).message, ERROR_MAX) ?? 'lookup failed' };
    }
  }));
  const rows = new Map(settled.filter((entry): entry is { repo: string; row: GithubRow } => 'row' in entry).map((entry) => [entry.repo, entry.row]));
  const failures = settled.filter((entry) => 'failed' in entry) as { repo: string; failed: string }[];
  const status: RecommendationSourceStatus = {
    source: 'github',
    ok: rows.size > 0 || failures.length === 0,
    error: failures.length ? `${failures.length}/${settled.length} repository lookups failed: ${failures[0].failed}` : null,
    results: rows.size,
  };
  return { rows, status };
}

const cache = new Map<string, { at: number; value: RoleRecommendations }>();

async function attempt(run: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await run();
  } catch (error) {
    return { drafts: [], error: cleanText((error as Error).message, ERROR_MAX) ?? 'source failed' };
  }
}

function requireInputs(role: string, q: string): { role: string; q: string } {
  const cleanRole = cleanText(role, 100);
  if (!cleanRole) throw new Error('role is required');
  return { role: cleanRole, q: cleanText(q, 100) ?? '' };
}

/** Merge GitHub's licence, archived flag, stars and HEAD commit into a card that lacks them. */
function enrichCard(draft: Draft, rows: Map<string, GithubRow>): RecommendationCard {
  const { card } = draft;
  const row = draft.repo === null ? undefined : rows.get(draft.repo);
  if (!row) return card;
  return {
    ...card,
    license: card.license ?? row.license,
    archived: card.archived ?? row.archived,
    popularity: card.popularity ?? row.stars,
    popularityUnit: card.popularityUnit ?? (row.stars === null ? null : 'stars'),
    commitSha: card.commitSha ?? row.sha,
  };
}

function remember(key: string, answer: RoleRecommendations, at: number): void {
  cache.set(key, { at, value: answer });
  for (const stale of cache.keys()) {
    if (cache.size <= CACHE_MAX) break;
    cache.delete(stale);
  }
}

/**
 * Aggregate the three public sources for one role. The answer always names every
 * source with ok or its error, so "no results" and "source failed" stay different
 * answers. No secret is sent: every request is an unauthenticated GET the caller
 * could have made, and the cache keeps one board page from hammering a source.
 */
export async function roleRecommendations(role: string, q: string, opts: {
  endpoints?: Partial<RecommendationEndpoints>;
  cacheTtlMs?: number;
  now?: () => number;
} = {}): Promise<RoleRecommendations> {
  const inputs = requireInputs(role, q);
  const endpoints: RecommendationEndpoints = { ...DEFAULT_ENDPOINTS, ...opts.endpoints };
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  const now = opts.now?.() ?? Date.now();
  const key = JSON.stringify([inputs.role, inputs.q, endpoints]);
  const hit = cache.get(key);
  if (hit && ttl > 0 && now - hit.at < ttl) return { ...hit.value, cached: true };
  const term = (inputs.q || inputs.role).trim();
  const [skills, registry] = await Promise.all([
    attempt(() => fromSkills(term, endpoints.skills)),
    attempt(() => fromRegistry(term, endpoints.registry)),
  ]);
  const drafts = [...skills.drafts, ...registry.drafts];
  const { rows, status: github } = await withGithub(drafts, endpoints.github);
  const answer: RoleRecommendations = {
    role: inputs.role,
    q: inputs.q,
    cards: drafts.map((draft) => enrichCard(draft, rows)),
    sources: [
      { source: 'skills-sh', ok: skills.error === null, error: skills.error, results: skills.drafts.length },
      { source: 'mcp-registry', ok: registry.error === null, error: registry.error, results: registry.drafts.length },
      github,
    ],
    cached: false,
    at: new Date(now).toISOString(),
  };
  cache.delete(key);
  if (ttl > 0) remember(key, answer, now);
  return answer;
}

/** GET /api/role-recommendations?role=&q= — loopback-only and read-only; loopback reachability is the listener's guard. */
export async function serveRoleRecommendations(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/role-recommendations' || req.method !== 'GET') return false;
  try {
    sendJson(res, 200, await roleRecommendations(url.searchParams.get('role') ?? '', url.searchParams.get('q') ?? ''));
  } catch (error) {
    sendJson(res, 400, { error: cleanText((error as Error).message, ERROR_MAX) ?? 'invalid request' });
  }
  return true;
}
