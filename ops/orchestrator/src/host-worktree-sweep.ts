// Host-only recovery of old, registered scratch checkouts. No repo-wide prune.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Seat } from './store.ts';
import { collect, removeSweptWorktree, withHostClone } from './remote-repo.ts';
import { spawnProvider } from './providers/spawn.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { createKeyedQueue } from './keyed-queue.ts';
import { readHosts } from './config.ts';
import { acquireSweepGate } from './sweep-shared.ts';

export type SweepSeat = Pick<Seat, 'id' | 'status' | 'created_at' | 'data' | 'cwd' | 'worktree'>;
type Identity = { dev: number; ino: number; birthtimeMs: number };
type Entry = {
  dir: string; root: string; adminId: string; registeredAt: number;
  head: string; detached: boolean; identity: Identity | null;
};
type Row = Entry & { reason?: string; seatRoot: boolean };
type Scan = { repo: string; tmpRoot: string; worktreesRoot: string; leadRoot: string; platform: NodeJS.Platform; rows: Row[] };
type JournalEntry = Entry & { host: string | null; repo: string };
export type HostWorktreeSweepEvent = {
  host: string | null; dir: string; action: 'candidate' | 'skip' | 'removed' | 'error'; reason: string; retry?: boolean;
};
export type HostWorktreeSweepOptions = {
  host: string | undefined; repo: string; stateDir: string;
  seats: () => SweepSeat[]; dryRun?: boolean;
  log?: (event: HostWorktreeSweepEvent) => void;
};
/** Shared daemon/CLI pass: one lease covers the entire configured-host loop. */
export async function sweepConfiguredHostWorktrees(options: {
  stateDir: string; seats: () => SweepSeat[]; host?: string; daily?: boolean; dryRun?: boolean;
  log?: (event: HostWorktreeSweepEvent) => void;
}): Promise<HostWorktreeSweepEvent[] | null> {
  const { stateDir, host, daily = false, dryRun = false } = options;
  const hosts = readHosts(stateDir);
  if (host !== undefined && !hosts[host]) throw new Error(`unknown host '${host}': hosts.json names ${Object.keys(hosts).join(', ') || 'no host'}`);
  const gate = await acquireSweepGate({ stateDir, base: 'host-worktree-sweep', daily, dryRun });
  if (!gate) return null;
  try {
    const events: HostWorktreeSweepEvent[] = [];
    const log = (event: HostWorktreeSweepEvent) => { events.push(event); options.log?.(event); };
    for (const name of host === undefined ? Object.keys(hosts) : [host]) {
      try {
        await sweepHostWorktrees({ host: name, repo: hosts[name]!.repo, stateDir, dryRun, seats: options.seats, log });
      } catch (error) {
        // A host that cannot be inspected is skipped, never a daemon-wide failure.
        log({ host: name, dir: '', action: daily ? 'skip' : 'error', reason: `host inspection failed: ${(error as Error).message}` });
      }
    }
    if (host === undefined) await gate.publish();
    return events;
  } finally { await gate.release(); }
}

const journalQueue = createKeyedQueue();
const AGE_MS = 48 * 60 * 60 * 1000;

// All filesystem facts come from the host, including its tmpdir and case rules.
const scanScript = String.raw`
const fs=require('node:fs'),p=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const git=(...a)=>cp.execFileSync('git',['-C',process.cwd(),...a],{encoding:'utf8',timeout:30000});
const real=x=>{let d=x,rest=[];for(;;){try{return p.join(fs.realpathSync.native(d),...rest)}catch(e){if(e.code!=='ENOENT')throw e;const up=p.dirname(d);if(up===d)throw e;rest.unshift(p.basename(d));d=up}}};
const norm=x=>process.platform==='win32'?p.normalize(real(x)).toLowerCase():p.normalize(real(x));
const below=(x,root)=>{const r=p.relative(norm(root),norm(x));return !!r&&r!=='..'&&!r.startsWith('..'+p.sep)&&!p.isAbsolute(r)};
const repo=fs.realpathSync(git('rev-parse','--show-toplevel').trim());
const common=git('rev-parse','--path-format=absolute','--git-common-dir').trim();
const tmpRoot=fs.realpathSync(os.tmpdir()),worktreesRoot=p.join(p.dirname(repo),'worktrees'),leadRoot=p.join(p.dirname(repo),'lead-check');
const adminRoot=p.join(common,'worktrees');
const admins=(fs.existsSync(adminRoot)?fs.readdirSync(adminRoot):[]).map(adminId=>{
  const admin=p.join(adminRoot,adminId),gitdir=p.join(admin,'gitdir');
  const target=fs.readFileSync(gitdir,'utf8').trim();
  const birth=fs.statSync(admin).birthtimeMs;
  return {adminId,dir:p.dirname(target),registeredAt:birth>0?birth:fs.statSync(gitdir).mtimeMs};
});
const rows=git('worktree','list','--porcelain','-z').split('\0\0').filter(Boolean).map(block=>{
  const lines=block.split('\0'),dir=lines[0].slice(9);
  const matches=admins.filter(a=>norm(a.dir)===norm(dir));
  const admin=matches.length===1?matches[0]:undefined;
  const head=lines.find(x=>x.startsWith('HEAD '))?.slice(5)||'';
  const row={dir,head,detached:lines.includes('detached'),adminId:admin?.adminId||'',registeredAt:admin?.registeredAt||0,root:'',identity:null,seatRoot:false};
  try{
    let stat;try{stat=fs.lstatSync(dir)}catch(e){if(e.code!=='ENOENT')throw e}
    if(stat)row.identity={dev:stat.dev,ino:stat.ino,birthtimeMs:stat.birthtimeMs};
    if(stat?.isSymbolicLink())row.reason='checkout is a link';
    else if(norm(dir)===norm(repo))row.reason='host repo';
    else if(norm(dir)===norm(leadRoot)||below(dir,leadRoot))row.reason='lead-check';
    else if(lines.some(x=>x==='locked'||x.startsWith('locked ')))row.reason='locked';
    else if(stat&&!stat.isDirectory())row.reason='checkout is not a directory';
    else if(!admin)row.reason=matches.length>1?'ambiguous registration metadata':'registration metadata missing';
    else if(!Number.isFinite(row.registeredAt)||row.registeredAt<=0)row.reason='registration age unknown';
    else if(p.basename(dir).includes('.dropping-'))row.reason='dropping checkout';
    else if(norm(p.dirname(dir))===norm(worktreesRoot)){row.root=worktreesRoot;row.seatRoot=true}
    else if(below(dir,tmpRoot))row.root=tmpRoot;
    else row.reason='outside allowed roots';
  }catch(e){row.reason='inspection failed: '+e.message}
  return row;
});
console.log(JSON.stringify({repo,tmpRoot,worktreesRoot,leadRoot,platform:process.platform,rows}));
`;

