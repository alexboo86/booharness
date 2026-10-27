#!/usr/bin/env node
// Lead UserPromptSubmit hook, fail-open: a miss or error never blocks the prompt.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../scripts/lib/is-main.mjs';
import { ask as askJev } from './jev-client.mjs';
import { describe, questionKey } from './skill-router.mjs';
import { readKnowledgePage, renderKnowledgePage } from './knowledge-page-lib.mjs';
import { deliveredMarksDir } from './domain-lessons-hook.mjs';
import { serviceUrl } from '../../scripts/memory/service-client.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CAP = 6 * 1024;
const DOMAIN_P = 0.5;
const catalogueNames = (root) => readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md')))
  .map((entry) => entry.name).sort();

const BUDGET_MS = 1500;
const TEXT_CAP = 8000;
const ID_RE = '[1-9]\\d*';

function remember(hits, id, index, follow) {
  if (!new RegExp(`^${ID_RE}$`).test(id) || !Number.isSafeInteger(Number(id))) return;
  hits.push({ id, index, follow: Boolean(follow) });
}

function scanNamed(prompt) {
  if (typeof prompt !== 'string' || !prompt) return [];
  const hits = [];
  const forms = [
    { re: new RegExp(`\\bmemoryctl\\s+get\\s+#?(${ID_RE})\\b`, 'gi'), follow: false },
    { re: new RegExp(`\\bhandoff\\s+#?(${ID_RE})\\b`, 'gi'), follow: false },
    { re: new RegExp(`\\bget\\s+#?(${ID_RE})\\s+--follow\\s+latest\\b`, 'gi'), follow: true },
  ];
  for (const { re, follow } of forms) {
    for (const match of prompt.matchAll(re)) {
      remember(hits, match[1], match.index + match[0].lastIndexOf(match[1]), follow);
    }
  }
  const listRe = new RegExp(`(?:^|[^\\p{L}\\p{N}_])записи\\s+((?:#?${ID_RE}(?:\\s*,\\s*#?${ID_RE})*))`, 'giu');
  for (const match of prompt.matchAll(listRe)) {
    const list = match[1];
    const start = match.index + match[0].indexOf(list);
    for (const item of list.matchAll(new RegExp(`#?(${ID_RE})`, 'g'))) {
      remember(hits, item[1], start + item.index, false);
    }
  }
  const byId = new Map();
  for (const hit of hits.sort((a, b) => a.index - b.index || Number(b.follow) - Number(a.follow))) {
    const prev = byId.get(hit.id);
    if (!prev) byId.set(hit.id, { ...hit });
    else if (hit.follow) prev.follow = true;
  }
  return [...byId.values()].slice(0, 3);
}

/** Ids a prompt names as a handoff or entry to read, in order, at most 3. */
export function namedMemoryIds(prompt) {
  return scanNamed(prompt).map((item) => item.id);
}

