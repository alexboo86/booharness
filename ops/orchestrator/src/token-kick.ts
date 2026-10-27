// Vendor CLIs own their credentials. Orch only invokes a bounded CLI command and
// re-reads when its expiry moved; it never copies or writes either token.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { claudeCredentials } from '../../usage-snapshot.mjs';

// kimi CLI 2.1.1 tokens live 900 s: a cooldown longer than that leaves kimi unread
// until it ends, so kimi's is shorter than one token lifetime.
const COOLDOWN_MS: Record<string, number> = { claude: 30 * 60_000, grok: 30 * 60_000, kimi: 10 * 60_000 };
// A kick killed by the deadline never reached the CLI's refresh; retry at the next refresh.
const TIMEOUT_RETRY_MS = 2 * 60_000;
// A live `kimi -p ok` took 8.4 s on 2026-09-28; 12 s left no margin and timed out at 16:35.
const TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 1_000;
const grokAuth = path.join(homedir(), '.grok', 'auth.json');
const kimiAuthDir = path.join(homedir(), '.kimi-code', 'credentials');
const piAuth = path.join(homedir(), '.pi', 'agent', 'auth.json');
const kimiBin = path.join(homedir(), '.kimi-code', 'bin', 'kimi');

/** A KIMI_CODE_* override would refresh a different credential slot. */
export function withoutKimiOverrides(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith('KIMI_CODE_')));
}

async function credentialExpiry(family: string): Promise<number> {
  try {
    if (family === 'claude') {
      const expiresAt = Number((await claudeCredentials())?.expiresAt);
      return expiresAt > 0 ? expiresAt : NaN;
    }
    if (family === 'kimi') {
      // Mirror usage-snapshot.mjs: Kimi 2.1.1 may use a host-scoped OAuth slot.
      // Ignore unreadable slots rather than letting one stale file hide another.
      let latest = -Infinity;
      for (const name of readdirSync(kimiAuthDir)) {
        if (name !== 'kimi-code.json' && !/^kimi-code-env-[a-f0-9]+\.json$/.test(name)) continue;
        try {
          const entry = JSON.parse(readFileSync(path.join(kimiAuthDir, name), 'utf8')) as { access_token?: string; expires_at?: number };
          const seconds = Number(entry.expires_at);
          if (typeof entry.access_token === 'string' && entry.access_token && entry.expires_at != null && Number.isFinite(seconds)) {
            latest = Math.max(latest, seconds * 1000);
          }
        } catch { /* A malformed slot is not a reason to skip other slots. */ }
      }
      return Number.isFinite(latest) ? latest : NaN;
    }
    if (family === 'pi-kimi') {
      const entry = JSON.parse(readFileSync(piAuth, 'utf8'))['kimi-coding'];
      return entry?.access ? Number(entry.expires) : NaN;
    }
    if (family === 'grok') {
      const entries = Object.values(JSON.parse(readFileSync(grokAuth, 'utf8'))) as { expires_at?: string }[];
      return Date.parse(entries[0]?.expires_at ?? '');
    }
  } catch { /* missing or malformed credentials are never a reason to kick */ }
  return NaN;
}

/** execFile's timeout only sends SIGTERM. Settle even when a CLI ignores it. */
export function runKickCommand(file: string, args: string[], cwd: string, timeoutMs = TIMEOUT_MS): Promise<void> {
  mkdirSync(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 256 * 1024,
      env: file === kimiBin ? withoutKimiOverrides()
        : file === 'claude' ? { ...process.env, DISABLE_AUTOUPDATER: '1' } : process.env }, (error) => {
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    });
    const deadline = setTimeout(() => {
      try { child.kill('SIGKILL'); } finally {
        reject(Object.assign(new Error('token kick deadline'), { killed: true }));
      }
    }, timeoutMs + KILL_GRACE_MS);
    child.stdin?.end(); // Kicks never wait for interactive input.
  });
}

