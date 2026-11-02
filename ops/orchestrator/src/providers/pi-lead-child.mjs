#!/usr/bin/env node
/**
 * The Pi lead child shim (task 3459 L0b). lead-driver.ts speaks claude stream-json to every
 * lead child and reads line events back; a Pi lead runs the pinned runtime in `--mode rpc`
 * (providers/pi.ts), which speaks a different protocol. This shim IS the lead child:
 *
 *   driver ──claude user lines──▶ pi-lead-child ──rpc prompt commands──▶ pi
 *   driver ◀──pi event lines─── pi-lead-child ◀──rpc events/responses── pi
 *
 * It translates each driver user line into one RPC `prompt` command, forwards every Pi stdout
 * line to the driver (pi-lead.ts parses them), and owns the protocol duties a raw pipe would
 * miss:
 *  - `agent_settled` is forwarded only while a turn is open (rpc.md: settle can also fire for
 *    work no prompt asked for), and a refused or `handled` prompt gets a synthesized settle so
 *    the driver's turn always closes (a `handled` prompt starts no run at all);
 *  - `extension_ui_request` dialogs are dismissed headless exactly like a Pi seat
 *    (providers/pi.ts): nobody can answer a dialog on a supervised child;
 *  - every forwarded line has U+2028/U+2029 escaped to their JSON `\u` forms: the driver reads
 *    with readline, which splits on those separators although they are valid inside JSON
 *    strings (rpc.md, "Framing");
 *  - at start it verifies through `get_state`/`get_commands` what the seat adapter verifies:
 *    the provider Pi actually runs is the route's (a wrong provider is a silent substitution,
 *    lesson #10740) and orch's Pi extension loaded — Pi has no permission hook (memory
 * #10739), so that extension is the lead's tool gate; without it the child must not run.
 *
 * No imports from the orchestrator: argv after this script is the pi command and its args.
 */
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('pi-lead-child: argv must name the pi command\n');
  process.exit(2);
}

const EXPECTED_PROVIDER = process.env.ORCH_PI_LEAD_PROVIDER;
const EXPECTED_EXTENSION = process.env.ORCH_PI_LEAD_EXTENSION_COMMAND;
const child = spawn(command, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
let exiting = false;
/** Turns the driver opened and Pi has not settled yet; settled resets it (rpc.md: one settle drains a queue). */
let open = 0;
let nextPrompt = 1;
const fail = (message) => {
  if (exiting) return;
  exiting = true;
  process.stderr.write(`pi-lead-child: ${message}\n`);
  child.kill('SIGKILL');
  process.exit(1);
};

process.stderr.write(`pi-lead-child: ${command} ${args.join(' ')}\n`);

const send = (record) => {
  child.stdin.write(`${JSON.stringify(record)}\n`);
};
// Escaped for the driver's line reader; JSON keeps the decoded value identical.
const forward = (line) => {
  process.stdout.write(`${line.replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')}\n`);
};

function onPiLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'response') return onResponse(event, line);
  if (event.type === 'extension_ui_request') return onUiRequest(event);
  if (event.type === 'agent_settled') return onSettled(line);
  return forward(line);
}

function onResponse(event, line) {
  if (event.id === 'lead-state') return onStateResponse(event, line);
  if (event.id === 'lead-commands') return onCommandsResponse(event, line);
  if (typeof event.id === 'string' && event.id.startsWith('lead-prompt-')) return onPromptResponse(event, line);
  if (typeof event.id === 'string' && event.id.startsWith('lead-stats-')) return onStatsResponse(event, line);
  return forward(line);
}

/** The handover limit derives from the model's context window (lesson #10797): after the session
 *  starts and after every settled turn the shim queries `get_session_stats`, the only window source
 *  (providers/pi.ts contextUsage), and forwards the answer for pi-lead.ts to report in lead usage. */
let nextStats = 1;
/** One labelled warning per run: a missing window is expected (flat cap), never fatal, never spam. */
let warnedNoWindow = false;
const queryStats = () => send({ id: `lead-stats-${nextStats++}`, type: 'get_session_stats' });

function onStatsResponse(event, line) {
  const window = event.data?.contextUsage?.contextWindow;
  const reported = event.success === true && typeof window === 'number' && Number.isFinite(window) && window > 0;
  if (!reported && !warnedNoWindow) {
    warnedNoWindow = true;
    process.stderr.write('pi-lead-child: warn: get_session_stats reported no context window; the handover keeps the flat cap\n');
  }
  return forward(line);
}