const pinScript = String.raw`
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');
const e=JSON.parse(process.argv[1]);
const git=(...a)=>cp.execFileSync('git',a,{encoding:'utf8',timeout:30000}).trim();
if(!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(e.head))throw new Error('invalid swept HEAD');
const ref='refs/orch/swept/'+e.adminId;
git('check-ref-format',ref);
if(p.basename(e.adminId)!==e.adminId)throw new Error('invalid admin id');
const common=git('rev-parse','--path-format=absolute','--git-common-dir');
const admin=p.join(common,'worktrees',e.adminId);
if(fs.existsSync(admin)){
  if(fs.existsSync(p.join(admin,'locked')))throw new Error('sweep checkout is locked');
  const norm=x=>process.platform==='win32'?p.normalize(x).toLowerCase():p.normalize(x);
  if(norm(fs.readFileSync(p.join(admin,'gitdir'),'utf8').trim())!==norm(p.join(e.dir,'.git')))throw new Error('registration path changed');
  const birth=fs.statSync(admin).birthtimeMs;
  const registeredAt=birth>0?birth:fs.statSync(p.join(admin,'gitdir')).mtimeMs;
  const current=git('--git-dir='+admin,'rev-parse','HEAD');
  const symbolic=cp.spawnSync('git',['--git-dir='+admin,'symbolic-ref','-q','HEAD'],{encoding:'utf8',timeout:30000});
  if(![0,1].includes(symbolic.status))throw new Error('cannot determine swept HEAD state');
  if(registeredAt!==e.registeredAt||current!==e.head||(symbolic.status===1)!==e.detached)throw new Error('registration or HEAD changed');
}else if(!e.retry)throw new Error('registration disappeared before removal');
if(!e.detached)process.exit(0);
if(git('for-each-ref','--contains='+e.head,'--format=%(refname)'))process.exit(0);
// Never overwrite an earlier recovery pin if git reused an admin id.
git('update-ref',ref,e.head,'0'.repeat(e.head.length));
`;
const retryIdentityScript = String.raw`
const fs=require('node:fs');const e=JSON.parse(process.argv[1]);
let s;try{s=fs.lstatSync(e.dir)}catch(x){if(x.code!=='ENOENT')throw x}
if(s){
  if(s.isSymbolicLink())throw new Error('journal path is a link');
  if(!e.identity||s.dev!==e.identity.dev||s.ino!==e.identity.ino||s.birthtimeMs!==e.identity.birthtimeMs)
    throw new Error('journal path was replaced');
}
`;

async function hostNode(options: HostWorktreeSweepOptions, script: string, args: string[] = []): Promise<string> {
  const child = spawnProvider({ host: options.host, cwd: options.repo, command: 'node', args: ['-e', script, ...args] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try { return (await collect(child, undefined, 'host worktree sweep', Boolean(options.host))).toString('utf8').trim(); }
  finally { clearTimeout(timer); }
}

function readJournal(file: string): JournalEntry[] {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!Array.isArray(value) || value.some(e => !e || !['dir', 'root', 'adminId', 'repo', 'head'].every(k => typeof e[k] === 'string') ||
    !(e.host === null || typeof e.host === 'string') || typeof e.registeredAt !== 'number' || typeof e.detached !== 'boolean')) {
    throw new Error('invalid host worktree sweep journal');
  }
  return value as JournalEntry[];
}
function writeJournal(file: string, entries: JournalEntry[]): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { flush: true });
  renameSync(temp, file);
}

