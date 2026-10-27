import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Native dependencies cannot be provisioned by a foreign-platform config run. */
export function installPyTools(ctx) {
  if (ctx.platform !== process.platform) {
    return { skipped: true, reason: 'py-tools must be installed on the target platform' };
  }
  const script = path.join(ctx.repo, 'ops', 'py-tools', 'install.mjs');
  if (!existsSync(script)) {
    return { skipped: true, reason: `py-tools installer is missing from this checkout: ${script}` };
  }
  const result = spawnSync(process.execPath, [script, '--home', ctx.home], {
    encoding: 'utf8', timeout: 300_000, windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`py-tools install failed: ${result.stderr || result.error?.message || result.stdout}`);
  return JSON.parse(result.stdout);
}

/** The install-harness step: a failure is reported with its remedy and the other steps still run. */
export function runPyToolsStep(ctx, report) {
  if (ctx.only && ctx.only !== 'py-tools') return;
  try {
    report.pyTools = installPyTools(ctx);
  } catch (error) {
    report.pyTools = {
      state: 'failed', reason: error.message,
      remedy: 'node ops/bootstrap/install-harness.mjs --only py-tools',
    };
    report.ok = false;
    process.exitCode = 1;
  }
}
