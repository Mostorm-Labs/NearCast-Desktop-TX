import test from 'node:test';
import assert from 'node:assert/strict';
import {LauncherWebCastClient} from '../src/webcast/launcher-webcast-client.mjs';

globalThis.RTCRtpSender = {getCapabilities: kind => ({codecs: [{mimeType: kind === 'video' ? 'video/H264' : 'audio/opus'}]})};

const wait = () => new Promise(resolve => setTimeout(resolve, 0));

class FakeSocket {
  static instances = [];
  static OPEN = 1;
  static CONNECTING = 0;
  constructor(url) { this.url = url; this.readyState = FakeSocket.CONNECTING; this.sent = []; FakeSocket.instances.push(this); }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  send(value) { this.sent.push(JSON.parse(value)); }
  receive(value) { return this.onmessage?.({data: JSON.stringify(value)}); }
  close() { this.readyState = 3; this.onclose?.(); }
}

class FakeChannel {
  readyState = 'connecting';
  sent = [];
  open() { this.readyState = 'open'; this.onopen?.(); }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 'closed'; this.onclose?.(); }
}

class FakePeerConnection {
  static instances = [];
  constructor() { this.connectionState = 'new'; this.iceConnectionState = 'new'; this.tracks = []; this.localDescriptions = []; this.remoteDescriptions = []; this.candidates = []; this.dataChannel = new FakeChannel(); FakePeerConnection.instances.push(this); }
  createDataChannel() { return this.dataChannel; }
  async createOffer() { return {type: 'offer', sdp: `offer-${this.localDescriptions.length + 1}`}; }
  async setLocalDescription(value) { this.localDescriptions.push(value); }
  async setRemoteDescription(value) { this.remoteDescriptions.push(value); }
  async addIceCandidate(value) { this.candidates.push(value); }
  addTrack(track, stream) { this.tracks.push({track, stream}); }
  close() { this.connectionState = 'closed'; this.dataChannel.close(); }
}

function streamFixture() {
  const track = {kind: 'video', contentHint: '', appliedConstraints: [], async applyConstraints(value) { this.appliedConstraints.push(value); }, stopped: false, stop() { this.stopped = true; }};
  return {track, stream: {getTracks: () => [track], getVideoTracks: () => [track]}};
}

test('applies selected capture resolution and fixed video bitrate to the sender', async () => {
  FakeSocket.instances.length = 0; FakePeerConnection.instances.length = 0;
  const fixture = streamFixture();
  const parameters = {encodings: [{}]};
  const sender = {track: fixture.track, getParameters: () => parameters, async setParameters(value) { Object.assign(parameters, value); }, async replaceTrack() {}};
  const captures = [];
  class QualityPeer extends FakePeerConnection {
    addTrack(track, stream) { this.tracks.push({track, stream}); return sender; }
    getTransceivers() { return [{sender, setCodecPreferences() {}}]; }
  }
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: QualityPeer,
    mediaDevices: {getDisplayMedia: async constraints => { captures.push(constraints); return fixture.stream; }},
    videoQuality: {resolution: '1920x1080', bitrateMode: 'fixed', bitrateKbps: 8000}});
  const connecting = client.connect('1234'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  await socket.receive({type: 'joined'}); await wait();
  await client.startScreenShare();
  assert.deepEqual(captures[0], {video: {width: {ideal: 1920}, height: {ideal: 1080}}, audio: false});
  assert.equal(parameters.encodings[0].maxBitrate, 8000000);
  assert.equal(parameters.degradationPreference, 'maintain-resolution');
  assert.equal(fixture.track.contentHint, 'detail');
  assert.deepEqual(fixture.track.appliedConstraints.at(-1), {width: {ideal: 1920}, height: {ideal: 1080}});
  await client.stop();
});

