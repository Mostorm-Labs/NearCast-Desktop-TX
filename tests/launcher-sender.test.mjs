import test from 'node:test';
import assert from 'node:assert/strict';
import {LauncherCompatibleWebCastSender} from '../src/webcast/launcher-compatible-sender.mjs';
import {TouchbackFrameKind, encodeTouchbackFrame} from '../src/touchback/codec.mjs';

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
