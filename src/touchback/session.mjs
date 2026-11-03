import {TouchbackFrameKind, TouchbackPhase, decodeTouchbackFrame, decodeTouchbackBindPayload} from './codec.mjs';

const sameBinding = (a, b) => a && b && a.runtimeInstanceId === b.runtimeInstanceId && a.sessionId === b.sessionId && a.sessionGeneration === b.sessionGeneration &&
  a.slotId === b.slotId && a.bindingGeneration === b.bindingGeneration && a.lifecycleGeneration === b.lifecycleGeneration && a.bindingToken === b.bindingToken;

export class TouchbackSession {
  constructor(limits = {}) {
    this.limits = limits;
    this.binding = null;
    this.epoch = null;
    this.nextSequence = 0;
    this.streamId = null;
    this.canvasToken = null;
    this.geometryToken = null;
    this.wireVersion = null;
    this.resetPending = false;
    this.activeContacts = new Map();
  }

  accept(control) {
    if (!control || !Number.isInteger(control.kind)) return {status: 'invalid_state'};
    if (control.kind === TouchbackFrameKind.BIND) {
      if (!control.binding?.bindingToken) return {status: 'invalid_state'};
      this.binding = {...control.binding}; this.epoch = control.binding.epoch ?? 0; this.streamId = control.binding.streamId ?? null;
      this.canvasToken = control.binding.canvasToken ?? null; this.geometryToken = control.binding.geometryToken ?? null;
      this.wireVersion = control.binding.wireVersion ?? null; this.nextSequence = 0; this.resetPending = false; this.activeContacts.clear();
      return {status: 'accepted'};
    }
    if (control.kind === TouchbackFrameKind.RESET) {
      if (!this.binding || !Number.isInteger(control.epoch) || control.epoch < this.epoch || (control.wireVersion !== 'axtp' && control.epoch === this.epoch)) return {status: 'stale'};
      this.epoch = control.epoch; this.nextSequence = 0; this.resetPending = control.wireVersion !== 'axtp'; this.activeContacts.clear(); return {status: 'reset'};
    }
    if (!this.binding || control.epoch !== this.epoch) return {status: 'stale'};
    if (control.kind === TouchbackFrameKind.CLOSE) {
      this.activeContacts.clear();
      this.resetPending = true;
      return {status: 'closed'};
    }
    if (control.kind === TouchbackFrameKind.RESET_ACK) {
      if (this.wireVersion === 'axtp' || !this.resetPending) return {status: 'stale'};
      this.resetPending = false; this.nextSequence = 0; return {status: 'accepted'};
    }
    return {status: 'accepted'};
  }

  acceptBindFrame(frame) {
    const binding = decodeTouchbackBindPayload(frame.controlPayload);
    if (!binding) return {status: 'invalid_state'};
    return this.accept({kind: TouchbackFrameKind.BIND, binding: {
      ...binding,
      epoch: frame.epoch,
      streamId: frame.streamId ?? null,
      canvasToken: frame.canvasToken ?? null,
      geometryToken: frame.geometryToken ?? null,
      wireVersion: frame.wireVersion ?? null,
    }});
  }

  acceptBytes(bytes) {
    let frame;
    try { frame = decodeTouchbackFrame(bytes, this.limits); } catch (error) { return {status: 'invalid_state', error}; }
    if (!this.binding || frame.wireVersion !== 'axtp' && frame.kind !== TouchbackFrameKind.BATCH) return {status: 'stale'};
    if (frame.wireVersion === 'axtp') {
      if (frame.streamId !== this.streamId || frame.canvasToken !== this.canvasToken || frame.geometryToken !== this.geometryToken) return {status: 'stale_geometry'};
      if (frame.kind === TouchbackFrameKind.RESET) return this.accept({kind: TouchbackFrameKind.RESET, epoch: frame.epoch, wireVersion: 'axtp'});
      if (frame.kind === TouchbackFrameKind.CLOSE) { this.activeContacts.clear(); this.resetPending = true; return {status: 'closed'}; }
      if (frame.epoch !== this.epoch || this.resetPending) return {status: 'reset_required'};
      if (frame.seqId < this.nextSequence) return {status: 'stale'};
      if (frame.seqId > this.nextSequence) { this.resetPending = true; this.activeContacts.clear(); return {status: 'reset_required'}; }
    } else {
      if (frame.kind !== TouchbackFrameKind.BATCH || frame.epoch !== this.epoch || this.resetPending) return {status: 'reset_required'};
      if (frame.sequence < this.nextSequence) return {status: 'stale'};
      if (frame.sequence > this.nextSequence) { this.resetPending = true; this.activeContacts.clear(); return {status: 'reset_required'}; }
    }
    for (const record of frame.records) {
      if (record.phase === TouchbackPhase.DOWN || record.phase === TouchbackPhase.MOVE) this.activeContacts.set(record.contactId, record);
      else this.activeContacts.delete(record.contactId);
    }
    this.nextSequence += frame.wireVersion === 'axtp' ? 1 : frame.records.length;
    return {status: 'applied', frame};
  }

  fence() { this.resetPending = true; this.activeContacts.clear(); return {status: 'reset_required'}; }
}

export {sameBinding};
