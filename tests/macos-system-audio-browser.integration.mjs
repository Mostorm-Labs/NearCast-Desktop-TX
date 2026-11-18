// Real AudioWorklet/Opus/RTP with the macOS fallback path. Only the system
// picker and native PCM IPC are fixtures; no microphone or speakers are used.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=resolve('dist');
const server=createServer(async(req,res)=>{
  try{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/fixture'){res.setHeader('content-type','text/html');res.end('<button id="start">Share</button><video id="remote" autoplay muted playsinline></video>');return;}
    const file=resolve(root,'.'+pathname);if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
    res.setHeader('content-type',extname(file)==='.mjs'?'text/javascript':'text/html');res.end(await readFile(file));
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/fixture');
  await page.evaluate(async()=>{
    const {BrowserCaptureMediaDevices}=await import('/capture/browser-capture.mjs');
    const state=globalThis.audioFixture={starts:0,stops:0,fail:false};
    let owner,sequence=0,position=0,timer;
    state.provider=new BrowserCaptureMediaDevices({platform:'macos',
      mediaDevices:{getDisplayMedia(){
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
        const ctx=canvas.getContext('2d');timer=setInterval(()=>{ctx.fillStyle=position%2?'#439bfc':'#111';ctx.fillRect(0,0,640,360);},40);
        const stream=canvas.captureStream(25),track=stream.getVideoTracks()[0];state.original=track;
        const settings=track.getSettings.bind(track),stop=track.stop.bind(track);
        track.getSettings=()=>({...settings(),displaySurface:'monitor'});track.stop=()=>{clearInterval(timer);stop();};return Promise.resolve(stream);
      }},invoke:async(command,args)=>{
        if(command==='nearcast_system_audio_start'){if(state.fail)throw Error('macos_audio_permission_required');owner=args.captureId;sequence=0;state.starts++;return{source:'screencapturekit',scope:'system-excluding-self',sampleRate:48000,channels:2};}
        if(command==='nearcast_audio_stop'){if(owner===args.captureId){owner=null;state.stops++;}return null;}
        if(command==='nearcast_audio_read'){
          await new Promise(resolve=>setTimeout(resolve,20));
          if(owner!==args.captureId)throw Error('native_audio_not_active');
          const header=new TextEncoder().encode(JSON.stringify({captureId:owner,format:'f32le',sampleRate:48000,channels:2,frames:960,sequence:++sequence,discontinuities:0}));
          const bytes=new Uint8Array(4+header.length+960*8),view=new DataView(bytes.buffer);view.setUint32(0,header.length);bytes.set(header,4);
          for(let i=0;i<960;i++){const sample=.1*Math.sin(2*Math.PI*440*position++/48000);view.setFloat32(4+header.length+i*8,sample,true);view.setFloat32(8+header.length+i*8,sample,true);}
          return bytes.buffer;
        }
        throw Error('unexpected native call: '+command);
      }});
    document.querySelector('#start').onclick=()=>{state.pending=state.provider.getDisplayMedia({audio:true}).then(stream=>state.stream=stream).catch(error=>state.error=String(error));};
    state.connect=async()=>{
      const sender=state.sender=new RTCPeerConnection({iceServers:[]}),receiver=state.receiver=new RTCPeerConnection({iceServers:[]});
      receiver.ontrack=event=>{document.querySelector('#remote').srcObject=event.streams[0];};
      for(const track of state.stream.getTracks())sender.addTrack(track,state.stream);
      for(const transceiver of sender.getTransceivers()){
        const kind=transceiver.sender.track.kind;
        transceiver.setCodecPreferences(RTCRtpSender.getCapabilities(kind).codecs.filter(codec=>codec.mimeType.toLowerCase()===(kind==='audio'?'audio/opus':'video/h264')));
      }
      const gather=async(pc,description)=>{
        await pc.setLocalDescription(description);
        if(pc.iceGatheringState!=='complete')await new Promise(resolve=>{pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete')resolve();};});
      };
      await gather(sender,await sender.createOffer());await receiver.setRemoteDescription(sender.localDescription);
      await gather(receiver,await receiver.createAnswer());await sender.setRemoteDescription(receiver.localDescription);
    };
  });
  await page.locator('#start').click();await page.waitForFunction(()=>audioFixture.stream||audioFixture.error);
  assert.equal(await page.evaluate(()=>audioFixture.error),undefined);
  assert.deepEqual(await page.evaluate(()=>({sameVideo:audioFixture.stream.getVideoTracks()[0]===audioFixture.original,audioTracks:audioFixture.stream.getAudioTracks().length,source:audioFixture.provider.diagnostics().audio.source})),{sameVideo:true,audioTracks:1,source:'screencapturekit'});
  await page.evaluate(()=>audioFixture.connect());
  await page.waitForFunction(async()=>[...await audioFixture.receiver.getStats()].some(([,row])=>row.type==='inbound-rtp'&&row.kind==='audio'&&row.totalAudioEnergy>.00001));
  assert.equal(await page.evaluate(async()=>{const stats=await audioFixture.sender.getStats();const row=[...stats.values()].find(row=>row.type==='outbound-rtp'&&row.kind==='audio');return stats.get(row.codecId).mimeType.toLowerCase();}),'audio/opus');
  await page.evaluate(async()=>{audioFixture.sender.close();audioFixture.receiver.close();await audioFixture.provider.stop();});
  assert.equal(await page.evaluate(()=>audioFixture.stops),1);
  assert.equal(await page.evaluate(()=>audioFixture.stream.getAudioTracks()[0].readyState),'ended');
  await page.evaluate(()=>{audioFixture.stream=null;audioFixture.fail=true;});await page.locator('#start').click();
  await page.waitForFunction(()=>audioFixture.stream||audioFixture.error);
  assert.equal(await page.evaluate(()=>audioFixture.stream.getVideoTracks()[0].readyState),'live','denied native audio preserves browser video');
  assert.equal(await page.evaluate(()=>audioFixture.provider.diagnostics().audio.error),'macos_audio_permission_required');
  await page.evaluate(()=>audioFixture.provider.stop());
  assert.deepEqual(errors,[]);
  console.log('PASS: macOS native-audio fallback, original browser video, one Opus track with RTP energy, owner cleanup and audio failure preserving video');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
