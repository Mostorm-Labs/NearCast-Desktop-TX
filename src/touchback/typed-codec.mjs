import {INPUT_WIRE as wire} from './axtp-input-contract.mjs';
import {PayloadType,asBytes,check,integer,encodeStandardFrame,decodeStandardFrame,FrameReassembler} from './frame-codec.mjs';
export {INPUT_CONTRACT,INPUT_WIRE} from './axtp-input-contract.mjs';
function readFields(bytes,fields){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),value={};
  for(const field of fields)value[field.name]=view[`get${field.type.startsWith('int')?'Int':'Uint'}${field.bytes*8}`](field.offset,false);
  return value;
}
function writeFields(value,fields,size){
  const bytes=new Uint8Array(size),view=new DataView(bytes.buffer);
  for(const field of fields){
    const signed=field.type.startsWith('int'),bits=field.bytes*8;
    check(integer(value[field.name],signed?-(2**(bits-1)):0,2**(bits-(signed?1:0))-1),`Input field range: ${field.name}`);
    view[`set${signed?'Int':'Uint'}${bits}`](field.offset,value[field.name],false);
  }
  return bytes;
}
export function decodeInputData(input,{maxDataBytes=wire.maxDataBytes,maxContacts=wire.touch.maxContacts}={}){
  const data=asBytes(input);
  check(data.length>1&&data.length<=Math.min(maxDataBytes,wire.maxDataBytes),'Input data length/budget');
  if(data[0]===wire.inputTypes.touch){
    check((data.length-1)%wire.touch.recordBytes===0,'Touch length');
    const count=(data.length-1)/wire.touch.recordBytes;
    check(count>=1&&count<=Math.min(maxContacts,wire.touch.maxContacts),'Touch contact count limit');
    const records=Array.from({length:count},(_,i)=>readFields(data.subarray(1+i*7),wire.touch.fields));
    check(records.every(record=>Object.values(wire.touch.phases).includes(record.phase)),'Touch phase');
    return{inputType:'touch',records};
  }
  check(data[0]===wire.inputTypes.mouse,'Unknown input type');
  const shape=wire.mouse.records.find(record=>record.kind===data[1]);
  check(shape,'Mouse event kind');check(data.length===1+shape.bytes,'Mouse exact length');
  const value=readFields(data.subarray(1),shape.fields);
  if(value.buttons!==undefined)check((value.buttons&~31)===0,'Mouse button bits');
  if(value.modifiers!==undefined)check((value.modifiers&~15)===0,'Mouse modifier bits');
  if(value.eventKind===2)check(Object.values(wire.mouse.wheelUnits).includes(value.wheelUnit)&&Object.values(wire.mouse.wheelPhases).includes(value.wheelPhase),'Mouse wheel unit/phase');
  return{inputType:'mouse',...value};
}
export function encodeInputData(value,limits){
  let data;
  if(value.inputType==='touch'){
    check(Array.isArray(value.records)&&value.records.length>=1&&value.records.length<=wire.touch.maxContacts,'Touch contact count limit');
    data=new Uint8Array(1+value.records.length*7);data[0]=wire.inputTypes.touch;
    value.records.forEach((record,index)=>data.set(writeFields(record,wire.touch.fields,7),1+index*7));
  }else{
    check(value.inputType==='mouse','Unknown input type');const shape=wire.mouse.records.find(record=>record.kind===value.eventKind);check(shape,'Mouse event kind');
    data=new Uint8Array(1+shape.bytes);data[0]=wire.inputTypes.mouse;data.set(writeFields(value,shape.fields,shape.bytes),1);
  }
  decodeInputData(data,limits);return data;
}
export function decodeInputPayload(input,{frameBytes,...limits}={}){
  const payload=asBytes(input);
  check(payload.length>=18&&payload.length<=16+Math.min(limits.maxDataBytes??wire.maxDataBytes,wire.maxDataBytes),'Input payload length/budget');
  const view=new DataView(payload.buffer,payload.byteOffset,payload.byteLength);
  const streamId=view.getUint32(0),seqId=view.getUint32(4),cursor=view.getBigUint64(8);check(streamId>0&&seqId>0,'Stream identity/sequence zero');
  return{streamId,seqId,cursor:cursor<=BigInt(Number.MAX_SAFE_INTEGER)?Number(cursor):cursor.toString(),dataBytes:payload.length-16,...(frameBytes===undefined?{}:{frameBytes}),...decodeInputData(payload.subarray(16),limits)};
}
export function decodeInputFrame(input,limits={}){
  const frame=decodeStandardFrame(input,limits);check(frame.payloadType===PayloadType.STREAM,'Input requires STREAM payload');check(frame.count===1&&frame.index===0,'Frame fragment reassembly required');
  return decodeInputPayload(frame.payload,{...limits,frameBytes:frame.frameBytes});
}
export function decodeInputFrames(frames,limits={}){
  check(Array.isArray(frames)&&frames.length>=1&&frames.length<=255,'Frame fragment count');
  const assembler=new FrameReassembler({maxPayloadBytes:16+(limits.maxDataBytes??wire.maxDataBytes)});let result=null;
  for(const frame of frames){check(!result,'Multiple input messages in fragment group');result=assembler.accept(frame);}
  check(result&&assembler.pending.size===0,'Frame fragment incomplete');check(result.payloadType===PayloadType.STREAM,'Input requires STREAM payload');
  return decodeInputPayload(result.payload,{...limits,frameBytes:result.frameBytes});
}
export function encodeInputFrames(value,{maxFrameBytes=65549,...frameOptions}={}){
  check(integer(value.streamId,1,0xffffffff)&&integer(value.seqId,1,0xffffffff),'Stream identity/sequence range');
  const cursor=BigInt(value.cursor);check(cursor>=0n&&cursor<=0xffffffffffffffffn,'Stream cursor range');
  const data=encodeInputData(value),payload=new Uint8Array(16+data.length),view=new DataView(payload.buffer);
  view.setUint32(0,value.streamId);view.setUint32(4,value.seqId);view.setBigUint64(8,cursor);payload.set(data,16);
  check(integer(maxFrameBytes,15,65549),'Frame budget');const budget=maxFrameBytes-14,count=Math.ceil(payload.length/budget);check(count<=255,'Frame fragment count limit');
  return Array.from({length:count},(_,index)=>encodeStandardFrame(payload.subarray(index*budget,(index+1)*budget),{messageId:value.seqId&65535,...frameOptions,payloadType:PayloadType.STREAM,index,count}));
}
export function encodeInputFrame(value,options={}){
  const frames=encodeInputFrames(value,options);check(frames.length===1,'Frame fragmentation required');return frames[0];
}
