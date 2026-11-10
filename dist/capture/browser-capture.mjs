import {createSystemAudioTrack} from './native-audio.mjs';
import {calibrateDisplayBinding} from './display-binding.mjs';

// A capture provider returns the browser's original MediaStream and tracks.
// It owns lifecycle and audio composition, never reads or transports pixels.
export class BrowserCaptureMediaDevices {
  constructor({mediaDevices=globalThis.navigator?.mediaDevices,platform='unknown',invoke,
    createSystemAudio=createSystemAudioTrack,calibrateDisplay=calibrateDisplayBinding,onStatus=()=>{}}={}) {
    Object.assign(this,{mediaDevices,platform,invoke,createSystemAudio,calibrateDisplay,onStatus});
    this.current=null;this.generation=0;this.stopBarrier=Promise.resolve();
  }
  getDisplayMedia({video=true,audio=false}={}) {
    if(!this.mediaDevices?.getDisplayMedia) return Promise.reject(new Error('Screen capture is unavailable'));
    const generation=++this.generation;
    // This call must precede every await: WebKit/WebView requires activation.
    let selected;
    try { selected=this.mediaDevices.getDisplayMedia({video:video===false?false:{frameRate:{ideal:60}},audio:this.platform==='windows'?false:audio,systemAudio:'include',surfaceSwitching:'exclude'}); }
    catch(error){return Promise.reject(error);}
    const previous=this.current;
    const retired=this.stopBarrier;
    return (async()=>{
      const stream=await selected;
      try { await retired; }
      catch(error) { stream.getTracks().forEach(t=>t.stop());throw error; }
      if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());throw new Error('Capture selection retired');}
      if(previous) {
        try { await this.release(previous); }
        catch(error) { stream.getTracks().forEach(t=>t.stop());throw error; }
      }
      if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());throw new Error('Capture selection retired');}
      const track=stream.getVideoTracks()[0];
      if(!track){stream.getTracks().forEach(t=>t.stop());throw new Error('Display video track unavailable');}
      const getSettings=track.getSettings.bind(track);
      const raw=getSettings();
      const source={displaySurface:raw.displaySurface??'unknown',width:raw.width,height:raw.height};
      const capture={generation,stream,track,source,sourceId:globalThis.crypto.randomUUID(),abort:new AbortController(),binding:null,bindingStarting:null,bindingError:null,audio:null,audioStarting:null,originalStops:new Map(stream.getTracks().map(t=>[t,t.stop.bind(t)])),closed:false};
      this.current=capture;
      track.getSettings=()=>({...getSettings(),nearcastBrowserSource:{...source},...(capture.binding?{nearcastDisplayBinding:{sourceId:capture.sourceId,bindingId:capture.binding.bindingId}}:{})});
      track.stop=()=>{if(this.current===capture)void this.stop().catch(error=>this.onStatus({error:String(error?.message??error)}));else capture.originalStops.get(track)();};
      capture.ended=()=>{if(this.current===capture)void this.stop().catch(error=>this.onStatus({error:String(error?.message??error)}));};
      track.addEventListener('ended',capture.ended,{once:true});
      if(this.platform==='windows'&&source.displaySurface==='monitor'&&typeof this.invoke==='function'){
        this.onStatus({binding:'calibrating'});
        capture.bindingStarting=Promise.resolve().then(()=>this.calibrateDisplay({stream,sourceId:capture.sourceId,invoke:this.invoke,signal:capture.abort.signal})).then(binding=>{
          if(!capture.closed&&generation===this.generation)capture.binding=binding;
        }).catch(error=>{if(!capture.closed)capture.bindingError=String(error?.message??error);});
        await capture.bindingStarting;
      }
      if(capture.closed||generation!==this.generation){await this.release(capture);throw new Error('Capture calibration retired');}
      if(this.platform==='windows'&&audio) {
        // Audio has a separate lease and worker. It needs no WGC capture.
        capture.audioStarting=Promise.resolve().then(()=>this.createSystemAudio({invoke:this.invoke})).then(async session=>{
          if(capture.closed||generation!==this.generation){await session?.stop();return;}
          if(!session?.track){await session?.stop?.();throw new Error('System audio track unavailable');}
          capture.audio=session;stream.addTrack(session.track);
        }).catch(error=>{
          if(!capture.closed){capture.audio={diagnostics:()=>({state:'error',error:String(error?.message??error)})};this.onStatus({audio:capture.audio.diagnostics()});}
        });
        await capture.audioStarting;
      }
      if(capture.closed||generation!==this.generation){await this.release(capture);throw new Error('Capture start retired');}
      this.onStatus(this.diagnostics());
      return stream;
    })();
  }
  release(capture) {
    if(capture.releasing)return capture.releasing;
    capture.closed=true;
    capture.abort.abort();
    capture.releasing=(async()=>{
      let failure;
      capture.track.removeEventListener?.('ended',capture.ended);
      for(const stop of capture.originalStops.values())try{stop();}catch(error){failure??=error;}
      await capture.bindingStarting;
      if(this.platform==='windows'&&typeof this.invoke==='function'&&capture.source.displaySurface==='monitor'){
        try{await this.invoke('nearcast_display_binding_release',{sourceId:capture.sourceId});}catch(error){failure??=error;}
      }
      await capture.audioStarting;
      // Stop any unexpected display-audio tracks too. No duplicate audio sender.
      for(const track of capture.stream.getAudioTracks()) {
        if(track!==capture.audio?.track && !capture.originalStops.has(track))track.stop();
      }
      try{await capture.audio?.stop?.();}catch(error){failure??=error;}
      if(failure)throw failure;
    })();
    return capture.releasing;
  }
  stop() {
    this.generation++;
    const capture=this.current;this.current=null;
    if(!capture)return this.stopBarrier;
    const stopping=this.release(capture);
    this.stopBarrier=stopping;
    return stopping;
  }
  diagnostics() {
    const c=this.current;if(!c)return null;
    return{backend:'browser',kind:c.source.displaySurface,source:{...c.source},output:c.track.getSettings(),
      displayBinding:c.binding?{bindingId:c.binding.bindingId,region:c.binding.region,state:'bound'}:{state:c.bindingError?'failed':'unbound',error:c.bindingError},
      trackState:c.track.readyState,muted:c.track.muted===true,
      audio:c.audio?.diagnostics?.()??{source:this.platform==='windows'?'wasapi-loopback':'display-audio',state:c.stream.getAudioTracks().length?'capturing':'disabled'}};
  }
}
