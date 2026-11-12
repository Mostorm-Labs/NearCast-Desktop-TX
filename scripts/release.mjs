import {createHash, createPublicKey, verify} from 'node:crypto';
import {readFile, writeFile, mkdir, readdir, copyFile} from 'node:fs/promises';
import {resolve, basename, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {INSTALLER_NAME} from './name-installers.mjs';

export function releasePlatforms(selection='all') {
  if(!['all','windows'].includes(selection))throw new Error('Expected all or windows release platforms');
  return selection==='windows'?['windows']:['windows','macos'];
}
export function releaseMatrix(selection='all') {
  const platforms=releasePlatforms(selection);
  return {include:[
    {os:'windows-latest',target:'x86_64-pc-windows-msvc',platform:'windows',arch:'x86_64',bundles:'nsis,msi'},
    {os:'macos-15-intel',target:'x86_64-apple-darwin',platform:'macos',arch:'x86_64',bundles:'app,dmg'},
    {os:'macos-15',target:'aarch64-apple-darwin',platform:'macos',arch:'aarch64',bundles:'app,dmg'},
  ].filter(row=>platforms.includes(row.platform))};
}

export function releasePackageName(version,platform,cpu,format){
  const ext=format==='nsis'?'-setup.exe':format==='msi'?'.msi':'.app.tar.gz';
  return INSTALLER_NAME+'-'+version+'-'+platform+'-'+cpu+ext;
}

export function releaseVersion(logical, run) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(logical)) throw new Error('Expected X.Y.Z');
  if (!/^[1-9]\d*$/.test(String(run))) throw new Error('Expected positive CI build number');
  const build=Number(run);
  if(!Number.isSafeInteger(build))throw new Error('Build overflow');
  const [major,minor,patch]=logical.split('.').map(Number);
  // MSI only orders three components. Use the globally increasing CI build
  // as native ProductVersion while retaining the public four-part version.
  if([major,minor,patch,build].some(n=>n>65535))throw new Error('Windows native version field exhausted; revise the installer mapping before publishing');
  return {logical,build,display:logical+'.'+build,semver:logical+'+'+build,msi:'1.0.'+build};
}
export function buildManifest({version,platform,assets,notes='',channel='release',publishedAt=new Date().toISOString()}) {
  const parts=version.split('.');if(parts.length!==4)throw new Error('Expected four-part version');
  return {schemaVersion:1,version,logicalVersion:parts.slice(0,3).join('.'),build:Number(parts[3]),platform,
    productSlug:platform==='windows'?'nearcast-tx-windows':'nearcast-tx-macos',channel,notes,publishedAt,assets};
}
export function selectPackage(files,{semver,format}) {
  const suffix=format==='nsis'?'-setup.exe':format==='msi'?'.msi':'.app.tar.gz';
  const matches=files.filter(path=>(format==='app'||basename(path).includes('_'+semver+'_'))&&path.endsWith(suffix));
  if(matches.length!==1)throw new Error('Expected exactly one '+format+' package for '+semver);
  return matches[0];
}
export function validateAssets(assets,platform) {
  const expected=platform==='windows'?['x86_64/nsis','x86_64/msi']:['x86_64/app','aarch64/app'];
  if(assets.length!==expected.length||new Set(assets.map(a=>a.arch+'/'+a.format)).size!==assets.length
    ||expected.some(key=>!assets.some(a=>a.arch+'/'+a.format===key)))throw new Error('Incomplete '+platform+' update set');
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function verifySignedAsset(bytes,encodedSignature,encodedKey,semver) {
  const keyLines=Buffer.from(encodedKey.trim(),'base64').toString('utf8').trim().split(/\r?\n/);
  const lines=Buffer.from(encodedSignature.trim(),'base64').toString('utf8').trim().split(/\r?\n/);
  const key=Buffer.from(keyLines[1]||'','base64');
  const signature=Buffer.from(lines[1]||'','base64');
  if(key.length!==42||signature.length!==74||!key.subarray(2,10).equals(signature.subarray(2,10)))throw new Error('Updater signing key does not match embedded public key');
  const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key.subarray(10)]),type:'spki',format:'der'});
  const message=signature.subarray(0,2).toString()==='ED'?createHash('blake2b512').update(bytes).digest():bytes;
  const comment=(lines[2]||'').replace(/^trusted comment: /,'');
  if(!verify(null,message,publicKey,signature.subarray(10))
    ||!verify(null,Buffer.concat([signature.subarray(10),Buffer.from(comment)]),publicKey,Buffer.from(lines[3]||'','base64'))
    ||!comment.split('\t').includes('version:'+semver))throw new Error('Invalid updater signature or signed version');
}
async function walk(path) {
  const files=[];
  for(const entry of await readdir(path,{withFileTypes:true})){
    const item=join(path,entry.name);
    if(entry.isDirectory())files.push(...await walk(item));else files.push(item);
  }
  return files;
}
function sign(path,semver) {
  execFileSync(process.execPath,[resolve('node_modules/@tauri-apps/cli/tauri.js'),'signer','sign','--app-version',semver,path],{stdio:'inherit'});
}
async function prepare(target,platform,cpu,display,inputRoot,outputRoot) {
  const [x,y,z,b]=display.split('.');const version=releaseVersion(x+'.'+y+'.'+z,b);
  const output=resolve(outputRoot,platform,cpu);await mkdir(output,{recursive:true});
  const files=await walk(inputRoot);
  const formats=platform==='windows'?['nsis','msi']:['app'];
  const assets=[];
  for(const format of formats) {
    const original=selectPackage(files,{semver:version.semver,format});
    if(format==='app') {
      const plist=original.replace(/\.tar\.gz$/,'')+'/Contents/Info.plist';
      const bundleBuild=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleVersion',plist],{encoding:'utf8'}).trim();
      if(bundleBuild!==String(version.build))throw new Error('Stale macOS app bundle');
    }
    const name=releasePackageName(display,platform,cpu,format);
    const destination=join(output,name);await copyFile(original,destination);sign(destination,version.semver);
    const bytes=await readFile(destination);const sha256=hash(bytes);
    await writeFile(destination+'.sha256',sha256+'  '+name+'\n');
    const signature=(await readFile(destination+'.sig','utf8')).trim();
    verifySignedAsset(bytes,signature,await readFile('src-tauri/update.pub','utf8'),version.semver);
    const url='https://github.com/'+process.env.GITHUB_REPOSITORY+'/releases/download/v'+display+'/'+encodeURIComponent(name);
    assets.push({platform,arch:cpu,format,name,url,size:bytes.length,sha256,signature});
  }
  await writeFile(join(output,'assets.json'),JSON.stringify(assets,null,2)+'\n');
}
async function aggregate(display,inputRoot,outputRoot,channel,selection='all') {
  const [x,y,z,b]=display.split('.');const version=releaseVersion(x+'.'+y+'.'+z,b);
  const files=await walk(inputRoot);let notes='NearHub Cast '+display;
  try{notes=await readFile('docs/releases/v'+version.logical+'.md','utf8');}catch{}
  for(const platform of releasePlatforms(selection)) {
    const dest=resolve(outputRoot,platform);await mkdir(dest,{recursive:true});
    const assets=[];
    for(const path of files.filter(p=>basename(p)==='assets.json')){
      const items=JSON.parse(await readFile(path,'utf8'));assets.push(...items.filter(a=>a.platform===platform));
    }
    validateAssets(assets,platform);
    for(const asset of assets){
      for(const suffix of ['', '.sig','.sha256']){
        const file=files.find(path=>basename(path)===asset.name+suffix);
        if(!file)throw new Error('Missing '+asset.name+suffix);
        if(!suffix) {
          const bytes=await readFile(file);
          if(bytes.length!==asset.size||hash(bytes)!==asset.sha256)throw new Error('Artifact digest changed: '+asset.name);
        } else if(suffix==='.sig'&&(await readFile(file,'utf8')).trim()!==asset.signature)throw new Error('Artifact signature changed: '+asset.name);
        await copyFile(file,join(dest,asset.name+suffix));
      }
    }
    const manifest=buildManifest({version:display,platform,assets,notes,channel});
    const name='NearCast-Desktop-TX-'+display+'-'+platform+'-manifest.json';
    const path=join(dest,name);await writeFile(path,JSON.stringify(manifest,null,2)+'\n');sign(path,version.semver);
    verifySignedAsset(await readFile(path),await readFile(path+'.sig','utf8'),await readFile('src-tauri/update.pub','utf8'),version.semver);
    await writeFile(path+'.sha256',hash(await readFile(path))+'  '+name+'\n');
  }
  await writeFile(resolve(outputRoot,'changelog.md'),notes+'\n');
}
async function main() {
  const [command,...args]=process.argv.slice(2);
  if(command==='config') {
    const [logical,build,platform]=args;const v=releaseVersion(logical,build);
    const pubkey=(await readFile('src-tauri/update.pub','utf8')).trim();
    const config={version:v.semver,bundle:{createUpdaterArtifacts:true},plugins:{updater:{pubkey,requireSignedVersion:true}}};
    if(platform==='windows')config.bundle.windows={wix:{version:v.msi}};
    else config.bundle.macOS={bundleVersion:String(v.build),signingIdentity:process.env.APPLE_SIGNING_IDENTITY||'-'};
    await writeFile('src-tauri/tauri.release.conf.json',JSON.stringify(config,null,2)+'\n');
    console.log(JSON.stringify(v));
  } else if(command==='prepare') await prepare(...args);
  else if(command==='aggregate')await aggregate(...args);
  else throw new Error('Unknown release command');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
