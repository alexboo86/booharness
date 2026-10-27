import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const sourceCache = new Map();

function sourceAt(repo, base, file) {
  const key = `${repo}:${base}:${file}`;
  if (!sourceCache.has(key)) {
    const text = git(repo, 'show', `${base}:${file}`);
    sourceCache.set(key, { text, ast: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) });
  }
  return sourceCache.get(key);
}

function namedChild(parent, name) {
  const found = [];
  const visit = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parent, visit);
  if (found.length !== 1) throw new Error(`expected one symbol '${name}', found ${found.length}`);
  return found[0];
}

/** Narrow SQL table/field spans, or TypeScript declaration/member spans from the pinned AST. */
export function symbolSpan(fixture, ref, repo = ROOT) {
  const { text, ast } = sourceAt(repo, fixture.base, ref.path);
  const [name, sqlSection] = ref.symbol.split('::');
  const [declaration, index] = /^([A-Za-z][\w]*)(?:\[(\d+)\])?$/.exec(name.split('.')[0])?.slice(1) ?? [];
  if (!declaration) throw new Error(`invalid symbol '${ref.symbol}'`);
  let node = namedChild(ast, declaration);
  if (index !== undefined) {
    if (!ts.isVariableDeclaration(node) || !ts.isArrayLiteralExpression(node.initializer) || !node.initializer.elements[Number(index)]) throw new Error(`no pinned array element '${name}'`);
    node = node.initializer.elements[Number(index)];
  }
  for (const part of name.split('.').slice(1)) node = namedChild(node, part);
  let start = node.getStart(ast, true);
  let end = node.getEnd();
  if (sqlSection) {
    const [table, field] = sqlSection.split('.');
    const segment = text.slice(start, end);
    const tableMatch = new RegExp(`\\bCREATE TABLE ${table} \\(`).exec(segment);
    if (!tableMatch) throw new Error(`no SQL table '${table}' in '${name}'`);
    start += tableMatch.index;
    const close = /\n[ \t]*\);/.exec(text.slice(start, end));
    if (!close) throw new Error(`no closing SQL table '${table}'`);
    end = start + close.index + close[0].length;
    if (field) {
      const match = new RegExp(`^[ \\t]*${field}[ \\t]+[^\\n]*`, 'm').exec(text.slice(start, end));
      if (!match) throw new Error(`no SQL field '${field}' in '${table}'`);
      start += match.index;
      end = start + match[0].length;
    }
  }
  if (!ref.contains || !text.slice(start, end).includes(ref.contains)) throw new Error(`stale truth: ${ref.path}:${ref.symbol} lacks ${JSON.stringify(ref.contains)}`);
  return { path: ref.path, start: ast.getLineAndCharacterOfPosition(start).line + 1, end: ast.getLineAndCharacterOfPosition(end - 1).line + 1 };
}

export function validateTruth(fixture, repo = ROOT) {
  if (!Array.isArray(fixture.truth) || !fixture.truth.length) throw new Error('scout truth must not be empty');
  const ids = new Set();
  for (const fact of fixture.truth) {
    if (!fact.id || ids.has(fact.id) || !Array.isArray(fact.symbols) || !fact.symbols.length || !Array.isArray(fact.claimPatterns) || !fact.claimPatterns.length) throw new Error(`invalid or duplicate fact '${fact.id}'`);
    for (const pattern of fact.claimPatterns) new RegExp(pattern, 'i');
    ids.add(fact.id);
    for (const ref of fact.symbols) symbolSpan(fixture, ref, repo);
  }
}

