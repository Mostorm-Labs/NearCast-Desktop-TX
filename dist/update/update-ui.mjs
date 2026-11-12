import {UpdateManager} from './update-manager.mjs';

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
  const version = document.querySelector('#app-version');
  const progress = document.querySelector('#update-progress');
  let unlisten;
  const render = state => {
    const available = Boolean(state.update);
    const size = state.update ? (state.update.size / 1024 / 1024).toFixed(1) + ' MB' : '';
    version.textContent = state.currentVersion ? 'v' + state.currentVersion : '';
    const settingsVersion=document.querySelector('#settings-version'),settingsStatus=document.querySelector('#settings-update-status'),settingsError=document.querySelector('#settings-update-error');
    if(settingsVersion)settingsVersion.textContent=(state.currentVersion||'—')+(state.channel&&state.channel!=='release'?' · '+state.channel+' 测试渠道':'');
    if(settingsStatus)settingsStatus.textContent=state.checking?'正在检查更新…':state.status==='ready'?'更新 '+state.update.version+' 已下载并校验，可点击更新按钮确认安装。':state.status==='downloading'?'正在后台下载更新…':state.update?'发现新版本 '+state.update.version:state.status==='current'?'当前已是最新版本。':'后台自动检查并下载更新。';
    if(settingsError){settingsError.hidden=!state.error;settingsError.textContent=state.error||'';}
    button.textContent = state.status === 'downloading' ? '正在下载更新…' : state.status === 'ready' ? '更新已就绪' : available ? '发现新版本' : '检查更新';
    button.dataset.available = String(available);
    title.textContent = available ? '新版本 ' + state.update.version : '软件更新';
    notes.textContent = state.update?.notes || (state.status === 'current' ? '当前已是最新版本。' : '后台检查并下载更新，安装前由你确认。');
    detail.textContent = state.installing ? '正在结束投屏并安装更新…' : state.status === 'ready' ? size + ' · 已下载并校验。' + (isSharing() ? '更新将结束当前投屏和反控。' : '更新后应用会重新启动。') : state.status === 'downloading' ? size + ' · 后台下载中，可继续使用投屏。' : state.checking ? '正在检查更新…' : available ? size + ' · 等待下载或重试。' : '';
    error.hidden = !state.error; error.textContent = state.error || '';
    install.hidden = !available;
    install.disabled = state.status !== 'ready' || state.installing;
    install.textContent = state.installing ? '正在更新…' : '立即更新并重启';
    check.disabled = state.checking || state.status === 'downloading' || state.installing;
    check.textContent = state.error ? '重试' : '检查更新';
    later.disabled = Boolean(state.installing);
    later.textContent = available ? '暂不更新' : '关闭';
    progress.hidden = state.status !== 'downloading';
    if (state.prompt && !dialog.open) dialog.showModal();
    if (!state.prompt && dialog.open) dialog.close();
    for (const id of ['code-view', 'casting-view','settings-view']){const page=document.getElementById(id);if(page)page.inert = Boolean(state.installing);}
  };
  const manager = new UpdateManager({invoke, beforeInstall, onChange:render});
  button.addEventListener('click', () => { manager.open(); if (!manager.state.update) void manager.check(); });
  document.querySelector('#settings-update-check')?.addEventListener('click',()=>{manager.open();if(!manager.state.update)void manager.check();});
  check.addEventListener('click', () => void manager.check());
  later.addEventListener('click', () => manager.dismiss());
  install.addEventListener('click', () => void manager.install());
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!manager.state.installing) manager.dismiss();
  });
  void listen('nearcast://update-progress', event => {
    if (event.payload?.total) { progress.max = event.payload.total; progress.value = event.payload.received; }
  }).then(stop => { unlisten = stop; }).catch(() => {});
  render(manager.state);
  const startup = setTimer(() => void manager.start(), 2500);
  return {manager, stop() { clearTimeout(startup); unlisten?.(); manager.stop(); }};
}
