import {check} from './frame-codec.mjs';

export const DEFAULT_OUTPUT_POLICY=Object.freeze({touch:'native',mouse:'native'});
export function outputPolicyOptions(native){
  const mouse=native.inputTypes.includes('mouse'),touch=native.inputTypes.includes('touch');
  return {
    touch:[{value:'native',label:'原生 Touch（保持类型）',supported:touch},{value:'mouse-drag',label:'Mouse · 点击与拖拽',supported:mouse&&Boolean(native.mouse?.buttonsMask&1)},
      {value:'mouse-scroll',label:'Mouse · 轻点点击 / 滑动滚动',supported:mouse&&Boolean(native.mouse?.buttonsMask&1)&&native.mouse?.continuousScroll===true&&native.mouse?.wheelUnits.includes('regionQ16_16')},
      {value:'disabled',label:'禁用 Touch 输入',supported:true}],
    mouse:[{value:'native',label:'原生 Mouse（保持类型）',supported:mouse},{value:'touch',label:'Touch · 左键单点触控',supported:touch},
      {value:'disabled',label:'禁用 Mouse 输入',supported:true}],
  };
}
export function normalizeOutputPolicy(value){
  check(value&&Object.keys(value).every(key=>['touch','mouse'].includes(key)),'Invalid input output policy');
  const policy={...DEFAULT_OUTPUT_POLICY,...value};
  check(['native','mouse-drag','mouse-scroll','disabled'].includes(policy.touch)&&['native','touch','disabled'].includes(policy.mouse),'Invalid input output policy');
  return policy;
}
const outputType=(policy,type)=>policy[type]==='disabled'?null:policy[type]==='native'?type:type==='touch'?'mouse':'touch';
export function policyCapabilities(native,policy){
  const result={...structuredClone(native),inputTypes:[],nativeTypes:[...(native.nativeTypes??native.inputTypes)]};
  delete result.touch;delete result.mouse;
  if(policy.touch==='native'&&native.inputTypes.includes('touch')){result.inputTypes.push('touch');result.touch={...native.touch};}
  if(['mouse-drag','mouse-scroll'].includes(policy.touch)&&native.inputTypes.includes('mouse')&&(native.mouse.buttonsMask&1)&&
    (policy.touch!=='mouse-scroll'||native.mouse.continuousScroll&&native.mouse.wheelUnits.includes('regionQ16_16'))){
    result.inputTypes.push('touch');result.touch={maxContacts:1};
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
  constructor(native){this.native=native;this.policy={...DEFAULT_OUTPUT_POLICY};this.nativeCaps=null;this.owners=new Map();this.lastConversion=null;}
  async probe(){this.nativeCaps=await this.native.probe();return policyCapabilities(this.nativeCaps,this.policy);}
  async setOutputPolicy(value){
    const next=normalizeOutputPolicy(value);
    check(this.owners.size===0,'Input cleanup required before policy change');
    const native=await this.native.probe(),caps=policyCapabilities(native,next);
    for(const type of ['touch','mouse'])if(!['native','disabled'].includes(next[type]))check(caps.inputTypes.includes(type),`Output conversion not supported: ${type} → ${outputType(next,type)}`);
    this.nativeCaps=native;this.policy=next;this.lastConversion=null;
  }
  async configuration(){
    const caps=await this.native.probe();this.nativeCaps=caps;
    return{policy:{...this.policy},options:outputPolicyOptions(caps),nativeInputTypes:[...(caps.nativeTypes??caps.inputTypes)]};
  }
  async prepare(context,contract){
    const policy={...this.policy};
    const nativeTypes=[...new Set(contract.acceptedInputTypes.map(type=>outputType(policy,type)))];
    const nativeContract={...contract,acceptedInputTypes:nativeTypes};
    delete nativeContract.touch;delete nativeContract.mouse;
    if(nativeTypes.includes('touch'))nativeContract.touch={maxContacts:Math.max(contract.acceptedInputTypes.includes('touch')&&policy.touch==='native'?contract.touch.maxContacts:0,contract.acceptedInputTypes.includes('mouse')&&policy.mouse==='touch'?1:0)};
    if(nativeTypes.includes('mouse'))nativeContract.mouse=structuredClone(this.nativeCaps.mouse);
    // Retain context even if IPC loses the prepare response: release must still
    // reach the guarded native owner before another policy can be selected.
    this.owners.set(context.ownerId,{policy,gesture:null,activeType:null,buttons:0,scrolling:false});
    return this.native.prepare(context,nativeContract);
  }
  convert(action,owner,context){
    const type=action.inputType,mode=owner.policy[type];
    check(!owner.activeType||owner.activeType===type,'Overlapping Touch/Mouse output gesture');
    if(mode==='native')return [action];
    const mouse=(eventKind,buttons,x,y,extra={})=>({inputType:'mouse',eventKind,buttons,modifiers:0,x,y,...extra});
    if(type==='touch'){
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
    let submitted=0;
    try{
      const actions=this.convert(action,owner,context);
      for(const converted of actions){
        const result=await this.native.apply(converted,context);
        if(result.status!=='submitted'){this.lastConversion.status=result.status;return{...result,status:submitted?'partial':result.status,submittedActions:submitted+(result.submittedActions??0)};}
        submitted+=result.submittedActions??1;this.lastConversion.emittedActions++;
      }
      if(action.inputType==='mouse'&&owner.policy.mouse==='native'){
        if(action.eventKind===3){owner.buttons=0;owner.scrolling=false;}
        else{
          if(action.buttons!==undefined)owner.buttons=action.buttons;
          if(action.eventKind===2&&action.wheelUnit===1)owner.scrolling=action.wheelPhase<3;
        }
      }
      const active=owner.gesture||action.inputType==='touch'&&owner.policy.touch==='native'&&action.records.some(r=>r.phase<2)||owner.buttons||owner.scrolling;
      owner.activeType=active?action.inputType:null;
      this.lastConversion.status='submitted';return{status:'submitted',submittedActions:submitted};
    }catch(error){this.lastConversion.status='rejected';return{status:submitted?'partial':'rejected',submittedActions:submitted,error:String(error.message??error)};}
  }
  async releaseOwned(context,reason){
    const result=await this.native.releaseOwned(context,reason);
    if(result.status==='released')this.owners.delete(context.ownerId);
    return result;
  }
  owns(ownerId){return this.native.owns(ownerId);}
  snapshot(){return{...this.native.snapshot(),outputPolicy:{...this.policy},nativeInputTypes:[...(this.nativeCaps?.nativeTypes??this.nativeCaps?.inputTypes??[])],lastConversion:structuredClone(this.lastConversion)};}
}
