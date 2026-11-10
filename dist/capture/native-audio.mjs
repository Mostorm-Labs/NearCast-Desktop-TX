import {check,integer} from '../touchback/frame-codec.mjs';

const RATE=48000,CHANNELS=2,MAX_FRAMES=1920;
export function decodeAudioPacket(input,captureId){
  const bytes=input instanceof ArrayBuffer?new Uint8Array(input):input;
  check(bytes instanceof Uint8Array&&bytes.length>=4,'Audio packet length');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),size=view.getUint32(0);
  check(size>0&&size<=4096&&size+4<=bytes.length,'Audio metadata length');
  const metadata=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(4,4+size)));
  check(metadata.captureId===captureId&&metadata.format==='f32le','Audio identity/format');
  check(metadata.sampleRate===RATE&&metadata.channels===CHANNELS&&integer(metadata.frames,0,MAX_FRAMES),'Audio metadata');
  check(Number.isSafeInteger(metadata.sequence)&&metadata.sequence>0&&Number.isSafeInteger(metadata.discontinuities)&&metadata.discontinuities>=0,'Audio sequence');
  check(bytes.length===4+size+metadata.frames*CHANNELS*4,'Audio packet length');
  const samples=new Float32Array(metadata.frames*CHANNELS);
  for(let i=0;i<samples.length;i++){const sample=view.getFloat32(4+size+i*4,true);check(Number.isFinite(sample),'Audio samples');samples[i]=sample;}
  return{...metadata,samples};
}

// No microphone and no connection to context.destination (local speakers).
// WASAPI supplies fixed 48 kHz stereo; Chromium encodes the destination as Opus.
export async function createNativeAudioTrack({captureId,invoke,AudioContextImpl=globalThis.AudioContext,
  AudioWorkletNodeImpl=globalThis.AudioWorkletNode,workletUrl=new URL('./pcm-worklet.mjs',import.meta.url).href,startCommand='nearcast_audio_start'}={}){
  check(typeof AudioContextImpl==='function'&&typeof AudioWorkletNodeImpl==='function','Web Audio unavailable');
  let context,node,track,nativeStarted=false,stopped=false,stopPromise;
  const stats={source:'wasapi-loopback',scope:'default-render-device',sampleRate:RATE,channels:CHANNELS,state:'starting',
    receivedFrames:0,packets:0,discontinuities:0,error:null};
  const stop=()=>{
    if(stopPromise)return stopPromise;
    stopped=true;if(stats.state!=='error')stats.state='stopped';
    stopPromise=(async()=>{
      track?.stop();node?.disconnect();node?.port.close?.();
      const results=await Promise.allSettled([context?.close(),nativeStarted?invoke('nearcast_audio_stop',{captureId}):undefined]);
      const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    })();return stopPromise;
  };
  try{
    context=new AudioContextImpl({sampleRate:RATE,latencyHint:'interactive'});
    check(context.sampleRate===RATE,'Web Audio requires 48000 Hz');
    await context.audioWorklet.addModule(workletUrl);
    const destination=context.createMediaStreamDestination();
    node=new AudioWorkletNodeImpl(context,'nearcast-native-pcm',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[CHANNELS]});
    node.connect(destination);track=destination.stream.getAudioTracks()[0];check(track,'Audio destination track unavailable');
    node.port.onmessage=event=>{if(!stopped)stats.render=event.data;};
    let resumeTimer;
    try{await Promise.race([context.resume(),new Promise((_,reject)=>{resumeTimer=setTimeout(()=>reject(new Error('Web Audio resume timed out')),2000);resumeTimer.unref?.();})]);}
    finally{clearTimeout(resumeTimer);}
    // A reply may fail after the native owner was created: always attempt
    // cleanup for this random owner even when start did not return successfully.
    nativeStarted=true;const started=await invoke(startCommand,{captureId});
    check(started?.sampleRate===RATE&&started?.channels===CHANNELS,'Native audio format mismatch');
    stats.state='capturing';
    let sequence=0,discontinuities=0;
    const read=async()=>{
      while(!stopped){
        const bytes=await invoke('nearcast_audio_read',{captureId});if(stopped)return;
        const packet=decodeAudioPacket(bytes,captureId);
        check(packet.sequence>sequence,'Native audio sequence did not advance');
        const reset=packet.discontinuities!==discontinuities||sequence>0&&packet.sequence!==sequence+1;
        sequence=packet.sequence;discontinuities=packet.discontinuities;stats.discontinuities=discontinuities;
        stats.packets++;stats.receivedFrames+=packet.frames;
        if(packet.frames)node.port.postMessage({samples:packet.samples,reset},[packet.samples.buffer]);
      }
    };
    void read().catch(error=>{if(stopped)return;stats.state='error';stats.error=String(error.message??error);void stop().catch(()=>{});});
    return{track,stop,diagnostics:()=>({...stats,contextState:context.state,trackState:track.readyState})};
  }catch(error){stats.state='error';stats.error=String(error.message??error);await stop().catch(()=>{});throw error;}
}

// Separate from native video capture: random local owner fences late audio IPC.
export function createSystemAudioTrack(options={}) {
  return createNativeAudioTrack({...options,captureId:globalThis.crypto.randomUUID(),startCommand:'nearcast_system_audio_start'});
}
