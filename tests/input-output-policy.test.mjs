import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformInputAdapter} from '../src/touchback/platform-input.mjs';
import {peer,openRequest,geometry,turn} from './helpers/typed-peer.mjs';
import {encodeInputFrame} from '../src/touchback/typed-codec.mjs';

const mouseCaps={inputTypes:['mouse'],nativeTypes:['mouse'],nativeReady:true,maxDataBytes:4096,
  mouse:{buttonsMask:7,modifierMask:15,allowChords:false,wheelUnits:['detent120','regionQ16_16'],continuousScroll:true},zoom:{browser:true},geometry};
const touchCaps={inputTypes:['touch'],nativeTypes:['touch'],nativeReady:true,maxDataBytes:4096,touch:{maxContacts:10},geometry};
function platform(caps=mouseCaps){
  const calls=[];let releaseResult={status:'released'};
  const provider=createPlatformInputAdapter({}, {invoke:async(name,args)=>{
    calls.push([name,args]);
    if(name==='nearcast_input_probe')return structuredClone(caps);
    if(name==='nearcast_input_prepare')return {status:'ready',leaseId:'local-secret'};
    if(name==='nearcast_input_release')return releaseResult;
    return {status:'submitted',inputType:args.action.inputType,nativeApi:args.action.inputType==='mouse'?'CGEventPost':'InjectTouchInput'};
  }});
  return {provider,calls,actions:()=>calls.filter(([n])=>n==='nearcast_input_apply').map(([,a])=>a.action),blockRelease:()=>{releaseResult={status:'blocked',error:'cleanup failed'};}};
}
async function session(t,policy,caps=mouseCaps){
  const p=platform(caps);await p.provider.probe();await p.provider.setOutputPolicy(policy);
  const channel=await peer({providerAdapter:p.provider});
  t.after(()=>channel.sender.fence());await channel.handshake();await channel.bind();await channel.sender.setCaptureTrack(channel.track);await channel.sender.setEnabled(true);
  return {...channel,...p};
}
const contact=(phase,x=10000,y=20000)=>({contactId:65000,phase,x,y});
async function send(p,streamId,seqId,input){
  await p.sender.handleControlMessage({data:encodeInputFrame({streamId,seqId,cursor:seqId,...input})});await turn();
}

test('explicit Touch to Mouse mapping negotiates Touch while preparing only native Mouse and releases the same owner',async t=>{
  const p=await session(t,{touch:'mouse-drag',mouse:'native'});
  assert.deepEqual(p.source().data.inputCapability.inputTypes,['touch','mouse']);
  assert.equal(p.source().data.inputCapability.touch.maxContacts,1);
  const result=await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  assert.deepEqual(result.acceptedInputTypes,['touch']);
  const prepared=p.calls.find(([n])=>n==='nearcast_input_prepare')[1];
  assert.deepEqual(prepared.inputTypes,['mouse']);assert.equal(prepared.maxContacts,0);
  for(const [i,r]of [contact(0),contact(1,20000),contact(2,20000)].entries())await send(p,result.streamId,i+1,{inputType:'touch',records:[r]});
  const actions=p.actions();assert.deepEqual(actions.map(a=>[a.inputType,a.eventKind,a.buttons]),[['mouse',1,1],['mouse',0,1],['mouse',1,0]]);
  const d=p.sender.diagnostics();assert.equal(d.nativeInput.lastConversion.receivedType,'touch');assert.equal(d.nativeInput.lastConversion.outputType,'mouse');
  assert.deepEqual(d.nativeInputTypes,['mouse']);assert.equal(d.nativeInput.lastSubmission.nativeInputType,'mouse');
  assert.equal(JSON.stringify(d).includes('local-secret'),false);
  await p.sender.fence();assert.equal(p.provider.snapshot().owners,0);
});

test('Touch scroll waits for a movement threshold, never presses on drag, and taps click only after Up',async t=>{
  const p=await session(t,{touch:'mouse-scroll',mouse:'native'});
  const opened=await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  const records=[contact(0),contact(1,10001),contact(1,10000,16000),contact(2,10000,16000),contact(0),contact(2),contact(0),contact(3)];
  for(const [i,r]of records.entries())await send(p,opened.streamId,i+1,{inputType:'touch',records:[r]});
  const a=p.actions();assert.deepEqual(a.map(v=>v.eventKind),[0,2,2,0,1,1,0]);
  assert.equal(a[1].wheelPhase,1);assert.ok(a[1].wheelY<0);assert.equal(a[2].wheelPhase,3);assert.equal(a[2].wheelY,0);
  assert.equal(a[1].x,a[0].x);assert.equal(a[1].y,a[0].y);
  assert.deepEqual(a.filter(v=>v.eventKind===1).map(v=>v.buttons),[1,0]);
});

test('conversion is opt-in and unsupported output combinations cannot change policy or acquire a native lease',async()=>{
  const p=platform();await p.provider.probe();
  assert.deepEqual((await p.provider.probe()).inputTypes,['mouse']);
  await assert.rejects(p.provider.setOutputPolicy({touch:'native',mouse:'touch'}),/not supported|unsupported/i);
  assert.deepEqual(p.provider.snapshot().outputPolicy,{touch:'native',mouse:'native'});
  assert.equal(p.calls.some(([n])=>n==='nearcast_input_prepare'),false);
});

