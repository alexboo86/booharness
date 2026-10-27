#!/usr/bin/env node
// Runtime-home MCP entries share this gate with the plugin's explicit-server
// filter. This trims schemas; a worker with a shell is NOT sandboxed by it.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSecrets, resolveSecretEnv, secretBindings } from './secret-bindings.mjs';

export const MCP_BY_ROLE = JSON.parse(readFileSync(
  new URL('../orchestrator/mcp-by-role.json', import.meta.url), 'utf8',
));

const MCP_SERVERS = JSON.parse(readFileSync(new URL('./mcp-servers.json', import.meta.url), 'utf8'));

export function isAllowed(server, role) {
  // Unset (or empty, the adapter's interpolation of an unset var) marks a lead
  // session or a non-seat process: only orch's seat spawn sets SEAT_POLICY_ROLE,
  // so a process without it keeps its servers.
  if (!role) return true;
  // A seat role the map does not name gets no server: a new role without a row
  // must not silently inherit every server. Add its row to mcp-by-role.json.
  return Object.hasOwn(MCP_BY_ROLE, role) && MCP_BY_ROLE[role].includes(server);
}

function cmdArgument(value) {
  // Quote for the child's argv, then escape both cmd parsing passes (.cmd's
  // %* expands through another pass). No user argument becomes shell syntax.
  const quoted = '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  return quoted.replace(meta, '^$1').replace(meta, '^$1');
}

export function serverInvocation(command, args, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return { command, args, options: {} };
  let resolved = command;
  // npm puts a POSIX script beside its .cmd shim. Windows cannot exec either
  // with spawn(command, args) directly; pick the shim explicitly.
  const dirs = path.isAbsolute(command) ? [''] : (env.PATH || env.Path || '').split(';');
  for (const dir of dirs) {
    const base = dir ? path.join(dir, command) : command;
    const candidate = path.extname(base) ? [base] : [`${base}.exe`, `${base}.cmd`, `${base}.bat`];
    const found = candidate.find(existsSync);
    if (found) { resolved = found; break; }
  }
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args, options: {} };
  if ([resolved, ...args].some((value) => /[\r\n\0]/.test(value))) {
    throw new Error('MCP command arguments cannot contain NUL or line breaks in a Windows shim');
  }
  const comspec = env.ComSpec || env.COMSPEC;
  if (!comspec) throw new Error('ComSpec is required to run a Windows MCP shim');
  const escapedCommand = path.normalize(resolved).replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
  return {
    command: comspec,
    args: ['/d', '/s', '/v:off', '/c', `"${escapedCommand} ${args.map(cmdArgument).join(' ')}"`],
    options: { windowsVerbatimArguments: true },
  };
}

export function emptyServer(input = process.stdin, output = process.stdout) {
  const send = (id, payload) => output.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
  let pending = '';
  input.setEncoding('utf8');
  const handle = (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch { send(null, { error: { code: -32700, message: 'Parse error' } }); return; }
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      send(null, { error: { code: -32600, message: 'Invalid Request' } }); return;
    }
    if (!Object.hasOwn(message, 'id')) return; // notifications have no response
    const id = message.id;
    if (typeof id !== 'string' && typeof id !== 'number' && id !== null) {
      send(null, { error: { code: -32600, message: 'Invalid Request' } }); return;
    }
    switch (message.method) {
      case 'initialize':
        send(id, { result: {
          protocolVersion: typeof message.params?.protocolVersion === 'string'
            ? message.params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-role-gate', version: '1.0.0' },
        } });
        break;
      case 'tools/list': send(id, { result: { tools: [] } }); break;
      case 'ping': send(id, { result: {} }); break;
      default: send(id, { error: { code: -32601, message: 'Method not found' } });
    }
  };
  input.on('data', (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      if (end > 1024 * 1024) break;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim()) handle(line);
    }
    if (pending.length > 1024 * 1024) {
      process.stderr.write('mcp-role-gate: request exceeds 1 MiB\n');
      process.exitCode = 1;
      input.destroy();
    }
  });
  input.on('end', () => { if (pending.trim()) handle(pending); });
}

// A server whose registry spec binds secrets resolves each target variable
// from the gate's own environment first (a local config whose installer baked
// the value in keeps it), then from the host's ~/.claude/<prefix>-secrets.env
// (a remote seat, whose config carries no env). Values are set for the child
// only: the seat's .mcp.json, the child's argv and every log line never carry
// them. A variable neither source has closes the server (empty tools).
function secretEnv(server) {
  const spec = MCP_SERVERS.servers?.[server];
  const bindings = secretBindings(spec);
  if (bindings.length === 0) return {};
  const prefix = JSON.parse(readFileSync(new URL('./harness.config.json', import.meta.url), 'utf8')).names?.prefix;
  const file = path.join(homedir(), '.claude', `${prefix}-secrets.env`);
  const secrets = loadSecrets(file);
  const envName = new Map(bindings.map((binding) => [binding.secret, binding.env]));
  const valueFor = (secret) => process.env[envName.get(secret)] || secrets[secret];
  const env = resolveSecretEnv(spec, valueFor);
  if (env === null) {
    const missing = bindings.find(({ secret, optional }) => !optional && !valueFor(secret));
    process.stderr.write(`mcp-role-gate: ${server} needs ${missing.secret} from ${file}\n`);
    return null;
  }
  return env;
}

export function main(argv = process.argv.slice(2)) {
  const [server, separator, command, ...args] = argv;
  if (!server || separator !== '--' || !command) {
    process.stderr.write('Usage: mcp-role-gate.mjs <server-id> -- <command> [args...]\n');
    process.exitCode = 2;
    return;
  }
  if (!isAllowed(server, process.env.SEAT_POLICY_ROLE)) { emptyServer(); return; }
  const secrets = secretEnv(server);
  if (!secrets) { emptyServer(); return; }
  let invocation;
  try { invocation = serverInvocation(command, args); }
  catch {
    process.stderr.write('mcp-role-gate: cannot prepare server command\n');
    process.exitCode = 1;
    return;
  }
  const child = spawn(invocation.command, invocation.args, {
    ...invocation.options, stdio: 'inherit', env: { ...process.env, ...secrets }, shell: false, windowsHide: true,
  });
  const signals = ['SIGINT', 'SIGTERM'];
  const forward = (signal) => child.kill(signal);
  const handlers = signals.map((signal) => {
    const handler = () => forward(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  child.on('error', () => {
    // argv/env may contain credentials; never include them in diagnostics.
    process.stderr.write('mcp-role-gate: cannot start server\n');
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    for (const [name, handler] of handlers) process.off(name, handler);
    process.exitCode = code !== null && code >= 0 ? code : (signal ? 128 + (constants.signals[signal] || 1) : 1);
  });
}

// Self-contained (node: builtins plus ./secret-bindings.mjs): the fixture
// (scripts/lib/install-macos-fixture.mjs) copies both standalone into a
// fixture repo where scripts/lib is absent.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) main();
