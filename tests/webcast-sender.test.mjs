import test from 'node:test';
import assert from 'node:assert/strict';
import {WebCastTouchbackSender} from '../src/webcast/touchback-sender.mjs';
import {encodeTouchbackFrame, encodeTouchbackBindPayload, TouchbackFrameKind} from '../src/touchback/codec.mjs';
import {PointerInjectionSink} from '../src/touchback/pointer-injection.mjs';

test('requires explicit WebCast authorization and disables AirPlay', () => {
  const native = {initializeTouchInjection: () => true, injectTouchInput: () => true};
  const sender = new WebCastTouchbackSender({nativeBridge: {initialize: () => 'accepted', apply: () => 'accepted', reset() {}, snapshot: () => ({})}});
  assert.equal(sender.attachControlChannel({readyState: 'open'}, {authorized: true, protocol: 'airplay'}), false);
  assert.equal(sender.snapshot().authorized, false);
});

test('reports native readiness separately from receiver Touchback binding', async () => {
  const statuses = [];
  const sender = new WebCastTouchbackSender({onStatus: status => statuses.push(status), nativeBridge: {
    initialize: () => 'accepted', apply: () => 'accepted', reset() {}, snapshot: () => ({})
  }});
  await sender.attachControlChannel({readyState: 'open', send() {}}, {authorized: true});
  assert.equal(statuses.at(-1), 'native_ready');
  sender.handleControlMessage({data: encodeTouchbackFrame({kind: TouchbackFrameKind.BIND, epoch: 1,
    controlPayload: encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1})})});
  assert.equal(statuses.at(-1), 'accepted');
});

test('buffers BIND and the first BATCH while native input initializes', async () => {
  let finishInitialize;
  const applied = [];
  const sender = new WebCastTouchbackSender({nativeBridge: {
    initialize: () => new Promise(resolve => { finishInitialize = resolve; }),
    apply: record => { applied.push(record.contactId); return 'accepted'; },
    reset() {}, snapshot: () => ({})
  }});
  const channel = {readyState: 'open', send() {}};
  const attaching = sender.attachControlChannel(channel, {authorized: true});
  const bind = encodeTouchbackFrame({kind: TouchbackFrameKind.BIND, epoch: 1,
    controlPayload: encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1})});
  const batch = encodeTouchbackFrame({kind: TouchbackFrameKind.BATCH, epoch: 1, sequence: 0,
    records: [{contactId: 0, phase: 0, buttons: 1, x: 100, y: 100}]});
  assert.equal(sender.handleControlMessage({data: bind}).status, 'pending');
  assert.equal(sender.handleControlMessage({data: batch}).status, 'pending');
  finishInitialize('accepted');
  await attaching;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(applied, [0]);
  assert.equal(sender.snapshot().authorized, true);
});

test('exposes channel, native, binding and injection diagnostics without claiming receiver enabled', async () => {
  let finishInitialize;
  const sender = new WebCastTouchbackSender({nativeBridge: {
    initialize: () => new Promise(resolve => { finishInitialize = resolve; }),
    apply: () => 'accepted', reset() {}, snapshot: () => ({initialized: true, activeContacts: 0})
  }});
  const channel = {readyState: 'open', send() {}};
  const attaching = sender.attachControlChannel(channel, {authorized: true});
  assert.deepEqual(sender.diagnostics(), {
    controlChannelReady: true,
    nativeReady: false,
    bindingReady: false,
    receiverEnabled: null,
    injectionCount: 0,
    lastInjectionStatus: 'idle',
    lastInjectionFailure: null,
  });
  finishInitialize('accepted');
  await attaching;
  const bind = encodeTouchbackFrame({kind: TouchbackFrameKind.BIND, epoch: 1,
    controlPayload: encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1})});
  sender.handleControlMessage({data: bind});
  const beforeInput = sender.diagnostics();
  assert.equal(beforeInput.nativeReady, true);
  assert.equal(beforeInput.bindingReady, true);
  assert.equal(beforeInput.receiverEnabled, null);
  const batch = encodeTouchbackFrame({kind: TouchbackFrameKind.BATCH, epoch: 1, sequence: 0,
    records: [{contactId: 0, phase: 0, buttons: 1, x: 100, y: 100}]});
  sender.handleControlMessage({data: batch});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sender.diagnostics().injectionCount, 1);
  assert.equal(sender.diagnostics().lastInjectionStatus, 'accepted');
});

