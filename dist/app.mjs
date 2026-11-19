import {LauncherWebCastClient, DEFAULT_ENDPOINT} from './webcast/launcher-webcast-client.mjs';
import {browserPlatform} from './webcast/source-info.mjs';
import {localSocketFactory,signalingChoice} from './webcast/local-signaling.mjs';
import {ReceiverTrust} from './webcast/receiver-trust.mjs';
import {WebCastTouchbackSender} from './webcast/touchback-sender.mjs';
import {showInputConsent} from './touchback/consent-ui.mjs';
import {createPlatformInputAdapter} from './touchback/platform-input.mjs';
import {TauriDeviceDiscovery} from './tauri-device-discovery.mjs';
import {loadPlatformInfo, touchbackSummary} from './platform-capabilities.mjs';
import {mountCaptureError} from './capture/capture-error-ui.mjs';
import {canAttachTouchbackChannel} from './webcast/touchback-channel-policy.mjs';
import {normalizeVideoQuality,VIDEO_FRAME_RATE} from './webcast/video-quality.mjs';
import {MacOsPermissions} from './macos-permissions.mjs';
import {mountDiscoveryPermissions} from './discovery-permissions-ui.mjs';
import {mountFeaturePermissions} from './feature-permissions.mjs';
import {mountMacOsPermissionOnboarding} from './macos-permission-onboarding.mjs';
import {BrowserCaptureMediaDevices} from './capture/browser-capture.mjs';
import {mountUpdates} from './update/update-ui.mjs';
import {createDiagnostics} from './diagnostics.mjs';
import {loadPreferences,savePreferences,mountSettings,mountFeedback} from './settings.mjs';
import {mountPairingInput} from './pairing-input.mjs';
import {mountWindowControls} from './window-controls.mjs';
import {i18n} from './i18n.mjs';
import {mountTheme} from './theme.mjs';
import {DEFAULT_OUTPUT_POLICY} from './touchback/output-policy.mjs';

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
const castingInputEnabled = document.querySelector('#casting-input-enabled');
const castingAudioEnabled = document.querySelector('#casting-system-audio-enabled');
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
const themeSelect=document.querySelector('#theme-select');
const theme=mountTheme({document,preference:preferences.theme,invoke:tauri.core?.invoke});
themeSelect.value=preferences.theme;
const languageSelect=document.querySelector('#language-select');
languageSelect.value=preferences.language;i18n.setLanguage(preferences.language);
const localSignalingEnabled=document.querySelector('#local-signaling-enabled');
localSignalingEnabled.checked=preferences.localSignaling;
let codeRoute=null;
videoResolution.value=preferences.video.resolution;videoBitrateMode.value=preferences.video.bitrateMode;videoBitrate.value=String(preferences.video.bitrateKbps);
systemAudioEnabled.checked=preferences.systemAudio;inputEnabled.checked=preferences.inputEnabled;
const persistPreferences=()=>{
  try{savePreferences({video:videoQuality,language:languageSelect.value,theme:themeSelect.value,localSignaling:localSignalingEnabled.checked,systemAudio:systemAudioEnabled.checked,inputEnabled:inputEnabled.checked,policy:inputProvider.policy});
    i18n.text(document.querySelector('#settings-save-status'),'settings.saved');}
  catch{i18n.text(document.querySelector('#settings-save-status'),'settings.saveFailed');}
  renderCastingPreferences();
};
languageSelect.addEventListener('change',()=>{i18n.setLanguage(languageSelect.value);persistPreferences();});
themeSelect.addEventListener('change',()=>{theme.setPreference(themeSelect.value);persistPreferences();});
for(const input of [videoResolution,videoBitrateMode,videoBitrate])input.addEventListener('change',()=>{videoQuality=normalizeVideoQuality({resolution:videoResolution.value,bitrateMode:videoBitrateMode.value,bitrateKbps:videoBitrate.value});persistPreferences();});
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
let sessionAccepted = false;
let permissionOnboarding;
const settingsPage=mountSettings({document,isConnected:()=>['joined','connected','sharing'].includes(currentStatus),
  isOnboarding:()=>permissionOnboarding?.active===true,
  onSelectTab:tab=>{if(tab==='permissions')void refreshPermissions();}});
