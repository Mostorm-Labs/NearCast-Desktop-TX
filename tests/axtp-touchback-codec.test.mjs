import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STREAM_HEADER_BYTES,
  HEADER_BYTES,
  RECORD_BYTES,
  TouchbackFrameKind,
  TouchbackPhase,
  decodeTouchbackFrame,
  encodeTouchbackFrame,
  encodeTouchbackBindPayload,
} from '../src/touchback/codec.mjs';
import {LauncherCompatibleWebCastSender} from '../src/webcast/launcher-compatible-sender.mjs';

test('encodes AXTP STREAM header and big-endian touch-batch-v1 payload', () => {
  const bytes = new Uint8Array(encodeTouchbackFrame({
    streamId: 0x01020304,
    seqId: 7,
    cursor: 0x0102030405060708n,
    kind: TouchbackFrameKind.BATCH,
    epoch: 9,
    canvasToken: 0x0a0b0c0d,
    geometryToken: 0x0e0f1011,
    records: [{contactId: 0x1234, phase: TouchbackPhase.DOWN, buttons: 3, x: 0x2345, y: 0x4567, modifiers: 0x6789, wheel: -2, dtMs: 10, recordFlags: 0x1234}],
  }));

  assert.equal(bytes.length, STREAM_HEADER_BYTES + HEADER_BYTES + RECORD_BYTES);
  assert.deepEqual([...bytes.slice(0, STREAM_HEADER_BYTES)], [
    1, 2, 3, 4, 0, 0, 0, 7, 1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  assert.deepEqual([...bytes.slice(STREAM_HEADER_BYTES, STREAM_HEADER_BYTES + 12)], [
    0x54, 0x42, 1, 0, 0, 0, 0, 28, 0, 0, 0, 9,
  ]);
  assert.deepEqual([...bytes.slice(STREAM_HEADER_BYTES + HEADER_BYTES, STREAM_HEADER_BYTES + HEADER_BYTES + 12)], [
    0x12, 0x34, 0, 3, 0x23, 0x45, 0x45, 0x67, 0x67, 0x89, 0xff, 0xfe,
  ]);

  const decoded = decodeTouchbackFrame(bytes);
  assert.equal(decoded.streamId, 0x01020304);
  assert.equal(decoded.seqId, 7);
  assert.equal(decoded.cursor, 0x0102030405060708n);
  assert.equal(decoded.records[0].wheel, -2);
});

test('reset is a canonical packet and does not use an application ACK kind', () => {
  const bytes = new Uint8Array(encodeTouchbackFrame({
    streamId: 4, seqId: 10, cursor: 11n, kind: TouchbackFrameKind.RESET,
    epoch: 12, canvasToken: 13, geometryToken: 14,
  }));
  const decoded = decodeTouchbackFrame(bytes);
  assert.equal(decoded.kind, TouchbackFrameKind.RESET);
  assert.equal(decoded.eventCount, 0);
  assert.equal(decoded.payloadLen, 0);
  assert.equal(encodeTouchbackFrame({wireVersion: 'axtp', streamId: 4, seqId: 11, cursor: 12n, kind: TouchbackFrameKind.RESET_ACK, epoch: 12, canvasToken: 13, geometryToken: 14}), null);
});

test('sender fences AXTP stream identity and emits one ordered reset packet without ACK', () => {
  const sent = [];
  const sender = new LauncherCompatibleWebCastSender({onTouchback() {}});
  sender.attachControlChannel({readyState: 'open', send: value => sent.push(value)});
  const bind = encodeTouchbackFrame({wireVersion: 'axtp', streamId: 9, seqId: 0, cursor: 1n, kind: TouchbackFrameKind.BIND, epoch: 2, canvasToken: 3, geometryToken: 4, controlPayload: encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1})});
  assert.equal(sender.handleControlMessage({data: bind}).status, 'accepted');
  assert.equal(sender.handleControlMessage({data: JSON.stringify({method: 'input.openStream', result: {streamId: 9, epoch: 2, acceptedMode: 'touch', format: 'touch-batch-v1', canvasToken: 3, geometryToken: 4, revision: 'rev-1', accepted: true}})}).status, 'stream_opened');
  const first = encodeTouchbackFrame({streamId: 9, seqId: 0, cursor: 1n, kind: TouchbackFrameKind.BATCH, epoch: 2, canvasToken: 3, geometryToken: 4, records: [{contactId: 1, phase: TouchbackPhase.DOWN, x: 1, y: 2}]});
  assert.equal(sender.handleControlMessage({data: first}).status, 'applied');
  const gap = encodeTouchbackFrame({streamId: 9, seqId: 2, cursor: 2n, kind: TouchbackFrameKind.BATCH, epoch: 2, canvasToken: 3, geometryToken: 4, records: [{contactId: 1, phase: TouchbackPhase.MOVE, x: 2, y: 3}]});
  assert.equal(sender.handleControlMessage({data: gap}).status, 'reset_required');
  assert.equal(sent.length, 1);
  const reset = decodeTouchbackFrame(sent[0]);
  assert.equal(reset.kind, TouchbackFrameKind.RESET);
  assert.equal(reset.streamId, 9);
  assert.equal(reset.epoch, 3);
  assert.equal(reset.canvasToken, 3);
  assert.equal(reset.geometryToken, 4);
});

