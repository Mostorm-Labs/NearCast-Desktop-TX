import {check} from './frame-codec.mjs';
import {TouchMouseGestures,normalizeGestureSettings} from './touch-mouse-gestures.mjs';

export const DEFAULT_OUTPUT_POLICY=Object.freeze({touch:'native',mouse:'native'});
export function outputPolicyOptions(native){
  const mouse=native.inputTypes.includes('mouse'),touch=native.inputTypes.includes('touch');
  return {
    touch:[{value:'native',label:'原生 Touch（保持类型）',supported:touch},{value:'mouse-drag',label:'Mouse · 点击与拖拽',supported:mouse&&Boolean(native.mouse?.buttonsMask&1)},
      {value:'mouse-scroll',label:'Mouse · 轻点点击 / 滑动滚动',supported:mouse&&Boolean(native.mouse?.buttonsMask&1)&&native.mouse?.continuousScroll===true&&native.mouse?.wheelUnits.includes('regionQ16_16')},
      {value:'mouse-gestures',label:'Mouse · 组合手势（滚动 / 拖拽 / 右键 / 缩放）',supported:mouse&&(native.mouse?.buttonsMask&3)===3&&native.mouse?.continuousScroll===true&&native.mouse?.wheelUnits.includes('regionQ16_16')},
      {value:'disabled',label:'禁用 Touch 输入',supported:true}],
    mouse:[{value:'native',label:'原生 Mouse（保持类型）',supported:mouse},{value:'touch',label:'Touch · 左键单点触控',supported:touch},
      {value:'disabled',label:'禁用 Mouse 输入',supported:true}],
  };
}
export function normalizeOutputPolicy(value){
  check(value&&Object.keys(value).every(key=>['touch','mouse','gestures'].includes(key)),'Invalid input output policy');
  const policy={...DEFAULT_OUTPUT_POLICY,...value};
  check(['native','mouse-drag','mouse-scroll','mouse-gestures','disabled'].includes(policy.touch)&&['native','touch','disabled'].includes(policy.mouse),'Invalid input output policy');
  if(policy.gestures)policy.gestures=normalizeGestureSettings(policy.gestures);
  return policy;
}
const outputType=(policy,type)=>policy[type]==='disabled'?null:policy[type]==='native'?type:type==='touch'?'mouse':'touch';
export function policyCapabilities(native,policy){
  const result={...structuredClone(native),inputTypes:[],nativeTypes:[...(native.nativeTypes??native.inputTypes)]};
  delete result.touch;delete result.mouse;
  if(policy.touch==='native'&&native.inputTypes.includes('touch')){result.inputTypes.push('touch');result.touch={...native.touch};}
  if(['mouse-drag','mouse-scroll','mouse-gestures'].includes(policy.touch)&&native.inputTypes.includes('mouse')&&(native.mouse.buttonsMask&1)&&
    (policy.touch==='mouse-drag'||native.mouse.continuousScroll&&native.mouse.wheelUnits.includes('regionQ16_16'))&&
    (policy.touch!=='mouse-gestures'||(native.mouse.buttonsMask&2))){
    result.inputTypes.push('touch');result.touch={maxContacts:policy.touch==='mouse-gestures'?2:1};
  }
  if(policy.mouse==='native'&&native.inputTypes.includes('mouse')){result.inputTypes.push('mouse');result.mouse=structuredClone(native.mouse);}
  if(policy.mouse==='touch'&&native.inputTypes.includes('touch')){
    result.inputTypes.push('mouse');result.mouse={buttonsMask:1,modifierMask:0,allowChords:false,wheelUnits:[],continuousScroll:false};
  }
  return result;
}

