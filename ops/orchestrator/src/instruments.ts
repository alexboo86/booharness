// A seat's switchable instruments (task 1452; operator decisions #10646/#10648):
// the A/B stand compares code-intel arms, so seat_create takes an optional
// `instruments` override that turns a named instrument off for that one seat.
// RTK is an axiom (#10646): always on, never an arm, so it is not listed here.
//
// One name covers every surface of an instrument:
//   codegraph — the MCP tool (Pi direct `codegraph_explore`, mcp__codegraph_*)
//               and the `codegraph` CLI;
//   ast-grep  — the `ast-grep`/`sg` CLI (it has no MCP surface);
//   memory    — the memory tool (Pi direct `memoryctl_memory`, mcp__memoryctl_*)
//               and the `memoryctl` CLI.
// The override is validated once at seat_create and stored as the EFFECTIVE map
// in the seat's data; every later reader (session spec, context, leanSeat)
// derives from that, so a default seat and a legacy seat behave exactly alike.
//
// Enforcement is where the harness allows it: Pi blocks through the orch
// extension (pi-extension.ts reads ORCH_SEAT_INSTRUMENTS_OFF) and the read-only
// --tools list; native claude denies the server's tools and codex disables the
// server; ACP natives never got MCP servers. A native seat's SHELL has no
// per-seat program gate, so there the CLI half is context-only: context.ts
// stops advertising it. This is an experiment arm, not a sandbox — a determined
// seat with a full shell can evade a program ban, and the run row records what
// was effective, not what was impossible to reach.
//
// Pure data and string logic: seats.ts, the providers, the Pi extension (via
// jiti) and the tests import it; keep it free of node imports.

export const INSTRUMENT_KEYS = ['codegraph', 'ast-grep', 'memory'] as const;
export type InstrumentKey = (typeof INSTRUMENT_KEYS)[number];
export type Instruments = Record<InstrumentKey, boolean>;

/** No override: every instrument on. */
export const ALL_ON: Instruments = { codegraph: true, 'ast-grep': true, memory: true };

/** Pi direct-tool names each instrument surfaces (pi-mcp-adapter `directTools`). */
export const PI_DIRECT_TOOLS: Record<InstrumentKey, readonly string[]> = {
  codegraph: ['codegraph_explore'],
  'ast-grep': [],
  memory: ['memoryctl_memory'],
};

/** MCP server ids each instrument surfaces (claude mcp__<id>__*, codex mcp_servers.<id>). */
export const MCP_SERVERS: Record<InstrumentKey, readonly string[]> = {
  codegraph: ['codegraph'],
  'ast-grep': [],
  memory: ['memoryctl'],
};

/** Shell program names each instrument surfaces (a Pi seat's bash is filtered by these). */
export const CLI_PROGRAMS: Record<InstrumentKey, readonly string[]> = {
  codegraph: ['codegraph'],
  'ast-grep': ['ast-grep', 'sg'],
  memory: ['memoryctl'],
};

/** The Pi/MCP tool names whose calls are proxied by server name (the adapter's `mcp` gateway and `mcpScript`). */
export const MCP_PROXY_TOOLS = new Set(['mcp', 'mcpscript', 'mcp_script']);

/**
 * The effective map for a seat_create override: every key present, default on.
 * Unknown keys, non-objects and non-boolean values are refused — a mistyped arm
 * must fail at creation, not silently run with everything on.
 */
export function effectiveInstruments(override: unknown): Instruments {
  const effective: Instruments = { ...ALL_ON };
  if (override === undefined || override === null) return effective;
  if (typeof override !== 'object' || Array.isArray(override)) {
    throw new Error(`instruments must be an object naming some of ${INSTRUMENT_KEYS.join(', ')} with boolean values`);
  }
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (!(INSTRUMENT_KEYS as readonly string[]).includes(key)) {
      throw new Error(`instruments: unknown instrument '${key}'; known: ${INSTRUMENT_KEYS.join(', ')}`);
    }
    if (typeof value !== 'boolean') throw new Error(`instruments.${key} must be true or false`);
    effective[key as InstrumentKey] = value;
  }
  return effective;
}

