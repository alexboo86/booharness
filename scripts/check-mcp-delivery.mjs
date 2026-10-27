#!/usr/bin/env node
// What the RUNTIME says it has, not what our SSOT says it should have.
//
// Measured 2026-08-12: `~/.codex/config.toml` carried the office plugins, the
// three session hooks and ZERO `[mcp_servers.*]` tables, while an hour earlier
// the same file held `brightdata-web` with a live token. `codex mcp list`
// answered `No MCP servers configured yet`. Nothing in the tree said so: the
// SSOT was right, `test:mcp-ssot-render` drives the installer against a
// THROWAWAY home and was green, and every other sensor reads files we wrote.
// The operator's own codex sessions ran with no code index, no memory tool and
// no web for a day.
//
// Two runtimes answer for themselves and both are asked here:
//   codex — `codex mcp list`
//   grok  — `grok mcp list`
// kimi offers no such command (its `doctor` validates config.toml and tui.toml
// only), and the Claude-family runtimes read a settings file this repo also
// writes. For those the check reads the file and SAYS SO in its label, because
// "we read our own copy" and "the runtime loaded it" are different facts and a
// sensor that blurs them is the thing that failed here.
//
// A runtime that is not installed is not a violation - the same rule the other
// live probes follow.
//
// `--write-tool-baseline` is a separate mode (task 1559, MCPTox arXiv 2508.14925):
// an allowlisted server can change its tool names, descriptions or input
// schemas under the same id, and a poisoned description is read by every
// agent that loads the server. This mode pins what each server ANSWERS today —
// initialize + tools/list over stdio (launched the way the installer renders
// it) or over streamable HTTP for an http server that needs no secret — into
// a tracked JSON file. A server it must not ask (auth headers or env tokens)
// is never contacted, and one it cannot honestly ask (unreachable, missing
// entry file, silent past the timeout) is recorded as
// `{unverifiable: "<reason>"}`, never guessed. Options:
//   --out <file>        default ops/bootstrap/mcp-tool-baseline.json
//   --ssot <file>       read servers from this file only (tests); default both
//                       ops/bootstrap/mcp-servers.json and mcp-servers.operator.json
//   --timeout-ms <n>    per server, default 20000
//
// `--check-tool-baseline` (npm run check:mcp-tools) recomputes the same snapshot
// and diffs it against the tracked file: any added, removed or changed tool
// fails with a readable diff of the description or inputSchema that moved, and
// so does a server that was pinned and can no longer be asked. A server
// unverifiable in BOTH runs is a note, not a failure — it was never pinned, so
// nothing it serves today can be compared against yesterday. Same options.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homeReader } from './home-read-lib.mjs';
import { harnessPaths, readHarnessConfig } from './lib/harness-config.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretBindings } from '../ops/bootstrap/secret-bindings.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';

// Never inherit the seat's own environment into a probed server: a server
// that echoes an env value into a tool description would get it written into
// the tracked baseline and printed in a drift diff (reviewer-codex, 1559 2c).
const PROBE_ENV_KEYS =
  process.platform === 'win32'
    ? ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SystemRoot', 'APPDATA', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE']
    : ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'];

/** The largest reply a probe reads; bigger is unverifiable, not buffered. */
const REPLY_LIMIT = 1024 * 1024;

class OverDeep extends Error {}

