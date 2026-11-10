import {createSystemAudioTrack} from './native-audio.mjs';

// A capture provider returns the browser's original MediaStream and tracks.
// It owns lifecycle and audio composition, never reads or transports pixels.
export class BrowserCaptureMediaDevices {
  constructor({mediaDevices=globalThis.navigator?.mediaDevices,platform='unknown',invoke,
    createSystemAudio=createSystemAudioTrack,onStatus=()=>{}}={}) {
    Object.assign(this,{mediaDevices,platform,invoke,createSystemAudio,onStatus});
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
      const capture={generation,stream,track,source,audio:null,audioStarting:null,originalStops:new Map(stream.getTracks().map(t=>[t,t.stop.bind(t)])),closed:false};
      this.current=capture;
      track.getSettings=()=>({...getSettings(),nearcastBrowserSource:{...source}});
      track.stop=()=>{if(this.current===capture)void this.stop().catch(error=>this.onStatus({error:String(error?.message??error)}));else capture.originalStops.get(track)();};
      capture.ended=()=>{if(this.current===capture)void this.stop().catch(error=>this.onStatus({error:String(error?.message??error)}));};
      track.addEventListener('ended',capture.ended,{once:true});
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
    capture.releasing=(async()=>{
      capture.track.removeEventListener?.('ended',capture.ended);
      for(const stop of capture.originalStops.values())stop();
      await capture.audioStarting;
      // Stop any unexpected display-audio tracks too. No duplicate audio sender.
      for(const track of capture.stream.getAudioTracks()) {
        if(track!==capture.audio?.track && !capture.originalStops.has(track))track.stop();
      }
      await capture.audio?.stop?.();
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
      trackState:c.track.readyState,muted:c.track.muted===true,
      audio:c.audio?.diagnostics?.()??{source:this.platform==='windows'?'wasapi-loopback':'display-audio',state:c.stream.getAudioTracks().length?'capturing':'disabled'}};
  }
}