test('opens the AXTP touch stream from the input.openStream control result', () => {
  const events = [];
  const sender = new LauncherCompatibleWebCastSender({onTouchback: frame => events.push(frame)});
  sender.attachControlChannel({readyState: 'open', send() {}});
  const bindPayload = encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1});
  sender.handleControlMessage({data: encodeTouchbackFrame({wireVersion: 'axtp', streamId: 17, seqId: 0, cursor: 1n, kind: TouchbackFrameKind.BIND, epoch: 4, canvasToken: 5, geometryToken: 6, controlPayload: bindPayload})});
  assert.equal(sender.handleControlMessage({data: JSON.stringify({method: 'input.openStream', result: {streamId: 17, epoch: 4, acceptedMode: 'touch', format: 'touch-batch-v1', canvasToken: 5, geometryToken: 6, revision: 'rev-1', accepted: true}})}).status, 'stream_opened');
  const bytes = encodeTouchbackFrame({streamId: 17, seqId: 0, cursor: 1n, kind: TouchbackFrameKind.BATCH, epoch: 4, canvasToken: 5, geometryToken: 6, records: [{contactId: 3, phase: TouchbackPhase.DOWN, x: 10, y: 20}]});
  assert.equal(sender.handleControlMessage({data: bytes}).status, 'applied');
  assert.equal(events.length, 1);
});

test('uses registered control methods for touchback negotiation', async () => {
  const sent = [];
  const sender = new LauncherCompatibleWebCastSender();
  sender.attachControlChannel({readyState: 'open', send: value => sent.push(JSON.parse(value))});
  const request = sender.getControlCapabilities();
  assert.equal(sent[0].method, 'cast.getControlCapabilities');
  sender.handleControlMessage({data: JSON.stringify({id: sent[0].id, result: {touchback: true}})});
  assert.deepEqual(await request, {touchback: true});
});

test('decodes the receiver modern Bind control frame with its formal kind values', () => {
  assert.equal(TouchbackFrameKind.BIND, 3);
  assert.equal(TouchbackFrameKind.CAPABILITY, 4);
  const controlPayload = new Uint8Array([1, 2, 3, 4]);
  const bytes = encodeTouchbackFrame({
    wireVersion: 'axtp', streamId: 9, seqId: 0, cursor: 1n,
    kind: TouchbackFrameKind.BIND, epoch: 2, canvasToken: 3, geometryToken: 4,
    controlPayload,
  });
  assert.ok(bytes);
  const decoded = decodeTouchbackFrame(bytes);
  assert.equal(decoded.kind, TouchbackFrameKind.BIND);
  assert.deepEqual([...new Uint8Array(decoded.controlPayload)], [...controlPayload]);
});

