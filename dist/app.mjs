import {LauncherWebCastClient, DEFAULT_ENDPOINT} from './webcast/launcher-webcast-client.mjs';
import {ReceiverTrust, formatFingerprint} from './webcast/receiver-trust.mjs';
import {WebCastTouchbackSender} from './webcast/touchback-sender.mjs';
import {createPlatformInputAdapter} from './touchback/platform-input.mjs';
import {TauriDeviceDiscovery} from './tauri-device-discovery.mjs';
import {loadPlatformInfo, platformSummary, screenCaptureError, touchbackSummary} from './platform-capabilities.mjs';
import {canAttachTouchbackChannel} from './webcast/touchback-channel-policy.mjs';
import {normalizeVideoQuality} from './webcast/video-quality.mjs';
import {MacOsPermissions} from './macos-permissions.mjs';
import {NativeCaptureMediaDevices} from './capture/native-capture.mjs';
import {CaptureTargetPreviews} from './capture/target-previews.mjs';
import {TouchFeedback} from './touchback/touch-feedback.mjs';

const tauri = globalThis.__TAURI__ ?? {};
const invoke = tauri.core?.invoke ?? (async () => false);
const listen = tauri.event?.listen ?? (async () => () => {});
const codeView = document.querySelector('#code-view');
const castingView = document.querySelector('#casting-view');
const pairForm = document.querySelector('#pair-form');
const digits = [...document.querySelectorAll('.code-digit')];
const connectButton = document.querySelector('#connect-button');
const codeError = document.querySelector('#code-error');
const codeDisplayStatus = document.querySelector('#code-display-status');
const trustCard = document.querySelector('#trust-card');
const trustTitle = document.querySelector('#trust-title');
const trustCopy = document.querySelector('#trust-copy');
const trustFingerprint = document.querySelector('#trust-fingerprint');
const trustCheck = document.querySelector('#trust-check');
const trustCheckLabel = document.querySelector('#trust-check-label');
const trustConfirm = document.querySelector('#trust-confirm');
const trustRetry = document.querySelector('#trust-retry');
const trustCancel = document.querySelector('#trust-cancel');
const trustRevoke = document.querySelector('#trust-revoke');
const trustError = document.querySelector('#trust-error');
const targetName = document.querySelector('#target-name');
const castStatus = document.querySelector('#cast-status');
const shareButton = document.querySelector('#share-button');
const stopShareButton = document.querySelector('#stop-share-button');
const leaveButton = document.querySelector('#leave-button');
const previewWrap = document.querySelector('#preview-wrap');
const preview = document.querySelector('#preview');
const castError = document.querySelector('#cast-error');
const platformStatus = document.querySelector('#platform-status');
const touchbackStatus = document.querySelector('#touchback-status');
const deviceGroups = document.querySelector('#device-groups');
const deviceStatus = document.querySelector('#device-status');
const refreshDevices = document.querySelector('#refresh-devices');
const videoResolution = document.querySelector('#video-resolution');
const videoBitrateMode = document.querySelector('#video-bitrate-mode');
const videoBitrate = document.querySelector('#video-bitrate');
const videoQualitySummary = document.querySelector('#video-quality-summary');
const permissionsPanel = document.querySelector('#macos-permissions');
const permissionRows = document.querySelector('#permission-rows');
const refreshPermissionsButton = document.querySelector('#refresh-permissions');
const permissionsError = document.querySelector('#permissions-error');
const permissions = new MacOsPermissions({invoke});
const inputEnabled = document.querySelector('#input-enabled');
const touchFeedbackToggle=document.querySelector('#touch-feedback-enabled');
const touchFeedback=new TouchFeedback({invoke,enabled:false});
touchFeedbackToggle.addEventListener('change',()=>touchFeedback.setEnabled(touchFeedbackToggle.checked));
const inputState = document.querySelector('#input-state');
const inputReconnect = document.querySelector('#input-reconnect');
const inputCleanup = document.querySelector('#input-cleanup');
const capturePicker = document.querySelector('#capture-picker');
const captureTarget = document.querySelector('#capture-target');
const captureConfirm = document.querySelector('#capture-picker-confirm');
const capturePickerError = document.querySelector('#capture-picker-error');
let permissionActionPending = false;
let permissionSettingsOpened = null;

