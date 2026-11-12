import {DEFAULT_VIDEO_QUALITY,normalizeVideoQuality,VIDEO_RESOLUTIONS,VIDEO_BITRATES_KBPS} from './webcast/video-quality.mjs';
import {normalizeOutputPolicy,DEFAULT_OUTPUT_POLICY} from './touchback/output-policy.mjs';
export function loadPreferences(storage=globalThis.localStorage){
  const defaults={video:{...DEFAULT_VIDEO_QUALITY},systemAudio:true,inputEnabled:false,policy:{...DEFAULT_OUTPUT_POLICY}};
  try{
    const value=JSON.parse(storage.getItem('nearhub-cast-settings-v1'))??{};
    const video=normalizeVideoQuality({...defaults.video,...value.video});
    if(!VIDEO_RESOLUTIONS.includes(video.resolution)||!VIDEO_BITRATES_KBPS.includes(video.bitrateKbps))throw new Error('Invalid saved quality');
    return{video,systemAudio:value.systemAudio!==false,inputEnabled:value.inputEnabled===true,policy:normalizeOutputPolicy(value.policy??defaults.policy)};
  }catch{return defaults;}
}
export function savePreferences(value,storage=globalThis.localStorage){
  storage.setItem('nearhub-cast-settings-v1',JSON.stringify({video:normalizeVideoQuality(value.video),systemAudio:value.systemAudio===true,inputEnabled:value.inputEnabled===true,policy:normalizeOutputPolicy(value.policy)}));
}
// A page in the same WebView keeps MediaStream and DataChannel owners alive.
export function mountSettings({document,isConnected}){
  const view=document.querySelector('#settings-view'),open=document.querySelector('#settings-open');
  let active=false;
  const render=()=>{
    view.hidden=!active;document.querySelector('#code-view').hidden=active||isConnected();document.querySelector('#casting-view').hidden=active||!isConnected();
    open.setAttribute('aria-expanded',String(active));
  };
  open.addEventListener('click',()=>{active=true;render();document.querySelector('#settings-title').focus();});
  document.querySelector('#settings-close').addEventListener('click',()=>{active=false;render();open.focus();});
  for(const button of document.querySelectorAll('[data-settings-tab]'))button.addEventListener('click',()=>{
    for(const tab of document.querySelectorAll('[data-settings-tab]')){const selected=tab===button;tab.setAttribute('aria-pressed',String(selected));document.getElementById('settings-'+tab.dataset.settingsTab).hidden=!selected;}
  });
  return{render,get active(){return active;}};
}
export function mountFeedback({document,invoke}){
  const form=document.querySelector('#feedback-form'),button=document.querySelector('#feedback-submit'),status=document.querySelector('#feedback-status');
  let busy=false;
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!form.reportValidity())return;
    busy=true;button.disabled=true;status.textContent='正在打包诊断并发送…';
    try{
      const result=await invoke('nearcast_feedback_submit',{email:document.querySelector('#feedback-email').value.trim(),message:document.querySelector('#feedback-message').value.trim(),consent:document.querySelector('#feedback-consent').checked});
      if(result?.status!=='submitted')throw new Error('反馈服务没有确认提交，请稍后重试。');
      status.textContent='反馈已发送，编号：'+result.id;document.querySelector('#feedback-consent').checked=false;
    }catch(error){status.textContent='发送失败：'+String(error?.message??error);}
    finally{busy=false;button.disabled=false;}
  });
}
