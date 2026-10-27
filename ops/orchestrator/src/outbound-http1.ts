// Task 3105: the daemon hung for 15 minutes with its main thread inside
// node::http2::Http2Session::SendPendingData on one Jev connection. Node 26's
// bundled undici offers ALPN h2 by default, and a JS AbortController cannot stop
// a native send loop. One process-global dispatcher — an Agent with allowH2
// false — makes every built-in fetch offer http/1.1 only. serve() calls this
// first, before any fetch; seat and lead processes keep their own fetch.
import { Agent, setGlobalDispatcher } from 'undici';

/** Pin this process's built-in fetch to HTTP/1.1 (task 3105). Idempotent. */
export function forceOutboundHttp1(): void {
  setGlobalDispatcher(new Agent({ allowH2: false }));
}
