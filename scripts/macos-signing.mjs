import {spawnSync} from 'node:child_process';
import {accessSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const API_FIELDS=['APPLE_API_KEY','APPLE_API_ISSUER','APPLE_API_KEY_P8','APPLE_API_KEY_PATH'];
const present=(env,key)=>Boolean(String(env[key]??'').trim());
function required(env,key){if(!present(env,key))throw Error(`Configure ${key} for macOS distribution`);return env[key];}
function signingIdentity(env){
  const identity=required(env,'APPLE_SIGNING_IDENTITY').trim();
  const match=/^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(identity);
  if(!match)throw Error('APPLE_SIGNING_IDENTITY must be a Developer ID Application identity');
  const teamId=required(env,'APPLE_TEAM_ID').trim();
  if(teamId!==match[1])throw Error('APPLE_TEAM_ID must match the signing certificate team');
  return{identity,teamId};
}
export function validateMacosSigningEnvironment(env){
  const identity=signingIdentity(env);
  required(env,'APPLE_CERTIFICATE');required(env,'APPLE_CERTIFICATE_PASSWORD');
  const method=String(env.APPLE_NOTARIZATION_METHOD||'').trim();
  if(method&&!['apple-id','api-key'].includes(method))throw Error('APPLE_NOTARIZATION_METHOD must be apple-id or api-key');
  const api=method?method==='api-key':API_FIELDS.some(key=>present(env,key));
  if(api){
    required(env,'APPLE_API_KEY');required(env,'APPLE_API_ISSUER');
    if(!present(env,'APPLE_API_KEY_P8')&&!present(env,'APPLE_API_KEY_PATH'))throw Error('Configure APPLE_API_KEY_P8 or APPLE_API_KEY_PATH for notarization');
    if(present(env,'APPLE_API_KEY_P8')&&present(env,'APPLE_API_KEY_PATH'))throw Error('Configure only one of APPLE_API_KEY_P8 and APPLE_API_KEY_PATH');
  }else{required(env,'APPLE_ID');required(env,'APPLE_PASSWORD');}
  return{...identity,notarization:api?'api-key':'apple-id'};
}
export function prepareMacosSigningEnvironment(env){
  const config=validateMacosSigningEnvironment(env);
  const child={...env,APPLE_SIGNING_IDENTITY:config.identity,APPLE_TEAM_ID:config.teamId};
  let directory;
  const cleanup=()=>{if(directory)rmSync(directory,{recursive:true,force:true});};
  try{
    if(config.notarization==='api-key'){
      delete child.APPLE_ID;delete child.APPLE_PASSWORD;
      if(present(env,'APPLE_API_KEY_P8')){
        directory=mkdtempSync(join(env.RUNNER_TEMP||tmpdir(),'nearcast-notary-'));
        child.APPLE_API_KEY_PATH=join(directory,'AuthKey.p8');
        writeFileSync(child.APPLE_API_KEY_PATH,env.APPLE_API_KEY_P8,{mode:0o600,flag:'wx'});
      }else{
        try{accessSync(child.APPLE_API_KEY_PATH);}catch{throw Error('APPLE_API_KEY_PATH must point to a readable notarization key');}
      }
    }else for(const key of API_FIELDS)delete child[key];
    delete child.APPLE_API_KEY_P8;
    return{env:child,cleanup};
  }catch(error){cleanup();throw error;}
}
export function verifyMacosDistribution(app,{env=process.env,run=spawnSync}={}){
  const expected=signingIdentity(env);
  const command=(binary,args,label)=>{
    const result=run(binary,args,{encoding:'utf8',stdio:'pipe'});
    // Never include command environment or raw tool errors in a credential log.
    if(result.error||result.status!==0)throw Error(label+' failed');
    return String(result.stdout||'')+String(result.stderr||'');
  };
  command('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app],'macOS code signature verification');
  const details=command('/usr/bin/codesign',['--display','--verbose=4',app],'macOS signature inspection');
  if(!details.split(/\r?\n/).includes('Authority='+expected.identity))throw Error('macOS signature does not use the configured Developer ID Application identity');
  if(!details.split(/\r?\n/).includes('TeamIdentifier='+expected.teamId))throw Error('macOS signature team does not match APPLE_TEAM_ID');
  if(!/flags=.*\bruntime\b/.test(details))throw Error('macOS signature is missing hardened runtime');
  command('/usr/bin/xcrun',['stapler','validate',app],'macOS stapled notarization ticket validation');
  command('/usr/sbin/spctl',['--assess','--type','execute','--verbose=2',app],'macOS Gatekeeper assessment');
  return expected;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv[2]==='check'){
      const config=validateMacosSigningEnvironment(process.env);
      console.log(`macOS distribution credentials complete (${config.notarization}); values are not displayed.`);
    }else if(process.argv[2]==='verify'&&process.argv[3]){
      verifyMacosDistribution(resolve(process.argv[3]));
      console.log('Verified Developer ID, hardened runtime, stapled notarization and Gatekeeper assessment.');
    }else throw Error('Usage: macos-signing.mjs check | verify <application.app>');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
