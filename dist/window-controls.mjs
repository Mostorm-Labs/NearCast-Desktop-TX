// Move through ordinary set_position calls instead of Windows' native modal
// move loop. Keep only the newest position while an IPC call is in flight.
export function mountWindowControls({document,invoke,beforeClose=async()=>{}}){
  const bar=document.querySelector('#window-titlebar'),drag=document.querySelector('#window-drag');
  const min=document.querySelector('#window-minimize'),max=document.querySelector('#window-maximize'),close=document.querySelector('#window-close'),error=document.querySelector('#window-error');
  bar.hidden=false;document.documentElement.classList.add('custom-window');
  let state=null,gesture=null,latest=null,moving=false,closing=false,pending=false;
  const call=async action=>{
    const result=await invoke('nearcast_window_action',{action});
    if(result&&typeof result.maximized==='boolean'){
      state=result;max.setAttribute('aria-label',state.maximized?'还原窗口':'最大化窗口');max.title=max.getAttribute('aria-label');
      max.dataset.maximized=String(state.maximized);
    }
    return result;
  };
  const report=e=>{error.textContent='窗口操作失败：'+String(e?.message??e);error.hidden=false;};
  const refresh=()=>call({kind:'state'}).catch(report);
  const pump=async()=>{
    if(moving)return;moving=true;
    try{while(latest){const position=latest;latest=null;await call({kind:'move',...position});}}
    catch(e){latest=null;report(e);}finally{moving=false;}
  };
  min.addEventListener('click',()=>{void call({kind:'minimize'}).catch(report);});
  const toggle=async()=>{if(pending||closing)return;pending=true;try{gesture=null;latest=null;await call({kind:'toggleMaximize'});}catch(e){report(e);}finally{pending=false;}};
  max.addEventListener('click',()=>void toggle());drag.addEventListener('dblclick',()=>void toggle());
  close.addEventListener('click',async()=>{
    if(closing)return;closing=true;close.disabled=true;
    try{await beforeClose();await call({kind:'close'});}
    catch(e){closing=false;close.disabled=false;report(e);}
  });
  drag.addEventListener('pointerdown',async event=>{
    if(event.button!==0||gesture||closing)return;
    event.preventDefault();error.hidden=true;
    const current={id:event.pointerId,x:event.screenX,y:event.screenY,base:null,last:null};gesture=current;
    drag.setPointerCapture(event.pointerId);
    try{
      const base=await call({kind:'state'});
      if(gesture!==current||!Number.isFinite(base?.x)||!Number.isFinite(base?.y)||base.maximized)return;
      current.base=base;if(current.last)move(current,current.last);
    }catch(e){gesture=null;report(e);}
  });
  function move(g,e){
    if(!g.base||g.base.maximized)return;
    const scale=g.base.scaleFactor||1;
    latest={x:Math.round(g.base.x+(e.screenX-g.x)*scale),y:Math.round(g.base.y+(e.screenY-g.y)*scale)};
    void pump();
  }
  drag.addEventListener('pointermove',event=>{if(gesture?.id===event.pointerId){gesture.last={screenX:event.screenX,screenY:event.screenY};move(gesture,event);}});
  const end=event=>{if(gesture?.id===event.pointerId){gesture=null;if(drag.hasPointerCapture(event.pointerId))drag.releasePointerCapture(event.pointerId);}};
  for(const name of ['pointerup','pointercancel','lostpointercapture'])drag.addEventListener(name,end);
  document.defaultView.addEventListener('resize',refresh);document.defaultView.addEventListener('focus',refresh);
  void refresh();
}
