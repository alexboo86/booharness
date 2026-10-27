import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { harnessPaths, readHarnessConfig } from '../../../scripts/lib/harness-config.mjs';

type Balance = { at: string; balance: number; pendingCosts: number | null; error?: never }
  | { at: string; error: string; balance?: never; pendingCosts?: never }
  | null;

// https://docs.brightdata.com/api-reference/account-management-api/Get_total_balance_through_API
// Only allowlisted numbers and fixed error classes cross the board boundary.
export function brightdataCache({ home = homedir(), fetchImpl = globalThis.fetch } = {}) {
  const secretsFile = process.env.BRIGHTDATA_SECRETS_FILE;
  let value: Balance = null;
  let expires = 0;
  let inflight: Promise<Balance> | null = null;
  async function read(): Promise<Balance> {
    let key: string | undefined;
    try {
      const prefix = readHarnessConfig({ repoRoot: fileURLToPath(new URL('../../../', import.meta.url)) }).names.prefix;
      const bytes = await readFile(secretsFile ?? harnessPaths({ prefix, home }).secretsFile, 'utf8');
      for (const line of bytes.split(/\r?\n/)) {
        const cut = line.indexOf('=');
        if (cut > 0 && line.slice(0, cut).trim() === 'BRIGHTDATA_API_KEY') key = line.slice(cut + 1).trim();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { at: new Date().toISOString(), error: 'secret-read-failed' };
    }
    if (!key) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<Balance>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ at: new Date().toISOString(), error: 'timeout' });
      }, 10_000);
    });
    const request = async (): Promise<Balance> => {
      try {
        const response = await fetchImpl('https://api.brightdata.com/customer/balance', {
          headers: { Authorization: 'Bearer ' + key }, signal: controller.signal, redirect: 'error',
        });
        const at = new Date().toISOString();
        if (!response.ok) return { at, error: 'HTTP ' + response.status };
        const data = await response.json();
        if (typeof data?.balance !== 'number' || !Number.isFinite(data.balance)
          || (data.pending_costs !== undefined && (typeof data.pending_costs !== 'number' || !Number.isFinite(data.pending_costs)))) {
          return { at, error: 'invalid-response' };
        }
        return { at: new Date().toISOString(), balance: data.balance, pendingCosts: data.pending_costs ?? null };
      } catch {
        return { at: new Date().toISOString(), error: controller.signal.aborted ? 'timeout' : 'request-failed' };
      }
    };
    try { return await Promise.race([request(), deadline]); }
    finally { clearTimeout(timer!); }
  }
  return (): Promise<Balance> => {
    if (inflight) return inflight;
    if (Date.now() < expires) return Promise.resolve(value);
    inflight = read().then((next) => {
      value = next;
      expires = Date.now() + 600_000;
      inflight = null;
      return value;
    });
    return inflight;
  };
}

export const cachedBrightdataBalance = brightdataCache();
