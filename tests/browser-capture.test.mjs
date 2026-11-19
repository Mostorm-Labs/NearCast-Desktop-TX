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
    assert.deepEqual(options.video.frameRate,{ideal:30,max:30},'cap capture at 30 FPS before calibration');
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
test('macOS fills missing display audio with native system audio without replacing browser video',async()=>{
  const video=track(),audio=track('audio'),source=stream([video]);let starts=0,stops=0,primed=false;
  const context={resume:()=>Promise.resolve(),close:async()=>{}};
  const media=new BrowserCaptureMediaDevices({platform:'macos',invoke:async()=>{},
    prepareSystemAudio:()=>{primed=true;return context;},
    mediaDevices:{getDisplayMedia(options){assert.equal(primed,true,'Web Audio is primed in the share gesture');assert.equal(options.audio,true);return Promise.resolve(source);}},
    createSystemAudio:async options=>{starts++;assert.equal(options.audioContext,context);return{track:audio,stop:async()=>{stops++;audio.stop();},diagnostics:()=>({source:'screencapturekit',state:'capturing'})};}});
  assert.equal(await media.getDisplayMedia({audio:true}),source);
  assert.equal(source.getVideoTracks()[0],video);assert.deepEqual(source.getAudioTracks(),[audio]);
  assert.equal(media.diagnostics().audio.source,'screencapturekit');
  await media.stop();await media.stop();assert.equal(starts,1);assert.equal(stops,1);
});
test('macOS releases a primed audio context when the picker is cancelled or already provides audio',async()=>{
  for(const cancelled of [true,false]){
    let closes=0,starts=0;
    const context={close:async()=>{closes++;}};
    const media=new BrowserCaptureMediaDevices({platform:'macos',invoke:async()=>{},prepareSystemAudio:()=>context,
      mediaDevices:{getDisplayMedia:async()=>{if(cancelled)throw Error('picker cancelled');return stream([track(),track('audio')]);}},
      createSystemAudio:async()=>{starts++;}});
    if(cancelled)await assert.rejects(media.getDisplayMedia({audio:true}),/cancelled/);
    else{await media.getDisplayMedia({audio:true});await media.stop();}
    assert.equal(closes,1);assert.equal(starts,0);
  }
});
test('macOS native audio failure reports an error while browser video continues',async()=>{
  const source=stream();
  const media=new BrowserCaptureMediaDevices({platform:'macos',invoke:async()=>{},prepareSystemAudio:()=>null,
    mediaDevices:{getDisplayMedia:async()=>source},createSystemAudio:async()=>{throw Error('macos_audio_permission_required');}});
  await media.getDisplayMedia({audio:true});assert.equal(source.getVideoTracks()[0].readyState,'live');
  assert.match(media.diagnostics().audio.error,/permission_required/);await media.stop();
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
test('waiting for an old stream to retire cannot stop a newly selected capture',async()=>{
  const media=new BrowserCaptureMediaDevices({mediaDevices:{getDisplayMedia:async()=>stream()}});
  const first=await media.getDisplayMedia();
  const second=await media.getDisplayMedia();
  await media.stop(first);
  assert.equal(second.getVideoTracks()[0].readyState,'live');
  assert.equal(media.current?.stream,second);
  await media.stop(second);
  assert.equal(second.getVideoTracks()[0].readyState,'ended');
});
test('macOS never opens another picker while its audio worker is still retiring',async()=>{
  let finish;const retired=new Promise(resolve=>{finish=resolve;});let selections=0;
  const media=new BrowserCaptureMediaDevices({platform:'macos',invoke:async()=>{},prepareSystemAudio:()=>null,
    mediaDevices:{getDisplayMedia:async()=>{selections++;return stream();}},
    createSystemAudio:async()=>({track:track('audio'),stop:()=>retired})});
  await media.getDisplayMedia({audio:true});
  const stopping=media.stop();
  const next=media.getDisplayMedia();void next.catch(()=>{});
  try{
    assert.equal(selections,1,'the native worker must exit before another OS picker is opened');
    await assert.rejects(next,/native_audio_cleanup_required/);
  }finally{finish();await stopping;await next.catch(()=>{});await media.stop();}
  const restarted=await media.getDisplayMedia();
  assert.equal(restarted.getVideoTracks()[0].readyState,'live');
  await media.stop();
});
test('Windows monitor calibration binds the original track and releases the same source on stop',async()=>{
  let sourceId;const released=[];
  const media=new BrowserCaptureMediaDevices({platform:'windows',mediaDevices:{getDisplayMedia:async()=>stream()},
    invoke:async(command,args)=>{if(command==='nearcast_display_binding_release')released.push(args.sourceId);},
    calibrateDisplay:async args=>{sourceId=args.sourceId;return{bindingId:'test-binding',region:{x:-1920,y:0,width:1920,height:1080}};}});
  const result=await media.getDisplayMedia();
  assert.deepEqual(result.getVideoTracks()[0].getSettings().nearcastDisplayBinding,{sourceId,bindingId:'test-binding'});
  assert.equal(media.diagnostics().displayBinding.region.x,-1920);
  await media.stop();assert.deepEqual(released,[sourceId]);
});
test('calibration timeout preserves video and does not synthesize an identity',async()=>{
  const media=new BrowserCaptureMediaDevices({platform:'windows',mediaDevices:{getDisplayMedia:async()=>stream()},
    invoke:async()=>{},calibrateDisplay:async()=>{throw new Error('binding timeout');}});
  const result=await media.getDisplayMedia();
  assert.equal(result.getVideoTracks()[0].readyState,'live');
  assert.equal(result.getVideoTracks()[0].getSettings().nearcastDisplayBinding,undefined);
  assert.match(media.diagnostics().displayBinding.error,/timeout/);await media.stop();
});
test('binding release failure still cleans system audio and blocks unsafe reuse',async()=>{
  let stopped=0;
  const media=new BrowserCaptureMediaDevices({platform:'windows',mediaDevices:{getDisplayMedia:async()=>stream()},
    invoke:async command=>{if(command.endsWith('release'))throw new Error('input cleanup pending');},calibrateDisplay:async()=>({bindingId:'b'}),
    createSystemAudio:async()=>({track:track('audio'),stop:async()=>{stopped++;}})});
  await media.getDisplayMedia({audio:true});
  await assert.rejects(media.stop(),/cleanup/);assert.equal(stopped,1);
});
