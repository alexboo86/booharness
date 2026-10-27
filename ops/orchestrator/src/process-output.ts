import type { spawn } from 'node:child_process';

// Shared process collection: remote probes must keep stdin open until close.
// Kept independent of providers and the daemon's Git checkout transport.
export function collect(child: ReturnType<typeof spawn>, input?: Buffer, label = 'remote git', remoteProcess = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const output: Buffer[] = [], errors: Buffer[] = [];
    let settled = false, stdinError: Error | undefined;
    let stdinDeadline: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (stdinDeadline) clearTimeout(stdinDeadline);
      reject(error);
    };
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', fail);
    child.stdin.on('error', (error: Error) => {
      if (settled) return;
      stdinError = error;
      child.kill();
      stdinDeadline = setTimeout(() => fail(error), 2_000);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (stdinDeadline) clearTimeout(stdinDeadline);
      if (code !== 0) fail(new Error(`${label} exit ${code}${code === null ? ` (signal ${signal ?? 'unknown'})` : ''}: ${Buffer.concat(errors).toString('utf8').trim()}`));
      else if (stdinError) fail(stdinError);
      else { settled = true; resolve(Buffer.concat(output)); }
    });
    if (remoteProcess) {
      // remote-exec treats stdin EOF as disconnect and kills its child.
      if (input) child.stdin.write(input);
    } else if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export const text = (bytes: Buffer) => bytes.toString('utf8').trim();