test('accepts a modern binary Bind and then an open result before applying touch batches', () => {
  const events = [];
  const sender = new LauncherCompatibleWebCastSender({onTouchback: frame => events.push(frame)});
  sender.attachControlChannel({readyState: 'open', send() {}});
  const bindPayload = encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1});
  const bind = encodeTouchbackFrame({
    wireVersion: 'axtp', streamId: 9, seqId: 0, cursor: 1n,
    kind: TouchbackFrameKind.BIND, epoch: 2, canvasToken: 3, geometryToken: 4,
    controlPayload: bindPayload,
  });
  assert.equal(sender.handleControlMessage({data: bind}).status, 'accepted');
  assert.equal(sender.handleControlMessage({data: JSON.stringify({method: 'input.openStream', result: {streamId: 9, epoch: 2, acceptedMode: 'touch', format: 'touch-batch-v1', canvasToken: 3, geometryToken: 4, revision: 'rev-1', accepted: true}})}).status, 'stream_opened');
  const batch = encodeTouchbackFrame({
    wireVersion: 'axtp', streamId: 9, seqId: 0, cursor: 2n,
    kind: TouchbackFrameKind.BATCH, epoch: 2, canvasToken: 3, geometryToken: 4,
    records: [{contactId: 1, phase: TouchbackPhase.DOWN, x: 10, y: 20}],
  });
  assert.equal(sender.handleControlMessage({data: batch}).status, 'applied');
  assert.equal(events.length, 1);
});

test('does not activate a stream from BIND alone', () => {
  const events = [];
  const sender = new LauncherCompatibleWebCastSender({onTouchback: frame => events.push(frame)});
  sender.attachControlChannel({readyState: 'open', send() {}});
  const bindPayload = encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1});
  const bind = encodeTouchbackFrame({
    wireVersion: 'axtp', streamId: 9, seqId: 0, cursor: 1n,
    kind: TouchbackFrameKind.BIND, epoch: 2, canvasToken: 3, geometryToken: 4,
    controlPayload: bindPayload,
  });
  assert.equal(sender.handleControlMessage({data: bind}).status, 'accepted');
  assert.equal(sender.snapshot().streamState, 'bound');
  const batch = encodeTouchbackFrame({
    wireVersion: 'axtp', streamId: 9, seqId: 0, cursor: 2n,
    kind: TouchbackFrameKind.BATCH, epoch: 2, canvasToken: 3, geometryToken: 4,
    records: [{contactId: 1, phase: TouchbackPhase.DOWN, x: 10, y: 20}],
  });
  assert.equal(sender.handleControlMessage({data: batch}).status, 'reset_required');
  assert.equal(events.length, 0);
});

test('activates only after a complete input.openStream result', () => {
  const events = [];
  const sender = new LauncherCompatibleWebCastSender({onTouchback: frame => events.push(frame)});
  sender.attachControlChannel({readyState: 'open', send() {}});
  const bindPayload = encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1});
  const bind = encodeTouchbackFrame({
    wireVersion: 'axtp', streamId: 9, seqId: 0, cursor: 1n,
    kind: TouchbackFrameKind.BIND, epoch: 2, canvasToken: 3, geometryToken: 4,
    controlPayload: bindPayload,
  });
  assert.equal(sender.handleControlMessage({data: bind}).status, 'accepted');
  assert.equal(sender.handleControlMessage({data: JSON.stringify({method: 'input.openStream', result: {
    streamId: 9, epoch: 2, acceptedMode: 'touch', format: 'touch-batch-v1', canvasToken: 3,
    geometryToken: 4, revision: 'rev-1', accepted: true,
  }})}).status, 'stream_opened');
  assert.equal(sender.snapshot().streamState, 'active');
  const batch = encodeTouchbackFrame({
    wireVersion: 'axtp', streamId: 9, seqId: 0, cursor: 2n,
    kind: TouchbackFrameKind.BATCH, epoch: 2, canvasToken: 3, geometryToken: 4,
    records: [{contactId: 1, phase: TouchbackPhase.DOWN, x: 10, y: 20}],
  });
  assert.equal(sender.handleControlMessage({data: batch}).status, 'applied');
  assert.equal(events.length, 1);
});

