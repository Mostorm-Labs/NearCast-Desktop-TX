import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseVersion,buildManifest,selectPackage,validateAssets,verifySignedAsset} from '../scripts/release.mjs';
import {readFile} from 'node:fs/promises';
test('release maps four-part display and numeric build metadata consistently',()=>{
  assert.deepEqual(releaseVersion('0.2.1','37'),{logical:'0.2.1',build:37,display:'0.2.1.37',semver:'0.2.1+37',msi:'1.0.37'});
  assert.ok(Number(releaseVersion('0.2.1','38').msi.split('.')[2])>Number(releaseVersion('0.2.1','37').msi.split('.')[2]));
  for(const args of [['1.2','1'],['1.2.3','0'],['1.2.3','65536'],['1.2.65536','1']])assert.throws(()=>releaseVersion(...args));
});
test('release refuses stale bundle output and incomplete or duplicate architecture sets',()=>{
  const old='bundle/nsis/NearCast Desktop TX_0.1.0+1_x64-setup.exe';
  const current='bundle/nsis/NearCast Desktop TX_0.1.0+2_x64-setup.exe';
  assert.equal(selectPackage([old,current],{semver:'0.1.0+2',format:'nsis'}),current);
  assert.throws(()=>selectPackage([old],{semver:'0.1.0+2',format:'nsis'}));
  assert.throws(()=>selectPackage([current,current],{semver:'0.1.0+2',format:'nsis'}));
  assert.equal(selectPackage(['macos/NearCast Desktop TX.app.tar.gz'],{semver:'0.1.0+2',format:'app'}),'macos/NearCast Desktop TX.app.tar.gz');
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
