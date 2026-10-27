#!/usr/bin/env node
// Reproduce #13055's six reviewed mistakes and their landed corrections.
// Branches retained only the seat base (the reviewed edits were uncommitted).
// Therefore reconstruct the cited mechanism, not an invented full coder output.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runLessonProbe } from './lesson-probe.mjs';
import { scoreProbe } from './scorer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
// #12868 deliberately changed the historical acceptance contract. Keep the
// failed candidate's reproduction visible, but never schedule it as a fixture.
const dropped = { probe: '12845', mustChange: 'ops/bootstrap/code-intel-order-hook.mjs',
  owned: ['ops/bootstrap/code-intel-order-hook.mjs'], history: { clean: 'c13c63e6f' } };
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const replace = (text, from, to) => {
  if (text.split(from).length !== 2) throw new Error(`reconstruction anchor not unique: ${from}`);
  return text.replace(from, to);
};

function mistakenSource(id, clean) {
  if (id === '12805') return replace(clean, "program === 'test' && operands.length === 3 &&", "program === 'test' &&");
  if (id === '12713') return replace(clean, "splitTopLevel(command, ['&&', '||', '|&', '|', ';', '\\n', '&'])", "splitTopLevel(command, ['&&', '||', '|&', '|', ';', '\\n'])");
  if (id === '12737') return replace(clean, 'remaining >= 0 && remaining <= limit ? limit - remaining : NaN', 'limit - remaining');
  if (id === '12562') return replace(clean, 'return remote || existsSync(join(cwd, relative)) ? relative : fileURLToPath(new URL(relative, REPO));', 'return relative;');
  if (id === '12703') return replace(clean, "pi.on('agent_settled', () => { firstPrompt = false; });", "pi.on('turn_end', () => { firstPrompt = false; });");
  if (id === '12845') {
    // Reviewer glm-0cc635: the opener scan stops at the commit line, the
    // delimiter regex takes the last adjacent << operand, and missing matches
    // scan only bare commit lines. Missing closers are trusted. Rebuild these
    // decisions on the historical base, before the exact-shape replacement.
    let text = git('show', 'ef1a8b434:ops/bootstrap/code-intel-order-hook.mjs');
    text = replace(text, "const boundary = new Set([' ', '\\t', '\\n', '\\r',", "const boundary = new Set([' ', '\\t', '\\n',");
    text = replace(text, 'const gated = stripped.text;', 'let gated = stripped.text;');
    const start = text.indexOf('    for (let i = 0; i < text.length; i += 1) {', text.indexOf('const stripComments'));
    const end = text.indexOf('    const inProtect', start);
    if (start < 0 || end < 0) throw new Error('missing historical heredoc parser');
    // The reviewed replacement removed the before-commit heredoc parser.
    text = text.slice(0, start) + text.slice(end);
    return replace(text, '  // Unquoted or unclosed heredocs are not parsed.', `  // Reconstructed reviewer-glm-0cc635.1 decision path.
  let before = false;
  let offset = 0;
  const rawLines = command.split('\\n');
  for (const [number, line] of gated.split('\\n').entries()) {
    for (const { part } of splitTopLevel(line, ['&&', '||', '|&', '|', ';', '&'])) {
      const commit = isGitCommit(peelProgram(splitWords(part)));
      if (commit && before) refuse();
      if (part.includes('<<')) {
        if (commit) {
          const match = /.*<<-?(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))/.exec(part);
          const body = rawLines.slice(number + 1);
          const delimiter = match?.[1] ?? match?.[2] ?? match?.[3];
          if (match) {
            const close = body.findIndex((entry) => entry === delimiter);
            if (close !== -1 && body.slice(close + 1).some((entry) => entry.trim())) refuse();
          } else if (body.some((entry) => isGitCommit(peelProgram(splitWords(entry))))) refuse();
          gated = gated.slice(0, offset + line.length);
          break;
        }
        before = true;
      }
    }
    if (gated.length === offset + line.length) break;
    offset += line.length + 1;
  }
  segments.length = 0;
  for (const segment of splitTopLevel(gated, ['&&', '||', '|&', '|', ';', '\\n', '&'])) segments.push(segment);
  // Unquoted or unclosed heredocs are not parsed.`);
  }
  throw new Error(`unknown reconstruction ${id}`);
}

const scratch = mkdtempSync(path.join(process.argv[2] ? path.resolve(process.argv[2]) : tmpdir(), 'lesson-ab-'));
const tree = path.join(scratch, 'tree');
let added = false;
try {
  for (const [key, fixture] of [...Object.entries(fixtures).filter(([, fixture]) => fixture.probe), ['lesson-12845', dropped]]) {
    if (!added) { git('worktree', 'add', '--detach', tree, fixture.history.clean); added = true; symlinkSync(path.join(root, 'node_modules'), path.join(tree, 'node_modules')); }
    else git('-C', tree, 'checkout', '--force', fixture.history.clean);
    const file = path.join(tree, fixture.mustChange);
    const cleanSource = readFileSync(file, 'utf8');
    const measure = () => {
      const started = performance.now();
      return { ...runLessonProbe(fixture.probe, tree), elapsedMs: Math.round(performance.now() - started) };
    };
    writeFileSync(file, mistakenSource(fixture.probe, cleanSource));
    const mistaken = measure();
    writeFileSync(file, cleanSource);
    const clean = measure();
    const paths = [fixture.mustChange];
    const scores = { mistaken: scoreProbe(fixture, paths, mistaken), clean: scoreProbe(fixture, paths, clean) };
    const discriminates = !mistaken.error && mistaken.mistakeAbsent === false && clean.acceptance && clean.mistakeAbsent &&
      scores.mistaken === 0 && scores.clean === 1 && mistaken.elapsedMs < 60_000 && clean.elapsedMs < 60_000;
    const retained = fixture !== dropped;
    console.log(JSON.stringify({ fixture: key, retained, reconstruction: true, cleanCommit: git('rev-parse', fixture.history.clean).trim(), mistaken, clean, scores, discriminates,
      ...(!retained ? { droppedReason: 'Decision #12868 supersedes the original comment-newline acceptance; the landed allowlist refuses it.' } : {}) }));
    if (retained ? !discriminates : mistaken.error || clean.error || mistaken.mistakeAbsent !== false || clean.mistakeAbsent !== true || clean.acceptance !== false) process.exitCode = 1;
  }
} finally {
  if (added) git('worktree', 'remove', '--force', tree);
  rmSync(scratch, { recursive: true, force: true });
}
