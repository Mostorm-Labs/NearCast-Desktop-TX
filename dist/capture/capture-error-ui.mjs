import {screenCaptureError} from '../platform-capabilities.mjs';
import {i18n} from '../i18n.mjs';

export function mountCaptureError({document,permissions,platform,onSettingsOpened=()=>{},onPermissionsChanged=()=>{}}){
  const container=document.querySelector('#cast-error-container');
  const message=document.querySelector('#cast-error');
  const settings=document.querySelector('#cast-permission-settings');
  let current=null,revision=0,opening=false,settingsError=null;
  const hasAction=()=>current?.permission==='screenRecording'&&platform()?.os==='macos';
  const render=()=>{
    container.hidden=message.hidden=!current;
    message.textContent=!current?'':settingsError?i18n.t('permission.openFailed',{error:i18n.error(settingsError)}):i18n.error(current);
    settings.hidden=!hasAction();settings.disabled=opening;
    i18n.text(settings,opening?'permission.openingSettings':'permission.openSettings');
  };
  const show=error=>{revision++;current=error;settingsError=null;render();};
  const permissionsChanged=()=>{
    if(!hasAction())return;
    const enabled=permissions.rows().find(row=>row.id==='screenRecording')?.enabled;
    if(enabled===true)show(null);
    else if(enabled!==false)show(screenCaptureError(new Error('Permission denied'),platform()));
  };
  const report=async error=>{
    const request=++revision;
    current=screenCaptureError(error,platform());settingsError=null;render();
    if(platform()?.os!=='macos'||current.code!=='screen_capture_not_allowed')return;
    // Query after picker failure, keeping the original share-button gesture
    // available to getDisplayMedia. Unknown/query failure is not denial.
    try{await permissions.refresh();}catch{/* The model clears stale grants. */}
    onPermissionsChanged();
    if(request!==revision)return;
    current=screenCaptureError(error,platform(),{screenRecording:permissions.snapshot.screenRecording});render();
  };
  settings.addEventListener('click',async()=>{
    if(opening||!hasAction())return;
    const target=current;opening=true;settingsError=null;render();onSettingsOpened();
    try{await permissions.openSettings('screenRecording');onPermissionsChanged();permissionsChanged();}
    catch(error){permissionsChanged();if(current===target)settingsError=error;}
    finally{opening=false;render();}
  });
  i18n.subscribe(render);render();
  return{show,report,permissionsChanged};
}
