import {LauncherWebCastClient, DEFAULT_ENDPOINT} from './webcast/launcher-webcast-client.mjs';
import {ReceiverTrust, formatFingerprint} from './webcast/receiver-trust.mjs';
import {WebCastTouchbackSender} from './webcast/touchback-sender.mjs';
import {createPlatformInputAdapter} from './touchback/platform-input.mjs';
import {TauriDeviceDiscovery} from './tauri-device-discovery.mjs';
import {loadPlatformInfo, platformSummary, screenCaptureError, touchbackSummary} from './platform-capabilities.mjs';
import {canAttachTouchbackChannel} from './webcast/touchback-channel-policy.mjs';
import {normalizeVideoQuality} from './webcast/video-quality.mjs';
import {MacOsPermissions} from './macos-permissions.mjs';
import {BrowserCaptureMediaDevices} from './capture/browser-capture.mjs';
import {mountUpdates} from './update/update-ui.mjs';
import {createDiagnostics} from './diagnostics.mjs';
import {loadPreferences,savePreferences,mountSettings,mountFeedback} from './settings.mjs';

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
const systemAudioEnabled=document.querySelector('#system-audio-enabled');
const systemAudioStatus=document.querySelector('#system-audio-status');
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
const inputState = document.querySelector('#input-state');
const inputReconnect = document.querySelector('#input-reconnect');
const inputCleanup = document.querySelector('#input-cleanup');
const inputTouchOutput=document.querySelector('#input-touch-output');
const inputMouseOutput=document.querySelector('#input-mouse-output');
const inputPolicyApply=document.querySelector('#input-policy-apply');
const inputPolicyStatus=document.querySelector('#input-policy-status');
const touchOutputHelp=document.querySelector('#input-touch-help');
const mouseOutputHelp=document.querySelector('#input-mouse-help');
const gestureSettings=document.querySelector('#gesture-settings');
const gestureHold=document.querySelector('#gesture-hold-ms');
const gestureHoldValue=document.querySelector('#gesture-hold-value');
const gestureRightClick=document.querySelector('#gesture-right-click');
const gestureRightHold=document.querySelector('#gesture-right-hold-ms');
const gestureRightHoldValue=document.querySelector('#gesture-right-hold-value');
const gestureRightHoldLabel=document.querySelector('#gesture-right-hold-label');
const gestureRightHelp=document.querySelector('#gesture-right-help');
const gesturePinch=document.querySelector('#gesture-pinch-action');
const gesturePinchHelp=document.querySelector('#gesture-pinch-help');
const gestureFeedback=document.querySelector('#gesture-feedback');
const inputProvider=createPlatformInputAdapter({}, {invoke});
const preferences=loadPreferences();
videoResolution.value=preferences.video.resolution;videoBitrateMode.value=preferences.video.bitrateMode;videoBitrate.value=String(preferences.video.bitrateKbps);
systemAudioEnabled.checked=preferences.systemAudio;inputEnabled.checked=preferences.inputEnabled;
const persistPreferences=()=>{
  try{savePreferences({video:videoQuality,systemAudio:systemAudioEnabled.checked,inputEnabled:inputEnabled.checked,policy:inputProvider.policy});
    document.querySelector('#settings-save-status').textContent='设置已保存在本机。画质和声音在下次分享时生效。';}
  catch{document.querySelector('#settings-save-status').textContent='无法保存设置，本次运行仍可使用。';}
};
for(const input of [videoResolution,videoBitrateMode,videoBitrate,systemAudioEnabled])input.addEventListener('change',()=>{videoQuality=normalizeVideoQuality({resolution:videoResolution.value,bitrateMode:videoBitrateMode.value,bitrateKbps:videoBitrate.value});persistPreferences();});
let policyPending=false;
const outputLabels={touch:'Touch',mouse:'Mouse'};
const outputHelp={
  touch:{native:'Touch 直接输出为原生触控；不支持时不会自动转换。','mouse-drag':'单指按下立即按住鼠标左键，移动拖拽，抬手释放；可选中文字和拖动物体。',
    'mouse-scroll':'轻点松开时点击；移动超过 6 个本机坐标单位后开始滚动，不会按住鼠标；只支持单点。',
    'mouse-gestures':'轻点点击、滑动滚动、长按后拖拽；右键方式和捏合缩放可在下方配置。',disabled:'不协商和执行接收到的 Touch 输入。'},
  mouse:{native:'保持 Mouse 语义，包括本机支持的按钮与滚轮。',touch:'只将左键按下、移动、释放转换成单点 Touch；不转换悬停、右键或滚轮。',disabled:'不协商和执行接收到的 Mouse 输入。'},
};
const updatePolicyHelp=()=>{
  touchOutputHelp.textContent=outputHelp.touch[inputTouchOutput.value]??'';mouseOutputHelp.textContent=outputHelp.mouse[inputMouseOutput.value]??'';
  gestureSettings.hidden=inputTouchOutput.value!=='mouse-gestures';
  gestureHoldValue.value=`${gestureHold.value} ms`;
  gestureRightHold.min=gestureHold.value;
  if(Number(gestureRightHold.value)<Number(gestureHold.value))gestureRightHold.value=gestureHold.value;
  gestureRightHoldValue.value=`${gestureRightHold.value} ms`;
  gestureRightHoldLabel.hidden=gestureRightClick.value!=='hold';
  gestureRightHelp.textContent=gestureRightClick.value==='hold'
    ?`静止长按 ${gestureRightHold.value}ms 后，光圈变紫，松手触发右键；移动开始拖拽后不会触发右键。右键等待不能短于拖拽等待。`
    :'双指轻点并松手触发右键；单指长按只准备拖拽，不触发右键。';
  gesturePinchHelp.textContent=gesturePinch.value==='browser-zoom'?'网页缩放使用前台应用的 ⌘＋/− 快捷键，非原生触控捏合；请先点按目标网页。':
    gesturePinch.value==='ctrl-wheel'?'Ctrl＋滚轮：适合 Windows 网页；Mac 可能按系统设置触发整屏缩放，请谨慎选择。':'捏合不输出缩放；不会误触双指右键。';
};
inputTouchOutput.addEventListener('change',updatePolicyHelp);
inputMouseOutput.addEventListener('change',updatePolicyHelp);
gestureHold.addEventListener('input',updatePolicyHelp);
gestureRightClick.addEventListener('change',updatePolicyHelp);
gestureRightHold.addEventListener('input',updatePolicyHelp);
gesturePinch.addEventListener('change',updatePolicyHelp);
async function renderPolicyConfiguration(){
  const config=await inputProvider.configuration();
  for(const [type,select]of [['touch',inputTouchOutput],['mouse',inputMouseOutput]]){
    select.replaceChildren(...config.options[type].map(item=>{
      const option=document.createElement('option');option.value=item.value;option.disabled=!item.supported;
      option.textContent=item.label+(item.supported?'':' · 本机不支持');return option;
    }));
    select.value=config.policy[type];select.disabled=policyPending;
  }
  inputPolicyApply.disabled=policyPending;
  gestureHold.value=String(config.gestureSettings.holdMs);gestureFeedback.checked=config.gestureSettings.feedback;
  gestureRightClick.value=config.gestureSettings.rightClick;gestureRightHold.min=String(config.gestureSettings.holdMs);gestureRightHold.value=String(config.gestureSettings.rightHoldMs);
  const pinchLabels={disabled:'关闭缩放','browser-zoom':'网页缩放 · ⌘＋/−','ctrl-wheel':'兼容缩放 · Ctrl＋滚轮'};
  gesturePinch.replaceChildren(...config.pinchActions.map(value=>{const option=document.createElement('option');option.value=value;option.textContent=pinchLabels[value];return option;}));
  gesturePinch.value=config.policy.gestures?.pinchAction??(config.pinchActions.includes('browser-zoom')?'browser-zoom':'disabled');
  updatePolicyHelp();
  inputPolicyStatus.textContent=`本机原生输出：${config.nativeInputTypes.map(type=>outputLabels[type]).join(' / ')||'暂无可用类型'}。转换仅在选择并应用后生效。`;
}
let permissionActionPending = false;
let permissionSettingsOpened = null;

