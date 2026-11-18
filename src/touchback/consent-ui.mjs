import {i18n} from '../i18n.mjs';
export function showInputConsent({signal,timeoutMs=8000},{document=globalThis.document,showWindow=async()=>{}}={}){
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='update-dialog';dialog.setAttribute('aria-label',i18n.t('consent.title'));
    const title=document.createElement('h2');i18n.text(title,'consent.title');
    const message=document.createElement('p');i18n.text(message,'consent.message');
    const remaining=document.createElement('p');remaining.setAttribute('role','status');
    const actions=document.createElement('div');actions.className='update-actions';
    const deny=document.createElement('button'),accept=document.createElement('button');
    deny.type=accept.type='button';deny.className='button secondary';accept.className='button primary';i18n.text(deny,'consent.deny');i18n.text(accept,'consent.allow');
    actions.append(deny,accept);dialog.append(title,message,remaining,actions);document.body.append(dialog);
    let done=false;const deadline=Date.now()+timeoutMs;
    const update=()=>{i18n.text(remaining,'consent.remaining',{seconds:Math.max(0,Math.ceil((deadline-Date.now())/1000))});};
    const timer=setInterval(update,200);
    const finish=value=>{if(done)return;done=true;clearInterval(timer);signal?.removeEventListener('abort',cancel);dialog.close();dialog.remove();resolve(value);};
    const cancel=()=>finish(false);
    deny.addEventListener('click',()=>finish(false));accept.addEventListener('click',()=>finish(true));dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
    if(signal?.aborted){finish(false);return;}
    signal?.addEventListener('abort',cancel,{once:true});update();dialog.showModal();deny.focus();
    void Promise.resolve().then(showWindow).catch(()=>{});
  });
}
