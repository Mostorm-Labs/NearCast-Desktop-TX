import test from 'node:test';
import assert from 'node:assert/strict';
import {AxtpServer,rpcPayload,controlPayload} from '../src/touchback/axtp-session.mjs';
import {encodeStandardFrame,decodeStandardFrame,FrameReassembler} from '../src/touchback/frame-codec.mjs';
const open=Buffer.from('4158010100160000000100010100010000040210000701070801010a0203e80b010034f2','hex'); // Real Axent FramedClient output.
const rpc=value=>encodeStandardFrame(rpcPayload(value),{payloadType:2});
const json=frame=>JSON.parse(new TextDecoder().decode(frame.payload.subarray(1)));
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}){
  const sent=[],faults=[],requests=[],samples=[];
  const server=new AxtpServer({send:frame=>sent.push(frame),sessionIdFactory:()=> 'ABCDEF12',onFault:error=>faults.push(error),onRequest:async(method,params)=>{requests.push([method,params]);return{accepted:true};},onStream:sample=>samples.push(sample),...options});
  const identify=()=>server.accept(rpc({sid:'',op:2,d:{randomSeed:123,eventMasks:'050101'}}));
  return{server,sent,faults,requests,samples,identify};
}

test('real Runtime OPEN negotiates JSON and server Hello/Identify/Identified establishes APP_READY',()=>{
  const f=fixture();f.server.accept(open);
  assert.equal(f.sent.length,2);
  const accept=decodeStandardFrame(f.sent[0]);assert.equal(accept.payloadType,1);assert.deepEqual([...accept.payload.subarray(0,5)],[2,0,1,0,0]);
  assert.equal(json(decodeStandardFrame(f.sent[1])).op,0);
  f.identify();assert.equal(f.server.ready,true);assert.equal(f.server.sessionId,'ABCDEF12');
  assert.deepEqual(json(decodeStandardFrame(f.sent.at(-1))),{sid:'ABCDEF12',op:3,d:{}});
  f.server.dispose();
});

test('STREAM before APP_READY and a foreign RPC sid cannot dispatch input or acquire native state',()=>{
  const f=fixture();f.server.accept(open);
  f.server.accept(encodeStandardFrame(new Uint8Array(18),{payloadType:3}));assert.equal(f.server.failed,true);assert.equal(f.samples.length,0);
  const other=fixture();other.server.accept(open);other.identify();
  other.server.accept(rpc({sid:'foreign',op:7,d:{id:1,method:'input.openStream',params:{}}}));
  assert.equal(other.server.failed,true);assert.equal(other.requests.length,0);
});

test('standard framed RPC requests preserve numeric correlation and status while input has no application ACK',async()=>{
  const f=fixture();f.server.accept(open);f.identify();
  f.server.accept(rpc({sid:f.server.sessionId,op:7,d:{id:17,method:'input.openStream',params:{commandId:'open-1'}}}));await turn();
  const response=json(decodeStandardFrame(f.sent.at(-1)));
  assert.equal(response.op,8);assert.equal(response.d.id,17);assert.equal(response.d.status.code,0);assert.equal(response.d.result.accepted,true);
  const before=f.sent.length;const payload=new Uint8Array(18);new DataView(payload.buffer).setUint32(0,1);new DataView(payload.buffer).setUint32(4,1);payload[16]=2;payload[17]=3;
  f.server.accept(encodeStandardFrame(payload,{payloadType:3}));assert.equal(f.samples.length,1);assert.equal(f.sent.length,before);
  f.server.dispose();
});

test('matching heartbeat ACK and bounded timeout fault only the dedicated input session',()=>{
  let now=0;const f=fixture({now:()=>now});f.server.accept(open);f.identify();
  f.server.accept(encodeStandardFrame(controlPayload(4,42),{payloadType:1}));
  assert.deepEqual([...decodeStandardFrame(f.sent.at(-1)).payload],[5,0,42,0,0]);
  now=5001;f.server.tick();assert.equal(f.server.failed,true);assert.equal(f.faults.length,1);
});

test('late RPC completion after session disposal cannot send an old response',async()=>{
  let finish;const f=fixture({onRequest:()=>new Promise(resolve=>{finish=resolve;})});f.server.accept(open);f.identify();
  f.server.accept(rpc({sid:f.server.sessionId,op:7,d:{id:1,method:'input.openStream',params:{}}}));await turn();
  const count=f.sent.length;f.server.dispose();finish({accepted:true});await turn();assert.equal(f.sent.length,count);
});

test('server fragments RPC messages to the negotiated frame budget without changing the JSON envelope',()=>{
  const f=fixture();const tlv=[4,2,0,20,7,1,7,8,1,1,10,2,3,232,11,1,0];
  f.server.accept(encodeStandardFrame(controlPayload(1,1,0,Uint8Array.from(tlv)),{payloadType:1}));
  assert.ok(f.sent.every(frame=>frame.length<=20));
  const reassembler=new FrameReassembler();const complete=f.sent.map(frame=>reassembler.accept(frame)).filter(Boolean);
  assert.equal(complete.length,2);assert.equal(json(complete[1]).op,0);f.server.dispose();
});

test('duplicate pending RPC IDs fault the input session rather than producing two correlated responses',async()=>{
  let finish;const f=fixture({onRequest:()=>new Promise(resolve=>{finish=resolve;})});f.server.accept(open);f.identify();
  const request=rpc({sid:f.server.sessionId,op:7,d:{id:1,method:'input.openStream',params:{}}});
  f.server.accept(request);await turn();f.server.accept(request);
  assert.equal(f.server.failed,true);const count=f.sent.length;finish({accepted:true});await turn();assert.equal(f.sent.length,count);
});
