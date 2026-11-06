import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeCaptureFrame,fitCaptureSize,NativeCaptureMediaDevices} from '../src/capture/native-capture.mjs';
import {proveCaptureGeometry} from '../src/touchback/capture-geometry.mjs';
const geometry={captureId:'capture-1',nativeId:'capture:capture-1',kind:'monitor',revision:'r1',units:'physical-pixels',rotation:0,region:{x:-1920,y:0,width:1920,height:1080},captureWidth:1920,captureHeight:1080,inputReady:true,disabledReason:null};
function packet(meta={},pixels=new Uint8Array(16)){
  const metadata=new TextEncoder().encode(JSON.stringify({captureId:'capture-1',frameId:1,pixelFormat:'BGRA8',width:2,height:2,geometry:{...geometry,captureWidth:2,captureHeight:2},...meta}));
  const bytes=new Uint8Array(4+metadata.length+pixels.length);new DataView(bytes.buffer).setUint32(0,metadata.length);bytes.set(metadata,4);bytes.set(pixels,4+metadata.length);return bytes.buffer;
}
test('binary capture decoder validates dimensions, payload length and generation identity',()=>{
  const frame=decodeCaptureFrame(packet(),'capture-1');assert.equal(frame.pixels.length,16);assert.equal(frame.geometry.region.x,-1920);
  assert.throws(()=>decodeCaptureFrame(packet(),'old-capture'),/capture/i);
  assert.throws(()=>decodeCaptureFrame(packet({},new Uint8Array(15)),'capture-1'),/length/i);
  assert.throws(()=>decodeCaptureFrame(packet({width:100000,height:100000}),'capture-1'),/budget|dimensions/i);
  assert.throws(()=>decodeCaptureFrame(packet({geometry}),'capture-1'),/dimension|geometry/i);
});
test('quality sizing preserves the captured aspect ratio without stretching a window',()=>{
  assert.deepEqual(fitCaptureSize(1920,1080,{width:{ideal:1280},height:{ideal:720}}),{width:1280,height:720});
  assert.deepEqual(fitCaptureSize(800,600,{width:{ideal:1920},height:{ideal:1080}}),{width:800,height:600});
  assert.deepEqual(fitCaptureSize(2000,1000,{width:{ideal:1280},height:{ideal:720}}),{width:1280,height:640});
});

test('window resize publishes the rendered dimensions even while browser track settings lag',async()=>{
  const resized={...geometry,kind:'window',revision:'resized',captureWidth:400,captureHeight:400,region:{x:100,y:100,width:400,height:400}};
  const observations=[];let reads=0;
  const canvas={width:800,height:600,captureStream:()=>({getVideoTracks:()=>[{getSettings:()=>({width:800,height:600,aspectRatio:4/3}),stop(){},requestFrame(){}}]})};
  const devices=new NativeCaptureMediaDevices({chooseTarget:async()=> 'target-1',createCanvas:()=>({canvas,draw(_frame,size){Object.assign(canvas,size);},close(){}}),
    onGeometryChange:(capture,track)=>observations.push({settings:track.getSettings(),capture}),
    invoke:async(method)=>{if(method==='nearcast_capture_start')return{...geometry,kind:'window',captureWidth:800,captureHeight:600};if(method==='nearcast_capture_frame'){if(++reads===1)return packet({width:400,height:400,geometry:resized},new Uint8Array(400*400*4));return new Promise(()=>{});}}});
  try{
    await devices.getDisplayMedia({video:true});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(observations.length,1);const {settings,capture}=observations[0];
    assert.equal(settings.width,400);assert.equal(settings.height,400);assert.equal(settings.aspectRatio,1);
    assert.equal(proveCaptureGeometry(settings,{revision:capture.revision,capture}).proven,true);
  }finally{await devices.stop();}
});

test('late native capture start after cancellation is released and cannot publish a stream',async()=>{
  let start;const calls=[];
  const devices=new NativeCaptureMediaDevices({invoke:async(method,args)=>{calls.push([method,args]);if(method==='nearcast_capture_start')return new Promise(resolve=>{start=resolve;});return null;},chooseTarget:async()=> 'target-1'});
  const opening=devices.getDisplayMedia({video:true});while(!start)await new Promise(resolve=>setImmediate(resolve));
  await devices.stop();start(geometry);
  await assert.rejects(opening,/cancel|retired/i);
  assert.ok(calls.some(([method,args])=>method==='nearcast_capture_stop'&&args.captureId==='capture-1'));
});

