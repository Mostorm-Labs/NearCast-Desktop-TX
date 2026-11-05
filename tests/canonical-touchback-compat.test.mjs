import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeTouchbackFrame,
  decodeTouchbackBindPayload,
  encodeTouchbackBindPayload,
  encodeTouchbackFrame,
  TouchbackFrameKind,
} from '../src/touchback/codec.mjs';
import { LauncherCompatibleWebCastSender } from '../src/webcast/launcher-compatible-sender.mjs';
import { WebCastTouchbackSender } from '../src/webcast/touchback-sender.mjs';
import { MacOsInputSink } from '../src/touchback/macos-input.mjs';

// Produced by RX d7e3721 TouchbackCodec.cpp, not by the JavaScript encoder.
const bindBytes = Uint8Array.from(
  Buffer.from(
    '00000001000000000000000000000000544201030000001c0000000100000000000000000000004b3284781d000e72782d6a6f696e742d70726f6265001072782d6a6f696e742d73657373696f6e000b70726f62652d746f6b656e00000000000000010000000000000000000000010000000000000001',
    'hex',
  ),
);
const target = {
  sessionId: 'rx-joint-session',
  sessionGeneration: '1',
  slotId: '0',
  bindingGeneration: '1',
  lifecycleGeneration: '1',
};
const params = (commandId = 'open-1', overrides = {}) => ({
  controlVersion: 1,
  runtimeInstanceId: 'rx-joint-probe',
  target: { ...target },
  streamKind: 'touchback',
  format: 'touch-batch-v1',
  preferredMode: 'touch',
  supportedModes: ['touch', 'mouse'],
  canvasRevision: '1',
  geometryRevision: '1',
  canvasToken: 0,
  geometryToken: 0,
  maxBatchEvents: 1024,
  maxFrameBytes: 1048576,
  maxContacts: 16,
  modeRequirement: 'preferred',
  commandId,
  ...overrides,
});
const message = (method, p, id = p.commandId) => ({
  data: JSON.stringify({ action: 'axtp-control', id, method, params: p }),
});
function setup(options = {}) {
  const replies = [];
  const sender = new LauncherCompatibleWebCastSender(options);
  sender.attachControlChannel({
    readyState: 'open',
    send: (value) =>
      replies.push(typeof value === 'string' ? JSON.parse(value) : value),
  });
  sender.handleControlMessage({ data: bindBytes });
  return { sender, replies };
}

test('decodes and encodes the independently compiled big-endian RX BIND payload', () => {
  const frame = decodeTouchbackFrame(bindBytes);
  const payload = decodeTouchbackBindPayload(frame.controlPayload);
  assert.deepEqual(payload, {
    runtimeInstanceId: 'rx-joint-probe',
    sessionId: 'rx-joint-session',
    bindingToken: 'probe-token',
    sessionGeneration: '1',
    slotId: 0,
    bindingGeneration: '1',
    lifecycleGeneration: '1',
  });
  assert.deepEqual(
    new Uint8Array(encodeTouchbackBindPayload(payload)),
    bindBytes.slice(44),
  );
});

test('preserves uint64 generation fences without JavaScript precision loss', () => {
  const payload = {
    runtimeInstanceId: 'r',
    sessionId: 's',
    bindingToken: 't',
    sessionGeneration: '18446744073709551615',
    slotId: 0,
    bindingGeneration: '9007199254740993',
    lifecycleGeneration: '1',
  };
  assert.deepEqual(
    decodeTouchbackBindPayload(encodeTouchbackBindPayload(payload)),
    payload,
  );
});

test('answers canonical receiver-owned open request with sender-owned mode, revision, identity and bounded limits', () => {
  const { sender, replies } = setup({
    limits: { maxBytes: 65579, maxRecords: 1024, maxContacts: 10 },
  });
  assert.equal(sender.snapshot().streamState, 'bound');
  sender.handleControlMessage(message('input.openStream', params()));
  assert.deepEqual(replies[0], {
    action: 'axtp-control',
    id: 'open-1',
    method: 'input.openStream',
    result: {
      accepted: true,
      streamId: 1,
      epoch: 1,
      acceptedMode: 'touch',
      format: 'touch-batch-v1',
      canvasToken: 0,
      geometryToken: 0,
      maxBatchEvents: 1024,
      maxFrameBytes: 65579,
      maxContacts: 10,
      revision: '1',
    },
  });
  assert.equal(sender.snapshot().streamState, 'active');
});

