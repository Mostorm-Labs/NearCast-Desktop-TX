// Run with PLAYWRIGHT_MODULE pointing to Playwright, or install it locally.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve('dist');
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const body = await readFile(path);
    response.setHeader('content-type', path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.webp') ? 'image/webp' : 'text/html');
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
// Chromium blocks several low-numbered ports; Windows may allocate them for :0.
for (;;) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  if (server.address().port > 10240) break;
  await new Promise(resolve => server.close(resolve));
}
let browser;
try {
  browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.testReceiver = {signals: [], receivedTracks: [], frames: 0, mode: 'capture'};
    const state = globalThis.testReceiver;
    const receiver = new RTCPeerConnection({iceServers: []});
    let channel, socket, chain = Promise.resolve(), pending = [];
    const context = {roomId: 'room-1', userId: 'host-1', hostUserId: 'host-1', targetId: 'sender-1'};
    const send = (type, payload) => {
      if (channel?.readyState === 'open') channel.send(JSON.stringify({action: 'webrtc-signal', data: {type, payload}}));
      else socket.receive({type, ...context, [type === 'ice-candidate' ? 'candidate' : type]: payload});
    };
    const signal = (type, payload, transport) => {
      state.signals.push({type, transport});
      chain = chain.then(async () => {
        if (type === 'offer') {
          if (/^m=video /m.test(payload.sdp)) {
            state.videoCodecs = [...payload.sdp.matchAll(/^a=rtpmap:\d+ ([^/]+)\/90000/gm)].map(match => match[1]);
          }
          await receiver.setRemoteDescription(payload);
          for (const candidate of pending.splice(0)) await receiver.addIceCandidate(candidate);
          await receiver.setLocalDescription(await receiver.createAnswer());
          const answer = receiver.localDescription.toJSON();
          if (!state.releaseAnswer) state.releaseAnswer = () => send('answer', answer);
          else send('answer', answer);
        } else if (type === 'ice-candidate') {
          if (receiver.remoteDescription) await receiver.addIceCandidate(payload);
          else pending.push(payload);
        }
      }).catch(error => { state.error = error.message; });
    };
    receiver.onicecandidate = event => { if (event.candidate) send('ice-candidate', event.candidate.toJSON()); };
    receiver.ontrack = event => {
      state.receivedTracks.push(event.track.kind);
      const video = document.createElement('video'); video.muted = true; video.autoplay = true;
      video.srcObject = new MediaStream([event.track]); document.body.append(video);
      const countFrame = () => { state.frames++; video.requestVideoFrameCallback(countFrame); };
      video.requestVideoFrameCallback(countFrame);
    };
    receiver.ondatachannel = event => {
      channel = event.channel;
      state.closeControl = () => channel.close();
      channel.onopen = () => { state.channelOpen = true; };
      channel.onmessage = event => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.action === 'webrtc-signal') signal(message.data.type, message.data.payload, 'datachannel');
      };
    };
    globalThis.WebSocket = class {
      readyState = 0;
      constructor() { socket = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      receive(message) { return this.onmessage?.({data: JSON.stringify(message)}); }
      send(text) {
        const message = JSON.parse(text);
        if (message.type === 'join') {
          state.joinCode = message.pairCode;
          setTimeout(() => this.receive({type: 'joined', roomId: 'room-1', userId: 'sender-1', hostUserId: 'host-1'}), 50);
        } else if (['offer', 'ice-candidate'].includes(message.type)) {
          // This is the same routing contract enforced by NearCast.
          if (message.hostUserId !== 'host-1' || message.targetId !== 'host-1') { state.error = 'missing host/target context'; return; }
          signal(message.type, message[message.type === 'ice-candidate' ? 'candidate' : message.type], 'websocket');
        }
      }
      close() { this.readyState = 3; this.onclose?.({code: 1000}); }
    };
    // Only capture is substituted. SDP, ICE, DTLS, SCTP and RTP use Edge.
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {value: async () => {
      if (state.mode === 'cancel') throw new DOMException('Cancelled by user', 'NotAllowedError');
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d');
      const timer = setInterval(() => { ctx.fillStyle = `hsl(${Date.now() % 360} 80% 50%)`; ctx.fillRect(0, 0, 320, 180); }, 40);
      const stream = canvas.captureStream(25);
      const track = stream.getVideoTracks()[0]; const stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      return stream;
    }});
    globalThis.__TAURI__ = {core: {invoke: async command => command === 'nearcast_platform_info' ? {os: 'windows', screenCapture: true} : false}, event: {listen: async () => () => {}}};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (const [index, value] of [...'1234'].entries()) await page.locator('.code-digit').nth(index).fill(value);
  await page.locator('#connect-button').click();
  await page.waitForFunction(() => testReceiver.releaseAnswer || testReceiver.error);
  assert.equal(await page.locator('#casting-view').isVisible(), true);
  assert.equal(await page.locator('#share-button').isDisabled(), true, 'sharing waits for the control connection');
  await page.evaluate(() => testReceiver.releaseAnswer());
  await page.waitForFunction(() => testReceiver.channelOpen || testReceiver.error);
  assert.equal(await page.evaluate(() => testReceiver.error), undefined);
  await page.evaluate(() => { testReceiver.mode = 'cancel'; });
  await page.locator('#share-button').click();
  assert.equal(await page.locator('#casting-view').isVisible(), true);
  assert.equal(await page.locator('#cast-error').isVisible(), true);
  await page.evaluate(() => { testReceiver.mode = 'capture'; });
  await page.locator('#share-button').click();
  await page.waitForFunction(() => testReceiver.frames > 0 || testReceiver.error);
  assert.equal(await page.evaluate(() => testReceiver.error), undefined);
  assert.equal(await page.locator('#preview-wrap').isVisible(), true);
  await page.locator('#stop-share-button').click();
  const beforeRestart = await page.evaluate(() => testReceiver.frames);
  await page.locator('#share-button').click();
  await page.waitForFunction(() => testReceiver.signals.filter(x => x.type === 'offer').length >= 3);
  await page.waitForFunction(before => testReceiver.frames >= before + 3 || testReceiver.error, beforeRestart);
  // A second active video m-line makes NearCast reject multiple_tracks_per_kind.
  const activeVideo = await page.evaluate(async () => {
    const preview = document.querySelector('#preview');
    return {state: preview.srcObject?.getVideoTracks()[0]?.readyState, tracks: testReceiver.receivedTracks, signals: testReceiver.signals};
  });
  assert.equal(activeVideo.state, 'live');
  assert.equal(activeVideo.tracks.filter(kind => kind === 'video').length, 1, 'reselect must reuse the existing video transceiver');
  assert.deepEqual(await page.evaluate(() => [...new Set(testReceiver.videoCodecs)]), ['H264'], 'NearCast accepts H.264 video only');
  assert.equal(activeVideo.signals.some(signal => signal.type === 'offer' && signal.transport === 'datachannel'), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({result: 'PASS', frames: await page.evaluate(() => testReceiver.frames), ...activeVideo}, null, 2));
  await page.evaluate(() => testReceiver.closeControl());
  await page.waitForFunction(() => !document.querySelector('#code-view').hidden);
  assert.equal(await page.locator('#code-view').isVisible(), true);
  assert.match(await page.locator('#code-error').textContent(), /控制通道.*关闭/);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
