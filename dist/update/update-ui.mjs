import {UpdateManager} from './update-manager.mjs';
import {i18n} from '../i18n.mjs';

export function mountUpdates({document, invoke, listen, beforeInstall, isSharing = () => false, setTimer = setTimeout}) {
  const button = document.querySelector('#update-button');
  const dialog = document.querySelector('#update-dialog');
  const title = document.querySelector('#update-title');
  const notes = document.querySelector('#update-notes');
  const detail = document.querySelector('#update-detail');
  const error = document.querySelector('#update-error');
  const install = document.querySelector('#update-install');
  const check = document.querySelector('#update-check');
  const later = document.querySelector('#update-later');
  const close = document.querySelector('#update-close');
  const version = document.querySelector('#app-version');
  const progress = document.querySelector('#update-progress');
  let unlisten;
  const render = state => {
    const available = Boolean(state.update);
    const size = state.update ? (state.update.size / 1024 / 1024).toFixed(1) + ' MB' : '';
    version.textContent = state.currentVersion ? 'v' + state.currentVersion : '';
    const settingsVersion=document.querySelector('#settings-version'),settingsStatus=document.querySelector('#settings-update-status'),settingsError=document.querySelector('#settings-update-error');
    if(settingsVersion)settingsVersion.textContent=(state.currentVersion||'—')+(state.channel&&state.channel!=='release'?' · '+i18n.t('update.channel',{channel:state.channel}):'');
    if(settingsStatus)i18n.text(settingsStatus,state.checking?'update.checking':state.status==='ready'?'update.readyVersion':state.status==='downloading'?'update.downloading':state.update?'update.found':state.status==='current'?'update.latest':'update.background',{version:state.update?.version});
    if(settingsError){settingsError.hidden=!state.error;settingsError.textContent=state.error?i18n.error(state.error):'';}
    const target=document.querySelector('#settings-update-target'),targetVersion=document.querySelector('#settings-update-version'),release=document.querySelector('#settings-update-release'),releaseNotes=document.querySelector('#settings-update-notes');
    target.hidden=!available;targetVersion.textContent=state.update?.version||'';
    release.hidden=!available;releaseNotes.textContent=state.update?.notes||i18n.t('update.noNotes');
    document.querySelector('#settings-update-icon').hidden=!available;
    const settingsCheck=document.querySelector('#settings-update-check');
    settingsCheck.disabled=state.checking||state.status==='downloading'||Boolean(state.installing);
    i18n.text(button,state.status==='downloading'?'update.downloading':state.status==='ready'?'update.ready':available?'update.available':'update.check');
    button.dataset.available=String(available);
    i18n.text(title,'update.title');
    close.disabled=Boolean(state.installing);
    button.disabled=Boolean(state.installing);
    notes.textContent=state.update?.notes||i18n.t(state.status==='current'?'update.latest':'update.background');
    detail.textContent=state.installing?i18n.t('update.installing'):state.status==='ready'?i18n.t('update.verified',{size,next:i18n.t(isSharing()?'update.endSession':'update.restart')}):state.status==='downloading'?i18n.t('update.downloadDetail',{size}):state.checking?i18n.t('update.checking'):available?i18n.t('update.waiting',{size}):i18n.t(state.status==='current'?'update.latest':'update.background');
    error.hidden=!state.error;error.textContent=state.error?i18n.error(state.error):'';
    notes.hidden=state.status==='downloading'||!available;
    install.hidden = !available||state.status==='downloading';
    install.disabled = state.status !== 'ready' || state.installing;
    i18n.text(install,state.installing?'update.updating':'update.install');
    check.disabled = state.checking || state.status === 'downloading' || state.installing;
    i18n.text(check,state.error?'common.retry':'update.check');
    check.hidden=state.status==='downloading'||available&&!state.error;
    later.disabled = Boolean(state.installing);
    i18n.text(later,available?state.status==='downloading'?'update.backgroundDownload':'update.later':'common.close');
    progress.hidden = state.status !== 'downloading';
    if (state.prompt && !dialog.open) dialog.showModal();
    if (!state.prompt && dialog.open) dialog.close();
    for (const id of ['code-view', 'casting-view','settings-view']){const page=document.getElementById(id);if(page)page.inert = Boolean(state.installing);}
  };
  const manager = new UpdateManager({invoke, beforeInstall, onChange:render});
  button.addEventListener('click', () => { manager.open(); if (!manager.state.update) void manager.check(); });
  document.querySelector('#settings-update-check')?.addEventListener('click',()=>void manager.check());
  check.addEventListener('click', () => void manager.check());
  later.addEventListener('click', () => manager.dismiss());
  close.addEventListener('click',()=>{if(!manager.state.installing)manager.dismiss();});
  install.addEventListener('click', () => void manager.install());
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!manager.state.installing) manager.dismiss();
  });
  void listen('nearcast://update-progress', event => {
    if (event.payload?.total) { progress.max = event.payload.total; progress.value = event.payload.received; }
  }).then(stop => { unlisten = stop; }).catch(() => {});
  const stopLanguage=i18n.subscribe(()=>render(manager.state));
  render(manager.state);
  const startup = setTimer(() => void manager.start(), 2500);
  return {manager, stop() { stopLanguage();clearTimeout(startup); unlisten?.(); manager.stop(); }};
}
