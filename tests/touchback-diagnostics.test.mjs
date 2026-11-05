import {encodeTouchbackFrame, openCurrent} from './helpers/canonical-touchback.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {WebCastTouchbackSender} from '../src/webcast/touchback-sender.mjs';
import {encodeTouchbackBindPayload, TouchbackFrameKind} from '../src/touchback/codec.mjs';

const createSender = () => new WebCastTouchbackSender({nativeBridge: {
  initialize: () => 'accepted', reset() {}, apply: () => 'accepted', snapshot: () => ({}),
}});

test('reports a received open request rejection without retaining credentials or raw payloads', () => {
  const sender = createSender();
  sender.attachControlChannel({readyState: 'open', send() {}}, {authorized: true});
  sender.handleControlMessage({data: JSON.stringify({action: 'axtp-control', id: 'request-secret', method: 'input.openStream', params: {
    acceptedMode: 'touch', format: 'touch-batch-v1', revision: '1', streamId: 7, epoch: 2,
    canvasToken: 3, geometryToken: 4, pairCode: 'pair-secret', bindingToken: 'binding-secret',
  }})});
  const diagnostics = sender.controlDiagnostics();
  assert.equal(diagnostics.textReceived, 1);
  assert.equal(diagnostics.recentControl.at(-1).method, 'input.openStream');
  assert.equal(diagnostics.recentControl.at(-1).status, 'control_rejected');
  assert.equal(diagnostics.recentControl.at(-1).params.acceptedMode, 'touch');
  assert.match(diagnostics.recentControl.at(-1).error, /commandId/);
  assert.equal(JSON.stringify(diagnostics).includes('secret'), false);
});

test('distinguishes received BIND from active stream and counts input rejected before authorization', () => {
  const sender = createSender();
  sender.attachControlChannel({readyState: 'open', send() {}}, {authorized: true});
  sender.handleControlMessage({data: encodeTouchbackFrame({kind: TouchbackFrameKind.BIND, epoch: 1,
    controlPayload: encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 'secret', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1}),
  })});
  assert.equal(sender.controlDiagnostics().binaryReceived, 1);
  assert.equal(sender.controlDiagnostics().streamState, 'bound');
  assert.equal(sender.controlDiagnostics().lastBinary.status, 'accepted');
  sender.handleControlMessage({data: JSON.stringify(openCurrent(sender))});
  assert.equal(sender.controlDiagnostics().streamState, 'active');
  assert.equal(sender.controlDiagnostics().stream.streamId, 1);
  assert.equal(JSON.stringify(sender.controlDiagnostics()).includes('secret'), false);
  sender.fence();
  sender.handleControlMessage({data: new Uint8Array([1, 2, 3])});
  assert.equal(sender.controlDiagnostics().binaryReceived, 2);
  assert.equal(sender.controlDiagnostics().lastBinary.status, 'not_supported');
});

test('retains a bounded copy of control history separately from high frequency binary frames', () => {
  const sender = createSender();
  sender.attachControlChannel({readyState: 'open', send() {}}, {authorized: true});
  for (let i = 0; i < 80; i++) sender.handleControlMessage({data: JSON.stringify({method: 'cast.touchbackChanged', params: {revision: String(i)}})});
  const diagnostics = sender.controlDiagnostics();
  assert.equal(diagnostics.textReceived, 80);
  assert.equal(diagnostics.recentControl.length, 32);
  assert.equal(diagnostics.recentControl[0].params.revision, '48');
  diagnostics.recentControl.length = 0;
  assert.equal(sender.controlDiagnostics().recentControl.length, 32);
});
