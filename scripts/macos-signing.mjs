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
function checkedTool(run,binary,args,label,env){
  const result=run(binary,args,{encoding:'utf8',stdio:'pipe',env});
  // Tool errors may contain command arguments that include credentials.
  if(result.error||result.status!==0)throw Error(label+' failed');
  return result;
}

function verifyDeveloperId(file,expected,run,{app=false}={}){
  const verification=['--verify','--strict','--verbose=2',file];
  if(app)verification.unshift('--deep');
  checkedTool(run,'/usr/bin/codesign',verification,'macOS code signature verification');
  const {stdout,stderr}=checkedTool(run,'/usr/bin/codesign',['--display','--verbose=4',file],'macOS signature inspection');
  const details=String(stdout||'')+String(stderr||'');
  if(!details.split(/\r?\n/).includes('Authority='+expected.identity))throw Error('macOS signature does not use the configured Developer ID Application identity');
  if(!details.split(/\r?\n/).includes('TeamIdentifier='+expected.teamId))throw Error('macOS signature team does not match APPLE_TEAM_ID');
  if(app&&!/flags=.*\bruntime\b/.test(details))throw Error('macOS signature is missing hardened runtime');
}

export function verifyMacosDistribution(app,{env=process.env,run=spawnSync}={}){
  const expected=signingIdentity(env);
  verifyDeveloperId(app,expected,run,{app:true});
  checkedTool(run,'/usr/bin/xcrun',['stapler','validate',app],'macOS stapled notarization ticket validation');
  checkedTool(run,'/usr/sbin/spctl',['--assess','--type','execute','--verbose=2',app],'macOS Gatekeeper assessment');
  return expected;
}

export function notarizeMacosDiskImage(dmg,{env=process.env,run=spawnSync}={}){
  const config=validateMacosSigningEnvironment(env);
  verifyDeveloperId(dmg,config,run);
  const prepared=prepareMacosSigningEnvironment(env);
  try{
    const child=prepared.env;
    const auth=config.notarization==='api-key'
      ? ['--key',child.APPLE_API_KEY_PATH,'--key-id',child.APPLE_API_KEY,'--issuer',child.APPLE_API_ISSUER]
      : ['--apple-id',child.APPLE_ID,'--team-id',child.APPLE_TEAM_ID,'--password',child.APPLE_PASSWORD];
    const {stdout}=checkedTool(run,'/usr/bin/xcrun',
      ['notarytool','submit',dmg,'--wait','--timeout','30m','--output-format','json',...auth],
      'macOS disk image notarization submission',child);
    let submission;
    try{submission=JSON.parse(stdout);}catch{throw Error('Invalid macOS disk image notarization response');}
    if(submission?.status!=='Accepted'){
      const id=/^[0-9a-f-]{36}$/i.test(submission?.id)?` (submission ${submission.id})`:'';
      throw Error('macOS disk image notarization was not accepted'+id);
    }
    checkedTool(run,'/usr/bin/xcrun',['stapler','staple',dmg],'macOS disk image stapling');
    checkedTool(run,'/usr/bin/xcrun',['stapler','validate',dmg],'macOS disk image notarization ticket validation');
    checkedTool(run,'/usr/sbin/spctl',['--assess','--type','open','--context','context:primary-signature','--verbose=2',dmg],
      'macOS disk image Gatekeeper assessment');
  }finally{prepared.cleanup();}
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