test('accepts receiver-owned input.openStream request only after BIND and replies with the original id and method', () => {
  const sent = [];
  const sender = new LauncherCompatibleWebCastSender();
  sender.attachControlChannel({readyState: 'open', send: value => sent.push(JSON.parse(value))});
  const bindPayload = encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1});
  sender.handleControlMessage({data: encodeTouchbackFrame({wireVersion: 'axtp', streamId: 9, seqId: 0, cursor: 1n, kind: TouchbackFrameKind.BIND, epoch: 2, canvasToken: 3, geometryToken: 4, controlPayload: bindPayload})});
  const result = sender.handleControlMessage({data: JSON.stringify({action: 'axtp-control', id: 'open-1', method: 'input.openStream', params: {
    streamId: 9, epoch: 2, acceptedMode: 'touch', format: 'touch-batch-v1', canvasToken: 3, geometryToken: 4, revision: 'rev-1', accepted: true,
  }})});
  assert.equal(result.status, 'stream_opened');
  assert.equal(sender.snapshot().streamState, 'active');
  assert.deepEqual(sent, [{action: 'axtp-control', id: 'open-1', method: 'input.openStream', result: {
    streamId: 9, epoch: 2, acceptedMode: 'touch', format: 'touch-batch-v1', canvasToken: 3, geometryToken: 4, revision: 'rev-1', accepted: true,
  }}]);
});

test('rejects a mismatched receiver-owned open request and closes an active stream with a response', () => {
  const sent = [];
  const sender = new LauncherCompatibleWebCastSender();
  sender.attachControlChannel({readyState: 'open', send: value => sent.push(JSON.parse(value))});
  const bindPayload = encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1});
  sender.handleControlMessage({data: encodeTouchbackFrame({wireVersion: 'axtp', streamId: 9, seqId: 0, cursor: 1n, kind: TouchbackFrameKind.BIND, epoch: 2, canvasToken: 3, geometryToken: 4, controlPayload: bindPayload})});
  const rejected = sender.handleControlMessage({data: JSON.stringify({action: 'axtp-control', id: 'open-2', method: 'input.openStream', params: {
    streamId: 10, epoch: 2, acceptedMode: 'mouse', format: 'touch-batch-v1', canvasToken: 3, geometryToken: 4, revision: 'rev-2', accepted: true,
  }})});
  assert.equal(rejected.status, 'invalid_state');
  assert.equal(sent.at(-1).id, 'open-2');
  assert.equal(sent.at(-1).method, 'input.openStream');
  assert.equal(sent.at(-1).error.code, 'INVALID_STATE');
  sender.handleControlMessage({data: JSON.stringify({action: 'axtp-control', id: 'open-3', method: 'input.openStream', params: {
    streamId: 9, epoch: 2, acceptedMode: 'touch', format: 'touch-batch-v1', canvasToken: 3, geometryToken: 4, revision: 'rev-1', accepted: true,
  }})});
  const closed = sender.handleControlMessage({data: JSON.stringify({action: 'axtp-control', id: 'close-1', method: 'input.closeStream', params: {streamId: 9, epoch: 2}})});
  assert.equal(closed.status, 'stream_closed');
  assert.equal(sender.snapshot().streamState, 'bound');
  assert.deepEqual(sent.at(-1), {action: 'axtp-control', id: 'close-1', method: 'input.closeStream', result: {streamId: 9, epoch: 2, closed: true, alreadyClosed: false}});
});

test('recognizes AXTP when streamId begins with the touch magic', () => {
  const bytes = encodeTouchbackFrame({
    wireVersion: 'axtp', streamId: 0x54420001, seqId: 0, cursor: 1n,
    kind: TouchbackFrameKind.RESET, epoch: 2, canvasToken: 3, geometryToken: 4,
  });
  assert.equal(decodeTouchbackFrame(bytes).wireVersion, 'axtp');
});

