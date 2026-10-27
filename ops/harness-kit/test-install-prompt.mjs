// The install prompt's fenced commands are the contract a lead will run.
// A wrong verb must fail here: the install result depends on those verbs.
// Existing kit tests do not read this prompt. No production seam is added.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The donor owns the source prompt; releases put the rendered prompt at root.
const promptPath = existsSync(path.join(repoRoot, 'INSTALL-PROMPT.md'))
  ? path.join(repoRoot, 'INSTALL-PROMPT.md')
  : path.join(repoRoot, 'ops/harness-kit/INSTALL-PROMPT.md');
const COMMAND = /^node\s+(\S+)\s+(\S+)(?:\s|$)/;

function codeBlocks(markdown) {
  const blocks = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(markdown))) blocks.push(match[1]);
  return blocks;
}

function commandLines(markdown) {
  const lines = [];
  for (const block of codeBlocks(markdown)) {
    for (const raw of block.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = COMMAND.exec(line);
      if (!match) continue;
      lines.push({ line, script: match[1], verb: match[2] });
    }
  }
  return lines;
}

function sliceConst(source, name) {
  const at = source.search(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=`));
  if (at === -1) return '';
  let depth = 0;
  let started = false;
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
      started = true;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
    } else if (ch === ';' && started && depth === 0) return source.slice(at, i + 1);
  }
  return '';
}


function leadingComments(source) {
  const lines = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#!') || trimmed.startsWith('//')
      || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')) {
      lines.push(line);
      continue;
    }
    break;
  }
  return lines.join('\n');
}

// Usage text is what the script prints or documents as its command line:
// a USAGE constant (including one it imports), a string that contains "usage:",
// the leading comment block, and a refusal string that names a flag it expects.
// The whole source is not usage: a word that only appears in other code must fail.
function usageText(scriptPath, seen = new Set()) {
  const resolved = path.resolve(scriptPath);
  if (seen.has(resolved) || !existsSync(resolved)) return '';
  seen.add(resolved);
  const source = readFileSync(resolved, 'utf8');
  const parts = [sliceConst(source, 'USAGE'), leadingComments(source)];
  for (const line of source.split(/\r?\n/)) {
    if (/usage\s*:/i.test(line) || (/--[a-z0-9-]+/i.test(line) && /expects/i.test(line))) parts.push(line);
  }
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = importRe.exec(source))) {
    const names = match[1].split(',').map((part) => part.trim().split(/\s+as\s+/i)[0].replace(/^type\s+/, ''));
    if (!names.includes('USAGE')) continue;
    let target = path.resolve(path.dirname(resolved), match[2]);
    if (!existsSync(target)) {
      for (const ext of ['.mjs', '.js', '.cjs', '.ts']) {
        if (existsSync(`${target}${ext}`)) {
          target = `${target}${ext}`;
          break;
        }
      }
    }
    parts.push(usageText(target, seen));
  }
  return parts.filter(Boolean).join('\n');
}

function holds(usage, verb) {
  const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[\\s|\\[\\]()<>'"\`,:;])${escaped}(?=$|[\\s|\\[\\]()<>'"\`,:;])`);
  return re.test(usage);
}

export function commandProblems(markdown, root = repoRoot) {
  const problems = [];
  const lines = commandLines(markdown);
  if (!lines.length) problems.push('no node <script> <verb> line in a code block');
  for (const { line, script, verb } of lines) {
    if (path.isAbsolute(script) || script.split(/[/\\]/).includes('..')) {
      problems.push(`${line}: script path must stay inside the checkout`);
      continue;
    }
    const file = path.resolve(root, script);
    const inside = file === root || file.startsWith(`${root}${path.sep}`);
    if (!inside || !existsSync(file) || !statSync(file).isFile()) {
      problems.push(`${line}: script does not exist: ${script}`);
      continue;
    }
    if (!holds(usageText(file), verb)) {
      problems.push(`${line}: ${verb} is not in the usage text of ${script}`);
    }
  }
  return problems;
}

