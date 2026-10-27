// memoryd owns one resident JSONL child; no extra service or test-only seam.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function createReranker(python, stateDir, log) {
  // Off is only this env. A missing interpreter without it stays unavailable.
  if (process.env.MEMORYCTL_RERANK === 'off') {
    return {
      health: () => ({ status: 'off', lastError: null, pid: null }),
      rerank() { return Promise.resolve({ header: null }); },
      stop() {},
    };
  }
  let child = null;
  let status = 'down';
  let lastError = python ? null : 'MEMORYCTL_RERANK_PYTHON is not set';
  let stopped = false;
  let restartTimer;
  let warmTimer;
  let backoff = 1000;
  let failedLoads = 0;
  let requestId = 0;
  let active = null;
  const queue = [];
  const reason = () => status === 'warming' ? 'warming' : lastError || 'down';
  const unavailable = (error) => ({ header: `unavailable: ${String(error).replace(/[^\x20-\x7e]/g, ' ').slice(0, 240)}` });

  function finish(item, result) {
    if (item.settled) return;
    item.settled = true;
    clearTimeout(item.timer);
    item.resolve(result);
  }
  function fail(error) {
    if (status === 'warming') failedLoads++;
    status = 'down';
    lastError = String(error);
    if (failedLoads >= 3) lastError += '; stopped after 3 consecutive failed loads; restart memoryd to retry';
    clearTimeout(warmTimer);
    if (active) { finish(active, unavailable(lastError)); active = null; }
    for (const item of queue.splice(0)) finish(item, unavailable(lastError));
    child?.kill('SIGKILL'); // Only load, process and protocol failures unload the model.
  }
  function pump() {
    if (active || status !== 'ready' || !child || !queue.length) return;
    active = queue.shift();
    const worker = child;
    worker.stdin.write(`${JSON.stringify({ id: active.id, query: active.query, docs: active.docs })}\n`, (error) => {
      if (error && child === worker) fail(`stdin: ${error.message}`);
    });
  }
  function start() {
    if (stopped || failedLoads >= 3) return;
    status = 'warming';
    const worker = spawn(python, [fileURLToPath(new URL('./rerank-worker.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HF_HOME: path.join(stateDir, 'rerank-model'), HF_HUB_OFFLINE: '1' } });
    child = worker;
    let output = '';
    let stderr = '';
    warmTimer = setTimeout(() => fail('warming timeout after 180 s'), 180_000);
    worker.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-400); });
    worker.stdin.on('error', error => { if (child === worker) fail(`stdin: ${error.message}`); });
    worker.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 64 * 1024) { fail('invalid worker response: oversized line'); return; }
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        if (status === 'down') continue;
        try {
          const result = JSON.parse(line);
          if (status === 'warming' && result.ready === true) {
            clearTimeout(warmTimer);
            status = 'ready';
            lastError = null;
            failedLoads = 0;
            continue;
          }
          if (!Number.isSafeInteger(result.id) || result.id < 1 || result.id > requestId) {
            throw new Error('invalid request id');
          }
          if (result.id !== active?.id) continue; // A stale/duplicate answer cannot score another query.
          if (active.settled) { active = null; pump(); continue; }
          if (!Array.isArray(result.scores) || result.scores.length !== active.docs.length
            || result.scores.some(score => typeof score !== 'number' || !Number.isFinite(score))) {
            throw new Error(result.error || 'invalid score count or non-finite score');
          }
          finish(active, { header: 'ok', scores: result.scores });
          active = null;
          lastError = null;
          backoff = 1000;
          pump();
        } catch (error) { fail(`worker protocol: ${error.message}`); }
      }
    });
    worker.on('error', error => fail(`spawn: ${error.message}`));
    worker.on('close', (code, signal) => {
      if (status !== 'down') fail(`worker exit ${signal || code}${stderr ? `: ${stderr.trim()}` : ''}`);
      child = null;
      if (!stopped && failedLoads < 3) {
        log(`reranker down: ${lastError}; restart in ${backoff} ms`);
        restartTimer = setTimeout(start, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    });
  }
  if (python) start();
  return {
    health: () => ({ status, lastError, pid: child?.pid ?? null }),
    rerank(query, docs, timeoutMs) {
      if (status !== 'ready') return Promise.resolve(unavailable(reason()));
      if (timeoutMs <= 0) return Promise.resolve(unavailable('request timeout budget exhausted'));
      if (!docs.length) return Promise.resolve({ header: 'ok', scores: [] });
      return new Promise(resolve => {
        const item = { id: ++requestId, query, docs, resolve };
        item.timer = setTimeout(() => {
          if (active === item) {
            lastError = 'worker timeout';
            // Keep the single-flight slot until this ID answers. The caller's
            // deadline does not cancel GPU work or trigger an expensive reload.
            finish(item, unavailable(lastError));
          }
          else {
            const index = queue.indexOf(item);
            if (index !== -1) queue.splice(index, 1);
            finish(item, unavailable('queue timeout'));
          }
        }, timeoutMs);
        queue.push(item);
        pump();
      });
    },
    stop() {
      stopped = true;
      clearTimeout(restartTimer);
      fail('shutdown');
    },
  };
}
