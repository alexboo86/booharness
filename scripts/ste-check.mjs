#!/usr/bin/env node
// Deterministic ASD-STE100 checker: word half (slice 1a), sentence half
// (slice 1b, task 2164) and corpus mode over many texts (slice 1c).
//
// No dependency, no network, no model: the same text always yields the same
// report. Exports check(text, options) for reuse. The word half judges every
// token (judgeToken over the output of maskSpans); the sentence half walks the
// same masked text a second time (analyzeProse) for sentence length, passive
// voice, noun clusters and paragraph length. The two halves share the masking,
// the dictionary lookup and the curated technical-name list.
//
// Never judged: fenced blocks, backtick spans, quoted spans, Cyrillic text,
// URLs, paths (and file names), identifiers, numbers with units (and plain
// numbers, dates, versions), ids (#1234), technical names (patterns and the
// word lists in ops/orchestrator/ste/technical-names.json).
//
// Reported: rejected words with their approved alternatives, unknown words,
// violations per 100 words, the share of words passed as technical names, and
// the sentence-rule totals. The report names what it cannot check: that a word
// is used only in its one approved STE meaning, and the sentence heuristics.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Mirrors stateDirFor()/loadConfig() in ops/orchestrator/src/config.ts. */
function orchStateDir() {
  return process.env.ORCH_STATE_DIR
    ? path.resolve(process.env.ORCH_STATE_DIR)
    : path.join(os.homedir(), '.local', 'state', 'orch');
}

export const DEFAULT_DICTIONARY = path.join(orchStateDir(), 'ste', 'dictionary.json');
export const DEFAULT_TECHNICAL_NAMES = fileURLToPath(
  new URL('../ops/orchestrator/ste/technical-names.json', import.meta.url),
);

export const LIMITATIONS = [
  'one approved meaning per word is not checked: a word approved in one part of speech and rejected in another (71 such words) is never flagged',
  'multi-word dictionary entries (for example AFT OF) are not matched; only single tokens are looked up',
  'single-quoted spans are not masked (apostrophes would make that ambiguous); double-quoted spans are',
  'sentence segmentation is heuristic: an abbreviation with an internal period (for example e.g.) splits one sentence into two',
  'passive voice is a pattern (a form of BE before a past participle) reported as maybe; it cannot tell a passive from a predicate adjective',
  'noun clusters use dictionary parts of speech; a technical name counts as a noun and an unknown or exempt word breaks a cluster',
  'a markdown list or heading block counts as one paragraph and each item as one sentence, so a list of more than six items is reported',
  'numbers written as words (one, two, three, ...) are judged as ordinary words against the dictionary; they are not mapped to digits and not exempted',
  "contractions and possessives (don't, it's) are never judged; they are not split into their parts",
];

const CYRILLIC = /[\u0400-\u04FF]/;
const URL_RE = /^(https?:\/\/|www\.)\S*$/i;
const ID_RE = /^#[\w.-]+$/;
const NUMBER_RE = /^#?\d+([.,]\d+)*(px|ms|us|ns|s|m|h|kb|mb|gb|tb|%|°c?|k|x)?$/i;
const DATE_OR_VERSION_RE = /^v?\d+(\.\d+)+(-[\w.]+)*$|^\d{4}-\d{2}-\d{2}$/;
const IDENTIFIER_RE = /_|[a-z][A-Z]|\p{L}.*\d|\d.*\p{L}/u;
const FILE_EXT_RE =
 /\.(ts|tsx|js|mjs|cjs|cts|mts|json|jsonl|md|mdx|rs|toml|ya?ml|sql|css|scss|html?|sh|bash|zsh|py|lock|txt|log|db|sqlite3?|png|jpe?g|gif|webp|svg|ico|wasm|plist|service|patch|diff|conf|ini|env|gitignore)$/i;
