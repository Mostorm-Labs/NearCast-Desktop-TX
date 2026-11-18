import test from 'node:test';
import assert from 'node:assert/strict';
import {peer,product,turn} from './helpers/typed-peer.mjs';

const target=product.targetMessage.data.target;
const capabilities={runtimeInstanceId:'rx-runtime-1',supportedControlVersions:[1],methods:['cast.getControlCapabilities','cast.getTouchbackState','cast.setTouchbackEnabled'],events:[],touchback:{inputTypes:['touch','mouse'],formats:['input-sample-v1'],protocols:['webcast','hid'],supportsControlPlane:true}};
const state=(diagnosticReason='RECEIVER_OPT_IN_REQUIRED')=>({target,receiverOptIn:false,controllerRequested:false,effectiveEnabled:false,acceptedInputTypes:[],lifecycleState:'inactive',resolutionPreference:'inherit',resolutionState:'inherit',canvasRevision:'1',geometryRevision:'1',revision:'0',diagnosticReason});
const pending=(p,method)=>p.messages().findLast(message=>message.op===7&&message.d.method===method);
async function answer(p,method,result,code=0){
  const request=pending(p,method);assert.ok(request,`TX must query ${method}`);
  await p.rpc(8,{id:request.d.id,status:{ok:code===0,code},...(code===0?{result}:{})});await turn();
}
async function connected(t){const p=await peer();t.after(()=>p.sender.fence());await p.handshake();await p.bind();await turn();return p;}

test('paired RX master-off state disables remote control; inactive routes remain configurable',async t=>{
  const p=await connected(t);
  await answer(p,'cast.getControlCapabilities',capabilities);
  assert.deepEqual(pending(p,'cast.getTouchbackState').d.params,{target});
  await answer(p,'cast.getTouchbackState',state('RECEIVER_INPUT_DISABLED'));
  assert.equal(p.sender.diagnostics().receiverSupported,true);
  assert.equal(p.sender.diagnostics().receiverEnabled,false);
  assert.equal(p.sender.diagnostics().receiverStateReady,true);
  await assert.rejects(p.sender.requestReceiverControl(true),/接收端已关闭反控/);
  assert.equal(pending(p,'cast.getTouchbackMaster'),undefined,'older paired RX does not advertise this method');
  const refresh=p.sender.refreshReceiverState();await turn();
  await answer(p,'cast.getTouchbackState',state());await refresh;
  assert.equal(p.sender.diagnostics().receiverEnabled,true,'inactive and effectiveEnabled=false do not imply master-off');
  assert.equal(pending(p,'cast.setTouchbackEnabled'),undefined,'policy recovery must not replay enable intent');
});

test('explicitly missing RX remote-control capability disables without sending unsupported queries',async t=>{
  const p=await connected(t);
  await answer(p,'cast.getControlCapabilities',{...capabilities,methods:['cast.getControlCapabilities'],touchback:{...capabilities.touchback,inputTypes:[]}});
  assert.equal(p.sender.diagnostics().receiverSupported,false);
  assert.equal(pending(p,'cast.getTouchbackState'),undefined);
  await assert.rejects(p.sender.requestReceiverControl(true),/不支持反控/);
});

test('a valid capability response without touchback reports unsupported rather than waiting forever',async t=>{
  const p=await connected(t);
  await answer(p,'cast.getControlCapabilities',{runtimeInstanceId:'rx-runtime-1',supportedControlVersions:[1],methods:['cast.getControlCapabilities'],events:[]});
  assert.equal(p.sender.diagnostics().receiverSupported,false);
  assert.equal(pending(p,'cast.getTouchbackState'),undefined);
});

test('advertised master API is authoritative, polled, and scoped to the RX runtime',async t=>{
  const p=await connected(t);
  await answer(p,'cast.getControlCapabilities',{...capabilities,methods:[...capabilities.methods,'cast.getTouchbackMaster']});
  await answer(p,'cast.getTouchbackMaster',{enabled:false,revision:'2',runtimeInstanceId:'rx-runtime-1'});
  await answer(p,'cast.getTouchbackState',state());
  assert.equal(p.sender.diagnostics().receiverEnabled,false,'explicit master=false overrides inactive route');
  const refresh=p.sender.refreshReceiverState();await turn();
  await answer(p,'cast.getTouchbackMaster',{enabled:true,revision:'3',runtimeInstanceId:'other-runtime'});
  await refresh;
  assert.equal(p.sender.diagnostics().receiverStateReady,false,'wrong-runtime policy never enables the UI');
});

test('old target responses cannot change receiver availability after rebinding or disconnect',async t=>{
  const p=await connected(t);await answer(p,'cast.getControlCapabilities',capabilities);
  const old=pending(p,'cast.getTouchbackState');
  const next=structuredClone(product.targetMessage);next.data.target.bindingGeneration='2';
  await p.sender.handleControlMessage({data:JSON.stringify(next)});await turn();
  await p.rpc(8,{id:old.d.id,status:{ok:true,code:0},result:state('RECEIVER_INPUT_DISABLED')});await turn();
  assert.equal(p.sender.diagnostics().receiverEnabled,null);
  await answer(p,'cast.getControlCapabilities',capabilities);
  await answer(p,'cast.getTouchbackState',{...state(),target:next.data.target});
  assert.equal(p.sender.diagnostics().receiverEnabled,true);
  await p.sender.fence();
  assert.equal(p.sender.diagnostics().receiverEnabled,null);
  assert.equal(p.sender.diagnostics().receiverStateReady,false);
});

test('mismatched targets and failed RX queries cannot claim remote control is available',async t=>{
  const p=await connected(t);await answer(p,'cast.getControlCapabilities',capabilities);
  await answer(p,'cast.getTouchbackState',{...state(),target:{...target,slotId:'9'}});
  assert.equal(p.sender.diagnostics().receiverStateReady,false);
  const refresh=p.sender.refreshReceiverState();await turn();
  await answer(p,'cast.getTouchbackState',null,15);await refresh;
  assert.equal(p.sender.diagnostics().receiverStateReady,false);
  assert.equal(p.sender.diagnostics().receiverEnabled,null);
});