mountFeedback({document,invoke});
let codeDisplayRequestId = null;
let trustDevice = null;
let platformInfo = null;
let touchback;
let platformReady = Promise.resolve();
let controlGeneration = 0;
let capturePending = false;
let captureProvider = null;
let featurePermissions;
let client;
let diagnosticLogger;
const windowCaptureActive=()=>{
  const track=client?.stream?.getVideoTracks()[0]??captureProvider?.current?.track;
  return track?.readyState==='live'&&['window','browser'].includes(track.getSettings?.().displaySurface);
};
const renderCastingPreferences=(state=touchback?.diagnostics())=>{
  const windowCapture=windowCaptureActive();
  inputEnabled.disabled=windowCapture||featurePermissions?.state('input').checking===true;
  systemAudioEnabled.disabled=featurePermissions?.state('audio').checking===true;
  const receiverUnavailable=state?.receiverSupported===false||state?.receiverEnabled===false;
  castingInputEnabled.checked=inputEnabled.checked&&!receiverUnavailable&&!windowCapture;
  castingInputEnabled.disabled=inputEnabled.disabled||!state?.appReady||!state?.receiverStateReady||state?.receiverSupported!==true||state?.receiverEnabled!==true;
  i18n.text(document.querySelector('#settings-input-help'),windowCapture?'cast.remoteWindow':'settings.remoteHelp');
  for(const control of [inputEnabled,castingInputEnabled])i18n.attribute(control,'title',windowCapture?'cast.remoteWindow':'cast.remoteHelp');
  i18n.text(document.querySelector('#casting-input-help'),windowCapture?'cast.remoteWindow':inputEnabled.disabled?'onboarding.checking':state?.receiverSupported===false?'cast.remoteUnsupported'
    :state?.receiverEnabled===false?'cast.remoteOff'
    :castingInputEnabled.disabled?'cast.remoteWaiting':'cast.remoteHelp');
  const request=document.querySelector('#input-request-control');
  if(request)request.disabled=castingInputEnabled.disabled||!state?.sourceReady;
  const sharing=Boolean(client?.stream);
  const audio=captureProvider?.diagnostics()?.audio;
  const hasAudio=sharing&&client.stream.getAudioTracks().some(track=>track.readyState==='live');
  castingAudioEnabled.checked=sharing?hasAudio:systemAudioEnabled.checked;
  castingAudioEnabled.disabled=systemAudioEnabled.disabled||capturePending||sharing;
  shareButton.disabled=capturePending||systemAudioEnabled.disabled||!['connected','sharing'].includes(currentStatus);
  i18n.text(document.querySelector('#casting-audio-help'),systemAudioEnabled.disabled?'onboarding.checking':sharing?audio?.error?'audio.error':hasAudio?'cast.audioLive':'cast.audioNone':'cast.audioNext',{error:i18n.error(audio?.error)});
};
for(const [shortcut,setting]of [[castingInputEnabled,inputEnabled],[castingAudioEnabled,systemAudioEnabled]]){
  shortcut.addEventListener('change',()=>{if(shortcut.disabled){renderCastingPreferences();return;}setting.checked=shortcut.checked;setting.dispatchEvent(new Event('change'));});
}
let windowDiagnostics={};
const diagnosticWindow=()=>({...windowDiagnostics,pageVisibility:document.visibilityState});
let videoQuality = normalizeVideoQuality({resolution: videoResolution.value, bitrateMode: videoBitrateMode.value, bitrateKbps: videoBitrate.value});
globalThis.__nearcastTouchbackDiagnostics = () => touchback ? {...touchback.diagnostics(), control: touchback.controlDiagnostics(),capture:captureProvider?.diagnostics()??null} : null;
const controlDiagnostics = document.querySelector('#touchback-diagnostics');
const renderControlDiagnostics = () => {
  if (controlDiagnostics) controlDiagnostics.textContent = JSON.stringify({...globalThis.__nearcastTouchbackDiagnostics(),media:client?.mediaDiagnostics??null,window:diagnosticWindow()}, null, 2);
  const flow=touchback?.diagnostics()?.inputFlow;
  document.querySelector('#input-flow').textContent=flow&&inputEnabled.checked?`最近 1 秒：接收 ${flow.receivedPerSecond} / 执行 ${flow.submittedPerSecond} 次 · 最近桥接等待 ${Math.round(flow.lastBridgeOverheadMs)} ms`:'';
  const scroll=touchback?.diagnostics()?.scroll;
  if(scroll){const r=scroll.detent120.received,s=scroll.detent120.submitted;
    document.querySelector('#scroll-diagnostic-summary').textContent=`滚轮诊断版 · 累计纵轴（正／负）：接收 ${r.positiveY}／${r.negativeY}，提交 ${s.positiveY}／${s.negativeY} · 原始包 ${r.samples}，提交调用 ${s.samples}。测试后点击“导出诊断”。`;}
  const audio=captureProvider?.diagnostics()?.audio;
  if(systemAudioStatus)i18n.text(systemAudioStatus,audio?.error?'audio.error':audio?.state==='capturing'?'audio.capturing':captureProvider?.current?'audio.disabled':'audio.idle',{error:i18n.error(audio?.error)});
  renderCastingPreferences();
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
  try{await Promise.allSettled([client?.refreshMediaDiagnostics?.(),inputProvider.refreshExecution?.(),
    invoke('nearcast_window_action',{action:{kind:'state'}}).then(value=>{windowDiagnostics={minimized:value?.minimized,visible:value?.visible,sampledAt:Date.now()};})]);}catch{/* Statistics cannot stop media. */}
  finally{mediaStatsPending=false;renderControlDiagnostics();diagnosticLogger?.scroll();diagnosticLogger?.media();}
},1000);

const captureErrors=mountCaptureError({document,permissions,platform:()=>platformInfo,
  onSettingsOpened:()=>{permissionSettingsOpened='screenRecording';},onPermissionsChanged:()=>renderPermissions()});
