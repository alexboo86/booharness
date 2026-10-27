#!/usr/bin/env node
// Blast radius by compilation, not by ranking.
//
//   node scripts/blast-radius.mjs <symbol> --ts [--project tsconfig.app.json]
//   node scripts/blast-radius.mjs <symbol> --rust [-p <crate>] [--at <file>:<line>]
//
// TypeScript: the compiler's own LanguageService.findReferences. The tree is never edited.
// Rust: `#[deprecated]` on the declaration, then `cargo check`; every use site prints as a
// warning with file:line:col and the build still succeeds, so no downstream error masks
// another. cargo is an async child so SIGINT, SIGTERM and SIGHUP stop it and revert the
// edit (also reverted in `finally`). One journal per repository under os.tmpdir(), created
// with wx and tagged with the owner pid, restores a dead owner's patch on the next --rust run.
// A live owner blocks the second run.
//
// Neither side sees dispatch by string — Tauri command names, serde field names, ClickHouse
// column names, MCP tool names. That half is `rg` on the literal, and both modes say so.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const rel = (p) => path.relative(ROOT, p) || p;

function usage(msg) {
  if (msg) console.error(`blast-radius: ${msg}`);
  console.error(
    'usage: node scripts/blast-radius.mjs <symbol> --ts [--project <tsconfig>]\n' +
      '       node scripts/blast-radius.mjs <symbol> --rust [-p <crate>] [--at <file>:<line>]'
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = { symbol: null, mode: null, project: 'tsconfig.app.json', crate: null, at: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ts' || a === '--rust') out.mode = a.slice(2);
    else if (a === '--project') out.project = argv[++i];
    else if (a === '-p' || a === '--package') out.crate = argv[++i];
    else if (a === '--at') out.at = argv[++i];
    else if (a.startsWith('-')) usage(`unknown flag ${a}`);
    else if (out.symbol === null) out.symbol = a;
    else usage(`unexpected argument ${a}`);
  }
  if (!out.symbol) usage('no symbol given');
  if (!out.mode) usage('pass --ts or --rust');
  return out;
}

const STRING_DISPATCH_NOTE = (symbol) =>
  `\nNOT covered by the compiler: dispatch by string (Tauri command names, serde field names, ` +
  `ClickHouse column names, MCP tool names).\nRun \`rg -n '${symbol}'\` for that half before ` +
  `calling this answer exhaustive.`;

// ---------------------------------------------------------------- TypeScript

async function typescriptReferences({ symbol, project }) {
  const ts = (await import('typescript')).default;
  const configPath = path.resolve(ROOT, project);
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error) {
    console.error(ts.flattenDiagnosticMessageText(raw.error.messageText, '\n'));
    process.exit(1);
  }
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath));
  if (parsed.errors.length) {
    for (const e of parsed.errors) console.error(ts.flattenDiagnosticMessageText(e.messageText, '\n'));
    process.exit(1);
  }

  const files = parsed.fileNames;
  const host = {
    getScriptFileNames: () => files,
    getScriptVersion: () => '1',
    getScriptSnapshot: (name) => {
      const text = ts.sys.readFile(name);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => ROOT,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = service.getProgram();

  const declarations = [];
  const named = (node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node);

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) continue;
    const walk = (node) => {
      if (named(node) && node.name && ts.isIdentifier(node.name) && node.name.text === symbol) {
        declarations.push({ fileName: sf.fileName, pos: node.name.getStart(sf), sourceFile: sf });
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(sf, walk);
  }

  if (!declarations.length) {
    console.error(`no declaration of \`${symbol}\` in ${project}. Not every symbol is a declaration —` +
      ` for an imported-only name, search the source it comes from.`);
    process.exit(1);
  }

  let total = 0;
  for (const decl of declarations) {
    const at = decl.sourceFile.getLineAndCharacterOfPosition(decl.pos);
    console.log(`\ndeclaration ${rel(decl.fileName)}:${at.line + 1}:${at.character + 1}`);
    const refs = service.getReferencesAtPosition(decl.fileName, decl.pos) || [];
    const uses = refs.filter((r) => !(r.fileName === decl.fileName && r.textSpan.start === decl.pos));
    if (!uses.length) {
      console.log('  (no references — dead, or reached only by string dispatch)');
      continue;
    }
    for (const ref of uses) {
      const sf = program.getSourceFile(ref.fileName);
      const p = sf.getLineAndCharacterOfPosition(ref.textSpan.start);
      const lineStart = sf.getPositionOfLineAndCharacter(p.line, 0);
      const nl = sf.text.indexOf('\n', lineStart);
      const text = sf.text.slice(lineStart, nl === -1 ? undefined : nl).trim();
      console.log(`  ${rel(ref.fileName)}:${p.line + 1}:${p.character + 1}  ${text}`);
      total++;
    }
  }
  console.log(
    `\n${total} reference(s) across ${declarations.length} declaration(s) of \`${symbol}\`, ` +
      `from ${project}. A file outside that project is invisible here — name another with --project.`
  );
  console.log(STRING_DISPATCH_NOTE(symbol));
}

// ---------------------------------------------------------------------- Rust

const RUST_DECL_PATTERNS = (s) => [
  `\\bfn\\s+${s}\\s*[(<]`,
  `\\bstruct\\s+${s}\\b`,
  `\\benum\\s+${s}\\b`,
  `\\btrait\\s+${s}\\b`,
  `\\btype\\s+${s}\\s*[=<]`,
  `\\bunion\\s+${s}\\b`,
  `\\bconst\\s+${s}\\s*:`,
  `\\bstatic\\s+${s}\\s*:`,
];

function findRustDeclarations(symbol) {
  const pattern = RUST_DECL_PATTERNS(symbol).join('|');
  let out = '';
  try {
    out = execFileSync('rg', ['-n', '--no-heading', '-t', 'rust', '-e', pattern, '.'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?):(\d+):(.*)$/);
      return m ? { file: m[1], line: Number(m[2]), text: m[3] } : null;
    })
    .filter(Boolean);
}