/** Reserve a per-family cooldown before awaiting any process; never log credential-bearing output. */
export class TokenKick {
  private last = new Map<string, number>();
  // In memory only: after a restart a timed-out kick waits the full cooldown.
  private timedOut = new Set<string>();
  private readonly run: (file: string, args: string[]) => Promise<void>;
  private readonly expiry: (family: string) => number | Promise<number>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly lastGoodFile: string | null;
  constructor(run: ((file: string, args: string[]) => Promise<void>) | undefined = undefined,
  expiry: (family: string) => number | Promise<number> = credentialExpiry, now: () => number = Date.now,
  log: (message: string) => void = (message) => console.error(message),
  lastGoodFile: string | null = null) {
    this.run = run ?? ((file, args) => runKickCommand(file, args,
      path.join(path.dirname(lastGoodFile ?? path.join(homedir(), '.local', 'state', 'orch', 'limits-last-good.json')), 'token-kick')));
    this.expiry = expiry;
    this.now = now;
    this.log = log;
    this.lastGoodFile = lastGoodFile;
    if (lastGoodFile) {
      try {
        const saved = JSON.parse(readFileSync(lastGoodFile, 'utf8')) as { __kick?: Record<string, unknown> };
        for (const family of ['claude', 'grok', 'kimi']) {
          const at = saved.__kick?.[family];
          if (typeof at === 'number' && Number.isFinite(at) && at >= 0 && at <= now()) this.last.set(family, at);
        }
      } catch { /* No saved cooldown yet. */ }
    }
  }

  private reserve(family: string, at: number): boolean {
    this.last.set(family, at);
    if (!this.lastGoodFile) return true;
    try {
      let saved: Record<string, unknown> = {};
      try { saved = JSON.parse(readFileSync(this.lastGoodFile, 'utf8')) as Record<string, unknown>; } catch { /* No file yet. */ }
      const existing = saved.__kick && typeof saved.__kick === 'object' ? saved.__kick : {};
      mkdirSync(path.dirname(this.lastGoodFile), { recursive: true });
      writeFileSync(`${this.lastGoodFile}.tmp`, `${JSON.stringify({ ...saved, __kick: { ...existing, [family]: at } })}\n`, 'utf8');
      renameSync(`${this.lastGoodFile}.tmp`, this.lastGoodFile);
      return true;
    } catch {
      // Never spend a model request if a restart could erase the cooldown.
      this.log(`[orch limits] ${family} token kick cooldown could not be saved`);
      return false;
    }
  }

  async kick(rows: { family: string; error: string | null }[]): Promise<boolean> {
    const pending = rows.filter((row) => (row.family === 'claude' || row.family === 'grok' || row.family === 'kimi') && row.error?.startsWith('token expired'));
    const moved = await Promise.all(pending.map((row) => this.kickOne(row.family)));
    return moved.some(Boolean);
  }

  private async kickOne(family: string): Promise<boolean> {
    const now = this.now();
    // A Pi turn may have refreshed since the snapshot: re-read without spending a model request.
    if (family === 'kimi' && await this.expiry('pi-kimi') > now) return true;
    const before = await this.expiry(family);
    if (!Number.isFinite(before) || before > now || (family === 'claude' && before <= 0)) return false;
    // Reserve after the async read: another row/refresh may have reserved meanwhile.
    const last = this.last.get(family);
    if (last !== undefined && now - last < (this.timedOut.has(family) ? TIMEOUT_RETRY_MS : COOLDOWN_MS[family])) return false;
    if (!this.reserve(family, now)) return false;
    this.timedOut.delete(family);
    const [file, args] = family === 'claude' ? ['claude', ['doctor']] as const
      : family === 'kimi' ? [kimiBin, ['-p', 'ok']] as const : ['grok', ['models']] as const;
    try {
      await this.run(file, [...args]);
      const after = await this.expiry(family);
      const moved = Number.isFinite(after) && after > before;
      this.log(`[orch limits] ${family} token kick ${moved ? 'refreshed' : 'did not move expiry'}`);
      return moved;
    } catch (error) {
      // The CLI can refresh at startup, then time out waiting for the tiny model reply.
      // A moved expiry still warrants a re-read; the process failure is never hidden.
      const after = await this.expiry(family);
      const moved = Number.isFinite(after) && after > before;
      const cause = error as { code?: string | number; killed?: boolean };
      if (cause.killed && !moved) this.timedOut.add(family);
      this.log(`[orch limits] ${family} token kick failed (${cause.killed ? 'timeout' : cause.code ?? 'unknown'}); expiry ${moved ? 'moved' : 'unchanged'}`);
      return moved;
    }
  }
}
