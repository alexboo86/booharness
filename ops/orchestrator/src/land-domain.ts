import { readFileSync } from 'node:fs';
import os from 'node:os';
import type { Store } from './store.ts';
import { stateDirFor } from './config.ts';
import { readInstallSetting } from './settings/index.ts';
import { readMemory } from '../../../scripts/memory/service-client.mjs';
import { domainOf } from '../../../scripts/lib/anchor-grammar.mjs';

type Assignment = { handle: string; session: string; generation: number };
type Registry = { schema: number; assignments: Record<string, Assignment> };
type Scope = { gated: boolean; reason?: string; handle?: string; domains?: string[] };
const KEY = 'domain-native-leads-v1';

function validAssignment(record: Assignment): boolean {
  return Boolean(record) && typeof record.handle === 'string' && typeof record.session === 'string' && Number.isSafeInteger(record.generation);
}

function registryBody(row: { body: string }): Registry {
  if (typeof row.body !== 'string' || Buffer.byteLength(row.body) > 60000) throw new Error('invalid registry body');
  const state = JSON.parse(row.body) as Registry;
  if (state.schema !== 1 || !state.assignments || Array.isArray(state.assignments)) throw new Error('invalid registry schema');
  if (!Object.values(state.assignments).every(validAssignment)) throw new Error('invalid assignment');
  return state;
}

async function assignments(): Promise<Record<string, Assignment>> {
  const row = await readMemory(`registry?key=${KEY}`);
  if (row?.key !== KEY) throw new Error('invalid registry key');
  if (row.version === 0 && row.body === null) return {};
  return registryBody(row).assignments;
}

/** True while an effective assignment remains. Disabled (domainLeads.enabled=false) or an allowlist
 * (domainLeads.domains) that drops every assignment makes creates behave as a repository with no
 * domain leads; an unreadable registry stays fail-open (decision #22281). */
export async function domainLeadsRegistered(): Promise<boolean> {
  let registry: Record<string, Assignment>;
  try { registry = await assignments(); } catch { return false; }
  if (!Object.keys(registry).length) return false;
  const settings = leadSettings();
  return settings.enabled && Object.keys(gatedAssignments(registry, settings.domains)).length > 0;
}

