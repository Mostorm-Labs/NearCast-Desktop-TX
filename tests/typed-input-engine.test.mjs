import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {InputEngine} from '../src/touchback/input-engine.mjs';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/axtp/input_stream.json',import.meta.url),'utf8'));
const target={sessionId:'source-1',sessionGeneration:'1',slotId:'webcast-0',bindingGeneration:'1',lifecycleGeneration:'1'};
const binding={sessionId:'AUTH-SID',runtimeInstanceId:'rx-runtime',target,sourceBindingId:'share-binding',authorized:true,
  geometry:{proven:true,revision:'primary-1',nativeId:'primary',units:'physical-pixels',region:{x:0,y:0,width:1920,height:1080},rotation:0}};
const request=(commandId='open-1',overrides={})=>({controlVersion:1,runtimeInstanceId:'rx-runtime',target:{...target},sourceBindingId:'share-binding',streamKind:'touchback',format:'input-sample-v1',inputTypes:['touch','mouse'],maxDataBytes:4096,touch:{maxContacts:10},mouse:{...corpus.limits.mouse},commandId,...overrides});
const touch=overrides=>request('touch',{inputTypes:['touch'],mouse:undefined,...overrides});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(methods={},options={}){
  const calls=[];
  const provider={
    probe:async()=>({inputTypes:['touch','mouse'],maxDataBytes:4096,touch:{maxContacts:10},mouse:{...corpus.limits.mouse}}),
    prepare:async()=>({status:'ready'}),apply:async()=>({status:'submitted'}),releaseOwned:async()=>({status:'released'}),...methods,
  };
  for(const name of ['probe','prepare','apply','releaseOwned']){const original=provider[name];provider[name]=async(...args)=>{calls.push([name,...args]);return original(...args);};}
  const engine=new InputEngine({provider,initialStreamId:7,...options});
  await engine.bindSource(binding);
  return{engine,calls,provider};
}

test('production engine consumes the official 25 positive frames and rejects all 13 negative traces',async()=>{
  let positive=0,negative=0;
  for(const scenario of corpus.cases){
    const {engine}=await fixture();await engine.open(request(),{sessionId:'AUTH-SID'});
    let failure;
    for(const row of scenario.frames){try{await engine.acceptFrame(Buffer.from(row.hex,'hex'));positive+=scenario.valid?1:0;}catch(error){failure=error;break;}}
    if(scenario.valid){assert.equal(failure,undefined,`${scenario.name}: ${failure?.message}`);const state=engine.snapshot();assert.equal(state.touchContacts,0);assert.equal(state.mouseButtons,0);await engine.close('done');}
    else{assert.ok(failure,scenario.name);assert.match(failure.message,new RegExp(scenario.expectError,'i'),scenario.name);assert.notEqual(engine.snapshot().state,'active');negative++;}
  }
  assert.equal(positive,25);assert.equal(negative,13);
});

test('native Touch fails closed on a Mouse-only platform and source/geometry mismatches never prepare',async()=>{
  const {engine,calls}=await fixture({probe:async()=>({inputTypes:['mouse'],maxDataBytes:4096,mouse:{...corpus.limits.mouse}})});
  await assert.rejects(engine.open(touch(),{sessionId:'AUTH-SID'}),/NOT_SUPPORTED/);
  await assert.rejects(engine.open(request('wrong-source',{sourceBindingId:'other'}),{sessionId:'AUTH-SID'}),/INVALID_STATE/);
  assert.equal(calls.some(([name])=>name==='prepare'),false);
  await engine.bindSource({...binding,geometry:{...binding.geometry,proven:false}});
  await assert.rejects(engine.open(request('no-map'),{sessionId:'AUTH-SID'}),/geometry/i);
});