test('rejects stale target/token before mutating a current stream and permits a corrected request', () => {
  const { sender, replies } = setup();
  sender.handleControlMessage(
    message(
      'input.openStream',
      params('bad-target', { target: { ...target, bindingGeneration: '2' } }),
    ),
  );
  assert.equal(replies.at(-1).error.code, 'INVALID_STATE');
  sender.handleControlMessage(
    message('input.openStream', params('bad-token', { canvasToken: 1 })),
  );
  assert.equal(replies.at(-1).error.code, 'INVALID_STATE');
  assert.equal(sender.snapshot().streamState, 'bound');
  sender.handleControlMessage(message('input.openStream', params('good')));
  assert.equal(replies.at(-1).result.accepted, true);
});

test('negotiates explicit preferred fallback but rejects unsupported required mode', () => {
  const { sender, replies } = setup({ supportedModes: ['touch'] });
  sender.handleControlMessage(
    message(
      'input.openStream',
      params('required', {
        preferredMode: 'mouse',
        modeRequirement: 'required',
      }),
    ),
  );
  assert.equal(replies.at(-1).error.code, 'NOT_SUPPORTED');
  sender.handleControlMessage(
    message(
      'input.openStream',
      params('preferred', { preferredMode: 'mouse' }),
    ),
  );
  assert.equal(replies.at(-1).result.acceptedMode, 'touch');
});

test('replays open without resetting packet sequence or accepting conflicting command reuse', () => {
  const { sender, replies } = setup();
  const p = params();
  sender.handleControlMessage(message('input.openStream', p));
  const batch = encodeTouchbackFrame({
    wireVersion: 'axtp',
    streamId: 1,
    seqId: 0,
    epoch: 1,
    canvasToken: 0,
    geometryToken: 0,
    kind: TouchbackFrameKind.BATCH,
    records: [],
  });
  assert.equal(sender.handleControlMessage({ data: batch }).status, 'applied');
  sender.handleControlMessage(message('input.openStream', p, 'open-retry'));
  assert.deepEqual(replies.at(-1).result, replies[0].result);
  assert.equal(sender.session.nextSequence, 1);
  sender.handleControlMessage(
    message(
      'input.openStream',
      { ...p, preferredMode: 'mouse' },
      'open-conflict',
    ),
  );
  assert.equal(replies.at(-1).error.code, 'INVALID_ARGUMENT');
  assert.equal(sender.session.nextSequence, 1);
});

test('closes idempotently after ordered reset, rejects old epoch, and reopens only the new epoch', () => {
  const { sender, replies } = setup();
  sender.handleControlMessage(message('input.openStream', params()));
  sender.handleControlMessage({
    data: encodeTouchbackFrame({
      wireVersion: 'axtp',
      streamId: 1,
      seqId: 0,
      kind: TouchbackFrameKind.RESET,
      epoch: 2,
      canvasToken: 0,
      geometryToken: 0,
    }),
  });
  sender.handleControlMessage(
    message('input.openStream', params('before-close')),
  );
  assert.equal(replies.at(-1).error.code, 'INVALID_STATE');
  const close = {
    controlVersion: 1,
    runtimeInstanceId: 'rx-joint-probe',
    target: { ...target },
    streamKind: 'touchback',
    streamId: 1,
    epoch: 2,
    commandId: 'close-1',
    reason: 'requested',
  };
  sender.handleControlMessage(message('input.closeStream', close));
  assert.equal(replies.at(-1).result.closed, true);
  const firstClose = replies.at(-1).result;
  sender.handleControlMessage(
    message('input.closeStream', close, 'close-retry'),
  );
  assert.deepEqual(replies.at(-1).result, firstClose);
  sender.handleControlMessage(
    message('input.closeStream', { ...close, commandId: 'close-again' }),
  );
  assert.equal(replies.at(-1).result.alreadyClosed, true);
  sender.handleControlMessage(message('input.openStream', params('reopen')));
  assert.equal(replies.at(-1).result.epoch, 2);
  assert.equal(sender.snapshot().streamState, 'active');
  assert.equal(
    sender.handleControlMessage({
      data: encodeTouchbackFrame({
        wireVersion: 'axtp',
        streamId: 1,
        seqId: 0,
        kind: TouchbackFrameKind.BATCH,
        epoch: 1,
        canvasToken: 0,
        geometryToken: 0,
        records: [],
      }),
    }).status,
    'stale',
  );
});

