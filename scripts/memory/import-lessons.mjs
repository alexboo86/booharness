#!/usr/bin/env node
// One-shot idempotent importer: .agents/domains/domain-*/lessons.md + _inbox.md → kind=lesson in memory.db.
//
// Direct SQLite (memory-import.mjs pattern). Does NOT create schema. Originals NEVER modified.
//
// Usage:
//   node scripts/memory/import-lessons.mjs [--skills <dir>] [--db <memory.db>]
//                                         [--dry-run] [--report] [--parity]
//
// Idempotency: UNIQUE(kind, title, content_hash). session_id='lessons-import', agent='importer'.
// links: {domain, anchor, globs[], status: active|inbox}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';

import {
  REPO_ROOT,
  DOMAINS_DIR,
  DOMAINS_ROOT,
  requireDbPath,
  SESSION_IMPORT,
  AGENT_IMPORT,
  sha256,
  buildLessonLinks,
  splitLessonFile,
  anchorOfBlock,
  triggerOfBlock,
  listLessonSourceFiles,
  readUtf8,
  openExistingMemoryDb,
  insertLessonEntry,
  listLiveLessons,
} from './lesson-lib.mjs';

/**
 * @typedef {{
 *   domain: string,
 *   status: 'active'|'inbox',
 *   title: string,
 *   body: string,
 *   content_hash: string,
 *   source_path: string,
 *   links: object,
 *   ts: number,
 *   origin_file: string,
 *   section_index: number,
 * }} PlannedLesson
 */

/**
 * Plan all lesson entries from skills tree (pure planning; no DB).
 * @param {string} skillsDir
 * @returns {{ planned: PlannedLesson[], perDomain: Record<string, {active: number, inbox: number, bytes: number}>, files: object[], bytesIn: number }}
 */
export function planLessons(skillsDir) {
  const files = listLessonSourceFiles(skillsDir);
  /** @type {PlannedLesson[]} */
  const planned = [];
  /** @type {Record<string, {active: number, inbox: number, bytes: number}>} */
  const perDomain = {};
  let bytesIn = 0;

  for (const f of files) {
    const { text, byteLength } = readUtf8(f.abs);
    bytesIn += byteLength;
    if (!perDomain[f.domain]) perDomain[f.domain] = { active: 0, inbox: 0, bytes: 0 };
    perDomain[f.domain].bytes += byteLength;

    let st;
    try {
      st = fs.statSync(f.abs);
    } catch {
      st = { mtimeMs: Date.now() };
    }
    const ts = Math.floor(st.mtimeMs);
    const { sections } = splitLessonFile(text);

    for (const sec of sections) {
      const anchor = anchorOfBlock(sec.body);
      const trigger = triggerOfBlock(sec.body);
      const links = buildLessonLinks({
        domain: f.domain,
        anchor,
        status: f.status,
        trigger,
      });
      const content_hash = sha256(sec.body);
      const source_path = `${f.rel}#${sec.index}`;
      planned.push({
        domain: f.domain,
        status: f.status,
        title: sec.title,
        body: sec.body,
        content_hash,
        source_path,
        links,
        ts,
        origin_file: f.rel,
        section_index: sec.index,
      });
      if (f.status === 'inbox') perDomain[f.domain].inbox += 1;
      else perDomain[f.domain].active += 1;
    }
  }

  return { planned, perDomain, files, bytesIn };
}

/**
 * Reconstruct source files from planned entries and compare byte-for-byte.
 * Preamble is re-read from disk (not stored as a lesson).
 * @param {string} skillsDir
 * @param {PlannedLesson[]} planned
 */
export function parityAgainstSources(skillsDir, planned) {
  const byFile = new Map();
  for (const p of planned) {
    if (!byFile.has(p.origin_file)) byFile.set(p.origin_file, []);
    byFile.get(p.origin_file).push(p);
  }

  /** @type {{ file: string, ok: boolean, bytes_src: number, bytes_recon: number, detail?: string }[]} */
  const results = [];
  let allOk = true;

  for (const f of listLessonSourceFiles(skillsDir)) {
    const { text } = readUtf8(f.abs);
    const { preamble, sections } = splitLessonFile(text);
    const entries = (byFile.get(f.rel) || []).slice().sort((a, b) => a.section_index - b.section_index);
    const reconBodies = entries.map((e) => e.body).join('');
    const reconstructed = preamble + reconBodies;
    const ok = reconstructed === text;
    if (!ok) allOk = false;
    // Also verify section count match
    let detail;
    if (!ok) {
      if (entries.length !== sections.length) {
        detail = `section count planned=${entries.length} source=${sections.length}`;
      } else {
        // find first mismatch offset
        let i = 0;
        const max = Math.min(reconstructed.length, text.length);
        while (i < max && reconstructed[i] === text[i]) i++;
        detail = `first mismatch at byte ${i} (srcLen=${text.length} reconLen=${reconstructed.length})`;
      }
    }
    results.push({
      file: f.rel,
      ok,
      bytes_src: Buffer.byteLength(text, 'utf8'),
      bytes_recon: Buffer.byteLength(reconstructed, 'utf8'),
      detail,
    });
  }

  return { ok: allOk, results };
}