const setError = (element, error) => {
  if(element===castError){captureErrors.show(error);return;}
  element.textContent = error ? i18n.error(error) : '';
  if(error)element.dataset.errorMessage=error.message||String(error);else delete element.dataset.errorMessage;
  element.hidden = !error;
};
const setCodeDisplayStatus = (key,values={}) => { if(key)i18n.text(codeDisplayStatus,key,values);else{delete codeDisplayStatus.dataset.i18n;codeDisplayStatus.textContent='';} };
const renderVideoQuality = () => {
  videoQuality = normalizeVideoQuality({resolution: videoResolution.value, bitrateMode: videoBitrateMode.value, bitrateKbps: videoBitrate.value});
  const resolution = videoQuality.resolution === 'auto' ? i18n.t('quality.auto') : videoQuality.resolution.replace('x', ' × ');
  videoQualitySummary.textContent = `${i18n.t(videoQuality.bitrateMode === 'fixed' ? 'quality.fixed' : 'quality.dynamic')} · ${resolution} · ${VIDEO_FRAME_RATE} FPS${videoQuality.bitrateMode === 'fixed' ? ` · ${videoQuality.bitrateKbps / 1000} Mbps` : ''}`;
  videoBitrate.disabled = false;
};
videoResolution.addEventListener('change', renderVideoQuality);
videoBitrateMode.addEventListener('change', renderVideoQuality);
videoBitrate.addEventListener('change', renderVideoQuality);
renderVideoQuality();
const renderTrust = state => {
  if (state?.phase === 'checking') setCodeDisplayStatus('pair.connecting');
  else if (['error','changed'].includes(state?.phase)) setCodeDisplayStatus(String(state.error).includes('NEARCAST_KEY_MISMATCH')
    ?'pair.changed':'pair.failed',{error:i18n.error(state.error)});
};
const codeValue = () => digits.map(input => input.value.trim()).join('').toUpperCase();
const setView = status => {
  diagnosticLogger?.status(status);
  currentStatus = status;
  const connected = ['joined', 'connected', 'sharing'].includes(status);
  if(!connected)captureErrors.show(null);
  if(connected)sessionAccepted=true;
  codeView.hidden = connected;
  castingView.hidden = !connected;
  settingsPage.render();
  connectButton.disabled = status !== 'idle';
  digits.forEach(input => { input.disabled = status !== 'idle'; });
  shareButton.disabled = capturePending || !['connected', 'sharing'].includes(status);
  deviceGroups.querySelectorAll('.device-row.selectable').forEach(row => { row.disabled = status !== 'idle'; });
  i18n.text(castStatus,status==='sharing'?'cast.sharing':status==='connected'?'cast.ready':'pair.connecting');
  castingView.dataset.status=status;
  document.querySelector('#connect-tab-devices').disabled=status!=='idle';
  document.querySelector('#return-to-devices').disabled=status!=='idle';
  if(status==='idle')document.querySelector('#session-details').open=false;
  if(status==='idle'&&sessionAccepted){sessionAccepted=false;activeDevice=null;returnToDevices();}
  renderCastingPreferences();
};
const pairingInput=mountPairingInput({inputs:digits,help:document.querySelector('#pair-input-help'),onChange:()=>setError(codeError,null)});

