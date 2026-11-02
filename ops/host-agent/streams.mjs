import { constants } from 'node:http2';
import { once } from 'node:events';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_FRAME = 65536;

// Called by orch's HTTP/2 client on the accepted TLS socket after authentication.
// The outbound-dialing agent is the HTTP/2 server on its end of that socket.
export function openExecStream(session, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('invalid exec id');
  return session.request({
    ':method': 'POST', ':path': `/v1/exec/${id}`, 'content-type': 'application/octet-stream',
  }, { endStream: false });
}

export function pipeWithBackpressure(source, destination, options = {}) {
  return pipeline(source, destination, options);
}

function outputFrames(channel) {
  return new Transform({
    transform(chunk, encoding, callback) {
      for (let offset = 0; offset < chunk.length; offset += MAX_FRAME) {
        const data = chunk.subarray(offset, offset + MAX_FRAME);
        const frame = Buffer.allocUnsafe(5 + data.length);
        frame[0] = channel;
        frame.writeUInt32BE(data.length, 1);
        data.copy(frame, 5);
        this.push(frame);
      }
      callback();
    },
  });
}

async function outputTo(source, stream, channel) {
  await pipeline(source, outputFrames(channel), stream, { end: false });
}

export function sendExitTrailers(stream, { code, signal, pid }) {
  stream.once('wantTrailers', () => stream.sendTrailers({
    'orch-exit-code': code === null ? '' : String(code),
    'orch-exit-signal': signal ?? '',
    'orch-remote-pid': String(pid),
  }));
  stream.end();
}

// The caller owns spawning/policy and supplies a real platform process-tree killer.
// In particular Windows callers must use a kill-on-close Job Object, not taskkill /T.
export async function pipeExec(stream, child, { killTree }) {
  if (typeof killTree !== 'function') throw new Error('process-tree killer required');
  let completed = false;
  let cancelled = false;
  const cancel = () => {
    if (completed || cancelled) return;
    cancelled = true;
    killTree(child.pid);
  };
  const stdinError = (error) => {
    if (error.code !== 'EPIPE') stream.destroy(error);
    stream.unpipe(child.stdin);
    stream.resume();
  };
  stream.once('aborted', cancel);
  stream.once('close', cancel);
  stream.once('error', cancel);
  child.stdin.on('error', stdinError);
  // A clean request END_STREAM means stdin EOF, not cancellation; RST/close kills.
  stream.pipe(child.stdin);
  try {
    const [exit] = await Promise.all([
      once(child, 'close'), outputTo(child.stdout, stream, 1), outputTo(child.stderr, stream, 2),
    ]);
    const result = { code: exit[0], signal: exit[1], pid: child.pid };
    sendExitTrailers(stream, result);
    completed = true;
    return result;
  } catch (error) {
    cancel();
    stream.close(constants.NGHTTP2_INTERNAL_ERROR);
    throw error;
  } finally {
    stream.unpipe(child.stdin);
    // The command may exit while orch's stdin half is still open. Drain any
    // in-flight stdin so its eventual END_STREAM can close the HTTP/2 stream.
    stream.resume();
  }
}

async function writeOutput(destination, data) {
  // Waiting for the write callback also observes delayed sink failures and keeps
  // at most one bounded frame pending, even when write() initially returns true.
  await new Promise((resolve, reject) => {
    destination.write(data, error => error ? reject(error) : resolve());
  });
}

async function drainFrames(pending, destinations) {
  while (pending.length >= 5) {
    const channel = pending[0];
    const size = pending.readUInt32BE(1);
    if ((channel !== 1 && channel !== 2) || size === 0 || size > MAX_FRAME) throw new Error('invalid exec output frame');
    if (pending.length < size + 5) break;
    await writeOutput(destinations[channel - 1], pending.subarray(5, 5 + size));
    pending = pending.subarray(5 + size);
  }
  return pending;
}

// Orch-side demultiplexing. Destinations stay open and are owned by the caller.
export async function readExecOutput(stream, { stdout, stderr }) {
  let pending = Buffer.alloc(0);
  const outputError = error => stream.destroy(error);
  stdout.on('error', outputError);
  stderr.on('error', outputError);
  try {
    for await (const chunk of stream) {
      pending = await drainFrames(Buffer.concat([pending, chunk]), [stdout, stderr]);
    }
    if (pending.length) throw new Error('truncated exec output frame');
  } catch (error) {
    stream.destroy(error);
    throw error;
  } finally {
    stdout.off('error', outputError);
    stderr.off('error', outputError);
  }
}
