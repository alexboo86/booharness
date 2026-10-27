#!/usr/bin/env node
// Client-side lesson write gate. Keep the service's schema and curator policy separate.
import { appendFileSync, readFileSync } from 'node:fs';
import { isMain } from '../lib/is-main.mjs';
import { checkCaptureFields } from './capture-gate.mjs';

export const LIMITS = Object.freeze({ title: 120, rule: 300, trigger: 400, why: 400, evidence: 400 });
// Targets are writing advice, not a gate; trigger has no measured target.
// LIMITS are hard code-point ceilings unless --long explains the extra length.
export const TARGETS = Object.freeze({ title: 40, rule: 110, why: 120, evidence: 70 });
export const LESSON_SIZES = 'Lesson sizes (code points): suggested targets title ~40, rule ~110 (one sentence), why ~120, evidence ~70 (advice, not refusal); ceilings title <=120, rule <=300, trigger/why/evidence <=400.';
const FIELDS = Object.keys(LIMITS);
const LESSON_GUIDANCE = `Use body lines - trigger: <text>, - rule: <text>, - why: <text>, - evidence: <text>. ${LESSON_SIZES} Capture with capture-lesson.mjs <domain> "<title>" --anchor <file:symbol> --trigger "<when>" --rule "<rule>" --why "<why>" --evidence "<evidence>" [--long "<reason>"].`;
const missingField = name => new Error(`lesson ${name} is missing; ${LESSON_GUIDANCE}`);

// Match store.mjs:parseLessonBody: only known field headers start a field, and
// only indented lines continue it. A bullet in a rule does not terminate it.
export function lessonFields(title, body, { partial = false, allowDuplicates = false } = {}) {
  if (typeof title !== 'string' || typeof body !== 'string') throw new Error('lesson title and body must be text');
  const fields = { title, trigger: '' };
  const seen = new Set();
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const field = line.match(/^-\s+(trigger|rule|why|evidence|date):\s*(.*)$/);
    if (field) {
      current = field[1];
      if (seen.has(current) && !allowDuplicates) throw new Error(`lesson ${current} is duplicated`);
      seen.add(current);
      fields[current] = field[2].trim() || '';
    } else if (current !== null && /^(?: {2,}|\t)\S/.test(line)) {
      const continuation = line.trim();
      fields[current] = fields[current] ? `${fields[current]}\n${continuation}` : continuation;
    } else current = null;
  }
  delete fields.date;
  if (!partial) for (const name of ['rule', 'why', 'evidence']) {
    if (!fields[name]) throw missingField(name);
  }
  return fields;
}

export function lessonChanges(old, title, body, { links } = {}) {
  let status;
  try { status = (typeof links === 'string' ? JSON.parse(links) : links)?.status; } catch { /* Invalid links belong to the store. */ }
  const retiring = status === 'retired' && /^(?:RETIRED|MERGED-INTO):/.test(title);
  const before = lessonFields(old.title, old.body, { partial: true, allowDuplicates: true });
  // Historical duplicate lines do not make metadata maintenance impossible,
  // but adding another occurrence is a newly written duplicate and is refused.
  const counts = text => [...text.matchAll(/^-\s+(trigger|rule|why|evidence|date):/gm)]
    .reduce((out, match) => ({ ...out, [match[1]]: (out[match[1]] || 0) + 1 }), {});
  const previous = counts(old.body);
  for (const [name, count] of Object.entries(counts(body))) {
    if (count > 1 && count > (previous[name] || 0)) throw new Error(`lesson ${name} is duplicated`);
  }
  const after = lessonFields(title, body, { partial: true, allowDuplicates: true });
  const only = FIELDS.filter(name => !(retiring && name === 'title') && before[name] !== after[name]);
  for (const name of only) if (!after[name] && name !== 'trigger') throw missingField(name);
  return { fields: after, only };
}

export function withLongReason(body, long) {
  return long ? `${body.trimEnd()}\n- long: ${JSON.stringify(long)}\n` : body;
}

/** Enforce code-point ceilings on newly authored fields only. Targets are advice. */
export async function checkLesson(fields, { long, only = FIELDS, notify = console.error } = {}) {
  if (long !== undefined && (typeof long !== 'string' || !long.trim())) throw new Error('--long needs a nonempty explanation');
  if (!only.length) {
    if (long !== undefined) notify('lesson: --long ignored; no lesson field changed');
    return { longIgnored: long !== undefined };
  }
  for (const name of only) if (typeof fields[name] !== 'string' || (!fields[name].trim() && name !== 'trigger')) {
    throw missingField(name);
  }
  const objections = only.flatMap(name => {
    const length = [...fields[name]].length;
    return length > LIMITS[name] && !long
      ? [`${name}: ${length} chars / ${LIMITS[name]}; --long reason required${TARGETS[name] ? `; target ~${TARGETS[name]} (advice)` : ''}`]
      : [];
  });
  if (objections.length) throw new Error(`lesson refused:\n  ${objections.join('\n  ')}`);
  return { longIgnored: false };
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const titleFile = args[0] === '--title-file' ? args.splice(0, 2)[1] : null;
    const [literalTitle, bodyFile, long, oldFile, links] = titleFile ? ['', ...args] : args;
    const title = titleFile ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(titleFile)) : literalTitle;
    const body = readFileSync(bodyFile, 'utf8');
    const change = oldFile
      ? lessonChanges(JSON.parse(readFileSync(oldFile, 'utf8')), title, body, { links })
      : { fields: lessonFields(title, body), only: FIELDS };
    const quality = await checkLesson(change.fields, { only: change.only, long: long || undefined });
    checkCaptureFields(change.fields, { only: change.only });
    if (long && !quality.longIgnored) appendFileSync(bodyFile, `\n- long: ${JSON.stringify(long)}\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
