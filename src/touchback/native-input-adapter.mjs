import {check,integer} from './frame-codec.mjs';

// This adapter receives validated native actions, never network bytes. Native
// leases and ID pools stay local and are never included in product descriptors.
export class NativeInputAdapter{
  constructor({invoke}={}){if(typeof invoke!=='function')throw new TypeError('Tauri invoke required');this.invoke=invoke;this.owners=new Map();this.lastSubmission=null;}
  async probe(){
    const result=await this.invoke('nearcast_input_probe');
    check(result&&Array.isArray(result.inputTypes)&&result.inputTypes.every(type=>['touch','mouse'].includes(type)),'Invalid native capability result');
    return structuredClone(result);
  }
  async prepare(context,contract){
    try{
      const result=await this.invoke('nearcast_input_prepare',{ownerId:context.ownerId,sourceBindingId:context.binding.sourceBindingId,
        geometryRevision:context.geometry.revision,nativeId:context.geometry.nativeId,inputTypes:contract.acceptedInputTypes,maxContacts:contract.touch?.maxContacts??0});
      if(result?.leaseId)this.owners.set(context.ownerId,{leaseId:result.leaseId,slots:new Map(),maxContacts:contract.touch?.maxContacts??0});
      if(result?.status==='ready'&&result.leaseId)return{status:'ready'};
      return{status:'rejected',error:result?.error??'Native prepare unconfirmed'};
    }catch(error){return{status:'rejected',error:String(error?.message??error)};}
  }
  async apply(action,context){
    this.lastSubmission={inputType:action.inputType,nativeInputType:null,nativeApi:null,pointerType:null,status:'pending'};
    const owner=this.owners.get(context.ownerId);if(!owner){this.lastSubmission.status='rejected';return{status:'rejected',error:'Native owner not prepared'};}
    let nativeAction=structuredClone(action),next;
    try{
      if(action.inputType==='touch'){
        check(action.records.length>=1&&action.records.length<=owner.maxContacts,'Native Touch sample limit');
        next=new Map(owner.slots);const seen=new Set();
        nativeAction.records=action.records.map(record=>{
          check(integer(record.contactId,0,65535)&&!seen.has(record.contactId),'Invalid/duplicate Touch ID');seen.add(record.contactId);
          let slot=next.get(record.contactId);
          if(record.phase===0){
            check(slot===undefined,'Native Touch Down already active');
            const used=new Set(next.values());slot=Array.from({length:owner.maxContacts},(_,index)=>index+1).find(id=>!used.has(id));
            check(slot!==undefined,'Native Touch ID pool exhausted');next.set(record.contactId,slot);
          }
          check(slot!==undefined,'Native Touch ID mapping missing');
          return{...record,contactId:slot};
        });
        check([...owner.slots.keys()].every(id=>seen.has(id)),'Native Touch sample missing active contact');
        for(const record of action.records)if(record.phase>=2)next.delete(record.contactId);
      }
      const result=await this.invoke('nearcast_input_apply',{ownerId:context.ownerId,leaseId:owner.leaseId,geometryRevision:context.geometry.revision,action:nativeAction});
      this.lastSubmission={inputType:action.inputType,nativeInputType:result?.inputType??null,nativeApi:result?.nativeApi??null,pointerType:result?.pointerType??null,status:result?.status??'unknown',
        ...(action.inputType==='touch'?{records:nativeAction.records.slice(0,10).map(record=>({...record}))}:{eventKind:action.eventKind})};
      if(result?.status==='submitted'){if(next)owner.slots=next;return result;}
      return{status:['partial','unknown','rejected'].includes(result?.status)?result.status:'unknown',submittedActions:result?.submittedActions??0,error:result?.error??'Native submission unconfirmed'};
    }catch(error){this.lastSubmission.status='unknown';return{status:'unknown',error:String(error?.message??error)};}
  }
  async releaseOwned(context,reason){
    const owner=this.owners.get(context.ownerId);
    try{
      // A prepare response can be lost after acquiring a native owner. Always
      // ask native to release this exact random owner, even without a lease copy.
      const result=await this.invoke('nearcast_input_release',{ownerId:context.ownerId,leaseId:owner?.leaseId??null,reason});
      if(result?.status==='released'){this.owners.delete(context.ownerId);return result;}
      return{status:'blocked',error:result?.error??'Native cleanup unconfirmed'};
    }catch(error){return{status:'blocked',error:String(error?.message??error)};}
  }
  snapshot(){return{owners:this.owners.size,activeContacts:[...this.owners.values()].reduce((sum,owner)=>sum+owner.slots.size,0),lastSubmission:structuredClone(this.lastSubmission)};}
  owns(ownerId){return this.owners.has(ownerId);}
}
