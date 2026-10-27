import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Minimatch } from 'minimatch';
import { git } from './git-env.mjs';
import { isMain } from './lib/is-main.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Coverage policy is hand-kept by the lead; the registry remains generated
// solely from contract headers. Open areas report gaps without failing.
const REQUIRED_HEADER_KEYS = ['id', 'owner', 'paths', 'entry', 'layer'];
const OPTIONAL_HEADER_KEYS = ['sideEffectEntries', 'workerEntries', 'serverEntries'];
// Canonical order, also the order a contract summary renders.
// Legacy `depends` is accepted but ignored for older worktrees (task 2996).
const HEADER_KEYS = ['id', 'owner', 'paths', 'entry', 'layer', ...OPTIONAL_HEADER_KEYS];
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0 && value === value.trim();
const repoPath = (value) => nonempty(value) && !value.includes('\\') &&
  !path.posix.isAbsolute(value) && !/^[a-z]:/i.test(value) &&
  !value.split('/').some((part) => part === '..' || part === '.' || part === '');

export function headerFault(header, { strict = true } = {}) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) return 'expected a mapping';
  // Non-strict readers (a daemon running older code) ignore header keys added
  // after their parser was loaded; missing required keys still fault.
  if (REQUIRED_HEADER_KEYS.some((key) => !Object.hasOwn(header, key)) ||
      (strict && Object.keys(header).some((key) => key !== 'depends' && !HEADER_KEYS.includes(key)))) return `expected keys: ${REQUIRED_HEADER_KEYS.join(', ')}; optional: ${OPTIONAL_HEADER_KEYS.join(', ')}`;
  if (!nonempty(header.id) || !nonempty(header.layer)) return 'id and layer must be non-empty strings';
  if (!nonempty(header.owner) || !/^domain-[a-z0-9-]+$/.test(header.owner)) return 'owner must be a domain directory name';
  if (!Array.isArray(header.paths) || !header.paths.length || !header.paths.every(repoPath)) return 'paths must be a non-empty array of repo-relative globs';
  if (!repoPath(header.entry)) return 'entry must be a repo-relative path';
  for (const key of OPTIONAL_HEADER_KEYS) {
    if (!Object.hasOwn(header, key)) continue;
    const entries = header[key];
    if (!Array.isArray(entries) || !entries.length || !entries.every(repoPath)) return `${key} must be a non-empty array of repo-relative paths`;
    if (entries.includes(header.entry)) return `${key} must not include entry`;
    if (new Set(entries).size !== entries.length) return `${key} must not contain duplicates`;
  }
  return null;
}

function isContract(file) {
  return /(^|\/)CONTRACT\.md$/.test(file) ||
    /^src\/utils\/[^/]+\.CONTRACT\.md$/.test(file) ||
    /^docs\/contracts\/modules\/[^/]+\.md$/.test(file);
}

function discoverContracts(rootDir) {
  return [...new Set(git(['-C', rootDir, 'ls-files', '-z',
    '--cached', '--others', '--exclude-standard', '--',
    ':(glob)**/CONTRACT.md', ':(glob)src/utils/*.CONTRACT.md',
    ':(glob)docs/contracts/modules/*.md'], {
    maxBuffer: 32 * 1024 * 1024,
  }).split('\0').filter(isContract))].sort(compare);
}

function globMatcher() {
  const matchers = new Map();
  return (file, glob) => {
    if (!matchers.has(glob)) {
      const matcher = new Minimatch(glob, { dot: true, nonegate: true, nocomment: true });
      // Most contracts list literal files or deeply rooted globs. Avoid
      // splitting every tracked path for every unrelated contract pattern.
      // Use parsed segments, not a second glob grammar (braces/escapes matter).
      const prefixes = matcher.set.map(parts => {
        const end = parts.findIndex(part => typeof part !== 'string');
        return { literal: end === -1, prefix: parts.slice(0, end === -1 ? parts.length : end).join('/') };
      });
      matchers.set(glob, file => prefixes.some(({ literal, prefix }) => literal
        ? file === prefix
        : (!prefix || file === prefix || file.startsWith(`${prefix}/`)) && matcher.match(file)));
    }
    return matchers.get(glob)(file);
  };
}