test('leaves bitrate adaptive when dynamic mode is selected', async () => {
  const fixture = streamFixture();
  const parameters = {encodings: [{maxBitrate: 4000000, scaleResolutionDownBy: 1}]};
  const sender = {track: fixture.track, getParameters: () => parameters, async setParameters(value) { Object.assign(parameters, value); }, async replaceTrack() {}};
  class QualityPeer extends FakePeerConnection {
    addTrack(track, stream) { this.tracks.push({track, stream}); return sender; }
    getTransceivers() { return [{sender, setCodecPreferences() {}}]; }
  }
  FakeSocket.instances.length = 0; FakePeerConnection.instances.length = 0;
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: QualityPeer,
    mediaDevices: {getDisplayMedia: async () => fixture.stream},
    videoQuality: {resolution: 'auto', bitrateMode: 'dynamic', bitrateKbps: 8000}});
  const connecting = client.connect('1234'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  await socket.receive({type: 'joined'}); await wait();
  await client.startScreenShare();
  assert.equal(parameters.encodings[0].maxBitrate, 8000000);
  assert.equal(parameters.degradationPreference, 'balanced');
  assert.equal(parameters.encodings[0].scaleResolutionDownBy, 1);
  await client.stop();
});

test('requires a four-character pairing code before opening Launcher signaling', async () => {
  FakeSocket.instances.length = 0;
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection});
  await assert.rejects(() => client.connect('12'), /pairing code/i);
  assert.equal(FakeSocket.instances.length, 0);
});

test('joins through Launcher signaling and negotiates a sender peer connection', async () => {
  FakeSocket.instances.length = 0; FakePeerConnection.instances.length = 0;
  const statuses = [];
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection, endpoint: 'wss://cast.example.test', onStatus: status => statuses.push(status)});
  const connecting = client.connect('a1b2');
  const socket = FakeSocket.instances.at(-1);
  assert.match(socket.url, /role=sender/);
  socket.open();
  await connecting;
  assert.deepEqual(socket.sent[0], {type: 'join', pairCode: 'A1B2'});
  await socket.receive({type: 'joined', roomId: 'room-1', userId: 'sender-1'});
  await wait();
  const pc = FakePeerConnection.instances.at(-1);
  assert.equal(pc.localDescriptions[0].type, 'offer');
  assert.equal(socket.sent.at(-1).type, 'offer');
  await socket.receive({type: 'answer', answer: {type: 'answer', sdp: 'answer-1'}});
  assert.equal(pc.remoteDescriptions[0].sdp, 'answer-1');
  pc.onicecandidate?.({candidate: {candidate: 'candidate-1'}});
  assert.deepEqual(socket.sent.at(-1), {type: 'ice-candidate', candidate: {candidate: 'candidate-1'}, roomId: 'room-1', userId: 'sender-1'});
  assert.equal(statuses.includes('joined'), true);
});

const receiverDevice = (overrides = {}) => ({protocol: 'webcast', selectable: true, instance: 'Receiver._nearcast._tcp.local.', deviceId: 'receiver-1', endpoint: 'https://receiver.example.test:8443', supportsCodeDisplay: true, capabilities: new Set(['webcast', 'code-display-v1']), expiresAt: Date.now() + 60000, ...overrides});

test('requests code display over local HTTPS before pairing and exposes only status', async () => {
  FakeSocket.instances.length = 0;
  const results = []; const requests = [];
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection,
    codeDisplayTransport: async ({url, instance, request}) => {
      requests.push({url, instance, request});
      return {type: 'nearcast.code_display.result', version: 1, requestId: request.requestId, status: 'shown', pairCode: 'PRIVATE'};
    }, onCodeDisplayResult: result => results.push(result)});
  const requestId = client.requestCodeDisplay({device: receiverDevice()});
  await wait();
  assert.equal(FakeSocket.instances.length, 0);
  assert.deepEqual(requests, [{url: 'https://receiver.example.test:8443/nearcast/code-display', instance: 'Receiver._nearcast._tcp.local.', request: {type: 'nearcast.code_display.request', version: 1, deviceId: 'receiver-1', requestId, reason: 'sender-device-selected'}}]);
  assert.deepEqual(results, [{type: 'nearcast.code_display.result', version: 1, requestId, deviceId: 'receiver-1', status: 'shown'}]);
  assert.equal(client.snapshot().pairCode, null);
  assert.equal(client.snapshot().status, 'idle');
});

test('does not request code display for an unselected device or accept mismatched results', async () => {
  FakeSocket.instances.length = 0; FakePeerConnection.instances.length = 0;
  const results = [];
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection, onCodeDisplayResult: result => results.push(result)});
  const connecting = client.connect('1234'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  assert.equal(socket.sent.some(message => message.type === 'nearcast.code_display.request'), false);
  await socket.receive({type: 'nearcast.code_display.result', version: 1, requestId: 'unknown', status: 'shown'});
  assert.deepEqual(results, []);
});

