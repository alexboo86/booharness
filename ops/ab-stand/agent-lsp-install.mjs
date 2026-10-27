// Stand-only MCP pins. Never install the unrelated bare npm name agent-lsp.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const AGENT_LSP_PINS = JSON.parse(readFileSync(new URL('./agent-lsp.json', import.meta.url), 'utf8'));
export const AGENT_LSP_PACKAGE = `${AGENT_LSP_PINS.package}@${AGENT_LSP_PINS.version}`;
export const AGENT_LSP_PACKAGES = [AGENT_LSP_PINS, ...AGENT_LSP_PINS.dependencies];
export const AGENT_LSP_INTEGRITIES = Object.fromEntries(AGENT_LSP_PACKAGES.map((pin) => [pin.package, pin.integrity]));

export function agentLspServer(dir) {
  const bin = path.join(dir, 'npm', 'node_modules', '.bin');
  return {
    // Run the verified native binary directly so teardown signals it rather
    // than the npm wrapper's execFileSync parent.
    command: path.join(dir, 'npm', 'node_modules', AGENT_LSP_PINS.dependencies[0].package, 'bin', 'agent-lsp'),
    args: [`typescript:${path.join(bin, 'typescript-language-server')},--stdio`],
    inheritEnv: false, lifecycle: 'lazy', requestTimeoutMs: 90_000,
    // Code intelligence only; no disk-edit, shell/build/test or workflow tools.
    includeTools: ['start_lsp', 'open_document', 'list_symbols', 'find_symbol', 'find_references', 'go_to_definition', 'blast_radius', 'explore_symbol', 'find_callers', 'get_diagnostics'],
    env: {
      SEAT_POLICY_ROLE: '${SEAT_POLICY_ROLE}',
      HOME: path.join(dir, 'home'), XDG_CACHE_HOME: path.join(dir, 'cache'),
      XDG_CONFIG_HOME: path.join(dir, 'home', '.config'),
      XDG_STATE_HOME: path.join(dir, 'home', '.local', 'state'),
      TMPDIR: path.join(dir, 'cache', 'tmp'),
      PATH: [bin, path.dirname(process.execPath), '${PATH}'].join(path.delimiter),
      AGENT_LSP_OUTPUT_FORMAT: 'json',
    },
  };
}
