import { targetLivenessScript } from './remote-target-liveness.ts';
import { CARGO_MARKERS, RECENT_BUILD_RULE } from './target-sweep-rules.ts';

// Shipped over the managed transport: never imports code from a seat's checkout.
export const remoteTargetScript = String.raw`
const fs = require('node:fs'), p = require('node:path');
const { createInterface } = require('node:readline');
const input = createInterface({ input: process.stdin });
const { checkout, repo, targets, window, dryRun } = JSON.parse(process.argv[1]);
if (!p.isAbsolute(checkout) || checkout.split(/[\\/]/).some(part => part === '.' || part === '..')) throw new Error('unsafe checkout path');
const given = p.resolve(checkout), worktreeRoot = p.join(p.dirname(repo), 'worktrees');
function checkoutRoot() {
  // process.cwd() has already followed links: inspect the original host path instead.
  for (let dir = given;; dir = p.dirname(dir)) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('linked checkout path: ' + dir);
    if (dir === worktreeRoot || p.dirname(dir) === dir) break;
  }
  return fs.realpathSync(given);
}
const root = checkoutRoot();
const result = { removed: [], bytesBefore: 0, skipped: [] };
const droppingPrefix = '.dropping-', dropGrace = 60 * 60_000;
const cargoMarkers = ${JSON.stringify(CARGO_MARKERS)}, recentBuildRule = ${JSON.stringify(RECENT_BUILD_RULE)};
${targetLivenessScript}
function directory(suffix) {
  if (checkoutRoot() !== root) throw new Error('checkout root changed');
  const target = p.resolve(root, suffix), relative = p.relative(root, target);
  if (!relative || relative.startsWith('..') || p.isAbsolute(relative)) throw new Error('target escapes checkout');
  let current = root;
  for (const part of relative.split(p.sep)) {
    current = p.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('not a plain directory: ' + current);
  }
  const resolved = fs.realpathSync(target), below = p.relative(root, resolved);
  if (!below || below.startsWith('..') || p.isAbsolute(below)) throw new Error('resolved target escapes checkout');
  return target;
}
function marked(target) {
  for (const marker of cargoMarkers) {
    try {
      const stat = fs.lstatSync(p.join(target, marker));
      if (stat.isFile() && !stat.isSymbolicLink()) return;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error('no Cargo marker');
}
// Shared profile/depth policy; links are dated, not followed.
function recentBuild(target, cutoff) {
  function changed(dir, depth) {
    if (depth < 1) return false;
    for (const name of fs.readdirSync(dir)) {
      const file = p.join(dir, name), stat = fs.lstatSync(file);
      if (stat.mtimeMs >= cutoff) return true;
      if (stat.isDirectory() && !stat.isSymbolicLink() && changed(file, depth - 1)) return true;
    }
    return false;
  }
  for (const profile of recentBuildRule.profiles) {
    const dir = p.join(target, profile);
    let stat;
    try { stat = fs.lstatSync(dir); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('not a plain build directory: ' + dir);
    if (stat.mtimeMs >= cutoff) return true;
    if (changed(dir, recentBuildRule.depth)) return true;
  }
  return false;
}
function treeBytes(dir) {
  let bytes = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = p.join(dir, name), stat = fs.lstatSync(file);
    bytes += stat.isDirectory() && !stat.isSymbolicLink() ? treeBytes(file) : stat.size;
  }
  return bytes;
}
function inspect(suffix, leftover) {
  const target = directory(suffix);
  if (!leftover) {
    marked(target);
    if (recentBuild(target, Date.now() - window)) throw new Error('build modified within idle window');
  }
  return fs.lstatSync(target);
}
async function drop(suffix, leftover = false, authorizationTarget = suffix) {
  const target = p.resolve(root, suffix);
  try {
    const before = inspect(suffix, leftover), bytes = treeBytes(target);
    const busy = targetBusy(target);
    if (busy) throw new Error('target in use: ' + busy);
    // The daemon samples turns AFTER filesystem/liveness inspection and SSH startup.
    const permission = new Promise(resolve => input.once('line', resolve));
    console.log(JSON.stringify({ ready: authorizationTarget }));
    if (await permission !== 'drop') { result.skipped.push({ path: target, reason: 'seat no longer idle' }); return; }
    const after = inspect(suffix, leftover);
    if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeMs !== after.birthtimeMs)
      throw new Error('target changed during inspection');
    const final = inspect(suffix, leftover);
    if (before.dev !== final.dev || before.ino !== final.ino || before.birthtimeMs !== final.birthtimeMs)
      throw new Error('target changed during final liveness inspection');
    // Last probe before the claim: even the final freshness walk can admit a builder.
    const busyAfterGrant = targetBusy(target);
    if (busyAfterGrant) throw new Error('target in use: ' + busyAfterGrant);
    result.bytesBefore += bytes;
    if (!dryRun) {
      const dropping = leftover ? target : target + droppingPrefix + Date.now();
      if (!leftover) {
        if (fs.existsSync(dropping)) throw new Error('drop claim already exists');
        fs.renameSync(target, dropping);
      }
      fs.rmSync(dropping, { recursive: true, force: true });
      result.removed.push(target);
    }
  } catch (e) {
    // Spawn ENOENT means a missing probe, not a vanished target.
    if (e.code !== 'ENOENT' || e.syscall?.startsWith('spawn')) result.skipped.push({ path: target, reason: e.message });
  }
}
async function removeStaleDrops() {
  for (const suffix of targets) {
    const parentRelative = p.dirname(suffix), prefix = p.basename(suffix) + droppingPrefix;
    try {
      const parent = parentRelative === '.' ? (checkoutRoot(), root) : directory(parentRelative);
      for (const name of fs.readdirSync(parent)) {
        if (!name.startsWith(prefix)) continue;
        const stamp = name.slice(prefix.length);
        if (!/^\d+$/.test(stamp) || Date.now() - Number(stamp) < dropGrace) continue;
        // The stamp records an authorized claim; partial deletes need no Cargo marker.
        await drop(p.join(parentRelative, name), true, suffix);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') result.skipped.push({ path: p.resolve(root, parentRelative), reason: e.message });
    }
  }
}
(async () => {
  if (!dryRun) await removeStaleDrops();
  for (const suffix of targets) await drop(suffix);
  console.log(JSON.stringify(result));
  input.close();
  process.stdin.pause();
})().catch(e => { console.error(e.message); process.exitCode = 1; input.close(); process.stdin.pause(); });
`;
