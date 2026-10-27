#!/usr/bin/env node
// Run after exporting the reviewed routing map to the NAS. Dry-run by default;
// --apply supersedes via memoryctl (never direct SQLite), preserving each lesson.
import { collect } from '../gen-domain-routing.mjs';
import { dbArgument, readLessons, requireServiceWrite } from './service-client.mjs';
import { mismatchedLessonDomains, supersedeDomain } from './lesson-domain-routes.mjs';

const args = process.argv.slice(2);
let dbFlags = 0;
let applyFlags = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--db') { dbFlags++; i++; continue; }
  if (args[i] === '--apply') { applyFlags++; continue; }
  throw new Error('usage: node scripts/memory/migrate-lesson-domains.mjs [--db <fixture>] [--apply]');
}
if (dbFlags > 1 || applyFlags > 1) throw new Error('duplicate migration flag');
const apply = args.includes('--apply');
const dbPath = dbArgument(args);
requireServiceWrite(dbPath, !apply);
const rows = await readLessons({ dbPath }, { status: 'active' });
const mismatches = mismatchedLessonDomains(rows, collect());
let moved = 0;
let failed = 0;
console.log('id\tanchor\tstored -> resolved');
for (const { row, anchor, storedDomain, resolvedDomain } of mismatches) {
  console.log(`${row.id}\t${anchor}\t${storedDomain} -> ${resolvedDomain}`);
  if (!apply) continue;
  try {
    supersedeDomain(row, resolvedDomain, {
      session: process.env.MEMORYCTL_SESSION_ID || 'migrate-lesson-domains',
      agent: process.env.MEMORYCTL_AGENT_ID || 'migrate-lesson-domains',
    });
    moved++;
  } catch (error) {
    failed++;
    console.error(`FAIL id=${row.id}: ${error.message}`);
  }
}
console.log(apply
  ? `migrate-lesson-domains: ${moved} moved, ${failed} failed of ${mismatches.length} candidate(s)`
  : `migrate-lesson-domains: ${mismatches.length} lesson(s) would move (dry-run)`);
if (failed) process.exit(1);
