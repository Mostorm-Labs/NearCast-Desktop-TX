export const HEADER_BYTES = 28;
export const RECORD_BYTES = 16;
export const MAGIC = 0x5442;
export const VERSION = 1;

export const TouchbackFrameKind = Object.freeze({BATCH: 0, CAPABILITY: 1, BIND: 2, RESET: 3, RESET_ACK: 4, ACK: 5});
export const TouchbackPhase = Object.freeze({DOWN: 0, MOVE: 1, UP: 2, CANCEL: 3});

const validKind = value => Number.isInteger(value) && value >= TouchbackFrameKind.BATCH && value <= TouchbackFrameKind.ACK;
const validPhase = value => Number.isInteger(value) && value >= TouchbackPhase.DOWN && value <= TouchbackPhase.CANCEL;
const uint16 = value => Number.isInteger(value) && value >= 0 && value <= 0xffff;
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (~crc) >>> 0;
}

function fail(message) {
  throw new RangeError(message);
}

export function encodeTouchbackFrame(frame, limits) {
  const maxBytes = limits?.maxBytes ?? 1024 * 1024;
  const maxRecords = limits?.maxRecords ?? 64;
  const kind = frame?.kind;
  const records = Array.isArray(frame?.records) ? frame.records : [];
  const payload = frame?.controlPayload instanceof Uint8Array ? frame.controlPayload : new Uint8Array(frame?.controlPayload ?? []);
  if (!validKind(kind) || records.length > maxRecords || records.length > 0xffff || !uint16(frame?.flags ?? 0) || !uint32(frame?.epoch ?? 0) || !uint32(frame?.sequence ?? 0)) return null;
  const batch = kind === TouchbackFrameKind.BATCH;
  if (batch && payload.length) return null;
  if (!batch && records.length) return null;
  const payloadBytes = batch ? records.length * RECORD_BYTES : payload.length;
  const total = HEADER_BYTES + payloadBytes;
  if (total > maxBytes || payloadBytes > 0xffffffff) return null;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, MAGIC, true); view.setUint8(2, VERSION); view.setUint8(3, kind);
  view.setUint16(4, frame.flags ?? 0, true); view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, frame.epoch ?? 0, true); view.setUint32(12, frame.sequence ?? 0, true);
  view.setUint16(16, records.length, true); view.setUint16(18, 0, true); view.setUint32(20, payloadBytes, true);
  if (batch) {
    for (const [index, record] of records.entries()) {
      if (!uint16(record.contactId ?? 0) || !validPhase(record.phase ?? TouchbackPhase.MOVE) || !uint16(record.x ?? 0) || !uint16(record.y ?? 0) ||
        !uint16(record.modifiers ?? 0) || !uint16(record.dtMs ?? 0) || !uint16(record.recordFlags ?? 0) || !Number.isInteger(record.buttons ?? 0) || record.buttons < 0 || record.buttons > 0xff) return null;
      const offset = HEADER_BYTES + index * RECORD_BYTES;
      view.setUint16(offset, record.contactId ?? 0, true); view.setUint8(offset + 2, record.phase ?? TouchbackPhase.MOVE); view.setUint8(offset + 3, record.buttons ?? 0);
      view.setUint16(offset + 4, record.x ?? 0, true); view.setUint16(offset + 6, record.y ?? 0, true); view.setUint16(offset + 8, record.modifiers ?? 0, true);
      view.setUint16(offset + 10, record.dtMs ?? 0, true); view.setUint16(offset + 12, record.recordFlags ?? 0, true); view.setUint16(offset + 14, 0, true);
    }
  } else out.set(payload, HEADER_BYTES);
  view.setUint32(24, 0, true); view.setUint32(24, crc32(out), true);
  return out.buffer;
}