function onStateResponse(event, line) {
  if (event.success !== true) return fail(`get_state failed: ${event.error}`);
  const provider = event.data?.model?.provider;
  if (EXPECTED_PROVIDER && provider !== EXPECTED_PROVIDER) {
    return fail(`pi runs provider ${provider ?? 'none'}, not the lead route's ${EXPECTED_PROVIDER}`);
  }
  forward(line);
  startupPassed('lead-state');
  // The session just started or resumed: read the window the handover limit derives from.
  return queryStats();
}

function onCommandsResponse(event, line) {
  if (event.success !== true) return fail(`get_commands failed: ${event.error}`);
  const loaded = Array.isArray(event.data?.commands)
    && event.data.commands.some((c) => c?.name === EXPECTED_EXTENSION && c?.source === 'extension');
  if (!loaded) return fail(`pi did not load the orch extension (no ${EXPECTED_EXTENSION ?? 'orch-seat'} command); the lead child has no tool gate`);
  startupPassed('lead-commands');
  return forward(line);
}

function onPromptResponse(event, line) {
  if (event.success !== true) {
    if (open > 0) open -= 1;
    // A refusal is not a completed run. The provider reports it as a visible failure.
    return forward(line);
  }
  const disposition = event.data?.disposition;
  if (disposition === 'handled') {
    // No run starts for an extension-handled prompt. Do not close another active run.
    if (open > 0) open -= 1;
    forward(line);
    if (open === 0) forward('{"type":"agent_settled","aborted":false}');
    return;
  }
  return forward(line);
}

function onUiRequest(event) {
  // Headless: a dialog nobody answers would block the lead; dismiss like a Pi seat.
  if (['select', 'confirm', 'input', 'editor'].includes(event.method) && event.id !== undefined) {
    send({ type: 'extension_ui_response', id: event.id, cancelled: true });
  }
}

function onSettled(line) {
  if (open > 0) {
    open = 0;
    forward(line);
    // A turn just ended: re-read the window so a model change is current next turn (lesson #10797).
    return queryStats();
  }
  // A settle no open turn asked for (startup, post-abort drain) is not the lead's turn end.
}

// Split on LF only: U+2028/U+2029 are valid inside JSON strings (rpc.md, "Framing").
const splitLines = (stream, onLine) => {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (line.trim()) onLine(line);
    }
  });
};

splitLines(child.stdout, onPiLine);
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('error', (error) => fail(`spawn ${command}: ${error.message}`));
child.on('exit', (code, signal) => {
  if (exiting) return;
  exiting = true;
  process.exitCode = code ?? 1;
  if (signal) process.kill(process.pid, signal);
  else process.exit(process.exitCode);
});

// The driver's turn line: claude stream-json user message → one RPC prompt.
const driverLine = (line) => {
  let record;
  try { record = JSON.parse(line); } catch { return; }
  if (record.type === 'orch-compact') {
    send({ id: `lead-compact-${nextPrompt++}`, type: 'compact' });
    return;
  }
  if (record.type !== 'user') return;
  const content = record.message?.content;
  const text = (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('');
  if (!text) return;
  const streaming = open > 0;
  open += 1;
  send({ id: `lead-prompt-${nextPrompt++}`, type: 'prompt', message: text, ...(streaming ? { streamingBehavior: 'followUp' } : {}) });
};
splitLines(process.stdin, driverLine);

// Startup verification, before any turn can run: provider identity and the extension gate.
// Startup verification, before any turn can run: provider identity and the extension gate.
/** Checks whose answer is still out; a handler fails the run on a bad answer, so a pass is final. */
const startupOutstanding = new Set(EXPECTED_EXTENSION ? ['lead-state', 'lead-commands'] : ['lead-state']);
const startupTimer = setTimeout(() => {
  if (!exiting) fail('pi did not answer the startup verification in 60 s');
}, 60_000).unref();
/** One startup check passed; once every one has, the timer can no longer kill a healthy run. */
const startupPassed = (id) => {
  startupOutstanding.delete(id);
  if (startupOutstanding.size === 0) clearTimeout(startupTimer);
};
send({ id: 'lead-state', type: 'get_state' });
if (EXPECTED_EXTENSION) send({ id: 'lead-commands', type: 'get_commands' });

process.stdin.on('end', () => {
  // The driver stops its child by ending stdin (lead-driver.ts): an orderly Pi shutdown.
  child.stdin.end();
  setTimeout(() => {
    if (!exiting) {
      child.kill('SIGKILL');
      process.exit(0);
    }
  }, 2_000).unref();
});
process.on('SIGTERM', () => {
  // Never orphan pi: the driver SIGTERMs this shim only.
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
});