/** JSON with object keys sorted at every depth: the form a hash is taken over. */
function canonicalJson(value, depth = 0) {
  if (depth > 64) throw new OverDeep('schema nesting over 64');
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Why this server cannot be asked from here, or null when it can be asked. */
function unaskable(spec) {
  // Secrets first: an entry that carries auth headers or env tokens is never
  // contacted, whatever its transport, so no secret can leak into a request.
  const secrets = secretBindings(spec).map((entry) => entry.secret);
  if (secrets.length || spec.bearer_from_secret) {
    return `needs secrets (${[...secrets, spec.bearer_from_secret].filter(Boolean).join(', ')}); a tracked baseline is not taken with operator keys`;
  }
  if (spec.url || (spec.transport && spec.transport !== 'stdio')) {
    if (!spec.url) return `transport ${spec.transport} with no url; only stdio and http are pinned`;
    let parsed;
    try {
      parsed = new URL(spec.url);
    } catch {
      return `unparseable url ${spec.url}`;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `remote ${spec.transport || 'http'} server with ${parsed.protocol} url; only http(s) is pinned`;
    }
    return null; // an http server with no auth is asked over streamable HTTP
  }
  if (!spec.command) return 'no command defined';
  if (spec.requires_file) {
    const file = spec.requires_file.replaceAll('{repo}', REPO);
    if (!existsSync(file)) return `requires ${relative(REPO, file) || file}, which is not on this machine`;
  }
  return null;
}

/**
 * Spawn one stdio server, ask initialize + tools/list, and ALWAYS kill it.
 * Resolves to { tools } or { unverifiable }. The child leads its own process
 * group on POSIX so a wrapper's grandchildren die with it.
 */
function askServer(spec, timeoutMs) {
  const expand = (value) => String(value).replaceAll('{repo}', REPO);
  const env = {};
  for (const key of PROBE_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [key, value] of Object.entries(spec.env_static ?? {})) env[key] = expand(value);
  const posix = process.platform !== 'win32';
  return new Promise((resolveAnswer) => {
    let child;
    try {
      child = spawn(expand(spec.command), (spec.args ?? []).map(expand), {
        cwd: REPO,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: posix,
        shell: !posix,
      });
    } catch (error) {
      resolveAnswer({ unverifiable: `cannot start: ${error.message}` });
      return;
    }
    let settled = null;
    let exited = false;
    let stderr = '';
    let buffer = '';
    let stage = 'initialize';
    const pending = new Map();
    const tools = [];
    const kill = () => {
      if (exited) return;
      try {
        if (posix) process.kill(-child.pid, 'SIGKILL');
        else spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } catch {
        child.kill('SIGKILL');
      }
    };
    // The answer is delivered only after the child has exited, so a caller that
    // sees the result also sees the process gone.
    const finish = (answer) => {
      if (settled) return;
      settled = answer;
      clearTimeout(timer);
      if (exited) resolveAnswer(settled);
      else kill();
    };
    const timer = setTimeout(
      () => finish({ unverifiable: `no answer to ${stage} within ${timeoutMs} ms` }),
      timeoutMs,
    );
    let nextId = 1;
    const ask = (method, params) =>
      new Promise((resolveReply) => {
        const id = nextId++;
        pending.set(id, resolveReply);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    child.stdin.on('error', () => {});
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-400);
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > REPLY_LIMIT) {
        finish({ unverifiable: `reply over ${REPLY_LIMIT / 1024 / 1024} MiB` });
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      }
    });
    child.on('error', (error) => {
      // A spawn that never produced a process emits no 'exit'.
      if (child.pid === undefined) exited = true;
      finish({ unverifiable: `cannot start: ${error.message}` });
    });
    child.on('exit', (code, signal) => {
      exited = true;
      // The leader is gone; anything it left in its group goes with it.
      if (posix) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
      if (!settled) {
        settled = {
          unverifiable: `exited (${signal || `code ${code}`}) before answering ${stage}` +
            (stderr.trim() ? `: ${stderr.trim().split('\n').pop().slice(0, 200)}` : ''),
        };
        clearTimeout(timer);
      }
      resolveAnswer(settled);
    });
    (async () => {
      const init = await ask('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'check-mcp-delivery', version: '1' },
      });
      if (init.error) return finish({ unverifiable: `initialize failed: ${init.error.message}` });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      stage = 'tools/list';
      let cursor;
      do {
        const page = await ask('tools/list', cursor ? { cursor } : {});
        if (page.error) return finish({ unverifiable: `tools/list failed: ${page.error.message}` });
        tools.push(...(page.result?.tools ?? []));
        cursor = page.result?.nextCursor;
      } while (cursor);
      finish({ tools });
    })();
  });
}

/**
 * Every JSON-RPC message in a reply body: the bare JSON document, or each
 * `data:` payload of an SSE stream (an event's data lines join with '\n').
 */
function mcpMessages(body) {
  const text = body.trim();
  try {
    return [JSON.parse(text)];
  } catch {
    // SSE framing.
  }
  const messages = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // An event that is not JSON-RPC is not an answer.
    }
  }
  return messages;
}

/**
 * Ask an http server that needs no secret: initialize +
 * notifications/initialized + tools/list over streamable HTTP, the same
 * protocol version the stdio path speaks. The Mcp-Session-Id a reply carries
 * rides on every later request. Resolves to { tools } or { unverifiable }.
 */
