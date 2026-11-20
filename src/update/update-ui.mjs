import {UpdateManager} from './update-manager.mjs';
import {i18n} from '../i18n.mjs';

export function mountUpdates({document, invoke, listen, beforeInstall, isSharing = () => false, setTimer = setTimeout}) {
  const button = document.querySelector('#settings-update-check');
  const versionButton = document.querySelector('#app-version-button');
  const versionIcon = document.querySelector('#app-update-icon');
  const dialog = document.querySelector('#update-dialog');
  const title = document.querySelector('#update-title');
  const notes = document.querySelector('#update-notes');
  const detail = document.querySelector('#update-detail');
  const error = document.querySelector('#update-error');
  const install = document.querySelector('#update-install');
  const later = document.querySelector('#update-later');
  const close = document.querySelector('#update-close');
  const version = document.querySelector('#app-version');
  const progress = document.querySelector('#update-progress');
  const versions = document.querySelector('#update-versions');
  const currentVersion = document.querySelector('#update-current-version');
  const targetVersion = document.querySelector('#update-target-version');
  const notesTitle = document.querySelector('#update-notes-title');
  const isInstalling = state => Boolean(state.installing) || state.status === 'installing';
  let unlisten;
  const render = state => {
    const available = Boolean(state.update);
    const installing = isInstalling(state);
    const downloading = state.status === 'downloading';
    const size = state.update ? (state.update.size / 1024 / 1024).toFixed(1) + ' MB' : '';
    version.textContent = state.currentVersion ? 'v' + state.currentVersion : '';
    versionButton.hidden = !state.currentVersion;
    versionButton.disabled = !available || installing;
    versionButton.dataset.available = String(available);
    versionIcon.hidden = !available;
    for (const attribute of ['aria-label', 'title']) i18n.attribute(versionButton, attribute, available ? 'update.openDetails' : 'update.versionLabel', {current:state.currentVersion,version:state.update?.version});
    const settingsVersion=document.querySelector('#settings-version'),settingsStatus=document.querySelector('#settings-update-status'),settingsError=document.querySelector('#settings-update-error');
    if(settingsVersion)settingsVersion.textContent=(state.currentVersion||'—')+(state.channel&&state.channel!=='release'?' · '+i18n.t('update.channel',{channel:state.channel}):'');
    if(settingsStatus)i18n.text(settingsStatus,state.checking?'update.checking':state.status==='ready'?'update.readyVersion':state.status==='downloading'?'update.downloading':state.update?'update.found':state.status==='current'?'update.latest':'update.background',{version:state.update?.version});
    if(settingsError){settingsError.hidden=!state.error;settingsError.textContent=state.error?i18n.error(state.error):'';}
    versions.hidden=!available;currentVersion.textContent=state.currentVersion||'—';targetVersion.textContent=state.update?.version||'';
    i18n.text(button,available?'update.viewDetails':state.checking?'update.checking':state.error?'common.retry':'update.check');
    button.disabled=installing||(!available&&state.checking);
    i18n.text(title,'update.title');
    close.disabled=installing;
    notes.textContent=state.update?.notes||i18n.t('update.noNotes');
    detail.textContent=installing?i18n.t('update.installing'):state.checking&&!downloading?i18n.t('update.checking'):state.status==='ready'?i18n.t('update.verified',{size,next:i18n.t(isSharing()?'update.endSession':'update.restart')}):downloading?i18n.t('update.downloadDetail',{size}):available?i18n.t('update.waiting',{size}):i18n.t(state.status==='current'?'update.latest':'update.background');
    error.hidden=!state.error;error.textContent=state.error?i18n.error(state.error):'';
    notes.hidden=notesTitle.hidden=!available;
    install.hidden = !available&&!state.checking&&!state.error;
    install.disabled = state.checking || downloading || installing;
    i18n.text(install,installing?'update.updating':downloading?'update.downloading':state.checking?'update.checking':state.status==='ready'?'update.install':available?state.error?'update.retryDownload':'update.download':state.error?'common.retry':'update.check');
    later.disabled = installing;
    i18n.text(later,available?downloading?'update.backgroundDownload':'update.later':'common.close');
    progress.hidden = !downloading;
    if (state.prompt && !dialog.open) dialog.showModal();
    if (!state.prompt && dialog.open) dialog.close();
    for (const id of ['code-view', 'casting-view','settings-view']){const page=document.getElementById(id);if(page)page.inert = installing;}
  };
  const manager = new UpdateManager({invoke, beforeInstall, onChange:render});
  button.addEventListener('click', () => { if (manager.state.update) manager.open(); else void manager.check({interactive:true}); });
  versionButton.addEventListener('click', () => { if (manager.state.update) manager.open(); });
  later.addEventListener('click', () => manager.dismiss());
  close.addEventListener('click',()=>{if(!isInstalling(manager.state))manager.dismiss();});
  install.addEventListener('click', () => { if (manager.state.status==='ready') void manager.install(); else void manager.check({interactive:true}); });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!isInstalling(manager.state)) manager.dismiss();
  });
  void listen('nearcast://update-progress', event => {
    if (event.payload?.total) { progress.max = event.payload.total; progress.value = event.payload.received; }
  }).then(stop => { unlisten = stop; }).catch(() => {});
  const stopLanguage=i18n.subscribe(()=>render(manager.state));
  render(manager.state);
  const startup = setTimer(() => void manager.start(), 2500);
  return {manager, stop() { stopLanguage();clearTimeout(startup); unlisten?.(); manager.stop(); }};
}
