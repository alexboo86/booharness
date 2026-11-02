import { normalizedPath, SNAPSHOT } from './codegraph-seed.ts';

// Shared with seat MCP provisioning: Windows npm shims cannot be spawned as executables.
export const CODEGRAPH_INVOCATION = String.raw`
const fs=require('node:fs'),p=require('node:path');
const dirs=(process.env.PATH||process.env.Path||'').split(p.delimiter);
let invocation;
for(const dir of dirs){
  if(!dir)continue;
  if(process.platform==='win32' && fs.existsSync(p.join(dir,'codegraph.cmd'))){
    const root=p.join(dir,'node_modules','@colbymchenry','codegraph');
    const manifest=p.join(root,'package.json');
    if(!fs.existsSync(manifest))continue;
    const bin=JSON.parse(fs.readFileSync(manifest,'utf8')).bin?.codegraph;
    const script=typeof bin==='string' ? p.resolve(root,bin) : '';
    if(!script || !fs.existsSync(script))continue;
    invocation={command:process.execPath,args:[script]};break;
  }
  if(process.platform!=='win32' && fs.existsSync(p.join(dir,'codegraph'))){
    const binary=fs.realpathSync(p.join(dir,'codegraph'));
    invocation=/\.[cm]?js$/.test(binary) ? {command:process.execPath,args:[binary]} : {command:binary,args:[]};break;
  }
}
if(!invocation)throw new Error('cannot resolve host CodeGraph executable for seat MCP');
`;

