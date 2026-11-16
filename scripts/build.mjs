import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {allocateVersion,currentVersion,parseVersion,projectRoot} from './build-version.mjs';

export function bundleVersionConfig(version,platform,env={}){
  return {version:version.semver,bundle:platform==='windows'?{windows:{wix:{version:'1.0.'+version.build}}}:
    {macOS:{bundleVersion:String(version.build),...(env.APPLE_SIGNING_IDENTITY?{signingIdentity:env.APPLE_SIGNING_IDENTITY}:{})}}};
}
export async function buildDesktop(args=[],{root=projectRoot,env=process.env,host=process.platform,run=spawnSync}={}){
  if(args.some(arg=>['-h','--help','-V','--version'].includes(arg))){const result=run(process.execPath,[resolve(root,'node_modules/@tauri-apps/cli/tauri.js'),'build',...args],{cwd:root,env,stdio:'inherit'});if(result.error)throw result.error;return result.status??1;}
  const targetIndex=args.findIndex(arg=>arg==='--target'||arg==='-t'),target=targetIndex<0?args.find(arg=>arg.startsWith('--target='))?.slice(9):args[targetIndex+1];
  const platform=target?(target.includes('apple-darwin')?'macos':target.includes('windows')?'windows':null):host==='win32'?'windows':host==='darwin'?'macos':null;
  if(!platform)throw Error('Build target must be Windows or macOS');
  let version;
  if(env.NEARCAST_BUILD_VERSION){version=parseVersion(env.NEARCAST_BUILD_VERSION);if(version.build===0||(await currentVersion(root)).display!==version.display)throw Error('Assigned build must match build-version.json');}
  else version=await allocateVersion({root});
  const divider=args.indexOf('--'),tauriArgs=divider<0?args:args.slice(0,divider),cargoArgs=divider<0?[]:args.slice(divider);
  console.log('Building NearHub Cast '+version.display);
  const result=run(process.execPath,[resolve(root,'node_modules/@tauri-apps/cli/tauri.js'),'build',...tauriArgs,'--config',JSON.stringify(bundleVersionConfig(version,platform,env)),...cargoArgs],
    {cwd:root,env:{...env,NEARCAST_BUILD_VERSION:version.display},stdio:'inherit'});
  if(result.error)throw result.error;
  return result.status??1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await buildDesktop(process.argv.slice(2));
