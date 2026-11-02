import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFamilyLogins } from '../../../scripts/lib/family-logins.mjs';
import type { Family } from './providers/types.ts';

export type ReauthState = { family: Family; since: string; opened: boolean; command?: string; url?: string };
export type ReauthOptions = {
  platform?: string;
  run?: (file: string, args: string[]) => Promise<void>;
  message?: (text: string) => void;
};
const login = fileURLToPath(new URL('../../bootstrap/harness-login.mjs', import.meta.url));
const run = (file: string, args: string[]) => new Promise<void>((resolve, reject) => {
  execFile(file, args, { timeout: 20_000 }, (error) => error ? reject(error) : resolve());
});

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readSaved(file: string): Record<string, unknown> {
  try { return record(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { return {}; }
}

/** Human-only sign-in. Cooldowns survive reader recovery and daemon restarts. */
export class LimitsReauth {
  private states = new Map<Family, ReauthState>();
  private attempted = new Map<Family, number>();
  private options: ReauthOptions;
  private now: () => number;
  private cooldown: number;
  private lastGoodFile: string | null;
  constructor(options: ReauthOptions, now: () => number, cooldown: number, lastGoodFile: string | null) {
    this.options = options;
    this.now = now;
    this.cooldown = cooldown;
    this.lastGoodFile = lastGoodFile;
    this.restore();
  }

  get(family: Family): ReauthState | null { return this.states.get(family) ?? null; }
  clear(family: Family): void { this.states.delete(family); }

  async request(family: Family): Promise<void> {
    const at = this.now();
    const previous = this.attempted.get(family);
    if (previous !== undefined && at - previous < this.cooldown) {
      this.keepState(family, at);
      return;
    }
    const state = this.createState(family, at);
    this.states.set(family, state);
    const message = this.options.message ?? ((text: string) => process.stderr.write(`${text}\n`));
    if (!this.reserve(family, at)) {
      message(`orch: ${family} limits login expired — cooldown could not be saved; sign in yourself: ${state.command ?? state.url}`);
      return;
    }
    if ((this.options.platform ?? process.platform) !== 'darwin' || family === 'claude') {
      message(`orch: ${family} limits login expired — sign in yourself: ${state.command ?? state.url}`);
      return;
    }
    await this.open(state, message);
  }

  private createState(family: Family, at: number): ReauthState {
    const state: ReauthState = { family, since: this.states.get(family)?.since ?? new Date(at).toISOString(), opened: false };
    const descriptor = loadFamilyLogins()[family];
    if (family === 'mimo') state.url = `https://${descriptor.usageCredential.hosts[0]}`;
    else state.command = family === 'qwen' ? descriptor.usageCredential.login.command
      : family === 'claude' ? descriptor.terminalLogin.command : `node ops/bootstrap/harness-login.mjs ${family}`;
    return state;
  }

  private keepState(family: Family, at: number): void {
    if (!this.states.has(family)) this.states.set(family, this.createState(family, at));
  }

  private restore(): void {
    if (!this.lastGoodFile) return;
    const saved = record(readSaved(this.lastGoodFile).__reauth);
    for (const [family, at] of Object.entries(saved)) {
      if (typeof at === 'number' && Number.isFinite(at) && at >= 0 && at <= this.now()) {
        this.attempted.set(family as Family, at);
      }
    }
  }

  private reserve(family: Family, at: number): boolean {
    this.attempted.set(family, at); // Reserve synchronously before awaiting any launcher.
    if (!this.lastGoodFile) return true;
    try {
      const saved = readSaved(this.lastGoodFile);
      mkdirSync(path.dirname(this.lastGoodFile), { recursive: true });
      writeFileSync(`${this.lastGoodFile}.tmp`, `${JSON.stringify({ ...saved, __reauth: { ...record(saved.__reauth), [family]: at } })}\n`, 'utf8');
      renameSync(`${this.lastGoodFile}.tmp`, this.lastGoodFile);
      return true;
    } catch {
      // No automatic open if a restart could erase its cooldown.
      return false;
    }
  }

  private async open(state: ReauthState, message: (text: string) => void): Promise<void> {
    const execute = this.options.run ?? run;
    try {
      if (state.url) await execute('/usr/bin/open', ['-a', 'Google Chrome', state.url]);
      else await execute(process.execPath, [login, state.family, ...(state.family === 'qwen' ? ['--quota'] : [])]);
      state.opened = true;
    } catch {
      message(`orch: ${state.family} limits login expired — could not open sign-in; run ${state.command ?? state.url}`);
      return;
    }
    const text = `orch: ${state.family} limits login expired — sign in in the opened window`;
    message(text);
    // JSON string literals are valid AppleScript strings for this fixed, non-secret text.
    try { await execute('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(text)} with title "orch"`]); }
    catch { /* The stderr message and board state remain available if notifications are disabled. */ }
  }
}

export function createLimitsReauth(options: true | ReauthOptions | undefined, now: () => number, off: string | null, cooldown: number, lastGoodFile: string | null): LimitsReauth | null {
  return !off && options ? new LimitsReauth(options === true ? {} : options, now, cooldown, lastGoodFile) : null;
}