// Leading dots, tildes and slashes are kept, so .env, ~/x, ../x, ./x and
// /usr/bin stay paths.
const LEADING_PUNCT = /^[^\p{L}\p{N}#.~/]+/u;
const TRAILING_PUNCT = /[^\p{L}\p{N}%_-]+$/u;

// Sentence-half patterns. A placeholder stands in for one inline exempt span so
// that the span counts as exactly one word; it is a control char that never
// occurs in prose and never survives token cleaning, so it is handled first.
const EXEMPT_WORD = '\u0000';
const SENTENCE_TERMINATOR_RE = /[.!?]["')\]]*$/;
const LIST_OR_HEADING = /^\s*(?:[-*+>]|\d+[.)]|#{1,6})\s/;

// Forms of BE that a passive-voice pattern recognises (surface forms, judged
// independently of the dictionary so an absent form still triggers the rule).
const BE_FORMS = new Set(['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being']);

// Irregular past participles that do not end in -ed; a regular participle is
// any word ending in "ed" longer than three chars (see isPastParticiple).
const IRREGULAR_PARTICIPLES = new Set([
  'been', 'done', 'gone', 'seen', 'taken', 'given', 'made', 'found', 'known',
  'shown', 'written', 'driven', 'broken', 'chosen', 'spoken', 'stolen',
  'forgotten', 'hidden', 'risen', 'taught', 'thought', 'told', 'sold', 'said',
  'paid', 'laid', 'led', 'read', 'run', 'sung', 'sunk', 'begun', 'drawn',
  'grown', 'thrown', 'blown', 'flown', 'bitten', 'ridden', 'beaten', 'eaten',
  'fallen', 'gotten', 'held', 'kept', 'left', 'lost', 'meant', 'met', 'put',
  'set', 'shut', 'spread', 'stood', 'understood', 'won', 'bound', 'wound',
  'spun', 'stuck', 'struck', 'swept', 'slept', 'felt', 'dealt', 'built',
  'bought', 'brought', 'caught', 'sought', 'shone', 'worn', 'torn', 'borne',
  'frozen', 'sent', 'born', 'drunk', 'swum', 'rung', 'hung', 'dug', 'sat',
]);

// Irregular forms mapped to their dictionary base word. The exact word is always
// tried first (see dictionaryCandidates), so this table only fires for a form
// the dictionary does not carry (for example "are", "were", "been", "gone").
const IRREGULAR_FORMS = {
  // BE, HAVE, DO
  am: 'be', is: 'be', are: 'be', was: 'be', were: 'be', been: 'be', being: 'be',
  has: 'have', had: 'have', having: 'have',
  does: 'do', did: 'do', done: 'do', doing: 'do',
  // irregular verb forms (past and past participle) to the base
  went: 'go', gone: 'go', made: 'make', saw: 'see', seen: 'see',
  took: 'take', taken: 'take', gave: 'give', given: 'give', found: 'find',
  told: 'tell', thought: 'think', said: 'say', knew: 'know', known: 'know',
  got: 'get', gotten: 'get', came: 'come', wrote: 'write', written: 'write',
  ran: 'run', broke: 'break', broken: 'break', held: 'hold', kept: 'keep',
  led: 'lead', drove: 'drive', driven: 'drive',
  left: 'leave', lost: 'lose', paid: 'pay', sent: 'send', built: 'build',
  bought: 'buy', brought: 'bring', caught: 'catch', taught: 'teach',
  fought: 'fight', sought: 'seek', sold: 'sell', stood: 'stand',
  understood: 'understand', won: 'win', drew: 'draw', drawn: 'draw',
  grew: 'grow', grown: 'grow', threw: 'throw', thrown: 'throw',
  blew: 'blow', blown: 'blow', flew: 'fly', flown: 'fly',
  lain: 'lie', laid: 'lay', rose: 'rise', risen: 'rise',
  chose: 'choose', chosen: 'choose', spoke: 'speak', spoken: 'speak',
  stole: 'steal', stolen: 'steal', hid: 'hide', hidden: 'hide',
  bit: 'bite', bitten: 'bite', beaten: 'beat',
  ate: 'eat', eaten: 'eat', fell: 'fall', fallen: 'fall',
  met: 'meet', dealt: 'deal', meant: 'mean', slept: 'sleep', felt: 'feel',
  bound: 'bind', wound: 'wind', spun: 'spin', stuck: 'stick',
  struck: 'strike', swept: 'sweep', shone: 'shine', wore: 'wear', worn: 'wear',
  tore: 'tear', torn: 'tear', bore: 'bear', borne: 'bear',
  froze: 'freeze', frozen: 'freeze', began: 'begin', begun: 'begin',
  drank: 'drink', drunk: 'drink', sang: 'sing', sung: 'sing',
  sank: 'sink', sunk: 'sink', swam: 'swim', swum: 'swim',
  rang: 'ring', rung: 'ring', hung: 'hang', dug: 'dig', sat: 'sit',
  // irregular plurals to the singular
  men: 'man', women: 'woman', children: 'child', feet: 'foot', teeth: 'tooth',
  mice: 'mouse', geese: 'goose', oxen: 'ox', phenomena: 'phenomenon',
  criteria: 'criterion', analyses: 'analysis', indices: 'index',
  appendices: 'appendix', matrices: 'matrix', vertices: 'vertex',
  // irregular comparatives and superlatives to the base
  better: 'good', best: 'good', worse: 'bad', worst: 'bad',
  more: 'much', most: 'much',
};

/**
 * Inflection: plain suffix rules, tried in order, first dictionary hit wins.
 * "tests" -> "test", "goes" -> "go", "supplies" -> "supply", "loved" -> "love",
 * "installed" -> "install", "making" -> "make", "stopped" -> "stop" (un-doubling),
 * "faster" -> "fast", "bigger" -> "big", "happiest" -> "happy". An irregular form
 * (are -> be, went -> go, men -> man, better -> good) maps to its base last, so a
 * regular reading of the same string wins first.
 */
function dictionaryCandidates(word) {
  const out = [word];
  const push = (w) => out.push(w);
  // The longer -s base is tried before the shorter -es base, so "notes" is
  // judged as "note", not as "not", and "pastes" as "paste", not "past".
  if (word.endsWith('ies')) push(word.slice(0, -3) + 'y');
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) push(word.slice(0, -1));
  if (word.endsWith('es')) push(word.slice(0, -2));
  if (word.endsWith('ed')) { push(word.slice(0, -1)); push(word.slice(0, -2)); }
  if (word.endsWith('ing')) { push(word.slice(0, -3) + 'e'); push(word.slice(0, -3)); }
  if (word.endsWith('iest')) push(word.slice(0, -4) + 'y');
  if (word.endsWith('est')) push(word.slice(0, -3));
  if (word.endsWith('ier')) push(word.slice(0, -3) + 'y');
  if (word.endsWith('er')) push(word.slice(0, -2));
  for (const candidate of [...out]) {
    if (candidate.length > 3 && /([a-z])\1$/.test(candidate)) push(candidate.slice(0, -1));
  }
  const irregular = IRREGULAR_FORMS[word];
  if (irregular) push(irregular);
  return [...new Set(out)];
}

/**
 * A listed technical name matches only its exact, -s, -es, -ed, -ing and
 * -ies forms, plus the shared irregular forms table: "lands" and "landing"
 * match a listed "land", "memories" matches a listed "memory" and "led"
 * matches a listed "lead", but "leader" is not a form of "lead" and is
 * judged against the dictionary instead.
 */
function technicalNameCandidates(word) {
  const out = new Set([word]);
  if (word.endsWith('ies')) out.add(word.slice(0, -3) + 'y');
  if (word.endsWith('es')) out.add(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) out.add(word.slice(0, -1));
  if (word.endsWith('ed')) { out.add(word.slice(0, -1)); out.add(word.slice(0, -2)); }
  if (word.endsWith('ied')) out.add(word.slice(0, -3) + 'y');
  if (word.endsWith('ing')) { out.add(word.slice(0, -3)); out.add(word.slice(0, -3) + 'e'); }
  if (word.endsWith('ying')) out.add(word.slice(0, -3) + 'y');
  const irregular = IRREGULAR_FORMS[word];
  if (irregular) out.add(irregular);
  for (const candidate of [...out]) {
    if (candidate.length > 3 && /([a-z])\1$/.test(candidate)) out.add(candidate.slice(0, -1));
  }
  return [...out];
}

function lookupWord(word, dictionary) {
  const irregularBase = IRREGULAR_FORMS[word];
  for (const candidate of dictionaryCandidates(word)) {
    const viaIrregular = Boolean(irregularBase) && candidate === irregularBase && candidate !== word;
    const approved = dictionary.approved[candidate];
    if (approved) return { status: 'approved', word: candidate, pos: approved.pos, viaIrregular };
    const rejected = dictionary.rejected[candidate];
    if (rejected) return { status: 'rejected', word: candidate, pos: rejected.pos, alternatives: rejected.alternatives, viaIrregular };
  }
  return null;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Names a bad in-memory input honestly instead of printing a path that was not used. */
function inputName(input, fallback) {
  return typeof input === 'string' ? input : input ? '(passed-in object)' : fallback;
}

function loadJson(input, what) {
  if (input && typeof input === 'object') return input;
  const file = input || what.default;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`cannot read ${input ? '' : 'default '}${what.name} ${file}: ${what.hint}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${input ? '' : 'default '}${what.name} ${file}: ${error.message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`bad ${input ? '' : 'default '}${what.name} ${file}: expected one JSON object`);
  }
  return parsed;
}

const DICTIONARY_INPUT = {
  default: DEFAULT_DICTIONARY,
  name: 'STE dictionary',
  hint: 'build it first: node scripts/ste-build-dictionary.mjs',
};

const TECHNICAL_NAMES_INPUT = {
  default: DEFAULT_TECHNICAL_NAMES,
  name: 'technical names',
  hint: 'expected at ops/orchestrator/ste/technical-names.json in the repository',
};

const validatedDictionaries = new WeakSet();

/** Loads the dictionary and rejects a wrong shape or entry up front, naming the file. */
function loadDictionary(input) {
  const raw = loadJson(input, DICTIONARY_INPUT);
  if (validatedDictionaries.has(raw)) return raw;
  const where = inputName(input, DEFAULT_DICTIONARY);
  if (!isPlainObject(raw.approved) || !isPlainObject(raw.rejected)) {
    throw new Error(`bad STE dictionary ${where}: 'approved' and 'rejected' must be objects`);
  }
  for (const section of ['approved', 'rejected']) {
    for (const [key, entry] of Object.entries(raw[section])) {
      if (!isPlainObject(entry) || !Array.isArray(entry.pos) || !Array.isArray(entry.alternatives)) {
        throw new Error(`bad STE dictionary ${where}: entry '${key}' in '${section}' must be an object with 'pos' and 'alternatives' arrays`);
      }
    }
  }
  validatedDictionaries.add(raw);
  return raw;
}

const validatedTechnicalNames = new WeakSet();

function assertTechnicalNamesShape(raw, input) {
  if (validatedTechnicalNames.has(raw)) return;
  const where = inputName(input, DEFAULT_TECHNICAL_NAMES);
  if (!Array.isArray(raw.nouns) || !Array.isArray(raw.verbs)) {
    throw new Error(`bad technical names ${where}: 'nouns' and 'verbs' must be arrays`);
  }
  if (!Array.isArray(raw.patterns)) {
    throw new Error(`bad technical names ${where}: 'patterns' must be an array`);
  }
  for (const key of ['nouns', 'verbs']) {
    raw[key].forEach((word, index) => {
      if (typeof word !== 'string' || !word.trim()) {
        throw new Error(`bad technical names ${where}: ${key}[${index}] must be a non-empty string, got ${JSON.stringify(word)}`);
      }
    });
  }
  (raw.patterns || []).forEach((source, index) => {
    if (typeof source !== 'string') {
      throw new Error(`bad technical names ${where}: patterns[${index}] must be a string, got ${JSON.stringify(source)}`);
    }
    try {
      new RegExp(source, 'u');
    } catch (error) {
      throw new Error(`bad technical names ${where}: patterns[${index}] ${JSON.stringify(source)} is not a valid regular expression: ${error.message}`);
    }
  });
  validatedTechnicalNames.add(raw);
}

function loadTechnicalNames(input) {
  const raw = loadJson(input, TECHNICAL_NAMES_INPUT);
  assertTechnicalNamesShape(raw, input);
  const words = new Map();
  for (const key of ['nouns', 'verbs']) {
    for (const word of raw[key] || []) words.set(String(word).toLowerCase(), key);
  }
  const patterns = (raw.patterns || []).map((source) => new RegExp(source, 'u'));
  return { words, patterns };
}

function blank(match) {
  return match.replace(/[^\n]/g, ' ');
}

/** Removes never-judged spans while preserving line numbers; returns text and span counts. */
function maskSpans(text) {
  const counts = { fenced: 0, backtick: 0, quoted: 0 };
  const mask = (re, key) => (current) =>
    current.replace(re, (m) => { counts[key] += 1; return blank(m); });
  const stages = [
    mask(/```[\s\S]*?(```|$)/g, 'fenced'),
    mask(/~~~[\s\S]*?(~~~|$)/g, 'fenced'),
    mask(/(`+)[^\n]*?\1/g, 'backtick'),
    // A quoted span may cross one line break, never a blank line.
    mask(/"(?:[^"\n]|\n(?!\s*\n))*"/g, 'quoted'),
    mask(/\u201c[^\u201d\n]*\u201d/g, 'quoted'),
  ];
  return { counts, text: stages.reduce((t, stage) => stage(t), text) };
}

