import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {allocateVersion,currentVersion,reserveRemoteVersion,versionOf} from './build-version.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'nearcast-build-counter-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'build-version.json'),JSON.stringify({logicalVersion:'1.2.3',build:154}));return root;
}
test('parallel build allocations preserve every increment and retain one valid document',async t=>{
  const root=await fixture(t);
  const script=resolve('scripts/build-version.mjs');
  const values=await Promise.all(Array.from({length:8},()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,'allocate','1.2.3',root],{stdio:['ignore','pipe','pipe']});let output='',error='';
    child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>error+=value);
    child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(output).build):reject(Error(error)));
  })));
  assert.deepEqual(values.sort((a,b)=>a-b),[155,156,157,158,159,160,161,162]);
  assert.equal((await currentVersion(root)).display,'1.2.3.162');
});
test('logical version changes retain the counter and invalid data never resets or consumes it',async t=>{
  const root=await fixture(t);
  assert.equal((await allocateVersion({root,logicalVersion:'2.0.0'})).display,'2.0.0.155');
  await assert.rejects(allocateVersion({root,logicalVersion:'invalid'}));assert.equal((await currentVersion(root)).build,155);
  await writeFile(join(root,'build-version.json'),'{broken');
  await assert.rejects(allocateVersion({root}));assert.equal(await readFile(join(root,'build-version.json'),'utf8'),'{broken');
  await writeFile(join(root,'build-version.json'),JSON.stringify({logicalVersion:'1.0.0',build:65535}));
  await assert.rejects(allocateVersion({root}),/65535/);assert.equal((await currentVersion(root)).build,65535);
  assert.throws(()=>versionOf({logicalVersion:'01.0.0',build:1}));
});
test('an existing allocation lock times out without overwriting the counter',async t=>{
  const root=await fixture(t);await writeFile(join(root,'build-version.json.lock'),'');
  await assert.rejects(allocateVersion({root,lockTimeoutMs:25}),/locked/);
  assert.equal((await currentVersion(root)).build,154);
});
test('CI reservations persist across fresh source checkouts independently of run numbers',async t=>{
  const root=await fixture(t),bare=join(root,'remote.git');
  const git=(args,cwd=root)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  git(['init','--bare',bare]);
  const source=join(root,'source');await mkdir(source);git(['init','-b','main',source]);
  git(['config','user.name','Counter test'],source);git(['config','user.email','counter@example.invalid'],source);
  await writeFile(join(source,'build-version.json'),JSON.stringify({logicalVersion:'1.0.0',build:154}));
  git(['add','build-version.json'],source);git(['commit','-m','source'],source);git(['remote','add','origin',bare],source);git(['push','origin','main'],source);
  const before=git(['rev-parse','HEAD'],source);
  assert.equal((await reserveRemoteVersion({root:source})).build,155);
  const fresh=join(root,'fresh');git(['clone','--branch','main',bare,fresh]);
  assert.equal((await reserveRemoteVersion({root:fresh})).build,156);
  assert.equal(git(['rev-parse','HEAD'],source),before,'reserving metadata never changes product source history');
  assert.equal(JSON.parse(git(['show','refs/heads/build-counter:build-version.json'],bare)).build,156);
});
