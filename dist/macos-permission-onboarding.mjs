import {i18n} from './i18n.mjs';

const COMPLETION_KEY='nearhub-cast-macos-permissions-onboarding-v1';

export class MacOsPermissionOnboarding {
  constructor({permissions,storage=globalThis.localStorage,onChange=()=>{},onComplete=()=>{}}={}){
    this.permissions=permissions;
    this.storage=storage;
    this.onChange=onChange;
    this.onComplete=onComplete;
    this.active=false;
    this.starting=false;
    this.checking=false;
    this.pendingPermission=null;
    this.error=null;
    this.screenCaptureRequired=false;
  }

  snapshot(){
    const rows=this.permissions.rows().map(row=>({...row,required:row.id==='localNetwork'||row.id==='screenRecording'&&this.screenCaptureRequired}));
    return{active:this.active,checking:this.checking,pendingPermission:this.pendingPermission,error:this.error,rows,screenCaptureRequired:this.screenCaptureRequired,
      requiredReady:!this.checking&&!this.pendingPermission&&rows.filter(row=>row.required).every(row=>row.enabled===true)};
  }

  async start({os,desktop=false,screenCapturePermission='on_selection'}={}){
    this.screenCaptureRequired=screenCapturePermission==='required';
    if(!desktop||os!=='macos'){
      this.active=false;
      this.onChange(this.snapshot());
      return false;
    }
    let completed=false;
    try{completed=this.storage?.getItem(COMPLETION_KEY)==='completed';}catch{/* Blocked storage cannot block first-run setup. */}
    this.active=!completed;
    this.starting=true;
    this.onChange(this.snapshot());
    await this.refresh();
    this.starting=false;
    // Completion only skips the guide while required capabilities remain
    // ready. A first-run deferral during this query applies to this run.
    if(completed)this.active=!this.snapshot().requiredReady;
    this.onChange(this.snapshot());
    return this.active;
  }

  async refresh(){
    if(!this.active&&!this.starting)return false;
    this.checking=true;this.error=null;this.onChange(this.snapshot());
    try{await this.permissions.refresh();return true;}
    catch(error){this.error=String(error?.message??error);return false;}
    finally{this.checking=false;this.onChange(this.snapshot());}
  }

  async grant(permission){
    if(!this.active||this.pendingPermission||!this.permissions.rows().some(row=>row.id===permission))return false;
    this.pendingPermission=permission;this.error=null;this.onChange(this.snapshot());
    try{
      // A successful settings jump is not authorization. The model reads the
      // system again, and focus/visibility refresh handles later user changes.
      await this.permissions.openSettings(permission);
      return true;
    }catch(error){this.error=String(error?.message??error);return false;}
    finally{this.pendingPermission=null;this.onChange(this.snapshot());}
  }

  finish({defer=false}={}){
    if(!this.active||this.pendingPermission||!defer&&!this.snapshot().requiredReady)return false;
    try{this.storage?.setItem(COMPLETION_KEY,'completed');}catch{/* Keep this session usable when persistence is unavailable. */}
    this.active=false;
    this.onChange(this.snapshot());
    this.onComplete();
    return true;
  }
}

export function mountMacOsPermissionOnboarding({document,permissions,storage,onChange=()=>{},onComplete=()=>{}}){
  const view=document.querySelector('#permission-onboarding');
  const continueButton=document.querySelector('#onboarding-continue');
  const deferButton=document.querySelector('#onboarding-not-now');
  const refreshButton=document.querySelector('#onboarding-refresh');
  const errorView=document.querySelector('#onboarding-error');
  const help=document.querySelector('#onboarding-help');
  let wasActive=false;
  const render=state=>{
    view.hidden=!state.active;
    view.setAttribute('aria-busy',String(state.checking));
    for(const row of state.rows){
      const item=view.querySelector(`[data-onboarding-row="${row.id}"]`);
      const button=item.querySelector('[data-onboarding-grant]');
      const label=button.querySelector('span:last-child');
      const requirement=item.querySelector('[data-onboarding-requirement]');
      requirement.classList.toggle('optional',!row.required);i18n.text(requirement,row.required?'onboarding.required':'onboarding.optional');
      if(row.id==='screenRecording')i18n.text(item.querySelector('.onboarding-permission-text p'),state.screenCaptureRequired?'permission.screenHelp':'permission.screenAudioHelp');
      const granted=row.enabled===true;
      button.dataset.state=granted?(row.id==='localNetwork'?'available':'granted'):row.enabled===false?'not_granted':'unknown';
      button.disabled=granted||state.checking||Boolean(state.pendingPermission);
      button.classList.toggle('is-granted',granted);
      button.querySelector('.onboarding-status-icon').hidden=!granted;
      const labelKey=state.pendingPermission===row.id?'onboarding.opening':granted?(row.id==='localNetwork'?'onboarding.available':'onboarding.granted'):'onboarding.grant';
      i18n.text(label,labelKey);
      button.setAttribute('aria-label',i18n.t('permission.'+row.id)+': '+i18n.t(labelKey));
    }
    continueButton.disabled=!state.requiredReady;
    deferButton.disabled=Boolean(state.pendingPermission);
    refreshButton.disabled=state.checking||Boolean(state.pendingPermission);
    i18n.text(help,state.checking?'onboarding.checking':state.requiredReady?'onboarding.ready':'onboarding.help');
    errorView.hidden=!state.error;
    errorView.textContent=state.error?i18n.t('onboarding.failed',{error:i18n.error(state.error)}):'';
    onChange(state);
    if(state.active&&!wasActive)document.querySelector('#onboarding-title').focus();
    wasActive=state.active;
  };
  const onboarding=new MacOsPermissionOnboarding({permissions,storage,onChange:render,onComplete});
  for(const button of view.querySelectorAll('[data-onboarding-grant]'))button.addEventListener('click',()=>{void onboarding.grant(button.dataset.onboardingGrant);});
  refreshButton.addEventListener('click',()=>{void onboarding.refresh();});
  continueButton.addEventListener('click',()=>onboarding.finish());
  deferButton.addEventListener('click',()=>onboarding.finish({defer:true}));
  i18n.subscribe(()=>render(onboarding.snapshot()));
  return onboarding;
}