/** One host-side node invocation; sources are confined to the configured clone. */
export function remoteCodegraphScript(repo: string, mode: 'seed' | 'upkeep'): string {
  return `const fs=require('node:fs'),path=require('node:path'),p=path;
function resolveInvocation(){${CODEGRAPH_INVOCATION}\nreturn invocation}
let invocation;
const {spawn}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const {randomUUID}=require('node:crypto');
const repo=${JSON.stringify(repo)}, mode=${JSON.stringify(mode)};
${normalizedPath.toString()}
const dir=process.cwd(), target=p.join(dir,'.codegraph'), source=p.join(repo,'.codegraph','codegraph.db');
let owned=false;
function run(command,args){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:dir,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let output='',tail='';
    child.stdout.on('data',chunk=>{output=(output+chunk).slice(-100000)});
    child.stderr.on('data',chunk=>{tail=(tail+chunk).slice(-2000);process.stderr.write(chunk)});
    child.once('error',reject);
    child.once('close',code=>code===0?resolve(output):reject(new Error('codegraph child exit '+code+': '+tail)));
  });
}
const cg=(args)=>run(invocation.command,[...invocation.args,...args]);
const sync=()=>run(process.execPath,[p.join(repo,'ops/orchestrator/build-gate.mjs'),'--exec',invocation.command,...invocation.args,'sync','.']);
// run() caps stdout at its tail; counting diff paths through it truncated large diffs and mis-ranked seeds.
function countDiffPaths(commit){
  return new Promise((resolve,reject)=>{
    const child=spawn('git',['diff','--name-only','-z',commit,'HEAD','--'],{cwd:dir,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let count=0,tail='';
    child.stdout.on('data',chunk=>{for(let i=0;i<chunk.length;i++)if(chunk[i]===0)count++});
    child.stderr.on('data',chunk=>{tail=(tail+chunk).slice(-2000);process.stderr.write(chunk)});
    child.once('error',reject);
    child.once('close',code=>code===0?resolve(count):reject(new Error('git diff exit '+code+': '+tail)));
  });
}
async function stop(){
  if(process.platform==='win32')return;
  const {stopCodegraphDaemon}=await import(pathToFileURL(p.join(repo,'ops/orchestrator/src/worktrees.ts')).href);
  await stopCodegraphDaemon(dir);
}
function completeSource(){
  if(!fs.existsSync(source))return false;
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(source,{readOnly:true});
  try{return db.prepare('SELECT value FROM project_metadata WHERE key = ?').get('index_state')?.value==='complete'}
  finally{db.close()}
}
function snapshotPaths(seeds){
  try{return fs.readdirSync(seeds,{withFileTypes:true})
    .filter(entry=>entry.isFile()&&entry.name.endsWith('.db'))
    .map(entry=>p.join(seeds,entry.name)).sort()}
  catch(e){if(e.code==='ENOENT')return [];throw e}
}
function qualified(file,version,extraction){
  if(!fs.existsSync(file))return null;
  const {DatabaseSync}=require('node:sqlite');
  let db;
  try{
    db=new DatabaseSync(file,{readOnly:true});
    const metadata=db.prepare('SELECT value FROM project_metadata WHERE key = ?');
    const commit=metadata.get('indexed_at_commit')?.value;
    if(metadata.get('index_state')?.value!=='complete'||metadata.get('indexed_with_version')?.value!==version||
      metadata.get('indexed_with_extraction_version')?.value!==String(extraction)||typeof commit!=='string'||!commit.trim())return null;
    return {file,commit:commit.trim()};
  }catch{return null}finally{db?.close()}
}
async function closest(version,extraction,seeds){
  let best=null;
  for(const file of [source,...snapshotPaths(seeds)]){
    const candidate=qualified(file,version,extraction);
    if(!candidate)continue;
    try{
      const changes=await countDiffPaths(candidate.commit);
      if(!best||changes<best.changes)best={...candidate,changes};
    }catch{/* A missing or unreadable candidate commit is not a usable seed. */}
  }
  return best;
}
async function retain(version,seeds){
  // Snapshot keeping and pruning are best-effort cache work: a failure is logged and never
  // removes or fails the seat's verified index; a skipped file is pruned on a later run.
  try{
    fs.mkdirSync(seeds,{recursive:true});
    const id=Date.now()+'-'+process.pid+'-'+randomUUID();
    const temporary=p.join(seeds,'.'+id+'.tmp'), destination=p.join(seeds,id+'.db');
    try{
      await run(process.execPath,['-e',${JSON.stringify(SNAPSHOT)},p.join(target,'codegraph.db'),temporary,version]);
      fs.renameSync(temporary,destination);
    }finally{fs.rmSync(temporary,{force:true})}
    const retained=snapshotPaths(seeds);
    while(retained.length>3){
      const stale=retained.shift();
      try{fs.rmSync(stale,{force:true})}
      catch(e){process.stderr.write('codegraph seed kept unpruned snapshot '+stale+': '+e.message+'\\n')}
    }
    // Every new tree opens a bucket: keep this one and the two most recently written others,
    // and drop flat snapshots left by the cache layout before tree buckets.
    const root=p.dirname(seeds), others=[];
    for(const entry of fs.readdirSync(root,{withFileTypes:true})){
      const file=p.join(root,entry.name);
      try{
        if(entry.isFile()&&entry.name.endsWith('.db'))fs.rmSync(file,{force:true});
        else if(entry.isDirectory()&&file!==seeds)others.push({file,mtime:fs.statSync(file).mtimeMs});
      }catch(e){process.stderr.write('codegraph seed kept unpruned '+file+': '+e.message+'\\n')}
    }
    for(const stale of others.sort((a,b)=>b.mtime-a.mtime).slice(2)){
      try{fs.rmSync(stale.file,{recursive:true,force:true})}
      catch(e){process.stderr.write('codegraph seed kept unpruned bucket '+stale.file+': '+e.message+'\\n')}
    }
  }catch(e){process.stderr.write('codegraph seed snapshot retention failed: '+e.message+'\\n')}
}
function verify(output){
  const status=JSON.parse(output);
  const win=process.platform==='win32';
  if(normalizedPath(status.projectPath,win)!==normalizedPath(dir,win)||status.initialized!==true||status.index?.state!=='complete'||
    !(status.fileCount>0&&status.nodeCount>0&&status.dbSizeBytes>0))throw new Error('seed index is not complete for this checkout');
}
async function seed(){
  try{fs.lstatSync(target);return}catch(e){if(e.code!=='ENOENT')throw e}
  const tree=(await run('git',['rev-parse','HEAD^{tree}'])).trim();
  if(!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tree))throw new Error('cannot determine seat tree for codegraph seed');
  const seeds=p.join(repo,'.codegraph-seeds',tree);
  if(!fs.existsSync(source)&&snapshotPaths(seeds).length===0)return;
  invocation=resolveInvocation();
  const version=(await cg(['--version'])).trim();
  if(!/^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?$/.test(version))throw new Error('unrecognized codegraph version');
  const cloneStatus=JSON.parse(await cg(['status','--json',repo]));
  const extraction=cloneStatus.index?.currentExtractionVersion;
  if(!Number.isInteger(extraction))throw new Error('cannot determine current codegraph extraction version');
  const selected=await closest(version,extraction,seeds);
  if(!selected){
    process.stderr.write('codegraph seed skipped: no index matches codegraph '+version+' extraction '+extraction+' with a reachable commit\\n');
    return;
  }
  try{fs.mkdirSync(target);owned=true}catch(e){if(e.code==='EEXIST')return;throw e}
  await run(process.execPath,['-e',${JSON.stringify(SNAPSHOT)},selected.file,p.join(target,'codegraph.db'),version]);
  const ignore=p.join(repo,'.codegraph','.gitignore');
  if(fs.existsSync(ignore))fs.copyFileSync(ignore,p.join(target,'.gitignore'));
  await sync();
  verify(await cg(['status','--json','.']));
  await retain(version,seeds);
  process.stdout.write('codegraph seeded index verified');
}
async function main(){
  if(mode==='upkeep'){
    if(!completeSource())return;
    try{invocation=resolveInvocation();await sync()}finally{await stop()}
  }else{
    try{await seed()}catch(error){
      if(owned){
        try{await stop();fs.rmSync(target,{recursive:true,force:true})}
        catch(cleanup){throw new Error(error.message+'; cleanup failed: '+cleanup.message)}
      }
      throw error;
    }
  }
}
main().catch(error=>{console.error('codegraph '+mode+' failed: '+error.message);process.exitCode=1});
`;
}

export function remoteCodegraphSeed(repo: string): string {
  // Raw JavaScript goes straight to native node: Git Bash can strip embedded Windows backslashes.
  return `// orch-codegraph-seed\n${remoteCodegraphScript(repo, 'seed')}`;
}
