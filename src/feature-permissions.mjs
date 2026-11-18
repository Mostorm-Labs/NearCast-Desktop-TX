import {i18n} from './i18n.mjs';

const PERMISSION={audio:'screenRecording',input:'accessibility'};
export class FeaturePermissionGate{
  constructor({permissions,platform,onChange=()=>{},onChecked=()=>{}}){
    Object.assign(this,{permissions,platform,onChange,onChecked});
    this.features=new Map(Object.keys(PERMISSION).map(feature=>[feature,{revision:0,checking:false,notice:null}]));
  }
  entry(feature){const state=this.features.get(feature);if(!state)throw new RangeError('Unknown permission feature');return state;}
  state(feature){const {checking,notice}=this.entry(feature);return{checking,notice,permission:PERMISSION[feature]};}
  cancel(feature){const state=this.entry(feature);state.revision++;state.checking=false;state.notice=null;this.onChange();}
  require(feature,notice='required'){this.cancel(feature);this.entry(feature).notice=notice;this.onChange();}
  async check(feature){
    const state=this.entry(feature),revision=++state.revision;
    if(this.platform()?.os!=='macos'){state.notice=null;this.onChange();return true;}
    state.checking=true;state.notice=null;this.onChange();
    try{await this.permissions.refresh();}catch{/* Unknown cannot enable the feature. */}
    if(revision!==state.revision)return false;
    const enabled=this.permissions.rows().find(row=>row.id===PERMISSION[feature])?.enabled;
    state.checking=false;state.notice=enabled===true?null:enabled===false?'required':'unknown';
    this.onChecked();this.onChange();return enabled===true;
  }
  permissionsChanged(){
    for(const [feature,state]of this.features){
      if(!state.notice)continue;
      const enabled=this.permissions.rows().find(row=>row.id===PERMISSION[feature])?.enabled;
      state.notice=enabled===true?null:enabled===false?'required':'unknown';
    }
    this.onChange();
  }
}

export function mountFeaturePermissions({document,permissions,platform,onSettingsOpened=()=>{},onPermissionsChanged=()=>{},onChange=()=>{}}){
  const notices=[...document.querySelectorAll('[data-feature-permission]')];
  const errors=new Map();let opening=null;
  const render=()=>{
    for(const element of notices){
      const feature=element.dataset.featurePermission,state=gate.state(feature);
      if(state.checking||!state.notice)errors.delete(feature);
      element.hidden=!state.notice;
      const name=i18n.t('permission.'+state.permission);
      i18n.text(element.querySelector('p'),errors.has(feature)?'permission.openFailed':state.notice==='required'?`feature.${feature}Required`:'feature.permissionUnknown',{name,error:i18n.error(errors.get(feature))});
      const button=element.querySelector('button');button.disabled=opening!==null;
      i18n.text(button,opening===feature?'permission.openingSettings':'permission.openSettings');
    }
    onChange();
  };
  const gate=new FeaturePermissionGate({permissions,platform,onChange:render,onChecked:onPermissionsChanged});
  for(const element of notices)element.querySelector('button').addEventListener('click',async()=>{
    if(opening||element.hidden)return;
    const feature=element.dataset.featurePermission,permission=PERMISSION[feature];
    opening=feature;errors.delete(feature);render();onSettingsOpened(permission);
    try{await permissions.openSettings(permission);onPermissionsChanged();gate.permissionsChanged();}
    catch(error){errors.set(feature,error);}
    finally{opening=null;render();}
  });
  i18n.subscribe(render);render();return gate;
}
