import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
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