test('restarting capture waits for the previous native stop instead of racing its lease',async()=>{
  let finishStop,starts=0;
  const devices=new NativeCaptureMediaDevices({chooseTarget:async()=> 'target-1',createCanvas:()=>({canvas:{captureStream:()=>({getVideoTracks:()=>[{getSettings:()=>({width:2,height:2}),stop(){}}]})},close(){}}),
    invoke:async(method)=>{
      if(method==='nearcast_capture_start'){starts++;return{...geometry,captureId:`capture-${starts}`};}
      if(method==='nearcast_capture_frame')return new Promise(()=>{});
      if(method==='nearcast_capture_stop'&&starts===1)return new Promise(resolve=>{finishStop=resolve;});
    }});
  await devices.getDisplayMedia({video:true});const stopping=devices.stop();const restarting=devices.getDisplayMedia({video:true});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(starts,1,'new native start must wait for old release');
  finishStop();await stopping;await restarting;assert.equal(starts,2);await devices.stop();
});

test('an unchanged native surface periodically repeats its last frame to keep RTP active',async()=>{
  let clock=0,reads=0,requests=0;
  const devices=new NativeCaptureMediaDevices({chooseTarget:async()=> 'target-1',now:()=>clock,createCanvas:()=>({canvas:{captureStream:()=>({getVideoTracks:()=>[{getSettings:()=>({width:2,height:2}),stop(){},requestFrame(){requests++;}}]})},draw(){},close(){}}),
    invoke:async(method)=>{if(method==='nearcast_capture_start')return geometry;if(method==='nearcast_capture_frame'){if(++reads===1)return packet();if(reads===2){clock=500;return packet({width:0,height:0},new Uint8Array(0));}return new Promise(()=>{});}}});
  await devices.getDisplayMedia({video:true});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests,2,'static capture must not silently stop video delivery');await devices.stop();
});

test('green updates distinguish input owners and carry an ordered capture-local sequence',async()=>{
  const sent=[];
  const devices=new NativeCaptureMediaDevices({chooseTarget:async()=> 'target-1',createCanvas:()=>({canvas:{captureStream:()=>({getVideoTracks:()=>[{getSettings:()=>({width:2,height:2}),stop(){}}]})},close(){}}),invoke:async(method,args)=>{
    if(method==='nearcast_capture_start')return geometry;if(method==='nearcast_capture_frame')return new Promise(()=>{});if(method==='nearcast_capture_indicator')sent.push(args);
  }});
  await devices.getDisplayMedia({video:true});
  const active={state:'active',sourceReady:true,localEnabled:true,cleanupPending:false};
  await devices.setInputState({...active,nativeOwnerId:'old-owner'});await devices.setInputState({...active,nativeOwnerId:'new-owner'});
  assert.equal(sent.length,2);assert.equal(sent[1].ownerId,'new-owner');assert.ok(sent[1].sequence>sent[0].sequence);await devices.stop();
});


test('capture diagnostics distinguish repeated pixels from advancing native and preview requests',async()=>{
  let reads=0;
  const first=Uint8Array.from([0,0,0,255,0,0,0,255,0,0,0,255,0,0,0,255]);
  const changed=first.slice();changed[1]=255; // Green-only change must be visible in diagnostics.
  const devices=new NativeCaptureMediaDevices({chooseTarget:async()=> 'target-1',createCanvas:()=>({canvas:{captureStream:()=>({getVideoTracks:()=>[{getSettings:()=>({width:2,height:2}),stop(){},requestFrame(){}}]})},draw(){},close(){}}),
    invoke:async(method)=>{
      if(method==='nearcast_capture_start')return geometry;
      if(method==='nearcast_capture_frame'){
        if(++reads>3)return new Promise(()=>{});
        return packet({frameId:reads,nativeCapture:{sourceTimestamp100ns:reads*10000,surfaceWidth:8,surfaceHeight:8,readbackWidth:2,readbackHeight:2}},reads===3?changed:first);
      }
    }});
  await devices.getDisplayMedia({video:true});await new Promise(resolve=>setImmediate(resolve));
  const capture=devices.diagnostics();
  assert.equal(capture.frames,3);assert.equal(capture.lastFrameId,3);
  assert.equal(capture.sampledPixelChanges,1,'new frame counters must not imply that content changed');
  assert.match(capture.sampledPixelHash,/^[0-9a-f]{8}$/);
  assert.equal(capture.nativeCapture.sourceTimestamp100ns,30000);
  assert.equal(capture.nativeCapture.surfaceWidth,8);await devices.stop();
});