test('a calibrated display uses its binding revision while checking the current layout and exact binding on every open',async()=>{
  const geometry={...binding.geometry,revision:'layout:binding',layoutRevision:'layout',nativeId:'screen-binding:binding',sourceId:'browser-source',bindingId:'binding',region:{x:-1920,y:0,width:1920,height:1080}};
  let nativeGeometry={revision:'layout',browserBinding:structuredClone(geometry)};
  const {engine,calls}=await fixture({probe:async()=>({nativeReady:true,inputTypes:['touch'],maxDataBytes:4096,touch:{maxContacts:10},geometry:structuredClone(nativeGeometry)})});
  await engine.bindSource({...binding,geometry});
  const params=touch(),first=await engine.open(params,{sessionId:'AUTH-SID'});
  assert.equal((await engine.open(params,{sessionId:'AUTH-SID'})).streamId,first.streamId);
  nativeGeometry.browserBinding.bindingId='different-binding';
  await assert.rejects(engine.open(params,{sessionId:'AUTH-SID'}),/Native readiness lost/);
  assert.equal(engine.state,'closed');
  assert.equal(calls.filter(([name])=>name==='releaseOwned').length,1);
  nativeGeometry={revision:'new-layout',browserBinding:structuredClone(geometry)};
  await assert.rejects(engine.open(touch({commandId:'after-layout-change'}),{sessionId:'AUTH-SID'}),/Native geometry changed/);
  assert.equal(calls.filter(([name])=>name==='prepare').length,1);
});

test('close waits for native release; failed cleanup blocks owner acquisition and explicit retry recovers',async()=>{
  let finishRelease;
  const {engine}=await fixture({releaseOwned:()=>new Promise(resolve=>{finishRelease=resolve;})});
  const first=await engine.open(touch(),{sessionId:'AUTH-SID'});
  let closed=false;const closing=engine.close('requested').then(result=>{closed=true;return result;});
  await delay(0);assert.equal(closed,false);assert.equal(engine.snapshot().state,'closing');
  await assert.rejects(engine.open(touch({commandId:'second'}),{sessionId:'AUTH-SID'}),/BUSY|cleanup/i);
  finishRelease({status:'blocked',error:'permission lost'});
  await assert.rejects(closing,/cleanup|UNAVAILABLE/i);assert.equal(engine.snapshot().state,'cleanup_blocked');
  await assert.rejects(engine.open(touch({commandId:'third'}),{sessionId:'AUTH-SID'}),/BUSY|cleanup/i);
  const retry=engine.close('retry');await delay(0);finishRelease({status:'released'});await retry;
  const next=await engine.open(touch({commandId:'fourth'}),{sessionId:'AUTH-SID'});assert.ok(next.streamId>first.streamId);
  const final=engine.close('done');await delay(0);finishRelease({status:'released'});await final;
});

test('disconnect drops queued samples, waits for in-flight native input, and releases the same owner',async()=>{
  let finishApply;
  const {engine,calls}=await fixture({apply:()=>new Promise(resolve=>{finishApply=resolve;})});
  await engine.open(touch(),{sessionId:'AUTH-SID'});
  const frames=corpus.cases[0].frames;
  const first=engine.acceptFrame(Buffer.from(frames[0].hex,'hex'));
  while(!finishApply)await delay(0);
  const second=engine.acceptFrame(Buffer.from(frames[1].hex,'hex')).catch(error=>error);
  const closing=engine.close('disconnect');finishApply({status:'submitted'});
  await first;await second;await closing;
  assert.equal(calls.filter(([name])=>name==='apply').length,1);
  const owner=calls.find(([name])=>name==='prepare')[1].ownerId;
  assert.equal(calls.findLast(([name])=>name==='releaseOwned')[1].ownerId,owner);
  assert.equal(engine.snapshot().state,'closed');
});

