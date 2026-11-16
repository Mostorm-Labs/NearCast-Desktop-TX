import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticSample,createDiagnostics} from '../src/diagnostics.mjs';
test('persistent diagnostic records contain only known status and numeric counters',()=>{
  const value=diagnosticSample({status:'sharing',pairCode:'1234',media:{video:{framesEncoded:10,framesPerSecond:30,sdp:'secret'}},input:{submittedSamples:3,lease:'private'},capture:{audio:{receivedFrames:48000,rawAudio:'private'}}});
  assert.deepEqual(value,{event:'media',status:'sharing',metrics:{framesEncoded:10,framesPerSecond:30,inputSubmitted:3,audioFrames:48000},video:{}});
  assert.deepEqual(diagnosticSample({media:{video:{framesPerSecond:NaN}}}).metrics,{});
});

test('persistent video diagnostics whitelist enums, dimensions and finite counters',()=>{
  const value=diagnosticSample({status:'sharing',media:{video:{qualityLimitationReason:'cpu',codec:'h264',encodeMsPerFrame:12,sourceIntervalFps:30,
    roundTripTimeMs:NaN,sendKbps:-3,packetsLost:-1,powerEfficientEncoder:false,encoderImplementation:'private',candidateAddress:'private'}},
    capture:{kind:'monitor',trackState:'live',muted:false,output:{width:1920,height:1080,frameRate:60,deviceId:'private'}},
    window:{minimized:true,visible:true,pageVisibility:'hidden',sampledAt:1234,title:'private'}});
  assert.equal(value.video.captureFrameRate,60);assert.equal(value.video.sourceIntervalFps,30);assert.equal(value.video.windowMinimized,true);
  assert.equal(value.video.qualityLimitationReason,'cpu');assert.equal(value.video.packetsLost,-1);
  assert.equal(value.video.roundTripTimeMs,undefined);assert.equal(value.video.sendKbps,undefined);assert.ok(!JSON.stringify(value).includes('private'));
});

test('saves video statistics every five seconds while sharing without scroll input',async()=>{
  let updatedAt=10_000,status='sharing';const rows=[];
  const logger=createDiagnostics({snapshot:()=>({status,media:{updatedAt,video:{qualityLimitationReason:'none'}}}),setTimer(){},clearTimer(){},
    invoke:async(command,args)=>rows.push(args.sample)});
  logger.media();await new Promise(r=>setImmediate(r));updatedAt+=1000;logger.media();assert.equal(rows.length,1);
  updatedAt+=4000;logger.media();await new Promise(r=>setImmediate(r));assert.equal(rows.length,2);
  status='idle';updatedAt+=5000;logger.media();assert.equal(rows.length,2);logger.stop();
});
test('diagnostics serializes best-effort writes and exports without a network request',async()=>{
  let tick,finish;const calls=[];
  const logger=createDiagnostics({snapshot:()=>({status:'sharing'}),setTimer:fn=>{tick=fn;},clearTimer(){},
    invoke:async(command,args)=>{calls.push([command,args]);if(command==='nearcast_diagnostics_export')return 'report.json';return new Promise(r=>finish=r);}});
  logger.status('connected');tick();logger.error();
  assert.equal(calls.length,1);finish();await new Promise(r=>setImmediate(r));
  tick();assert.equal(calls.length,2);finish();await new Promise(r=>setImmediate(r));
  const exporting=logger.export();await new Promise(r=>setImmediate(r));finish();
  assert.equal(await exporting,'report.json');logger.stop();tick();assert.equal(calls.length,4);
});
