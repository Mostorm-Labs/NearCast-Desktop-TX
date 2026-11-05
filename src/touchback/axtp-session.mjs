import {SESSION_CONTRACT as meta} from './axtp-session-contract.mjs';
import {INPUT_CONTRACT} from './axtp-input-contract.mjs';
import {FrameReassembler,asBytes,check,integer,encodeStandardFrame} from './frame-codec.mjs';
const C=meta.control,R=meta.rpc,T=meta.tlv;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.length>0&&value.length<=128;
const error=(code,message=code)=>Object.assign(new Error(message),{code});
export function controlPayload(opcode,id,status=0,body=new Uint8Array()){
  const bytes=new Uint8Array(5+body.length),view=new DataView(bytes.buffer);
  bytes[0]=opcode;view.setUint16(1,id);view.setUint16(3,status);bytes.set(body,5);return bytes;
}
export function rpcPayload(value){const json=new TextEncoder().encode(JSON.stringify(value)),bytes=new Uint8Array(1+json.length);bytes[0]=meta.rpcEncodings.Json;bytes.set(json,1);return bytes;}
function parseTlvs(bytes){
  const fields=new Map();let at=0;
  while(at<bytes.length){check(at+2<=bytes.length,'CONTROL TLV header');const tag=bytes[at++],length=bytes[at++];check(at+length<=bytes.length&&!fields.has(tag),'CONTROL TLV length/duplicate');fields.set(tag,bytes.slice(at,at+length));at+=length;}
  return fields;
}
function number(fields,tag,fallback){
  const bytes=fields.get(tag);if(!bytes)return fallback;
  check([1,2,4].includes(bytes.length),'CONTROL TLV numeric width');
  return bytes.reduce((value,byte)=>value*256+byte,0);
}
function tlvs(fields){
  const bytes=[];
  for(const[tag,value,width= value<=255?1:value<=65535?2:4]of fields){bytes.push(tag,width);for(let shift=width-1;shift>=0;shift--)bytes.push((value/2**(shift*8))&255);}
  return Uint8Array.from(bytes);
}
function stateSubscription(value){
  check(typeof value==='string'&&value.length<=1024&&/^(?:[\da-f]{2})*$/i.test(value),'RPC eventMasks');
  const bytes=Uint8Array.from(value.match(/../g)??[],byte=>parseInt(byte,16));
  const masks=parseTlvs(bytes),event=meta.streamStateEvent,mask=masks.get(event.domainId);
  return Boolean(mask&&mask[Math.floor(event.bitOffset/8)]&(1<<(event.bitOffset%8)));
}

