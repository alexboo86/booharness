import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProfileRole } from './profiles.ts';
import type { Family } from './providers/types.ts';
import { readHost, type RemoteHost } from './config.ts';
import { effectiveInstruments, type Instruments } from './shared.entry.ts';
import { ownGroup, refuseHostSsh, spawnProvider, sshNodeArgs } from './providers/spawn.ts';
import { projectConfig } from '../../../scripts/lib/harness-config.mjs';

const project = projectConfig();
const mcpByRole: Record<string, string[]> = JSON.parse(readFileSync(new URL('../mcp-by-role.json', import.meta.url), 'utf8'));

/** Web access follows the MCP role map, not a second role-policy flag. */
export function needsBrightdataWeb(role: string): boolean {
  return mcpByRole[role]?.includes('brightdata-web') === true;
}

/** Where a seat runs: this Mac or a named host of hosts.json. */
export type Target = 'local' | string;

/** Display machine for a stored seat; placement calls this Mac `local`, not a named host. */
export function seatHost(data: Record<string, unknown>): string {
  return typeof data.host === 'string' ? data.host : 'mac';
}
export type Load = { cpus: number; cpuBusyPct: number; freeMemGb: number; totalMemGb: number };
/** A probe that failed is an error, never a zero load: an idle-looking dead host would win every placement. */
export const HOST_INSTRUMENTS = ['ast-grep', 'codegraph', 'memoryctl', 'rg'] as const;
export type HostInstruments = Record<(typeof HOST_INSTRUMENTS)[number], boolean>;
type InstrumentCheck = { status: 'ok' } | { status: 'absent' | 'timed out'; error: string };
export type LoadProbe = { ok: true; load: Load; instruments?: HostInstruments; instrumentChecks?: Record<(typeof HOST_INSTRUMENTS)[number], InstrumentCheck>; capabilities?: { 'brightdata-web': boolean } } | { ok: false; error: string };

/** Remote tools needed by the effective seat map; rg is always on. Unknown availability is not a promise. */
export function missingHostInstruments(probe: LoadProbe, instruments: Instruments): string[] {
  const required = { 'ast-grep': instruments['ast-grep'], codegraph: instruments.codegraph, memoryctl: instruments.memory, rg: true };
  return HOST_INSTRUMENTS.filter((tool) => required[tool] && (!probe.ok || probe.instruments?.[tool] !== true));
}
/** Keep the missing-tool list stable, then explain each unavailable reading. */
export function hostInstrumentCauses(probe: LoadProbe, missing: readonly string[]): string {
  return `${missing.join(', ')} (${missing.map((tool) => {
    const check = probe.ok ? probe.instrumentChecks?.[tool as keyof HostInstruments] : undefined;
    return `${tool}: ${check && check.status !== 'ok' ? `${check.status} (${check.error})` : 'unknown'}`;
  }).join('; ')})`;
}
/** Total and available space of the volume that holds a path: GB as this Mac's Finder counts (1e9 bytes), GiB elsewhere. */
export type DiskLoad = { totalGb: number; freeGb: number };
export type DiskProbe = { ok: true; disk: DiskLoad } | { ok: false; error: string };
/** One placement candidate: its platform, its probe and the seats the caller already runs there. */
export type Candidate = { platform: NodeJS.Platform; probe: LoadProbe; activeSeats: number };

/** The platform the lead says a seat's work needs (decision #12522): mac is this Mac, win any win32 host, any every target. */
export type PlatformNeed = 'mac' | 'win' | 'any';
export const PLATFORM_NEEDS: readonly PlatformNeed[] = ['mac', 'win', 'any'];

export const PROBE_TIMEOUT_MS = 10_000;

