#!/usr/bin/env node
// Explicit assignments, not model-family routing or client-liveness detection.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readInstallSettings } from '../lib/harness-settings.mjs';
import { readMemory, updateRegistry } from './service-client.mjs';

const KEY = 'domain-native-leads-v1';
const MAX_BYTES = 60000;
const DOMAIN = /^domain-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HANDLE = /^[A-Za-z0-9._-]{1,64}$/;
const PI = /(?:^|[^a-z0-9])pi(?:$|[^a-z0-9])/i;

function refuse(message, status = 'refused') {
  throw Object.assign(new Error(message), { status });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`invalid ${label}`);
}

function keys(value, expected, label) {
  object(value, label);
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) refuse(`invalid ${label} fields`);
}

function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || value.length > max || /\p{Cc}/u.test(value)) refuse(`invalid ${label}`);
  return value;
}

function integer(value, min, label) {
  if (!Number.isSafeInteger(value) || value < min || value >= Number.MAX_SAFE_INTEGER) refuse(`invalid ${label}`);
  return value;
}

function domainName(value) {
  if (!DOMAIN.test(text(value, 96, 'domain'))) refuse('invalid domain');
  return value;
}

function record(value) {
  keys(value, ['handle', 'nativeClient', 'evidence', 'session', 'generation'], 'assignment');
  if (!HANDLE.test(text(value.handle, 64, 'handle')) || ['operator', 'all', 'git', 'table'].includes(value.handle)) refuse('invalid lead handle');
  text(value.nativeClient, 80, 'native client');
  if (PI.test(value.nativeClient)) refuse('Pi designation is not a native client');
  text(value.evidence, 512, 'native client evidence');
  text(value.session, 256, 'session');
  integer(value.generation, 1, 'generation');
  return value;
}

function stateBody(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BYTES) refuse('invalid registry body size');
  const state = JSON.parse(body);
  keys(state, ['schema', 'assignments'], 'registry');
  if (state.schema !== 1) refuse('unsupported registry schema');
  object(state.assignments, 'assignments');
  if (Object.keys(state.assignments).length > 128) refuse('too many assignments');
  for (const [domain, assignment] of Object.entries(state.assignments)) {
    domainName(domain);
    record(assignment);
  }
  return state;
}

async function registry() {
  const current = await readMemory(`registry?key=${KEY}`);
  if (current?.key !== KEY) refuse('invalid registry key');
  integer(current.version, 0, 'registry version');
  if (current.version === 0) {
    if (current.body !== null) refuse('invalid empty registry');
    return { version: 0, state: { schema: 1, assignments: {} } };
  }
  return { version: current.version, state: stateBody(current.body) };
}

function activeDomains() {
  const path = new URL('../../docs/agent/domain-routing.generated.json', import.meta.url);
  const source = readFileSync(path, 'utf8');
  if (Buffer.byteLength(source) > 2_000_000) refuse('domain map too large');
  const map = JSON.parse(source);
  object(map.byDomain, 'domain map');
  object(map.retiredDomains, 'retired domains');
  const names = Object.keys(map.byDomain);
  names.forEach(domainName);
  return new Set(names.filter(name => !Object.hasOwn(map.retiredDomains, name)));
}

// Task 3459 C13 (decision 22510): the attach point reads the same install document the settings
// core writes; defaults (enabled, no allowlist) keep today's unrestricted assign. A corrupt or
// invalid store refuses rather than guessing.
function leadSettings() {
  const stateDir = process.env.ORCH_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'orch');
  const values = readInstallSettings(stateDir).document.values;
  const enabled = values['domainLeads.enabled'];
  if (enabled !== undefined && typeof enabled !== 'boolean') refuse('invalid domainLeads.enabled');
  const domains = values['domainLeads.domains'];
  if (domains === undefined || domains === null) return { enabled: enabled !== false, domains: null };
  if (!Array.isArray(domains) || domains.some((name) => typeof name !== 'string' || !DOMAIN.test(name))
    || new Set(domains).size !== domains.length) refuse('invalid domainLeads.domains');
  return { enabled: enabled !== false, domains };
}

function optionName(flag, allowed, flags) {
  const name = flag.slice(2);
  if (!flag.startsWith('--') || !allowed.includes(name) || Object.hasOwn(flags, name)) refuse(`unknown or duplicate option: ${flag}`);
  return name;
}

function options(argv) {
  const [command, ...rest] = argv;
  const allowed = {
    list: [], resolve: ['orch-url'],
    assign: ['orch-url', 'handle', 'native-client', 'evidence', 'session', 'generation', 'expected-version'],
    unassign: ['expected-version'],
  };
  if (!Object.hasOwn(allowed, command)) refuse('usage: domain-leads.mjs list | resolve DOMAIN --orch-url URL | assign DOMAIN --handle HANDLE --native-client NAME --evidence TEXT --session ID --generation N --expected-version N --orch-url URL | unassign DOMAIN --expected-version N');
  const domain = command === 'list' ? undefined : domainName(rest.shift());
  const flags = {};
  while (rest.length) {
    const flag = rest.shift();
    const name = optionName(flag, allowed[command], flags);
    const value = rest.shift();
    if (!value || value.startsWith('--')) refuse(`missing value for ${flag}`);
    flags[name] = value;
  }
  return { command, domain, flags };
}

