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
  const page = await browser.newPage({viewport:{width:960,height:640}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const nativeMode=process.env.NATIVE_CAPTURE_TEST==='1';
  const thumbnail=[...await readFile(resolve('tests/fixtures/capture-thumbnail.bmp'))];
  await page.addInitScript(({nativeMode,thumbnail}) => {
    globalThis.testReceiver = {signals: [], receivedTracks: [], frames: 0, mode: 'capture',nativeMode,sourceMessages:[],inputRpcId:100};
    const state = globalThis.testReceiver;
    const receiver = new RTCPeerConnection({iceServers: []});
    state.receiverPeer=receiver;
    const NativePeer=globalThis.RTCPeerConnection;
    globalThis.RTCPeerConnection=new Proxy(NativePeer,{construct(target,args){const pc=Reflect.construct(target,args);state.senderPeer=pc;return pc;}});
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
      // Count actual decoder output. requestVideoFrameCallback stops when the
      // fixture video scrolls outside the viewport as the sender UI grows.
      if(!state.decodePoll)state.decodePoll=setInterval(async()=>{
        const stats=await receiver.getStats();
        state.frames=[...stats.values()].filter(row=>row.type==='inbound-rtp'&&row.kind==='video').reduce((sum,row)=>sum+(row.framesDecoded||0),0);
      },100);
    };
    receiver.ondatachannel = event => {
      channel = event.channel;
      state.closeControl = () => channel.close();
      state.sendMalformedInput = () => channel.send(new Uint8Array([1,2,3]));
      state.sendInputBytes = bytes => channel.send(bytes);
      const inputChannel=channel;let heartbeat,frameCodec,sessionCodec,heartbeatId=20;
      channel.binaryType='arraybuffer';
      channel.onopen = async () => {
        state.channelOpen = true; state.channelCount = (state.channelCount || 0) + 1;state.inputReady=false;
        frameCodec=await import('/touchback/frame-codec.mjs');sessionCodec=await import('/touchback/axtp-session.mjs');
        inputChannel.send(Uint8Array.from('4158010100160000000100010100010000040210000701070801010a0203e80b010034f2'.match(/../g),v=>parseInt(v,16)));
        heartbeat=setInterval(()=>{if(inputChannel.readyState==='open')inputChannel.send(frameCodec.encodeStandardFrame(sessionCodec.controlPayload(4,++heartbeatId),{payloadType:1}));},1000);
      };
      channel.onclose=()=>clearInterval(heartbeat);
      channel.onmessage = event => {
        if (typeof event.data !== 'string') {
          const frame=frameCodec.decodeStandardFrame(event.data);
          if(frame.payloadType===2){
            const message=JSON.parse(new TextDecoder().decode(frame.payload.subarray(1)));
            if(message.op===0)inputChannel.send(frameCodec.encodeStandardFrame(sessionCodec.rpcPayload({sid:'',op:2,d:{randomSeed:123,eventMasks:'050101'}}),{payloadType:2}));
            if(message.op===3){state.inputReady=true;state.inputSid=message.sid;inputChannel.send(JSON.stringify({action:'nearcast-input-target',data:{version:1,contractFingerprint:'feac6fa2a4b9c927708c077746166259ffeb7d5f06dc6972b29f1fc30954c2d0',runtimeInstanceId:'rx-runtime-1',target:{sessionId:'share-1',sessionGeneration:'1',slotId:'0',bindingGeneration:'1',lifecycleGeneration:'1'}}}));}
            if(message.op===8&&message.d.id>=100){if(message.d.status.code!==0){state.error=JSON.stringify(message);return;}state.inputActive=true;state.inputStreamId=message.d.result.streamId;}
          }
          return;
        }
        const message = JSON.parse(event.data);
        if (message.action === 'webrtc-signal') signal(message.data.type, message.data.payload, 'datachannel');
        if (message.action === 'nearcast-input-source') {
          state.sourceMessages.push(message.data);
          if(!message.data.available){state.inputActive=false;state.lastInputBinding=null;}
          if(message.data.available&&state.armInput&&state.lastInputBinding!==message.data.sourceBindingId){
            state.lastInputBinding=message.data.sourceBindingId;const id=++state.inputRpcId;
            inputChannel.send(frameCodec.encodeStandardFrame(sessionCodec.rpcPayload({sid:state.inputSid,op:7,d:{id,method:'input.openStream',params:{controlVersion:1,runtimeInstanceId:'rx-runtime-1',target:{sessionId:'share-1',sessionGeneration:'1',slotId:'0',bindingGeneration:'1',lifecycleGeneration:'1'},sourceBindingId:message.data.sourceBindingId,streamKind:'touchback',format:'input-sample-v1',inputTypes:['touch'],maxDataBytes:4096,touch:{maxContacts:10},commandId:`open-${id}`}}}),{payloadType:2}));
          }
        }
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
    let captureNumber=0;
    globalThis.__TAURI__ = {core: {invoke: async (command,args={}) => {
      if(command==='nearcast_platform_info')return{os:'windows',screenCapture:true,nativeCapture:nativeMode,touchback:nativeMode};
      if(command==='nearcast_capture_targets'){if(state.delayTargetSelection){await new Promise(resolve=>{state.releaseTargetSelection=resolve;});state.targetListReturned=true;}return[{targetId:'monitor-main',kind:'monitor',title:'Main monitor',primary:true,region:{x:0,y:0,width:1920,height:1080}},{targetId:'monitor-left',kind:'monitor',title:'Left monitor',primary:false,region:{x:-1920,y:0,width:1920,height:1080}},{targetId:'window-1',kind:'window',title:'Owned fixture window',region:{x:100,y:100,width:320,height:240}},...Array.from({length:20},(_,i)=>({targetId:`window-extra-${i}`,kind:'window',title:i===19?'Owned fixture window':'C:\\test\\'+'Long window title '.repeat(20)+i,region:{x:100,y:100,width:320,height:240}}))];}
      if(command==='nearcast_capture_thumbnail'){
        (state.thumbnailRequests??=[]).push(args.targetId);state.previewActive=(state.previewActive??0)+1;state.previewPeak=Math.max(state.previewPeak??0,state.previewActive);
        try{await new Promise(resolve=>setTimeout(resolve,20));if(args.targetId==='window-extra-0')throw new Error('preview unavailable');return Uint8Array.from(thumbnail).buffer;}finally{state.previewActive--;}
      }
      if(command==='nearcast_capture_start'){
        state.lastCaptureTargetId=args.targetId;const captureId=`native-${++captureNumber}`,left=args.targetId==='monitor-left';
        state.nativeGeometry={captureId,nativeId:`capture:${captureId}`,kind:left?'monitor':'window',revision:`r${captureNumber}`,units:'physical-pixels',rotation:0,region:{x:left?-1920:100,y:left?0:100,width:left?1920:320,height:left?1080:240},captureWidth:320,captureHeight:240,inputReady:true,disabledReason:null};state.nativeFrameId=0;return state.nativeGeometry;
      }
      if(command==='nearcast_capture_frame'){
        await new Promise(resolve=>setTimeout(resolve,35));const geometry=state.nativeGeometry;
        if(!geometry||geometry.captureId!==args.captureId)throw new Error('capture retired');
        const width=geometry.captureWidth,height=geometry.captureHeight;
        const meta=new TextEncoder().encode(JSON.stringify({captureId:geometry.captureId,frameId:++state.nativeFrameId,pixelFormat:'BGRA8',width,height,geometry}));
        const bytes=new Uint8Array(4+meta.length+width*height*4);new DataView(bytes.buffer).setUint32(0,meta.length);bytes.set(meta,4);for(let i=4+meta.length;i<bytes.length;i+=4){const top=i<4+meta.length+width*height*2;bytes.set(top?[80,state.nativeFrameId%255,180,255]:[180,state.nativeFrameId%255,80,255],i);}return bytes.buffer;
      }
      if(command==='nearcast_capture_stop'){if(state.nativeGeometry?.captureId===args.captureId){state.nativeGeometry=null;state.borderActive=false;state.nativeOwner=null;}return null;}
      if(command==='nearcast_capture_touch_feedback'){state.touchFeedback=args;return{updated:true};}
      if(command==='nearcast_capture_indicator'){
        if(args.active&&(!state.nativeOwner||state.nativeOwner.nativeId!==`capture:${args.captureId}`||state.nativeOwner.ownerId!==args.ownerId))throw new Error('unowned green request');
        state.borderActive=args.active;return null;
      }
      if(command==='nearcast_input_probe')return{nativeReady:true,inputTypes:['touch'],maxDataBytes:4096,touch:{maxContacts:10},geometry:{revision:state.nativeGeometry?.revision??'no-capture',displays:[{},{}],...(state.nativeGeometry?{capture:state.nativeGeometry}:{})}};
      if(command==='nearcast_input_prepare'){state.nativeOwner=args;return{status:'ready',leaseId:'local-test-lease'};}
      if(command==='nearcast_input_apply'){if(state.nativeApplyDelayMs)await new Promise(resolve=>setTimeout(resolve,state.nativeApplyDelayMs));state.lastNativeAction=args.action;state.nativeApplyCalls=(state.nativeApplyCalls??0)+1;return{status:'submitted',nativeDurationMs:1};}
      if(command==='nearcast_input_release'){state.nativeOwner=null;state.borderActive=false;return{status:'released'};}
      return false;
    }}, event: {listen: async () => () => {}}};
  },{nativeMode,thumbnail});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  let pickerPointerVerified=false;
  const share = async cancel => {
    await page.locator('#share-button').click();
    if(!nativeMode)return;
    await page.locator('#capture-picker').waitFor({state:'visible'});
    assert.equal(await page.locator('#capture-picker-confirm').isDisabled(),true,'reopening must clear previous selection');
    if(cancel){await page.locator('#capture-picker button[value="cancel"]').click();return;}
    assert.ok(await page.locator('#capture-target [role="radio"]').count()>=3,'capture targets must expose explicitly clickable single-selection rows');
    if(!pickerPointerVerified){
      const main=page.locator('[data-target-id="monitor-main"]'),left=page.locator('[data-target-id="monitor-left"]');
      await main.click();assert.equal(await main.getAttribute('aria-checked'),'true');assert.equal(await page.locator('#capture-picker-confirm').isEnabled(),true);
      await page.keyboard.press('ArrowUp');assert.equal(await left.getAttribute('aria-checked'),'true','grid navigation must handle fewer cards than columns');
      await page.keyboard.press('ArrowDown');assert.equal(await main.getAttribute('aria-checked'),'true');
      await page.keyboard.press('ArrowRight');assert.equal(await left.getAttribute('aria-checked'),'true');assert.equal(await main.getAttribute('aria-checked'),'false');
      await page.keyboard.press('Enter');assert.equal(await page.locator('#capture-picker').isVisible(),true,'selecting a row must not accidentally submit sharing');
      await page.waitForFunction(()=>document.querySelector('[data-target-id=monitor-main] img')?.naturalWidth===2);
      assert.equal(await page.evaluate(()=>testReceiver.thumbnailRequests.some(id=>id.startsWith('window-'))),false,'hidden window previews must remain lazy');
      assert.equal(await page.evaluate(()=>testReceiver.lastCaptureTargetId),undefined,'previewing must not start sharing');
      await page.getByRole('tab',{name:/窗口/}).click();assert.equal(await page.locator('#capture-picker-confirm').isDisabled(),true,'changing source kind clears selection');
      await page.waitForFunction(()=>document.querySelector('[data-target-id=window-extra-0] .capture-target-preview').dataset.status==='error');
      await page.locator('[data-target-id=window-extra-0]').click();assert.equal(await page.locator('#capture-picker-confirm').isEnabled(),true,'preview failure must not prevent selecting a target');
      const duplicate=page.locator('[data-target-id="window-extra-19"]');await duplicate.click();assert.equal(await duplicate.getAttribute('aria-checked'),'true');
      const bounds=await page.locator('#capture-target').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=960,'long window titles must remain inside the viewport');
      await page.setViewportSize({width:520,height:640});
      const small=await page.locator('#capture-target').boundingBox(),confirm=await page.locator('#capture-picker-confirm').boundingBox();
      assert.ok(small.x>=0&&small.x+small.width<=520,'thumbnail grid must fit a narrow sender window');
      assert.ok(confirm.y>=0&&confirm.y+confirm.height<=640,'share confirmation must remain visible');
      await page.setViewportSize({width:960,height:640});
      pickerPointerVerified=true;
    }
    await page.getByRole('tab',{name:/窗口/}).click();
    await page.locator('[data-target-id="window-1"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-target-id=window-1] img')?.naturalWidth===2);
    assert.ok(await page.evaluate(()=>testReceiver.previewPeak<=2),'native preview requests must be bounded');
    assert.equal(await page.locator('[data-target-id="window-1"]').getAttribute('aria-checked'),'true');
    assert.equal(await page.locator('#capture-picker-confirm').isEnabled(),true,'a real mouse click must select the capture target and enable sharing');
    if(process.env.BROWSER_SCREENSHOT)await page.screenshot({path:process.env.BROWSER_SCREENSHOT.replace(/\.png$/, '-picker.png')});
    await page.locator('#capture-picker-confirm').click();
    await page.waitForFunction(()=>testReceiver.lastCaptureTargetId==='window-1');
  };
  for (const [index, value] of [...'1234'].entries()) await page.locator('.code-digit').nth(index).fill(value);
  await page.locator('#connect-button').click();
  await page.waitForFunction(() => testReceiver.releaseAnswer || testReceiver.error);
  assert.equal(await page.locator('#casting-view').isVisible(), true);
  assert.equal(await page.locator('#input-enabled').isChecked(), false);
  assert.equal(await page.locator('#share-button').isDisabled(), true, 'sharing waits for the control connection');
  await page.evaluate(() => testReceiver.releaseAnswer());
  await page.waitForFunction(() => testReceiver.channelOpen || testReceiver.error);
  assert.equal(await page.evaluate(() => testReceiver.error), undefined);
  await page.evaluate(() => { testReceiver.mode = 'cancel'; });
  await share(true);
  assert.equal(await page.locator('#casting-view').isVisible(), true);
  await page.locator('#cast-error').waitFor({state:'visible'});
  assert.equal(await page.locator('#cast-error').isVisible(), true);
  await page.evaluate(() => { testReceiver.mode = 'capture'; });
  await share(false);
  await page.waitForFunction(() => testReceiver.frames > 0 || testReceiver.error);
  assert.equal(await page.evaluate(() => testReceiver.error), undefined);
  assert.equal(await page.locator('#preview-wrap').isVisible(), true);
  if(nativeMode){
    assert.equal(await page.locator('#touch-feedback-enabled').count(),1,'Windows native input exposes the circle switch');
    assert.equal(await page.locator('#touch-feedback-enabled').isChecked(),true);
    const colors=await page.evaluate(()=>{const video=document.querySelector('#preview'),canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0);return[...ctx.getImageData(100,40,1,1).data,...ctx.getImageData(100,200,1,1).data];});
    assert.ok(colors[0]>colors[2]+60&&colors[4]<colors[6]-60,'native BGRA must be GPU-swizzled to upright RGB');
  }
  await page.locator('#stop-share-button').click();
  const beforeRestart = await page.evaluate(() => testReceiver.frames);
  await share(false);
  await page.waitForFunction(() => testReceiver.signals.filter(x => x.type === 'offer').length >= 3);
  await page.waitForFunction(before => testReceiver.frames >= before + 3 || testReceiver.error, beforeRestart).catch(async failure=>{
    console.log(JSON.stringify(await page.evaluate(async()=>{
      const state=testReceiver;const stats=pc=>pc.getStats().then(rows=>[...rows.values()].filter(row=>['outbound-rtp','inbound-rtp'].includes(row.type)));
      return{error:state.error,frames:state.frames,signals:state.signals,errors:[document.querySelector('#cast-error').textContent,document.querySelector('#code-error').textContent],sender:{connection:state.senderPeer.connectionState,signaling:state.senderPeer.signalingState,stats:await stats(state.senderPeer)},receiver:{connection:state.receiverPeer.connectionState,signaling:state.receiverPeer.signalingState,stats:await stats(state.receiverPeer)},input:__nearcastTouchbackDiagnostics()};
    }),null,2));throw failure;
  });
  // A second active video m-line makes NearCast reject multiple_tracks_per_kind.
  const activeVideo = await page.evaluate(async () => {
    const preview = document.querySelector('#preview');
    return {state: preview.srcObject?.getVideoTracks()[0]?.readyState, tracks: testReceiver.receivedTracks, signals: testReceiver.signals};
  });
  assert.equal(activeVideo.state, 'live');
  assert.equal(activeVideo.tracks.filter(kind => kind === 'video').length, 1, 'reselect must reuse the existing video transceiver');
  assert.deepEqual(await page.evaluate(() => [...new Set(testReceiver.videoCodecs)]), ['H264'], 'NearCast accepts H.264 video only');
  assert.equal(activeVideo.signals.some(signal => signal.type === 'offer' && signal.transport === 'datachannel'), true);
  if(nativeMode){
    await page.evaluate(()=>{testReceiver.armInput=true;});await page.locator('#input-enabled').check();
    await page.waitForFunction(()=>testReceiver.inputActive&&testReceiver.borderActive||testReceiver.error);
    assert.equal(await page.evaluate(()=>testReceiver.error),undefined);
    await page.evaluate(async()=>{const {encodeInputFrame}=await import('/touchback/typed-codec.mjs');testReceiver.sendSample=async(seqId,phase,x,y)=>{
      const bytes=encodeInputFrame({streamId:testReceiver.inputStreamId,seqId,cursor:seqId,inputType:'touch',records:[{contactId:65535,phase,x,y}]});
      // sendMalformedInput closes over the receiver-owned control channel.
      testReceiver.sendInputBytes(bytes);
    };await testReceiver.sendSample(1,0,65535,0);});
    await page.waitForFunction(()=>testReceiver.lastNativeAction?.records[0].x===419);
    assert.equal(await page.evaluate(()=>testReceiver.lastNativeAction.records[0].y),100);
    await page.waitForFunction(()=>testReceiver.touchFeedback?.points.some(p=>p.x===419&&p.y===100&&p.submitted)).catch(async error=>{console.log(JSON.stringify(await page.evaluate(()=>({feedback:testReceiver.touchFeedback,diagnostics:__nearcastTouchbackDiagnostics()})),null,2));throw error;});
    const injected=await page.evaluate(()=>testReceiver.nativeApplyCalls);
    await page.locator('#touch-feedback-enabled').uncheck();await page.waitForFunction(()=>testReceiver.touchFeedback?.points.length===0);
    assert.equal(await page.evaluate(()=>testReceiver.nativeApplyCalls),injected,'circle visibility cannot inject input');
    await page.locator('#touch-feedback-enabled').check();
    await page.evaluate(()=>testReceiver.sendSample(2,2,65535,0));
    const oldId=await page.evaluate(()=>testReceiver.inputStreamId);
    await page.evaluate(()=>{testReceiver.nativeGeometry={...testReceiver.nativeGeometry,revision:'window-moved',region:{...testReceiver.nativeGeometry.region,x:500}};});
    await page.waitForFunction(old=>testReceiver.inputStreamId>old&&testReceiver.borderActive||testReceiver.error,oldId);
    assert.equal(await page.evaluate(()=>testReceiver.error),undefined);
    await page.evaluate(()=>testReceiver.sendSample(1,0,0,0));
    await page.waitForFunction(()=>testReceiver.lastNativeAction?.records[0].x===500);
    await page.evaluate(()=>testReceiver.sendSample(2,2,0,0));
    const movedId=await page.evaluate(()=>testReceiver.inputStreamId);
    await page.evaluate(()=>{testReceiver.nativeGeometry={...testReceiver.nativeGeometry,revision:'window-resized',captureWidth:400,captureHeight:200,region:{...testReceiver.nativeGeometry.region,width:400,height:200}};});
    await page.waitForFunction(old=>testReceiver.inputStreamId>old&&testReceiver.borderActive||testReceiver.error,movedId);
    await page.waitForFunction(()=>document.querySelector('#preview').videoWidth===400&&document.querySelector('#preview').videoHeight===200);
    assert.equal(await page.evaluate(()=>testReceiver.error),undefined);
    await page.evaluate(()=>testReceiver.sendSample(1,0,65535,65535));
    await page.waitForFunction(()=>testReceiver.lastNativeAction?.records[0].x===899&&testReceiver.lastNativeAction?.records[0].y===299);
    await page.evaluate(()=>testReceiver.sendSample(2,2,65535,65535));
    await page.evaluate(()=>{testReceiver.nativeGeometry={...testReceiver.nativeGeometry,inputReady:false,disabledReason:'capture_window_not_foreground'};});
    await page.waitForFunction(()=>!__nearcastTouchbackDiagnostics().sourceReady&&!testReceiver.borderActive);
    const paused=await page.evaluate(()=>testReceiver.frames);await page.waitForFunction(before=>testReceiver.frames>before+2,paused);
    await page.evaluate(()=>{testReceiver.nativeGeometry={...testReceiver.nativeGeometry,inputReady:true,disabledReason:null};});
    await page.waitForFunction(()=>testReceiver.inputActive&&testReceiver.borderActive||testReceiver.error);
    assert.equal(await page.evaluate(()=>testReceiver.error),undefined);
    const beforeDrag=await page.evaluate(()=>testReceiver.frames);
    await page.evaluate(async()=>{
      testReceiver.nativeApplyDelayMs=170;let seq=1;
      await testReceiver.sendSample(seq,0,1000,1000);
      const until=performance.now()+5000;
      while(performance.now()<until){await new Promise(resolve=>setTimeout(resolve,4));await testReceiver.sendSample(++seq,1,(seq*67)%60000,1000);}
      await testReceiver.sendSample(++seq,2,2000,1000);testReceiver.dragFinalSeq=seq;
    });
    await page.waitForFunction(()=>{const d=__nearcastTouchbackDiagnostics();return d.state==='active'&&d.touchContacts===0&&d.queueLength===0;});
    const drag=await page.evaluate(()=>({diagnostics:__nearcastTouchbackDiagnostics(),frames:testReceiver.frames,error:testReceiver.error}));
    assert.equal(drag.error,undefined);assert.equal(drag.diagnostics.lastError,null);assert.equal(drag.diagnostics.controlChannelReady,true);
    assert.ok(drag.diagnostics.coalescedSamples>30,'slow native calls must not accumulate every motion sample');
    assert.ok(drag.diagnostics.queuePeak<=3);assert.equal(drag.diagnostics.lastNativeExecutionMs,1);
    assert.ok(drag.frames>beforeDrag+5,'video must continue during sustained slow input');
    await page.evaluate(()=>{testReceiver.nativeApplyDelayMs=0;});
  }
  assert.deepEqual(errors, []);
  await page.evaluate(() => testReceiver.sendMalformedInput());
  await page.waitForFunction(() => !document.querySelector('#input-reconnect').disabled);
  assert.equal(await page.locator('#casting-view').isVisible(), true);
  const beforeClose=await page.evaluate(()=>testReceiver.frames);
  await page.waitForFunction(before=>testReceiver.frames>=before+3,beforeClose);
  assert.equal(await page.evaluate(()=>document.querySelector('#preview').srcObject.getVideoTracks()[0].readyState),'live');
  await page.locator('#input-reconnect').click();
  await page.waitForFunction(()=>testReceiver.channelCount===2);
  await page.waitForFunction(()=>__nearcastTouchbackDiagnostics()?.appReady);
  assert.equal(await page.locator('#casting-view').isVisible(), true);
  await page.locator('#input-reconnect').click();
  await page.waitForFunction(()=>testReceiver.channelCount===3&&__nearcastTouchbackDiagnostics()?.appReady);
  if(process.env.BROWSER_SCREENSHOT)await page.screenshot({path:process.env.BROWSER_SCREENSHOT,fullPage:true});
  if(nativeMode){
    await page.locator('#stop-share-button').click();
    await page.evaluate(()=>{testReceiver.delayTargetSelection=true;});
    await page.locator('#share-button').click();
    await page.waitForFunction(()=>testReceiver.releaseTargetSelection);
  }
  await page.locator('#leave-button').click();
  if(nativeMode){await page.evaluate(()=>testReceiver.releaseTargetSelection());await page.waitForFunction(()=>testReceiver.targetListReturned);assert.equal(await page.locator('#capture-picker').isVisible(),false,'late target enumeration must not open a picker after leaving');}
  await page.waitForFunction(() => !document.querySelector('#code-view').hidden);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({result: 'PASS', nativeCapture:nativeMode, pickerPointerAndKeyboard:pickerPointerVerified, slowNativeMotionCoalescing:nativeMode, geometryRebinding:nativeMode, foregroundPausePreservesVideo:nativeMode, mediaSurvivedMalformedInput:true, controlChannels:await page.evaluate(()=>testReceiver.channelCount), frames: await page.evaluate(() => testReceiver.frames), ...activeVideo}, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