test('diagnostics distinguish contact validation from native injection failure', async () => {
  const invalidPointer = new PointerInjectionSink({native: {
    initializeTouchInjection: () => true,
    injectTouchInput: () => ({ok: false, error: 'windows_inject_touch_input_failed:0x80070057'}),
  }});
  const sender = new WebCastTouchbackSender({nativeBridge: invalidPointer});
  await sender.attachControlChannel({readyState: 'open'}, {authorized: true});
  const invalid = await sender.applyFrame({records: [{contactId: 10, phase: 0, x: 1, y: 2}]});
  assert.equal(invalid.status, 'invalid_state');
  assert.equal(sender.diagnostics().lastInjectionFailure.kind, 'native_error');
  const nativePointer = new PointerInjectionSink({native: {
    initializeTouchInjection: () => true,
    injectTouchInput: () => ({ok: false, error: 'windows_inject_touch_input_failed:0x80070057'}),
  }});
  const native = new WebCastTouchbackSender({nativeBridge: nativePointer});
  await native.attachControlChannel({readyState: 'open'}, {authorized: true});
  await native.applyFrame({records: [{contactId: 1, phase: 0, x: 1, y: 2}]});
  assert.deepEqual(native.diagnostics().lastInjectionFailure, {kind: 'native_error', error: 'windows_inject_touch_input_failed:0x80070057'});
});

test('uses the platform batch path for a multi-contact Touchback frame', async () => {
  const calls = [];
  const sender = new WebCastTouchbackSender({nativeBridge: {
    initialize: () => 'accepted',
    applyBatch: records => { calls.push(records); return 'accepted'; },
    apply: () => { throw new Error('single-record fallback should not run'); },
    reset() {}, snapshot: () => ({})
  }});
  await sender.attachControlChannel({readyState: 'open'}, {authorized: true});
  assert.deepEqual(await sender.applyFrame({records: [{contactId: 42, phase: 0, x: 1, y: 2}, {contactId: 65535, phase: 0, x: 3, y: 4}]}), {status: 'applied'});
  assert.deepEqual(calls, [[{contactId: 42, phase: 0, x: 1, y: 2}, {contactId: 65535, phase: 0, x: 3, y: 4}]]);
});

test('drives a high-ID Touchback contact through bind, move, up and reset', async () => {
  const injected = []; const cancelled = [];
  const sender = new WebCastTouchbackSender({nativeBridge: new PointerInjectionSink({native: {
    initializeTouchInjection: () => true,
    injectTouchInputs: records => { injected.push(records); return true; },
    cancelTouchContacts: ids => { cancelled.push(ids); return true; },
  }})});
  const channel = {readyState: 'open', send() {}};
  await sender.attachControlChannel(channel, {authorized: true, protocol: 'webcast'});
  const bind = encodeTouchbackFrame({kind: TouchbackFrameKind.BIND, epoch: 1,
    controlPayload: encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1})});
  assert.equal(sender.handleControlMessage({data: bind}).status, 'accepted');
  const sendBatch = (sequence, phase, x) => sender.handleControlMessage({data: encodeTouchbackFrame({kind: TouchbackFrameKind.BATCH, epoch: 1, sequence, records: [{contactId: 65535, phase, buttons: 1, x, y: 20}]})});
  assert.equal(sendBatch(0, 0, 10).status, 'applied');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sendBatch(1, 1, 30).status, 'applied');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sendBatch(2, 2, 1).status, 'applied');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(injected.map(frame => { const {contactId, phase, buttons, x, y} = frame[0]; return {contactId, phase, buttons, x, y}; }), [
    {contactId: 65535, phase: 0, buttons: 1, x: 10, y: 20},
    {contactId: 65535, phase: 1, buttons: 1, x: 30, y: 20},
    {contactId: 65535, phase: 2, buttons: 1, x: 30, y: 20},
  ]);
  assert.equal(sender.snapshot().pointer.activeContacts, 0);

  assert.equal(sendBatch(3, 0, 40).status, 'applied');
  await new Promise(resolve => setImmediate(resolve));
  await sender.resetPointer();
  assert.deepEqual(cancelled, [[65535]]);
  assert.equal(sender.snapshot().pointer.activeContacts, 0);
});

test('serializes asynchronous native records across frame boundaries', async () => {
  const calls = []; let finish;
  const sender = new WebCastTouchbackSender({nativeBridge: {
    initialize: () => 'accepted', reset() {}, snapshot: () => ({}),
    apply: record => { calls.push(record.x); return calls.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve('accepted'); },
  }});
  await sender.attachControlChannel({readyState: 'open'}, {authorized: true});
  const first = sender.applyFrame({records: [{x: 1}, {x: 2}]});
  const second = sender.applyFrame({records: [{x: 3}]});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [1]);
  finish('accepted');
  await Promise.all([first, second]);
  assert.deepEqual(calls, [1, 2, 3]);
});