const defaultEndpoint = new URLSearchParams(location.search).get('ws') || DEFAULT_ENDPOINT;
let selectedEndpoint = defaultEndpoint;
let selectedDevice = null;
let activeDevice = null;
let currentStatus = 'idle';
const settingsPage=mountSettings({document,isConnected:()=>['joined','connected','sharing'].includes(currentStatus)});
mountFeedback({document,invoke});
let codeDisplayRequestId = null;
let trustDevice = null;
let platformInfo = null;
let touchback;
let platformReady = Promise.resolve();
let controlGeneration = 0;
let capturePending = false;
let captureProvider = null;
let client;
let diagnosticLogger;
let videoQuality = normalizeVideoQuality({resolution: videoResolution.value, bitrateMode: videoBitrateMode.value, bitrateKbps: videoBitrate.value});
globalThis.__nearcastTouchbackDiagnostics = () => touchback ? {...touchback.diagnostics(), control: touchback.controlDiagnostics(),capture:captureProvider?.diagnostics()??null} : null;
const controlDiagnostics = document.querySelector('#touchback-diagnostics');
const renderControlDiagnostics = () => {
  if (controlDiagnostics) controlDiagnostics.textContent = JSON.stringify({...globalThis.__nearcastTouchbackDiagnostics(),media:client?.mediaDiagnostics??null}, null, 2);
  const audio=captureProvider?.diagnostics()?.audio;
  if(systemAudioStatus)systemAudioStatus.textContent=audio?.error?`系统声音不可用，视频继续：${audio.error}`:audio?.state==='capturing'?'正在分享默认播放设备的系统声音':captureProvider?.current?'本次分享没有音频轨道':'开始分享后采集系统声音';
};
// Full JSON diagnostics are observability, not a per-input rendering task.
// Limit DOM/stringification work while the high-rate input queue drains.
let controlDiagnosticsTimer=null;
const scheduleControlDiagnostics=()=>{
  if(controlDiagnosticsTimer!==null)return;
  controlDiagnosticsTimer=setTimeout(()=>{controlDiagnosticsTimer=null;renderControlDiagnostics();},150);
};
let mediaStatsPending=false;
setInterval(async()=>{
  if(mediaStatsPending)return;
  mediaStatsPending=true;
  try{await Promise.all([client?.refreshMediaDiagnostics?.(),inputProvider.refreshExecution?.()]);}catch{/* Statistics cannot stop media. */}
  finally{mediaStatsPending=false;renderControlDiagnostics();}
},1000);

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
  diagnosticLogger?.status(status);
  currentStatus = status;
  const connected = ['joined', 'connected', 'sharing'].includes(status);
  codeView.hidden = connected;
  castingView.hidden = !connected;
  settingsPage.render();
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
  provider: inputProvider,
  onStatus: (_status, state) => {
    const reasons = {LOCAL_INPUT_DISABLED:'反控未启用', APP_NOT_READY:'等待接收端建立反控会话', TARGET_UNBOUND:'等待接收端绑定投屏来源', CAPTURE_UNAVAILABLE:'请先分享整个屏幕', CAPTURE_CHANGED:'分享已停止，重新分享后等待接收端恢复反控', CAPTURE_GEOMETRY_CHANGED:'正在更新分享范围，反控暂时暂停', CAPTURE_MUTED:'采集已暂停', NATIVE_CLEANUP_PENDING:'等待释放上一次输入', NATIVE_PERMISSION_UNAVAILABLE:'本机输入不可用，请检查系统权限', NATIVE_DOMAIN_BUSY:'本机输入正由其他会话使用', NATIVE_GEOMETRY_UNAVAILABLE:'无法确认当前分享范围的坐标映射，请查看反控诊断', TARGET_CONTRACT_MISMATCH:'接收端反控协议版本不匹配', INPUT_SESSION_FAULT:'反控连接异常，可重建连接'};
    inputState.textContent = !state.localEnabled ? '反控未启用' : state.state === 'active' && state.sourceReady ? `反控已开启 · ${state.acceptedInputTypes.join(' / ')} · stream ${state.streamId}` : state.sourceReady ? '本机已就绪，等待接收端开启反控' : state.detail?.includes('BROWSER_WINDOW_INPUT_UNSUPPORTED') ? '窗口投屏可用；反控请改为分享整个屏幕' : state.detail?.includes('BROWSER_MULTIPLE_DISPLAYS_UNPROVEN') ? '未完成屏幕识别，反控暂不可用；请停止后重新分享整个屏幕' : state.detail?.includes('BROWSER_DISPLAY_LAYOUT_CHANGED') ? '显示布局已变化，请停止后重新分享以校验屏幕' : state.detail?.includes('BROWSER_DISPLAY_BINDING_RETIRED') ? '屏幕绑定已失效，请停止后重新分享' : state.detail?.includes('BROWSER_SOURCE_SIZE_UNPROVEN') ? '无法确认原始屏幕尺寸，反控暂不可用' : state.detail?.includes('capture_window_not_foreground') ? '窗口反控已暂停，请切回正在分享的窗口' : state.detail?.includes('minimized') ? '窗口已最小化，反控已暂停' : state.disabledReason === 'NATIVE_PROBE_FAILED' ? '无法读取本机输入能力，请重试或检查系统权限' : captureProvider && state.disabledReason === 'NATIVE_GEOMETRY_UNAVAILABLE' ? '正在确认分享范围，反控暂不可用' : state.disabledReason === 'INPUT_SESSION_FAULT' && state.detail?.includes('Input queue age') ? '输入处理积压，已释放触点；可重建反控连接' : reasons[state.disabledReason] || '正在准备反控';
    inputCleanup.hidden = !state.cleanupPending;
    inputReconnect.disabled = state.cleanupPending || !['connected','sharing'].includes(currentStatus);
    inputPolicyApply.disabled=policyPending||state.cleanupPending;
    touchbackStatus.textContent = touchbackSummary(platformInfo ?? {});
    scheduleControlDiagnostics();
  },
});
touchback = buildTouchback();
inputPolicyApply.addEventListener('click',async()=>{
  if(policyPending)return;
  const requested={touch:inputTouchOutput.value,mouse:inputMouseOutput.value,
    ...(inputTouchOutput.value==='mouse-gestures'?{gestures:{holdMs:Number(gestureHold.value),rightClick:gestureRightClick.value,rightHoldMs:Number(gestureRightHold.value),pinchAction:gesturePinch.value,feedback:gestureFeedback.checked}}:{})};
  policyPending=true;inputPolicyApply.disabled=true;inputTouchOutput.disabled=true;inputMouseOutput.disabled=true;
  for(const control of [gestureHold,gestureRightClick,gestureRightHold,gesturePinch,gestureFeedback])control.disabled=true;
  inputPolicyStatus.textContent='正在释放当前输入并应用转换配置…';
  try{
    await touchback.setOutputPolicy(requested);
    await renderPolicyConfiguration();
    persistPreferences();
    inputPolicyStatus.textContent='配置已应用。请在接收端重新开启反控；投屏保持连接。';
  }catch(error){
    await renderPolicyConfiguration().catch(()=>{});
    inputPolicyStatus.textContent=`未应用配置：${error.message||error}`;
  }finally{policyPending=false;inputTouchOutput.disabled=false;inputMouseOutput.disabled=false;inputPolicyApply.disabled=touchback.diagnostics().cleanupPending;
    for(const control of [gestureHold,gestureRightClick,gestureRightHold,gesturePinch,gestureFeedback])control.disabled=false;}
});
inputEnabled.addEventListener('change', () => { persistPreferences();void touchback.setEnabled(inputEnabled.checked); });
let haloPending=false;
const haloTimer=setInterval(async()=>{
  if(haloPending||inputProvider.policy.touch!=='mouse-gestures')return;
  haloPending=true;
  try{await inputProvider.refreshGestureFeedback();}catch{/* Feedback never controls input. */}
  finally{haloPending=false;}
},40);
window.addEventListener('beforeunload',()=>clearInterval(haloTimer));
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
client = new LauncherWebCastClient({
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
  onSessionEnded: () => { controlGeneration++; touchback.fence(); void captureProvider?.stop().catch(error => setError(castError,error)); },
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
    await touchback.setEnabled(inputEnabled.checked);
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
  try { client.videoQuality = videoQuality; await client.startScreenShare({video: true, audio: systemAudioEnabled.checked}); }
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
  const groups = [{protocol: 'webcast', label: 'NEARCAST RECEIVERS', icon: '▣'}];
  const available = devices.filter(device => device.protocol === 'webcast');
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
  refreshDevices.disabled = true; deviceStatus.textContent = 'Scanning for NearCast receivers…';
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
platformReady = loadPlatformInfo(invoke).then(async info => {
  platformInfo = info;
  document.querySelector('#system-audio-settings').hidden=false;
  document.querySelector('#capture-help').textContent = '系统选屏后会短暂显示四角校验标记；识别成功的整屏支持多屏反控。窗口仅投屏。';
  captureProvider = new BrowserCaptureMediaDevices({platform:info.os,invoke,mediaDevices:navigator.mediaDevices,
    onStatus: state => { if(state.binding==='calibrating')document.querySelector('#capture-help').textContent='正在识别分享的屏幕，请稍候；四角校验标记将自动消失。';else document.querySelector('#capture-help').textContent=state.displayBinding?.state==='bound'?'已确认分享的屏幕，可开启反控。':'系统选屏后自动识别屏幕；窗口仅投屏，识别失败可停止后重试。';if (state.error) setError(castError, new Error(state.error)); },
  });
  client.mediaDevices = captureProvider;
  permissionsPanel.hidden = info.os !== 'macos';
  if (info.os === 'macos') { renderPermissions(); refreshPermissions(); }
  platformStatus.textContent = platformSummary(info);
  touchbackStatus.textContent = touchbackSummary(info);
  touchback.status();
  try{await inputProvider.setOutputPolicy(preferences.policy);}
  catch{inputPolicyStatus.textContent='已保存的转换不适用于本机，当前使用原生输入。';}
  await touchback.setEnabled(inputEnabled.checked);
  await renderPolicyConfiguration().catch(error=>{inputPolicyStatus.textContent=`无法读取输入能力：${error.message||error}`;});
  return info;
}).catch(() => ({os: 'unknown', touchback: false, inputControl: 'none'}));
startDiscovery();
if(tauri.core?.invoke){
  diagnosticLogger=createDiagnostics({invoke,snapshot:()=>({status:currentStatus,input:touchback?.diagnostics(),capture:captureProvider?.diagnostics(),media:client?.mediaDiagnostics})});
  diagnosticLogger.status(currentStatus);
  window.addEventListener('error',()=>diagnosticLogger.error());
  window.addEventListener('unhandledrejection',()=>diagnosticLogger.error());
  window.addEventListener('beforeunload',()=>diagnosticLogger.stop());
  const exportButton=document.querySelector('#export-diagnostics'),exportStatus=document.querySelector('#diagnostics-export-status');
  exportButton.addEventListener('click',async()=>{
    exportButton.disabled=true;
    try{exportStatus.textContent='诊断已保存：'+await diagnosticLogger.export();}
    catch{exportStatus.textContent='无法导出诊断，请检查本机日志目录权限。';}
    finally{exportButton.disabled=false;}
  });
}
if (tauri.core?.invoke) {
  const updates = mountUpdates({document, invoke, listen, isSharing: () => Boolean(client.stream),
    beforeInstall: async () => {
      if (capturePending) throw new Error('正在选择分享范围，请先完成或取消分享。');
      await touchback.setEnabled(false);
      await touchback.fence('software update');
      if (touchback.diagnostics()?.cleanupPending) throw new Error('输入尚未释放，请先重试释放输入后再更新。');
      await client.stop();
      await captureProvider?.stop();
    },
  });
  window.addEventListener('beforeunload', () => updates.stop());
}
