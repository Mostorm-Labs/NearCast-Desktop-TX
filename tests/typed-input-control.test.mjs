import test from 'node:test';
import assert from 'node:assert/strict';
import {peer,openRequest,product,turn,geometry} from './helpers/typed-peer.mjs';
import {encodeInputFrame} from '../src/touchback/typed-codec.mjs';

test('temporary native window readiness loss keeps its precise reason and can recover on the same session',async t=>{
  let capture={captureId:'native',nativeId:'capture:native',revision:'window-1',kind:'window',units:'physical-pixels',rotation:0,region:{x:100,y:100,width:800,height:600},captureWidth:800,captureHeight:600,inputReady:true,disabledReason:null};
  const p=await peer({provider:{probe:async()=>({inputTypes:['touch'],maxDataBytes:4096,touch:{maxContacts:10},nativeReady:true,geometry:{revision:capture.revision,capture}})}});t.after(()=>p.sender.fence());
  p.track.getSettings=()=>({displaySurface:'window',width:800,height:600,nearcastCaptureId:capture.captureId,nearcastCaptureRevision:capture.revision});
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);
  for(const [nativeReason,reason] of [['capture_window_not_foreground','CAPTURE_WINDOW_NOT_FOREGROUND'],['capture_window_minimized_or_hidden','CAPTURE_WINDOW_MINIMIZED'],['capture_waiting_for_frame','CAPTURE_GEOMETRY_CHANGED'],['capture_window_pixels_do_not_match_native_bounds','CAPTURE_GEOMETRY_CHANGED']]){
    capture={...capture,inputReady:false,disabledReason:nativeReason};await p.sender.captureGeometryChanged();
    assert.equal(p.source().data.disabledReason,reason);assert.equal(p.sender.server.ready,true);assert.equal(p.sender.channel.readyState,'open');
    capture={...capture,revision:capture.revision+'r',inputReady:true,disabledReason:null};await p.sender.captureGeometryChanged();assert.equal(p.source().data.available,true);
  }
});

test('source association requires local authorization, APP_READY, authenticated target and proven capture',async t=>{
  const p=await peer();t.after(()=>p.sender.fence());
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);
  assert.equal(p.source().data.disabledReason,'LOCAL_INPUT_DISABLED');
  await p.sender.setEnabled(true);
  const source=p.source();assert.equal(source.data.available,true);assert.ok(source.data.sourceBindingId);
  assert.deepEqual({...source,data:{...source.data,sourceBindingId:'share-binding-1'}},product.sourceMessage);
  await p.sender.setCaptureTrack({...p.track,getSettings:()=>({displaySurface:'window',width:1920,height:1080})});
  assert.equal(p.source().data.available,false);assert.equal(p.source().data.geometryRevision,null);
  assert.deepEqual(p.source().data.inputCapability,product.sourceMessage.data.inputCapability);
});

test('production peer opens typed input, submits full samples without ACK, and reports confirmed close',async t=>{
  const p=await peer();t.after(()=>p.sender.fence());await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);
  const request=openRequest(p.source().data.sourceBindingId);p.rpc(7,{id:1,method:'input.openStream',params:request});await turn();await turn();
  const response=p.messages().find(message=>message.op===8&&message.d.id===1);assert.equal(response.d.status.code,0);
  const streamId=response.d.result.streamId,count=p.sent.length;
  await p.sender.handleControlMessage({data:encodeInputFrame({streamId,seqId:1,cursor:1,inputType:'touch',records:[{contactId:65535,phase:0,x:65535,y:0}]})});
  assert.equal(p.actions.length,1);assert.equal(p.actions[0].records[0].x,1919);assert.equal(p.sent.length,count);
  const trace=p.sender.controlDiagnostics();assert.deepEqual(trace.lastOpenRequest.inputTypes,['touch']);
  assert.equal(trace.receivedTouchSamples,1);assert.equal(trace.receivedMouseSamples,0);
  assert.equal(trace.lastReceivedInput.inputType,'touch');assert.equal(trace.lastReceivedInput.typeByte,1);
  assert.equal(trace.lastReceivedInput.records[0].contactId,65535);assert.equal(p.actions[0].inputType,'touch');
  p.rpc(7,{id:2,method:'input.closeStream',params:{controlVersion:1,runtimeInstanceId:request.runtimeInstanceId,target:request.target,streamKind:'touchback',streamId,reason:'peerClosed',commandId:'close-1'}});await turn();await turn();
  assert.equal(p.messages().find(message=>message.d.id===2).d.result.closed,true);
  p.rpc(7,{id:3,method:'stream.getState',params:{streamId}});await turn();
  assert.equal(p.messages().find(message=>message.d.id===3).d.result.state,'closed');
  const next=await p.sender.engine.open({...request,commandId:'next'}, {sessionId:p.sender.server.sessionId});assert.ok(next.streamId>streamId);
});