test('rejects AirPlay, missing capabilities, stale leases and insecure display requests before transport', () => {
  let calls = 0;
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection, codeDisplayTransport: async () => { calls++; }});
  for (const overrides of [{trustRequired:true,trustState:'untrusted'}, {trustRequired:true,trustState:'changed'}, {protocol: 'airplay'}, {selectable: false}, {capabilities: new Set(['webcast'])}, {deviceId: null}, {expiresAt: 1}, {endpoint: 'http://receiver.example.test'}, {endpoint: 'https://user:pass@receiver.example.test'}]) {
    assert.throws(() => client.requestCodeDisplay({device: receiverDevice(overrides)}));
  }
  assert.equal(calls, 0);
});

test('deduplicates pending displays and ignores cancelled or mismatched HTTP results', async () => {
  const results = []; const errors = []; const pending = [];
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection,
    codeDisplayTransport: options => new Promise(resolve => pending.push({options, resolve})),
    onCodeDisplayResult: result => results.push(result), onCodeDisplayError: error => errors.push(error)});
  const requestId = client.requestCodeDisplay({device: receiverDevice()});
  assert.equal(client.requestCodeDisplay({device: receiverDevice()}), requestId);
  await wait();
  assert.equal(pending.length, 1);
  client.cancelCodeDisplay();
  assert.equal(pending[0].options.signal.aborted, true);
  pending[0].resolve({type: 'nearcast.code_display.result', version: 1, requestId, status: 'shown'});
  await wait();
  assert.deepEqual(results, []);
  client.requestCodeDisplay({device: receiverDevice()}); await wait();
  pending[1].resolve({type: 'nearcast.code_display.result', version: 1, requestId: 'wrong-target', status: 'shown'});
  await wait();
  assert.deepEqual(results, []);
  assert.equal(errors.length, 1);
  assert.equal(client.pendingCodeDisplayRequest('receiver-1'), null);
});

test('display timeout and network failures do not authorize or open signaling', async () => {
  FakeSocket.instances.length = 0;
  const errors = [];
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection,
    codeDisplayTimeoutMs: 10, codeDisplayTransport: () => new Promise(() => {}), onCodeDisplayError: error => errors.push(error)});
  client.requestCodeDisplay({device: receiverDevice()});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(errors.length, 1);
  assert.equal(client.pendingCodeDisplayRequest('receiver-1'), null);
  assert.equal(client.status, 'idle');
  assert.equal(FakeSocket.instances.length, 0);
});

test('preserves the native Tauri HTTPS trust failure returned as a string', async () => {
  FakeSocket.instances.length = 0;
  const errors = [];
  const nativeMessage = '无法通过 HTTPS 访问接收端，请检查网络和接收端证书是否已受 Windows 信任；也可现场查看配对码。';
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection,
    codeDisplayTransport: async () => { throw nativeMessage; }, onCodeDisplayError: (error, request) => errors.push({error, request})});
  const requestId = client.requestCodeDisplay({device: receiverDevice()});
  await wait();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.message, nativeMessage);
  assert.deepEqual(errors[0].request, {requestId, deviceId: 'receiver-1'});
  assert.equal(client.pendingCodeDisplayRequest('receiver-1'), null);
  assert.equal(client.status, 'idle');
  assert.equal(FakeSocket.instances.length, 0);
});

test('pairing never falls back to a WebSocket display request', async () => {
  FakeSocket.instances.length = 0;
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection});
  const connecting = client.connect('1234', {deviceId: 'receiver-1'});
  const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  assert.deepEqual(socket.sent, [{type: 'join', pairCode: '1234'}]);
});

test('error callback can stop a failed connection and return the sender to idle', async () => {
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection,
    onError: () => client.stop({notify: false})});
  const connecting = client.connect('1234'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  await socket.receive({type: 'join_failed', reason: 'invalid_code'});
  assert.equal(client.status, 'idle');
  assert.equal(client.socket, null);
});

