import {readFileSync} from 'node:fs';
import {WebCastTouchbackSender} from '../../src/webcast/touchback-sender.mjs';
import {rpcPayload} from '../../src/touchback/axtp-session.mjs';
import {encodeStandardFrame,decodeStandardFrame} from '../../src/touchback/frame-codec.mjs';
export const product=JSON.parse(readFileSync(new URL('../fixtures/typed-input-webcast.json',import.meta.url),'utf8'));
export const turn=()=>new Promise(resolve=>setImmediate(resolve));
export const geometry={revision:'geometry-1',displays:[{nativeId:'primary',primary:true,rotation:0,units:'physical-pixels',region:{x:0,y:0,width:1920,height:1080},captureWidth:1920,captureHeight:1080}]};
export const openRequest=sourceBindingId=>({controlVersion:1,runtimeInstanceId:product.targetMessage.data.runtimeInstanceId,target:product.targetMessage.data.target,sourceBindingId,streamKind:'touchback',format:'input-sample-v1',inputTypes:['touch'],maxDataBytes:4096,touch:{maxContacts:10},commandId:'open-1'});
export async function peer(options={}){
  const actions=[],sent=[];
  const provider={probe:async()=>({inputTypes:['touch'],maxDataBytes:4096,touch:{maxContacts:10},geometry,nativeReady:true}),prepare:async()=>({status:'ready'}),apply:async(action)=>{actions.push(action);return{status:'submitted'};},releaseOwned:async()=>({status:'released'}),...options.provider};
  const sender=new WebCastTouchbackSender({provider,engineOptions:options.engineOptions});
  const channel={readyState:'open',ordered:true,send:value=>sent.push(value),close(){this.readyState='closed';void sender.fence('channel closed');}};
  const mediaIdentity={roomId:'room-1',userId:'sender-1',hostUserId:'receiver-1'};
  await sender.attachControlChannel(channel,{authorized:true,mediaIdentity});
  const track={readyState:'live',getSettings:()=>({displaySurface:'monitor',width:1920,height:1080})};
  const rpc=(op,d,sid=sender.server.sessionId??'')=>sender.handleControlMessage({data:encodeStandardFrame(rpcPayload({sid,op,d}),{payloadType:2})});
  const handshake=async()=>{await sender.handleControlMessage({data:Buffer.from('4158010100160000000100010100010000040210000701070801010a0203e80b010034f2','hex')});rpc(2,{randomSeed:123,eventMasks:'050101'});await sender.refreshSource();};
  const bind=()=>sender.handleControlMessage({data:JSON.stringify(product.targetMessage)});
  const source=()=>sent.filter(value=>typeof value==='string').map(JSON.parse).at(-1);
  const messages=()=>sent.filter(value=>typeof value!=='string').map(decodeStandardFrame).filter(frame=>frame.payloadType===2).map(frame=>JSON.parse(new TextDecoder().decode(frame.payload.subarray(1))));
  return{sender,channel,provider,actions,sent,track,rpc,handshake,bind,source,messages};
}
