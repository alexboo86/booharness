// MCP config planning and publication. The installer holds its home lock.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mergeKeep, readManifest, targetIdentity, writeOwned } from './owned-entries.mjs';

export function serverBelongs(spec, runtime) {
  if (!spec || !Array.isArray(spec.runtimes)) return true;
  return spec.runtimes.includes(runtime);
}

export function jsonEntry(entry) {
  if (entry.url) {
    const http = { type: 'http', url: entry.url };
    if (entry.bearer) http.headers = { Authorization: `Bearer ${entry.bearer}` };
    return http;
  }
  const rendered = { command: entry.command, args: entry.args };
  if (Object.keys(entry.env).length > 0) rendered.env = entry.env;
  return rendered;
}

function readRoot(file, keep) {
  if (!keep && !existsSync(file)) return {};
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if (keep && error.code === 'ENOENT') {
      try { lstatSync(file); }
      catch (missing) { if (missing.code === 'ENOENT') return {}; }
    }
    throw new Error(`Cannot read MCP config ${file}: ${error.message}`, { cause: error });
  }
  let root;
  try { root = JSON.parse(keep ? text : text || '{}'); }
  catch {
    // JSON.parse may quote credentials from the input; do not retain its cause.
    throw new Error(`Invalid JSON in MCP config ${file}`);
  }
  if (!keep) return root;
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(root)) throw new Error(`Invalid MCP config ${file}: expected a config object`);
  if (root.mcpServers !== undefined && !isRecord(root.mcpServers)) {
    throw new Error(`Invalid MCP config ${file}: mcpServers must be an object`);
  }
  return root;
}

export function buildJsonConfig(file, runtime, { selected, preserve, operatorIds, retiredIds, keep, manifestPath }, { render = jsonEntry, settings = null, legacyFile } = {}) {
  const root = readRoot(file, keep);
  if (legacyFile) {
    if (targetIdentity(file) === targetIdentity(legacyFile)) {
      throw new Error(`MCP migration source and target must be separate files: ${legacyFile} and ${file}`);
    }
    // Plan the old config under the same policy, without publishing it. In keep
    // mode its own ownership record decides what is user-owned, not the new path.
    const legacy = buildJsonConfig(legacyFile, runtime,
      { selected, preserve, operatorIds, retiredIds, keep, manifestPath }, { render });
    if (legacy.ownership) {
      const owned = readManifest(manifestPath)[legacy.writePath]?.mcpServers;
      const { present, canon } = legacy.ownership.lists.mcpServers;
      legacy.mergeServers({ mcpServers: mergeKeep(present, canon, owned) });
    }
    // An operator's choice already in the adapter file wins a name collision.
    root.mcpServers = { ...JSON.parse(legacy.content).mcpServers, ...root.mcpServers };
  }
  const existing = root.mcpServers && typeof root.mcpServers === 'object' ? root.mcpServers : {};
  const rendered = new Map();
  for (const [id, entry] of selected) {
    if (!serverBelongs(entry.spec, runtime)) continue;
    rendered.set(id, render(entry, id));
  }
  const servers = {};
  for (const [id, value] of Object.entries(existing)) {
    if (preserve.includes(id) && !operatorIds.includes(id) && (!keep || !retiredIds.includes(id))) servers[id] = value;
  }
  for (const [id, value] of rendered) servers[id] = value;
  root.mcpServers = servers;
  if (settings) root.settings = { ...(root.settings || {}), ...settings };
  const plan = { path: file, runtime, servers: Object.keys(servers), content: `${JSON.stringify(root, null, 2)}\n` };
  if (keep) {
    // Capture once: publication must not replace a link or recase its target.
    plan.writePath = targetIdentity(file);
    plan.ownership = {
      manifestPath, targetPath: plan.writePath,
      lists: { mcpServers: {
        present: Object.keys(existing).filter((id) => !retiredIds.includes(id) && !operatorIds.includes(id)),
        canon: [...rendered.keys()],
      } },
    };
    plan.mergeServers = ({ mcpServers }) => {
      root.mcpServers = Object.fromEntries(mcpServers.map((id) => [id, rendered.has(id) ? rendered.get(id) : existing[id]]));
      plan.servers = mcpServers;
      plan.content = `${JSON.stringify(root, null, 2)}\n`;
    };
  }
  return plan;
}

export function publishConfigs(plans) {
  // writeOwned commits each target's ownership independently. The MCP batch
  // needs the same rollback boundary for its configs and its manifest bytes.
  const manifests = new Map();
  for (const plan of plans) {
    if (!plan.ownership) continue;
    const file = path.resolve(plan.ownership.manifestPath);
    if (manifests.has(file)) continue;
    try { manifests.set(file, readFileSync(file)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot snapshot ownership manifest ${file}: ${error.message}`, { cause: error });
      manifests.set(file, null);
    }
  }
  const staged = [];
  try {
    for (const plan of plans) {
      const target = plan.writePath ?? plan.path;
      if (existsSync(target) && lstatSync(target).isDirectory()) {
        throw new Error(`${target} is a directory, not a config file`);
      }
      mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.harness-new`;
      writeFileSync(temp, plan.content, { encoding: 'utf8' });
      staged.push({ plan, target, temp, backup: null });
    }
  } catch (error) {
    for (const entry of staged) try { unlinkSync(entry.temp); } catch { /* ignore */ }
    throw new Error(`MCP install staged nothing: ${error.message}. No configuration was changed.`);
  }
  const committed = [];
  try {
    for (const entry of staged) {
      if (existsSync(entry.target) && lstatSync(entry.target).isFile()) {
        entry.backup = `${entry.target}.harness-backup`;
        copyFileSync(entry.target, entry.backup);
      }
      const commit = () => {
        renameSync(entry.temp, entry.target);
        committed.push(entry);
      };
      if (entry.plan.ownership) {
        writeOwned({ ...entry.plan.ownership, writeTarget: (lists) => {
          entry.plan.mergeServers(lists);
          writeFileSync(entry.temp, entry.plan.content, { encoding: 'utf8' });
          commit();
        } });
      } else {
        commit();
      }
    }
  } catch (error) {
    const unrestored = [];
    for (const entry of committed) {
      try {
        if (entry.backup) renameSync(entry.backup, entry.target);
        else unlinkSync(entry.target);
      } catch {
        unrestored.push(entry.target);
      }
    }
    for (const entry of staged) {
      try { unlinkSync(entry.temp); } catch { /* ignore */ }
      if (entry.backup && existsSync(entry.backup)) {
        try { unlinkSync(entry.backup); } catch { /* ignore */ }
      }
    }
    for (const [file, bytes] of manifests) {
      try {
        if (bytes === null) {
          rmSync(file, { force: true });
        } else {
          const temporary = `${file}.${randomUUID()}.harness-restore`;
          try {
            writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
            renameSync(temporary, file);
          } finally {
            rmSync(temporary, { force: true });
          }
        }
      } catch {
        unrestored.push(file);
      }
    }
    if (unrestored.length) {
      throw new Error(`MCP install rolled back after: ${error.message}. THESE COULD NOT BE RESTORED: ${unrestored.join(', ')}`);
    }
    throw new Error(`MCP install rolled back: ${error.message}. Every runtime was restored.`);
  }
  for (const entry of committed) {
    if (entry.backup && existsSync(entry.backup)) unlinkSync(entry.backup);
  }
  return plans;
}
