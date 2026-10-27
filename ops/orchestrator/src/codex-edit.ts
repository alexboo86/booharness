// Stock codex Pi seats edit through the codex-edit extension (Codex-style
// `apply_patch`), operator #13098 after the pilot #13097 (equal correctness,
// about 45% fewer tokens and half the wall time on edit-1/edit-2). Only family
// codex, only seats that edit (`full`), only the Pi harness, and never a stand
// arm: an arm's own isolated profile decides what it loads, so the `base` arm
// stays stock and future comparisons keep meaning something (#13099).
//
// The bytes come from the A/B stand's one verified install path
// (ops/ab-stand/codex-edit-install.mjs: registry integrity and tarball origin
// checked, the pinned sha512 hashed before npm sees the bytes, npm
// --ignore-scripts because the toolkit postinstall writes into ~/.pi and
// ~/.local/bin, config.json pinned to gpt-6.1-sol, every write and verified read
// contained in the prefix). A seat never downloads and never falls back silently:
// a missing, unverified or tampered install fails the seat start with the reason
// and the command that repairs it — on this Mac and on a host alike.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHost, readHosts, type RemoteHost } from './config.ts';

type Pins = { package: string; version: string; integrity: string; extension: string; config: { enabled: boolean; models: string[] } };
const pins = JSON.parse(readFileSync(new URL('../../ab-stand/codex-edit.json', import.meta.url), 'utf8')) as Pins;
const INSTALLER = fileURLToPath(new URL('../../ab-stand/codex-edit-install.mjs', import.meta.url));
const EXTENSION_DIR = pins.extension.slice(0, pins.extension.lastIndexOf('/'));
const ENTRY = pins.extension.slice(EXTENSION_DIR.length + 1);
/** npm --prefix layout under a prefix, as path parts (never a platform separator). */
const PACKAGE_DIRECTORY = ['node_modules', ...pins.package.split('/'), ...EXTENSION_DIR.split('/'), ENTRY];

export type CodexEdit = { extension: string; models: readonly string[] };
/** One line of JSON from the installer's --check, on this Mac or on a host. */
export type CodexEditVerdict = { ok: boolean; prefix?: string; extension?: string; reason?: string };
export type CodexEditSeat = {
  family: unknown; access: unknown; harness?: unknown; standArm?: unknown; role?: unknown;
};

/** A stock Pi seat that edits: family codex, full access, no stand arm. */
export function codexEditWanted(seat: CodexEditSeat): boolean {
  return seat.family === 'codex' && seat.access === 'full' && (seat.harness === undefined || seat.harness === 'pi') && seat.standArm === undefined;
}

/** Why a win32 target never loads codex-edit (task 1956): the pinned toolkit's apply_patch workspace guard compares forward-slash prefixes, so node:path's backslashes make it refuse every nested path with "Parent path escapes workspace". */
export const CODEX_EDIT_WIN32_WITHHELD = 'codex-edit is not eligible on win32 hosts: the pinned @maxiaochao/pi-toolkit apply_patch refuses every nested Windows path with "Parent path escapes workspace" (task 1956)';

/**
 * Platform eligibility beside codexEditWanted (task 1956, CODEX_EDIT_WIN32_WITHHELD):
 * a seat whose target platform is win32 keeps Pi's built-in edit and write. The
 * host registry is resolved without throwing — an unreadable or unknown host keeps
 * today's answer (eligible), because provisioning and every start still fail loudly
 * on their own readHost. Nothing already installed is uninstalled.
 */
export function codexEditEligible(host: string | undefined, stateDir?: string): boolean {
  if (host === undefined) return process.platform !== 'win32';
  try { return readHosts(stateDir)[host]?.platform !== 'win32'; } catch { return true; }
}

/** The pinned model ids the extension activates for (the config.json orch writes). */
export function codexEditModels(): readonly string[] { return pins.config.models; }

/** This machine's stock prefix: <orch state dir>/pi-extensions/codex-edit, never an arm directory. */
export function codexEditPrefix(stateDir: string): string {
  return path.join(stateDir, 'pi-extensions', 'codex-edit');
}

