#!/usr/bin/env node
// Apply the adjudicated lesson plan one write at a time. No writes without --apply.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lessonChanges, checkLesson } from './lesson-quality.mjs';
import { gateMovedLesson } from './capture-gate.mjs';
import { cutTitle } from './archive-handoff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_PLAN = path.join(ROOT, 'output/lesson-fixes-2026-09-26/plan.json');

export async function run(planPath = DEFAULT_PLAN, { apply = false, gate = gateMovedLesson, quality = checkLesson, call = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  const base = path.dirname(path.resolve(planPath));
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  if (!Array.isArray(plan)) throw new Error('plan must be an array');
  const applied = [], skipped = [];
  const memoryctl = process.env.LESSON_FIXES_MEMORYCTL || 'memoryctl';
  const node = process.env.LESSON_FIXES_NODE || process.execPath;
  const get = (id, follow = false) => JSON.parse(call(memoryctl, ['get', String(id), ...(follow ? ['--follow', 'latest'] : []), '--json']));
  for (let index = 0; index < plan.length; index++) {
    const entry = plan[index];
    const { id, action } = entry;
    try {
      if (!Number.isSafeInteger(id) || id <= 0 || !['merge', 'retire', 'reanchor', 'rewrite', 'redomain'].includes(action)) throw new Error('invalid action/id');
      if (entry.bodyFile && (!entry.bodyFile.startsWith('bodies/') || !path.resolve(base, entry.bodyFile).startsWith(path.join(base, 'bodies') + path.sep))) throw new Error('invalid bodyFile');
      const bodyFile = entry.bodyFile && path.resolve(base, entry.bodyFile);
      const body = bodyFile && fs.readFileSync(bodyFile, 'utf8');
      if (['rewrite', 'merge'].includes(action) && !body) throw new Error('missing body');
      if (action === 'retire' && entry.into && (!Number.isSafeInteger(entry.into) || entry.into >= id)) throw new Error('merge target must be lower id');
      if (['reanchor', 'redomain'].includes(action) && entry.anchor && (!entry.anchor.split(':')[0] || path.isAbsolute(entry.anchor))) throw new Error('invalid anchor');
      const original = get(id);
      if (original.kind !== 'lesson') throw new Error('not a lesson');
      const current = original.live ? original : get(id, true);
      if (action === 'retire' && entry.into) {
        // Superseding the survivor during a preceding merge changes its numeric id.
        // Follow its lineage, but never retire the current head into itself (1555 -> 11470).
        const survivor = get(entry.into, true);
        if (!survivor.live || survivor.id === current.id || survivor.links?.status !== 'active') {
          throw new Error(`merge survivor #${entry.into} is not a separate live active lesson (latest #${survivor.id})`);
        }
      }
      const nextTitle = action === 'retire'
        ? cutTitle(`${entry.into ? `MERGED-INTO: ${entry.into}` : `RETIRED: ${entry.reason}`} — ${current.title}`)
        : current.title;
      const change = lessonChanges(current, nextTitle, body ?? current.body, {
        links: action === 'retire' ? { ...current.links, status: 'retired' } : current.links,
      });
      await quality(change.fields, { only: change.only });
      console.log(`QUALITY PASS #${id} (${action}; ${change.only.join(',') || 'unchanged fields'})`);
      if (!original.live) {
        const done = action === 'retire' ? current.links?.status === 'retired' && (!entry.into || current.title?.startsWith(`MERGED-INTO: ${entry.into}`))
          : ['rewrite', 'merge'].includes(action) ? current.body === body && current.links?.status === original.links?.status
          : current.links?.anchor === (entry.anchor || original.links?.anchor) && current.links?.domain === (action === 'redomain' ? entry.into : original.links?.domain);
        if (!done) throw new Error(`id ${id} superseded by another change; re-adjudicate`);
        skipped.push(id);
        continue;
      }
      const links = typeof current.links === 'string' ? JSON.parse(current.links) : current.links;
      if (action === 'redomain' && links.domain === entry.into && (!entry.anchor || links.anchor === entry.anchor)) { skipped.push(id); continue; }
      if (action === 'rewrite' && current.body === body) { skipped.push(id); continue; }
      if (action === 'reanchor' && links.anchor === entry.anchor) { skipped.push(id); continue; }
      if (action === 'merge' && !Number.isSafeInteger(entry.into)) throw new Error('merge target missing');
      if (!apply) { console.log(`WOULD ${action} #${id}${entry.into ? ` -> ${entry.into}` : ''}`); continue; }
      if (action === 'retire') call(node, ['scripts/memory/retire-lesson.mjs', '--id', String(id), ...(entry.into ? ['--merged-into', String(entry.into)] : ['--reason', entry.reason])]);
      else if (action === 'reanchor') call(node, ['scripts/memory/reanchor-lesson.mjs', '--id', String(id), '--to', entry.anchor]);
      else if (action === 'redomain') {
        const tempDir = fs.mkdtempSync(path.join('/tmp', 'lesson-fixes-'));
        try {
          const file = bodyFile || path.join(tempDir, `${id}.md`);
          if (!bodyFile) fs.writeFileSync(file, current.body, 'utf8');
          const next = gate({ ...current, linksObj: links }, {
            ...links, domain: entry.into, ...(entry.anchor ? { anchor: entry.anchor, globs: (links.globs || []).filter(glob => glob !== links.anchor) } : {}),
          });
          call(memoryctl, ['supersede', '--id', String(id), '--title', current.title, '--body-file', file, '--links', JSON.stringify(next)]);
        } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
      }
      else call(memoryctl, ['supersede', '--id', String(id), '--title', current.title, '--body-file', bodyFile]);
      applied.push(id);
      console.log(`APPLIED ${action} #${id}`);
    } catch (error) {
      const detail = error.stderr?.toString().trim() || error.message;
      throw new Error(`STOP #${id} (${action}): ${detail}; applied=[${applied.join(',')}]; remaining=[${plan.slice(index).map(x => x.id).join(',')}]`, { cause: error });
    }
  }
  console.log(`${apply ? 'Applied' : 'Dry run'}: ${applied.length} writes; skipped=[${skipped.join(',')}]`);
  return { applied, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(x => !['--apply', '--plan'].includes(x) && args[args.indexOf(x) - 1] !== '--plan') || args.filter(x => x === '--plan').length > 1) {
    console.error('usage: apply-lesson-fixes.mjs [--plan <file>] [--apply]'); process.exit(2);
  }
  const p = args.includes('--plan') ? args[args.indexOf('--plan') + 1] : DEFAULT_PLAN;
  try { await run(p, { apply: args.includes('--apply') }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
