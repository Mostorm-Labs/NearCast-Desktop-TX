export const STREAM_HEADER_BYTES = 16;
export const HEADER_BYTES = 28;
export const RECORD_BYTES = 16;
export const MAGIC = 0x5442;
export const VERSION = 1;

export const TouchbackFrameKind = Object.freeze({
  BATCH: 0,
  RESET: 1,
  CLOSE: 2,
  BIND: 3,
  CAPABILITY: 4,
  RESET_ACK: 5,
  ACK: 6,
});
export const TouchbackPhase = Object.freeze({DOWN: 0, MOVE: 1, UP: 2, CANCEL: 3});

const validAxtpKind = value => value === TouchbackFrameKind.BATCH || value === TouchbackFrameKind.RESET || value === TouchbackFrameKind.CLOSE || value === TouchbackFrameKind.BIND || value === TouchbackFrameKind.CAPABILITY;
const validLegacyKind = value => Number.isInteger(value) && value >= 0 && value <= 5;
const validPhase = value => Number.isInteger(value) && value >= TouchbackPhase.DOWN && value <= TouchbackPhase.CANCEL;
const uint16 = value => Number.isInteger(value) && value >= 0 && value <= 0xffff;
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const uint64 = value => typeof value === 'bigint' ? value >= 0n && value <= 0xffffffffffffffffn : Number.isSafeInteger(value) && value >= 0;

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

function fail(message) { throw new RangeError(message); }
function asBytes(input) { return input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input?.buffer ?? [], input?.byteOffset ?? 0, input?.byteLength ?? 0); }
function monotonicCursor() { const now = globalThis.performance?.now?.() ?? Date.now(); const origin = globalThis.performance?.timeOrigin ?? 0; return BigInt(Math.max(0, Math.floor((origin + now) * 1000))); }
function hasAxtpFields(frame) { return frame?.wireVersion === 'axtp' || ['streamId', 'seqId', 'cursor', 'canvasToken', 'geometryToken'].some(key => Object.hasOwn(frame ?? {}, key)); }

function encodeAxtpFrame(frame, limits) {
  const maxBytes = limits?.maxBytes ?? 1024 * 1024;
  const maxRecords = limits?.maxRecords ?? 1024;
  const kind = frame?.kind;
  const records = Array.isArray(frame?.records) ? frame.records : [];
  const streamId = frame?.streamId ?? 1;
  const seqId = frame?.seqId ?? frame?.sequence ?? 0;
  const cursor = frame?.cursor ?? monotonicCursor();
  const canvasToken = frame?.canvasToken ?? 0;
  const geometryToken = frame?.geometryToken ?? 0;
  const controlPayload = asBytes(frame?.controlPayload);
  if (!validAxtpKind(kind) || !uint32(streamId) || streamId === 0 || !uint32(seqId) || !uint64(cursor) || !uint32(frame?.epoch ?? 0) || !uint32(canvasToken) || !uint32(geometryToken) || !uint16(frame?.flags ?? 0) || records.length > maxRecords || records.length > 0xffff) return null;
  if (kind !== TouchbackFrameKind.BATCH && records.length) return null;
  if (kind === TouchbackFrameKind.BATCH && controlPayload.length) return null;
  const payloadBytes = kind === TouchbackFrameKind.BATCH ? records.length * RECORD_BYTES : controlPayload.length;
  if (payloadBytes > 0xffff || STREAM_HEADER_BYTES + HEADER_BYTES + payloadBytes > maxBytes) return null;
  const out = new Uint8Array(STREAM_HEADER_BYTES + HEADER_BYTES + payloadBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, streamId, false); view.setUint32(4, seqId, false); view.setBigUint64(8, BigInt(cursor), false);
  const offset = STREAM_HEADER_BYTES;
  view.setUint16(offset, MAGIC, false); view.setUint8(offset + 2, VERSION); view.setUint8(offset + 3, kind); view.setUint16(offset + 4, frame.flags ?? 0, false); view.setUint16(offset + 6, HEADER_BYTES, false); view.setUint32(offset + 8, frame.epoch ?? 0, false); view.setUint32(offset + 12, canvasToken, false); view.setUint32(offset + 16, geometryToken, false); view.setUint16(offset + 20, records.length, false); view.setUint16(offset + 22, payloadBytes, false); view.setUint32(offset + 24, 0, false);
  for (const [index, record] of records.entries()) {
    const wheel = record.wheel ?? 0;
    if (!uint16(record.contactId ?? 0) || !validPhase(record.phase ?? TouchbackPhase.MOVE) || !uint16(record.x ?? 0) || !uint16(record.y ?? 0) || !uint16(record.modifiers ?? 0) || !uint16(record.dtMs ?? 0) || !uint16(record.recordFlags ?? 0) || !Number.isInteger(record.buttons ?? 0) || record.buttons < 0 || record.buttons > 0xff || !Number.isInteger(wheel) || wheel < -0x8000 || wheel > 0x7fff) return null;
    const at = offset + HEADER_BYTES + index * RECORD_BYTES;
    view.setUint16(at, record.contactId ?? 0, false); view.setUint8(at + 2, record.phase ?? TouchbackPhase.MOVE); view.setUint8(at + 3, record.buttons ?? 0); view.setUint16(at + 4, record.x ?? 0, false); view.setUint16(at + 6, record.y ?? 0, false); view.setUint16(at + 8, record.modifiers ?? 0, false); view.setInt16(at + 10, wheel, false); view.setUint16(at + 12, record.dtMs ?? 0, false); view.setUint16(at + 14, record.recordFlags ?? 0, false);
  }
  if (kind !== TouchbackFrameKind.BATCH) out.set(controlPayload, offset + HEADER_BYTES);
  const payload = out.subarray(STREAM_HEADER_BYTES); view.setUint32(offset + 24, crc32(payload), false); return out.buffer;
}

