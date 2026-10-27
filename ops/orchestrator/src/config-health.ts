// The running validator, not a subprocess loading potentially newer code from disk.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readHarnessConfig, PROJECT_DEFAULTS } from '../../../scripts/lib/harness-config.mjs';
import { codeHash } from '../code-hash.mjs';
import type { Logger } from './log.ts';

const DAEMON_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export type ConfigError = { message: string; since: string; codeStale: boolean | null };
export type ConfigHealthSnapshot = { configError: ConfigError | null; frozenProjectKeys: string[] };

/** One per daemon. Reads are synchronous, so simultaneous callers share confirmation state. */
export class ConfigHealth {
  private error: ConfigError | null = null;
  private pending: { at: number; errorClass: string } | null = null;
  private warned = new Set<string>();
  private bootProject: Record<string, unknown> | undefined;
  private frozen: string[] = [];
  private confirmation?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly repoRoot: string;
  private readonly code: string;
  private readonly log: Logger;

  constructor({ repoRoot = DAEMON_ROOT, code, log }: { repoRoot?: string; code: string; log: Logger }) {
    this.repoRoot = repoRoot;
    this.code = code;
    this.log = log;
    this.check(); // Capture project policy before serving seats, not after the first failure.
  }

  snapshot(): ConfigHealthSnapshot {
    return { configError: this.error && { ...this.error }, frozenProjectKeys: [...this.frozen] };
  }

  warning(): string | null {
    const error = this.error;
    const rejected = error ? `Daemon rejected ops/bootstrap/harness.config.json: ${error.message}. ${error.codeStale === true
      ? 'Run node ops/orchestrator/src/main.ts restart --when-idle.'
      : 'Fix ops/bootstrap/harness.config.json.'}${error.codeStale === null ? ' Daemon code fingerprint is unavailable.' : ''}` : '';
    const frozen = this.frozen.length ? `${this.frozen.join(', ')} changed since start; frozen until restart.` : '';
    return [rejected, frozen].filter(Boolean).join(' ') || null;
  }

  check(): void {
    const now = Date.now();
    try {
      const config = readHarnessConfig({ repoRoot: this.repoRoot });
      const project = { ...PROJECT_DEFAULTS, ...config.project };
      this.bootProject ??= structuredClone(project);
      this.frozen = Object.keys(project).filter((key) => JSON.stringify(project[key]) !== JSON.stringify(this.bootProject![key]))
        .map((key) => `project.${key}`).sort();
      this.pending = null;
      clearTimeout(this.confirmation);
      this.confirmation = undefined;
      if (this.error) this.log('info', 'daemon.harness_config_cleared', { since: this.error.since });
      this.error = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A distinct rejection reason is its own class, not every Error lumped together.
      const errorClass = `${error instanceof Error ? error.name : 'Error'}:${message}`;
      if (this.pending?.errorClass !== errorClass) {
        this.pending = { at: now, errorClass };
        clearTimeout(this.confirmation);
        this.confirmation = setTimeout(() => { this.confirmation = undefined; this.check(); }, 1000);
        this.confirmation.unref();
        return;
      }
      if (now - this.pending.at < 1000) return;
      let codeStale: boolean | null = null;
      try { codeStale = codeHash(join(this.repoRoot, 'ops/orchestrator')) !== this.code; }
      catch { /* A partial/unreadable checkout cannot establish either fingerprint equality or staleness. */ }
      this.error = { message, since: new Date(this.pending.at).toISOString(), codeStale };
      if (!this.warned.has(errorClass)) {
        this.warned.add(errorClass);
        this.log('warn', 'daemon.harness_config_rejected', { ...this.error, errorClass });
      }
    }
  }

  start(): void {
    if (this.timer) return;
    // Independent of the potentially long-running/destructive sweep gate.
    this.timer = setInterval(() => this.check(), 10 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.confirmation);
    this.timer = undefined;
    this.confirmation = undefined;
  }
}

let daemonHealth: ConfigHealth | undefined;
export function startConfigHealth(options: { code: string; log: Logger }): ConfigHealth {
  daemonHealth?.stop();
  daemonHealth = new ConfigHealth(options);
  daemonHealth.start();
  return daemonHealth;
}

/** Failure paths probe the daemon's config, never a seat checkout or the router's exception. */
export function checkConfigHealth(): void {
  daemonHealth?.check();
}
