import {decodeTouchbackFrame, encodeTouchbackFrame, TouchbackFrameKind} from '../touchback/codec.mjs';
import {TouchbackSession} from '../touchback/session.mjs';

export class LauncherCompatibleWebCastSender {
  constructor({onTouchback, onControlFrame, resolveBinding, limits = {maxBytes: 1024 * 1024, maxRecords: 64}} = {}) {
    this.onTouchback = onTouchback ?? (() => {});
    this.onControlFrame = onControlFrame ?? (() => {});
    this.resolveBinding = resolveBinding ?? (() => null);
    this.session = new TouchbackSession(limits);
    this.control = null;
    this.stats = {binaryRejected: 0, binaryAccepted: 0, textAccepted: 0};
  }
  attachControlChannel(channel) {
    if (!channel || channel.readyState !== 'open') throw new Error('control channel is not open');
    this.control = channel;
  }
  handleControlMessage(message) {
    if (!this.control || this.control.readyState !== 'open') return {status: 'stale'};
    if (typeof message?.data === 'string') { this.stats.textAccepted += 1; return {status: 'text'}; }
    try {
      const frame = decodeTouchbackFrame(message?.data, this.session.limits);
      if (frame.kind !== TouchbackFrameKind.BATCH) {
        const result = this.handleControlFrame(frame);
        if (result.status === 'invalid_state' || result.status === 'stale') this.stats.binaryRejected += 1;
        else this.stats.binaryAccepted += 1;
        return result;
      }
      const result = this.session.acceptBytes(message.data);
      if (result.status === 'applied') { this.stats.binaryAccepted += 1; this.onTouchback(result.frame); }
      else {
        this.stats.binaryRejected += 1;
        if (result.status === 'reset_required') this.requestReset();
      }
      return result;
    } catch (error) { this.stats.binaryRejected += 1; return {status: 'invalid_state', error}; }
  }
  requestReset() {
    if (!this.control || this.control.readyState !== 'open' || !Number.isInteger(this.session.epoch) || this.session.epoch >= 0xffffffff || this.session.resetPending && this.session.epoch === this.lastResetEpoch) return false;
    const epoch = this.session.epoch + 1;
    const result = this.session.accept({kind: TouchbackFrameKind.RESET, epoch});
    if (result.status !== 'reset') return false;
    const bytes = encodeTouchbackFrame({kind: TouchbackFrameKind.RESET, epoch, sequence: 0}, this.session.limits);
    if (!bytes) return false;
    this.lastResetEpoch = epoch;
    this.control.send(bytes);
    return true;
  }
  handleControlFrame(frame) {
    if (!this.session.binding && frame.kind !== TouchbackFrameKind.BIND) return {status: 'stale'};
    if (frame.kind === TouchbackFrameKind.BIND) {
      const binding = this.resolveBinding(frame);
      const result = binding ? this.session.accept({kind: TouchbackFrameKind.BIND, binding: {...binding, epoch: frame.epoch}}) : this.session.acceptBindFrame(frame);
      this.onControlFrame(frame, result);
      return result;
    }
    if (frame.kind === TouchbackFrameKind.RESET || frame.kind === TouchbackFrameKind.RESET_ACK) {
      const result = this.session.accept({kind: frame.kind, epoch: frame.epoch});
      this.onControlFrame(frame, result);
      if (frame.kind === TouchbackFrameKind.RESET && result.status === 'reset' && this.control.readyState === 'open') {
        const ack = encodeTouchbackFrame({kind: TouchbackFrameKind.RESET_ACK, epoch: frame.epoch, sequence: frame.sequence}, this.session.limits);
        if (ack) this.control.send(ack);
      }
      return result;
    }
    if (frame.kind === TouchbackFrameKind.CAPABILITY || frame.kind === TouchbackFrameKind.ACK) {
      const result = this.session.accept({kind: frame.kind, epoch: frame.epoch});
      this.onControlFrame(frame, result);
      return result;
    }
    const result = this.session.accept({kind: frame.kind, epoch: frame.epoch});
    this.onControlFrame(frame, result);
    return result;
  }
  fence() { return this.session.fence(); }
  snapshot() { return {...this.stats, activeContacts: this.session.activeContacts.size}; }
}
