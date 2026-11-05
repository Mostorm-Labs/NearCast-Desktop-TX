import test from 'node:test';
import assert from 'node:assert/strict';
import {peer,openRequest,product,turn,geometry} from './helpers/typed-peer.mjs';
import {encodeInputFrame} from '../src/touchback/typed-codec.mjs';

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
