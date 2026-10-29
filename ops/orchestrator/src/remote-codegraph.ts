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
function verify(output){
  const status=JSON.parse(output);
  const win=process.platform==='win32';
  if(normalizedPath(status.projectPath,win)!==normalizedPath(dir,win)||status.initialized!==true||status.index?.state!=='complete'||
    !(status.fileCount>0&&status.nodeCount>0&&status.dbSizeBytes>0))throw new Error('seed index is not complete for this checkout');
}
async function seed(){
  try{fs.lstatSync(target);return}catch(e){if(e.code!=='ENOENT')throw e}
  if(!fs.existsSync(source))return;
  invocation=resolveInvocation();
  const version=(await cg(['--version'])).trim();
  if(!/^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?$/.test(version))throw new Error('unrecognized codegraph version');
  try{fs.mkdirSync(target);owned=true}catch(e){if(e.code==='EEXIST')return;throw e}
  await run(process.execPath,['-e',${JSON.stringify(SNAPSHOT)},source,p.join(target,'codegraph.db'),version]);
  const ignore=p.join(repo,'.codegraph','.gitignore');
  if(fs.existsSync(ignore))fs.copyFileSync(ignore,p.join(target,'.gitignore'));
  await sync();
  verify(await cg(['status','--json','.']));
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