test('late prepare cannot activate after timeout and its resource is released before a new owner',async()=>{
  let finishPrepare;
  const {engine,calls}=await fixture({prepare:()=>new Promise(resolve=>{finishPrepare=resolve;})},{operationTimeoutMs:10,cleanupTimeoutMs:10});
  await assert.rejects(engine.open(touch(),{sessionId:'AUTH-SID'}),failure=>failure.code==='UNAVAILABLE'&&failure.details.cleanupPending===true&&/TIMEOUT/.test(failure.details.diagnosticReason));
  assert.notEqual(engine.snapshot().state,'active');
  await assert.rejects(engine.open(touch({commandId:'next'}),{sessionId:'AUTH-SID'}),/BUSY|cleanup/i);
  finishPrepare({status:'ready'});await delay(20);
  assert.equal(engine.snapshot().state,'closed');
  assert.equal(calls.filter(([name])=>name==='releaseOwned').length,1);
});

test('partial native result is never reported as a submitted sample and triggers owned cleanup',async()=>{
  const feedback=[];const {engine,calls}=await fixture({apply:async()=>({status:'partial',submittedActions:1,error:'native failure'})},{onTouchFeedback:event=>feedback.push(event)});
  await engine.open(touch(),{sessionId:'AUTH-SID'});
  await assert.rejects(engine.acceptFrame(Buffer.from(corpus.cases[0].frames[0].hex,'hex')),/native failure/);
  assert.equal(engine.snapshot().submittedSamples,0);assert.equal(engine.snapshot().state,'closed');
  assert.equal(feedback.some(event=>event.stage==='received'),true);assert.equal(feedback.some(event=>event.stage==='submitted'),false);
  assert.equal(calls.filter(([name])=>name==='releaseOwned').length,1);
});

test('idempotent open never reports active when native readiness has been withdrawn',async()=>{
  const {engine,provider}=await fixture();const params=touch();await engine.open(params,{sessionId:'AUTH-SID'});
  const original=provider.probe;provider.probe=async()=>({...await original(),nativeReady:false});
  await assert.rejects(engine.open(params,{sessionId:'AUTH-SID'}),/Native readiness lost/);
  assert.notEqual(engine.state,'active');
});

test('queue overflow fences pending work and releases after the sole in-flight native call',async()=>{
  let finish;const {engine,calls}=await fixture({apply:()=>new Promise(resolve=>{finish=resolve;})},{maxQueuedSamples:1});
  await engine.open(touch(),{sessionId:'AUTH-SID'});
  const sample=seqId=>({streamId:7,seqId,cursor:seqId,inputType:'touch',dataBytes:8,records:[{contactId:1,phase:seqId===2?2:0,x:1,y:2}]});
  const first=engine.accept(sample(1));while(!finish)await delay(0);
  const queued=engine.accept(sample(2));const overflow=engine.accept(sample(3));
  assert.equal(engine.state,'closing');finish({status:'submitted'});
  await assert.rejects(overflow,/queue budget/);await first;assert.equal((await queued).status,'stale');
  assert.equal(calls.filter(([name])=>name==='apply').length,1);assert.equal(engine.state,'closed');
});

test('queued input that exceeds the age budget is discarded before native submission',async()=>{
  let now=0,finish;const {engine,calls}=await fixture({apply:()=>new Promise(resolve=>{finish=resolve;})},{now:()=>now,maxQueueAgeMs:50});
  await engine.open(touch(),{sessionId:'AUTH-SID'});
  const sample=seqId=>({streamId:7,seqId,cursor:seqId,inputType:'touch',dataBytes:8,records:[{contactId:1,phase:seqId===1?0:1,x:1,y:2}]});
  const first=engine.accept(sample(1));while(!finish)await delay(0);
  const stale=engine.accept(sample(2));const rejection=assert.rejects(stale,/queue age/);
  now=51;finish({status:'submitted'});await first;await rejection;
  assert.equal(calls.filter(([name])=>name==='apply').length,1);assert.equal(engine.state,'closed');
});