test('Mouse to Touch maps only a left-button lifecycle and retains high-ID native allocation',async t=>{
  const p=await session(t,{touch:'native',mouse:'touch'},touchCaps);
  const params={...openRequest(p.source().data.sourceBindingId),inputTypes:['mouse'],touch:undefined,
    mouse:{buttonsMask:1,modifierMask:0,allowChords:false,wheelUnits:[],continuousScroll:false}};
  const opened=await p.sender.engine.open(params,{sessionId:p.sender.server.sessionId});
  assert.equal(opened.mouse.buttonsMask,1);assert.deepEqual(opened.mouse.wheelUnits,[]);
  const samples=[{eventKind:0,buttons:0},{eventKind:1,buttons:1},{eventKind:0,buttons:1},{eventKind:1,buttons:0}];
  for(const [i,s]of samples.entries())await send(p,opened.streamId,i+1,{inputType:'mouse',modifiers:0,x:12000,y:18000,...s});
  assert.deepEqual(p.actions().map(a=>[a.inputType,a.records[0].phase,a.records[0].contactId]),[['touch',0,1],['touch',1,1],['touch',2,1]]);
});

test('policy change closes the old stream before changing capabilities and rejects old bindings and frames',async t=>{
  const p=await session(t,{touch:'mouse-drag',mouse:'native'});
  const oldSource=p.source().data.sourceBindingId,request=openRequest(oldSource);
  const opened=await p.sender.engine.open(request,{sessionId:p.sender.server.sessionId});
  await send(p,opened.streamId,1,{inputType:'touch',records:[contact(0)]});
  await p.sender.setOutputPolicy({touch:'mouse-scroll',mouse:'native'});
  assert.equal(p.sender.engine.state,'closed');assert.equal(p.provider.snapshot().owners,0);
  assert.notEqual(p.source().data.sourceBindingId,oldSource);
  assert.equal(p.channel.readyState,'open');
  await assert.rejects(p.sender.engine.open({...request,commandId:'old'},{sessionId:p.sender.server.sessionId}),/binding/i);
  assert.equal((await p.sender.engine.accept({streamId:opened.streamId,seqId:2})).status,'discarded');
  const next=await p.sender.engine.open({...openRequest(p.source().data.sourceBindingId),commandId:'new'},{sessionId:p.sender.server.sessionId});
  assert.ok(next.streamId>opened.streamId);
});

test('failed cleanup blocks a policy change and preserves the previous configuration',async t=>{
  const p=await session(t,{touch:'mouse-drag',mouse:'native'});
  const opened=await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  await send(p,opened.streamId,1,{inputType:'touch',records:[contact(0)]});
  p.blockRelease();
  await assert.rejects(p.sender.setOutputPolicy({touch:'mouse-scroll',mouse:'native'}),/cleanup|释放/i);
  assert.deepEqual(p.provider.snapshot().outputPolicy,{touch:'mouse-drag',mouse:'native'});
  assert.equal(p.sender.diagnostics().cleanupPending,true);assert.equal(p.source().data.available,false);
});

test('in-flight input completes before policy cleanup and old queued work cannot be replayed',async t=>{
  const p=await session(t,{touch:'mouse-drag',mouse:'native'});
  const opened=await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  let finish;const apply=p.provider.native.apply.bind(p.provider.native);
  p.provider.native.apply=async(...args)=>{await new Promise(resolve=>{finish=resolve;});return apply(...args);};
  const down=send(p,opened.streamId,1,{inputType:'touch',records:[contact(0)]});await turn();
  const changing=p.sender.setOutputPolicy({touch:'mouse-scroll',mouse:'native'});await turn();
  assert.equal(p.calls.some(([n])=>n==='nearcast_input_release'),false);
  assert.equal(p.source().data.available,false);
  finish();await down;await changing;
  const names=p.calls.map(([n])=>n);assert.ok(names.indexOf('nearcast_input_release')>names.indexOf('nearcast_input_apply'));
  assert.equal(p.sender.engine.state,'closed');assert.equal(p.provider.snapshot().owners,0);
});

test('multi-contact or incompatible overlapping inputs fail before additional native actions',async t=>{
  const p=await session(t,{touch:'mouse-drag',mouse:'native'});
  const params={...openRequest(p.source().data.sourceBindingId),inputTypes:['touch','mouse'],mouse:mouseCaps.mouse};
  const opened=await p.sender.engine.open(params,{sessionId:p.sender.server.sessionId});
  await send(p,opened.streamId,1,{inputType:'touch',records:[contact(0)]});
  await assert.rejects(p.sender.engine.accept({streamId:opened.streamId,seqId:2,cursor:2,inputType:'mouse',dataBytes:12,eventKind:1,buttons:1,modifiers:0,x:10000,y:20000}),/Overlapping/);
  assert.equal(p.actions().length,1);assert.equal(p.provider.snapshot().owners,0);
  const next=await p.sender.engine.open({...params,commandId:'multi'},{sessionId:p.sender.server.sessionId});
  await assert.rejects(p.sender.engine.accept({streamId:next.streamId,seqId:1,cursor:1,inputType:'touch',dataBytes:15,records:[contact(0),{...contact(0),contactId:1}]}),/count/i);
  assert.equal(p.actions().length,1);
});

