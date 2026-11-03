import {LauncherCompatibleWebCastSender} from './launcher-compatible-sender.mjs';
import {PointerInjectionStatus} from '../touchback/pointer-injection.mjs';
import {TouchbackFrameKind} from '../touchback/codec.mjs';

export class WebCastTouchbackSender {
  constructor({nativeBridge, onStatus, onControlFrame, resolveBinding, limits} = {}) {
    this.onStatus = onStatus ?? (() => {});
    this.pointer = nativeBridge;
    this.receiver = new LauncherCompatibleWebCastSender({
      limits,
      resolveBinding,
      onControlFrame: (frame, result) => {
        if (frame?.kind === TouchbackFrameKind.BIND || frame?.kind === TouchbackFrameKind.RESET || frame?.kind === TouchbackFrameKind.CLOSE || result?.status === 'reset' || result?.status === 'closed') {
          this.generation++;
          this.resetPointer();
        }
        if (frame?.kind === TouchbackFrameKind.BIND && result?.status === 'accepted' && this.authorized) this.onStatus(PointerInjectionStatus.ACCEPTED);
        onControlFrame?.(frame, result);
      },
      onTouchback: frame => this.applyFrame(frame),
    });
    this.authorized = false;
    this.protocol = 'webcast';
    this.generation = 0;
    this._frameQueue = Promise.resolve();
    this._resetBarrier = Promise.resolve();
    this._initialization = null;
    this._pendingControlMessages = [];
    this._nativeReady = false;
    this._lastInjectionStatus = 'idle';
    this._injectionCount = 0;
    this._lastInjectionFailure = null;
  }
  resetPointer() {
    let result;
    try { result = this.pointer.reset(); } catch { result = PointerInjectionStatus.INVALID_STATE; }
    this._resetBarrier = Promise.resolve(result);
    return result;
  }
  attachControlChannel(channel, {authorized = false, protocol = 'webcast'} = {}) {
    this.fence(); const generation = this.generation;
    if (protocol !== 'webcast' || !authorized) { this.authorized = false; this.onStatus('not_supported'); return false; }
    this.receiver.attachControlChannel(channel);
    const finish = status => {
      if (generation !== this.generation) return false;
      this.onStatus(status === PointerInjectionStatus.ACCEPTED ? 'native_ready' : status);
      this._nativeReady = status === PointerInjectionStatus.ACCEPTED;
      this.authorized = status === PointerInjectionStatus.ACCEPTED;
      return this.authorized;
    };
    const status = this.pointer.initialize();
    if (!status || typeof status.then !== 'function') return finish(status);
    const initialization = Promise.resolve(status).then(finish).then(ready => {
      if (ready && this._initialization === initialization) {
        const pending = this._pendingControlMessages.splice(0);
        for (const message of pending) this.handleControlMessage(message);
      } else if (!ready) this._pendingControlMessages = [];
      return ready;
    }).finally(() => { if (this._initialization === initialization) this._initialization = null; });
    this._initialization = initialization;
    return initialization;
  }
  handleControlMessage(message) {
    if (!this.authorized) {
      if (this._initialization) { this._pendingControlMessages.push(message); return {status: 'pending'}; }
      return {status: 'not_supported'};
    }
    const result = this.receiver.handleControlMessage(message);
    if (result?.status === 'reset_required' || result?.status === 'invalid_state') {
      this.generation++;
      this.resetPointer();
      if (result.status === 'invalid_state') this.authorized = false;
    }
    return result;
  }
  applyFrame(frame) {
    if (!this.authorized) return {status: 'not_supported'};
    const generation = this.generation;
    const run = () => this._applyFrameNow(frame, generation);
    const result = this._frameQueue.then(run, run);
    this._frameQueue = result.catch(() => {});
    return result;
  }
  _applyFrameNow(frame, generation) {
    const records = frame?.records ?? [];
    if (records.length > 0 && typeof this.pointer.applyBatch === 'function') {
      return Promise.resolve(this._resetBarrier).then(() => {
        if (!this.authorized || generation !== this.generation) return {status: 'stale'};
        const result = this.pointer.applyBatch(records);
        const finish = status => { this._lastInjectionStatus = status; if (status !== PointerInjectionStatus.ACCEPTED) { this._lastInjectionFailure = this.pointer.snapshot?.().lastFailure ?? {kind: 'unknown'}; this.authorized = false; this.resetPointer(); this.onStatus(status); return {status}; } this._injectionCount += records.length; return {status: 'applied'}; };
        return result && typeof result.then === 'function' ? result.then(finish) : finish(result);
      });
    }
    const applyAt = index => {
      if (!this.authorized || generation !== this.generation) return {status: 'stale'};
      for (let i = index; i < records.length; i += 1) {
        const result = this.pointer.apply(records[i]);
        if (result && typeof result.then === 'function') {
          return result.then(status => {
            if (generation !== this.generation) return {status: 'stale'};
            this._lastInjectionStatus = status;
            if (status !== PointerInjectionStatus.ACCEPTED) { this._lastInjectionFailure = this.pointer.snapshot?.().lastFailure ?? {kind: 'unknown'}; this.authorized = false; this.resetPointer(); this.onStatus(status); return {status}; }
            this._injectionCount += 1;
            return applyAt(i + 1);
          });
        }
        this._lastInjectionStatus = result;
        if (result !== PointerInjectionStatus.ACCEPTED) { this._lastInjectionFailure = this.pointer.snapshot?.().lastFailure ?? {kind: 'unknown'}; this.authorized = false; this.resetPointer(); this.onStatus(result); return {status: result}; }
        this._injectionCount += 1;
      }
      return {status: 'applied'};
    };
    return Promise.resolve(this._resetBarrier).then(() => applyAt(0));
  }
  fence() { this.generation++; this.authorized = false; this._nativeReady = false; this._initialization = null; this._pendingControlMessages = []; this.resetPointer(); this.receiver.control = null; return this.receiver.fence(); }
  diagnostics() {
    return {
      controlChannelReady: this.receiver.control?.readyState === 'open',
      nativeReady: this._nativeReady,
      bindingReady: Boolean(this.receiver.session.binding),
      // The sender cannot observe the receiver's UI switch over the wire.
      // A BIND proves protocol state only, so this intentionally remains null.
      receiverEnabled: null,
      injectionCount: this._injectionCount,
      lastInjectionStatus: this._lastInjectionStatus,
      lastInjectionFailure: this._lastInjectionFailure,
    };
  }
  snapshot() { return {...this.receiver.snapshot(), pointer: this.pointer.snapshot(), authorized: this.authorized}; }
}