async function fetchMemoryEntry(id, { signal, follow } = {}) {
  const base = serviceUrl().replace(/\/+$/, '');
  const url = new URL('/api/memory/entry', `${base}/`);
  url.searchParams.set('id', id);
  if (follow) url.searchParams.set('follow', follow);
  const response = await fetch(url, { signal, redirect: 'error' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function entriesText(entries) {
  let text = '';
  for (const entry of entries) {
    const block = `#${entry.id} ${entry.title}\n\n${entry.body}`;
    const sep = text ? '\n\n' : '';
    if (text.length + sep.length >= TEXT_CAP) break;
    let slice = block.slice(0, TEXT_CAP - text.length - sep.length);
    if (/[\uD800-\uDBFF]$/.test(slice)) slice = slice.slice(0, -1);
    if (!slice) break;
    text += sep + slice;
    if (slice.length < block.length) break;
  }
  return text;
}

async function readNamedEntries(specs, fetchEntry, deadline) {
  const out = new Array(specs.length).fill(null);
  const ms = Math.max(0, deadline - Date.now());
  if (!ms) return [];
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), ms);
  let pending = specs.length;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const finish = () => { if (--pending === 0) settle(); };
  for (const [index, spec] of specs.entries()) {
    Promise.resolve()
      .then(() => fetchEntry(spec.id, {
        timeoutMs: ms,
        signal: controller.signal,
        ...(spec.follow ? { follow: 'latest' } : {}),
      }))
      .then((row) => {
        if (row && typeof row.title === 'string' && typeof row.body === 'string') {
          out[index] = { id: spec.id, title: row.title, body: row.body };
        }
      })
      .catch(() => {})
      .finally(finish);
  }
  let raceTimer;
  await Promise.race([done, new Promise((resolve) => { raceTimer = setTimeout(resolve, ms); })]);
  clearTimeout(raceTimer);
  clearTimeout(abortTimer);
  controller.abort();
  return out.filter(Boolean);
}

/** Route a lead's first substantial prompt; all failures leave the session retryable. */
export async function routeLeadTask(event, {
  ask = askJev, fetchEntry = fetchMemoryEntry, repoRoot = ROOT,
  stateDir = join(tmpdir(), 'toolset-lead-task-router'),
} = {}) {
  let claimed = '';
  const written = [];
  try {
    if (process.env.ORCH_SEAT_ID || typeof event?.prompt !== 'string' || event.prompt.trim().length < 40) return;
    const session = String(event.session_id ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
    const marks = deliveredMarksDir(event.session_id);
    if (!marks) return;
    const marker = join(stateDir, session);
    if (existsSync(marker)) return;
    const named = scanNamed(event.prompt);
    // Decision 18596: no named entry is not a task. Do not call Jev or spend the marker.
    if (!named.length) return;
    const domainsRoot = join(repoRoot, '.agents/domains');
    const domains = [];
    for (const name of catalogueNames(domainsRoot).filter((name) => /^domain-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
      try { domains.push(describe(name, domainsRoot)); }
      catch { /* one broken catalogue entry must not mute the others */ }
    }
    const key = (name) => questionKey(`domain_${name}`);
    const questions = Object.fromEntries(domains.map(({ name, questionDescription }) => [key(name), {
      type: 'noul', instructions: `Does this task need the domain '${name}'? The domain: ${questionDescription}`,
    }]));
    if (!Object.keys(questions).length) return;
    const deadline = Date.now() + BUDGET_MS;
    const entries = await readNamedEntries(named, fetchEntry, deadline);
    if (!entries.length) return;
    const text = entriesText(entries);
    if (!text.trim()) return;
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) return;
    const result = await ask({ text, questions, timeoutMs, maxChars: TEXT_CAP });
    if (result?.error || !result?.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) return;
    const selected = (name) => {
      const p = result.answers[key(name)]?.noul;
      return typeof p === 'number' && Number.isFinite(p) && p >= DOMAIN_P && p <= 1;
    };
    const parts = [];
    const delivered = [];
    let used = 0;
    const admit = (text) => {
      const bytes = Buffer.byteLength(text, 'utf8') + (parts.length ? 2 : 0);
      if (used + bytes > CAP) return false;
      parts.push(text);
      used += bytes;
      return true;
    };
    for (const { name } of domains) {
      if (!selected(name) || existsSync(join(marks, 'knowledge', name))) continue;
      let index;
      try {
        const page = readKnowledgePage(name, (path) => {
          try { return readFileSync(join(repoRoot, path), 'utf8'); }
          catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        });
        if (!page) continue;
        // Empty selection uses the shared index renderer, never page-body passages.
        index = renderKnowledgePage(name, page, [], Buffer.byteLength(page.head), new Set());
      } catch { continue; }
      if (admit(`## Knowledge: ${name}\n\n${index}`)) delivered.push(name);
    }
    if (!parts.length) return;
    const output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') } };
    mkdirSync(stateDir, { recursive: true });
    if (delivered.length) mkdirSync(join(marks, 'knowledge'), { recursive: true });
    // Only the winner may deliver. Nothing above this point spends the session marker.
    writeFileSync(marker, String(Date.now()), { flag: 'wx' });
    claimed = marker;
    for (const domain of delivered) {
      const mark = join(marks, 'knowledge', domain);
      try {
        writeFileSync(mark, String(Date.now()), { flag: 'wx' });
        written.push(mark);
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return output;
  } catch {
    // An interrupted marks write must not permanently mute a retry.
    for (const mark of [...written, ...(claimed ? [claimed] : [])]) {
      try { unlinkSync(mark); } catch { /* fail-open cleanup */ }
    }
  }
}

if (isMain(import.meta.url)) {
  try {
    const output = await routeLeadTask(JSON.parse(readFileSync(0, 'utf8')));
    if (output) writeSync(1, JSON.stringify(output));
  } catch { /* a context hook must never block a prompt */ }
}
