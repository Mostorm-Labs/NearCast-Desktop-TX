import test from 'node:test';
import assert from 'node:assert/strict';
import {requestInputConsent} from '../src/touchback/consent-request.mjs';
import {peer,product,turn} from './helpers/typed-peer.mjs';
import {encodeStandardFrame} from '../src/touchback/frame-codec.mjs';
import {rpcPayload} from '../src/touchback/axtp-session.mjs';

test('consent deadline defaults to 8 seconds, rejects late acceptance and cancels exactly once',async()=>{
  let expire,accept;const controller=new AbortController();
  const request=requestInputConsent(()=>new Promise(resolve=>accept=resolve),{signal:controller.signal,setTimer:(fn,ms)=>{assert.equal(ms,8000);expire=fn;return 1;},clearTimer:()=>{}});
  await turn();expire();assert.equal(await request,'timeout');accept(true);controller.abort();
  assert.equal(await request,'timeout');
  const canceled=new AbortController();canceled.abort();let prompted=false;
  assert.equal(await requestInputConsent(()=>{prompted=true;return true;},{signal:canceled.signal}),'canceled');assert.equal(prompted,false);
});

test('RX consent request does not grant input until accepted, deduplicates and stays on the current target',async t=>{
  let approve,prompts=0,changed=0;
  const p=await peer({onConsentRequest:()=>{prompts++;return new Promise(resolve=>approve=resolve);},onEnabledChanged:()=>changed++});t.after(()=>p.sender.fence());
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);
  const request=structuredClone(product.targetMessage);request.data.controlRequest={requestId:'consent-1',timeoutMs:8000};
  await p.sender.handleControlMessage({data:JSON.stringify(request)});await turn();
  assert.equal(prompts,1);assert.equal(p.sender.enabled,false);assert.equal(p.source().data.controlConsent.status,'pending');
  await p.sender.handleControlMessage({data:JSON.stringify(request)});assert.equal(prompts,1);
  approve(true);await turn();await turn();
  assert.equal(p.sender.enabled,true);assert.equal(p.source().data.available,true);assert.equal(p.source().data.controlConsent.status,'accepted');assert.equal(changed,1);
});

test('denied requests and late approval after capture stops never enable native input',async t=>{
  let approve;
  const p=await peer({onConsentRequest:()=>new Promise(resolve=>approve=resolve)});t.after(()=>p.sender.fence());
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);
  const request=structuredClone(product.targetMessage);request.data.controlRequest={requestId:'deny-1',timeoutMs:8000};
  await p.sender.handleControlMessage({data:JSON.stringify(request)});await turn();approve(false);await turn();await turn();
  assert.equal(p.sender.enabled,false);assert.equal(p.source().data.controlConsent.status,'denied');
  request.data.controlRequest.requestId='late-1';await p.sender.handleControlMessage({data:JSON.stringify(request)});await turn();
  await p.sender.setCaptureTrack(null);approve(true);await turn();await turn();assert.equal(p.sender.enabled,false);assert.equal(p.sender.source,null);
});

test('RX cancellation closes a pending prompt and ignores late acceptance',async t=>{
  let approve,signal;
  const p=await peer({onConsentRequest:options=>{signal=options.signal;return new Promise(resolve=>approve=resolve);}});t.after(()=>p.sender.fence());
  await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);
  const request=structuredClone(product.targetMessage);request.data.controlRequest={requestId:'canceled-1',timeoutMs:8000};
  await p.sender.handleControlMessage({data:JSON.stringify(request)});await turn();assert.equal(signal.aborted,false);
  request.data.controlRequest.cancel=true;await p.sender.handleControlMessage({data:JSON.stringify(request)});approve(true);await turn();await turn();
  assert.equal(signal.aborted,true);assert.equal(p.sender.enabled,false);assert.equal(p.sender.source,null);
});

test('TX initiation sends an explicit target-scoped RX enable request and respects rejection',async t=>{
  const p=await peer();t.after(()=>p.sender.fence());await p.handshake();await p.bind();await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);
  const requested=p.sender.requestReceiverControl(true);await turn();
  const rpc=p.messages().findLast(message=>message.op===7&&message.d.method==='cast.setTouchbackEnabled');
  assert.deepEqual(rpc.d.params.target,product.targetMessage.data.target);assert.equal(rpc.d.params.enabled,true);
  await p.sender.handleControlMessage({data:encodeStandardFrame(rpcPayload({sid:p.sender.server.sessionId,op:8,d:{id:rpc.d.id,status:{ok:false,code:15,msg:'RECEIVER_INPUT_DISABLED'}}}),{payloadType:2})});
  await assert.rejects(requested,/RECEIVER_INPUT_DISABLED/);assert.equal(p.actions.length,0);
});
