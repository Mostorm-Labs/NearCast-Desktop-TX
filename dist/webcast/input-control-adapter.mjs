import {AxtpServer} from '../touchback/axtp-session.mjs';
import {InputEngine,InputError} from '../touchback/input-engine.mjs';
import {decodeInputPayload} from '../touchback/typed-codec.mjs';
import {INPUT_CONTRACT,INPUT_WIRE} from '../touchback/axtp-input-contract.mjs';
import {SESSION_CONTRACT} from '../touchback/axtp-session-contract.mjs';
import {proveCaptureGeometry} from '../touchback/capture-geometry.mjs';
const text=value=>typeof value==='string'&&value.length>0&&value.length<=128;
const targetFields=['sessionId','sessionGeneration','slotId','bindingGeneration','lifecycleGeneration'];
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);

// Product/media association belongs here. Standard framing/session and native
// execution remain separate owners; no transport callback injects OS input.
export class WebCastTouchbackSender{
  constructor({provider,nativeBridge,onStatus=()=>{},engineOptions={}}={}){
    this.provider=provider??nativeBridge;this.onStatus=onStatus;this.engineOptions=engineOptions;
    this.engine=null;this.server=null;this.channel=null;this.generation=0;this.refreshVersion=0;
    this.enabled=false;this.track=null;this.target=null;this.identity=null;this.source=null;this.sourceKey=null;
    this.retiring=new Set();this.lastProbe=null;this.reason='LOCAL_INPUT_DISABLED';this.detail=null;this.wireStateKey=null;
    this.stats={textReceived:0,binaryReceived:0,recentControl:[],lastOpenRequest:null,receivedTouchSamples:0,receivedMouseSamples:0,lastReceivedInput:null};
  }
  status(){const snapshot=this.diagnostics();this.onStatus(this.engine?.state==='active'?'accepted':this.server?.ready?'session_ready':'waiting',{...snapshot,nativeOwnerId:this.engine?.owner?.ownerId??null});}
  capability(){
    const caps=this.lastProbe??{inputTypes:[],maxDataBytes:4096};
    const result={capability:'input.stream',direction:'receiver_to_source',reliability:'ordered_reliable',profiles:['AXTP-TYPED-INPUT-V1'],formats:['input-sample-v1'],inputTypes:[...(caps.inputTypes??[])],maxDataBytes:Math.min(caps.maxDataBytes??4096,4096)};
    if(result.inputTypes.includes('touch'))result.touch={...caps.touch};if(result.inputTypes.includes('mouse'))result.mouse=structuredClone(caps.mouse);
    return result;
  }
  record(method,status){this.stats.recentControl.push({method,status});if(this.stats.recentControl.length>32)this.stats.recentControl.shift();}
  sendSource(){
    if(this.channel?.readyState!=='open'||!this.identity)return;
    const source=this.source;
    this.channel.send(JSON.stringify({action:'nearcast-input-source',data:{version:1,contractFingerprint:INPUT_CONTRACT.fingerprint,
      sourceBindingId:source?.sourceBindingId??null,roomId:this.identity.roomId,senderUserId:this.identity.userId,receiverUserId:this.identity.hostUserId,
      geometryRevision:source?.geometry.revision??null,available:Boolean(source),disabledReason:source?null:this.reason,inputCapability:this.capability()}}));
  }
  makeEngine(generation){
    const engine=new InputEngine({...this.engineOptions,provider:this.provider,onState:snapshot=>{
      const retired=this.retiring.has(engine);if(snapshot.state==='closed')this.retiring.delete(engine);
      if(this.engine!==engine||generation!==this.generation){if(retired&&snapshot.state==='closed')void this.refreshSource();return;}
      const key=[snapshot.state,snapshot.streamId,snapshot.cleanupPending].join(':');
      // Statistics updates are not application ACKs: only lifecycle transitions
      // emit stream.stateChanged, never one event per ordinary input sample.
      if(key!==this.wireStateKey&&snapshot.streamId&&this.server?.ready){
        this.wireStateKey=key;
        try{const state=engine.streamState(snapshot.streamId,this.server.sessionId);this.server.notifyStreamState({streamId:snapshot.streamId,state});}catch{/* No published stream context yet. */}
      }
      this.status();
    }});
    return engine;
  }
  retire(engine,reason){
    if(!engine)return Promise.resolve(true);
    if(engine.state!=='closed')this.retiring.add(engine);
    return engine.close(reason).then(()=>{this.retiring.delete(engine);return true;},failure=>{this.detail=String(failure.message??failure);return false;});
  }
  async attachControlChannel(channel,{authorized=false,protocol='webcast',mediaIdentity}={}){
    this.fence('channel replaced');
    if(!authorized||protocol!=='webcast'||channel?.readyState!=='open'||channel.ordered===false||channel.maxRetransmits!=null||channel.maxPacketLifeTime!=null)return false;
    if(!mediaIdentity||![mediaIdentity.roomId,mediaIdentity.userId,mediaIdentity.hostUserId].every(text))return false;
    this.identity={roomId:mediaIdentity.roomId,userId:mediaIdentity.userId,hostUserId:mediaIdentity.hostUserId};
    this.channel=channel;const generation=this.generation;
    this.engine=this.makeEngine(generation);
    const server=new AxtpServer({send:frame=>{if(this.server===server&&this.channel===channel&&channel.readyState==='open')channel.send(frame);},
      onReady:()=>{if(this.server===server)void this.refreshSource();},
      onFault:failure=>{if(this.server!==server)return;this.detail=String(failure.message??failure);this.reason='INPUT_SESSION_FAULT';this.source=null;this.sendSource();void this.retire(this.engine,'protocol fault');channel.close?.();this.status();},
      onRequest:(method,params,context)=>this.requestFromReceiver(method,params,context),
      onStream:frame=>{
        if(!this.source||!this.enabled||this.track?.readyState!=='live'||this.track.muted){this.invalidateSource('CAPTURE_UNAVAILABLE');return;}
        proveCaptureGeometry(this.track.getSettings(),this.lastProbe?.geometry);
        const sample=decodeInputPayload(frame.payload,{frameBytes:frame.frameBytes,maxDataBytes:this.engine.stream?.maxDataBytes??4096});
        this.stats[sample.inputType==='touch'?'receivedTouchSamples':'receivedMouseSamples']++;
        this.stats.lastReceivedInput={streamId:sample.streamId,seqId:sample.seqId,cursor:sample.cursor,inputType:sample.inputType,typeByte:INPUT_WIRE.inputTypes[sample.inputType],
          ...(sample.inputType==='touch'?{recordCount:sample.records.length,records:sample.records.slice(0,10).map(record=>({...record}))}:{eventKind:sample.eventKind})};
        return this.engine.accept(sample);
      },
    });
    this.server=server;this.tickTimer=setInterval(()=>{if(this.server===server)server.tick();},250);this.tickTimer.unref?.();
    this.probeTimer=setInterval(()=>void this.refreshSource(),1000);this.probeTimer.unref?.();
    await this.refreshSource();return generation===this.generation;
  }
  requestFromReceiver(method,params,context){
    this.record(method,'received');
    if(method==='input.openStream'){
      this.stats.lastOpenRequest={format:params.format===INPUT_WIRE.format?params.format:null,inputTypes:Array.isArray(params.inputTypes)?params.inputTypes.filter(type=>['touch','mouse'].includes(type)).slice(0,2):[]};
      if(!this.enabled||!this.source)throw new InputError('PERMISSION_DENIED','Local input source unavailable');
      return this.engine.open(params,context);
    }
    if(method==='input.closeStream')return this.engine.closeStream(params,context);
    if(method==='stream.getState')return this.engine.streamState(params.streamId,context.sessionId);
    throw new InputError(SESSION_CONTRACT.registeredMethods.includes(method)?'NOT_SUPPORTED':'RPC_METHOD_NOT_FOUND',method);
  }
  handleControlMessage(event){
    if(!this.server||this.channel?.readyState!=='open')return{status:'stale'};
    if(typeof event?.data!=='string'){this.stats.binaryReceived++;return this.server.accept(event.data);}
    this.stats.textReceived++;
    let message;try{message=JSON.parse(event.data);}catch{return{status:'ignored_text'};}
    if(message.action!=='nearcast-input-target')return{status:'ignored_text'};
    const data=message.data,target=data?.target;
    const valid=data?.version===1&&data.contractFingerprint===INPUT_CONTRACT.fingerprint&&text(data.runtimeInstanceId)&&target&&
      targetFields.every(field=>text(target[field]))&&Object.keys(target).every(field=>targetFields.includes(field))&&
      ['sessionGeneration','bindingGeneration','lifecycleGeneration'].every(field=>/^[1-9]\d*$/.test(target[field])&&BigInt(target[field])<=0xffffffffffffffffn);
    if(!valid){this.target=null;this.invalidateSource('TARGET_CONTRACT_MISMATCH');return{status:'invalid_target'};}
    const value={runtimeInstanceId:data.runtimeInstanceId,target:structuredClone(target)};
    if(canonical(this.target)!==canonical(value)){this.target=value;this.invalidateSource('TARGET_CHANGED');}
    return this.refreshSource().then(()=>({status:'target_bound'}));
  }
  invalidateSource(reason){
    this.refreshVersion++;this.source=null;this.sourceKey=null;this.reason=reason;this.sendSource();
    const cleanup=this.engine?this.engine.bindSource(null).catch(failure=>{if(failure.code!=='CANCELED'){this.detail=String(failure.message??failure);this.status();}}):Promise.resolve();
    this.status();return cleanup;
  }
  async captureGeometryChanged(){await this.invalidateSource('CAPTURE_GEOMETRY_CHANGED');await this.refreshSource();}
  async refreshSource(){
    if(!this.server||!this.identity)return;
    const version=++this.refreshVersion,generation=this.generation,engine=this.engine;
    try{
      const probe=await this.provider.probe();if(version!==this.refreshVersion||generation!==this.generation)return;
      this.lastProbe=probe;
      let reason=!this.enabled?'LOCAL_INPUT_DISABLED':!this.server?.ready?'APP_NOT_READY':!this.target?'TARGET_UNBOUND':
        !this.track||this.track.readyState!=='live'?'CAPTURE_UNAVAILABLE':this.track.muted?'CAPTURE_MUTED':
        this.retiring.size>0||probe.cleanupBlocked?'NATIVE_CLEANUP_PENDING':probe.nativeReady===false?'NATIVE_PERMISSION_UNAVAILABLE':null;
      if(!reason&&probe.ownerBusy&&!this.provider.owns?.(engine.owner?.ownerId)&&engine.state!=='opening')reason='NATIVE_DOMAIN_BUSY';
      let geometry;
      if(!reason){try{geometry=proveCaptureGeometry(this.track.getSettings(),probe.geometry);}catch(failure){reason='NATIVE_GEOMETRY_UNAVAILABLE';this.detail=String(failure.message??failure);}}
      if(reason){
        if(this.source||engine.binding)this.invalidateSource(reason);else this.reason=reason;
        this.sendSource();this.status();return;
      }
      const key=canonical({track:this.captureGeneration,geometry,target:this.target,sessionId:this.server.sessionId});
      if(this.source&&this.sourceKey===key){this.sendSource();this.status();return;}
      const sourceBindingId=crypto.randomUUID();
      await engine.bindSource({sessionId:this.server.sessionId,...this.target,sourceBindingId,authorized:true,geometry});
      if(version!==this.refreshVersion||generation!==this.generation||engine!==this.engine)return;
      this.source={sourceBindingId,geometry};this.sourceKey=key;this.reason=null;this.detail=null;this.sendSource();this.status();
    }catch(failure){if(generation===this.generation&&version===this.refreshVersion){this.detail=String(failure.message??failure);this.invalidateSource('NATIVE_PROBE_FAILED');}}
  }
  async setEnabled(value){this.enabled=value===true;this.invalidateSource(this.enabled?'SOURCE_PREPARING':'LOCAL_INPUT_DISABLED');await this.refreshSource();}
  async setCaptureTrack(track){
    if(this.track===track)return;
    if(this.track){
      this.track.removeEventListener?.('ended',this.trackChanged);
      this.track.removeEventListener?.('mute',this.trackAvailability);
      this.track.removeEventListener?.('unmute',this.trackAvailability);
    }
    this.track=track??null;this.captureGeneration=(this.captureGeneration??0)+1;
    this.trackChanged=()=>{if(this.track===track){this.captureGeneration++;this.invalidateSource('CAPTURE_UNAVAILABLE');void this.setCaptureTrack(null);}};
    this.trackAvailability=()=>{if(this.track===track){this.invalidateSource(track.muted?'CAPTURE_MUTED':'CAPTURE_CHANGED');void this.refreshSource();}};
    track?.addEventListener?.('ended',this.trackChanged,{once:true});
    track?.addEventListener?.('mute',this.trackAvailability);
    track?.addEventListener?.('unmute',this.trackAvailability);
    this.invalidateSource('CAPTURE_CHANGED');await this.refreshSource();
  }
  async retryCleanup(){
    const engines=new Set([...this.retiring,...(this.engine&&['closing','cleanup_blocked'].includes(this.engine.state)?[this.engine]:[])]);
    const results=await Promise.all([...engines].map(engine=>this.retire(engine,'explicit cleanup retry')));
    await this.refreshSource();return results.every(Boolean);
  }
  fence(reason='session ended'){
    this.generation++;this.refreshVersion++;clearInterval(this.tickTimer);clearInterval(this.probeTimer);
    this.server?.dispose();this.server=null;this.channel=null;this.identity=null;this.target=null;this.source=null;this.sourceKey=null;this.wireStateKey=null;
    const closing=this.retire(this.engine,reason);this.status();return closing.finally(()=>this.status());
  }
  diagnostics(){
    const state=this.engine?.snapshot()??{};
    return{controlChannelReady:this.channel?.readyState==='open',appReady:this.server?.ready===true,nativeReady:this.lastProbe?.nativeReady===true,
      sourceReady:Boolean(this.source),localEnabled:this.enabled,receiverEnabled:null,nativeInputTypes:[...(this.lastProbe?.inputTypes??[])],
      disabledReason:this.source?null:this.reason,detail:this.detail,...state,cleanupPending:Boolean(state.cleanupPending||this.retiring.size),injectionCount:state.submittedRecords??0,nativeInput:this.provider.snapshot?.()??null};
  }
  controlDiagnostics(){return structuredClone({...this.stats,...this.diagnostics()});}
  snapshot(){return this.diagnostics();}
}
