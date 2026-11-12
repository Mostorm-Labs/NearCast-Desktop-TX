// Product consent has its own deadline. Never leave an AXTP RPC waiting on UI.
export function requestInputConsent(prompt,{signal,timeoutMs=8000,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  return new Promise(resolve=>{
    let settled=false,timer;
    const finish=status=>{if(settled)return;settled=true;clearTimer(timer);signal?.removeEventListener('abort',cancel);resolve(status);};
    const cancel=()=>finish('canceled');
    if(signal?.aborted){finish('canceled');return;}
    signal?.addEventListener('abort',cancel,{once:true});
    timer=setTimer(()=>finish('timeout'),timeoutMs);timer?.unref?.();
    Promise.resolve().then(()=>prompt({signal,timeoutMs})).then(accepted=>finish(accepted===true?'accepted':'denied'),()=>finish('denied'));
  });
}
