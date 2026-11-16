import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaDiagnosticsReader} from '../src/webcast/media-diagnostics.mjs';

function fixture(){
  let current;
  const sender={track:{kind:'video'},getStats:async()=>current};
  const set=(timestamp,frames,bytes,encode=frames/100)=>{
    current=new Map([
      ['out',{id:'out',type:'outbound-rtp',kind:'video',ssrc:1,timestamp,framesEncoded:frames,framesSent:frames,bytesSent:bytes,totalEncodeTime:encode,
        mediaSourceId:'source',transportId:'transport',remoteId:'remote',codecId:'codec',qualityLimitationReason:'cpu',qualityLimitationDurations:{cpu:2,none:1},powerEfficientEncoder:false}],
      ['source',{id:'source',type:'media-source',kind:'video',timestamp,frames:frames*2,framesPerSecond:60,width:1920,height:1080}],
      ['transport',{type:'transport',selectedCandidatePairId:'pair'}],
      ['pair',{type:'candidate-pair',availableOutgoingBitrate:20e6,currentRoundTripTime:0.02,localCandidateId:'private'}],
      ['remote',{type:'remote-inbound-rtp',packetsLost:-1,fractionLost:0.01}],
      ['codec',{mimeType:'video/H264',sdpFmtpLine:'private'}],
    ]);
  };
  return{sender,set};
}

test('reports source, encoder interval rates and the selected network path without identifiers',async()=>{
  const f=fixture(),reader=new MediaDiagnosticsReader();
  f.set(1000,10,1000);assert.equal((await reader.read(f.sender)).encodedIntervalFps,null);
  f.set(3000,40,251000);const value=await reader.read(f.sender);
  assert.equal(value.sourceIntervalFps,30);assert.equal(value.encodedIntervalFps,15);assert.equal(value.sentIntervalFps,15);
  assert.equal(value.sendKbps,1000);assert.ok(Math.abs(value.encodeMsPerFrame-10)<1e-10);
  assert.equal(value.qualityLimitationReason,'cpu');assert.equal(value.availableOutgoingBitrate,20e6);
  assert.equal(value.roundTripTimeMs,20);assert.equal(value.packetsLost,-1);assert.equal(value.codec,'h264');
  assert.equal(value.powerEfficientEncoder,false);assert.ok(!JSON.stringify(value).includes('private'));
});

test('fences replaced or stopped tracks and resets deltas for counter rollback',async()=>{
  const f=fixture(),reader=new MediaDiagnosticsReader();f.set(1000,50,1000);await reader.read(f.sender);
  f.sender.track={kind:'video'};f.set(2000,60,2000);assert.equal((await reader.read(f.sender)).encodedIntervalFps,null);
  f.set(3000,10,100);const reset=await reader.read(f.sender);assert.equal(reset.encodedIntervalFps,null);assert.equal(reset.sendKbps,null);
  let finish;f.sender.getStats=()=>new Promise(r=>finish=r);const late=reader.read(f.sender);f.sender.track=null;finish(new Map());assert.equal(await late,null);
  assert.equal(await reader.read(f.sender),null);
});
