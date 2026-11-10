import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserCaptureMediaDevices} from '../src/capture/browser-capture.mjs';
const track = (kind='video',settings={displaySurface:'monitor',width:1920,height:1080}) => ({
  kind,readyState:'live',getSettings:()=>({...settings}),listeners:new Map(),
  addEventListener(name,fn){this.listeners.set(name,fn);},removeEventListener(name){this.listeners.delete(name);},
  stop(){this.readyState='ended';},applyConstraints:async()=>{},
});
const stream = (tracks=[track()]) => ({getTracks:()=>tracks.slice(),getVideoTracks:()=>tracks.filter(t=>t.kind==='video'),getAudioTracks:()=>tracks.filter(t=>t.kind==='audio'),addTrack:t=>tracks.push(t)});
test('browser video track goes directly to WebRTC with one user-gesture picker and independent system audio',async()=>{
  let calls=0,audioStops=0;
  const video=track(),audio=track('audio'),source=stream([video]);
  const media=new BrowserCaptureMediaDevices({platform:'windows',mediaDevices:{getDisplayMedia(options){
    calls++;assert.equal(options.audio,false);assert.equal(options.video.width,undefined,'initial capture must retain original source dimensions');
    return Promise.resolve(source);
  }},createSystemAudio:async()=>({track:audio,stop:async()=>{audioStops++;audio.stop();},diagnostics:()=>({source:'wasapi-loopback',state:'capturing'})})});
  const pending=media.getDisplayMedia({video:{width:{ideal:1280}},audio:true});
  assert.equal(calls,1,'getDisplayMedia must execute synchronously before losing activation');
  const result=await pending;
  assert.equal(result,source);assert.equal(result.getVideoTracks()[0],video);
  assert.equal(result.getAudioTracks()[0],audio);
  assert.equal(media.diagnostics().backend,'browser');
  assert.equal(media.diagnostics().source.width,1920);
  await media.stop();await media.stop();
  assert.equal(video.readyState,'ended');assert.equal(audioStops,1);
});
test('window shares and missing system audio preserve video while reporting accurate source type',async()=>{
  const source=stream([track('video',{displaySurface:'window',width:900,height:700})]);
  const media=new BrowserCaptureMediaDevices({platform:'windows',mediaDevices:{getDisplayMedia:()=>Promise.resolve(source)},createSystemAudio:async()=>{throw new Error('no render device');}});
  await media.getDisplayMedia({audio:true});
  assert.equal(source.getVideoTracks()[0].readyState,'live');assert.equal(media.diagnostics().kind,'window');
  assert.match(media.diagnostics().audio.error,/no render/);
  await media.stop();
});
test('picker cancellation and late results after stop never start audio or retain tracks',async()=>{
  let complete,starts=0;
  const source=stream();
  const media=new BrowserCaptureMediaDevices({platform:'windows',mediaDevices:{getDisplayMedia:()=>new Promise(r=>complete=r)},createSystemAudio:async()=>{starts++;}});
  const pending=media.getDisplayMedia({audio:true});
  await media.stop();complete(source);
  await assert.rejects(pending,/retired|cancel/i);
  assert.equal(starts,0);assert.equal(source.getVideoTracks()[0].readyState,'ended');
  assert.equal(media.current,null);
});
test('audio start finishing after stop is cleaned before a new source acquires audio',async()=>{
  let finish,starts=0,stops=0;
  const media=new BrowserCaptureMediaDevices({platform:'windows',mediaDevices:{getDisplayMedia:async()=>stream()},createSystemAudio:()=>{starts++;return new Promise(r=>finish=()=>r({track:track('audio'),stop:async()=>{stops++;}}));}});
  const first=media.getDisplayMedia({audio:true});
  while(!finish)await new Promise(r=>setImmediate(r));
  const stopped=media.stop();
  finish();await stopped;await assert.rejects(first,/retired|cancel/i);
  assert.equal(starts,1);assert.equal(stops,1);
});
test('browser returned audio is reused on macOS and disabling audio never opens microphone',async()=>{
  const audio=track('audio'),source=stream([track(),audio]);let request;
  const media=new BrowserCaptureMediaDevices({platform:'macos',mediaDevices:{getDisplayMedia:async options=>{request=options;return source;}},createSystemAudio:async()=>assert.fail('native audio on macOS')});
  await media.getDisplayMedia({audio:true});assert.equal(request.audio,true);assert.equal(source.getAudioTracks()[0],audio);
  await media.stop();
});
test('cleanup failure blocks reuse and closes the newly selected video',async()=>{
  let selected;
  const media=new BrowserCaptureMediaDevices({platform:'windows',mediaDevices:{getDisplayMedia:async()=>selected=stream()},
    createSystemAudio:async()=>({track:track('audio'),stop:async()=>{throw new Error('audio cleanup pending');}})});
  await media.getDisplayMedia({audio:true});
  await assert.rejects(media.stop(),/cleanup/);
  await assert.rejects(media.getDisplayMedia({audio:false}),/cleanup/);
  assert.equal(selected.getVideoTracks()[0].readyState,'ended');
});
test('an old video track stop cannot retire a replacement session',async()=>{
  const media=new BrowserCaptureMediaDevices({mediaDevices:{getDisplayMedia:async()=>stream()}});
  const first=await media.getDisplayMedia();
  const second=await media.getDisplayMedia();
  first.getVideoTracks()[0].stop();
  assert.equal(second.getVideoTracks()[0].readyState,'live');
  assert.equal(media.current.stream,second);
  await media.stop();
});