test('accepts an ordered modern reset without waiting for an application ACK', () => {
  const events = [];
  const sender = new LauncherCompatibleWebCastSender({onTouchback: frame => events.push(frame)});
  sender.attachControlChannel({readyState: 'open', send: value => {
    assert.equal(decodeTouchbackFrame(value).kind, TouchbackFrameKind.RESET);
  }});
  const bind = encodeTouchbackFrame({wireVersion: 'axtp', streamId: 19, seqId: 0, cursor: 1n, kind: TouchbackFrameKind.BIND, epoch: 4, canvasToken: 5, geometryToken: 6, controlPayload: encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1})});
  assert.equal(sender.handleControlMessage({data: bind}).status, 'accepted');
  assert.equal(sender.handleControlMessage({data: JSON.stringify({method: 'input.openStream', result: {streamId: 19, epoch: 4, acceptedMode: 'touch', format: 'touch-batch-v1', canvasToken: 5, geometryToken: 6, revision: 'rev-1', accepted: true}})}).status, 'stream_opened');
  const reset = encodeTouchbackFrame({wireVersion: 'axtp', streamId: 19, seqId: 0, cursor: 1n, kind: TouchbackFrameKind.RESET, epoch: 5, canvasToken: 5, geometryToken: 6});
  assert.equal(sender.handleControlMessage({data: reset}).status, 'reset');
  const batch = encodeTouchbackFrame({wireVersion: 'axtp', streamId: 19, seqId: 0, cursor: 2n, kind: TouchbackFrameKind.BATCH, epoch: 5, canvasToken: 5, geometryToken: 6, records: [{contactId: 1, phase: TouchbackPhase.DOWN, x: 1, y: 2}]});
  assert.equal(sender.handleControlMessage({data: batch}).status, 'reset_required');
  assert.equal(sender.snapshot().streamState, 'bound');
  assert.equal(events.length, 0);
});

test('modern close releases the sender binding contacts without sending an ACK', () => {
  let closeCalls = 0;
  const sender = new LauncherCompatibleWebCastSender({onControlFrame: (frame, result) => {
    if (frame.kind === TouchbackFrameKind.CLOSE && result.status === 'closed') closeCalls += 1;
  }});
  sender.attachControlChannel({readyState: 'open', send() {}});
  sender.handleControlMessage({data: encodeTouchbackFrame({wireVersion: 'axtp', streamId: 22, seqId: 0, cursor: 1n, kind: TouchbackFrameKind.BIND, epoch: 7, canvasToken: 8, geometryToken: 9, controlPayload: encodeTouchbackBindPayload({runtimeInstanceId: 'r', sessionId: 's', bindingToken: 't', sessionGeneration: 1, slotId: 0, bindingGeneration: 1, lifecycleGeneration: 1})})});
  const close = encodeTouchbackFrame({wireVersion: 'axtp', streamId: 22, seqId: 0, cursor: 1n, kind: TouchbackFrameKind.CLOSE, epoch: 7, canvasToken: 8, geometryToken: 9});
  assert.equal(sender.handleControlMessage({data: close}).status, 'closed');
  assert.equal(sender.snapshot().activeContacts, 0);
  assert.equal(closeCalls, 1);
});

test('encodes zero-valued normalized coordinates and contact identifiers', () => {
  const bytes = encodeTouchbackFrame({wireVersion: 'axtp', streamId: 23, seqId: 0, cursor: 1n, kind: TouchbackFrameKind.BATCH, epoch: 1, records: [{contactId: 0, phase: TouchbackPhase.DOWN, x: 0, y: 0, modifiers: 0, dtMs: 0, recordFlags: 0}]});
  assert.ok(bytes);
  assert.equal(decodeTouchbackFrame(bytes).records[0].contactId, 0);
});
