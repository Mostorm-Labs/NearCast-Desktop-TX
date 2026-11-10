import test from 'node:test';
import assert from 'node:assert/strict';
import {DISPLAY_MARKER,markerBits,markerRect,matchesMarker,matchDisplayFrame,calibrateDisplayBinding} from '../src/capture/display-binding.mjs';
function pixels(token,corner){
  const out=new Uint8ClampedArray(96*96*4),bits=markerBits(token,corner);
  for(let y=0;y<96;y++)for(let x=0;x<96;x++){const p=(y*96+x)*4,b=bits[Math.floor(y/8)*12+Math.floor(x/8)]?255:0;out.set([b,b,b,255],p);}
  return out;
}
test('four-corner marker encodes nonce and location; stale or damaged markers cannot match',()=>{
  for(let corner=0;corner<4;corner++){
    const rgba=pixels('0123456789abcdef',corner);
    assert.equal(matchesMarker(rgba,'0123456789abcdef',corner),true);
    assert.equal(matchesMarker(rgba,'1123456789abcdef',corner),false);
    assert.equal(matchesMarker(rgba,'0123456789abcdef',(corner+1)%4),false);
    rgba.fill(127);assert.equal(matchesMarker(rgba,'0123456789abcdef',corner),false);
  }
  assert.deepEqual(markerRect(1920,1080,3),{x:1808,y:968,width:96,height:96});
});
test('frame matcher distinguishes same-size monitors, including scaled video, and requires all four corners',()=>{
  const displays=[{captureWidth:1920,captureHeight:1080,rotation:0,token:'1111111111111111'},{captureWidth:1920,captureHeight:1080,rotation:0,token:'2222222222222222'}];
  let corner;
  const context={clearRect(){},drawImage(_v,x,y){corner=(x>100?1:0)+(y>100?2:0);},getImageData(){return{data:pixels(displays[1].token,corner)};}};
  assert.equal(matchDisplayFrame({videoWidth:1280,videoHeight:720},displays,context).token,displays[1].token);
  context.getImageData=()=>({data:pixels(displays[1].token,0)});
  assert.equal(matchDisplayFrame({videoWidth:1280,videoHeight:720},displays,context),null);
  assert.equal(matchDisplayFrame({videoWidth:1280,videoHeight:800},displays,context),null);
});
test('calibration times out boundedly and removes native windows even on cancellation',async()=>{
  const calls=[];let clock=0;
  const doc={createElement:kind=>kind==='canvas'?{getContext:()=>({})}:{readyState:0,play:async()=>{},pause(){}}};
  const stream={getVideoTracks:()=>[{readyState:'live'}]};
  const invoke=async(command,args)=>{calls.push([command,args]);if(command.endsWith('begin'))return{challengeId:'c',displays:[],timeoutMs:100};};
  await assert.rejects(calibrateDisplayBinding({stream,sourceId:'source',invoke,document:doc,now:()=>clock,sleep:async ms=>clock+=ms}),/TIMEOUT/);
  assert.equal(calls.at(-1)[0],'nearcast_display_binding_cancel');
  const controller=new AbortController();controller.abort();
  await assert.rejects(calibrateDisplayBinding({stream,sourceId:'source',invoke,document:doc,signal:controller.signal}),/canceled/);
  assert.equal(calls.at(-1)[0],'nearcast_display_binding_cancel');
});