function numberFlag(flags, name, min) {
  if (!/^(0|[1-9][0-9]*)$/.test(flags[name] ?? '')) refuse(`--${name} requires an explicit integer`);
  return integer(Number(flags[name]), min, name);
}

function localUrl(value) {
  if (!value) refuse('--orch-url requires an explicit local loopback endpoint');
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') refuse('only a local loopback HTTP origin is supported; LAN bindings lack validation capability');
  return new URL('/api/chat?after=9007199254740991&limit=1', url);
}

function binding(value) {
  object(value, 'binding');
  if (!HANDLE.test(text(value.handle, 64, 'binding handle'))) refuse('invalid binding handle');
  text(value.session, 256, 'binding session');
  integer(value.generation, 1, 'binding generation');
  if (value.ended_at !== null) text(value.ended_at, 80, 'binding end');
  if (value.desktop !== null) text(value.desktop, 80, 'binding desktop');
  return value;
}

async function bindings(endpoint) {
  const response = await fetch(localUrl(endpoint), { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) refuse(`binding read HTTP ${response.status}`, 'unavailable');
  // Stream cap also bounds responses without Content-Length.
  let source = '';
  let bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1_000_000) refuse('binding response too large');
    source += decoder.decode(chunk, { stream: true });
  }
  source += decoder.decode();
  const data = JSON.parse(source);
  object(data, 'binding capability');
  if (Object.hasOwn(data, 'canRelease') || Object.hasOwn(data, 'readOnly')) refuse('LAN/stripped binding capability is unsupported');
  if (!Array.isArray(data.handles) || data.handles.length > 4096) refuse('invalid binding list');
  const seen = new Set();
  for (const item of data.handles) {
    binding(item);
    if (seen.has(item.handle)) refuse('duplicate binding handle');
    seen.add(item.handle);
  }
  return data.handles;
}

function resolution(assignment, handles) {
  if (!assignment) return 'unassigned';
  const current = handles.find(item => item.handle === assignment.handle);
  if (!current || current.ended_at !== null) return 'offline';
  if (current.session !== assignment.session || current.generation !== assignment.generation) return 'stale';
  if (PI.test(current.desktop ?? '')) return 'stale';
  return 'bound';
}

function output(summary, body) {
  console.log(summary);
  console.log(JSON.stringify({ ...body, running: 'unknown', unsupported: ['compact', 'wake', 'messages', 'launch', 'adapters'] }, null, 2));
}

async function persist(version, state) {
  const body = JSON.stringify(state);
  stateBody(body);
  let written;
  try { written = await updateRegistry(KEY, version, body); }
  catch (error) {
    if (error.message.startsWith('memoryd registry token unavailable')) refuse(error.message);
    refuse('write outcome unknown; read registry before any deliberate next mutation; no retry performed', 'unknown');
  }
  if (!written) refuse('registry version conflict; no overwrite or retry performed', 'conflict');
}

async function mutate(command, domain, flags, current, active) {
  const expected = numberFlag(flags, 'expected-version', 0);
  if (expected !== current.version) refuse(`registry version conflict: expected ${expected}, observed ${current.version}`, 'conflict');
  if (command === 'assign') {
    const leads = leadSettings();
    if (!leads.enabled) refuse('domain leads are disabled (domainLeads.enabled=false); unassign or re-enable instead');
    if (leads.domains && !leads.domains.includes(domain)) refuse(`domain ${domain} is not listed in domainLeads.domains`);
    if (!active.has(domain)) refuse('assign requires a known active domain');
    const assignment = record({ handle: flags.handle, nativeClient: flags['native-client'], evidence: flags.evidence,
      session: flags.session, generation: numberFlag(flags, 'generation', 1) });
    const status = resolution(assignment, await bindings(flags['orch-url']));
    if (status !== 'bound') refuse(`cannot assign: binding is ${status}`);
    current.state.assignments[domain] = assignment;
  } else {
    if (!Object.hasOwn(current.state.assignments, domain)) refuse('domain is already unassigned');
    delete current.state.assignments[domain];
  }
  await persist(expected, current.state);
  output(`${command === 'assign' ? 'Assigned' : 'Unassigned'} ${domain}; registry v${expected + 1}`, { status: 'written', version: expected + 1, domain });
}

async function main() {
  const { command, domain, flags } = options(process.argv.slice(2));
  const active = activeDomains();
  const current = await registry();
  const assignments = current.state.assignments;
  if (command === 'list') {
    const rows = Object.entries(assignments).map(([name, assignment]) => ({ domain: name, assignment, orphaned: !active.has(name) }));
    output(`${rows.length} native lead assignment(s); registry v${current.version}; running clients not verified`, { version: current.version, assignments: rows });
    return;
  }
  if (command === 'resolve') {
    const assignment = assignments[domain] ?? null;
    const status = resolution(assignment, assignment ? await bindings(flags['orch-url']) : []);
    output(`${domain}: ${status}${!active.has(domain) ? ' (orphaned)' : ''}; running client not verified`, { version: current.version, domain, status, orphaned: !active.has(domain), assignment });
    return;
  }
  await mutate(command, domain, flags, current, active);
}

main().catch(error => {
  const message = String(error.message).replace(/[\r\n\p{Cc}]/gu, ' ').slice(0, 600);
  console.error(`Domain leads: ${error.status ?? 'unavailable'}: ${message}`);
  console.error(JSON.stringify({ status: error.status ?? 'unavailable', error: message }));
  process.exitCode = 1;
});
