const MAX_BYTES=54+320*180*4;
function imageBlob(input){
  const bytes=input instanceof ArrayBuffer?new Uint8Array(input):input;
  if(!(bytes instanceof Uint8Array)||bytes.length<54||bytes.length>MAX_BYTES||bytes[0]!==66||bytes[1]!==77)throw new Error('Invalid target thumbnail');
  return new Blob([bytes],{type:'image/bmp'});
}

// A chooser owns its previews. Closing it stops queued work and revokes URLs;
// late native responses cannot publish images into another chooser generation.
export class CaptureTargetPreviews{
  constructor({invoke,createObjectURL=blob=>URL.createObjectURL(blob),revokeObjectURL=url=>URL.revokeObjectURL(url)}={}){
    Object.assign(this,{invoke,createObjectURL,revokeObjectURL});this.jobs=new Map();this.queue=[];this.running=0;this.disposed=false;
  }
  notify(job,state){job.state=state;try{job.onUpdate(state);}catch{/* Rendering cannot retain native capture resources. */}}
  request(targetId,onUpdate){
    if(this.disposed)return;
    const existing=this.jobs.get(targetId);
    if(existing){existing.onUpdate=onUpdate;onUpdate(existing.state);return;}
    const job={targetId,onUpdate,state:{status:'loading'}};
    this.jobs.set(targetId,job);this.queue.push(job);this.notify(job,job.state);this.drain();
  }
  drain(){
    while(!this.disposed&&this.running<2&&this.queue.length){
      const job=this.queue.shift();this.running++;
      Promise.resolve().then(()=>this.invoke('nearcast_capture_thumbnail',{targetId:job.targetId})).then(bytes=>{
        if(this.disposed)return;
        const url=this.createObjectURL(imageBlob(bytes));this.notify(job,{status:'ready',url});
      }).catch(()=>{if(!this.disposed)this.notify(job,{status:'error'});}).finally(()=>{this.running--;this.drain();});
    }
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;this.queue.length=0;
    for(const job of this.jobs.values())if(job.state.url)this.revokeObjectURL(job.state.url);
    this.jobs.clear();
  }
}