/**
 * Parity of DB live lessons vs source files (bodies joined per origin file).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} skillsDir
 */
export function parityAgainstDb(db, skillsDir) {
  const lessons = listLiveLessons(db);
  // Group by source_path origin (strip #frag)
  /** @type {Map<string, Array<{section: number, body: string}>>} */
  const byFile = new Map();
  for (const row of lessons) {
    const sp = String(row.source_path || '');
    const hash = sp.indexOf('#');
    if (hash < 0) continue;
    const file = sp.slice(0, hash);
    const frag = sp.slice(hash + 1);
    const section = parseInt(frag, 10);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ section: Number.isFinite(section) ? section : 0, body: String(row.body) });
  }

  /** @type {{ file: string, ok: boolean, detail?: string }[]} */
  const results = [];
  let allOk = true;
  for (const f of listLessonSourceFiles(skillsDir)) {
    const { text } = readUtf8(f.abs);
    const { preamble } = splitLessonFile(text);
    const entries = (byFile.get(f.rel) || []).slice().sort((a, b) => a.section - b.section);
    const reconstructed = preamble + entries.map((e) => e.body).join('');
    const ok = reconstructed === text;
    if (!ok) allOk = false;
    results.push({
      file: f.rel,
      ok,
      detail: ok ? undefined : `src=${Buffer.byteLength(text)} recon=${Buffer.byteLength(reconstructed)} n=${entries.length}`,
    });
  }
  return { ok: allOk, results };
}

/**
 * @param {object} opts
 * @param {string} [opts.skills]
 * @param {string} [opts.dbPath]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.doReport]
 * @param {boolean} [opts.doParity]
 */
export function runImportLessons(opts = {}) {
  if (!opts.dryRun) requireDbPath(opts.dbPath);
  // Canon lives in lesson-lib as one constant: capture-lesson and promote-lesson kept their
  // own spelling of it and went on reading the deleted tree after this line was fixed.
  const skillsDir = path.resolve(opts.skills || DOMAINS_ROOT);
  const dryRun = Boolean(opts.dryRun);
  const doParity = Boolean(opts.doParity);
  const doReport = Boolean(opts.doReport) || dryRun || doParity;

  if (!fs.existsSync(skillsDir)) {
    throw new Error(`skills directory not found: ${skillsDir}`);
  }

  const { planned, perDomain, files, bytesIn } = planLessons(skillsDir);
  const plannedBytes = planned.reduce((s, p) => s + Buffer.byteLength(p.body, 'utf8'), 0);

  /** @type {Record<string, unknown>} */
  const report = {
    dry_run: dryRun,
    skills: skillsDir,
    files_seen: files.length,
    entries_planned: planned.length,
    bytes_in: bytesIn,
    bytes_planned_bodies: plannedBytes,
    per_domain: perDomain,
    imported: 0,
    deduped: 0,
    parity: null,
  };

  // Planned-source parity (no DB needed)
  if (doParity || dryRun) {
    const p = parityAgainstSources(skillsDir, planned);
    report.parity_planned = p;
    if (!p.ok) {
      const bad = p.results.filter((r) => !r.ok);
      throw new Error(
        `parity FAIL on planned reconstruction: ${bad.map((b) => `${b.file}: ${b.detail}`).join('; ')}`,
      );
    }
  }

  if (!dryRun) {
    // Direct SQLite import bypasses memoryd's capture-gate check (store.mjs
    // lessonGateProblem) and would create unchecked new lessons. Keep dry-run/parity.
    if (planned.length) throw new Error('lesson import refused: use scripts/memory/capture-lesson.mjs for new lessons; --dry-run and --parity remain available');
    const dbPath = requireDbPath(opts.dbPath);
    const db = openExistingMemoryDb(dbPath);
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const entry of planned) {
        const result = insertLessonEntry(db, {
          title: entry.title,
          body: entry.body,
          content_hash: entry.content_hash,
          source_path: entry.source_path,
          links: entry.links,
          ts: entry.ts,
          session_id: SESSION_IMPORT,
          agent: AGENT_IMPORT,
        });
        if (result === 'inserted') report.imported = Number(report.imported) + 1;
        else report.deduped = Number(report.deduped) + 1;
      }
      db.exec('COMMIT');

      if (doParity) {
        report.parity = parityAgainstDb(db, skillsDir);
        if (!report.parity.ok) {
          const bad = report.parity.results.filter((r) => !r.ok);
          throw new Error(
            `parity FAIL vs DB: ${bad.map((b) => `${b.file}: ${b.detail}`).join('; ')}`,
          );
        }
      }
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      db.close();
      throw err;
    }
    db.close();
  }

  if (doReport) {
    printReport(report);
  }
  return report;
}

