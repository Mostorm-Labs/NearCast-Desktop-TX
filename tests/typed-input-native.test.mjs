import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeInputAdapter} from '../src/touchback/native-input-adapter.mjs';
import {proveCaptureGeometry} from '../src/touchback/capture-geometry.mjs';
const display={nativeId:'DISPLAY1',primary:true,units:'physical-pixels',rotation:0,region:{x:0,y:0,width:1920,height:1080},captureWidth:1920,captureHeight:1080};
const snapshot={revision:'native-1',displays:[display]};
const geometry={proven:true,revision:'native-1',...display};
const owner={ownerId:'test-owner',geometry,binding:{sourceBindingId:'capture-1'}};

test('capture mapping requires one native primary monitor and exact uncropped monitor capture facts',()=>{
  assert.equal(proveCaptureGeometry({displaySurface:'monitor',width:1920,height:1080},snapshot).proven,true);
  for(const settings of [{displaySurface:'window',width:1920,height:1080},{displaySurface:'monitor',width:1280,height:720},{width:1920,height:1080}])assert.throws(()=>proveCaptureGeometry(settings,snapshot));
  assert.throws(()=>proveCaptureGeometry({displaySurface:'monitor',width:1920,height:1080},{...snapshot,displays:[display,{...display,nativeId:'DISPLAY2'}]}));
  assert.throws(()=>proveCaptureGeometry({displaySurface:'monitor',width:1920,height:1080},{...snapshot,displays:[{...display,rotation:90}]}));
});

test('typed native adapter holds a lease, maps high wire IDs, and releases only its owner',async()=>{
  const calls=[];
  const adapter=new NativeInputAdapter({invoke:async(name,args)=>{calls.push([name,args]);return name==='nearcast_input_prepare'?{status:'ready',leaseId:'native-secret'}:name==='nearcast_input_apply'?{status:'submitted'}:{status:'released'};}});
  assert.equal((await adapter.prepare(owner,{acceptedInputTypes:['touch'],touch:{maxContacts:10}})).status,'ready');
  const action={inputType:'touch',records:[{contactId:65535,phase:0,x:1919,y:1079}]};
  assert.equal((await adapter.apply(action,owner)).status,'submitted');
  assert.equal(calls[1][1].action.records[0].contactId,1);
  assert.equal(calls[1][1].leaseId,'native-secret');
  assert.equal(JSON.stringify(adapter.snapshot()).includes('native-secret'),false);
  assert.equal((await adapter.releaseOwned(owner,'disconnect')).status,'released');
  assert.equal(calls.at(-1)[1].ownerId,owner.ownerId);
});

test('unconfirmed native cleanup keeps lease and contact IDs until explicit release succeeds',async()=>{
  let released=false;
  const calls=[];
  const adapter=new NativeInputAdapter({invoke:async(name,args)=>{calls.push([name,args]);return name==='nearcast_input_prepare'?{status:'ready',leaseId:'lease'}:name==='nearcast_input_apply'?{status:'submitted'}:released?{status:'released'}:{status:'blocked',error:'Win32 failure'};}});
  await adapter.prepare(owner,{acceptedInputTypes:['touch'],touch:{maxContacts:10}});
  await adapter.apply({inputType:'touch',records:[{contactId:42,phase:0,x:10,y:20}]},owner);
  assert.equal((await adapter.releaseOwned(owner,'close')).status,'blocked');
  assert.equal(adapter.snapshot().owners,1);
  released=true;await adapter.releaseOwned(owner,'retry');assert.equal(adapter.snapshot().owners,0);
});
