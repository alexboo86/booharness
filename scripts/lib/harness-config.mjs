// Synchronous checkout config, with no external dependencies.
// Hook call sites must catch errors and stay fail-open. A daemon-side consumer
// needs FILE_TARGETS entries for both this reader and the config file.
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Project policy is opt-in. In particular, no absent list grants new deletion
// permissions; the sole default sweep path is Cargo's conventional target.
export const PROJECT_DEFAULTS = Object.freeze({
  macOnlyPaths: Object.freeze([]),
  noWinPaths: Object.freeze([]),
  productRoots: Object.freeze([]),
  generatedPaths: Object.freeze([]),
  cacheDirs: Object.freeze([]),
  targetDirs: Object.freeze(['target']),
  stateTargetDirs: Object.freeze([]),
  anchorRoots: Object.freeze([]),
  probeRoots: Object.freeze([]),
  sharedBuildDirs: Object.freeze([]),
  productionMcp: '',
  productionHosts: Object.freeze([]),
  productionTools: Object.freeze([]),
  diagnosticCommands: Object.freeze([]),
});

const PROJECT_SCHEMA = Object.fromEntries(Object.entries(PROJECT_DEFAULTS)
  .map(([key, value]) => [`project.${key}`, Array.isArray(value) ? 'array' : 'string']));

/** The checkout containing the harness owns its policy; callers may name another repository. */
export function projectConfig({ repoRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const file = path.join(repoRoot, 'ops/bootstrap/harness.config.json');
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return PROJECT_DEFAULTS;
    throw error;
  }
  const config = checkHarnessConfigText(text, { file, repoRoot });
  return Object.freeze({ ...PROJECT_DEFAULTS, ...config.project });
}