async function askHttpServer(spec, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const PROTOCOL = '2025-06-18';
  let stage = 'initialize';
  let sessionId = null;
  let nextId = 1;
  try {
    const post = async (message) => {
      const left = deadline - Date.now();
      if (left <= 0) throw Object.assign(new Error(`no answer to ${stage} within ${timeoutMs} ms`), { ours: true });
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      if (sessionId) {
        headers['mcp-session-id'] = sessionId;
        headers['mcp-protocol-version'] = PROTOCOL;
      }
      const response = await fetch(spec.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(left),
      });
      const sid = response.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      if (message.id === undefined) {
        // A notification: 202/204 and nothing to read; anything else is a refusal.
        if (!response.ok && response.status !== 202) {
          throw new Error(`${message.method} refused: HTTP ${response.status}`);
        }
        return null;
      }
      // Read incrementally and cut the stream the moment it passes the cap:
      // `response.text()` buffered a 256 MiB reply to 921 MB RSS before the
      // length check ever ran (reviewer-glm, 1559).
      const chunks = [];
      let bytes = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > REPLY_LIMIT) {
            await reader.cancel().catch(() => {});
            throw Object.assign(new Error(`reply over ${REPLY_LIMIT / 1024 / 1024} MiB`), { ours: true });
          }
          chunks.push(value);
        }
      }
      const body = new TextDecoder().decode(Buffer.concat(chunks));
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      const reply = mcpMessages(body).find((candidate) => candidate && candidate.id === message.id);
      if (!reply) throw new Error(`no reply to ${message.method} (id ${message.id}) in the response body`);
      return reply;
    };
    const init = await post({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'check-mcp-delivery', version: '1' },
      },
    });
    if (init.error) return { unverifiable: `initialize failed: ${init.error.message}` };
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    stage = 'tools/list';
    const tools = [];
    let cursor;
    do {
      const page = await post({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/list',
        params: cursor ? { cursor } : {},
      });
      if (page.error) return { unverifiable: `tools/list failed: ${page.error.message}` };
      tools.push(...(page.result?.tools ?? []));
      cursor = page.result?.nextCursor;
    } while (cursor);
    return { tools };
  } catch (error) {
    if (error.ours) return { unverifiable: error.message };
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return { unverifiable: `no answer to ${stage} within ${timeoutMs} ms` };
    }
    const cause = error.cause?.code ? ` (${error.cause.code})` : '';
    return { unverifiable: `cannot reach ${spec.url}: ${error.message}${cause}` };
  }
}

function baselineOptions(argv) {
  const option = (name, fallback) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  return {
    out: resolve(option('--out', join(REPO, 'ops', 'bootstrap', 'mcp-tool-baseline.json'))),
    timeoutMs: Number(option('--timeout-ms', '20000')),
    ssotFiles: argv.includes('--ssot')
      ? [resolve(option('--ssot'))]
      : ['mcp-servers.json', 'mcp-servers.operator.json'].map((name) => join(REPO, 'ops', 'bootstrap', name)),
  };
}

/**
 * Ask every allowlisted server what it serves today. Returns the sorted
 * [id, entry] pairs of the same snapshot `--write-tool-baseline` pins, plus
 * one console line per server: writing and checking run the SAME code, so the
 * two can never disagree about what "the snapshot" is.
 */
