import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path, { resolve } from 'node:path';

// The kit wrapper owns the local writer's label and service tasks.
export function memoryInstallerFor(repoRoot) {
  return existsSync(resolve(repoRoot, 'ops/memory-local/install.mjs'))
    ? 'ops/memory-local/install.mjs' : 'ops/bootstrap/install-memory.mjs';
}

/// The interpreter a service unit (launchd plist, Windows task) holds has to
/// outlive runtime upgrades. A Homebrew node runs from a version-specific
/// keg (/opt/homebrew/Cellar/node/26.7.0/bin/node); when brew removes that
/// version the units die with it (task 3427: memoryd exited EX_CONFIG 78 with
/// no listener, the backup child with ENOENT). The stable spells for the same
/// formula are the brew-managed symlinks: <prefix>/bin/<formula>, then
/// <prefix>/opt/<formula>/bin/node. A non-keg path has no unstable spelling.
function stableNodeCandidates(execPath) {
  const posixPath = String(execPath).split(path.sep).join('/');
  const keg = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node(\.exe)?$/.exec(posixPath);
  if (!keg) return [];
  const suffix = keg[3] ?? '';
  return [
    path.join(keg[1], 'bin', keg[2] + suffix),
    path.join(keg[1], 'opt', keg[2], 'bin', 'node' + suffix),
  ];
}

/// The probe is the sqlite import, and it is bounded: a candidate that hangs
/// (a broken launcher shim, a wedged binary) is killed after PROBE_TIMEOUT_MS
/// and counts as a failure, never as a resolution that blocks the installer.
/// The kill is SIGKILL: a candidate that ignores SIGTERM (a trapped shell
/// wrapper survives into its exec'd child) would otherwise outlive the bound
/// and exit 0 — turning the lie the probe exists to catch into the answer.
/// A healthy `node -e 'import("node:sqlite")'` starts in well under a second;
/// the bound leaves two orders of magnitude of cold-start headroom.
const PROBE_TIMEOUT_MS = 5000;

/// The unit's node has to run memoryd.mjs, which imports node:sqlite at load:
/// existence alone would advertise a unit that fails to exec and restart-loops,
/// so the probe is the import, not a stat call. Returns null when the
/// interpreter runs, or a short per-candidate diagnostic — missing, timed out,
/// or the exit code with the first stderr line — for the refusal message.
function nodeProbeOutcome(interpreter) {
  if (!existsSync(interpreter)) return 'missing';
  const probe = spawnSync(interpreter, ['--input-type=module', '-e', 'import("node:sqlite")'],
    { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' });
  return spawnOutcome(probe);
}

/// Classify one probe result: a timeout kill (spawnSync reports it as status
/// null with error ETIMEDOUT; some node builds only set the null status and the
/// kill signal), a start failure, or a nonzero exit with the first stderr line.
function spawnOutcome(probe) {
  if (probe.error?.code === 'ETIMEDOUT' || (probe.status === null && probe.error == null)) {
    return `timed out after ${PROBE_TIMEOUT_MS} ms`;
  }
  if (probe.error) return `failed to start (${probe.error.code ?? probe.error.message})`;
  if (probe.status !== 0) return `probe failed (exit ${probe.status})${stderrHead(probe)}`;
  return null;
}

/// The first line of the probe's stderr, bounded: one line keeps the refusal
/// single-line, and the bound keeps a candidate's noise from drowning it.
function stderrHead(probe) {
  const head = String(probe.stderr ?? '').trim().split(/\r?\n/)[0]?.slice(0, 120) ?? '';
  return head ? `: ${head}` : '';
}

/// Resolve the interpreter a service unit should hold. A non-keg execPath
/// passes through unchanged; a Homebrew keg execPath resolves to the first
/// stable spell that exists and runs. When no stable spell does, the caller
/// gets `refusal` — a message naming the override and each candidate's own
/// outcome, so a missing node and one that exists but fails the probe do not
/// read the same — instead of a path that brew can delete.
export function resolveServiceNodeBin(execPath) {
  const candidates = stableNodeCandidates(execPath);
  if (candidates.length === 0) return { nodeBin: execPath };
  const attempted = [];
  for (const candidate of candidates) {
    const outcome = nodeProbeOutcome(candidate);
    if (outcome === null) return { nodeBin: candidate };
    attempted.push(`${candidate}: ${outcome}`);
  }
  return { refusal: `the running node ${execPath} is a version-specific Homebrew keg that stops existing when brew removes that version, and no stable node was found (${attempted.join('; ')}). Set MEMORYCTL_NODE_BIN (the kit's --node passes it through) to a stable interpreter that exists and runs` };
}
