import {check,integer} from '../touchback/frame-codec.mjs';
const MAX_PIXELS=3840*2160;
export function decodeCaptureFrame(input,captureId){
  const bytes=input instanceof ArrayBuffer?new Uint8Array(input):input;
  check(bytes instanceof Uint8Array&&bytes.length>=4,'Capture packet length');
  const size=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
  check(size>0&&size<=4096&&size+4<=bytes.length,'Capture metadata length');
  const metadata=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(4,4+size)));
  check(metadata.captureId===captureId&&metadata.geometry?.captureId===captureId,'Retired capture identity');
  const {width,height}=metadata;
  check(integer(width,0,16384)&&integer(height,0,16384)&&width*height<=MAX_PIXELS&&(width===0)===(height===0),'Capture dimensions/budget');
  check(metadata.pixelFormat==='BGRA8'&&bytes.length===4+size+width*height*4,'Capture pixel length/format');
  check(!width||(width===metadata.geometry.captureWidth&&height===metadata.geometry.captureHeight),'Capture frame/geometry dimensions disagree');
  return{...metadata,pixels:bytes.subarray(4+size)};
}
export function fitCaptureSize(width,height,constraints=true){
  check(integer(width,1,16384)&&integer(height,1,16384)&&width*height<=MAX_PIXELS,'Capture dimensions/budget');
  const limitWidth=constraints?.width?.ideal??width,limitHeight=constraints?.height?.ideal??height;
  const scale=Math.min(1,limitWidth/width,limitHeight/height);
  return{width:Math.max(2,Math.floor(width*scale/2)*2),height:Math.max(2,Math.floor(height*scale/2)*2)};
}

// Binary BGRA -> GPU color swizzle. No base64/JSON pixel array, CPU resize or
// additional lossy codec before the existing H.264 WebRTC sender.
export function createCaptureCanvas(){
  const canvas=document.createElement('canvas');const gl=canvas.getContext('webgl',{alpha:false,preserveDrawingBuffer:true});
  if(!gl)throw new Error('Native capture requires WebGL');
  const shader=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader;};
  const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,'attribute vec2 position;varying vec2 uv;void main(){gl_Position=vec4(position,0,1);uv=vec2((position.x+1.0)*0.5,(1.0-position.y)*0.5);}'));
  gl.attachShader(program,shader(gl.FRAGMENT_SHADER,'precision mediump float;varying vec2 uv;uniform sampler2D image;void main(){vec4 c=texture2D(image,uv);gl_FragColor=vec4(c.b,c.g,c.r,1.0);}'));gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  return{canvas,draw(frame,size){if(canvas.width!==size.width||canvas.height!==size.height){canvas.width=size.width;canvas.height=size.height;}gl.viewport(0,0,size.width,size.height);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,frame.width,frame.height,0,gl.RGBA,gl.UNSIGNED_BYTE,frame.pixels);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);gl.flush();},close(){gl.getExtension('WEBGL_lose_context')?.loseContext();}};
}

// Bounded RGB sampling is diagnostic only. Static content is valid and must
// never revoke capture/input or be treated as a failure based on this digest.
function sampledPixelHash(pixels){
  const step=Math.max(4,Math.floor(pixels.length/4096/4)*4);let hash=2166136261;
  for(let i=0;i<pixels.length;i+=step)for(let channel=0;channel<3;channel++)hash=Math.imul(hash^pixels[i+channel],16777619);
  return (hash>>>0).toString(16).padStart(8,'0');
}