test('revokes authorization after macOS permission is withdrawn during input', async () => {
  const statuses = [];
  const sender = new WebCastTouchbackSender({onStatus: status => statuses.push(status), nativeBridge: {
    initialize: () => 'accepted', reset() {}, snapshot: () => ({}), apply: async () => 'not_authorized',
  }});
  await sender.attachControlChannel({readyState: 'open'}, {authorized: true});
  assert.deepEqual(await sender.applyFrame({records: [{}]}), {status: 'not_authorized'});
  assert.equal(sender.snapshot().authorized, false);
  assert.equal(statuses.at(-1), 'not_authorized');
});

test('remote reset, rebind and sequence gap release native input state', async () => {
  let resets = 0;
  const sender = new WebCastTouchbackSender({nativeBridge: {initialize: () => 'accepted', reset() { resets++; }, snapshot: () => ({}), apply: () => 'accepted'}});
  await sender.attachControlChannel({readyState: 'open', send() {}}, {authorized: true});
  const send = frame => sender.handleControlMessage({data: encodeTouchbackFrame(frame)});
  const bind = epoch => send({kind: TouchbackFrameKind.BIND, epoch, controlPayload: encodeTouchbackBindPayload({runtimeInstanceId:'r', sessionId:'s', bindingToken:'t', sessionGeneration:1, slotId:0, bindingGeneration:1, lifecycleGeneration:1})});
  bind(1); const afterBind = resets;
  send({kind: TouchbackFrameKind.RESET, epoch:2});
  assert.equal(resets, afterBind + 1);
  bind(3);
  assert.equal(resets, afterBind + 2);
  send({kind: TouchbackFrameKind.BATCH, epoch:3, sequence:4, records:[{contactId:0, phase:0, buttons:1, x:10, y:10}]});
  assert.equal(resets, afterBind + 3);
});

test('fencing revokes Touchback authorization including pending initialization', async () => {
  let finish; let applied = 0;
  const sender = new WebCastTouchbackSender({nativeBridge: {initialize: () => new Promise(resolve => { finish = resolve; }), apply: () => { applied++; return 'accepted'; }, reset() {}, snapshot: () => ({})}});
  const attaching = sender.attachControlChannel({readyState: 'open'}, {authorized: true, protocol: 'webcast'});
  sender.fence(); finish('accepted'); await attaching;
  assert.equal(sender.snapshot().authorized, false);
  assert.equal(sender.handleControlMessage({data: new ArrayBuffer(1)}).status, 'not_supported');
  assert.equal(applied, 0);
});

test('rebind fences remaining asynchronous records without revoking the new binding', async () => {
  let finish; const calls = [];
  const sender = new WebCastTouchbackSender({nativeBridge: {initialize: () => 'accepted', reset() {}, snapshot: () => ({}), apply: record => {
    calls.push(record.x);
    return calls.length === 1 ? new Promise(resolve => { finish = resolve; }) : 'accepted';
  }}});
  sender.attachControlChannel({readyState:'open', send() {}}, {authorized:true});
  const pending = sender.applyFrame({records:[{x:1},{x:2}]});
  await new Promise(resolve => setImmediate(resolve));
  sender.handleControlMessage({data:encodeTouchbackFrame({kind:TouchbackFrameKind.BIND, epoch:4, controlPayload:encodeTouchbackBindPayload({runtimeInstanceId:'r', sessionId:'s', bindingToken:'new', sessionGeneration:1, slotId:0, bindingGeneration:2, lifecycleGeneration:1})})});
  finish('accepted');
  await pending;
  assert.deepEqual(calls, [1]);
  assert.equal(sender.snapshot().authorized, true);
  await sender.applyFrame({records:[{x:3}]});
  assert.deepEqual(calls, [1,3]);
});

test('new binding waits for native reset before applying its first frame', async () => {
  let finishReset;
  let resetCalls = 0;
  const calls = [];
  const sender = new WebCastTouchbackSender({nativeBridge: {
    initialize: () => 'accepted',
    apply: record => { calls.push(record.x); return 'accepted'; },
    reset: () => { resetCalls += 1; return resetCalls === 1 ? 'accepted' : new Promise(resolve => { finishReset = resolve; }); },
    snapshot: () => ({}),
  }});
  await sender.attachControlChannel({readyState: 'open', send() {}}, {authorized: true});
  await sender.pointer.apply({contactId: 0, phase: 0, x: 10, y: 10});
  const bind = encodeTouchbackFrame({kind: TouchbackFrameKind.BIND, epoch: 1,
    controlPayload: encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 'new', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1})});
  sender.handleControlMessage({data: bind});
  const firstFrame = sender.applyFrame({records: [{contactId: 0, phase: 0, buttons: 1, x: 20, y: 20}]});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [10]);
  finishReset(true);
  assert.deepEqual(await firstFrame, {status: 'applied'});
  assert.deepEqual(calls, [10, 20]);
});
