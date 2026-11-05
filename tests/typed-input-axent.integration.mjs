// Independent Axent/Runtime wire producer. No GUI, OS input, or RX process changes.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {peer,openRequest,turn} from './helpers/typed-peer.mjs';
import {INPUT_CONTRACT} from '../src/touchback/axtp-input-contract.mjs';
const executable=process.env.AXENT_FRAMED_PROBE;
assert.ok(executable,'Set AXENT_FRAMED_PROBE to the independently built framed_client_probe.exe');
const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const lines=createInterface({input:child.stdout}),pending=[];let stderr='';
child.stderr.on('data',chunk=>{stderr+=chunk;});
lines.on('line',line=>{const waiter=pending.shift();if(waiter)waiter.resolve(JSON.parse(line));});
child.on('error',error=>{for(const waiter of pending.splice(0))waiter.reject(error);});
const command=body=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`probe timeout: ${stderr}`)),5000);pending.push({resolve:value=>{clearTimeout(timer);resolve(value);},reject});child.stdin.write(`${JSON.stringify(body)}\n`);});
const p=await peer(),trace=[],messages=[];let txIndex=0,now=100;
async function consumeResult(result){
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.failed,false,JSON.stringify(result));
  messages.push(...result.messages);trace.push({ready:result.ready,frames:result.frames,messages:result.messages});
  for(const hex of result.frames)await p.sender.handleControlMessage({data:Buffer.from(hex,'hex')});
}
async function pump(){
  for(let pass=0;pass<20;pass++){
    await turn();const outgoing=p.sent.slice(txIndex);txIndex=p.sent.length;
    const binary=outgoing.filter(value=>typeof value!=='string');
    if(!binary.length)return;
    for(const frame of binary)await consumeResult(await command({op:'consume',hex:Buffer.from(frame).toString('hex'),nowMs:++now}));
  }
  throw new Error('Wire pump did not quiesce');
}
try{
  await p.sender.setCaptureTrack(p.track);await p.sender.setEnabled(true);await p.bind();
  await consumeResult(await command({op:'start',nowMs:now,randomSeed:123,eventMasks:'050101'}));await pump();
  assert.equal(p.sender.server.ready,true);assert.equal(p.source().data.available,true);
  const request=openRequest(p.source().data.sourceBindingId);
  await consumeResult(await command({op:'request',id:1,method:'input.openStream',body:request,nowMs:++now}));await pump();
  const opened=messages.find(message=>message.kind==='response'&&message.id===1);assert.equal(opened?.status,0,JSON.stringify(messages));
  const body=typeof opened.body==='string'?JSON.parse(opened.body):opened.body,streamId=body.streamId;assert.ok(streamId>0);
  const before=p.sent.filter(value=>typeof value!=='string').length;
  for(const [seqId,phase]of [[1,0],[2,1],[3,2]]){
    await consumeResult(await command({op:'encodeInput',streamId,seqId,cursor:1000+seqId,contacts:[{id:7,phase,x:100+seqId,y:200}],maxFrameBytes:4096}));await pump();
  }
  for(const [seqId,phase]of [[4,0],[5,2]])await consumeResult(await command({op:'encodeInput',streamId,seqId,cursor:1000+seqId,contacts:[{id:7,phase,x:104,y:200},{id:500,phase,x:300,y:400}],maxFrameBytes:32}));
  await pump();
  assert.equal(p.actions.length,5);assert.equal(p.sender.diagnostics().submittedSamples,5);assert.equal(p.actions[3].records.length,2);
  assert.equal(p.sent.filter(value=>typeof value!=='string').length,before,'ordinary input must have no application ACK');
  const closeRequest={controlVersion:1,runtimeInstanceId:request.runtimeInstanceId,target:request.target,streamKind:'touchback',streamId,commandId:'close-1',reason:'peerClosed'};
  p.provider.releaseOwned=async()=>({status:'blocked',error:'fixture cleanup blocked'});
  await consumeResult(await command({op:'request',id:2,method:'input.closeStream',body:closeRequest,nowMs:++now}));await pump();
  const blocked=messages.find(message=>message.kind==='response'&&message.id===2);assert.equal(blocked?.status,15);
  const failure=typeof blocked.body==='string'?JSON.parse(blocked.body):blocked.body;
  assert.equal(failure.status.details.cleanupPending,true);assert.equal(Object.hasOwn(failure,'result'),false);assert.equal(p.sender.engine.state,'cleanup_blocked');
  p.provider.releaseOwned=async()=>({status:'released'});
  await consumeResult(await command({op:'request',id:4,method:'input.closeStream',body:closeRequest,nowMs:++now}));await pump();
  const closed=messages.find(message=>message.kind==='response'&&message.id===4);assert.equal(closed?.status,0);assert.equal(p.sender.engine.state,'closed');
  await consumeResult(await command({op:'request',id:5,method:'input.openStream',body:{...request,commandId:'open-2'},nowMs:++now}));await pump();
  const reopened=messages.find(message=>message.kind==='response'&&message.id===5);assert.equal(reopened?.status,0);
  const next=typeof reopened.body==='string'?JSON.parse(reopened.body):reopened.body;assert.ok(next.streamId>streamId);
  const result={passed:true,contract:INPUT_CONTRACT,probeSha256:createHash('sha256').update(readFileSync(executable)).digest('hex'),streamIds:[streamId,next.streamId],nativeProvider:'deterministic test provider; no physical input claimed',submittedSamples:p.actions.length,trace};
  if(process.env.TYPED_INPUT_EVIDENCE)writeFileSync(process.env.TYPED_INPUT_EVIDENCE,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({...result,trace:undefined}));
}finally{await p.sender.fence('probe complete');child.stdin.end();child.kill();}
