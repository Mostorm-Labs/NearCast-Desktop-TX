import test from 'node:test';
import assert from 'node:assert/strict';
import {MacOsPermissions} from '../src/macos-permissions.mjs';

for(const directory of ['src','dist']){
  test(`${directory}: macOS feature checks require the matching fresh native permission`,async()=>{
    const {FeaturePermissionGate}=await import(`../${directory}/feature-permissions.mjs`);
    let native={screenRecording:'granted',accessibility:'not_granted'};
    const permissions=new MacOsPermissions({invoke:async()=>({...native})});
    const gate=new FeaturePermissionGate({permissions,platform:()=>({os:'macos'})});
    assert.equal(await gate.check('audio'),true);
    assert.equal(await gate.check('input'),false);
    assert.equal(gate.state('input').notice,'required');
    native={screenRecording:'not_granted',accessibility:'granted'};
    assert.equal(await gate.check('audio'),false,'a cached recording grant cannot enable audio');
    assert.equal(await gate.check('input'),true,'screen capture permission cannot block mouse control');
  });
  test(`${directory}: unknown/failed permission checks cannot enable features or assert denial`,async()=>{
    const {FeaturePermissionGate}=await import(`../${directory}/feature-permissions.mjs`);
    let fail=false;
    const permissions=new MacOsPermissions({invoke:async()=>{if(fail)throw Error('query failed');return{screenRecording:'unknown',accessibility:'unknown'};}});
    const gate=new FeaturePermissionGate({permissions,platform:()=>({os:'macos'})});
    for(const feature of ['audio','input']){
      assert.equal(await gate.check(feature),false);assert.equal(gate.state(feature).notice,'unknown');
    }
    fail=true;assert.equal(await gate.check('audio'),false);assert.equal(gate.state('audio').notice,'unknown');
  });
  test(`${directory}: cancelling an enable intent fences a late native grant`,async()=>{
    const {FeaturePermissionGate}=await import(`../${directory}/feature-permissions.mjs`);
    let release;
    const permissions=new MacOsPermissions({invoke:()=>new Promise(resolve=>{release=resolve;})});
    const gate=new FeaturePermissionGate({permissions,platform:()=>({os:'macos'})});
    const pending=gate.check('input');await Promise.resolve();
    assert.equal(gate.state('input').checking,true);
    gate.cancel('input');release({accessibility:'granted'});
    assert.equal(await pending,false);assert.equal(gate.state('input').checking,false);
  });
  test(`${directory}: returning from settings clears guidance only after a verified grant`,async()=>{
    const {FeaturePermissionGate}=await import(`../${directory}/feature-permissions.mjs`);
    let accessibility='not_granted';
    const permissions=new MacOsPermissions({invoke:async()=>({accessibility})});
    const gate=new FeaturePermissionGate({permissions,platform:()=>({os:'macos'})});
    await gate.check('input');gate.permissionsChanged();assert.equal(gate.state('input').notice,'required');
    accessibility='unknown';await permissions.refresh();gate.permissionsChanged();assert.equal(gate.state('input').notice,'unknown');
    accessibility='granted';await permissions.refresh();gate.permissionsChanged();assert.equal(gate.state('input').notice,null);
  });
  test(`${directory}: Windows feature toggles never query macOS permissions`,async()=>{
    const {FeaturePermissionGate}=await import(`../${directory}/feature-permissions.mjs`);
    const permissions=new MacOsPermissions({invoke:()=>assert.fail('macOS permission queried on Windows')});
    const gate=new FeaturePermissionGate({permissions,platform:()=>({os:'windows'})});
    assert.equal(await gate.check('audio'),true);assert.equal(await gate.check('input'),true);
  });
}
