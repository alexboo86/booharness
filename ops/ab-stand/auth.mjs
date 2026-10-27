// Stand auth is a disposable access-token snapshot, never a second refresh owner.
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { standDirectory } from './arms.mjs';

// qwen and mimo authenticate with a Token Plan api_key (ops/orchestrator/src/providers/index.ts);
// mimo's entry is whichever region Pi /login stored.
const providers = { codex: 'openai-codex', grok: 'xai', kimi: 'kimi-coding', glm: 'zai', qwen: 'qwen-token-plan-individual',
  mimo: ['xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-cn'] };
export const AUTH_MARGIN_MS = 60_000;

export function isStandSnapshotParseError(message) {
  return typeof message === 'string' && /live Pi (?:auth\.json|models-store\.json) unparseable during refresh/.test(message);
}

export function liveAuthVerdict(auth, family, timeoutMinutes, now = Date.now()) {
  const known = providers[family];
  const provider = Array.isArray(known) ? known.find((name) => auth[name]) ?? known[0] : known;
  if (!provider) throw new Error(`unknown stand family ${family}`);
  const credential = auth[provider];
  // glm uses a separate ZAI_API_KEY in orch's provider environment, not auth.json.
  if (family === 'glm' && !credential) return { run: true, reason: null };
  if (credential?.type === 'api_key') return { run: true, reason: null };
  if (credential?.type !== 'oauth' || typeof credential.access !== 'string' || !credential.access ||
      !Number.isFinite(credential.expires) || !Number.isFinite(new Date(credential.expires).getTime()) ||
      typeof credential.refresh !== 'string') {
    return { run: false, reason: `${provider} live OAuth access token unreadable; refresh via a live seat first` };
  }
  const expiry = new Date(credential.expires).toISOString();
  return credential.expires > now + timeoutMinutes * 60_000 + AUTH_MARGIN_MS
    ? { run: true, reason: null }
    : { run: false, reason: `${provider} live OAuth access token expires ${expiry} before cell timeout + margin; refresh via a live seat first` };
}

export function syncStandAuth(arm, { family, timeoutMinutes, now = Date.now(), liveFile = path.join(os.homedir(), '.pi', 'agent', 'auth.json'), directory = standDirectory(arm), rename = renameSync } = {}) {
  let auth;
  try { auth = JSON.parse(readFileSync(liveFile, 'utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Pi writes auth.json in place; a concurrent refresh can expose a partial JSON read.
    // Do not include parser context: it could contain credential bytes.
    throw new Error('live Pi auth.json unparseable during refresh');
  }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('live Pi auth.json is not an object');
  const verdict = family ? liveAuthVerdict(auth, family, timeoutMinutes, now) : { run: true, reason: null };
  const safe = Object.fromEntries(Object.entries(auth).map(([provider, credential]) => {
    if (!credential || typeof credential !== 'object' || Array.isArray(credential)) throw new Error(`invalid live Pi auth entry for ${provider}`);
    // Pi requires refresh to be a string for OAuth entries. An empty string is
    // deliberately unusable: even if an access token expires mid-call, no live
    // refresh grant can be rotated by the isolated profile.
    if (credential.type !== 'oauth') return [provider, credential];
    const withoutGrants = { ...credential, refresh: '' };
    delete withoutGrants.refreshToken;
    delete withoutGrants.refresh_token;
    return [provider, withoutGrants];
  }));
  const liveModels = path.join(path.dirname(liveFile), 'models-store.json');
  let models;
  try { models = readFileSync(liveModels, 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (models !== undefined) {
    try { JSON.parse(models); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error('live Pi models-store.json unparseable during refresh');
    }
  }
  const dest = path.join(directory, 'agent', 'auth.json');
  const agent = path.dirname(dest);
  if (lstatSync(agent).isSymbolicLink() || !lstatSync(agent).isDirectory()) throw new Error('unsafe stand agent directory');
  const writeSnapshot = (target, contents) => {
    const temp = path.join(agent, `.${path.basename(target)}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, contents, { mode: 0o600, flag: 'wx' });
      chmodSync(temp, 0o600);
      rename(temp, target);
    } finally { rmSync(temp, { force: true }); }
  };
  if (models !== undefined) writeSnapshot(path.join(agent, 'models-store.json'), models);
  writeSnapshot(dest, `${JSON.stringify(safe, null, 2)}\n`);
  return verdict;
}
