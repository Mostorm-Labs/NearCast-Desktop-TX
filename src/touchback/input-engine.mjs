import {decodeInputFrame} from './typed-codec.mjs';
import {INPUT_CONTRACT} from './axtp-input-contract.mjs';
import {InputState} from './input-state.mjs';
import {GeometryMapper} from './geometry-mapper.mjs';
import {integer} from './frame-codec.mjs';

const text=value=>typeof value==='string'&&value.length>0&&value.length<=128;
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const same=(a,b)=>canonical(a)===canonical(b);
function nativeGeometryMatches(snapshot,descriptor){
  if(descriptor.nativeId?.startsWith('screen-binding:')){
    const binding=snapshot?.browserBinding;
    return Boolean(binding&&snapshot.revision===descriptor.layoutRevision&&
      ['sourceId','bindingId','nativeId','revision','layoutRevision'].every(key=>binding[key]===descriptor[key]));
  }
  return !snapshot||snapshot.revision===descriptor.revision;
}
// Only an unsubmitted motion snapshot can be superseded. Lifecycle frames
// remain barriers, and wire validation happens before any queue reduction.
function supersedesMotion(previous,next){
  if(previous?.streamId!==next.streamId||previous.inputType!==next.inputType)return false;
  if(previous.inputType==='touch')return previous.records.every(record=>record.phase===1)&&previous.records.every(record=>next.records.some(value=>value.contactId===record.contactId));
  return previous.eventKind===0&&next.eventKind===0&&previous.buttons===next.buttons&&previous.modifiers===next.modifiers;
}
function accumulateWheel(previous,next,region){
  if(previous?.streamId!==next.streamId||previous.inputType!=='mouse'||next.inputType!=='mouse'||
    previous.eventKind!==2||next.eventKind!==2||previous.wheelUnit!==next.wheelUnit||
    previous.wheelPhase!==next.wheelPhase||!([0,2].includes(next.wheelPhase))||
    previous.buttons!==next.buttons||previous.modifiers!==next.modifiers||previous.x!==next.x||previous.y!==next.y)return null;
  const result={...next};
  for(const [axis,extent]of [['wheelX',region.width],['wheelY',region.height]]){
    // A direction change is a user-visible barrier, never cancel it out by
    // summing opposite deltas. Keep i32 wire/native budgets after accumulation.
    if(previous[axis]!==0&&next[axis]!==0&&Math.sign(previous[axis])!==Math.sign(next[axis]))return null;
    const sum=previous[axis]+next[axis];
    if(!integer(sum,-2147483648,2147483647)||next.wheelUnit===1&&Math.abs(sum)/65536*Math.max(1,extent-1)*3>2999999)return null;
    result[axis]=sum;
  }
  return result;
}
export class InputError extends Error{constructor(code,message=code,details){super(`${code}: ${message}`);this.code=code;this.details=details;}}
const requireInput=(condition,code,message)=>{if(!condition)throw new InputError(code,message);};
const timeout=(promise,ms,code='TIMEOUT')=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new InputError(code,'Native operation timed out',{cleanupPending:true})),ms);
  promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});

