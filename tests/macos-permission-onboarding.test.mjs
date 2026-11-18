import test from 'node:test';
import assert from 'node:assert/strict';
import {MacOsPermissions} from '../src/macos-permissions.mjs';

const marker='nearhub-cast-macos-permissions-onboarding-v1';
const storage=()=>{
  const values=new Map();
  return{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
};

for(const directory of ['src','dist']){
  test(`${directory}: onboarding is macOS desktop only and cannot infer permissions from a saved completion flag`,async()=>{
    const {MacOsPermissionOnboarding}=await import(`../${directory}/macos-permission-onboarding.mjs`);
    let queries=0;
    const saved=storage();
    const permissions=new MacOsPermissions({invoke:async()=>{queries++;return{localNetwork:'available',screenRecording:'granted',accessibility:'not_granted'};}});
    for(const config of [{os:'windows',desktop:true},{os:'macos',desktop:false}]){
      const onboarding=new MacOsPermissionOnboarding({permissions,storage:saved});
      assert.equal(await onboarding.start(config),false);
    }
    saved.setItem(marker,'completed');
    const onboarding=new MacOsPermissionOnboarding({permissions,storage:saved});
    assert.equal(await onboarding.start({os:'macos',desktop:true}),false);
    assert.equal(queries,1,'a completed setup must still query the system on startup');
    assert.equal(permissions.rows().find(row=>row.id==='accessibility').enabled,false,'missing optional accessibility does not reopen setup');
  });

  test(`${directory}: missing local network access reopens setup after completion or deferral`,async()=>{
    const {MacOsPermissionOnboarding}=await import(`../${directory}/macos-permission-onboarding.mjs`);
    for(const current of [
      {localNetwork:'unknown',screenRecording:'granted',accessibility:'granted'},
      {localNetwork:'not_granted',screenRecording:'granted',accessibility:'granted'},
      {localNetwork:'unknown',screenRecording:'not_granted',accessibility:'not_granted'},
    ]){
      const saved=storage();saved.setItem(marker,'completed');
      const permissions=new MacOsPermissions({invoke:async()=>current});
      const onboarding=new MacOsPermissionOnboarding({permissions,storage:saved});
      assert.equal(await onboarding.start({os:'macos',desktop:true}),true);
      assert.equal(onboarding.snapshot().requiredReady,false);
      assert.equal(onboarding.finish({defer:true}),true,'Not Now dismisses the guide for the current run');
      const restarted=new MacOsPermissionOnboarding({permissions,storage:saved});
      assert.equal(await restarted.start({os:'macos',desktop:true}),true,'deferral cannot suppress the next startup check');
    }
  });

  test(`${directory}: startup checks detect permission revocation instead of trusting a cached grant`,async()=>{
    const {MacOsPermissionOnboarding}=await import(`../${directory}/macos-permission-onboarding.mjs`);
    let current={localNetwork:'available',screenRecording:'granted',accessibility:'granted'},queries=0;
    const permissions=new MacOsPermissions({invoke:async()=>{queries++;return{...current};}});
    await permissions.refresh();
    current.localNetwork='not_granted';
    const saved=storage();saved.setItem(marker,'completed');
    const onboarding=new MacOsPermissionOnboarding({permissions,storage:saved});
    assert.equal(await onboarding.start({os:'macos',desktop:true}),true);
    assert.equal(queries,2);
    assert.equal(onboarding.snapshot().rows.find(row=>row.id==='localNetwork').enabled,false);
  });

  test(`${directory}: failed startup checks show recovery even if setup was previously completed`,async()=>{
    const {MacOsPermissionOnboarding}=await import(`../${directory}/macos-permission-onboarding.mjs`);
    const permissions=new MacOsPermissions({invoke:async()=>{throw Error('check failed');}});
    const saved=storage();saved.setItem(marker,'completed');
    const onboarding=new MacOsPermissionOnboarding({permissions,storage:saved});
    assert.equal(await onboarding.start({os:'macos',desktop:true}),true);
    assert.equal(onboarding.snapshot().error,'check failed');
    assert.equal(onboarding.snapshot().requiredReady,false);
  });

  test(`${directory}: a legacy capture backend can still require recording permission at startup`,async()=>{
    const {MacOsPermissionOnboarding}=await import(`../${directory}/macos-permission-onboarding.mjs`);
    let screenRecording='not_granted';
    const permissions=new MacOsPermissions({invoke:async()=>({localNetwork:'available',screenRecording})});
    const saved=storage();saved.setItem(marker,'completed');
    const onboarding=new MacOsPermissionOnboarding({permissions,storage:saved});
    assert.equal(await onboarding.start({os:'macos',desktop:true,screenCapturePermission:'required'}),true);
    assert.equal(onboarding.snapshot().rows.find(row=>row.id==='screenRecording').required,true);
    assert.equal(onboarding.snapshot().requiredReady,false);
    screenRecording='granted';await onboarding.refresh();assert.equal(onboarding.snapshot().requiredReady,true);
  });

  test(`${directory}: only local networking gates Continue; recording and accessibility are checked when used`,async()=>{
    const {MacOsPermissionOnboarding}=await import(`../${directory}/macos-permission-onboarding.mjs`);
    let current={localNetwork:'unknown',screenRecording:'granted',accessibility:'granted'};
    const permissions=new MacOsPermissions({invoke:async()=>current});
    const saved=storage(),onboarding=new MacOsPermissionOnboarding({permissions,storage:saved});
    await onboarding.start({os:'macos',desktop:true});
    assert.equal(onboarding.snapshot().requiredReady,false);
    assert.equal(onboarding.finish(),false);
    assert.equal(onboarding.active,true);
    assert.equal(saved.getItem(marker),null);
    current={localNetwork:'available',screenRecording:'not_granted',accessibility:'not_granted'};
    await onboarding.refresh();
    assert.equal(onboarding.snapshot().requiredReady,true);
    assert.equal(onboarding.finish(),true);
    assert.equal(onboarding.active,false);
    assert.equal(saved.getItem(marker),'completed');
    assert.equal(permissions.rows().find(row=>row.id==='accessibility').enabled,false);
    const restarted=new MacOsPermissionOnboarding({permissions,storage:saved});
    assert.equal(await restarted.start({os:'macos',desktop:true}),false,'optional capture/control permissions cannot reopen completed onboarding');
    assert.equal(restarted.snapshot().rows.find(row=>row.id==='screenRecording').required,false);
  });

  test(`${directory}: opening system settings never grants permission optimistically and duplicate actions coalesce`,async()=>{
    const {MacOsPermissionOnboarding}=await import(`../${directory}/macos-permission-onboarding.mjs`);
    const calls=[];let finish;
    const permissions=new MacOsPermissions({invoke:async(command,args)=>{
      calls.push([command,args]);
      if(command==='nearcast_macos_permission_settings')await new Promise(resolve=>{finish=resolve;});
      return{localNetwork:'available',screenRecording:'not_granted',accessibility:'not_granted'};
    }});
    const onboarding=new MacOsPermissionOnboarding({permissions,storage:storage()});
    await onboarding.start({os:'macos',desktop:true});
    const action=onboarding.grant('screenRecording');
    assert.equal(onboarding.snapshot().pendingPermission,'screenRecording');
    assert.equal(await onboarding.grant('accessibility'),false);
    finish();await action;
    assert.equal(permissions.rows().find(row=>row.id==='screenRecording').enabled,false);
    assert.deepEqual(calls.filter(([command])=>command==='nearcast_macos_permission_settings'),[['nearcast_macos_permission_settings',{permission:'screenRecording'}]]);
    assert.equal(await onboarding.grant('arbitrary'),false);
  });

  test(`${directory}: a failed check stays unknown, can retry, and Not Now never modifies OS grants`,async()=>{
    const {MacOsPermissionOnboarding}=await import(`../${directory}/macos-permission-onboarding.mjs`);
    let fail=true;
    const permissions=new MacOsPermissions({invoke:async()=>{if(fail)throw Error('offline');return{localNetwork:'available',screenRecording:'not_granted'};}});
    const saved=storage(),onboarding=new MacOsPermissionOnboarding({permissions,storage:saved});
    await onboarding.start({os:'macos',desktop:true});
    assert.equal(onboarding.snapshot().error,'offline');
    assert.ok(onboarding.snapshot().rows.every(row=>row.enabled===null));
    fail=false;await onboarding.refresh();
    assert.equal(onboarding.snapshot().error,null);
    assert.equal(onboarding.finish({defer:true}),true);
    assert.equal(saved.getItem(marker),'completed');
    assert.equal(permissions.rows().find(row=>row.id==='screenRecording').enabled,false);
  });

  test(`${directory}: blocked storage cannot prevent the user from finishing or deferring setup`,async()=>{
    const {MacOsPermissionOnboarding}=await import(`../${directory}/macos-permission-onboarding.mjs`);
    const permissions=new MacOsPermissions({invoke:async()=>({})});
    const onboarding=new MacOsPermissionOnboarding({permissions,storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}});
    await onboarding.start({os:'macos',desktop:true});
    assert.equal(onboarding.active,true);
    assert.equal(onboarding.finish({defer:true}),true);
    assert.equal(onboarding.active,false);
  });
}