export function decodeTouchbackFrame(input, limits) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input?.buffer ?? [], input?.byteOffset ?? 0, input?.byteLength ?? 0);
  const maxBytes = limits?.maxBytes ?? 1024 * 1024;
  const maxRecords = limits?.maxRecords ?? 64;
  if (bytes.byteLength < HEADER_BYTES || bytes.byteLength > maxBytes) fail('length limit');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== MAGIC) fail('magic');
  if (view.getUint8(2) !== VERSION) fail('version');
  const kind = view.getUint8(3); if (!validKind(kind)) fail('kind');
  if (view.getUint16(6, true) !== HEADER_BYTES || view.getUint16(18, true) !== 0) fail('header');
  const count = view.getUint16(16, true); const declared = view.getUint32(20, true); const batch = kind === TouchbackFrameKind.BATCH;
  if (count > maxRecords || (!batch && count !== 0)) fail('record limit');
  const expectedPayload = batch ? count * RECORD_BYTES : declared;
  if (declared !== expectedPayload || HEADER_BYTES + expectedPayload !== bytes.byteLength) fail('length');
  const expectedCrc = view.getUint32(24, true); const copy = new Uint8Array(bytes); const copyView = new DataView(copy.buffer); copyView.setUint32(24, 0, true);
  if (crc32(copy) !== expectedCrc) fail('crc');
  const frame = {kind, flags: view.getUint16(4, true), epoch: view.getUint32(8, true), sequence: view.getUint32(12, true), records: []};
  if (batch) {
    for (let index = 0; index < count; index += 1) {
      const offset = HEADER_BYTES + index * RECORD_BYTES; const phase = view.getUint8(offset + 2);
      if (!validPhase(phase) || view.getUint16(offset + 14, true) !== 0) fail('record');
      frame.records.push({contactId: view.getUint16(offset, true), phase, buttons: view.getUint8(offset + 3), x: view.getUint16(offset + 4, true), y: view.getUint16(offset + 6, true), modifiers: view.getUint16(offset + 8, true), dtMs: view.getUint16(offset + 10, true), recordFlags: view.getUint16(offset + 12, true)});
    }
  } else frame.controlPayload = bytes.slice(HEADER_BYTES).slice().buffer;
  return frame;
}

export {crc32};

export function encodeTouchbackBindPayload(payload) {
  const values = [payload?.runtimeInstanceId, payload?.sessionId, payload?.bindingToken];
  if (values.some(value => typeof value !== 'string' || value.length === 0 || value.length > 128)) return null;
  const encoded = values.map(value => new TextEncoder().encode(value));
  if ([payload?.sessionGeneration, payload?.bindingGeneration, payload?.lifecycleGeneration].some(value => !Number.isSafeInteger(value) || value <= 0) || !Number.isSafeInteger(payload?.slotId) || payload.slotId < 0 || payload.slotId > 0xffffffff) return null;
  const size = 6 + encoded.reduce((total, value) => total + value.length, 0) + 8 + 4 + 8 + 8;
  if (size > 1024) return null;
  const out = new Uint8Array(size); const view = new DataView(out.buffer); let offset = 0;
  for (const value of encoded) { view.setUint16(offset, value.length, true); offset += 2; out.set(value, offset); offset += value.length; }
  view.setBigUint64(offset, BigInt(payload.sessionGeneration), true); offset += 8;
  view.setUint32(offset, payload.slotId, true); offset += 4;
  view.setBigUint64(offset, BigInt(payload.bindingGeneration), true); offset += 8;
  view.setBigUint64(offset, BigInt(payload.lifecycleGeneration), true);
  return out.buffer;
}

export function decodeTouchbackBindPayload(input) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input?.buffer ?? [], input?.byteOffset ?? 0, input?.byteLength ?? 0);
  if (bytes.byteLength < 6 + 8 + 4 + 8 + 8 || bytes.byteLength > 1024) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 0;
  const readString = () => { if (offset + 2 > bytes.byteLength) return null; const length = view.getUint16(offset, true); offset += 2; if (!length || length > 128 || offset + length > bytes.byteLength) return null; const value = new TextDecoder().decode(bytes.subarray(offset, offset + length)); offset += length; return value; };
  const runtimeInstanceId = readString(); const sessionId = readString(); const bindingToken = readString();
  if (!runtimeInstanceId || !sessionId || !bindingToken || offset + 8 + 4 + 8 + 8 !== bytes.byteLength) return null;
  const sessionGeneration = Number(view.getBigUint64(offset, true)); offset += 8;
  const slotId = view.getUint32(offset, true); offset += 4;
  const bindingGeneration = Number(view.getBigUint64(offset, true)); offset += 8;
  const lifecycleGeneration = Number(view.getBigUint64(offset, true));
  if (![sessionGeneration, bindingGeneration, lifecycleGeneration].every(Number.isSafeInteger) || !sessionGeneration || !bindingGeneration || !lifecycleGeneration) return null;
  return {runtimeInstanceId, sessionId, bindingToken, sessionGeneration, slotId, bindingGeneration, lifecycleGeneration};
}