function citationPath(raw, checkout) {
  if (!raw.startsWith('/')) return raw.replace(/^\.\//, '');
  if (checkout && (raw === checkout || raw.startsWith(`${checkout}/`))) return raw.slice(checkout.length + 1);
  const marker = /\/(ops|scripts|src)\//g;
  const match = marker.exec(raw);
  return match ? raw.slice(match.index + 1) : raw; // unknown absolute paths never match a truth path
}

function citations(text, checkout) {
  return [...String(text ?? '').matchAll(/(?:^|[^\w./-])((?:\/|\.\/)?[\w./-]+\.[cm]?[jt]sx?):(\d+)(?:-(\d+))?(?![\d-])/gm)]
    .map((m) => ({ path: citationPath(m[1], checkout), start: Number(m[2]), end: Number(m[3] ?? m[2]) }))
    .filter((c) => Number.isSafeInteger(c.start) && Number.isSafeInteger(c.end) && c.start >= 1 && c.end >= c.start);
}

/** Established facts require matching claim AND in-span evidence in one finding; precision exposes citation spray. */
export function scoutBreakdown(fixture, digest, repo = ROOT, checkout = null) {
  if (digest.status !== 'done' || !digest.report) return { matched: [], inTruth: 0, citations: 0, facts: 0, precision: 0, score: 0 };
  validateTruth(fixture, repo);
  const findings = Array.isArray(digest.report.findings) ? digest.report.findings : [];
  const evidence = findings.map((f) => citations(f.evidence, checkout));
  const all = [...evidence.flat(), ...((Array.isArray(digest.report.checked) ? digest.report.checked : []).flatMap((s) => citations(s, checkout)))];
  const spans = fixture.truth.map((fact) => fact.symbols.map((ref) => symbolSpan(fixture, ref, repo)));
  const inside = (citation, factSpans) => factSpans.some((span) => citation.path === span.path && citation.start >= span.start && citation.end <= span.end);
  const matched = fixture.truth.filter((fact, i) => findings.some((finding, j) =>
    typeof finding.claim === 'string' && fact.claimPatterns.every((pattern) => new RegExp(pattern, 'i').test(finding.claim)) &&
    evidence[j].some((citation) => inside(citation, spans[i])))).map((fact) => fact.id);
  const inTruth = all.filter((citation) => spans.some((factSpans) => inside(citation, factSpans))).length;
  const facts = matched.length / fixture.truth.length;
  const precision = inTruth / Math.max(1, all.length);
  return { matched, inTruth, citations: all.length, facts, precision, score: facts };
}

export function scoutMatches(fixture, digest, repo = ROOT, checkout = null) {
  return scoutBreakdown(fixture, digest, repo, checkout).matched;
}

export function scoreScout(fixture, digest, repo = ROOT, checkout = null) {
  return scoutBreakdown(fixture, digest, repo, checkout);
}

export function changedPaths(repo, base) {
  const tracked = execFileSync('git', ['diff', '--name-only', '-z', base, '--'], { cwd: repo }).toString('utf8').split('\0');
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repo }).toString('utf8').split('\0');
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
}

/** TAP must name the accepted test and mark it ok (not skipped); a 0-test exit 0 is not a pass. */
export function scoreCoder(fixture, paths, test) {
  const name = fixture.testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namedPass = new RegExp(`^ok \\d+ - ${name}(?: \\([^\\n]*\\))?$`, 'm').test(test.stdout ?? '');
  const passCount = /^# pass ([1-9]\d*)$/m.test(test.stdout ?? '');
  return Number(test.status === 0 && namedPass && passCount && paths.includes(fixture.mustChange) &&
    paths.includes(fixture.test) && paths.every((p) => fixture.owned.includes(p)));
}

/**
 * Edit-only fixture (no `test` field, decisions #12881/#12895): the seat may neither write nor
 * run a test, so the score is the diff itself — the owned file changed and nothing outside
 * `owned` did. A foreign path or an untouched mustChange is a zero, never a partial.
 */
export function scoreEdit(fixture, paths) {
  if (!fixture.mustChange || !Array.isArray(fixture.owned) || !fixture.owned.includes(fixture.mustChange)) throw new Error(`edit fixture must own its mustChange path '${fixture.mustChange}'`);
  return Number(paths.includes(fixture.mustChange) && paths.every((p) => fixture.owned.includes(p)));
}

/** Operator-approved reproduction: both acceptance and mistake absence must be observed. */
export function scoreProbe(fixture, paths, probe) {
  return Number(scoreEdit(fixture, paths) === 1 && probe?.acceptance === true &&
    probe?.mistakeAbsent === true && !probe.error);
}