// `#[deprecated]` on a trait method inside an `impl ... for ...` block is a hard rustc error,
// measured 2026-09-03: "attribute cannot be used on trait methods in impl blocks".
// The trait DECLARATION is the right target there, and it also catches dyn and generic dispatch.
function insideTraitImpl(fileText, lineNo) {
  const lines = fileText.split('\n');
  const target = lines[lineNo - 1] ?? '';
  const targetIndent = target.length - target.trimStart().length;
  for (let i = lineNo - 2; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim()) continue;
    const indent = l.length - l.trimStart().length;
    if (indent >= targetIndent) continue;
    if (/^\s*impl\b/.test(l)) return / for /.test(l);
    if (/^\s*(pub\s+)?(trait|mod|fn)\b/.test(l)) return false;
  }
  return false;
}

const CARGO_MAX_BUFFER = 64 * 1024 * 1024;

function repoJournalFile() {
  const id = crypto.createHash('sha256').update(path.resolve(ROOT)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'blast-radius', `${id}.journal`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function readJournal(file) {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  if (!rec || typeof rec.source !== 'string' || typeof rec.original !== 'string' || typeof rec.declLine !== 'string') {
    return null;
  }
  const pid = Number(rec.pid);
  return {
    pid: Number.isInteger(pid) ? pid : 0,
    source: rec.source,
    declLine: rec.declLine,
    original: Buffer.from(rec.original, 'base64'),
  };
}

function sourceInRepo(source) {
  const relPath = path.relative(path.resolve(ROOT), path.resolve(source));
  return relPath !== '' && !relPath.startsWith('..') && !path.isAbsolute(relPath);
}

const DEPRECATED_LINE = /^[ \t]*#\[deprecated\][ \t]*$/;

function pairsAboveDecl(text, declLine) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (DEPRECATED_LINE.test(lines[i]) && lines[i + 1] === declLine) hits.push(i);
  }
  return hits;
}

// True only when current is original plus the single `#[deprecated]` line this tool inserts.
function holdsInsertedDeprecated(originalBuf, currentBuf) {
  if (currentBuf.equals(originalBuf)) return false;
  const original = originalBuf.toString('utf8');
  const current = currentBuf.toString('utf8');
  const oLines = original.split('\n');
  const cLines = current.split('\n');
  if (cLines.length !== oLines.length + 1) return false;
  for (let i = 0; i < cLines.length; i++) {
    if (!DEPRECATED_LINE.test(cLines[i])) continue;
    const without = cLines.slice(0, i).concat(cLines.slice(i + 1));
    if (without.join('\n') === original) return true;
  }
  return false;
}

