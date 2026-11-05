import { encodeTouchbackFrame as encodeFrame } from '../../src/touchback/codec.mjs';

export const encodeTouchbackFrame = (frame, limits) =>
  encodeFrame(
    {
      wireVersion: 'axtp',
      streamId: 1,
      canvasToken: 0,
      geometryToken: 0,
      ...frame,
    },
    limits,
  );
let sequence = 0;
// This drives native/queue tests; the independent C++ golden test verifies fence values.
export function openCurrent(sender, overrides = {}) {
  const receiver = sender.receiver ?? sender;
  const b = receiver.session.binding;
  const commandId = `fixture-open-${++sequence}`;
  return {
    action: 'axtp-control',
    id: commandId,
    method: 'input.openStream',
    params: {
      controlVersion: 1,
      runtimeInstanceId: b.runtimeInstanceId,
      target: Object.fromEntries(
        [
          'sessionId',
          'sessionGeneration',
          'slotId',
          'bindingGeneration',
          'lifecycleGeneration',
        ].map((k) => [k, String(b[k])]),
      ),
      streamKind: 'touchback',
      format: 'touch-batch-v1',
      preferredMode: 'touch',
      supportedModes: ['touch', 'mouse'],
      modeRequirement: 'preferred',
      canvasRevision: '1',
      geometryRevision: '1',
      canvasToken: receiver.session.canvasToken,
      geometryToken: receiver.session.geometryToken,
      commandId,
      ...overrides,
    },
  };
}
