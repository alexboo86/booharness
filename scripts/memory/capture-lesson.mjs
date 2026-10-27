#!/usr/bin/env node
// Capture a gated domain lesson into memoryd as kind=lesson links.status=active.
// Writes via memoryctl append — NO silent file fallback. Loud fail if memoryctl/HTTP absent.
//
// Usage:
//   node scripts/memory/capture-lesson.mjs <domain> "<title>" \
//     --anchor <file:symbol> --trigger "<when>" --rule "<rule>" --why "<root cause>" --evidence "<commit/test>" \
//     [--date YYYY-MM-DD] [--long "<reason for exceeding a ceiling>"]
//     [--probe "<command>" (--expect "<regexp>" | --expect-absent "<regexp>")]
//
// A probe is what turns a lesson from prose into something a sweep can re-check.
// --expect-absent exists because half the lessons here assert an ABSENCE ("rtk
// has no reset subcommand"), and a sweep that only knows --expect reads every
// such mention as breakage.

import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/is-main.mjs';

import {
  REPO_ROOT,
  buildLessonLinks,
  isGlobAnchor,
  probeObjections,
  resolveMemoryctl,
  runMemoryctl,
} from './lesson-lib.mjs';
import { LESSON_SIZES } from './lesson-quality.mjs';
import { routedLessonDomain, checkCaptureFields } from './capture-gate.mjs';

/**
 * Render an anchored lesson block (same schema as lessons.md).
 * @param {{ title: string, anchor: string, trigger?: string, rule: string, why: string, evidence: string, date: string }} p
 */
