const GRID=12, CELL=8, INSET=16, SIZE=GRID*CELL;
export const DISPLAY_MARKER=Object.freeze({grid:GRID,cell:CELL,inset:INSET,size:SIZE});

export function markerBits(token,corner) {
  if(!/^[0-9a-f]{16}$/.test(token)||!Number.isInteger(corner)||corner<0||corner>3)throw new Error('Invalid display marker');
  const data=[...Array.from({length:8},(_,i)=>(0xa7>>(7-i))&1),(corner>>1)&1,corner&1];
  for(const char of token)for(let bit=3;bit>=0;bit--)data.push((parseInt(char,16)>>bit)&1);
  while(data.length<100)data.push(data.length%2);
  return Array.from({length:GRID*GRID},(_,i)=>{
    const x=i%GRID,y=Math.floor(i/GRID);
    return x===0||y===0||x===GRID-1||y===GRID-1?(x+y)%2:data[(y-1)*10+x-1];
  });
}
export function markerRect(width,height,corner) {
  return{x:corner%2===0?INSET:width-INSET-SIZE,y:corner<2?INSET:height-INSET-SIZE,width:SIZE,height:SIZE};
}
export function matchesMarker(rgba,token,corner) {
  if(rgba.length!==SIZE*SIZE*4)return false;
  const bits=markerBits(token,corner);
  return bits.every((bit,index)=>{
    // Average cell centers to tolerate browser scaling without accepting
    // arbitrary pictures or dark/light gradients as a valid random marker.
    const cx=(index%GRID)*CELL+CELL/2,cy=Math.floor(index/GRID)*CELL+CELL/2;
    let light=0;
    for(const dy of [-1,0,1])for(const dx of [-1,0,1]){
      const p=((cy+dy)*SIZE+cx+dx)*4;
      const r=rgba[p],g=rgba[p+1],b=rgba[p+2];
      if(Math.max(r,g,b)-Math.min(r,g,b)>65)return false;
      light+=(r+g+b)/3;
    }
    light/=9;
    return bit?light>=190:light<=65;
  });
}

export function matchDisplayFrame(video,displays,context) {
  const width=video.videoWidth,height=video.videoHeight;
  if(!width||!height)return null;
  const matches=[];
  for(const display of displays) {
    const w=display.captureWidth,h=display.captureHeight;
    if(display.rotation!==0||w<320||h<240||Math.abs(width*h-height*w)>2*Math.max(w,h))continue;
    let okay=true;
    for(let corner=0;corner<4;corner++){
      const r=markerRect(w,h,corner);
      context.clearRect(0,0,SIZE,SIZE);
      context.drawImage(video,r.x*width/w,r.y*height/h,SIZE*width/w,SIZE*height/h,0,0,SIZE,SIZE);
      if(!matchesMarker(context.getImageData(0,0,SIZE,SIZE).data,display.token,corner)){okay=false;break;}
    }
    if(okay)matches.push(display);
  }
  if(matches.length!==1)return null;
  return {token:matches[0].token,corners:[0,1,2,3],frameWidth:width,frameHeight:height};
}

export async function calibrateDisplayBinding({stream,sourceId,invoke,signal,document=globalThis.document,
  now=()=>performance.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  const challenge=await invoke('nearcast_display_binding_begin',{sourceId});
  let video;
  try {
    if(signal?.aborted)throw new Error('Screen binding canceled');
    const canvas=document.createElement('canvas');canvas.width=SIZE;canvas.height=SIZE;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)throw new Error('Screen binding pixel reader unavailable');
    context.imageSmoothingEnabled=false;
    video=document.createElement('video');video.muted=true;video.playsInline=true;
    video.srcObject=stream;
    // Do not wait unboundedly for play(): a canceled/muted track may never
    // deliver metadata. Native windows also expire independently of this page.
    void video.play().catch(()=>{});
    const until=now()+Math.min(challenge.timeoutMs??5000,5000);
    while(now()<until) {
      if(signal?.aborted||stream.getVideoTracks()[0]?.readyState!=='live')throw new Error('Screen binding canceled');
      if(video.readyState>=2){
        const observation=matchDisplayFrame(video,challenge.displays,context);
        if(observation) {
          const binding=await invoke('nearcast_display_binding_confirm',{sourceId,challengeId:challenge.challengeId,...observation});
          if(signal?.aborted){await invoke('nearcast_display_binding_release',{sourceId});throw new Error('Screen binding canceled');}
          // Let the captured track advance beyond the marker windows before
          // attaching that unchanged track to the remote peer.
          await sleep(160);
          return binding;
        }
      }
      await sleep(80);
    }
    throw new Error('BROWSER_DISPLAY_BINDING_TIMEOUT: 未能识别完整屏幕，请停止后重新分享整个屏幕');
  } finally {
    video?.pause();if(video)video.srcObject=null;
    await invoke('nearcast_display_binding_cancel',{sourceId,challengeId:challenge.challengeId}).catch(()=>{});
  }
}