/** One install per host, inside the host's own runtime clone (the seat row records the entry file). */
export function codexEditHostPrefix(host: RemoteHost): string {
  const p = host.platform === 'win32' ? path.win32 : path.posix;
  return p.join(host.repo, '.pi-extensions', 'codex-edit');
}

/** The `-e` path a codex seat on this host must record; provisioning writes exactly this. */
export function codexEditHostExtension(host: RemoteHost): string {
  const p = host.platform === 'win32' ? path.win32 : path.posix;
  return p.join(codexEditHostPrefix(host), ...PACKAGE_DIRECTORY);
}

/**
 * The extension's own routing rule (model-routing.ts): `enabled`, a responses API
 * and a glob over the pinned model ids. orch only asks for family codex, whose Pi
 * route is provider openai-codex (providers/index.ts:93) and so api
 * openai-codex-responses (ops/ab-stand/smoke.mjs asserts one of the two responses
 * APIs); the api leg is mirrored anyway, so the manifest stays honest if a codex
 * route ever changes instead of expecting a swap Pi will not make.
 */
export function codexEditActive(models: readonly string[], model: string | null | undefined, api = 'openai-codex-responses'): boolean {
  if (!pins.config.enabled || !model) return false;
  if (api !== 'openai-responses' && api !== 'openai-codex-responses') return false;
  return models.some((pattern) => typeof pattern === 'string' &&
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(model));
}

/**
 * Verify a prefix with the installer's own --check (one implementation of
 * "verified": pins, per-file sha256, toolkit version and config content).
 * execFile, never execFileSync: a seat start must not block the daemon's loop.
 */
export function checkCodexEdit(prefix: string): Promise<CodexEditVerdict> {
  return checkPinnedEdit(INSTALLER, prefix, 'codex-edit');
}

/** Shared asynchronous installer verdict protocol; never blocks the daemon. */
export function checkPinnedEdit(installer: string, prefix: string, name: string): Promise<CodexEditVerdict> {
  const parse = (output: string): CodexEditVerdict | null => {
    const line = output.trim().split(/\r?\n/).pop();
    try {
      const parsed = JSON.parse(line ?? '') as CodexEditVerdict;
      return typeof parsed?.ok === 'boolean' ? parsed : null;
    } catch { return null; }
  };
  return new Promise((resolve) => {
    execFile(process.execPath, [installer, '--check', '--prefix', prefix],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true },
      (error, stdout) => {
        // --check exits 1 with its verdict on stdout; anything else is a broken
        // check, never a pass.
        const reported = parse(String(stdout ?? ''));
        resolve(reported && (!reported.ok || !error) ? reported : { ok: false, prefix, reason: `${name} check did not run: ${String(error?.message ?? 'no verdict').slice(0, 300)}` });
      });
  });
}

/** This Mac's verified extension, or a thrown reason naming the repair command. */
export async function localCodexEdit(stateDir: string): Promise<CodexEdit> {
  const prefix = codexEditPrefix(stateDir);
  const verdict = await checkCodexEdit(prefix);
  if (!verdict.ok || typeof verdict.extension !== 'string') {
    throw new Error(`codex-edit is not verified in ${prefix}: ${verdict.reason ?? 'unknown reason'}; repair with: node ops/ab-stand/codex-edit-install.mjs --ensure --prefix ${prefix}`);
  }
  return { extension: verdict.extension, models: pins.config.models };
}

/**
 * A remote seat's recorded `-e` path must be exactly the one provisioning wrote
 * on that host (the --mcp-config rule: never select a path orch did not write and
 * record). The bytes themselves are re-verified on the host before every start by
 * checkCodexEditOnHost (remote-provision.ts); this is the shape gate.
 */
export function remoteCodexEditExtension(hostName: string, recorded: unknown): string {
  const expected = codexEditHostExtension(readHost(hostName));
  if (recorded !== expected) {
    throw new Error(`codex-edit: host '${hostName}' has no provisioned extension for this seat (expected ${expected}, seat records ${typeof recorded === 'string' ? recorded : 'nothing'}); re-provision the seat`);
  }
  return expected;
}
