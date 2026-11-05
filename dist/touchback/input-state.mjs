import {check} from './frame-codec.mjs';

export class InputState {
  constructor(){this.contacts=new Map();this.buttons=0;this.modifiers=0;this.scroll=null;this.seqId=0;this.cursor=0n;}
  candidate(sample,contract){
    check(contract.acceptedInputTypes.includes(sample.inputType),'Unaccepted input type');
    check(sample.dataBytes<=contract.maxDataBytes,'Input data budget');
    check(sample.seqId===this.seqId+1,'Input sequence gap/duplicate');
    check(BigInt(sample.cursor)>=this.cursor,'Input cursor backwards');
    const next=new InputState();Object.assign(next,this);next.contacts=new Map(this.contacts);
    if(sample.inputType==='touch'){
      check(sample.records.length<=contract.touch.maxContacts,'Touch count limit');
      const ids=new Set(sample.records.map(record=>record.contactId));
      check(ids.size===sample.records.length,'Duplicate Touch ID');
      check([...this.contacts.keys()].every(id=>ids.has(id)),'Missing active Touch ID');
      for(const record of sample.records){
        if(record.phase===0){check(!this.contacts.has(record.contactId),'Touch Down already active');next.contacts.set(record.contactId,{...record});}
        else{check(this.contacts.has(record.contactId),'Orphan Touch contact');if(record.phase>=2)next.contacts.delete(record.contactId);else next.contacts.set(record.contactId,{...record});}
      }
    }else{
      const limits=contract.mouse,kind=sample.eventKind;
      if(kind===3){next.buttons=0;next.modifiers=0;next.scroll=null;}
      else{
        check((sample.modifiers&~limits.modifierMask)===0,'Unsupported Mouse modifier');next.modifiers=sample.modifiers;
        if(kind!==4){
          check((sample.buttons&~limits.buttonsMask)===0,'Unsupported Mouse button');
          check(limits.allowChords||(sample.buttons&(sample.buttons-1))===0,'Unsupported Mouse chord');
          check(kind===1?sample.buttons!==this.buttons:sample.buttons===this.buttons,kind===1?'Buttons without transition':'Implicit button change');
          next.buttons=sample.buttons;
          if(kind===2){
            const unit=sample.wheelUnit===0?'detent120':'regionQ16_16';check(limits.wheelUnits.includes(unit),'Unsupported wheel unit');
            if(sample.wheelUnit===0)check(sample.wheelPhase===0&&(sample.wheelX!==0||sample.wheelY!==0)&&!this.scroll,'Invalid detent/overlapping wheel');
            else{
              check(limits.continuousScroll&&sample.wheelPhase>=1,'Unsupported continuous phase');
              if(sample.wheelPhase===1){check(!this.scroll,'Overlapping scroll');next.scroll={x:sample.x,y:sample.y};}
              else{
                check(this.scroll&&this.scroll.x===sample.x&&this.scroll.y===sample.y,'Scroll without Began or changed anchor');
                if(sample.wheelPhase>=3){check(sample.wheelX===0&&sample.wheelY===0,'Scroll terminal delta');next.scroll=null;}
              }
            }
          }
        }
      }
    }
    next.seqId=sample.seqId;next.cursor=BigInt(sample.cursor);return next;
  }
}