test('delayed title-bar mouse release discards aged idle hover and keeps the stream usable',async()=>{
  let now=0,finish;
  const {engine,calls,provider}=await fixture({}, {now:()=>now});
  await engine.open(request(),{sessionId:'AUTH-SID'});
  const mouse=(seqId,eventKind,buttons)=>({streamId:7,seqId,cursor:seqId,inputType:'mouse',dataBytes:12,eventKind,buttons,modifiers:0,x:300,y:100});
  await engine.accept(mouse(1,1,1));
  provider.apply=()=>new Promise(resolve=>{finish=resolve;});
  const release=engine.accept(mouse(2,1,0));while(!finish)await delay(0);
  const hover=engine.accept(mouse(3,0,0));now=537;
  provider.apply=async()=>({status:'submitted',nativeDurationMs:1});
  finish({status:'submitted',nativeDurationMs:17});await release;
  assert.equal((await hover).status,'discarded');
  assert.equal(engine.state,'active');assert.equal(engine.snapshot().discardedSamples,1);
  assert.equal(engine.snapshot().mouseButtons,0);assert.equal(engine.snapshot().receivedSeqId,3);
  assert.equal(engine.snapshot().submittedSeqId,2);
  assert.equal(calls.some(([name])=>name==='releaseOwned'),false);
  await engine.accept(mouse(4,1,1));await engine.accept(mouse(5,1,0));
  assert.equal(engine.snapshot().submittedSeqId,5);assert.equal(engine.state,'active');
  await engine.close('done');
});

test('aged held-button motion and release still fail closed instead of replaying a delayed drag',async()=>{
  for(const [kind,buttons]of [[0,1],[1,0]]){
    let now=0,finish;const {engine}=await fixture({apply:()=>new Promise(resolve=>{finish=resolve;})},{now:()=>now});
    await engine.open(request(),{sessionId:'AUTH-SID'});
    const mouse=(seqId,eventKind,buttons)=>({streamId:7,seqId,cursor:seqId,inputType:'mouse',dataBytes:12,eventKind,buttons,modifiers:0,x:300,y:100});
    const down=engine.accept(mouse(1,1,1));while(!finish)await delay(0);
    const queued=engine.accept(mouse(2,kind,buttons));const rejected=assert.rejects(queued,/Input queue age/);
    now=537;finish({status:'submitted'});await down;await rejected;
    assert.equal(engine.state,'closed');
  }
});

test('drag flow reports received and submitted rates and preserves the latest full-distance point',async()=>{
  let now=0,finish;const actions=[];
  const {engine,provider}=await fixture({apply:async action=>{actions.push(action);return{status:'submitted',nativeDurationMs:1};}},{now:()=>now});
  await engine.open(request(),{sessionId:'AUTH-SID'});
  const mouse=(seqId,eventKind,buttons,x)=>({streamId:7,seqId,cursor:seqId,inputType:'mouse',dataBytes:12,eventKind,buttons,modifiers:0,x,y:100});
  await engine.accept(mouse(1,1,1,0));
  provider.apply=action=>{actions.push(action);return new Promise(resolve=>{finish=resolve;});};
  const first=engine.accept(mouse(2,0,1,100));while(!finish)await delay(0);
  const pending=[];for(let seq=3;seq<=12;seq++)pending.push(engine.accept(mouse(seq,0,1,seq===12?65535:seq*100)));
  now=20;provider.apply=async action=>{actions.push(action);return{status:'submitted',nativeDurationMs:1};};
  finish({status:'submitted',nativeDurationMs:1});await first;await Promise.all(pending);
  const flow=engine.snapshot().inputFlow;
  assert.equal(flow.receivedPerSecond,12);assert.equal(flow.submittedPerSecond,3);
  assert.equal(flow.lastReceivedPosition.x,65535);assert.equal(flow.lastSubmittedPosition.x,1919);
  assert.equal(actions.at(-1).x,1919);assert.equal(engine.snapshot().coalescedSamples,9);
  await engine.accept(mouse(13,1,0,65535));assert.equal(engine.snapshot().mouseButtons,0);
  now=1200;assert.equal(engine.snapshot().inputFlow.receivedPerSecond,0);
  await engine.close('done');
});