async function buildSnapshot(ssotFiles, timeoutMs) {
  const specs = [];
  for (const file of ssotFiles) {
    for (const [id, spec] of Object.entries(JSON.parse(readFileSync(file, 'utf8')).servers ?? {})) {
      if (!id.startsWith('_') && !spec.disabled) specs.push([id, spec]);
    }
  }
  const started = Date.now();
  const entries = await Promise.all(
    specs.map(async ([id, spec]) => {
      const t0 = Date.now();
      const reason = unaskable(spec);
      const answer = reason
        ? { unverifiable: reason }
        : spec.url
          ? await askHttpServer(spec, timeoutMs)
          : await askServer(spec, timeoutMs);
      const ms = Date.now() - t0;
      if (answer.unverifiable) {
        return [id, { unverifiable: answer.unverifiable }, `unverifiable: ${id} — ${answer.unverifiable} (${ms} ms)`];
      }
      let tools;
      try {
        tools = answer.tools
          .map(({ name, description, inputSchema }) => {
            const pinned = { name, description: description ?? null, inputSchema: inputSchema ?? null };
            return { ...pinned, sha256: createHash('sha256').update(canonicalJson(pinned)).digest('hex') };
          })
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch (error) {
        if (!(error instanceof OverDeep)) throw error;
        return [id, { unverifiable: error.message }, `unverifiable: ${id} — ${error.message} (${ms} ms)`];
      }
      return [id, { tools }, `pinned: ${id} — ${tools.length} tools (${ms} ms)`];
    }),
  );
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { entries, lines: entries.map(([, , line]) => line), ms: Date.now() - started };
}

async function writeToolBaseline(argv) {
  const { out, timeoutMs, ssotFiles } = baselineOptions(argv);
  const { entries, lines, ms } = await buildSnapshot(ssotFiles, timeoutMs);
  for (const line of lines) console.log(line);
  const baseline = {
    _comment:
      'Generated by `node scripts/check-mcp-delivery.mjs --write-tool-baseline` (task 1559). What each allowlisted ' +
      'local stdio MCP server answered to tools/list: sha256 is over the canonical (sorted-key) JSON of ' +
      '{name, description, inputSchema}. `unverifiable` names why a server was not asked. Regenerate, never hand-edit.',
    schema_version: 1,
    servers: Object.fromEntries(entries),
  };
  writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`\nmcp-tool-baseline: wrote ${relative(REPO, out) || out} in ${ms} ms`);
  return 0;
}