// Busy share of os.cpus() times over ~1 s: os.loadavg() is always 0 on Windows.
// darwin: os.freemem() counts only free pages, so the probe ships raw vm_stat for parseVmStat.
const PROBE_SCRIPT = `const os=require('os');
const {loadSecrets}=require('./ops/bootstrap/secret-bindings.mjs');
const prefix=require('./ops/bootstrap/harness.config.json').names.prefix;
const secrets=loadSecrets(require('path').join(os.homedir(),'.claude',prefix+'-secrets.env'));
const capabilities={'brightdata-web':Boolean(process.env.BRIGHTDATA_API_KEY||secrets.BRIGHTDATA_API_KEY)};
const run=(command,arg,ast=false)=>new Promise(resolve=>{
require('child_process').execFile(command,[arg],{encoding:'utf8',timeout:4000,killSignal:'SIGKILL',windowsHide:true,shell:process.platform==='win32'},(error,stdout)=>{
if(error)return resolve({status:error.killed?'timed out':'absent',error:error.message});
if(ast&&!/^ast-grep\\s+\\d/m.test(stdout))return resolve({status:'absent',error:command+' did not identify as ast-grep: '+stdout.trim()});
resolve({status:'ok'});
})});
const checks=Promise.all([run('ast-grep','--version',true),run('sg','--version',true),run('codegraph','--version'),run('memoryctl','--help'),run('rg','--version')]).then(([ast,sg,codegraph,memoryctl,rg])=>{
const best=[ast,sg].find(r=>r.status==='ok')||[ast,sg].find(r=>r.status==='timed out')||ast;
return {'ast-grep':best,codegraph,memoryctl,rg};
});
const sum=()=>os.cpus().reduce((a,c)=>{const t=c.times;a.idle+=t.idle;a.total+=t.user+t.nice+t.sys+t.idle+t.irq;return a},{idle:0,total:0});
const a=sum();
setTimeout(async()=>{const b=sum();const total=b.total-a.total;
const mem=process.platform==='darwin'?{vmStat:require('child_process').execFileSync('/usr/bin/vm_stat',{encoding:'utf8'})}:{freeMemGb:os.freemem()/2**30};
const instrumentChecks=await checks;
const instruments=Object.fromEntries(Object.entries(instrumentChecks).map(([tool,check])=>[tool,check.status==='ok']));
console.log(JSON.stringify({platform:process.platform,cpus:os.cpus().length,cpuBusyPct:total>0?100*(1-(b.idle-a.idle)/total):null,totalMemGb:os.totalmem()/2**30,instruments,instrumentChecks,capabilities,...mem}))},1000);`;

const VM_STAT_AVAILABLE = ['free', 'inactive', 'purgeable', 'speculative'];