test('revoked source remains unauthorized after blocked cleanup and an explicit successful retry',async()=>{
  let release=false;const {engine}=await fixture({releaseOwned:async()=>release?{status:'released'}:{status:'blocked'}});
  const params=touch();await engine.open(params,{sessionId:'AUTH-SID'});
  await assert.rejects(engine.bindSource(null),/UNAVAILABLE/);assert.equal(engine.binding,null);
  release=true;await engine.close('explicit retry');
  await assert.rejects(engine.open({...params,commandId:'old-source'},{sessionId:'AUTH-SID'}),/PERMISSION_DENIED/);
});


test('slow native submission coalesces queued Touch motion into the latest complete sample and preserves Up',async t=>{
  let now=0;const finishes=[];
  const {engine,calls,provider}=await fixture({apply:()=>new Promise(resolve=>finishes.push(resolve))},{now:()=>now});
  t.after(async()=>{provider.apply=async()=>({status:'submitted'});for(const finish of finishes.splice(0))finish({status:'submitted'});await engine.close('test cleanup');});
  await engine.open(touch(),{sessionId:'AUTH-SID'});
  const pending=[],sample=(seqId,phase)=>({streamId:7,seqId,cursor:seqId,inputType:'touch',dataBytes:8,records:[{contactId:1,phase,x:seqId,y:20}]});
  pending.push(engine.accept(sample(1,0)));while(!finishes.length)await delay(0);
  for(let seq=2;seq<=52;seq++){now=(seq-1)*4;pending.push(engine.accept(sample(seq,seq===52?2:1)).catch(error=>({error})));}
  assert.equal(engine.snapshot().queueLength,1,'fresh motion/terminal snapshots must replace old pending motion, not build a delayed backlog');
  now=210;finishes.shift()({status:'submitted'});while(!finishes.length)await delay(0);
  now+=172;finishes.shift()({status:'submitted'});const results=await Promise.all(pending);
  assert.ok(results.every(result=>!result.error));assert.equal(engine.state,'active');assert.equal(engine.snapshot().touchContacts,0);
  assert.equal(engine.snapshot().coalescedSamples,50);assert.equal(engine.snapshot().receivedSamples,52);assert.equal(engine.snapshot().validatedSamples,52);
  assert.equal(engine.snapshot().submittedSamples,2);assert.equal(engine.streamState(7,'AUTH-SID').lastSeqId,52);
  assert.deepEqual(calls.filter(([name])=>name==='apply').map(([,action])=>action.records[0].phase),[0,2]);
});

test('every wire sequence is validated before queued motion can be coalesced',async t=>{
  let finish;const {engine,provider}=await fixture({apply:()=>new Promise(resolve=>{finish=resolve;})});
  t.after(async()=>{provider.apply=async()=>({status:'submitted'});finish?.({status:'submitted'});await engine.close('test cleanup');});
  await engine.open(touch(),{sessionId:'AUTH-SID'});
  const sample=(seqId,phase)=>({streamId:7,seqId,cursor:seqId,inputType:'touch',dataBytes:8,records:[{contactId:1,phase,x:seqId,y:20}]});
  const first=engine.accept(sample(1,0));while(!finish)await delay(0);
  const move=engine.accept(sample(2,1));const gap=engine.accept(sample(4,1)).catch(error=>error);
  assert.equal(engine.state,'closing','a sequence gap must be fenced on arrival, including while the native call is in flight');
  finish({status:'submitted'});await first;await move;assert.match((await gap).message,/sequence/i);assert.equal(engine.state,'closed');
});

