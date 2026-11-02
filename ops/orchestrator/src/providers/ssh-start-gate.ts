import { ChildProcess, spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { PassThrough, type Readable, type Writable } from 'node:stream';

export const SSH_START_LIMIT = 6;
export const SSH_START_BOUND_MS = 15_000;

type Release = () => void;
type HostGate = { active: number; waiters: (() => void)[] };
const hosts = new Map<string, HostGate>();

/** FIFO per SSH target. Acquisition itself has no failure, cancellation or retry path. */
function acquire(host: string): Promise<Release> {
  const gate = hosts.get(host) ?? { active: 0, waiters: [] };
  hosts.set(host, gate);
  return new Promise(resolve => {
    const grant = () => {
      gate.active++;
      let held = true;
      resolve(() => {
        if (!held) return;
        held = false;
        gate.active--;
        const next = gate.waiters.shift();
        if (next) next();
        else if (gate.active === 0) hosts.delete(host);
      });
    };
    if (gate.active < SSH_START_LIMIT && gate.waiters.length === 0) grant();
    else gate.waiters.push(grant);
  });
}

/**
 * Forward a caller's destroy of a facade stream to the real SSH pipe. probeEnd destroys all three
 * after a probe timeout because a descendant can hold a pipe open after ssh itself has exited, and
 * only the real pipe keeps the daemon's event loop alive. A normal end() is not a destroy: pipe()
 * flushes every buffered byte first (directHostNode and syncHostRuntime send a whole script over
 * stdin), so the real stream is left alone once the facade's own end was requested or reached.
 */
function forwardDestroy(facade: PassThrough, real: Readable | Writable | null | undefined): void {
  if (!real) return;
  const callerDestroyed = () => facade.destroyed && !facade.writableEnded && !facade.readableEnded;
  // Destroyed while the start was still queued: 'close' has fired already, so apply it now.
  if (callerDestroyed()) { real.destroy(); return; }
  facade.once('close', () => { if (callerDestroyed()) real.destroy(); });
}

/**
 * A child facade that delays only the real spawn. Callers keep their synchronous child API: input
 * buffers while queued, and an existing timeout can kill the facade before a slot becomes available.
 */
class GatedSsh extends ChildProcess {
  private inner?: ChildProcess;
  private readonly input = new PassThrough();
  private readonly output = new PassThrough();
  private readonly errors = new PassThrough();
  private cancelled?: NodeJS.Signals | number;
  private ended = false;
  private referenced = true;

  constructor(host: string, args: readonly string[], options: SpawnOptions) {
    super();
    this.stdin = this.input;
    this.stdout = this.output;
    this.stderr = this.errors;
    Object.assign(this, { stdio: [this.stdin, this.stdout, this.stderr, null, null] });
    void this.start(host, args, options);
  }

  override kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.ended) return false;
    if (!this.inner) {
      this.cancelled = signal;
      Object.assign(this, { killed: true });
      this.finishCancelled(signal);
      return true;
    }
    const killed = this.inner.kill(signal);
    Object.assign(this, { killed: this.inner.killed });
    return killed;
  }

  override ref(): this {
    this.referenced = true;
    this.inner?.ref();
    return this;
  }

  override unref(): this {
    this.referenced = false;
    this.inner?.unref();
    return this;
  }

  private async start(host: string, args: readonly string[], options: SpawnOptions): Promise<void> {
    const release = await acquire(host);
    if (this.cancelled !== undefined) {
      release();
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn('ssh', args, options);
    } catch (error) {
      release();
      this.finishError(error as Error);
      return;
    }
    this.inner = child;
    Object.assign(this, { pid: child.pid, spawnfile: child.spawnfile, spawnargs: child.spawnargs });
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      release();
    };
    const timer = setTimeout(releaseOnce, SSH_START_BOUND_MS);
    timer.unref();
    child.stdout?.once('data', releaseOnce);
    child.stderr?.once('data', releaseOnce);
    child.once('error', error => {
      releaseOnce();
      this.emit('error', error);
    });
    child.once('exit', (code, signal) => {
      releaseOnce();
      this.ended = true;
      Object.assign(this, { exitCode: code, signalCode: signal, killed: child.killed });
      this.emit('exit', code, signal);
    });
    child.once('close', (code, signal) => {
      this.ended = true;
      this.emit('close', code, signal);
    });
    child.once('spawn', () => this.emit('spawn'));
    this.wire(child);
    if (!this.referenced) child.unref();
  }

  /**
   * Attach the real pipes to their facades. A facade stream the caller already destroyed while the
   * start was queued is never piped into: writing to a destroyed stream raises an error nobody
   * listens for. forwardDestroy closes that real pipe instead.
   */
  private wire(child: ChildProcess): void {
    if (child.stdin && !this.input.destroyed) {
      child.stdin.on('error', error => this.input.destroy(error));
      this.input.pipe(child.stdin);
    }
    forwardDestroy(this.input, child.stdin);
    if (!this.output.destroyed) child.stdout?.pipe(this.output);
    forwardDestroy(this.output, child.stdout);
    if (!this.errors.destroyed) child.stderr?.pipe(this.errors);
    forwardDestroy(this.errors, child.stderr);
  }

  private finishCancelled(signal: NodeJS.Signals | number): void {
    this.ended = true;
    Object.assign(this, { signalCode: typeof signal === 'string' ? signal : null });
    this.input.destroy();
    this.output.end();
    this.errors.end();
    this.emit('exit', null, this.signalCode);
    this.emit('close', null, this.signalCode);
  }

  private finishError(error: Error): void {
    this.ended = true;
    this.input.destroy();
    this.output.end();
    this.errors.end();
    this.emit('error', error);
    this.emit('close', null, null);
  }
}

/** Start one managed SSH process, limited per SSH target while it authenticates. */
export function spawnSsh(host: string, args: readonly string[], options: SpawnOptions): ChildProcessWithoutNullStreams {
  return new GatedSsh(host, args, options) as ChildProcessWithoutNullStreams;
}