// Step 3 pins live in that slice. A prompt-wide match of the preamble
// does not prove them: each sentence below fails when only the slice loses it.
export const LOGIN_PINS = [
  'A key never goes into this chat',
  'The exit code of the login is not the proof',
  'node ops/bootstrap/harness-secret.mjs has <family>',
  'offer the same choices again',
  'If the command exits 3, that is an answer, not a failure: show the command it printed and ask the user to run that command in a terminal.',
  'Say that the claude store cannot be read here, and the running lead proves its own login. Ask nothing. Do not read the Keychain. Do not start a claude login.',
  'the helper prints `type /login qwen-token-plan-individual` and then starts Pi; it does not type that line into Pi.',
  'On darwin that opens a new Terminal window.',
  'Do not invent a different command. Do not stop the install.',
  'Then prove again with `has`.',
  'It is optional.',
];
export const SECTION_PINS = [
  {
    name: 'preamble',
    from: '# Install this harness\n',
    to: '\n## Before step 1: dependencies\n',
    sentences: ['Do not read the Keychain. Do not start a claude login.'],
    forbidden: [],
  },
  {
    // Prompt wording is the agent-facing selection contract. A fresh home
    // has no working logins; selecting only those would skip step 3. Pin the
    // default and its consumer here, without adding a production test seam.
    name: 'step 2',
    from: '\n## 2. Families\n',
    to: '\n## 3. Logins\n',
    sentences: [
      'Show all eight families with their printed rows.',
      'If it is absent, all eight families, in the order listed above.',
      'Ask the user to drop the families they do not have.',
      'The other six families work here when the pinned Pi is installed; each row shows its login state separately.',
    ],
    forbidden: ['If it is absent, the `works here:` list'],
  },
  {
    name: 'step 3',
    from: '\n## 3. Logins\n',
    to: '\n## 4. Teams\n',
    sentences: [...LOGIN_PINS, 'Go through `families.enabled`, or through all eight families when that key is absent.'],
    forbidden: ['running Claude Code lead is signed in', 'the window types `', 'You do not run it'],
  },
  {
    name: 'step 10',
    from: '\n## 10. Jev\n',
    to: '\n## 11. Lead\n',
    sentences: ['you open the window. The user only pastes the key there.'],
    forbidden: ['You do not run it', "in the user's own terminal"],
  },
  {
    name: 'Apply',
    from: '\n## Apply\n',
    to: null,
    sentences: ['you open the window, and the user only pastes the key there.'],
    forbidden: ['You do not run it', "in the user's own terminal"],
  },
];

function promptSection(markdown, from, to) {
  const start = markdown.indexOf(from);
  if (start < 0) return '';
  const end = to == null ? markdown.length : markdown.indexOf(to, start + from.length);
  if (end < 0) return '';
  return markdown.slice(start, end);
}

export function loginSliceProblems(markdown) {
  const problems = [];
  for (const spec of SECTION_PINS) {
    const body = promptSection(markdown, spec.from, spec.to);
    if (!body) {
      problems.push(`${spec.name} slice missing`);
      continue;
    }
    for (const sentence of spec.sentences) {
      if (!body.includes(sentence)) problems.push(`${spec.name} missing: ${sentence}`);
    }
    for (const phrase of spec.forbidden) {
      if (body.includes(phrase)) problems.push(`${spec.name} forbids: ${phrase}`);
    }
  }
  return problems;
}

const prompt = readFileSync(promptPath, 'utf8');

test('each fenced node command names a real script and a usage verb', () => {
  const problems = commandProblems(prompt);
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(commandLines(prompt).length >= 8);
});

test('a wrong verb in the prompt fails', () => {
  const wrong = '```text\nnode ops/bootstrap/harness-config.mjs frobnicate\n```\n';
  const problems = commandProblems(wrong);
  assert.ok(problems.some((problem) => problem.includes('frobnicate')), problems.join('\n'));
});

test('a word that appears in the script but not in its usage fails', () => {
  const wrong = '```text\nnode ops/bootstrap/doctor.mjs set\n```\n';
  const problems = commandProblems(wrong);
  assert.ok(problems.some((problem) => problem.includes('set is not in the usage text')), problems.join('\n'));
});

test('a missing script fails', () => {
  const wrong = '```text\nnode ops/bootstrap/no-such-script.mjs set\n```\n';
  const problems = commandProblems(wrong);
  assert.ok(problems.some((problem) => problem.includes('does not exist')), problems.join('\n'));
});