const defaultEndpoint = new URLSearchParams(location.search).get('ws') || DEFAULT_ENDPOINT;
let selectedEndpoint = defaultEndpoint;
let selectedDevice = null;
let activeDevice = null;
let currentStatus = 'idle';
let codeDisplayRequestId = null;
let trustDevice = null;
let platformInfo = null;
let touchback;
let platformReady = Promise.resolve();
let controlGeneration = 0;
let capturePending = false;
let nativeCapture = null;
let videoQuality = normalizeVideoQuality({resolution: videoResolution.value, bitrateMode: videoBitrateMode.value, bitrateKbps: videoBitrate.value});
globalThis.__nearcastTouchbackDiagnostics = () => touchback ? {...touchback.diagnostics(), control: touchback.controlDiagnostics(),capture:nativeCapture?.diagnostics()??null,touchFeedback:touchFeedback.diagnostics()} : null;
const controlDiagnostics = document.querySelector('#touchback-diagnostics');
const renderControlDiagnostics = () => {
  if (controlDiagnostics) controlDiagnostics.textContent = JSON.stringify(globalThis.__nearcastTouchbackDiagnostics(), null, 2);
};
setInterval(renderControlDiagnostics, 1000);

const setError = (element, error) => {
  element.textContent = error ? (error.message || String(error)) : '';
  element.hidden = !error;
};
const setCodeDisplayStatus = text => { codeDisplayStatus.textContent = text || ''; };
const renderVideoQuality = () => {
  videoQuality = normalizeVideoQuality({resolution: videoResolution.value, bitrateMode: videoBitrateMode.value, bitrateKbps: videoBitrate.value});
  const resolution = videoQuality.resolution === 'auto' ? 'Auto' : videoQuality.resolution.replace('x', ' × ');
  videoQualitySummary.textContent = `${videoQuality.bitrateMode === 'fixed' ? 'Fixed' : 'Dynamic'} · ${resolution}${videoQuality.bitrateMode === 'fixed' ? ` · ${videoQuality.bitrateKbps / 1000} Mbps` : ''}`;
  videoBitrate.disabled = false;
};
videoResolution.addEventListener('change', renderVideoQuality);
videoBitrateMode.addEventListener('change', renderVideoQuality);
videoBitrate.addEventListener('change', renderVideoQuality);
renderVideoQuality();
const renderTrust = state => {
  trustCard.hidden = !state || state.phase === 'idle' || state.phase === 'trusted' && !state.fingerprint;
  trustCard.open = state?.phase !== 'trusted';
  trustTitle.textContent = state?.phase === 'trusted' ? '已配对 · 接收端指纹' : '现场核对接收端指纹';
  trustCheck.checked = false; trustConfirm.disabled = true; trustConfirm.hidden = state?.phase !== 'compare'; trustCheckLabel.hidden = true; trustRevoke.hidden = true;
  trustRetry.hidden = !['changed','expired','untrusted','error'].includes(state?.phase) || !state.device?.supportsTrustDisplay;
  trustFingerprint.textContent = '';
  setError(trustError, state?.error ? new Error(state.error) : null);
  if (!state || state.phase === 'idle') return;
  if (state.phase === 'trusted') { trustCopy.textContent = '此设备已完成现场核对，可以请求接收端显示配对码。'; trustFingerprint.textContent = formatFingerprint(state.fingerprint); trustRevoke.hidden = false; return; }
  if (state.phase === 'compare') { trustCopy.textContent = `${state.previousFingerprint && state.previousFingerprint !== state.fingerprint ? '此设备的公钥已变化。' : ''}请确认接收端顶部显示的指纹与下方四行内容完全一致，核对后勾选确认。`; trustFingerprint.textContent = formatFingerprint(state.fingerprint); trustCheckLabel.hidden = false; return; }
  if (state.phase === 'preparing' || state.phase === 'checking') { trustCopy.textContent = '正在建立安全连接并请求接收端显示指纹…'; trustFingerprint.textContent = ''; return; }
  if (state.phase === 'unsupported') { trustCopy.textContent = '接收端没有提供指纹显示能力，请现场查看配对码并手动输入。'; trustFingerprint.textContent = ''; return; }
  if (state.phase === 'changed') { trustCopy.textContent = '接收端公钥已变化，已阻止请求。请重新在现场核对新的完整指纹。'; trustFingerprint.textContent = state.fingerprint ? formatFingerprint(state.fingerprint) : ''; trustRevoke.hidden = !state.fingerprint; return; }
  if (state.phase === 'expired') { trustCopy.textContent = '指纹核对已过期，请重新显示指纹。'; trustFingerprint.textContent = ''; }
  else if (state.phase === 'saving') trustCopy.textContent = '正在保存现场确认…';
  else if (state.phase === 'error') trustCopy.textContent = '无法完成设备信任，请使用现场配对码或重试。';
  else if (state.phase === 'untrusted') trustCopy.textContent = '已撤销此设备信任，重新请求配对码前需要再次现场核对。';
};
const codeValue = () => digits.map(input => input.value.trim()).join('').toUpperCase();
const setView = status => {
  currentStatus = status;
  const connected = ['joined', 'connected', 'sharing'].includes(status);
  codeView.hidden = connected;
  castingView.hidden = !connected;
  connectButton.disabled = status !== 'idle';
  digits.forEach(input => { input.disabled = status !== 'idle'; });
  shareButton.disabled = capturePending || !['connected', 'sharing'].includes(status);
  deviceGroups.querySelectorAll('.device-row.selectable').forEach(row => { row.disabled = status !== 'idle'; });
  castStatus.textContent = status === 'sharing' ? 'Your screen is being shared to the receiver.' : status === 'connected' ? 'Receiver is ready for casting.' : 'Connecting to receiver…';
};
const focusNext = index => { if (index < digits.length - 1) digits[index + 1].focus(); };
digits.forEach((input, index) => {
  input.addEventListener('input', () => {
    input.value = input.value.replace(/[^a-z0-9]/gi, '').slice(-1).toUpperCase();
    setError(codeError, null);
    if (input.value) focusNext(index);
  });
  input.addEventListener('keydown', event => { if (event.key === 'Backspace' && !input.value && index > 0) digits[index - 1].focus(); });
  input.addEventListener('paste', event => {
    event.preventDefault();
    const pasted = (event.clipboardData?.getData('text') || '').replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase();
    pasted.split('').forEach((value, offset) => { if (digits[index + offset]) digits[index + offset].value = value; });
    focusNext(Math.min(index + pasted.length - 1, digits.length - 1));
  });
});

