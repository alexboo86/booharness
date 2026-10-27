import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Inspect each live runtime, not a union of commands. Probe the wired command
// rather than this checkout's copy: a stale path must not look installed.
export async function checkLeadChatWiring({ HOME, check, readHome }) {
  for (const [dir, name, matcher] of [
    ['.claude', 'settings.json', ''],
    ['.glm-lead-config', 'settings.json', ''],
    ['.codex', 'hooks.json', '.*'],
  ]) {
    const runtime = join(HOME, dir);
    if (!existsSync(runtime)) continue;
    const file = join(runtime, name);
    check(existsSync(file), `${file} — lead-chat settings must exist`);
    if (!existsSync(file)) continue;
    const text = readHome(file, 'lead-chat wiring');
    if (text === null) continue;
    let doc;
    try { doc = JSON.parse(text); } catch {
      check(false, `${file} — lead-chat settings must parse`);
      continue;
    }
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
      const watching = event === 'Stop';
      const scriptName = watching ? 'lead-chat-watch.mjs' : 'lead-chat-hook.mjs';
      const label = `${file} — lead-chat/${event}`;
      const groups = Array.isArray(doc.hooks?.[event]) ? doc.hooks[event] : [];
      const wires = groups.flatMap((group) => (Array.isArray(group.hooks) ? group.hooks : [])
        .filter((hook) => String(hook.command ?? '').includes(scriptName))
        .map((hook) => ({ ...hook, matcher: group.matcher ?? '' })));
      if (watching && dir === '.codex') {
        check(wires.length === 0, `${label} must not be wired for Codex`);
        continue;
      }
      check(wires.length === 1 && wires[0].type === 'command' && wires[0].matcher === matcher,
        `${label} must be wired once for all tools (run node ops/bootstrap/install-harness.mjs)`);
      if (wires.length !== 1) continue;
      if (watching) check(wires[0].asyncRewake === true && wires[0].timeout === 7200,
        `${label} must have asyncRewake true and timeout 7200`);
      const command = String(wires[0].command);
      // hookCommand emits double quotes; the fallback also accepts legacy bare paths.
      const quoted = watching ? /"([^"]*[\\/]lead-chat-watch\.mjs)"/ : /"([^"]*[\\/]lead-chat-hook\.mjs)"/;
      const bare = watching ? /(?:^|\s)([^\s"]*[\\/]lead-chat-watch\.mjs)(?:\s|$)/ : /(?:^|\s)([^\s"]*[\\/]lead-chat-hook\.mjs)(?:\s|$)/;
      const script = command.match(quoted)?.[1] ?? command.match(bare)?.[1];
      check(Boolean(script && existsSync(script)), `${label} wired script must exist: ${script ?? command}`);
      if (!script || !existsSync(script)) continue;
      let result = await probe(command, event);
      if (!result.ok) result = await probe(command, event);
      const contract = watching ? 'exit silently for seats' : 'inject unread chat and report delivery';
      check(result.ok, `${label} wired command must ${contract}${result.ok ? '' : `: ${result.detail}`}`);
    }
  }
}

async function probe(command, event) {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-wiring-'));
  const session = `lead-chat-wiring-${process.pid}-${event}`;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET'
      ? { posts: [{ id: 39, author: 'probe-peer', body: 'wiring probe', to: 'all', wake: false }], more: 0 }
      : { delivered: 1 }));
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const log = join(dir, 'lead.jsonl');
    writeFileSync(log, `${JSON.stringify({ type: 'assistant', sessionId: session, cwd: dir,
      entrypoint: 'claude-desktop', timestamp: '2026-10-06T09:00:00Z',
      message: { model: 'claude-opus-5-5', usage: { input_tokens: 1, cache_read_input_tokens: 120000, output_tokens: 7 } },
    })}\n`);
    const env = { ...process.env, ORCH_STATE_DIR: join(dir, 'state'), ORCH_PORT: String(server.address().port),
      ORCH_CHAT_REQUEST_BUDGET_MS: '10000' };
    delete env.ORCH_SEAT_ID;
    delete env.SEAT_POLICY_ROLE;
    if (event === 'Stop') {
      // A real lead Stop would long-poll. Use an otherwise eligible lead
      // transcript plus seat env: silence must come from exclusion, not
      // missing input. Any mistaken polling reaches only this probe's server.
      env.ORCH_SEAT_ID = 'lead-chat-wiring-probe';
      env.SEAT_POLICY_ROLE = 'coder';
    }
    mkdirSync(env.ORCH_STATE_DIR);
    const result = await new Promise((resolve) => {
      const child = spawn(command, { shell: true, cwd: dir, env, timeout: 15000 });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ session_id: session, transcript_path: log, hook_event_name: event }));
    });
    if (event === 'Stop') return {
      ok: result.code === 0 && result.stdout === '' && result.stderr === '' && requests.length === 0,
      detail: `exit ${result.code}; requests ${requests.length}; ${JSON.stringify((result.stderr || result.stdout).slice(0, 160))}`,
    };
    let output;
    try { output = JSON.parse(result.stdout).hookSpecificOutput; } catch { /* invalid output is a failed probe */ }
    const ok = result.code === 0 && output?.hookEventName === event
      && output.additionalContext?.includes('probe-peer -> all: wiring probe')
      && output.additionalContext?.includes('[orch-chat 39]')
      && requests.includes(`GET /chat/unread?session=${session}`) && requests.includes('POST /chat/delivered');
    return { ok: Boolean(ok), detail: `exit ${result.code}; ${result.stderr.trim().slice(0, 160) || 'missing chat envelope or delivery request'}` };
  } catch (error) {
    return { ok: false, detail: error.message };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}
