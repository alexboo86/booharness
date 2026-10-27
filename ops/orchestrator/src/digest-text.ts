import { checkCommand, type VerifiedCheck } from './check-verify.ts';
import type { Digest } from './seats.ts';

// Preserve backslashes and the entire text; continuation lines remain under their item.
const item = (value: unknown): string => String(value).replace(/\r\n?/g, '\n').replace(/\n/g, '\n  ');

export type CriterionEntry = { criterion: string; check: string | null; reason?: string };

/** Operator 2026-09-30: advise smaller briefs after a turn exceeds this many calls. */
export const MODEL_CALL_LIMIT = 100;

/** Only Pi and native opencode persist per-call raw entries; other adapters store aggregates. */
export function modelCallFlags(raw: unknown, harness: unknown, family: unknown): string[] {
  if (harness !== 'pi' && !(harness === 'native' && family === 'opencode')) return [];
  if (!Array.isArray(raw)) return [];
  // addUsage nests each repair/support raw payload; its outer length is not a call count.
  const calls = raw.flat(Infinity);
  if (!calls.every((entry) => entry !== null && typeof entry === 'object'
    && typeof entry.input === 'number' && Number.isFinite(entry.input) && entry.input >= 0)) return [];
  return calls.length > MODEL_CALL_LIMIT
    ? [`long turn: ${calls.length} model calls (limit ${MODEL_CALL_LIMIT}): cut the next brief smaller`]
    : [];
}

/**
 * One flag per done-report criterion that nothing runnable proves: no check at all, a check that
 * names no command in checks, or a command orch's rerun did not pass (task 1641).
 */
export function criteriaFlags(report: Record<string, unknown> | null | undefined, verified: readonly VerifiedCheck[]): string[] {
  if (!report || report.status !== 'done' || !Array.isArray(report.criteria)) return [];
  const checks = (report.checks ?? []) as { command: string }[];
  const reruns = new Map(verified.map((entry) => [entry.command, entry]));
  const flags: string[] = [];
  for (const [i, entry] of (report.criteria as CriterionEntry[]).entries()) {
    const label = `criterion ${i + 1} (${String(entry.criterion).slice(0, 80)})`;
    if (entry.check === null || entry.check === undefined) { flags.push(`${label}: no runnable check — ${String(entry.reason ?? 'no reason given')}`); continue; }
    const named = String(entry.check);
    const hit = checks.find((check) => checkCommand(check.command) === checkCommand(named) || check.command.includes(named));
    if (!hit) { flags.push(`${label}: check names no command in checks: ${named}`); continue; }
    const rerun = reruns.get(checkCommand(hit.command));
    if (!rerun) flags.push(`${label}: check not verified by orch rerun: ${hit.command}`);
    else if (rerun.result === 'fail') flags.push(`${label}: check failed on rerun: ${hit.command}`);
    else if (rerun.result !== 'pass') flags.push(`${label}: check unverified (${rerun.reason ?? 'no reason'}): ${hit.command}`);
  }
  return flags;
}

function languageLine(language: NonNullable<Digest['language']>): string {
  const rejected = language.rejected.length
    ? language.rejected.map((row) => `${row.word} (${row.alternatives.join(' | ') || 'no alternative'})`).join(', ')
    : 'none';
  const unknown = language.unknown.length ? language.unknown.join(', ') : 'none';
  return `judged ${language.judgedWords}, violations ${language.violationsPer100Words} per 100 words, technical names ${language.technicalNameShare}%, long sentences ${language.longSentences}, rejected ${rejected}, unknown ${unknown}`;
}