test('the prompt follows the install rules', () => {
  const markers = [
    'Add a machine?',
    'Which model families do you have?',
    'is not logged in',
    'Default: log in now',
    'harness-login.mjs <family>',
    'exits 3',
    'qwen --quota',
    'ranks it last',
    'no quota login',
    'Keep the present role matrix, or take a preset?',
    'Skills to turn off',
    'Which skills should a lead session get?',
    'Which MCP servers are off?',
    'memory.embed.url',
    'Set up Jev now?',
    'Send one paid request to prove the key?',
    'Run the paid proof only after the user says yes.',
    'lead.replyLanguage',
    'setup-routines',
    'install-harness.mjs',
    'doctor.mjs --fix',
    'next:',
  ];
  let at = -1;
  for (const marker of markers) {
    const next = prompt.indexOf(marker, at + 1);
    assert.ok(next > at, `missing or out of order: ${marker}`);
    at = next;
  }
  assert.match(prompt, /Do not write `ops\/bootstrap\/harness\.config\.json`/);
  assert.match(prompt, /harness-config\.mjs set` or `apply`/);
  assert.match(prompt, /install\.userEntries` is `keep`/);
  assert.ok(prompt.includes(`node ops/bootstrap/harness-config.mjs set install.userEntries '"keep"'`), 'the userEntries keep command');
  assert.match(prompt, /Do not ask for a key\. Do not read a key\. Do not print a key\./);
  assert.match(prompt, /harness-secret\.mjs set <name>/);
  const logins = prompt.slice(prompt.indexOf('\n## 3. Logins\n'), prompt.indexOf('\n## 4. Teams\n'));
  assert.ok(logins.length > 0, 'step 3 slice');
  assert.match(logins, /GLM defaults to Pi with the Z\.AI key, not a Claude login\./);
  assert.match(logins, /harness-config\.mjs set families\.enabled '\["claude"\]'/);
  assert.equal(logins.includes('You do not run it'), false);
  assert.equal(logins.includes('Default: skip'), false);
  assert.equal(logins.includes('only skip and drop'), false);
  assert.match(prompt, /When a command fails, stop\. Show the command and its output\. Ask what to do\./);
  assert.match(prompt, /not checked/);
  assert.match(prompt, /KIT-MANIFEST\.json/);
  assert.match(prompt, /hooks repair is never safe/);
  for (const word of ['seamless', 'effortless', 'world-class', 'delightful']) {
    assert.equal(prompt.toLowerCase().includes(word), false, word);
  }
});

// Authoring gate: published interview policy is distinct from command validity.
// A bundled interview or Git before CLT regresses it; no production seam.
test('the interview starts in the UI language, asks singly, and prepares Git before clone', () => {
  const guide = readFileSync(path.join(path.dirname(promptPath), 'INSTALL.md'), 'utf8');
  for (const text of [prompt, guide]) {
    assert.match(text, /defaults read -g AppleLanguages/);
    assert.match(text, /\(Get-UICulture\)\.Name/);
    assert.match(text, /first entry.*region tag/);
    assert.match(text, /before your first message/);
    assert.match(text, /fails or is unclear, ask the language first/);
    assert.match(text, /answers in another language, switch/);
    assert.match(text, /One question per message/);
    assert.match(text, /default and a one-line reason.*wait for the answer/);
  }
  const lead = promptSection(prompt, '\n## 11. Lead\n', '\n## 12. Routines\n');
  assert.match(lead, /Default: the interview language/);
  assert.match(lead, /not Russian.*set `lead.replyLanguage`/);
  assert.match(prompt, /Steps 2 and 11 are the exceptions/);
  const memory = promptSection(prompt, '\n## 9. Memory\n', '\n## 10. Jev\n');
  assert.match(memory, /Wait for the URL answer before asking about the model/);
  const beforeClone = guide.slice(0, guide.indexOf("git clone '"));
  for (const command of ['xcode-select -p', 'xcode-select --install', 'xcrun --find git', '"$git_bin" --version']) {
    assert.ok(beforeClone.includes(command), `before clone: ${command}`);
  }
  assert.match(beforeClone, /wait for.*done/);
  assert.match(guide, /Local Network.*not yet proven/);
  const interview = promptSection(guide, '\n## 3. Ask the user first\n', '\n## 4. Phase A: prerequisites\n');
  assert.ok(interview.indexOf('Machines') < interview.indexOf('Families'));
  assert.ok(interview.indexOf('Memory') < interview.indexOf('Jev'));
  assert.match(interview, /updater consent and git identity.*Apply/);
});

