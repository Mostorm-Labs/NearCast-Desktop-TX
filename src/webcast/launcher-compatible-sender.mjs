import {decodeTouchbackFrame, encodeTouchbackFrame, TouchbackFrameKind} from '../touchback/codec.mjs';
import {TouchbackSession} from '../touchback/session.mjs';

export class LauncherCompatibleWebCastSender {
  constructor({onTouchback, onControlFrame, resolveBinding, limits = {maxBytes: 1024 * 1024, maxRecords: 1024}} = {}) {
    this.onTouchback = onTouchback ?? (() => {});
    this.onControlFrame = onControlFrame ?? (() => {});
    this.resolveBinding = resolveBinding ?? (() => null);
    this.session = new TouchbackSession(limits);
    this.control = null;
    this.sendSequence = 0;
    this.controlRequestSequence = 0;
    this.pendingControlRequests = new Map();
    this.stats = {binaryRejected: 0, binaryAccepted: 0, textAccepted: 0};
    this.streamState = 'unavailable';
    this.stream = null;
  }
  attachControlChannel(channel) {
    if (!channel || channel.readyState !== 'open') throw new Error('control channel is not open');
    this.control = channel;
  }
  configureStream({streamId, epoch, canvasToken = 0, geometryToken = 0, binding = {}} = {}) {
    if (!Number.isInteger(streamId) || streamId <= 0 || !Number.isInteger(epoch) || epoch < 0 || !Number.isInteger(canvasToken) || canvasToken < 0 || !Number.isInteger(geometryToken) || geometryToken < 0) return false;
    this.sendSequence = 0;
    const result = this.session.accept({kind: TouchbackFrameKind.BIND, binding: {
      ...binding, streamId, epoch, canvasToken, geometryToken, wireVersion: 'axtp',
      bindingToken: binding.bindingToken ?? `axtp:${streamId}:${epoch}`,
    }});
    if (result.status !== 'accepted') return false;
    this.stream = {streamId, epoch, canvasToken, geometryToken, acceptedMode: binding.acceptedMode ?? null, format: binding.format ?? 'touch-batch-v1', revision: binding.revision ?? null, binding: {...binding}};
    this.streamState = 'bound';
    this.onControlFrame({kind: TouchbackFrameKind.BIND, wireVersion: 'axtp', streamId, epoch, canvasToken, geometryToken}, result);
    return true;
  }
  requestControl(method, params = {}) {
    if (!this.control || this.control.readyState !== 'open' || typeof method !== 'string' || !method) return Promise.reject(new Error('control channel is not open'));
    const id = `axtp-${Date.now().toString(36)}-${(++this.controlRequestSequence).toString(36)}`;
    const request = {action: 'axtp-control', id, method, params};
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingControlRequests.delete(id); reject(new Error(`Control request timed out: ${method}`)); }, 8000);
      this.pendingControlRequests.set(id, {resolve, reject, timer});
      try { this.control.send(JSON.stringify(request)); } catch (error) { clearTimeout(timer); this.pendingControlRequests.delete(id); reject(error); }
    });
  }
  getControlCapabilities(params = {}) { return this.requestControl('cast.getControlCapabilities', params); }
  getTouchbackState(params = {}) { return this.requestControl('cast.getTouchbackState', params); }
  setTouchbackEnabled(params = {}) { return this.requestControl('cast.setTouchbackEnabled', params); }
  setTouchbackMode(params = {}) { return this.requestControl('cast.setTouchbackMode', params); }
  setTouchbackResolutionPreference(params = {}) { return this.requestControl('cast.setTouchbackResolutionPreference', params); }
  async openTouchbackStream(params = {}) {
    throw new Error('Sender does not initiate input.openStream; wait for the receiver control result');
  }
  closeTouchbackStream(params = {}) { return this.requestControl('input.closeStream', {streamKind: 'touchback', ...params}); }
  sendControlResponse(id, method, result, error) {
    if (!this.control || this.control.readyState !== 'open' || typeof id !== 'string' || !id || typeof method !== 'string' || !method) return false;
    const response = {action: 'axtp-control', id, method};
    if (error) response.error = error;
    else response.result = result;
    try { this.control.send(JSON.stringify(response)); return true; } catch { return false; }
  }
  controlError(id, method, code, message) {
    this.sendControlResponse(id, method, undefined, {code, message});
    return {status: 'invalid_state', error: new Error(message)};
  }
  handleReceiverControlRequest(control) {
    const id = control?.id;
    const method = control?.method;
    const params = control?.params;
    if (typeof id !== 'string' || !id || typeof method !== 'string' || !method || !params || typeof params !== 'object') return {status: 'invalid_state'};
    if (method === 'input.openStream') {
      const result = {...params, accepted: params.accepted !== false};
      const opened = this.acceptOpenStreamResult(result);
      if (!opened) return this.controlError(id, method, 'INVALID_STATE', 'input.openStream does not match the current BIND or is incomplete');
      this.sendControlResponse(id, method, result);
      return {status: 'stream_opened'};
    }
    if (method === 'input.closeStream') {
      const stream = this.stream;
      if (!stream || !Number.isInteger(params.streamId) || !Number.isInteger(params.epoch) || params.streamId !== stream.streamId || params.epoch !== stream.epoch) return this.controlError(id, method, 'INVALID_STATE', 'input.closeStream does not match the current BIND');
      const result = this.session.accept({kind: TouchbackFrameKind.CLOSE, epoch: params.epoch});
      if (result.status !== 'closed') return this.controlError(id, method, 'INVALID_STATE', 'input.closeStream rejected by the current session');
      this.streamState = 'bound';
      this.stream = {...stream, acceptedMode: null};
      const response = {streamId: params.streamId, epoch: params.epoch, closed: true, alreadyClosed: false};
      this.sendControlResponse(id, method, response);
      this.onControlFrame({kind: method, wireVersion: 'control', ...response}, {status: 'closed'});
      return {status: 'stream_closed'};
    }
    return this.controlError(id, method, 'NOT_SUPPORTED', `Unsupported control method: ${method}`);
  }
  handleControlMessage(message) {
    if (!this.control || this.control.readyState !== 'open') return {status: 'stale'};
    if (typeof message?.data === 'string') {
      this.stats.textAccepted += 1;
      try {
        const control = JSON.parse(message.data);
        if (control?.action === 'axtp-control' && Object.hasOwn(control, 'params') && !Object.hasOwn(control, 'result') && !Object.hasOwn(control, 'error')) return this.handleReceiverControlRequest(control);
        const result = control?.result ?? control?.params ?? control;
        const method = control?.method ?? control?.type ?? control?.action;
        if (control?.id && this.pendingControlRequests.has(control.id) && Object.hasOwn(control, 'result')) {
          const pending = this.pendingControlRequests.get(control.id); this.pendingControlRequests.delete(control.id); clearTimeout(pending.timer);
          if (control.error) pending.reject(new Error(control.error.message || String(control.error))); else pending.resolve(control.result);
          return {status: 'control_response'};
        }
        if (method === 'input.openStream') {
          const opened = this.acceptOpenStreamResult(result);
          return opened ? {status: 'stream_opened'} : {status: 'invalid_state'};
        }
        if (method === 'input.closeStream' && Number.isInteger(result?.streamId) && result.closed !== false) {
          if (this.session.streamId === result.streamId && this.session.epoch === result.epoch) this.session.accept({kind: TouchbackFrameKind.CLOSE, epoch: result.epoch});
          this.streamState = 'bound';
          if (this.stream) this.stream = {...this.stream, acceptedMode: null};
          return {status: 'stream_closed'};
        }
        if ((method === 'cast.touchbackChanged' || method === 'cast.touchback.changed') && result?.effectiveEnabled === true) {
          const stream = result.stream ?? result.inputStream ?? result.touchback?.stream;
          if (stream && Number.isInteger(stream.streamId) && Number.isInteger(stream.epoch)) {
            return this.acceptOpenStreamResult({...stream, accepted: true, acceptedMode: stream.acceptedMode ?? stream.mode, format: stream.format ?? 'touch-batch-v1', revision: stream.revision}) ? {status: 'stream_opened'} : {status: 'invalid_state'};
          }
        }
      } catch {}
      return {status: 'text'};
    }
    try {
      const frame = decodeTouchbackFrame(message?.data, this.session.limits);
      if (frame.wireVersion === 'axtp' && frame.kind !== TouchbackFrameKind.BATCH) {
        const result = this.handleControlFrame(frame);
        if (result.status === 'invalid_state' || result.status === 'stale') this.stats.binaryRejected += 1;
        else this.stats.binaryAccepted += 1;
        return result;
      }
      if (frame.wireVersion === 'axtp') {
        if (this.streamState !== 'active') {
          this.stats.binaryRejected += 1;
          this.requestReset();
          return {status: 'reset_required'};
        }
        const result = this.session.acceptBytes(message.data);
        if (result.status === 'applied' || result.status === 'closed' || result.status === 'reset') {
          this.stats.binaryAccepted += 1;
          if (result.status === 'applied') this.onTouchback(result.frame);
        } else {
          this.stats.binaryRejected += 1;
          if (result.status === 'reset_required') this.requestReset();
        }
        return result;
      }
      if (frame.kind !== TouchbackFrameKind.BATCH) {
        const result = this.handleControlFrame(frame);
        if (result.status === 'invalid_state' || result.status === 'stale') this.stats.binaryRejected += 1;
        else this.stats.binaryAccepted += 1;
        return result;
      }
      if (this.streamState !== 'active') {
        this.stats.binaryRejected += 1;
        this.requestReset();
        return {status: 'reset_required'};
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
    const result = this.session.accept({kind: TouchbackFrameKind.RESET, epoch, wireVersion: this.session.wireVersion});
    if (result.status !== 'reset') return false;
    const modern = this.session.wireVersion === 'axtp';
    const bytes = encodeTouchbackFrame(modern ? {
      wireVersion: 'axtp', streamId: this.session.streamId, seqId: this.sendSequence++, cursor: BigInt(Date.now()) * 1000n,
      kind: TouchbackFrameKind.RESET, epoch, canvasToken: this.session.canvasToken, geometryToken: this.session.geometryToken,
    } : {kind: TouchbackFrameKind.RESET, epoch, sequence: 0}, this.session.limits);
    if (!bytes) return false;
    this.lastResetEpoch = epoch;
    this.control.send(bytes);
    return true;
  }
  handleControlFrame(frame) {
    if (frame.kind === TouchbackFrameKind.CAPABILITY) {
      const result = {status: 'accepted'};
      this.onControlFrame(frame, result);
      return result;
    }
    if (!this.session.binding && frame.kind !== TouchbackFrameKind.BIND) return {status: 'stale'};
    if (frame.kind === TouchbackFrameKind.BIND) {
      const binding = this.resolveBinding(frame);
      const result = binding ? this.session.accept({kind: TouchbackFrameKind.BIND, binding: {...binding, epoch: frame.epoch, streamId: frame.streamId, canvasToken: frame.canvasToken, geometryToken: frame.geometryToken, wireVersion: frame.wireVersion}}) : this.session.acceptBindFrame(frame);
      if (result.status === 'accepted') {
        this.streamState = 'bound';
        this.stream = {streamId: frame.streamId, epoch: frame.epoch, canvasToken: frame.canvasToken, geometryToken: frame.geometryToken, acceptedMode: null, format: null, revision: null, binding: binding ?? this.session.binding};
      }
      this.onControlFrame(frame, result);
      return result;
    }
    if (frame.kind === TouchbackFrameKind.RESET || frame.kind === TouchbackFrameKind.RESET_ACK) {
      const result = this.session.accept({kind: frame.kind, epoch: frame.epoch, wireVersion: frame.wireVersion});
      if (frame.kind === TouchbackFrameKind.RESET && result.status === 'reset') this.streamState = 'bound';
      this.onControlFrame(frame, result);
      if (frame.wireVersion !== 'axtp' && frame.kind === TouchbackFrameKind.RESET && result.status === 'reset' && this.control.readyState === 'open') {
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
  acceptOpenStreamResult(result) {
    if (!result || result.accepted !== true || result.format !== 'touch-batch-v1' || !['touch', 'mouse'].includes(result.acceptedMode) || typeof result.revision !== 'string' || !result.revision.trim()) return false;
    if (!Number.isInteger(result.streamId) || result.streamId <= 0 || !Number.isInteger(result.epoch) || result.epoch < 0 || !Number.isInteger(result.canvasToken) || result.canvasToken < 0 || !Number.isInteger(result.geometryToken) || result.geometryToken < 0) return false;
    const bound = this.stream;
    if (!bound || (bound.streamId != null && bound.streamId !== result.streamId) || (bound.epoch != null && bound.epoch !== result.epoch) || (bound.canvasToken != null && bound.canvasToken !== result.canvasToken) || (bound.geometryToken != null && bound.geometryToken !== result.geometryToken)) return false;
    this.session.streamId = result.streamId;
    this.session.epoch = result.epoch;
    this.session.canvasToken = result.canvasToken;
    this.session.geometryToken = result.geometryToken;
    this.session.wireVersion = 'axtp';
    this.session.resetPending = false;
    this.session.nextSequence = 0;
    this.stream = {...bound, acceptedMode: result.acceptedMode, format: result.format, revision: result.revision, limits: {maxBatchEvents: result.maxBatchEvents, maxFrameBytes: result.maxFrameBytes, maxContacts: result.maxContacts}};
    this.streamState = 'active';
    this.onControlFrame({kind: 'input.openStream', wireVersion: 'control', ...result}, {status: 'active', stream: this.stream});
    return true;
  }
  fence() { return this.session.fence(); }
  snapshot() { return {...this.stats, activeContacts: this.session.activeContacts.size, streamState: this.streamState, stream: this.stream ? {...this.stream} : null}; }
}
