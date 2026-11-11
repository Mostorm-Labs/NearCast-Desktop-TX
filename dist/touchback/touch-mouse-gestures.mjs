import {check,integer} from './frame-codec.mjs';

export const DEFAULT_GESTURE_SETTINGS=Object.freeze({holdMs:300,rightClick:'hold',rightHoldMs:700,moveThreshold:6,twoFingerTapMs:350,pinchStep:0.12,pinchAction:'disabled',feedback:true});
const RELEASE_FEEDBACK_MS=280;
export function normalizeGestureSettings(value={}){
  check(value&&Object.keys(value).every(key=>Object.hasOwn(DEFAULT_GESTURE_SETTINGS,key)),'Invalid gesture setting');
  const s={...DEFAULT_GESTURE_SETTINGS,...value};
  check(integer(s.holdMs,150,2000)&&integer(s.moveThreshold,3,30)&&integer(s.twoFingerTapMs,150,600),'Gesture timing/distance out of range');
  if(!Object.hasOwn(value,'rightHoldMs'))s.rightHoldMs=Math.max(s.rightHoldMs,s.holdMs);
  check(['hold','two-finger'].includes(s.rightClick),'Invalid right-click method');
  check(integer(s.rightHoldMs,150,3000)&&s.rightHoldMs>=s.holdMs,'Right-click delay must be at least the drag hold delay');
  check(Number.isFinite(s.pinchStep)&&s.pinchStep>=0.05&&s.pinchStep<=0.4,'Invalid pinch sensitivity');
  check(['disabled','browser-zoom','ctrl-wheel'].includes(s.pinchAction)&&typeof s.feedback==='boolean','Invalid gesture output');
  return s;
}
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const center=points=>({x:points.reduce((n,p)=>n+p.x,0)/points.length,y:points.reduce((n,p)=>n+p.y,0)/points.length});