test('Touch down, up and cancel barriers survive a burst of coalescible motion',async t=>{
  const finishes=[];const {engine,calls,provider}=await fixture({apply:()=>new Promise(resolve=>finishes.push(resolve))});
  t.after(async()=>{provider.apply=async()=>({status:'submitted'});for(const finish of finishes.splice(0))finish({status:'submitted'});await engine.close('test cleanup');});
  await engine.open(touch(),{sessionId:'AUTH-SID'});
  const phases=[0,1,2,0,1,1,1,1,3],pending=[];
  for(const [i,phase]of phases.entries()){pending.push(engine.accept({streamId:7,seqId:i+1,cursor:i+1,inputType:'touch',dataBytes:8,records:[{contactId:1,phase,x:i,y:10}]}).catch(error=>({error})));if(!i)while(!finishes.length)await delay(0);}
  assert.equal(engine.snapshot().queueLength,3);
  for(let i=0;i<4;i++){while(!finishes.length)await delay(0);finishes.shift()({status:'submitted'});await delay(0);}
  assert.ok((await Promise.all(pending)).every(result=>!result.error));
  assert.deepEqual(calls.filter(([name])=>name==='apply').map(([,action])=>action.records[0].phase),[0,2,0,3]);
  assert.equal(engine.state,'active');assert.equal(engine.snapshot().touchContacts,0);
});


test('full multi-contact snapshots keep additions and terminal contacts while reducing pure motion',async t=>{
  const finishes=[];const {engine,calls,provider}=await fixture({apply:()=>new Promise(resolve=>finishes.push(resolve))});
  t.after(async()=>{provider.apply=async()=>({status:'submitted'});for(const finish of finishes.splice(0))finish({status:'submitted'});await engine.close('test cleanup');});
  await engine.open(touch(),{sessionId:'AUTH-SID'});
  const rows=[[[1,0]],[[1,1]],[[1,1]],[[1,1],[2,0]],[[1,2],[2,1]],[[2,1]],[[2,1]],[[2,2]]],pending=[];
  for(const [i,row]of rows.entries()){
    pending.push(engine.accept({streamId:7,seqId:i+1,cursor:i+1,inputType:'touch',dataBytes:1+7*row.length,records:row.map(([contactId,phase])=>({contactId,phase,x:i,y:10}))}).catch(error=>({error})));
    if(!i)while(!finishes.length)await delay(0);
  }
  assert.equal(engine.snapshot().queueLength,3);
  for(let i=0;i<4;i++){while(!finishes.length)await delay(0);finishes.shift()({status:'submitted'});await delay(0);}
  assert.ok((await Promise.all(pending)).every(result=>!result.error));
  assert.deepEqual(calls.filter(([name])=>name==='apply').map(([,action])=>action.records.map(r=>[r.contactId,r.phase])),[[[1,0]],[[1,1],[2,0]],[[1,2],[2,1]],[[2,2]]]);
  assert.equal(engine.snapshot().touchContacts,0);assert.equal(engine.streamState(7,'AUTH-SID').lastSeqId,8);
});

test('Mouse modifier changes and button transitions remain ordered barriers between motion samples',async t=>{
  const finishes=[];const {engine,calls,provider}=await fixture({apply:()=>new Promise(resolve=>finishes.push(resolve))});
  t.after(async()=>{provider.apply=async()=>({status:'submitted'});for(const finish of finishes.splice(0))finish({status:'submitted'});await engine.close('test cleanup');});
  await engine.open(request(),{sessionId:'AUTH-SID'});
  const rows=[[0,0,0],[0,0,0],[0,0,0],[0,0,1],[1,1,1],[0,1,1],[0,1,1],[1,0,1]],pending=[];
  for(const [i,[eventKind,buttons,modifiers]]of rows.entries()){
    pending.push(engine.accept({streamId:7,seqId:i+1,cursor:i+1,inputType:'mouse',dataBytes:12,eventKind,buttons,modifiers,x:i,y:10}).catch(error=>({error})));
    if(!i)while(!finishes.length)await delay(0);
  }
  assert.equal(engine.snapshot().queueLength,5);
  for(let i=0;i<6;i++){while(!finishes.length)await delay(0);finishes.shift()({status:'submitted'});await delay(0);}
  assert.ok((await Promise.all(pending)).every(result=>!result.error));
  assert.deepEqual(calls.filter(([name])=>name==='apply').map(([,action])=>[action.eventKind,action.buttons,action.modifiers]),[[0,0,0],[0,0,0],[0,0,1],[1,1,1],[0,1,1],[1,0,1]]);
  assert.equal(engine.snapshot().mouseButtons,0);
});

