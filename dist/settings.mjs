import {DEFAULT_VIDEO_QUALITY,normalizeVideoQuality,VIDEO_RESOLUTIONS,VIDEO_BITRATES_KBPS} from './webcast/video-quality.mjs';
import {normalizeOutputPolicy,DEFAULT_OUTPUT_POLICY} from './touchback/output-policy.mjs';
import {i18n,normalizeLanguage} from './i18n.mjs';
import {normalizeTheme} from './theme.mjs';
export function loadPreferences(storage=globalThis.localStorage){
  const defaults={video:{...DEFAULT_VIDEO_QUALITY},language:'system',theme:'system',localSignaling:true,systemAudio:true,inputEnabled:false,policy:{...DEFAULT_OUTPUT_POLICY}};
  try{
    const value=JSON.parse(storage.getItem('nearhub-cast-settings-v1'))??{};
    const video=normalizeVideoQuality({...defaults.video,...value.video});
    if(!VIDEO_RESOLUTIONS.includes(video.resolution)||!VIDEO_BITRATES_KBPS.includes(video.bitrateKbps))throw new Error('Invalid saved quality');
    return{video,language:normalizeLanguage(value.language),theme:normalizeTheme(value.theme),localSignaling:value.localSignaling!==false,systemAudio:value.systemAudio!==false,inputEnabled:value.inputEnabled===true,policy:normalizeOutputPolicy(value.policy??defaults.policy)};
  }catch{return defaults;}
}
export function savePreferences(value,storage=globalThis.localStorage){
  storage.setItem('nearhub-cast-settings-v1',JSON.stringify({video:normalizeVideoQuality(value.video),language:normalizeLanguage(value.language),theme:normalizeTheme(value.theme),localSignaling:value.localSignaling!==false,systemAudio:value.systemAudio===true,inputEnabled:value.inputEnabled===true,policy:normalizeOutputPolicy(value.policy)}));
}
// A page in the same WebView keeps MediaStream and DataChannel owners alive.
export function mountSettings({document,isConnected,isOnboarding=()=>false,onSelectTab=()=>{}}){
  const view=document.querySelector('#settings-view'),open=document.querySelector('#settings-open');
  const entries=[...new Set([open,...document.querySelectorAll('[data-settings-open]')])];
  const title=document.querySelector('#settings-title'),advanced=[...document.querySelectorAll('[data-settings-advanced]')];
  let active=false,opener=open,advancedVisible=false,advancedClicks=0;
  // The reveal gesture is local to this launch; only parameter values persist.
  for(const section of advanced)section.hidden=true;
  title.addEventListener('click',()=>{
    if(!active||++advancedClicks<8)return;
    advancedClicks=0;advancedVisible=!advancedVisible;
    for(const section of advanced)section.hidden=!advancedVisible;
  });
  const render=()=>{
    const onboarding=isOnboarding();
    view.hidden=!active||onboarding;document.querySelector('#code-view').hidden=onboarding||active||isConnected();document.querySelector('#casting-view').hidden=onboarding||active||!isConnected();
    document.documentElement.dataset.view=onboarding?'onboarding':active?'settings':isConnected()?'casting':'home';
    for(const entry of entries)entry.setAttribute('aria-expanded',String(active));
  };
  for(const entry of entries)entry.addEventListener('click',()=>{opener=entry;active=true;render();document.querySelector('#settings-title').focus();onSelectTab(view.dataset.tab);});
  document.querySelector('#settings-close').addEventListener('click',()=>{active=false;advancedClicks=0;render();const target=opener.getClientRects().length?opener:entries.find(entry=>entry.getClientRects().length);target?.focus();});
  const tabs=[...document.querySelectorAll('[data-settings-tab]')];
  const selectTab=button=>{
    for(const tab of tabs){
      const selected=tab===button;
      tab.setAttribute('aria-pressed',String(selected));tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
      document.getElementById('settings-'+tab.dataset.settingsTab).hidden=!selected;
    }
    view.dataset.tab=button.dataset.settingsTab;
    document.querySelector('.settings-scroll').scrollTop=0;
    if(active)onSelectTab(button.dataset.settingsTab);
  };
  for(const button of tabs){
    button.addEventListener('click',()=>selectTab(button));
    button.addEventListener('keydown',event=>{
      const index=tabs.indexOf(button);
      const next=event.key==='ArrowRight'?tabs[(index+1)%tabs.length]:event.key==='ArrowLeft'?tabs[(index+tabs.length-1)%tabs.length]:event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):null;
      if(next){event.preventDefault();selectTab(next);next.focus();}
    });
  }
  selectTab(tabs.find(tab=>tab.getAttribute('aria-selected')==='true')??tabs[0]);
  return{render,get active(){return active;}};
}
export function mountFeedback({document,invoke}){
  const form=document.querySelector('#feedback-form'),button=document.querySelector('#feedback-submit'),status=document.querySelector('#feedback-status');
  let busy=false;
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!form.reportValidity())return;
    busy=true;button.disabled=true;i18n.text(status,'feedback.sending');
    try{
      const result=await invoke('nearcast_feedback_submit',{email:document.querySelector('#feedback-email').value.trim(),message:document.querySelector('#feedback-message').value.trim(),consent:document.querySelector('#feedback-consent').checked});
      if(result?.status!=='submitted')throw new Error(i18n.t('feedback.unconfirmed'));
      i18n.text(status,'feedback.sent',{id:result.id});document.querySelector('#feedback-consent').checked=false;
    }catch(error){i18n.text(status,'feedback.failed',{error:i18n.error(error)});}
    finally{busy=false;button.disabled=false;}
  });
}