// Pure state machine: explicit clock, no OS calls, timers or transport. Feed a
// complete validated contact sample in local logical coordinates. It can be
// reused at the receiver, then encode returned Mouse actions in normalized units.
export class TouchMouseGestures{
  constructor({region,settings={}}){this.region=region;this.settings=normalizeGestureSettings(settings);this.group=null;this.released=null;this.time=0;}
  mouse(eventKind,buttons,p,extra={}){return{inputType:'mouse',eventKind,buttons,modifiers:0,x:p.x,y:p.y,...extra};}
  wheel(g,dx,dy,phase){return this.mouse(2,0,g.anchor,{wheelUnit:1,wheelPhase:phase,
    wheelX:Math.round(dx/Math.max(1,this.region.width-1)*65536),wheelY:Math.round(dy/Math.max(1,this.region.height-1)*65536)});}
  feedback(){
    if(!this.settings.feedback)return null;
    const g=this.group;
    if(!g){
      const f=this.released;
      return f&&this.time<f.until?{stage:f.stage,x:f.x,y:f.y,progress:Math.max(0,Math.min(1,(this.time-f.started)/RELEASE_FEEDBACK_MS))}:null;
    }
    if(g.stage==='blocked')return null;
    const elapsed=g.time-g.started;
    const progress=g.stage==='holding'?Math.min(1,elapsed/this.settings.holdMs):g.stage==='right-wait'?
      Math.max(0,Math.min(1,(elapsed-this.settings.holdMs)/Math.max(1,this.settings.rightHoldMs-this.settings.holdMs))):1;
    return{stage:g.stage,x:g.point.x,y:g.point.y,progress};
  }
  tick(time){
    const g=this.group;
    this.time=Math.max(this.time,time);
    if(this.released&&this.time>=this.released.until)this.released=null;
    if(g){
      g.time=Math.max(g.time,time);
      if(['holding','armed','right-wait','right-ready'].includes(g.stage)&&g.time-g.started>=this.settings.holdMs){
        g.stage=this.settings.rightClick==='hold'?(g.time-g.started>=this.settings.rightHoldMs?'right-ready':'right-wait'):'armed';
      }
    }
    return this.feedback();
  }
  accept(records,time){
    check(Array.isArray(records)&&records.length>=1&&records.length<=2,'Gesture requires one or two contacts');
    const active=records.filter(r=>r.phase<2),newContacts=records.filter(r=>r.phase===0),cancelled=records.some(r=>r.phase===3),out=[];
    this.tick(time);
    if(!this.group){
      this.released=null;
      check(newContacts.length===records.length,'Gesture must start with Down');
      const p=center(records),first=records[0];
      this.group={stage:'holding',started:time,time,anchor:{x:first.x,y:first.y},point:p,last:{x:first.x,y:first.y},id:first.contactId,
        origins:new Map(records.map(r=>[r.contactId,{x:r.x,y:r.y}])),two:false,tap:true,pinched:false,ended:false,zoomLog:0};
      if(records.length===2)this.beginPair(records,time);
      out.push(this.mouse(0,0,this.group.anchor));
      return out;
    }
    const g=this.group;this.tick(time);
    if(g.stage==='blocked'){
      if(!active.length)this.group=null;
      return out;
    }
    if(records.length===2&&!g.two){
      if(['dragging','scrolling'].includes(g.stage)){
        out.push(g.stage==='dragging'?this.mouse(1,0,g.last):this.wheel(g,0,0,4));
        g.stage='blocked';if(!active.length)this.group=null;return out;
      }
      if(newContacts.length===1&&active.length===2){this.beginPair(records,time);g.tap=g.tap&&time-g.started<=this.settings.twoFingerTapMs;}
      else{g.stage='blocked';return out;}
    }
    if(g.two){
      if(g.ended&&newContacts.length){g.tap=false;g.stage='blocked';if(!active.length)this.group=null;return out;}
      g.tap=g.tap&&!cancelled&&time-g.pairStarted<=this.settings.twoFingerTapMs;
      for(const r of records){const origin=g.origins.get(r.contactId);if(!origin||distance(r,origin)>this.settings.moveThreshold)g.tap=false;}
      if(records.some(r=>r.phase>=2))g.ended=true;
      if(records.length===2&&!g.ended&&!cancelled){
        g.point=center(records);
        const span=distance(records[0],records[1]);
        if(span>1&&g.initialSpan>1){
          const log=Math.log(span/g.initialSpan),delta=log-g.zoomLog;
          if(Math.abs(log)>=this.settings.pinchStep||g.pinched){
            g.pinched=true;g.tap=false;g.stage='pinching';
            const steps=Math.max(-4,Math.min(4,Math.trunc(delta/this.settings.pinchStep)));
            if(steps&&this.settings.pinchAction!=='disabled'){
              g.zoomLog+=steps*this.settings.pinchStep;
              out.push(this.settings.pinchAction==='browser-zoom'?{inputType:'zoom',steps,x:g.anchor.x,y:g.anchor.y}:
                this.mouse(2,0,g.anchor,{modifiers:2,wheelUnit:0,wheelPhase:0,wheelX:0,wheelY:steps*120}));
            }
          }
        }
      }
      if(cancelled){g.tap=false;g.stage='blocked';}
      if(!active.length){
        if(g.tap&&!g.pinched&&this.settings.rightClick==='two-finger'){
          out.push(this.mouse(1,2,g.anchor),this.mouse(1,0,g.anchor));this.releaseFeedback(g.anchor,true);
        }
        this.group=null;
      }
      return out;
    }
    const r=records[0];check(r.contactId===g.id,'Gesture contact changed');
    g.point={x:r.x,y:r.y};
    const moved=distance(g.point,g.anchor)>=this.settings.moveThreshold;
    if(r.phase!==3&&moved&&['holding','armed','right-wait','right-ready'].includes(g.stage)){
      if(g.stage!=='holding'){g.stage='dragging';out.push(this.mouse(1,1,g.anchor));}
      else{g.stage='scrolling';out.push(this.wheel(g,r.x-g.anchor.x,r.y-g.anchor.y,1));}
      g.last={x:r.x,y:r.y};
      if(g.stage==='dragging')out.push(this.mouse(0,1,g.point));
    }else if(r.phase!==3&&g.stage==='scrolling'){
      const dx=r.x-g.last.x,dy=r.y-g.last.y;
      if(dx||dy)out.push(this.wheel(g,dx,dy,2));g.last={x:r.x,y:r.y};
    }else if(r.phase===1&&g.stage==='dragging'){
      out.push(this.mouse(0,1,g.point));g.last={x:r.x,y:r.y};
    }
    if(r.phase>=2){
      const right=g.stage==='right-ready'&&r.phase===2;
      if(g.stage==='dragging')out.push(this.mouse(1,0,r.phase===3?g.last:g.point));
      else if(g.stage==='scrolling')out.push(this.wheel(g,0,0,r.phase===3?4:3));
      else if(r.phase===2)out.push(this.mouse(1,right?2:1,g.anchor),this.mouse(1,0,g.anchor));
      if(r.phase===2)this.releaseFeedback(right?g.anchor:g.point,right);
      this.group=null;
    }
    return out;
  }
  releaseFeedback(point,right){
    this.released={stage:right?'right-released':'released',x:point.x,y:point.y,started:this.time,until:this.time+RELEASE_FEEDBACK_MS};
  }
  beginPair(records,time){
    const g=this.group;g.two=true;g.stage='two-finger';g.pairStarted=time;g.point=center(records);g.anchor={...g.point};g.initialSpan=distance(records[0],records[1]);
    for(const r of records)if(!g.origins.has(r.contactId))g.origins.set(r.contactId,{x:r.x,y:r.y});
  }
}