function printReport(report) {
  console.log('=== import-lessons report ===');
  console.log(`dry_run=${report.dry_run} files=${report.files_seen} planned=${report.entries_planned}`);
  console.log(`bytes_in=${report.bytes_in} bytes_planned_bodies=${report.bytes_planned_bodies}`);
  console.log(`bytes_in==planned_bodies? ${report.bytes_in === report.bytes_planned_bodies ? 'NOTE: includes preambles' : 'preambles+inbox headers not in bodies (expected)'}`);
  console.log('per-domain:');
  const pd = /** @type {Record<string, {active:number,inbox:number,bytes:number}>} */ (report.per_domain);
  let totalActive = 0;
  let totalInbox = 0;
  for (const d of Object.keys(pd).sort()) {
    const x = pd[d];
    totalActive += x.active;
    totalInbox += x.inbox;
    console.log(`  ${d}: active=${x.active} inbox=${x.inbox} file_bytes=${x.bytes}`);
  }
  console.log(`TOTAL lessons: active=${totalActive} inbox=${totalInbox}`);
  if (!report.dry_run) {
    console.log(`imported=${report.imported} deduped=${report.deduped}`);
  }
  if (report.parity_planned) {
    const p = /** @type {{ok:boolean, results: {file:string,ok:boolean}[]}} */ (report.parity_planned);
    console.log(`parity_planned: ${p.ok ? 'OK' : 'FAIL'} (${p.results.length} files)`);
    for (const r of p.results) {
      console.log(`  ${r.ok ? 'ok' : 'FAIL'} ${r.file} src=${r.bytes_src} recon=${r.bytes_recon}${r.detail ? ' ' + r.detail : ''}`);
    }
  }
  if (report.parity) {
    const p = /** @type {{ok:boolean, results: {file:string,ok:boolean,detail?:string}[]}} */ (report.parity);
    console.log(`parity_db: ${p.ok ? 'OK' : 'FAIL'}`);
    for (const r of p.results) {
      console.log(`  ${r.ok ? 'ok' : 'FAIL'} ${r.file}${r.detail ? ' ' + r.detail : ''}`);
    }
  }
}

function parseArgs(argv) {
  /** @type {{ skills?: string, dbPath?: string, dryRun: boolean, doReport: boolean, doParity: boolean, help: boolean }} */
  const opts = { dryRun: false, doReport: false, doParity: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--report') opts.doReport = true;
    else if (a === '--parity') opts.doParity = true;
    else if (a === '--skills') opts.skills = argv[++i];
    else if (a === '--db') opts.dbPath = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return opts;
}

if (isMain(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(`usage: import-lessons.mjs [--skills <dir>] [--db <memory.db>] [--dry-run] [--report] [--parity]
  --dry-run   plan only, no writes; implies report + planned parity
  --report    print per-domain counts
  --parity    reconstruct lessons.md from planned (and DB if writing) and byte-compare
--db        REQUIRED for writes: explicit maintenance database (no service import API)
  --skills    default: <repo>/${DOMAINS_DIR}`);
      process.exit(0);
    }
    // dry-run always reports
    if (opts.dryRun) opts.doReport = true;
    runImportLessons(opts);
  } catch (err) {
    console.error(String(err?.stack || err?.message || err));
    process.exit(1);
  }
}