// Runs after typed wire validation and geometry mapping, inside the engine's
// owned serial native chain. The wire type stays intact; only local actions
// change. A policy is immutable for the lifetime of each native owner.
export class OutputPolicyAdapter {
  constructor(native,{now=()=>performance.now()}={}){this.native=native;this.now=now;this.policy={...DEFAULT_OUTPUT_POLICY};this.nativeCaps=null;this.owners=new Map();this.lastConversion=null;}
  async probe(){this.nativeCaps=await this.native.probe();return policyCapabilities(this.nativeCaps,this.policy);}
  async setOutputPolicy(value){
    const next=normalizeOutputPolicy(value);
    check(this.owners.size===0,'Input cleanup required before policy change');
    const native=await this.native.probe(),caps=policyCapabilities(native,next);
    for(const type of ['touch','mouse'])if(!['native','disabled'].includes(next[type]))check(caps.inputTypes.includes(type),`Output conversion not supported: ${type} → ${outputType(next,type)}`);
    if(next.touch==='mouse-gestures'){
      const settings=normalizeGestureSettings(next.gestures);
      check(settings.pinchAction!=='browser-zoom'||native.zoom?.browser===true,'Browser zoom not supported');
      check(settings.pinchAction!=='ctrl-wheel'||(native.mouse.modifierMask&2)&&native.mouse.wheelUnits.includes('detent120'),'Ctrl-wheel zoom not supported');
      next.gestures=settings;
    }
    this.nativeCaps=native;this.policy=next;this.lastConversion=null;
  }
  async configuration(){
    const caps=await this.native.probe();this.nativeCaps=caps;
    return{policy:structuredClone(this.policy),options:outputPolicyOptions(caps),nativeInputTypes:[...(caps.nativeTypes??caps.inputTypes)],
      gestureSettings:normalizeGestureSettings(this.policy.gestures),pinchActions:['disabled',...(caps.zoom?.browser?['browser-zoom']:[]),...(caps.mouse?.modifierMask&2&&caps.mouse?.wheelUnits.includes('detent120')?['ctrl-wheel']:[])]};
  }
  async prepare(context,contract){
    const policy=structuredClone(this.policy);
    const nativeTypes=[...new Set(contract.acceptedInputTypes.map(type=>outputType(policy,type)))];
    const nativeContract={...contract,acceptedInputTypes:nativeTypes};
    delete nativeContract.touch;delete nativeContract.mouse;
    if(nativeTypes.includes('touch'))nativeContract.touch={maxContacts:Math.max(contract.acceptedInputTypes.includes('touch')&&policy.touch==='native'?contract.touch.maxContacts:0,contract.acceptedInputTypes.includes('mouse')&&policy.mouse==='touch'?1:0)};
    if(nativeTypes.includes('mouse'))nativeContract.mouse=structuredClone(this.nativeCaps.mouse);
    // Retain context even if IPC loses the prepare response: release must still
    // reach the guarded native owner before another policy can be selected.
    this.owners.set(context.ownerId,{policy,gesture:null,activeType:null,buttons:0,modifiers:0,scrolling:false,
      recognizer:policy.touch==='mouse-gestures'?new TouchMouseGestures({region:context.geometry.region,settings:policy.gestures}):null});
    return this.native.prepare(context,nativeContract);
  }
  convert(action,owner,context){
    const type=action.inputType,mode=owner.policy[type];
    check(!owner.activeType||owner.activeType===type,'Overlapping Touch/Mouse output gesture');
    if(mode==='native')return [action];
    const mouse=(eventKind,buttons,x,y,extra={})=>({inputType:'mouse',eventKind,buttons,modifiers:0,x,y,...extra});
    if(type==='touch'){
      if(mode==='mouse-gestures')return owner.recognizer.accept(action.records,this.now()).flatMap(converted=>
        converted.inputType==='mouse'&&converted.eventKind===2&&converted.modifiers?
          [converted,{inputType:'mouse',eventKind:4,modifiers:0}]:[converted]);
      check(action.records.length===1,'Touch conversion supports one contact');
      const r=action.records[0],g=owner.gesture;
      if(r.phase===0){
        check(!g,'Touch gesture already active');owner.gesture={id:r.contactId,x:r.x,y:r.y,lastX:r.x,lastY:r.y,scrolling:false};
        return [mouse(mode==='mouse-drag'?1:0,mode==='mouse-drag'?1:0,r.x,r.y)];
      }
      check(g&&g.id===r.contactId,'Touch conversion contact missing');
      if(mode==='mouse-drag'){
        if(r.phase>=2)owner.gesture=null;
        return [mouse(r.phase>=2?1:0,r.phase>=2?0:1,r.x,r.y)];
      }
      const actions=[],region=context.geometry.region;
      const wheel=(dx,dy,phase)=>mouse(2,0,g.x,g.y,{wheelUnit:1,wheelPhase:phase,
        wheelX:Math.round(dx/Math.max(1,region.width-1)*65536),wheelY:Math.round(dy/Math.max(1,region.height-1)*65536)});
      if(r.phase!==3&&(g.scrolling||Math.hypot(r.x-g.x,r.y-g.y)>=6)){
        const dx=r.x-g.lastX,dy=r.y-g.lastY;
        if(dx||dy){actions.push(wheel(dx,dy,g.scrolling?2:1));g.scrolling=true;g.lastX=r.x;g.lastY=r.y;}
      }
      if(r.phase>=2){
        if(g.scrolling)actions.push(wheel(0,0,r.phase===3?4:3));
        else if(r.phase===2)actions.push(mouse(1,1,g.x,g.y),mouse(1,0,g.x,g.y));
        owner.gesture=null;
      }
      return actions;
    }
    check(type==='mouse'&&mode==='touch','Unsupported output conversion');
    check(!action.modifiers&&!(action.buttons&~1)&&[0,1,3,4].includes(action.eventKind),'Mouse to Touch supports only the left button');
    const g=owner.gesture;
    if(action.eventKind===4)return [];
    let phase;
    if(action.eventKind===3){if(!g)return [];phase=3;}
    else if(action.eventKind===1){phase=action.buttons?0:2;check(action.buttons?!g:Boolean(g),'Invalid Mouse to Touch lifecycle');}
    else {if(!g)return [];phase=1;}
    const point=action.eventKind===3?g:action;
    owner.gesture=phase>=2?null:{x:action.x,y:action.y};
    return [{inputType:'touch',records:[{contactId:65535,phase,x:Math.round(point.x),y:Math.round(point.y)}]}];
  }
  async apply(action,context){
    const owner=this.owners.get(context.ownerId);
    if(!owner)return{status:'rejected',error:'Output policy owner missing'};
    this.lastConversion={receivedType:action.inputType,outputType:outputType(owner.policy,action.inputType),mode:owner.policy[action.inputType],emittedActions:0,status:'pending'};
    let submitted=0,nativeDurationMs=0;
    try{
      const actions=this.convert(action,owner,context);
      for(const converted of actions){
        const result=await this.native.apply(converted,context);
        nativeDurationMs+=result.nativeDurationMs??0;
        if(result.status!=='submitted'){this.lastConversion.status=result.status;return{...result,nativeDurationMs,status:submitted?'partial':result.status,submittedActions:submitted+(result.submittedActions??0)};}
        submitted+=result.submittedActions??1;this.lastConversion.emittedActions++;
      }
      if(action.inputType==='mouse'&&owner.policy.mouse==='native'){
        if(action.eventKind===3){owner.buttons=0;owner.modifiers=0;owner.scrolling=false;}
        else{
          if(action.buttons!==undefined)owner.buttons=action.buttons;
          if(action.modifiers!==undefined)owner.modifiers=action.modifiers;
          if(action.eventKind===2&&action.wheelUnit===1)owner.scrolling=action.wheelPhase<3;
        }
      }
      const active=owner.recognizer?.group||owner.gesture||action.inputType==='touch'&&owner.policy.touch==='native'&&action.records.some(r=>r.phase<2)||owner.buttons||owner.modifiers||owner.scrolling;
      owner.activeType=active?action.inputType:null;
      this.lastConversion.status='submitted';return{status:'submitted',submittedActions:submitted,nativeDurationMs};
    }catch(error){this.lastConversion.status='rejected';return{status:submitted?'partial':'rejected',submittedActions:submitted,error:String(error.message??error)};}
  }
  async releaseOwned(context,reason){
    const result=await this.native.releaseOwned(context,reason);
    if(result.status==='released')this.owners.delete(context.ownerId);
    return result;
  }
  owns(ownerId){return this.native.owns(ownerId);}
  refreshExecution(){return this.native.refreshExecution?.();}
  gestureFeedback(){for(const owner of this.owners.values())if(owner.recognizer)return owner.recognizer.tick(this.now());return null;}
  async refreshGestureFeedback(){
    for(const [ownerId,owner]of this.owners)if(owner.recognizer)return this.native.showGestureFeedback?.(ownerId,owner.recognizer.tick(this.now()));
  }
  snapshot(){return{...this.native.snapshot(),outputPolicy:structuredClone(this.policy),nativeInputTypes:[...(this.nativeCaps?.nativeTypes??this.nativeCaps?.inputTypes??[])],lastConversion:structuredClone(this.lastConversion),
    ...(this.policy.touch==='mouse-gestures'?{gestureFeedback:this.gestureFeedback()}: {})};}
}
