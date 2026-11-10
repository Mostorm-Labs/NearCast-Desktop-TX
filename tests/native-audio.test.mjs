import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {decodeAudioPacket,createNativeAudioTrack} from '../src/capture/native-audio.mjs';

const packet=(meta={},samples=[0.25,-0.5,1,-1])=>{
  const header=new TextEncoder().encode(JSON.stringify({captureId:'cap-1',format:'f32le',sampleRate:48000,channels:2,frames:2,sequence:1,discontinuities:0,...meta}));
  const bytes=new Uint8Array(4+header.length+samples.length*4);const view=new DataView(bytes.buffer);view.setUint32(0,header.length);bytes.set(header,4);samples.forEach((s,i)=>view.setFloat32(4+header.length+i*4,s,true));return bytes.buffer;
};
test('native PCM decoder preserves interleaved stereo samples and fences malformed or retired packets',()=>{
  assert.deepEqual([...decodeAudioPacket(packet(),'cap-1').samples],[0.25,-0.5,1,-1]);
  for(const bad of [packet({captureId:'old'}),packet({channels:8}),packet({sampleRate:96000}),packet({frames:3}),packet({},[NaN,0,0,0])])assert.throws(()=>decodeAudioPacket(bad,'cap-1'));
  assert.equal(decodeAudioPacket(packet({frames:0},[]),'cap-1').samples.length,0);
});
test('audio worklet renders both channels, supplies silence on underrun and bounds latency after a burst',async()=>{
  let Processor;const context={sampleRate:48000,Float32Array,AudioWorkletProcessor:class{constructor(){this.port={postMessage(){}};}},registerProcessor:(_name,p)=>Processor=p};
  vm.runInNewContext(await readFile(new URL('../src/capture/pcm-worklet.mjs',import.meta.url),'utf8'),context);
  const p=new Processor(),output=[new Float32Array(4),new Float32Array(4)];
  p.port.onmessage({data:{samples:new Float32Array(2*2880).fill(0.25),reset:false}});
  p.process([], [output]);assert.deepEqual([...output[0]],[0.25,0.25,0.25,0.25]);
  p.port.onmessage({data:{reset:true,samples:new Float32Array(2*2880).fill(-0.5)}});p.process([], [output]);assert.equal(output[1][0],-0.5);
  p.port.onmessage({data:{reset:true,samples:new Float32Array(48000*2).fill(0.75)}});p.process([], [output]);assert.equal(output[0][0],0.75);assert.ok(p.queuedFrames<=12000);
  for(let i=0;i<4000;i++)p.process([], [output]);assert.equal(output[0][0],0);assert.ok(p.underrunFrames>0);
});
test('native audio bridge polls PCM into a MediaStream destination and closes every resource once',async()=>{
  const calls=[],messages=[];let closes=0,stops=0;
  const track={stop(){stops++;}};
  class Context{sampleRate=48000;state='running';audioWorklet={addModule:async()=>{}};createMediaStreamDestination(){return {stream:{getAudioTracks:()=>[track]}};}async resume(){}async close(){closes++;}}
  class Worklet{port={postMessage:value=>messages.push(value)};connect(){}disconnect(){}}
  let resolveRead;
  const audio=await createNativeAudioTrack({captureId:'cap-1',AudioContextImpl:Context,AudioWorkletNodeImpl:Worklet,
    invoke:async(method,args)=>{assert.deepEqual(args,{captureId:'cap-1'},'Tauri requires named object arguments');calls.push([method,args]);if(method==='nearcast_system_audio_start')return{sampleRate:48000,channels:2};if(method==='nearcast_audio_read'){if(!messages.length)return packet();return new Promise(resolve=>{resolveRead=resolve;});}}});
  while(!messages.length)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(audio.track,track);assert.equal(audio.diagnostics().receivedFrames,2);
  await audio.stop();await audio.stop();resolveRead?.(packet({sequence:2}));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(messages.length,1);assert.equal(stops,1);assert.equal(closes,1);assert.equal(calls.filter(([name])=>name==='nearcast_audio_stop').length,1);
});
