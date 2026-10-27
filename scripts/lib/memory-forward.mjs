import path from 'node:path';
import { harnessLabel } from './harness-config.mjs';

export function forwardLaunchdLabel({ prefix, host }) {
  const base = harnessLabel({ prefix, name: 'memory-forward' });
  const maxHostBytes = Math.min(200, 255 - Buffer.byteLength(`${base}..plist`));
  if (typeof host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host) || host.length > maxHostBytes) {
    throw new Error('--forward expects an SSH host alias within the filename budget');
  }
  return `${base}.${host}`;
}

export function workerPlistPath(daemonPlist, label) {
  return path.join(path.dirname(daemonPlist), `${label}.plist`);
}

// The caller validates the host and ports before rendering a worker.
export function forwardSshArgs({ host, target, servicePort }) {
  return [
    '-NT', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-R', `127.0.0.1:${target}:127.0.0.1:${servicePort}`, host,
  ];
}