// Test-audit: decision 19348 adds a lead recommendation and a GUI/CLI boundary
// absent from the existing command/order checks. Check both emitted documents;
// settings registration must not become a claim of successful mod loading.
test('both install docs recommend the desktop lead and state the CLI limits', () => {
  const guide = readFileSync(path.join(path.dirname(promptPath), 'INSTALL.md'), 'utf8');
  const verify = (text) => {
    assert.match(text, /\*\*Recommended setup:\*\* paste this install prompt into the \*\*Claude Code desktop app \(GUI\)\*\*/);
    assert.match(text, /worker seats run under orch/);
    assert.match(text, /\*\*Claude Code terminal CLI\*\*/);
    assert.match(text, /terminal surface renders a\s+text\s+summary/);
    assert.match(text, /no attached surface/);
    assert.match(text, /(?:installer|It) does not install the desktop app/);
    assert.match(text, /registration (?:alone does not prove|as proof of) (?:a loaded mod|mod loading)/);
  };
  for (const text of [prompt, guide]) {
    verify(text);
    assert.throws(() => verify(text.replace('**Recommended setup:**', 'Alternative setup:')));
  }
  assert.match(guide, /On both macOS and\s+Windows, the installer's `permissions` step/);
  for (const name of ['collision-guard', 'delay-no-more', 'handover', 'orch-board', 'secrets-veil']) {
    assert.ok(guide.includes(`| \`${name}\` |`), `mod table row: ${name}`);
  }
  assert.match(guide, /All default patterns are empty: registration alone changes nothing/);
});

test('each login pin fails when only that sentence is removed from its section', () => {
  assert.deepEqual(loginSliceProblems(prompt), []);
  for (const spec of SECTION_PINS) {
    const start = prompt.indexOf(spec.from);
    const end = spec.to == null ? prompt.length : prompt.indexOf(spec.to, start + spec.from.length);
    const body = prompt.slice(start, end);
    for (const sentence of spec.sentences) {
      const mutated = prompt.slice(0, start) + body.replaceAll(sentence, 'MUTATED') + prompt.slice(end);
      // The preamble key rule still matches. The section pin must fail anyway.
      assert.match(mutated, /Do not ask for a key\. Do not read a key\. Do not print a key\./);
      const problems = loginSliceProblems(mutated);
      assert.ok(problems.some((problem) => problem.includes(spec.name) && problem.includes(sentence)), `${spec.name}: ${sentence}\n${problems.join('\n')}`);
    }
    for (const phrase of spec.forbidden) {
      const mutated = prompt.slice(0, start + spec.from.length) + phrase + '\n' + prompt.slice(start + spec.from.length);
      const problems = loginSliceProblems(mutated);
      assert.ok(problems.some((problem) => problem.includes(spec.name) && problem.includes(phrase)), `${spec.name} allows ${phrase}\n${problems.join('\n')}`);
    }
  }
});

// Authoring gate: the real command owns runtime discovery plus login rows.
// A vendor CLI must not replace missing pinned Pi; login absence must not
// hide installed Pi. Existing launcher tests cover transport, not this probe.
// Copying the command's small dependency closure isolates installed packages
// without a production seam or a real GUI.
test('--families separates pinned Pi availability from login state', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'install-prompt-home-'));
  try {
    const home = path.join(root, 'home');
    mkdirSync(path.join(home, '.grok', 'bin'), { recursive: true });
    writeFileSync(path.join(home, '.grok', 'bin', 'grok'), '');
    mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(path.join(home, '.pi', 'agent', 'auth.json'), JSON.stringify({
      'qwen-token-plan-individual': { type: 'api_key', key: 'fixture-key' },
    }));
    for (const rel of ['ops/bootstrap/resolve-runtime-path.mjs', 'ops/bootstrap/wizard-steps/families.mjs',
      'ops/bootstrap/family-logins.json', 'scripts/lib/family-logins.mjs', 'scripts/lib/harness-config.mjs', 'scripts/lib/runtime-search.mjs']) {
      const file = path.join(root, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      copyFileSync(path.join(repoRoot, rel), file);
    }
    const piPackage = path.join(root, 'ops/pi-runtime/node_modules/@earendil-works/pi-coding-agent');
    mkdirSync(piPackage, { recursive: true });
    writeFileSync(path.join(piPackage, 'package.json'), JSON.stringify({ bin: { pi: 'cli.js' } }));
    const entry = path.join(piPackage, 'cli.js');
    for (const installed of [false, true, false]) {
      if (installed) writeFileSync(entry, '');
      else rmSync(entry, { force: true });
      const run = spawnSync(process.execPath, [path.join(root, 'ops/bootstrap/resolve-runtime-path.mjs'), '--families', '--home', home], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const lines = run.stdout.trimEnd().split('\n');
      const last = lines.pop();
      assert.equal(lines.length, 8, run.stdout);
      assert.ok(last.startsWith('works here: '), last);
      const working = JSON.parse(last.slice('works here: '.length));
      for (const family of ['codex', 'grok', 'kimi', 'opencode', 'qwen', 'mimo']) {
        assert.equal(working.includes(family), installed, `${family}: ${last}`);
        assert.ok(lines.some((line) => line.startsWith(`${family}: pinned Pi ${installed ? 'found at ' : 'not found;'}`)), run.stdout);
      }
      assert.match(lines.find((line) => line.startsWith('qwen:')), /; login ok /);
      assert.match(lines.find((line) => line.startsWith('grok:')), /; login missing /);
      assert.equal(run.stdout.includes('fixture-key'), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The install instructions are an independent user-facing contract: offering
// a vendor install regresses the kit policy even if runtime probes still pass.
test('the install documents offer only Claude Code as a vendor CLI', () => {
  const guidePath = path.join(path.dirname(promptPath), 'INSTALL.md');
  const guide = readFileSync(guidePath, 'utf8');
  for (const text of [prompt, guide]) {
    assert.match(text, /npm install -g @anthropic-ai\/claude-code/);
  }
  const readmes = ['README.md', 'README.ru.md'].map((name) => readFileSync(path.join(path.dirname(promptPath), name), 'utf8'));
  for (const text of [prompt, guide, ...readmes]) {
    assert.doesNotMatch(text, /npm install[^\n]*@openai\/codex|codex login|kimi login|opencode auth login|Install the Kimi Code CLI/);
  }
  // Whole cells, not a suffix: "<vendor login> or Pi `/login`" must fail too.
  const piAccess = {
    'README.md': { codex: 'ChatGPT subscription via Pi `/login`', kimi: 'Pi `/login`', opencode: 'Pi `/login`' },
    'README.ru.md': { codex: 'Подписка ChatGPT через Pi `/login`', kimi: 'Pi `/login`', opencode: 'Pi `/login`' },
  };
  for (const [index, name] of ['README.md', 'README.ru.md'].entries()) {
    for (const [family, access] of Object.entries(piAccess[name])) {
      const row = readmes[index].split('\n').find((line) => line.startsWith(`| \`${family}\` |`));
      assert.ok(row, `${family}: family row exists in ${name}`);
      const cells = row.split('|').slice(2, -1).map((cell) => cell.trim());
      assert.equal(cells.length, 2, `${family}: route and access cells only in ${name}`);
      assert.match(cells[0], /^Pi `[\w-]+`$/, `${family}: Pi-only runtime route in ${name}`);
      assert.equal(cells[1], access, `${family}: Pi-only login in ${name}`);
    }
  }
  assert.ok(prompt.includes('Claude seats default to native Claude Code; GLM defaults to Pi'));
  // Public path contract: a donor-only guide path does not exist in the kit.
  // The existing prompt-contract owner is the cheapest independent boundary;
  // no production export or duplicate runtime test is needed.
  assert.doesNotMatch(prompt, /`ops\/harness-kit\/INSTALL\.md`/);
  const schedule = guide.slice(guide.indexOf('### 8.3 '), guide.indexOf('\n## 9.'));
  assert.match(schedule, /claude update/);
  assert.doesNotMatch(schedule, /(?:codex|kimi|grok|opencode) update/);
});

// The Apply block is the ordered command plan of an install. An explicit
// --home disables orch activation even when it names the process home.
// Extend the existing prompt-contract owner to both shells; no production seam.
test('the Apply list preserves command order without an explicit home in both shells', () => {
  const apply = prompt.slice(prompt.indexOf('\n## Apply\n'));
  const plans = codeBlocks(apply).slice(0, 2);
  assert.equal(plans.length, 2);
  for (const block of plans) {
    const listed = block.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.includes('harness-config.mjs'));
    assert.deepEqual(listed, [
      'node ops/memory-local/install.mjs',
      'node ops/bootstrap/install-harness.mjs --skip-code-intel',
      'node ops/bootstrap/doctor.mjs',
    ]);
  }
});

// Authoring gate: the guide is the executable install boundary, not a script
// export. Existing probe/golden tests cannot catch hash-before-extract, remote
// refusal or missing-model regressions. Shim only downloads and macOS commands;
// execute the published code with real config loading, hashing and filesystem.
test('the macOS Ollama script requires the pin, refuses remote fallback, imports the pinned default and pulls only a different missing model', () => {
  const storedPins = JSON.parse(readFileSync(path.join(repoRoot, 'ops/bootstrap/tool-pins.json'), 'utf8'));
  const pin = storedPins.ollama;
  assert.equal(storedPins['qwen3-embedding'].model, 'qwen3-embedding:0.6b');
  assert.equal(storedPins['qwen3-embedding'].url, 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf');
  assert.equal(storedPins['qwen3-embedding'].sha256, '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439');
  assert.equal(storedPins['qwen3-embedding'].bytes, 639150592);
  const fixture = `
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'darwin' });
process.getuid = () => 501;
const mode = process.env.OLLAMA_TEST_MODE;
const pin = process.env.OLLAMA_TEST_PIN;
const log = (event) => fs.appendFileSync('events.jsonl', JSON.stringify(event) + '\\n');
let started = false;
cp.execFileSync = (file, args, options = {}) => {
  log({ file, args, host: options.env?.OLLAMA_HOST });
  if (file === 'curl') {
    const url = args.find((arg) => arg.startsWith('https://'));
    const gguf = JSON.parse(fs.readFileSync('ops/bootstrap/tool-pins.json', 'utf8'))['qwen3-embedding'].url;
    if (url === gguf) {
      fs.writeFileSync(args[args.indexOf('-o') + 1], Buffer.from('fixture gguf'));
      return '';
    }
    throw Error('setup must not download prerequisite tools: ' + url);
  }
  if (file === 'plutil') return '';
  if (file === 'launchctl') { started = true; return ''; }
  if (path.basename(file) === 'ollama') {
    if (args[0] === '--version') return 'ollama version is ' + (mode === 'wrong-pin' ? '0.0.0' : pin) + '\\n';
    if (args[0] === 'list') return 'NAME ID SIZE MODIFIED\\nqwen3-embedding:' + (mode === 'present-remote' ? '0.6b' : 'other') + ' abc 1GB now\\n';
    if (args[0] === 'create') {
      const modelfile = args[args.indexOf('-f') + 1];
      const body = fs.readFileSync(modelfile, 'utf8');
      if (!body.startsWith('FROM ')) throw Error('Modelfile must FROM the GGUF');
      log({ file, args, host: options.env?.OLLAMA_HOST, modelfile: body, modelfilePath: modelfile });
      return '';
    }
    if (args[0] === 'pull') return '';
  }
  throw Error('unexpected command: ' + file + ' ' + args.join(' '));
};
syncBuiltinESMExports();
globalThis.fetch = async (url) => {
  const u = new URL(url);
  log({ request: u.href });
  if (u.pathname === '/api/version') return new Response(JSON.stringify({ version: pin }), { status: mode === 'missing-remote' || (!started && mode !== 'present-remote') ? 503 : 200 });
  if (u.pathname === '/api/embed') return Response.json({ embeddings: [Array(1024).fill(0.25)] });
  throw Error('unexpected request: ' + u.href);
};
`;
  for (const mode of ['missing-local', 'present-remote', 'missing-remote', 'absent-binary', 'wrong-pin', 'foreign-binary', 'bad-model-hash', 'missing-other']) {
    const root = mkdtempSync(path.join(tmpdir(), 'ollama-guide-'));
    try {
      for (const rel of ['scripts/lib/harness-config.mjs', 'scripts/lib/import-embed-model.mjs', 'scripts/memory/embed-recipe.mjs', 'ops/bootstrap/tool-pins.json', 'ops/bootstrap/ollama-setup.mjs']) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        copyFileSync(path.join(repoRoot, rel), path.join(root, rel));
      }
      const home = path.join(root, 'home & space');
      mkdirSync(path.join(home, '.local/bin'), { recursive: true });
      if (mode !== 'absent-binary') {
        const base = path.join(home, '.local/share/probe/ollama');
        mkdirSync(path.join(base, pin, 'lib'), { recursive: true });
        writeFileSync(path.join(base, pin, 'ollama'), 'fixture binary', { mode: 0o755 });
        writeFileSync(path.join(base, pin, 'lib/fixture.dylib'), 'fixture library');
        symlinkSync(pin, path.join(base, 'current'), 'dir');
        if (mode === 'foreign-binary') writeFileSync(path.join(home, '.local/bin/ollama'), 'user binary');
        else symlinkSync(path.join(base, 'current/ollama'), path.join(home, '.local/bin/ollama'));
      }
      const url = mode.endsWith('remote') ? 'http://embed.example:11434' : 'http://127.0.0.1:11434';
      const modelName = mode === 'missing-other' ? 'other:model' : 'qwen3-embedding:0.6b';
      const config = JSON.stringify({ names: { prefix: 'probe' }, memory: { embed: { url, model: modelName } } });
      const configPath = path.join(root, 'ops/bootstrap/harness.config.json');
      writeFileSync(configPath, config);
      if (mode === 'missing-local' || mode === 'bad-model-hash') {
        const pinFile = path.join(root, 'ops/bootstrap/tool-pins.json');
        const rewritten = JSON.parse(readFileSync(pinFile, 'utf8'));
        const fixtureBytes = Buffer.from('fixture gguf');
        rewritten['qwen3-embedding'].bytes = fixtureBytes.length;
        rewritten['qwen3-embedding'].sha256 = mode === 'bad-model-hash' ? '0'.repeat(64) : createHash('sha256').update(fixtureBytes).digest('hex');
        writeFileSync(pinFile, JSON.stringify(rewritten));
      }
      writeFileSync(path.join(root, 'fixture.mjs'), fixture);
      const run = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'fixture.mjs')).href, 'ops/bootstrap/ollama-setup.mjs', 'setup'], {
        cwd: root, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, HOME: home, USERPROFILE: home, OLLAMA_TEST_MODE: mode, OLLAMA_TEST_PIN: pin },
      });
      const events = readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const calls = (name) => events.filter((event) => event.file && path.basename(event.file) === name);
      const success = ['missing-local', 'present-remote', 'missing-other'].includes(mode);
      assert.equal(run.status, success ? 0 : 1, `${mode}: ${run.stdout}\n${run.stderr}`);
      assert.equal(readFileSync(configPath, 'utf8'), config, 'stored endpoint is unchanged');
      if (mode === 'missing-remote') {
        assert.match(run.stderr, /remote endpoint/i);
        assert.equal(events.some((event) => event.file), false, 'remote refusal precedes downloads and service writes');
      } else if (mode === 'bad-model-hash') {
        assert.match(run.stderr, /checksum mismatch/i);
        assert.equal(calls('ollama').filter((event) => event.args[0] === 'create').length, 0, 'hash mismatch precedes ollama create');
        assert.equal(events.some((event) => event.file === 'curl' && event.args?.some((arg) => String(arg).includes('huggingface.co'))), true);
      } else if (mode === 'absent-binary' || mode === 'wrong-pin') {
        assert.equal(calls('curl').length, 0, 'missing or wrong prerequisite never downloads');
        assert.match(run.stderr, mode === 'absent-binary' ? /binary is absent/i : /does not match pin/i);
        assert.equal(calls('launchctl').length, 0);
      } else if (mode === 'foreign-binary') {
        assert.match(run.stderr, /unmanaged/i);
        assert.equal(readFileSync(path.join(home, '.local/bin/ollama'), 'utf8'), 'user binary');
        assert.equal(calls('launchctl').length, 0);
      } else {
        const base = path.join(home, '.local/share/probe/ollama');
        assert.equal(readFileSync(path.join(base, pin, 'lib/fixture.dylib'), 'utf8'), 'fixture library', 'complete distribution retained');
        assert.equal(readFileSync(path.join(home, '.local/bin/ollama'), 'utf8'), 'fixture binary', 'stable link resolves to release');
        const pulls = calls('ollama').filter((event) => event.args[0] === 'pull');
        const creates = calls('ollama').filter((event) => event.args[0] === 'create' && event.modelfile);
        if (mode === 'missing-other') {
          assert.equal(creates.length, 0);
          assert.deepEqual(pulls[0]?.args, ['pull', 'other:model']);
          assert.equal(events.some((event) => event.file === 'curl' && event.args?.some((arg) => String(arg).includes('huggingface.co'))), false);
        } else if (mode === 'missing-local') {
          assert.equal(pulls.length, 0);
          assert.equal(creates.length, 1);
          assert.equal(creates[0].args[1], 'qwen3-embedding:0.6b');
          assert.equal(creates[0].args[2], '-f');
          assert.match(creates[0].modelfile, /^FROM \S+\n$/);
          assert.equal(existsSync(creates[0].modelfilePath), false, 'temporary GGUF removed after create');
        } else {
          assert.equal(pulls.length, 0);
          assert.equal(creates.length, 0);
        }
        assert.ok(calls('ollama').filter((event) => ['list', 'pull', 'create'].includes(event.args[0])).every((event) => event.host === url));
        if (mode === 'present-remote') assert.equal(calls('launchctl').length, 0, 'reuse answering remote endpoint');
        else {
          const plist = readFileSync(path.join(home, 'Library/LaunchAgents/com.probe.ollama.plist'), 'utf8');
          assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
          assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
          assert.ok(plist.includes('home &amp; space'));
          assert.ok(plist.includes('<string>serve</string>'));
          assert.ok(calls('launchctl').some((event) => event.args[0] === 'bootstrap'));
        }
        assert.ok(events.some((event) => event.request?.endsWith('/api/embed')), 'embedding proved before memory installation');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// The prompt is the public execution plan. Static section pins independently
// guard consent and ordering; the command execution test cannot inspect prose.
test('the agent runs macOS Ollama setup after consent and before memory, deferring its early probe', () => {
  const apply = prompt.slice(prompt.indexOf('\n## Apply\n'));
  const step9 = promptSection(prompt, '\n## 9. Memory\n', '\n## 10. Jev\n');
  assert.match(apply, /Run them only after yes\./);
  assert.match(apply, /On macOS, after that yes and before the memory command, run `node ops\/bootstrap\/ollama-setup\.mjs setup` from INSTALL\.md §4\.1\./);
  assert.match(step9, /On macOS, defer this proof until Apply, after the Ollama commands of INSTALL\.md §4\.1\./);
  const guide = readFileSync(path.join(path.dirname(promptPath), 'INSTALL.md'), 'utf8');
  const embedder = promptSection(guide, '\n### 6.1 Embedder\n', '\n### 6.2 Client, service files and the memoryd unit\n');
  assert.match(embedder, /§4\.1/);
  assert.doesNotMatch(embedder, /[Tt]he bootstrap/);
});

// Authoring gate: execute the published probe, not a source-spelling assertion.
// Existing command checks inspect only the agent prompt and cannot catch an
// invalid library call in INSTALL.md. The HTTP fixture supplies embeddings;
// real config loading and the real embed recipe must deliver the request.
test('the manual embedding verification reads the checkout config and prints the vector dimension', async () => {
  const guide = readFileSync(path.join(path.dirname(promptPath), 'INSTALL.md'), 'utf8');
  const commands = codeBlocks(guide).flatMap((block) => block.split(/\r?\n/))
    .filter((line) => line.startsWith('node --input-type=module -e ') && line.includes('embed-recipe.mjs'));
  assert.ok(commands.length, 'embedding verification command exists');
  const root = mkdtempSync(path.join(tmpdir(), 'install-guide-probe-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ embeddings: [Array(1024).fill(0.25)] }));
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const rel of ['scripts/lib/harness-config.mjs', 'scripts/memory/embed-recipe.mjs']) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      copyFileSync(path.join(repoRoot, rel), path.join(root, rel));
    }
    mkdirSync(path.join(root, 'ops/bootstrap'), { recursive: true });
    writeFileSync(path.join(root, 'ops/bootstrap/harness.config.json'), JSON.stringify({
      names: { prefix: 'probe' }, memory: { embed: { url, model: 'qwen3-embedding:0.6b' } },
    }));
    for (const command of commands) {
      const source = command.match(/^node --input-type=module -e '([^']+)'$/)?.[1];
      assert.ok(source, 'copyable POSIX one-liner');
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { cwd: root, timeout: 10000 });
      assert.equal(result.stdout.trim(), '1024');
    }
    assert.equal(requests.length, commands.length);
    for (const request of requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/embed');
      assert.equal(request.body.model, 'qwen3-embedding:0.6b');
      assert.deepEqual(request.body.input, ['probe']);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
