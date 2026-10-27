// Only lead task text may cross the Jev boundary. No I/O, memory or network here.
const START = '<!-- brief:start -->';
const END = '<!-- brief:end -->';
const REPLACEMENT = '[REDACTED]';
const BUILDER = /<!--\s*(?:paseo|orch)-seat-context\b|^Role \(profile[^\n]*\):/m;
const BUILDER_HEADER = /^<!-- orch-seat-context v2 role=[^\s]+ family=[^\s]+ harness=[^\s]+ files=\d+ lessons=\d+ -->\r?\n/;
const SECTION = /^#{1,6} (?:Memory hot|Knowledge|Lessons|Code intel|Files that matter|Your tools|Your shell|Proving a change in `[^`\r\n]+`)(?:\b|:)/;
const CLOSING = /Final delivery to the lead agent:|Do NOT write to memoryctl|Do NOT commission work from another model/;

/** Marked briefs are byte-preserved. Legacy builder prompts fail closed. */
export function extractTask(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (/<!--\s*brief:/.test(text)) {
    // A literal marker example in a standalone task is not a builder envelope.
    // Refuse ambiguity rather than silently dropping the surrounding request.
    if (!BUILDER_HEADER.test(text)) return '';
    const start = text.indexOf(START);
    const end = text.indexOf(END);
    if (start < 0 || end < start || text.indexOf(START, start + START.length) !== -1
      || text.indexOf(END, end + END.length) !== -1
      || (text.match(/<!--\s*brief:/g) || []).length !== 2) return '';
    return text.slice(start + START.length, end);
  }
  if (BUILDER.test(text)) return '';
  const kept = [];
  let inBuilderSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (CLOSING.test(line)) break;
    if (SECTION.test(line)) { inBuilderSection = true; continue; }
    // Knowledge pages contain their own headings: an arbitrary H1 is NOT proof
    // of a task boundary. Only an explicit task heading ends an unmarked section.
    if (/^#{1,2} (?:Task|Assignment|Brief|Задача)\s*:?\s*$/i.test(line)) inBuilderSection = false;
    if (!inBuilderSection) kept.push(line);
  }
  return kept.join('\n');
}

// Operator contract, 2026-09-21: preserve routing coverage. Only obvious values
// are redacted; words, assignments, CLI flags and encodings never block a task.
// This is not a general credential detector: short/bare passwords and deliberate
// obfuscation are outside this policy. no-task is the only content block.
const RULES = [
  ['pem', /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g],
  ['provider-key', /\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[a-z]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}|apik[_-]?[A-Za-z0-9_-]{12,})/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g],
  // Value shape only: 32+ letters/digits (with common key separators), with at
  // least one letter and digit. Do not infer credentials from a field's name.
  ['exchange-key', /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}={0,2}(?![A-Za-z0-9_-])/g],
  ['url-credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi],
];

function applyRedactions(text) {
  const rules = new Set();
  let state = text;
  for (const [name, pattern] of RULES) {
    state = state.replace(pattern, (match) => {
      rules.add(name);
      // Retain the URL scheme/host/path so routing still has useful context.
      return name === 'url-credentials'
        ? match.slice(0, match.indexOf('://') + 3) + REPLACEMENT + '@'
        : REPLACEMENT;
    });
  }
  return { state, rules: [...rules] };
}

export function redact(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  return applyRedactions(text).state;
}

/** Redaction rule names only, never matches. This is not an admission decision. */
export function scanSecrets(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  return RULES.filter(([, pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  }).map(([name]) => name);
}

export function prepareState(text, { maxChars = 6000 } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new RangeError('maxChars must be a positive integer');
  const task = extractTask(text);
  if (!task.trim()) return { state: '', blocked: true, rules: ['no-task'] };
  // Redact whole values before truncating, so a length limit cannot cut a key
  // into an unrecognizable fragment. A redacted task is still sent.
  const cleaned = applyRedactions(task);
  return { state: cleaned.state.slice(0, maxChars), blocked: false, rules: cleaned.rules };
}