/** Human delivery for wait and seat_wait. The raw digest remains available with --json / json: true. */
export function formatDigest(digest: Digest): string {
  const rows: string[] = [];
  for (const flag of digest.flags ?? []) rows.push(`FLAG: ${item(flag)}`);
  rows.push(`seat ${item(digest.seat)} · role ${item(digest.role)} · family ${item(digest.family)} · turn ${item(digest.turn)} · status ${item(digest.status)} · seconds ${digest.seconds ?? 'n/a'} · tokens ${digest.tokens?.total ?? 'n/a'} · tools ${digest.tools ?? 'n/a'} · error ${digest.error == null ? 'none' : item(digest.error)}`);
  if (digest.language) rows.push(`language: ${item(languageLine(digest.language))}`);
  if (digest.compactions !== undefined) rows.push(`compactions: ${digest.compactions ?? 'n/a'}`);
  const scope = digest.scope;
  const feature = (value: number | null): string => value === null ? 'n/a' : value.toFixed(1);
  const features = scope?.features
    ? ` · difficulty ${feature(scope.features.difficulty)} · ui ${feature(scope.features.layer_ui)} rust ${feature(scope.features.layer_rust)} orch ${feature(scope.features.layer_orch)}`
    : '';
  if (scope?.status === 'scored') rows.push(`scope: Jev ${scope.score.toFixed(2)}${features}`);
  else if (scope) rows.push(`scope: ${scope.status} — ${item(scope.reason)}`);
  const session = digest.watch?.session;
  if (session && session.mode !== 'first') rows.push(`session: ${session.mode}${session.reason ? ` — ${item(session.reason)}` : ''}`);
  if (digest.worktree) rows.push(`worktree: branch ${item(digest.worktree.branch ?? 'none')} · files ${digest.worktree.files} · stat ${item(digest.worktree.stat)}`);
  for (const recheck of digest.rechecks ?? []) rows.push(`recheck (${recheck.kind === 'new' ? `new reviewer, replaces ${item(recheck.replaces)}` : 'same reviewer'}): ${item(recheck.reviewer)} · turn ${item(recheck.turn)}`);
  for (const note of digest.recheckNotes ?? []) rows.push(`recheck note: ${item(note)}`);
  for (const note of digest.support ?? []) rows.push(`support round: ${item(note)}`);
  const grade = digest.grade;
  if (grade?.status === 'graded') {
    rows.push(`grade: realReport ${grade.realReport} · evidenceSupports ${grade.evidenceSupports.join(', ') || '(none)'}`);
    for (const sibling of grade.siblings ?? []) {
      if (sibling.status === 'graded') rows.push(`grade sibling ${item(sibling.seat)}: ${sibling.pairs.map((pair) => `${pair.finding}↔${pair.siblingFinding} ${pair.probability}`).join(', ') || '(none)'}`);
      else rows.push(`grade sibling ${item(sibling.seat)}: ungraded — ${item(sibling.reason)}`);
    }
  } else if (grade?.status === 'ungraded') rows.push(`grade: ungraded — ${item(grade.reason)}`);
  const report = digest.report;
  if (!report) {
    rows.push(`report: null${digest.reportError ? ` (${item(digest.reportError)})` : ''}${digest.reportError?.includes('seat_report') ? '' : `; raw text: seat_report ${item(digest.turn)}`}`);
    return rows.join('\n');
  }
  rows.push(`report: ${item(report.status)}`);
  const findings = (report.findings ?? []) as { severity: string; claim: string; evidence: string; reproduced: boolean }[];
  const active = findings.filter((finding) => finding.severity !== 'withdrawn');
  const advisory = report.verdict === 'REQUEST_CHANGES' && active.length > 0 && active.every((finding) => !finding.reproduced);
  if (report.verdict !== undefined) rows.push(`verdict: ${item(report.verdict)}${advisory ? ' (advisory; suggestions only)' : ''}`);
  const proposals = (report.memory ?? []) as { op: string; id?: number; title: string; reason: string; body: string; links?: Record<string, unknown> }[];
  if (proposals.length) {
    rows.push(`memory proposals: ${proposals.length} (worker lesson appends auto-apply at completion; lesson supersede/retire and non-lessons require lead memory_apply ${item(digest.turn)})`);
    for (const application of digest.lessonApplications ?? []) {
      rows.push(`lesson[${application.index}]: ${item(application.title)} · ${item(application.outcome)}`);
    }
    for (const [index, proposal] of proposals.entries()) {
      rows.push(`memory[${index}]: ${item(proposal.op)} · id ${proposal.id ?? 'new'} · ${item(proposal.title)} · ${item(proposal.reason)}`);
      rows.push(`    links: ${proposal.links === undefined ? '(none)' : item(JSON.stringify(proposal.links))}`);
      const body = proposal.body.slice(0, 600);
      rows.push(`    body: ${item(body).replace(/\n {2}/g, '\n    ')}${proposal.body.length > 600 ? ` (+${proposal.body.length - 600} chars)` : ''}`);
    }
  }
  if (!findings.length) rows.push('findings: none');
  for (const finding of findings) {
    const label = !finding.reproduced && finding.severity !== 'withdrawn' ? 'suggestion' : finding.severity;
    rows.push(`[${item(label)}] ${item(finding.claim)} — ${item(finding.evidence)} (${finding.reproduced ? 'observed; reproduced' : 'inferred; not reproduced'})`);
  }
  const verified = new Map((digest.verified ?? []).map((check) => [check.command, check]));
  for (const check of (report.checks ?? []) as { command: string; result: string; tail: string }[]) {
    const rerun = check.result === 'pass' ? verified.get(checkCommand(check.command)) : undefined;
    const location = rerun?.host ? ` on host ${item(rerun.host)}` : '';
    const tag = !rerun ? '' : rerun.result === 'pass' ? ` [verified${location}]`
      : rerun.result === 'fail' ? ` [VERIFIED FAIL${location}: ${item(rerun.line ?? 'no output')}]` : ` [unverified${location} (${item(rerun.reason ?? 'no reason')})]`;
    rows.push(`${item(check.command)}: ${item(check.result)}${tag}${check.tail ? ` — ${item(check.tail)}` : ''}`);
  }
  if (report.changedFiles !== undefined) rows.push(`changedFiles: ${(report.changedFiles as string[]).map(item).join(', ') || '(none)'}`);
  for (const [i, criterion] of ((report.criteria ?? []) as CriterionEntry[]).entries()) {
    rows.push(`criterion ${i + 1}: ${item(criterion.criterion)} — check: ${criterion.check === null ? `none (${item(criterion.reason ?? 'no reason')})` : item(criterion.check)}`);
  }
  for (const checked of (report.checked ?? []) as string[]) rows.push(`checked: ${item(checked)}`);
  for (const unchecked of (report.notChecked ?? []) as string[]) rows.push(`notChecked: ${item(unchecked)}`);
  if (report.forLead !== undefined) rows.push(`forLead: ${item(report.forLead)}`);
  return rows.join('\n');
}

/** All CLI error envelopes use the same text line unless --json requests the original object. */
export function formatWaitError(turn: string, error: string): string {
  return `turn ${item(turn)}: error: ${item(error)}`;
}
