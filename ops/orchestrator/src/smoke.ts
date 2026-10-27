// `orch smoke`: prove each provider adapter end to end against the real CLI.
// Per family: start a read-only session, get a nonce echoed back, close the
// process, resume the session in a fresh process and get the nonce recalled.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapterFor, defaultHarness, FAMILIES, hasAdapter, type Family, type Harness, type SessionSpec, type TurnResult } from './providers/index.ts';
import { readHost } from './config.ts';

export type SmokeTurn = Omit<TurnResult, 'text'> & { text: string; ok: boolean };
export type SmokeReport = {
  family: Family;
  harness: Harness;
  ok: boolean;
  model: string | null;
  sessionId: string | null;
  turns: SmokeTurn[];
  error: string | null;
};

const clip = (text: string) => (text.length > 200 ? `${text.slice(0, 200)}…` : text);

export async function smokeFamily(spec: SessionSpec, timeoutMs: number, harness: Harness = defaultHarness(spec.family)): Promise<SmokeReport> {
  const token = `ORCH-${randomBytes(4).toString('hex').toUpperCase()}`;
  const report: SmokeReport = { family: spec.family, harness, ok: false, model: null, sessionId: null, turns: [], error: null };
  let adapter;
  try {
    adapter = adapterFor(spec.family, harness);
  } catch (error) {
    report.error = (error as Error).message;
    return report;
  }
  const turn = (result: TurnResult): boolean => {
    const ok = result.error === null && result.stopReason === 'end_turn' && result.text.includes(token);
    report.turns.push({ ...result, text: clip(result.text), ok });
    return ok;
  };
  let session = null;
  try {
    session = await adapter.start(spec);
    report.sessionId = session.sessionId;
    const first = await session.prompt(`Reply with exactly this token and nothing else, without using any tools: ${token}`, { timeoutMs });
    report.model = session.model;
    await session.close();
    session = null;
    if (!turn(first)) throw new Error(`echo turn failed: ${first.error ?? `stop ${first.rawStopReason}, text '${clip(first.text)}'`}`);

    session = await adapter.resume(spec, report.sessionId);
    const second = await session.prompt('What exact token did you reply with in your previous message? Reply with that token only, without using any tools.', { timeoutMs });
    report.model = session.model ?? report.model;
    if (!turn(second)) throw new Error(`resume turn failed: ${second.error ?? `stop ${second.rawStopReason}, text '${clip(second.text)}'`}`);
    report.ok = true;
  } catch (error) {
    report.error = (error as Error).message;
  } finally {
    await session?.close().catch(() => undefined);
  }
  return report;
}

function parseArgs(argv: string[]) {
  // harness null: each family on its default (Pi where it has a route, native for claude, #11849).
  const options: { families: Family[] | null; harness: Harness | null; model?: string; effort?: string; timeoutMs: number; cwd?: string; host?: string } = { families: null, harness: null, timeoutMs: 180000 };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case '--family':
        options.families = value.split(',') as Family[];
        for (const family of options.families) if (!FAMILIES.includes(family)) throw new Error(`unknown family '${family}' (${FAMILIES.join(', ')})`);
        i += 1;
        break;
      case '--harness':
        if (value !== 'native' && value !== 'pi') throw new Error(`--harness is native or pi, got '${value}'`);
        options.harness = value;
        i += 1;
        break;
      case '--model': options.model = value; i += 1; break;
      case '--effort': options.effort = value; i += 1; break;
      case '--timeout':
        options.timeoutMs = Number(value);
        if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error(`--timeout needs a positive integer of ms, got '${value}'`);
        i += 1;
        break;
      case '--cwd': options.cwd = value; i += 1; break;
      case '--host': options.host = value; i += 1; break;
      default: throw new Error(`unknown argument '${argv[i]}'`);
    }
  }
  // Without --family: every family the chosen harness can run; a named family it cannot run still fails loudly.
  // On a host every family runs through Pi and claude stays native on the Mac (decision #12501).
  const families = options.families ?? FAMILIES.filter((family) => (!options.host || family !== 'claude') && hasAdapter(family, options.harness ?? defaultHarness(family)));
  if ((options.model || options.effort) && families.length !== 1) throw new Error('--model and --effort need exactly one --family');
  return { ...options, families };
}

/** One JSON line per family on stdout; exit 1 when any family failed. */
export async function smoke(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  // A remote cwd is already on the host; do not create it on the launching Mac.
  // Without --host, retain the local scratch directory and absolute --cwd behavior.
  if (options.host && options.families.includes('claude')) throw new Error('--host smoke: claude runs native on the Mac only');
  if (options.host && options.families.some((family) => (options.harness ?? defaultHarness(family)) !== 'pi')) {
    throw new Error('--host smoke supports the Pi harness only');
  }
  const cwd = options.host ? (options.cwd ?? readHost(options.host).repo) : (options.cwd ? path.resolve(options.cwd) : path.join(os.tmpdir(), 'orch-smoke'));
  if (!options.host) mkdirSync(cwd, { recursive: true });
  let failed = 0;
  for (const family of options.families) {
    const report = await smokeFamily({ family, cwd, host: options.host, access: 'read-only', model: options.model, effort: options.effort }, options.timeoutMs, options.harness ?? defaultHarness(family));
    if (!report.ok) failed += 1;
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  return failed ? 1 : 0;
}
