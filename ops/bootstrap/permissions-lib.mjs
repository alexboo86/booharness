// Lead permission lists: portable canon + values computed on the target machine.
//
// `platforms` answers which OS a rule means anything on. It does not answer
// whose machine this is. An ssh Host alias, a checkout path and a disk name
// are machine values — they are true on one operator box and false on the
// next Mac with the same OS. Those entries must declare `machine`, and the
// installer evaluates them here; a bare rule string that carries such a
// token is a canon defect, the same class as a transcribed {repo} path in
// codex-trust.json.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SSH_OPTION_TAKES_ARG = new Set([
  'b',
  'c',
  'D',
  'E',
  'e',
  'F',
  'I',
  'i',
  'J',
  'L',
  'l',
  'm',
  'O',
  'o',
  'p',
  'Q',
  'R',
  'S',
  'W',
  'w',
]);

export function commandFromRule(rule) {
  const match = /^(?:Bash|PowerShell)\((.+)\)$/.exec(rule);
  return match ? match[1] : String(rule);
}

export function sshHostFromRule(rule) {
  const parts = commandFromRule(rule).match(/\S+/g);
  if (!parts || parts[0] !== 'ssh') return null;
  let i = 1;
  while (i < parts.length) {
    const token = parts[i];
    if (token === '--') {
      i += 1;
      break;
    }
    if (!token.startsWith('-') || token === '-') break;
    if (token.startsWith('--')) {
      i += token.includes('=') ? 1 : 2;
      continue;
    }
    const flags = token.slice(1);
    if (SSH_OPTION_TAKES_ARG.has(flags[0]) && flags.length > 1) {
      i += 1;
      continue;
    }
    const last = flags[flags.length - 1];
    i += SSH_OPTION_TAKES_ARG.has(last) ? 2 : 1;
  }
  const dest = parts[i];
  if (!dest || dest.startsWith('-')) return null;
  const at = dest.lastIndexOf('@');
  return at === -1 ? dest : dest.slice(at + 1);
}

export function isMachineBoundHost(host) {
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  if (host.includes(':') && /^[0-9a-fA-F:]+$/.test(host)) return false;
  if (host.includes('.')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(host);
}

const SPECIFIC_POSIX = [
  /\/(?:Users|home)\/(?!\*)([^/\s*)]+)/g,
  /\/c\/Users\/(?!\*)([^/\s*)]+)/g,
  /\/Volumes\/(?!\*)([^/\s*)]+)/g,
];

export function machineBoundPaths(rule) {
  const found = [];
  for (const pattern of SPECIFIC_POSIX) {
    pattern.lastIndex = 0;
    for (const match of rule.matchAll(pattern)) {
      found.push(match[0]);
    }
  }
  for (const match of rule.matchAll(/[A-Za-z]:[\\/]([^\s)]+)/g)) {
    const rest = match[1];
    if (!rest || rest.includes('*')) continue;
    found.push(match[0]);
  }
  return found;
}

export function machineBoundTokens(rule) {
  const tokens = [];
  const host = sshHostFromRule(rule);
  if (host && isMachineBoundHost(host)) tokens.push({ kind: 'ssh-host', value: host });
  for (const value of machineBoundPaths(rule)) tokens.push({ kind: 'path', value });
  return tokens;
}

export function sshConfigDefinesHost(configText, host) {
  if (!configText || !host) return false;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = /^Host\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const token of match[1].split(/\s+/).filter(Boolean)) {
      if (token.startsWith('!')) continue;
      if (token.includes('*') || token.includes('?')) continue;
      if (token === host) return true;
    }
  }
  return false;
}

export function readSshConfig(home) {
  if (!home) return '';
  const file = path.join(home, '.ssh', 'config');
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8');
}

export function sshHostConfigured(host, ctx) {
  const text = ctx.sshConfigText ?? readSshConfig(ctx.home);
  return sshConfigDefinesHost(text, host);
}

export function entryApplies(entry, ctx) {
  if (entry.platforms && !entry.platforms.includes(ctx.platform)) return false;
  if (!entry.machine) return true;
  if (entry.machine === 'ssh-host') {
    const host = sshHostFromRule(entry.rule);
    if (!host) {
      throw new Error(
        `permission rule declares machine=ssh-host but names no ssh host: ${entry.rule}`,
      );
    }
    if (!isMachineBoundHost(host)) {
      throw new Error(
        `permission rule declares machine=ssh-host but '${host}' is not a machine alias: ${entry.rule}`,
      );
    }
    return sshHostConfigured(host, ctx);
  }
  throw new Error(`unknown machine predicate '${entry.machine}' on ${entry.rule}`);
}

export function selectPermissionRules(canon, ctx) {
  const forHere = (entries) =>
    (entries || []).filter((entry) => entryApplies(entry, ctx)).map((entry) => entry.rule);
  return { allow: forHere(canon.allow), deny: forHere(canon.deny) };
}

export function ungatedMachineBoundEntries(canon) {
  const findings = [];
  for (const list of ['allow', 'deny']) {
    for (const entry of canon[list] || []) {
      const tokens = machineBoundTokens(entry.rule);
      if (tokens.length === 0) continue;
      if (entry.machine) continue;
      findings.push({ list, rule: entry.rule, tokens });
    }
  }
  return findings;
}

export function assertPermissionCanon(canon) {
  const findings = ungatedMachineBoundEntries(canon);
  if (findings.length === 0) return;
  const listed = findings
    .map((row) => `${row.list}: ${row.rule} (${row.tokens.map((token) => `${token.kind}=${token.value}`).join(', ')})`)
    .join('; ');
  throw new Error(
    `permissions.json carries machine-bound rules without machine=: ${listed}. ` +
      'platforms answers which OS, not whose machine — tag the entry with machine (ssh-host) or compute the value at install.',
  );
}
