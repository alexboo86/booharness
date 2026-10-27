import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { harnessPaths, readHarnessConfig } from '../../scripts/lib/harness-config.mjs';
import { prepareState, redact } from './jev-gate.mjs';
import { recordJevUsage, recordCreditError, isCreditCandidate, JEV_MODEL_ID } from './jev-ledger.mjs';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const KEY_NAME = 'TYPESAFE_API_KEY';
const REPO = fileURLToPath(new URL('../../', import.meta.url));
/** Pinned, never the moving `jev-latest` alias: the gate thresholds are tuned
 * against one model version (docs.typesafe.ai/models, read 2026-09-25). */
export const JEV_MODEL = 'jev-1.13.0';

let secretsFile;
function secretValueFrom(bytes) {
  let value;
  for (const line of bytes.split(/\r?\n/)) {
    const cut = line.indexOf('=');
    if (cut > 0 && !line.trim().startsWith('#') && line.slice(0, cut).trim() === KEY_NAME) {
      value = line.slice(cut + 1).trim();
    }
  }
  return value;
}
/** The project's secret store is the source of the key on every machine
 * (docs/agent/environment.md): a seat spawned by the Paseo daemon may carry an
 * environment that predates the key or holds a rotated one. Order and parsing
 * match install-harness.mjs:loadSecrets/secretValue: the file first, then the
 * environment. The value is never logged. A caller that names a home (the
 * setup wizard proves the key of the home it configures) reads that home's
 * store instead; the cached path stays that of the process home. */
export function readApiKey(home) {
  let value;
  try {
    if (typeof home === 'string' && home) {
      value = secretValueFrom(readFileSync(harnessPaths({
        prefix: readHarnessConfig({ repoRoot: REPO }).names.prefix,
        home,
      }).secretsFile, 'utf8'));
    } else {
      if (secretsFile === undefined) secretsFile = harnessPaths({
        prefix: readHarnessConfig({ repoRoot: REPO }).names.prefix,
        home: homedir(),
      }).secretsFile;
      value = secretValueFrom(readFileSync(secretsFile, 'utf8'));
    }
  } catch { /* no secrets file: the environment decides */ }
  return value || process.env[KEY_NAME] || undefined;
}

/** Tests point this at a fixture so the suite never reads the real key. */
export function useSecretsFile(file) { secretsFile = file; }

function redactQuestions(value, sanitize) {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map((entry) => redactQuestions(entry, sanitize));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [sanitize(key), redactQuestions(entry, sanitize)]));
}

/** Only bounded client status codes may enter seat metadata; never expose response or exception text. */
export function jevFailureReason(result) {
  const error = result?.error;
  return typeof error === 'string' && /^(?:timeout|request-failed|invalid-response|invalid-input|blocked|missing-api-key|http-[0-9]{3})$/.test(error)
    ? error : 'invalid-answer';
}

/** Dormant until explicitly wired by a later phase. Errors never include input,
 * provider response bodies, credentials, exception messages or stacks. */
export async function ask({ text, questions, timeoutMs = 1500, maxChars = 6000, model: requested = JEV_MODEL, home } = {}) {
  const started = performance.now();
  let state = '';
  let status = 'invalid-input';
  // Only the regression runner names another version (scripts/jev-regression); the gates keep the pin.
  let model = typeof requested === 'string' && requested.length <= 64 && JEV_MODEL_ID.test(requested) ? requested : JEV_MODEL;
  let timer;
  const ms = () => Math.round(performance.now() - started);
  try {
    if (model !== requested) return { error: status };
    if (typeof text !== 'string' || !Number.isSafeInteger(maxChars) || maxChars <= 0
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0
      || timeoutMs > 2147483647 || !questions || typeof questions !== 'object'
      || Array.isArray(questions)) return { error: status };
    const prepared = prepareState(text, { maxChars });
    state = prepared.state;
    if (prepared.blocked) { status = 'blocked'; return { error: status }; }
    // Normalize toJSON output, then apply the same value-only redaction to all
    // outbound strings. Credential-related questions must remain routable too.
    const encodedQuestions = JSON.stringify(questions);
    const questionObject = JSON.parse(encodedQuestions);
    if (!questionObject || typeof questionObject !== 'object' || Array.isArray(questionObject)
      || Object.keys(questionObject).length === 0) return { error: status };
    const key = readApiKey(home);
    if (!key) { status = 'missing-api-key'; return { error: status }; }
    const sanitize = (value) => redact(value).replaceAll(key, '[REDACTED]');
    state = sanitize(state);
    const body = JSON.stringify({ model, state, questions: redactQuestions(questionObject, sanitize) });
    const controller = new AbortController();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, timeoutMs);
    });
    const request = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(ENDPOINT, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
        });
        if (controller.signal.aborted) return { error: 'timeout' };
        if ((response.status === 429 || response.status === 529) && attempt === 0) {
          await response.body?.cancel();
          if (controller.signal.aborted) return { error: 'timeout' };
          continue;
        }
        if (!response.ok) {
          if (isCreditCandidate(response.status)) {
            const errorBody = await response.text?.();
            void recordCreditError(errorBody, response.status, process.env.ORCH_SEAT_ID || process.argv[1] || 'unknown', model);
          } else await response.body?.cancel();
          status = `http-${response.status}`;
          return { error: status };
        }
        const data = await response.json();
        // A 200 can be billed even when its answers are malformed or a deadline
        // expires during parsing. Accounting must precede answer validation.
        // The response names the model that performed the evaluation (docs.typesafe.ai/api.md);
        // only a bounded Jev id may enter the audit line and the ledger, never free provider text.
        if (typeof data?.model === 'string' && data.model.length <= 64 && JEV_MODEL_ID.test(data.model)) model = data.model;
        void recordJevUsage(data?.usage?.input_tokens, process.env.ORCH_SEAT_ID || process.argv[1] || 'unknown', model);
        if (controller.signal.aborted) return { error: 'timeout' };
        if (!data?.answers || typeof data.answers !== 'object' || Array.isArray(data.answers)) {
          status = 'invalid-response';
          return { error: status };
        }
        status = 'ok';
        return { answers: data.answers, usage: data.usage, model, ms: ms() };
      }
    };
    try { return await Promise.race([request(), deadline]); }
    catch { status = controller.signal.aborted ? 'timeout' : 'request-failed'; return { error: status }; }
  } catch {
    return { error: status };
  } finally {
    clearTimeout(timer);
    // MSK, explicit offset. The audit is metadata only, one line per ask.
    const ts = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace('Z', '+03:00');
    process.stderr.write(`${JSON.stringify({ ts, sha256: createHash('sha256').update(state).digest('hex'), bytes: Buffer.byteLength(state), ms: ms(), status, model })}\n`);
  }
}