function validateProjectEntry(key, value, file) {
  const leaf = key.slice('project.'.length);
  const identifier = ['productionMcp', 'productionHosts', 'productionTools', 'diagnosticCommands'].includes(leaf);
  // stateTargetDirs entries are patterns relative to ~/.local/state: the safe-path
  // rule plus ONE trailing `*` of the last segment. The star is stripped here, so a
  // `*` anywhere else — or a second one — stays refused by the rule itself.
  const starred = leaf === 'stateTargetDirs' && typeof value === 'string' && value.endsWith('*');
  const entry = starred ? value.slice(0, -1) : value;
  const valid = typeof entry === 'string' && entry.length <= 1024 && (identifier
    ? (leaf === 'productionMcp' && entry === '') || /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(entry)
    : entry.length > 0 && !/[\x00-\x1f\x7f\\:*?<>|"]/u.test(entry) &&
      !path.posix.isAbsolute(entry) && entry.split('/').every((part) => part && part !== '.' && part !== '..' && !part.startsWith('-')));
  if (!valid) throw new Error(`Harness config ${file}: ${key} must contain safe ${leaf === 'stateTargetDirs' ? 'state-relative target patterns' : identifier ? 'identifiers' : 'repo-relative paths'}`);
}

// Seat families, the same eight as FAMILIES in ops/orchestrator/src/providers/types.ts.
// Hooks load this file, so it cannot import that module. A test compares the two.
export const HARNESS_FAMILIES = Object.freeze([
  'claude', 'glm', 'codex', 'grok', 'kimi', 'opencode', 'qwen', 'mimo',
]);

export const HARNESS_CONFIG_SCHEMA = Object.freeze({
  'memory.embed.model': 'string',
  'memory.embed.url': 'string',
  'memory.rerank': 'string',
  'names.prefix': 'string',
  'install.userEntries': 'string',
  'families.enabled': 'array',
  'mcp.off': 'array',
  'skills.off': 'array',
  'skills.lead': 'array',
  'lead.replyLanguage': 'string',
  'lead.userTextFile': 'string',
  'lead.plainStyle': 'boolean',
  'lead.briefLanguage': 'string',
  // "off" or an integer 1..65535: a union, judged by lanPortRefusal, not a typeof.
  'orch.lanPort': 'string',
  ...PROJECT_SCHEMA,
});

// Absent leaves pass. A branch passes when every leaf under it is in this set,
// so the old special case for `install` is the one row `install.userEntries`.
const OPTIONAL_LEAVES = new Set(['install.userEntries', 'memory.embed.url', 'memory.rerank', 'families.enabled', 'mcp.off', 'skills.off', 'skills.lead', 'lead.replyLanguage', 'lead.userTextFile', 'lead.plainStyle', 'lead.briefLanguage', 'orch.lanPort', ...Object.keys(PROJECT_SCHEMA)]);

// One rule for an embedding URL that may land in a world-readable launchd plist.
export function embedUrlRefusal(value) {
  let url;
  try { url = new URL(value); }
  catch { return 'expects an http(s) URL'; }
  if (typeof value !== 'string' || !['http:', 'https:'].includes(url.protocol)
    || !url.hostname || /[\x00-\x20\x7f]/.test(value)) {
    return 'expects an http(s) URL';
  }
  if (url.username || url.password || /^https?:\/\/[^/]*@/i.test(value)
    || value.includes('?') || value.includes('#')) {
    return 'must not contain userinfo, a query string or a fragment: launchd plists are public';
  }
  return null;
}

// The read-only LAN board: "off" disables it, an integer port 1..65535 enables
// it. The value goes verbatim into ORCH_LAN_PORT in the launchd plist, and as
// --lan-port on the Windows task command (renderTaskXml; the task has no environment).
// Also the refusal of the wizard's machines step, so the rule has one copy.
export function lanPortRefusal(value) {
  if (value === 'off' || (Number.isInteger(value) && value >= 1 && value <= 65535)) return null;
  return 'must be "off" or an integer from 1 to 65535';
}

function validateFamilies(value, file) {
  if (value.length === 0) {
    throw new Error(`Harness config ${file}: families.enabled must list at least one family`);
  }
  const seen = new Set();
  for (const name of value) {
    if (typeof name !== 'string' || !HARNESS_FAMILIES.includes(name)) {
      throw new Error(`Harness config ${file}: families.enabled unknown family ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) {
      throw new Error(`Harness config ${file}: families.enabled duplicate family ${JSON.stringify(name)}`);
    }
    seen.add(name);
  }
}

// mcp.off names servers of the MCP SSOT, so its check needs that file. Read
// only when an entry is actually judged: an absent or empty key keeps the
// reader free of this dependency, and the fail-open hook callers keep their
// today's behavior unless the user opted in.
function loadMcpServers(repoRoot) {
  const file = path.resolve(repoRoot, 'ops', 'bootstrap', 'mcp-servers.json');
  let ssot;
  try {
    ssot = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read MCP server list ${file}: ${error.message}`, { cause: error });
  }
  if (!ssot || typeof ssot !== 'object' || Array.isArray(ssot)
    || !ssot.servers || typeof ssot.servers !== 'object' || Array.isArray(ssot.servers)) {
    throw new Error(`Invalid MCP server list ${file}: expected a servers object`);
  }
  return ssot.servers;
}

function validateMcpOff(value, file, servers) {
  for (const name of value) {
    if (typeof name !== 'string') {
      throw new Error(`Harness config ${file}: mcp.off entries must be strings`);
    }
    if (!Object.hasOwn(servers, name)) {
      throw new Error(`Harness config ${file}: mcp.off names '${name}', which is not a server of ops/bootstrap/mcp-servers.json`);
    }
    if (servers[name].required) {
      throw new Error(`Harness config ${file}: mcp.off cannot turn off the required server '${name}'`);
    }
  }
}

// skills.off and skills.lead name skills of the skill map, so their checks need
// that file. Read only when an entry is actually judged, as for mcp.off. Also the
// default probe of the wizard's skills step, so the map shape has one copy.
export function loadSkillMap(repoRoot) {
  const mapFile = path.resolve(repoRoot, '.agents/domains/_skill-map.json');
  let map;
  try {
    map = JSON.parse(readFileSync(mapFile, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read skill map ${mapFile}: ${error.message}`, { cause: error });
  }
  if (!map?.skills || typeof map.skills !== 'object' || Array.isArray(map.skills)) {
    throw new Error(`Invalid skill map ${mapFile}: expected a skills object`);
  }
  return { map, mapFile };
}

// One group per class, core first (it is the fixed, always-on group), the rest
// by class name so the wizard's questions are deterministic. Names inside a group too.
export function skillClassGroups(map, mapFile) {
  const groups = new Map();
  for (const [name, entry] of Object.entries(map.skills)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.class !== 'string') {
      throw new Error(`Invalid skill map ${mapFile}: entry '${name}' must be an object with a string class`);
    }
    if (!groups.has(entry.class)) groups.set(entry.class, []);
    groups.get(entry.class).push(name);
  }
  return [...groups.entries()]
    .map(([label, names]) => ({ label, names: names.sort() }))
    .sort((a, b) => (a.label === 'core' ? -1 : b.label === 'core' ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

// skills.off as the wizard's skills step spells it: class by class in the
// order of its questions, the given order inside a class.
export function skillsOffByClass(groups, off) {
  return groups.filter((group) => group.label !== 'core')
    .flatMap((group) => off.filter((name) => group.names.includes(name)));
}

// mcp.off as the wizard's MCP step spells it: an empty list is an absent key.
export function withMcpOff(config, off) {
  const next = structuredClone(config);
  if (off.length === 0) {
    if (next.mcp && typeof next.mcp === 'object' && !Array.isArray(next.mcp)) {
      delete next.mcp.off;
      if (Object.keys(next.mcp).length === 0) delete next.mcp;
    }
    return next;
  }
  const mcp = next.mcp && typeof next.mcp === 'object' && !Array.isArray(next.mcp) ? next.mcp : {};
  next.mcp = { ...mcp, off: [...off] };
  return next;
}

// The spelling the setup wizard gives a saved config when every answer is the
// default: it drops an empty mcp.off and it regroups skills.off; it keeps an
// empty skills.off. The config verbs publish this spelling too, so an agent
// that follows the install prompt writes the bytes the wizard writes. A value
// that the rules refuse stays as it is: the reader names it.
export function wizardSpelling({ repoRoot, config }) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return config;
  let next = config;
  if (Array.isArray(next.mcp?.off) && next.mcp.off.length === 0) next = withMcpOff(next, []);
  const off = next.skills?.off;
  if (Array.isArray(off) && off.length > 1 && off.every((name) => typeof name === 'string')) {
    const { map, mapFile } = loadSkillMap(repoRoot);
    const ordered = skillsOffByClass(skillClassGroups(map, mapFile), off);
    if (ordered.length === off.length) next = { ...next, skills: { ...next.skills, off: ordered } };
  }
  return next;
}

function validateSkillsOff(value, file, repoRoot) {
  const { map, mapFile } = loadSkillMap(repoRoot);
  const seen = new Set();
  for (const name of value) {
    if (typeof name !== 'string') {
      throw new Error(`Harness config ${file}: skills.off entry '${String(name)}' must be a string`);
    }
    if (!Object.hasOwn(map.skills, name)) {
      throw new Error(`Harness config ${file}: skills.off names '${name}', which is not a skill of .agents/domains/_skill-map.json`);
    }
    const entry = map.skills[name];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.class !== 'string') {
      throw new Error(`Invalid skill map ${mapFile}: entry '${name}' must be an object with a string class`);
    }
    if (seen.has(name)) {
      throw new Error(`Harness config ${file}: skills.off has duplicate entry '${name}'`);
    }
    if (entry.class === 'core') {
      throw new Error(`Harness config ${file}: skills.off cannot turn off the core skill '${name}'`);
    }
    seen.add(name);
  }
}

function validateSkillsLead(value, file, repoRoot, off) {
  const { map } = loadSkillMap(repoRoot);
  const seen = new Set();
  for (const name of value) {
    if (typeof name !== 'string') {
      throw new Error(`Harness config ${file}: skills.lead entry '${String(name)}' must be a string`);
    }
    if (!Object.hasOwn(map.skills, name)) {
      throw new Error(`Harness config ${file}: skills.lead names '${name}', which is not a skill of .agents/domains/_skill-map.json`);
    }
    if (seen.has(name)) {
      throw new Error(`Harness config ${file}: skills.lead has duplicate entry '${name}'`);
    }
    if (off.includes(name)) {
      throw new Error(`Harness config ${file}: skills.lead names '${name}', which skills.off turns off`);
    }
    // One managed link of a support-lead skill tells the drift check and the
    // session start that the whole support set was installed.
    if (Array.isArray(map.supportLeadSkills) && map.supportLeadSkills.includes(name)) {
      throw new Error(`Harness config ${file}: skills.lead names '${name}', which is a skill of supportLeadSkills; the installer flag --support-lead installs that set`);
    }
    seen.add(name);
  }
}

// The skills a lead runtime is promised, for one checkout's skill map and the
// skills.lead list of its config. With the key absent it is the map's own
// list. With the key present it is the user's list plus each class core skill
// of the map's list: no config takes a core skill from a lead.
export function effectiveLeadSkills({ map, lead }) {
  if (lead === undefined) return map.leadInstalledSkills;
  const core = map.leadInstalledSkills.filter((name) => map.skills?.[name]?.class === 'core');
  return [...new Set([...core, ...lead])];
}

// For a verb that removes one key: it can name the key that it refuses.
export function harnessKeyIsOptional(key) {
  return OPTIONAL_LEAVES.has(key);
}

function absentIsAllowed(key, schemaKeys) {
  if (OPTIONAL_LEAVES.has(key)) return true;
  const prefix = key ? `${key}.` : '';
  const under = schemaKeys.filter((entry) => entry.startsWith(prefix) && entry !== key);
  return under.length > 0 && under.every((entry) => OPTIONAL_LEAVES.has(entry));
}

function validatePrefix(prefix) {
  if (typeof prefix !== 'string' || !/^[a-z][a-z0-9-]*$/.test(prefix)) {
    throw new Error('names.prefix must match ^[a-z][a-z0-9-]*$');
  }
  if (prefix.length > 32) {
    throw new Error('names.prefix must be at most 32 characters');
  }
}

function validateReplyLanguage(value, file) {
  if (!/^[\p{L} -]{2,40}$/u.test(value) || !/\p{L}/u.test(value)) {
    throw new Error(`Harness config ${file}: lead.replyLanguage must be a language name of letters, spaces and hyphens, 2 to 40 characters`);
  }
}

function validateUserTextFile(value, file) {
  if (value.length < 1 || value.length > 1024 || /\p{Cc}/u.test(value)) {
    throw new Error(`Harness config ${file}: lead.userTextFile must be a path of 1 to 1024 characters with no control character`);
  }
}

export function harnessPaths({ prefix, home }) {
  validatePrefix(prefix);
  return {
    cacheDir: path.join(home, '.cache', prefix),
    stateDir: path.join(home, '.local', 'state', prefix),
    shareDir: path.join(home, '.local', 'share', prefix),
    secretsFile: path.join(home, '.claude', `${prefix}-secrets.env`),
  };
}

export function harnessLabel({ prefix, name }) {
  validatePrefix(prefix);
  return `com.${prefix}.${name}`;
}

export function harnessTaskName({ prefix }) {
  validatePrefix(prefix);
  return `${String.fromCharCode(prefix.charCodeAt(0) - 32)}${prefix.slice(1)}Memoryctl`;
}

export function readHarnessConfig({ repoRoot, overridePath }) {
  const file = path.resolve(repoRoot, overridePath ?? 'ops/bootstrap/harness.config.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read harness config ${file}: ${error.message}`, { cause: error });
  }
  return checkHarnessConfigText(text, { file, repoRoot });
}

// The rules of the config, applied to its bytes: the reader gives the bytes of
// the file, the writer gives the bytes that it is about to publish.
function checkHarnessConfigText(text, { file, repoRoot }) {
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in harness config ${file}: ${error.message}`, { cause: error });
  }
  const keys = Object.keys(HARNESS_CONFIG_SCHEMA);
  let mcpServers = null;
  function validate(value, key = '') {
    if (value === undefined && absentIsAllowed(key, keys)) return;
    if (Object.hasOwn(HARNESS_CONFIG_SCHEMA, key)) {
      const type = HARNESS_CONFIG_SCHEMA[key];
      // typeof [] is 'object', and an object leaf returns before Object.freeze,
      // so an array key cannot be declared 'object': null and a mutable array would pass.
      if (type === 'array') {
        if (!Array.isArray(value)) throw new Error(`Harness config ${file}: ${key} must be an array`);
        if (key.startsWith('project.')) {
          const seen = new Set();
          for (const entry of value) {
            validateProjectEntry(key, entry, file);
            if (seen.has(entry)) throw new Error(`Harness config ${file}: ${key} has a duplicate entry`);
            seen.add(entry);
          }
        }
        if (key === 'families.enabled') validateFamilies(value, file);
        if (key === 'mcp.off' && value.length > 0) {
          if (mcpServers === null) mcpServers = loadMcpServers(repoRoot);
          validateMcpOff(value, file, mcpServers);
        }
        if (key === 'skills.off' && value.length > 0) validateSkillsOff(value, file, repoRoot);
        if (key === 'skills.lead' && value.length > 0) {
          const off = config.skills.off;
          validateSkillsLead(value, file, repoRoot, Array.isArray(off) ? off : []);
        }
        Object.freeze(value);
        return;
      }
      // A union leaf: the typeof check cannot say "string or integer", so the
      // value is judged here and returns before the type comparison.
      if (key === 'orch.lanPort') {
        const reason = lanPortRefusal(value);
        if (reason) throw new Error(`Harness config ${file}: orch.lanPort ${reason}`);
        return;
      }
      if (typeof value !== type) throw new Error(`Harness config ${file}: ${key} must be ${type}`);
      if (key.startsWith('project.')) validateProjectEntry(key, value, file);
      if (key === 'install.userEntries' && !['replace', 'keep'].includes(value)) {
        throw new Error(`Harness config ${file}: ${key} must be replace or keep`);
      }
      if (key === 'names.prefix') {
        try { validatePrefix(value); }
        catch (error) { throw new Error(`Harness config ${file}: ${error.message}`, { cause: error }); }
      }
      if (key === 'memory.embed.url') {
        const reason = embedUrlRefusal(value);
        if (reason) throw new Error(`Harness config ${file}: ${key} ${reason}`);
      }
      if (key === 'memory.rerank' && !['local', 'off'].includes(value)) {
        throw new Error(`Harness config ${file}: ${key} must be local or off`);
      }
      if (key === 'lead.replyLanguage') validateReplyLanguage(value, file);
      if (key === 'lead.userTextFile') validateUserTextFile(value, file);
      if (key === 'lead.briefLanguage' && !['off', 'flag', 'enforce'].includes(value)) {
        throw new Error(`Harness config ${file}: ${key} must be off, flag or enforce`);
      }
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Harness config ${file}: ${key || '<root>'} must be an object`);
    }
    const prefix = key ? `${key}.` : '';
    const children = new Set(keys.filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length).split('.')[0]));
    for (const child of Object.keys(value)) {
      if (!children.has(child)) throw new Error(`Harness config ${file}: unknown key ${prefix}${child}`);
    }
    for (const child of children) validate(value[child], `${prefix}${child}`);
    Object.freeze(value);
  }
  validate(config);
  return config;
}

