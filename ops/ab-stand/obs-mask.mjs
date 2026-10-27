// Observation-masking Pi extension for the A/B stand (task 1716a).
//
// arXiv 2508.21433 ("The Complexity Trap") masks environment observations
// older than the newest M turns and keeps the task prompt, the reasoning and
// the actions. The released code (the-complexity-trap,
// sweagent/agent/history_processors.py LastNObservations) also keeps the first
// observation, writes "Old environment output: (X lines omitted)" in place of
// the output, and advances the mask in batches: every provider we use breaks
// its cached prefix at the first rewritten message, so the masked frontier
// moves at most once per K observation-bearing turns.
//
// Pi's `context` event hands the extension a structuredClone of the messages
// of the next LLM request (dist/core/extensions/runner.js emitContext), so the
// session file on disk never sees the rewrite. Only the content of
// `toolResult` messages changes; user, assistant (with its tool calls), system
// and custom messages pass through as the same objects.
//
// Loaded with `pi -e ops/ab-stand/obs-mask.mjs`; wiring it as a stand arm is
// the next slice.

/** Newest observation-bearing turns kept verbatim (SWE-agent M=10). */
export const KEEP_NEWEST = 10;
/** The masked frontier advances in steps of this many observation-bearing turns. */
export const MASK_BATCH = 5;

const STUB = /^Old environment output: \(\d+ lines omitted\)$/;

export function stubText(lines) {
  return `Old environment output: (${lines} lines omitted)`;
}

/** Python str.splitlines() count: "" is 0 lines and a trailing newline adds none. */
export function lineCount(text) {
  if (text === '') return 0;
  const lines = text.split(/\r\n|\r|\n/);
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function isStub(message) {
  return message.content.length === 1 && message.content[0].type === 'text' && STUB.test(message.content[0].text);
}

/**
 * One observation-bearing turn per assistant message whose tool calls have
 * results here; a result whose call is not found forms its own turn.
 * Returns the turns in order, each a list of message indexes.
 */
export function observationTurns(messages) {
  const callOwner = new Map();
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
    for (const part of message.content) if (part.type === 'toolCall') callOwner.set(part.id, index);
  });
  const turns = new Map();
  messages.forEach((message, index) => {
    if (message.role !== 'toolResult') return;
    const owner = callOwner.get(message.toolCallId) ?? `result:${index}`;
    if (!turns.has(owner)) turns.set(owner, []);
    turns.get(owner).push(index);
  });
  return [...turns.values()];
}

/** How many turns after the first one are masked: a whole number of batches that leaves the newest `keep` verbatim. */
export function maskedTurnCount(turnCount, keep = KEEP_NEWEST, batch = MASK_BATCH) {
  const eligible = Math.max(0, turnCount - keep - 1);
  return Math.floor(eligible / batch) * batch;
}

/**
 * Returns a new message list in which the tool results of the masked turns
 * carry the stub. `remembered` holds the toolCallIds a session already masked:
 * each of them stays masked wherever it appears again, and every id masked now
 * is added to it, so on a shorter or re-sent branch the frontier never moves
 * back and the cached prefix keeps its stubs. With a fresh set the result
 * depends on the messages alone. The input messages are not mutated;
 * untouched messages are returned as the same objects.
 */
export function maskObservations(messages, remembered = new Set(), keep = KEEP_NEWEST, batch = MASK_BATCH) {
  const turns = observationTurns(messages);
  const masked = maskedTurnCount(turns.length, keep, batch);
  const targets = new Set(turns.slice(1, 1 + masked).flat());
  messages.forEach((message, index) => {
    if (message.role === 'toolResult' && remembered.has(message.toolCallId)) targets.add(index);
  });
  if (targets.size === 0) return messages;
  return messages.map((message, index) => {
    if (!targets.has(index)) return message;
    remembered.add(message.toolCallId);
    if (isStub(message)) return message;
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    return { ...message, content: [{ type: 'text', text: stubText(lineCount(text)) }] };
  });
}

/**
 * The extension keeps one remembered set per Pi session id
 * (ctx.sessionManager.getSessionId(), dist/core/extensions/types.d.ts:220) in
 * this process. A restart starts fresh and recomputes from the messages, which
 * is deterministic. A context without a session manager gets no memory: each
 * request is masked from its own messages alone, and a shorter branch there
 * can unmask a result.
 */
export default function obsMask(pi) {
  const sessions = new Map();
  pi.on('context', (event, ctx) => {
    const id = ctx?.sessionManager?.getSessionId?.();
    let remembered;
    if (id === undefined) remembered = new Set();
    else {
      if (!sessions.has(id)) sessions.set(id, new Set());
      remembered = sessions.get(id);
    }
    const messages = maskObservations(event.messages, remembered);
    return messages === event.messages ? undefined : { messages };
  });
}
