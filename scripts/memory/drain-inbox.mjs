#!/usr/bin/env node
// Rejudge live inbox lessons with the same gate used for new captures.
// Default is read-only; --apply supersedes only lessons the gate accepts.
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/is-main.mjs';
import { gateNewLesson, routedLessonDomain } from './capture-gate.mjs';
import { REPO_ROOT, filterLessons, parseLinks, runMemoryctl } from './lesson-lib.mjs';
import { carriedLinks, stampBody } from './promote-lesson.mjs';
import { readEntries } from './service-client.mjs';

export function supersedeAccepted(row, links) {
  runMemoryctl([
    'supersede', '--id', String(row.id), '--title', String(row.title),
    '--body-file', '-', '--links', JSON.stringify(links),
    '--session', process.env.MEMORYCTL_SESSION_ID || 'drain-inbox',
    '--agent', process.env.MEMORYCTL_AGENT_ID || 'drain-inbox',
  ], { cwd: REPO_ROOT, input: stampBody(row.body, 'promoted') });
}

export async function drainInbox({ apply = false, read = () => readEntries('lesson'), gate = gateNewLesson,
  routing = () => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs/agent/domain-routing.generated.json'), 'utf8')),
  supersede = supersedeAccepted, print = console.log } = {}) {
  const rows = await read();
  const routingMap = routing();
  const inbox = filterLessons(rows, { status: 'inbox' })
    .filter((row) => (row.linksObj || parseLinks(row.links)).closed !== true);
  const plan = [];
  for (const row of inbox) {
    const links = row.linksObj || parseLinks(row.links);
    let accepted;
    let redomain;
    try {
      // Same explicit-route and ambiguity decision as a new capture; the
      // catchall floor cannot silently re-domain an inbox lesson.
      const domain = routedLessonDomain(links.anchor, links.domain, routingMap);
      if (domain !== links.domain) {
        redomain = { from: links.domain, to: domain };
        print(`#${row.id} redomain ${links.domain} -> ${domain}`);
      }
      accepted = await gate({ title: row.title, body: row.body,
        links: { ...links, domain } }, { routing: () => routingMap });
    } catch (error) {
      const reason = String(error?.message || error);
      // An outage is not a verdict on the lesson: count it apart so the plan says "retry" (review reviewer-glm-2807d1.1).
      const action = /unavailable|restore (Jev|memoryd)/.test(reason) ? 'error' : 'refuse';
      plan.push({ id: Number(row.id), action, reason, ...(redomain ? { redomain } : {}) });
      print(`#${row.id} ${action}: ${reason}`);
      continue;
    }
    const activeLinks = carriedLinks(accepted, accepted.domain, 'active');
    plan.push({ id: Number(row.id), action: 'pass', ...(redomain ? { redomain } : {}) });
    print(`#${row.id} pass${apply ? ' (applying)' : ''}`);
    // A failed write is not a gate refusal. Stop on uncertain mutation.
    if (apply) supersede(row, activeLinks);
  }
  print(`drain-inbox: ${plan.filter((item) => item.action === 'pass').length} pass, ${plan.filter((item) => item.action === 'refuse').length} refuse, ${plan.filter((item) => item.action === 'error').length} error${apply ? ' (applied)' : ' (dry run)'}`);
  return plan;
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--apply')) throw new Error('usage: node scripts/memory/drain-inbox.mjs [--apply]');
    await drainInbox({ apply: process.argv.includes('--apply') });
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