test('Mouse-only source is available but rejects native Touch without conversion',async t=>{
  const p=await peer({provider:{probe:async()=>({inputTypes:['mouse'],maxDataBytes:4096,mouse:{buttonsMask:7,modifierMask:0,allowChords:false,wheelUnits:[],continuousScroll:false},geometry,nativeReady:true})}});t.after(()=>p.sender.fence());
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);
  assert.equal(p.source().data.available,true);assert.deepEqual(p.source().data.inputCapability.inputTypes,['mouse']);
  await assert.rejects(p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId}),/NOT_SUPPORTED/);
  assert.equal(p.actions.length,0);assert.equal(p.channel.readyState,'open');
});

test('wrong target fingerprint revokes the source and cannot reach native prepare',async t=>{
  let prepares=0;const p=await peer({provider:{prepare:async()=>{prepares++;return{status:'ready'};}}});t.after(()=>p.sender.fence());
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);const old=openRequest(p.source().data.sourceBindingId);
  const invalid=structuredClone(product.targetMessage);invalid.data.contractFingerprint='old';await p.sender.handleControlMessage({data:JSON.stringify(invalid)});
  await assert.rejects(p.sender.engine.open(old,{sessionId:p.sender.server.sessionId}),/PERMISSION_DENIED|INVALID_STATE/);assert.equal(prepares,0);assert.equal(p.source().data.available,false);
});

test('capture replacement fences a pending source bind even after native cleanup completes',async t=>{
  let release;const p=await peer({provider:{releaseOwned:()=>new Promise(resolve=>{release=resolve;})}});t.after(()=>{p.provider.releaseOwned=async()=>({status:'released'});return p.sender.fence();});
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);
  await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  const moving=p.sender.setCaptureTrack({...p.track});await turn();
  await p.sender.setEnabled(false);release({status:'released'});await moving;await turn();
  assert.equal(p.sender.source,null);assert.equal(p.sender.engine.binding,null);assert.equal(p.sender.engine.state,'closed');
});

test('failed prepare with unconfirmed cleanup returns UNAVAILABLE status.details and no result',async t=>{
  const p=await peer({provider:{prepare:async()=>({status:'rejected',error:'prepare failed'}),releaseOwned:async()=>({status:'blocked',error:'permission withdrawn'})}});
  t.after(()=>{p.provider.releaseOwned=async()=>({status:'released'});return p.sender.fence();});
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);
  p.rpc(7,{id:19,method:'input.openStream',params:openRequest(p.source().data.sourceBindingId)});await turn();await turn();
  const failure=p.messages().find(message=>message.d.id===19).d;
  assert.equal(failure.status.code,15);assert.equal(failure.status.ok,false);assert.equal(failure.status.details?.cleanupPending,true);assert.equal(Object.hasOwn(failure,'result'),false);
  assert.equal(p.sender.engine.state,'cleanup_blocked');
});

test('native probe failure revokes active ownership and releases held input',async t=>{
  let releases=0;const p=await peer({provider:{releaseOwned:async()=>{releases++;return{status:'released'};}}});t.after(()=>p.sender.fence());
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);
  await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  p.provider.probe=async()=>{throw new Error('native bridge unavailable');};
  await p.sender.refreshSource();await turn();
  assert.equal(p.sender.source,null);assert.equal(p.sender.engine.state,'closed');assert.equal(releases,1);
});

