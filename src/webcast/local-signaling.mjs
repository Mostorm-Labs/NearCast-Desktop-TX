// WebSocket-shaped IPC adapter. The native owner resolves the selected DNS-SD
// service and verifies its saved key; JavaScript never chooses an arbitrary URL.
export function localSocketFactory({invoke,listen,device}){
  return ()=>{
    const id=globalThis.crypto.randomUUID();
    const socket={readyState:0,onopen:null,onmessage:null,onerror:null,onclose:null};
    let unlisten,timer,sendTail=Promise.resolve();
    const close=()=>{
      if(socket.readyState===3)return;
      socket.readyState=3;clearTimeout(timer);unlisten?.();
      void invoke('nearcast_local_signal_close',{connectionId:id}).catch(()=>{});
      socket.onclose?.({code:1000});
    };
    const fail=()=>{if(socket.readyState===3)return;socket.onerror?.(new Error('无法连接接收端本地信令服务'));close();};
    socket.close=close;
    socket.send=data=>{if(socket.readyState!==1||typeof data!=='string')throw new Error('Local signaling is not open');
      sendTail=sendTail.then(()=>socket.readyState===1?invoke('nearcast_local_signal_send',{connectionId:id,data}):undefined).catch(fail);};
    timer=setTimeout(fail,7000);
    void (async()=>{
      unlisten=await listen('nearcast://local-signal',event=>{
        const value=event.payload;if(value?.connection_id!==id||socket.readyState===3)return;
        if(value.kind==='open'){clearTimeout(timer);socket.readyState=1;socket.onopen?.();}
        else if(value.kind==='message'&&socket.readyState===1)socket.onmessage?.({data:value.data});
        else if(value.kind==='error')fail();
        else if(value.kind==='close')close();
      });
      if(socket.readyState===3){unlisten();return;}
      await invoke('nearcast_local_signal_open',{connectionId:id,instance:device.instance,deviceId:device.deviceId,runtimeInstanceId:device.signaling.runtimeInstanceId});
      if(socket.readyState===3)await invoke('nearcast_local_signal_close',{connectionId:id});
    })().catch(fail);
    return socket;
  };
}

export function signalingChoice(device,localEnabled){
  if(!localEnabled)return{backend:'cloud'};
  if(!device)throw new Error('局域网投屏请先选择接收端；云端配对可在设置中关闭“局域网投屏”。');
  if(!device.signaling)throw new Error('此接收端尚不支持局域网直连，请更新接收端或关闭“局域网投屏”。');
  if(device.signaling.local!=='ready')throw new Error('接收端本地投屏服务尚未就绪，请稍后重试。');
  return{backend:'local',runtimeInstanceId:device.signaling.runtimeInstanceId};
}