/**
 * Masks the text for the sentence walk. Fenced blocks are block-level, not
 * prose: they are blanked so they form no sentence. An inline exempt span
 * (backtick or quoted) becomes one placeholder so it counts as exactly one
 * word. Line count is preserved, so reported line numbers match the input.
 */
function maskForSentences(text) {
  let out = text.replace(/```[\s\S]*?(```|$)/g, (m) => blank(m));
  out = out.replace(/~~~[\s\S]*?(~~~|$)/g, (m) => blank(m));
  out = out.replace(/(`+)[^\n]*?\1/g, EXEMPT_WORD);
  out = out.replace(/"(?:[^"\n]|\n(?!\s*\n))*"/g, EXEMPT_WORD);
  out = out.replace(/\u201c[^\u201d\n]*\u201d/g, EXEMPT_WORD);
  return out;
}

/** True when the dictionary or the curated list knows the word (any status). */
function isKnownWord(word, dictionary, technicalNames) {
  const lower = word.toLowerCase();
  if (technicalNameCandidates(lower).some((candidate) => technicalNames.words.has(candidate))) return true;
  return Boolean(lookupWord(lower, dictionary));
}

// A letter, an apostrophe and a letter: contractions and possessives.
const CONTRACTION_RE = /[\p{L}]['’][\p{L}]/u;

function neverJudgedCategory(token, dictionary, technicalNames) {
  if (URL_RE.test(token)) return 'url';
  // Bare dots, slashes or tildes are punctuation or a home marker, not a word.
  if (/^[.~/]+$/.test(token)) return 'path';
  if (token.length > 1 && (token.startsWith('.') || token.startsWith('~') || token.startsWith('/'))) return 'path';
  if (token.includes('/')) {
    const segments = token.split('/');
    const last = segments[segments.length - 1];
    if (segments.some((segment) => segment.startsWith('.') || segment.startsWith('~'))) return 'path';
    if (FILE_EXT_RE.test(last)) return 'path';
    if (segments.length >= 3) return 'path';
    // Two segments without an extension are judged word by word only when the
    // dictionary or the names list knows every segment ("and/or",
    // "utilize/prior"); otherwise the token is a path ("scripts/utilize").
    if (!segments.every((segment) => isKnownWord(segment, dictionary, technicalNames))) return 'path';
  }
  if (FILE_EXT_RE.test(token)) return 'path';
  if (ID_RE.test(token)) return 'id';
  if (NUMBER_RE.test(token) || DATE_OR_VERSION_RE.test(token)) return 'number';
  if (IDENTIFIER_RE.test(token)) return 'identifier';
  return null;
}

function isPastParticiple(lower) {
  return (lower.endsWith('ed') && lower.length > 3) || IRREGULAR_PARTICIPLES.has(lower);
}

/** Classifies one cleaned word for the sentence walk: exempt, noun, BE form, participle. */
function proseSlot(word, dictionary, technicalNames) {
  const lower = word.toLowerCase();
  const slot = { lower, exempt: false, isNoun: false, isBe: BE_FORMS.has(lower), isParticiple: isPastParticiple(lower) };
  if (CYRILLIC.test(word) || neverJudgedCategory(word, dictionary, technicalNames)) {
    return { ...slot, exempt: true, isBe: false, isParticiple: false };
  }
  // The curated list outranks the dictionary; a technical name counts as a noun.
  if (technicalNameCandidates(lower).some((candidate) => technicalNames.words.has(candidate))) {
    return { ...slot, isNoun: true };
  }
  const hit = lookupWord(lower, dictionary);
  if (hit) return { ...slot, isNoun: (hit.pos || []).includes('n') };
  if (technicalNames.patterns.some((re) => re.test(word))) return { ...slot, isNoun: true };
  return slot;
}

/** Builds one sentence record from its word slots: length, passive, noun clusters. */
function buildSentence(slots, line) {
  let passive = null;
  for (let i = 0; i < slots.length - 1; i++) {
    if (slots[i].isBe && slots[i + 1].isParticiple) {
      passive = `${slots[i].lower} ${slots[i + 1].lower}`;
      break;
    }
  }
  const clusters = [];
  let run = [];
  const endRun = () => { if (run.length > 3) clusters.push(run.join(' ')); run = []; };
  for (const slot of slots) {
    if (slot.isNoun) run.push(slot.lower);
    else endRun();
  }
  endRun();
  return { line, words: slots.length, passive, nounClusters: clusters };
}

/** Splits one paragraph (a run of consecutive non-blank lines) into sentences. */
function paragraphSentences(paraLines, dictionary, technicalNames) {
  const sentences = [];
  let slots = [];
  let line = paraLines[0].n;
  const flush = () => {
    if (slots.length) { sentences.push(buildSentence(slots, line)); slots = []; }
  };
  for (let i = 0; i < paraLines.length; i++) {
    const text = paraLines[i].text;
    // A list item or heading starts its own sentence, so a list is not merged
    // into one long sentence; wrapped prose lines stay in the same sentence.
    if (i > 0 && LIST_OR_HEADING.test(text)) { flush(); line = paraLines[i].n; }
    for (const raw of text.split(/\s+/)) {
      if (!raw) continue;
      const terminator = SENTENCE_TERMINATOR_RE.test(raw);
      if (raw.includes(EXEMPT_WORD)) {
        if (slots.length === 0) line = paraLines[i].n;
        slots.push({ lower: EXEMPT_WORD, exempt: true, isNoun: false, isBe: false, isParticiple: false });
      } else {
        const word = raw.replace(/['\u2019]s$/i, '').replace(LEADING_PUNCT, '').replace(TRAILING_PUNCT, '');
        if (word) {
          if (slots.length === 0) line = paraLines[i].n;
          slots.push(proseSlot(word, dictionary, technicalNames));
        }
      }
      if (terminator) flush();
    }
  }
  flush();
  return sentences;
}

/** Walks the sentence-masked text: paragraphs, sentences and the four sentence rules. */
function analyzeProse(text, dictionary, technicalNames) {
  const rawLines = text.split('\n');
  const findings = [];
  const totals = {
    sentenceCount: 0,
    paragraphCount: 0,
    length: { violation: 0, maybe: 0 },
    passive: { maybe: 0 },
    nounClusters: { violation: 0 },
    paragraphs: { violation: 0 },
  };
  let i = 0;
  while (i < rawLines.length) {
    if (rawLines[i].trim() === '') { i += 1; continue; }
    const paraLines = [];
    while (i < rawLines.length && rawLines[i].trim() !== '') {
      paraLines.push({ n: i + 1, text: rawLines[i] });
      i += 1;
    }
    totals.paragraphCount += 1;
    const startLine = paraLines[0].n;
    const sentences = paragraphSentences(paraLines, dictionary, technicalNames);
    totals.sentenceCount += sentences.length;
    if (sentences.length > 6) {
      totals.paragraphs.violation += 1;
      findings.push({ rule: 'paragraph', severity: 'violation', line: startLine, detail: `${sentences.length} sentences in one paragraph` });
    }
    for (const sentence of sentences) {
      if (sentence.words > 25) {
        totals.length.violation += 1;
        findings.push({ rule: 'sentenceLength', severity: 'violation', line: sentence.line, detail: `${sentence.words} words` });
      } else if (sentence.words > 20) {
        totals.length.maybe += 1;
        findings.push({ rule: 'sentenceLength', severity: 'maybe', line: sentence.line, detail: `${sentence.words} words` });
      }
      if (sentence.passive) {
        totals.passive.maybe += 1;
        findings.push({ rule: 'passive', severity: 'maybe', line: sentence.line, detail: sentence.passive });
      }
      for (const cluster of sentence.nounClusters) {
        totals.nounClusters.violation += 1;
        findings.push({ rule: 'nounCluster', severity: 'violation', line: sentence.line, detail: cluster });
      }
    }
  }
  return { ...totals, findings };
}

function record(map, key, extra, line) {
  const row = map.get(key) || { count: 0, lines: [], ...extra };
  row.count += 1;
  if (row.lines.length < 5 && !row.lines.includes(line)) row.lines.push(line);
  map.set(key, row);
}

function sortedRows(map) {
  return [...map.values()].sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}

/**
 * Checks one text. options.dictionary and options.technicalNames each accept a
 * file path or an already loaded object; both default to the checked-in
 * technical names and the dictionary built into the orch state directory.
 *
 * The result keeps the slice-1a word-half keys and always adds a `sentences`
 * section: per-rule totals (zero when a rule does not fire) plus the findings.
 */
export function check(text, options = {}) {
  const dictionary = loadDictionary(options.dictionary);
  const technicalNames = loadTechnicalNames(options.technicalNames);

  const masked = maskSpans(String(text));
  const spans = masked.counts;
  const categoryCounts = { url: 0, path: 0, identifier: 0, number: 0, id: 0, cyrillic: 0 };
  const rejectedMap = new Map();
  const unknownMap = new Map();
  const technicalMap = new Map();
  let judgedWords = 0;
  let irregularForms = 0;

  const walkLines = masked.text.split('\n');

  for (let i = 0; i < walkLines.length; i++) {
    const lineNumber = i + 1;
    for (const rawToken of walkLines[i].split(/\s+/)) {
      let token = rawToken.replace(/['\u2019]s$/i, '');
      token = token.replace(LEADING_PUNCT, '').replace(TRAILING_PUNCT, '');
      if (!token) continue;
      if (CYRILLIC.test(token)) { categoryCounts.cyrillic += 1; continue; }
      const category = neverJudgedCategory(token, dictionary, technicalNames);
      if (category) { categoryCounts[category] += 1; continue; }
      judgeToken(token, lineNumber);
    }
  }

  function judgeToken(token, lineNumber) {
    // A trailing hyphen is punctuation (a broken line break): drop it, so
    // "utilize-" is judged as "utilize", not reported as an unknown word.
    token = token.replace(/-+$/, '');
    if (!token) return;
    // Contractions and possessives (don't, it's) are never judged; the gap is
    // named in LIMITATIONS.
    if (CONTRACTION_RE.test(token)) return;
    // Hyphen or slash compounds are judged part by part ("re-run" -> "re", "run").
    if (/[\p{L}\p{N}][-/][\p{L}\p{N}]/u.test(token)) {
      for (const part of token.split(/[-/]/)) judgeToken(part, lineNumber);
      return;
    }
    const lower = token.toLowerCase();
    // The curated project word list outranks the dictionary: this project's own
    // nouns and verbs (seat, land, commit, ...) are technical names even where
    // the aviation vocabulary rejects the same string. Only the -s, -es, -ed
    // and -ing forms of a listed word count (see technicalNameCandidates).
    const listed = technicalNameCandidates(lower).find((candidate) => technicalNames.words.has(candidate));
    if (listed) {
      record(technicalMap, listed, { key: listed, via: `list:${technicalNames.words.get(listed)}` }, lineNumber);
      return;
    }
    const hit = lookupWord(lower, dictionary);
    if (hit) {
      judgedWords += 1;
      if (hit.viaIrregular) irregularForms += 1;
      if (hit.status === 'rejected') {
        const row = rejectedMap.get(hit.word) || {
          key: hit.word, count: 0, lines: [], forms: [], alternatives: hit.alternatives,
        };
        row.count += 1;
        if (row.lines.length < 5 && !row.lines.includes(lineNumber)) row.lines.push(lineNumber);
        if (!row.forms.includes(lower)) row.forms.push(lower);
        rejectedMap.set(hit.word, row);
      }
      return;
    }
    // Patterns stay behind the dictionary so an all-caps approved word (GO) is judged.
    if (technicalNames.patterns.some((re) => re.test(token))) {
      record(technicalMap, token, { key: token, via: 'pattern' }, lineNumber);
      return;
    }
    judgedWords += 1;
    record(unknownMap, lower, { key: lower }, lineNumber);
  }

  const technicalCount = [...technicalMap.values()].reduce((sum, row) => sum + row.count, 0);
  const violations = [...rejectedMap.values()].reduce((sum, row) => sum + row.count, 0);
  const totalWords = judgedWords + technicalCount;
  const rejected = sortedRows(rejectedMap);
  const unknown = sortedRows(unknownMap);
  const result = {
    totalWords,
    judgedWords,
    technicalNames: {
      count: technicalCount,
      share: totalWords ? Math.round((technicalCount / totalWords) * 1000) / 10 : 0,
      tokens: sortedRows(technicalMap),
    },
    violations,
    violationsPer100Words: totalWords ? Math.round((violations / totalWords) * 1000) / 10 : 0,
    rejected,
    unknown,
    neverJudged: { ...spans, ...categoryCounts },
    limitations: LIMITATIONS,
  };

  const prose = analyzeProse(maskForSentences(String(text)), dictionary, technicalNames);
  result.sentences = {
    sentenceCount: prose.sentenceCount,
    paragraphCount: prose.paragraphCount,
    length: prose.length,
    passive: prose.passive,
    nounClusters: prose.nounClusters,
    paragraphs: prose.paragraphs,
    irregularForms,
    findings: prose.findings.slice(0, 50),
    findingsTruncated: prose.findings.length > 50,
  };
  return result;
}

function humanReport(result, inputName) {
  const lines = [];
  lines.push(`STE check: ${inputName}`);
  lines.push(
    `words: ${result.totalWords} (judged ${result.judgedWords}, technical names ${result.technicalNames.count} = ${result.technicalNames.share}%)`,
  );
  lines.push(`violations: ${result.violations} (${result.violationsPer100Words} per 100 words)`);
  if (result.rejected.length) {
    lines.push('rejected words:');
    for (const row of result.rejected) {
      const forms = row.forms.filter((form) => form !== row.key);
      const formNote = forms.length ? `; forms: ${forms.join(', ')}` : '';
      lines.push(`  ${row.key} x${row.count} (line ${row.lines.join(', ')}${formNote}) -> ${row.alternatives.join(' | ') || '(no alternative listed)'}`);
    }
  }
  if (result.unknown.length) {
    lines.push(`unknown words (${result.unknown.length}):`);
    for (const row of result.unknown) {
      lines.push(`  ${row.key} x${row.count} (line ${row.lines.join(', ')})`);
    }
  }
  const s = result.sentences;
  lines.push('sentence rules:');
  lines.push(`  sentences: ${s.sentenceCount} in ${s.paragraphCount} paragraphs`);
  lines.push(`  length: ${s.length.violation} violations (over 25 words), ${s.length.maybe} maybe (21 to 25 words)`);
  lines.push(`  passive voice: ${s.passive.maybe} maybe (a form of BE before a past participle)`);
  lines.push(`  noun clusters: ${s.nounClusters.violation} (over three nouns in a row)`);
  lines.push(`  paragraphs: ${s.paragraphs.violation} (over six sentences)`);
  lines.push(`  irregular forms mapped to a dictionary word: ${s.irregularForms}`);
  if (s.findings.length) {
    lines.push('  examples:');
    for (const finding of s.findings.slice(0, 10)) {
      lines.push(`    line ${finding.line} [${finding.rule}/${finding.severity}] ${finding.detail}`);
    }
    if (s.findingsTruncated) lines.push('    (further findings truncated; the counts above are complete)');
  }
  lines.push('note: numbers written as words are judged as ordinary words, not mapped to digits and not exempted');
  const nj = result.neverJudged;
  lines.push(
    `never judged: fenced ${nj.fenced}, backtick ${nj.backtick}, quoted ${nj.quoted}, cyrillic ${nj.cyrillic}, url ${nj.url}, path ${nj.path}, identifier ${nj.identifier}, number ${nj.number}, id ${nj.id}`,
  );
  lines.push('cannot check:');
  for (const limitation of result.limitations) lines.push(`  - ${limitation}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Corpus mode (slice 1c): many texts, one summary. A directory is read
// recursively for .txt and .md files (kind "file"); a .jsonl file holds one
// {kind, id, text} object per line; any other file is one text of kind "file".
// A .jsonl line that does not parse or has no string text is counted in
// skippedLines with its line number and never stops the run.

const CORPUS_FILE_EXTENSIONS = new Set(['.txt', '.md']);

function fileTexts(input) {
  const files = readdirSync(input, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && CORPUS_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  return files.map((file) => ({
    kind: 'file',
    id: path.relative(input, file),
    text: readFileSync(file, 'utf8'),
  }));
}

function jsonlTexts(file, skipped) {
  const texts = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      skipped.push({ file, line: i + 1, reason: 'not JSON' });
      continue;
    }
    if (!obj || typeof obj !== 'object' || typeof obj.text !== 'string') {
      skipped.push({ file, line: i + 1, reason: 'no string text' });
      continue;
    }
    const kind = typeof obj.kind === 'string' && obj.kind ? obj.kind : 'unknown';
    texts.push({ kind, id: obj.id === undefined ? '' : String(obj.id), text: obj.text });
  }
  return texts;
}

function corpusTexts(corpusPaths) {
  const texts = [];
  const skipped = [];
  const inputs = [];
  for (const input of corpusPaths) {
    let stat;
    try {
      stat = statSync(input);
    } catch (error) {
      throw new Error(`cannot read corpus path ${input}: ${error.message}`);
    }
    if (stat.isDirectory()) {
      const found = fileTexts(input);
      texts.push(...found);
      inputs.push({ path: input, texts: found.length });
    } else if (path.extname(input).toLowerCase() === '.jsonl') {
      const found = jsonlTexts(input, skipped);
      texts.push(...found);
      inputs.push({ path: input, texts: found.length });
    } else {
      texts.push({ kind: 'file', id: input, text: readFileSync(input, 'utf8') });
      inputs.push({ path: input, texts: 1 });
    }
  }
  return { texts, skipped, inputs };
}

function emptyGroup() {
  return {
    texts: 0,
    totalWords: 0,
    judgedWords: 0,
    violations: 0,
    technicalCount: 0,
    unknownCount: 0,
    rules: {
      sentenceLength: { violation: 0, maybe: 0 },
      passiveVoice: { maybe: 0 },
      nounClusters: { violation: 0 },
      paragraphLength: { violation: 0 },
    },
  };
}

function accumulate(group, result) {
  group.texts += 1;
  group.totalWords += result.totalWords;
  group.judgedWords += result.judgedWords;
  group.violations += result.violations;
  group.technicalCount += result.technicalNames.count;
  group.unknownCount += result.unknown.reduce((sum, row) => sum + row.count, 0);
  const sentences = result.sentences;
  group.rules.sentenceLength.violation += sentences.length.violation;
  group.rules.sentenceLength.maybe += sentences.length.maybe;
  group.rules.passiveVoice.maybe += sentences.passive.maybe;
  group.rules.nounClusters.violation += sentences.nounClusters.violation;
  group.rules.paragraphLength.violation += sentences.paragraphs.violation;
}

function finalizeGroup(group) {
  return {
    texts: group.texts,
    totalWords: group.totalWords,
    judgedWords: group.judgedWords,
    violations: group.violations,
    violationsPer100Words: group.totalWords
      ? Math.round((group.violations / group.totalWords) * 1000) / 10 : 0,
    technicalNames: {
      count: group.technicalCount,
      share: group.totalWords ? Math.round((group.technicalCount / group.totalWords) * 1000) / 10 : 0,
    },
    unknownWords: group.unknownCount,
    rules: group.rules,
  };
}

/**
 * Checks many texts and returns one summary. options.dictionary and
 * options.technicalNames are as in check() and are loaded once for the whole
 * run; options.top (default 30) limits the most-frequent word lists. Per kind
 * and in total: text count, judged words, violations per 100 words, the rule
 * totals (maybe apart from violation) and the technical-name share. The top
 * lists count every occurrence and every text that holds the word.
 */
export function checkCorpus(corpusPaths, options = {}) {
  const top = Number.isInteger(options.top) && options.top >= 0 ? options.top : 30;
  const dictionary = loadDictionary(options.dictionary);
  const technicalNames = loadJson(options.technicalNames, TECHNICAL_NAMES_INPUT);
  assertTechnicalNamesShape(technicalNames, options.technicalNames);
  const { texts, skipped, inputs } = corpusTexts(corpusPaths);
  const groups = new Map();
  const total = emptyGroup();
  const rejectedAgg = new Map();
  const unknownAgg = new Map();
  for (const entry of texts) {
    const result = check(entry.text, { dictionary, technicalNames });
    let group = groups.get(entry.kind);
    if (!group) { group = emptyGroup(); groups.set(entry.kind, group); }
    accumulate(group, result);
    accumulate(total, result);
    for (const row of result.rejected) {
      const agg = rejectedAgg.get(row.key) || { word: row.key, count: 0, texts: 0, alternatives: [] };
      agg.count += row.count;
      agg.texts += 1;
      if (!agg.alternatives.length && row.alternatives && row.alternatives.length) agg.alternatives = row.alternatives;
      rejectedAgg.set(row.key, agg);
    }
    for (const row of result.unknown) {
      const agg = unknownAgg.get(row.key) || { word: row.key, count: 0, texts: 0 };
      agg.count += row.count;
      agg.texts += 1;
      unknownAgg.set(row.key, agg);
    }
  }
  const rank = (a, b) => b.count - a.count || (a.word < b.word ? -1 : 1);
  const kinds = {};
  for (const kind of [...groups.keys()].sort()) kinds[kind] = finalizeGroup(groups.get(kind));
  return {
    inputs,
    texts: texts.length,
    kinds,
    total: finalizeGroup(total),
    topRejected: [...rejectedAgg.values()].sort(rank).slice(0, top),
    topUnknown: [...unknownAgg.values()].sort(rank).slice(0, top),
    skippedLines: skipped,
    limitations: LIMITATIONS,
  };
}

function corpusGroupLines(lines, label, group) {
  lines.push(
    `${label}: ${group.texts} texts, ${group.judgedWords} judged words, ${group.violationsPer100Words} violations per 100 words, technical names ${group.technicalNames.share}% of words`,
  );
  const rules = group.rules;
  lines.push(
    `  violations ${group.violations}, unknown words ${group.unknownWords}; rules: sentenceLength ${rules.sentenceLength.violation} violations + ${rules.sentenceLength.maybe} maybe, passiveVoice ${rules.passiveVoice.maybe} maybe, nounClusters ${rules.nounClusters.violation}, paragraphLength ${rules.paragraphLength.violation}`,
  );
}

function corpusReport(result) {
  const lines = [];
  lines.push(`STE corpus check: ${result.texts} texts from ${result.inputs.length} input(s)`);
  for (const input of result.inputs) lines.push(`  ${input.path}: ${input.texts} texts`);
  lines.push('by kind:');
  for (const [kind, group] of Object.entries(result.kinds)) corpusGroupLines(lines, `  ${kind}`, group);
  corpusGroupLines(lines, 'total', result.total);
  if (result.topRejected.length) {
    lines.push(`most frequent rejected words (top ${result.topRejected.length}):`);
    for (const row of result.topRejected) {
      lines.push(`  ${row.word} x${row.count} in ${row.texts} text(s) -> ${row.alternatives.join(' | ') || '(no alternative listed)'}`);
    }
  } else {
    lines.push('most frequent rejected words: none');
  }
  if (result.topUnknown.length) {
    lines.push(`most frequent unknown words (top ${result.topUnknown.length}):`);
    for (const row of result.topUnknown) lines.push(`  ${row.word} x${row.count} in ${row.texts} text(s)`);
  } else {
    lines.push('most frequent unknown words: none');
  }
  if (result.skippedLines.length) {
    lines.push(`skipped lines: ${result.skippedLines.length}`);
    for (const skip of result.skippedLines) lines.push(`  ${skip.file}:${skip.line} ${skip.reason}`);
  }
  lines.push('cannot check:');
  for (const limitation of result.limitations) lines.push(`  - ${limitation}`);
  return lines.join('\n');
}

function usage() {
  return [
    'Usage: node scripts/ste-check.mjs [file] [--json] [--dict <file>]',
    '       node scripts/ste-check.mjs --corpus <path>... [--top <N>] [--json] [--dict <file>]',
    '',
    '  file     a text file to check; stdin when omitted',
    '  --corpus read many texts and print one summary: a directory is read',
    '           recursively for .txt and .md files (kind "file"); a .jsonl file',
    '           holds one {kind, id, text} object per line; any other file is',
    '           one text of kind "file"',
    `  --top    most frequent rejected and unknown words to list (default 30)`,
    '  --json   print the result as JSON instead of the human report',
    `  --dict   dictionary (default: ${DEFAULT_DICTIONARY})`,
  ].join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const args = { file: undefined, json: false, dict: undefined, corpus: [], top: undefined };
  let corpusMode = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--dict') args.dict = argv[++i];
    else if (arg === '--corpus') corpusMode = true;
    else if (arg === '--top') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) { console.error(usage()); process.exitCode = 2; return; }
      args.top = value;
    }
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--')) { console.error(usage()); process.exitCode = 2; return; }
    else if (corpusMode) args.corpus.push(arg);
    else if (args.file === undefined) args.file = arg;
    else { console.error(usage()); process.exitCode = 2; return; }
  }
  if (args.help) { console.log(usage()); return; }
  if (corpusMode) {
    if (!args.corpus.length) { console.error(usage()); process.exitCode = 2; return; }
    let result;
    try {
      result = checkCorpus(args.corpus, { dictionary: args.dict, top: args.top });
    } catch (error) {
      console.error(String(error.message));
      process.exitCode = 2;
      return;
    }
    console.log(args.json ? JSON.stringify(result, null, 2) : corpusReport(result));
    return;
  }
  let text;
  try {
    text = args.file === undefined ? readFileSync(0, 'utf8') : readFileSync(args.file, 'utf8');
  } catch (error) {
    console.error(String(error.message));
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = check(text, { dictionary: args.dict });
  } catch (error) {
    console.error(String(error.message));
    process.exitCode = 2;
    return;
  }
  console.log(args.json ? JSON.stringify(result, null, 2) : humanReport(result, args.file ?? 'stdin'));
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) main();
