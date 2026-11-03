import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADER_BYTES,
  RECORD_BYTES,
  TouchbackFrameKind,
  TouchbackPhase,
  decodeTouchbackFrame,
  encodeTouchbackFrame,
  decodeTouchbackBindPayload,
  encodeTouchbackBindPayload,
} from '../src/touchback/codec.mjs';

test('encodes the canonical big-endian AXTP STREAM and touch-batch layout', () => {
  const bytes = encodeTouchbackFrame({
    wireVersion: 'axtp',
    streamId: 0x01020304,
    seqId: 42,
    cursor: 0x0102030405060708n,
    kind: TouchbackFrameKind.BATCH,
    epoch: 9,
    canvasToken: 10,
    geometryToken: 11,
    records: [
      {contactId: 7, phase: TouchbackPhase.DOWN, buttons: 3, x: 0x1234, y: 0xabcd, modifiers: 0x0201, dtMs: 9, recordFlags: 0x40},
      {contactId: 7, phase: TouchbackPhase.MOVE, buttons: 3, x: 0x1235, y: 0xabce, modifiers: 0x0201, dtMs: 8, recordFlags: 0x40},
    ],
  }, {maxBytes: 4096, maxRecords: 8});

  assert.equal(bytes.byteLength, 16 + HEADER_BYTES + 2 * RECORD_BYTES);
  assert.deepEqual([...new Uint8Array(bytes.slice(0, 16))], [1, 2, 3, 4, 0, 0, 0, 42, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...new Uint8Array(bytes.slice(16, 20))], [0x54, 0x42, 1, 0]);
  const decoded = decodeTouchbackFrame(bytes, {maxBytes: 4096, maxRecords: 8});
  assert.equal(decoded.seqId, 42);
  assert.equal(decoded.records[1].x, 0x1235);
  assert.equal(decoded.records[1].phase, TouchbackPhase.MOVE);
});

test('rejects corrupted, truncated, unknown, and over-limit frames before allocation', () => {
  const bytes = new Uint8Array(encodeTouchbackFrame({kind: TouchbackFrameKind.BATCH, records: [{contactId: 1, phase: TouchbackPhase.DOWN, x: 1, y: 2}]}, {maxBytes: 1024, maxRecords: 2}));
  bytes[bytes.length - 1] ^= 0xff;
  assert.throws(() => decodeTouchbackFrame(bytes, {maxBytes: 1024, maxRecords: 2}), /crc/i);
  const clean = new Uint8Array(encodeTouchbackFrame({kind: TouchbackFrameKind.BATCH, records: [{contactId: 1, phase: TouchbackPhase.DOWN, x: 1, y: 2}]}, {maxBytes: 1024, maxRecords: 2}));
  clean[3] = 0xff;
  assert.throws(() => decodeTouchbackFrame(clean, {maxBytes: 1024, maxRecords: 2}), /kind/i);
  const truncated = new Uint8Array(encodeTouchbackFrame({kind: TouchbackFrameKind.BATCH, records: [{contactId: 1, phase: TouchbackPhase.DOWN, x: 1, y: 2}]}, {maxBytes: 1024, maxRecords: 2})).subarray(0, clean.length - 1);
  assert.throws(() => decodeTouchbackFrame(truncated, {maxBytes: 1024, maxRecords: 2}), /length/i);
  assert.equal(encodeTouchbackFrame({kind: TouchbackFrameKind.BATCH, records: [{contactId: 1, phase: TouchbackPhase.DOWN}]}, {maxBytes: HEADER_BYTES, maxRecords: 1}), null);
});

test('round trips the canonical bind owner payload', () => {
  const payload = {runtimeInstanceId: 'runtime-a', sessionId: 'session-a', bindingToken: 'opaque-token', sessionGeneration: 4, slotId: 2, bindingGeneration: 8, lifecycleGeneration: 11};
  assert.deepEqual(decodeTouchbackBindPayload(encodeTouchbackBindPayload(payload)), payload);
});