// The top-level order of the tracked file. A branch that is not named here
// follows in schema order, and the keys of a branch are in schema order.
const CANONICAL_TOP = ['install', 'names', 'memory'];

function canonicalChildren(prefix) {
  const names = [...new Set(Object.keys(HARNESS_CONFIG_SCHEMA).filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length).split('.')[0]))];
  if (prefix) return names;
  return [...CANONICAL_TOP.filter((name) => names.includes(name)), ...names.filter((name) => !CANONICAL_TOP.includes(name))];
}

// One key order for one content. A list keeps its own order: it is content.
// A key that the schema does not know stays, sorted, so that the rules refuse it.
function canonicalOrder(value, key = '') {
  if (Object.hasOwn(HARNESS_CONFIG_SCHEMA, key) || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const prefix = key ? `${key}.` : '';
  const known = canonicalChildren(prefix);
  // No prototype: a key named __proto__ stays an own key and is refused as unknown.
  const ordered = Object.create(null);
  for (const child of [...known, ...Object.keys(value).filter((name) => !known.includes(name)).sort()]) {
    if (!Object.hasOwn(value, child)) continue;
    const next = canonicalOrder(value[child], `${prefix}${child}`);
    // An empty branch says what an absent branch says, so it has one spelling: absent.
    const branch = known.includes(child) && !Object.hasOwn(HARNESS_CONFIG_SCHEMA, `${prefix}${child}`);
    if (branch && next !== null && typeof next === 'object' && !Array.isArray(next) && Object.keys(next).length === 0) continue;
    ordered[child] = next;
  }
  return ordered;
}

// One validated spelling for publication and previews. This does not mutate
// the supplied config or publish bytes; checks use the reader's rules.
export function canonicalHarnessConfigText({ repoRoot, config }) {
  const file = path.resolve(repoRoot, 'ops/bootstrap/harness.config.json');
  const text = `${JSON.stringify(canonicalOrder(config), null, 2)}\n`;
  checkHarnessConfigText(text, { file, repoRoot });
  return text;
}

// The file that a write replaces. A link to a file is written through: the
// temp file sits beside the link's target and the link stays.
function writeTarget(file) {
  try {
    return realpathSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read harness config ${file}: ${error.message}`, { cause: error });
  }
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Cannot read harness config ${file}: it is a link with no target`);
  }
  return file;
}

