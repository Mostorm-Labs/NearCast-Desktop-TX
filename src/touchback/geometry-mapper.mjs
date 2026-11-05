import {check,integer} from './frame-codec.mjs';
export class GeometryMapper {
  constructor(descriptor){
    check(descriptor?.proven===true&&typeof descriptor.revision==='string'&&descriptor.revision.length>0,'Unproven native geometry');
    check(['physical-pixels','points'].includes(descriptor.units)&&descriptor.rotation===0,'Unsupported native geometry units/rotation');
    const r=descriptor.region;
    check(r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.width>=1&&r.height>=1,'Invalid native geometry region');
    check(Math.abs(r.x)+r.width<=0x7fffffff&&Math.abs(r.y)+r.height<=0x7fffffff,'Native geometry range');
    this.descriptor=structuredClone(descriptor);
  }
  point(x,y){
    check(integer(x,0,65535)&&integer(y,0,65535),'Normalized coordinates out of range');
    const r=this.descriptor.region;
    const offset=(value,extent)=>this.descriptor.units==='physical-pixels'?Math.round(value*(extent-1)/65535):value*(extent-1)/65535;
    return{x:r.x+offset(x,r.width),y:r.y+offset(y,r.height)};
  }
  map(sample){
    if(sample.inputType==='touch')return{inputType:'touch',records:sample.records.map(record=>({...record,...this.point(record.x,record.y)}))};
    const {streamId,seqId,cursor,dataBytes,frameBytes,...action}=sample;
    return action.x===undefined?action:{...action,...this.point(action.x,action.y)};
  }
}
