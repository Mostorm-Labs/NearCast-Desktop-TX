export const PayloadType=Object.freeze({CONTROL:1,RPC:2,STREAM:3});
export const check=(condition,reason)=>{if(!condition)throw new RangeError(reason);};
export const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
export function asBytes(input){
  if(input instanceof Uint8Array)return input;
  if(input instanceof ArrayBuffer)return new Uint8Array(input);
  if(ArrayBuffer.isView(input))return new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
  throw new TypeError('Binary Frame required');
}
export function crc16(input){
  let value=0xffff;
  for(const byte of input){value^=byte<<8;for(let bit=0;bit<8;bit++)value=((value&0x8000)?(value<<1)^0x1021:value<<1)&0xffff;}
  return value;
}
export function encodeStandardFrame(input,{payloadType=3,sourceId=0,destinationId=0,messageId=0,index=0,count=1}={}){
  const payload=asBytes(input);
  check(payload.length<=65535&&[1,2,3].includes(payloadType),'Frame payload type/length');
  check(integer(sourceId,0,255)&&integer(destinationId,0,255)&&integer(messageId,0,65535)&&integer(count,1,255)&&integer(index,0,count-1),'Frame fields');
  const bytes=new Uint8Array(14+payload.length),view=new DataView(bytes.buffer);
  bytes.set([65,88,1,payloadType]);view.setUint16(4,payload.length);bytes[6]=sourceId;bytes[7]=destinationId;
  view.setUint16(8,messageId);bytes[10]=index;bytes[11]=count;bytes.set(payload,12);
  view.setUint16(bytes.length-2,crc16(bytes.subarray(0,-2)));return bytes;
}
export function decodeStandardFrame(input,{maxFrameBytes=65549}={}){
  const bytes=asBytes(input);
  check(bytes.length>=14&&bytes.length<=maxFrameBytes,'Frame length/budget');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  check(bytes[0]===65&&bytes[1]===88&&bytes[2]===1&&[1,2,3].includes(bytes[3]),'Frame header');
  check(bytes.length===view.getUint16(4)+14,'Frame length');
  check(crc16(bytes.subarray(0,-2))===view.getUint16(bytes.length-2),'Frame CRC');
  check(bytes[11]>=1&&bytes[10]<bytes[11],'Frame fragment header');
  return{payloadType:bytes[3],sourceId:bytes[6],destinationId:bytes[7],messageId:view.getUint16(8),index:bytes[10],count:bytes[11],payload:bytes.slice(12,-2),frameBytes:bytes.length};
}
export class FrameReassembler{
  constructor({maxFrameBytes=65549,maxPayloadBytes=65536,maxPending=8,maxPendingBytes=131072,timeoutMs=2000,now=()=>performance.now()}={}){
    Object.assign(this,{maxFrameBytes,maxPayloadBytes,maxPending,maxPendingBytes,timeoutMs,now});this.pending=new Map();this.pendingBytes=0;
  }
  clear(){this.pending.clear();this.pendingBytes=0;}
  accept(input){
    for(const item of this.pending.values())check(this.now()-item.started<=this.timeoutMs,'Frame fragment timeout');
    const frame=decodeStandardFrame(input,{maxFrameBytes:this.maxFrameBytes});
    check(frame.payload.length<=this.maxPayloadBytes,'Frame reassembly budget');
    const key=[frame.payloadType,frame.sourceId,frame.destinationId,frame.messageId].join(':');
    if(frame.count===1){check(!this.pending.has(key),'Frame fragment identity conflict');return frame;}
    let item=this.pending.get(key);
    if(!item){check(this.pending.size<this.maxPending,'Frame fragment queue limit');item={...frame,parts:new Map(),bytes:0,frameBytes:0,started:this.now()};this.pending.set(key,item);}
    check(item.count===frame.count&&!item.parts.has(frame.index),'Frame fragment identity/duplicate');
    check(item.bytes+frame.payload.length<=this.maxPayloadBytes&&this.pendingBytes+frame.payload.length<=this.maxPendingBytes,'Frame reassembly budget');
    item.parts.set(frame.index,frame.payload);item.bytes+=frame.payload.length;item.frameBytes+=frame.frameBytes;this.pendingBytes+=frame.payload.length;
    if(item.parts.size!==item.count)return null;
    const payload=new Uint8Array(item.bytes);let offset=0;
    for(let i=0;i<item.count;i++){const part=item.parts.get(i);payload.set(part,offset);offset+=part.length;}
    this.pending.delete(key);this.pendingBytes-=item.bytes;
    return{...frame,index:0,count:1,payload,frameBytes:item.frameBytes};
  }
}
