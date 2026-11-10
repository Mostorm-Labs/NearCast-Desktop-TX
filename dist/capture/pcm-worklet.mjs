// Fixed stereo ring: 40 ms prefill, at most 200 ms queued. Neither video IPC
// nor a renderer stall may create an ever-growing playback delay.
class NativePcmProcessor extends AudioWorkletProcessor {
  constructor(){
    super();this.capacity=9600;this.ring=new Float32Array(this.capacity*2);this.read=0;this.queuedFrames=0;
    this.ready=false;this.underrunFrames=0;this.droppedFrames=0;this.renderedFrames=0;
    this.port.onmessage=({data})=>{
      if(!(data?.samples instanceof Float32Array)||data.samples.length%2)return;
      if(data.reset){this.read=0;this.queuedFrames=0;this.ready=false;}
      const samples=data.samples,frames=samples.length/2;
      for(let i=0;i<frames;i++){
        if(this.queuedFrames===this.capacity){this.read=(this.read+1)%this.capacity;this.queuedFrames--;this.droppedFrames++;}
        const write=(this.read+this.queuedFrames)%this.capacity;
        this.ring[write*2]=samples[i*2];this.ring[write*2+1]=samples[i*2+1];this.queuedFrames++;
      }
      if(this.queuedFrames>=1920)this.ready=true;
    };
  }
  process(_inputs,outputs){
    const output=outputs[0];if(!output?.length)return true;
    for(let i=0;i<output[0].length;i++){
      const available=this.ready&&this.queuedFrames>0;
      for(let channel=0;channel<output.length;channel++)output[channel][i]=available?this.ring[this.read*2+Math.min(channel,1)]:0;
      if(available){this.read=(this.read+1)%this.capacity;this.queuedFrames--;}
      else{this.underrunFrames++;this.ready=false;}
      this.renderedFrames++;
    }
    if(this.renderedFrames%48000<output[0].length)this.port.postMessage({queuedFrames:this.queuedFrames,underrunFrames:this.underrunFrames,droppedFrames:this.droppedFrames});
    return true;
  }
}
registerProcessor('nearcast-native-pcm',NativePcmProcessor);