const buildTouchback = () => new WebCastTouchbackSender({
  provider: createPlatformInputAdapter({}, {invoke}),
  onTouchFeedback:event=>touchFeedback.observe(event),
  onStatus: (_status, state) => {
    void nativeCapture?.setInputState(state);
    const reasons = {LOCAL_INPUT_DISABLED:'反控未启用', APP_NOT_READY:'等待接收端建立反控会话', TARGET_UNBOUND:'等待接收端绑定投屏来源', CAPTURE_UNAVAILABLE:'请先分享屏幕或窗口', CAPTURE_CHANGED:'分享已停止，重新分享后等待接收端恢复反控', CAPTURE_GEOMETRY_CHANGED:'正在更新分享范围，反控暂时暂停', CAPTURE_MUTED:'采集已暂停', NATIVE_CLEANUP_PENDING:'等待释放上一次输入', NATIVE_PERMISSION_UNAVAILABLE:'本机输入不可用，请检查系统权限', NATIVE_DOMAIN_BUSY:'本机输入正由其他会话使用', NATIVE_GEOMETRY_UNAVAILABLE:'无法确认当前分享范围的坐标映射，请查看反控诊断', TARGET_CONTRACT_MISMATCH:'接收端反控协议版本不匹配', INPUT_SESSION_FAULT:'反控连接异常，可重建连接'};
    inputState.textContent = !state.localEnabled ? '反控未启用' : state.state === 'active' && state.sourceReady ? `反控已开启 · ${state.acceptedInputTypes.join(' / ')} · stream ${state.streamId}` : state.sourceReady ? '本机已就绪，等待接收端开启反控' : state.detail?.includes('capture_window_not_foreground') ? '窗口反控已暂停，请切回正在分享的窗口' : state.detail?.includes('minimized') ? '窗口已最小化，反控已暂停' : state.disabledReason === 'NATIVE_PROBE_FAILED' ? '无法读取本机输入能力，请重试或检查系统权限' : nativeCapture && state.disabledReason === 'NATIVE_GEOMETRY_UNAVAILABLE' ? '正在确认分享范围，反控暂不可用' : state.disabledReason === 'INPUT_SESSION_FAULT' && state.detail?.includes('Input queue age') ? '输入处理积压，已释放触点；可重建反控连接' : reasons[state.disabledReason] || '正在准备反控';
    inputCleanup.hidden = !state.cleanupPending;
    inputReconnect.disabled = state.cleanupPending || !['connected','sharing'].includes(currentStatus);
    touchbackStatus.textContent = touchbackSummary(platformInfo ?? {});
    renderControlDiagnostics();
  },
});
touchback = buildTouchback();
inputEnabled.addEventListener('change', () => { void touchback.setEnabled(inputEnabled.checked); });
inputCleanup.addEventListener('click', async () => {
  inputCleanup.disabled = true;
  try { await touchback.retryCleanup(); } finally { inputCleanup.disabled = false; }
});
inputReconnect.addEventListener('click', async () => {
  inputReconnect.disabled = true;
  if (touchback.diagnostics().cleanupPending) return;
  if (!await touchback.fence('explicit control replacement')) {
    inputState.textContent = '输入尚未释放，请先重试释放输入';
    return;
  }
  try { client.recreateControlChannel({replace: true}); }
  catch (error) { inputState.textContent = error.message; }
});
let capturePickerGeneration = 0;
const chooseCaptureTarget = async () => {
  const generation = ++capturePickerGeneration;
  capturePicker.returnValue = 'cancel';captureTarget.replaceChildren();captureConfirm.disabled = true;setError(capturePickerError, null);
  const choices = await invoke('nearcast_capture_targets');
  if (generation !== capturePickerGeneration) return null;
  let selectedTargetId = null;
  const rows = [], tabs = [], tabsHost = document.querySelector('#capture-kind-tabs');
  tabsHost.replaceChildren();
  const previews = new CaptureTargetPreviews({invoke});
  const selectRow = row => {
    if (!capturePicker.open || row.hidden || generation !== capturePickerGeneration) return;
    selectedTargetId = row.dataset.targetId;
    for (const candidate of rows) {
      candidate.setAttribute('aria-checked', String(candidate === row));
      candidate.tabIndex = candidate === row ? 0 : -1;
    }
    captureConfirm.disabled = false;
    row.focus({preventScroll:true});
  };
  const setKind = kind => {
    selectedTargetId = null;captureConfirm.disabled = true;captureTarget.scrollTop = 0;
    for (const tab of tabs) {const active=tab.dataset.kind===kind;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;}
    let first = true;
    for (const row of rows) {
      row.hidden = row.dataset.kind !== kind;row.setAttribute('aria-checked','false');
      row.tabIndex = !row.hidden && first ? 0 : -1;if(!row.hidden)first=false;
    }
  };
  for (const [kind, label] of [['monitor','屏幕'],['window','窗口']]) {
    const groupChoices = choices.filter(choice => choice.kind === kind);
    if (!groupChoices.length) continue;
    const tab=document.createElement('button');tab.type='button';tab.dataset.kind=kind;tab.setAttribute('role','tab');tab.setAttribute('aria-controls','capture-target');tab.textContent=`${label} (${groupChoices.length})`;tabs.push(tab);tabsHost.append(tab);
    tab.addEventListener('click',()=>setKind(kind));
    tab.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(tabs.indexOf(tab)+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;
      setKind(tabs[index].dataset.kind);tabs[index].focus();
    });
    for (const choice of groupChoices) {
      const row = document.createElement('button');row.type = 'button';row.className = 'capture-target-row';
      row.dataset.targetId = choice.targetId;row.dataset.kind=kind;row.setAttribute('role','radio');row.setAttribute('aria-checked','false');row.tabIndex=-1;
      const preview=document.createElement('span');preview.className='capture-target-preview';preview.dataset.status='loading';preview.textContent='正在加载预览…';preview.setAttribute('aria-hidden','true');
      const title = document.createElement('span');title.className = 'capture-target-title';
      title.textContent = kind === 'monitor' ? `${choice.primary ? '主屏幕' : `副屏幕${choice.region.x < 0 ? '（左侧）' : choice.region.y < 0 ? '（上方）' : ''}`} · ${choice.region.width} × ${choice.region.height}` : choice.title;
      row.title = title.textContent;row.append(preview,title);rows.push(row);captureTarget.append(row);
      row.addEventListener('click', () => selectRow(row));
      row.addEventListener('keydown', event => {
        const visible=rows.filter(candidate=>!candidate.hidden);
        const columns=Math.max(1,getComputedStyle(captureTarget).gridTemplateColumns.split(' ').length);
        const step = {ArrowDown:columns,ArrowRight:1,ArrowUp:-columns,ArrowLeft:-1}[event.key];
        if (!step && !['Home','End'].includes(event.key)) return;
        event.preventDefault();
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (visible.indexOf(row) + step % visible.length + visible.length) % visible.length;
        selectRow(visible[index]);visible[index].scrollIntoView({block:'nearest'});
      });
    }
  }
  if (!rows.length) {previews.dispose();throw new Error('没有可分享的屏幕或窗口');}
  const observer=new IntersectionObserver(entries=>{
    for(const entry of entries){
      const row=entry.target;
      if(!entry.isIntersecting||row.hidden||!capturePicker.open)continue;
      previews.request(row.dataset.targetId,state=>{
        if(!capturePicker.open||generation!==capturePickerGeneration)return;
        const box=row.querySelector('.capture-target-preview');box.dataset.status=state.status;
        if(state.status==='ready'){
          const img=document.createElement('img');img.alt='';img.src=state.url;
          img.onerror=()=>{box.dataset.status='error';box.textContent='预览暂不可用';};box.replaceChildren(img);
        }else box.textContent=state.status==='error'?'预览暂不可用':'正在加载预览…';
      });
    }
  },{root:captureTarget});
  setKind(tabs[0].dataset.kind);
  return new Promise(resolve => {
    capturePicker.addEventListener('close', () => {
      observer.disconnect();previews.dispose();
      resolve(generation === capturePickerGeneration && capturePicker.returnValue === 'share' ? selectedTargetId : null);
    }, {once:true});
    capturePicker.showModal();for(const row of rows)observer.observe(row);
  });
};
chooseCaptureTarget.cancel = () => { capturePickerGeneration++;if (capturePicker.open) capturePicker.close('cancel'); };
const client = new LauncherWebCastClient({
  endpoint: selectedEndpoint,
  videoQuality,
  codeDisplayTransport: ({instance, request}) => invoke('nearcast_code_display', {instance, request}),
  onStatus: setView,
  onError: error => { setError(codeError, error); client.stop({notify: false}); activeDevice = null; },
  onCodeDisplayResult: result => {
    if (result.requestId !== codeDisplayRequestId) return;
    const messages = {shown: '配对码已在接收端显示，请输入 4 位配对码。', unavailable: '接收端暂时无法显示配对码，请现场查看接收端。', rate_limited: '请求过于频繁，请稍后再试。', not_supported: '该接收端不支持远程显示配对码，请现场查看。'};
    setCodeDisplayStatus(messages[result.status] || '');
  },
  onCodeDisplayError: (error, request) => {
    if (request.requestId !== codeDisplayRequestId) return;
    setCodeDisplayStatus(`无法请求接收端显示配对码：${error.message || error}`);
    if (String(error.message || error).includes('NEARCAST_KEY_MISMATCH')) trustManager.keyMismatch(error.message || error);
  },
  onSessionEnded: () => { controlGeneration++; touchback.fence(); void nativeCapture?.stop().catch(error => setError(castError,error)); },
  onControlClosed: () => { controlGeneration++; void touchback.fence('control channel closed'); inputReconnect.disabled = false; inputState.textContent = '反控连接已关闭，投屏继续'; },
  onControlChannel: (channel, mediaIdentity) => {
    if (!canAttachTouchbackChannel(channel)) return;
    const generation = ++controlGeneration;
    try {
      platformReady.then(() => {
        if (generation !== controlGeneration || channel.readyState !== 'open') return;
        return touchback.attachControlChannel(channel, {authorized: true, protocol: 'webcast', mediaIdentity});
      }).catch(error => { if (generation === controlGeneration) setError(castError, error); });
    } catch (error) { setError(castError, error); }
  },
  onControlMessage: message => touchback.handleControlMessage(message),
  onStream: stream => {
    void touchback.setCaptureTrack(stream?.getVideoTracks()[0] ?? null);
    preview.srcObject = stream;
    previewWrap.hidden = !stream;
    shareButton.hidden = Boolean(stream);
    stopShareButton.hidden = !stream;
    if (stream) preview.play?.().catch(() => {});
  },
});