export function renderLesson({ title, anchor, trigger, rule, why, evidence, date, probe }) {
  // The probe is rendered as well as stored in links: a human reading the lesson
  // must see the same expectation the sweep will enforce, or the two drift apart
  // and only one of them is checked.
  const probeLine = probe?.cmd
    ? `- probe: ${probe.cmd} => ${probe.absent ? `must NOT print /${probe.absent}/` : `must print /${probe.expect}/`}`
    : null;
  return [
    `## ${title}`,
    `- anchor: ${anchor}`,
    trigger ? `- trigger: ${trigger}` : null,
    `- rule: ${rule}`,
    `- why: ${why}`,
    `- evidence: ${evidence}`,
    probeLine,
    `- date: ${date}`,
    '',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : process.argv[i + 1];
}

/**
 * Normalize domain arg to domain-<name>.
 * @param {string} domain
 */
export function normalizeDomain(domain) {
  if (!domain) throw new Error('domain required');
  return domain.startsWith('domain-') ? domain : `domain-${domain}`;
}

/**
 * Validate CLI args; throw with usage-style message.
 */
export const CAPTURE_USAGE = `usage: capture-lesson.mjs <domain> "<title>" --anchor <file:symbol> --trigger "<when>" --rule "<rule>" --why "<root cause>" --evidence "<commit/test>" [--date YYYY-MM-DD] [--long "<reason>"]\n${LESSON_SIZES} Targets are advice only; --long "<reason>" allows fields over their ceiling.`;

export function validateCaptureArgs({ domain, title, anchor, trigger, rule, why, evidence }) {
  if (!domain || !title || domain.startsWith('--') || title.startsWith('--')) {
    throw new Error(CAPTURE_USAGE);
  }
  if (!anchor || anchor === '?') throw new Error('--anchor is required');
  if (!rule || rule === '?') throw new Error('--rule is required');
  if (!why || why === '?') throw new Error('--why is required');
  checkCaptureFields({ trigger, evidence });
}

/**
 * Build the probe object from CLI args, or null when none was asked for.
 * Refuses loudly rather than recording something a sweep would then decline to
 * run — a probe that cannot execute is worse than no probe, because the lesson
 * reads as checked.
 */
export function buildProbe({ probe, expect, absent }) {
  if (!probe && !expect && !absent) return null;
  if (!probe) throw new Error('--expect / --expect-absent need --probe: an expectation with no command checks nothing');
  const built = { cmd: String(probe).trim(), ...(expect ? { expect } : {}), ...(absent ? { absent } : {}) };
  const objections = probeObjections(built);
  if (objections.length) throw new Error(`probe refused:\n  ${objections.join('\n  ')}`);
  return built;
}

/**
 * Capture via memoryctl append --kind lesson (status=active), after pre-append gates.
 * @param {object} p
 * @returns {Promise<{ stdout: string, links: object, domain: string, substitution: string | null }>}
 */
export async function captureLesson(p, { run = runMemoryctl, resolve = resolveMemoryctl } = {}) {
  const domain = normalizeDomain(p.domain);
  validateCaptureArgs({
    domain,
    title: p.title,
    anchor: p.anchor,
    trigger: p.trigger,
    rule: p.rule,
    why: p.why,
    evidence: p.evidence,
  });

  // Validated here as well as in buildProbe: a programmatic caller reaches
  // captureLesson directly and must not be able to store a probe the sweep will
  // then refuse to run.
  const probe = p.probe ?? null;
  if (probe) {
    const objections = probeObjections(probe);
    if (objections.length) throw new Error(['probe refused:', ...objections].join('\n  '));
  }

  const body = renderLesson({
    title: p.title,
    anchor: p.anchor,
    trigger: p.trigger,
    rule: p.rule,
    why: p.why,
    evidence: p.evidence,
    date: p.date || new Date().toISOString().slice(0, 10),
    probe,
  });

  // Route before memoryctl's own capture gate so its POST receives the corrected domain.
  const routedDomain = routedLessonDomain(p.anchor, domain,
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs/agent/domain-routing.generated.json'), 'utf8')));
  const substitution = routedDomain !== p.domain ? `domain ${p.domain} -> ${routedDomain}: routed for ${p.anchor.split(':')[0]}` : null;
  const links = buildLessonLinks({
    domain: routedDomain,
    anchor: p.anchor,
    status: 'active',
    trigger: p.trigger,
    probe,
    globs: isGlobAnchor(p.anchor) ? [p.anchor] : [],
  });

  // The memoryctl lesson append path applies the shared capture gate before POST.
  resolve(REPO_ROOT);

  const result = run(
    [
      'append',
      '--kind', 'lesson',
      '--title', p.title,
      '--body-file', '-',
      '--links', JSON.stringify(links),
      '--session', p.session || process.env.MEMORYCTL_SESSION_ID || 'capture',
      '--agent', p.agent || process.env.MEMORYCTL_AGENT_ID || 'capture-lesson',
      ...(p.long !== undefined ? ['--long', p.long] : []),
    ],
    { cwd: REPO_ROOT, input: body },
  );
  return { stdout: result.stdout, links, domain: routedDomain, substitution };
}

if (isMain(import.meta.url) && process.argv.includes('--help')) {
  console.log(CAPTURE_USAGE);
} else if (isMain(import.meta.url)) {
  try {
    const domain = process.argv[2];
    const title = process.argv[3];
    const result = await captureLesson({
      domain,
      title,
      anchor: arg('--anchor', '?'),
      trigger: arg('--trigger'),
      rule: arg('--rule', '?'),
      why: arg('--why', '?'),
      evidence: arg('--evidence', '?'),
      date: arg('--date', new Date().toISOString().slice(0, 10)),
      long: arg('--long'),
      probe: buildProbe({ probe: arg('--probe'), expect: arg('--expect'), absent: arg('--expect-absent') }),
    });
    console.log(`captured -> memoryd kind=lesson status=active domain=${result.domain}`);
    if (result.substitution) console.log(result.substitution);
    if (result.stdout.trim()) console.log(result.stdout.trim());
  } catch (err) {
    console.error(String(err?.message || err));
    process.exit(typeof err?.status === 'number' && err.status !== 0 ? err.status : 1);
  }
}