test('a delayed screen picker cannot attach captured media to a replacement peer', async () => {
  let finishCapture;
  const fixture = streamFixture();
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection,
    mediaDevices: {getDisplayMedia: () => new Promise(resolve => { finishCapture = resolve; })}});
  let connecting = client.connect('1234'); let socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  await socket.receive({type: 'joined'});
  const capture = client.startScreenShare();
  await client.stop();
  connecting = client.connect('5678'); socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  await socket.receive({type: 'joined'});
  finishCapture(fixture.stream);
  await assert.rejects(capture, /cancel/i);
  assert.equal(fixture.track.stopped, true);
  assert.equal(client.pc.tracks.length, 0);
  await client.stop();
});

test('late socket and control callbacks cannot enter a replacement peer session', async () => {
  const controls = []; const channels = []; const ended = [];
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection,
    onControlMessage: message => controls.push(message), onControlChannel: channel => channels.push(channel), onSessionEnded: () => ended.push(true)});
  let connecting = client.connect('1234'); const oldSocket = FakeSocket.instances.at(-1); oldSocket.open(); await connecting;
  await oldSocket.receive({type: 'joined', roomId: 'old-room', userId: 'sender-1', hostUserId: 'host-1'}); await wait();
  const oldChannel = client.channel; const onMessage = oldChannel.onmessage; const onOpen = oldChannel.onopen;
  await client.stop();
  connecting = client.connect('5678'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  await socket.receive({type: 'joined', roomId: 'new-room', userId: 'sender-2', hostUserId: 'host-2'}); await wait();
  const pc = client.pc;
  await oldSocket.receive({type: 'answer', answer: {type: 'answer', sdp: 'stale'}}); await wait();
  await socket.receive({type: 'answer', roomId: 'other-room', userId: 'host-2', answer: {type: 'answer', sdp: 'wrong room'}}); await wait();
  onMessage({data: new ArrayBuffer(1)}); onOpen();
  assert.equal(pc.remoteDescriptions.length, 0);
  assert.equal(controls.length, 0);
  assert.equal(channels.length, 0);
  assert.equal(ended.length >= 1, true);
  await client.stop();
});

test('captures the screen only on request and renegotiates the media stream', async () => {
  FakeSocket.instances.length = 0; FakePeerConnection.instances.length = 0;
  const fixture = streamFixture();
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection, mediaDevices: {getDisplayMedia: async () => fixture.stream}});
  const connecting = client.connect('1234');
  const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  await socket.receive({type: 'joined'}); await wait();
  const pc = FakePeerConnection.instances.at(-1);
  await client.startScreenShare();
  assert.equal(pc.tracks.length, 1);
  assert.equal(client.snapshot().status, 'sharing');
  assert.equal(client.snapshot().hasStream, true);
  await client.stop();
  assert.equal(fixture.track.stopped, true);
  assert.equal(pc.connectionState, 'closed');
  assert.equal(socket.readyState, 3);
});

test('keeps a joined session when the screen picker is cancelled or unavailable', async () => {
  for (const captureError of [new DOMException('The user cancelled the screen picker', 'AbortError'), new DOMException('permission denied', 'NotAllowedError'), new Error('getDisplayMedia is not a function')]) {
    FakeSocket.instances.length = 0; FakePeerConnection.instances.length = 0;
    const errors = [];
    const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection,
      mediaDevices: {getDisplayMedia: async () => { throw captureError; }}, onError: error => errors.push(error)});
    const connecting = client.connect('1234'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
    await socket.receive({type: 'joined'}); await wait();
    client.channel.open();
    await assert.rejects(client.startScreenShare(), error => error === captureError);
    assert.equal(client.status, 'connected');
    assert.equal(client.socket, socket);
    assert.equal(errors.length, 0);
  }
});

test('includes the Launcher host and target context required by the NearCast receiver', async () => {
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection});
  const connecting = client.connect('1234'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  assert.equal(client.status, 'connecting');
  await socket.receive({type: 'joined', roomId: 'room-1', userId: 'sender-1', hostUserId: 'host-1'});
  const offer = socket.sent.find(message => message.type === 'offer');
  assert.equal(offer.hostUserId, 'host-1');
  assert.equal(offer.targetId, 'host-1');
  await client.stop();
});