const requestCodeDisplayFor = device => {
  if (!device?.supportsCodeDisplay) { setCodeDisplayStatus('该接收端不支持远程显示配对码，请现场查看。'); return; }
  try { codeDisplayRequestId = client.requestCodeDisplay({device: {...device, trustRequired: true, trustState: trustDevice && trustDevice.discoveryId === device.discoveryId && trustManager.state.phase === 'trusted' ? 'trusted' : 'untrusted'}, reason: 'sender-device-selected'}); }
  catch (error) { setCodeDisplayStatus(error.message || String(error)); }
};

const trustManager = new ReceiverTrust({invoke, onChange: renderTrust, onTrusted: device => {
  if (!trustDevice || device.discoveryId !== trustDevice.discoveryId || currentStatus !== 'idle') return;
  trustDevice = device;
  if (device.supportsCodeDisplay) { setCodeDisplayStatus('指纹已确认，正在请求接收端显示配对码…'); requestCodeDisplayFor(device); }
}});
trustCheck.addEventListener('change', () => { trustConfirm.disabled = !trustCheck.checked; });
trustConfirm.addEventListener('click', async () => { try { await trustManager.confirm(trustCheck.checked); } catch (error) { setError(trustError, error); } });
trustRetry.addEventListener('click', () => trustManager.prepare());
trustCancel.addEventListener('click', () => { trustManager.cancel(); trustDevice = null; client.cancelCodeDisplay(); codeDisplayRequestId = null; setCodeDisplayStatus('已取消指纹核对，可现场输入配对码。'); });
trustRevoke.addEventListener('click', async () => { try { client.cancelCodeDisplay(); codeDisplayRequestId = null; await trustManager.revoke(); setCodeDisplayStatus('已撤销信任。'); } catch (error) { setError(trustError, error); } });

