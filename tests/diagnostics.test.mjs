import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticSample,createDiagnostics} from '../src/diagnostics.mjs';
test('persistent diagnostic records contain only known status and numeric counters',()=>{
  const value=diagnosticSample({status:'sharing',pairCode:'1234',media:{video:{framesEncoded:10,framesPerSecond:30,sdp:'secret'}},input:{submittedSamples:3,lease:'private'},capture:{audio:{receivedFrames:48000,rawAudio:'private'}}});
  assert.deepEqual(value,{event:'media',status:'sharing',metrics:{framesEncoded:10,framesPerSecond:30,inputSubmitted:3,audioFrames:48000}});
  assert.deepEqual(diagnosticSample({media:{video:{framesPerSecond:NaN}}}).metrics,{});
});
test('diagnostics serializes best-effort writes and exports without a network request',async()=>{
  let tick,finish;const calls=[];
  const logger=createDiagnostics({snapshot:()=>({status:'sharing'}),setTimer:fn=>{tick=fn;},clearTimer(){},
    invoke:async(command,args)=>{calls.push([command,args]);if(command==='nearcast_diagnostics_export')return 'report.json';return new Promise(r=>finish=r);}});
  logger.status('connected');tick();logger.error();
  assert.equal(calls.length,1);finish();await new Promise(r=>setImmediate(r));
  tick();assert.equal(calls.length,2);finish();await new Promise(r=>setImmediate(r));
  assert.equal(await logger.export(),'report.json');logger.stop();tick();assert.equal(calls.length,3);
});
