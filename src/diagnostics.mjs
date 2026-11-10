const statuses=new Set(['idle','connecting','joined','connected','sharing','error','stopped']);
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
  return {event:'media',status:statuses.has(snapshot.status)?snapshot.status:'error',metrics};
}
export function createDiagnostics({invoke,snapshot,setTimer=(fn,ms)=>setInterval(fn,ms),clearTimer=id=>clearInterval(id)}={}) {
  let pending=false,stopped=false,lastStatus;
  const send=async sample=>{
    if(pending||stopped)return;
    pending=true;
    try{await invoke('nearcast_diagnostics_record',{sample});}catch{/* Logging cannot disrupt media. */}
    finally{pending=false;}
  };
  const timer=setTimer(()=>void send(diagnosticSample(snapshot())),30_000);
  return {
    status(status){if(lastStatus===status)return;lastStatus=status;void send({event:'session',status:statuses.has(status)?status:'error',metrics:{}});},
    error(){void send({event:'frontend_error',status:'error',metrics:{}});},
    async export(){return invoke('nearcast_diagnostics_export');},
    stop(){stopped=true;clearTimer(timer);},
  };
}
