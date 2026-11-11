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

test('browser source facts preserve single-monitor proof after video scaling but never infer a multi-display source',()=>{
  const settings={displaySurface:'monitor',width:1280,height:720,nearcastBrowserSource:{displaySurface:'monitor',width:1920,height:1080}};
  const proven=proveCaptureGeometry(settings,snapshot);
  assert.equal(proven.region.width,1920);assert.equal(proven.captureFacts.width,1920);
  assert.throws(()=>proveCaptureGeometry({...settings,displaySurface:'window'},snapshot));
  assert.throws(()=>proveCaptureGeometry(settings,{...snapshot,displays:[display,{...display,nativeId:'D2'}]}),/multiple|single|display|显示器/i);
  assert.throws(()=>proveCaptureGeometry({...settings,width:1000,height:1000},snapshot),/aspect/i);
  assert.throws(()=>proveCaptureGeometry({...settings,nearcastBrowserSource:{...settings.nearcastBrowserSource,width:1280,height:720}},snapshot),/original/i);
});
test('calibrated monitor identity permits secondary negative coordinates and rejects a stale layout or source',()=>{
  const binding={sourceId:'source',bindingId:'binding',nativeId:'screen-binding:binding',layoutRevision:'layout',revision:'layout:binding',units:'physical-pixels',rotation:0,
    region:{x:-1920,y:0,width:1920,height:1080},captureWidth:1920,captureHeight:1080,kind:'monitor'};
  const native={revision:'layout',displays:[display,{...display,nativeId:'DISPLAY2'}],browserBinding:binding};
  const settings={displaySurface:'monitor',width:1280,height:720,nearcastBrowserSource:{displaySurface:'monitor',width:1920,height:1080},
    nearcastDisplayBinding:{sourceId:'source',bindingId:'binding'}};
  const proven=proveCaptureGeometry(settings,native);
  assert.equal(proven.region.x,-1920);assert.equal(proven.nativeId,'screen-binding:binding');
  assert.throws(()=>proveCaptureGeometry(settings,{...native,revision:'new-layout'}),/LAYOUT_CHANGED/);
  assert.throws(()=>proveCaptureGeometry({...settings,nearcastDisplayBinding:{sourceId:'old',bindingId:'binding'}},native),/RETIRED/);
  assert.throws(()=>proveCaptureGeometry(settings,{...native,browserBinding:null}),/RETIRED/);
});

test('typed native adapter holds a lease, maps high wire IDs, and releases only its owner',async()=>{
  const calls=[];
  const adapter=new NativeInputAdapter({invoke:async(name,args)=>{calls.push([name,args]);return name==='nearcast_input_prepare'?{status:'ready',leaseId:'native-secret'}:name==='nearcast_input_apply'?{status:'submitted',inputType:'touch',nativeApi:'InjectTouchInput',pointerType:'PT_TOUCH'}:{status:'released'};}});
  assert.equal((await adapter.prepare(owner,{acceptedInputTypes:['touch'],touch:{maxContacts:10}})).status,'ready');
  const action={inputType:'touch',records:[{contactId:65535,phase:0,x:1919,y:1079}]};
  assert.equal((await adapter.apply(action,owner)).status,'submitted');
  assert.equal(calls[1][1].action.records[0].contactId,1);
  assert.equal(calls[1][1].action.inputType,'touch');
  const nativeTrace=adapter.snapshot().lastSubmission;
  assert.equal(nativeTrace.inputType,'touch');assert.equal(nativeTrace.nativeInputType,'touch');
  assert.equal(nativeTrace.nativeApi,'InjectTouchInput');assert.equal(nativeTrace.pointerType,'PT_TOUCH');
  assert.equal(nativeTrace.records[0].contactId,1);
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

test('native adapter preserves every explicit Mouse action including wheel fields and zero-coordinate-free cancel/modifiers',async()=>{
  const calls=[];
  const adapter=new NativeInputAdapter({invoke:async(name,args)=>{calls.push([name,args]);return name==='nearcast_input_prepare'?{status:'ready',leaseId:'mouse-lease'}:name==='nearcast_input_apply'?{status:'submitted',inputType:'mouse',nativeApi:'SendInput'}:{status:'released'};}});
  await adapter.prepare(owner,{acceptedInputTypes:['mouse'],mouse:{buttonsMask:31,modifierMask:15,allowChords:true,wheelUnits:['detent120'],continuousScroll:false}});
  assert.equal(calls[0][1].maxContacts,0);
  const actions=[
    {inputType:'mouse',eventKind:0,buttons:0,modifiers:0,x:-1920,y:0},
    {inputType:'mouse',eventKind:1,buttons:3,modifiers:2,x:-1919,y:1},
    {inputType:'mouse',eventKind:2,buttons:3,modifiers:2,x:-1919,y:1,wheelUnit:0,wheelPhase:0,wheelX:-120,wheelY:240},
    {inputType:'mouse',eventKind:4,modifiers:0},
    {inputType:'mouse',eventKind:3},
  ];
  for(const action of actions){assert.equal((await adapter.apply(action,owner)).status,'submitted');assert.deepEqual(calls.at(-1)[1].action,action);}
  assert.equal(adapter.snapshot().lastSubmission.nativeApi,'SendInput');
  assert.equal(adapter.snapshot().activeContacts,0);
  await adapter.releaseOwned(owner,'source changed');assert.equal(calls.at(-1)[1].ownerId,owner.ownerId);
});