function warnKept(source, journalFile) {
  console.error(`blast-radius: ${source} is not the inserted patch; journal kept at ${journalFile}`);
}

// Returns true when the journal is gone. Never writes bytes other than removing one inserted line,
// or rewriting a file that is exactly original plus that line.
function recoverDead(rec, journalFile) {
  if (!sourceInRepo(rec.source)) {
    warnKept(rec.source, journalFile);
    return false;
  }
  let current;
  try {
    current = readFileSync(rec.source);
  } catch (err) {
    console.error(`blast-radius: cannot read ${rec.source} (${err.code || err.message}); journal kept at ${journalFile}`);
    return false;
  }
  if (current.equals(rec.original)) {
    unlinkSync(journalFile);
    return true;
  }
  if (holdsInsertedDeprecated(rec.original, current)) {
    writeFileSync(rec.source, rec.original);
    unlinkSync(journalFile);
    console.error(`blast-radius: restored ${rel(rec.source)} after an interrupted run (removed leftover #[deprecated])`);
    return true;
  }
  const currentText = current.toString('utf8');
  if (!Buffer.from(currentText, 'utf8').equals(current)) {
    warnKept(rec.source, journalFile);
    return false;
  }
  const curHits = pairsAboveDecl(currentText, rec.declLine);
  const origHits = pairsAboveDecl(rec.original.toString('utf8'), rec.declLine);
  if (curHits.length === 1 && origHits.length === 0) {
    const lines = currentText.split('\n');
    lines.splice(curHits[0], 1);
    writeFileSync(rec.source, lines.join('\n'));
    unlinkSync(journalFile);
    console.error(`blast-radius: removed leftover #[deprecated] in ${rel(rec.source)} after an interrupted run`);
    return true;
  }
  warnKept(rec.source, journalFile);
  return false;
}

function takeExistingJournal() {
  const file = repoJournalFile();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  let rec = null;
  try {
    rec = readJournal(file);
  } catch {
    rec = null;
  }
  if (!rec) {
    console.error(`blast-radius: unreadable journal ${file}; left unchanged`);
    process.exit(1);
  }
  if (pidAlive(rec.pid)) {
    console.error(`blast-radius: another --rust run owns this repository (pid ${rec.pid}, journal ${file})`);
    process.exit(1);
  }
  if (!recoverDead(rec, file)) process.exit(1);
}

function writeJournal(sourcePath, originalBuf, declLine) {
  const file = repoJournalFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    source: path.resolve(sourcePath),
    declLine,
    original: Buffer.from(originalBuf).toString('base64'),
  });
  try {
    writeFileSync(file, payload, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let pid = 'unknown';
    try {
      const rec = readJournal(file);
      if (rec?.pid) pid = String(rec.pid);
    } catch { /* unreadable lock */ }
    console.error(`blast-radius: another --rust run owns this repository (pid ${pid}, journal ${file})`);
    process.exit(1);
  }
  return file;
}

function stopCargoChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }, 2000);
  child.once('close', () => clearTimeout(timer));
  try {
    child.kill('SIGTERM');
  } catch {
    clearTimeout(timer);
  }
}

