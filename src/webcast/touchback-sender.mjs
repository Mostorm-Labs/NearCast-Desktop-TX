import {LauncherCompatibleWebCastSender} from './launcher-compatible-sender.mjs';
import {PointerInjectionStatus} from '../touchback/pointer-injection.mjs';

export class WebCastTouchbackSender {
  constructor({nativeBridge, onStatus, onControlFrame, resolveBinding, limits} = {}) {
    this.onStatus = onStatus ?? (() => {});
    this.pointer = nativeBridge;
    this.receiver = new LauncherCompatibleWebCastSender({limits, resolveBinding, onControlFrame, onTouchback: frame => this.applyFrame(frame)});
    this.authorized = false;
    this.protocol = 'webcast';
  }
  attachControlChannel(channel, {authorized = false, protocol = 'webcast'} = {}) {
    if (protocol !== 'webcast' || !authorized) { this.authorized = false; this.onStatus('not_supported'); return false; }
    this.receiver.attachControlChannel(channel);
    this.authorized = true;
    const status = this.pointer.initialize();
    this.onStatus(status);
    if (status !== PointerInjectionStatus.ACCEPTED) this.authorized = false;
    return this.authorized;
  }
  handleControlMessage(message) {
    if (!this.authorized) return {status: 'not_supported'};
    return this.receiver.handleControlMessage(message);
  }
  applyFrame(frame) {
    if (!this.authorized) return {status: 'not_supported'};
    for (const record of frame.records) {
      const status = this.pointer.apply(record);
      if (status !== PointerInjectionStatus.ACCEPTED) { this.pointer.reset(); this.onStatus(status); return {status}; }
    }
    return {status: 'applied'};
  }
  fence() { this.pointer.reset(); return this.receiver.fence(); }
  snapshot() { return {...this.receiver.snapshot(), pointer: this.pointer.snapshot(), authorized: this.authorized}; }
}
