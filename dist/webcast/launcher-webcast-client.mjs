const DEFAULT_ENDPOINT = 'wss://cast.nearhub.us';
const PAIR_CODE_LENGTH = 4;
const CODE_DISPLAY_REQUEST_TYPE = 'nearcast.code_display.request';
const CODE_DISPLAY_RESULT_TYPE = 'nearcast.code_display.result';
const CODE_DISPLAY_VERSION = 1;
const CODE_DISPLAY_STATUSES = new Set(['shown', 'unavailable', 'rate_limited', 'not_supported']);
let codeDisplaySequence = 0;

const normalizeEndpoint = endpoint => {
  const value = String(endpoint || DEFAULT_ENDPOINT).trim();
  if (!value) throw new TypeError('WebCast endpoint required');
  const url = new URL(value);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new TypeError('WebCast endpoint must be ws or wss');
  url.searchParams.set('role', 'sender');
  return url.toString();
};

const validPairCode = value => typeof value === 'string' && /^[A-Za-z0-9]{4}$/.test(value.trim());
const utf8Length = value => new TextEncoder().encode(value).length;
const postCodeDisplay = async ({url, request, signal}) => {
  const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(request), signal, redirect: 'error', credentials: 'omit', cache: 'no-store'});
  if (!response.ok) throw new Error(`Code display HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > 4096) throw new Error('Code display response is too large');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 4096) throw new Error('Code display response is too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
};

export class LauncherWebCastClient {
  constructor({
    WebSocketImpl = globalThis.WebSocket,
    RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
    mediaDevices = globalThis.navigator?.mediaDevices,
    endpoint = DEFAULT_ENDPOINT,
    onStatus,
    onError,
    onControlChannel,
    onControlMessage,
    onStream,
    onCodeDisplayResult,
    onCodeDisplayError,
    onSessionEnded,
    codeDisplayTransport = postCodeDisplay,
    codeDisplayTimeoutMs = 6000,
  } = {}) {
    if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocket implementation required');
    if (typeof RTCPeerConnectionImpl !== 'function') throw new TypeError('RTCPeerConnection implementation required');
    this.WebSocketImpl = WebSocketImpl;
    this.RTCPeerConnectionImpl = RTCPeerConnectionImpl;
    this.mediaDevices = mediaDevices;
    this.endpoint = endpoint;
    this.onStatus = onStatus ?? (() => {});
    this.onError = onError ?? (() => {});
    this.onControlChannel = onControlChannel ?? (() => {});
    this.onControlMessage = onControlMessage ?? (() => {});
    this.onStream = onStream ?? (() => {});
    this.onCodeDisplayResult = onCodeDisplayResult ?? (() => {});
    this.onCodeDisplayError = onCodeDisplayError ?? (() => {});
    this.onSessionEnded = onSessionEnded ?? (() => {});
    this.codeDisplayTransport = codeDisplayTransport;
    this.codeDisplayTimeoutMs = codeDisplayTimeoutMs;
    this.socket = null;
    this.pc = null;
    this.channel = null;
    this.stream = null;
    this.pairCode = null;
    this.context = {};
    this.status = 'idle';
    this.closed = false;
    this.joinedPromise = null;
    this.pendingCodeDisplay = new Map();
    this.socketOpenPromise = null;
    this.pendingCandidates = [];
    this.remoteReady = false;
    this.signalingChain = Promise.resolve();
    this.mediaSenders = new Map();
  }

  setStatus(status) {
    this.status = status;
    this.onStatus(status);
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('WebSocket is not connected');
    const enriched = {...payload};
    if (this.context.roomId && !enriched.roomId) enriched.roomId = this.context.roomId;
    if (this.context.userId && !enriched.userId) enriched.userId = this.context.userId;
    if (this.context.hostUserId && !enriched.hostUserId) enriched.hostUserId = this.context.hostUserId;
    if (['offer', 'ice-candidate'].includes(enriched.type) && this.context.hostUserId && !enriched.targetId) enriched.targetId = this.context.hostUserId;
    this.socket.send(JSON.stringify(enriched));
  }

  // Match Launcher's CastController: bootstrap on WSS, then prefer control.
  sendSignal(type, payload) {
    if (this.channel?.readyState === 'open') {
      try { this.channel.send(JSON.stringify({action: 'webrtc-signal', data: {type, payload}})); return; }
      catch { /* A closing channel can still report open; fall back to WSS. */ }
    }
    this.send({type, [type === 'ice-candidate' ? 'candidate' : type]: payload});
  }

  queueSignal(operation) {
    const socket = this.socket;
    const next = this.signalingChain.then(() => {
      if (this.socket === socket && !this.closed) return operation();
    });
    this.signalingChain = next.catch(() => {});
    return next;
  }

  async applySignal(type, payload) {
    const pc = this.pc;
    if (!pc) return;
    if (type === 'answer') {
      await pc.setRemoteDescription(payload);
      if (this.pc !== pc || this.closed) return;
      this.remoteReady = true;
      for (const candidate of this.pendingCandidates.splice(0)) {
        await pc.addIceCandidate(candidate);
        if (this.pc !== pc || this.closed) return;
      }
      this.setStatus(this.stream ? 'sharing' : this.channel?.readyState === 'open' ? 'connected' : 'joined');
    } else if (type === 'ice-candidate') {
      if (this.remoteReady) await pc.addIceCandidate(payload);
      else {
        if (this.pendingCandidates.length >= 128) throw new Error('Too many pending ICE candidates');
        this.pendingCandidates.push(payload);
      }
    }
  }

  requestCodeDisplay({device, reason = 'sender-device-selected'} = {}) {
    if (device?.trustRequired && device.trustState !== 'trusted') throw new TypeError('请先现场核对并信任接收端指纹');
    if (device?.protocol !== 'webcast' || !device.selectable || !device.capabilities?.has('webcast') || !device.capabilities.has('code-display-v1') || !device.supportsCodeDisplay) throw new TypeError('Receiver does not support code display');
    if (!Number.isFinite(device.expiresAt) || device.expiresAt <= Date.now()) throw new RangeError('Receiver discovery expired; scan again');
    const deviceId = device.deviceId;
    if (typeof deviceId !== 'string' || !deviceId.trim() || utf8Length(deviceId) > 128) throw new TypeError('WebCast device id required');
    if (typeof reason !== 'string' || !reason.trim() || utf8Length(reason) > 64) throw new TypeError('Code display reason required');
    const endpoint = new URL(device.endpoint);
    if (endpoint.protocol === 'wss:') endpoint.protocol = 'https:';
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new TypeError('Code display endpoint must be https without credentials');
    const url = new URL('/nearcast/code-display', endpoint).toString();
    for (const pending of this.pendingCodeDisplay.values()) if (pending.deviceId === deviceId && pending.url === url) return pending.requestId;
    const requestId = `code-display-${Date.now().toString(36)}-${(++codeDisplaySequence).toString(36)}`;
    const request = {type: CODE_DISPLAY_REQUEST_TYPE, version: CODE_DISPLAY_VERSION, deviceId, requestId, reason: reason.trim()};
    if (utf8Length(JSON.stringify(request)) > 1024) throw new RangeError('Code display request is too large');
    // Selecting another receiver retires the previous display request and its response.
    this.cancelCodeDisplay();
    const controller = new AbortController();
    const pending = {...request, url, controller};
    this.pendingCodeDisplay.set(requestId, pending);
    const fail = error => {
      if (this.pendingCodeDisplay.get(requestId) !== pending) return;
      this.pendingCodeDisplay.delete(requestId); clearTimeout(pending.timer); controller.abort();
      this.onCodeDisplayError(error instanceof Error ? error : new Error(typeof error === 'string' && error.trim() ? error : 'Code display request failed'), {requestId, deviceId});
    };
    pending.timer = setTimeout(() => fail(new Error('Code display request timed out')), this.codeDisplayTimeoutMs);
    Promise.resolve().then(() => this.codeDisplayTransport({url, instance: device.instance, request, signal: controller.signal})).then(result => {
      if (this.pendingCodeDisplay.get(requestId) !== pending) return;
      if (result?.type !== CODE_DISPLAY_RESULT_TYPE || result.version !== 1 || result.requestId !== requestId || !CODE_DISPLAY_STATUSES.has(result.status) || (result.deviceId && result.deviceId !== deviceId)) throw new Error('Invalid code display response');
      this.pendingCodeDisplay.delete(requestId); clearTimeout(pending.timer);
      this.onCodeDisplayResult({type: CODE_DISPLAY_RESULT_TYPE, version: 1, requestId, deviceId, status: result.status});
    }).catch(fail);
    return requestId;
  }

  cancelCodeDisplay() {
    for (const pending of this.pendingCodeDisplay.values()) { clearTimeout(pending.timer); pending.controller.abort(); }
    this.pendingCodeDisplay.clear();
  }

  pendingCodeDisplayRequest(deviceId) {
    for (const request of this.pendingCodeDisplay.values()) if (request.deviceId === deviceId) return request.requestId;
    return null;
  }

  openSocket() {
    if (this.socket?.readyState === 1) return Promise.resolve();
    if (this.socketOpenPromise) return this.socketOpenPromise;
    const url = normalizeEndpoint(this.endpoint);
    const socket = new this.WebSocketImpl(url);
    this.socket = socket;
    this.socketOpenPromise = new Promise((resolve, reject) => {
      socket.onopen = () => {
        if (this.socket !== socket || this.closed) { reject(new Error('Connection cancelled')); return; }
        this.socketOpenPromise = null;
        resolve();
      };
      socket.onmessage = event => { if (this.socket === socket && !this.closed) return this.queueSignal(() => this.handleSocketMessage(event)).catch(error => { if (this.socket === socket && !this.closed) this.fail(error); }); };
      socket.onerror = () => { if (this.socket !== socket || this.closed) return; this.socketOpenPromise = null; reject(new Error('WebSocket connection error')); this.fail(new Error('WebSocket connection error')); };
      socket.onclose = event => {
        reject(new Error('WebSocket connection closed'));
        if (this.socket !== socket || this.closed) return;
        this.socketOpenPromise = null;
        this.fail(new Error(`信令连接已关闭（${event?.code ?? 1006}）${event?.reason ? `：${event.reason}` : '，请检查接收端和网络后重试。'}`));
      };
    });
    return this.socketOpenPromise;
  }

  async connect(pairCode) {
    if (!validPairCode(pairCode)) throw new RangeError('Pairing code must be four letters or digits');
    if (this.status !== 'idle') return this.snapshot();
    this.pairCode = pairCode.trim().toUpperCase();
    this.closed = false;
    this.setStatus('connecting');
    const opening = this.openSocket(); const socket = this.socket;
    await opening;
    if (this.socket !== socket || this.closed) throw new Error('Connection cancelled');
    this.send({type: 'join', pairCode: this.pairCode});
    return this.snapshot();
  }

  async handleSocketMessage(event) {
    const data = typeof event?.data === 'string' ? JSON.parse(event.data) : event?.data;
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'ping') { this.send({type: 'pong', ts: data.ts}); return; }
    if (data.type === 'joined') {
      this.context = {roomId: data.roomId, userId: data.userId, hostUserId: data.hostUserId};
      this.setStatus('joined');
      await this.initializePeerConnection();
      return;
    }
    if (data.type === 'join_failed') { throw new Error(data.reason || 'Pairing code rejected'); }
    if (data.roomId && this.context.roomId && data.roomId !== this.context.roomId) return;
    if (data.targetId && this.context.userId && data.targetId !== this.context.userId) return;
    if (['answer', 'ice-candidate'].includes(data.type) && data.userId && this.context.hostUserId && data.userId !== this.context.hostUserId) return;
    if (data.type === 'answer' && data.answer) {
      await this.applySignal('answer', data.answer);
      return;
    }
    if (data.type === 'ice-candidate' && data.candidate) {
      await this.applySignal('ice-candidate', data.candidate);
      return;
    }
    if (data.type === 'peer_leave' || data.type === 'room_closed') {
      throw new Error(data.type === 'room_closed' ? '接收端已关闭投屏房间，请查看新的配对码。' : `接收端已结束连接${data.reason ? `：${data.reason}` : '，请重新连接。'}`);
    }
    if (data.type === 'error') throw new Error(`信令请求失败：${data.reason || data.message || 'unknown_error'}`);
  }

  async initializePeerConnection(createOffer = true) {
    if (this.pc) return;
    const pc = new this.RTCPeerConnectionImpl(); this.pc = pc;
    const current = () => this.pc === pc && !this.closed;
    pc.onicecandidate = event => {
      if (current() && event.candidate) {
        try { this.sendSignal('ice-candidate', event.candidate); } catch (error) { this.fail(error); }
      }
    };
    pc.onconnectionstatechange = () => {
      if (current() && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) this.fail(new Error('WebRTC connection failed'));
    };
    const channel = pc.createDataChannel('control'); this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => { if (current() && this.channel === channel) { this.setStatus(this.stream ? 'sharing' : 'connected'); this.onControlChannel(channel, {...this.context}); } };
    channel.onmessage = event => {
      if (!current() || this.channel !== channel) return;
      if (typeof event.data === 'string') {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.action === 'webrtc-signal') return this.queueSignal(() => this.applySignal(message.data?.type, message.data?.payload)).catch(error => { if (current()) this.fail(error); });
        if (message.action === 'leave') { this.fail(new Error('接收端已结束本次投屏，请重新连接。')); return; }
      }
      this.onControlMessage(event, {...this.context});
    };
    channel.onclose = () => { if (current() && this.channel === channel) this.fail(new Error('接收端控制通道已关闭，请重新连接。')); };
    if (!createOffer) return;
    const offer = await pc.createOffer();
    if (!current()) return;
    await pc.setLocalDescription(offer);
    if (!current()) return;
    this.send({type: 'offer', offer});
  }

  async startScreenShare({video = true, audio = false} = {}) {
    if (!this.pc || (this.status !== 'connected' && this.status !== 'joined' && this.status !== 'sharing')) throw new Error('Connect to a receiver before sharing');
    if (!this.mediaDevices || typeof this.mediaDevices.getDisplayMedia !== 'function') throw new Error('Screen capture is unavailable');
    const pc = this.pc;
    const stream = await this.mediaDevices.getDisplayMedia({video, audio});
    if (this.pc !== pc || this.closed) { for (const track of stream.getTracks()) track.stop(); throw new Error('Screen capture cancelled with the previous connection'); }
    if (this.stream) await this.stopStream();
    this.stream = stream;
    try {
      for (const track of stream.getTracks()) {
        const sender = this.mediaSenders.get(track.kind);
        if (sender) await sender.replaceTrack(track);
        else this.mediaSenders.set(track.kind, pc.addTrack(track, stream));
        track.onended = () => { if (this.stream === stream) this.stopStream().catch(error => this.fail(error)); };
      }
      // NearCast's native receiver accepts H.264 / Opus, not Chromium's
      // default VP8 preference. Keep codec selection at the media boundary.
      for (const transceiver of pc.getTransceivers?.() ?? []) {
        const kind = transceiver.sender.track?.kind;
        if (!kind) continue;
        const codecs = globalThis.RTCRtpSender?.getCapabilities(kind)?.codecs.filter(codec => codec.mimeType.toLowerCase() === (kind === 'video' ? 'video/h264' : 'audio/opus'));
        if (!codecs?.length || !transceiver.setCodecPreferences) throw new Error('Screen capture codec unavailable: H.264 / Opus required');
        transceiver.setCodecPreferences(codecs);
      }
      await this.queueSignal(async () => {
        if (this.pc !== pc || this.closed) return;
        const offer = await pc.createOffer();
        if (this.pc !== pc || this.closed) return;
        await pc.setLocalDescription(offer);
        if (this.pc !== pc || this.closed) return;
        this.sendSignal('offer', offer);
      });
    } catch (error) {
      if (this.stream === stream) await this.stopStream();
      throw error;
    }
    if (this.pc !== pc || this.closed) return;
    this.setStatus('sharing');
    this.onStream(stream);
    return stream;
  }

  async stopStream() {
    if (!this.stream) return;
    const current = this.stream;
    this.stream = null;
    for (const track of current.getTracks()) track.stop();
    for (const sender of this.mediaSenders.values()) await sender?.replaceTrack(null);
    this.onStream(null);
    if (this.pc && this.status === 'sharing') this.setStatus('connected');
  }

  closePeerConnection() {
    this.pendingCandidates = [];
    this.remoteReady = false;
    this.signalingChain = Promise.resolve();
    this.mediaSenders.clear();
    this.onSessionEnded();
    if (this.stream) { const stream = this.stream; this.stream = null; for (const track of stream.getTracks()) track.stop(); this.onStream(null); }
    if (this.channel) { const channel = this.channel; this.channel = null; channel.onmessage = null; channel.onopen = null; channel.onclose = null; channel.close?.(); }
    if (this.pc) { const pc = this.pc; this.pc = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close?.(); }
  }

  async stop({notify = true} = {}) {
    this.closed = true;
    if (notify && this.socket?.readyState === 1) { try { this.send({type: 'peer_leave', targetId: ''}); } catch {} }
    this.closePeerConnection();
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) this.socket.close();
    this.socket = null;
    this.context = {};
    this.pairCode = null;
    this.cancelCodeDisplay();
    this.socketOpenPromise = null;
    this.setStatus('idle');
  }

  fail(error) {
    const value = error instanceof Error ? error : new Error(String(error));
    this.closePeerConnection();
    this.setStatus('error');
    this.onError(value);
  }

  snapshot() {
    return {status: this.status, pairCode: this.pairCode, roomId: this.context.roomId ?? null, hasStream: Boolean(this.stream), hasControlChannel: Boolean(this.channel)};
  }
}

export {DEFAULT_ENDPOINT, PAIR_CODE_LENGTH};