/** Available GiB the way macOS counts it: free + inactive + purgeable + speculative pages times the printed page size; null when any is missing. */
export function parseVmStat(text: string): number | null {
  const pageSize = /^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)$/m.exec(text);
  if (!pageSize) return null;
  let pages = 0;
  for (const name of VM_STAT_AVAILABLE) {
    const row = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.$`, 'm').exec(text);
    if (!row) return null;
    pages += Number(row[1]);
  }
  return pages * Number(pageSize[1]) / 2 ** 30;
}

type CpuSample = { at: number; idle: number; total: number };
const cpuSample = (): CpuSample => os.cpus().reduce((sum, cpu) => {
  const t = cpu.times;
  sum.idle += t.idle;
  sum.total += t.user + t.nice + t.sys + t.idle + t.irq;
  return sum;
}, { at: Date.now(), idle: 0, total: 0 });
// This Mac's busy share is measured against the newest sample at least CPU_WINDOW_MS older than now,
// so a reading taken right after another still spans a second or more of CPU time.
const CPU_WINDOW_MS = 1000;
let cpuBase = cpuSample();
let cpuLast = cpuBase;

/** Busy percent of this Mac, in-process; null in the first second after import, before a full window exists. */
function cpuBusyPct(): number | null {
  const now = cpuSample();
  if (now.at - cpuBase.at < CPU_WINDOW_MS) return null;
  if (now.at - cpuLast.at >= CPU_WINDOW_MS) { cpuBase = cpuLast; cpuLast = now; }
  const total = now.total - cpuBase.total;
  return total > 0 ? 100 * (1 - (now.idle - cpuBase.idle) / total) : null;
}

/** Reads this machine's available memory in GiB: vm_stat on darwin (os.freemem() counts free pages
 *  only), os.freemem() elsewhere. Handed the probe's timeout: a stalled read is killed there and rejects. */
export type FreeMemRunner = (timeoutMs: number) => Promise<number>;
const runVmStat: FreeMemRunner = (timeoutMs) => new Promise((resolve, reject) =>
  execFile('/usr/bin/vm_stat', { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout) => {
    if (error) return reject(error);
    const freeMemGb = parseVmStat(stdout);
    return freeMemGb === null ? reject(new Error('vm_stat output did not parse')) : resolve(freeMemGb);
  }));
// No child to stall outside darwin; the timeout is still handed over so an injected runner can stall on any platform.
const runFreeMem: FreeMemRunner = () => Promise.resolve(os.freemem() / 2 ** 30);
const runMem: FreeMemRunner = process.platform === 'darwin' ? runVmStat : runFreeMem;

type MemReading = { at: string } & ({ freeMemGb: number } | { error: string });
let memLatest: MemReading | null = null;
let memInFlight: Promise<MemReading> | null = null;

/** This machine's available memory, read through `run` on every platform (a test stalls it there). At most one read runs; a caller arriving while it runs joins it. */
function readMemory(run: FreeMemRunner, timeoutMs: number): Promise<MemReading> {
  memInFlight ??= run(timeoutMs).then((freeMemGb): MemReading => ({ at: new Date().toISOString(), freeMemGb }),
    (error: Error): MemReading => ({ at: new Date().toISOString(), error: `vm_stat: ${error.message}` })).then((reading) => {
    memLatest = reading;
    memInFlight = null;
    return reading;
  });
  return memInFlight;
}

function macLoad(cpuBusyPct: number | null, mem: MemReading): LoadProbe {
  if ('error' in mem) return { ok: false, error: `local: ${mem.error}` };
  const load = parseLoad(JSON.stringify({ cpus: os.cpus().length, cpuBusyPct, totalMemGb: os.totalmem() / 2 ** 30, freeMemGb: mem.freeMemGb }));
  return typeof load === 'object' ? { ok: true, load } : { ok: false, error: `local: ${load}` };
}

/**
 * This Mac for the board, never waiting on a child process: CPU read now, memory from the latest
 * vm_stat with its time, and a background vm_stat started when none is running. null until both exist.
 */
export function macLoadNow(run: FreeMemRunner = runMem): { load: LoadProbe; memAt: string } | null {
  void readMemory(run, PROBE_TIMEOUT_MS);
  const cpu = cpuBusyPct();
  return memLatest && cpu !== null ? { load: macLoad(cpu, memLatest), memAt: memLatest.at } : null;
}

/** This Mac for placement: a full CPU window and a fresh memory read, or the timeout error at timeoutMs. */
async function localLoad(timeoutMs: number, run: FreeMemRunner): Promise<LoadProbe> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<LoadProbe>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `local: probe timed out after ${timeoutMs} ms; killed by SIGKILL` }), timeoutMs);
  });
  const sampled = (async () => {
    // The memory read starts now, not after the CPU window: its runner is the probe's stallable step,
    // so a read that outlives timeoutMs is reported as the timeout on every platform.
    const mem = readMemory(run, timeoutMs);
    const wait = CPU_WINDOW_MS - (Date.now() - cpuBase.at);
    if (wait > 0) await delay(wait);
    return macLoad(cpuBusyPct(), await mem);
  })();
  try { return await Promise.race([sampled, timedOut]); } finally { clearTimeout(timer); }
}

/** Sample CPU and memory on `target`: this Mac in-process plus vm_stat, a host by the probe script over ssh and remote-exec. */
export function probeLoad(target: Target, timeoutMs = PROBE_TIMEOUT_MS, run: FreeMemRunner = runMem): Promise<LoadProbe> {
  if (target === 'local') return localLoad(timeoutMs, run);
  let child: ReturnType<typeof spawnProvider>;
  try {
    child = spawnProvider({ command: 'node', args: ['-e', PROBE_SCRIPT], cwd: readHost(target).repo, host: target, ownGroup: true });
  } catch (error) {
    return Promise.resolve({ ok: false, error: `${target}: ${(error as Error).message}` });
  }
  // stdin stays open: remote-exec kills the remote tree when its stdin ends.
  return probeEnd(child, timeoutMs).then((end): LoadProbe => {
    if ('timedOut' in end) return { ok: false, error: `${target}: probe timed out after ${timeoutMs} ms; killed by SIGKILL` };
    if ('error' in end) return { ok: false, error: `${target}: ${end.error}` };
    // A valid line from a probe that then failed (non-zero exit, signal, ssh 255) is not a load.
    const line = end.stdout.trim().split(/\r?\n/).pop() ?? '';
    const load = parseLoad(line);
    if (end.code === 0 && typeof load === 'object') {
      const payload = JSON.parse(line);
      const value = payload.instruments;
      const capabilities = payload.capabilities;
      if (capabilities !== undefined && (!capabilities || typeof capabilities !== 'object' || typeof capabilities['brightdata-web'] !== 'boolean'))
        return { ok: false, error: `${target}: invalid capabilities line` };
      const web = capabilities === undefined ? {} : { capabilities: { 'brightdata-web': capabilities['brightdata-web'] as boolean } };
      // Legacy load-only payloads remain readable, but cannot qualify a remote seat.
      if (value === undefined) return { ok: true, load, ...web };
      if (!value || typeof value !== 'object' || HOST_INSTRUMENTS.some((key) => typeof value[key] !== 'boolean'))
        return { ok: false, error: `${target}: invalid instruments line` };
      const checks = payload.instrumentChecks;
      if (checks !== undefined && (!checks || typeof checks !== 'object' || HOST_INSTRUMENTS.some((key) => {
        const check = checks[key];
        return !check || !['ok', 'absent', 'timed out'].includes(check.status) ||
          (check.status !== 'ok' && typeof check.error !== 'string') || value[key] !== (check.status === 'ok');
      }))) return { ok: false, error: `${target}: invalid instrument checks line` };
      return { ok: true, load, ...web, instruments: Object.fromEntries(HOST_INSTRUMENTS.map((key) => [key, value[key]])) as HostInstruments,
        ...(checks === undefined ? {} : { instrumentChecks: checks }) };
    }
    const status = end.code === null ? `probe killed by ${end.signal}` : `probe exit ${end.code}`;
    return { ok: false, error: `${target}: ${status}${typeof load === 'string' ? `, ${load}` : ''}${end.stderr ? `: ${end.stderr}` : ''}` };
  });
}

/** How a probe child ended: its exit and output, the error that kept it from running, or the timeout that killed it. */
type ProbeEnd = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } | { error: string } | { timedOut: true };

/**
 * Collect a probe child's output until it closes. The child leads its own process group (spawned
 * with ownGroup): a probe that has not closed at timeoutMs is killed as that group, so ssh's
 * ProxyCommand and every other descendant die with it.
 */
export function probeEnd(child: ChildProcess & { stdout: Readable; stderr: Readable }, timeoutMs: number): Promise<ProbeEnd> {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false;
    const finish = (end: ProbeEnd) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!('code' in end)) {
        // No close yet: the child runs, or a descendant holds its pipe after the child's own exit.
        try {
          if (child.pid === undefined || process.platform === 'win32') throw new Error('no process group');
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        // A descendant that left the group can still hold a pipe: the caller's process must not wait on it.
        child.stdin?.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolve(end);
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-2000); });
    child.on('error', (error) => finish({ error: error.message }));
    child.on('close', (code, signal) => finish({ code, signal, stdout, stderr: stderr.trim() }));
  });
}

export type HostProbe = { ok: true; version: string } | { ok: false; reason: 'unreachable' | 'node not found' | 'timeout' | 'unsupported node' | 'required node unknown'; error: string };

/** The Node major orch needs, read from `engines.node` of its package.json, the one place that states it. */
function requiredNodeMajor(): number {
  let range: unknown;
  try { range = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines?.node; }
  catch (error) { throw new Error(`ops/orchestrator/package.json is unreadable: ${(error as Error).message}`); }
  const major = typeof range === 'string' ? /^>=(\d+)$/.exec(range) : null;
  if (!major) throw new Error(`ops/orchestrator/package.json engines.node must be '>=<major>': ${String(range)}`);
  return Number(major[1]);
}

/**
 * Prove a host entry before a seat depends on it: over ssh, run the entry's node and read its version.
 * Plain ssh with no remote-exec, so a host that has no repo checkout yet still answers. The entry
 * must have passed the hosts.json rules (checkHosts): its ssh alias and node path go to ssh as they are.
 */
export function probeHost(host: RemoteHost, timeoutMs = PROBE_TIMEOUT_MS): Promise<HostProbe> {
  let child: ReturnType<typeof spawn>;
  let required: number;
  // This checkout's own fault, not the host's: no ssh starts without the major to compare with.
  try { required = requiredNodeMajor(); }
  catch (error) { return Promise.resolve({ ok: false, reason: 'required node unknown', error: (error as Error).message }); }
  try {
    refuseHostSsh(host.ssh);
    child = spawn('ssh', [...sshNodeArgs(host), '--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...ownGroup() });
  } catch (error) {
    return Promise.resolve({ ok: false, reason: 'unreachable', error: (error as Error).message });
  }
  return probeEnd(child as ChildProcess & { stdout: Readable; stderr: Readable }, timeoutMs).then((end): HostProbe => {
    if ('timedOut' in end) return { ok: false, reason: 'timeout', error: `no answer from '${host.ssh}' in ${timeoutMs} ms; ssh killed by SIGKILL` };
    if ('error' in end) return { ok: false, reason: 'unreachable', error: `ssh did not start: ${end.error}` };
    const detail = end.stderr ? `: ${end.stderr}` : '';
    // 255 is ssh's own failure (no route, refused, no key); any other failure is the remote command's.
    if (end.code === null) return { ok: false, reason: 'unreachable', error: `ssh to '${host.ssh}' killed by ${end.signal}${detail}` };
    if (end.code === 255) return { ok: false, reason: 'unreachable', error: `ssh to '${host.ssh}' exit 255${detail}` };
    if (end.code !== 0) return { ok: false, reason: 'node not found', error: `'${host.node}' did not run on '${host.ssh}' (exit ${end.code})${detail}` };
    const version = /^v(\d+)\.\d+\.\d+\S*$/.exec(end.stdout.trim().split(/\r?\n/).pop() ?? '');
    if (!version) return { ok: false, reason: 'node not found', error: `'${host.node}' on '${host.ssh}' printed no node version: ${end.stdout.trim().slice(0, 200)}` };
    if (Number(version[1]) < required) return { ok: false, reason: 'unsupported node', error: `'${host.node}' on '${host.ssh}' is node ${version[0]}; orch needs node >=${required}` };
    return { ok: true, version: version[0] };
  });
}

/** A Load, or the reason the probe line is unusable. */
export function parseLoad(line: string): Load | string {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return 'no load line'; }
  if (value === null || typeof value !== 'object') return 'no load line';
  const { platform, cpus, cpuBusyPct, totalMemGb, vmStat } = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  let freeMemGb = (value as Record<string, unknown>).freeMemGb;
  if (platform === 'darwin') {
    if (typeof vmStat !== 'string' || freeMemGb !== undefined) return 'darwin load line without vm_stat';
    freeMemGb = parseVmStat(vmStat);
    if (freeMemGb === null) return 'vm_stat output did not parse';
  }
  if (!finite(cpus) || cpus < 1 || !finite(cpuBusyPct) || cpuBusyPct < 0 || cpuBusyPct > 100 ||
      !finite(totalMemGb) || totalMemGb <= 0 || !finite(freeMemGb) || freeMemGb < 0 || freeMemGb > totalMemGb) return 'invalid load line';
  return { cpus, cpuBusyPct, freeMemGb, totalMemGb };
}

// statfs of the volume holding argv[1]: total and available bytes in GiB. Works on win32 too (Node >= 18.15).
const DISK_SCRIPT = `const fs=require('fs');
try{const s=fs.statfsSync(process.argv[1]);console.log(JSON.stringify({totalGb:s.blocks*s.bsize/2**30,freeGb:s.bavail*s.bsize/2**30}))}catch(e){console.error(String(e&&e.message||e));process.exit(1)}`;

// This Mac: what Finder calls Available (important-usage capacity, purgeable space included) and the volume
// total, in decimal GB as Finder prints them; statfs bavail leaves purgeable space out.
const MAC_DISK_SCRIPT = `function run(argv){ObjC.import('Foundation');const u=$.NSURL.fileURLWithPath(argv[0]);
const get=(k)=>{const v=Ref();if(!u.getResourceValueForKeyError(v,k,null)||!v[0])throw new Error('no '+ObjC.unwrap(k)+' for '+argv[0]);return Number(v[0].js)};
return JSON.stringify({totalGb:get($.NSURLVolumeTotalCapacityKey)/1e9,freeGb:get($.NSURLVolumeAvailableCapacityForImportantUsageKey)/1e9})}`;

/** A DiskLoad, or the reason the probe line is unusable. */
export function parseDisk(line: string): DiskLoad | string {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return 'no disk line'; }
  if (value === null || typeof value !== 'object') return 'no disk line';
  const { totalGb, freeGb } = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (!finite(totalGb) || totalGb <= 0 || !finite(freeGb) || freeGb < 0 || freeGb > totalGb) return 'invalid disk line';
  return { totalGb, freeGb };
}

/** Sample the disk of the volume holding `path` on `target`; a host runs the same script over ssh and remote-exec. */
export function probeDisk(target: Target, path: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<DiskProbe> {
  let child: ReturnType<typeof spawnProvider>;
  try {
    const cwd = target === 'local' ? process.cwd() : readHost(target).repo;
    const mac = target === 'local' && process.platform === 'darwin';
    child = spawnProvider({ command: mac ? 'osascript' : 'node', args: mac ? ['-l', 'JavaScript', '-e', MAC_DISK_SCRIPT, path] : ['-e', DISK_SCRIPT, path], cwd, ownGroup: true, ...(target === 'local' ? {} : { host: target }) });
  } catch (error) {
    return Promise.resolve({ ok: false, error: `${target}: ${(error as Error).message}` });
  }
  return probeEnd(child, timeoutMs).then((end): DiskProbe => {
    if ('timedOut' in end) return { ok: false, error: `${target}: disk probe timed out after ${timeoutMs} ms; killed by SIGKILL` };
    if ('error' in end) return { ok: false, error: `${target}: ${end.error}` };
    // Healthy only on exit 0 with a parseable line: ssh prints output and exits 255 on a dropped host.
    const disk = parseDisk(end.stdout.trim().split(/\r?\n/).pop() ?? '');
    if (end.code === 0 && typeof disk === 'object') return { ok: true, disk };
    const status = end.code === null ? `probe killed by ${end.signal}` : `probe exit ${end.code}`;
    return { ok: false, error: `${target}: ${status}${typeof disk === 'string' ? `, ${disk}` : ''}${end.stderr ? `: ${end.stderr}` : ''}` };
  });
}

/**
 * What this Mac keeps for the operator, the leads and the desktop app before it ranks as a seat machine
 * (operator 2026-10-28, task 3288): ranked as an equal peer it took 97 of 305 non-scout seats in a day and
 * ran loud all day. A host wins whenever its share beats what the Mac has left; the Mac still takes seats
 * when the hosts are fuller.
 */
const MAC_RESERVE = { cores: 6, memGb: 12 } as const;

/** A target's load as placement ranks it: on this Mac, MAC_RESERVE taken off its free cores and free memory, floored at zero. */
function rankedLoad(target: Target, load: Load): Load {
  if (target !== 'local') return load;
  const freeCores = Math.max(0, load.cpus * (1 - load.cpuBusyPct / 100) - MAC_RESERVE.cores);
  return { ...load, cpuBusyPct: 100 * (1 - freeCores / load.cpus), freeMemGb: Math.max(0, load.freeMemGb - MAC_RESERVE.memGb) };
}

/** One ranking entry as the placement reason prints it; this Mac's names its reserve. */
function rankDetail(target: Target, value: number, load: Load, activeSeats: number): string {
  const freeCores = load.cpus * (1 - load.cpuBusyPct / 100);
  const kept = target === 'local' ? `; ${MAC_RESERVE.cores} cores and ${MAC_RESERVE.memGb} GB kept for the Mac` : '';
  return `${target} ${value.toFixed(1)} (free cores ${freeCores.toFixed(1)} of ${load.cpus}, free mem ${load.freeMemGb.toFixed(1)} of ${load.totalMemGb.toFixed(1)} GB, ${activeSeats} active${kept})`;
}

/** Higher value first; an equal value goes to a host, not this Mac (task 3288); equal hosts keep their name order. */
const byValueHostFirst = (a: { target: Target; value: number }, b: { target: Target; value: number }) =>
  b.value - a.value || Number(a.target === 'local') - Number(b.target === 'local');

/** Free-capacity share relative to the ranked maxima, minus one point per active seat; higher wins. */
export function pressure(load: Load, activeSeats: number, maxFreeCores: number, maxFreeGb: number): number {
  const freeCores = load.cpus * (1 - load.cpuBusyPct / 100);
  const share = maxFreeCores === 0 || maxFreeGb === 0 ? 0 : 100 * Math.min(freeCores / maxFreeCores, load.freeMemGb / maxFreeGb);
  return share - activeSeats;
}

const pathRule = (file: string, roots: readonly string[]): string | undefined => {
  const relative = file.replaceAll('\\', '/').replace(/^\.\//, '');
  return roots.find((root) => relative === root || relative.startsWith(`${root}/`));
};
const touchesServer = (file: string) => pathRule(file, project.noWinPaths) !== undefined;
export const touchesMacDesktop = (file: string) => pathRule(file, project.macOnlyPaths) !== undefined;
/** mac is this Mac, not any darwin host; win is any win32 host. */
const NEED_FITS = {
  mac: { fits: (target: Target) => target === 'local', miss: (target: Target) => `${target} is not this Mac` },
  win: { fits: (_: Target, candidate: Candidate) => candidate.platform === 'win32', miss: (target: Target, candidate: Candidate) => `${target} ${candidate.platform} is not Windows` },
  any: { fits: () => true, miss: () => '' },
};

/** Pure: the same inputs always give the same target and reason. Throws when no target is eligible. Hard rules come first; the lead's need then narrows the platform, load picks the machine (decision #12522). */
export function placeSeat(input: { role: ProfileRole; family: Family; taskFiles: readonly string[]; local: Candidate; hosts: Readonly<Record<string, Candidate>>; need: PlatformNeed; instruments?: Instruments }): { target: Target; reason: string } {
  const { role, family, taskFiles, local, hosts, need } = input;
  const instruments = input.instruments ?? effectiveInstruments(undefined);
  if (family === 'claude') {
    // A hard rule the lead's need cannot move: a claude seat that needs Windows has no target.
    if (need === 'win') throw new Error(`no placement target is eligible for a claude ${role}: claude runs native on the Mac, and the need is win`);
    return { target: 'local', reason: `claude runs native on the Mac: ${role} seat stays local` };
  }
  const serverFile = taskFiles.find(touchesServer);
  const desktopFile = taskFiles.find(touchesMacDesktop);
  const candidates: [Target, Candidate][] = [['local', local], ...Object.entries(hosts).sort(([a], [b]) => a.localeCompare(b))];
  const skipped: string[] = [];
  const keep = (rows: [Target, Candidate][], ok: (target: Target, candidate: Candidate) => boolean, why: (target: Target, candidate: Candidate) => string) =>
    rows.filter(([target, candidate]) => {
      if (ok(target, candidate)) return true;
      skipped.push(why(target, candidate));
      return false;
    });
  const hardEligible = keep(candidates, (_, candidate) => !(serverFile && candidate.platform === 'win32'), (target) => `${target} win32 does not build ${pathRule(serverFile!, project.noWinPaths)} (${serverFile}; memory #9283)`);
  const desktopEligible = keep(hardEligible, (target) => !desktopFile || target === 'local', (target) => `${target} cannot run this Mac's desktop runtime (${desktopFile})`);
  const eligible = keep(desktopEligible, NEED_FITS[need].fits, NEED_FITS[need].miss);
  const measured: { target: Target; load: Load; activeSeats: number }[] = [];
  let maxFreeCores = 0, maxFreeGb = 0;
  for (const [target, candidate] of eligible) {
    const probe = candidate.probe;
    if (probe.ok === false) { skipped.push(`${target} probe failed: ${probe.error}`); continue; }
    if (target !== 'local' && needsBrightdataWeb(role) && probe.capabilities?.['brightdata-web'] !== true) {
      skipped.push(`${target} missing capability: brightdata-web (BRIGHTDATA_API_KEY required)`); continue;
    }
    const missing = target !== 'local' ? missingHostInstruments(probe, instruments) : [];
    if (missing.length) { skipped.push(`${target} missing instrument: ${hostInstrumentCauses(probe, missing)}`); continue; }
    const load = rankedLoad(target, probe.load);
    maxFreeCores = Math.max(maxFreeCores, load.cpus * (1 - load.cpuBusyPct / 100));
    maxFreeGb = Math.max(maxFreeGb, load.freeMemGb);
    measured.push({ target, load, activeSeats: candidate.activeSeats });
  }
  const ranked = measured.map(({ target, load, activeSeats }) => {
    const value = pressure(load, activeSeats, maxFreeCores, maxFreeGb);
    return { target, value, detail: rankDetail(target, value, load, activeSeats) };
  });
  const skipText = skipped.length ? `; skipped: ${skipped.join('; ')}` : '';
  if (!ranked.length) throw new Error(`no placement target is eligible for a ${family} ${role} that needs ${need}${skipText}`);
  ranked.sort(byValueHostFirst);
  const ranking = ranked.map((row) => row.detail).join('; ');
  const desktopNote = desktopFile ? `this Mac's desktop runtime (${desktopFile}); ` : '';
  return { target: ranked[0].target, reason: `${desktopNote}highest free capacity: ${ranked[0].target}; ranking: ${ranking}${skipText}` };
}

/** The target the load ranking would give a Pi coder with the same files under need `any`; null when this Mac wins or no target is eligible (failed probes, Mac-only files). The family is a stand-in: placeSeat's claude hard rule must not apply. Reuses the caller's probe results; it never probes. */
export function lighterHost(input: { taskFiles: readonly string[]; local: Candidate; hosts: Readonly<Record<string, Candidate>>; instruments?: Instruments }): Target | null {
  try {
    const placed = placeSeat({ role: 'coder', family: 'codex', taskFiles: input.taskFiles, need: 'any', instruments: input.instruments, local: input.local, hosts: input.hosts });
    return placed.target === 'local' ? null : placed.target;
  } catch {
    return null;
  }
}
