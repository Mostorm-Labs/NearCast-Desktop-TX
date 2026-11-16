const statuses=new Set(['idle','connecting','joined','connected','sharing','error','stopped']);
export function videoSample(snapshot={}){
  const video=snapshot.media?.video,capture=snapshot.capture,window=snapshot.window??{};
  if(!video&&!capture)return undefined;
  const result={};
  for(const key of ['frameWidth','frameHeight','sourceWidth','sourceHeight','sourceFrames','sourceFramesPerSecond','sourceIntervalFps',
    'intervalMs','encodedIntervalFps','sentIntervalFps','encodeMsPerFrame','sendKbps','bytesSent','targetBitrate',
    'availableOutgoingBitrate','roundTripTimeMs','fractionLost','retransmittedPacketsSent','nackCount','pliCount',
    'totalEncodeTime','qualityCpuSeconds','qualityBandwidthSeconds','qualityNoneSeconds','qualityOtherSeconds']){
    const value=video?.[key];if(Number.isFinite(value)&&value>=0&&value<=1e15)result[key]=value;
  }
  if(Number.isSafeInteger(video?.packetsLost))result.packetsLost=video.packetsLost;
  for(const [key,allowed] of Object.entries({qualityLimitationReason:['none','cpu','bandwidth','other'],codec:['h264','vp8','vp9','av1','h265','unknown']}))
    if(allowed.includes(video?.[key]))result[key]=video[key];
  if(typeof video?.powerEfficientEncoder==='boolean')result.powerEfficientEncoder=video.powerEfficientEncoder;
  const settings=capture?.output??{};
  for(const [key,value] of Object.entries({captureWidth:settings.width,captureHeight:settings.height,captureFrameRate:settings.frameRate,windowSampledAt:window.sampledAt}))
    if(Number.isFinite(value)&&value>=0&&value<=1e15)result[key]=value;
  if(['monitor','window','browser','unknown'].includes(capture?.kind))result.captureSurface=capture.kind;
  if(['live','ended'].includes(capture?.trackState))result.captureTrackState=capture.trackState;
  if(typeof capture?.muted==='boolean')result.captureMuted=capture.muted;
  if(['visible','hidden'].includes(window.pageVisibility))result.pageVisibility=window.pageVisibility;
  for(const [key,value] of Object.entries({windowMinimized:window.minimized,windowVisible:window.visible}))if(typeof value==='boolean')result[key]=value;
  return result;
}
export function scrollSample(input={}){
  const scroll=input.scroll;if(!scroll||!(scroll.streams>0))return undefined;
  const result={};
  for(const key of ['scopeStartedAt','streams','touchReceived','touchSubmitted','wheelBridgeMs','wheelNativeMs','wheelMaxBridgeMs','wheelMaxNativeMs'])
    if(Number.isFinite(scroll[key])&&scroll[key]>=0)result[key]=scroll[key];
  const bucket=value=>Object.fromEntries(['samples','positiveX','negativeX','positiveY','negativeY'].filter(k=>Number.isSafeInteger(value?.[k])&&value[k]>=0).map(k=>[k,value[k]]));
  for(const unit of ['detent120','regionQ16_16'])result[unit]={received:bucket(scroll[unit]?.received),submitted:bucket(scroll[unit]?.submitted)};
  const native=input.nativeInput?.nativeExecution?.wheelSubmitted;
  if(native)result.nativeWheel=Object.fromEntries(['events','positiveX','negativeX','positiveY','negativeY'].filter(k=>Number.isSafeInteger(native[k])&&native[k]>=0).map(k=>[k,native[k]]));
  return result;
}
// Whitelist counters before crossing IPC: no pairing code, SDP, ICE, device
// address, frame pixels or raw exception text enters persistent diagnostics.
export function diagnosticSample(snapshot={}) {
  const input=snapshot.input??{},video=snapshot.media?.video??{},audio=snapshot.capture?.audio??{};
  const metrics={};
  for(const [key,value] of Object.entries({
    framesEncoded:video.framesEncoded,framesSent:video.framesSent,framesPerSecond:video.framesPerSecond,
    inputReceived:input.receivedSamples,inputSubmitted:input.submittedSamples,inputFailed:input.failedSamples,
    audioFrames:audio.receivedFrames,
  })) if(Number.isFinite(value)&&value>=0)metrics[key]=value;
  const scroll=scrollSample(input);
  const videoDetails=videoSample(snapshot);
  return {event:'media',status:statuses.has(snapshot.status)?snapshot.status:'error',metrics,...(scroll?{scroll}: {}),...(videoDetails?{video:videoDetails}:{})};
}
export function createDiagnostics({invoke,snapshot,setTimer=(fn,ms)=>setInterval(fn,ms),clearTimer=id=>clearInterval(id)}={}) {
  let pending=false,stopped=false,lastStatus,lastScroll='',lastMediaAt=0;
  const send=async sample=>{
    if(pending||stopped)return;
    pending=true;
    try{await invoke('nearcast_diagnostics_record',{sample});}catch{/* Logging cannot disrupt media. */}
    finally{pending=false;}
  };
  const timer=setTimer(()=>void send(diagnosticSample(snapshot())),30_000);
  return {
    status(status){if(lastStatus===status)return;lastStatus=status;void send({...diagnosticSample(snapshot()),event:'session',status:statuses.has(status)?status:'error'});},
    scroll(){const sample=diagnosticSample(snapshot()),key=JSON.stringify(sample.scroll);if(!sample.scroll||key===lastScroll||pending||stopped)return;lastScroll=key;void send(sample);},
    media(){const value=snapshot(),at=value.media?.updatedAt;if(value.status!=='sharing'||!at||at-lastMediaAt<5000||pending||stopped)return;lastMediaAt=at;void send(diagnosticSample(value));},
    error(){void send({event:'frontend_error',status:'error',metrics:{}});},
    async export(){await send(diagnosticSample(snapshot()));return invoke('nearcast_diagnostics_export');},
    stop(){stopped=true;clearTimer(timer);},
  };
}
