// scout_request's shape and limits (decision #11990), with no runtime imports:
// the Pi extension and the claude adapter load it without the daemon's store.
export const SCOUT_CALLERS: readonly string[] = ['coder', 'bughunter', 'reviewer'];
export const MAX_QUESTION_WORDS = 200;
export const MAX_FILES = 20;
/** The name a seat's MCP config gives orch's seat endpoint: never `orch`, which stays denied (providers/claude.ts). */
export const SEAT_MCP_SERVER = 'scout';
export const SEAT_MCP_PATH = '/seat-mcp';
export const SEAT_SCOUT_PATH = '/seat/scout_request';

export const SCOUT_TOOL = {
  name: 'scout_request',
  description: `Call this BEFORE your own read/grep when answering needs a sweep of 3+ files, logs or memory: send one question, get a cheap scout's answer. One at a time per seat; the question is English, at most ${MAX_QUESTION_WORDS} words, and names what to report back. Ask for facts (where, what, how it is wired), never for a design or whether a plan is enough: you decide that.`,
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: `The one question, at most ${MAX_QUESTION_WORDS} words.` },
      files: { type: 'array', items: { type: 'string' }, description: 'Optional repo-relative files the question is about.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
} as const;

export type SeatTool = { url: string; token: string };

/** A Pi seat reaches the endpoint through its extension (pi-extension.ts), which reads these. */
export function seatToolEnv(tool: SeatTool): Record<string, string> {
  return { ORCH_SEAT_TOOL_URL: `${tool.url}${SEAT_SCOUT_PATH}`, ORCH_SEAT_TOKEN: tool.token };
}