const buildTouchback = () => new WebCastTouchbackSender({
  provider: inputProvider,
  onConsentRequest:async options=>{
    if(platformInfo?.os==='macos'&&!await featurePermissions.check('input')){
      await invoke('nearcast_window_action',{action:{kind:'show'}}).catch(()=>{});return false;
    }
    return showInputConsent(options,{showWindow:()=>invoke('nearcast_window_action',{action:{kind:'show'}})});
  },
  onEnabledChanged:enabled=>{inputEnabled.checked=enabled;persistPreferences();},
  onStatus: (_status, state) => {
    if(platformInfo?.os==='macos'&&state.disabledReason==='NATIVE_PERMISSION_UNAVAILABLE'&&inputEnabled.checked){
      inputEnabled.checked=false;featurePermissions?.require('input');persistPreferences();
      void Promise.resolve().then(()=>touchback.setEnabled(false)).catch(()=>{});
    }
    const reasons = {LOCAL_INPUT_DISABLED:'反控未启用', APP_NOT_READY:'等待接收端建立反控会话', TARGET_UNBOUND:'等待接收端绑定投屏来源', CAPTURE_UNAVAILABLE:'请先分享整个屏幕', CAPTURE_CHANGED:'分享已停止，重新分享后等待接收端恢复反控', CAPTURE_GEOMETRY_CHANGED:'正在更新分享范围，反控暂时暂停', CAPTURE_MUTED:'采集已暂停', NATIVE_CLEANUP_PENDING:'等待释放上一次输入', NATIVE_PERMISSION_UNAVAILABLE:'本机输入不可用，请检查系统权限', NATIVE_DOMAIN_BUSY:'本机输入正由其他会话使用', NATIVE_GEOMETRY_UNAVAILABLE:'无法确认当前分享范围的坐标映射，请查看反控诊断', TARGET_CONTRACT_MISMATCH:'接收端反控协议版本不匹配', INPUT_SESSION_FAULT:'反控连接异常，可重建连接'};
    inputState.textContent = !state.localEnabled ? '反控未启用' : state.state === 'active' && state.sourceReady ? `反控已开启 · ${state.acceptedInputTypes.join(' / ')} · stream ${state.streamId}` : state.sourceReady ? '本机已就绪，等待接收端开启反控' : state.detail?.includes('BROWSER_WINDOW_INPUT_UNSUPPORTED') ? '窗口投屏可用；反控请改为分享整个屏幕' : state.detail?.includes('BROWSER_MULTIPLE_DISPLAYS_UNPROVEN') ? '未完成屏幕识别，反控暂不可用；请停止后重新分享整个屏幕' : state.detail?.includes('BROWSER_DISPLAY_LAYOUT_CHANGED') ? '显示布局已变化，请停止后重新分享以校验屏幕' : state.detail?.includes('BROWSER_DISPLAY_BINDING_RETIRED') ? '屏幕绑定已失效，请停止后重新分享' : state.detail?.includes('BROWSER_SOURCE_SIZE_UNPROVEN') ? '无法确认原始屏幕尺寸，反控暂不可用' : state.detail?.includes('capture_window_not_foreground') ? '窗口反控已暂停，请切回正在分享的窗口' : state.detail?.includes('minimized') ? '窗口已最小化，反控已暂停' : state.disabledReason === 'NATIVE_PROBE_FAILED' ? '无法读取本机输入能力，请重试或检查系统权限' : captureProvider && state.disabledReason === 'NATIVE_GEOMETRY_UNAVAILABLE' ? '正在确认分享范围，反控暂不可用' : state.disabledReason === 'INPUT_SESSION_FAULT' && state.detail?.includes('Input queue age') ? '输入处理积压，已释放触点；可重建反控连接' : reasons[state.disabledReason] || '正在准备反控';
    inputCleanup.hidden = !state.cleanupPending;
    inputReconnect.disabled = state.cleanupPending || !['connected','sharing'].includes(currentStatus);
    inputPolicyApply.disabled=policyPending||state.cleanupPending;
    touchbackStatus.textContent = touchbackSummary(platformInfo ?? {});
    renderCastingPreferences(state);
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
const setFeatureEnabled=async(feature,wanted)=>{
  const control=feature==='input'?inputEnabled:systemAudioEnabled;
  if(feature==='input'&&wanted&&windowCaptureActive()){
    control.checked=touchback.diagnostics().localEnabled;renderCastingPreferences();return false;
  }
  if(!wanted)featurePermissions.cancel(feature);
  else if(!platformInfo||platformInfo.os==='macos'){
    control.checked=false;renderCastingPreferences();await platformReady;
    if(!await featurePermissions.check(feature)){persistPreferences();return false;}
    if(feature==='input'&&windowCaptureActive()){
      control.checked=touchback.diagnostics().localEnabled;renderCastingPreferences();return false;
    }
  }
  control.checked=wanted;persistPreferences();
  if(feature==='input')await touchback.setEnabled(wanted);
  return wanted;
};
systemAudioEnabled.addEventListener('change',()=>{void setFeatureEnabled('audio',systemAudioEnabled.checked);});
inputEnabled.addEventListener('change', async () => {
  const enabled=await setFeatureEnabled('input',inputEnabled.checked);
  if(enabled&&touchback.diagnostics().sourceReady){
    try{await touchback.requestReceiverControl(true);}catch(error){inputState.textContent=`反控未开启：${error.message||error}`;}
  }
});
const requestControl=document.createElement('button');requestControl.id='input-request-control';requestControl.type='button';requestControl.className='button secondary';requestControl.textContent='在接收端开启反控';
inputState.after(requestControl);requestControl.addEventListener('click',async()=>{
  requestControl.disabled=true;
  try{if(!inputEnabled.checked&&!await setFeatureEnabled('input',true))return;await touchback.requestReceiverControl(true);}
  catch(error){inputState.textContent=`反控未开启：${error.message||error}`;}
  finally{renderCastingPreferences();}
});
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
  sourceIdentity:()=>({clientKind:tauri.core?.invoke?'desktop':'web',platform:tauri.core?.invoke?platformInfo?.os??'unknown':browserPlatform(),product:tauri.core?.invoke?'nearhub-cast':'webcast'}),
  endpoint: selectedEndpoint,
  videoQuality,
  codeDisplayTransport: ({instance, request}) => invoke('nearcast_code_display', {instance, request}),
  onStatus: setView,
  onError: async error => { await client.stop({notify: false}); activeDevice = null;setError(codeError, error); },
  onCodeDisplayResult: result => {
    if (result.requestId !== codeDisplayRequestId) return;
    codeRoute=result.status==='shown'?{backend:result.backend??'cloud',deviceId:result.deviceId,runtimeInstanceId:result.runtimeInstanceId}:null;
    const messages = {shown:'pair.shown',unavailable:'pair.unavailable',rate_limited:'pair.rateLimited',not_supported:'pair.noDisplay'};
    setCodeDisplayStatus(messages[result.status] || '');
  },
  onCodeDisplayError: (error, request) => {
    if (request.requestId !== codeDisplayRequestId) return;
    setCodeDisplayStatus('pair.displayFailed',{error:i18n.error(error)});
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
    document.querySelector('#preview-empty').hidden = Boolean(stream);
    shareButton.hidden = Boolean(stream);
    stopShareButton.hidden = !stream;
    if (stream) preview.play?.().catch(() => {});
    renderCastingPreferences();
  },
});

const requestCodeDisplayFor = device => {
  if (!device?.supportsCodeDisplay) { setCodeDisplayStatus('pair.noDisplay'); return; }
  try {const choice=signalingChoice(device,localSignalingEnabled.checked);codeRoute=null;
    codeDisplayRequestId = client.requestCodeDisplay({device: {...device, trustRequired: true, trustState: trustDevice && trustDevice.discoveryId === device.discoveryId && trustManager.state.phase === 'trusted' ? 'trusted' : 'untrusted'},backend:choice.backend, reason: 'sender-device-selected'}); }
  catch (error) { setCodeDisplayStatus('pair.displayFailed',{error:i18n.error(error)}); }
};

const trustManager = new ReceiverTrust({invoke, automatic:true, onChange: renderTrust, onTrusted: device => {
  if (!trustDevice || device.discoveryId !== trustDevice.discoveryId || currentStatus !== 'idle') return;
  trustDevice = device;
  if (device.supportsCodeDisplay) { setCodeDisplayStatus('pair.showing'); requestCodeDisplayFor(device); }
  else setCodeDisplayStatus('pair.look');
}});
const clearSelectedDevice=()=>{
  trustManager.cancel();trustDevice=null;selectedDevice=null;codeRoute=null;selectedEndpoint=defaultEndpoint;client.endpoint=defaultEndpoint;
  client.cancelCodeDisplay();codeDisplayRequestId=null;setCodeDisplayStatus('');setError(codeError,null);
  const name=document.querySelector('#pair-device-name');name.hidden=true;name.textContent='';name.removeAttribute('title');
  pairingInput.clear();
};
const connectionTabs=[document.querySelector('#connect-tab-code'),document.querySelector('#connect-tab-devices')];
const selectConnectionTab=tab=>{
  const manual=tab===connectionTabs[0];
  codeView.dataset.connection=manual?'code':'devices';
  document.documentElement.dataset.connection=codeView.dataset.connection;
  for(const button of connectionTabs){const selected=button===tab;button.setAttribute('aria-pressed',String(selected));button.tabIndex=0;document.getElementById(button.getAttribute('aria-controls')).hidden=!selected;}
  i18n.text(document.querySelector('#connect-heading'),'home.welcome');
  i18n.text(document.querySelector('#connect-description'),'home.description');
};
selectConnectionTab(connectionTabs[1]);
const returnToDevices=()=>{
  clearSelectedDevice();selectConnectionTab(connectionTabs[1]);
  if(!settingsPage.active)document.querySelector('#refresh-devices').focus();
};
document.querySelector('#return-to-devices').addEventListener('click',()=>{
  if(currentStatus==='idle')returnToDevices();
});
for(const tab of connectionTabs)tab.addEventListener('click',()=>{
  if(tab===connectionTabs[1]){if(currentStatus==='idle')returnToDevices();return;}
  selectConnectionTab(tab);
  digits[0].focus();
});
localSignalingEnabled.addEventListener('change',()=>{
  persistPreferences();codeRoute=null;client.cancelCodeDisplay();codeDisplayRequestId=null;
  if(currentStatus==='idle')selectConnectionTab(connectionTabs[localSignalingEnabled.checked?1:0]);
  if(currentStatus==='idle'&&selectedDevice)void trustManager.select(selectedDevice);
});

pairForm.addEventListener('submit', async event => {
  event.preventDefault();
  if(currentStatus!=='idle')return;
  const pairCode = codeValue();
  if (!/^[A-Z0-9]{4}$/.test(pairCode)) { setError(codeError, new Error('请输入 4 位字母或数字配对码')); return; }
  setError(codeError, null);
  if (selectedDevice && selectedDevice.expiresAt <= Date.now()) { setError(codeError, new Error('接收端发现已过期，请重新扫描并选择设备。')); return; }
  let choice;
  try{
    choice=signalingChoice(selectedDevice,localSignalingEnabled.checked);
    if(selectedDevice?.signaling&&(!codeRoute||codeRoute.backend!==choice.backend||codeRoute.deviceId!==selectedDevice.deviceId||codeRoute.runtimeInstanceId!==selectedDevice.signaling.runtimeInstanceId))
      throw new Error('请先请求接收端显示当前连接方式的配对码，再连接。');
  }catch(error){setError(codeError,error);return;}
  activeDevice = selectedDevice;
  trustManager.cancel(); trustDevice = null; client.cancelCodeDisplay(); codeDisplayRequestId = null;
  client.endpoint = selectedEndpoint;
  client.socketFactory=choice.backend==='local'?localSocketFactory({invoke,listen,device:structuredClone(selectedDevice)}):null;
  client.rtcConfiguration=choice.backend==='local'?{iceServers:[]}:undefined;
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
  if (capturePending||featurePermissions?.state('audio').checking) return;
  capturePending = true; shareButton.disabled = true;
  renderCastingPreferences();
  setError(castError, null);
  if(platformInfo?.os==='macos'&&systemAudioEnabled.checked&&permissions.snapshot.screenRecording!=='granted'){
    systemAudioEnabled.checked=false;featurePermissions.require('audio',permissions.snapshot.screenRecording==='not_granted'?'required':'unknown');persistPreferences();
  }
  try { client.videoQuality = videoQuality; await client.startScreenShare({video: true, audio: systemAudioEnabled.checked}); }
  catch (error) { if(['connected','sharing'].includes(currentStatus))await captureErrors.report(error); }
  finally { capturePending = false; shareButton.disabled = !['connected', 'sharing'].includes(currentStatus); renderCastingPreferences(); }
});
stopShareButton.addEventListener('click', async () => { setError(castError, null); await client.stopStream(); });
leaveButton.addEventListener('click', async () => { setError(castError, null); touchback.fence(); await client.stop(); });
window.addEventListener('beforeunload', () => { touchback.fence(); trustManager.cancel(); client.stop({notify: false}); });

const discoveryPermissions=mountDiscoveryPermissions({document,permissions,platform:()=>platformInfo,
  onSettingsOpened:()=>{permissionSettingsOpened='localNetwork';},onPermissionsChanged:()=>{renderPermissions();captureErrors.permissionsChanged();}});
const reconcileFeaturePermissions=({initial=false}={})=>{
  if(platformInfo?.os!=='macos')return;
  let changed=false;
  for(const [feature,control,permission]of [['audio',systemAudioEnabled,'screenRecording'],['input',inputEnabled,'accessibility']]){
    const value=permissions.snapshot[permission];
    if(control.checked&&(initial?value!=='granted':value==='not_granted')){
      control.checked=false;changed=true;
      if(initial)featurePermissions.cancel(feature);else featurePermissions.require(feature);
      if(feature==='input')void touchback.setEnabled(false).catch(()=>{});
    }
  }
  featurePermissions.permissionsChanged();if(changed)persistPreferences();
};
featurePermissions=mountFeaturePermissions({document,permissions,platform:()=>platformInfo,
  onSettingsOpened:permission=>{permissionSettingsOpened=permission;},onChange:()=>renderCastingPreferences(),
  onPermissionsChanged:()=>{renderPermissions();captureErrors.permissionsChanged();discoveryPermissions.permissionsChanged();reconcileFeaturePermissions();}});
const renderDevices = devices => {
  if (selectedDevice && currentStatus === 'idle') {
    const current = devices.find(device => device.discoveryId === selectedDevice.discoveryId && device.selectable);
    if (!current || current.instance !== selectedDevice.instance || current.endpoint !== selectedDevice.endpoint || current.deviceId !== selectedDevice.deviceId || current.capability !== selectedDevice.capability||current.signaling?.runtimeInstanceId!==selectedDevice.signaling?.runtimeInstanceId) {
      clearSelectedDevice();
      setCodeDisplayStatus('pair.offline');
    } else {
      selectedDevice = current;
      document.querySelector('#pair-device-name').textContent=current.displayName;
      document.querySelector('#pair-device-name').title=current.displayName;
      if (trustDevice) { trustDevice = current; trustManager.device = current; }
    }
  }
  deviceGroups.replaceChildren(discoveryPermissions.element);
  discoveryPermissions.devicesChanged(devices);
  const groups = [{protocol: 'webcast'}];
  const available = devices.filter(device => device.protocol === 'webcast');
  i18n.text(deviceStatus,available.length?'discovery.found':'discovery.empty',{count:available.length});
  for (const group of groups) {
    const entries = devices.filter(device => device.protocol === group.protocol);
    if (!entries.length) continue;
    const section = document.createElement('div'); section.className = 'device-group';
    for (const device of entries) {
      const row = document.createElement('button'); row.type = 'button'; row.className = `device-row ${device.selectable ? 'selectable' : 'disabled'}`;
      row.disabled = !device.selectable || currentStatus !== 'idle';
      row.setAttribute('aria-pressed', String(device.selectable && device.discoveryId === selectedDevice?.discoveryId));
      row.innerHTML = `<img class="device-icon" src="./assets/figma/display.svg" width="28" height="28" alt="" /><span class="device-copy"><span class="device-name"></span><span class="device-meta"></span></span><img class="row-chevron" src="./assets/figma/chevron.svg" width="20" height="20" alt="" />`;
      row.querySelector('.device-name').textContent = device.displayName;
      row.querySelector('.device-meta').textContent = device.addresses?.[0] ? `${device.addresses[0]}${device.port ? `:${device.port}` : ''}` : device.hostname || device.model || device.protocol;
      row.title=[device.displayName,row.querySelector('.device-meta').textContent,device.selectable?'':i18n.t('discovery.displayOnly')].filter(Boolean).join(' · ');
      if (device.selectable) row.addEventListener('click', () => {
        if (currentStatus !== 'idle') return;
        client.cancelCodeDisplay(); codeDisplayRequestId = null;
        if (selectedDevice?.discoveryId !== device.discoveryId) pairingInput.clear();
        selectedDevice = device; trustDevice = device; selectedEndpoint = defaultEndpoint; client.endpoint = selectedEndpoint;
        codeRoute=null;
        document.querySelector('#pair-device-name').textContent=device.displayName;
        document.querySelector('#pair-device-name').title=device.displayName;
        document.querySelector('#pair-device-name').hidden=false;
        selectConnectionTab(connectionTabs[0]);digits[0].focus();setError(codeError, null);
        setCodeDisplayStatus('pair.connecting');
        trustManager.select(device);
      });
      section.append(row);
    }
    deviceGroups.append(section);
  }
};

const discovery = new TauriDeviceDiscovery({invoke, listen});
let startupDiscoveryStarted=false;
const startDiscovery = async ({checkPermissions=true}={}) => {
  if(refreshDevices.disabled)return;
  trustManager.cancel(); trustDevice = null; client.cancelCodeDisplay(); codeDisplayRequestId = null;
  refreshDevices.disabled = true;i18n.text(deviceStatus,'discovery.scanning');
  discoveryPermissions.scanStarted();
  try { await discovery.stop().catch(() => {}); await discovery.start(renderDevices); }
  catch (error) { i18n.text(deviceStatus,'discovery.failed',{error:i18n.error(error)}); }
  finally { if(checkPermissions&&platformInfo?.os==='macos')await refreshPermissions();discoveryPermissions.scanFinished();refreshDevices.disabled = false; }
};
refreshDevices.addEventListener('click', startDiscovery);
const startStartupDiscovery=()=>{
  if(startupDiscoveryStarted)return;
  startupDiscoveryStarted=true;
  return startDiscovery({checkPermissions:false});
};

const renderPermissions = () => {
  const mac=platformInfo?.os==='macos',os=platformInfo?.os??'unknown';
  const presentation={
    localNetwork:{title:'Local Network',help:'Discover and connect to NearHub Cast receivers on your local network.',icon:'permission-network.png'},
    screenRecording:{title:'Screen & System Audio Recording',help:'Capture and share the selected screen.',icon:'permission-screen.png'},
    accessibility:{title:'Accessibility',help:'Allow the receiver to control your mouse.',icon:'permission-accessibility.png'},
  };
  if(permissionRows.dataset.platform!==os){permissionRows.replaceChildren();permissionRows.dataset.platform=os;}
  for (const [index,row] of permissions.rows().entries()) {
    const copy=presentation[row.id];
    let item=permissionRows.querySelector(`[data-permission-row="${row.id}"]`);
    if(!item){
      if(index){const divider=document.createElement('img');divider.className='permission-divider';divider.src='./assets/figma/settings-divider.svg';divider.alt='';permissionRows.append(divider);}
      item=document.createElement('div');item.className='permission-row';item.dataset.permissionRow=row.id;
      const body=document.createElement('div');body.className='permission-copy';
      const icon=document.createElement('img');icon.className='permission-icon';icon.src='./assets/figma/'+copy.icon;icon.alt='';icon.width=40;icon.height=40;
      const text=document.createElement('div');
      const title=document.createElement('span');title.className='permission-title';
      const help=document.createElement('p');help.className='permission-detail';
      const state=document.createElement('span');state.id=`permission-status-${row.id}`;state.className=mac?'permission-state sr-only':'permission-platform-state';state.setAttribute('aria-live','polite');
      text.append(title,help);body.append(icon,text);item.append(body);
      if(mac){
        const toggle=document.createElement('button');toggle.type='button';toggle.className='permission-toggle';toggle.dataset.permission=row.id;
        toggle.setAttribute('aria-describedby',state.id);
        toggle.addEventListener('click',async()=>{
          if(permissionActionPending)return;
          permissionActionPending=true;permissionSettingsOpened=row.id;setError(permissionsError,null);renderPermissions();
          try{await permissions.openSettings(row.id);}catch(error){setError(permissionsError,error);}
          finally{permissionActionPending=false;renderPermissions();}
        });
        item.append(state,toggle);
      }else item.append(state);
      permissionRows.append(item);
    }
    i18n.text(item.querySelector('.permission-title'),'permission.'+row.id);
    i18n.text(item.querySelector('.permission-detail'),'permission.'+(row.id==='screenRecording'&&mac&&platformInfo.screenCapturePermission!=='required'?'screenAudioHelp':{localNetwork:'localHelp',screenRecording:'screenHelp',accessibility:'accessibilityHelp'}[row.id]));
    const state=item.querySelector(`#permission-status-${row.id}`);
    if(mac){
      const toggle=item.querySelector('button');toggle.disabled=permissionActionPending;
      toggle.setAttribute('aria-label',i18n.t('permission.open',{name:i18n.t('permission.'+row.id)}));toggle.title=toggle.getAttribute('aria-label');
      const value=row.enabled===null?'unknown':row.enabled?'on':'off';
      if(toggle.dataset.state!==value){
        toggle.dataset.state=value;toggle.replaceChildren();
        if(value==='unknown')toggle.textContent='?';
        else{const image=document.createElement('img');image.src=`./assets/figma/switch-${value}.svg`;image.alt='';toggle.append(image);}
      }
      if(row.enabled===null){toggle.removeAttribute('role');toggle.removeAttribute('aria-checked');}
      else{toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(row.enabled));}
      i18n.text(state,row.enabled===null?'permission.checkSystem':row.enabled?(row.id==='localNetwork'?'permission.available':'permission.on'):'permission.off');
    }else i18n.text(state,os==='windows'?(row.id==='localNetwork'?'permission.managed':row.id==='screenRecording'?(platformInfo.screenCapture?'permission.onSelect':'common.unavailable'):'permission.notRequired'):'permission.unknown');
  }
  refreshPermissionsButton.hidden=!mac;
  i18n.text(document.querySelector('#permissions-help'),mac?'permission.macHelp':os==='windows'?'permission.windowsHelp':'permission.desktopHelp');
};
const refreshPermissions = async () => {
  if (platformInfo?.os !== 'macos') return;
  refreshPermissionsButton.disabled = true;
  setError(permissionsError, null);
  try { if(permissionOnboarding?.active)await permissionOnboarding.refresh();else await permissions.refresh(); }
  catch (error) { setError(permissionsError, error); }
  finally { renderPermissions();captureErrors.permissionsChanged();discoveryPermissions.permissionsChanged();reconcileFeaturePermissions();refreshPermissionsButton.disabled = false; }
};
refreshPermissionsButton.addEventListener('click', refreshPermissions);
window.addEventListener('focus', async () => {
  const opened = permissionSettingsOpened; permissionSettingsOpened = null;
  await refreshPermissions();
  if (opened === 'localNetwork' && currentStatus === 'idle') await startDiscovery({checkPermissions:false});
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPermissions(); });
const refreshLanguage=()=>{
  renderCastingPreferences();renderVideoQuality();renderPermissions();
  for(const row of deviceGroups.querySelectorAll('.device-row.disabled'))row.title=[row.querySelector('.device-name').textContent,row.querySelector('.device-meta').textContent,i18n.t('discovery.displayOnly')].filter(Boolean).join(' · ');
  for(const input of digits)input.setAttribute('aria-label',i18n.t('pair.digit',{number:input.dataset.pairDigit}));
  const heading=document.querySelector('#casting-heading');heading.firstChild.textContent=i18n.t('cast.targetPrefix');
  for(const node of document.querySelectorAll('[data-error-message]'))node.textContent=i18n.error(node.dataset.errorMessage);
};
permissionOnboarding=mountMacOsPermissionOnboarding({document,permissions,
  onChange:()=>{renderPermissions();settingsPage.render();discoveryPermissions.permissionsChanged();},
  onComplete:()=>{
    const heading=document.querySelector('#connect-heading');heading.tabIndex=-1;heading.focus();
    void startStartupDiscovery();
  },
});
i18n.subscribe(refreshLanguage);i18n.apply();refreshLanguage();
setView('idle');
platformReady = loadPlatformInfo(invoke).then(async info => {
  platformInfo = info;
  if(info.os==='windows')mountWindowControls({document,invoke,beforeClose:async()=>{
    if(capturePending)throw new Error('请先完成或取消分享范围选择。');
    await touchback.setEnabled(false);await touchback.fence('window close');
    if(touchback.diagnostics()?.cleanupPending)throw new Error('输入尚未释放，请重试释放后关闭。');
    await client.stop();await captureProvider?.stop();diagnosticLogger?.stop();
  }});
  document.querySelector('#system-audio-settings').hidden=false;
  document.querySelector('#capture-help').textContent = '系统选屏后会短暂显示四角校验标记；识别成功的整屏支持多屏反控。窗口仅投屏。';
  captureProvider = new BrowserCaptureMediaDevices({platform:info.os,invoke,mediaDevices:navigator.mediaDevices,
    onStatus: state => { if(state.binding==='calibrating')document.querySelector('#capture-help').textContent='正在识别分享的屏幕，请稍候；四角校验标记将自动消失。';else document.querySelector('#capture-help').textContent=state.displayBinding?.state==='bound'?'已确认分享的屏幕，可开启反控。':'系统选屏后自动识别屏幕；窗口仅投屏，识别失败可停止后重试。';if (state.error) setError(castError, new Error(state.error));
      if(info.os==='macos'&&state.audio?.error?.includes('macos_audio_permission_required')){systemAudioEnabled.checked=false;featurePermissions.require('audio');persistPreferences();}
    },
  });
  client.mediaDevices = captureProvider;
  permissionsPanel.hidden = false;renderPermissions();
  await permissionOnboarding.start({os:info.os,desktop:typeof tauri.core?.invoke==='function',screenCapturePermission:info.screenCapturePermission});
  reconcileFeaturePermissions({initial:true});
  touchbackStatus.textContent = touchbackSummary(info);
  touchback.status();
  try{await inputProvider.setOutputPolicy(DEFAULT_OUTPUT_POLICY);}
  catch{inputPolicyStatus.textContent='已保存的转换不适用于本机，当前使用原生输入。';}
  await touchback.setEnabled(inputEnabled.checked);
  await renderPolicyConfiguration().catch(error=>{inputPolicyStatus.textContent=`无法读取输入能力：${error.message||error}`;});
  return info;
}).catch(() => ({os: 'unknown', touchback: false, inputControl: 'none'}));
platformReady.then(()=>{if(!permissionOnboarding.active)return startStartupDiscovery();});
if(tauri.core?.invoke){
  diagnosticLogger=createDiagnostics({invoke,snapshot:()=>({status:currentStatus,input:touchback?.diagnostics(),capture:captureProvider?.diagnostics(),media:client?.mediaDiagnostics,window:diagnosticWindow()})});
  diagnosticLogger.status(currentStatus);
  window.addEventListener('error',()=>diagnosticLogger.error());
  window.addEventListener('unhandledrejection',()=>diagnosticLogger.error());
  window.addEventListener('beforeunload',()=>diagnosticLogger.stop());
}
if (tauri.core?.invoke) {
  const updates = mountUpdates({document, invoke, listen, isSharing: () => Boolean(client.stream),
    beforeInstall: async () => {
      if (capturePending) throw new Error('正在选择分享范围，请先完成或取消分享。');
      await touchback.setEnabled(false);
      await touchback.fence('software update');
      if (touchback.diagnostics()?.cleanupPending) throw new Error('输入尚未释放，请先重试释放输入后再更新。');
      await client.stop();await captureProvider?.stop();
    },
  });
  window.addEventListener('beforeunload', () => updates.stop());
}
