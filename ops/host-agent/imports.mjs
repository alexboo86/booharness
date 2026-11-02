// A conservative lexer, not an evaluator. Ambiguous syntax fails closed.
function fail(file, message) {
  throw new Error(`${file}: ${message}`);
}

function unicodeEscape(source, start, kind, file) {
  const braced = kind === 'u' && source[start] === '{';
  const end = braced ? source.indexOf('}', start + 1) : start + (kind === 'x' ? 2 : 4);
  const hex = source.slice(start + Number(braced), end);
  if (!/^[0-9a-f]+$/i.test(hex)) fail(file, 'invalid string escape');
  const code = Number.parseInt(hex, 16);
  if (code > 0x10ffff) fail(file, 'invalid string code point');
  return { value: String.fromCodePoint(code), end: end + Number(braced) };
}

function escapeAt(source, start, file) {
  const char = source[start];
  if (char === 'x' || char === 'u') return unicodeEscape(source, start + 1, char, file);
  if (char === '\r') return { value: '', end: start + (source[start + 1] === '\n' ? 2 : 1) };
  if (char === '\n') return { value: '', end: start + 1 };
  if (char === undefined || /[1-9]/.test(char)) fail(file, 'unsupported string escape');
  const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
  return { value: simple[char] ?? char, end: start + 1 };
}

function quoted(source, start, file) {
  let value = '';
  let i = start + 1;
  while (i < source.length) {
    const char = source[i++];
    if (char === source[start]) return { value, end: i };
    if (char === '\n' || char === '\r') fail(file, 'newline in string');
    if (char === '\\') {
      const escape = escapeAt(source, i, file);
      value += escape.value; i = escape.end;
    } else value += char;
  }
  fail(file, 'unterminated string');
}

function regexEnd(source, start, file) {
  let characterClass = false;
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '\n' || char === '\r') break;
    if (char === '\\') { i++; continue; }
    if (char === '[') characterClass = true;
    if (char === ']') characterClass = false;
    if (char === '/' && !characterClass) return i + 1;
  }
  fail(file, 'unterminated or ambiguous regular expression');
}

function template(state) {
  const { source, file } = state;
  state.i++;
  while (state.i < source.length) {
    const char = source[state.i++];
    if (char === '\\') { state.i++; continue; }
    if (char === '`') return;
    if (char === '$' && source[state.i] === '{') {
      state.i++; state.expression = true;
      lex(state, true);
    }
  }
  fail(file, 'unterminated template');
}

// Every ECMAScript line terminator, not just LF: code after a lone \r, U+2028
// or U+2029 executes and must not hide inside a // comment.
function lineEnd(source, start) {
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029') return i;
  }
  return -1;
}

function skipComment(state) {
  const { source, i, file } = state;
  if (source.startsWith('//', i) || (i === 0 && source.startsWith('#!', i))) {
    const end = lineEnd(source, i);
    state.i = end < 0 ? source.length : end;
    return true;
  }
  if (!source.startsWith('/*', i)) return false;
  const end = source.indexOf('*/', i + 2);
  if (end < 0) fail(file, 'unterminated comment');
  state.i = end + 2;
  return true;
}

const expressionPrefix = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'yield', 'await', 'in', 'instanceof']);

// Reserved words cannot be identifiers, so a `/` after one is not unambiguous
// division; refuse it instead of guessing between operator and regex.
const keywords = new Set(['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield']);

function word(state) {
  const value = /^[a-zA-Z_$0-9]+/.exec(state.source.slice(state.i))[0];
  const previous = state.tokens.at(-1)?.value;
  state.tokens.push({ type: 'word', value });
  state.i += value.length;
  state.expression = previous !== '.' && expressionPrefix.has(value);
}

function text(state, char) {
  if (char === '`') {
    state.tokens.push({ value: '`' });
    template(state);
    state.tokens.push({ value: '`' });
  } else {
    const string = quoted(state.source, state.i, state.file);
    state.tokens.push({ type: 'string', value: string.value });
    state.i = string.end;
  }
  state.expression = false;
}

