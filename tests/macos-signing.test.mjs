import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateMacosSigningEnvironment,prepareMacosSigningEnvironment,verifyMacosDistribution} from '../scripts/macos-signing.mjs';

const identity='Developer ID Application: Example Company (AB12CD34EF)';
const credentials=()=>({APPLE_CERTIFICATE:'test-p12-base64',APPLE_CERTIFICATE_PASSWORD:'test-p12-password',APPLE_SIGNING_IDENTITY:identity,APPLE_TEAM_ID:'AB12CD34EF',APPLE_ID:'ci@example.invalid',APPLE_PASSWORD:'test-app-specific-password'});
test('distribution signing needs a Developer ID identity, matching team and complete notarization credentials',()=>{
  assert.deepEqual(validateMacosSigningEnvironment(credentials()),{identity,teamId:'AB12CD34EF',notarization:'apple-id'});
  for(const name of ['APPLE_CERTIFICATE','APPLE_CERTIFICATE_PASSWORD','APPLE_SIGNING_IDENTITY','APPLE_TEAM_ID','APPLE_ID','APPLE_PASSWORD']){
    const env=credentials();delete env[name];assert.throws(()=>validateMacosSigningEnvironment(env),/APPLE_/);
  }
  for(const name of ['-','Apple Development: Example (AB12CD34EF)'])assert.throws(()=>validateMacosSigningEnvironment({...credentials(),APPLE_SIGNING_IDENTITY:name}),/Developer ID Application/);
  assert.throws(()=>validateMacosSigningEnvironment({...credentials(),APPLE_TEAM_ID:'ZZ12CD34EF'}),/team/i);
});
test('API notarization rejects partial keys and does not silently use another credential set',()=>{
  const env={...credentials(),APPLE_API_KEY:'KEY1234567',APPLE_API_ISSUER:'test-issuer',APPLE_API_KEY_P8:'test-private-key'};
  assert.equal(validateMacosSigningEnvironment(env).notarization,'api-key');
  for(const name of ['APPLE_API_KEY','APPLE_API_ISSUER','APPLE_API_KEY_P8']){
    const partial={...env};delete partial[name];assert.throws(()=>validateMacosSigningEnvironment(partial),/APPLE_API/);
  }
  assert.equal(validateMacosSigningEnvironment({...credentials(),APPLE_API_KEY:'unused-partial-key',APPLE_NOTARIZATION_METHOD:'apple-id'}).notarization,'apple-id');
  assert.throws(()=>validateMacosSigningEnvironment({...env,APPLE_NOTARIZATION_METHOD:'unknown'}),/APPLE_NOTARIZATION_METHOD/);
});
test('temporary API credentials are private, excluded from the child environment and removed after use',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tx-notary-test-'));
  try{
    const prepared=prepareMacosSigningEnvironment({...credentials(),RUNNER_TEMP:directory,APPLE_API_KEY:'KEY1234567',APPLE_API_ISSUER:'test-issuer',APPLE_API_KEY_P8:'test-private-key'});
    const path=prepared.env.APPLE_API_KEY_PATH;
    assert.equal(await readFile(path,'utf8'),'test-private-key');
    if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
    assert.equal(prepared.env.APPLE_API_KEY_P8,undefined);assert.equal(prepared.env.APPLE_ID,undefined);assert.equal(prepared.env.APPLE_PASSWORD,undefined);
    prepared.cleanup();await assert.rejects(access(path));
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('release verification rejects development signatures, wrong teams and non-hardened binaries',()=>{
  const details=`Authority=${identity}\nTeamIdentifier=AB12CD34EF\nCodeDirectory flags=0x10000(runtime)\n`;
  const verify=(metadata,failure)=>verifyMacosDistribution('Example.app',{env:credentials(),run:(command,args)=>({status:failure?.(command,args)?1:0,stdout:'',stderr:args.includes('--display')?metadata:''})});
  assert.deepEqual(verify(details),{identity,teamId:'AB12CD34EF'});
  for(const metadata of [details.replace('Developer ID Application','Apple Development'),details.replace('TeamIdentifier=AB12CD34EF','TeamIdentifier=ZZ12CD34EF'),details.replace('(runtime)','')])assert.throws(()=>verify(metadata),/signature|team|runtime/i);
  assert.throws(()=>verify(details,(cmd,args)=>cmd==='/usr/bin/codesign'&&args.includes('--verify')),/signature/i);
  assert.throws(()=>verify(details,cmd=>cmd==='/usr/bin/xcrun'),/notarization/i);
  assert.throws(()=>verify(details,cmd=>cmd==='/usr/sbin/spctl'),/Gatekeeper/i);
});
