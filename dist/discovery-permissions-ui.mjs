import {i18n} from './i18n.mjs';

export function mountDiscoveryPermissions({document,permissions,platform,onSettingsOpened=()=>{},onPermissionsChanged=()=>{}}){
  const element=document.querySelector('#discovery-permission-notice');
  const message=document.querySelector('#discovery-permission-message');
  const button=document.querySelector('#discovery-permission-settings');
  let scanned=false,scanning=false,count=0,opening=false,error=null;
  const render=()=>{
    const denied=permissions.snapshot.localNetwork==='not_granted';
    element.hidden=platform()?.os!=='macos'||!scanned||scanning||(!denied&&count>0);
    i18n.text(message,error?'permission.openFailed':denied?'discovery.networkDenied':'discovery.networkHelp',{error:i18n.error(error)});
    i18n.text(button,opening?'permission.openingSettings':'permission.openSettings');button.disabled=opening;
  };
  button.addEventListener('click',async()=>{
    if(opening||element.hidden)return;
    opening=true;error=null;render();onSettingsOpened();
    try{await permissions.openSettings('localNetwork');onPermissionsChanged();}
    catch(failure){error=failure;}
    finally{opening=false;render();}
  });
  i18n.subscribe(render);render();
  return{element,
    scanStarted(){scanned=true;scanning=true;error=null;render();},
    scanFinished(){scanning=false;render();},
    devicesChanged(devices){count=devices.filter(device=>device.protocol==='webcast').length;render();},
    permissionsChanged:render,
  };
}
