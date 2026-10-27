// Check reruns and worktree provisioning spawn beside spawnProvider. They take
// the same macOS priority and cargo-jobs cap, and nothing else from providerEnv:
// that helper strips host-session names and sets RTK_DB_PATH, which these
// children must keep inheriting as their caller set them.
import { existsSync } from 'node:fs';
import { cargoBuildJobsDefault, providerLaunch, resolveCommand, type Command } from './providers/spawn.ts';

/** Existing env plus the cargo jobs default when unset. An explicit value, including empty, stays. */
export function withCargoBuildJobs(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.CARGO_BUILD_JOBS !== undefined) return env;
  return { ...env, CARGO_BUILD_JOBS: cargoBuildJobsDefault() };
}

/**
 * What spawn would exec, or null when it would fail to start (ENOENT).
 * A slash path is a file, not a PATH lookup. A bare name uses resolveCommand.
 * resolveCommand does not stat an absolute path, so a missing file is null too.
 */
export function commandForSpawn(file: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Command | null {
  if (file.includes('/') || file.includes('\\')) return existsSync(file) ? { file, args: [] } : null;
  try {
    const resolved = resolveCommand(file, env, platform);
    return existsSync(resolved.file) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * darwin: `/usr/bin/nice -n 10` then the resolved command. nice execs, so the
 * pid stays the command's. A command spawn would not find is left unwrapped,
 * so the spawn error stays ENOENT instead of nice exiting 127. Other platforms
 * are the command unchanged. A check that starts and exits 127 is still launched.
 */
export function prioritySpawn(file: string, args: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Command {
  if (platform !== 'darwin') return { file, args };
  const resolved = commandForSpawn(file, env, platform);
  return resolved ? providerLaunch(resolved, args, platform) : { file, args };
}