// A killed write leaves its temp file. The caller holds the lock, and a temp
// file carries the pid of its writer: one of a dead pid has no owner. One of a
// live pid stays, because a writer under the lock of another home can own it.
function removeDeadTemps(target) {
  const base = `${path.basename(target)}.`;
  let names;
  try {
    names = readdirSync(path.dirname(target));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    const match = name.startsWith(base) && /^(\d+)\.[0-9a-f]{12}\.tmp$/.exec(name.slice(base.length));
    if (!match) continue;
    try {
      process.kill(Number(match[1]), 0);
    } catch (error) {
      if (error.code !== 'ESRCH') continue;
      try { unlinkSync(path.join(path.dirname(target), name)); }
      catch (gone) { if (gone.code !== 'ENOENT') throw gone; }
    }
  }
}

// The one writer of ops/bootstrap/harness.config.json. `config` is the whole
// config, or a function from the parsed file to the whole config (it runs with
// the lock held, so a change of one key cannot lose another writer's change).
// The bytes pass the reader's rules before they replace the file; a refusal
// throws and leaves the old file whole. `home` is the home directory that an
// installer run would write: its lock keeps a write out of an install run, and
// the lock of a dead pid (a killed write) is taken over.
export async function writeHarnessConfig({ repoRoot, home, config }) {
  const file = path.resolve(repoRoot, 'ops/bootstrap/harness.config.json');
  // Loaded here and not at the top: hooks and fixture repos load this file alone.
  const { acquireInstallLock } = await import('./install-lock.mjs');
  const release = acquireInstallLock({ home });
  try {
    const target = writeTarget(file);
    removeDeadTemps(target);
    let old = null;
    let mode = 0o644;
    try {
      old = readFileSync(target, 'utf8');
      mode = statSync(target).mode & 0o777;
    } catch (error) {
      if (error.code !== 'ENOENT' || typeof config === 'function') {
        throw new Error(`Cannot read harness config ${file}: ${error.message}`, { cause: error });
      }
    }
    let next = config;
    if (typeof config === 'function') {
      let current;
      try {
        current = JSON.parse(old);
      } catch (error) {
        throw new Error(`Invalid JSON in harness config ${file}: ${error.message}`, { cause: error });
      }
      next = config(current);
    }
    const text = canonicalHarnessConfigText({ repoRoot, config: next });
    if (text === old) return { file, changed: false };
    const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(temp, 'wx', mode);
    try {
      try {
        writeFileSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, target);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* The rename moved it, or it is already gone. */ }
      throw error;
    }
    return { file, changed: true };
  } finally {
    release();
  }
}
