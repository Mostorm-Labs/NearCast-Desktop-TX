import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseVersion,buildManifest,selectPackage,validateAssets,verifySignedAsset,releasePackageName,releasePlatforms,macosReleaseMatrix} from '../scripts/release.mjs';
import {installerFileName,nameInstallers} from '../scripts/name-installers.mjs';
import {readFile} from 'node:fs/promises';

test('Windows-only release keeps a complete x64 installer pair and all-platform release builds both Mac architectures',()=>{
  assert.deepEqual(releasePlatforms('windows'),['windows']);
  assert.deepEqual(releasePlatforms('all'),['windows','macos']);
  assert.deepEqual(macosReleaseMatrix().include.map(row=>row.target),['x86_64-apple-darwin','aarch64-apple-darwin']);
  assert.throws(()=>releasePlatforms('linux'));
  validateAssets([{arch:'x86_64',format:'nsis'},{arch:'x86_64',format:'msi'}],'windows');
  assert.throws(()=>validateAssets([{arch:'x86_64',format:'nsis'}],'windows'));
});
test('release maps four-part display and numeric build metadata consistently',()=>{
  assert.deepEqual(releaseVersion('0.2.1','37'),{logical:'0.2.1',build:37,display:'0.2.1.37',semver:'0.2.1+37',msi:'1.0.37'});
  assert.ok(Number(releaseVersion('0.2.1','38').msi.split('.')[2])>Number(releaseVersion('0.2.1','37').msi.split('.')[2]));
  for(const args of [['1.2','1'],['1.2.3','0'],['1.2.3','65536'],['1.2.65536','1']])assert.throws(()=>releaseVersion(...args));
});

test('desktop installer naming preserves sidecar signatures and version/platform identity',async()=>{
  const {mkdtemp,mkdir,writeFile,rm,readdir}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  assert.equal(releasePackageName('0.2.0.37','windows','x86_64','nsis'),'NearHub-Cast-Desktop-Installer-0.2.0.37-windows-x86_64-setup.exe');
  assert.equal(releasePackageName('0.2.0.37','macos','aarch64','app'),'NearHub-Cast-Desktop-Installer-0.2.0.37-macos-aarch64.app.tar.gz');
  assert.equal(releasePackageName('0.2.0.37','macos','x86_64','dmg'),'NearHub-Cast-Desktop-Installer-0.2.0.37-macos-x86_64.dmg');
  assert.equal(installerFileName('NearHub Cast.app.tar.gz'),'NearHub Cast.app.tar.gz');
  const root=await mkdtemp(join(tmpdir(),'nearhub-installer-'));
  try{
    await mkdir(join(root,'nsis'));
    const name='NearHub Cast_0.2.0+37_x64-setup.exe',next=installerFileName(name);
    await writeFile(join(root,'nsis',name),'package');await writeFile(join(root,'nsis',name+'.sig'),'signed bytes');
    await nameInstallers(root);await nameInstallers(root);
    assert.deepEqual((await readdir(join(root,'nsis'))).sort(),[next,next+'.sig'].sort());
    assert.equal(await readFile(join(root,'nsis',next+'.sig'),'utf8'),'signed bytes');
    await writeFile(join(root,'nsis',name),'new package');await assert.rejects(nameInstallers(root),/already exists/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('public package names preserve signed mirror URLs through GitHub filename normalization',()=>{
  for(const [platform,arch,format] of [['windows','x86_64','nsis'],['windows','x86_64','msi'],['macos','aarch64','app'],['macos','x86_64','app']]){
    const name=releasePackageName('0.2.0.50',platform,arch,format);
    assert.match(name,/^[A-Za-z0-9._-]+$/,'public asset names must not require GitHub normalization');
    assert.equal(encodeURIComponent(name),name);
  }
});
test('release refuses stale bundle output and incomplete or duplicate architecture sets',()=>{
  const old='bundle/nsis/NearHub Cast_0.1.0+1_x64-setup.exe';
  const current='bundle/nsis/NearHub Cast_0.1.0+2_x64-setup.exe';
  assert.equal(selectPackage([old,current],{semver:'0.1.0+2',format:'nsis'}),current);
  assert.throws(()=>selectPackage([old],{semver:'0.1.0+2',format:'nsis'}));
  assert.throws(()=>selectPackage([current,current],{semver:'0.1.0+2',format:'nsis'}));
  assert.equal(selectPackage(['macos/NearHub Cast.app.tar.gz'],{semver:'0.1.0+2',format:'app'}),'macos/NearHub Cast.app.tar.gz');
  const dmg='dmg/NearHub Cast_0.1.0+2_aarch64.dmg';
  const staleDmg='dmg/NearHub Cast_0.1.0+1_aarch64.dmg';
  assert.equal(selectPackage([staleDmg,dmg],{semver:'0.1.0+2',format:'dmg'}),dmg);
  assert.throws(()=>selectPackage([staleDmg],{semver:'0.1.0+2',format:'dmg'}));
  const assets=[{arch:'x86_64',format:'app'},{arch:'aarch64',format:'app'}];
  validateAssets(assets,'macos');
  assert.throws(()=>validateAssets(assets.slice(0,1),'macos'));
  assert.throws(()=>validateAssets([assets[0],assets[0]],'macos'));
});
test('platform manifest binds build, product and all architecture assets',()=>{
  const assets=[{arch:'x86_64'},{arch:'aarch64'}];
  const manifest=buildManifest({version:'0.2.0.37',platform:'macos',assets});
  assert.equal(manifest.productSlug,'nearcast-tx-macos');assert.equal(manifest.build,37);assert.equal(manifest.logicalVersion,'0.2.0');
  assert.deepEqual(manifest.assets,assets);
});
test('release signature verification matches native Minisign and rejects wrong version or bytes',async()=>{
  const bytes=await readFile(new URL('./fixtures/update/package.bin',import.meta.url));
  const signature=await readFile(new URL('./fixtures/update/package.bin.sig',import.meta.url),'utf8');
  const key=await readFile(new URL('../src-tauri/update.pub',import.meta.url),'utf8');
  verifySignedAsset(bytes,signature,key,'0.2.0+37');
  assert.throws(()=>verifySignedAsset(Buffer.from('tampered'),signature,key,'0.2.0+37'));
  assert.throws(()=>verifySignedAsset(bytes,signature,key,'0.2.0+38'));
});