test('continuous Mouse wheel backlog accumulates every delta without crossing Began, Ended, modifier or direction barriers',async t=>{
  let now=0,finish,hold=true;
  const {engine,calls,provider}=await fixture({apply:()=>hold?new Promise(resolve=>{finish=resolve;}):Promise.resolve({status:'submitted'})},{now:()=>now,maxQueuedSamples:8});
  t.after(async()=>{provider.apply=async()=>({status:'submitted'});finish?.({status:'submitted'});await engine.close();});
  await engine.open(request('wheel-burst'),{sessionId:'AUTH-SID'});
  const wheel=(seqId,phase,x=64,y=-128,modifiers=0)=>({streamId:7,seqId,cursor:seqId,inputType:'mouse',dataBytes:22,eventKind:2,buttons:0,modifiers,x:10000,y:20000,wheelUnit:1,wheelPhase:phase,wheelX:x,wheelY:y});
  const pending=[engine.accept(wheel(1,1))];while(!finish)await delay(0);
  for(let seq=2;seq<=81;seq++){now=seq;pending.push(engine.accept(wheel(seq,2,seq%2?0:64)).catch(error=>({error})));}
  pending.push(engine.accept(wheel(82,2,-64,128)).catch(error=>({error})));
  pending.push(engine.accept(wheel(83,2,-64,128,2)).catch(error=>({error})));
  pending.push(engine.accept(wheel(84,3,0,0,2)).catch(error=>({error})));
  assert.equal(engine.snapshot().queueLength,4,'80 queued Changed frames should become one additive action');
  hold=false;now=120;finish({status:'submitted'});
  assert.ok((await Promise.all(pending)).every(result=>!result.error));
  const actions=calls.filter(([name])=>name==='apply').map(([,a])=>a);
  assert.deepEqual(actions.map(a=>[a.wheelPhase,a.wheelX,a.wheelY,a.modifiers]),[[1,64,-128,0],[2,2560,-10240,0],[2,-64,128,0],[2,-64,128,2],[3,0,0,2]]);
  assert.equal(engine.streamState(7,'AUTH-SID').lastSeqId,84);assert.equal(engine.snapshot().scrollActive,false);
  assert.equal(engine.snapshot().coalescedSamples,79);assert.equal(engine.state,'active');
});

test('wheel coalescing preserves the oldest delta age and cannot extend the stale-input budget',async t=>{
  let now=0,finish;
  const {engine,provider}=await fixture({apply:()=>new Promise(resolve=>{finish=resolve;})},{now:()=>now,maxQueueAgeMs:50});
  t.after(async()=>{provider.apply=async()=>({status:'submitted'});finish?.({status:'submitted'});await engine.close();});
  await engine.open(request('wheel-age'),{sessionId:'AUTH-SID'});
  const wheel=seqId=>({streamId:7,seqId,cursor:seqId,inputType:'mouse',dataBytes:22,eventKind:2,buttons:0,modifiers:0,x:100,y:200,wheelUnit:0,wheelPhase:0,wheelX:0,wheelY:120});
  const first=engine.accept(wheel(1));while(!finish)await delay(0);
  const queued=engine.accept(wheel(2)).catch(error=>error);now=40;const next=engine.accept(wheel(3)).catch(error=>error);
  now=60;provider.apply=async()=>({status:'submitted'});finish({status:'submitted'});
  await first;await queued;assert.match((await next).message,/Input queue age/);assert.equal(engine.state,'closed');
});

