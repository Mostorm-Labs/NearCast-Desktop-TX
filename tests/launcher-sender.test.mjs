import test from 'node:test';
import assert from 'node:assert/strict';
import {LauncherCompatibleWebCastSender} from '../src/webcast/launcher-compatible-sender.mjs';
import {TouchbackFrameKind, encodeTouchbackFrame, encodeTouchbackBindPayload} from '../src/touchback/codec.mjs';

test('accepts binary touchback through the existing Launcher control channel', async () => {
  const events = [];
  const sender = new LauncherCompatibleWebCastSender({onTouchback: frame => events.push(frame)});
  const control = {readyState: 'open', send() {}};
  sender.attachControlChannel(control);
  const bytes = new Uint8Array([0x42, 0x54, 1, 5, 0, 0, 28, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  sender.handleControlMessage({data: bytes.buffer});
  assert.equal(events.length, 0);
  assert.equal(sender.snapshot().binaryRejected, 1);
});

test('dispatches capability and bind binary controls through the session boundary', () => {
  const controls = [];
  const binding = {runtimeInstanceId: 'runtime-a', sessionId: 'peer-a', sessionGeneration: 4, slotId: 2, bindingGeneration: 8, lifecycleGeneration: 11, bindingToken: 'opaque-a'};
  const sender = new LauncherCompatibleWebCastSender({resolveBinding: () => binding, onControlFrame: frame => controls.push(frame.kind)});
  sender.attachControlChannel({readyState: 'open', send() {}});
  const bytes = encodeTouchbackFrame({kind: TouchbackFrameKind.BIND, epoch: 3}, {maxBytes: 4096, maxRecords: 8});
  sender.handleControlMessage({data: bytes});
  assert.deepEqual(controls, [TouchbackFrameKind.BIND]);
  assert.equal(sender.snapshot().activeContacts, 0);
});

test('decodes canonical bind payload without a side channel resolver', () => {
  const controls = [];
  const sender = new LauncherCompatibleWebCastSender({onControlFrame: frame => controls.push(frame.kind)});
  sender.attachControlChannel({readyState: 'open', send() {}});
  const controlPayload = encodeTouchbackBindPayload({runtimeInstanceId: 'runtime-a', sessionId: 'peer-a', bindingToken: 'opaque-a', sessionGeneration: 4, slotId: 2, bindingGeneration: 8, lifecycleGeneration: 11});
  const bytes = encodeTouchbackFrame({kind: TouchbackFrameKind.BIND, epoch: 3, controlPayload}, {maxBytes: 4096, maxRecords: 8});
  assert.equal(sender.handleControlMessage({data: bytes}).status, 'accepted');
  assert.deepEqual(controls, [TouchbackFrameKind.BIND]);
});

test('answers a newer reset epoch and fences injection until ack state is clear', () => {
  const sent = [];
  const sender = new LauncherCompatibleWebCastSender();
  sender.attachControlChannel({readyState: 'open', send: value => sent.push(value)});
  sender.session.accept({kind: TouchbackFrameKind.BIND, binding: {bindingToken: 'opaque', epoch: 3}});
  const bytes = encodeTouchbackFrame({kind: TouchbackFrameKind.RESET, epoch: 4, sequence: 0}, {maxBytes: 4096, maxRecords: 8});
  assert.equal(sender.handleControlMessage({data: bytes}).status, 'reset');
  assert.equal(sent.length, 1);
});