function ownerApproved(store: Partial<Store>, owner: string | undefined, lead: string, reason: string): boolean {
  if (!owner) return false;
  // Explicit post citations, not arbitrary numbers in prose.
  const ids = [...reason.matchAll(/(?:post(?:[_ -]?id)?[\s:#=]*|#)([1-9]\d*)\b/gi)].map(match => Number(match[1]));
  return ids.some(id => {
    if (!Number.isSafeInteger(id)) return false;
    const post = store.db!.prepare('SELECT author, to_json FROM chat_posts WHERE id = ?').get(id);
    if (!post || post.author !== owner || typeof post.to_json !== 'string') return false;
    const to = JSON.parse(post.to_json);
    return Array.isArray(to) && to.includes(lead);
  });
}

function ownerLabel(domain: string | null, registry: Record<string, Assignment>): string {
  return `owner ${domain ?? 'unrouted'}; handle ${registry[domain]?.handle ?? 'unregistered'}`;
}

type Creator = { handle: string; unresolved?: undefined } | { handle?: undefined; unresolved: string };

/**
 * The creator's handle resolved once at seat_create and is stored (task 3419): a release or rebind
 * after creation must not drop the gate, so a stored leadHandle is authoritative and is never
 * re-looked-up. Legacy seats without one resolve their leadSession through its live binding; a
 * missing identity or a session that no longer resolves is reported as an unresolved creator.
 */
function creatorHandle(store: Partial<Store>, data: Record<string, unknown>): Creator {
  if (typeof data.leadHandle === 'string' && data.leadHandle) return { handle: data.leadHandle };
  if (typeof data.leadSession !== 'string' || !data.leadSession) return { unresolved: 'no creating lead identity is recorded on the seat' };
  if (!store.db) return { unresolved: 'chat bindings are unavailable to resolve the creating session' };
  const bound = (store.db.prepare('SELECT handle FROM chat_bindings WHERE session = ? AND ended_at IS NULL').get(data.leadSession) as { handle?: string } | undefined)?.handle;
  return typeof bound === 'string' && bound
    ? { handle: bound }
    : { unresolved: `creating session '${data.leadSession}' no longer resolves to a live handle` };
}

/**
 * Task 3419 correction 2: a seat whose creator identity is missing or unresolvable owns no domain,
 * so a patch touching any registered domain is refused — the gate fails closed, never open. A
 * patch wholly inside unrouted or unowned paths keeps today's ungated landing; only registry
 * unavailability stays fail-open (decision #22281).
 */
function unresolvedCreatorScope(data: Record<string, unknown>, paths: string[], registry: Record<string, Assignment>, cause: string): { note: { domainScope: Scope }; outside: string[] } {
  const map = JSON.parse(readFileSync(new URL('../../../docs/agent/domain-routing.generated.json', import.meta.url), 'utf8'));
  const touched = paths.map(file => ({ file, domain: domainOf(file, map) as string | null }))
    .filter(({ domain }) => domain !== null && registry[domain] !== undefined);
  if (touched.length) {
    const seat = typeof data.repo === 'string' ? ` on repo '${data.repo}'` : '';
    throw new Error(`seat${seat} cannot gate its patch: ${cause}; refusing paths into registered domains: ${touched.map(({ file, domain }) => `${file} (${ownerLabel(domain, registry)})`).join(', ')}`);
  }
  return { note: { domainScope: { gated: false, reason: cause } }, outside: [] };
}

type LeadSettings = { enabled: boolean; domains: string[] | null };

/**
 * Install settings for domain leads (decision #22510). Resolves the state dir exactly like
 * loadConfig (ORCH_STATE_DIR, else the daemon default). Throws on a corrupt settings store: the
 * gate fails closed on indeterminate configuration instead of defaulting; only the registry read
 * stays fail-open (decision #22281).
 */
function leadSettings(): LeadSettings {
  const stateDir = process.env.ORCH_STATE_DIR || stateDirFor(os.homedir());
  return {
    enabled: readInstallSetting(stateDir, 'domainLeads.enabled') as boolean,
    domains: readInstallSetting(stateDir, 'domainLeads.domains') as string[] | null,
  };
}

/** Select path owners subject to the gate, without changing a creator's registered lead status. */
function gatedAssignments(registry: Record<string, Assignment>, domains: string[] | null): Record<string, Assignment> {
  if (!domains) return registry;
  return Object.fromEntries(Object.entries(registry).filter(([domain]) => domains.includes(domain)));
}

/** Runs before any target mutation; only registry unavailability is fail-open by decision #22281. */
export async function landDomainScope(store: Partial<Store>, data: Record<string, unknown>, paths: string[], reason = ''): Promise<{ note: { domainScope?: Scope }; outside: string[] }> {
  let registry: Record<string, Assignment>;
  try { registry = await assignments(); }
  catch { return { note: { domainScope: { gated: false, reason: 'domain registry unreadable' } }, outside: [] }; }
  if (!Object.keys(registry).length) return { note: { domainScope: { gated: false, reason: 'domain registry empty' } }, outside: [] };
  const settings = leadSettings();
  if (!settings.enabled) return { note: { domainScope: { gated: false, reason: 'domain leads disabled' } }, outside: [] };
  if (settings.domains?.length === 0) return { note: { domainScope: { gated: false, reason: 'no gated domains' } }, outside: [] };
  const effective = gatedAssignments(registry, settings.domains);
  const creator = creatorHandle(store, data);
  if (creator.unresolved) return unresolvedCreatorScope(data, paths, effective, creator.unresolved);
  return checkDomains(store, paths, reason, registry, creator.handle, settings.domains);
}

function checkDomains(store: Partial<Store>, paths: string[], reason: string, registry: Record<string, Assignment>, handle: string, allowedDomains: string[] | null): { note: { domainScope: Scope }; outside: string[] } {
  if (!store.db) return { note: { domainScope: { gated: false, reason: 'chat bindings unavailable' } }, outside: [] };
  const domains = Object.keys(registry).filter(domain => registry[domain].handle === handle);
  if (!domains.length) return { note: { domainScope: { gated: false, reason: 'lead has no registered domains' } }, outside: [] };
  const map = JSON.parse(readFileSync(new URL('../../../docs/agent/domain-routing.generated.json', import.meta.url), 'utf8'));
  const outside = paths.map(file => ({ file, domain: domainOf(file, map) as string | null }))
    .filter(({ domain }) => !domains.includes(domain) && (allowedDomains === null || allowedDomains.includes(domain)));
  const refused = outside.filter(({ domain }) => !ownerApproved(store, registry[domain]?.handle, handle, reason));
  if (refused.length) throw new Error(`patch paths outside ${handle}'s domains: ${refused.map(({ file, domain }) => `${file} (${ownerLabel(domain, registry)})`).join(', ')}; override_reason must cite an addressed owner chat post id (post #ID) for each owner`);
  return { note: { domainScope: { gated: true, handle, domains } }, outside: outside.map(({ file }) => file) };
}

export function withDomainScopeNote<T extends { domainScope?: Scope }>(result: T) {
  return { ...result, domainScope: result.domainScope ?? { gated: false, reason: 'no creating lead identity recorded' } };
}
