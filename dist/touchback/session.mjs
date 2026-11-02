import {TouchbackFrameKind, TouchbackPhase, decodeTouchbackFrame, decodeTouchbackBindPayload} from './codec.mjs';

const sameBinding = (a, b) => a && b && a.runtimeInstanceId === b.runtimeInstanceId && a.sessionId === b.sessionId && a.sessionGeneration === b.sessionGeneration &&
  a.slotId === b.slotId && a.bindingGeneration === b.bindingGeneration && a.lifecycleGeneration === b.lifecycleGeneration && a.bindingToken === b.bindingToken;

export class TouchbackSession {
  constructor(limits = {}) {
    this.limits = limits;
    this.binding = null;
    this.epoch = null;
    this.nextSequence = 0;
    this.resetPending = false;
    this.activeContacts = new Map();
  }

  accept(control) {
    if (!control || !Number.isInteger(control.kind)) return {status: 'invalid_state'};
    if (control.kind === TouchbackFrameKind.BIND) {
      if (!control.binding?.bindingToken) return {status: 'invalid_state'};
      this.binding = {...control.binding}; this.epoch = control.binding.epoch ?? 0; this.nextSequence = 0; this.resetPending = false; this.activeContacts.clear();
      return {status: 'accepted'};
    }
    if (control.kind === TouchbackFrameKind.RESET) {
      if (!this.binding || !Number.isInteger(control.epoch) || control.epoch <= this.epoch) return {status: 'stale'};
      this.epoch = control.epoch; this.nextSequence = 0; this.resetPending = true; this.activeContacts.clear(); return {status: 'reset'};
    }
    if (!this.binding || control.epoch !== this.epoch) return {status: 'stale'};
    if (control.kind === TouchbackFrameKind.RESET_ACK) {
      if (!this.resetPending) return {status: 'stale'};
      this.resetPending = false; this.nextSequence = 0; return {status: 'accepted'};
    }
    return {status: 'accepted'};
  }

  acceptBindFrame(frame) {
    const binding = decodeTouchbackBindPayload(frame.controlPayload);
    if (!binding) return {status: 'invalid_state'};
    return this.accept({kind: TouchbackFrameKind.BIND, binding: {...binding, epoch: frame.epoch}});
  }

  acceptBytes(bytes) {
    let frame;
    try { frame = decodeTouchbackFrame(bytes, this.limits); } catch (error) { return {status: 'invalid_state', error}; }
    if (!this.binding || frame.kind !== TouchbackFrameKind.BATCH || frame.epoch !== this.epoch) return {status: 'stale'};
    if (this.resetPending) return {status: 'reset_required'};
    if (frame.sequence < this.nextSequence) return {status: 'stale'};
    if (frame.sequence > this.nextSequence) { this.resetPending = true; this.activeContacts.clear(); return {status: 'reset_required'}; }
    for (const record of frame.records) {
      if (record.phase === TouchbackPhase.DOWN || record.phase === TouchbackPhase.MOVE) this.activeContacts.set(record.contactId, record);
      else this.activeContacts.delete(record.contactId);
    }
    this.nextSequence += frame.records.length;
    return {status: 'applied', frame};
  }

  fence() { this.resetPending = true; this.activeContacts.clear(); return {status: 'reset_required'}; }
}

export {sameBinding};

