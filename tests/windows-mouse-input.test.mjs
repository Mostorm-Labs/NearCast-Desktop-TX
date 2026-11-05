import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformInputSink} from '../src/touchback/platform-input.mjs';
import {WebCastTouchbackSender} from '../src/webcast/touchback-sender.mjs';
import {encodeTouchbackBindPayload, TouchbackFrameKind as Kind} from '../src/touchback/codec.mjs';
import {encodeTouchbackFrame, openCurrent} from './helpers/canonical-touchback.mjs';

const record = (phase, values = {}) => ({contactId:0,phase,x:32768,y:65535,buttons:0,modifiers:0,wheel:0,dtMs:0,recordFlags:0,...values});
async function fixture(inject = async () => null, initialize = () => true) {
  const calls = [], replies = [];
  const sink = createPlatformInputSink({os:'windows',touchback:true,inputControl:'windows-pointer'}, {
    viewport:{width:1920,height:1080},
    invoke:async (command,args) => { calls.push([command,args]); return command.includes('initialize') ? initialize(command) : inject(command,args); },
  });
  const sender = new WebCastTouchbackSender({nativeBridge:sink});
  await sender.attachControlChannel({readyState:'open',send:value=>replies.push(value)},{authorized:true});
  sender.handleControlMessage({data:encodeTouchbackFrame({kind:Kind.BIND,epoch:1,controlPayload:encodeTouchbackBindPayload({runtimeInstanceId:'test',sessionId:'session',sessionGeneration:1,slotId:0,bindingGeneration:1,lifecycleGeneration:1,bindingToken:'test-token'})})});
  const control = value => sender.handleControlMessage({data:JSON.stringify(value)});
  const open = mode => control(openCurrent(sender,{preferredMode:mode,modeRequirement:'required'}));
  const batch = (epoch, records, seqId=0) => sender.handleControlMessage({data:encodeTouchbackFrame({kind:Kind.BATCH,epoch,seqId,records})});
  const settle = async () => { await sender._frameQueue; await sender._resetBarrier; };
  return {sink,sender,calls,replies,control,open,batch,settle};
}

test('Windows negotiates required Mouse and routes hover, drag, release and wheel to native Mouse', async () => {
  const f=await fixture();
  assert.equal(f.open('mouse').status,'stream_opened');
  const reply=JSON.parse(f.replies.at(-1));
  assert.equal(reply.result.acceptedMode,'mouse');
  assert.equal(reply.result.maxContacts,1);
  const records=[record(1),record(0,{buttons:2,modifiers:2}),record(1,{buttons:2,modifiers:2,x:65535}),record(2),record(1,{wheel:-120})];
  assert.equal(f.batch(1,records).status,'applied');
  await f.settle();
  assert.deepEqual(f.calls.filter(([name])=>name==='nearcast_windows_mouse_inject'),[['nearcast_windows_mouse_inject',{records}]]);
  assert.equal(f.calls.some(([name])=>/^nearcast_pointer_inject/.test(name)),false);
  assert.equal(f.sender.diagnostics().injectionCount,5);
});

test('Mouse hover does not consume the single contact slot before an explicit receiver Mouse click', async () => {
  const f=await fixture();
  assert.equal(f.open('mouse').status,'stream_opened');
  assert.equal(f.batch(1,[record(1,{contactId:0})]).status,'applied');
  assert.equal(f.sender.receiver.session.activeContacts.size,0);
  assert.equal(f.batch(1,[record(0,{contactId:42,buttons:1}),record(1,{contactId:42,buttons:1}),record(2,{contactId:42})],1).status,'applied');
  await f.settle();
  assert.equal(f.sender.diagnostics().injectionCount,4);
});

test('reset-close-open switches Windows Mouse to Touch and fences stale Mouse packets', async () => {
  const f=await fixture();
  assert.equal(f.open('mouse').status,'stream_opened');
  f.batch(1,[record(0,{buttons:1,modifiers:1})]); await f.settle();
  const start=f.calls.length;
  f.sender.handleControlMessage({data:encodeTouchbackFrame({kind:Kind.RESET,epoch:2})});
  f.control({action:'axtp-control',id:'close',method:'input.closeStream',params:{...openCurrent(f.sender).params,commandId:'close',streamId:1,epoch:2}});
  assert.equal(f.open('touch').status,'stream_opened');
  assert.equal(f.batch(1,[record(1,{buttons:1})],1).status,'stale');
  f.batch(2,[record(0,{contactId:42,buttons:1})]); await f.settle();
  const after=f.calls.slice(start);
  assert.equal(after[0][0],'nearcast_windows_mouse_reset');
  assert.equal(after.some(([name])=>name==='nearcast_windows_mouse_inject'),false);
  assert.equal(after.some(([name])=>name==='nearcast_pointer_inject_batch'),true);
  assert.equal(f.sender.snapshot().pointer.mode,'touch');
});

