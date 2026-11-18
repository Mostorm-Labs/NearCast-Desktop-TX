import {open,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

export const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const counterFile='build-version.json';
export function versionOf(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['logicalVersion','build'].includes(key)))throw Error('Invalid build counter document');
  const {logicalVersion,build}=value;
  if(typeof logicalVersion!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(logicalVersion)||logicalVersion.split('.').some(part=>Number(part)>65535))throw Error('Expected bounded X.Y.Z logical version');
  if(!Number.isInteger(build)||build<0||build>65535)throw Error('Build counter must be an integer from 0 to 65535');
  return {logicalVersion,build,display:logicalVersion+'.'+build,semver:logicalVersion+'+'+build};
}
export function parseVersion(text){
  const parts=String(text).split('.');
  if(parts.length!==4||!/^(0|[1-9]\d*)$/.test(parts[3]))throw Error('Expected X.Y.Z.Build');
  return versionOf({logicalVersion:parts.slice(0,3).join('.'),build:Number(parts[3])});
}
export async function currentVersion(root=projectRoot){
  return versionOf(JSON.parse(await readFile(resolve(root,counterFile),'utf8')));
}
export async function allocateVersion({root=projectRoot,logicalVersion,minimumBuild=0,lockTimeoutMs=10000}={}){
  const path=resolve(root,counterFile),lockPath=path+'.lock',until=Date.now()+lockTimeoutMs;
  let lock;
  while(!lock){try{lock=await open(lockPath,'wx');}catch(error){if(error.code!=='EEXIST')throw error;if(Date.now()>=until)throw Error('Build counter is locked; finish the other build allocation first');await new Promise(r=>setTimeout(r,20));}}
  const temporary=path+'.'+randomUUID()+'.tmp';
  try{
    const current=await currentVersion(root);
    if(!Number.isInteger(minimumBuild)||minimumBuild<0||minimumBuild>65535)throw Error('Invalid minimum build counter');
    const next=versionOf({logicalVersion:logicalVersion??current.logicalVersion,build:Math.max(current.build,minimumBuild)+1});
    const file=await open(temporary,'wx');
    try{await file.writeFile(JSON.stringify({logicalVersion:next.logicalVersion,build:next.build},null,2)+'\n');await file.sync();}finally{await file.close();}
    await rename(temporary,path);return next;
  }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});await lock.close();await unlink(lockPath);}
}

// Trusted CI persists the SAME counter file on a dedicated metadata branch.
// Ordinary fast-forward push is the compare-and-swap: a competing reservation
// forces a fresh read and another increment. Never switch the source checkout.
export async function reserveRemoteVersion({root=projectRoot,logicalVersion,remote='origin',ref='refs/heads/build-counter'}={}){
  if(!/^[A-Za-z0-9_-]+$/.test(remote)||!/^refs\/heads\/[A-Za-z0-9/_-]+$/.test(ref))throw Error('Invalid build counter remote/ref');
  const git=(args,options={})=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:1024*1024,...options});
  for(let attempt=0;attempt<5;attempt++){
    const entry=git(['ls-remote','--heads',remote,ref]).trim();let parent,minimumBuild=0;
    if(entry){git(['fetch','--no-tags','--no-recurse-submodules',remote,ref]);parent=git(['rev-parse','FETCH_HEAD']).trim();minimumBuild=versionOf(JSON.parse(git(['show',parent+':'+counterFile]))).build;}
    const next=await allocateVersion({root,logicalVersion,minimumBuild});
    const content=JSON.stringify({logicalVersion:next.logicalVersion,build:next.build},null,2)+'\n';
    const blob=git(['hash-object','-w','--stdin'],{input:content}).trim();
    const tree=git(['mktree'],{input:`100644 blob ${blob}\t${counterFile}\n`}).trim();
    const commit=git(['commit-tree',tree,...(parent?['-p',parent]:[]),'-m','Reserve build '+next.display],{env:{...process.env,
      GIT_AUTHOR_NAME:'Build counter',GIT_AUTHOR_EMAIL:'build-counter@users.noreply.github.com',GIT_COMMITTER_NAME:'Build counter',GIT_COMMITTER_EMAIL:'build-counter@users.noreply.github.com'}}).trim();
    try{git(['push',remote,commit+':'+ref]);return next;}catch(error){if(attempt===4)throw error;}
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,logicalVersion,selectedRoot]=process.argv.slice(2);const root=selectedRoot?resolve(selectedRoot):projectRoot;
  const value=command==='allocate'?await allocateVersion({root,logicalVersion}):command==='reserve'?await reserveRemoteVersion({root,logicalVersion}):command==='current'?await currentVersion(root):null;
  if(!value)throw Error('Expected current, allocate or reserve [X.Y.Z]');
  console.log(JSON.stringify(value));
}