// Expression position (after `return` or `=`) lexes a regex. Otherwise a '/'
// is division only after a value: a non-keyword word (identifiers and number
// literals both lex as words) or `]`. After `)` and `}` a regex may follow in
// valid JS, so those and every other prefix stay fail-closed.
function slash(state) {
  if (state.expression) {
    state.i = regexEnd(state.source, state.i, state.file);
    state.expression = false;
    return;
  }
  const previous = state.tokens.at(-1);
  const operator = previous
    && ((previous.type === 'word' && !keywords.has(previous.value))
      || (previous.type === undefined && previous.value === ']'));
  if (!operator) fail(state.file, 'ambiguous slash (division unsupported)');
  state.tokens.push({ value: '/' });
  state.i++;
  state.expression = true;
}

function punctuation(state, char) {
  if (char === '\\' || char.charCodeAt(0) > 127) fail(state.file, 'unsupported identifier');
  if (char === '/') return slash(state);
  if ((char === '+' || char === '-') && state.source[state.i + 1] === char) {
    state.tokens.push({ value: char + char });
    state.i += 2; state.expression = false;
    return;
  }
  state.tokens.push({ value: char });
  state.expression = ![']', ')', '}', '.'].includes(char);
  state.i++;
}

function token(state, char) {
  if ("'\"`".includes(char)) text(state, char);
  else if (/[a-zA-Z_$0-9]/.test(char)) word(state);
  else punctuation(state, char);
}

function lex(state, interpolation = false) {
  let braces = 0;
  while (state.i < state.source.length) {
    const char = state.source[state.i];
    if (/\s/.test(char)) { state.i++; continue; }
    if (skipComment(state)) continue;
    if (interpolation && char === '}' && braces === 0) { state.i++; return; }
    if (char === '{') braces++;
    if (char === '}') braces--;
    token(state, char);
  }
  if (interpolation) fail(state.file, 'unterminated template expression');
}

function staticSpecifier(tokens, start, file) {
  if (tokens[start]?.type === 'string') return tokens[start].value;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].value === ';') break;
    if (tokens[i].value === 'from' && tokens[i + 1]?.type === 'string') return tokens[i + 1].value;
  }
  fail(file, 'unsupported static import/export');
}

function nextIsString(tokens, i) {
  return tokens[i + 1]?.type === 'string';
}

function importAt(tokens, i, file) {
  const next = tokens[i + 1]?.value;
  if (next === '(') fail(file, 'dynamic import is forbidden');
  if (tokens[i - 1]?.value === '.') return null;
  // `{ import: value }` names a property or destructuring binding; only a
  // non-string ':' token can be that separator (a string VALUE of ':' cannot).
  if (!nextIsString(tokens, i) && next === ':') return null;
  if (next === '.') {
    if (tokens[i + 2]?.value !== 'meta') fail(file, 'unsupported import expression');
    return null;
  }
  return staticSpecifier(tokens, i + 1, file);
}

function exportAt(tokens, i, file) {
  let end = i + 1;
  if (!['*', '{'].includes(tokens[end]?.value)) return null;
  if (tokens[end].value === '{') {
    // A string token's VALUE may be '}'; only a non-string token closes the clause.
    while (end < tokens.length && (tokens[end].type === 'string' || tokens[end].value !== '}')) end++;
    if (end >= tokens.length) fail(file, 'unterminated export clause');
    if (tokens[end + 1]?.value !== 'from') return null;
  }
  return staticSpecifier(tokens, end, file);
}

export function importSpecifiers(source, file) {
  const tokens = [];
  lex({ source, file, tokens, i: 0, expression: true });
  const imports = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'word') continue;
    let specifier = null;
    if (tokens[i].value === 'import') specifier = importAt(tokens, i, file);
    if (tokens[i].value === 'export') specifier = exportAt(tokens, i, file);
    if (specifier !== null) imports.push(specifier);
  }
  return imports;
}