pairForm.addEventListener('submit', async event => {
  event.preventDefault();
  const pairCode = codeValue();
  if (!/^[A-Z0-9]{4}$/.test(pairCode)) { setError(codeError, new Error('请输入 4 位字母或数字配对码')); return; }
  setError(codeError, null);
  if (selectedDevice && selectedDevice.expiresAt <= Date.now()) { setError(codeError, new Error('接收端发现已过期，请重新扫描并选择设备。')); return; }
  activeDevice = selectedDevice;
  trustManager.cancel(); trustDevice = null; client.cancelCodeDisplay(); codeDisplayRequestId = null;
  client.endpoint = selectedEndpoint;
  try {
    await platformReady;
    await touchback.fence('new pairing');
    inputEnabled.checked = false;
    await touchback.setEnabled(false);
    await client.connect(pairCode);
    targetName.textContent = selectedDevice?.displayName || 'NearCast';
  } catch (error) {
    setError(codeError, error);
    await client.stop({notify: false});
    setView('idle');
  }
});
shareButton.addEventListener('click', async () => {
  if (capturePending) return;
  capturePending = true; shareButton.disabled = true;
  setError(castError, null);
  try { client.videoQuality = videoQuality; await client.startScreenShare({video: true, audio: false}); }
  catch (error) { setError(castError, screenCaptureError(error, platformInfo)); }
  finally { capturePending = false; shareButton.disabled = !['connected', 'sharing'].includes(currentStatus); }
});
stopShareButton.addEventListener('click', async () => { setError(castError, null); await client.stopStream(); });
leaveButton.addEventListener('click', async () => { setError(castError, null); touchback.fence(); await client.stop(); digits.forEach(input => { input.value = ''; }); });
window.addEventListener('beforeunload', () => { touchback.fence(); trustManager.cancel(); client.stop({notify: false}); });

