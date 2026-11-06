// Local visual observability only. One in-flight IPC and one latest scene;
// feedback never shares the native injection queue or acknowledges wire input.
export class TouchFeedback {
  constructor({invoke,enabled=true,now=()=>performance.now(),setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}={}) {
    Object.assign(this,{invoke,enabled,now,setTimer,clearTimer});
    this.points=new Map();this.context=null;this.ownerKey=null;this.serial=0;this.timer=null;this.busy=false;this.dirty=false;this.remoteHasPoints=false;this.lastError=null;
  }
  observe(event) {
    if(event.stage==='clear'){this.clear();return;}
    if(!this.enabled||!['received','submitted'].includes(event.stage))return;
    const g=event.geometry;
    if(g?.units!=='physical-pixels'||!g.nativeId?.startsWith('capture:')||!Array.isArray(event.records))return;
    const key=`${g.nativeId}:${g.revision}:${event.ownerId}:${event.streamId}`;
    if(event.stage==='received'&&key!==this.ownerKey){this.points.clear();this.ownerKey=key;}
    if(key!==this.ownerKey)return;
    this.context={captureId:g.nativeId.slice(8),geometryRevision:g.revision,ownerId:event.ownerId};
    const now=this.now();for(const [id,p]of this.points)if(p.until!==null&&p.until<=now)this.points.delete(id);
    let changed=false;
    for(const record of event.records){
      const previous=this.points.get(record.contactId);
      if(event.stage==='received'){
        this.points.set(record.contactId,{...record,seqId:event.seqId,submitted:false,until:record.phase>=2?now+700:null});changed=true;
      }else if(previous?.seqId===event.seqId){previous.submitted=true;changed=true;}
    }
    // Retain active contacts before recent terminal pulses; cap all local work.
    while(this.points.size>32){const old=[...this.points].find(([,p])=>p.until!==null);if(!old)break;this.points.delete(old[0]);}
    if(changed){this.dirty=true;this.schedule();}
  }
  setEnabled(value){this.enabled=value===true;if(!this.enabled)this.clear();}
  clear(){
    if(!this.context||(!this.points.size&&!this.remoteHasPoints&&!this.dirty))return;
    this.points.clear();this.ownerKey=null;this.dirty=true;this.schedule();
  }
  schedule(){if(!this.busy&&this.timer===null)this.timer=this.setTimer(()=>{this.timer=null;void this.flush();},32);}
  async flush(){
    if(this.busy||!this.dirty||!this.context)return;
    this.dirty=false;this.busy=true;const serial=++this.serial,now=this.now();
    const points=[...this.points.values()].filter(p=>p.until===null||p.until>now).slice(0,32).map(p=>({contactId:p.contactId,x:p.x,y:p.y,phase:p.phase,submitted:p.submitted,expiresInMs:p.until===null?null:Math.ceil(p.until-now)}));
    const args={...this.context,serial,points};this.remoteHasPoints=points.length>0;
    try{await this.invoke('nearcast_capture_touch_feedback',args);if(serial===this.serial)this.lastError=null;}
    catch(error){this.lastError=String(error?.message??error);}
    finally{this.busy=false;if(this.dirty)this.schedule();}
  }
  diagnostics(){return{enabled:this.enabled,points:this.points.size,pending:this.busy||this.dirty,lastError:this.lastError};}
}
