import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildDesktop,bundleVersionConfig} from '../scripts/build.mjs';
import {currentVersion} from '../scripts/build-version.mjs';

test('one application build increments once and gives Cargo and the bundler matching metadata',async t=>{
  const root=await mkdtemp(join(tmpdir(),'nearcast-build-command-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'build-version.json'),JSON.stringify({logicalVersion:'0.1.0',build:6}));
  const calls=[],run=(exe,args,options)=>{calls.push({exe,args,options});return{status:1};};
  assert.equal(await buildDesktop(['--no-bundle','--','--locked'],{root,host:'win32',env:{},run}),1);
  assert.equal((await currentVersion(root)).build,7,'failed build keeps its allocated count');
  assert.equal(calls[0].options.env.NEARCAST_BUILD_VERSION,'0.1.0.7');
  const config=JSON.parse(calls[0].args[calls[0].args.indexOf('--config')+1]);
  assert.equal(config.version,'0.1.0+7');assert.equal(config.bundle.windows.wix.version,'1.0.7');
  assert.deepEqual(calls[0].args.slice(-2),['--','--locked']);
  await buildDesktop([],{root,host:'win32',env:{NEARCAST_BUILD_VERSION:'0.1.0.7'},run});
  assert.equal((await currentVersion(root)).build,7,'another platform in the reserved batch reuses its count');
  await assert.rejects(buildDesktop([],{root,host:'win32',env:{NEARCAST_BUILD_VERSION:'0.1.0.8'},run}),/match/);
  assert.deepEqual(bundleVersionConfig({semver:'0.1.0+7',build:7},'macos',{APPLE_SIGNING_IDENTITY:'stable'}),
    {version:'0.1.0+7',bundle:{macOS:{bundleVersion:'7',signingIdentity:'stable'}}});
});

test('blank Apple secrets are absent from Tauri environment while real credentials survive',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tx-apple-env-'));
  try{
    await writeFile(join(root,'build-version.json'),JSON.stringify({logicalVersion:'0.1.0',build:6}));
    let child;
    await buildDesktop(['--target','aarch64-apple-darwin'],{root,env:{APPLE_CERTIFICATE:'',APPLE_ID:'  ',APPLE_SIGNING_IDENTITY:'-',APPLE_TEAM_ID:'configured-team'},run:(_cmd,_args,options)=>{child=options.env;return{status:0};}});
    assert.equal('APPLE_CERTIFICATE' in child,false);assert.equal('APPLE_ID' in child,false);
    assert.equal(child.APPLE_SIGNING_IDENTITY,'-');assert.equal(child.APPLE_TEAM_ID,'configured-team');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('public macOS builds reject missing distribution credentials before reserving a Build',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tx-public-macos-'));
  try{
    await writeFile(join(root,'build-version.json'),JSON.stringify({logicalVersion:'0.2.0',build:37}));
    let invoked=false;
    await assert.rejects(buildDesktop(['--target','aarch64-apple-darwin'],{root,env:{NEARCAST_REQUIRE_MACOS_SIGNING:'1'},run:()=>{invoked=true;return{status:0};}}),/APPLE_/);
    assert.equal(invoked,false);assert.equal((await currentVersion(root)).build,37);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a failed macOS build removes its temporary notarization key and Windows stays independent',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tx-notary-build-'));let keyPath;
  try{
    await writeFile(join(root,'build-version.json'),JSON.stringify({logicalVersion:'0.2.0',build:37}));
    const env={NEARCAST_REQUIRE_MACOS_SIGNING:'1',APPLE_CERTIFICATE:'fixture-p12',APPLE_CERTIFICATE_PASSWORD:'fixture-password',APPLE_SIGNING_IDENTITY:'Developer ID Application: Fixture (AB12CD34EF)',APPLE_TEAM_ID:'AB12CD34EF',APPLE_API_KEY:'FIXTURE123',APPLE_API_ISSUER:'fixture-issuer',APPLE_API_KEY_P8:'fixture-private-key',RUNNER_TEMP:root};
    await assert.rejects(buildDesktop(['--target','aarch64-apple-darwin'],{root,env,run:(_command,args,options)=>{
      keyPath=options.env.APPLE_API_KEY_PATH;
      assert.equal(options.env.APPLE_API_KEY_P8,undefined);
      const overlay=JSON.parse(args[args.lastIndexOf('--config')+1]);
      assert.equal(overlay.bundle.macOS.hardenedRuntime,true);
      throw Error('fixture build failed');
    }}),/fixture build failed/);
    assert.ok(keyPath);await assert.rejects(readFile(keyPath));
    assert.equal(await buildDesktop(['--target','x86_64-pc-windows-msvc'],{root,env:{NEARCAST_REQUIRE_MACOS_SIGNING:'1'},run:()=>({status:0})}),0);
  }finally{await rm(root,{recursive:true,force:true});}
});