export class AxtpServer{
  constructor({send,onReady=()=>{},onFault=()=>{},onRequest=()=>{throw error('NOT_SUPPORTED');},onEvent=()=>{},onStream=()=>{},
    now=()=>performance.now(),sessionIdFactory=()=>crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8,'0').toUpperCase(),handshakeTimeoutMs=5000,rpcTimeoutMs=5000,maxPendingRpc=32}={}){
    Object.assign(this,{send,onReady,onFault,onRequest,onEvent,onStream,now,sessionIdFactory,handshakeTimeoutMs,rpcTimeoutMs,maxPendingRpc});
    this.assembler=new FrameReassembler({maxFrameBytes:4096,now});this.maxFrameBytes=4096;this.startedAt=now();this.lastReceiveAt=now();
    this.controlOpen=false;this.ready=false;this.failed=false;this.disposed=false;this.sessionId=null;this.generation=0;this.messageId=0;this.requestId=0;
    this.heartbeatMs=1000;this.subscribed=false;this.incoming=new Map();this.outgoing=new Map();
  }
  sendPayload(payloadType,input){
    if(this.disposed)return;
    const bytes=asBytes(input),budget=this.maxFrameBytes-14,count=Math.ceil(bytes.length/budget);
    check(count>=1&&count<=255,'Outgoing Frame fragment budget');const messageId=(++this.messageId)&65535;
    for(let index=0;index<count;index++)this.send(encodeStandardFrame(bytes.subarray(index*budget,(index+1)*budget),{payloadType,messageId,index,count}));
  }
  sendRpc(value){this.sendPayload(meta.payloadTypes.RPC,rpcPayload(value));}
  accept(input){
    if(this.disposed)return false;
    try{
      const frame=this.assembler.accept(input);this.lastReceiveAt=this.now();if(!frame)return true;
      if(frame.payloadType===meta.payloadTypes.CONTROL)return this.control(frame.payload);
      check(this.controlOpen,'CONTROL OPEN required');
      if(frame.payloadType===meta.payloadTypes.RPC)return this.rpc(frame.payload);
      check(this.ready,'STREAM requires APP_READY');
      return Promise.resolve(this.onStream(frame)).catch(failure=>{this.fault(failure);return false;});
    }catch(failure){this.fault(failure);return false;}
  }
  control(input){
    check(input.length>=5,'CONTROL payload truncated');const view=new DataView(input.buffer,input.byteOffset,input.byteLength);
    const opcode=input[0],id=view.getUint16(1),status=view.getUint16(3);check(id>0&&status===0,'CONTROL id/status');
    if(opcode===C.Open){
      check(!this.controlOpen,'Duplicate CONTROL OPEN requires a new input session');
      const fields=parseTlvs(input.subarray(5));
      const frameBytes=number(fields,T.MaxFrameSize,4096),types=number(fields,T.SupportedPayloadTypes,7),encodings=number(fields,T.SupportedRpcEncodings,1),heartbeat=number(fields,T.HeartbeatIntervalMs,1000);
      check(integer(frameBytes,15,65549)&&(types&7)===7&&(encodings&1)!==0&&number(fields,T.AckMode,0)===0,'CONTROL negotiation unsupported');
      check(number(fields,T.ProtocolVersion,1)===1&&integer(heartbeat,500,60000),'CONTROL version/heartbeat');
      this.maxFrameBytes=Math.min(frameBytes,4096);this.assembler.maxFrameBytes=this.maxFrameBytes;this.heartbeatMs=heartbeat;this.controlOpen=true;
      const accepted=[[T.SessionId,number(fields,T.SessionId,0),4],[T.MaxFrameSize,this.maxFrameBytes,2],[T.SupportedPayloadTypes,7,1],[T.SelectedRpcEncoding,meta.rpcEncodings.Json,1],[T.HeartbeatIntervalMs,heartbeat,heartbeat>65535?4:2],[T.AckMode,0,1]];
      if(fields.has(T.ProtocolVersion))accepted.push([T.ProtocolVersion,1,1]);
      if(fields.has(T.Mtu))accepted.push([T.Mtu,Math.min(number(fields,T.Mtu,4096),this.maxFrameBytes),2]);
      this.sendPayload(meta.payloadTypes.CONTROL,controlPayload(C.Accept,id,0,tlvs(accepted)));
      this.sendRpc({sid:'',op:R.Hello,d:{axtpVersion:INPUT_CONTRACT.version}});return true;
    }
    check(this.controlOpen,'CONTROL OPEN required');check(input.length===5,'Unexpected CONTROL body');
    if(opcode===C.Heartbeat||opcode===C.Ping){this.sendPayload(meta.payloadTypes.CONTROL,controlPayload(opcode===C.Heartbeat?C.HeartbeatAck:C.Pong,id));return true;}
    if(opcode===C.Close){this.sendPayload(meta.payloadTypes.CONTROL,controlPayload(C.CloseAck,id));this.fault(error('CANCELED','Peer closed input session'));return true;}
    throw error('NOT_SUPPORTED','Unsupported CONTROL opcode');
  }
  rpc(input){
    check(input.length>=2&&input.length<=65536&&input[0]===meta.rpcEncodings.Json,'RPC requires negotiated JSON encoding');
    const message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input.subarray(1)));
    check(object(message)&&object(message.d)&&integer(message.op,0,255)&&typeof message.sid==='string','RPC envelope');
    if(message.op===R.Identify){
      check(!this.ready&&message.sid===''&&integer(message.d.randomSeed??0,0,0xffffffff),'RPC Identify state');
      this.subscribed=stateSubscription(message.d.eventMasks??'');
      this.sessionId=this.sessionIdFactory();check(text(this.sessionId),'RPC generated sid');this.ready=true;
      this.sendRpc({sid:this.sessionId,op:R.Identified,d:{}});this.onReady({sessionId:this.sessionId});return true;
    }
    check(this.ready&&message.sid===this.sessionId,'RPC sid/APP_READY mismatch');
    const d=message.d;
    if(message.op===R.Subscribe){this.subscribed=stateSubscription(d.eventMasks??'');return true;}
    if(message.op===R.Request){
      check(integer(d.id,1,0xffffffff)&&text(d.method)&&object(d.params??{})&&!Object.hasOwn(d,'result')&&!Object.hasOwn(d,'error'),'RPC request fields');
      if(this.incoming.has(d.id))throw error('RPC_REQUEST_ID_INVALID','Duplicate pending RPC request');
      if(this.incoming.size>=this.maxPendingRpc){this.respond(d.id,null,error('BUSY','RPC queue budget'));return true;}
      const generation=this.generation,sid=this.sessionId,entry={started:this.now()};this.incoming.set(d.id,entry);
      return Promise.resolve().then(()=>this.onRequest(d.method,d.params??{},{sessionId:sid})).then(result=>{
        if(!this.disposed&&generation===this.generation&&sid===this.sessionId)this.respond(d.id,result);
      },failure=>{if(!this.disposed&&generation===this.generation&&sid===this.sessionId)this.respond(d.id,null,failure);}).catch(failure=>this.fault(failure)).finally(()=>{if(this.incoming.get(d.id)===entry)this.incoming.delete(d.id);});
    }
    if(message.op===R.RequestResponse){
      check(integer(d.id,1,0xffffffff)&&object(d.status)&&typeof d.status.ok==='boolean'&&integer(d.status.code,0,65535),'RPC response status');
      const pending=this.outgoing.get(d.id);if(!pending)return true;this.outgoing.delete(d.id);
      if(d.status.ok&&d.status.code===0)pending.resolve(d.result);else pending.reject(error(Object.keys(meta.errorCodes).find(name=>meta.errorCodes[name]===d.status.code)??'UNKNOWN_ERROR',d.status.msg??'Remote request rejected'));return true;
    }
    if(message.op===R.Event){check(text(d.event)&&object(d.data),'RPC event fields');this.onEvent(d.event,d.data);return true;}
    throw error('NOT_SUPPORTED','Unsupported RPC operation');
  }
  respond(id,result,failure){
    let status={ok:true,code:0};
    if(failure){const name=Object.hasOwn(meta.errorCodes,failure.code)?failure.code:'INTERNAL_ERROR';status={ok:false,code:meta.errorCodes[name],msg:name};if(failure.details)status.details=failure.details;}
    const d={id,status};if(!failure&&result!==undefined)d.result=result;
    this.sendRpc({sid:this.sessionId,op:R.RequestResponse,d});
  }
  request(method,params){
    if(!this.ready||this.disposed)return Promise.reject(error('INVALID_STATE','Input session not APP_READY'));
    if(this.outgoing.size>=this.maxPendingRpc)return Promise.reject(error('BUSY','RPC queue budget'));
    const id=++this.requestId;if(id>0xffffffff)return Promise.reject(error('RESOURCE_EXHAUSTED','RPC request ID exhausted'));
    return new Promise((resolve,reject)=>{this.outgoing.set(id,{resolve,reject,started:this.now()});try{this.sendRpc({sid:this.sessionId,op:R.Request,d:{id,method,params}});}catch(failure){this.outgoing.delete(id);reject(failure);}});
  }
  notifyStreamState(data){if(this.ready&&this.subscribed&&!this.disposed)this.sendRpc({sid:this.sessionId,op:R.Event,d:{event:meta.streamStateEvent.name,data}});}
  tick(){
    if(this.disposed)return;
    if(!this.ready&&this.now()-this.startedAt>this.handshakeTimeoutMs)return this.fault(error('TIMEOUT','Input handshake timeout'));
    if(this.controlOpen&&this.now()-this.lastReceiveAt>Math.max(this.heartbeatMs*3,5000))return this.fault(error('TIMEOUT','Input heartbeat timeout'));
    for(const entry of [...this.incoming.values(),...this.outgoing.values()])if(this.now()-entry.started>this.rpcTimeoutMs)return this.fault(error('TIMEOUT','Input RPC timeout'));
    for(const item of this.assembler.pending.values())if(this.now()-item.started>this.assembler.timeoutMs)return this.fault(error('TIMEOUT','Input fragment timeout'));
  }
  fault(failure){if(this.disposed)return;this.failed=true;this.dispose(failure);try{this.onFault(failure);}catch{/* Cleanup owner remains responsible. */}}
  dispose(reason=error('CANCELED','Input session ended')){
    if(this.disposed)return;this.disposed=true;this.ready=false;this.generation++;this.assembler.clear();
    for(const pending of this.outgoing.values())pending.reject(reason);this.outgoing.clear();this.incoming.clear();
  }
}