function decodeAxtpFrame(bytes, limits) {
  const maxBytes = limits?.maxBytes ?? 1024 * 1024; const maxRecords = limits?.maxRecords ?? 1024;
  if (bytes.byteLength < STREAM_HEADER_BYTES + HEADER_BYTES || bytes.byteLength > maxBytes) fail('length limit');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const streamId = view.getUint32(0, false); const seqId = view.getUint32(4, false); const cursor = view.getBigUint64(8, false); const offset = STREAM_HEADER_BYTES;
  if (view.getUint16(offset, false) !== MAGIC) fail('magic'); if (view.getUint8(offset + 2) !== VERSION) fail('version'); const kind = view.getUint8(offset + 3); if (!validAxtpKind(kind)) fail('kind'); if (view.getUint16(offset + 6, false) !== HEADER_BYTES) fail('header');
  const epoch = view.getUint32(offset + 8, false); const canvasToken = view.getUint32(offset + 12, false); const geometryToken = view.getUint32(offset + 16, false); const eventCount = view.getUint16(offset + 20, false); const payloadLen = view.getUint16(offset + 22, false); const declaredCrc = view.getUint32(offset + 24, false);
  const batch = kind === TouchbackFrameKind.BATCH;
  if (eventCount > maxRecords || (!batch && eventCount !== 0) || (batch && payloadLen !== eventCount * RECORD_BYTES) || offset + HEADER_BYTES + payloadLen !== bytes.byteLength) fail('length');
  const payload = bytes.slice(offset); const payloadView = new DataView(payload.buffer); payloadView.setUint32(24, 0, false); if (crc32(payload) !== declaredCrc) fail('crc');
  const frame = {wireVersion: 'axtp', streamId, seqId, cursor, kind, flags: view.getUint16(offset + 4, false), epoch, canvasToken, geometryToken, eventCount, payloadLen, records: []};
  if (kind !== TouchbackFrameKind.BATCH) frame.controlPayload = bytes.slice(offset + HEADER_BYTES).buffer;
  for (let index = 0; index < eventCount; index += 1) { const at = offset + HEADER_BYTES + index * RECORD_BYTES; const phase = view.getUint8(at + 2); if (!validPhase(phase)) fail('record'); frame.records.push({contactId: view.getUint16(at, false), phase, buttons: view.getUint8(at + 3), x: view.getUint16(at + 4, false), y: view.getUint16(at + 6, false), modifiers: view.getUint16(at + 8, false), wheel: view.getInt16(at + 10, false), dtMs: view.getUint16(at + 12, false), recordFlags: view.getUint16(at + 14, false)}); }
  return frame;
}

