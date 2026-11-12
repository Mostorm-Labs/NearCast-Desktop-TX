// Serialize visibility changes: a late minimize must never win over capture ended.
export function createSharingWindow({invoke,onError=()=>{}}){
  let tail=Promise.resolve(),minimizedForShare=false,shuttingDown=false;
  const enqueue=kind=>{
    const result=tail.then(()=>invoke('nearcast_window_action',{action:{kind}}));
    tail=result.catch(error=>{onError(error);});return tail;
  };
  return{
    sharing(stream){
      if(shuttingDown)return tail;
      if(stream){
        if(minimizedForShare)return tail;
        minimizedForShare=true;return enqueue('minimize');
      }
      if(!minimizedForShare)return tail;
      minimizedForShare=false;return enqueue('show');
    },
    // Closing/updating must not bring a stopped share's window back to front.
    shutdown(){shuttingDown=true;minimizedForShare=false;return tail;},
    resume(){shuttingDown=false;},
  };
}
