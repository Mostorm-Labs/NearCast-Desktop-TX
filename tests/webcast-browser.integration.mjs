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
  const pcmFixture=process.env.NEARCAST_AUDIO_PCM_FIXTURE?[...await readFile(process.env.NEARCAST_AUDIO_PCM_FIXTURE)]:null;
  await page.addInitScript(({pcmFixture}) => {
    globalThis.testReceiver = {signals: [], receivedTracks: [], frames: 0, mode: 'capture',sourceMessages:[],inputRpcId:100,discoveryListeners:{}};
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
      if(event.track.kind==='audio')return;
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
          // Mirrors the paired RX cd598cd SourceMayResume contract. Ordinary
          // capture gaps must not be advertised as permanent revocations.
          if(!message.data.available&&state.enforceResumeReasons&&state.armInput&&
            !['','NATIVE_GEOMETRY_UNAVAILABLE','CAPTURE_GEOMETRY_CHANGED','CAPTURE_WINDOW_NOT_FOREGROUND','CAPTURE_WINDOW_MINIMIZED','CAPTURE_CHANGED','CAPTURE_MUTED'].includes(message.data.disabledReason??'')){
            state.armInput=false;(state.canceledInputReasons??=[]).push(message.data.disabledReason);
          }
          if(!message.data.available){state.inputActive=false;state.lastInputBinding=null;}
          if(message.data.available&&state.armInput&&state.lastInputBinding!==message.data.sourceBindingId){
            state.lastInputBinding=message.data.sourceBindingId;const id=++state.inputRpcId;
            const inputTypes=state.requestedInputTypes??['touch'];
            inputChannel.send(frameCodec.encodeStandardFrame(sessionCodec.rpcPayload({sid:state.inputSid,op:7,d:{id,method:'input.openStream',params:{controlVersion:1,runtimeInstanceId:'rx-runtime-1',target:{sessionId:'share-1',sessionGeneration:'1',slotId:'0',bindingGeneration:'1',lifecycleGeneration:'1'},sourceBindingId:message.data.sourceBindingId,streamKind:'touchback',format:'input-sample-v1',inputTypes,maxDataBytes:4096,...(inputTypes.includes('touch')?{touch:{maxContacts:10}}:{}),...(inputTypes.includes('mouse')?{mouse:{buttonsMask:31,modifierMask:15,allowChords:true,wheelUnits:['detent120','regionQ16_16'],continuousScroll:true}}:{}),commandId:`open-${id}`}}}),{payloadType:2}));
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
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {value: async options => {
      state.browserPickerCalls=(state.browserPickerCalls??0)+1;
      state.captureOptions=options;
      if (state.mode === 'cancel') throw new DOMException('Cancelled by user', 'NotAllowedError');
      const canvas = document.createElement('canvas');
      const width=state.testCalibration?1920:320,height=state.testCalibration?1080:180;
      canvas.width=width;canvas.height=height;
      const ctx = canvas.getContext('2d');
      const timer = setInterval(() => {
        ctx.fillStyle = 'hsl('+(Date.now()%360)+' 80% 50%)';ctx.fillRect(0,0,width,height);
        if(state.markerPatterns)for(let corner=0;corner<4;corner++){
          const {rect,bits}=state.markerPatterns[corner];
          bits.forEach((bit,i)=>{ctx.fillStyle=bit?'white':'black';ctx.fillRect(rect.x+(i%12)*8,rect.y+Math.floor(i/12)*8,8,8);});
        }
      },40);
      const stream = canvas.captureStream(25);
      const track = stream.getVideoTracks()[0]; const stop = track.stop.bind(track);const settings=track.getSettings.bind(track);
      track.getSettings=()=>({...settings(),displaySurface:state.captureKind??'monitor',width,height});
      track.stop = () => { clearInterval(timer); stop(); };
      state.browserVideoTrack=track;return stream;
    }});
    let audioCaptureId=null,audioSequence=0,audioPosition=0;
    globalThis.__TAURI__ = {core: {invoke: async (command,args={}) => {
      if(command==='nearcast_platform_info')return{os:'windows',screenCapture:true,nativeCapture:false,captureBackend:'browser',systemAudio:true,touchback:true};
      if(command==='nearcast_mdns_start'){state.discoveryServices=args.services;return null;}
      if(command.startsWith('nearcast_capture_'))throw new Error('Browser default must not invoke WGC/preview IPC: '+command);
      if(command==='nearcast_diagnostics_record'){(state.logSamples??=[]).push(args.sample);return null;}
      if(command==='nearcast_diagnostics_export')return 'C:/diagnostics/nearcast-diagnostics-test.json';
      if(command==='nearcast_display_binding_begin'){
        if(!state.testCalibration)throw new Error('Calibration disabled in fixture');
        const {markerBits,markerRect}=await import('/capture/display-binding.mjs');
        const displays=[0,1].map(i=>({nativeId:'DISPLAY'+i,primary:i===0,units:'physical-pixels',rotation:0,region:{x:i===0?0:-1920,y:0,width:1920,height:1080},captureWidth:1920,captureHeight:1080,token:i===0?'1111111111111111':'2222222222222222'}));
        const selected=displays[state.selectedDisplay??1];
        state.markerPatterns=[0,1,2,3].map(corner=>({rect:markerRect(1920,1080,corner),bits:markerBits(selected.token,corner)}));
        state.challenge={sourceId:args.sourceId,challengeId:'challenge-'+args.sourceId,timeoutMs:5000,displays};
        return state.challenge;
      }
      if(command==='nearcast_display_binding_confirm'){
        const challenge=state.challenge,selected=challenge.displays[state.selectedDisplay??1];
        if(args.sourceId!==challenge.sourceId||args.challengeId!==challenge.challengeId||args.token!==selected.token||args.corners.join(',')!=='0,1,2,3')throw new Error('Invalid calibration observation');
        state.markerPatterns=null;
        state.browserBinding={sourceId:args.sourceId,bindingId:'bound-'+args.sourceId,nativeId:'screen-binding:'+args.sourceId,revision:'bound-'+args.sourceId,layoutRevision:state.displayRevision??'single-display',kind:'monitor',units:'physical-pixels',rotation:0,region:selected.region,captureWidth:1920,captureHeight:1080};
        return state.browserBinding;
      }
      if(command==='nearcast_display_binding_cancel'){state.markerPatterns=null;return null;}
      if(command==='nearcast_display_binding_release'){
        if(state.browserBinding?.sourceId===args.sourceId){state.releasedBinding=state.browserBinding;state.browserBinding=null;}
        return null;
      }
      if(command==='nearcast_system_audio_start'){
        audioCaptureId=args.captureId;audioSequence=0;audioPosition=0;state.audioStarts=(state.audioStarts??0)+1;
        return{source:'wasapi-loopback',sampleRate:48000,channels:2};
      }
      if(command==='nearcast_audio_read'){
        await new Promise(resolve=>setTimeout(resolve,20));
        if(audioCaptureId!==args.captureId||!audioCaptureId)throw new Error('audio retired');
        const meta=new TextEncoder().encode(JSON.stringify({captureId:audioCaptureId,format:'f32le',sampleRate:48000,channels:2,frames:960,sequence:++audioSequence,discontinuities:0}));
        const bytes=new Uint8Array(4+meta.length+960*8),view=new DataView(bytes.buffer);view.setUint32(0,meta.length);bytes.set(meta,4);
        const fixture=pcmFixture?new DataView(Uint8Array.from(pcmFixture).buffer):null;
        for(let i=0;i<960*2;i++){
          const sample=fixture?fixture.getFloat32((audioPosition++%(fixture.byteLength/4))*4,true):0.2*Math.sin(audioPosition++*Math.PI*440/48000);
          view.setFloat32(4+meta.length+i*4,sample,true);
        }
        return bytes.buffer;
      }
      if(command==='nearcast_audio_stop'){
        if(audioCaptureId===args.captureId)audioCaptureId=null;
        state.audioStops=(state.audioStops??0)+1;return null;
      }
      if(command==='nearcast_input_probe'){
        const width=state.testCalibration?1920:320,height=state.testCalibration?1080:180;
        return{nativeReady:true,inputTypes:['touch','mouse'],maxDataBytes:4096,touch:{maxContacts:10},mouse:{buttonsMask:31,modifierMask:15,allowChords:true,wheelUnits:['detent120','regionQ16_16'],continuousScroll:true},geometry:{browserBinding:state.browserBinding,revision:state.displayRevision??'single-display',displays:Array.from({length:state.displayCount??1},(_,i)=>({nativeId:'DISPLAY'+i,primary:i===0,units:'physical-pixels',rotation:0,region:{x:i===0?0:-width,y:0,width,height},captureWidth:width,captureHeight:height}))}};
      }
      if(command==='nearcast_input_prepare'){state.nativeOwner=args;return{status:'ready',leaseId:'local-test-lease'};}
      if(command==='nearcast_input_apply'){
        if(state.nativeApplyDelayMs)await new Promise(resolve=>setTimeout(resolve,state.nativeApplyDelayMs));
        state.lastNativeAction=args.action;state.nativeApplyCalls=(state.nativeApplyCalls??0)+1;
        if(args.action.inputType==='mouse'&&args.action.eventKind===2){state.wheelTotalX=(state.wheelTotalX??0)+args.action.wheelX;state.wheelTotalY=(state.wheelTotalY??0)+args.action.wheelY;}
        return{status:'submitted',nativeDurationMs:1,inputType:args.action.inputType,nativeApi:args.action.inputType==='mouse'?'SendInput':'InjectTouchInput'};
      }
      if(command==='nearcast_input_release'){state.nativeOwner=null;state.borderActive=false;return{status:'released'};}
      return false;
    }}, event: {listen: async (name,callback) => {state.discoveryListeners[name]=callback;return()=>delete state.discoveryListeners[name];}}};
  },{pcmFixture});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>testReceiver.discoveryServices);
  assert.deepEqual(await page.evaluate(()=>testReceiver.discoveryServices),['_nearcast._tcp']);
  await page.evaluate(()=>{
    const service=serviceType=>({serviceType,instance:'Board.'+serviceType,hostname:'board.local.',port:8443,addresses:['192.0.2.21'],txt:{id:'board',display:'Test NearCast Board',capability:'webcast'}});
    for(const type of ['_nearcast._tcp.local.','_airplay._tcp.local.','_raop._tcp.local.'])testReceiver.discoveryListeners['nearcast://mdns-service']({payload:service(type)});
  });
  assert.equal(await page.locator('.device-row').count(),1);
  assert.equal(await page.locator('.device-name').textContent(),'Test NearCast Board');
  assert.deepEqual(await page.locator('.group-title').allTextContents(),['NEARCAST RECEIVERS']);
  assert.match(await page.locator('#device-status').textContent(),/^1 device found/);
  const share=async()=>{await page.locator('#share-button').click();};
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
  await page.waitForFunction(async()=>[...await testReceiver.receiverPeer.getStats()].some(([,row])=>row.type==='inbound-rtp'&&row.kind==='audio'&&row.totalAudioEnergy>0.00001));
  assert.equal(await page.evaluate(()=>testReceiver.browserPickerCalls),2,'one picker for cancellation and one successful selection');
  assert.equal(await page.evaluate(()=>testReceiver.captureOptions.audio),false,'Windows audio must not open another display picker');
  assert.equal(await page.evaluate(()=>document.querySelector('#preview').srcObject.getVideoTracks()[0]===testReceiver.browserVideoTrack),true,'the original browser track must reach preview/WebRTC');
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().capture.backend),'browser');
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().capture.audio.state),'capturing');
  await page.locator('#stop-share-button').click();
  const beforeRestart = await page.evaluate(() => testReceiver.frames);
  await share(false);
  await page.waitForFunction(() => testReceiver.signals.filter(x => x.type === 'offer').length >= 3);
  await page.waitForFunction(before => testReceiver.frames >= before + 3 || testReceiver.error, beforeRestart);
  assert.equal(await page.evaluate(()=>testReceiver.receivedTracks.filter(t=>t==='video').length),1);
  assert.equal(await page.evaluate(()=>testReceiver.receivedTracks.filter(t=>t==='audio').length),1);
  assert.deepEqual(await page.evaluate(()=>[...new Set(testReceiver.videoCodecs)]),['H264']);
  assert.equal(await page.evaluate(async()=>{
    const stats=await testReceiver.senderPeer.getStats();
    const audio=[...stats.values()].find(r=>r.type==='outbound-rtp'&&r.kind==='audio');
    return stats.get(audio.codecId).mimeType.toLowerCase();
  }),'audio/opus');
  await page.evaluate(()=>{testReceiver.armInput=true;});await page.locator('#input-enabled').check();
  await page.waitForFunction(()=>testReceiver.inputActive||testReceiver.error);
  assert.equal(await page.evaluate(()=>testReceiver.error),undefined);
  await page.evaluate(async()=>{
    const {encodeInputFrame}=await import('/touchback/typed-codec.mjs');
    testReceiver.sendSample=(seqId,phase)=>testReceiver.sendInputBytes(encodeInputFrame({
      streamId:testReceiver.inputStreamId,seqId,cursor:seqId,inputType:'touch',
      records:[{contactId:65535,phase,x:65535,y:65535}],
    }));
    testReceiver.sendSample(1,0);
  });
  await page.waitForFunction(()=>testReceiver.lastNativeAction?.records[0].x===319);
  assert.equal(await page.evaluate(()=>testReceiver.lastNativeAction.records[0].y),179);
  await page.evaluate(()=>testReceiver.sendSample(2,2));
  await page.waitForFunction(()=>__nearcastTouchbackDiagnostics().touchContacts===0);
  for(const [kind,displays,blocked] of [['window',1,'BROWSER_WINDOW_INPUT_UNSUPPORTED'],['monitor',2,'BROWSER_MULTIPLE_DISPLAYS_UNPROVEN'],['monitor',1,null]]){
    await page.locator('#stop-share-button').click();
    await page.evaluate(([kind,count])=>{testReceiver.captureKind=kind;testReceiver.displayCount=count;},[kind,displays]);
    await share();
    await page.waitForFunction(()=>document.querySelector('#preview').srcObject?.getVideoTracks()[0]?.readyState==='live');
    if(blocked){
      await page.waitForFunction(reason=>__nearcastTouchbackDiagnostics().detail?.includes(reason),blocked);
      assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().sourceReady),false);
    }else await page.waitForFunction(()=>testReceiver.inputActive&&__nearcastTouchbackDiagnostics().sourceReady);
    const before=await page.evaluate(()=>testReceiver.frames);
    await page.waitForFunction(n=>testReceiver.frames>n+2,before);
    assert.equal(await page.evaluate(()=>testReceiver.receivedTracks.filter(t=>t==='video').length),1);
    assert.equal(await page.evaluate(()=>testReceiver.receivedTracks.filter(t=>t==='audio').length),1);
  }
  // Production pixel matching against an actual browser video frame, using a
  // deterministic native bridge fixture. Same-sized displays cannot be guessed.
  await page.locator('#stop-share-button').click();
  await page.evaluate(()=>{testReceiver.testCalibration=true;testReceiver.displayCount=2;testReceiver.selectedDisplay=1;});
  await share();
  await page.waitForFunction(()=>testReceiver.inputActive&&__nearcastTouchbackDiagnostics().sourceReady);
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().capture.displayBinding.state),'bound');
  await page.evaluate(()=>testReceiver.sendSample(1,0));
  await page.waitForFunction(()=>testReceiver.lastNativeAction?.records[0].x===-1);
  assert.equal(await page.evaluate(()=>testReceiver.lastNativeAction.records[0].y),1079);
  await page.evaluate(()=>testReceiver.sendSample(2,2));
  await page.waitForFunction(()=>__nearcastTouchbackDiagnostics().touchContacts===0);
  await page.evaluate(()=>{testReceiver.displayRevision='layout-changed';});
  await page.waitForFunction(()=>__nearcastTouchbackDiagnostics().detail?.includes('BROWSER_DISPLAY_LAYOUT_CHANGED'));
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().sourceReady),false);
  const afterLayoutChange=await page.evaluate(()=>testReceiver.frames);
  await page.waitForFunction(n=>testReceiver.frames>n+2,afterLayoutChange);
  await page.locator('#stop-share-button').click();
  assert.equal(await page.evaluate(()=>testReceiver.browserBinding),null);
  assert.ok(await page.evaluate(()=>testReceiver.releasedBinding?.sourceId));
  await page.evaluate(()=>{testReceiver.selectedDisplay=0;});
  await share();
  await page.waitForFunction(()=>testReceiver.inputActive&&__nearcastTouchbackDiagnostics().sourceReady);
  await page.evaluate(()=>testReceiver.sendSample(1,0));
  await page.waitForFunction(()=>testReceiver.lastNativeAction?.records[0].x===1919);
  await page.evaluate(()=>testReceiver.sendSample(2,2));
  await page.waitForFunction(()=>__nearcastTouchbackDiagnostics().touchContacts===0);
  const beforeMouse=await page.evaluate(()=>({frames:testReceiver.frames,streamId:testReceiver.inputStreamId}));
  await page.evaluate(()=>{testReceiver.requestedInputTypes=['mouse'];});
  await page.locator('#input-enabled').uncheck();await page.locator('#input-enabled').check();
  await page.waitForFunction(id=>testReceiver.inputStreamId>id&&__nearcastTouchbackDiagnostics().acceptedInputTypes.join(',')==='mouse',beforeMouse.streamId);
  assert.equal(await page.evaluate(()=>testReceiver.nativeOwner.maxContacts),0);
  await page.evaluate(async()=>{
    const {encodeInputFrame}=await import('/touchback/typed-codec.mjs');
    const records=[
      {eventKind:0,buttons:0,modifiers:0,x:65535,y:32768},
      {eventKind:1,buttons:1,modifiers:2,x:65535,y:32768},
      {eventKind:0,buttons:1,modifiers:2,x:65535,y:32768},
      {eventKind:2,buttons:1,modifiers:2,x:65535,y:32768,wheelUnit:0,wheelPhase:0,wheelX:-120,wheelY:240},
      {eventKind:1,buttons:0,modifiers:0,x:65535,y:32768},
      {eventKind:4,modifiers:3},
      {eventKind:3},
    ];
    for(const [i,record]of records.entries()){
      testReceiver.sendInputBytes(encodeInputFrame({streamId:testReceiver.inputStreamId,seqId:i+1,cursor:i+1,inputType:'mouse',...record}));
      await new Promise(resolve=>setTimeout(resolve,30));
    }
  });
  await page.waitForFunction(()=>testReceiver.lastNativeAction?.inputType==='mouse'&&testReceiver.lastNativeAction.eventKind===3&&__nearcastTouchbackDiagnostics().submittedSeqId===7);
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().mouseButtons),0);
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().mouseModifiers),0);
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().control.receivedMouseSamples),7);
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().nativeInput.lastSubmission.nativeApi),'SendInput');
  await page.waitForFunction(n=>testReceiver.frames>n+2,beforeMouse.frames);
  // Reproduce real RX gesture scrolling faster than a ~20ms native bridge.
  // Deltas must all reach the native fixture while video and control stay live.
  const beforeWheel=await page.evaluate(()=>({frames:testReceiver.frames,calls:testReceiver.nativeApplyCalls,coalesced:__nearcastTouchbackDiagnostics().coalescedSamples}));
  await page.evaluate(async()=>{
    const {encodeInputFrame}=await import('/touchback/typed-codec.mjs');
    testReceiver.nativeApplyDelayMs=20;testReceiver.wheelTotalX=0;testReceiver.wheelTotalY=0;
    for(let i=0;i<122;i++){
      const phase=i===0?1:i===121?3:2,terminal=phase===3;
      testReceiver.sendInputBytes(encodeInputFrame({streamId:testReceiver.inputStreamId,seqId:i+8,cursor:i+8,inputType:'mouse',eventKind:2,buttons:0,modifiers:0,
        x:32768,y:32768,wheelUnit:1,wheelPhase:phase,wheelX:terminal?0:64,wheelY:terminal?0:-128}));
      await new Promise(resolve=>setTimeout(resolve,4));
    }
  });
  await page.waitForFunction(()=>__nearcastTouchbackDiagnostics().submittedSeqId===129||!__nearcastTouchbackDiagnostics().controlChannelReady);
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().controlChannelReady),true);
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().state),'active');
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().scrollActive),false);
  assert.deepEqual(await page.evaluate(()=>[testReceiver.wheelTotalX,testReceiver.wheelTotalY]),[121*64,-121*128]);
  assert.ok(await page.evaluate(n=>__nearcastTouchbackDiagnostics().coalescedSamples>n,beforeWheel.coalesced));
  assert.ok(await page.evaluate(n=>testReceiver.nativeApplyCalls-n<100,beforeWheel.calls));
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().lastNativeExecutionMs),1);
  await page.waitForFunction(n=>testReceiver.frames>n+2,beforeWheel.frames);
  await page.evaluate(()=>{testReceiver.nativeApplyDelayMs=0;});
  const mouseStream=await page.evaluate(()=>testReceiver.inputStreamId);
  await page.evaluate(()=>{testReceiver.requestedInputTypes=['touch'];});
  await page.locator('#input-enabled').uncheck();await page.locator('#input-enabled').check();
  await page.waitForFunction(id=>testReceiver.inputStreamId>id&&__nearcastTouchbackDiagnostics().acceptedInputTypes.join(',')==='touch',mouseStream);
  await page.evaluate(()=>testReceiver.sendSample(1,0));await page.waitForFunction(()=>__nearcastTouchbackDiagnostics().submittedSeqId===1);
  await page.evaluate(()=>testReceiver.sendSample(2,2));await page.waitForFunction(()=>__nearcastTouchbackDiagnostics().submittedSeqId===2);
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>testReceiver.sendMalformedInput());
  await page.waitForFunction(()=>!document.querySelector('#input-reconnect').disabled);
  const beforeFault=await page.evaluate(()=>testReceiver.frames);
  await page.waitForFunction(n=>testReceiver.frames>n+2,beforeFault);
  await page.locator('#input-reconnect').click();
  await page.waitForFunction(()=>testReceiver.channelCount===2&&__nearcastTouchbackDiagnostics()?.appReady);
  await page.locator('#leave-button').click();
  await page.waitForFunction(()=>!document.querySelector('#code-view').hidden);
  await page.waitForFunction(()=>testReceiver.audioStops===testReceiver.audioStarts);
  assert.equal(await page.evaluate(()=>document.querySelector('#preview').srcObject),null);
  await page.locator('#export-diagnostics').click();
  await page.waitForFunction(()=>document.querySelector('#diagnostics-export-status').textContent.includes('nearcast-diagnostics-test.json'));
  assert.ok((await page.evaluate(()=>testReceiver.logSamples)).every(row=>Object.keys(row).every(key=>['event','status','metrics'].includes(key))));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',videoBackend:'browser',originalTrack:true,independentPcmOpus:true,screenOnlyInput:true,multiDisplayCalibration:true,negativeCoordinates:true,layoutInvalidation:true,screenReselection:true,touchMouseTouch:true,wheelBackpressure:true,windowAndMultiDisplayVideo:true,senderReuse:true,frames:await page.evaluate(()=>testReceiver.frames)},null,2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