function encodeLegacyFrame(frame, limits) {
  const maxBytes = limits?.maxBytes ?? 1024 * 1024; const maxRecords = limits?.maxRecords ?? 1024; const records = Array.isArray(frame?.records) ? frame.records : []; const payload = frame?.controlPayload instanceof Uint8Array ? frame.controlPayload : new Uint8Array(frame?.controlPayload ?? []); const kindMap = {[TouchbackFrameKind.BATCH]: 0, [TouchbackFrameKind.CAPABILITY]: 1, [TouchbackFrameKind.BIND]: 2, [TouchbackFrameKind.RESET]: 3, [TouchbackFrameKind.RESET_ACK]: 4, [TouchbackFrameKind.ACK]: 5}; const rawKind = kindMap[frame?.kind];
  if (rawKind === undefined || records.length > maxRecords || records.length > 0xffff || !uint16(frame?.flags ?? 0) || !uint32(frame?.epoch ?? 0) || !uint32(frame?.sequence ?? 0)) return null; const batch = rawKind === 0; if (batch && payload.length || !batch && records.length) return null; const payloadBytes = batch ? records.length * RECORD_BYTES : payload.length; const total = HEADER_BYTES + payloadBytes; if (total > maxBytes || payloadBytes > 0xffffffff) return null;
  const out = new Uint8Array(total); const view = new DataView(out.buffer); view.setUint16(0, MAGIC, true); view.setUint8(2, VERSION); view.setUint8(3, rawKind); view.setUint16(4, frame.flags ?? 0, true); view.setUint16(6, HEADER_BYTES, true); view.setUint32(8, frame.epoch ?? 0, true); view.setUint32(12, frame.sequence ?? 0, true); view.setUint16(16, records.length, true); view.setUint16(18, 0, true); view.setUint32(20, payloadBytes, true);
  if (batch) for (const [index, record] of records.entries()) { const at = HEADER_BYTES + index * RECORD_BYTES; if (!uint16(record.contactId ?? 0) || !validPhase(record.phase ?? TouchbackPhase.MOVE) || !uint16(record.x ?? 0) || !uint16(record.y ?? 0) || !uint16(record.modifiers ?? 0) || !uint16(record.dtMs ?? 0) || !uint16(record.recordFlags ?? 0) || !Number.isInteger(record.buttons ?? 0) || record.buttons < 0 || record.buttons > 0xff) return null; view.setUint16(at, record.contactId ?? 0, true); view.setUint8(at + 2, record.phase ?? TouchbackPhase.MOVE); view.setUint8(at + 3, record.buttons ?? 0); view.setUint16(at + 4, record.x ?? 0, true); view.setUint16(at + 6, record.y ?? 0, true); view.setUint16(at + 8, record.modifiers ?? 0, true); view.setUint16(at + 10, record.dtMs ?? 0, true); view.setUint16(at + 12, record.recordFlags ?? 0, true); view.setUint16(at + 14, 0, true); } else out.set(payload, HEADER_BYTES);
  view.setUint32(24, 0, true); view.setUint32(24, crc32(out), true); return out.buffer;
}

function decodeLegacyFrame(bytes, limits) {
  const maxBytes = limits?.maxBytes ?? 1024 * 1024; const maxRecords = limits?.maxRecords ?? 1024; if (bytes.byteLength < HEADER_BYTES || bytes.byteLength > maxBytes) fail('length limit'); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); if (view.getUint16(0, true) !== MAGIC) fail('magic'); if (view.getUint8(2) !== VERSION) fail('version'); const rawKind = view.getUint8(3); if (!validLegacyKind(rawKind)) fail('kind'); if (view.getUint16(6, true) !== HEADER_BYTES || view.getUint16(18, true) !== 0) fail('header'); const count = view.getUint16(16, true); const declared = view.getUint32(20, true); const batch = rawKind === 0; if (count > maxRecords || (!batch && count !== 0)) fail('record limit'); const expectedPayload = batch ? count * RECORD_BYTES : declared; if (declared !== expectedPayload || HEADER_BYTES + expectedPayload !== bytes.byteLength) fail('length'); const expectedCrc = view.getUint32(24, true); const copy = new Uint8Array(bytes); const copyView = new DataView(copy.buffer, copy.byteOffset, copy.byteLength); copyView.setUint32(24, 0, true); if (crc32(copy) !== expectedCrc) fail('crc'); const kind = [TouchbackFrameKind.BATCH, TouchbackFrameKind.CAPABILITY, TouchbackFrameKind.BIND, TouchbackFrameKind.RESET, TouchbackFrameKind.RESET_ACK, TouchbackFrameKind.ACK][rawKind]; const frame = {wireVersion: 'legacy', kind, flags: view.getUint16(4, true), epoch: view.getUint32(8, true), sequence: view.getUint32(12, true), records: []}; if (batch) for (let index = 0; index < count; index += 1) { const at = HEADER_BYTES + index * RECORD_BYTES; const phase = view.getUint8(at + 2); if (!validPhase(phase) || view.getUint16(at + 14, true) !== 0) fail('record'); frame.records.push({contactId: view.getUint16(at, true), phase, buttons: view.getUint8(at + 3), x: view.getUint16(at + 4, true), y: view.getUint16(at + 6, true), modifiers: view.getUint16(at + 8, true), wheel: 0, dtMs: view.getUint16(at + 10, true), recordFlags: view.getUint16(at + 12, true)}); } else frame.controlPayload = bytes.slice(HEADER_BYTES).buffer; return frame;
}

