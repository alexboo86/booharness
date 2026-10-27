// One verdict on Peekaboo, the macOS capture tool, and the rights it needs (task
// 2427, operator decision 16706), printed by the doctor row `peekaboo`
// (ops/bootstrap/doctor.mjs). It names each absent thing and its fix: `brew install
// peekaboo` (the approved route, docs/agent/harness-allowlist.md) or the right's own
// grantInstructions. A probe killed at its own bound is NO ANSWER — unknown, not
// dead (lesson 14553).
import { execFile } from 'node:child_process';

export const PEEKABOO_PROBE_MS = 5000;
export const PEEKABOO_INSTALL_FIX = 'brew install peekaboo (the approved route: docs/agent/harness-allowlist.md)';

export type PeekabooRun = { ok: boolean; out: string; timedOut?: boolean };
export type PeekabooVerdict = { ok: true } | { ok: false; fix: string };
/** session-start.mjs's synchronous spawnSync `run` answers this same shape. */
export type PeekabooRunner = (cmd: string, args: string[], timeoutMs: number) => PeekabooRun | Promise<PeekabooRun>;

function defaultRun(cmd: string, args: string[], timeoutMs: number): Promise<PeekabooRun> {
  return new Promise((resolve) => {
    // SIGKILL, not SIGTERM: a child that ignores TERM outlives the bound (measured
    // 7 s against 5 s, reviewer-codex-a5a459.1); the bound is hard for both callers.
    execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // execFile killed the child at OUR bound: killed, not exited — no answer.
        resolve({ ok: false, out: String(error.message || error), timedOut: (error as { killed?: boolean }).killed === true });
        return;
      }
      resolve({ ok: true, out: String(stdout || '').trim() || String(stderr || '').trim() });
    });
  });
}

const firstLine = (text: string): string => text.split(/\r?\n/)[0].slice(0, 160) || 'no output';

/** The one verdict for both callers: run `peekaboo permissions --json` and judge the answer. */
export async function peekabooVerdict(run: PeekabooRunner = defaultRun): Promise<PeekabooVerdict> {
  const probe = await run('peekaboo', ['permissions', '--json'], PEEKABOO_PROBE_MS);
  if (probe.timedOut) {
    return { ok: false, fix: `peekaboo gave NO ANSWER in ${PEEKABOO_PROBE_MS / 1000} s — its state is unknown, not dead; retry \`peekaboo permissions --json\` once with a longer bound and fix what it names` };
  }
  if (!probe.ok) {
    return { ok: false, fix: `peekaboo is missing or \`peekaboo permissions --json\` failed (${firstLine(probe.out)}); fix: ${PEEKABOO_INSTALL_FIX}` };
  }
  let permissions: unknown;
  try {
    permissions = (JSON.parse(probe.out) as { data?: { permissions?: unknown } } | null)?.data?.permissions;
  } catch {
    permissions = undefined;
  }
  if (!Array.isArray(permissions)) {
    return { ok: false, fix: `peekaboo answered \`permissions --json\` without data.permissions[] (${firstLine(probe.out)}); fix: ${PEEKABOO_INSTALL_FIX}` };
  }
  // The verdict is good only when the answer is readable (reviewer-codex-a5a459.1):
  // a non-empty list whose every entry is an object with a string name and boolean
  // isRequired/isGranted. One skipped junk entry would let a seat row promise a
  // right nobody checked, so any other shape is the unreadable-answer refusal.
  const unreadable = { ok: false as const, fix: `peekaboo answered \`permissions --json\` with an unreadable permissions list (${firstLine(probe.out)}); fix: ${PEEKABOO_INSTALL_FIX}` };
  if (permissions.length === 0) return unreadable;
  const fixes: string[] = [];
  for (const entry of permissions) {
    if (typeof entry !== 'object' || entry === null) return unreadable;
    const right = entry as { name?: unknown; isRequired?: unknown; isGranted?: unknown; grantInstructions?: unknown };
    if (typeof right.name !== 'string' || typeof right.isRequired !== 'boolean' || typeof right.isGranted !== 'boolean') return unreadable;
    if (!right.isRequired || right.isGranted) continue;
    const how = typeof right.grantInstructions === 'string' && right.grantInstructions.trim()
      ? right.grantInstructions.trim()
      : 'grant it in System Settings > Privacy & Security';
    fixes.push(`peekaboo right "${right.name}" is required and not granted: ${how}`);
  }
  if (fixes.length) return { ok: false, fix: fixes.join('; ') };
  return { ok: true };
}
