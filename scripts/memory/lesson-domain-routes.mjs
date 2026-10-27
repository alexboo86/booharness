// One routing decision for the read-only gate and the service-backed repair.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isGlobAnchor, parseLinks, REPO_ROOT } from './lesson-lib.mjs';
import { resolveDomain } from './store.mjs';
import { gateMovedLesson } from './capture-gate.mjs';

/** Retirement is routing data, not a mutation of historical lesson links. */
export function auditLessonDomainRoutes(rows, map) {
  const retired = map.retiredDomains ?? {};
  const routed = new Set([
    ...Object.keys(map.byDomain),
    ...map.order.map(({ domain }) => domain),
  ]);
  const conflicts = Object.keys(retired).filter((domain) => routed.has(domain));
  const retiredCounts = Object.fromEntries(Object.keys(retired).map((domain) => [domain, 0]));
  const unknown = [];
  const current = [];
  for (const row of rows) {
    const links = row.linksObj || parseLinks(row.links);
    const domain = String(links.domain || '?');
    if (Object.hasOwn(retired, domain)) {
      retiredCounts[domain]++;
    } else {
      current.push(row);
      if (!routed.has(domain)) unknown.push({ row, domain });
    }
  }
  return { current, retiredCounts, conflicts, unknown, mismatches: mismatchedLessonDomains(current, map) };
}

/** Every concrete file has a route, including files only on another branch. GONE/glob anchors are handled by the sweep. */
export function mismatchedLessonDomains(rows, map) {
  const out = [];
  for (const row of rows) {
    const links = row.linksObj || parseLinks(row.links);
    if (row.status === 'retired' || links.status === 'retired') continue;
    if (Object.hasOwn(map.retiredDomains ?? {}, String(links.domain))) continue;
    const anchor = String(links.anchor || '');
    const file = anchor.split(':')[0];
    if (!file || file === '?' || isGlobAnchor(file) || file.includes('[')) continue;
    const resolvedDomain = resolveDomain(file, map);
    if (resolvedDomain !== links.domain) {
      out.push({ row, links, anchor, storedDomain: String(links.domain || '?'), resolvedDomain });
    }
  }
  return out;
}

/** Preserve the complete lesson and links except the domain; only memoryctl may write the live store. */
export function supersedeDomain(row, domain, {
  session = process.env.MEMORYCTL_SESSION_ID || 'normalize-domains',
  agent = process.env.MEMORYCTL_AGENT_ID || 'normalize-lesson-domains',
} = {}) {
  // The move passes the capture gate; a refusal throws before the supersede.
  const links = gateMovedLesson(row, { ...(row.linksObj || parseLinks(row.links)), domain });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-domain-'));
  const bodyFile = path.join(dir, 'body.md');
  try {
    fs.writeFileSync(bodyFile, row.body ?? '', 'utf8');
    const args = [
      'supersede', '--id', String(row.id), '--title', row.title,
      '--body-file', bodyFile, '--links', JSON.stringify(links),
      '--session', session, '--agent', agent,
    ];
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'memoryctl.cmd', ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 20000 })
      : spawnSync('memoryctl', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 20000 });
    if (!result || result.status !== 0) {
      const detail = String(result?.stderr || result?.stdout || result?.error?.message || 'unknown');
      throw new Error(`memoryctl supersede failed: ${detail.trim().slice(0, 400)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