export class InputEngine{
  constructor({provider,initialStreamId=1,operationTimeoutMs=3000,cleanupTimeoutMs=3000,maxQueuedSamples=64,maxQueuedRecords=2048,maxQueuedBytes=65536,maxQueueAgeMs=250,now=()=>performance.now(),onState=()=>{},onTouchFeedback=()=>{}}={}){
    Object.assign(this,{provider,initialStreamId,operationTimeoutMs,cleanupTimeoutMs,maxQueuedSamples,maxQueuedRecords,maxQueuedBytes,maxQueueAgeMs,now,onState,onTouchFeedback});
    this.state='closed';this.generation=0;this.bindingToken=0;this.binding=null;this.owner=null;this.stream=null;this.input=new InputState();this.ingress=new InputState();
    this.nextIds=new Map();this.commands=new Map();this.closedIds=new Map();this.queue=[];this.pumping=false;
    this.nativeTail=Promise.resolve();this.cleanupActual=null;this.lastError=null;
    this.stats={receivedSamples:0,validatedSamples:0,submittedSamples:0,submittedRecords:0,coalescedSamples:0,discardedSamples:0,failedSamples:0,queuePeak:0,lastNativeMs:0,lastNativeExecutionMs:0,lastQueueWaitMs:0,queueWaitPeakMs:0,cleanupMs:0};
  }
  notify(){try{this.onState(this.snapshot());}catch{/* Observability never owns input lifecycle. */}}
  touchFeedback(stage,sample){
    try{
      if(stage==='clear')this.onTouchFeedback({stage});
      else if(sample?.inputType==='touch')this.onTouchFeedback({stage,streamId:sample.streamId,seqId:sample.seqId,ownerId:this.owner?.ownerId,
        geometry:structuredClone(this.mapper.descriptor),records:this.mapper.map(sample).records});
    }catch{/* Visual feedback is bounded observability, never input authority. */}
  }
  snapshot(){return{state:this.state,streamId:this.stream?.streamId??this.owner?.streamId??this.lastClosedId??null,generation:this.generation,
    contractFingerprint:INPUT_CONTRACT.fingerprint,acceptedInputTypes:[...(this.stream?.acceptedInputTypes??[])],outputPolicy:this.provider.snapshot?.().outputPolicy??'native',
    geometryRevision:this.binding?.geometry?.revision??null,receivedSeqId:this.ingress.seqId,submittedSeqId:this.input.seqId,queueLength:this.queue.length,touchContacts:this.input.contacts.size,
    mouseButtons:this.input.buttons,mouseModifiers:this.input.modifiers,scrollActive:Boolean(this.input.scroll),cleanupPending:['closing','cleanup_blocked'].includes(this.state),
    lastError:this.lastError,...this.stats};}
  enqueueNative(task){const result=this.nativeTail.then(task,task);this.nativeTail=result.then(()=>{},()=>{});return result;}
  async bindSource(binding){
    if(this.binding&&same(this.binding,binding))return;
    const token=++this.bindingToken;
    // Revoke immediately, even if native cleanup later fails. The old owner
    // retains its immutable identity solely for authenticated close/retry.
    this.binding=null;
    if(this.owner)await this.close('source changed');
    requireInput(token===this.bindingToken,'CANCELED','Stale source binding');
    requireInput(this.state==='closed','BUSY','cleanup pending');
    this.binding=binding?structuredClone(binding):null;this.generation++;this.notify();
  }
  identity(params,sessionId,expected=this.binding){
    requireInput(expected?.authorized===true&&text(sessionId)&&sessionId===expected.sessionId,'PERMISSION_DENIED','Authenticated source session required');
    requireInput(params?.runtimeInstanceId===expected.runtimeInstanceId&&same(params.target,expected.target),'INVALID_STATE','Source target/runtime mismatch');
  }
  negotiate(params,caps){
    requireInput(params.controlVersion===1&&params.streamKind==='touchback'&&params.format==='input-sample-v1','NOT_SUPPORTED','Input format/control version');
    const types=params.inputTypes;
    requireInput(Array.isArray(types)&&types.length>0&&new Set(types).size===types.length&&types.every(type=>['touch','mouse'].includes(type)),'INVALID_ARGUMENT','Input types');
    requireInput(Boolean(params.touch)===types.includes('touch')&&Boolean(params.mouse)===types.includes('mouse'),'INVALID_ARGUMENT','Per-type constraints');
    requireInput(integer(params.maxDataBytes,8,4096),'INVALID_ARGUMENT','Data budget');
    const acceptedInputTypes=types.filter(type=>caps.inputTypes?.includes(type));requireInput(acceptedInputTypes.length>0,'NOT_SUPPORTED','No native input type intersection');
    const maxDataBytes=Math.min(params.maxDataBytes,caps.maxDataBytes??4096,4096),result={format:'input-sample-v1',acceptedInputTypes,maxDataBytes,accepted:true};
    if(types.includes('touch'))requireInput(integer(params.touch.maxContacts,1,256),'INVALID_ARGUMENT','Touch contact limit');
    if(acceptedInputTypes.includes('touch'))result.touch={maxContacts:Math.min(params.touch.maxContacts,caps.touch.maxContacts,Math.floor((maxDataBytes-1)/7))};
    if(types.includes('mouse')){
      const m=params.mouse;requireInput(integer(m.buttonsMask,0,31)&&integer(m.modifierMask,0,15)&&typeof m.allowChords==='boolean'&&typeof m.continuousScroll==='boolean','INVALID_ARGUMENT','Mouse masks');
      requireInput(Array.isArray(m.wheelUnits)&&new Set(m.wheelUnits).size===m.wheelUnits.length&&m.wheelUnits.every(unit=>['detent120','regionQ16_16'].includes(unit)),'INVALID_ARGUMENT','Wheel units');
      if(acceptedInputTypes.includes('mouse')){
        const native=caps.mouse,units=m.wheelUnits.filter(unit=>native.wheelUnits.includes(unit));
        requireInput(maxDataBytes>=(units.length?22:12),'NOT_SUPPORTED','Mouse data budget');
        result.mouse={buttonsMask:m.buttonsMask&native.buttonsMask,modifierMask:m.modifierMask&native.modifierMask,allowChords:m.allowChords&&native.allowChords,wheelUnits:units,continuousScroll:m.continuousScroll&&native.continuousScroll&&units.includes('regionQ16_16')};
      }
    }
    return result;
  }
  async open(params,{sessionId}={}){
    this.identity(params,sessionId);
    requireInput(params.sourceBindingId===this.binding.sourceBindingId&&text(params.sourceBindingId),'INVALID_STATE','Source binding mismatch');
    requireInput(text(params.commandId),'INVALID_ARGUMENT','commandId');
    const geometry=new GeometryMapper(this.binding.geometry),key=`${sessionId}:${params.commandId}`,fingerprint=canonical(params);
    for(const [id,item]of this.commands)if(this.now()-item.time>300000&&!item.pending)this.commands.delete(id);
    const previous=this.commands.get(key);
    if(previous){
      requireInput(previous.fingerprint===fingerprint,'INVALID_ARGUMENT','Conflicting commandId');
      if(previous.pending)return previous.pending;
      requireInput(this.state==='active'&&this.stream?.streamId===previous.result.streamId,'INVALID_STATE','Retired open command');
      const caps=await timeout(this.enqueueNative(()=>this.provider.probe()),this.operationTimeoutMs);
      const ready=this.state==='active'&&this.stream?.streamId===previous.result.streamId&&caps.nativeReady!==false&&!caps.cleanupBlocked&&
        nativeGeometryMatches(caps.geometry,geometry.descriptor)&&previous.result.acceptedInputTypes.every(type=>caps.inputTypes?.includes(type));
      if(!ready){const failure=new InputError('INVALID_STATE','Native readiness lost');if(this.owner)await this.fault(failure).catch(()=>{});throw failure;}
      return structuredClone(previous.result);
    }
    requireInput(this.state==='closed','BUSY','Native input owner/cleanup pending');
    const nextId=this.nextIds.get(sessionId)??this.initialStreamId;requireInput(nextId<=0xffffffff,'UNAVAILABLE','Stream ID exhausted');
    this.nextIds.set(sessionId,nextId+1);this.generation++;
    const generation=this.generation,owner={ownerId:crypto.randomUUID(),sessionId,streamId:nextId,generation,geometry:geometry.descriptor,binding:structuredClone(this.binding)};
    this.owner=owner;this.state='opening';this.lastError=null;this.notify();
    const entry={fingerprint,time:this.now(),pending:null,result:null};
    const run=async()=>{
      try{
        const caps=await timeout(this.enqueueNative(()=>this.provider.probe()),this.operationTimeoutMs);
        requireInput(caps.nativeReady!==false&&!caps.cleanupBlocked,'NOT_SUPPORTED','Native input not ready');
        requireInput(nativeGeometryMatches(caps.geometry,geometry.descriptor),'INVALID_STATE','Native geometry changed');
        const result=this.negotiate(params,caps);
        requireInput(this.owner===owner&&generation===this.generation,'CANCELED','Stale open');
        const prepared=await timeout(this.enqueueNative(()=>this.provider.prepare(owner,result)),this.operationTimeoutMs);
        requireInput(this.owner===owner&&generation===this.generation&&this.state==='opening','CANCELED','Stale prepare completion');
        requireInput(prepared?.status==='ready','UNAVAILABLE',prepared?.error??'Native prepare rejected');
        this.mapper=geometry;this.stream={...result,streamId:nextId,revision:String(generation)};this.input=new InputState();this.ingress=new InputState();this.state='active';
        entry.result=structuredClone(this.stream);this.notify();return structuredClone(this.stream);
      }catch(error){
        if(this.owner===owner&&this.state==='opening')await this.fault(error).catch(()=>{});
        if(this.owner===owner&&['closing','cleanup_blocked'].includes(this.state))throw new InputError('UNAVAILABLE','cleanupPending',{cleanupPending:true,diagnosticReason:String(error.message??error)});
        throw error;
      }finally{entry.pending=null;if(!entry.result)this.commands.delete(key);}
    };
    entry.pending=run();this.commands.set(key,entry);
    while(this.commands.size>64)this.commands.delete(this.commands.keys().next().value);
    return entry.pending;
  }
  async acceptFrame(bytes){
    let sample;
    try{sample=decodeInputFrame(bytes,{maxDataBytes:this.stream?.maxDataBytes??4096});}
    catch(error){this.stats.receivedSamples++;if(this.owner)await this.fault(error).catch(()=>{});throw error;}
    return this.accept(sample);
  }
  accept(sample){
    this.stats.receivedSamples++;
    if(this.state!=='active'||sample.streamId!==this.stream?.streamId){this.stats.discardedSamples++;return Promise.resolve({status:'discarded'});}
    let candidate;
    try{candidate=this.ingress.candidate(sample,this.stream);this.stats.validatedSamples++;}
    catch(error){this.stats.failedSamples++;return this.fault(error).catch(()=>{}).then(()=>{throw error;});}
    const records=sample.inputType==='touch'?sample.records.length:1;
    const tail=this.queue.at(-1),sameGeneration=tail?.generation===this.generation;
    const wheel=sameGeneration?accumulateWheel(tail.sample,sample,this.mapper.descriptor.region):null;
    const replace=sameGeneration&&(Boolean(wheel)||supersedesMotion(tail.sample,sample));
    const queuedRecords=this.queue.reduce((sum,item)=>sum+item.records,0)-(replace?tail.records:0),queuedBytes=this.queue.reduce((sum,item)=>sum+item.sample.dataBytes,0)-(replace?tail.sample.dataBytes:0);
    if(this.queue.length-(replace?1:0)>=this.maxQueuedSamples||queuedRecords+records>this.maxQueuedRecords||queuedBytes+sample.dataBytes>this.maxQueuedBytes){
      const error=new InputError('RESOURCE_EXHAUSTED','Input queue budget');return this.fault(error).catch(()=>{}).then(()=>{throw error;});
    }
    this.ingress=candidate;this.touchFeedback('received',sample);
    return new Promise((resolve,reject)=>{
      if(replace){this.queue.pop();tail.resolve({status:'coalesced'});this.stats.coalescedSamples++;}
      // Wheel deltas are additive: retain their first arrival time so merging
      // cannot hide stale input. Position snapshots only retain the latest time.
      this.queue.push({sample:structuredClone(wheel??sample),candidate,records,generation:this.generation,queuedAt:wheel?tail.queuedAt:this.now(),resolve,reject});
      this.stats.queuePeak=Math.max(this.stats.queuePeak,this.queue.length);this.pump();
    });
  }
  async pump(){
    if(this.pumping)return;this.pumping=true;
    try{while(this.queue.length){
      const item=this.queue.shift(),owner=this.owner;
      if(item.generation!==this.generation||this.state!=='active'){item.resolve({status:'stale'});continue;}
      try{
        this.stats.lastQueueWaitMs=this.now()-item.queuedAt;this.stats.queueWaitPeakMs=Math.max(this.stats.queueWaitPeakMs,this.stats.lastQueueWaitMs);
        requireInput(this.stats.lastQueueWaitMs<=this.maxQueueAgeMs,'TIMEOUT','Input queue age');
        const action=this.mapper.map(item.sample),started=this.now();
        const result=await timeout(this.enqueueNative(()=>this.provider.apply(action,owner)),this.operationTimeoutMs);
        this.stats.lastNativeMs=this.now()-started;
        this.stats.lastNativeExecutionMs=result?.nativeDurationMs??0;
        if(item.generation!==this.generation||this.owner!==owner){item.resolve({status:'stale'});continue;}
        requireInput(result?.status==='submitted','UNAVAILABLE',result?.error??'Native submission unconfirmed');
        this.touchFeedback('submitted',item.sample);this.input=item.candidate;this.stats.submittedSamples++;this.stats.submittedRecords+=item.records;item.resolve({status:'submitted'});this.notify();
      }catch(error){this.stats.failedSamples++;await this.fault(error).catch(()=>{});item.reject(error);}
    }}finally{this.pumping=false;}
  }
  async fault(error){this.lastError={code:error.code??'INVALID_ARGUMENT',message:String(error.message??error)};return this.close('fault');}
  async close(reason='requested'){
    if(!this.owner){this.touchFeedback('clear');return{streamId:this.lastClosedId??0,closed:true,alreadyClosed:true,revision:String(this.generation)};}
    if(!['closing','cleanup_blocked'].includes(this.state)){
      this.touchFeedback('clear');this.generation++;this.state='closing';for(const item of this.queue.splice(0))item.resolve({status:'stale'});this.notify();
    }
    const owner=this.owner,started=this.now();
    if(!this.cleanupActual){
      this.state='closing';
      const actual=this.enqueueNative(()=>this.provider.releaseOwned(owner,reason));this.cleanupActual=actual;
      actual.then(result=>{
        if(this.owner!==owner)return;
        this.stats.cleanupMs=this.now()-started;
        if(result?.status==='released'){
          this.lastClosedId=owner.streamId;this.closedIds.set(`${owner.sessionId}:${owner.streamId}`,owner.binding);
          while(this.closedIds.size>4096)this.closedIds.delete(this.closedIds.keys().next().value);
          this.owner=null;this.stream=null;this.input=new InputState();this.ingress=new InputState();this.state='closed';
        }else{this.state='cleanup_blocked';this.lastError={code:'UNAVAILABLE',message:result?.error??'Native cleanup unconfirmed'};}
        this.notify();
      },error=>{if(this.owner===owner){this.state='cleanup_blocked';this.lastError={code:'UNAVAILABLE',message:String(error.message??error)};this.notify();}}).finally(()=>{if(this.cleanupActual===actual)this.cleanupActual=null;});
    }
    try{
      const result=await timeout(this.cleanupActual,this.cleanupTimeoutMs,'UNAVAILABLE');
      requireInput(result?.status==='released','UNAVAILABLE','cleanupPending');
      return{streamId:owner.streamId,closed:true,alreadyClosed:false,revision:String(this.generation)};
    }catch(error){if(this.owner===owner){this.state='cleanup_blocked';this.notify();}throw new InputError('UNAVAILABLE','cleanupPending',{cleanupPending:true,diagnosticReason:String(error.message??error)});}
  }
  async closeStream(params,{sessionId}={}){
    const key=`${sessionId}:${params.streamId}`;
    const expected=this.owner?.sessionId===sessionId&&this.owner.streamId===params.streamId?this.owner.binding:this.closedIds.get(key);
    requireInput(expected,'NOT_FOUND','Unknown input stream');this.identity(params,sessionId,expected);
    requireInput(params.controlVersion===1&&params.streamKind==='touchback'&&text(params.commandId),'INVALID_ARGUMENT','Close request');
    if(this.closedIds.has(key))return{streamId:params.streamId,closed:true,alreadyClosed:true,revision:String(this.generation)};
    return this.close(params.reason??'requested');
  }
  streamState(streamId,sessionId){
    if(streamId===undefined)return{state:'aggregate'};
    requireInput(integer(streamId,1,0xffffffff),'INVALID_ARGUMENT','Stream ID');
    if(this.owner?.sessionId===sessionId&&this.owner.streamId===streamId){
      const state=this.state==='active'?'streaming':this.state==='opening'?'opening':'closing';
      return{streamId,state,lastSeqId:this.input.seqId,...(this.input.cursor<=BigInt(Number.MAX_SAFE_INTEGER)?{lastCursor:Number(this.input.cursor)}:{}),reason:'unknown'};
    }
    requireInput(this.closedIds.has(`${sessionId}:${streamId}`),'STREAM_NOT_FOUND','Unknown stream');
    return{streamId,state:'closed',reason:'unknown'};
  }
}