const renderDevices = devices => {
  if (selectedDevice && currentStatus === 'idle') {
    const current = devices.find(device => device.discoveryId === selectedDevice.discoveryId && device.selectable);
    if (!current || current.instance !== selectedDevice.instance || current.endpoint !== selectedDevice.endpoint || current.deviceId !== selectedDevice.deviceId || current.capability !== selectedDevice.capability) {
      trustManager.cancel(); trustDevice = null;
      selectedDevice = null; selectedEndpoint = defaultEndpoint; client.endpoint = defaultEndpoint; client.cancelCodeDisplay(); codeDisplayRequestId = null;
      setCodeDisplayStatus('接收端已离线或服务发生变化，请重新扫描并选择。');
    } else {
      selectedDevice = current;
      if (trustDevice) { trustDevice = current; trustManager.device = current; }
    }
  }
  deviceGroups.replaceChildren();
  const groups = [{protocol: 'webcast', label: 'NEARCAST RECEIVERS', icon: '▣'}, {protocol: 'airplay', label: 'AIRPLAY DEVICES', icon: ''}];
  const available = devices.filter(device => device.protocol === 'webcast' || device.protocol === 'airplay');
  deviceStatus.textContent = available.length ? `${available.length} device${available.length === 1 ? '' : 's'} found on your local network` : 'No receivers found yet — keep scanning…';
  for (const group of groups) {
    const entries = devices.filter(device => device.protocol === group.protocol);
    if (!entries.length) continue;
    const section = document.createElement('div'); section.className = 'device-group';
    const title = document.createElement('div'); title.className = 'group-title'; title.textContent = group.label; section.append(title);
    for (const device of entries) {
      const row = document.createElement('button'); row.type = 'button'; row.className = `device-row ${device.selectable ? 'selectable' : 'disabled'}`;
      row.disabled = !device.selectable || currentStatus !== 'idle';
      row.setAttribute('aria-pressed', String(device.selectable && device.discoveryId === selectedDevice?.discoveryId));
      row.innerHTML = `<span class="device-icon">${group.icon}</span><span class="device-copy"><span class="device-name"></span><span class="device-meta"></span></span><span class="device-action">${device.selectable ? 'Use' : 'Display only'}</span>`;
      row.querySelector('.device-name').textContent = device.displayName;
      row.querySelector('.device-meta').textContent = device.addresses?.[0] ? `${device.addresses[0]}${device.port ? `:${device.port}` : ''}` : device.hostname || device.model || device.protocol;
      if (device.selectable) row.addEventListener('click', () => {
        if (currentStatus !== 'idle') return;
        client.cancelCodeDisplay(); codeDisplayRequestId = null;
        if (selectedDevice?.discoveryId !== device.discoveryId) digits.forEach(input => { input.value = ''; });
        selectedDevice = device; trustDevice = device; selectedEndpoint = defaultEndpoint; client.endpoint = selectedEndpoint; digits[0].focus(); setError(codeError, null);
        setCodeDisplayStatus(device.supportsTrustDisplay ? '正在请求现场核对指纹…' : '该接收端不支持指纹显示，请现场输入配对码。');
        trustManager.select(device);
      });
      section.append(row);
    }
    deviceGroups.append(section);
  }
};

