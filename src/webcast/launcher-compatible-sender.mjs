import {
  decodeTouchbackFrame,
  encodeTouchbackFrame,
  TouchbackFrameKind,
  decodeTouchbackBindPayload,
} from '../touchback/codec.mjs';
import { TouchbackSession, sameBinding } from '../touchback/session.mjs';

const uint32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;
const stable = (v) =>
  JSON.stringify(
    v && typeof v === 'object'
      ? Array.isArray(v)
        ? v.map((x) => JSON.parse(stable(x)))
        : Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, JSON.parse(stable(v[k]))]),
          )
      : v,
  );
const targetFields = [
  'sessionId',
  'sessionGeneration',
  'slotId',
  'bindingGeneration',
  'lifecycleGeneration',
];

export class LauncherCompatibleWebCastSender {
  constructor({
    onTouchback,
    onControlFrame,
    supportedModes = ['touch'],
    limits = {},
  } = {}) {
    this.onTouchback = onTouchback ?? (() => {});
    this.onControlFrame = onControlFrame ?? (() => {});
    this.supportedModes = supportedModes.filter((m) =>
      ['touch', 'mouse'].includes(m),
    );
    this.localLimits = {
      maxBytes: 65579,
      maxRecords: 1024,
      maxContacts: 10,
      ...limits,
    };
    this.session = new TouchbackSession({ ...this.localLimits });
    this.control = null;
    this.sendSequence = 0;
    this.controlRequestSequence = 0;
    this.pendingControlRequests = new Map();
    this.commands = new Map();
    this.revision = 0;
    this.stats = { binaryRejected: 0, binaryAccepted: 0, textAccepted: 0 };
    this.streamState = 'unavailable';
    this.stream = null;
    this.openedEpoch = null;
    this.closedEpoch = null;
    this.awaitingClose = false;
  }
  attachControlChannel(channel) {
    if (channel?.readyState !== 'open')
      throw new Error('control channel is not open');
    this.control = channel;
  }
  requestControl(method, params = {}) {
    if (this.control?.readyState !== 'open' || !text(method))
      return Promise.reject(new Error('control channel is not open'));
    const id = `axtp-${Date.now().toString(36)}-${(++this.controlRequestSequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControlRequests.delete(id);
        reject(new Error(`Control request timed out: ${method}`));
      }, 8000);
      this.pendingControlRequests.set(id, { resolve, reject, timer, method });
      try {
        this.control.send(
          JSON.stringify({ action: 'axtp-control', id, method, params }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pendingControlRequests.delete(id);
        reject(error);
      }
    });
  }
  getControlCapabilities(p = {}) {
    return this.requestControl('cast.getControlCapabilities', p);
  }
  getTouchbackState(p = {}) {
    return this.requestControl('cast.getTouchbackState', p);
  }
  setTouchbackEnabled(p = {}) {
    return this.requestControl('cast.setTouchbackEnabled', p);
  }
  setTouchbackMode(p = {}) {
    return this.requestControl('cast.setTouchbackMode', p);
  }
  setTouchbackResolutionPreference(p = {}) {
    return this.requestControl('cast.setTouchbackResolutionPreference', p);
  }
  async openTouchbackStream() {
    throw new Error('Receiver owns input.openStream');
  }
  sendControlResponse(id, method, result, error) {
    if (this.control?.readyState !== 'open') return false;
    try {
      this.control.send(
        JSON.stringify({
          action: 'axtp-control',
          id,
          method,
          ...(error ? { error } : { result }),
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
  controlError(id, method, code, message) {
    this.sendControlResponse(id, method, undefined, { code, message });
    return { status: 'control_rejected', error: new Error(message) };
  }
  matchesTarget(p) {
    const b = this.session.binding;
    return (
      b &&
      p.controlVersion === 1 &&
      p.runtimeInstanceId === b.runtimeInstanceId &&
      p.streamKind === 'touchback' &&
      targetFields.every(
        (k) =>
          typeof p.target?.[k] === 'string' && p.target[k] === String(b[k]),
      )
    );
  }
  handleReceiverControlRequest({ id, method, params: p }) {
    const reject = (code, reason) =>
      this.controlError(id, method, code, reason);
    if (!p || typeof p !== 'object' || Array.isArray(p) || !text(p.commandId))
      return reject('INVALID_ARGUMENT', 'Missing commandId or request params');
    if (!this.matchesTarget(p))
      return reject(
        'INVALID_STATE',
        'Request does not match the current BIND target/runtime fence',
      );
    for (const [key, entry] of this.commands)
      if (Date.now() - entry.time > 300000) this.commands.delete(key);
    const fingerprint = stable({ method, params: p }),
      cached = this.commands.get(p.commandId);
    if (cached) {
      if (cached.fingerprint !== fingerprint)
        return reject('INVALID_ARGUMENT', 'Conflicting commandId reuse');
      if (
        cached.result.epoch !== this.session.epoch ||
        (method === 'input.openStream' && this.streamState !== 'active')
      )
        return reject(
          'INVALID_STATE',
          'Command belongs to a retired stream epoch',
        );
      this.sendControlResponse(id, method, cached.result);
      return {
        status:
          method === 'input.openStream' ? 'stream_opened' : 'stream_closed',
        replayed: true,
      };
    }
    if (this.commands.size >= 256)
      return reject('BUSY', 'Command replay window is full');
    let result;
    if (method === 'input.openStream') {
      if (
        p.format !== 'touch-batch-v1' ||
        !Array.isArray(p.supportedModes) ||
        !p.supportedModes.length ||
        p.supportedModes.some((m) => !['touch', 'mouse'].includes(m)) ||
        !['touch', 'mouse'].includes(p.preferredMode ?? 'touch') ||
        !['preferred', 'required'].includes(p.modeRequirement ?? 'preferred') ||
        !text(p.canvasRevision) ||
        !text(p.geometryRevision)
      )
        return reject(
          'INVALID_ARGUMENT',
          'Invalid input stream format, mode, or revisions',
        );
      if (
        !uint32(p.canvasToken) ||
        !uint32(p.geometryToken) ||
        p.canvasToken !== this.session.canvasToken ||
        p.geometryToken !== this.session.geometryToken
      )
        return reject('INVALID_STATE', 'Geometry tokens do not match BIND');
      if (
        [
          ['maxBatchEvents', 65535, 1],
          ['maxFrameBytes', 0xffffffff, 44],
          ['maxContacts', 65535, 1],
        ].some(
          ([k, max, min]) =>
            p[k] !== undefined &&
            (!Number.isInteger(p[k]) || p[k] < min || p[k] > max),
        )
      )
        return reject('INVALID_ARGUMENT', 'Invalid stream limits');
      const common = this.supportedModes.filter((m) =>
          p.supportedModes.includes(m),
        ),
        preferred = p.preferredMode ?? 'touch';
      const acceptedMode = common.includes(preferred)
        ? preferred
        : (p.modeRequirement ?? 'preferred') === 'preferred'
          ? common[0]
          : null;
      if (!acceptedMode)
        return reject(
          'NOT_SUPPORTED',
          'Requested input mode is not supported by this sender',
        );
      if (
        this.awaitingClose ||
        this.streamState === 'active' ||
        (this.openedEpoch !== null && this.session.epoch <= this.openedEpoch)
      )
        return reject(
          'INVALID_STATE',
          'Reset and close the old stream before opening a new epoch',
        );
      const maxFrameBytes = Math.min(
        p.maxFrameBytes ?? this.localLimits.maxBytes,
        this.localLimits.maxBytes,
        65579,
      );
      const maxBatchEvents = Math.min(
        p.maxBatchEvents ?? 1024,
        this.localLimits.maxRecords,
        Math.floor((maxFrameBytes - 44) / 16),
      );
      if (maxBatchEvents < 1)
        return reject(
          'INVALID_ARGUMENT',
          'Frame limit cannot hold an input record',
        );
      result = {
        accepted: true,
        streamId: this.session.streamId,
        epoch: this.session.epoch,
        acceptedMode,
        format: 'touch-batch-v1',
        canvasToken: p.canvasToken,
        geometryToken: p.geometryToken,
        maxBatchEvents,
        maxFrameBytes,
        maxContacts: Math.min(
          p.maxContacts ?? this.localLimits.maxContacts,
          this.localLimits.maxContacts,
        ),
        revision: String(++this.revision),
      };
      this.session.limits = {
        maxBytes: maxFrameBytes,
        maxRecords: maxBatchEvents,
        maxContacts: result.maxContacts,
      };
      this.session.resetPending = false;
      this.session.nextSequence = 0;
      this.stream = {
        ...result,
        binding: { ...this.session.binding },
        target: { ...p.target },
        canvasRevision: p.canvasRevision,
        geometryRevision: p.geometryRevision,
      };
      this.streamState = 'active';
      this.openedEpoch = result.epoch;
      this.closedEpoch = null;
      this.onControlFrame(
        { kind: 'input.openStream', wireVersion: 'control', ...result },
        { status: 'active', stream: this.stream },
      );
    } else if (method === 'input.closeStream') {
      if (
        !uint32(p.streamId) ||
        p.streamId !== this.session.streamId ||
        !uint32(p.epoch) ||
        p.epoch !== this.session.epoch
      )
        return reject(
          'INVALID_STATE',
          'Close does not match the current stream/epoch',
        );
      const alreadyClosed = this.closedEpoch === p.epoch;
      if (!alreadyClosed) {
        this.session.accept({ kind: TouchbackFrameKind.CLOSE, epoch: p.epoch });
        this.streamState = 'bound';
        this.closedEpoch = p.epoch;
        this.awaitingClose = false;
        this.stream = { ...this.stream, epoch: p.epoch, acceptedMode: null };
        this.revision++;
        this.onControlFrame(
          {
            kind: 'input.closeStream',
            wireVersion: 'control',
            streamId: p.streamId,
            epoch: p.epoch,
          },
          { status: 'closed' },
        );
      }
      result = {
        streamId: p.streamId,
        epoch: p.epoch,
        closed: true,
        alreadyClosed,
        revision: String(this.revision),
      };
    } else
      return reject('NOT_SUPPORTED', 'Unsupported receiver control method');
    this.commands.set(p.commandId, {
      fingerprint,
      result: { ...result },
      time: Date.now(),
    });
    this.sendControlResponse(id, method, result);
    return {
      status: method === 'input.openStream' ? 'stream_opened' : 'stream_closed',
    };
  }
  handleControlMessage(message) {
    if (this.control?.readyState !== 'open') return { status: 'stale' };
    if (typeof message?.data === 'string') {
      this.stats.textAccepted++;
      try {
        const c = JSON.parse(message.data);
        if (c?.action !== 'axtp-control') return { status: 'text' };
        if (
          text(c.id) &&
          text(c.method) &&
          Object.hasOwn(c, 'params') &&
          !Object.hasOwn(c, 'result') &&
          !Object.hasOwn(c, 'error')
        )
          return this.handleReceiverControlRequest(c);
        const pending = this.pendingControlRequests.get(c.id);
        if (
          pending &&
          c.method === pending.method &&
          (Object.hasOwn(c, 'result') || Object.hasOwn(c, 'error'))
        ) {
          this.pendingControlRequests.delete(c.id);
          clearTimeout(pending.timer);
          if (c.error)
            pending.reject(new Error(c.error.message ?? String(c.error.code)));
          else pending.resolve(c.result);
          return { status: 'control_response' };
        }
      } catch {}
      return { status: 'text' };
    }
    try {
      const f = decodeTouchbackFrame(message?.data, this.session.limits);
      if (f.wireVersion !== 'axtp') return { status: 'not_supported' };
      if (!f.streamId || !f.epoch) throw new Error('Invalid stream identity');
      let result;
      if (f.kind !== TouchbackFrameKind.BATCH)
        result = this.handleControlFrame(f);
      else if (
        !this.matchesStream(f) ||
        f.epoch < this.session.epoch ||
        this.streamState !== 'active'
      )
        result = { status: 'stale' };
      else {
        result = this.session.acceptBytes(message.data);
        if (result.status === 'applied') this.onTouchback(result.frame);
        if (result.status === 'reset_required')
          result = { ...result, resetSent: this.requestReset() };
      }
      if (
        ['invalid_state', 'stale', 'reset_required', 'stale_geometry'].includes(
          result.status,
        )
      )
        this.stats.binaryRejected++;
      else this.stats.binaryAccepted++;
      return result;
    } catch (error) {
      this.stats.binaryRejected++;
      return { status: 'invalid_state', error };
    }
  }
  matchesStream(f) {
    return (
      this.session.binding &&
      f.streamId === this.session.streamId &&
      f.canvasToken === this.session.canvasToken &&
      f.geometryToken === this.session.geometryToken
    );
  }
  requestReset() {
    if (
      this.control?.readyState !== 'open' ||
      !this.session.binding ||
      this.session.epoch >= 0xffffffff ||
      this.lastResetEpoch === this.session.epoch
    )
      return false;
    const f = {
      wireVersion: 'axtp',
      streamId: this.session.streamId,
      seqId: this.sendSequence++,
      kind: TouchbackFrameKind.RESET,
      epoch: this.session.epoch + 1,
      canvasToken: this.session.canvasToken,
      geometryToken: this.session.geometryToken,
    };
    const bytes = encodeTouchbackFrame(f, this.localLimits);
    if (!bytes) return false;
    this.handleControlFrame(f);
    this.lastResetEpoch = f.epoch;
    this.control.send(bytes);
    return true;
  }
  handleControlFrame(f) {
    if (f.kind === TouchbackFrameKind.CAPABILITY) return { status: 'accepted' };
    if (f.kind === TouchbackFrameKind.BIND) {
      const b = decodeTouchbackBindPayload(f.controlPayload);
      if (!b)
        return {
          status: 'invalid_state',
          error: new Error('Malformed canonical big-endian BIND payload'),
        };
      const sameOwner = sameBinding(b, this.session.binding);
      if (
        sameOwner &&
        this.matchesStream(f) &&
        f.epoch === this.session.epoch
      )
        return { status: 'accepted', duplicate: true };
      const result = this.session.accept({
        kind: TouchbackFrameKind.BIND,
        binding: {
          ...b,
          ...Object.fromEntries(
            [
              'streamId',
              'epoch',
              'canvasToken',
              'geometryToken',
              'wireVersion',
            ].map((k) => [k, f[k]]),
          ),
        },
      });
      this.stream = {
        streamId: f.streamId,
        epoch: f.epoch,
        canvasToken: f.canvasToken,
        geometryToken: f.geometryToken,
      };
      this.session.limits = { ...this.localLimits };
      this.streamState = 'bound';
      this.openedEpoch = null;
      this.closedEpoch = null;
      this.awaitingClose = false;
      if (!sameOwner) this.commands.clear();
      this.lastResetEpoch = null;
      this.lastReceivedResetEpoch = null;
      this.sendSequence = 0;
      this.onControlFrame(f, result);
      return result;
    }
    if (!this.matchesStream(f) || f.epoch < this.session.epoch)
      return { status: 'stale' };
    if (f.kind === TouchbackFrameKind.RESET) {
      if (f.epoch === this.lastReceivedResetEpoch)
        return { status: 'reset', duplicate: true };
      const result = this.session.accept({
        kind: f.kind,
        epoch: f.epoch,
        wireVersion: 'axtp',
      });
      this.awaitingClose = this.openedEpoch !== null;
      this.lastReceivedResetEpoch = f.epoch;
      this.streamState = 'bound';
      this.stream = { ...this.stream, epoch: f.epoch };
      this.onControlFrame(f, result);
      return result;
    }
    if (f.kind === TouchbackFrameKind.CLOSE && f.epoch === this.session.epoch) {
      const result = this.session.accept({ kind: f.kind, epoch: f.epoch });
      this.streamState = 'bound';
      this.closedEpoch = f.epoch;
      this.onControlFrame(f, result);
      return result;
    }
    return { status: 'stale' };
  }
  fence() {
    for (const request of this.pendingControlRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Control channel detached'));
    }
    this.pendingControlRequests.clear();
    this.commands.clear();
    this.session = new TouchbackSession({ ...this.localLimits });
    this.stream = null;
    this.streamState = 'unavailable';
    this.openedEpoch = null;
    this.closedEpoch = null;
    this.lastReceivedResetEpoch = null;
    this.awaitingClose = false;
    this.control = null;
    return { status: 'reset_required' };
  }
  snapshot() {
    return {
      ...this.stats,
      activeContacts: this.session.activeContacts.size,
      streamState: this.streamState,
      stream: this.stream ? { ...this.stream } : null,
    };
  }
}
