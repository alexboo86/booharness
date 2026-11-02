import { readHost } from './config.ts';
import { collect } from './shared.entry.ts';
import { spawnProvider } from './providers/spawn.ts';
import { dropHostTargets } from './remote-repo.ts';
import { remoteTmpDropScript, remoteTmpScanScript } from './remote-tmp-script.ts';

type Skip = { path: string; reason: string };
type Candidate = { root: string; name: string };
type Plan = { candidates: Candidate[]; skipped: Skip[] };
export type HostCleanupResult = { removed: string[]; bytesBefore: number | null; skipped: Skip[]; errors: string[] };
type Drop = { removed: string[]; bytesBefore: number | null; skipped: Skip[] };

/** One managed transport and deadline per invocation, never one for an entire host pass. */
async function hostNode<T>(host: string, script: string, options: object): Promise<T> {
  const { repo } = readHost(host);
  const child = spawnProvider({ host, cwd: repo, command: 'node', args: ['-e', script, JSON.stringify({ ...options, repo })] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      child.kill('SIGKILL'); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      reject(new Error('host tmp sweep timed out after 120000 ms'));
    }, 120_000);
  });
  try {
    const output = await Promise.race([collect(child, undefined, 'host tmp sweep', true), deadline]);
    return JSON.parse(output.toString('utf8').trim());
  } finally { clearTimeout(timer); }
}

async function sweep(host: string, kind: 'lead' | 'tmp', drop: (candidate: Candidate) => Promise<Drop>): Promise<HostCleanupResult> {
  const plan = await hostNode<Plan>(host, remoteTmpScanScript, { kind });
  const result: HostCleanupResult = { removed: [], bytesBefore: kind === 'lead' ? 0 : null, skipped: plan.skipped, errors: [] };
  for (const candidate of plan.candidates) {
    try {
      const cleanup = await drop(candidate);
      result.removed.push(...cleanup.removed);
      result.skipped.push(...cleanup.skipped);
      if (result.bytesBefore !== null && cleanup.removed.length) result.bytesBefore += cleanup.bytesBefore!;
    } catch (error) {
      // A deadline may have interrupted deletion: do not invent a zero byte total.
      result.bytesBefore = null;
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return result;
}

/** Only direct target-* children of lead-check; Cargo guards remain in dropHostTargets. */
export function sweepHostLeadTargets(host: string, window: number): Promise<HostCleanupResult> {
  return sweep(host, 'lead', ({ root, name }) => dropHostTargets(host, root, { targets: [name], window, beforeDrop: () => true }));
}

/** Every tmp candidate gets a separate host process and its own 120-second deadline. */
export function sweepHostTmp(host: string, retention: { window: number; dropGrace: number }): Promise<HostCleanupResult> {
  return sweep(host, 'tmp', ({ root, name }) => hostNode<Drop>(host, remoteTmpDropScript, { root, name, ...retention }));
}
