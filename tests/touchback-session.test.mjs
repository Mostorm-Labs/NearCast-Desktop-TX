import test from 'node:test';
import assert from 'node:assert/strict';
import {TouchbackFrameKind, TouchbackPhase, encodeTouchbackFrame} from '../src/touchback/codec.mjs';
import {TouchbackSession} from '../src/touchback/session.mjs';

const binding = {runtimeInstanceId: 'runtime-a', sessionId: 'peer-a', sessionGeneration: 4, slotId: 2, bindingGeneration: 8, lifecycleGeneration: 11, bindingToken: 'opaque-a', epoch: 3};
const frame = (sequence, records, epoch = binding.epoch) => new Uint8Array(encodeTouchbackFrame({kind: TouchbackFrameKind.BATCH, epoch, sequence, records}, {maxBytes: 4096, maxRecords: 8}));

test('binds to the exact opaque session and fences duplicate/gap sequences', () => {
  const session = new TouchbackSession({maxBytes: 4096, maxRecords: 8});
  assert.equal(session.accept({kind: TouchbackFrameKind.BIND, binding}).status, 'accepted');
  assert.equal(session.acceptBytes(frame(0, [{contactId: 1, phase: TouchbackPhase.DOWN, x: 1, y: 2}])).status, 'applied');
  assert.equal(session.activeContacts.size, 1);
  assert.equal(session.acceptBytes(frame(1, [{contactId: 1, phase: TouchbackPhase.UP, x: 1, y: 2}])).status, 'applied');
  assert.equal(session.activeContacts.size, 0);
  assert.equal(session.acceptBytes(frame(1, [{contactId: 1, phase: TouchbackPhase.DOWN, x: 1, y: 2}])).status, 'stale');
  assert.equal(session.acceptBytes(frame(3, [{contactId: 1, phase: TouchbackPhase.DOWN, x: 1, y: 2}])).status, 'reset_required');
});

test('reset clears contacts and changes the epoch before accepting new data', () => {
  const session = new TouchbackSession({maxBytes: 4096, maxRecords: 8});
  session.accept({kind: TouchbackFrameKind.BIND, binding});
  session.acceptBytes(frame(0, [{contactId: 2, phase: TouchbackPhase.DOWN, x: 1, y: 2}]));
  const reset = session.accept({kind: TouchbackFrameKind.RESET, epoch: 4});
  assert.equal(reset.status, 'reset');
  assert.equal(session.activeContacts.size, 0);
  assert.equal(session.acceptBytes(frame(0, [{contactId: 2, phase: TouchbackPhase.DOWN, x: 1, y: 2}], 4)).status, 'reset_required');
  assert.equal(session.accept({kind: TouchbackFrameKind.RESET_ACK, epoch: 4}).status, 'accepted');
  assert.equal(session.acceptBytes(frame(0, [{contactId: 2, phase: TouchbackPhase.DOWN, x: 1, y: 2}], 4)).status, 'applied');
});
