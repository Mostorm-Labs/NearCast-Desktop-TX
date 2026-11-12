export function showInputConsent({signal,timeoutMs=8000},{document=globalThis.document,showWindow=async()=>{}}={}){
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='update-dialog';dialog.setAttribute('aria-label','反控请求');
    const title=document.createElement('h2');title.textContent='接收端请求控制此桌面';
    const message=document.createElement('p');message.textContent='是否允许当前接收端操作你正在分享的桌面？8 秒未选择将自动拒绝。';
    const remaining=document.createElement('p');remaining.setAttribute('role','status');
    const actions=document.createElement('div');actions.className='update-actions';
    const deny=document.createElement('button'),accept=document.createElement('button');
    deny.type=accept.type='button';deny.className='button secondary';accept.className='button primary';deny.textContent='拒绝';accept.textContent='允许反控';
    actions.append(deny,accept);dialog.append(title,message,remaining,actions);document.body.append(dialog);
    let done=false;const deadline=Date.now()+timeoutMs;
    const update=()=>{remaining.textContent=`${Math.max(0,Math.ceil((deadline-Date.now())/1000))} 秒后自动拒绝`;};
    const timer=setInterval(update,200);
    const finish=value=>{if(done)return;done=true;clearInterval(timer);signal?.removeEventListener('abort',cancel);dialog.close();dialog.remove();resolve(value);};
    const cancel=()=>finish(false);
    deny.addEventListener('click',()=>finish(false));accept.addEventListener('click',()=>finish(true));dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
    if(signal?.aborted){finish(false);return;}
    signal?.addEventListener('abort',cancel,{once:true});update();dialog.showModal();deny.focus();
    void Promise.resolve().then(showWindow).catch(()=>{});
  });
}