test('Windows Mouse reset waits for in-flight injection and discards queued old records', async () => {
  let finish;
  const f=await fixture(async name=> name==='nearcast_windows_mouse_inject' ? new Promise(resolve=>{finish=resolve;}) : null);
  assert.equal(f.open('mouse').status,'stream_opened');
  f.batch(1,[record(0,{buttons:1})]);
  while (!finish) await new Promise(resolve=>setImmediate(resolve));
  f.batch(1,[record(1,{buttons:1})],1);
  f.sender.fence(); finish(null); await f.settle();
  assert.equal(f.calls.filter(([name])=>name==='nearcast_windows_mouse_inject').length,1);
  assert.equal(f.calls.at(-1)[0],'nearcast_windows_mouse_reset');
  assert.equal(f.sender.authorized,false);
});

test('Windows Mouse preserves native errors in diagnostics and resets after injection failure', async () => {
  const f=await fixture(async name=>{if(name==='nearcast_windows_mouse_inject') throw 'windows_mouse_send_input_failed:win32=5:sent=0/2';return null;});
  assert.equal(f.open('mouse').status,'stream_opened');
  f.batch(1,[record(0,{buttons:1})]); await f.settle();
  assert.equal(f.sender.authorized,false);
  assert.match(f.sender.diagnostics().lastInjectionFailure.error,/win32=5/);
  assert.equal(f.calls.at(-1)[0],'nearcast_windows_mouse_reset');
});

test('failed Windows Mouse reset blocks new input until cleanup succeeds', async () => {
  let failReset=false;
  const f=await fixture(async name=>{if(failReset && name==='nearcast_windows_mouse_reset') throw 'windows_mouse_reset_failed';return null;});
  assert.equal(f.open('mouse').status,'stream_opened');
  f.batch(1,[record(0,{buttons:1})]); await f.settle();
  failReset=true;
  const reset=f.sink.reset();
  assert.equal(await reset,'invalid_state');
  const before=f.calls.filter(([name])=>name==='nearcast_windows_mouse_inject').length;
  assert.equal(await f.sink.apply(record(1,{buttons:1})),'invalid_state');
  assert.equal(f.calls.filter(([name])=>name==='nearcast_windows_mouse_inject').length,before);
  failReset=false;
  assert.equal(await f.sink.reset(),'accepted');
});

test('Windows can negotiate Mouse when native Touch initialization is unavailable', async () => {
  const f=await fixture(undefined, command=>command !== 'nearcast_pointer_initialize');
  assert.equal(f.sender.authorized,true);
  assert.equal(f.open('mouse').status,'stream_opened');
  assert.equal(f.open('touch').status,'control_rejected');
  assert.deepEqual(f.sender.receiver.supportedModes,['mouse']);
});

test('Windows advertises only Touch when native Mouse initialization fails', async () => {
  const f=await fixture(undefined, command=>command !== 'nearcast_windows_mouse_initialize');
  assert.deepEqual(f.sender.receiver.supportedModes,['touch']);
  assert.equal(f.open('mouse').status,'control_rejected');
  assert.equal(f.open('touch').status,'stream_opened');
});

test('native mode cleanup failure is reported without waiting for the first input frame', async () => {
  let failReset=false;
  const f=await fixture(async name=>{if(failReset && name==='nearcast_windows_mouse_reset') throw 'windows_mouse_reset_failed';return null;});
  await f.settle(); failReset=true;
  assert.equal(f.open('mouse').status,'stream_opened');
  await f.settle();
  assert.equal(f.sender.authorized,false);
  assert.equal(f.sender.diagnostics().lastInjectionStatus,'invalid_state');
  assert.match(f.sender.diagnostics().lastInjectionFailure.error,/reset_failed/);
});
