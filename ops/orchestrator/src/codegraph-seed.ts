import { copyFile, lstat, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export type ProvisionStep = { command: string; code: number | null; ms: number; tail: string };
export type SeedCodegraphDeps = {
  run(command: string, args: string[], gated: boolean): Promise<ProvisionStep>;
  stopDaemon(dir: string): Promise<unknown>;
};

function normalizedPath(value: string, win: boolean): string {
  const normalized = value.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/$/, '');
  return win ? normalized.toLowerCase() : normalized;
}

function completeIndex(status: { initialized?: boolean; index?: { state?: string }; fileCount?: number; nodeCount?: number; dbSizeBytes?: number }): boolean {
  return status.initialized === true && status.index?.state === 'complete' &&
    status.fileCount > 0 && status.nodeCount > 0 && status.dbSizeBytes > 0;
}

/** Shared local/remote validation; an unavailable index is nonfatal. */
export function codegraphIndexNote(run: { code: number | null; output: string }, dir: string): string | null {
  if (run.code !== 0) return `codegraph index unavailable: status failed (${run.output.trim().slice(-300) || `exit ${run.code}`})`;
  try {
    const status = JSON.parse(run.output);
    const win = /^[a-z]:[\\/]/i.test(dir);
    if (normalizedPath(status.projectPath, win) === normalizedPath(dir, win) && completeIndex(status)) return null;
  } catch { /* Missing or malformed status is a nonfatal provisioning warning. */ }
  return 'codegraph index unavailable: checkout has no complete, non-empty index';
}

async function nearestSource(main: string): Promise<string | null> {
  for (let root = path.resolve(main); ; root = path.dirname(root)) {
    const db = path.join(root, '.codegraph', 'codegraph.db');
    try {
      if ((await stat(db)).isFile()) return db;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (path.dirname(root) === root) return null;
  }
}

// VACUUM is synchronous in node:sqlite: keep it out of the orchestrator event loop.
// A SQLite snapshot includes committed WAL contents without copying live sidecars.
const SNAPSHOT = `
const { DatabaseSync } = require('node:sqlite');
const [source, destination, version] = process.argv.slice(1);
const db = new DatabaseSync(source, { readOnly: true });
try {
  const metadata = db.prepare('SELECT value FROM project_metadata WHERE key = ?');
  if (metadata.get('index_state')?.value !== 'complete') throw new Error('source index is not complete');
  if (metadata.get('indexed_with_version')?.value !== version) throw new Error('source index version differs from codegraph ' + version);
  db.prepare('VACUUM INTO ?').run(destination);
} finally { db.close(); }
`;

function requireSuccess(step: ProvisionStep): void {
  if (step.code !== 0) throw new Error(`${step.command}: ${step.tail.trim() || `exit ${step.code}`}`);
}

async function populateSeed(source: string, dir: string, deps: SeedCodegraphDeps, steps: ProvisionStep[], version: string): Promise<void> {
  const copy = await deps.run(process.execPath, ['-e', SNAPSHOT, source, path.join(dir, '.codegraph', 'codegraph.db'), version], false);
  copy.command = `codegraph seed from ${source}`;
  steps.push(copy);
  requireSuccess(copy);
  await copyFile(path.join(path.dirname(source), '.gitignore'), path.join(dir, '.codegraph', '.gitignore'));
  const sync = await deps.run('codegraph', ['sync', '.'], true);
  sync.command = 'codegraph sync .';
  steps.push(sync);
  requireSuccess(sync);
  const status = await deps.run('codegraph', ['status', '--json', '.'], false);
  status.command = 'codegraph status --json .';
  steps.push(status);
  const note = codegraphIndexNote({ code: status.code, output: status.tail }, dir);
  if (note) throw new Error(note);
  status.tail = 'codegraph seeded index verified';
}

async function alreadyExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

async function claimDirectory(target: string): Promise<boolean> {
  try {
    await mkdir(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  }
}

/** Optional acceleration only: the setup's ordinary init remains the recovery path. */
export async function seedCodegraph(main: string, dir: string, deps: SeedCodegraphDeps): Promise<ProvisionStep[]> {
  const steps: ProvisionStep[] = [];
  const target = path.join(dir, '.codegraph');
  let owned = false;
  try {
    if (await alreadyExists(target)) return steps;
    const source = await nearestSource(main);
    if (!source) return steps;
    const version = await deps.run('codegraph', ['--version'], false);
    version.command = 'codegraph --version';
    steps.push(version);
    requireSuccess(version);
    const installed = version.tail.trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(installed)) throw new Error('unrecognized codegraph version');
    // Exclusive creation also protects a concurrent provisioner's existing index.
    owned = await claimDirectory(target);
    if (!owned) return steps;
    await populateSeed(source, dir, deps, steps, installed);
  } catch (error) {
    let reason = error instanceof Error ? error.message : String(error);
    if (owned) {
      try {
        await deps.stopDaemon(dir);
        await rm(target, { recursive: true, force: true });
      } catch (cleanup) {
        reason += `; cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`;
      }
    }
    steps.push({ command: 'codegraph seed', code: null, ms: 0, tail: `codegraph seed skipped: ${reason}; ordinary init will run`.slice(-1500) });
  }
  return steps;
}