function norm(scan: Scan, value: string): string {
  const p = scan.platform === 'win32' ? path.win32 : path.posix;
  const normalized = p.normalize(value);
  return scan.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function seatReason(scan: Scan, row: Entry, seats: SweepSeat[], host: string | undefined): string | undefined {
  const p = scan.platform === 'win32' ? path.win32 : path.posix;
  if (norm(scan, p.dirname(row.dir)) === norm(scan, scan.worktreesRoot) && seats.some(s => norm(scan, s.id) === norm(scan, p.basename(row.dir)))) {
    return 'known seat id (any status)';
  }
  const onHost = seats.filter(s => s.data.host === host);
  const owner = onHost.find(s => [s.data.remoteDir, s.cwd, s.worktree].some(dir => typeof dir === 'string' && norm(scan, dir) === norm(scan, row.dir)));
  if (owner) return owner.status === 'closed' ? 'recorded seat checkout (any status)' : 'open-seat checkout';
  const open = onHost.filter(s => s.status !== 'closed');
  if (open.some(s => !Number.isFinite(Date.parse(s.created_at)) || row.registeredAt >= Date.parse(s.created_at))) return 'registered after an open seat';
}

/** One host, including a local transport (host undefined) for isolated git fixtures. */
export async function sweepHostWorktrees(options: HostWorktreeSweepOptions): Promise<HostWorktreeSweepEvent[]> {
  const { host, stateDir, dryRun = false } = options;
  return withHostClone(host ?? `local:${options.repo}`, () => journalQueue(stateDir, async () => {
    mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, 'host-worktree-sweep.json');
    const lockFile = `${file}.pid`;
    const lock = await acquireLock(lockFile);
    if (lock.ok === false) throw new Error(`host worktree sweep already running: ${lock.holder.reason}`);
    try {
      const events: HostWorktreeSweepEvent[] = [];
      const emit = (dir: string, action: HostWorktreeSweepEvent['action'], reason: string, retry = false) => {
        const event = { host: host ?? null, dir, action, reason, ...(retry ? { retry: true } : {}) };
        events.push(event); options.log?.(event);
      };
      const scan = JSON.parse(await hostNode(options, scanScript)) as Scan;
      let journal = readJournal(file);
      const pending = journal.filter(e => e.host === (host ?? null) && norm(scan, e.repo) === norm(scan, scan.repo));
      const seen = new Set<string>();
      const remove = async (entry: Entry, retry: boolean) => {
        emit(entry.dir, 'candidate', dryRun ? 'dry-run' : 'eligible', retry);
        if (dryRun) return;
        if (!retry) {
          journal.push({ ...entry, repo: scan.repo, host: host ?? null });
          writeJournal(file, journal); // Durable intent precedes pinning and deregistration.
        }
        await hostNode(options, retryIdentityScript, [JSON.stringify(entry)]);
        await hostNode(options, pinScript, [JSON.stringify({ ...entry, retry })]);
        await removeSweptWorktree(host, options.repo, entry.dir, entry.root);
        journal = journal.filter(e => !(e.host === (host ?? null) && norm(scan, e.repo) === norm(scan, scan.repo) && norm(scan, e.dir) === norm(scan, entry.dir)));
        writeJournal(file, journal);
        emit(entry.dir, 'removed', 'removed checkout and its registration', retry);
      };
      for (const entry of pending) {
        seen.add(norm(scan, entry.dir));
        try {
          const current = scan.rows.find(r => norm(scan, r.dir) === norm(scan, entry.dir));
          const reason = current?.reason ?? seatReason(scan, entry, options.seats(), host);
          if (reason) { emit(entry.dir, 'skip', reason, true); continue; }
          if (![scan.tmpRoot, scan.worktreesRoot].some(root => norm(scan, root) === norm(scan, entry.root))) throw new Error('journal root is no longer allowed');
          if (current && (current.adminId !== entry.adminId || current.registeredAt !== entry.registeredAt || current.head !== entry.head)) throw new Error('journal registration changed');
          await hostNode(options, retryIdentityScript, [JSON.stringify(entry)]);
          await remove(entry, true);
        } catch (error) { emit(entry.dir, 'error', (error as Error).message, true); }
      }
      for (const row of scan.rows) {
        if (seen.has(norm(scan, row.dir))) continue;
        const reason = row.reason ?? seatReason(scan, row, options.seats(), host) ??
          (Date.now() - row.registeredAt <= AGE_MS ? 'registered less than 48 hours ago' : undefined);
        if (reason) { emit(row.dir, 'skip', reason); continue; }
        try { await remove(row, false); }
        catch (error) { emit(row.dir, 'error', (error as Error).message); }
      }
      return events;
    } finally { releaseLock(lockFile); }
  }));
}