test('uses Launcher DataChannel signaling for media renegotiation and handles its answer', async () => {
  const fixture = streamFixture(); const controls = [];
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection,
    mediaDevices: {getDisplayMedia: async () => fixture.stream}, onControlMessage: event => controls.push(event)});
  const connecting = client.connect('1234'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  await socket.receive({type: 'joined', roomId: 'room-1', userId: 'sender-1', hostUserId: 'host-1'});
  await socket.receive({type: 'answer', answer: {type: 'answer', sdp: 'initial-answer'}});
  const channel = client.channel; channel.open();
  await client.startScreenShare();
  assert.deepEqual(JSON.parse(channel.sent.at(-1)), {action: 'webrtc-signal', data: {type: 'offer', payload: {type: 'offer', sdp: 'offer-2'}}});
  await channel.onmessage({data: JSON.stringify({action: 'webrtc-signal', data: {type: 'answer', payload: {type: 'answer', sdp: 'media-answer'}}})});
  assert.equal(client.pc.remoteDescriptions.at(-1).sdp, 'media-answer');
  assert.equal(controls.length, 0);
  await client.stop();
});

test('buffers early ICE until the answer is applied instead of failing the session', async () => {
  class StrictPeer extends FakePeerConnection {
    async addIceCandidate(candidate) {
      if (!this.remoteDescriptions.length) throw new DOMException('The remote description was null', 'InvalidStateError');
      return super.addIceCandidate(candidate);
    }
  }
  const errors = [];
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: StrictPeer, onError: error => errors.push(error)});
  const connecting = client.connect('1234'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  await socket.receive({type: 'joined'});
  await socket.receive({type: 'ice-candidate', candidate: {candidate: 'early', sdpMLineIndex: 0}});
  await socket.receive({type: 'answer', answer: {type: 'answer', sdp: 'answer'}});
  assert.deepEqual(errors, []);
  assert.deepEqual(client.pc.candidates, [{candidate: 'early', sdpMLineIndex: 0}]);
  await client.stop();
});

test('reports the signaling close reason instead of silently returning to pairing', async () => {
  const errors = [];
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection, onError: error => errors.push(error)});
  const connecting = client.connect('1234'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  await socket.receive({type: 'joined'});
  socket.onclose({code: 1008, reason: 'session_expired'});
  assert.match(errors[0]?.message ?? '', /1008.*session_expired/);
  await client.stop();
});

test('a closed control channel retires sharing and cannot start another capture', async () => {
  const errors = []; const fixture = streamFixture(); let captures = 0;
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection,
    mediaDevices: {getDisplayMedia: async () => { captures++; return fixture.stream; }}, onError: error => errors.push(error)});
  const connecting = client.connect('1234'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  await socket.receive({type: 'joined'}); client.channel.open();
  await client.startScreenShare();
  client.channel.close();
  assert.equal(client.status, 'error');
  assert.equal(fixture.track.stopped, true);
  assert.equal(client.stream, null);
  assert.match(errors[0]?.message ?? '', /控制通道.*关闭/);
  await assert.rejects(client.startScreenShare(), /Connect to a receiver/);
  assert.equal(captures, 1);
  await client.stop();
});

test('control closure while the picker is pending releases a late capture', async () => {
  let finishCapture; const fixture = streamFixture();
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection,
    mediaDevices: {getDisplayMedia: () => new Promise(resolve => { finishCapture = resolve; })}});
  const connecting = client.connect('1234'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting;
  await socket.receive({type: 'joined'}); client.channel.open();
  const capture = client.startScreenShare();
  client.channel.close(); finishCapture(fixture.stream);
  await assert.rejects(capture, /cancel/i);
  assert.equal(fixture.track.stopped, true);
  assert.equal(client.stream, null);
  await client.stop();
});

test('exposes the existing control channel and forwards binary messages', async () => {
  FakeSocket.instances.length = 0; FakePeerConnection.instances.length = 0;
  const channels = []; const controls = [];
  const client = new LauncherWebCastClient({WebSocketImpl: FakeSocket, RTCPeerConnectionImpl: FakePeerConnection, onControlChannel: channel => channels.push(channel), onControlMessage: message => controls.push(message)});
  const connecting = client.connect('1234'); const socket = FakeSocket.instances.at(-1); socket.open(); await connecting; await socket.receive({type: 'joined'}); await wait();
  const channel = FakePeerConnection.instances.at(-1).dataChannel;
  channel.open();
  channel.onmessage?.({data: new Uint8Array([1, 2]).buffer});
  assert.equal(channels[0], channel);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].data.byteLength, 2);
});