const discovery = new TauriDeviceDiscovery({invoke, listen});
const startDiscovery = async () => {
  trustManager.cancel(); trustDevice = null; client.cancelCodeDisplay(); codeDisplayRequestId = null;
  refreshDevices.disabled = true; deviceStatus.textContent = 'Scanning for AirPlay and WebCast receivers…';
  try { await discovery.stop().catch(() => {}); await discovery.start(renderDevices); }
  catch (error) { deviceStatus.textContent = `Scan unavailable: ${error.message || error}`; }
  finally { refreshDevices.disabled = false; }
};
refreshDevices.addEventListener('click', startDiscovery);

const renderPermissions = () => {
  for (const row of permissions.rows()) {
    let toggle = permissionRows.querySelector(`[data-permission="${row.id}"]`);
    if (!toggle) {
      const item = document.createElement('div'); item.className = 'permission-row';
      const control = document.createElement('div'); control.className = 'permission-control';
      const title = document.createElement('span'); title.className = 'permission-title'; title.textContent = row.title;
      toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'permission-toggle'; toggle.dataset.permission = row.id;
      toggle.setAttribute('aria-label', `${row.title}权限设置`);
      toggle.setAttribute('aria-describedby', `permission-status-${row.id}`);
      toggle.title = `前往系统设置配置${row.title}`;
      toggle.addEventListener('click', async () => {
        if (permissionActionPending) return;
        permissionActionPending = true; permissionSettingsOpened = row.id;
        setError(permissionsError, null); renderPermissions();
        try { await permissions.openSettings(row.id); }
        catch (error) { setError(permissionsError, error); }
        finally { permissionActionPending = false; renderPermissions(); }
      });
      const detail = document.createElement('p'); detail.className = 'permission-detail';
      const state = document.createElement('span'); state.className = 'permission-state'; state.id = `permission-status-${row.id}`; state.setAttribute('aria-live', 'polite');
      detail.append(state, document.createElement('br'), row.help);
      control.append(title, toggle); item.append(control, detail); permissionRows.append(item);
    }
    toggle.disabled = permissionActionPending;
    toggle.dataset.state = row.enabled === null ? 'unknown' : row.enabled ? 'on' : 'off';
    if (row.enabled === null) { toggle.removeAttribute('role'); toggle.removeAttribute('aria-checked'); }
    else { toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(row.enabled)); }
    const state = document.querySelector(`#permission-status-${row.id}`);
    state.textContent = row.status;
    if (row.id === 'localNetwork' && row.enabled === null) state.textContent = '待确认 · 请在系统设置中查看';
  }
};
const refreshPermissions = async () => {
  if (platformInfo?.os !== 'macos') return;
  refreshPermissionsButton.disabled = true;
  setError(permissionsError, null);
  try { await permissions.refresh(); }
  catch (error) { setError(permissionsError, error); }
  finally { renderPermissions(); refreshPermissionsButton.disabled = false; }
};
refreshPermissionsButton.addEventListener('click', refreshPermissions);
window.addEventListener('focus', async () => {
  const opened = permissionSettingsOpened; permissionSettingsOpened = null;
  await refreshPermissions();
  if (opened === 'localNetwork' && currentStatus === 'idle') await startDiscovery();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPermissions(); });
