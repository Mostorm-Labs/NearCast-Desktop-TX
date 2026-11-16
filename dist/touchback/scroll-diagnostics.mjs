const totals=()=>({samples:0,positiveX:0,negativeX:0,positiveY:0,negativeY:0});
// Additive observability only: no source/owner IDs, absolute positions or input
// policy. Opposite directions stay separate so they cannot cancel in a report.
export class ScrollDiagnostics {
  constructor(){
    this.value={scopeStartedAt:Date.now(),streams:0,detent120:{received:totals(),submitted:totals()},
      regionQ16_16:{received:totals(),submitted:totals()},touchReceived:0,touchSubmitted:0,
      wheelBridgeMs:0,wheelNativeMs:0,wheelMaxBridgeMs:0,wheelMaxNativeMs:0};
  }
  opened(){this.value.streams++;}
  record(stage,sample,bridgeMs=0,nativeMs=0){
    if(sample.inputType==='touch'){this.value[stage==='received'?'touchReceived':'touchSubmitted']++;return;}
    if(sample.inputType!=='mouse'||sample.eventKind!==2)return;
    const unit=sample.wheelUnit===0?'detent120':'regionQ16_16',bucket=this.value[unit][stage];bucket.samples++;
    for(const [axis,key]of [['X','wheelX'],['Y','wheelY']]){
      const value=sample[key];if(Number.isFinite(value))bucket[(value>=0?'positive':'negative')+axis]+=Math.abs(value);
    }
    if(stage==='submitted'){
      const bridge=Number.isFinite(bridgeMs)?Math.max(0,bridgeMs):0,native=Number.isFinite(nativeMs)?Math.max(0,nativeMs):0;
      this.value.wheelBridgeMs+=bridge;this.value.wheelNativeMs+=native;
      this.value.wheelMaxBridgeMs=Math.max(this.value.wheelMaxBridgeMs,bridge);this.value.wheelMaxNativeMs=Math.max(this.value.wheelMaxNativeMs,native);
    }
  }
  snapshot(){return structuredClone(this.value);}
}