test('does not activate from an unsolicited legacy result and does not revoke native readiness after malformed BIND', async () => {
  const replies = [];
  const sender = new WebCastTouchbackSender({
    nativeBridge: {
      initialize: () => 'accepted',
      reset() {},
      apply: () => 'accepted',
      snapshot: () => ({}),
    },
  });
  await sender.attachControlChannel(
    { readyState: 'open', send: (value) => replies.push(value) },
    { authorized: true },
  );
  sender.handleControlMessage({
    data: JSON.stringify({
      method: 'input.openStream',
      result: {
        accepted: true,
        streamId: 1,
        epoch: 1,
        acceptedMode: 'touch',
        format: 'touch-batch-v1',
        revision: 'old',
        canvasToken: 0,
        geometryToken: 0,
      },
    }),
  });
  assert.equal(sender.snapshot().streamState, 'unavailable');
  sender.handleControlMessage({ data: new Uint8Array([1, 2, 3]) });
  assert.equal(sender.diagnostics().nativeReady, true);
  sender.handleControlMessage({ data: bindBytes });
  sender.handleControlMessage(message('input.openStream', params()));
  assert.equal(sender.snapshot().streamState, 'active');
});

test('enforces negotiated contact capacity atomically before dispatching input', () => {
  let applied = 0;
  const { sender } = setup({ onTouchback: () => applied++ });
  sender.handleControlMessage(
    message('input.openStream', params('one-contact', { maxContacts: 1 })),
  );
  const batch = encodeTouchbackFrame({
    wireVersion: 'axtp',
    streamId: 1,
    seqId: 0,
    kind: TouchbackFrameKind.BATCH,
    epoch: 1,
    canvasToken: 0,
    geometryToken: 0,
    records: [
      { contactId: 0, phase: 0, x: 1, y: 1 },
      { contactId: 1, phase: 0, x: 2, y: 2 },
    ],
  });
  assert.equal(
    sender.handleControlMessage({ data: batch }).status,
    'reset_required',
  );
  assert.equal(applied, 0);
  assert.equal(sender.snapshot().activeContacts, 0);
});

test('keeps duplicate BIND idempotent and rejects commands retired by a newer BIND epoch', () => {
  const {sender,replies}=setup();
  const original=params();sender.handleControlMessage(message('input.openStream',original));
  sender.session.nextSequence=7;
  sender.handleControlMessage({data:bindBytes});
  assert.equal(sender.snapshot().streamState,'active');
  assert.equal(sender.session.nextSequence,7);
  const frame=decodeTouchbackFrame(bindBytes);
  sender.handleControlMessage({data:encodeTouchbackFrame({...frame,epoch:2})});
  sender.handleControlMessage(message('input.openStream',original,'old-command-new-epoch'));
  assert.equal(replies.at(-1).error.code,'INVALID_STATE');
});

test('uses the platform sink mode and contact capacity during negotiation', async () => {
  const nativeBridge=new MacOsInputSink({native:{initialize:async()=>true}});
  const replies=[];
  const sender=new WebCastTouchbackSender({nativeBridge});
  await sender.attachControlChannel({readyState:'open',send:value=>replies.push(JSON.parse(value))},{authorized:true});
  sender.handleControlMessage({data:bindBytes});
  sender.handleControlMessage(message('input.openStream',params('mac-mouse',{preferredMode:'mouse',modeRequirement:'required'})));
  assert.equal(replies.at(-1).result.acceptedMode,'mouse');
  assert.equal(replies.at(-1).result.maxContacts,1);
});
