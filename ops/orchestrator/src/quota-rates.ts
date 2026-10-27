// Task 1998 slice S1 (operator #13835): a family's quota burn is calibrated per QUOTA UNIT,
// not per raw token. Vendors price the models of a shared plan pool differently (codex Luna is
// 1/20 of Sol, glm flash 1/3 of glm-5.3, mimo flash 1/3 of pro, kimi k3-256k 1/2 of k3), so raw
// tokens pooled over all roles priced a cheap scout turn like a flagship coder turn.
//
// One table, family -> model -> {input, cacheRead, cacheWrite, output}, each row with the source
// URL and the date it was read (task 1998, researcher-kimi-61dddb.1, re-scraped 2026-10-03).
// cacheWrite is priced at the input (cache-miss) rate in every family (plan-critic answer).
// A family or model without a row (claude, grok, qwen, opencode) weighs 1 on every part: units
// equal raw tokens, which is the behaviour before this change.
import type { Family } from './providers/types.ts';

export type QuotaParts = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type QuotaRate = QuotaParts & { source: string; date: string };

export const QUOTA_RATES: Partial<Record<Family, { flagship: string; models: Record<string, QuotaRate> }>> = {
  codex: {
    // Credits per 1M tokens: input / cached input / output; cache write at the input rate.
    flagship: 'gpt-6.1-sol',
    models: {
      'gpt-6.1-sol': { input: 50, cacheRead: 2.5, cacheWrite: 50, output: 250, source: 'https://help.openai.com/en/articles/11481834', date: '2026-10-03' },
      'gpt-6-luna': { input: 2.5, cacheRead: 0.25, cacheWrite: 2.5, output: 12.5, source: 'https://help.openai.com/en/articles/11481834', date: '2026-10-03' },
    },
  },
  glm: {
    // Credit multipliers: (in*mult + cached*mult + out*mult) / 10000; cache write at the input rate.
    flagship: 'glm-5.3',
    models: {
      'glm-5.3': { input: 6.9, cacheRead: 1.7, cacheWrite: 6.9, output: 24, source: 'https://docs.z.ai/devpack/overview', date: '2026-10-03' },
      'glm-5.3-flash': { input: 2.3, cacheRead: 0.56, cacheWrite: 2.3, output: 8, source: 'https://docs.z.ai/devpack/overview', date: '2026-10-03' },
    },
  },
  mimo: {
    // Credits per 1M tokens: cache-miss input / cache-hit input / output; cache write at the miss rate.
    flagship: 'mimo-v2.6-pro',
    models: {
      'mimo-v2.6-pro': { input: 300, cacheRead: 2.5, cacheWrite: 300, output: 600, source: 'https://mimo.mi.com/docs/en-US/price/token-plan', date: '2026-10-03' },
      'mimo-v2.6-flash': { input: 100, cacheRead: 2, cacheWrite: 100, output: 200, source: 'https://mimo.mi.com/docs/en-US/price/token-plan', date: '2026-10-03' },
    },
  },
  kimi: {
    // kimi.com: 'k3 (1M) consumes about twice as much quota as k3-256k'; same relative weight on every part.
    flagship: 'k3',
    models: {
      k3: { input: 2, cacheRead: 2, cacheWrite: 2, output: 2, source: 'https://www.kimi.com/code/docs/en/kimi-code/models.html', date: '2026-10-03' },
      'k3-256k': { input: 1, cacheRead: 1, cacheWrite: 1, output: 1, source: 'https://www.kimi.com/code/docs/en/kimi-code/models.html', date: '2026-10-03' },
      // Assumed weight: the Kimi Code models page gives no rate for k3.1-pro.
      // It is 1M-context only; k3 (1M) costs about twice k3-256k, so use the k3 weight.
      'k3.1-pro': { input: 2, cacheRead: 2, cacheWrite: 2, output: 2, source: 'https://www.kimi.com/code/docs/en/kimi-code/models.html', date: '2026-10-24' },
    },
  },
};

/** True when the family has a rate table; only then do units differ from raw tokens. */
export function hasQuotaRates(family: string): boolean {
  return QUOTA_RATES[family as Family] !== undefined;
}

/**
 * The quota units of a turn's usage parts: parts weighted by the model's rates, divided by the
 * family flagship's input rate (the scale is arbitrary; the percent-per-unit calibration absorbs
 * it, so a cache-heavy flagship turn lands far below its raw token count — no "near raw"
 * expectation). An unlisted family or model returns the raw token sum: today's behaviour.
 */
export function quotaUnits(parts: QuotaParts, family: string, model: string | null): number {
  const raw = parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
  const table = QUOTA_RATES[family as Family];
  const rate = table && model ? table.models[model] : undefined;
  if (!table || !rate) return raw;
  const base = table.models[table.flagship].input;
  return (parts.input * rate.input + parts.cacheRead * rate.cacheRead + parts.cacheWrite * rate.cacheWrite + parts.output * rate.output) / base;
}