test('a focus-only Mouse record cannot hide a held button from the conversion overlap guard',async t=>{
  const p=await session(t,{touch:'mouse-drag',mouse:'native'});
  const opened=await p.sender.engine.open({...openRequest(p.source().data.sourceBindingId),inputTypes:['touch','mouse'],mouse:mouseCaps.mouse},{sessionId:p.sender.server.sessionId});
  await send(p,opened.streamId,1,{inputType:'mouse',eventKind:1,buttons:1,modifiers:0,x:10000,y:10000});
  await send(p,opened.streamId,2,{inputType:'mouse',eventKind:4,modifiers:0});
  await assert.rejects(p.sender.engine.accept({streamId:opened.streamId,seqId:3,cursor:3,inputType:'touch',dataBytes:8,records:[contact(0)]}),/Overlapping/);
  assert.equal(p.actions().filter(a=>a.eventKind===1).length,1);
});

test('configuration exposes only supported output choices and does not enable conversion by probing',async()=>{
  for(const directory of ['src','dist']){
    const {createPlatformInputAdapter}=await import(`../${directory}/touchback/platform-input.mjs`);
    for(const caps of [mouseCaps,touchCaps]){
      const provider=createPlatformInputAdapter({}, {invoke:async()=>structuredClone(caps)});
      const config=await provider.configuration();
      assert.deepEqual(config.policy,{touch:'native',mouse:'native'});
      const supported=type=>config.options[type].filter(option=>option.supported).map(option=>option.value);
      assert.deepEqual(supported('touch'),caps===mouseCaps?['mouse-drag','mouse-scroll','mouse-gestures','disabled']:['native','disabled']);
      assert.deepEqual(supported('mouse'),caps===mouseCaps?['native','disabled']:['touch','disabled']);
      assert.deepEqual((await provider.probe()).inputTypes,caps.inputTypes);
    }
  }
});

test('combined gestures negotiate two Touch contacts while injecting native right-click Mouse only',async t=>{
  const p=await session(t,{touch:'mouse-gestures',mouse:'native',gestures:{holdMs:250,rightClick:'two-finger',pinchAction:'browser-zoom'}});
  assert.equal(p.source().data.inputCapability.touch.maxContacts,2);
  const opened=await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  const r=(contactId,phase,x)=>({contactId,phase,x,y:20000});
  await send(p,opened.streamId,1,{inputType:'touch',records:[r(1,0,10000),r(2,0,20000)]});
  await send(p,opened.streamId,2,{inputType:'touch',records:[r(1,2,10000),r(2,2,20000)]});
  assert.deepEqual(p.actions().map(a=>[a.inputType,a.eventKind,a.buttons]),[['mouse',0,0],['mouse',1,2],['mouse',1,0]]);
  assert.equal(p.provider.snapshot().gestureFeedback.stage,'right-released');
});

test('default long-hold right click uses configured timing through the typed input owner',async t=>{
  const p=await session(t,{touch:'mouse-gestures',mouse:'native'});
  let time=0;p.provider.now=()=>time;
  const opened=await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  await send(p,opened.streamId,1,{inputType:'touch',records:[contact(0)]});
  time=500;assert.equal(p.provider.snapshot().gestureFeedback.stage,'right-wait');
  time=750;await send(p,opened.streamId,2,{inputType:'touch',records:[contact(2)]});
  assert.deepEqual(p.actions().filter(a=>a.eventKind===1).map(a=>a.buttons),[2,0]);
  assert.equal(p.provider.snapshot().gestureFeedback.stage,'right-released');
  await assert.rejects(p.sender.setOutputPolicy({touch:'mouse-gestures',mouse:'native',gestures:{holdMs:800,rightHoldMs:700}}),/Right-click/);
  assert.equal(p.provider.snapshot().outputPolicy.gestures.rightHoldMs,700);
  assert.equal(p.provider.snapshot().gestureFeedback,null);
});

test('policy reconfiguration includes gesture timing and discards an armed contact',async t=>{
  const p=await session(t,{touch:'mouse-gestures',mouse:'native',gestures:{holdMs:250}});
  const opened=await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  await send(p,opened.streamId,1,{inputType:'touch',records:[contact(0)]});
  assert.equal(p.provider.snapshot().gestureFeedback.stage,'holding');
  await p.sender.setOutputPolicy({touch:'mouse-gestures',mouse:'native',gestures:{holdMs:450}});
  assert.equal(p.provider.snapshot().gestureFeedback,null);
  assert.equal(p.provider.snapshot().outputPolicy.gestures.holdMs,450);
  assert.equal(p.provider.snapshot().owners,0);
});