/** Pretty JSON with object keys sorted at every depth: the diffable form. */
function stableJson(value, depth = 0) {
  const pad = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((item) => '  '.repeat(depth + 1) + stableJson(item, depth + 1)).join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (!keys.length) return '{}';
    return `{\n${keys
      .map((key) => '  '.repeat(depth + 1) + `${JSON.stringify(key)}: ${stableJson(value[key], depth + 1)}`)
      .join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Unified line diff (longest common subsequence) of two texts. */
function diffLines(before, after) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < a.length) lines.push(`- ${a[i++]}`);
  while (j < b.length) lines.push(`+ ${b[j++]}`);
  return lines;
}

/** One short line of a possibly long description, for context lines. */
function firstLine(text) {
  return String(text ?? '').split('\n')[0].slice(0, 160);
}

/**
 * The diff body of one changed field. Over 2,000 lines on either side the LCS
 * table alone costs gigabytes (a 45,000-line description under the 1 MiB cap
 * reached 2.85 GB RSS — reviewer-glm, 1559), so the check prints a bounded
 * summary instead and fails exactly as with a full diff.
 */
function describeChange(before, after, was, tool) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  if (a.length <= 2000 && b.length <= 2000) return diffLines(before, after).join('\n');
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  const context = (lines) =>
    lines
      .slice(Math.max(0, at - 3), at + 4)
      .map((line, index) => `${Math.max(0, at - 3) + index + 1}: ${line}`)
      .join('\n');
  return (
    `[${a.length} vs ${b.length} lines; sha256 ${was.sha256} -> ${tool.sha256}; first differing line ${at + 1}]\n` +
    `before:\n${context(a)}\nafter:\n${context(b)}`
  );
}

/** The drift failures for one server that was pinned and answered again. */
function toolDrift(id, pinnedTools, liveTools) {
  const failures = [];
  const liveByName = new Map(liveTools.map((tool) => [tool.name, tool]));
  for (const tool of pinnedTools) {
    if (!liveByName.has(tool.name)) {
      failures.push(`${id}/${tool.name} — tool REMOVED${tool.description ? ` (was: ${firstLine(tool.description)})` : ''}`);
    }
  }
  const pinnedByName = new Map(pinnedTools.map((tool) => [tool.name, tool]));
  for (const tool of liveTools) {
    const was = pinnedByName.get(tool.name);
    if (!was) {
      failures.push(`${id}/${tool.name} — tool ADDED${tool.description ? `: ${firstLine(tool.description)}` : ''}`);
      continue;
    }
    if (was.sha256 === tool.sha256) continue;
    const parts = [];
    if (canonicalJson(was.description ?? null) !== canonicalJson(tool.description ?? null)) {
      parts.push(['description', String(was.description ?? 'null'), String(tool.description ?? 'null')]);
    }
    if (canonicalJson(was.inputSchema ?? null) !== canonicalJson(tool.inputSchema ?? null)) {
      parts.push(['inputSchema', stableJson(was.inputSchema ?? null), stableJson(tool.inputSchema ?? null)]);
    }
    if (!parts.length) {
      // sha256 moved while no pinned field did: the baseline entry is inconsistent with itself.
      parts.push(['pinned entry', stableJson(was), stableJson(tool)]);
    }
    failures.push(
      `${id}/${tool.name} — ${parts.map(([label]) => label).join(' and ')} CHANGED:\n` +
        parts.map(([, before, after]) => describeChange(before, after, was, tool)).join('\n'),
    );
  }
  return failures;
}

async function checkToolBaseline(argv) {
  const { out, timeoutMs, ssotFiles } = baselineOptions(argv);
  const shown = relative(REPO, out) || out;
  if (!existsSync(out)) {
    console.error(`mcp-tool-baseline: ${shown} does not exist; run --write-tool-baseline first`);
    return 1;
  }
  let pinned;
  try {
    pinned = JSON.parse(readFileSync(out, 'utf8')).servers ?? {};
  } catch (error) {
    console.error(`mcp-tool-baseline: cannot read ${shown}: ${error.message}`);
    return 1;
  }
  const { entries, lines, ms } = await buildSnapshot(ssotFiles, timeoutMs);
  for (const line of lines) console.log(line);
  const live = Object.fromEntries(entries);
  const failures = [];
  const notes = [];
  for (const [id, answer] of Object.entries(live)) {
    const was = pinned[id];
    if (!was) {
      failures.push(`${id} — answers ${(answer.tools ?? []).length} tools but is not pinned; run --write-tool-baseline`);
    } else if (answer.unverifiable) {
      if (was.unverifiable) {
        notes.push(`${id} unverifiable in both runs — now: ${answer.unverifiable}`);
      } else {
        failures.push(
          `${id} — was pinned (${was.tools?.length ?? 0} tools) and is now unverifiable: ${answer.unverifiable}`,
        );
      }
    } else if (was.unverifiable) {
      notes.push(`${id} was unverifiable when pinned, now answers ${answer.tools.length} tools; regenerate to pin them`);
    } else {
      failures.push(...toolDrift(id, was.tools ?? [], answer.tools));
    }
  }
  for (const id of Object.keys(pinned)) {
    if (!(id in live)) notes.push(`${id} is pinned but no longer in the SSOT files; regenerate the baseline`);
  }
  for (const note of notes) console.log(`note: ${note}`);
  if (failures.length) {
    console.error('');
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    console.error(`\nmcp-tool-baseline: ${failures.length} drift(s) against ${shown} in ${ms} ms`);
    return 1;
  }
  console.log(`\nmcp-tool-baseline: ${Object.keys(live).length} servers match ${shown} (${notes.length} notes) in ${ms} ms`);
  return 0;
}

if (process.argv.includes('--write-tool-baseline')) {
  process.exit(await writeToolBaseline(process.argv.slice(2)));
}
if (process.argv.includes('--check-tool-baseline')) {
  process.exit(await checkToolBaseline(process.argv.slice(2)));
}

const failures = [];
const ok = [];
const check = (cond, label) => (cond ? ok.push(label) : failures.push(label));

const ssot = JSON.parse(readFileSync(join(REPO, 'ops', 'bootstrap', 'mcp-servers.json'), 'utf8'));
// Absent and unreadable are DIFFERENT answers, and reading them as one is how
// this check went green on a round that measured nothing. `existsSync` passes on
// a path a sandboxed seat may stat but not open; the bare read that stood here
// then returned an EMPTY file, every secret looked missing, and every
// `skip_if_secrets_missing` server became "legitimately absent" — a pass with no
// measurement behind it. So: absent means the secrets are genuinely not on this
// machine (a real answer), unreadable means this seat cannot judge the servers
// that depend on them, and it says so by name below.
const skipped = [];
const readHome = homeReader(skipped);
let secretsText = null;
try {
  const secretsFile = harnessPaths({
    prefix: readHarnessConfig({ repoRoot: REPO }).names.prefix,
    home: HOME,
  }).secretsFile;
  secretsText = existsSync(secretsFile) ? readHome(secretsFile, 'secrets that decide which servers are owed') : '';
} catch (error) {
  check(false, error.message);
}
const secretsReadable = secretsText !== null;
const secrets = secretsReadable ? secretsText : '';
const unjudged = new Set();
const secretPresent = (name) =>
  new RegExp(`^\\s*${name}\\s*=\\s*\\S`, 'm').test(secrets);

/**
 * The ids a runtime OWES, by the same three rules the installer applies:
 * an id may name the runtimes it belongs in, a `json_runtimes_only` server is
 * never written to a TOML runtime, and a server that declares
 * `skip_if_secrets_missing` is legitimately absent when its secret is not on
 * this machine.
 */
function owed(runtime) {
  return Object.entries(ssot.servers)
    .filter(([id]) => !id.startsWith('_'))
    .filter(([id, server]) => {
      if (Array.isArray(server.runtimes) && !server.runtimes.includes(runtime)) return false;
      if (server.json_runtimes_only) return false;
      if (server.skip_if_secrets_missing) {
        // Cannot read the secrets? Then this server is neither owed nor excused
        // — it is UNJUDGED, and it leaves by name rather than by silence.
        if (!secretsReadable) {
          unjudged.add(id);
          return false;
        }
        return secretBindings(server).every((entry) => entry.optional || secretPresent(entry.secret));
      }
      return true;
    })
    .map(([id]) => id);
}

/** Ask the runtime itself. `null` means the CLI is not on this machine. */
function runtimeAnswer(command, args) {
  const probe = spawnSync(
    process.platform === 'win32' ? 'cmd.exe' : command,
    process.platform === 'win32' ? ['/d', '/s', '/c', command, ...args] : args,
    { encoding: 'utf8', timeout: 60000 },
  );
  const text = `${probe.stdout || ''}${probe.stderr || ''}`;
  if (probe.error || /not recognized|command not found|unknown command/i.test(text)) return null;
  return { status: probe.status, text };
}

for (const [runtime, command] of [
  ['codex', 'codex'],
  ['grok', 'grok'],
]) {
  const answer = runtimeAnswer(command, ['mcp', 'list']);
  if (answer === null) {
    console.log(`skip: ${runtime} mcp list — no ${runtime} on this machine`);
    continue;
  }
  // A listing that could not be produced is not an empty listing. The status is
  // checked for the same reason the kimi doctor probe checks it: a crashed
  // command whose text matches no pattern would otherwise read as "nothing
  // missing".
  if (answer.status !== 0) {
    check(false, `${runtime} mcp list exited ${answer.status}: ${answer.text.trim().slice(0, 200)}`);
    continue;
  }
  const missing = owed(runtime).filter((id) => !answer.text.includes(id));
  check(
    missing.length === 0,
    `${runtime} — the runtime itself lists every MCP server the SSOT gives it` +
      (missing.length
        ? `; MISSING: ${missing.join(', ')}. Something rewrote ~/.${runtime === 'codex' ? 'codex' : 'grok'}/config.toml ` +
          'after the installer did (the runtime writes its own trust and plugin state into that file). ' +
          'Re-run ops/bootstrap/install-harness.mjs FROM THE MAIN CHECKOUT (--operator-profile if the operator-profile ' +
          'servers belong on this machine) and re-check with this sensor, never by reading the file'
        : ''),
  );
}

// The runtimes with no listing command of their own, read as what this is: our
// own copy of the config, not the runtime's answer.
for (const [runtime, path] of [
  ['kimi', join(HOME, '.kimi-code', 'mcp.json')],
  ['claude', join(HOME, '.claude.json')],
]) {
  if (!existsSync(path)) {
    console.log(`skip: ${runtime} — ${path} does not exist on this machine`);
    continue;
  }
  // The same wall, one line later. `existsSync` said the file is there; opening
  // it from a sealed seat still answers EPERM, and a bare read here took the
  // sensor down exactly as it did on the secrets file above.
  const blob = readHome(path, `the ${runtime} config this sensor compares against`);
  if (blob === null) continue;
  const missing = owed(runtime).filter((id) => !blob.includes(`"${id}"`));
  check(
    missing.length === 0,
    `${runtime} — FILE READ of ${path} (this runtime has no listing command, so this is our copy ` +
      `and not its answer)` + (missing.length ? `; MISSING: ${missing.join(', ')}` : ''),
  );
}

for (const label of skipped) console.log(`skip: ${label}`);
if (unjudged.size) {
  console.log(
    `skip: ${[...unjudged].sort().join(', ')} — secret-gated, and the secrets file could not be read from here; ` +
      'these servers were NOT judged in either direction',
  );
}
for (const label of ok) console.log(`ok: ${label}`);
if (failures.length) {
  console.error('');
  for (const label of failures) console.error(`FAIL: ${label}`);
  process.exit(1);
}
console.log(`\nmcp-delivery: ${ok.length} checks green`);