export class NativeCaptureMediaDevices{
  constructor({invoke,chooseTarget,onGeometryChange=()=>{},onStatus=()=>{},createCanvas=createCaptureCanvas,displayMediaDevices=globalThis.navigator?.mediaDevices,now=()=>performance.now()}={}){
    Object.assign(this,{invoke,chooseTarget,onGeometryChange,onStatus,createCanvas,displayMediaDevices,now});this.generation=0;this.current=null;this.indicatorKey=null;this.indicatorSequence=0;this.stopBarrier=Promise.resolve();this.acquisition=Promise.resolve();
  }
  async getDisplayMedia({video=true,audio=false}={}){
    await this.stop();const generation=++this.generation,targetId=await this.chooseTarget();
    if(generation!==this.generation)throw new Error('Capture selection cancelled');
    if(!targetId)throw new DOMException('Screen capture cancelled','NotAllowedError');
    const acquire=this.acquisition.then(async()=>{
    if(generation!==this.generation)throw new Error('Capture selection retired');
    const started=await this.invoke('nearcast_capture_start',{targetId});
    if(generation!==this.generation){await this.invoke('nearcast_capture_stop',{captureId:started.captureId});throw new Error('Capture start cancelled');}
    let renderer,stream;
    try{renderer=this.createCanvas();Object.assign(renderer.canvas,fitCaptureSize(started.captureWidth,started.captureHeight,video));stream=renderer.canvas.captureStream(0);}catch(failure){await this.invoke('nearcast_capture_stop',{captureId:started.captureId});throw failure;}
    const track=stream.getVideoTracks()[0],getSettings=track.getSettings.bind(track),stop=track.stop.bind(track);
    const capture={id:started.captureId,generation,renderer,stream,track,stop,audioTracks:[],geometry:started,frames:0,sampledPixelHash:null,sampledPixelChanges:0,lastFrameId:null,nativeCapture:null,startedAt:this.now(),stateKey:null};this.current=capture;
    // Canvas-track settings lag a resize until Chromium consumes the next frame.
    // We own this renderer: its output size is the frame actually requested.
    track.getSettings=()=>({...getSettings(),width:renderer.canvas.width,height:renderer.canvas.height,aspectRatio:renderer.canvas.width/renderer.canvas.height,displaySurface:capture.geometry.kind,nearcastCaptureId:capture.id,nearcastCaptureRevision:capture.geometry.revision});
    track.stop=()=>{if(this.current===capture)void this.stop().catch(failure=>this.onStatus({error:String(failure.message??failure)}));else stop();};
    if(audio){
      try{
        if(!this.displayMediaDevices?.getDisplayMedia)throw new Error('Native display audio requires WebView display capture');
        const displayStream=await this.displayMediaDevices.getDisplayMedia({video:true,audio:true});
        const audioTracks=displayStream.getAudioTracks?.()??[];
        for(const displayTrack of displayStream.getVideoTracks?.()??[])if(displayTrack!==track)displayTrack.stop?.();
        if(audioTracks.length){
          if(typeof stream.addTrack!=='function')throw new Error('Native display audio stream cannot attach an audio track');
          stream.addTrack(audioTracks[0]);capture.audioTracks=[audioTracks[0]];
          for(const extra of audioTracks.slice(1))extra.stop?.();
        }else for(const displayTrack of displayStream.getTracks?.()??[])displayTrack.stop?.();
      }catch(failure){await this.stop();throw failure;}
    }
    void this.pump(capture,video);return stream;
    });
    this.acquisition=acquire.then(()=>{},()=>{});return acquire;
  }
  async pump(capture,constraints){
    try{
      while(this.current===capture&&capture.generation===this.generation){
        const bytes=await this.invoke('nearcast_capture_frame',{captureId:capture.id});
        if(this.current!==capture||capture.generation!==this.generation)return;
        const frame=decodeCaptureFrame(bytes,capture.id),stateKey=[frame.geometry.revision,frame.geometry.inputReady,frame.geometry.disabledReason].join(':');capture.indicator=frame.indicator;capture.nativeCapture=frame.nativeCapture??null;
        const changed=stateKey!==capture.stateKey;if(changed){capture.stateKey=stateKey;capture.geometry=frame.geometry;}
        if(/closed|removed/.test(frame.geometry.disabledReason??''))throw new Error(frame.geometry.disabledReason);
        if(frame.pixels.length){
          const hash=sampledPixelHash(frame.pixels);
          if(capture.sampledPixelHash!==null&&capture.sampledPixelHash!==hash)capture.sampledPixelChanges++;
          capture.sampledPixelHash=hash;capture.lastFrameId=frame.frameId;
          capture.renderer.draw(frame,fitCaptureSize(frame.width,frame.height,constraints));capture.track.requestFrame?.();capture.lastRequestAt=this.now();capture.frames++;
        }else if(capture.frames&&this.now()-capture.lastRequestAt>=250){
          capture.track.requestFrame?.();capture.lastRequestAt=this.now();
        }
        if(changed)this.onGeometryChange(frame.geometry,capture.track);
        this.onStatus({geometry:capture.geometry,frames:capture.frames,fps:capture.frames*1000/Math.max(1,this.now()-capture.startedAt)});
      }
    }catch(failure){
      if(this.current!==capture)return;
      this.onStatus({error:String(failure.message??failure)});try{await this.stop();}catch(cleanup){this.onStatus({error:String(cleanup.message??cleanup)});}finally{capture.track.onended?.();}
    }
  }
  async setInputState(state){
    const capture=this.current;if(!capture)return;
    const ownerId=state.nativeOwnerId??null;
    const green=state.state==='active'&&state.sourceReady&&state.localEnabled&&!state.cleanupPending&&typeof ownerId==='string'&&ownerId.length>0;
    const key=`${capture.id}:${capture.geometry.revision}:${ownerId}:${green}`;if(this.indicatorKey===key)return;this.indicatorKey=key;
    try{await this.invoke('nearcast_capture_indicator',{captureId:capture.id,geometryRevision:capture.geometry.revision,ownerId,sequence:++this.indicatorSequence,active:green});}
    catch(failure){if(this.current===capture&&this.indicatorKey===key){this.indicatorKey=null;this.onStatus({error:String(failure.message??failure)});}}
  }
  diagnostics(){const capture=this.current;if(!capture)return null;const {kind,revision,region,inputReady,disabledReason}=capture.geometry;return{kind,revision,region:{...region},inputReady,disabledReason,output:{width:capture.renderer.canvas.width,height:capture.renderer.canvas.height},frames:capture.frames,lastFrameId:capture.lastFrameId,sampledPixelHash:capture.sampledPixelHash,sampledPixelChanges:capture.sampledPixelChanges,nativeCapture:capture.nativeCapture?{...capture.nativeCapture}:null,indicator:capture.indicator};}
  async stop(){
    this.generation++;this.chooseTarget.cancel?.();const capture=this.current;this.current=null;this.indicatorKey=null;if(!capture)return this.stopBarrier;
    capture.stop();for(const track of capture.audioTracks)track.stop?.();capture.renderer.close();const stopping=this.invoke('nearcast_capture_stop',{captureId:capture.id});this.stopBarrier=stopping.then(()=>{},()=>{});return stopping;
  }
}