/** The effective map stored with a seat (legacy seats predate the field: all on). */
export function seatInstruments(data: Record<string, unknown>): Instruments {
  const stored = data.instruments;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { ...ALL_ON };
  const effective = { ...ALL_ON };
  for (const key of INSTRUMENT_KEYS) {
    if ((stored as Record<string, unknown>)[key] === false) effective[key] = false;
  }
  return effective;
}

/** The instruments off for a seat, in canonical order. */
export function instrumentsOff(map: Instruments): InstrumentKey[] {
  return INSTRUMENT_KEYS.filter((key) => map[key] === false);
}

/** `ORCH_SEAT_INSTRUMENTS_OFF` value for a seat process; '' means nothing off. */
export function offEnv(off: readonly InstrumentKey[]): string {
  return off.join(',');
}

/** What an env value turns off; unknown entries are ignored (an old extension against a newer orch). */
export function parseOffEnv(value: string | undefined): InstrumentKey[] {
  return (value ?? '').split(',').filter((key): key is InstrumentKey => (INSTRUMENT_KEYS as readonly string[]).includes(key));
}

function flat(surfaces: Record<InstrumentKey, readonly string[]>, off: readonly InstrumentKey[]): Set<string> {
  const out = new Set<string>();
  for (const key of off) for (const name of surfaces[key]) out.add(name);
  return out;
}

export type InstrumentBan = {
  /** Pi direct tools to refuse (codegraph_explore, memoryctl_memory). */
  tools: Set<string>;
  /** MCP server ids whose mention in an mcp/mcpScript call refuses it. */
  servers: Set<string>;
  /** Shell programs whose invocation in bash refuses the command. */
  programs: Set<string>;
};

/** Everything a Pi seat must be refused when `off` instruments are off. */
export function instrumentBan(off: readonly InstrumentKey[]): InstrumentBan {
  return { tools: flat(PI_DIRECT_TOOLS, off), servers: flat(MCP_SERVERS, off), programs: flat(CLI_PROGRAMS, off) };
}

/**
 * The server ids one mcp/mcpScript call addresses, by TOKEN, never by payload
 * substring (review 2026-09-23: a serialized-input match refused unrelated calls
 * whose arguments merely mentioned 'codegraph'). Addressing forms: the gateway's
 * `server`/`connect` fields (exact), a `tool`/`tool_name` of `<server>_<tool>`
 * or `<server>__<tool>` (the prefix), and inside mcpScript code a prefixed tool
 * token — `tools.codegraph_explore(...)` or a quoted path `"codegraph_explore"`.
 */
function serverRefs(input: unknown): Set<string> {
  const refs = new Set<string>();
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  for (const key of ['server', 'connect']) {
    if (typeof args[key] === 'string') refs.add(args[key] as string);
  }
  for (const key of ['tool', 'tool_name']) {
    const value = args[key];
    const prefixed = typeof value === 'string' ? /^([a-z0-9-]+?)_{1,2}[A-Za-z0-9_]+$/.exec(value) : null;
    if (prefixed) refs.add(prefixed[1]);
  }
  const code = args.code;
  if (typeof code === 'string') {
    for (const re of [/tools\.([a-z0-9-]+)_[A-Za-z0-9_]+/g, /["']([a-z0-9-]+)_[A-Za-z0-9_]+["']/g]) {
      for (const match of code.matchAll(re)) refs.add(match[1]);
    }
  }
  return refs;
}

/**
 * Why a non-bash tool call is refused under an instrument ban, or null.
 * The adapter's `mcp` gateway and `mcpScript` reach a server through the
 * addressing tokens above; only those tokens refuse the call.
 */
export function refuseTool(toolName: string, input: unknown, ban: InstrumentBan): string | null {
  if (!ban.tools.size && !ban.servers.size) return null;
  const name = toolName.toLowerCase();
  if (ban.tools.has(name)) return `${toolName} is off for this seat`;
  if (MCP_PROXY_TOOLS.has(name) && ban.servers.size) {
    const server = [...serverRefs(input)].find((id) => ban.servers.has(id));
    if (server) return `the ${server} MCP server is off for this seat`;
  }
  return null;
}
