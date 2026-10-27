#!/usr/bin/env node
// Stop watcher (task 2139, plan 14640 D6). Registration with asyncRewake is
// separate. Connection/socket failures and 5xx retry silently after 5 s.
// At 7100 s the held poll or retry wait is aborted, before the hook's 7200 s
// timeout. Script-local test overrides: ORCH_CHAT_WATCH_RETRY_MS and
// ORCH_CHAT_WATCH_DEADLINE_MS (positive integer milliseconds).
import { setTimeout as delay } from 'node:timers/promises';
import { formatBatch, leadChatTarget, readStdin, reportPrinted } from './lead-chat-hook.mjs';

const duration = (name, standard) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : standard;
};
const retryMs = duration('ORCH_CHAT_WATCH_RETRY_MS', 5_000);
const deadline = AbortSignal.timeout(duration('ORCH_CHAT_WATCH_DEADLINE_MS', 7_100_000));
// The watcher's own start time (plan 14824): the daemon reads it as how long this lead has
// been idle, so a broadcast wakes the poll only while its prompt cache is still warm.
const since = new Date().toISOString();

let code = 0;
try {
  const input = readStdin();
  const target = await leadChatTarget(input);
  if (target) {
    const { base, session } = target;
    while (!deadline.aborted) {
      let answer;
      try {
        const response = await fetch(
          `${base}/chat/wake?session=${encodeURIComponent(session)}&since=${encodeURIComponent(since)}`,
          { signal: deadline },
        );
        if (response.status >= 500 && response.status <= 599) {
          await response.body?.cancel();
        } else {
          if (response.status !== 200) break;
          answer = await response.json();
        }
      } catch (error) {
        if (deadline.aborted || error instanceof SyntaxError) break;
        // A failed connection or interrupted body is retryable, invalid JSON is not.
      }
      if (answer === undefined) {
        await delay(retryMs, undefined, { signal: deadline });
        continue;
      }
      const batch = answer?.superseded === true ? null : formatBatch(answer);
      if (!batch || deadline.aborted) break;
      await new Promise((resolve, reject) => {
        process.stderr.once('error', reject);
        process.stderr.write(`${batch.text}\n`, (error) => error ? reject(error) : resolve());
      });
      code = 2;
      await reportPrinted(input, batch.text);
      break;
    }
  }
} catch {
  // A watcher that cannot deliver must not wake a lead or print a diagnostic.
}
process.exit(code);
