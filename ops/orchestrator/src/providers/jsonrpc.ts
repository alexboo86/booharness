// Newline-delimited JSON-RPC over a child's stdio: ACP agents (JSON-RPC 2.0)
// and `codex app-server` (the same framing without the "jsonrpc" member).
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readLines, stderrTail } from './spawn.ts';
import { span } from '../shared.entry.ts';

export type RequestHandler = (method: string, params: any) => Promise<unknown> | unknown;
export type NotificationHandler = (method: string, params: any) => void;

export class RpcError extends Error {
  code: number;
  data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; method: string };

export class JsonRpcPeer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private withVersion: boolean;
  private closedError: Error | null = null;
  private markClosed!: (error: Error) => void;
  /** Settles with the reason once the provider process is gone. */
  readonly whenClosed: Promise<Error> = new Promise((resolve) => { this.markClosed = resolve; });
  readonly stderr: () => string;
  onRequest: RequestHandler = (method) => { throw new RpcError(-32601, `method not found: ${method}`); };
  onNotification: NotificationHandler = () => {};
  onNoise: (line: string) => void = () => {};

  constructor(child: ChildProcessWithoutNullStreams, { withVersion = true } = {}) {
    this.child = child;
    this.withVersion = withVersion;
    this.stderr = stderrTail(child);
    readLines(child.stdout, (line) => this.receive(line), 'jsonrpc stdout');
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) => span('jsonrpc exit', () => {
      const tail = this.stderr();
      this.fail(new Error(`provider exited (${signal ?? code})${tail ? `: ${tail}` : ''}`));
    }));
    child.stdin.on('error', (error) => this.fail(error));
  }

  get closed(): boolean {
    return this.closedError !== null;
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closedError) this.send({ method, params });
  }

  /** Closed at once, not at exit: nothing the dying process still prints is read. */
  kill(reason = 'closed by orch'): void {
    this.fail(new Error(reason));
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  private send(message: Record<string, unknown>): void {
    const body = this.withVersion ? { jsonrpc: '2.0', ...message } : message;
    this.child.stdin.write(`${JSON.stringify(body)}\n`);
  }

  private receive(line: string): void {
    if (this.closedError) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.onNoise(line);
      return;
    }
    if (message === null || typeof message !== 'object') return this.onNoise(line);
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new RpcError(message.error.code, `${pending.method}: ${message.error.message}`, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    if (hasId) {
      void this.answer(message.id, message.method, message.params);
      return;
    }
    if (typeof message.method === 'string') this.onNotification(message.method, message.params);
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onRequest(method, params);
      this.send({ id, result: result ?? null });
    } catch (error) {
      const rpc = error instanceof RpcError ? error : new RpcError(-32603, (error as Error).message);
      this.send({ id, error: { code: rpc.code, message: rpc.message } });
    }
  }

  private fail(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.markClosed(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