setView('idle');
platformReady = loadPlatformInfo(invoke).then(info => {
  platformInfo = info;
  document.querySelector('#touch-feedback-settings').hidden=!(info.os==='windows'&&info.nativeCapture);
  touchFeedback.setEnabled(info.os==='windows'&&info.nativeCapture&&touchFeedbackToggle.checked);
  if (info.os === 'windows' && info.nativeCapture) {
    document.querySelector('#capture-help').textContent = '红框表示正在分享，绿框表示反控已就绪；分享窗口时请保持该窗口处于前台。';
    nativeCapture = new NativeCaptureMediaDevices({invoke, chooseTarget:chooseCaptureTarget,
      onGeometryChange: (_geometry, track) => { if (touchback.track === track) void touchback.captureGeometryChanged(); },
      onStatus: state => { if (state.error) setError(castError, new Error(state.error)); },
    });
    client.mediaDevices = nativeCapture;
  }
  permissionsPanel.hidden = info.os !== 'macos';
  if (info.os === 'macos') { renderPermissions(); refreshPermissions(); }
  platformStatus.textContent = platformSummary(info);
  touchbackStatus.textContent = touchbackSummary(info);
  touchback.status();
  return info;
}).catch(() => ({os: 'unknown', touchback: false, inputControl: 'none'}));
startDiscovery();
