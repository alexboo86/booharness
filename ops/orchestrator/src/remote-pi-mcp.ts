// Remote seats use their checkout's MCP scripts, never the host operator's Pi profile.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { RemoteHost } from './config.ts';

const registry = JSON.parse(readFileSync(new URL('../../bootstrap/mcp-servers.json', import.meta.url), 'utf8'));
const directTools: Record<string, string[]> = { codegraph: ['codegraph_explore'], memoryctl: ['memory'] };

// pi-mcp-adapter hashes the interpolated env into the shared mcp-cache.json
// (task 1918): a '${SEAT_POLICY_ROLE}' entry hashes differently per role and
// the thrashed cache line costs the seat its direct tools for the session.
// Servers every role allows render without the interpolation; the gate itself
// passes an unset role (mcp-role-gate.mjs isAllowed).
const byRole: Record<string, string[]> = JSON.parse(
  readFileSync(new URL('../../orchestrator/mcp-by-role.json', import.meta.url), 'utf8'),
);
const roleLists: string[][] = Object.values(byRole);
const universal = new Set(roleLists[0].filter(id => roleLists.every(list => list.includes(id))));
const remoteBaseServers = ['codegraph', 'memoryctl'];

/** Role-authorized servers omitted by the remote renderer (not a host health check). */
export function remotePiMissingServers(role: string): string[] {
  if (!Object.hasOwn(byRole, role)) return [];
  return byRole[role].filter(id => !remoteBaseServers.includes(id) && id !== 'brightdata-web');
}

export function remotePiMcpPath(host: RemoteHost, checkout: string): string {
  const p = host.platform === 'win32' ? path.win32 : path.posix;
  return p.join(checkout, '.mcp.json'); // ignored by git; explicitly selected, never read from cwd discovery
}

export type RemoteCodegraph = { command: string; args: string[] };

export function remotePiMcpConfig(host: RemoteHost, checkout: string, codegraph: RemoteCodegraph, role?: string): string {
  const p = host.platform === 'win32' ? path.win32 : path.posix;
  // Gate and memoryctl script come from the host runtime checkout (host.repo,
  // as piHostPaths does), never the per-seat checkout: the adapter cache is
  // per machine, so a seat path in args would invalidate every other seat.
  const gate = p.join(host.repo, 'ops', 'bootstrap', 'mcp-role-gate.mjs');
  if (!p.isAbsolute(codegraph.command) || codegraph.args.some(arg => /[\r\n\0]/.test(arg)) ||
      (host.platform === 'win32' && (!/^[a-zA-Z]:[\\/]/.test(codegraph.command) ||
       [codegraph.command, ...codegraph.args].some(arg => /^d:[\\/]terminal[\\/]/i.test(arg))))) {
    throw new Error('remote codegraph must use an absolute host executable, never the operator checkout');
  }
  const servers: Record<string, unknown> = {};
  for (const id of remoteBaseServers) {
    const spec = registry.servers[id];
    if (spec?.transport !== 'stdio' || !spec.required || spec.env_from_secrets || spec.env_static || spec.url ||
        (id === 'memoryctl' && spec.args?.[0] !== '{repo}/scripts/memory/mcp-server.mjs') ||
        (id === 'codegraph' && (spec.command !== 'codegraph' || spec.args?.join(' ') !== 'serve --mcp'))) {
      throw new Error(`remote Pi MCP registry changed for ${id}; review its seat entry`);
    }
    servers[id] = {
      command: 'node',
      args: [gate, id, '--', ...(id === 'codegraph' ? [codegraph.command, ...codegraph.args] : [spec.command]),
        ...spec.args.map((arg: string) => arg.replaceAll('{repo}', host.repo))],
      ...(universal.has(id) ? {} : { env: { SEAT_POLICY_ROLE: '${SEAT_POLICY_ROLE}' } }),
      inheritEnv: false,
      lifecycle: 'lazy',
      directTools: directTools[id],
    };
  }
  // brightdata-web is the one carve-out from the strict validation above: its
  // spec is not `required` and binds a secret, which the host gate supplies
  // from the secrets file. Every other secret or non-required server
  // (the operator's production MCP) stays refused. No SEAT_POLICY_ROLE env and role-independent
  // args: the machine-shared adapter cache keeps one hash (lesson 13221), and
  // the role filter is this render.
  // Own-property check: an inherited name (toString, constructor, __proto__)
  // is an unknown role and renders only the universal servers.
  if (role && Object.hasOwn(byRole, role) && byRole[role].includes('brightdata-web')) {
    const spec = registry.servers['brightdata-web'];
    if (spec?.transport !== 'stdio' || spec.command !== 'node' || spec.url || spec.env_static || spec.bearer_from_secret ||
        spec.args?.join(' ') !== '{repo}/ops/mcp-vendor/node_modules/@brightdata/mcp/server.js' ||
        spec.env_from_secrets?.length !== 1 || spec.env_from_secrets[0].env !== 'API_TOKEN' ||
        spec.env_from_secrets[0].secret !== 'BRIGHTDATA_API_KEY' || spec.env_from_secrets[0].optional) {
      throw new Error('remote Pi MCP registry changed for brightdata-web; review its seat entry');
    }
    servers['brightdata-web'] = {
      command: 'node',
      args: [gate, 'brightdata-web', '--', spec.command,
        ...spec.args.map((arg: string) => arg.replaceAll('{repo}', host.repo))],
      inheritEnv: false,
      lifecycle: 'lazy',
    };
  }
  return `${JSON.stringify({ mcpServers: servers, settings: { hostConfigDiscovery: 'off', jev: false, scriptMode: true } }, null, 2)}\n`;
}