// Stop at the frontmatter delimiter: lookups need no body, coverage policy or
// tracked-file assignment pass. Chunk boundaries must not split UTF-8 text.
export function readContractHeader(rootDir, contract, { strict = true } = {}) {
  const fd = fs.openSync(path.join(rootDir, contract), 'r');
  try {
    const chunks = [];
    while (true) {
      const chunk = Buffer.alloc(1024);
      const size = fs.readSync(fd, chunk, 0, chunk.length, null);
      chunks.push(chunk.subarray(0, size));
      const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
      if (!/^---\r?\n/.test(text)) return null;
      const lines = text.split(/\r?\n/);
      const end = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line));
      // A chunk may end part-way through a delimiter's line.
      if (end !== -1 && (end < lines.length - 1 || size === 0)) {
        const header = parse(lines.slice(1, end).join('\n'));
        const fault = headerFault(header, { strict });
        if (fault) throw new Error(fault);
        return header;
      }
      if (size === 0) throw new Error('unterminated YAML header');
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Header-only index, including unstaged contracts, suitable for hook caching. */
export function moduleIndex(rootDir, { strict = true } = {}) {
  const modules = [];
  for (const contract of discoverContracts(rootDir)) {
    const header = readContractHeader(rootDir, contract, { strict });
    if (header) {
      modules.push({
        id: header.id, owner: header.owner, layer: header.layer, entry: header.entry, contract,
        globs: header.paths,
      });
    }
  }
  return modules.sort((a, b) => compare(a.id, b.id) || compare(a.contract, b.contract));
}

/** Resolve even new paths from headers, or a caller's cached header index. */
export function moduleForPath(rootDir, relPath, index = null, { strict = true } = {}) {
  const headers = index ?? moduleIndex(rootDir, { strict });
  const matchesGlob = globMatcher();
  const matches = headers.filter(({ globs }) => globs.some((glob) => matchesGlob(relPath, glob)))
    .sort((a, b) => compare(a.id, b.id) || compare(a.contract, b.contract));
  if (!matches.length) return null;
  const { id, owner, layer, entry, contract } = matches[0];
  return { id, owner, layer, entry, contract,
    ...(matches.length > 1 ? { conflicts: matches.map(({ id }) => id) } : {}) };
}

/** Header and Public API only; the pointer and its newline count in the cap. */
export function contractSummary(rootDir, contractPath, maxBytes, { strict = true } = {}) {
  const header = readContractHeader(rootDir, contractPath, { strict });
  if (!header) throw new Error(`${contractPath}: no module header`);
  const text = fs.readFileSync(path.join(rootDir, contractPath), 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## Public API[ \t]*$/.test(line));
  const end = lines.findIndex((line, index) => index > start && /^##[ \t]+/.test(line));
  const api = start < 0 ? `no Public API section; read ${contractPath}` :
    lines.slice(start, end < 0 ? undefined : end).join('\n').trimEnd();
  const summary = [
    '---', ...HEADER_KEYS.filter((key) => REQUIRED_HEADER_KEYS.includes(key) || Object.hasOwn(header, key))
      .map((key) => `${key}: ${JSON.stringify(header[key])}`),
    '---', '', api,
  ].join('\n');
  if (Buffer.byteLength(summary) <= maxBytes) return summary;
  const marker = `... cut at ${maxBytes} bytes; read ${contractPath}`;
  if (Buffer.byteLength(marker) > maxBytes) throw new RangeError('module budget cannot fit the read pointer');
  const kept = [];
  let bytes = Buffer.byteLength(marker);
  for (const line of summary.split('\n')) {
    const cost = Buffer.byteLength(line) + 1;
    if (bytes + cost > maxBytes) break;
    kept.push(line);
    bytes += cost;
  }
  return [...kept, marker].join('\n');
}

function coveragePolicy(rootDir) {
  const file = 'docs/architecture/module-coverage.json';
  const policy = JSON.parse(fs.readFileSync(path.join(rootDir, file), 'utf8'));
  if (!policy || !Array.isArray(policy.exclude) ||
      !policy.exclude.every((item) => item && repoPath(item.glob) && nonempty(item.reason)) ||
      !Array.isArray(policy.closed) || !policy.closed.every(repoPath) ||
      (Object.hasOwn(policy, 'coverageClosed') &&
        (!Array.isArray(policy.coverageClosed) || !policy.coverageClosed.every(repoPath))) ||
      !Array.isArray(policy.layers) || !policy.layers.length || !policy.layers.every(nonempty)) {
    throw new Error(`${file}: expected exclude [{glob, reason}], closed globs, optional coverageClosed globs and non-empty layers`);
  }
  return policy;
}

/** Headers are the source of truth; files are always repo-relative tracked paths. */
export function buildRegistry(rootDir = ROOT, { paths = null } = {}) {
  const policy = coveragePolicy(rootDir);
  // All registry globs include tracked dotfiles, including hidden directories.
  const matchesGlob = globMatcher();
  const tracked = [...new Set(git(['-C', rootDir, 'ls-files', '-z'], {
    maxBuffer: 32 * 1024 * 1024,
  }).split('\0').filter(Boolean))].sort(compare);
  // Discover unstaged contracts too: an R2 author can validate before git add.
  // Only the separate tracked list above participates in file assignments.
  const contracts = discoverContracts(rootDir);
  const modules = [];
  const contractsWithoutHeader = [];
  const warnings = [];
  const errors = [];
  for (const contract of contracts) {
    try {
      const header = readContractHeader(rootDir, contract);
      if (!header) {
        contractsWithoutHeader.push(contract);
        continue;
      }
      if (Object.hasOwn(header, 'depends')) {
        warnings.push(`${contract}: depends is ignored (task 2996); delete the line`);
      }
      // Canonical key order makes output independent of the order in YAML.
      modules.push({
        id: header.id, owner: header.owner, paths: header.paths, entry: header.entry,
        sideEffectEntries: header.sideEffectEntries ?? [],
        ...Object.fromEntries(['workerEntries', 'serverEntries'].filter((key) => Object.hasOwn(header, key))
          .map((key) => [key, header[key]])),
        layer: header.layer, contract,
        files: tracked.filter((file) => header.paths.some((glob) => matchesGlob(file, glob))),
      });
    } catch (error) {
      // File I/O faults, unlike header schema faults, have always escaped the
      // registry pass and are reported by the CLI's outer handler.
      if (typeof error.errno === 'number') throw error;
      errors.push(`${contract}: header schema: ${error.message}`);
    }
  }
  modules.sort((a, b) => compare(a.id, b.id) || compare(a.contract, b.contract));
  const byId = new Map();
  const assignments = new Map();
  const trackedSet = new Set(tracked);
  for (const module of modules) {
    if (byId.has(module.id)) errors.push(`duplicate id ${module.id}: ${byId.get(module.id).contract}, ${module.contract}`);
    else byId.set(module.id, module);
    if (!policy.layers.includes(module.layer)) {
      errors.push(`${module.contract}: layer ${module.layer} is not allowed`);
    }
    if (!trackedSet.has(module.entry)) {
      errors.push(`${module.contract}: entry is not tracked: ${module.entry}`);
    } else if (!module.files.includes(module.entry)) {
      errors.push(`${module.contract}: entry outside own module paths: ${module.entry}`);
    }
    for (const key of OPTIONAL_HEADER_KEYS) {
      for (const entry of module[key] ?? []) {
        if (!trackedSet.has(entry)) {
          errors.push(`${module.contract}: ${key} file is not tracked: ${entry}`);
        } else if (!module.files.includes(entry)) {
          errors.push(`${module.contract}: ${key} file outside own module paths: ${entry}`);
        } else if (key !== 'sideEffectEntries' &&
            (!fs.existsSync(path.join(rootDir, entry)) || !fs.statSync(path.join(rootDir, entry)).isFile())) {
          errors.push(`${module.contract}: ${key} file does not exist: ${entry}`);
        }
      }
    }
    const ownerDir = path.join(rootDir, '.agents/domains', module.owner);
    if (!fs.existsSync(ownerDir) || !fs.statSync(ownerDir).isDirectory()) {
      errors.push(`${module.contract}: owner is not a domain directory: ${module.owner}`);
    }
    for (const file of module.files) {
      if (assignments.has(file)) {
        if (paths === null || paths.has(file)) {
          errors.push(`tracked file matched by two modules: ${file} (${assignments.get(file)}, ${module.id})`);
        }
      } else assignments.set(file, module.id);
    }
  }
  const coverage = new Map();
  for (const file of tracked) {
    const top = file.includes('/') ? file.split('/')[0] : '.';
    if (!coverage.has(top)) coverage.set(top, { tracked: 0, excluded: 0, covered: 0, uncovered: 0 });
    const counts = coverage.get(top);
    counts.tracked++;
    if (policy.exclude.some(({ glob }) => matchesGlob(file, glob))) counts.excluded++;
    else if (assignments.has(file)) counts.covered++;
    else {
      counts.uncovered++;
      if ((paths === null || paths.has(file)) &&
          (policy.coverageClosed ?? []).some((glob) => matchesGlob(file, glob))) {
        errors.push(`closed area has uncovered tracked file: ${file}`);
      }
    }
  }
  return {
    registry: { version: 1, modules, contractsWithoutHeader },
    coverage: [...coverage].sort(([a], [b]) => compare(a, b)),
    errors,
    warnings,
  };
}

function renderIndex(modules) {
  const lines = [
    '# Module index',
    '',
    'Every module of the project and its contract (task 2409, plan memory 19503). Generated from the contract headers by `node scripts/module-registry.mjs --write-index` (task 2969): do not edit it by hand; `npm run check:module-registry` fails when it is stale. `node scripts/module-registry.mjs` writes the full registry to the ignored `artifacts/module-registry.json`.',
  ];
  for (const layer of [...new Set(modules.map((module) => module.layer))].sort(compare)) {
    lines.push('', `## ${layer}`, '');
    for (const module of modules.filter((module) => module.layer === layer)
      .sort((a, b) => compare(a.id, b.id))) {
      const contract = path.posix.relative('docs/contracts', module.contract).split('/')
        .map((part) => encodeURIComponent(part).replaceAll('(', '%28').replaceAll(')', '%29')).join('/');
      lines.push(`- [${module.id}](${contract}) — ${module.owner}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  let check = false;
  let writeIndex = false;
  let pathspec = null;
  let out = path.join(ROOT, 'artifacts/module-registry.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--write-index') writeIndex = true;
    else if (args[i] === '--out' && args[i + 1] && !args[i + 1].startsWith('--')) out = path.resolve(args[++i]);
    else if (args[i] === '--paths') {
      pathspec = args.slice(i + 1);
      if (!pathspec.length || pathspec.some((value) => value.startsWith('--'))) {
        throw new Error('--paths needs one or more paths');
      }
      break;
    }
    else throw new Error(`unknown or incomplete argument: ${args[i]}`);
  }
  if (pathspec !== null && !check) throw new Error('--paths requires --check');
  if (check && writeIndex) throw new Error('--write-index cannot be combined with --check');
  // Let Git resolve directories, globs, magic and absolute names, as the
  // boundary ratchet does. Untracked/deleted names cannot have file faults.
  const paths = pathspec === null ? null : new Set(git([
    '-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspec,
  ], { maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean));
  const { registry, coverage, errors, warnings } = buildRegistry(ROOT, { paths });
  for (const [top, counts] of coverage) {
    console.log(`coverage ${top}: tracked=${counts.tracked} excluded=${counts.excluded} covered=${counts.covered} uncovered=${counts.uncovered}`);
  }
  for (const contract of registry.contractsWithoutHeader) console.log(`contract without header: ${contract}`);
  if (check) for (const warning of warnings) console.log(warning);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  const indexPath = path.join(ROOT, 'docs/contracts/module-index.md');
  const index = renderIndex(registry.modules);
  if (check && (!fs.existsSync(indexPath) || fs.readFileSync(indexPath, 'utf8') !== index)) {
    console.error('docs/contracts/module-index.md is stale or missing; run node scripts/module-registry.mjs --write-index');
    process.exitCode = 1;
    return;
  }
  if (writeIndex) {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, index);
  } else if (!check) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(registry, null, 2)}\n`);
  }
  console.log(`module registry: ${registry.modules.length} modules; ${registry.contractsWithoutHeader.length} contracts without header; OK`);
}

if (isMain(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
