// Operator #13149: only stock full-access qwen/grok/mimo Pi seats.
// Installation is explicit; every start checks pins and never falls back.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHost, type RemoteHost } from './config.ts';
import { checkPinnedEdit, type CodexEditSeat } from './codex-edit.ts';

const pins = JSON.parse(readFileSync(new URL('../../ab-stand/hashline-edit.json', import.meta.url), 'utf8')) as { package: string; extension: string };
const INSTALLER = fileURLToPath(new URL('../../ab-stand/hashline-edit-install.mjs', import.meta.url));
export type HashlineEdit = { extension: string; store: string };
export function hashlineEditWanted(seat: CodexEditSeat): boolean {
  return (seat.family === 'qwen' || seat.family === 'grok' || seat.family === 'mimo') && seat.access === 'full' &&
    (seat.harness === undefined || seat.harness === 'pi') && seat.standArm === undefined;
}
export const hashlineEditPrefix = (stateDir: string): string => path.join(stateDir, 'pi-extensions', 'hashline-edit');
export function hashlineEditHostPrefix(host: RemoteHost): string {
  return (host.platform === 'win32' ? path.win32 : path.posix).join(host.repo, '.pi-extensions', 'hashline-edit');
}
export function hashlineEditPaths(prefix: string, join = path): HashlineEdit {
  return { extension: join.join(prefix, 'node_modules', ...pins.package.split('/'), ...pins.extension.split('/')), store: join.join(prefix, 'hashline') };
}
export const checkHashlineEdit = (prefix: string) => checkPinnedEdit(INSTALLER, prefix, 'hashline-edit');
export async function localHashlineEdit(stateDir: string): Promise<HashlineEdit> {
  const prefix = hashlineEditPrefix(stateDir);
  const expected = hashlineEditPaths(prefix);
  const verdict = await checkHashlineEdit(prefix);
  if (!verdict.ok || verdict.extension !== expected.extension) {
    throw new Error(`hashline-edit is not verified in ${prefix}: ${verdict.reason ?? 'extension path mismatch'}; repair with: node ops/ab-stand/hashline-edit-install.mjs --ensure --prefix ${prefix}`);
  }
  return expected;
}
export function remoteHashlineEdit(hostName: string, recorded: unknown): HashlineEdit {
  const host = readHost(hostName);
  const expected = hashlineEditPaths(hashlineEditHostPrefix(host), host.platform === 'win32' ? path.win32 : path.posix);
  if (recorded !== expected.extension) throw new Error(`hashline-edit: host '${hostName}' has no provisioned extension for this seat (expected ${expected.extension}); re-provision the seat`);
  return expected;
}