function runCargo(args, onChild) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    onChild(child);
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const take = (chunks, len, chunk) => {
      const next = len + chunk.length;
      if (next > CARGO_MAX_BUFFER) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        const error = new Error('spawn cargo ENOBUFS');
        error.code = 'ENOBUFS';
        fail(error);
        return len;
      }
      chunks.push(chunk);
      return next;
    };
    child.stdout.on('data', (chunk) => { outLen = take(out, outLen, chunk); });
    child.stderr.on('data', (chunk) => { errLen = take(err, errLen, chunk); });
    child.on('error', fail);
    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      resolve({
        status,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

async function rustBlastRadius({ symbol, crate, at }) {
  takeExistingJournal();
  let decls = findRustDeclarations(symbol);
  if (at) {
    const [f, l] = at.split(':');
    decls = decls.filter((d) => path.resolve(d.file) === path.resolve(f) && d.line === Number(l));
    if (!decls.length) usage(`--at ${at} matches no declaration of \`${symbol}\``);
  }
  if (!decls.length) {
    console.error(`no Rust declaration of \`${symbol}\` found. Check the spelling, or pass --at <file>:<line>.`);
    process.exit(1);
  }
  if (decls.length > 1) {
    console.error(`\`${symbol}\` has ${decls.length} candidate declarations — pick one with --at <file>:<line>:`);
    for (const d of decls) console.error(`  ${d.file}:${d.line}  ${d.text.trim()}`);
    process.exit(1);
  }

  const decl = decls[0];
  const originalBuf = readFileSync(decl.file);
  const original = originalBuf.toString('utf8');
  if (insideTraitImpl(original, decl.line)) {
    console.error(
      `${decl.file}:${decl.line} is a trait method inside an \`impl ... for ...\` block, where rustc ` +
        `REFUSES \`#[deprecated]\`.\nDeprecate the method on the TRAIT declaration instead — that ` +
        `catches static, \`dyn\` and generic dispatch alike.`
    );
    process.exit(1);
  }

  const lines = original.split('\n');
  const declLine = lines[decl.line - 1];
  const indent = declLine.slice(0, declLine.length - declLine.trimStart().length);
  lines.splice(decl.line - 1, 0, `${indent}#[deprecated]`);
  const patched = lines.join('\n');

  const journalFile = writeJournal(decl.file, originalBuf, declLine);
  let restored = false;
  const restore = () => {
    if (restored) return;
    writeFileSync(decl.file, originalBuf);
    try {
      unlinkSync(journalFile);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    restored = true;
  };

  let cargoChild = null;
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    process.exitCode = 130;
    try {
      restore();
    } catch (err) {
      console.error(`blast-radius: restore failed: ${err.message}`);
    }
    stopCargoChild(cargoChild);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  // cargo writes diagnostics to stderr. spawn, not spawnSync: spawnSync blocks the loop, so a
  // SIGTERM delivered while cargo is running never reaches the handler and the edit stays.
  let diagnostics = '';
  try {
    writeFileSync(decl.file, patched, 'utf8');
    // --all-targets or the whole `#[cfg(test)]` half of the tree is never compiled, and its
    // call sites are silently missing from the answer. Measured 2026-09-03 on clamp_close_qty:
    // 1 use site without it, 3 with it.
    const cargoArgs = ['check', '--all-targets', '--message-format', 'short'];
    if (crate) cargoArgs.push('-p', crate);
    else cargoArgs.push('--workspace');
    const run = await runCargo(cargoArgs, (child) => { cargoChild = child; });
    if (!interrupted) {
      diagnostics = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      if (run.status !== 0) {
        const hard = diagnostics.split('\n').filter((l) => /^\S+:\d+:\d+: error/.test(l) || /^error(\[|:)/.test(l));
        console.error('cargo check failed for a reason other than the deprecation:');
        console.error(hard.slice(0, 20).join('\n') || diagnostics.split('\n').slice(-20).join('\n'));
        process.exitCode = 1;
      }
    }
  } finally {
    try {
      restore();
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
    }
  }

  if (interrupted) process.exit(130);

  // The inserted attribute shifts every line below it by one, so cargo's numbers for the patched
  // file are one too high. Correct them back to the tree the caller will actually open.
  const patchedFile = path.resolve(decl.file);
  const uses = [
    ...new Set(
      diagnostics
        .split('\n')
        .filter((l) => /warning: use of deprecated/.test(l))
        .map((l) => l.trim())
        .map((l) => {
          const m = l.match(/^(.*?):(\d+):(\d+): (.*)$/);
          if (!m) return l;
          const ln = path.resolve(m[1]) === patchedFile && Number(m[2]) > decl.line ? Number(m[2]) - 1 : Number(m[2]);
          return `${m[1]}:${ln}:${m[3]}: ${m[4]}`;
        })
    ),
  ];

  console.log(`declaration ${rel(path.resolve(decl.file))}:${decl.line}  ${decl.text.trim()}`);
  if (!uses.length) {
    console.log('  (no use sites — dead, or reached only by string dispatch)');
  } else {
    for (const u of uses) console.log(`  ${u}`);
  }
  const scope = crate ? `-p ${crate}` : '--workspace';
  console.log(
    `\n${uses.length} use site(s) of \`${symbol}\`, from \`cargo check --all-targets ${scope}\`.` +
      (crate ? `\n\`-p ${crate}\` checks that crate and its DEPENDENCIES — not its dependents. Drop it for the whole workspace.` : '')
  );
  console.log(STRING_DISPATCH_NOTE(symbol));
}

// ---------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
if (args.mode === 'ts') await typescriptReferences(args);
else await rustBlastRadius(args);
