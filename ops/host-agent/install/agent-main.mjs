import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runAgent } from '../agent.mjs';
import { readPointer } from './manager.mjs';

function markReady(root, version) {
  writeFileSync(path.join(root, 'ready.json'), `${JSON.stringify({ version, pid: process.pid })}\n`, { mode: 0o600 });
}

async function scheduleActivation(root, pointer) {
  const pending = path.join(root, 'pending-update.json');
  const temporary = `${pending}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(pointer)}\n`, { mode: 0o600 });
  renameSync(temporary, pending);
  const child = spawn(process.execPath, [path.join(root, 'switch.mjs'), '--root', root], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return pointer;
}

function clearOwnReady(root) {
  try {
    const readyPath = path.join(root, 'ready.json');
    const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
    if (ready.pid === process.pid) unlinkSync(readyPath);
  } catch { /* already removed or replaced by the next version */ }
}

export async function runInstalled(root) {
  const config = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
  const pointer = readPointer(root);
  const pairingPath = path.join(root, 'pairing.json');
  const pairing = existsSync(pairingPath) ? JSON.parse(readFileSync(pairingPath, 'utf8')) : null;
  const statePath = path.join(root, 'credential.json');
  let agent;
  const options = {
    origin: pairing?.origin ?? config.origin,
    agentVersion: pointer.version,
    statePath,
    pair: pairing?.pair,
    approvedFingerprint: pairing?.approvedFingerprint ?? undefined,
    onPaired: async () => {
      if (existsSync(pairingPath)) unlinkSync(pairingPath); // the one-time secret is erased after pairing
    },
    update: { root, activate: (staged) => scheduleActivation(root, staged) },
    approveCheckCode: async ({ code }) => {
      // QR installation needs no prompt. Embedders with a UI use runAgent's
      // callback directly; a background service has no hidden approval fallback.
      process.stderr.write(`Pairing check code: ${code}\n`);
      throw new Error('typed pairing requires an interactive operator approval');
    },
  };
  agent = runAgent(options);
  markReady(root, pointer.version);
  const result = await agent.promise;
  clearOwnReady(root);
  if (result.reason === 'stopped') return;
  throw new Error(`host agent stopped: ${result.reason}`);
}