test('replacement control session cannot bypass a retired native owner awaiting cleanup',async t=>{
  const p=await peer();t.after(()=>p.sender.fence());
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);
  await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  p.provider.releaseOwned=async()=>({status:'blocked',error:'cleanup pending'});
  const channel={...p.channel,send:value=>p.sent.push(value)};
  await p.sender.attachControlChannel(channel,{authorized:true,mediaIdentity:{roomId:'room-1',userId:'sender-1',hostUserId:'receiver-1'}});
  await p.handshake();await p.bind();await turn();
  assert.equal(p.sender.source,null);assert.equal(p.source().data.disabledReason,'NATIVE_CLEANUP_PENDING');assert.equal(p.sender.diagnostics().cleanupPending,true);
  p.provider.releaseOwned=async()=>({status:'released'});assert.equal(await p.sender.retryCleanup(),true);
  assert.equal(p.source().data.available,true);assert.equal(p.sender.diagnostics().cleanupPending,false);
});

test('capture mute releases held ownership without waiting for another network sample',async t=>{
  let releases=0;const p=await peer({provider:{releaseOwned:async()=>{releases++;return{status:'released'};}}});t.after(()=>p.sender.fence());
  const track=Object.assign(new EventTarget(),p.track,{muted:false});
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(track);await p.sender.setEnabled(true);
  const old=p.source().data.sourceBindingId;await p.sender.engine.open(openRequest(old),{sessionId:p.sender.server.sessionId});
  track.muted=true;track.dispatchEvent(new Event('mute'));await turn();await turn();
  assert.equal(p.sender.source,null);assert.equal(releases,1);assert.equal(p.sender.engine.state,'closed');
  track.muted=false;track.dispatchEvent(new Event('unmute'));await turn();await turn();
  assert.equal(p.source().data.available,true);assert.notEqual(p.source().data.sourceBindingId,old);
});

test('session fencing publishes unavailable immediately so the border cannot retain active UI state',async t=>{
  const states=[];const p=await peer({onStatus:(_status,state)=>states.push(state)});t.after(()=>p.sender.fence());
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);
  await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  assert.equal(states.at(-1).sourceReady,true);const closing=p.sender.fence('connection lost');
  assert.equal(states.at(-1).sourceReady,false);assert.equal(states.at(-1).controlChannelReady,false);await closing;
});


test('a Mouse sample on a Touch-only stream is rejected before native submission without conversion',async t=>{
  const p=await peer();t.after(()=>p.sender.fence());await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);
  const opened=await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  await p.sender.handleControlMessage({data:encodeInputFrame({streamId:opened.streamId,seqId:1,cursor:1,inputType:'mouse',eventKind:0,buttons:0,modifiers:0,x:100,y:100})});
  assert.equal(p.actions.length,0);assert.match(p.sender.diagnostics().lastError.message,/Unaccepted input type/);
  const trace=p.sender.controlDiagnostics();assert.equal(trace.receivedMouseSamples,1);assert.equal(trace.receivedTouchSamples,0);
  assert.equal(trace.lastReceivedInput.inputType,'mouse');assert.equal(trace.lastReceivedInput.typeByte,2);
});


test('authenticated Touch feedback reaches the UI observer and is cleared on source/channel loss',async t=>{
  const events=[];const p=await peer({onTouchFeedback:event=>events.push(event)});t.after(()=>p.sender.fence());
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);
  const opened=await p.sender.engine.open(openRequest(p.source().data.sourceBindingId),{sessionId:p.sender.server.sessionId});
  await p.sender.handleControlMessage({data:encodeInputFrame({streamId:opened.streamId,seqId:1,cursor:1,inputType:'touch',records:[{contactId:77,phase:0,x:65535,y:0}]})});
  assert.deepEqual(events.filter(e=>e.stage!=='clear').map(e=>e.stage),['received','submitted']);assert.equal(events.find(e=>e.stage==='received').records[0].x,1919);
  await p.sender.fence();assert.equal(events.at(-1).stage,'clear');
});