export function encodeTouchbackFrame(frame, limits) { return hasAxtpFields(frame) ? encodeAxtpFrame(frame, limits) : encodeLegacyFrame(frame, limits); }
export function decodeTouchbackFrame(input, limits) { const bytes = asBytes(input); if (bytes.byteLength >= STREAM_HEADER_BYTES + HEADER_BYTES && bytes[STREAM_HEADER_BYTES] === 0x54 && bytes[STREAM_HEADER_BYTES + 1] === 0x42) return decodeAxtpFrame(bytes, limits); return decodeLegacyFrame(bytes, limits); }
export {crc32};

function generation(value) {
  if (!(typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) && !(typeof value === 'number' && Number.isSafeInteger(value) && value > 0) && typeof value !== 'bigint') return null;
  try { const n = BigInt(value); return n > 0n && n <= 0xffffffffffffffffn ? n : null; } catch { return null; }
}

export function encodeTouchbackBindPayload(payload) {
  const strings = [payload?.runtimeInstanceId, payload?.sessionId, payload?.bindingToken];
  if (strings.some(value => typeof value !== 'string' || !value || value.includes('\0'))) return null;
  const encoded = strings.map(value => new TextEncoder().encode(value));
  const generations = [payload.sessionGeneration, payload.bindingGeneration, payload.lifecycleGeneration].map(generation);
  if (encoded.some(value => value.length > 128) || generations.includes(null) || !uint32(payload.slotId)) return null;
  const bytes = new Uint8Array(34 + encoded.reduce((n, value) => n + value.length, 0));
  const view = new DataView(bytes.buffer); let offset = 0;
  for (const value of encoded) { view.setUint16(offset, value.length, false); offset += 2; bytes.set(value, offset); offset += value.length; }
  view.setBigUint64(offset, generations[0], false); offset += 8;
  view.setUint32(offset, payload.slotId, false); offset += 4;
  view.setBigUint64(offset, generations[1], false); offset += 8;
  view.setBigUint64(offset, generations[2], false);
  return bytes.buffer;
}

export function decodeTouchbackBindPayload(input) {
  const bytes = asBytes(input);
  if (bytes.length < 37 || bytes.length > 1024) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length); let offset = 0;
  try {
    const strings = [];
    for (let i = 0; i < 3; i++) {
      if (offset + 2 > bytes.length) return null;
      const length = view.getUint16(offset, false); offset += 2;
      if (!length || length > 128 || offset + length > bytes.length) return null;
      const value = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(offset, offset + length));
      if (value.includes('\0')) return null;
      strings.push(value); offset += length;
    }
    if (offset + 28 !== bytes.length) return null;
    const sessionGeneration = view.getBigUint64(offset, false); offset += 8;
    const slotId = view.getUint32(offset, false); offset += 4;
    const bindingGeneration = view.getBigUint64(offset, false); offset += 8;
    const lifecycleGeneration = view.getBigUint64(offset, false);
    if (!sessionGeneration || !bindingGeneration || !lifecycleGeneration) return null;
    return {runtimeInstanceId: strings[0], sessionId: strings[1], bindingToken: strings[2], sessionGeneration: String(sessionGeneration), slotId, bindingGeneration: String(bindingGeneration), lifecycleGeneration: String(lifecycleGeneration)};
  } catch { return null; }
}
