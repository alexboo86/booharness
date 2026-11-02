// Read-only model-quality projection and guarded manual overrides. No UI or roles mutations.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { roleStats, tierOf, setManualTier, qualityReviewStats, qualityProfileKey, qualityRemovalCheck, type Store, type RoleStatsRow, type CellRef, type Tier } from './store.ts';
import { leadWriteAllowed, readJson, sendJson } from './http-leads.ts';

type QualityRuntime = { store: Store; stateDir: string };
type Route = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

function qualityWindow(url: URL, now: number): { since: string; until: string; previous: string } {
  const raw = url.searchParams.get('since') ?? '7d';
  if (!/^[1-9]\d*d$/.test(raw)) throw new Error('since needs positive days, e.g. 7d');
  const ms = Number(raw.slice(0, -1)) * 86_400_000;
  if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(now - 2 * ms).getTime())) throw new Error('since is too large');
  return { since: new Date(now - ms).toISOString(), until: new Date(now).toISOString(), previous: new Date(now - 2 * ms).toISOString() };
}

function rowTier(stateDir: string, role: string, row: RoleStatsRow, now: number) {
  // Unknown model/effort names no persisted tier cell, never a fabricated model or effort.
  if (row.model === null || row.effort === null) return { tier: 'NORMAL', manual: false, warning: null };
  const { tier, manual, warning } = tierOf(stateDir, { role, wallet: row.family, model: row.model, effort: row.effort }, now);
  return { tier, manual, warning };
}

function qualityPage(rt: QualityRuntime, url: URL) {
  const now = Date.now();
  const { since, until, previous } = qualityWindow(url, now);
  const stats = roleStats(rt.store.db, since, until);
  const prior = roleStats(rt.store.db, previous, since);
  const reviews = qualityReviewStats(rt.store.db, since, until);
  const previousMeans = new Map(prior.roles.flatMap(({ role, rows }) => rows.map((row) =>
    [JSON.stringify([role, qualityProfileKey(row.family, row)]), row.meanScore] as const)));
  return { since, until, previousSince: previous, attribution: reviews.attribution,
    roles: stats.roles.map(({ role, rows }) => ({ role, rows: rows.map((row) => ({
      ...row, ...rowTier(rt.stateDir, role, row, now), fewData: row.rated < 30,
      previousMeanScore: previousMeans.get(JSON.stringify([role, qualityProfileKey(row.family, row)])) ?? null,
      ...reviewMeasures(role, row, reviews),
    })) })) };
}

function reviewMeasures(role: string, row: RoleStatsRow, reviews: ReturnType<typeof qualityReviewStats>) {
  const empty = { share: null, sample: 0, successes: 0 };
  const key = qualityProfileKey(row.family, row);
  if (role === 'coder') return { firstPassApproval: reviews.coders.get(key) ?? empty };
  if (role === 'reviewer') return { dismissedFindings: reviews.reviewers.get(key) ?? empty };
  return {};
}

async function qualityBody(req: IncomingMessage, keys: string[]): Promise<Record<string, unknown>> {
  const raw = await readJson(req, 4096);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('body must be an object');
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).length !== keys.length || !keys.every((key) => Object.hasOwn(body, key))) throw new Error(`body requires exactly ${keys.join(', ')}`);
  return body;
}

function identifier(value: unknown, name: string): string {
  const pattern = name === 'model' ? /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/ : /^[A-Za-z0-9._-]{1,128}$/;
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${name} must be a bounded identifier`);
  return value;
}

async function manualTier(rt: QualityRuntime, req: IncomingMessage) {
  const body = await qualityBody(req, ['role', 'wallet', 'model', 'effort', 'tier']);
  const cell: CellRef = { role: identifier(body.role, 'role'), wallet: identifier(body.wallet, 'wallet'),
    model: identifier(body.model, 'model'), effort: identifier(body.effort, 'effort') };
  const tier = body.tier;
  if (tier !== null && tier !== 'WEAK' && tier !== 'NORMAL') throw new Error('tier must be WEAK, NORMAL or null');
  setManualTier(rt.stateDir, cell, tier as Tier | null);
  return tierOf(rt.stateDir, cell);
}

async function qualityAction(rt: QualityRuntime, req: IncomingMessage, url: URL): Promise<unknown> {
  if (req.method === 'PUT' && url.pathname === '/api/quality/manual-tier') return manualTier(rt, req);
  if (req.method === 'POST' && url.pathname === '/api/quality/remove-check') {
    const body = await qualityBody(req, ['role', 'family']);
    return qualityRemovalCheck(identifier(body.role, 'role'), identifier(body.family, 'family'));
  }
  throw new Error('unknown quality route or method');
}

async function serveQualityRoutes(rt: QualityRuntime, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/quality' && !url.pathname.startsWith('/api/quality/')) return false;
  if (req.method !== 'GET' && !leadWriteAllowed(req, req.socket.localPort!)) {
    sendJson(res, 403, { error: 'quality writes require the daemon origin and X-Orch-Chat: 1' });
    return true;
  }
  try {
    const body = req.method === 'GET' && url.pathname === '/api/quality' ? qualityPage(rt, url) : await qualityAction(rt, req, url);
    sendJson(res, 200, body);
  } catch (error) { sendJson(res, 400, { error: (error as Error).message }); }
  return true;
}

/** One route-pipeline mount, without adding branches to createHttpServer. */
export function withQualityRoutes(rt: QualityRuntime, next: Route): Route {
  return async (req, res, url) => await serveQualityRoutes(rt, req, res, url) || next(req, res, url);
}