test('a sequence gap is rejected before wheel aggregation and releases the in-flight owner',async t=>{
  let finish;const {engine,provider}=await fixture({apply:()=>new Promise(resolve=>{finish=resolve;})});
  t.after(async()=>{provider.apply=async()=>({status:'submitted'});finish?.({status:'submitted'});await engine.close();});
  await engine.open(request('wheel-gap'),{sessionId:'AUTH-SID'});
  const wheel=seqId=>({streamId:7,seqId,cursor:seqId,inputType:'mouse',dataBytes:22,eventKind:2,buttons:0,modifiers:0,x:100,y:200,wheelUnit:0,wheelPhase:0,wheelX:0,wheelY:120});
  const first=engine.accept(wheel(1));while(!finish)await delay(0);
  const queued=engine.accept(wheel(2));const gap=engine.accept(wheel(4)).catch(error=>error);
  assert.equal(engine.state,'closing');finish({status:'submitted'});await first;await queued;
  assert.match((await gap).message,/sequence/);assert.equal(engine.state,'closed');
});

test('detent wheel aggregation keeps totals, anchors, cancel and overflow boundaries',async t=>{
  let finish,hold=true;const {engine,calls,provider}=await fixture({apply:()=>hold?new Promise(resolve=>{finish=resolve;}):Promise.resolve({status:'submitted'})});
  t.after(async()=>{provider.apply=async()=>({status:'submitted'});finish?.({status:'submitted'});await engine.close();});
  await engine.open(request('detents'),{sessionId:'AUTH-SID'});
  const wheel=(seqId,delta,x=100)=>({streamId:7,seqId,cursor:seqId,inputType:'mouse',dataBytes:22,eventKind:2,buttons:0,modifiers:0,x,y:200,wheelUnit:0,wheelPhase:0,wheelX:0,wheelY:delta});
  const pending=[engine.accept(wheel(1,120))];while(!finish)await delay(0);
  for(const [index,delta]of [120,240,-120,2147483640,120].entries())pending.push(engine.accept(wheel(index+2,delta)));
  pending.push(engine.accept(wheel(7,120,101)));
  pending.push(engine.accept({streamId:7,seqId:8,cursor:8,inputType:'mouse',dataBytes:2,eventKind:3}));
  hold=false;finish({status:'submitted'});await Promise.all(pending);
  assert.deepEqual(calls.filter(([name])=>name==='apply').map(([,a])=>a.eventKind===2?[a.wheelY,a.x]:['cancel']),[[120,3],[360,3],[-120,3],[2147483640,3],[120,3],[120,3],['cancel']]);
  assert.equal(engine.snapshot().mouseButtons,0);
});


test('Touch feedback reports received physical points before native completion and clears on close',async t=>{
  const events=[];let finish;
  const {engine}=await fixture({apply:()=>new Promise(resolve=>{finish=resolve;})},{onTouchFeedback:event=>events.push(event)});
  await engine.open(touch({commandId:'feedback'}),{sessionId:'AUTH-SID'});
  const pending=engine.accept({inputType:'touch',streamId:7,seqId:1,cursor:1n,dataBytes:8,records:[{contactId:41,phase:0,x:65535,y:0}]});
  pending.catch(()=>{});t.after(async()=>{await delay(0);finish?.({status:'submitted'});await pending.catch(()=>{});await engine.close();});
  assert.equal(events[0]?.stage,'received');assert.equal(events[0].records[0].x,1919);assert.equal(events[0].records[0].y,0);
  assert.equal(events.some(event=>event.stage==='submitted'),false);
  await delay(0);finish({status:'submitted'});await pending;
  assert.equal(events.at(-1).stage,'submitted');assert.equal(events.at(-1).seqId,1);
  await engine.close();assert.equal(events.at(-1).stage,'clear');
});

test('a broken Touch visualization observer cannot change native input or cleanup',async()=>{
  const {engine,calls}=await fixture({}, {onTouchFeedback(){throw new Error('overlay unavailable');}});
  await engine.open(touch({commandId:'feedback-fails'}),{sessionId:'AUTH-SID'});
  await engine.accept({inputType:'touch',streamId:7,seqId:1,cursor:1n,dataBytes:8,records:[{contactId:1,phase:0,x:0,y:0}]});
  await engine.close();assert.equal(calls.filter(([method])=>method==='apply').length,1);assert.equal(engine.snapshot().state,'closed');
});
